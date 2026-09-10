"""Pure planning helpers for reviewed PDF export bundles.

The functions in this module describe output files and their page mappings.  They
do not open source files, read PDF content, or write any output.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import math
import re
import unicodedata
from typing import Any

try:
    from .exporter import DEFAULT_HEADERS
except ImportError:  # Support ``python engine/export_plan.py``.
    from exporter import DEFAULT_HEADERS  # type: ignore[no-redef]


_OUTPUT_MODES = {"merged", "by_source", "both"}
_CROP_MODES = {"candidate", "manual", "full_page"}
_REVIEW_STATUSES = {
    "pending",
    "needs_review",
    "confirmed",
    "page_confirmed",
    "group_confirmed",
    "blocked",
}
_CONFIRMED_STATUSES = {"confirmed", "page_confirmed", "group_confirmed"}
_RESERVED_NAMES = {
    "con",
    "prn",
    "aux",
    "nul",
    *(f"com{number}" for number in range(1, 10)),
    *(f"lpt{number}" for number in range(1, 10)),
}
_WINDOWS_ILLEGAL = re.compile(r'[<>:"/\\|?*]')
MAX_EXPORT_NAME_LENGTH = 120
MAX_EXPORT_FILENAME_LENGTH = 240


def _error(message: str) -> ValueError:
    return ValueError(f"invalid export plan: {message}")


def _materialize(value: object, label: str) -> list[Any]:
    if isinstance(value, (str, bytes, bytearray)) or not isinstance(value, Sequence):
        raise _error(f"{label} must be an ordered sequence")
    return list(value)


def _text(value: object, label: str, *, allow_empty: bool = False, allow_nul: bool = False) -> str:
    if not isinstance(value, str):
        raise _error(f"{label} must be text")
    if "\x00" in value and not allow_nul:
        raise _error(f"{label} contains a NUL character")
    if not allow_empty and not value.strip():
        raise _error(f"{label} must not be empty")
    return value


def _normalise_output_name(value: object) -> str:
    """Validate and canonicalise the user supplied PDF base name."""

    if not isinstance(value, str):
        raise _error("output_name must be text")
    if value.endswith((".", " ")):
        raise _error("output_name must not end with a dot or space")
    name = unicodedata.normalize("NFC", value.strip())
    while name.casefold().endswith(".pdf"):
        name = name[:-4]
    if not name:
        raise _error("output_name must not be empty")
    if _utf16_units(name) > MAX_EXPORT_NAME_LENGTH:
        raise _error("output_name is too long")
    if _WINDOWS_ILLEGAL.search(name) or any(unicodedata.category(character) == "Cc" for character in name):
        raise _error("output_name contains forbidden characters")
    if name in {".", ".."} or name.startswith("/") or name.startswith("\\") or re.match(r"^[A-Za-z]:", name):
        raise _error("output_name must be a filename")
    if name.endswith((".", " ")):
        raise _error("output_name must not end with a dot or space")
    if re.fullmatch(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", name, flags=re.IGNORECASE):
        raise _error("output_name uses a reserved device name")
    return name


def _output_filename(name: str) -> str:
    filename = f"{name}.pdf"
    if _utf16_units(filename) > MAX_EXPORT_FILENAME_LENGTH:
        raise _error("output filename is too long")
    return filename


def _positive_int(value: object, label: str) -> int:
    if type(value) is not int or value < 1:
        raise _error(f"{label} must be a positive integer")
    return value


def _finite_number(value: object, label: str, *, positive: bool = False) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise _error(f"{label} must be a finite number")
    if positive and value <= 0:
        raise _error(f"{label} must be positive")
    return value


def _rect(value: object, label: str, width: float, height: float, *, required: bool) -> dict[str, int | float] | None:
    if value is None:
        if required:
            raise _error(f"{label} is required")
        return None
    if not isinstance(value, Mapping):
        raise _error(f"{label} must be an object")
    result: dict[str, int | float] = {}
    for edge in ("x0", "y0", "x1", "y1"):
        result[edge] = _finite_number(value.get(edge), f"{label}.{edge}")
    x0, y0, x1, y1 = (float(result[edge]) for edge in ("x0", "y0", "x1", "y1"))
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise _error(f"{label} must be ordered and inside the page")
    return result


def _utf16_units(value: str) -> int:
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _limit_utf16(value: str, limit: int) -> str:
    result: list[str] = []
    used = 0
    for character in value:
        units = _utf16_units(character)
        if used + units > limit:
            break
        result.append(character)
        used += units
    return "".join(result)


def _source_basename(value: str) -> str:
    return re.split(r"[\\/]", value)[-1]


def _source_display_name(source: Mapping[str, object]) -> str:
    name = source["name"]
    if isinstance(name, str) and name.strip():
        return name
    path = source["source_path"]
    return path if isinstance(path, str) else ""


def _safe_source_stem(source: Mapping[str, object]) -> str:
    raw = _source_basename(_source_display_name(source)).rstrip(" .")
    if raw.lower().endswith(".pdf"):
        raw = raw[:-4]
    # Replace Windows-forbidden characters and all C0/C1 control characters.
    chars: list[str] = []
    for character in raw:
        if _WINDOWS_ILLEGAL.match(character) or unicodedata.category(character) == "Cc":
            chars.append("_")
        else:
            chars.append(character)
    stem = "".join(chars).rstrip(" .")
    if not stem:
        stem = "未命名"
    if stem.casefold() in _RESERVED_NAMES:
        stem = f"{stem}_"
    stem = _limit_utf16(stem, 120)
    return stem or "未命名"


def _source_name_for_index(source: Mapping[str, object]) -> str:
    # Keep the source's logical display name in the audit index.  The generated
    # output filename separately uses a basename-safe stem.
    return _source_display_name(source) or "未命名"


def _normalise_sources(value: object) -> tuple[list[dict[str, str]], dict[str, int]]:
    entries = _materialize(value, "sources")
    result: list[dict[str, str]] = []
    by_key: dict[str, int] = {}
    for index, item in enumerate(entries):
        if not isinstance(item, Mapping):
            raise _error(f"sources[{index}] must be an object")
        key = _text(item.get("source_key"), f"sources[{index}].source_key")
        if key in by_key:
            raise _error(f"duplicate source_key: {key}")
        name = _text(item.get("name"), f"sources[{index}].name", allow_empty=True, allow_nul=True)
        source_path = _text(item.get("source_path"), f"sources[{index}].source_path")
        source_sha256 = _text(item.get("source_sha256"), f"sources[{index}].source_sha256")
        by_key[key] = index
        result.append({
            "source_key": key,
            "name": name,
            "source_path": source_path,
            "source_sha256": source_sha256,
        })
    return result, by_key


def _normalise_criteria(value: object) -> tuple[list[str], list[str]]:
    if not isinstance(value, Mapping):
        raise _error("criteria must be an object")
    include_value = value.get("include")
    include = _materialize(include_value, "criteria.include")
    include_text: list[str] = []
    for index, keyword in enumerate(include):
        text = _text(keyword, f"criteria.include[{index}]").strip()
        if not text:
            raise _error(f"criteria.include[{index}] must not be empty")
        include_text.append(text)
    exclude_value = value.get("exclude", [])
    exclude = _materialize(exclude_value, "criteria.exclude")
    exclude_text: list[str] = []
    for index, keyword in enumerate(exclude):
        text = _text(keyword, f"criteria.exclude[{index}]").strip()
        if not text:
            raise _error(f"criteria.exclude[{index}] must not be empty")
        exclude_text.append(text)
    return include_text, exclude_text


def _normalise_evidence(value: object, record_ids: set[str]) -> dict[str, list[dict[str, object]]]:
    if not isinstance(value, Mapping):
        raise _error("evidence_by_id must be an object")
    result: dict[str, list[dict[str, object]]] = {}
    for segment_id, evidence_value in value.items():
        if not isinstance(segment_id, str) or not segment_id.strip():
            raise _error("evidence_by_id keys must be non-empty text")
        if segment_id not in record_ids:
            raise _error(f"evidence references an unknown segment id: {segment_id}")
        evidence_items = _materialize(evidence_value, f"evidence_by_id[{segment_id!r}]")
        normalised_items: list[dict[str, object]] = []
        for item_index, item in enumerate(evidence_items):
            if not isinstance(item, Mapping):
                raise _error(f"evidence_by_id[{segment_id!r}][{item_index}] must be an object")
            role = item.get("role")
            if role is not None and role not in {"include", "exclude"}:
                raise _error(f"evidence_by_id[{segment_id!r}][{item_index}].role is invalid")
            query_id = item.get("query_id")
            if query_id is not None:
                _text(query_id, f"evidence_by_id[{segment_id!r}][{item_index}].query_id")
            for field in ("matched_field", "matched_text"):
                field_value = item.get(field)
                if field_value is not None and not isinstance(field_value, str):
                    raise _error(f"evidence_by_id[{segment_id!r}][{item_index}].{field} must be text")
            normalised_items.append(dict(item))
        result[segment_id] = normalised_items
    return result


def _normalise_records(
    value: object,
    sources: list[dict[str, str]],
    source_indexes: dict[str, int],
) -> tuple[list[dict[str, object]], dict[str, dict[str, object]]]:
    entries = _materialize(value, "records")
    result: list[dict[str, object]] = []
    by_id: dict[str, dict[str, object]] = {}
    logical_keys: set[tuple[str, int, int]] = set()
    required = {
        "id",
        "source_key",
        "source_page",
        "segment_no",
        "page_width",
        "page_height",
        "confidence",
        "crop_mode",
        "review_status",
        "final_rect",
    }
    for index, item in enumerate(entries):
        if not isinstance(item, Mapping):
            raise _error(f"records[{index}] must be an object")
        missing = required.difference(item)
        if missing:
            raise _error(f"records[{index}] is missing fields: {', '.join(sorted(missing))}")
        segment_id = _text(item.get("id"), f"records[{index}].id")
        if segment_id in by_id:
            raise _error(f"duplicate segment id: {segment_id}")
        source_key = _text(item.get("source_key"), f"records[{index}].source_key")
        source_index = source_indexes.get(source_key)
        if source_index is None:
            raise _error(f"record references an unknown source_key: {source_key}")
        source = sources[source_index]
        page = _positive_int(item.get("source_page"), f"records[{index}].source_page")
        segment_no = _positive_int(item.get("segment_no"), f"records[{index}].segment_no")
        logical_key = (source_key, page, segment_no)
        if logical_key in logical_keys:
            raise _error(f"duplicate source/page/segment identity: {logical_key!r}")
        logical_keys.add(logical_key)
        source_path = item.get("source_path", source["source_path"])
        source_sha256 = item.get("source_sha256", source["source_sha256"])
        if not isinstance(source_path, str) or not source_path.strip():
            raise _error(f"records[{index}].source_path must be text")
        if not isinstance(source_sha256, str) or not source_sha256.strip():
            raise _error(f"records[{index}].source_sha256 must be text")
        if source_path != source["source_path"] or source_sha256.casefold() != source["source_sha256"].casefold():
            raise _error(f"record identity does not match source: {source_key}")
        width = _finite_number(item.get("page_width"), f"records[{index}].page_width", positive=True)
        height = _finite_number(item.get("page_height"), f"records[{index}].page_height", positive=True)
        crop_mode = _text(item.get("crop_mode"), f"records[{index}].crop_mode")
        if crop_mode not in _CROP_MODES:
            raise _error(f"records[{index}].crop_mode is invalid")
        review_status = _text(item.get("review_status"), f"records[{index}].review_status")
        if review_status not in _REVIEW_STATUSES:
            raise _error(f"records[{index}].review_status is invalid")
        confidence = _finite_number(item.get("confidence"), f"records[{index}].confidence")
        if not 0 <= float(confidence) <= 1:
            raise _error(f"records[{index}].confidence must be between 0 and 1")
        final_rect = _rect(
            item.get("final_rect"),
            f"records[{index}].final_rect",
            float(width),
            float(height),
            required=crop_mode != "full_page",
        )
        record = dict(item)
        record.update({
            "id": segment_id,
            "source_key": source_key,
            "source_path": source_path,
            "source_sha256": source_sha256,
            "source_page": page,
            "segment_no": segment_no,
            "page_width": width,
            "page_height": height,
            "crop_mode": crop_mode,
            "review_status": review_status,
            "confidence": confidence,
            "final_rect": final_rect,
        })
        result.append(record)
        by_id[segment_id] = record
    result.sort(key=lambda item: (source_indexes[item["source_key"]], item["source_page"], item["segment_no"]))  # type: ignore[index]
    return result, by_id


def _copy_page(page: Mapping[str, object]) -> dict[str, object]:
    copied = dict(page)
    copied["rect"] = dict(page["rect"]) if isinstance(page.get("rect"), Mapping) else None
    copied["segment_ids"] = list(page["segment_ids"])  # type: ignore[arg-type]
    return copied


def _pages_by_source(
    records: list[dict[str, object]],
    sources: list[dict[str, str]],
    source_indexes: dict[str, int],
) -> dict[str, list[dict[str, object]]]:
    # Full-page groups and cropped groups use distinct key shapes so a
    # full-page selection never merges with a cropped selection.  For cropped
    # records, the complete final rectangle is the identity: candidate and
    # manual records with the same rectangle share one output page, while
    # overlapping or adjacent rectangles remain separate.
    grouped: dict[tuple[object, ...], dict[str, object]] = {}
    for record in records:
        source_key = record["source_key"]
        page_number = record["source_page"]
        is_full = record["crop_mode"] == "full_page"
        if is_full:
            key = (source_key, page_number, "full_page")
            group = grouped.get(key)
            if group is None:
                group = {
                    "source_key": source_key,
                    "source_page": page_number,
                    "segment_no": record["segment_no"],
                    "keep_full_page": True,
                    "rect": None,
                    "segment_ids": [],
                    "_sort_segment_no": record["segment_no"],
                }
                grouped[key] = group
            group["segment_ids"].append(record["id"])  # type: ignore[union-attr]
            group["_sort_segment_no"] = min(group["_sort_segment_no"], record["segment_no"])  # type: ignore[operator]
            group["segment_no"] = min(group["segment_no"], record["segment_no"])  # type: ignore[operator]
            continue
        rect = record["final_rect"]
        rect_key = tuple(rect[edge] for edge in ("x0", "y0", "x1", "y1"))  # type: ignore[index]
        key = (source_key, page_number, "crop", *rect_key)
        group = grouped.get(key)
        if group is None:
            group = {
                "source_key": source_key,
                "source_page": page_number,
                "segment_no": record["segment_no"],
                "keep_full_page": False,
                "rect": dict(rect),  # type: ignore[arg-type]
                "segment_ids": [record["id"]],
                "_sort_segment_no": record["segment_no"],
            }
            grouped[key] = group
        else:
            group["segment_ids"].append(record["id"])  # type: ignore[union-attr]
            group["_sort_segment_no"] = min(group["_sort_segment_no"], record["segment_no"])  # type: ignore[operator]
            group["segment_no"] = min(group["segment_no"], record["segment_no"])  # type: ignore[operator]

    pages_by_source: dict[str, list[dict[str, object]]] = {source["source_key"]: [] for source in sources}
    for key, page in grouped.items():
        source_key = key[0]
        source = sources[source_indexes[source_key]]
        page.pop("_sort_segment_no", None)
        page.pop("_record_key", None)
        page.update({
            "source_path": source["source_path"],
            "source_sha256": source["source_sha256"],
        })
        pages_by_source[source_key].append(page)
    for source_key, pages in pages_by_source.items():
        pages.sort(key=lambda page: (page["source_page"], page["segment_no"]))
    return pages_by_source


def _matched_values(evidence: list[dict[str, object]], field: str) -> str:
    values: list[str] = []
    seen: set[str] = set()
    for item in evidence:
        if item.get("role") == "exclude":
            continue
        value = item.get(field)
        if not isinstance(value, str):
            continue
        value = value.strip()
        if value and value not in seen:
            seen.add(value)
            values.append(value)
    return "、".join(values)


def _matched_keywords(evidence: list[dict[str, object]], include: list[str]) -> str:
    included = [item for item in evidence if item.get("role") != "exclude"]
    query_ids = {
        item["query_id"]
        for item in included
        if isinstance(item.get("query_id"), str) and item["query_id"].strip()
    }
    matched = [keyword for index, keyword in enumerate(include) if f"include-{index}" in query_ids]
    # M2/M3 legacy evidence used one include clause without query_id/role.
    if not matched and len(include) == 1 and included and all(item.get("query_id") is None for item in included):
        matched = list(include)
    return "、".join(matched)


def _index_row(
    record: Mapping[str, object],
    source: Mapping[str, str],
    evidence: list[dict[str, object]],
    include: list[str],
    output_file: str,
    processed_at: str,
) -> dict[str, object]:
    full_page = record["crop_mode"] == "full_page"
    if full_page:
        crop_rect: Mapping[str, object] = {
            "x0": 0,
            "y0": 0,
            "x1": record["page_width"],
            "y1": record["page_height"],
        }
    else:
        crop_rect = record["final_rect"]  # type: ignore[assignment]
    status = record["review_status"]
    if status in _CONFIRMED_STATUSES:
        status = "confirmed"
    row = {
        "source_file": _source_name_for_index(source),
        "source_sha256": source["source_sha256"],
        "source_page": record["source_page"],
        "segment_no": record["segment_no"],
        "query": "、".join(include),
        "matched_field": _matched_values(evidence, "matched_field"),
        "crop_mode": record["crop_mode"],
        "review_status": status,
        "confidence": record["confidence"],
        "output_file": output_file,
        "processed_at": processed_at,
        "matched_keywords": _matched_keywords(evidence, include),
        "matched_text": _matched_values(evidence, "matched_text"),
        "crop_x0": crop_rect["x0"],
        "crop_y0": crop_rect["y0"],
        "crop_x1": crop_rect["x1"],
        "crop_y1": crop_rect["y1"],
    }
    # Keep the exact legacy column contract even if DEFAULT_HEADERS is changed
    # elsewhere in a future release.
    return {header: row[header] for header in DEFAULT_HEADERS}


def _file_name(
    source: Mapping[str, str],
    number: int,
    width: int,
    used: set[str],
    output_name: str | None = None,
) -> str:
    stem = _safe_source_stem(source)
    number_prefix = f"{number:0{width}d}__"
    suffix = "__匹配结果.pdf"
    name_prefix = "" if output_name is None else f"{output_name}_"
    stem_budget = MAX_EXPORT_FILENAME_LENGTH - _utf16_units(name_prefix + number_prefix + suffix)
    if stem_budget < 1:
        raise _error("source output filename is too long")
    stem = _limit_utf16(stem, stem_budget).rstrip(" .") or "未命名"
    legacy = f"{number_prefix}{stem}{suffix}"
    candidate = f"{name_prefix}{legacy}"
    # The numeric prefix makes collisions impossible for a normal selected
    # source list.  Keep a deterministic non-"_1" fallback for defensive use.
    if candidate.casefold() in used:
        suffix_number = 2
        while True:
            fallback_suffix = f"__匹配结果-{suffix_number}.pdf"
            fallback_budget = MAX_EXPORT_FILENAME_LENGTH - _utf16_units(name_prefix + number_prefix + fallback_suffix)
            fallback_stem = _limit_utf16(stem, max(1, fallback_budget)).rstrip(" .") or "未命名"
            candidate = f"{name_prefix}{number_prefix}{fallback_stem}{fallback_suffix}"
            if candidate.casefold() not in used:
                break
            suffix_number += 1
    used.add(candidate.casefold())
    return candidate


def _mappings_for_file(
    file_item: Mapping[str, object],
    records_by_id: Mapping[str, Mapping[str, object]],
    sources_by_key: Mapping[str, Mapping[str, str]],
) -> list[dict[str, object]]:
    mappings: list[dict[str, object]] = []
    for output_page, page in enumerate(file_item["pages"], 1):  # type: ignore[union-attr]
        for segment_id in page["segment_ids"]:  # type: ignore[index]
            record = records_by_id[segment_id]
            source = sources_by_key[record["source_key"]]
            mappings.append({
                "segment_id": segment_id,
                "source_file": _source_name_for_index(source),
                "source_page": record["source_page"],
                "segment_no": record["segment_no"],
                "output_file": file_item["name"],
                "output_page": output_page,
            })
    return mappings


def build_output_plan(
    sources: object,
    records: object,
    evidence_by_id: object,
    criteria: object,
    output_mode: object,
    processed_at: object,
    output_name: object = None,
) -> dict[str, object]:
    """Build a deterministic, read-only output plan for selected review records."""

    if not isinstance(output_mode, str) or output_mode not in _OUTPUT_MODES:
        raise _error("output_mode must be merged, by_source, or both")
    processed = _text(processed_at, "processed_at", allow_empty=True)
    canonical_output_name = None if output_name is None else _normalise_output_name(output_name)
    source_items, source_indexes = _normalise_sources(sources)
    include, _exclude = _normalise_criteria(criteria)
    record_items, records_by_id = _normalise_records(records, source_items, source_indexes)
    evidence = _normalise_evidence(evidence_by_id, set(records_by_id))
    pages_by_source = _pages_by_source(record_items, source_items, source_indexes)
    selected_sources = [source for source in source_items if pages_by_source[source["source_key"]]]
    sources_by_key = {source["source_key"]: source for source in source_items}

    selected_source_names: dict[str, str] = {}
    merged_name = "全部匹配结果.pdf" if canonical_output_name is None else _output_filename(canonical_output_name)
    used_names: set[str] = {merged_name.casefold()}
    source_width = max(3, len(str(len(selected_sources)))) if selected_sources else 3
    for selected_number, source in enumerate(selected_sources, 1):
        selected_source_names[source["source_key"]] = _file_name(
            source, selected_number, source_width, used_names, canonical_output_name,
        )

    files: list[dict[str, object]] = []
    merged_pages: list[dict[str, object]] = []
    for source in selected_sources:
        merged_pages.extend(_copy_page(page) for page in pages_by_source[source["source_key"]])

    if output_mode in {"merged", "both"} and merged_pages:
        files.append({
            "file_id": "merged",
            "name": merged_name,
            "source_key": None,
            "page_count": len(merged_pages),
            "pages": merged_pages,
        })
    if output_mode in {"by_source", "both"}:
        for source in selected_sources:
            pages = [_copy_page(page) for page in pages_by_source[source["source_key"]]]
            files.append({
                "file_id": f"source-{selected_sources.index(source) + 1:0{source_width}d}",
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
    index_rows = [
        _index_row(
            record,
            sources_by_key[record["source_key"]],
            evidence.get(record["id"], []),
            include,
            source_output_file[record["source_key"]],
            processed,
        )
        for record in record_items
    ]
    mappings: list[dict[str, object]] = []
    for file_item in files:
        mappings.extend(_mappings_for_file(file_item, records_by_id, sources_by_key))
    merged_page_count = next(
        (int(file_item["page_count"]) for file_item in files if file_item["file_id"] == "merged"),
        0,
    )
    source_page_count = sum(
        int(file_item["page_count"])
        for file_item in files
        if file_item["file_id"] != "merged"
    )
    result: dict[str, object] = {
        "files": files,
        "index_rows": index_rows,
        "mappings": mappings,
        "merged_pages": merged_page_count,
        "source_pages": source_page_count,
        "total_pages": merged_page_count + source_page_count,
    }
    if canonical_output_name is not None:
        result["output_name"] = canonical_output_name
    return result
