"""Frozen grouped-by-counterparty receipt export planning.

The ordinary receipt export planner is intentionally source-oriented.  This
module adds grouped output modes without changing that planner's output
shape. It accepts a grouping snapshot that was read by the
trusted grouping backend while the export scope's review lock is held; browser
supplied group membership, geometry, or field values are never accepted.

The module is pure after the caller has supplied the already validated receipt
scope.  It validates route conservation and cross-group geometry, builds one
PDF descriptor per group or one PDF with consecutive groups, and creates an
XLSX index/mapping plan keyed by the individual receipt segment.
"""

from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
import hashlib
import json
import math
import re
import unicodedata
from typing import Any, Mapping, Sequence

from .export_plan import MAX_EXPORT_FILENAME_LENGTH, _limit_utf16, _utf16_units, _normalise_output_name, _output_filename
from .export_scope import ExportScopeError, GROUPED_OUTPUT_MODES, _digest
from .receipt_group_labels import group_display_name
from .receipt_export_plan import _material_overlap


GROUPED_INDEX_HEADERS = (
    "source_key", "source_file", "source_sha256", "source_page", "instance_id", "slot_id",
    "position_index", "output_file", "output_page", "group_id", "group_kind", "group_name",
    "route", "extraction_state", "own_status", "own_side", "own_method", "source_bank_status",
    "counterparty_side", "counterparty_name_raw", "counterparty_name", "counterparty_account_raw",
    "counterparty_account", "counterparty_bank_raw", "counterparty_bank", "field_overrides",
    "payer_name_raw", "payer_name", "payer_name_state", "payer_name_evidence",
    "payer_account_raw", "payer_account", "payer_account_state", "payer_account_evidence",
    "payer_bank_raw", "payer_bank", "payer_bank_state", "payer_bank_evidence",
    "payee_name_raw", "payee_name", "payee_name_state", "payee_name_evidence",
    "payee_account_raw", "payee_account", "payee_account_state", "payee_account_evidence",
    "payee_bank_raw", "payee_bank", "payee_bank_state", "payee_bank_evidence",
    "basis", "warnings", "processed_at",
)

GROUPED_MAPPING_HEADERS = (
    "segment_id", "group_id", "group_kind", "group_name", "source_key", "source_file",
    "source_page", "position_index", "output_file", "output_page", "route",
)

# Keep the machine-readable ``索引`` worksheet stable for integrations while
# giving finance staff a Chinese, side-by-side review sheet.
GROUPED_DETAIL_HEADERS = (
    "来源文件", "来源页", "栏位序号", "付款方名称", "付款方账号", "付款方开户行",
    "收款方名称", "收款方账号", "收款方开户行", "本方方向", "交易对手名称",
    "交易对手账号", "交易对手开户行", "归组名称", "归组类型", "处理去向",
    "识别状态", "输出文件", "输出页", "识别依据", "人工修正", "提示",
)

_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_ROUTES = {"named", "internal", "blank", "special", "counterparty_pending"}
_PENDING_ROUTES = {"pending", "counterparty_pending", "needs_confirmation"}
_MAX_ITEMS = 50_000
MAX_GROUPED_OUTPUT_FILES = 501
_RECT_FIELDS = ("x0", "y0", "x1", "y1")
_WINDOWS_ILLEGAL = re.compile(r'[<>:"/\\|?*]')
_RESERVED_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{index}" for index in range(1, 10)),
    *(f"lpt{index}" for index in range(1, 10)),
}


def _fail(message: str, code: str = "export_scope_invalid") -> None:
    raise ExportScopeError(message, code)


def _mapping(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _fail(f"{label} is invalid")
    return value


def _text(value: object, label: str, *, required: bool = True) -> str:
    if not isinstance(value, str) or "\x00" in value or (required and not value.strip()):
        _fail(f"{label} is invalid")
    return value


def _safe_revision(value: object, label: str) -> int:
    if type(value) is not int or value < 0 or value >= 2**53:
        _fail(f"{label} is invalid")
    return value


def _fingerprint(value: object, label: str) -> str:
    value = _text(value, label)
    if _SHA256.fullmatch(value) is None:
        _fail(f"{label} is invalid")
    return value


def _rect(value: object, label: str) -> dict[str, float]:
    raw = _mapping(value, label)
    if set(raw) != set(_RECT_FIELDS):
        _fail(f"{label} is invalid")
    result: dict[str, float] = {}
    for edge in _RECT_FIELDS:
        number = raw[edge]
        if isinstance(number, bool) or not isinstance(number, (int, float)):
            _fail(f"{label} is invalid")
        converted = float(number)
        if not math.isfinite(converted):
            _fail(f"{label} is invalid")
        result[edge] = converted
    if not (result["x0"] < result["x1"] and result["y0"] < result["y1"]):
        _fail(f"{label} is invalid")
    return result


def _full_page_rect(record: Mapping[str, Any]) -> dict[str, float]:
    original = _mapping(record.get("original"), "record.original")
    geometry = _mapping(original.get("page_geometry"), "record.original.page_geometry")
    width = geometry.get("width_pt")
    height = geometry.get("height_pt")
    if isinstance(width, bool) or isinstance(height, bool) or not isinstance(width, (int, float)) or not isinstance(height, (int, float)):
        _fail("record page geometry is invalid", "export_scope_stale")
    width_float, height_float = float(width), float(height)
    if not math.isfinite(width_float) or not math.isfinite(height_float) or width_float <= 0 or height_float <= 0:
        _fail("record page geometry is invalid", "export_scope_stale")
    return {"x0": 0.0, "y0": 0.0, "x1": width_float, "y1": height_float}


def _record_rect(record: Mapping[str, Any], *, candidate: bool = False) -> dict[str, float]:
    if record.get("crop_mode") == "full_page":
        return _full_page_rect(record)
    key = "candidate_rect" if candidate else "final_rect"
    if key == "candidate_rect":
        original = _mapping(record.get("original"), "record.original")
        return _rect(original.get(key), f"record.original.{key}")
    return _rect(record.get(key), f"record.{key}")


def _record_page_key(record: Mapping[str, Any]) -> tuple[str, int]:
    original = _mapping(record.get("original"), "record.original")
    source_key = _text(original.get("source_key"), "record.original.source_key")
    page = original.get("source_page")
    if type(page) is not int or page < 1:
        _fail("record source page is invalid", "export_scope_stale")
    return source_key, page


def _segment_id(record: Mapping[str, Any]) -> str:
    original = _mapping(record.get("original"), "record.original")
    return _text(original.get("id"), "record.original.id")


def _snapshot_header(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    header = snapshot.get("header")
    result = dict(header) if isinstance(header, Mapping) else {}
    for key, value in snapshot.items():
        result.setdefault(key, value)
    return result


def _snapshot_items(snapshot: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw_items = snapshot.get("items")
    if not isinstance(raw_items, Sequence) or isinstance(raw_items, (str, bytes, bytearray)):
        _fail("grouping snapshot items are invalid", "grouping_stale")
    if not 1 <= len(raw_items) <= _MAX_ITEMS:
        _fail("grouping snapshot items are invalid", "grouping_stale")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raw_items:
        item = dict(_mapping(raw, "grouping item"))
        binding = item.get("binding")
        binding_map = binding if isinstance(binding, Mapping) else {}
        identifier = item.get("segment_id", item.get("id", binding_map.get("segment_id")))
        identifier = _text(identifier, "grouping item segment_id")
        if identifier in seen:
            _fail("grouping snapshot contains duplicate segments", "grouping_stale")
        seen.add(identifier)
        item["segment_id"] = identifier
        result.append(item)
    return result


def _group_descriptor(item: Mapping[str, Any], *, pending: bool = False) -> dict[str, str]:
    raw_group = item.get("group")
    group = raw_group if isinstance(raw_group, Mapping) else {}
    group_id = group.get("group_id", group.get("id"))
    group_kind = group.get("kind")
    display = group_display_name(group)
    if pending:
        group_id = group_id or "counterparty_pending"
        group_kind = group_kind or "counterparty_pending"
        display = display or "待确认交易对手"
    group_id = _text(group_id, "group.group_id")
    group_kind = _text(group_kind, "group.kind")
    display = _text(display, "group.display_name")
    if group_kind not in _ROUTES:
        _fail("group kind is invalid", "grouping_stale")
    return {"group_id": group_id, "group_kind": group_kind, "group_name": display}


def _route(item: Mapping[str, Any]) -> str:
    raw = item.get("route", item.get("kind"))
    if isinstance(raw, Mapping):
        raw = raw.get("kind", raw.get("route"))
    if not isinstance(raw, str):
        _fail("grouping route is invalid", "grouping_stale")
    route = raw.strip()
    if route in _PENDING_ROUTES:
        return "counterparty_pending"
    if route in {"excluded", "own_pending"} or route in _ROUTES:
        return route
    _fail("grouping route is invalid", "grouping_stale")
    return ""  # pragma: no cover


def _item_status(item: Mapping[str, Any], key: str) -> str:
    value = item.get(key)
    if isinstance(value, Mapping):
        value = value.get("status", value.get("state"))
    return value if isinstance(value, str) else ""


def _validate_item_binding(item: Mapping[str, Any], record: Mapping[str, Any]) -> None:
    """Ensure the grouping row still describes this frozen receipt record."""

    binding = item.get("binding")
    if not isinstance(binding, Mapping):
        _fail("grouping item binding is invalid", "grouping_stale")
    original = _mapping(record.get("original"), "record.original")
    expected = {
        "segment_id": original.get("id"),
        "source_key": original.get("source_key"),
        "source_sha256": record.get("source_sha256"),
        "source_page": original.get("source_page"),
        "position_index": original.get("position_index"),
        "slot_id": original.get("slot_id"),
        "instance_id": original.get("instance_id"),
        "review_record_revision": record.get("record_revision"),
        # Grouping's trusted raw input records an effective full-page
        # rectangle even though receipt review persists ``final_rect=null``
        # for a confirmed full-page crop.
        "final_rect": _record_rect(record),
    }
    for key, expected_value in expected.items():
        if key not in binding or binding.get(key) != expected_value:
            _fail("grouping item binding no longer matches the receipt review", "grouping_stale")
    if "analysis_signature" in original and binding.get("analysis_signature") != original.get("analysis_signature"):
        _fail("grouping item analysis basis is stale", "grouping_stale")


def _normalise_grouping_snapshot(snapshot: object, request: Mapping[str, Any]) -> dict[str, Any]:
    if hasattr(snapshot, "to_dict") and callable(snapshot.to_dict):
        snapshot = snapshot.to_dict()
    raw = _mapping(snapshot, "grouping snapshot")
    header = _snapshot_header(raw)
    expected_revision = _safe_revision(request["expected_grouping_revision"], "expected_grouping_revision")
    revision = _safe_revision(header.get("grouping_revision"), "grouping_revision")
    if revision != expected_revision:
        _fail("grouping revision changed", "grouping_stale")
    expected_review = _fingerprint(request["expected_review_fingerprint"], "expected_review_fingerprint")
    review_value = header.get("review_fingerprint", header.get("expected_review_fingerprint"))
    if review_value != expected_review:
        _fail("review fingerprint changed", "grouping_stale")
    expected_account = _fingerprint(request["own_account_fingerprint"], "own_account_fingerprint")
    account = header.get("own_account", header.get("account"))
    account_map = account if isinstance(account, Mapping) else {}
    account_value = header.get("own_account_fingerprint", account_map.get("fingerprint"))
    if account_value != expected_account:
        _fail("own account snapshot changed", "grouping_stale")
    items = _snapshot_items(raw)
    groups: dict[str, dict[str, str]] = {}
    raw_groups = raw.get("groups", ())
    if isinstance(raw_groups, Sequence) and not isinstance(raw_groups, (str, bytes, bytearray)):
        for raw_group in raw_groups:
            group = _mapping(raw_group, "group")
            descriptor = {
                "group_id": _text(group.get("group_id", group.get("id")), "group.group_id"),
                "group_kind": _text(group.get("kind"), "group.kind"),
                "group_name": _text(group_display_name(group), "group.display_name"),
            }
            if descriptor["group_kind"] not in _ROUTES:
                _fail("group kind is invalid", "grouping_stale")
            if descriptor["group_id"] in groups and groups[descriptor["group_id"]] != descriptor:
                _fail("group definitions conflict", "grouping_stale")
            groups[descriptor["group_id"]] = descriptor
    for item in items:
        route = _route(item)
        if route in {"excluded", "own_pending"}:
            continue
        descriptor = _group_descriptor(item, pending=route == "counterparty_pending")
        existing = groups.get(descriptor["group_id"])
        if existing is not None and existing != descriptor:
            _fail("group definitions conflict", "grouping_stale")
        groups[descriptor["group_id"]] = descriptor
    result = dict(raw)
    result["grouping_revision"] = revision
    result["review_fingerprint"] = expected_review
    result["own_account_fingerprint"] = expected_account
    result["items"] = items
    result["groups"] = list(groups.values())
    return result


def _grouping_fields(item: Mapping[str, Any]) -> Mapping[str, Any]:
    for key in ("extracted", "parties", "receipt_parties", "fields"):
        value = item.get(key)
        if isinstance(value, Mapping):
            return value
    return {}


def _field(fields: Mapping[str, Any], side: str, name: str) -> Mapping[str, Any]:
    side_map = fields.get(side)
    if not isinstance(side_map, Mapping):
        return {}
    value = side_map.get(name)
    return value if isinstance(value, Mapping) else {}


def _counterparty_fields(item: Mapping[str, Any]) -> tuple[str, Mapping[str, Any]]:
    own = item.get("own_decision")
    own_map = own if isinstance(own, Mapping) else {}
    side = own_map.get("side", own_map.get("our_side", item.get("our_side")))
    if side not in {"payer", "payee"}:
        side = item.get("counterparty_side")
    if side not in {"payer", "payee"}:
        return "", {}
    counterparty_side = "payee" if side == "payer" else "payer"
    fields = _grouping_fields(item)
    return counterparty_side, fields


def _json_cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, OverflowError):
        return ""


def _page_sort_key(page: Mapping[str, Any], source_positions: Mapping[str, int]) -> tuple[Any, ...]:
    return (
        source_positions.get(str(page.get("source_key")), 2**31),
        int(page.get("source_page", 0)),
        int(page.get("position_index", 0)),
        str(page.get("group_id", "")),
    )


def _safe_group_stem(value: str) -> str:
    raw = unicodedata.normalize("NFC", value).strip()
    chars: list[str] = []
    for character in raw:
        if _WINDOWS_ILLEGAL.match(character) or unicodedata.category(character) in {"Cc", "Cf"}:
            chars.append("_")
        else:
            chars.append(character)
    stem = "".join(chars).strip(" .") or "未命名分组"
    if stem.casefold() in _RESERVED_NAMES:
        stem += "_"
    budget = MAX_EXPORT_FILENAME_LENGTH - _utf16_units(".pdf")
    return _limit_utf16(stem, budget).rstrip(" .") or "未命名分组"


def _group_filename(label: str, group_id: str, used: set[str], output_name: object = None) -> str:
    stem = _safe_group_stem(label)
    if isinstance(output_name, str) and output_name.strip():
        prefix = _safe_group_stem(output_name)
        stem = _safe_group_stem(f"{prefix}__{stem}")
    candidate = f"{stem}.pdf"
    number = 2
    while candidate.casefold() in used:
        suffix = f"-{number}.pdf"
        budget = MAX_EXPORT_FILENAME_LENGTH - _utf16_units(suffix)
        candidate = f"{_limit_utf16(stem, budget).rstrip(' .')}{suffix}"
        number += 1
    used.add(candidate.casefold())
    return candidate


def _scope_records(scope: Mapping[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    records = scope.get("records")
    excluded = scope.get("excluded_records", ())
    if not isinstance(records, Sequence) or not isinstance(excluded, Sequence):
        _fail("receipt scope records are invalid", "export_scope_stale")
    retained = [dict(_mapping(record, "receipt record")) for record in records]
    excluded_records = [dict(_mapping(record, "excluded receipt record")) for record in excluded]
    return retained, excluded_records


def _validate_routes(
    scope: Mapping[str, Any],
    request: Mapping[str, Any],
    grouping: Mapping[str, Any],
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, str]]]:
    retained, excluded = _scope_records(scope)
    all_records = retained + excluded
    record_by_id = {_segment_id(record): record for record in all_records}
    if len(record_by_id) != len(all_records):
        _fail("receipt scope contains duplicate segments", "export_scope_stale")
    items = grouping["items"]
    item_by_id = {item["segment_id"]: item for item in items}
    if set(item_by_id) != set(record_by_id):
        _fail("grouping snapshot does not cover the current receipt set", "grouping_stale")
    excluded_ids = {_segment_id(record) for record in excluded}
    assignments: dict[str, dict[str, Any]] = {}
    groups: dict[str, dict[str, str]] = {group["group_id"]: group for group in grouping["groups"]}
    include_pending = request["include_counterparty_pending"]
    for identifier, record in record_by_id.items():
        item = item_by_id[identifier]
        _validate_item_binding(item, record)
        route = _route(item)
        if identifier in excluded_ids:
            if route != "excluded":
                _fail("excluded receipt has an output route", "grouping_stale")
            continue
        extraction_state = _item_status(item, "extraction_state")
        if extraction_state not in {"ready", "confirmed"}:
            # Including unresolved counterparties never bypasses extraction.
            _fail("receipt grouping extraction is stale", "grouping_stale")
        own_decision = item.get("own_decision")
        own_status = _item_status(item, "own_decision")
        if isinstance(own_decision, Mapping):
            own_status = str(own_decision.get("status", own_decision.get("state", own_status)))
        if route == "own_pending" or own_status not in {"confirmed", "ready"}:
            _fail("receipt company identity is pending", "grouping_identity_pending")
        if route == "excluded":
            _fail("retained receipt has an excluded route", "grouping_stale")
        pending = route == "counterparty_pending"
        if pending and not include_pending:
            _fail("counterparty pending receipts require explicit export selection", "grouping_incomplete")
        descriptor = _group_descriptor(item, pending=pending)
        current = groups.get(descriptor["group_id"])
        if current is None:
            groups[descriptor["group_id"]] = descriptor
        elif current != descriptor:
            _fail("group definition changed", "grouping_stale")
        assignments[identifier] = {
            "record": record,
            "item": deepcopy(item),
            "route": route,
            **descriptor,
        }
    if not assignments:
        _fail("there are no retained receipts to export", "grouping_incomplete")
    return assignments, groups


def _check_cross_group_geometry(
    assignments: Mapping[str, Mapping[str, Any]],
    excluded: Sequence[Mapping[str, Any]],
) -> None:
    by_page: dict[tuple[str, int], list[tuple[str, Mapping[str, Any], dict[str, float]]]] = defaultdict(list)
    for identifier, assignment in assignments.items():
        record = assignment["record"]
        by_page[_record_page_key(record)].append((identifier, assignment, _record_rect(record)))
    excluded_by_page: dict[tuple[str, int], list[dict[str, float]]] = defaultdict(list)
    for record in excluded:
        excluded_by_page[_record_page_key(record)].append(_record_rect(record, candidate=True))
    for page_key, entries in by_page.items():
        for index, (left_id, left, left_rect) in enumerate(entries):
            for right_id, right, right_rect in entries[index + 1:]:
                if left["group_id"] == right["group_id"]:
                    continue
                if left_rect == _full_page_rect(left["record"]) or right_rect == _full_page_rect(right["record"]):
                    _fail("同页整页回单会夹带其他交易对手内容", "grouping_geometry_conflict")
                if _material_overlap(left_rect, right_rect):
                    _fail("同页裁剪范围跨越不同交易对手", "grouping_geometry_conflict")
            for excluded_rect in excluded_by_page.get(page_key, ()):
                if left_rect == _full_page_rect(left["record"]) or _material_overlap(left_rect, excluded_rect):
                    _fail("导出范围会夹带已排除回单内容", "grouping_geometry_conflict")


def _build_group_pages(assignments: Mapping[str, Mapping[str, Any]], sources: Sequence[Mapping[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, dict[str, str]]]:
    source_positions = {str(source["source_key"]): index for index, source in enumerate(sources)}
    grouped: dict[tuple[Any, ...], dict[str, Any]] = {}
    for identifier, assignment in assignments.items():
        record = assignment["record"]
        original = _mapping(record["original"], "record.original")
        source_key, source_page = _record_page_key(record)
        full_page = record.get("crop_mode") == "full_page"
        rect = None if full_page else deepcopy(record["final_rect"])
        rect_key = ("full_page",) if full_page else ("crop", *(rect[edge] for edge in _RECT_FIELDS))
        key = (assignment["group_id"], source_key, source_page, *rect_key)
        page = grouped.get(key)
        if page is None:
            source = next((source for source in sources if source.get("source_key") == source_key), None)
            if source is None:
                _fail("grouped page references an unknown source", "export_scope_stale")
            page = {
                "group_id": assignment["group_id"], "group_kind": assignment["group_kind"],
                "group_name": assignment["group_name"], "source_key": source_key,
                "source_path": source["source_path"], "source_sha256": source["source_sha256"],
                "source_page": source_page, "instance_id": original["instance_id"],
                "position_index": original["position_index"], "keep_full_page": full_page,
                "rect": rect, "segment_ids": [],
            }
            grouped[key] = page
        page["segment_ids"].append(identifier)
        if original["position_index"] < page["position_index"]:
            page["position_index"] = original["position_index"]
            page["instance_id"] = original["instance_id"]
    pages = list(grouped.values())
    pages.sort(key=lambda page: _page_sort_key(page, source_positions))
    return pages, {group_id: {"group_id": group_id, "group_kind": value["group_kind"], "group_name": value["group_name"]}
                    for group_id, value in ((page["group_id"], page) for page in pages)}


def _build_index_rows(
    assignments: Mapping[str, Mapping[str, Any]],
    page_lookup: Mapping[tuple[str, str, int, str], int],
    source_positions: Mapping[str, int],
    processed_at: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    mappings: list[dict[str, Any]] = []
    ordered_assignments = sorted(
        assignments.items(),
        key=lambda pair: (
            source_positions.get(str(pair[1]["record"]["original"].get("source_key")), 2**31),
            int(pair[1]["record"]["original"].get("source_page", 0)),
            int(pair[1]["record"]["original"].get("position_index", 0)),
            str(pair[0]),
        ),
    )
    for identifier, assignment in ordered_assignments:
        record = assignment["record"]
        item = assignment["item"]
        original = _mapping(record["original"], "record.original")
        source = assignment["source"]
        page_key = (
            assignment["group_id"], str(original["source_key"]), int(original["source_page"]),
            str(original["instance_id"]),
        )
        output_page = page_lookup.get(page_key)
        if output_page is None:
            _fail("grouped output mapping is incomplete", "grouping_stale")
        output_file = assignment["output_file"]
        fields = _grouping_fields(item)
        counterparty_side, _ = _counterparty_fields(item)
        name_field = _field(fields, counterparty_side, "name")
        account_field = _field(fields, counterparty_side, "account")
        bank_field = _field(fields, counterparty_side, "bank")
        own = item.get("own_decision") if isinstance(item.get("own_decision"), Mapping) else {}
        effective_counterparty = item.get("counterparty")
        if not isinstance(effective_counterparty, Mapping):
            effective_counterparty = {}
        effective_name = effective_counterparty.get("name") if isinstance(effective_counterparty.get("name"), Mapping) else {}
        effective_account = effective_counterparty.get("account") if isinstance(effective_counterparty.get("account"), Mapping) else {}
        effective_bank = effective_counterparty.get("bank") if isinstance(effective_counterparty.get("bank"), Mapping) else {}
        row = {
            "source_key": source["source_key"], "source_file": source.get("name", source.get("source_path", "")),
            "source_sha256": source["source_sha256"], "source_page": original["source_page"],
            "instance_id": original["instance_id"], "slot_id": original["slot_id"],
            "position_index": original["position_index"], "output_file": output_file,
            "output_page": output_page, "group_id": assignment["group_id"],
            "group_kind": assignment["group_kind"], "group_name": assignment["group_name"],
            "route": assignment["route"], "extraction_state": item.get("extraction_state", "ready"),
            "own_status": own.get("status", own.get("state", "")), "own_side": own.get("side", own.get("our_side", "")),
            "own_method": own.get("method", ""), "source_bank_status": own.get("source_bank_status", ""),
            "counterparty_side": counterparty_side,
            "counterparty_name_raw": name_field.get("raw", ""), "counterparty_name": effective_name.get("value", name_field.get("value", name_field.get("normalized", ""))),
            "counterparty_account_raw": account_field.get("raw", ""), "counterparty_account": effective_account.get("value", account_field.get("value", account_field.get("normalized", ""))),
            "counterparty_bank_raw": bank_field.get("raw", ""), "counterparty_bank": effective_bank.get("value", bank_field.get("value", bank_field.get("normalized", ""))),
            "field_overrides": _json_cell(item.get("field_overrides", [])),
            "basis": _json_cell(item.get("basis", item.get("basis_fingerprint", ""))),
            "warnings": _json_cell(item.get("warnings", item.get("diagnostics", []))),
            "processed_at": processed_at,
        }
        for side in ("payer", "payee"):
            for field_name in ("name", "account", "bank"):
                field = _field(fields, side, field_name)
                row.update({
                    f"{side}_{field_name}_raw": field.get("raw", ""),
                    f"{side}_{field_name}": field.get("value", field.get("normalized", "")),
                    f"{side}_{field_name}_state": field.get("state", "missing"),
                    f"{side}_{field_name}_evidence": _json_cell(field.get("evidence", [])),
                })
        rows.append(row)
        mappings.append({
            "segment_id": identifier, "group_id": assignment["group_id"], "group_kind": assignment["group_kind"],
            "group_name": assignment["group_name"], "source_key": source["source_key"],
            "source_file": source.get("name", source.get("source_path", "")), "source_page": original["source_page"],
            "position_index": original["position_index"], "output_file": output_file,
            "output_page": output_page, "route": assignment["route"],
        })
    return rows, mappings


def _route_label(value: object) -> str:
    return {
        "named": "按交易对手",
        "internal": "本公司内部往来",
        "blank": "对方名称为空",
        "special": "特殊凭证",
        "counterparty_pending": "待确认交易对手",
    }.get(str(value), str(value) if value is not None else "")


def _group_kind_label(value: object) -> str:
    return {
        "named": "交易对手",
        "internal": "本公司内部往来",
        "blank": "对方为空",
        "special": "特殊凭证",
        "counterparty_pending": "待确认",
    }.get(str(value), str(value) if value is not None else "")


def _build_detail_rows(index_rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in index_rows:
        own_side = {"payer": "付款方", "payee": "收款方"}.get(str(row.get("own_side")), row.get("own_side", ""))
        state = str(row.get("extraction_state", ""))
        if row.get("own_status") not in {None, "", "confirmed", "ready"}:
            state = f"本方待确认；{state}" if state else "本方待确认"
        rows.append({
            "来源文件": row.get("source_file", ""), "来源页": row.get("source_page", ""),
            "栏位序号": row.get("position_index", ""), "付款方名称": row.get("payer_name", ""),
            "付款方账号": row.get("payer_account", ""), "付款方开户行": row.get("payer_bank", ""),
            "收款方名称": row.get("payee_name", ""), "收款方账号": row.get("payee_account", ""),
            "收款方开户行": row.get("payee_bank", ""), "本方方向": own_side,
            "交易对手名称": row.get("counterparty_name", ""), "交易对手账号": row.get("counterparty_account", ""),
            "交易对手开户行": row.get("counterparty_bank", ""), "归组名称": row.get("group_name", ""),
            "归组类型": _group_kind_label(row.get("group_kind")), "处理去向": _route_label(row.get("route")),
            "识别状态": state, "输出文件": row.get("output_file", ""), "输出页": row.get("output_page", ""),
            "识别依据": row.get("basis", ""), "人工修正": row.get("field_overrides", ""),
            "提示": row.get("warnings", ""),
        })
    return rows


def _validate_processed_at(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        _fail("processed_at is invalid")
    return value


def build_grouped_receipt_export_scope(
    base_scope: Mapping[str, Any],
    request: Mapping[str, Any],
    grouping_snapshot: object,
) -> dict[str, Any]:
    """Attach a validated grouping snapshot to an already trusted receipt scope."""

    grouping = _normalise_grouping_snapshot(grouping_snapshot, request)
    retained, excluded = _scope_records(base_scope)
    assignments, groups = _validate_routes(base_scope, request, grouping)
    _check_cross_group_geometry(assignments, excluded)
    result = deepcopy(dict(base_scope))
    # Receipt scopes keep the durable schema-2 journal contract.  The
    # grouped planner has its own schema marker, while output_mode selects
    # this extension everywhere the bundle layer needs to distinguish it.
    result["schema"] = 2
    result["grouped_export"] = True
    result["grouping_snapshot"] = deepcopy(grouping)
    result["expected_grouping_revision"] = request["expected_grouping_revision"]
    result["expected_review_fingerprint"] = request["expected_review_fingerprint"]
    result["own_account_fingerprint"] = request["own_account_fingerprint"]
    result["include_counterparty_pending"] = request["include_counterparty_pending"]
    result["grouping_revision"] = grouping["grouping_revision"]
    result["grouping_groups"] = list(groups.values())
    result["grouping_assignments"] = deepcopy(assignments)
    summary = dict(result.get("summary", {}))
    summary["group_count"] = len(groups)
    summary["grouped_count"] = len(assignments)
    summary["counterparty_pending_count"] = sum(value["route"] == "counterparty_pending" for value in assignments.values())
    result["summary"] = summary
    result["snapshot_digest"] = _digest({key: value for key, value in result.items() if key != "snapshot_digest"})
    return result


def _build_grouped_plan(scope: Mapping[str, Any], processed_at: object) -> dict[str, Any]:
    processed = _validate_processed_at(processed_at)
    assignments_raw = scope.get("grouping_assignments")
    if not isinstance(assignments_raw, Mapping):
        _fail("frozen grouping assignments are unavailable", "grouping_stale")
    assignments = {str(key): dict(_mapping(value, "grouping assignment")) for key, value in assignments_raw.items()}
    sources = scope.get("sources")
    if not isinstance(sources, Sequence) or isinstance(sources, (str, bytes, bytearray)):
        _fail("frozen grouping sources are unavailable", "export_scope_stale")
    source_items = [dict(_mapping(source, "source")) for source in sources]
    pages, groups = _build_group_pages(assignments, source_items)
    pages_by_group: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for page in pages:
        pages_by_group[page["group_id"]].append(page)
    used_names: set[str] = set()
    files_by_group: dict[str, dict[str, Any]] = {}
    for group_id, descriptor in groups.items():
        group_pages = pages_by_group[group_id]
        if not group_pages:
            continue
        name = _group_filename(descriptor["group_name"], group_id, used_names, scope.get("output_name"))
        files_by_group[group_id] = {
            "file_id": f"group:{group_id}", "name": name, "source_key": None,
            "group_id": group_id, "group_kind": descriptor["group_kind"],
            "group_name": descriptor["group_name"], "grouped_pages": len(group_pages),
            "page_count": len(group_pages), "pages": deepcopy(group_pages),
        }
    if not files_by_group:
        _fail("there are no grouped output files", "grouping_incomplete")
    if scope.get("output_mode") == "by_counterparty" and len(files_by_group) > MAX_GROUPED_OUTPUT_FILES:
        _fail("交易对手分组数量超过单次导出上限", "export_capacity_exceeded")
    source_positions = {str(source["source_key"]): index for index, source in enumerate(source_items)}
    ordered_files = sorted(files_by_group.values(), key=lambda file: (
        file["group_kind"] == "counterparty_pending",
        min(_page_sort_key(page, source_positions) for page in file["pages"]),
    ))
    if scope.get("output_mode") == "by_counterparty_merged":
        merged_pages = [page for file in ordered_files for page in file["pages"]]
        output_name = scope.get("output_name")
        name = "全部分组回单.pdf" if output_name is None else _output_filename(_normalise_output_name(output_name))
        ordered_files = [{
            "file_id": "grouped-merged", "name": name, "source_key": None,
            "grouped_pages": len(merged_pages), "page_count": len(merged_pages), "pages": merged_pages,
        }]
    page_lookup: dict[tuple[str, str, int, str], int] = {}
    for file in ordered_files:
        for output_page, page in enumerate(file["pages"], 1):
            for identifier in page["segment_ids"]:
                record = assignments[identifier]["record"]
                original = record["original"]
                page_lookup[(page["group_id"], str(original["source_key"]), int(original["source_page"]), str(original["instance_id"]))] = output_page
                assignments[identifier]["output_file"] = file["name"]
    # ``source`` is attached only while generating rows and never persisted in
    # the grouping assignment snapshot.  It comes from the trusted scope.
    source_by_key = {str(source["source_key"]): source for source in source_items}
    source_positions = {str(source["source_key"]): index for index, source in enumerate(source_items)}
    for assignment in assignments.values():
        assignment["source"] = source_by_key[str(assignment["record"]["original"]["source_key"])]
    index_rows, mappings = _build_index_rows(assignments, page_lookup, source_positions, processed)
    total_pages = sum(int(file["page_count"]) for file in ordered_files)
    return {
        "schema": 3, "grouped": True, "files": ordered_files, "index_rows": index_rows,
        "detail_rows": _build_detail_rows(index_rows),
        "mappings": mappings, "merged_pages": 0, "source_pages": 0,
        "grouped_pages": total_pages, "total_pages": total_pages,
    }


def build_grouped_receipt_output_plan(scope: Mapping[str, Any], processed_at: object) -> dict[str, Any]:
    """Build the deterministic per-group PDF/XLSX plan from frozen scope data."""

    # The journal's durable receipt contract remains schema 2.  Grouped
    # exports are selected by output_mode (and carry ``grouped_export`` in
    # the frozen scope); the planner itself uses schema 3 only for its
    # internal plan shape.
    if scope.get("output_mode") not in GROUPED_OUTPUT_MODES or scope.get("schema") != 2:
        _fail("grouped output scope is invalid", "grouping_stale")
    return _build_grouped_plan(scope, processed_at)


__all__ = [
    "MAX_GROUPED_OUTPUT_FILES", "GROUPED_INDEX_HEADERS", "GROUPED_MAPPING_HEADERS", "GROUPED_DETAIL_HEADERS",
    "build_grouped_receipt_export_scope",
    "build_grouped_receipt_output_plan",
]
