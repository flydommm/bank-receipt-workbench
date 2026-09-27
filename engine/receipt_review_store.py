"""Internal receipt-instance reviews; the published batch manifest is authority.

This store uses the existing review database and ownership transactions, but
never projects receipt slots into the legacy match/segment table.  Preparing
new originals is restricted to the server-attested batch path.  Ordinary
edits can change only review fields; layout calibration will register a new
manifest through its separate preview transaction.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import sqlite3
from typing import TYPE_CHECKING, Any

from .receipt_review_models import (
    MAX_RECEIPT_REVIEW_MANIFEST_BYTES, MAX_RECEIPT_REVIEW_ORIGINALS,
    MAX_RECEIPT_REVIEW_RECORD_BYTES, ReceiptReviewError, build_receipt_record,
    validate_receipt_context, validate_receipt_edit, validate_receipt_originals,
    validate_receipt_record,
)
from .review_store import ReviewStoreError

if TYPE_CHECKING:
    from .review_store_v2 import ReviewStoreV2


# Historical decisions include shared rows and task/result overrides. Bound the
# aggregate independently from any one active manifest, without deleting data.
MAX_RECEIPT_REVIEW_HISTORY_RECORDS = 4 * MAX_RECEIPT_REVIEW_ORIGINALS
MAX_RECEIPT_REVIEW_HISTORY_BYTES = 4 * MAX_RECEIPT_REVIEW_MANIFEST_BYTES


RECEIPT_REVIEW_DDL = """
CREATE TABLE IF NOT EXISTS review_receipt_records_v1 (
    context_key TEXT NOT NULL,
    source_key TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    id TEXT NOT NULL,
    analysis_signature TEXT NOT NULL,
    result_revision TEXT NOT NULL,
    record_revision INTEGER NOT NULL CHECK(record_revision > 0),
    record_json TEXT NOT NULL,
    decision_scope TEXT NOT NULL,
    PRIMARY KEY(context_key, source_key, instance_id, decision_scope),
    FOREIGN KEY(context_key) REFERENCES review_contexts_v2(context_key) ON DELETE CASCADE
)
"""


def _corrupt(message: str = "stored receipt review is invalid") -> None:
    from .review_store_v2 import ReviewStoreCorruptionError
    raise ReviewStoreCorruptionError(message)


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _decode(value: object, limit: int) -> Any:
    if not isinstance(value, str) or len(value.encode("utf-8")) > limit:
        _corrupt()
    return json.loads(value)


def _key(original: dict[str, Any]) -> tuple[str, str]:
    return original["source_key"], original["instance_id"]


def validate_receipt_schema(connection: sqlite3.Connection) -> bool:
    """Refuse incompatible partial tables instead of silently ignoring columns."""
    columns = list(connection.execute("PRAGMA table_info(review_receipt_records_v1)"))
    names = ["context_key", "source_key", "instance_id", "id", "analysis_signature",
             "result_revision", "record_revision", "record_json"]
    scoped = any(row["name"] == "decision_scope" for row in columns)
    if scoped:
        names.append("decision_scope")
    primary = ["context_key", "source_key", "instance_id"] + (["decision_scope"] if scoped else [])
    if ([row["name"] for row in columns] != names
            or any(row["type"].upper() != ("INTEGER" if row["name"] == "record_revision" else "TEXT")
                   or row["notnull"] != 1 or row["dflt_value"] is not None
                   or row["pk"] != (primary.index(row["name"]) + 1 if row["name"] in primary else 0)
                   for row in columns)):
        _corrupt("receipt review schema is incompatible")
    fks = list(connection.execute("PRAGMA foreign_key_list(review_receipt_records_v1)"))
    if (len(fks) != 1 or fks[0]["table"] != "review_contexts_v2"
            or fks[0]["from"] != "context_key" or fks[0]["to"] != "context_key"
            or fks[0]["on_delete"] != "CASCADE"):
        _corrupt("receipt review foreign key is incompatible")
    ddl = connection.execute("SELECT sql FROM sqlite_master WHERE name='review_receipt_records_v1'").fetchone()
    if ddl is None or "check(record_revision>0)" not in "".join(ddl["sql"].lower().split()):
        _corrupt("receipt review revision constraint is missing")
    return scoped


def migrate_receipt_schema(connection: sqlite3.Connection) -> None:
    """Upgrade atomically; the caller owns the transaction and rollback.

    Changing the strict table codec intentionally makes old clients refuse it,
    rather than silently ignoring scoped exclusion/recovery decisions.
    """
    if validate_receipt_schema(connection):
        return
    if connection.execute("SELECT 1 FROM sqlite_master WHERE tbl_name='review_receipt_records_v1' AND type='trigger'").fetchone():
        _corrupt("receipt review migration cannot discard custom triggers")
    records = []
    for row in connection.execute("SELECT DISTINCT context_key FROM review_receipt_records_v1"):
        context = connection.execute("SELECT * FROM review_contexts_v2 WHERE context_key=?", (row["context_key"],)).fetchone()
        if context is None:
            _corrupt()
        descriptor, _items = validate_context_row(context, _decode(context["descriptor_json"], MAX_RECEIPT_REVIEW_MANIFEST_BYTES), row["context_key"])
        records.extend(read_records(connection, row["context_key"], descriptor).values())
    connection.execute("ALTER TABLE review_receipt_records_v1 RENAME TO review_receipt_records_legacy_migration")
    connection.execute(RECEIPT_REVIEW_DDL)
    for record in records:
        _upsert(connection, record)
    connection.execute("DROP TABLE review_receipt_records_legacy_migration")
    validate_receipt_schema(connection)


def _decision_scope(original: dict[str, Any], revision: str) -> str:
    return hashlib.sha256(_canonical([original["id"], revision]).encode("utf-8")).hexdigest()


def record_is_scoped(connection: sqlite3.Connection, record: dict[str, Any] | None) -> bool:
    if record is None:
        return False
    original = record["original"]
    return connection.execute("""SELECT 1 FROM review_receipt_records_v1
        WHERE context_key=? AND source_key=? AND instance_id=? AND decision_scope=?""",
        (record["context_key"], *_key(original), _decision_scope(original, record["result_revision"]))).fetchone() is not None


class _ReceiptRecords(dict[tuple[str, str, str], dict[str, Any]]):
    """Validated records plus an O(1) index for same-task revision carryover."""

    def __init__(self) -> None:
        super().__init__()
        self.prior_scoped: dict[tuple[str, str, str], dict[str, Any]] = {}


def current_record(records: dict[tuple[str, str, str], dict[str, Any]], original: dict[str, Any],
                   revision: str) -> dict[str, Any] | None:
    """Return a decision only when it belongs to this exact result item.

    Empty-scope rows predate task-scoped receipt decisions and are retained as
    history for audit/migration.  They must not be rebound to a new task just
    because its source, layout and processing context happen to match.  A
    current task still restores its own old shared row while it has the same
    published item identity; a new job receives a clean review projection.
    """
    key = _key(original)
    scoped = records.get((*key, _decision_scope(original, revision)))
    if scoped is not None:
        return scoped
    # A calibration/undo round can publish a later result revision for the
    # same task.  Its item id is still bound to that task, so an earlier
    # task-scoped row is safe to carry forward when the new revision has not
    # written its own row yet.  The same logical source/slot in another job
    # has a different id and cannot enter this branch.
    indexed = getattr(records, "prior_scoped", None)
    if indexed is not None:
        prior = indexed.get((*key, original["id"]))
        if prior is not None:
            return prior
    else:
        # Keep direct callers that supply an ordinary dict compatible.
        # Production reads use _ReceiptRecords above, so they do not pay this
        # fallback scan.
        prior_scoped = [
            candidate for (source_key, instance_id, scope), candidate in records.items()
            if source_key == key[0] and instance_id == key[1] and scope
            and candidate["original"]["id"] == original["id"]
        ]
        if prior_scoped:
            return max(prior_scoped, key=lambda candidate: (candidate["record_revision"], candidate["result_revision"]))
    shared = records.get((*key, ""))
    return shared if shared is not None and shared["original"]["id"] == original["id"] else None


def validate_history_limits(connection: sqlite3.Connection, context_key: str) -> None:
    row = connection.execute("""SELECT COUNT(*) AS count,
        COALESCE(SUM(length(CAST(record_json AS BLOB))), 0) AS bytes
        FROM review_receipt_records_v1 WHERE context_key=?""", (context_key,)).fetchone()
    if row["count"] > MAX_RECEIPT_REVIEW_HISTORY_RECORDS or row["bytes"] > MAX_RECEIPT_REVIEW_HISTORY_BYTES:
        raise ReviewStoreError("receipt review history exceeds the bounded storage limit")


def record_table(connection: sqlite3.Connection, context_key: str,
                 context_row: sqlite3.Row | None = None) -> str:
    row = context_row or connection.execute(
        "SELECT version FROM review_contexts_v2 WHERE context_key=?", (context_key,),
    ).fetchone()
    if row is None or type(row["version"]) is not int or row["version"] not in {2, 3}:
        _corrupt("receipt review context version is invalid")
    selected, other = (("review_receipt_records_v1", "review_segments_v2") if row["version"] == 3
                       else ("review_segments_v2", "review_receipt_records_v1"))
    # SQL identifiers here are fixed literals selected only by the stored codec.
    if connection.execute(f"SELECT 1 FROM {other} WHERE context_key=? LIMIT 1", (context_key,)).fetchone():
        _corrupt("review context contains records for a different codec")
    return selected


def _validate_manifest(originals: object, descriptor: dict[str, Any]):
    items, encoded, digest = validate_receipt_originals(
        originals, {source["source_key"]: source["source_sha256"] for source in descriptor["sources"]},
    )
    allowed = {"keyword"} if descriptor["processing_options"]["processing_mode"] == "search" else {"occupied_slot", "manual_slot"}
    if any(item["selection_basis"] not in allowed for item in items):
        raise ReceiptReviewError("receipt selection basis does not match processing mode")
    return items, encoded, digest


def validate_context_row(row: sqlite3.Row, descriptor: dict[str, Any], context_key: str):
    """Validate the complete durable manifest, including historical descriptor."""
    try:
        if row["version"] != 3 or row["context_key"] != context_key:
            _corrupt()
        stored, _sha_by_key, stored_key = validate_receipt_context(
            _decode(row["descriptor_json"], MAX_RECEIPT_REVIEW_MANIFEST_BYTES), trusted_aliases=True,
        )
        _expected, _sha, expected_key = validate_receipt_context(descriptor, trusted_aliases=True)
        if (stored_key != context_key or expected_key != context_key
                or _canonical(stored) != row["descriptor_json"]
                or stored["criteria_fingerprint"] != row["criteria_fingerprint"]
                or stored["computation_version"] != row["computation_version"]):
            _corrupt()
        from .review_store_v2 import _bounded_result_revision, _bounded_text
        _bounded_result_revision(row["result_revision"])
        for field in ("created_at", "updated_at"):
            _bounded_text(row[field], field, 128)
        items, encoded, digest = _validate_manifest(
            _decode(row["manifest_json"], MAX_RECEIPT_REVIEW_MANIFEST_BYTES), stored,
        )
        if encoded != row["manifest_json"] or digest != row["manifest_digest"]:
            _corrupt()
        return stored, items
    except (KeyError, IndexError, ValueError, TypeError, OverflowError, RecursionError, ReviewStoreError):
        _corrupt()


def read_records(connection: sqlite3.Connection, context_key: str, descriptor: dict[str, Any]):
    """Validate all historical rows, even ones omitted from the latest manifest."""
    if record_table(connection, context_key) != "review_receipt_records_v1":
        _corrupt("receipt records require a receipt context")
    validate_history_limits(connection, context_key)
    sources = {source["source_key"]: source for source in descriptor["sources"]}
    result = _ReceiptRecords()
    try:
        for row in connection.execute("SELECT * FROM review_receipt_records_v1 WHERE context_key=?", (context_key,)):
            record = validate_receipt_record(_decode(row["record_json"], MAX_RECEIPT_REVIEW_RECORD_BYTES))
            original = record["original"]
            logical = _key(original)
            scope = row["decision_scope"] if "decision_scope" in row.keys() else ""
            key = (*logical, scope)
            source = sources.get(logical[0])
            if scope not in {"", _decision_scope(original, record["result_revision"])}:
                _corrupt("stored receipt decision scope is invalid")
            if "decision_scope" in row.keys() and not scope and record["review_status"] == "excluded":
                _corrupt("excluded receipt requires a task/result scope")
            if (key in result or source is None or record["context_key"] != context_key
                    or record["source_sha256"] != source["source_sha256"]
                    or record["source_path"] != source["source_path"]
                    or _canonical(record) != row["record_json"]):
                _corrupt()
            for field in ("source_key", "instance_id", "id", "analysis_signature"):
                if row[field] != original[field]:
                    _corrupt()
            for field in ("result_revision", "record_revision"):
                if row[field] != record[field]:
                    _corrupt()
            result[key] = record
            if scope:
                identity = (*logical, original["id"])
                prior = result.prior_scoped.get(identity)
                if prior is None or (record["record_revision"], record["result_revision"]) > (
                        prior["record_revision"], prior["result_revision"]):
                    result.prior_scoped[identity] = record
        return result
    except (KeyError, IndexError, ValueError, TypeError, OverflowError, RecursionError, ReviewStoreError):
        _corrupt()


def _upsert(connection: sqlite3.Connection, record: dict[str, Any], *, scoped: bool | None = None) -> None:
    original = record["original"]
    if scoped is None:
        scoped = record["review_status"] == "excluded" or record_is_scoped(connection, record)
    scope = _decision_scope(original, record["result_revision"]) if scoped else ""
    connection.execute("""
        INSERT INTO review_receipt_records_v1
          (context_key, source_key, instance_id, id, analysis_signature, result_revision, record_revision, record_json, decision_scope)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(context_key, source_key, instance_id, decision_scope) DO UPDATE SET
          id=excluded.id, analysis_signature=excluded.analysis_signature,
          result_revision=excluded.result_revision, record_revision=excluded.record_revision,
          record_json=excluded.record_json
        """, (record["context_key"], original["source_key"], original["instance_id"], original["id"],
               original["analysis_signature"], record["result_revision"], record["record_revision"], _canonical(record), scope))


def _same_original(previous: dict[str, Any], current: dict[str, Any]) -> bool:
    # Result IDs identify task rows; content signatures and slot identity do not.
    return _canonical({key: value for key, value in previous.items() if key != "id"}) == _canonical(
        {key: value for key, value in current.items() if key != "id"})


def _excluded_outside_result(record: dict[str, Any], original: dict[str, Any], revision: str) -> bool:
    # Only unmigrated eight-column databases may still contain a shared
    # exclusion. Read those conservatively until an attested write migrates it.
    return record["review_status"] == "excluded" and (
        record["original"]["id"] != original["id"] or record["result_revision"] != revision)


def _validate_exclusion_transition(previous: dict[str, Any] | None, original: dict[str, Any],
                                   edit: dict[str, Any], revision: str) -> None:
    current = previous if previous is not None and previous["original"] == original and previous["result_revision"] == revision else None
    if current is not None and current["review_status"] == "blocked" and edit["review_status"] not in {"blocked", "excluded"}:
        # A normal review/classification request cannot resolve geometry risk.
        # Calibration publishes checked geometry through its own journal.
        raise ReviewStoreError("blocked receipt requires layout calibration before confirmation")
    was_excluded = current is not None and current["review_status"] == "excluded"
    if was_excluded and edit["review_status"] not in {"excluded", "needs_review"}:
        raise ReviewStoreError("excluded receipt must explicitly restore to needs_review")
    if was_excluded or edit["review_status"] == "excluded":
        geometry = current or {"final_rect": original["candidate_rect"], "crop_mode": "candidate", "manual_adjusted": False}
        if any(edit[field] != geometry[field] for field in ("final_rect", "crop_mode", "manual_adjusted")):
            raise ReviewStoreError("exclusion and restore must preserve current geometry")


def _classification_edit(previous: dict[str, Any] | None, original: dict[str, Any],
                         edit: dict[str, Any], revision: str) -> dict[str, Any]:
    # Never inherit classification from an obsolete analysis identity. Ordinary
    # confirm/exclude/restore callers may omit it, but cannot erase a decision.
    current = previous if previous is not None and previous["original"] == original and previous["result_revision"] == revision else None
    if "document_type" not in edit:
        if current is not None and "document_type" in current:
            return {**edit, "document_type": current["document_type"]}
        return edit
    changed = current is None or current.get("document_type") != edit["document_type"]
    if changed:
        geometry = current or {"final_rect": original["candidate_rect"], "crop_mode": "candidate", "manual_adjusted": False}
        if any(edit[field] != geometry[field] for field in ("final_rect", "crop_mode", "manual_adjusted")):
            raise ReviewStoreError("classification must preserve current geometry")
        status = None if current is None else current["review_status"]
        if status in {"blocked", "excluded"}:
            if edit["review_status"] != status:
                raise ReviewStoreError("classification must preserve blocked or excluded state")
        elif (edit["review_status"] not in {"needs_review", "confirmed", "blocked", "excluded"}
              and not (edit["review_status"] == "page_confirmed" and edit["crop_mode"] == "full_page")):
            raise ReviewStoreError("classification requires explicit review or confirmation")
    return edit


def prepare_receipts(store: ReviewStoreV2, context: object, originals: object, *, result_revision: str,
                     trusted_aliases: bool, owner_kind: str, owner_id: str) -> dict[str, Any]:
    from .review_store_v2 import _bounded_result_revision, _now_utc, _owner_id
    if trusted_aliases is not True or owner_kind != "batch":
        raise ReviewStoreError("receipt manifests require a server-attested batch owner")
    try:
        descriptor, _sha_by_key, context_key = validate_receipt_context(context, trusted_aliases=True)
        current_revision = _bounded_result_revision(result_revision)
        owner = _owner_id(owner_id)
        items, manifest_json, manifest_digest = _validate_manifest(originals, descriptor)
    except ReceiptReviewError as exc:
        raise ReviewStoreError(str(exc)) from exc
    sources = {source["source_key"]: source for source in descriptor["sources"]}
    descriptor_json = _canonical(descriptor)
    with store.database.transaction() as connection:
        row = connection.execute("SELECT * FROM review_contexts_v2 WHERE context_key=?", (context_key,)).fetchone()
        now = _now_utc()
        if row is None:
            connection.execute("""
                INSERT INTO review_contexts_v2
                  (context_key, version, descriptor_json, criteria_fingerprint, computation_version,
                   result_revision, manifest_json, manifest_digest, created_at, updated_at)
                VALUES (?, 3, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (context_key, descriptor_json, descriptor["criteria_fingerprint"],
                       descriptor["computation_version"], current_revision, manifest_json, manifest_digest, now, now))
            stored_records = read_records(connection, context_key, descriptor)
        else:
            stored_descriptor, _previous_items = validate_context_row(row, descriptor, context_key)
            stored_records = read_records(connection, context_key, stored_descriptor)
            if row["result_revision"] == current_revision and row["manifest_json"] != manifest_json:
                raise ReviewStoreError("same result_revision cannot register a different manifest")
            if (row["result_revision"] != current_revision or row["descriptor_json"] != descriptor_json):
                connection.execute("""
                    UPDATE review_contexts_v2 SET descriptor_json=?, result_revision=?, manifest_json=?,
                      manifest_digest=?, updated_at=? WHERE context_key=?
                    """, (descriptor_json, current_revision, manifest_json, manifest_digest, now, context_key))
        store._register_owner_connection(connection, context_key, "batch", owner)
        # Relocate every historical record only after its previous binding passed.
        for logical, record in stored_records.items():
            path = sources[record["original"]["source_key"]]["source_path"]
            if path != record["source_path"]:
                record["source_path"] = path
                _upsert(connection, record, scoped=bool(logical[2]))
        public_records, revisions = [], []
        for item in items:
            record = current_record(stored_records, item, current_revision)
            revisions.append({"id": item["id"], "source_key": item["source_key"], "instance_id": item["instance_id"],
                              "source_page": item["source_page"], "position_index": item["position_index"],
                              "record_revision": 0 if record is None else record["record_revision"]})
            if record is None:
                continue
            if not _same_original(record["original"], item):
                if record["original"]["analysis_signature"] == item["analysis_signature"]:
                    _corrupt("receipt analysis signature conflicts with immutable geometry")
                continue
            if _excluded_outside_result(record, item, current_revision):
                continue
            if record["original"]["id"] != item["id"] or record["result_revision"] != current_revision:
                was_scoped = record_is_scoped(connection, record)
                record["original"] = deepcopy(item)
                record["result_revision"] = current_revision
                _upsert(connection, record, scoped=was_scoped)
            public_records.append(deepcopy(record))
        return {"schema_version": 1, "context_key": context_key, "result_revision": current_revision,
                "segments": public_records, "record_revisions": revisions, "group_confirmed": False}


def save_receipts(store: ReviewStoreV2, context_key: str, result_revision: str, records: object, *,
                  confirm_group: bool = False) -> dict[str, Any]:
    from .review_store_v2 import ReviewRevisionConflict, _bounded_result_revision, _now_utc, _require_sha
    key = _require_sha(context_key, "context_key", lowercase=True)
    revision = _bounded_result_revision(result_revision)
    if confirm_group is not False:
        raise ReviewStoreError("receipt rounds require their own preview scope; legacy group confirmation is unavailable")
    if not isinstance(records, list) or len(records) > MAX_RECEIPT_REVIEW_ORIGINALS:
        raise ReviewStoreError("receipt edits must be a bounded array")
    try:
        parsed, logical_keys, ids = [], set(), set()
        total_bytes = 2
        for raw in records:
            edit = validate_receipt_edit(raw)
            logical = (edit["source_key"], edit["instance_id"])
            if edit["context_key"] != key or edit["result_revision"] != revision:
                raise ReviewStoreError("receipt edit does not match requested context/revision")
            if logical in logical_keys or edit["id"] in ids:
                raise ReviewStoreError("receipt edits must have unique identities")
            total_bytes += len(_canonical(edit).encode("utf-8")) + 1
            if total_bytes > MAX_RECEIPT_REVIEW_MANIFEST_BYTES:
                raise ReviewStoreError("receipt edits exceed the aggregate JSON limit")
            logical_keys.add(logical)
            ids.add(edit["id"])
            parsed.append(edit)
        with store.database.transaction() as connection:
            row = connection.execute("SELECT * FROM review_contexts_v2 WHERE context_key=?", (key,)).fetchone()
            if row is None:
                raise ReviewStoreError("review context does not exist")
            descriptor = _decode(row["descriptor_json"], MAX_RECEIPT_REVIEW_MANIFEST_BYTES)
            descriptor, items = validate_context_row(row, descriptor, key)
            if row["result_revision"] != revision:
                raise ReviewRevisionConflict(context_key=key, expected_revision=None, actual_revision=None,
                                             message="result_revision does not match current receipt context")
            stored = read_records(connection, key, descriptor)
            item_by_key = {_key(item): item for item in items}
            sources = {source["source_key"]: source for source in descriptor["sources"]}
            pending = {}
            for edit in parsed:
                logical = (edit["source_key"], edit["instance_id"])
                item = item_by_key.get(logical)
                if item is None:
                    raise ReviewStoreError("receipt edit is absent from the current manifest")
                previous = current_record(stored, item, revision)
                actual_revision = 0 if previous is None else previous["record_revision"]
                if edit["record_revision"] != actual_revision:
                    raise ReviewRevisionConflict(context_key=key, record_id=item["id"],
                                                 expected_revision=edit["record_revision"], actual_revision=actual_revision)
                _validate_exclusion_transition(previous, item, edit, revision)
                edit = _classification_edit(previous, item, edit, revision)
                source = sources[item["source_key"]]
                pending[logical] = build_receipt_record(item, edit, source["source_path"], source["source_sha256"],
                                                       actual_revision + 1)
            # Validation precedes writes; the transaction also rolls back an I/O
            # failure after any insert. Return the manifest order, not edit order.
            saved = [pending[_key(item)] for item in items if _key(item) in pending]
            # Every new-task edit is task/result scoped.  Keeping ordinary
            # edits in the shared compatibility slot would let the next task
            # overwrite the prior task's refresh/undo state even though the
            # new task is correctly prevented from restoring it.
            for record in saved:
                _upsert(connection, record, scoped=True)
            validate_history_limits(connection, key)
            if saved:
                connection.execute("UPDATE review_contexts_v2 SET updated_at=? WHERE context_key=?", (_now_utc(), key))
            return {"schema_version": 1, "context_key": key, "result_revision": revision,
                    "saved_count": len(saved), "segments": saved}
    except ReceiptReviewError as exc:
        raise ReviewStoreError(str(exc)) from exc
