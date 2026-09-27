"""Strict JSON models for the receipt-layout domain contract.

The layout model is deliberately independent from PDF, OCR, storage, and
runtime capability code.  It only validates and copies JSON-shaped values so
that the Python engine can share the wire contract with the TypeScript client.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import math
import re
import sys
import unicodedata

from .batch_models import (
    MAX_CRITERIA_CLAUSES as MAX_SEARCH_CRITERIA_CLAUSES,
    MAX_KEYWORD_CODEPOINTS as MAX_SEARCH_KEYWORD_CODE_POINTS,
)

RECEIPT_LAYOUT_SCHEMA_VERSION = 1
MIN_CROP_SIZE = 12.0
MAX_LAYOUT_SLOTS = 1_000
MAX_SAFE_INTEGER = 9_007_199_254_740_991
_NEAR_FACTOR = 64 * sys.float_info.epsilon

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
_MISSING = object()

_PAGE_GEOMETRY_FIELDS = ("pdf_box", "rotation", "user_unit", "width_pt", "height_pt")
_RECT_FIELDS = ("x0", "y0", "x1", "y1")
_LAYOUT_FIELDS = (
    "schema_version",
    "layout_id",
    "revision",
    "workspace_id",
    "issuer_id",
    "family_id",
    "evidence_version",
    "page_geometry",
    "uniform_height",
    "left_pt",
    "right_pt",
    "slots",
)
_SLOT_FIELDS = ("slot_id", "position_index", "top_pt", "height_pt")
_PAGE_RESULT_FIELDS = (
    "schema_version",
    "processing_mode",
    "source_sha256",
    "page",
    "layout_definition",
    "instances",
    "excluded_slots",
    "candidates",
)
_INSTANCE_FIELDS = (
    "instance_id",
    "source_sha256",
    "page",
    "layout_id",
    "layout_revision",
    "slot_id",
    "position_index",
    "rect",
    "occupancy",
)
_EXCLUDED_FIELDS = ("slot_id", "reason")
_CANDIDATE_FIELDS = ("instance_id", "selection_basis", "evidence", "needs_review")
_EVIDENCE_FIELDS = ("query_id", "rect")
_PROCESSING_FIELDS = ("processing_mode", "criteria")
_CRITERIA_FIELDS = ("include", "includeMode", "exclude")
_CAPABILITY_FIELDS = ("contract_version", "processing_modes", "layout_schema_versions")


class ReceiptLayoutError(ValueError):
    """A JSON value violates the receipt-layout contract."""

    def __init__(self, code: str, path: str) -> None:
        self.code = code
        self.path = path
        super().__init__(f"{code}: {path}")


def _fail(code: str, path: str) -> None:
    raise ReceiptLayoutError(code, path)


def _object(value: object, fields: Sequence[str], path: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != set(fields):
        _fail("invalid_shape", path)
    return value


def _raw_number_is_finite(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, int):
        # Geometry follows JavaScript's finite Number semantics.  Identity
        # integers (page/revision/position) apply the safe-integer bound in
        # _positive_integer instead of imposing it on coordinates.
        try:
            return math.isfinite(float(value))
        except (OverflowError, ValueError):
            return False
    return math.isfinite(value)


def _computed_is_finite(value: object) -> bool:
    """Check arithmetic results without applying the input integer limit."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, int):
        return True
    return math.isfinite(value)


def _number(value: object, code: str, path: str) -> int | float:
    if not _raw_number_is_finite(value):
        _fail(code, path)
    if isinstance(value, int):
        # JavaScript parses every JSON number as a binary64 Number.  Convert
        # Python's arbitrary-precision JSON integers before doing geometry
        # arithmetic so cancellation and overflow match the other endpoint.
        try:
            return float(value)
        except (OverflowError, ValueError):
            _fail(code, path)
    return value  # type: ignore[return-value]


def _positive_integer(value: object, code: str, path: str) -> int:
    number = _number(value, code, path)
    if isinstance(number, float):
        if not number.is_integer() or abs(number) > MAX_SAFE_INTEGER:
            _fail(code, path)
        number = int(number)
    if not isinstance(number, int) or number < 1 or number > MAX_SAFE_INTEGER:
        _fail(code, path)
    return number


def _version(value: object, path: str) -> int:
    # JavaScript has one numeric type, so 1.0 is the same wire value as 1;
    # booleans are explicitly excluded even though Python subclasses int.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("unsupported_version", path)
    if isinstance(value, float) and not math.isfinite(value):
        _fail("unsupported_version", path)
    if value != RECEIPT_LAYOUT_SCHEMA_VERSION:
        _fail("unsupported_version", path)
    return RECEIPT_LAYOUT_SCHEMA_VERSION


def _identifier(value: object, code: str, path: str) -> str:
    if not isinstance(value, str) or _ID_RE.fullmatch(value) is None:
        _fail(code, path)
    return value


def _sha256(value: object, code: str, path: str) -> str:
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        _fail(code, path)
    return value


def _boolean(value: object, code: str, path: str) -> bool:
    if not isinstance(value, bool):
        _fail(code, path)
    return value


def _array(value: object, maximum: int, code: str, path: str) -> list[object]:
    if not isinstance(value, list) or len(value) > maximum:
        _fail(code, path)
    return value


def _one_of(value: object, values: Sequence[str], code: str, path: str) -> str:
    if not isinstance(value, str) or value not in values:
        _fail(code, path)
    return value


def near(a: int | float, b: int | float) -> bool:
    """Compare finite coordinates with the contract's machine epsilon only."""

    if not _computed_is_finite(a) or not _computed_is_finite(b):
        return False
    try:
        left = float(a)
        right = float(b)
    except (OverflowError, ValueError):
        return False
    if not math.isfinite(left) or not math.isfinite(right):
        return False
    try:
        difference = abs(left - right)
        scale = max(1.0, abs(left), abs(right))
        tolerance = _NEAR_FACTOR * scale
    except (OverflowError, ValueError):
        return False
    return math.isfinite(difference) and math.isfinite(tolerance) and difference <= tolerance


def _beyond(a: int | float, b: int | float) -> bool:
    return bool(a > b and not near(a, b))


def _rect(value: object, code: str, path: str) -> dict[str, int | float]:
    obj = _object(value, _RECT_FIELDS, path)
    result = {
        edge: _number(obj[edge], code, path)
        for edge in _RECT_FIELDS
    }
    if result["x1"] <= result["x0"] or result["y1"] <= result["y0"]:
        _fail(code, path)
    return result


def _same_rect(left: Mapping[str, int | float], right: Mapping[str, int | float]) -> bool:
    return all(near(left[edge], right[edge]) for edge in _RECT_FIELDS)


def _contains(container: Mapping[str, int | float], contained: Mapping[str, int | float]) -> bool:
    return (
        not _beyond(container["x0"], contained["x0"])
        and not _beyond(container["y0"], contained["y0"])
        and not _beyond(contained["x1"], container["x1"])
        and not _beyond(contained["y1"], container["y1"])
    )


def _intersects(left: Mapping[str, int | float], right: Mapping[str, int | float]) -> bool:
    return (
        min(left["x1"], right["x1"]) > max(left["x0"], right["x0"])
        and min(left["y1"], right["y1"]) > max(left["y0"], right["y0"])
    )


def parse_page_geometry(value: object, path: str = "page_geometry") -> dict[str, object]:
    """Validate a complete visible PDF page geometry and return a copy."""

    obj = _object(value, _PAGE_GEOMETRY_FIELDS, path)
    code = "invalid_geometry"
    box = _rect(obj["pdf_box"], code, f"{path}.pdf_box")
    rotation = _number(obj["rotation"], code, f"{path}.rotation")
    if rotation not in (0, 90, 180, 270):
        _fail(code, f"{path}.rotation")
    user_unit = _number(obj["user_unit"], code, f"{path}.user_unit")
    width = _number(obj["width_pt"], code, f"{path}.width_pt")
    height = _number(obj["height_pt"], code, f"{path}.height_pt")
    try:
        physical_width = (box["x1"] - box["x0"]) * user_unit
        physical_height = (box["y1"] - box["y0"]) * user_unit
    except (OverflowError, ValueError):
        _fail(code, path)
    if (
        user_unit <= 0
        or width <= 0
        or height <= 0
        or not _computed_is_finite(physical_width)
        or not _computed_is_finite(physical_height)
        or physical_width <= 0
        or physical_height <= 0
        or not near(width, physical_height if rotation % 180 else physical_width)
        or not near(height, physical_width if rotation % 180 else physical_height)
    ):
        _fail(code, path)
    return {
        "pdf_box": box,
        "rotation": rotation,
        "user_unit": user_unit,
        "width_pt": width,
        "height_pt": height,
    }


def parse_layout_definition(value: object, path: str = "layout_definition") -> dict[str, object]:
    """Validate a regular vertical receipt layout definition."""

    obj = _object(value, _LAYOUT_FIELDS, path)
    _version(obj["schema_version"], f"{path}.schema_version")
    code = "invalid_layout"
    geometry = parse_page_geometry(obj["page_geometry"], f"{path}.page_geometry")
    uniform_height = _boolean(obj["uniform_height"], code, f"{path}.uniform_height")
    left_pt = _number(obj["left_pt"], code, f"{path}.left_pt")
    right_pt = _number(obj["right_pt"], code, f"{path}.right_pt")
    page_width = geometry["width_pt"]
    page_height = geometry["height_pt"]
    assert isinstance(page_width, (int, float))
    assert isinstance(page_height, (int, float))
    try:
        # Keep this order identical to slot_rect: the right edge is computed
        # first, then the left edge is subtracted.  At very large magnitudes
        # reassociating the subtraction can turn a zero-width frame into an
        # apparently valid minimum-width frame.
        right_edge = page_width - right_pt
        remaining_width = right_edge - left_pt
    except (OverflowError, ValueError):
        _fail(code, path)
    minimum_width = min(MIN_CROP_SIZE, page_width)
    minimum_height = min(MIN_CROP_SIZE, page_height)
    if (
        left_pt < 0
        or right_pt < 0
        or not _computed_is_finite(right_edge)
        or right_edge <= left_pt
        or remaining_width <= 0
        or not _computed_is_finite(remaining_width)
        or (page_width < MIN_CROP_SIZE and (left_pt != 0 or right_pt != 0))
        or _beyond(minimum_width, remaining_width)
    ):
        _fail(code, path)
    try:
        physical_slot_limit = math.floor(page_height / minimum_height)
    except (OverflowError, ValueError, ZeroDivisionError):
        _fail(code, f"{path}.slots")
    raw_slots = _array(
        obj["slots"],
        min(MAX_LAYOUT_SLOTS, physical_slot_limit),
        code,
        f"{path}.slots",
    )
    if not raw_slots:
        _fail(code, f"{path}.slots")

    ids: set[str] = set()
    slots: list[dict[str, object]] = []
    for index, raw_slot in enumerate(raw_slots):
        slot_path = f"{path}.slots[{index}]"
        slot = _object(raw_slot, _SLOT_FIELDS, slot_path)
        slot_id = _identifier(slot["slot_id"], code, slot_path)
        position_index = _positive_integer(slot["position_index"], code, slot_path)
        top_pt = _number(slot["top_pt"], code, slot_path)
        height_pt = _number(slot["height_pt"], code, slot_path)
        try:
            bottom_pt = top_pt + height_pt
        except (OverflowError, ValueError):
            _fail(code, slot_path)
        previous = slots[-1] if slots else None
        if (
            slot_id in ids
            or position_index != index + 1
            or top_pt < 0
            or height_pt <= 0
            or _beyond(minimum_height, height_pt)
            or not _computed_is_finite(bottom_pt)
            or bottom_pt <= top_pt
            or _beyond(bottom_pt, page_height)
            or (
                page_height < MIN_CROP_SIZE
                and (top_pt != 0 or height_pt != page_height)
            )
            or (
                previous is not None
                and _beyond(
                    previous["top_pt"] + previous["height_pt"],  # type: ignore[operator]
                    top_pt,
                )
            )
            or (
                uniform_height
                and index > 0
                and not near(slots[0]["height_pt"], height_pt)  # type: ignore[arg-type]
            )
        ):
            _fail(code, slot_path)
        ids.add(slot_id)
        slots.append({
            "slot_id": slot_id,
            "position_index": position_index,
            "top_pt": top_pt,
            "height_pt": height_pt,
        })

    layout_id = _identifier(obj["layout_id"], code, path)
    revision = _positive_integer(obj["revision"], code, path)
    workspace_id = _identifier(obj["workspace_id"], code, path)
    issuer_id = None if obj["issuer_id"] is None else _identifier(obj["issuer_id"], code, path)
    family_id = None if obj["family_id"] is None else _identifier(obj["family_id"], code, path)
    evidence_version = _identifier(obj["evidence_version"], code, path)
    return {
        "schema_version": RECEIPT_LAYOUT_SCHEMA_VERSION,
        "layout_id": layout_id,
        "revision": revision,
        "workspace_id": workspace_id,
        "issuer_id": issuer_id,
        "family_id": family_id,
        "evidence_version": evidence_version,
        "page_geometry": geometry,
        "uniform_height": uniform_height,
        "left_pt": left_pt,
        "right_pt": right_pt,
        "slots": slots,
    }


def slot_rect(layout: Mapping[str, object], slot: Mapping[str, object]) -> dict[str, object]:
    """Return the visible-page rectangle for one parsed layout slot."""

    geometry = layout["page_geometry"]
    assert isinstance(geometry, Mapping)
    return {
        "x0": layout["left_pt"],
        "y0": slot["top_pt"],
        "x1": geometry["width_pt"] - layout["right_pt"],  # type: ignore[operator]
        "y1": slot["top_pt"] + slot["height_pt"],  # type: ignore[operator]
    }


def make_instance_id(
    source_sha256: object,
    page: object,
    layout: Mapping[str, object],
    slot_id: object,
) -> str:
    """Build the stable identity that is independent of match count."""

    source = _sha256(source_sha256, "invalid_instance", "source_sha256")
    page_number = _positive_integer(page, "invalid_instance", "page")
    layout_id = _identifier(layout.get("layout_id"), "invalid_instance", "layout_id")
    revision = _positive_integer(layout.get("revision"), "invalid_instance", "layout_revision")
    slot = _identifier(slot_id, "invalid_instance", "slot_id")
    raw_slots = layout.get("slots")
    if not isinstance(raw_slots, list) or not any(
        isinstance(item, Mapping) and item.get("slot_id") == slot for item in raw_slots
    ):
        _fail("invalid_instance", "slot_id")
    return f"receipt-v1:{source}:{page_number}:{layout_id}:{revision}:{slot}"


def parse_page_result(value: object, path: str = "page_result") -> dict[str, object]:
    """Validate one complete page result, including slot accounting."""

    obj = _object(value, _PAGE_RESULT_FIELDS, path)
    _version(obj["schema_version"], f"{path}.schema_version")
    processing_mode = _one_of(
        obj["processing_mode"], ("search", "split_all"), "invalid_processing", f"{path}.processing_mode"
    )
    source_sha256 = _sha256(obj["source_sha256"], "invalid_instance", path)
    page = _positive_integer(obj["page"], "invalid_instance", path)
    layout = parse_layout_definition(obj["layout_definition"], f"{path}.layout_definition")
    raw_layout_slots = layout["slots"]
    assert isinstance(raw_layout_slots, list)
    slots = {slot["slot_id"]: slot for slot in raw_layout_slots}
    seen_slots: set[str] = set()

    raw_instances = _array(obj["instances"], len(slots), "invalid_instance", path)
    instances: list[dict[str, object]] = []
    for index, raw_instance in enumerate(raw_instances):
        instance_path = f"{path}.instances[{index}]"
        instance = _object(raw_instance, _INSTANCE_FIELDS, instance_path)
        slot_id = _identifier(instance["slot_id"], "invalid_instance", instance_path)
        slot = slots.get(slot_id)
        if slot is None or slot_id in seen_slots:
            _fail("invalid_instance", instance_path)
        seen_slots.add(slot_id)
        instance_page = _positive_integer(instance["page"], "invalid_instance", f"{instance_path}.page")
        instance_revision = _positive_integer(
            instance["layout_revision"],
            "invalid_instance",
            f"{instance_path}.layout_revision",
        )
        instance_position = _positive_integer(
            instance["position_index"],
            "invalid_instance",
            f"{instance_path}.position_index",
        )
        instance_id = make_instance_id(source_sha256, page, layout, slot_id)
        instance_rect = _rect(instance["rect"], "invalid_instance", f"{instance_path}.rect")
        if (
            instance["instance_id"] != instance_id
            or instance["source_sha256"] != source_sha256
            or instance_page != page
            or instance["layout_id"] != layout["layout_id"]
            or instance_revision != layout["revision"]
            or instance_position != slot["position_index"]
            or not _same_rect(instance_rect, slot_rect(layout, slot))  # type: ignore[arg-type]
        ):
            _fail("invalid_instance", instance_path)
        occupancy = _one_of(
            instance["occupancy"], ("occupied", "uncertain"), "invalid_instance", instance_path
        )
        instances.append({
            "instance_id": instance_id,
            "source_sha256": source_sha256,
            "page": instance_page,
            "layout_id": layout["layout_id"],
            "layout_revision": instance_revision,
            "slot_id": slot_id,
            "position_index": instance_position,
            "rect": instance_rect,
            "occupancy": occupancy,
        })

    raw_excluded = _array(obj["excluded_slots"], len(slots), "invalid_instance", path)
    excluded_slots: list[dict[str, object]] = []
    for index, raw_excluded_item in enumerate(raw_excluded):
        excluded_path = f"{path}.excluded_slots[{index}]"
        excluded = _object(raw_excluded_item, _EXCLUDED_FIELDS, excluded_path)
        slot_id = _identifier(excluded["slot_id"], "invalid_instance", excluded_path)
        if slot_id not in slots or slot_id in seen_slots:
            _fail("invalid_instance", excluded_path)
        seen_slots.add(slot_id)
        reason = _one_of(excluded["reason"], ("blank", "invalid"), "invalid_instance", excluded_path)
        excluded_slots.append({"slot_id": slot_id, "reason": reason})
    if len(seen_slots) != len(slots):
        _fail("invalid_instance", f"{path}.instances")

    instance_by_id = {instance["instance_id"]: instance for instance in instances}
    seen_candidates: set[str] = set()
    paper = {
        "x0": 0,
        "y0": 0,
        "x1": layout["page_geometry"]["width_pt"],  # type: ignore[index]
        "y1": layout["page_geometry"]["height_pt"],  # type: ignore[index]
    }
    raw_candidates = _array(obj["candidates"], len(instances), "invalid_selection", path)
    evidence_count = 0
    candidates: list[dict[str, object]] = []
    for index, raw_candidate in enumerate(raw_candidates):
        candidate_path = f"{path}.candidates[{index}]"
        candidate = _object(raw_candidate, _CANDIDATE_FIELDS, candidate_path)
        candidate_instance_id = candidate["instance_id"]
        if not isinstance(candidate_instance_id, str) or candidate_instance_id in seen_candidates:
            _fail("invalid_selection", candidate_path)
        instance = instance_by_id.get(candidate_instance_id)
        if instance is None:
            _fail("invalid_selection", candidate_path)
        seen_candidates.add(candidate_instance_id)
        basis = _one_of(
            candidate["selection_basis"],
            ("keyword", "occupied_slot", "manual_slot"),
            "invalid_selection",
            candidate_path,
        )
        needs_review = _boolean(candidate["needs_review"], "invalid_selection", candidate_path)
        maximum_evidence = 10_000 - evidence_count
        raw_evidence = _array(candidate["evidence"], maximum_evidence, "invalid_selection", candidate_path)
        evidence: list[dict[str, object]] = []
        for evidence_index, raw_evidence_item in enumerate(raw_evidence):
            evidence_path = f"{candidate_path}.evidence[{evidence_index}]"
            evidence_item = _object(raw_evidence_item, _EVIDENCE_FIELDS, evidence_path)
            evidence_rect = _rect(evidence_item["rect"], "invalid_selection", evidence_path)
            if (
                not _contains(paper, evidence_rect)
                or not _intersects(instance["rect"], evidence_rect)  # type: ignore[arg-type]
                or (not _contains(instance["rect"], evidence_rect) and not needs_review)  # type: ignore[arg-type]
            ):
                _fail("invalid_selection", evidence_path)
            evidence.append({
                "query_id": _identifier(evidence_item["query_id"], "invalid_selection", evidence_path),
                "rect": evidence_rect,
            })
        evidence_count += len(evidence)
        occupancy = instance["occupancy"]
        if (
            (processing_mode == "search" and basis != "keyword")
            or (processing_mode == "split_all" and basis == "keyword")
            or (basis == "keyword" and not evidence)
            or (basis != "keyword" and evidence)
            or (occupancy == "uncertain" and basis != "manual_slot" and not needs_review)
        ):
            _fail("invalid_selection", candidate_path)
        candidates.append({
            "instance_id": instance["instance_id"],
            "selection_basis": basis,
            "evidence": evidence,
            "needs_review": needs_review,
        })
    if processing_mode == "split_all" and len(candidates) != len(instances):
        _fail("invalid_selection", f"{path}.candidates")
    return {
        "schema_version": RECEIPT_LAYOUT_SCHEMA_VERSION,
        "processing_mode": processing_mode,
        "source_sha256": source_sha256,
        "page": page,
        "layout_definition": layout,
        "instances": instances,
        "excluded_slots": excluded_slots,
        "candidates": candidates,
    }


def _js_trim(value: str) -> str:
    """Implement ECMAScript trim whitespace, including BOM but excluding NEL."""

    def is_js_whitespace(char: str) -> bool:
        codepoint = ord(char)
        return (
            char in "\t\n\v\f\r"
            or codepoint in (0x00A0, 0xFEFF, 0x2028, 0x2029)
            or unicodedata.category(char) == "Zs"
        )

    start = 0
    end = len(value)
    while start < end and is_js_whitespace(value[start]):
        start += 1
    while end > start and is_js_whitespace(value[end - 1]):
        end -= 1
    return value[start:end]


def _normalize_surrogates(value: str, code: str, path: str) -> str:
    """Convert escaped UTF-16 pairs and reject lone surrogate code points.

    A JSON parser may expose an astral character either as one Python code
    point or as a high/low surrogate pair when the input used ``\\u`` escapes.
    JavaScript treats the pair as one Unicode code point for the contract's
    length limit.  Lone surrogates are rejected before NFC normalization so a
    malformed value cannot leak into a result or an error formatter.
    """

    characters: list[str] = []
    index = 0
    while index < len(value):
        codepoint = ord(value[index])
        if 0xD800 <= codepoint <= 0xDBFF:
            if index + 1 >= len(value):
                _fail(code, path)
            next_codepoint = ord(value[index + 1])
            if not 0xDC00 <= next_codepoint <= 0xDFFF:
                _fail(code, path)
            characters.append(chr(
                0x10000
                + ((codepoint - 0xD800) << 10)
                + (next_codepoint - 0xDC00)
            ))
            index += 2
            continue
        if 0xDC00 <= codepoint <= 0xDFFF:
            _fail(code, path)
        characters.append(value[index])
        index += 1
    return "".join(characters)


def _normalize_processing_keyword(value: object, code: str, path: str) -> str:
    if not isinstance(value, str):
        _fail(code, path)
    try:
        scalar_value = _normalize_surrogates(value, code, path)
        normalized = unicodedata.normalize("NFC", scalar_value)
    except (TypeError, UnicodeError):
        _fail(code, path)
    trimmed = _js_trim(normalized)
    if not trimmed or len(trimmed) > MAX_SEARCH_KEYWORD_CODE_POINTS:
        _fail(code, path)
    return trimmed


def _normalize_processing_keywords(values: list[object], code: str, path: str) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for index, value in enumerate(values):
        keyword = _normalize_processing_keyword(value, code, f"{path}[{index}]")
        if keyword not in seen:
            seen.add(keyword)
            normalized.append(keyword)
    return normalized


def parse_processing_options(value: object) -> dict[str, object]:
    """Validate explicit search/split-all options with JS-compatible rules."""

    obj = _object(value, _PROCESSING_FIELDS, "processing_options")
    code = "invalid_processing"
    processing_mode = _one_of(obj["processing_mode"], ("search", "split_all"), code, "processing_mode")
    if processing_mode == "split_all":
        if obj["criteria"] is not None:
            _fail(code, "criteria")
        return {"processing_mode": processing_mode, "criteria": None}

    criteria_obj = _object(obj["criteria"], _CRITERIA_FIELDS, "criteria")
    include_mode = _one_of(criteria_obj["includeMode"], ("all", "any"), code, "criteria.includeMode")
    include = _array(criteria_obj["include"], MAX_SEARCH_CRITERIA_CLAUSES, code, "criteria.include")
    exclude = _array(criteria_obj["exclude"], MAX_SEARCH_CRITERIA_CLAUSES, code, "criteria.exclude")
    if len(include) + len(exclude) > MAX_SEARCH_CRITERIA_CLAUSES:
        _fail(code, "criteria")

    normalized_include = _normalize_processing_keywords(include, code, "criteria.include")
    normalized_exclude = _normalize_processing_keywords(exclude, code, "criteria.exclude")
    if not normalized_include:
        _fail(code, "criteria.include")
    return {
        "processing_mode": processing_mode,
        "criteria": {
            "include": normalized_include,
            "includeMode": include_mode,
            "exclude": normalized_exclude,
        },
    }


def legacy_processing_mode(value: object = _MISSING) -> str:
    """Map only an omitted legacy mode to search; explicit values stay strict."""

    if value is _MISSING:
        return "search"
    return _one_of(value, ("search", "split_all"), "invalid_processing", "processing_mode")


def parse_capabilities(value: object) -> dict[str, object]:
    """Validate the explicit host/engine capability declaration."""

    obj = _object(value, _CAPABILITY_FIELDS, "capabilities")
    _version(obj["contract_version"], "capabilities.contract_version")
    modes = _array(obj["processing_modes"], 2, "unsupported_capability", "processing_modes")
    parsed_modes = [
        _one_of(mode, ("search", "split_all"), "unsupported_capability", "processing_modes")
        for mode in modes
    ]
    if not parsed_modes or len(set(parsed_modes)) != len(parsed_modes):
        _fail("unsupported_capability", "processing_modes")
    schemas = _array(obj["layout_schema_versions"], 1, "unsupported_capability", "layout_schema_versions")
    if len(schemas) != 1 or isinstance(schemas[0], bool) or schemas[0] != RECEIPT_LAYOUT_SCHEMA_VERSION:
        _fail("unsupported_capability", "layout_schema_versions")
    return {
        "contract_version": RECEIPT_LAYOUT_SCHEMA_VERSION,
        "processing_modes": parsed_modes,
        "layout_schema_versions": [RECEIPT_LAYOUT_SCHEMA_VERSION],
    }


def require_layout_capability(host: object, engine: object, mode: object) -> None:
    """Require both endpoints to advertise the requested processing mode."""

    if not isinstance(mode, str) or mode not in ("search", "split_all"):
        _fail("unsupported_capability", "processing_mode")
    for endpoint in (host, engine):
        if mode not in parse_capabilities(endpoint)["processing_modes"]:  # type: ignore[operator]
            _fail("unsupported_capability", "processing_mode")


def changed_slot_ids(before: object, after: object) -> list[str]:
    """Return affected slot identities, expanding shared changes to all slots."""

    before_layout = parse_layout_definition(before)
    after_layout = parse_layout_definition(after)
    before_slots = before_layout["slots"]
    after_slots = after_layout["slots"]
    assert isinstance(before_slots, list) and isinstance(after_slots, list)
    all_ids: list[str] = []
    seen_ids: set[str] = set()
    for slot in [*before_slots, *after_slots]:
        slot_id = slot["slot_id"]
        if slot_id not in seen_ids:
            seen_ids.add(slot_id)
            all_ids.append(slot_id)

    before_geometry = before_layout["page_geometry"]
    after_geometry = after_layout["page_geometry"]
    assert isinstance(before_geometry, Mapping) and isinstance(after_geometry, Mapping)
    shared_changed = (
        before_layout["layout_id"] != after_layout["layout_id"]
        or before_layout["workspace_id"] != after_layout["workspace_id"]
        or before_layout["issuer_id"] != after_layout["issuer_id"]
        or before_layout["family_id"] != after_layout["family_id"]
        or before_layout["evidence_version"] != after_layout["evidence_version"]
        or before_layout["uniform_height"] != after_layout["uniform_height"]
        or not near(before_layout["left_pt"], after_layout["left_pt"])  # type: ignore[arg-type]
        or not near(before_layout["right_pt"], after_layout["right_pt"])  # type: ignore[arg-type]
        or not _same_rect(before_geometry["pdf_box"], after_geometry["pdf_box"])  # type: ignore[arg-type]
        or before_geometry["rotation"] != after_geometry["rotation"]
        or not near(before_geometry["user_unit"], after_geometry["user_unit"])  # type: ignore[arg-type]
        or not near(before_geometry["width_pt"], after_geometry["width_pt"])  # type: ignore[arg-type]
        or not near(before_geometry["height_pt"], after_geometry["height_pt"])  # type: ignore[arg-type]
        or len(before_slots) != len(after_slots)
        or any(
            left["slot_id"] != right["slot_id"]
            for left, right in zip(before_slots, after_slots, strict=False)
        )
        or (
            bool(after_layout["uniform_height"])
            and not near(before_slots[0]["height_pt"], after_slots[0]["height_pt"])  # type: ignore[arg-type]
        )
    )
    if shared_changed:
        return all_ids
    return [
        before_slot["slot_id"]
        for before_slot, after_slot in zip(before_slots, after_slots, strict=True)
        if not near(before_slot["top_pt"], after_slot["top_pt"])  # type: ignore[arg-type]
        or not near(before_slot["height_pt"], after_slot["height_pt"])  # type: ignore[arg-type]
    ]


def can_include_target(human_adjusted: object, explicit_full_page: object, include_override: object) -> bool:
    """Apply the default inclusion policy for automatic and human exceptions."""

    _boolean(human_adjusted, "invalid_selection", "human_adjusted")
    _boolean(explicit_full_page, "invalid_selection", "explicit_full_page")
    _boolean(include_override, "invalid_selection", "include_override")
    return bool(include_override or (not human_adjusted and not explicit_full_page))


__all__ = [
    "MAX_LAYOUT_SLOTS",
    "MIN_CROP_SIZE",
    "MAX_SAFE_INTEGER",
    "ReceiptLayoutError",
    "can_include_target",
    "changed_slot_ids",
    "legacy_processing_mode",
    "make_instance_id",
    "near",
    "parse_capabilities",
    "parse_layout_definition",
    "parse_page_geometry",
    "parse_page_result",
    "parse_processing_options",
    "require_layout_capability",
    "slot_rect",
]
