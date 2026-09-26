"""Pure output planning for schema-3 receipt review records.

The legacy export planner is intentionally kept separate from this module.
Receipt records identify a real receipt instance by ``source_key`` and
``instance_id``; they do not have legacy match rectangles, confidence values,
or per-page segment numbers.  This planner validates those records and emits a
small plan that the bundle/export layer can render without inventing any of
the missing fields.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from copy import deepcopy
import json
import math
import re
from typing import Any

from .export_plan import (
    MAX_EXPORT_FILENAME_LENGTH,
    _file_name,
    _limit_utf16,
    _normalise_output_name,
    _output_filename,
    _source_display_name,
    _text,
    _utf16_units,
)
from .receipt_layout_models import MAX_LAYOUT_SLOTS, near, parse_page_geometry, parse_processing_options
from .receipt_review_models import ReceiptReviewError, _reviewed_at, validate_receipt_record


_OUTPUT_MODES = {"merged", "by_source", "both"}
_CONFIRMED_STATUSES = {"confirmed", "page_confirmed"}
_RECT_FIELDS = ("x0", "y0", "x1", "y1")
_INCLUDE_QUERY = re.compile(r"include-(?:[0-9]|[12][0-9]|3[01])\Z")
_SHA256 = re.compile(r"[a-f0-9]{64}\Z")
_EXCLUSION_AUDIT_FIELDS = frozenset({
    "id", "source_key", "source_sha256", "source_page", "instance_id", "slot_id",
    "position_index", "record_revision", "decision", "reviewed_at",
})

# The receipt index deliberately contains only stable identities, processing
# metadata, query identifiers/coordinates, and final crop geometry.  It never
# exposes matched business text or legacy-only match/confidence/segment fields.
RECEIPT_INDEX_HEADERS = (
    "source_key",
    "source_file",
    "source_sha256",
    "source_page",
    "instance_id",
    "slot_id",
    "position_index",
    "layout_id",
    "layout_revision",
    "processing_mode",
    "selection_basis",
    "crop_mode",
    "review_status",
    "output_file",
    "processed_at",
    "query_ids",
    "query_evidence",
    "crop_x0",
    "crop_y0",
    "crop_x1",
    "crop_y1",
)

RECEIPT_MAPPING_HEADERS = (
    "instance_id",
    "source_key",
    "source_file",
    "source_page",
    "position_index",
    "output_file",
    "output_page",
)


def _fail(message: str) -> None:
    raise ReceiptReviewError(f"invalid receipt export plan: {message}")


def _materialize(value: object, label: str) -> list[Any]:
    if isinstance(value, (str, bytes, bytearray)) or not isinstance(value, Sequence):
        _fail(f"{label} must be an ordered sequence")
    return list(value)


def _sha(value: object, label: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        _fail(f"{label} must be a lowercase SHA-256 digest")
    return value


def _positive_int(value: object, label: str) -> int:
    if type(value) is not int or value < 1:
        _fail(f"{label} must be a positive integer")
    return value


def _source_path(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        _fail(f"{label} must be non-empty text")
    normalized = value.strip().replace("\\", "/")
    if not (normalized.startswith("/") or re.match(r"^[A-Za-z]:/", normalized)):
        _fail(f"{label} must be an absolute path")
    return value


def _source_key(value: object, label: str) -> str:
    raw = _source_path(value, label)
    normalized = raw.strip().replace("\\", "/").lower()
    if raw != normalized:
        _fail(f"{label} must be normalized")
    return raw


def _normalise_sources(value: object) -> tuple[list[dict[str, str]], dict[str, int]]:
    entries = _materialize(value, "sources")
    if not entries:
        _fail("sources must not be empty")
    result: list[dict[str, str]] = []
    indexes: dict[str, int] = {}
    for index, raw in enumerate(entries):
        if not isinstance(raw, Mapping):
            _fail(f"sources[{index}] must be an object")
        key = _source_key(raw.get("source_key"), f"sources[{index}].source_key")
        if key in indexes:
            _fail(f"sources[{index}] duplicates source_key")
        name = raw.get("name")
        if not isinstance(name, str) or "\x00" in name:
            _fail(f"sources[{index}].name must be text")
        path = _source_path(raw.get("source_path"), f"sources[{index}].source_path")
        digest = _sha(raw.get("source_sha256"), f"sources[{index}].source_sha256")
        indexes[key] = index
        result.append({
            "source_key": key,
            "name": name,
            "source_path": path,
            "source_sha256": digest,
        })
    return result, indexes


def _geometry(original: Mapping[str, object]) -> dict[str, float]:
    try:
        parsed = parse_page_geometry(original["page_geometry"])
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise ReceiptReviewError("invalid receipt export plan: original page geometry is invalid") from exc
    return {
        "width_pt": float(parsed["width_pt"]),
        "height_pt": float(parsed["height_pt"]),
    }


def _rect(value: object, geometry: Mapping[str, float], label: str) -> dict[str, float]:
    if not isinstance(value, Mapping) or set(value) != set(_RECT_FIELDS):
        _fail(f"{label} must contain exactly four coordinates")
    result: dict[str, float] = {}
    for edge in _RECT_FIELDS:
        number = value[edge]
        if isinstance(number, bool) or not isinstance(number, (int, float)):
            _fail(f"{label}.{edge} must be a finite number")
        try:
            converted = float(number)
        except (TypeError, ValueError, OverflowError):
            _fail(f"{label}.{edge} must be a finite number")
        if not math.isfinite(converted):
            _fail(f"{label}.{edge} must be a finite number")
        result[edge] = converted
    x0, y0, x1, y1 = (result[edge] for edge in _RECT_FIELDS)
    if not (x0 >= 0 or near(x0, 0)) or not (y0 >= 0 or near(y0, 0)) or x0 >= x1 or y0 >= y1:
        _fail(f"{label} must be ordered and non-empty")
    if x1 > geometry["width_pt"] and not near(x1, geometry["width_pt"]):
        _fail(f"{label} exceeds the page width")
    if y1 > geometry["height_pt"] and not near(y1, geometry["height_pt"]):
        _fail(f"{label} exceeds the page height")
    return result


def _intersects(left: Mapping[str, float], right: Mapping[str, float]) -> bool:
    return (
        min(left["x1"], right["x1"]) > max(left["x0"], right["x0"])
        and min(left["y1"], right["y1"]) > max(left["y0"], right["y0"])
    )


def _material_overlap(left: Mapping[str, float], right: Mapping[str, float]) -> bool:
    """Ignore only contract-level roundoff at touching crop edges."""
    x0, x1 = max(left["x0"], right["x0"]), min(left["x1"], right["x1"])
    y0, y1 = max(left["y0"], right["y0"]), min(left["y1"], right["y1"])
    return x1 > x0 and y1 > y0 and not near(x0, x1) and not near(y0, y1)


def validate_receipt_exclusion_geometry(records: Sequence[Mapping[str, Any]],
                                        excluded_records: Sequence[Mapping[str, Any]]) -> None:
    """An excluded identity must not reappear through another crop on its page."""
    excluded_by_page: dict[tuple[str, int], list[Mapping[str, Any]]] = {}
    for record in excluded_records:
        original = record["original"]
        excluded_by_page.setdefault((original["source_key"], original["source_page"]), []).append(original)
    for record in records:
        original = record["original"]
        same_page = excluded_by_page.get((original["source_key"], original["source_page"]), [])
        if same_page and record["crop_mode"] == "full_page":
            _fail("full-page export would include an excluded receipt")
        for excluded in same_page:
            if _material_overlap(record["final_rect"], excluded["candidate_rect"]):
                _fail("export crop would include an excluded receipt region")


def validate_receipt_exclusion_audit(value: object) -> list[dict[str, Any]]:
    """Validate the public, geometry-free exclusion audit in retained receipts."""
    entries = _materialize(value, "excluded")
    if len(entries) > 50_000:
        _fail("excluded exceeds the receipt limit")
    result, ids, logical_keys = [], set(), set()
    for raw in entries:
        if not isinstance(raw, Mapping) or set(raw) != _EXCLUSION_AUDIT_FIELDS:
            _fail("excluded audit fields are invalid")
        for field in ("id", "instance_id", "slot_id"):
            _text(raw[field], f"excluded.{field}")
            if len(raw[field].encode("utf-8")) > 1024:
                _fail(f"excluded.{field} is too long")
        _source_key(raw["source_key"], "excluded.source_key")
        _sha(raw["source_sha256"], "excluded.source_sha256")
        for field in ("source_page", "position_index", "record_revision"):
            if _positive_int(raw[field], f"excluded.{field}") >= 2 ** 53:
                _fail(f"excluded.{field} exceeds the safe integer limit")
        if raw["position_index"] > MAX_LAYOUT_SLOTS:
            _fail("excluded.position_index exceeds the layout slot limit")
        _reviewed_at(raw["reviewed_at"])
        logical = (raw["source_key"], raw["instance_id"])
        if raw["decision"] != "excluded" or raw["id"] in ids or logical in logical_keys:
            _fail("excluded decisions or identities are invalid")
        ids.add(raw["id"])
        logical_keys.add(logical)
        result.append(dict(raw))
    return result


def receipt_exclusion_audit(records: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    audit = []
    for raw in records:
        record = validate_receipt_record(raw)
        if record["review_status"] != "excluded":
            _fail("exclusion audit requires persisted excluded records")
        original = record["original"]
        audit.append({**{field: original[field] for field in
                         ("id", "source_key", "source_page", "instance_id", "slot_id", "position_index")},
                      "source_sha256": record["source_sha256"], "record_revision": record["record_revision"],
                      "decision": "excluded", "reviewed_at": record["reviewed_at"]})
    return validate_receipt_exclusion_audit(audit)


def _contains(outer: Mapping[str, float], inner: Mapping[str, float]) -> bool:
    return (
        (outer["x0"] <= inner["x0"] or near(outer["x0"], inner["x0"]))
        and (outer["y0"] <= inner["y0"] or near(outer["y0"], inner["y0"]))
        and (inner["x1"] <= outer["x1"] or near(inner["x1"], outer["x1"]))
        and (inner["y1"] <= outer["y1"] or near(inner["y1"], outer["y1"]))
    )


def _query_index(query_id: object, label: str, include_count: int) -> int:
    if not isinstance(query_id, str) or _INCLUDE_QUERY.fullmatch(query_id) is None:
        _fail(f"{label}.query_id is invalid")
    try:
        index = int(query_id.removeprefix("include-"))
    except ValueError:
        _fail(f"{label}.query_id is invalid")
    if index >= include_count:
        _fail(f"{label}.query_id is not part of the processing criteria")
    return index


def _evidence(
    value: object,
    record_id: str,
    original: Mapping[str, object],
    geometry: Mapping[str, float],
    mode: str,
    include_count: int,
) -> list[dict[str, object]]:
    raw_items = [] if value is None else _materialize(value, f"evidence_by_id[{record_id!r}]")
    if mode == "split_all" and raw_items:
        _fail("split_all records must not contain keyword evidence")
    if mode == "search" and not raw_items:
        _fail("search records require keyword evidence")
    candidate = _rect(original["candidate_rect"], geometry, "original.candidate_rect")
    paper = {"x0": 0.0, "y0": 0.0, "x1": geometry["width_pt"], "y1": geometry["height_pt"]}
    checked: list[dict[str, object]] = []
    for index, raw in enumerate(raw_items):
        label = f"evidence_by_id[{record_id!r}][{index}]"
        if not isinstance(raw, Mapping) or set(raw) != {"query_id", "rect"}:
            _fail(f"{label} must contain only query_id and rect")
        _query_index(raw.get("query_id"), label, include_count)
        rect = _rect(raw.get("rect"), geometry, f"{label}.rect")
        if not _intersects(candidate, rect) or (not _contains(candidate, rect) and not original["needs_review"]):
            _fail(f"{label}.rect is unrelated to the candidate")
        if not _contains(paper, rect):
            _fail(f"{label}.rect is outside the page")
        checked.append({"query_id": raw["query_id"], "rect": rect})
    return checked


def _replace_suffix(candidate: str, suffix: str, used: set[str]) -> str:
    """Reuse the legacy safe filename result while changing only its meaning."""

    legacy_suffix = "__匹配结果.pdf"
    old_key = candidate.casefold()
    used.discard(old_key)
    prefix = candidate[:-len(legacy_suffix)] if candidate.endswith(legacy_suffix) else candidate
    budget = MAX_EXPORT_FILENAME_LENGTH - _utf16_units(suffix)
    prefix = _limit_utf16(prefix, max(1, budget)).rstrip(" .") or "未命名"
    candidate = f"{prefix}{suffix}"
    if candidate.casefold() in used:
        suffix_number = 2
        while True:
            numbered_suffix = suffix[:-4] + f"-{suffix_number}.pdf"
            candidate = f"{prefix}{numbered_suffix}"
            if candidate.casefold() not in used:
                break
            suffix_number += 1
    used.add(candidate.casefold())
    return candidate


def _source_output_name(
    source: Mapping[str, str], number: int, width: int, used: set[str],
    output_name: str | None, mode: str,
) -> str:
    candidate = _file_name(source, number, width, used, output_name)
    if mode == "search":
        return candidate
    return _replace_suffix(candidate, "__回单分割结果.pdf", used)


def _evidence_json(value: list[dict[str, object]]) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def build_receipt_output_plan(
    sources: object,
    records: object,
    evidence_by_id: object,
    processing_options: object,
    output_mode: object,
    processed_at: object,
    output_name: object = None,
    *,
    excluded_records: object = (),
) -> dict[str, object]:
    """Build a deterministic output plan for validated schema-3 records."""

    if not isinstance(output_mode, str) or output_mode not in _OUTPUT_MODES:
        _fail("output_mode must be merged, by_source, or both")
    try:
        options = parse_processing_options(processing_options)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ReceiptReviewError("invalid receipt export plan: processing_options is invalid") from exc
    mode = options["processing_mode"]
    if not isinstance(mode, str):
        _fail("processing_options.processing_mode is invalid")
    processed = _text(processed_at, "processed_at", allow_empty=True)
    canonical_output_name = None if output_name is None else _normalise_output_name(output_name)
    source_items, source_indexes = _normalise_sources(sources)

    if not isinstance(evidence_by_id, Mapping):
        _fail("evidence_by_id must be an object")
    raw_records = _materialize(records, "records")
    record_ids = {
        raw.get("original", {}).get("id")
        for raw in raw_records
        if isinstance(raw, Mapping) and isinstance(raw.get("original"), Mapping)
    }
    if any(not isinstance(identifier, str) for identifier in record_ids):
        _fail("records must contain schema-3 originals")
    unknown_evidence = set(evidence_by_id) - record_ids
    if any(not isinstance(identifier, str) for identifier in unknown_evidence):
        _fail("evidence keys must be text")
    if unknown_evidence:
        _fail("evidence references an unknown receipt instance")

    records_by_id: dict[str, dict[str, Any]] = {}
    logical_keys: set[tuple[str, str]] = set()
    checked_records: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_records):
        try:
            if isinstance(raw, dict) and type(raw.get("record_revision")) is int and raw["record_revision"] == 0:
                # Initial automatic candidates are bound by export_scope to the
                # durable snapshot. Keep storage's positive-revision codec strict.
                record = validate_receipt_record({**raw, "record_revision": 1})
                if (record["original"]["needs_review"] or record["crop_mode"] != "candidate"
                        or record["review_status"] != "confirmed" or record["manual_adjusted"]):
                    _fail("initial record must be an unchanged automatic candidate")
                record["record_revision"] = 0
            else:
                record = validate_receipt_record(raw)
        except ReceiptReviewError as exc:
            raise ReceiptReviewError(f"invalid receipt export plan: records[{index}] is invalid") from exc
        original = record["original"]
        identifier = original["id"]
        if identifier in records_by_id:
            _fail("record IDs must be unique")
        logical_key = (original["source_key"], original["instance_id"])
        if logical_key in logical_keys:
            _fail("source_key and instance_id must be unique")
        source_index = source_indexes.get(original["source_key"])
        if source_index is None:
            _fail(f"record[{index}] references an unknown source_key")
        source = source_items[source_index]
        if record["source_path"] != source["source_path"] or record["source_sha256"] != source["source_sha256"]:
            _fail(f"record[{index}] source binding does not match its source")
        selection_basis = original["selection_basis"]
        if (mode == "search" and selection_basis != "keyword") or (
            mode == "split_all" and selection_basis not in {"occupied_slot", "manual_slot"}
        ):
            _fail(f"record[{index}] selection_basis does not match processing mode")
        status = record["review_status"]
        if status not in _CONFIRMED_STATUSES:
            _fail(f"record[{index}] must be confirmed before export")
        if record["crop_mode"] == "full_page" and status != "page_confirmed":
            _fail(f"record[{index}] full_page requires page_confirmed status")
        geometry = _geometry(original)
        evidence = _evidence(
            evidence_by_id.get(identifier, []), identifier, original, geometry, mode,
            len(options["criteria"]["include"]) if mode == "search" else 0,  # type: ignore[index]
        )
        checked = {
            "record": record,
            "source": source,
            "source_index": source_index,
            "geometry": geometry,
            "evidence": evidence,
        }
        records_by_id[identifier] = checked
        logical_keys.add(logical_key)
        checked_records.append(checked)

    checked_records.sort(key=lambda item: (
        item["source_index"],
        item["record"]["original"]["source_page"],
        item["record"]["original"]["position_index"],
        item["record"]["original"]["instance_id"],
    ))

    checked_exclusions = [validate_receipt_record(raw) for raw in _materialize(excluded_records, "excluded_records")]
    receipt_exclusion_audit(checked_exclusions)
    for record in checked_exclusions:
        original = record["original"]
        source_index = source_indexes.get(original["source_key"])
        if (source_index is None or original["id"] in records_by_id
                or (original["source_key"], original["instance_id"]) in logical_keys):
            _fail("excluded receipt identity conflicts with the selected output")
        source = source_items[source_index]
        if record["source_path"] != source["source_path"] or record["source_sha256"] != source["source_sha256"]:
            _fail("excluded receipt source binding does not match its source")
    validate_receipt_exclusion_geometry([item["record"] for item in checked_records], checked_exclusions)

    selected_sources = [source for source in source_items if any(
        item["source"]["source_key"] == source["source_key"] for item in checked_records
    )]
    selected_source_names: dict[str, str] = {}
    merged_name = (
        "全部匹配结果.pdf" if mode == "search" else "全部回单.pdf"
    ) if canonical_output_name is None else _output_filename(canonical_output_name)
    used_names: set[str] = {merged_name.casefold()}
    source_width = max(3, len(str(len(selected_sources)))) if selected_sources else 3
    for selected_number, source in enumerate(selected_sources, 1):
        selected_source_names[source["source_key"]] = _source_output_name(
            source, selected_number, source_width, used_names, canonical_output_name, mode,
        )

    grouped: dict[tuple[object, ...], dict[str, object]] = {}
    for item in checked_records:
        record = item["record"]
        original = record["original"]
        source = item["source"]
        full_page = record["crop_mode"] == "full_page"
        rect = None if full_page else deepcopy(record["final_rect"])
        rect_key = ("full_page",) if full_page else ("crop", *(rect[edge] for edge in _RECT_FIELDS))
        key = (source["source_key"], original["source_page"], *rect_key)
        page = grouped.get(key)
        if page is None:
            page = {
                "source_key": source["source_key"],
                "source_path": source["source_path"],
                "source_sha256": source["source_sha256"],
                "source_page": original["source_page"],
                "instance_id": original["instance_id"],
                "position_index": original["position_index"],
                "keep_full_page": full_page,
                "rect": rect,
                "segment_ids": [],
                "_source_index": item["source_index"],
                "_sort_position": original["position_index"],
            }
            grouped[key] = page
        page["segment_ids"].append(original["id"])  # type: ignore[union-attr]
        if original["position_index"] < page["_sort_position"]:  # type: ignore[operator]
            page["instance_id"] = original["instance_id"]
            page["position_index"] = original["position_index"]
            page["_sort_position"] = original["position_index"]

    pages_by_source: dict[str, list[dict[str, object]]] = {source["source_key"]: [] for source in selected_sources}
    for page in grouped.values():
        page.pop("_source_index", None)
        page.pop("_sort_position", None)
        pages_by_source[page["source_key"]].append(page)  # type: ignore[index]
    for pages in pages_by_source.values():
        pages.sort(key=lambda page: (page["source_page"], page["position_index"], page["instance_id"]))

    files: list[dict[str, object]] = []
    merged_pages: list[dict[str, object]] = []
    for source in selected_sources:
        merged_pages.extend(deepcopy(pages_by_source[source["source_key"]]))
    if output_mode in {"merged", "both"} and merged_pages:
        files.append({
            "file_id": "merged",
            "name": merged_name,
            "source_key": None,
            "page_count": len(merged_pages),
            "pages": merged_pages,
        })
    if output_mode in {"by_source", "both"}:
        for selected_number, source in enumerate(selected_sources, 1):
            pages = deepcopy(pages_by_source[source["source_key"]])
            files.append({
                "file_id": f"source-{selected_number:0{source_width}d}",
                "name": selected_source_names[source["source_key"]],
                "source_key": source["source_key"],
                "page_count": len(pages),
                "pages": pages,
            })

    source_output_file = {
        source["source_key"]: (
            merged_name if output_mode in {"merged", "both"} else selected_source_names[source["source_key"]]
        )
        for source in selected_sources
    }
    index_rows: list[dict[str, object]] = []
    for item in checked_records:
        record = item["record"]
        original = record["original"]
        source = item["source"]
        evidence = item["evidence"]
        geometry = item["geometry"]
        crop = (
            {"x0": 0.0, "y0": 0.0, "x1": geometry["width_pt"], "y1": geometry["height_pt"]}
            if record["crop_mode"] == "full_page" else record["final_rect"]
        )
        assert isinstance(crop, Mapping)
        query_ids = "、".join(str(hit["query_id"]) for hit in evidence)
        index_rows.append({
            "source_key": source["source_key"],
            "source_file": _source_display_name(source),
            "source_sha256": source["source_sha256"],
            "source_page": original["source_page"],
            "instance_id": original["instance_id"],
            "slot_id": original["slot_id"],
            "position_index": original["position_index"],
            "layout_id": original["layout_id"],
            "layout_revision": original["layout_revision"],
            "processing_mode": mode,
            "selection_basis": original["selection_basis"],
            "crop_mode": record["crop_mode"],
            "review_status": record["review_status"],
            "output_file": source_output_file[source["source_key"]],
            "processed_at": processed,
            "query_ids": query_ids,
            "query_evidence": _evidence_json(evidence),
            "crop_x0": crop["x0"],
            "crop_y0": crop["y0"],
            "crop_x1": crop["x1"],
            "crop_y1": crop["y1"],
        })

    mappings: list[dict[str, object]] = []
    for file_item in files:
        for output_page, page in enumerate(file_item["pages"], 1):  # type: ignore[index]
            for identifier in page["segment_ids"]:  # type: ignore[index]
                item = records_by_id[identifier]
                record = item["record"]
                original = record["original"]
                source = item["source"]
                mappings.append({
                    "instance_id": original["instance_id"],
                    "source_key": source["source_key"],
                    "source_file": _source_display_name(source),
                    "source_page": original["source_page"],
                    "position_index": original["position_index"],
                    "output_file": file_item["name"],
                    "output_page": output_page,
                })

    merged_page_count = next((int(file_item["page_count"]) for file_item in files if file_item["file_id"] == "merged"), 0)
    source_page_count = sum(int(file_item["page_count"]) for file_item in files if file_item["file_id"] != "merged")
    return {
        "schema": 2,
        "files": files,
        "index_rows": index_rows,
        "mappings": mappings,
        "merged_pages": merged_page_count,
        "source_pages": source_page_count,
        "total_pages": merged_page_count + source_page_count,
    }


__all__ = ["RECEIPT_INDEX_HEADERS", "RECEIPT_MAPPING_HEADERS", "build_receipt_output_plan",
           "receipt_exclusion_audit", "validate_receipt_exclusion_audit", "validate_receipt_exclusion_geometry"]
