"""SQLite storage for local company accounts and receipt grouping snapshots.

Only the tables declared in this module are owned here.  The application
passes the same private pdf-search.sqlite3 used by review storage, but this
module never changes PRAGMA user_version or review/template rows.
"""

from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
from typing import Any, Callable, Iterator, Mapping, Sequence
from uuid import uuid4

from .receipt_grouping_models import (
    CompanyAccount,
    GroupingConflict,
    GroupingError,
    GroupingIncomplete,
    GroupingNotFound,
    GroupingSourceChanged,
    GroupingValidationError,
    MAX_ITEMS,
    MAX_REFRESH_IDS,
    MAX_REFRESH_PAGES,
    canonical_json,
    derive_grouping_decision,
    digest,
    item_identifier,
    normalize_parties,
    normalize_text,
    now_utc,
    stable_item_identity,
    validate_account,
)
from .receipt_grouping_version import grouping_algorithm_version, extraction_algorithm_version, extraction_dependencies


SCHEMA = """
CREATE TABLE IF NOT EXISTS company_accounts (
    account_id TEXT PRIMARY KEY,
    account_revision INTEGER NOT NULL CHECK (account_revision > 0),
    company_name TEXT NOT NULL,
    bank_name TEXT NOT NULL,
    branch_name TEXT NOT NULL DEFAULT '',
    account_number TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_company_accounts_lookup
    ON company_accounts(company_name, bank_name, updated_at);

CREATE TABLE IF NOT EXISTS receipt_grouping_tasks (
    job_id TEXT PRIMARY KEY,
    grouping_revision INTEGER NOT NULL DEFAULT 0 CHECK (grouping_revision >= 0),
    own_account_json TEXT,
    own_account_fingerprint TEXT,
    result_revision TEXT,
    review_fingerprint TEXT,
    source_bank TEXT,
    basis_json TEXT NOT NULL DEFAULT '{}',
    basis_fingerprint TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'needs_prepare',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt_grouping_items (
    job_id TEXT NOT NULL,
    fragment_key TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    binding_json TEXT NOT NULL,
    extraction_fingerprint TEXT NOT NULL,
    basis_fingerprint TEXT NOT NULL,
    extracted_json TEXT,
    manual_json TEXT NOT NULL DEFAULT '{}',
    derived_json TEXT NOT NULL,
    extraction_state TEXT NOT NULL,
    route TEXT NOT NULL,
    group_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(job_id, fragment_key),
    UNIQUE(job_id, segment_id)
);
CREATE INDEX IF NOT EXISTS idx_receipt_grouping_items_job
    ON receipt_grouping_items(job_id, segment_id);
CREATE INDEX IF NOT EXISTS idx_receipt_grouping_items_group
    ON receipt_grouping_items(job_id, group_id);

CREATE TABLE IF NOT EXISTS receipt_grouping_groups (
    job_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    group_key TEXT,
    display_name TEXT NOT NULL,
    manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(job_id, group_id)
);

CREATE TABLE IF NOT EXISTS receipt_grouping_history (
    job_id TEXT NOT NULL,
    grouping_revision INTEGER NOT NULL CHECK(grouping_revision > 0),
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    previous_json TEXT,
    reason TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    PRIMARY KEY(job_id, grouping_revision, entity_kind, entity_id)
);

CREATE TABLE IF NOT EXISTS receipt_grouping_meta (
    schema_name TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL
);
"""

SCHEMA_NAME = "receipt_grouping"
SCHEMA_VERSION = 1
MAX_HISTORY_ROWS = 100_000


def _current_grouping_version() -> str:
    """Return a validated process-local grouping algorithm fingerprint."""

    try:
        value = grouping_algorithm_version()
    except Exception as exc:
        # A missing or unreadable algorithm source must fail closed.  Do not
        # allow a task with an unknown basis to be treated as current.
        raise GroupingError("分组算法版本不可用") from exc
    if not isinstance(value, str) or not value.strip() or len(value) > 256:
        raise GroupingError("分组算法版本无效")
    return value


def _task_basis(task: Mapping[str, Any]) -> Mapping[str, Any]:
    try:
        raw = task["basis_json"]
    except (KeyError, IndexError, TypeError):
        raw = task.get("basis_json", "{}")
    try:
        value = _json(raw)
    except GroupingError as exc:
        raise GroupingConflict("分组依据已损坏，请重新准备") from exc
    if not isinstance(value, Mapping):
        raise GroupingConflict("分组依据已损坏，请重新准备")
    return value


def _require_current_grouping_version(task: Mapping[str, Any], current: str | None = None) -> str:
    expected = current or _current_grouping_version()
    basis = _task_basis(task)
    if basis.get("grouping_algorithm_version") != expected:
        # An account-selected but never-prepared task has no grouping basis to
        # invalidate.  Keep the read-only empty snapshot available; page/save
        # still fail later on their missing result/revision checks.
        if task["result_revision"] is None and not task["basis_fingerprint"]:
            return expected
        raise GroupingConflict("分组算法已变化，请重新准备")
    return expected


def _text(value: object, field: str, *, required: bool = False, limit: int = 32768) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or "\x00" in value:
        raise GroupingValidationError(f"{field}格式无效")
    value = value.strip()
    if required and not value:
        raise GroupingValidationError(f"{field}不能为空")
    if len(value.encode("utf-8")) > limit:
        raise GroupingValidationError(f"{field}过长")
    return value


def _id(value: object, field: str = "编号") -> str:
    return _text(value, field, required=True, limit=1024)


def _revision(value: object, field: str = "修订") -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise GroupingValidationError(f"{field}无效")
    return value


def _json(value: object) -> Any:
    try:
        if isinstance(value, str):
            return json.loads(value)
        return json.loads(canonical_json(value))
    except GroupingError:
        raise


def _source_sha(path: Path) -> str:
    try:
        hasher = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(chunk)
        return hasher.hexdigest()
    except OSError as exc:
        raise GroupingSourceChanged("原始文件无法核验") from exc


def _items(value: object) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, Mapping):
        for key in ("items", "segments", "records", "originals"):
            if isinstance(value.get(key), Sequence) and not isinstance(value.get(key), (str, bytes, bytearray)):
                return _items(value[key])
        return []
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise GroupingValidationError("回单分组结果格式无效")
    result = [dict(item) for item in value if isinstance(item, Mapping)]
    if len(result) != len(value):
        raise GroupingValidationError("回单分组条目格式无效")
    if len(result) > MAX_ITEMS:
        raise GroupingValidationError("回单数量超过处理上限")
    return result


def _identity(item: Mapping[str, Any]) -> tuple[str, int, int] | None:
    source = item.get("source_key", item.get("source_id"))
    page = item.get("source_page", item.get("page"))
    segment = item.get("segment_no", item.get("segment", item.get("position_index", 1)))
    if not isinstance(source, str) or not source or isinstance(page, bool) or not isinstance(page, int):
        return None
    if isinstance(segment, bool) or not isinstance(segment, int):
        return None
    return source, page, segment


def _merge(authoritative: object, review: object) -> list[dict[str, Any]]:
    base = _items(authoritative)
    review_items = _items(review)
    if not base:
        return review_items
    if not review_items:
        return base
    by_id: dict[str, dict[str, Any]] = {}
    by_identity: dict[tuple[str, int, int], dict[str, Any]] = {}
    for item in review_items:
        value = item.get("segment_id", item.get("item_id", item.get("id", item.get("instance_id"))))
        if isinstance(value, str) and value:
            by_id[value] = item
        key = _identity(item)
        if key is not None:
            by_identity[key] = item
    merged: list[dict[str, Any]] = []
    for item in base:
        value = item.get("segment_id", item.get("item_id", item.get("id", item.get("instance_id"))))
        overlay = by_id.get(value) if isinstance(value, str) else None
        if overlay is None:
            overlay = by_identity.get(_identity(item))
        merged.append({**item, **overlay} if overlay is not None else item)
    return merged


def _source_fields(raw: Mapping[str, Any], index: int) -> dict[str, Any]:
    source_key = _text(raw.get("source_key", raw.get("source_id")), "来源标识", required=True)
    source_path = _text(raw.get("source_path", raw.get("access_path", raw.get("path"))), "来源路径")
    source_sha = raw.get("source_sha256", raw.get("sha256"))
    if source_sha is not None:
        source_sha = _text(source_sha, "来源校验值", required=True, limit=128).lower()
    page = raw.get("source_page", raw.get("page"))
    if isinstance(page, bool) or not isinstance(page, int) or page < 1:
        raise GroupingValidationError("来源页码无效")
    segment = raw.get("segment_no", raw.get("segment", raw.get("position_index", index + 1)))
    if isinstance(segment, bool) or not isinstance(segment, int) or segment < 1:
        raise GroupingValidationError("回单栏位无效")
    slot = raw.get("slot_id", raw.get("slot"))
    if slot is not None:
        slot = _text(slot, "版式栏位", required=True, limit=256)
    layout_revision = raw.get("layout_revision")
    if layout_revision is not None and (isinstance(layout_revision, bool) or not isinstance(layout_revision, int) or layout_revision < 1):
        raise GroupingValidationError("版式版本无效")
    final_rect = raw.get("final_rect", raw.get("rect"))
    return {
        "source_key": source_key, "source_path": source_path, "source_sha256": source_sha,
        "source_page": page, "segment_no": segment, "slot_id": slot,
        "layout_revision": layout_revision, "final_rect": final_rect,
    }


def _parties(raw: Mapping[str, Any]) -> Any:
    for key in ("parties", "receipt_parties", "party_fields"):
        if key in raw:
            return raw[key]
    return {key: raw[key] for key in ("payer", "payee", "own_observed", "counterparty_observed",
                                     "issues", "reader_dependencies", "layout_signature") if key in raw}


def stamp_extraction_dependencies(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Stamp a freshly read trusted result, never an unchanged cached result."""
    result = dict(raw)
    parties = _parties(result)
    result["extraction_dependencies"] = extraction_dependencies(
        parties if isinstance(parties, Mapping) else {}, common_version=extraction_algorithm_version(),
        rule_basis=result.get("field_rule_basis"),
    )
    return result


def _extraction_dependencies_current(raw: Mapping[str, Any]) -> bool:
    previous = raw.get("extraction_dependencies")
    current = stamp_extraction_dependencies(raw)["extraction_dependencies"]
    return previous == current and all(reader["source_version"] is not None for reader in current["readers"])


def _special(raw: Mapping[str, Any]) -> tuple[str, bool]:
    for key in ("special_type", "document_type", "voucher_type"):
        value = raw.get(key)
        if isinstance(value, Mapping):
            label = value.get("value", value.get("name", value.get("type", "")))
            confirmed = value.get("confirmed", value.get("state") in {"confirmed", "present"})
        else:
            label = value
            confirmed = raw.get("special_confirmed", raw.get("document_type_confirmed", False))
        if isinstance(label, str) and label.strip():
            return normalize_text(label), bool(confirmed)
    return "", False


def _source_bank(raw: Mapping[str, Any]) -> tuple[str, str]:
    for key in ("source_bank", "issuer_bank", "source_issuer_bank", "issuer"):
        value = raw.get(key)
        state = "present"
        if isinstance(value, Mapping):
            state = str(value.get("state", "present"))
            value = value.get("bank_name", value.get("name", value.get("value", "")))
        if isinstance(value, str) and value.strip():
            return normalize_text(value), state
    return "", "unknown"


def _manifest_bank(value: object) -> tuple[str, str]:
    from .receipt_issuer import canonical_bank_heading, is_bank_channel_heading

    if isinstance(value, Mapping):
        value = value.get("sources", value.get("items", []))
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return "", "unknown"
    names: list[str] = []
    unknown = False
    for raw in value:
        if not isinstance(raw, Mapping):
            unknown = True
            continue
        candidate = raw.get("source_bank", raw.get("issuer_bank", raw.get("issuer")))
        if isinstance(candidate, Mapping):
            candidate = candidate.get("bank_name", candidate.get("name", candidate.get("value", "")))
        if isinstance(candidate, str) and candidate.strip():
            if is_bank_channel_heading(candidate):
                unknown = True
            else:
                names.append(canonical_bank_heading(candidate) or normalize_text(candidate))
        else:
            unknown = True
    if not names:
        return "", "unknown"
    if len({name.casefold() for name in names}) != 1:
        return "", "mixed"
    return names[0], "unknown" if unknown else "present"


def _binding(raw: Mapping[str, Any], source: Mapping[str, Any], segment_id: str, job_id: str) -> dict[str, Any]:
    return {
        "segment_id": segment_id,
        "fragment_key": digest({
            "job_id": job_id, "source_key": source["source_key"],
            "source_sha256": source["source_sha256"], "source_page": source["source_page"],
            "slot_id": source["slot_id"],
        }),
        "source_key": source["source_key"],
        "source_path": source["source_path"],
        "source_sha256": source["source_sha256"],
        "source_page": source["source_page"],
        "position_index": source["segment_no"],
        "slot_id": source["slot_id"] or "",
        "instance_id": raw.get("instance_id", ""),
        "analysis_signature": raw.get("analysis_signature", ""),
        "review_record_revision": raw.get("record_revision", 0),
        "final_rect": source["final_rect"],
    }


def _field_fingerprint(raw: Mapping[str, Any], source: Mapping[str, Any], extractor_version: str = "receipt-parties-v1",
                       grouping_version: str | None = None) -> str:
    return digest({
        "source_sha256": source["source_sha256"], "source_page": source["source_page"],
        "final_rect": source["final_rect"], "slot_id": source["slot_id"],
        "parties": _parties(raw), "extractor_version": extractor_version,
        "extraction_dependencies": raw.get("extraction_dependencies"),
        "source_bank": _source_bank(raw),
    })


def _extract_state(raw: Mapping[str, Any], parties: Mapping[str, Any]) -> str:
    sides = ("payer", "payee", "own_observed", "counterparty_observed")
    if not parties or not any(isinstance(parties.get(side), Mapping) for side in sides):
        return "pending"
    # ``normalize_parties`` always creates payer/payee containers.  Presence
    # of those containers alone therefore cannot mean extraction succeeded;
    # an untouched container has six ``missing`` fields.  Explicit blank
    # values still count as a successful extraction (fees/taxes commonly use
    # blank counterparty columns).
    fields = [
        side_value.get(field)
        for side in sides
        if isinstance(side_value := parties.get(side), Mapping)
        for field in ("name", "account", "bank")
    ]
    if not any(isinstance(field, Mapping) and field.get("state") in {"present", "blank", "ambiguous"} for field in fields):
        return "pending"
    diagnostics = raw.get("diagnostics")
    if isinstance(diagnostics, Mapping) and diagnostics.get("status") not in {None, "ok"}:
        return "pending"
    return "ready"


_ROUTES = frozenset({"excluded", "own_pending", "named", "internal", "blank", "special", "counterparty_pending"})


def _call_derive(item: Mapping[str, Any], account: CompanyAccount, *, source_bank: str,
                 manual: Mapping[str, Any] | None = None,
                 groups: Mapping[str, Mapping[str, Any]] | None = None,
                 job_id: str = "") -> dict[str, Any]:
    """Call the single authoritative pure rule engine."""
    return dict(derive_grouping_decision(
        item, account, source_bank=source_bank, manual=manual or {},
        groups=groups or {}, job_id=job_id,
    ))


def _group_from_decision(decision: Mapping[str, Any], *, route: str, label: str) -> dict[str, Any] | None:
    value = decision.get("group")
    if value is None:
        return None
    if not isinstance(value, Mapping) or not isinstance(value.get("group_id"), str) or not value["group_id"].strip():
        raise GroupingValidationError("规则未返回有效分组定义")
    return {
        "group_id": value["group_id"],
        "kind": value.get("kind", route),
        "key": value.get("key", value.get("group_key")),
        "display_name": value.get("display_name", label),
        "manual": bool(value.get("manual", False)),
    }


def _sync_persisted_group_labels(items: Sequence[dict[str, Any]],
                                 groups: Mapping[str, Mapping[str, Any]]) -> None:
    """Apply a persisted manual display name without changing rule semantics.

    A group rename is presentation-only.  The pure rule engine still returns
    the same semantic group key/id, while this store keeps the renamed label
    in every current item and in the group table so export sees one definition
    consistently.
    """
    for item in items:
        group = item.get("group")
        if not isinstance(group, Mapping):
            continue
        if group.get("kind") in {"internal", "special"}:
            continue
        group_id = group.get("group_id")
        definition = groups.get(group_id) if isinstance(group_id, str) else None
        if not isinstance(definition, Mapping) or not bool(definition.get("manual")):
            continue
        item["group"] = {
            **dict(group),
            "display_name": definition.get("display_name", group.get("display_name", group_id)),
            "manual": True,
        }


def _build_item(job_id: str, raw: Mapping[str, Any], index: int, account: CompanyAccount,
                source_bank: str, result_revision: str, review_fingerprint: str,
                manifest_bank: tuple[str, str], previous: Mapping[str, Any] | None = None,
                groups: Mapping[str, Mapping[str, Any]] | None = None,
                grouping_version: str | None = None) -> dict[str, Any]:
    algorithm_version = grouping_version if grouping_version is not None else _current_grouping_version()
    source = _source_fields(raw, index)
    segment_id = _text(raw.get("segment_id", raw.get("item_id", raw.get("id", raw.get("instance_id", "")))),
                       "片段标识", required=False, limit=2048)
    if not segment_id:
        segment_id = item_identifier(raw, index)
    source_value, source_state = _source_bank(raw)
    if not source_value and manifest_bank[0]:
        source_value, source_state = manifest_bank
    effective = dict(raw)
    if source_value:
        effective["source_bank"] = source_value
    if manifest_bank[1] == "mixed":
        effective["source_bank"] = {"state": "mismatch", "value": ""}
    parties = normalize_parties(_parties(effective))
    effective["parties"] = parties
    if raw.get("review_status") == "excluded" or raw.get("excluded") is True or raw.get("persistable") is False:
        effective["excluded"] = True
    special, special_confirmed = _special(effective)
    if special:
        effective["special_type"] = special
        effective["special_confirmed"] = special_confirmed
    extraction_state = _extract_state(effective, parties)
    if effective.get("extraction_state") in {"pending", "ready", "stale", "failed"}:
        extraction_state = str(effective["extraction_state"])
    stable = stable_item_identity({**raw, **source})
    binding = _binding(effective, source, segment_id, job_id)
    extraction_fingerprint = _field_fingerprint(
        effective, source, str(effective.get("extractor_version", "receipt-parties-v1")), algorithm_version,
    )
    same_identity = bool(
        previous
        and previous.get("_stable_identity") == stable
        and previous.get("binding", {}).get("source_key") == source["source_key"]
        and previous.get("binding", {}).get("source_page") == source["source_page"]
        and previous.get("binding", {}).get("slot_id") == source["slot_id"]
        and previous.get("binding", {}).get("final_rect") == source["final_rect"]
    )
    manual = deepcopy(previous.get("_manual", {})) if same_identity and previous else {}
    # Human corrections describe the immutable original, not the parser's
    # latest wording. Keep them across algorithm upgrades of the same crop.
    # If newly read field values change, retain corrections but re-evaluate
    # an uncorrected side/group decision against the new evidence.
    if same_identity and previous and previous.get("extraction_fingerprint") != extraction_fingerprint:
        old_parties = normalize_parties(_parties(previous.get("_raw", {})))
        same_values = all((old_parties.get(side) or {}).get(key, {}).get(attribute)
                          == (parties.get(side) or {}).get(key, {}).get(attribute)
                          for side in ("payer", "payee", "own_observed", "counterparty_observed")
                          for key in ("name", "account", "bank") for attribute in ("value", "state"))
        if extraction_state == "ready" and not same_values:
            without_assignment = {key: value for key, value in manual.items() if key != "assignment"}
            refreshed = _call_derive(effective, account, source_bank=source_bank,
                                     manual=without_assignment, groups=groups or {}, job_id=job_id)
            old_counterparty = previous.get("counterparty") or {}
            new_counterparty = refreshed.get("counterparty") or {}
            same_counterparty = all(old_counterparty.get("name", {}).get(key) == new_counterparty.get("name", {}).get(key)
                                    for key in ("value", "state"))
            same_side = previous.get("own_decision", {}).get("side") == refreshed["own_decision"]["side"]
            if not same_counterparty or not same_side:
                manual.pop("assignment", None)
    if same_identity and previous and (
        previous.get("document_type") != (special or None)
        or previous.get("boundary_status", "confirmed") != str(effective.get("review_status", "confirmed"))
    ):
        manual = {}
    if not isinstance(manual, Mapping):
        manual = {}
    assignment = manual.get("assignment")
    if isinstance(assignment, Mapping):
        target_id = assignment.get("group_id")
        target = (groups or {}).get(target_id) if isinstance(target_id, str) else None
        if isinstance(target, Mapping) and target.get("kind") == "internal":
            # Former versions allowed per-account internal assignments. They
            # no longer control the route; remove the stale reference before
            # prepare drops unused groups. Keep all other human corrections.
            manual.pop("assignment", None)
    decision = _call_derive(effective, account, source_bank=source_bank,
                            manual=manual, groups=groups or {}, job_id=job_id)
    assignment = manual.get("assignment")
    if isinstance(assignment, Mapping):
        decided_group = decision.get("group")
        if not isinstance(decided_group, Mapping) or decided_group.get("group_id") != assignment.get("group_id"):
            # Internal/special/conflict rules can supersede a former named
            # assignment. Do not retain a reference to a group that prepare
            # will remove; still-effective named assignments remain intact.
            manual.pop("assignment", None)
    route_value = decision.get("route")
    if not isinstance(route_value, str) or route_value not in _ROUTES:
        raise GroupingValidationError("规则未返回有效去向")
    route = route_value
    group_value = decision.get("group")
    group_id = None
    group_key = None
    if isinstance(group_value, Mapping):
        group_id = str(group_value.get("group_id", "")) or None
        group_key_value = group_value.get("key", group_value.get("group_key"))
        group_key = None if group_key_value is None else str(group_key_value)
    label_value = decision.get("group_label")
    if isinstance(group_value, Mapping):
        label_value = group_value.get("display_name", label_value)
    label = str(label_value or "待确认")
    group = _group_from_decision(decision, route=route, label=label)
    own_decision = decision.get("own_decision")
    if not isinstance(own_decision, Mapping):
        raise GroupingValidationError("规则未返回本方判断")
    field_overrides = decision.get("field_overrides")
    if not isinstance(field_overrides, list):
        raise GroupingValidationError("规则未返回人工字段")
    counterparty = decision.get("counterparty")
    warnings = decision.get("warnings", [])
    if not isinstance(warnings, list):
        raise GroupingValidationError("规则未返回警告列表")
    decision_method = str(decision.get("decision_method", "none"))
    document_type = decision.get("document_type", special or None)
    if document_type is not None and not isinstance(document_type, str):
        document_type = str(document_type)
    basis = {
        "extraction_fingerprint": extraction_fingerprint,
        "own_account_fingerprint": digest(account.snapshot()),
        "source_bank": source_bank,
        "review_record_revision": effective.get("record_revision", 0),
        "boundary_status": effective.get("review_status", "confirmed"),
        "document_type": special or None,
        "grouping_algorithm_version": algorithm_version,
        "manual": manual,
    }
    item = {
        "binding": binding, "fragment_key": binding["fragment_key"],
        "extraction_fingerprint": extraction_fingerprint, "basis_fingerprint": digest(basis),
        "extraction_state": extraction_state, "extracted": effective.get("parties"),
        "field_overrides": deepcopy(list(field_overrides)), "own_decision": deepcopy(dict(own_decision)),
        "counterparty": deepcopy(counterparty),
        "route": route, "group": group,
        "decision_method": decision_method, "warnings": deepcopy(warnings),
        "boundary_status": str(effective.get("review_status", "confirmed")),
        "document_type": document_type,
        "_stable_identity": stable, "_manual": deepcopy(dict(manual)), "_raw": effective,
    }
    return item


class GroupingStore:
    def __init__(self, database: str | Path | sqlite3.Connection = ":memory:", *, initialize: bool | None = None) -> None:
        self._owns_connection = not isinstance(database, sqlite3.Connection)
        if self._owns_connection:
            path = str(database)
            if path != ":memory:":
                Path(path).parent.mkdir(parents=True, exist_ok=True)
            self.connection = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        else:
            self.connection = database
        self.connection.row_factory = sqlite3.Row
        if initialize is None:
            initialize = self._owns_connection
        if initialize:
            self.connection.execute("PRAGMA foreign_keys = ON")
            self.connection.execute("PRAGMA busy_timeout = 5000")
            self.initialize()
        else:
            self._verify_schema_readonly()

    def initialize(self) -> None:
        try:
            meta_table = self.connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", ("receipt_grouping_meta",)
            ).fetchone()
            if meta_table is not None:
                existing = self.connection.execute(
                    "SELECT schema_version FROM receipt_grouping_meta WHERE schema_name = ?", (SCHEMA_NAME,)
                ).fetchone()
                if existing is not None and int(existing["schema_version"]) != SCHEMA_VERSION:
                    raise GroupingError("本地分组存储版本不兼容")
            self.connection.executescript(SCHEMA)
            row = self.connection.execute(
                "SELECT schema_version FROM receipt_grouping_meta WHERE schema_name = ?", (SCHEMA_NAME,)
            ).fetchone()
            if row is None:
                self.connection.execute(
                    "INSERT INTO receipt_grouping_meta(schema_name, schema_version) VALUES (?, ?)",
                    (SCHEMA_NAME, SCHEMA_VERSION),
                )
            elif int(row["schema_version"]) != SCHEMA_VERSION:
                raise GroupingError("本地分组存储版本不兼容")
        except sqlite3.DatabaseError as exc:
            raise GroupingError("无法初始化本地分组存储") from exc

    def _verify_schema_readonly(self) -> None:
        required = {"receipt_grouping_meta", "receipt_grouping_tasks", "receipt_grouping_items", "receipt_grouping_groups"}
        present = {
            str(row["name"])
            for row in self.connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'receipt_grouping_%'"
            ).fetchall()
        }
        if not required.issubset(present):
            raise GroupingError("本地分组存储尚未初始化")
        row = self.connection.execute(
            "SELECT schema_version FROM receipt_grouping_meta WHERE schema_name = ?", (SCHEMA_NAME,)
        ).fetchone()
        if row is None or int(row["schema_version"]) != SCHEMA_VERSION:
            raise GroupingError("本地分组存储版本不兼容")

    @contextmanager
    def transaction(self, *, immediate: bool = True) -> Iterator[sqlite3.Connection]:
        nested = self.connection.in_transaction
        savepoint = None
        if nested:
            savepoint = "grouping_" + uuid4().hex
            self.connection.execute(f"SAVEPOINT {savepoint}")
        else:
            self.connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        try:
            yield self.connection
        except BaseException:
            if savepoint is None:
                self.connection.rollback()
            else:
                self.connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                self.connection.execute(f"RELEASE SAVEPOINT {savepoint}")
            raise
        else:
            if savepoint is None:
                self.connection.commit()
            else:
                self.connection.execute(f"RELEASE SAVEPOINT {savepoint}")

    def close(self) -> None:
        if self._owns_connection:
            self.connection.close()

    def __enter__(self) -> "GroupingStore":
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        self.close()

    @staticmethod
    def _account(row: sqlite3.Row) -> CompanyAccount:
        return CompanyAccount(
            id=str(row["account_id"]), revision=int(row["account_revision"]),
            company_name=str(row["company_name"]), bank_name=str(row["bank_name"]),
            branch_name=str(row["branch_name"] or ""), account_number=str(row["account_number"]),
            active=bool(row["active"]), created_at=str(row["created_at"]), updated_at=str(row["updated_at"]),
        )

    def account_list(self, *, active_only: bool = True, offset: int = 0, limit: int = 50) -> dict[str, Any]:
        if not isinstance(active_only, bool):
            raise GroupingValidationError("账户筛选条件无效")
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise GroupingValidationError("账户列表偏移无效")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
            raise GroupingValidationError("账户列表数量无效")
        where = " WHERE active = 1" if active_only else ""
        total = int(self.connection.execute(f"SELECT COUNT(*) FROM company_accounts{where}").fetchone()[0])
        rows = self.connection.execute(
            f"SELECT * FROM company_accounts{where} ORDER BY company_name, bank_name, account_id LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        return {
            "items": [self._account(row).to_dict() for row in rows],
            "total": total, "next_offset": offset + limit if offset + limit < total else None,
        }

    def account_save(self, account: Mapping[str, Any], *, account_id: object = None,
                     expected_account_revision: object = 0, active: bool = True) -> dict[str, Any]:
        if not isinstance(active, bool):
            raise GroupingValidationError("账户启用状态无效")
        expected = _revision(expected_account_revision, "账户版本")
        raw = dict(account)
        supplied_id = "" if account_id is None else _text(account_id, "账户编号", required=True, limit=256)
        if supplied_id:
            raw["account_id"] = supplied_id
        profile = validate_account(raw, require_id=False)
        identifier = supplied_id or f"account_{uuid4().hex}"
        with self.transaction():
            row = self.connection.execute("SELECT * FROM company_accounts WHERE account_id = ?", (identifier,)).fetchone()
            now = now_utc()
            if row is None:
                if expected != 0:
                    raise GroupingConflict("账户资料已变化")
                self.connection.execute(
                    "INSERT INTO company_accounts(account_id, account_revision, company_name, bank_name, branch_name, account_number, active, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)",
                    (identifier, profile.company_name, profile.bank_name, profile.branch_name or "", profile.account_number, int(active), now, now),
                )
            else:
                current = self._account(row)
                if current.revision != expected:
                    raise GroupingConflict("账户资料已变化")
                self.connection.execute(
                    "UPDATE company_accounts SET account_revision=?, company_name=?, bank_name=?, branch_name=?, account_number=?, active=?, updated_at=? WHERE account_id=? AND account_revision=?",
                    (current.revision + 1, profile.company_name, profile.bank_name, profile.branch_name or "", profile.account_number, int(active), now, identifier, expected),
                )
                if self.connection.execute("SELECT changes()").fetchone()[0] != 1:
                    raise GroupingConflict("账户资料已变化")
            return self._account(self.connection.execute("SELECT * FROM company_accounts WHERE account_id=?", (identifier,)).fetchone()).to_dict()

    def _task(self, connection: sqlite3.Connection, job_id: str) -> sqlite3.Row:
        row = connection.execute("SELECT * FROM receipt_grouping_tasks WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            raise GroupingNotFound("整理任务不存在")
        return row

    def set_account(self, job_id: object, *, expected_grouping_revision: object,
                    account_selection: Mapping[str, Any], task_state: str | None = None) -> dict[str, Any]:
        job = _id(job_id, "任务编号")
        expected = _revision(expected_grouping_revision)
        if task_state is not None and task_state not in {"queued", "pending", "created"}:
            raise GroupingConflict("任务已开始分析，不能修改本方账户")
        if not isinstance(account_selection, Mapping):
            raise GroupingValidationError("本方账户选择格式无效")
        kind = account_selection.get("kind")
        if kind == "saved":
            account_id = _id(account_selection.get("account_id"), "账户编号")
            account_revision = _revision(account_selection.get("account_revision"), "账户版本")
            if account_revision < 1:
                raise GroupingValidationError("账户版本无效")
            row = self.connection.execute("SELECT * FROM company_accounts WHERE account_id=?", (account_id,)).fetchone()
            if row is None or not bool(row["active"]) or int(row["account_revision"]) != account_revision:
                raise GroupingConflict("账户资料已变化或已停用")
            profile = self._account(row)
            own = profile.snapshot()
        elif kind == "inline":
            profile = validate_account(account_selection.get("account", {}), require_id=False)
            own = profile.snapshot()
            own["account_id"] = None
            own["account_revision"] = None
        else:
            raise GroupingValidationError("本方账户选择格式无效")
        fingerprint = digest(own)
        with self.transaction():
            if kind == "saved":
                # Freeze only a still-current active profile. The initial
                # read preceded this write lock and may have raced an edit.
                current_account = self.connection.execute("SELECT account_revision, active FROM company_accounts WHERE account_id=?", (account_id,)).fetchone()
                if current_account is None or not bool(current_account["active"]) or int(current_account["account_revision"]) != account_revision:
                    raise GroupingConflict("账户资料已变化或已停用")
            row = self.connection.execute("SELECT * FROM receipt_grouping_tasks WHERE job_id=?", (job,)).fetchone()
            if row is None:
                if expected != 0:
                    raise GroupingConflict("整理任务已变化")
                now = now_utc()
                own.update(own_account_revision=1, selected_at=now)
                self.connection.execute(
                    "INSERT INTO receipt_grouping_tasks(job_id, grouping_revision, own_account_json, own_account_fingerprint, source_bank, status, created_at, updated_at) VALUES (?, 0, ?, ?, ?, 'needs_prepare', ?, ?)",
                    (job, canonical_json(own), fingerprint, profile.bank_name, now, now),
                )
            else:
                if int(row["grouping_revision"]) != expected:
                    raise GroupingConflict("整理任务已变化")
                if row["own_account_fingerprint"] == fingerprint:
                    return self.header(job)
                old_items = self._load_items(self.connection, job)
                old_groups = self._load_groups(self.connection, job)
                algorithm_version = _current_grouping_version()
                now = now_utc()
                previous_own = _json(row["own_account_json"])
                own.update(own_account_revision=int(previous_own.get("own_account_revision", 1)) + 1, selected_at=now)
                self.connection.execute(
                    "UPDATE receipt_grouping_tasks SET grouping_revision=grouping_revision+1, own_account_json=?, own_account_fingerprint=?, source_bank=?, basis_json='{}', basis_fingerprint='', status='needs_prepare', updated_at=? WHERE job_id=? AND grouping_revision=?",
                    (canonical_json(own), fingerprint, profile.bank_name, now, job, expected),
                )
                if self.connection.execute("SELECT changes()").fetchone()[0] != 1:
                    raise GroupingConflict("整理任务已变化")
                self._record_history(self.connection, job, expected + 1, old_items, "account_changed")
                self._record_group_history(self.connection, job, expected + 1, old_groups, "account_changed")
                # Keep the verified field extraction cache.  Only the
                # account-dependent decision/manual layer is invalidated;
                # changing the selected company or bank must not force a
                # second PDF read for unchanged source/page/slot fragments.
                rebased: list[dict[str, Any]] = []
                new_task = self._task(self.connection, job)
                for old_item in old_items:
                    value = deepcopy(old_item)
                    value["_manual"] = {}
                    value["field_overrides"] = []
                    if not _extraction_dependencies_current(value.get("_raw", {})):
                        prior_raw = value.get("_raw")
                        if isinstance(prior_raw, Mapping):
                            refreshed_raw = dict(prior_raw)
                            refreshed_raw["extraction_state"] = "stale"
                            value["_raw"] = refreshed_raw
                    rebased.append(self._rebuild_item(job, value, profile, new_task, {}))
                self.connection.execute("DELETE FROM receipt_grouping_items WHERE job_id=?", (job,))
                self.connection.execute("DELETE FROM receipt_grouping_groups WHERE job_id=?", (job,))
                for item in rebased:
                    self._insert_item(self.connection, job, item, now)
                self._write_groups(self.connection, job, rebased, now)
                complete = all(item["route"] in {"excluded", "named", "internal", "blank", "special"} for item in rebased) and all(item["own_decision"].get("status") == "confirmed" for item in rebased if item["route"] != "excluded")
                basis = {
                    "result_revision": new_task["result_revision"],
                    "review_fingerprint": new_task["review_fingerprint"],
                    "own_account_fingerprint": fingerprint,
                    "source_bank": profile.bank_name,
                    "grouping_algorithm_version": algorithm_version,
                    "extraction_algorithm_version": extraction_algorithm_version(),
                    "preserved_extraction_count": len(rebased),
                }
                self.connection.execute(
                    "UPDATE receipt_grouping_tasks SET basis_json=?, basis_fingerprint=?, status=?, updated_at=? WHERE job_id=?",
                    (canonical_json(basis), digest(basis), "ready" if complete else "needs_confirmation", now, job),
                )
            return self.header(job)

    def _profile(self, row: sqlite3.Row) -> CompanyAccount:
        if not row["own_account_json"]:
            raise GroupingConflict("尚未选择本方账户")
        value = _json(row["own_account_json"])
        if value.get("account_revision") is None:
            value["account_revision"] = 1
        return validate_account(value, require_id=False)

    def _load_items(self, connection: sqlite3.Connection, job_id: str, *,
                    segment_ids: Sequence[str] | None = None,
                    offset: int = 0, limit: int | None = None) -> list[dict[str, Any]]:
        where = "job_id=?"
        parameters: list[Any] = [job_id]
        if segment_ids is not None:
            if not segment_ids:
                return []
            where += f" AND segment_id IN ({','.join('?' for _ in segment_ids)})"
            parameters.extend(segment_ids)
        bounds = ""
        if limit is not None:
            bounds = " LIMIT ? OFFSET ?"
            parameters.extend((limit, offset))
        rows = connection.execute(
            f"SELECT * FROM receipt_grouping_items WHERE {where} ORDER BY json_extract(binding_json, '$.source_key'), json_extract(binding_json, '$.source_page'), fragment_key{bounds}",
            parameters,
        ).fetchall()
        result = []
        for row in rows:
            binding = _json(row["binding_json"])
            extracted = None if row["extracted_json"] is None else _json(row["extracted_json"])
            manual = _json(row["manual_json"])
            derived = _json(row["derived_json"])
            result.append({
                "binding": binding, "fragment_key": row["fragment_key"],
                "extraction_fingerprint": row["extraction_fingerprint"],
                "basis_fingerprint": row["basis_fingerprint"],
                "extraction_state": row["extraction_state"], "extracted": extracted,
                "field_overrides": manual.get("field_overrides", []),
                "own_decision": derived.get("own_decision", {}),
                "counterparty": derived.get("counterparty"),
                "route": row["route"],
                "group": derived.get("group"),
                "decision_method": derived.get("decision_method", "automatic"),
                "warnings": derived.get("warnings", []),
                "boundary_status": derived.get("boundary_status", "confirmed"),
                "document_type": derived.get("document_type"),
                "_stable_identity": derived.get("_stable_identity"),
                "_manual": manual, "_raw": derived.get("_raw", {}),
            })
        return result

    def _load_groups(self, connection: sqlite3.Connection, job_id: str) -> dict[str, dict[str, Any]]:
        rows = connection.execute(
            "SELECT group_id, kind, group_key, display_name, manual FROM receipt_grouping_groups WHERE job_id=?",
            (job_id,),
        ).fetchall()
        return {
            str(row["group_id"]): {
                "group_id": str(row["group_id"]),
                "kind": str(row["kind"]),
                "key": row["group_key"],
                "group_key": row["group_key"],
                "display_name": str(row["display_name"]),
                "manual": bool(row["manual"]),
            }
            for row in rows
        }

    def _rebuild_item(self, job: str, item: Mapping[str, Any], profile: CompanyAccount,
                      task: sqlite3.Row, groups: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
        """Re-run pure rules for one stored item after a manual edit."""
        raw = item.get("_raw")
        if not isinstance(raw, Mapping):
            raise GroupingValidationError("片段提取依据缺失")
        source_bank, source_state = _source_bank(raw)
        # The selected account's bank is only the expected value.  It is not
        # evidence that this fragment's issuing bank was identified.  Keep an
        # unknown source unknown until the page/layout extractor provides an
        # explicit heading or the user confirms it.
        manifest = (source_bank, source_state) if source_bank else ("", "unknown")
        position = int(item.get("binding", {}).get("position_index", 1)) - 1
        return _build_item(
            job, raw, position, profile, str(task["source_bank"] or profile.bank_name),
            str(task["result_revision"] or ""), str(task["review_fingerprint"] or ""),
            manifest, item, groups,
        )

    def header(self, job_id: object) -> dict[str, Any]:
        job = _id(job_id, "任务编号")
        task = self._task(self.connection, job)
        totals = self.connection.execute(
            """SELECT COUNT(*) AS total,
               COALESCE(SUM(route='excluded'), 0) AS excluded,
               COALESCE(SUM(route!='excluded' AND extraction_state IN ('pending', 'failed')), 0) AS extraction_pending,
               COALESCE(SUM(route!='excluded' AND COALESCE(json_extract(derived_json, '$.own_decision.status'), '')!='confirmed'), 0) AS own_pending,
               COALESCE(SUM(route='counterparty_pending'), 0) AS counterparty_pending,
               COALESCE(SUM(route NOT IN ('excluded', 'counterparty_pending', 'own_pending')), 0) AS assigned,
               COALESCE(SUM(route!='excluded' AND extraction_state='stale'), 0) AS stale
               FROM receipt_grouping_items WHERE job_id=?""", (job,),
        ).fetchone()
        own = None if not task["own_account_json"] else _json(task["own_account_json"])
        counts = {key: int(totals[key]) for key in totals.keys()}
        return {
            "schema_version": 1, "job_id": job, "result_revision": task["result_revision"],
            "grouping_revision": int(task["grouping_revision"]),
            "own_account": None if own is None else {**own, "fingerprint": task["own_account_fingerprint"], "selected_at": own.get("selected_at", task["created_at"])},
            "review_fingerprint": task["review_fingerprint"], "counts": counts,
            "status": task["status"], "basis_fingerprint": task["basis_fingerprint"],
        }

    def prepare(self, job_id: object, *, result_revision: object, expected_grouping_revision: object,
                authoritative: object = None, review: object = None, source_manifest: object = None,
                review_fingerprint: str | None = None, source_bank: str | None = None) -> dict[str, Any]:
        job = _id(job_id, "任务编号")
        result = _text(result_revision, "分析版本", required=True, limit=1024)
        if isinstance(expected_grouping_revision, bool) or not isinstance(expected_grouping_revision, int) or expected_grouping_revision < -1:
            raise GroupingValidationError("整理版本无效")
        # -1 is a prepare-only sentinel used by the first load.  All other
        # operations use the normal non-negative revision validator.
        expected = expected_grouping_revision
        with self.transaction():
            task = self._task(self.connection, job)
            if int(task["grouping_revision"]) != expected and expected != -1:
                raise GroupingConflict("整理任务已变化")
            profile = self._profile(task)
            algorithm_version = _current_grouping_version()
            source_name = _text(source_bank or task["source_bank"] or profile.bank_name, "来源银行", required=True, limit=256)
            review_fp = _text(review_fingerprint, "审核摘要", limit=128) if review_fingerprint else ""
            manifest_bank = _manifest_bank(source_manifest)
            incoming = _merge(authoritative, review)
            current = self._load_items(self.connection, job)
            previous_basis = _task_basis(task)
            algorithm_changed = bool(current) and previous_basis.get("grouping_algorithm_version") != algorithm_version
            legacy_extraction_basis = bool(current) and "extraction_algorithm_version" not in previous_basis
            dependencies_changed = any(not _extraction_dependencies_current(item.get("_raw", {})) for item in current)
            if not incoming and (algorithm_changed or dependencies_changed or legacy_extraction_basis):
                raise GroupingConflict("分组算法已变化，缺少当前片段依据")
            if not incoming and task["result_revision"] == result and task["review_fingerprint"] == review_fp and not algorithm_changed:
                return {"header": self.header(job), "items": self._public_items(current)}
            previous = {item["_stable_identity"]: item for item in current if item.get("_stable_identity")}
            groups = self._load_groups(self.connection, job)
            build_rows: list[tuple[Mapping[str, Any], Mapping[str, Any] | None]] = []
            for index, raw in enumerate(incoming):
                previous_item = previous.get(stable_item_identity({**raw, **_source_fields(raw, index)}))
                # Prepare is allowed to run again after refresh.  The
                # authoritative review snapshot intentionally contains
                # boundaries/status but no extracted parties; retain the
                # trusted local extraction cache for the same stable fragment
                # instead of converting it back to six missing fields.
                has_parties = any(key in raw for key in ("parties", "receipt_parties", "party_fields", "payer", "payee",
                                                        "own_observed", "counterparty_observed"))
                if previous_item and not has_parties:
                    prior_raw = previous_item.get("_raw")
                    if isinstance(prior_raw, Mapping):
                        raw = {**prior_raw, **dict(raw)}
                if has_parties:
                    raw = stamp_extraction_dependencies(raw)
                elif previous_item and (legacy_extraction_basis or not _extraction_dependencies_current(raw)):
                    # Invalidate only evidence whose common/used-reader
                    # dependency changed. Saved rule activation is deliberately
                    # absent: applying a new rule is an explicit operation.
                    raw = {**dict(raw), "extraction_state": "stale"}
                build_rows.append((raw, previous_item))
            new_items = [_build_item(
                job, raw, index, profile, source_name, result, review_fp, manifest_bank,
                previous_item, groups, algorithm_version,
            ) for index, (raw, previous_item) in enumerate(build_rows)]
            _sync_persisted_group_labels(new_items, groups)
            basis = {"result_revision": result, "review_fingerprint": review_fp, "own_account_fingerprint": task["own_account_fingerprint"], "source_bank": source_name, "source_manifest": manifest_bank, "grouping_algorithm_version": algorithm_version, "extraction_algorithm_version": extraction_algorithm_version()}
            def _item_signature(value: Mapping[str, Any]) -> str:
                return digest({
                    "fragment_key": value.get("fragment_key"),
                    "extraction_fingerprint": value.get("extraction_fingerprint"),
                    "basis_fingerprint": value.get("basis_fingerprint"),
                    "extracted": value.get("extracted"),
                    "manual": value.get("_manual", {}),
                    "derived": {key: value.get(key) for key in ("own_decision", "counterparty", "route", "group", "decision_method", "warnings", "boundary_status", "document_type")},
                })
            unchanged = (
                bool(current) and len(current) == len(new_items)
                and task["result_revision"] == result
                and (task["review_fingerprint"] or "") == review_fp
                and (task["source_bank"] or "") == source_name
                and (task["basis_fingerprint"] or "") == digest(basis)
                # SQLite returns items by source/page/fragment key while the
                # authoritative result follows segment order.  Compare by
                # stable fragment key so a harmless ordering difference does
                # not create a new grouping revision.
                and sorted((_item_signature(item) for item in current)) == sorted((_item_signature(item) for item in new_items))
            )
            if unchanged:
                return {"header": self.header(job), "items": self._public_items(current)}
            next_revision = int(task["grouping_revision"]) + 1 if incoming or expected == -1 else int(task["grouping_revision"])
            now = now_utc()
            if current:
                self._record_history(self.connection, job, next_revision, current, "prepare")
            if groups:
                self._record_group_history(self.connection, job, next_revision, groups, "prepare")
            self.connection.execute("DELETE FROM receipt_grouping_items WHERE job_id=?", (job,))
            self.connection.execute("DELETE FROM receipt_grouping_groups WHERE job_id=?", (job,))
            for item in new_items:
                self._insert_item(self.connection, job, item, now)
            self._write_groups(self.connection, job, new_items, now)
            complete = all(item["route"] in {"excluded", "named", "internal", "blank", "special"} for item in new_items) and all(item["own_decision"].get("status") == "confirmed" for item in new_items if item["route"] != "excluded")
            self.connection.execute(
                "UPDATE receipt_grouping_tasks SET grouping_revision=?, result_revision=?, review_fingerprint=?, source_bank=?, basis_json=?, basis_fingerprint=?, status=?, updated_at=? WHERE job_id=?",
                (next_revision, result, review_fp, source_name, canonical_json(basis), digest(basis), "ready" if complete else "needs_confirmation", now, job),
            )
            return {"header": self.header(job), "items": self._public_items(new_items)}

    def _insert_item(self, connection: sqlite3.Connection, job: str, item: Mapping[str, Any], now: str) -> None:
        values = self._item_values(item)
        connection.execute(
            "INSERT INTO receipt_grouping_items(job_id, fragment_key, segment_id, binding_json, extraction_fingerprint, basis_fingerprint, extracted_json, manual_json, derived_json, extraction_state, route, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (job, *values, now, now),
        )

    @staticmethod
    def _item_values(item: Mapping[str, Any]) -> tuple:
        manual = item.get("_manual", {})
        if not isinstance(manual, Mapping):
            manual = {}
        derived = {key: item.get(key) for key in ("own_decision", "counterparty", "group", "decision_method", "warnings", "boundary_status", "document_type", "_stable_identity", "_raw")}
        binding = item["binding"]
        return (item["fragment_key"], binding["segment_id"], canonical_json(binding), item["extraction_fingerprint"], item["basis_fingerprint"], None if item.get("extracted") is None else canonical_json(item["extracted"]), canonical_json(manual), canonical_json(derived), item["extraction_state"], item["route"], None if item.get("group") is None else item["group"].get("group_id"))

    def _update_item(self, connection: sqlite3.Connection, job: str, item: Mapping[str, Any], now: str) -> None:
        values = self._item_values(item)
        connection.execute(
            """UPDATE receipt_grouping_items SET segment_id=?, binding_json=?, extraction_fingerprint=?,
               basis_fingerprint=?, extracted_json=?, manual_json=?, derived_json=?, extraction_state=?,
               route=?, group_id=?, updated_at=? WHERE job_id=? AND fragment_key=?""",
            (*values[1:], now, job, values[0]),
        )
        if connection.execute("SELECT changes()").fetchone()[0] != 1:
            raise GroupingConflict("片段已变化")

    def _write_groups(self, connection: sqlite3.Connection, job: str, items: Sequence[Mapping[str, Any]], now: str) -> None:
        seen: dict[str, Mapping[str, Any]] = {}
        for item in items:
            group = item.get("group")
            if isinstance(group, Mapping) and isinstance(group.get("group_id"), str):
                seen.setdefault(group["group_id"], group)
        for group_id, group in seen.items():
            connection.execute(
                "INSERT INTO receipt_grouping_groups(job_id, group_id, kind, group_key, display_name, manual, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (job, group_id, group.get("kind", "named"), group.get("key"), group.get("display_name", group_id), int(bool(group.get("manual", False))), now, now),
            )

    def _record_history(self, connection: sqlite3.Connection, job: str, revision: int,
                        items: Sequence[Mapping[str, Any]], reason: str) -> None:
        """Keep the previous current rows before an atomic replacement."""
        if not items:
            return
        existing = int(connection.execute(
            "SELECT COUNT(*) FROM receipt_grouping_history WHERE job_id=?", (job,)
        ).fetchone()[0])
        if existing + len(items) > MAX_HISTORY_ROWS:
            raise GroupingValidationError("整理历史已达到本任务上限，请先归档任务")
        now = now_utc()
        for item in items:
            fragment = str(item.get("fragment_key") or item.get("binding", {}).get("segment_id", ""))
            if not fragment:
                continue
            previous = self._public_items([item])[0]
            previous["manual"] = deepcopy(item.get("_manual", {}))
            connection.execute(
                """INSERT OR REPLACE INTO receipt_grouping_history
                   (job_id, grouping_revision, entity_kind, entity_id, previous_json, reason, changed_at)
                   VALUES (?, ?, 'item', ?, ?, ?, ?)""",
                (job, revision, fragment, canonical_json(previous), reason, now),
            )

    def _record_group_history(self, connection: sqlite3.Connection, job: str, revision: int,
                              groups: Mapping[str, Mapping[str, Any]], reason: str) -> None:
        """Keep previous group definitions when a group table is replaced."""
        if not groups:
            return
        existing = int(connection.execute(
            "SELECT COUNT(*) FROM receipt_grouping_history WHERE job_id=?", (job,)
        ).fetchone()[0])
        if existing + len(groups) > MAX_HISTORY_ROWS:
            raise GroupingValidationError("整理历史已达到本任务上限，请先归档任务")
        now = now_utc()
        for group_id, group in groups.items():
            previous = {
                "group_id": str(group_id),
                "kind": group.get("kind", "named"),
                "key": group.get("key", group.get("group_key")),
                "display_name": group.get("display_name", group_id),
                "manual": bool(group.get("manual", False)),
            }
            connection.execute(
                """INSERT OR REPLACE INTO receipt_grouping_history
                   (job_id, grouping_revision, entity_kind, entity_id, previous_json, reason, changed_at)
                   VALUES (?, ?, 'group', ?, ?, ?, ?)""",
                (job, revision, str(group_id), canonical_json(previous), reason, now),
            )

    @staticmethod
    def _public_items(items: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
        result = []
        for item in items:
            result.append({key: deepcopy(value) for key, value in item.items() if not key.startswith("_")})
        return result

    def page(self, job_id: object, *, result_revision: object, expected_grouping_revision: object,
             expected_review_fingerprint: object, offset: int, limit: int) -> dict[str, Any]:
        job = _id(job_id, "任务编号")
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise GroupingValidationError("分页偏移无效")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
            raise GroupingValidationError("分页数量无效")
        task = self._task(self.connection, job)
        _require_current_grouping_version(task)
        header = self.header(job)
        if header["result_revision"] != _text(result_revision, "分析版本", required=True):
            raise GroupingConflict("分析结果已变化")
        if header["grouping_revision"] != _revision(expected_grouping_revision):
            raise GroupingConflict("分组结果已变化")
        if (header["review_fingerprint"] or "") != (_text(expected_review_fingerprint, "审核摘要") if expected_review_fingerprint else ""):
            raise GroupingConflict("审核结果已变化")
        total = header["counts"]["total"]
        if offset > total:
            raise GroupingValidationError("分页偏移超出范围")
        items = self._public_items(self._load_items(self.connection, job, offset=offset, limit=limit))
        end = offset + len(items)
        return {"header": header, "offset": offset, "total": total, "items": items, "next_offset": end if end < total else None}

    def save(self, job_id: object, *, result_revision: object, expected_grouping_revision: object,
             expected_review_fingerprint: object, edits: Sequence[Mapping[str, Any]],
             group_edits: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        job = _id(job_id, "任务编号")
        result = _text(result_revision, "分析版本", required=True)
        expected = _revision(expected_grouping_revision)
        if not isinstance(edits, Sequence) or isinstance(edits, (str, bytes, bytearray)) or len(edits) > 200:
            raise GroupingValidationError("片段修改数量无效")
        if not isinstance(group_edits, Sequence) or isinstance(group_edits, (str, bytes, bytearray)) or len(group_edits) > 200:
            raise GroupingValidationError("分组修改数量无效")
        with self.transaction():
            task = self._task(self.connection, job)
            _require_current_grouping_version(task)
            if int(task["grouping_revision"]) != expected or task["result_revision"] != result:
                raise GroupingConflict("整理任务已变化")
            current_fp = task["review_fingerprint"] or ""
            provided_fp = _text(expected_review_fingerprint, "审核摘要") if expected_review_fingerprint else ""
            if current_fp != provided_fp:
                raise GroupingConflict("审核结果已变化")
            items = self._load_items(self.connection, job)
            previous_items = deepcopy(items)
            by_segment = {item["binding"]["segment_id"]: item for item in items}
            if len({edit.get("segment_id") for edit in edits}) != len(edits):
                raise GroupingValidationError("片段修改重复")
            groups = {row["group_id"]: dict(row) for row in self.connection.execute("SELECT * FROM receipt_grouping_groups WHERE job_id=?", (job,)).fetchall()}
            old_groups = deepcopy(groups)
            for edit in group_edits:
                if not isinstance(edit, Mapping):
                    raise GroupingValidationError("分组修改格式无效")
                action = edit.get("action")
                group_id = _text(edit.get("group_id"), "分组编号", required=True, limit=256)
                if action == "create":
                    if not group_id.startswith("manual-") or group_id in groups:
                        raise GroupingValidationError("人工分组编号无效")
                    kind = edit.get("kind")
                    if kind != "named":
                        raise GroupingValidationError("内部往来统一按本批公司名称归组，不能另建内部组")
                    name = _text(edit.get("display_name"), "分组名称", required=True, limit=256)
                    groups[group_id] = {"group_id": group_id, "kind": kind, "group_key": None, "display_name": name, "manual": 1}
                elif action == "rename":
                    if group_id not in groups:
                        raise GroupingNotFound("分组不存在")
                    if groups[group_id]["kind"] in {"internal", "special", "counterparty_pending", "blank"}:
                        raise GroupingValidationError("此分类名称由整理规则确定，不能重命名")
                    groups[group_id]["display_name"] = _text(edit.get("display_name"), "分组名称", required=True, limit=256)
                    groups[group_id]["manual"] = 1
                else:
                    raise GroupingValidationError("分组操作无效")
            for edit in edits:
                if not isinstance(edit, Mapping):
                    raise GroupingValidationError("片段修改格式无效")
                segment_id = _text(edit.get("segment_id"), "片段标识", required=True)
                if segment_id not in by_segment:
                    raise GroupingNotFound("片段不存在")
                item = by_segment[segment_id]
                if _text(edit.get("expected_basis_fingerprint"), "依据版本", required=True, limit=128) != item["basis_fingerprint"]:
                    raise GroupingConflict("片段依据已变化")
                if item["route"] == "excluded":
                    overrides = edit.get("field_overrides")
                    if edit.get("assignment") is not None or (
                        isinstance(overrides, list) and any(
                            isinstance(value, Mapping) and value.get("side") == "counterparty"
                            and value.get("field") == "name" and value.get("state") == "present"
                            for value in overrides
                        )
                    ):
                        raise GroupingValidationError("已排除回单不能修改交易对手或归组")
                    continue
                manual = deepcopy(item.get("_manual", {}))
                if not isinstance(manual, dict):
                    manual = {}
                counterparty_name_changed = False
                if "field_overrides" in edit:
                    override = edit["field_overrides"]
                    old_values = manual.get("field_overrides", [])
                    old_map = {
                        (str(value.get("side")), str(value.get("field"))): (value.get("value"), value.get("state"))
                        for value in old_values if isinstance(value, Mapping)
                    } if isinstance(old_values, list) else {}
                    new_map: dict[tuple[str, str], tuple[object, object]] = {}
                    if override is None:
                        # The desktop contract uses null to clear a prior
                        # correction while keeping the extracted source.
                        manual.pop("field_overrides", None)
                    else:
                        if not isinstance(override, Sequence) or isinstance(override, (str, bytes, bytearray)) or len(override) > 9:
                            raise GroupingValidationError("字段覆盖格式无效")
                        cleaned = []
                        seen = set()
                        for value in override:
                            if not isinstance(value, Mapping) or set(value) != {"side", "field", "value", "state", "reason"}:
                                raise GroupingValidationError("字段覆盖格式无效")
                            side = value.get("side")
                            field = value.get("field")
                            state = value.get("state")
                            if side not in {"payer", "payee", "counterparty"} or field not in {"name", "account", "bank"} or state not in {"present", "blank"}:
                                raise GroupingValidationError("字段覆盖格式无效")
                            if (side, field) in seen:
                                raise GroupingValidationError("字段覆盖重复")
                            seen.add((side, field))
                            reason = _text(value.get("reason"), "人工说明", required=True, limit=1000)
                            text = _text(value.get("value"), "字段值", required=False, limit=4096)
                            if (state == "blank" and text) or (state == "present" and not text):
                                raise GroupingValidationError("字段覆盖状态与值不一致")
                            cleaned.append({"side": side, "field": field, "value": text, "state": state, "reason": reason})
                            new_map[(str(side), str(field))] = (text, state)
                        manual["field_overrides"] = cleaned
                    changed_sides = {
                        key[0] for key in set(old_map) | set(new_map)
                        if old_map.get(key) != new_map.get(key)
                    }
                    name_key = ("counterparty", "name")
                    counterparty_name_changed = (
                        name_key in new_map and new_map[name_key][1] == "present"
                        and old_map.get(name_key) != new_map[name_key]
                    )
                    # A payer/payee correction changes the basis on which an
                    # old manual own-side confirmation was made.  A
                    # counterparty-only edit on a confirmed single-party
                    # voucher is allowed to retain ``side=single`` so the
                    # pure rule can apply that override.
                    if changed_sides - {"counterparty"}:
                        manual.pop("own_confirmation", None)
                    # Only an actual value/state change changes the semantic
                    # group key or its evidence.  Re-sending the same full
                    # override list must leave a prior assignment intact.
                    if changed_sides:
                        manual.pop("assignment", None)
                if "own_confirmation" in edit:
                    confirmation = edit["own_confirmation"]
                    if confirmation is None:
                        manual.pop("own_confirmation", None)
                    elif (not isinstance(confirmation, Mapping)
                          or set(confirmation) != {"side", "confirms_selected_account", "confirms_source_bank", "reason"}
                          or confirmation.get("side") not in {"payer", "payee", "single"}
                          or confirmation.get("confirms_selected_account") is not True
                          or confirmation.get("confirms_source_bank") is not True):
                        raise GroupingValidationError("本方确认格式无效")
                    else:
                        manual["own_confirmation"] = {
                            "side": confirmation["side"],
                            "confirms_selected_account": True,
                            "confirms_source_bank": True,
                            "reason": _text(confirmation["reason"], "人工说明", required=True, limit=1000),
                        }
                assignment_basis = None
                if counterparty_name_changed or edit.get("assignment") is not None:
                    if item["extraction_state"] != "ready":
                        raise GroupingValidationError("请先完成当前回单字段读取，再修改交易对手或归组")
                    # Check the corrected fields, without allowing an old
                    # assignment to hide their actual route. This lets an
                    # incorrectly identified internal transfer be corrected
                    # and assigned in the same atomic request.
                    candidate = {**item, "_manual": {key: value for key, value in manual.items() if key != "assignment"}}
                    assignment_basis = self._rebuild_item(job, candidate, self._profile(task), task, groups)
                    if (assignment_basis["own_decision"].get("status") != "confirmed"
                            or "batch_identity_conflict" in assignment_basis["warnings"]):
                        raise GroupingValidationError("本方信息存在冲突，请先核对本方字段")
                    if counterparty_name_changed and assignment_basis["route"] == "special":
                        raise GroupingValidationError("特殊凭证按固定分类整理，请先核对凭证类型")
                if "assignment" in edit:
                    assignment = edit["assignment"]
                    if assignment is None:
                        manual.pop("assignment", None)
                    elif not isinstance(assignment, Mapping) or set(assignment) != {"group_id", "reason"}:
                        raise GroupingValidationError("分组归属格式无效")
                    else:
                        group_id = _text(assignment.get("group_id"), "分组编号", required=True, limit=256)
                        if group_id not in groups:
                            raise GroupingNotFound("分组不存在")
                        automatic_service = (assignment_basis["route"] == "special" and assignment_basis.get("document_type") in {None, "ordinary"}
                            and (assignment_basis.get("extracted") or {}).get("service_type") in {"bank_fee", "deposit_interest"}
                            and ((assignment_basis.get("counterparty") or {}).get("name") or {}).get("state") == "blank")
                        if (assignment_basis["route"] == "internal" or (assignment_basis["route"] == "special" and not automatic_service)
                                or groups[group_id]["kind"] != "named"):
                            raise GroupingValidationError("内部往来和特殊凭证按固定分类整理，请修正字段后重新判断")
                        manual["assignment"] = {
                            "group_id": group_id,
                            "reason": _text(assignment.get("reason"), "人工说明", required=True, limit=1000),
                        }
                item["_manual"] = manual
                # All three manual decisions are inputs to the pure rule
                # engine.  Recompute the whole result so an own-side change,
                # field correction, or assignment clear cannot leave stale
                # route/group/counterparty values behind.
                rebuilt = self._rebuild_item(job, item, self._profile(task), task, groups)
                item.clear()
                item.update(rebuilt)
                # A field correction can derive a new named group. Persist
                # that group as well as its item so a subsequent bulk move
                # can select the group shown in the directory.
                definition = item.get("group")
                if definition is not None and definition["group_id"] not in groups:
                    groups[definition["group_id"]] = {
                        **definition, "group_key": definition.get("key", definition.get("group_key")),
                    }
            _sync_persisted_group_labels(items, groups)
            now = now_utc()
            next_revision = expected + 1
            changed_pairs = [(before, after) for before, after in zip(previous_items, items)
                             if self._item_values(before) != self._item_values(after)]
            changed_groups = {key: before for key, before in old_groups.items()
                              if any(before.get(field) != groups[key].get(field)
                                     for field in ("kind", "group_key", "display_name", "manual"))}
            self._record_history(self.connection, job, next_revision, [before for before, _ in changed_pairs], "save")
            self._record_group_history(self.connection, job, next_revision, changed_groups, "save")
            for _, item in changed_pairs:
                self._update_item(self.connection, job, item, now)
            for key, group in groups.items():
                if key in old_groups and key not in changed_groups:
                    continue
                self.connection.execute(
                    """INSERT INTO receipt_grouping_groups(job_id, group_id, kind, group_key, display_name, manual, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, group_id) DO UPDATE SET
                       kind=excluded.kind, group_key=excluded.group_key, display_name=excluded.display_name,
                       manual=excluded.manual, updated_at=excluded.updated_at""",
                    (job, group["group_id"], group["kind"], group.get("group_key"), group["display_name"], int(bool(group.get("manual"))), now, now),
                )
            complete = all(item["route"] in {"excluded", "named", "internal", "blank", "special"} for item in items) and all(item["own_decision"].get("status") == "confirmed" for item in items if item["route"] != "excluded")
            self.connection.execute("UPDATE receipt_grouping_tasks SET grouping_revision=?, status=?, updated_at=? WHERE job_id=? AND grouping_revision=?", (next_revision, "ready" if complete else "needs_confirmation", now, job, expected))
            if self.connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise GroupingConflict("整理任务已变化")
            edited_ids = {edit.get("segment_id") for edit in edits if isinstance(edit, Mapping)}
            changed_items = [item for item in items if item["binding"]["segment_id"] in edited_ids]
            return {"header": self.header(job), "items": self._public_items(changed_items)}

    def refresh(self, job_id: object, *, result_revision: object, expected_grouping_revision: object,
                expected_review_fingerprint: object, segment_ids: Sequence[object],
                source_reader: Callable[..., Mapping[str, Any] | None] | None = None,
                verify_sources: bool = True) -> dict[str, Any]:
        job = _id(job_id, "任务编号")
        if not isinstance(segment_ids, Sequence) or isinstance(segment_ids, (str, bytes, bytearray)) or not 1 <= len(segment_ids) <= MAX_REFRESH_IDS:
            raise GroupingValidationError("单次最多提取50个片段")
        ids = [_text(value, "片段标识", required=True) for value in segment_ids]
        if len(set(ids)) != len(ids):
            raise GroupingValidationError("片段标识重复")
        with self.transaction():
            task = self._task(self.connection, job)
            _require_current_grouping_version(task)
            expected = _revision(expected_grouping_revision)
            if int(task["grouping_revision"]) != expected or task["result_revision"] != _text(result_revision, "分析版本", required=True):
                raise GroupingConflict("整理任务已变化")
            if (task["review_fingerprint"] or "") != (_text(expected_review_fingerprint, "审核摘要") if expected_review_fingerprint else ""):
                raise GroupingConflict("审核结果已变化")
            profile = self._profile(task)
            items = self._load_items(self.connection, job, segment_ids=ids)
            by_segment = {item["binding"]["segment_id"]: item for item in items}
            if any(value not in by_segment for value in ids):
                raise GroupingNotFound("片段不存在")
            pages = {(item["binding"]["source_key"], item["binding"]["source_page"]) for item in items if item["binding"]["segment_id"] in ids}
            if len(pages) > MAX_REFRESH_PAGES:
                raise GroupingValidationError("单次最多读取200页")
            groups = self._load_groups(self.connection, job)
            previous_items = []
            changed_items = []
            for segment_id in ids:
                item = by_segment[segment_id]
                path_value = item["binding"].get("source_path") or item["_raw"].get("source_path")
                expected_sha = item["binding"].get("source_sha256")
                if not path_value or not expected_sha:
                    raise GroupingSourceChanged("原始文件缺少校验信息")
                path = Path(path_value)
                if verify_sources:
                    actual = _source_sha(path)
                    if len(expected_sha) == 64 and actual != expected_sha:
                        raise GroupingSourceChanged("原始文件校验值已变化")
                if source_reader is not None:
                    refreshed = source_reader(path, item["binding"]["source_page"], deepcopy(item))
                    if refreshed is not None:
                        if not isinstance(refreshed, Mapping):
                            raise GroupingValidationError("提取结果格式无效")
                        candidate_raw = {**item["_raw"], **dict(refreshed)}
                        if any(key in refreshed for key in ("parties", "receipt_parties", "party_fields", "payer", "payee",
                                                            "own_observed", "counterparty_observed")) and "field_rule_basis" not in refreshed:
                            candidate_raw.pop("field_rule_basis", None)
                        candidate_raw = stamp_extraction_dependencies(candidate_raw)
                        if canonical_json(candidate_raw) == canonical_json(item["_raw"]):
                            continue
                        # Rebuild this item through the same pure decision
                        # path as prepare.  This updates extraction/basis
                        # fingerprints and re-evaluates route/group while
                        # retaining the previous manual record only when the
                        # stable source/layout identity is unchanged.
                        manifest_value, manifest_state = _source_bank(candidate_raw)
                        rebuilt = _build_item(
                            job, candidate_raw, int(item["binding"].get("position_index", 1)) - 1,
                            profile, str(task["source_bank"] or profile.bank_name),
                            str(task["result_revision"] or ""), str(task["review_fingerprint"] or ""),
                            (manifest_value, manifest_state),
                            item, groups,
                        )
                        extracted_state = refreshed.get("extraction_state")
                        if extracted_state in {"pending", "ready", "stale", "failed"}:
                            rebuilt["extraction_state"] = extracted_state
                        previous_items.append(deepcopy(item))
                        item.clear()
                        item.update(rebuilt)
                        changed_items.append(item)
            if not changed_items:
                return {"header": self.header(job), "items": self._public_items([item for item in items if item["binding"]["segment_id"] in ids])}
            _sync_persisted_group_labels(changed_items, groups)
            next_revision = expected + 1
            now = now_utc()
            self._record_history(self.connection, job, next_revision, previous_items, "refresh")
            # A refresh changes only the requested fields. Existing group
            # definitions (including manual labels and unused groups) stay
            # intact; only newly derived groups need insertion, not history.
            for item in changed_items:
                self._update_item(self.connection, job, item, now)
                group = item.get("group")
                if (isinstance(group, Mapping) and isinstance(group.get("group_id"), str)
                        and group["group_id"] not in groups):
                    groups[group["group_id"]] = group
                    self.connection.execute(
                        "INSERT INTO receipt_grouping_groups(job_id, group_id, kind, group_key, display_name, manual, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (job, group["group_id"], group.get("kind", "named"), group.get("key", group.get("group_key")), group.get("display_name", group["group_id"]), int(bool(group.get("manual"))), now, now),
                    )
            self.connection.execute("UPDATE receipt_grouping_tasks SET grouping_revision=?, updated_at=? WHERE job_id=? AND grouping_revision=?", (next_revision, now, job, expected))
            if self.connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise GroupingConflict("整理任务已变化")
            return {"header": self.header(job), "items": self._public_items([item for item in items if item["binding"]["segment_id"] in ids])}

    def pending_segment_ids(self, job_id: object, segment_ids: Sequence[str], *,
                            expected_grouping_revision: int, expected_review_fingerprint: str) -> set[str]:
        """Read only selected extraction states; never materialize the entire job."""
        job = _id(job_id, "任务编号")
        task = self._task(self.connection, job)
        _require_current_grouping_version(task)
        if task["grouping_revision"] != _revision(expected_grouping_revision):
            raise GroupingConflict("整理任务已变化")
        if task["review_fingerprint"] != expected_review_fingerprint:
            raise GroupingConflict("审核结果已变化")
        if not segment_ids or len(segment_ids) > MAX_REFRESH_IDS or len(set(segment_ids)) != len(segment_ids):
            raise GroupingValidationError("每次只能提取1至50个不同片段")
        ids = [_id(value, "片段编号") for value in segment_ids]
        rows = self.connection.execute(
            f"SELECT segment_id, extraction_state, route FROM receipt_grouping_items WHERE job_id=? AND segment_id IN ({','.join('?' for _ in ids)})",
            (job, *ids),
        ).fetchall()
        if len(rows) != len(ids):
            raise GroupingValidationError("选中片段不在当前结果中")
        return {row["segment_id"] for row in rows if row["extraction_state"] != "ready" and row["route"] != "excluded"}

    def export_snapshot(self, job_id: object, *, expected_grouping_revision: int | None = None,
                        expected_review_fingerprint: str | None = None,
                        require_complete: bool = True) -> dict[str, Any]:
        job = _id(job_id, "任务编号")
        task = self._task(self.connection, job)
        _require_current_grouping_version(task)
        header = self.header(job)
        if expected_grouping_revision is not None and header["grouping_revision"] != _revision(expected_grouping_revision):
            raise GroupingConflict("整理任务已变化")
        if expected_review_fingerprint is not None and header["review_fingerprint"] != expected_review_fingerprint:
            raise GroupingConflict("审核结果已变化")
        items = self._public_items(self._load_items(self.connection, job))
        if require_complete:
            if header["counts"]["own_pending"] or header["counts"]["extraction_pending"] or header["counts"]["stale"]:
                raise GroupingIncomplete("仍有回单需要确认，暂不能导出")
            if header["counts"]["counterparty_pending"]:
                raise GroupingIncomplete("仍有交易对手需要确认，暂不能导出")
            if any(item["route"] == "excluded" and item.get("group") for item in items):
                raise GroupingIncomplete("排除回单不能进入导出分组")
        return {"header": header, "items": items, "groups": self._public_groups(job), "exportable": not require_complete or header["status"] == "ready"}

    def _public_groups(self, job: str) -> list[dict[str, Any]]:
        rows = self.connection.execute("SELECT group_id, kind, group_key, display_name, manual FROM receipt_grouping_groups WHERE job_id=? ORDER BY display_name, group_id", (job,)).fetchall()
        return [{"group_id": row["group_id"], "kind": row["kind"], "key": row["group_key"], "display_name": row["display_name"], "manual": bool(row["manual"])} for row in rows]


@contextmanager
def batch_then_review_transaction(batch_connection: sqlite3.Connection, review_connection: sqlite3.Connection) -> Iterator[tuple[sqlite3.Connection, sqlite3.Connection]]:
    """Acquire batch then review locks; never acquire them in reverse order."""
    if batch_connection is review_connection:
        raise GroupingValidationError("批次库与审核库不能使用同一连接")
    batch_connection.execute("BEGIN IMMEDIATE")
    try:
        review_connection.execute("BEGIN IMMEDIATE")
        try:
            yield batch_connection, review_connection
        except BaseException:
            review_connection.rollback()
            batch_connection.rollback()
            raise
        else:
            review_connection.commit()
            batch_connection.commit()
    except BaseException:
        if review_connection.in_transaction:
            review_connection.rollback()
        if batch_connection.in_transaction:
            batch_connection.rollback()
        raise


def read_grouping_export_snapshot(connection: sqlite3.Connection, job_id: object, *,
                                  expected_grouping_revision: int | None = None,
                                  expected_review_fingerprint: str | None = None,
                                  require_complete: bool = True) -> dict[str, Any]:
    """Read a grouping snapshot on an already-held review connection.

    No transaction, lock, or source read is opened here.  Export code calls
    this while holding the existing batch -> review lock pair.
    """
    store = GroupingStore(connection)
    return store.export_snapshot(job_id, expected_grouping_revision=expected_grouping_revision,
                                 expected_review_fingerprint=expected_review_fingerprint,
                                 require_complete=require_complete)


__all__ = ["GroupingStore", "SCHEMA", "batch_then_review_transaction", "read_grouping_export_snapshot"]
