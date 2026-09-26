"""Durable calibration previews and recoverable receipt-review publication.

The batch database is the commit authority: checkpoints, the result snapshot,
the complete review transition and the operation marker commit together. The
existing review database is a projection, replaced in one separate transaction.
A crash between them leaves a retryable committed operation, never a partially
confirmed round. Export's manifest/revision checks reject an old projection.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

from .batch_models import MAX_PAGE_RESULT_BYTES, BatchModelError, canonical_json, validate_budget
from .batch_pdf import BatchSourceError, open_batch_source
from .batch_store import BatchCapacityExceeded, BatchConflict, BatchStore, BatchStoreError
from .receipt_layout_review import (
    CalibrationPreview, _collection_digest, _digest, _review_digest, _excluded_by_page, _exclusion_requires_review,
    _calibration_changed_slots, _ordinary_exclusion_proof, _template_exclusion_proof,
    assert_calibration_current, prepare_receipt_calibration,
)
from .receipt_review_models import ReceiptReviewError, build_receipt_record, validate_receipt_record
from .receipt_review_read import read_receipt_review_snapshot
from .receipt_review_store import _upsert, validate_history_limits
from .receipt_snapshot import assemble_receipt_results
from .review_store_v2 import ReviewStoreV2


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _initialize(store: BatchStore) -> None:
    with store._transaction() as connection:
        connection.execute("""CREATE TABLE IF NOT EXISTS batch_receipt_calibrations (
            operation_id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
            state TEXT NOT NULL CHECK(state IN ('preview','committed','applied','cancelled')),
            header_json TEXT NOT NULL, header_digest TEXT NOT NULL,
            records_digest TEXT, projection_digest TEXT
        )""")
        connection.execute("""CREATE TABLE IF NOT EXISTS batch_receipt_calibration_pages (
            operation_id TEXT NOT NULL REFERENCES batch_receipt_calibrations(operation_id) ON DELETE CASCADE,
            position INTEGER NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
            PRIMARY KEY(operation_id, position)
        )""")
        connection.execute("""CREATE TABLE IF NOT EXISTS batch_receipt_calibration_records (
            operation_id TEXT NOT NULL REFERENCES batch_receipt_calibrations(operation_id) ON DELETE CASCADE,
            position INTEGER NOT NULL, payload_json TEXT NOT NULL,
            PRIMARY KEY(operation_id, position)
        )""")
        # An undo is a separate durable operation.  Keeping the original
        # calibration row immutable preserves the complete round history and
        # lets a retry distinguish an already completed undo from a new
        # request that accidentally targets the same round with another key.
        connection.execute("""CREATE TABLE IF NOT EXISTS batch_receipt_calibration_undos (
            operation_id TEXT PRIMARY KEY REFERENCES batch_receipt_calibrations(operation_id) ON DELETE CASCADE,
            job_id TEXT NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
            undo_id TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK(state IN ('committed','applied')),
            previous_result_revision TEXT NOT NULL,
            created_at TEXT NOT NULL,
            projection_digest TEXT
        )""")


def _exists(store: BatchStore) -> bool:
    return store.connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_receipt_calibrations'"
    ).fetchone() is not None


def _undo_exists(store: BatchStore) -> bool:
    return store.connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_receipt_calibration_undos'"
    ).fetchone() is not None


def _identifier(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise BatchModelError(f"invalid {field}")
    if len(value.encode("utf-8")) > 1024:
        raise BatchModelError(f"invalid {field}")
    return value.strip()


def _read(store: BatchStore, job_id: str, operation_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    row = store.connection.execute(
        "SELECT * FROM batch_receipt_calibrations WHERE operation_id=? AND job_id=?", (operation_id, job_id)
    ).fetchone() if _exists(store) else None
    if row is None:
        raise BatchConflict("calibration preview is unavailable")
    try:
        header = json.loads(row["header_json"])
        if (_digest(header) != row["header_digest"] or header["operation_id"] != operation_id
                or header["job_id"] != job_id or header["schema_version"] != 1):
            raise ValueError()
    except (ValueError, KeyError, TypeError) as exc:
        raise BatchStoreError("calibration journal header is invalid") from exc
    return dict(row), header


def _quota(store: BatchStore, required: int) -> None:
    if store._storage_size() + required > store.quota_bytes:
        raise BatchCapacityExceeded("calibration journal exceeds the task storage budget")


def retain_calibration_preview(store: BatchStore, preview: CalibrationPreview, review_database: Path) -> dict[str, Any]:
    """Persist a server-built preview; callers submit only its token afterward."""
    _initialize(store)
    prepared = preview.preparation
    before = {(row["source_id"], row["page"]): row for row in prepared.page_rows}
    selected = set(prepared.eligible_page_keys)
    after = [row for row in preview.page_rows if (row["source_id"], row["page"]) in selected]
    operation_id = str(uuid4())
    header = {
        **preview.view(), "operation_id": operation_id, "context_key": prepared.context_key,
        "preparation_fingerprint": prepared.fingerprint,
        "pages_digest": _collection_digest(after), "before_pages_digest": _collection_digest([
            before[(row["source_id"], row["page"])] for row in after]),
        "new_result_revision": str(uuid4()), "reviewed_at": _now(),
        **({"template_reference_digest": prepared.template_reference_digest}
           if prepared.mode == "template_apply" else {}),
    }
    encoded = canonical_json(header, max_bytes=MAX_PAGE_RESULT_BYTES)
    encoded_pages = [(canonical_json(before[(row["source_id"], row["page"])], max_bytes=MAX_PAGE_RESULT_BYTES),
                      canonical_json(row, max_bytes=MAX_PAGE_RESULT_BYTES)) for row in after]
    with store._transaction() as connection:
        assert_calibration_current(store, prepared, review_database)
        if connection.execute("SELECT COUNT(*) FROM batch_receipt_calibrations WHERE job_id=? AND state='preview'",
                              (header["job_id"],)).fetchone()[0] >= 20:
            raise BatchCapacityExceeded("close earlier calibration previews before creating another")
        _quota(store, len(encoded) + sum(len(a) + len(b) + 1024 for a, b in encoded_pages) + 16384)
        connection.execute("INSERT INTO batch_receipt_calibrations VALUES (?, ?, 'preview', ?, ?, NULL, NULL)",
                           (operation_id, header["job_id"], encoded.decode(), sha256(encoded).hexdigest()))
        connection.executemany("INSERT INTO batch_receipt_calibration_pages VALUES (?, ?, ?, ?)",
                               [(operation_id, index, a.decode(), b.decode()) for index, (a, b) in enumerate(encoded_pages)])
    return {**preview.view(), "operation_id": operation_id}


def _pages(store: BatchStore, header: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    before, after = [], []
    try:
        for index, row in enumerate(store.connection.execute(
                "SELECT * FROM batch_receipt_calibration_pages WHERE operation_id=? ORDER BY position",
                (header["operation_id"],))):
            if row["position"] != index:
                raise ValueError()
            before.append(json.loads(row["before_json"]))
            after.append(json.loads(row["after_json"]))
        if (len(after) != header["page_count"] or _collection_digest(before) != header["before_pages_digest"]
                or _collection_digest(after) != header["pages_digest"]):
            raise ValueError()
    except (ValueError, KeyError, TypeError) as exc:
        raise BatchStoreError("calibration journal pages are invalid") from exc
    return before, after


def _slot(original: dict[str, Any]) -> tuple[str, int, str]:
    return original["source_key"], original["source_page"], original["slot_id"]


def _review_transition(preview: CalibrationPreview, revision: str, reviewed_at: str) -> list[dict[str, Any]]:
    before = {_slot(record["original"]): record for record in preview.preparation.restored["segments"]}
    excluded = _excluded_by_page(before.values())
    old_originals = {_slot(item): item for item in preview.preparation.snapshot["originals"]}
    sources = {source["source_key"]: source for source in preview.preparation.snapshot["job"]["sources"]}
    affected = {(item["source_key"], item["page"], item["slot_id"]): item for item in preview.affected}
    protected_proven = set()
    ordinary_proven = set()
    if preview.preparation.mode == "template_apply":
        protected_proven, protection_blockers = _template_exclusion_proof(
            preview.preparation, preview.proposed, preview.page_rows)
        if protection_blockers:
            raise BatchConflict("an excluded receipt changed during template application")
    else:
        ordinary_proven = _ordinary_exclusion_proof(
            preview.preparation, preview.proposed, preview.page_rows,
            _calibration_changed_slots(preview.preparation, preview.draft))
    transition = []
    for original in preview.proposed["originals"]:
        key = _slot(original)
        previous = before.pop(key, None)
        previous_original = old_originals.get(key)
        action = affected.get(key)
        if preview.preparation.mode == "template_apply" and action and previous is not None:
            raise BatchConflict("a reviewed receipt cannot be changed by template application")
        if key in protected_proven or key in ordinary_proven:
            if previous is None or previous["review_status"] != "excluded" or action is not None:
                raise BatchConflict("protected exclusion cannot become a template target")
            decision = {field: previous[field] for field in
                        ("final_rect", "crop_mode", "manual_adjusted", "review_status", "reviewed_at")}
        elif _exclusion_requires_review(preview.preparation, previous, previous_original, original, excluded):
            # A rebuilt instance/layout or a replacement over an excluded
            # region cannot inherit its exclusion. The preview required a
            # separate acknowledgement of this transition before save.
            decision = {"final_rect": original["candidate_rect"], "crop_mode": "candidate",
                        "manual_adjusted": False, "review_status": "needs_review", "reviewed_at": reviewed_at}
        elif previous is not None and previous["review_status"] == "excluded":
            decision = {field: previous[field] for field in
                        ("final_rect", "crop_mode", "manual_adjusted", "review_status", "reviewed_at")}
        elif action and action["status"] != "retained_manual":
            if preview.preparation.mode == "template_apply":
                # A template suggests geometry; it is not a human review
                # decision. The recomputed checkpoint already marks this
                # candidate needs_review. Leaving the review projection empty
                # lets the user switch templates until they actually confirm
                # or exclude a receipt.
                continue
            decision = {"final_rect": original["candidate_rect"], "crop_mode": "candidate",
                        "manual_adjusted": False, "review_status": "confirmed",
                        "reviewed_at": reviewed_at}
        elif previous is not None:
            decision = {field: previous[field] for field in
                        ("final_rect", "crop_mode", "manual_adjusted", "review_status", "reviewed_at")}
        else:
            # An untouched automatic candidate has no user decision to migrate.
            # Its automatic risk flag lives in the page checkpoint; creating a
            # confirmed record here would enlarge the user's saved round.
            continue
        if previous is not None and "document_type" in previous:
            # Protected pages permit only the selected, identity-preserving
            # slot edit. Unchanged neighbors keep their explicit type and
            # review state even though the page's layout revision advances.
            unchanged_geometry = previous["original"]["candidate_rect"] == original["candidate_rect"]
            selected_override = (preview.preparation.editable_slot_ids is not None
                                 and original["slot_id"] in preview.preparation.editable_slot_ids
                                 and original["source_key"] == preview.preparation.sample["source_key"]
                                 and original["source_page"] == preview.preparation.sample["source_page"])
            if not unchanged_geometry and not selected_override:
                raise BatchConflict("manual classification cannot move to a different receipt")
            decision["document_type"] = previous["document_type"]
        source = sources[original["source_key"]]
        edit = {"schema_version": 1, "context_key": preview.preparation.context_key, "result_revision": revision,
                **{field: original[field] for field in ("id", "source_key", "instance_id", "analysis_signature")},
                "record_revision": 0, **deepcopy(decision)}
        record = build_receipt_record(original, edit, source["access_path"], source["sha256"], 1)
        transition.append({"before": previous, "after": record})
    transition.extend({"before": record, "after": None} for record in before.values())
    return transition


def _publish(store: BatchStore, job: dict[str, Any], header: dict[str, Any],
             rows: list[dict[str, Any]], proposed: dict[str, Any], transitions: list[dict[str, Any]]) -> None:
    """The caller owns the batch transaction. No review DB writes here."""
    connection = store.connection
    revision, operation_id = header["new_result_revision"], header["operation_id"]
    encoded_rows = [canonical_json(row["payload"], max_bytes=MAX_PAGE_RESULT_BYTES) for row in rows]
    encoded_items = [canonical_json(item, max_bytes=MAX_PAGE_RESULT_BYTES) for item in proposed["items"]]
    encoded_records = [canonical_json(item, max_bytes=MAX_PAGE_RESULT_BYTES) for item in transitions]
    _quota(store, sum(map(len, [*encoded_rows, *encoded_items, *encoded_records])) +
           (len(rows) + len(encoded_items) + len(encoded_records)) * 1024 + 16384)
    for row, encoded in zip(rows, encoded_rows, strict=True):
        connection.execute("""UPDATE batch_page_results SET payload_json=?, sha256=?, created_at=?
            WHERE job_id=? AND source_id=? AND page=? AND stage='page' AND schema=2""",
            (encoded.decode(), sha256(encoded).hexdigest(), header["reviewed_at"], job["id"], row["source_id"], row["page"]))
        if connection.execute("SELECT changes()").fetchone()[0] != 1:
            raise BatchConflict("calibration page disappeared during save")
    digest = sha256()
    for original in proposed["originals"]:
        digest.update(canonical_json(original, max_bytes=MAX_PAGE_RESULT_BYTES))
    # Preserve the source identity/summary already verified by the current
    # snapshot, while creating an independently addressable result revision.
    previous = connection.execute("SELECT source_summary_json FROM batch_snapshots WHERE job_id=? AND result_revision=?",
                                  (job["id"], job["result_revision"])).fetchone()
    connection.execute("INSERT INTO batch_snapshots VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?)",
        (job["id"], revision, previous["source_summary_json"], canonical_json(proposed["context"]).decode(),
         len(proposed["originals"]), digest.hexdigest(), len(job["sources"]), len(encoded_items), header["reviewed_at"]))
    connection.executemany("INSERT INTO batch_snapshot_items VALUES (?, ?, ?, ?, ?, ?)",
        [(job["id"], revision, index, item["original"]["id"], item["original"]["source_key"], encoded.decode())
         for index, (item, encoded) in enumerate(zip(proposed["items"], encoded_items, strict=True))])
    connection.executemany("INSERT INTO batch_receipt_calibration_records VALUES (?, ?, ?)",
                           [(operation_id, index, encoded.decode()) for index, encoded in enumerate(encoded_records)])
    connection.execute("UPDATE batch_jobs SET result_revision=?, updated_at=? WHERE id=?",
                       (revision, header["reviewed_at"], job["id"]))
    connection.execute("UPDATE batch_receipt_calibrations SET state='committed', records_digest=? WHERE operation_id=?",
                       (_collection_digest(transitions), operation_id))


def _transitions(store: BatchStore, row: dict[str, Any]) -> list[dict[str, Any]]:
    transitions = []
    try:
        for index, record in enumerate(store.connection.execute(
                "SELECT * FROM batch_receipt_calibration_records WHERE operation_id=? ORDER BY position", (row["operation_id"],))):
            if record["position"] != index:
                raise ValueError()
            transitions.append(json.loads(record["payload_json"]))
        if _collection_digest(transitions) != row["records_digest"]:
            raise ValueError()
    except (ValueError, KeyError, TypeError) as exc:
        raise BatchStoreError("calibration review transition is invalid") from exc
    return transitions


def _project_reviews(store: BatchStore, row: dict[str, Any], header: dict[str, Any], review_database: Path) -> None:
    """Atomically replace the review projection, or verify an earlier replay."""
    snapshot = store.review_snapshot(header["job_id"], header["new_result_revision"])
    transitions = _transitions(store, row)
    desired = [item["after"] for item in transitions if item["after"] is not None]
    with store.hold_review_binding(snapshot["job"]):
        with ReviewStoreV2(review_database) as reviews:
            with reviews.database.transaction() as connection:
                context = connection.execute("SELECT * FROM review_contexts_v2 WHERE context_key=?", (header["context_key"],)).fetchone()
                if context is None or context["result_revision"] not in {header["result_revision"], header["new_result_revision"]}:
                    raise BatchConflict("calibration review projection has a conflicting revision")
                if context["result_revision"] == header["result_revision"]:
                    # This checksum includes every old decision, even a manual
                    # exception or an unrelated previously saved position.
                    restored = read_receipt_review_snapshot(review_database, header["context_key"], header["result_revision"])
                    if _review_digest(restored) != header["before_review_digest"]:
                        raise BatchConflict("calibration review projection changed before recovery")
                    prepared = reviews.prepare_batch(snapshot["context"], snapshot["originals"],
                        result_revision=header["new_result_revision"], job_id=header["job_id"])
                    revisions = {item["id"]: item["record_revision"] for item in prepared["record_revisions"]}
                    for transition in transitions:
                        record = transition["after"]
                        if record is None:
                            continue
                        value = deepcopy(record)
                        value["record_revision"] = revisions[value["original"]["id"]] + 1
                        # A calibration publishes a new result for this
                        # task. Keep every projected decision task-scoped,
                        # including ordinary confirmed rows, so a later task
                        # cannot overwrite this task's refresh/undo state.
                        _upsert(connection, value, scoped=True)
                    validate_history_limits(connection, header["context_key"])
                else:
                    # The external transaction completed before a process
                    # interruption. A retry must not increment rows again.
                    restored = read_receipt_review_snapshot(review_database, header["context_key"], header["new_result_revision"])
                    actual = {record["original"]["id"]: record for record in restored["segments"]}
                    if set(actual) != {record["original"]["id"] for record in desired}:
                        raise BatchConflict("calibration projected record set differs from its journal")
                    for record in desired:
                        found = actual.get(record["original"]["id"])
                        if found is None or any(found[key] != value for key, value in record.items() if key != "record_revision"):
                            raise BatchConflict("calibration projected decision differs from its journal")
        restored = read_receipt_review_snapshot(review_database, header["context_key"], header["new_result_revision"])
        store.connection.execute("UPDATE batch_receipt_calibrations SET state='applied', projection_digest=? WHERE operation_id=?",
                                 (_review_digest(restored), header["operation_id"]))


def recover_receipt_calibration(store: BatchStore, job_id: str, review_database: Path) -> None:
    if not _exists(store):
        return
    rows = store.connection.execute(
        "SELECT operation_id FROM batch_receipt_calibrations WHERE job_id=? AND state='committed'", (job_id,)).fetchall()
    undo_rows = store.connection.execute(
        "SELECT operation_id FROM batch_receipt_calibration_undos WHERE job_id=? AND state='committed'", (job_id,)
    ).fetchall() if _undo_exists(store) else []
    if len(rows) + len(undo_rows) > 1:
        raise BatchConflict("multiple pending calibration operations require recovery")
    for pending in rows:
        row, header = _read(store, job_id, pending["operation_id"])
        _project_reviews(store, row, header, review_database)
    for pending in undo_rows:
        row, header = _read(store, job_id, pending["operation_id"])
        undo = _undo_row(store, job_id, pending["operation_id"])
        _project_calibration_undo(store, undo, row, header, review_database)


def save_calibration_preview(store: BatchStore, job_id: str, operation_id: str, fingerprint: str,
                             review_database: Path, *, acknowledged_risk_ids: list[str],
                             template_database: Path | None = None,
                             remember_reference: bool = True, template_name: str | None = None,
                             template_save_mode: str = "create", template_id: str | None = None,
                             template_bank_name: str | None = None) -> dict[str, Any]:
    row, header = _read(store, job_id, operation_id)
    if header["preview_fingerprint"] != fingerprint:
        raise BatchConflict("calibration preview fingerprint does not match")
    if (not isinstance(acknowledged_risk_ids, list) or any(not isinstance(value, str) for value in acknowledged_risk_ids)
            or len(set(acknowledged_risk_ids)) != len(acknowledged_risk_ids)):
        raise BatchModelError("risk acknowledgements must be unique identities")
    if type(remember_reference) is not bool:
        raise BatchModelError("remember_reference must be boolean")
    template_application = header.get("mode") == "template_apply"
    if template_application and remember_reference:
        raise BatchConflict("applying a template cannot save a new template reference")
    if template_application and row["state"] == "preview":
        if template_database is None:
            raise BatchConflict("selected layout template database is unavailable")
        from .receipt_layout_history import selected_reference
        reference = selected_reference(store, template_database, header["template_id"])
        if _digest(reference) != header.get("template_reference_digest"):
            raise BatchConflict("selected layout template changed before save")
    if remember_reference and header.get("template_allowed") is False:
        raise BatchConflict("manually classified receipts cannot be saved as a layout template")
    if template_name is not None and (not isinstance(template_name, str) or not template_name.strip()
                                     or len(template_name) > 256 or "\0" in template_name):
        raise BatchModelError("invalid template_name")
    if not isinstance(template_save_mode, str) or template_save_mode not in {"create", "update"}:
        raise BatchModelError("invalid template_save_mode")
    if template_id is not None and (not isinstance(template_id, str) or not template_id.strip()
                                    or len(template_id) > 256 or "\0" in template_id):
        raise BatchModelError("invalid template_id")
    if (template_save_mode == "update") != (template_id is not None):
        raise BatchModelError("template update requires an explicit target")
    if template_bank_name is not None and (not isinstance(template_bank_name, str)
            or not template_bank_name.strip() or len(template_bank_name) > 80 or "\0" in template_bank_name):
        raise BatchModelError("invalid template_bank_name")
    reference_intent = {"remember_reference": remember_reference, "name": template_name,
                        "save_mode": template_save_mode, "template_id": template_id,
                        "bank_name": template_bank_name}
    if "reference_intent" in header and header["reference_intent"] != reference_intent:
        raise BatchConflict("calibration template destination changed during retry")
    target_operations: set[str] = set()
    if remember_reference and template_database is not None:
        # A reusable template requires a positive issuer/family identity. Do
        # this before publishing the review round so an explicit template
        # request cannot leave the ordinary review applied while the template
        # silently disappears from the manager.
        from .receipt_layout_reference import require_reference_identity, validate_reference_target
        require_reference_identity(header["layout_definition"])
        if row["state"] == "preview":
            target = validate_reference_target(header["layout_definition"], template_database,
                                               save_mode=template_save_mode, template_id=template_id)
            if target is not None:
                from .receipt_layout_history import _undone_operations
                target_operations = {target["source_operation_id"],
                                     *target["evidence_summary"].get("confirmed_slot_sources", {}).values()}
                if target_operations & _undone_operations(store):
                    raise BatchConflict("update template was withdrawn")
    if set(acknowledged_risk_ids) != {risk["risk_id"] for risk in header["risks"]}:
        raise BatchConflict("review every calibration content risk before saving")
    if row["state"] == "cancelled":
        raise BatchConflict("calibration preview was cancelled")
    if row["state"] == "applied" and _undo_exists(store):
        # Once an applied round has been withdrawn, accepting a stale save
        # retry would make the same operation appear live again.
        marker = store.connection.execute(
            "SELECT state FROM batch_receipt_calibration_undos WHERE operation_id=?", (operation_id,)
        ).fetchone()
        if marker is not None:
            raise BatchConflict("calibration operation was undone")
    preview_to_save = None
    if row["state"] == "preview":
        if not header["can_save"] or header["blockers"]:
            raise BatchConflict("calibration preview has unresolved membership or geometry errors")
        recover_receipt_calibration(store, job_id, review_database)
        if template_application:
            from .receipt_layout_review import prepare_receipt_template_apply
            prepared, server_draft, _ = prepare_receipt_template_apply(
                store, job_id, header["result_revision"], header["template_id"],
                review_database, template_database)
            if server_draft != header["layout_definition"]:
                raise BatchConflict("selected layout template changed before save")
        else:
            prepared = prepare_receipt_calibration(
                store, job_id, header["result_revision"], header["sample_id"], review_database)
        if prepared.fingerprint != header["preparation_fingerprint"]:
            raise BatchConflict("calibration preview is stale; prepare a new preview")
        before_rows, after_rows = _pages(store, header)
        replacements = {(item["source_id"], item["page"]): item for item in after_rows}
        all_rows = [replacements.get((item["source_id"], item["page"]), item) for item in prepared.page_rows]
        job = prepared.snapshot["job"]
        for source in job["sources"]:
            with open_batch_source(source["access_path"], source["sha256"]) as opened:
                if opened.size_bytes != source["size_bytes"] or opened.page_count != source["page_count"]:
                    raise BatchSourceError("source_changed")
        proposed = assemble_receipt_results(job_id, job["sources"], job["processing_options"], job["match_mode"], job["computation_version"], all_rows)
        preview = CalibrationPreview(prepared, header["layout_definition"], all_rows, proposed, header["affected"], header["risks"],
                                     header["blockers"], tuple(header["retained_record_ids"]), tuple(header["included_exception_ids"]),
                                     fingerprint, header.get("preserved_excluded_count", 0))
        preview_to_save = preview
        transitions = _review_transition(preview, header["new_result_revision"], header["reviewed_at"])
        # Recovery needs the full pre-commit review binding, stored in the
        # same authoritative transaction as every new checkpoint and decision.
        header["before_review_digest"] = _review_digest(prepared.restored)
        header["reference_intent"] = reference_intent
        header["reference_target_operations"] = sorted(target_operations)
        encoded = canonical_json(header, max_bytes=MAX_PAGE_RESULT_BYTES)
        with store._transaction() as connection:
            assert_calibration_current(store, prepared, review_database)
            current, _ = _read(store, job_id, operation_id)
            if current["state"] != "preview":
                raise BatchConflict("calibration operation changed during save")
            connection.execute("UPDATE batch_receipt_calibrations SET header_json=?, header_digest=? WHERE operation_id=?",
                               (encoded.decode(), sha256(encoded).hexdigest(), operation_id))
            _publish(store, job, header, after_rows, proposed, transitions)
    recover_receipt_calibration(store, job_id, review_database)
    # Recovery can advance an entry from committed to applied. Auxiliary
    # persistence must use that authoritative state, not the entry snapshot.
    row, header = _read(store, job_id, operation_id)
    reference_state = "disabled"
    reference_error_code = None
    saved_template = None
    if remember_reference and template_database is not None:
        # Historical geometry is auxiliary state: a failure to remember it
        # must never turn an already committed review into an unknown save.
        try:
            from .layout_template_store import LayoutTemplateError
            from .receipt_layout_reference import save_reference, save_reference_layout
            job = store.get_job(job_id)
            with store.hold_review_binding(job):
                if job["result_revision"] != header["new_result_revision"]:
                    raise LayoutTemplateError("calibration result changed before template registration", code="operation_inactive")
                from .receipt_layout_history import _undone_operations
                if set(header.get("reference_target_operations", [])) & _undone_operations(store):
                    raise LayoutTemplateError("update template was withdrawn before registration", code="operation_inactive")
                # Registration and retry must still be authorized by the exact
                # review projection saved by this round. Hold the usual batch /
                # review write locks while checking and writing the auxiliary
                # template, so a new manual type cannot race into this family.
                with ReviewStoreV2(review_database) as reviews:
                    with reviews.database.transaction():
                        current = read_receipt_review_snapshot(review_database, header["context_key"], header["new_result_revision"])
                        if _review_digest(current) != row.get("projection_digest"):
                            raise LayoutTemplateError("receipt decisions changed before template registration", code="operation_inactive")
                        if preview_to_save is not None:
                            saved_template = save_reference(preview_to_save, template_database, operation_id,
                                name=template_name, save_mode=template_save_mode, template_id=template_id,
                                bank_name=template_bank_name)
                        elif row["state"] == "applied":
                            # A retry only repairs auxiliary registration; it
                            # never republishes a round or revives old decisions.
                            confirmed = sorted({item["slot_id"] for item in header.get("affected", [])
                                                if item.get("status") in {"updated", "added"} and item.get("after_rect") is not None})
                            saved_template = save_reference_layout(header["layout_definition"], template_database, operation_id,
                                confirmed_slot_ids=confirmed, name=template_name, save_mode=template_save_mode,
                                template_id=template_id, bank_name=template_bank_name)
                        else:
                            raise BatchStoreError("calibration reference requires an applied operation")
            reference_state = "saved"
        except (BatchStoreError, BatchModelError, OSError, ValueError, sqlite3.Error) as exc:
            reference_state = "failed"
            # Return bounded, public error categories; internal exceptions may
            # contain private paths. Only transient storage failures are retryable.
            reference_error_code = "invalid_reference"
            if isinstance(exc, (OSError, sqlite3.OperationalError)):
                reference_error_code = "storage_unavailable"
            elif isinstance(exc, LayoutTemplateError) and exc.code in {
                    "shared_geometry_changed", "template_geometry_conflict", "operation_inactive",
                    "identity_unavailable", "template_unavailable", "template_conflict",
                    "template_incompatible", "operation_conflict"}:
                reference_error_code = exc.code
    row, header = _read(store, job_id, operation_id)
    return {"schema_version": 1, "operation_id": operation_id, "job_id": job_id,
            "result_revision": header["new_result_revision"], "state": row["state"],
            "saved_count": sum(item["id"] is not None and item["status"] != "retained_manual" for item in header["affected"]),
            "reference_state": reference_state,
            **({"template_id": saved_template["id"], "template_name": saved_template["name"],
                "template_version": saved_template["version"]} if saved_template else {}),
            **({"reference_error_code": reference_error_code} if reference_error_code else {})}


def _validated_journal_page(store: BatchStore, job_id: str, value: object,
                            job_row: Any) -> dict[str, Any]:
    """Validate one page checkpoint before using it for an undo."""
    if not isinstance(value, dict) or set(value) != {"source_id", "page", "payload", "budget", "sha256"}:
        raise BatchStoreError("calibration journal page is invalid")
    source_id, page = value["source_id"], value["page"]
    if not isinstance(source_id, str) or not source_id.strip() or "\x00" in source_id:
        raise BatchStoreError("calibration journal page is invalid")
    if type(page) is not int or page < 1:
        raise BatchStoreError("calibration journal page is invalid")
    try:
        encoded = canonical_json(value["payload"], max_bytes=MAX_PAGE_RESULT_BYTES)
        if not isinstance(value["sha256"], str) or value["sha256"] != sha256(encoded).hexdigest():
            raise ValueError()
        validate_budget(value["budget"])
        source = store._source_row(store.connection, job_id, source_id)
        store._validate_page_binding(value["payload"], job_row, source, page, 2)
    except (BatchModelError, BatchStoreError, KeyError, TypeError, ValueError) as exc:
        raise BatchStoreError("calibration journal page is invalid") from exc
    return value


def _undo_page_maps(store: BatchStore, job_id: str, header: dict[str, Any]) -> tuple[
        dict[tuple[str, int], dict[str, Any]], dict[tuple[str, int], dict[str, Any]]]:
    """Load and compare before/after pages while the batch transaction is held."""
    before, after = _pages(store, header)
    job_row = store._job_row(store.connection, job_id)
    before_by_key: dict[tuple[str, int], dict[str, Any]] = {}
    after_by_key: dict[tuple[str, int], dict[str, Any]] = {}
    for value in before:
        checked = _validated_journal_page(store, job_id, value, job_row)
        key = (checked["source_id"], checked["page"])
        if key in before_by_key:
            raise BatchStoreError("calibration journal pages contain duplicate identities")
        before_by_key[key] = checked
    for value in after:
        checked = _validated_journal_page(store, job_id, value, job_row)
        key = (checked["source_id"], checked["page"])
        if key in after_by_key:
            raise BatchStoreError("calibration journal pages contain duplicate identities")
        after_by_key[key] = checked
    if not before_by_key or set(before_by_key) != set(after_by_key):
        raise BatchConflict("calibration undo page set is invalid")

    # A page may only be restored while it still contains exactly the result
    # written by this calibration.  This protects a later write (or a stale
    # caller) from being silently overwritten by an undo.
    current = {(item["source_id"], item["page"]): item for item in store.read_page_results(job_id)}
    for key, expected in after_by_key.items():
        found = current.get(key)
        if found is None or found["sha256"] != expected["sha256"]:
            raise BatchConflict("calibration result changed before undo")
        if canonical_json(found["payload"], max_bytes=MAX_PAGE_RESULT_BYTES) != canonical_json(
                expected["payload"], max_bytes=MAX_PAGE_RESULT_BYTES):
            raise BatchConflict("calibration result changed before undo")
    return before_by_key, after_by_key


def _validated_undo_transitions(store: BatchStore, row: dict[str, Any]) -> tuple[
        list[dict[str, Any]], dict[tuple[str, int, str], dict[str, Any]]]:
    """Validate and index the complete before side of a saved round."""
    transitions = _transitions(store, row)
    before_by_slot: dict[tuple[str, int, str], dict[str, Any]] = {}
    after_by_slot: dict[tuple[str, int, str], dict[str, Any]] = {}
    try:
        for transition in transitions:
            if not isinstance(transition, dict) or set(transition) != {"before", "after"}:
                raise ValueError()
            before, after = transition["before"], transition["after"]
            for record, target in ((before, before_by_slot), (after, after_by_slot)):
                if record is None:
                    continue
                checked = validate_receipt_record(record)
                key = _slot(checked["original"])
                if key in target:
                    raise ValueError()
                target[key] = checked
            if before is not None and after is not None and _slot(before["original"]) != _slot(after["original"]):
                raise ValueError()
        paired = {
            _slot(transition["before"]["original"])
            for transition in transitions
            if transition["before"] is not None and transition["after"] is not None
        }
        if paired != set(before_by_slot) & set(after_by_slot):
            raise ValueError()
    except (ReceiptReviewError, KeyError, TypeError, ValueError, OverflowError, RecursionError) as exc:
        raise BatchStoreError("calibration review transition is invalid") from exc
    return transitions, before_by_slot


def _undo_row(store: BatchStore, job_id: str, operation_id: str) -> dict[str, Any]:
    if not _undo_exists(store):
        raise BatchConflict("calibration undo is unavailable")
    row = store.connection.execute(
        "SELECT * FROM batch_receipt_calibration_undos WHERE operation_id=? AND job_id=?",
        (operation_id, job_id),
    ).fetchone()
    if row is None:
        raise BatchConflict("calibration undo is unavailable")
    if row["state"] not in {"committed", "applied"} or not isinstance(row["previous_result_revision"], str):
        raise BatchStoreError("calibration undo marker is invalid")
    if not isinstance(row["undo_id"], str) or not row["undo_id"].strip():
        raise BatchStoreError("calibration undo marker is invalid")
    return dict(row)


def _same_record_without_revision(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return all(left[field] == right[field] for field in left if field != "record_revision")


def _undo_projection_matches(restored: dict[str, Any],
                             before_by_slot: dict[tuple[str, int, str], dict[str, Any]]) -> bool:
    """Recognize an already committed undo after a crash before its marker update."""
    before_by_identity = {
        (record["original"]["source_key"], record["original"]["instance_id"]): record
        for record in before_by_slot.values()
    }
    actual_by_identity = {
        (record["original"]["source_key"], record["original"]["instance_id"]): record
        for record in restored["segments"]
    }
    if set(actual_by_identity) != set(before_by_identity):
        return False
    for key, before in before_by_identity.items():
        current = actual_by_identity.get(key)
        if current is None or not _same_record_without_revision(current, before):
            return False
        if current["record_revision"] != before["record_revision"] + 1:
            return False
    expected_revisions = {
        (item["source_key"], item["instance_id"]):
        before_by_identity.get((item["source_key"], item["instance_id"]), {}).get("record_revision", -1) + 1
        if (item["source_key"], item["instance_id"]) in before_by_identity else 0
        for item in restored["record_revisions"]
    }
    actual_revisions = {
        (item["source_key"], item["instance_id"]): item["record_revision"]
        for item in restored["record_revisions"]
    }
    return actual_revisions == expected_revisions


def _restored_record(before: dict[str, Any], revisions: dict[tuple[str, str], int],
                     sources: dict[str, dict[str, Any]], context_key: str,
                     result_revision: str) -> dict[str, Any]:
    original = before["original"]
    identity = (original["source_key"], original["instance_id"])
    current_revision = revisions.get(identity)
    if current_revision is None:
        raise BatchConflict("calibration undo record is absent from the previous manifest")
    source = sources.get(original["source_key"])
    if source is None:
        raise BatchStoreError("calibration undo source is invalid")
    next_revision = current_revision + 1
    edit = {
        "schema_version": 1, "context_key": context_key, "result_revision": result_revision,
        "id": original["id"], "source_key": original["source_key"],
        "instance_id": original["instance_id"], "analysis_signature": original["analysis_signature"],
        "record_revision": next_revision,
        "final_rect": deepcopy(before["final_rect"]), "crop_mode": before["crop_mode"],
        "review_status": before["review_status"], "manual_adjusted": before["manual_adjusted"],
        "reviewed_at": before["reviewed_at"],
        **({"document_type": before["document_type"]} if "document_type" in before else {}),
    }
    return build_receipt_record(original, edit, source["access_path"], source["sha256"], next_revision)


def _assert_undo_review_precondition(row: dict[str, Any], header: dict[str, Any],
                                    review_database: Path) -> None:
    """Reject a changed review projection before restoring batch pages.

    The batch journal is the authority, but an already edited projection must
    not be turned into a pending undo after the authority has moved back. This
    preflight closes the normal conflict path before the durable batch CAS;
    the projection phase repeats the check to cover a writer that races the
    request.
    """
    expected_after_digest = row.get("projection_digest")
    if not isinstance(expected_after_digest, str) or len(expected_after_digest) != 64:
        raise BatchStoreError("calibration projection marker is invalid")
    with ReviewStoreV2(review_database) as reviews:
        with reviews.database.transaction() as connection:
            context = connection.execute(
                "SELECT result_revision FROM review_contexts_v2 WHERE context_key=?",
                (header["context_key"],),
            ).fetchone()
            if context is None or context["result_revision"] != header["new_result_revision"]:
                raise BatchConflict("calibration review projection has a conflicting revision")
            current = read_receipt_review_snapshot(
                review_database, header["context_key"], header["new_result_revision"]
            )
            if _review_digest(current) != expected_after_digest:
                raise BatchConflict("calibration review projection changed before undo")


def _project_calibration_undo(store: BatchStore, undo: dict[str, Any], row: dict[str, Any],
                              header: dict[str, Any], review_database: Path) -> dict[str, Any]:
    previous_revision = undo["previous_result_revision"]
    snapshot = store.review_snapshot(header["job_id"], previous_revision)
    _transitions_value, before_by_slot = _validated_undo_transitions(store, row)
    expected_after_digest = row.get("projection_digest")
    if not isinstance(expected_after_digest, str) or len(expected_after_digest) != 64:
        raise BatchStoreError("calibration projection marker is invalid")
    sources = {source["source_key"]: source for source in snapshot["job"]["sources"]}
    with store.hold_review_binding(snapshot["job"]):
        with ReviewStoreV2(review_database) as reviews:
            with reviews.database.transaction() as connection:
                context = connection.execute(
                    "SELECT * FROM review_contexts_v2 WHERE context_key=?",
                    (header["context_key"],),
                ).fetchone()
                if context is None or context["result_revision"] not in {
                        header["new_result_revision"], previous_revision}:
                    raise BatchConflict("calibration review projection has a conflicting revision")
                if context["result_revision"] == header["new_result_revision"]:
                    if undo["state"] == "applied":
                        # A completed marker with a still-new projection means
                        # another writer changed the review database after the
                        # undo.  Reapplying the old round would overwrite that
                        # writer's decision.
                        raise BatchConflict("calibration review projection changed after undo")
                    current = read_receipt_review_snapshot(
                        review_database, header["context_key"], header["new_result_revision"]
                    )
                    if _review_digest(current) != expected_after_digest:
                        raise BatchConflict("calibration review projection changed before undo")
                    prepared = reviews.prepare_batch(
                        snapshot["context"], snapshot["originals"],
                        result_revision=previous_revision, job_id=header["job_id"],
                    )
                    revisions = {
                        (item["source_key"], item["instance_id"]): item["record_revision"]
                        for item in prepared["record_revisions"]
                    }
                    for before in before_by_slot.values():
                        _upsert(connection, _restored_record(
                            before, revisions, sources, header["context_key"], previous_revision,
                        ), scoped=True)
                    validate_history_limits(connection, header["context_key"])
                else:
                    current = read_receipt_review_snapshot(
                        review_database, header["context_key"], previous_revision
                    )
                    if undo["projection_digest"] is None and not _undo_projection_matches(current, before_by_slot):
                        raise BatchConflict("calibration review projection does not match its undo journal")
            restored = read_receipt_review_snapshot(review_database, header["context_key"], previous_revision)
            digest = _review_digest(restored)
            if undo["projection_digest"] is not None and undo["projection_digest"] != digest:
                raise BatchConflict("calibration review projection changed after undo")
            store.connection.execute(
                "UPDATE batch_receipt_calibration_undos SET state='applied', projection_digest=? "
                "WHERE operation_id=? AND state='committed'",
                (digest, header["operation_id"]),
            )
    return restored


def undo_calibration_operation(store: BatchStore, job_id: str, operation_id: str,
                               review_database: Path, *, undo_id: str | None = None,
                               template_database: Path | None = None) -> dict[str, Any]:
    """Undo one applied calibration round by its exact result revision.

    The batch database first restores the journaled page checkpoints and moves
    the job back to the immediately preceding snapshot. A unique undo marker
    makes that mutation idempotent. Review records are then projected in a
    second transaction; a committed marker remains recoverable if that
    projection is interrupted.
    """
    job_id = _identifier(job_id, "job id")
    operation_id = _identifier(operation_id, "operation id")
    requested_undo_id = _identifier(undo_id, "undo id") if undo_id is not None else str(uuid4())
    _initialize(store)
    with store._transaction() as connection:
        row, header = _read(store, job_id, operation_id)
        if row["state"] != "applied":
            raise BatchConflict("only an applied calibration can be undone")
        if not isinstance(header.get("new_result_revision"), str) or not isinstance(
                header.get("result_revision"), str):
            raise BatchStoreError("calibration journal revisions are invalid")
        current_job = store._job_row(connection, job_id)
        existing = connection.execute(
            "SELECT * FROM batch_receipt_calibration_undos WHERE operation_id=?",
            (operation_id,),
        ).fetchone()
        used = connection.execute(
            "SELECT operation_id FROM batch_receipt_calibration_undos WHERE undo_id=?",
            (requested_undo_id,),
        ).fetchone()
        if used is not None and used["operation_id"] != operation_id:
            raise BatchConflict("undo id was already used for another calibration")
        if existing is not None:
            if existing["job_id"] != job_id or existing["undo_id"] != requested_undo_id:
                raise BatchConflict("calibration undo was already requested with another undo id")
            if current_job["result_revision"] != header["result_revision"]:
                raise BatchConflict("calibration undo is no longer the latest operation")
            undo = dict(existing)
        else:
            if current_job["result_revision"] != header["new_result_revision"]:
                raise BatchConflict("calibration undo is no longer the latest operation")
            if current_job["state"] not in {"ready_for_review", "archived"} or current_job["deletion_pending"]:
                raise BatchConflict("calibration task is unavailable for undo")
            old_snapshot = connection.execute(
                "SELECT schema FROM batch_snapshots WHERE job_id=? AND result_revision=?",
                (job_id, header["result_revision"]),
            ).fetchone()
            if old_snapshot is None or old_snapshot["schema"] != 2:
                raise BatchConflict("previous calibration snapshot is unavailable")
            _assert_undo_review_precondition(row, header, review_database)
            # Validate the complete review journal before changing any page
            # or job row.  A malformed record must roll back the authority
            # transaction together with the page restore.
            _validated_undo_transitions(store, row)
            _undo_page_maps(store, job_id, header)
            before, _after = _pages(store, header)
            now = _now()
            for value in before:
                encoded = canonical_json(value["payload"], max_bytes=MAX_PAGE_RESULT_BYTES)
                connection.execute(
                    "UPDATE batch_page_results SET payload_json=?, sha256=?, created_at=? "
                    "WHERE job_id=? AND source_id=? AND page=? AND stage='page' AND schema=2",
                    (encoded.decode(), sha256(encoded).hexdigest(), now,
                     job_id, value["source_id"], value["page"]),
                )
                if connection.execute("SELECT changes()").fetchone()[0] != 1:
                    raise BatchConflict("calibration page disappeared during undo")
            connection.execute(
                "UPDATE batch_jobs SET result_revision=?, updated_at=? "
                "WHERE id=? AND result_revision=?",
                (header["result_revision"], now, job_id, header["new_result_revision"]),
            )
            if connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise BatchConflict("calibration task changed during undo")
            connection.execute(
                "INSERT INTO batch_receipt_calibration_undos "
                "(operation_id, job_id, undo_id, state, previous_result_revision, created_at, projection_digest) "
                "VALUES (?, ?, ?, 'committed', ?, ?, NULL)",
                (operation_id, job_id, requested_undo_id, header["result_revision"], now),
            )
            undo = {
                "operation_id": operation_id, "job_id": job_id, "undo_id": requested_undo_id,
                "state": "committed", "previous_result_revision": header["result_revision"],
                "projection_digest": None,
            }
            store._assert_complete_pages(connection, job_id)
    # The authority transaction above is complete before projection. A failed
    # projection leaves a durable committed undo for a later retry.
    calibration_row, header = _read(store, job_id, operation_id)
    undo = _undo_row(store, job_id, operation_id)
    # Historical layout references are auxiliary to the review projection but
    # must be withdrawn before reporting a completed undo.  The withdrawal is
    # itself idempotent, so a retry after an interrupted projection is safe.
    template_withdrawal = None
    if template_database is not None:
        from .layout_template_store import LayoutTemplateStore
        template_withdrawal = LayoutTemplateStore(template_database).withdraw_source_operation(
            operation_id, undo["undo_id"]
        )
    _project_calibration_undo(store, undo, calibration_row, header, review_database)
    row = _undo_row(store, job_id, operation_id)
    _transitions_value, before_by_slot = _validated_undo_transitions(store, calibration_row)
    return {
        "schema_version": 1, "operation_id": operation_id, "job_id": job_id,
        "undo_id": row["undo_id"], "result_revision": header["result_revision"],
        "state": "undone" if row["state"] == "applied" else "undo_pending",
        "saved_count": 0, "restored_count": len(before_by_slot),
        "template_withdrawal": template_withdrawal,
    }


# Keep the descriptive round spelling available to internal callers while the
# protocol uses the operation spelling.
undo_calibration_round = undo_calibration_operation


def cancel_calibration_preview(store: BatchStore, job_id: str, operation_id: str) -> None:
    with store._transaction() as connection:
        row, _ = _read(store, job_id, operation_id)
        if row["state"] not in {"preview", "cancelled"}:
            raise BatchConflict("a committed calibration must be undone, not cancelled")
        connection.execute("UPDATE batch_receipt_calibrations SET state='cancelled' WHERE operation_id=?", (operation_id,))
        # Regenerable private preview data can be released after cancellation.
        connection.execute("DELETE FROM batch_receipt_calibration_pages WHERE operation_id=?", (operation_id,))


def calibration_operation_status(store: BatchStore, job_id: str, operation_id: str) -> dict[str, Any]:
    row, header = _read(store, job_id, operation_id)
    undo = None
    if _undo_exists(store):
        marker = store.connection.execute(
            "SELECT * FROM batch_receipt_calibration_undos WHERE operation_id=? AND job_id=?",
            (operation_id, job_id),
        ).fetchone()
        if marker is not None:
            undo = dict(marker)
    if undo is not None:
        return {"schema_version": 1, "operation_id": operation_id, "job_id": job_id,
                "state": "undone" if undo["state"] == "applied" else "undo_pending",
                "preview_fingerprint": header["preview_fingerprint"],
                "result_revision": header["result_revision"], "saved_count": 0,
                "undo_id": undo["undo_id"]}
    return {"schema_version": 1, "operation_id": operation_id, "job_id": job_id,
            "state": row["state"], "preview_fingerprint": header["preview_fingerprint"],
            "result_revision": header["new_result_revision"] if row["state"] in {"committed", "applied"}
            else header["result_revision"],
            "saved_count": sum(item["id"] is not None and item["status"] != "retained_manual"
                               for item in header["affected"]) if row["state"] == "applied" else 0}
