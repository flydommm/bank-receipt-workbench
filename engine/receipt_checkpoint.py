"""Bounded schema-2 page checkpoints for receipt-layout computations.

The checkpoint is an internal, JSON-only boundary around the validated P1
``receipt_page`` result.  It deliberately contains no PDF/OCR/storage access
and keeps the layout definition in one place: inside ``receipt_page``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import math
import re
from typing import Any

from .batch_models import BatchModelError, MAX_PAGE_RESULT_BYTES, clone_json
from .receipt_document_types import DOCUMENT_TYPES
from .receipt_layout_models import (
    MAX_SAFE_INTEGER,
    ReceiptLayoutError,
    near,
    parse_layout_definition,
    parse_page_result,
)


CHECKPOINT_SCHEMA_VERSION = 2
MAX_CHECKPOINT_BYTES = MAX_PAGE_RESULT_BYTES
# ``instantiate_receipts`` can emit 10,000 risks plus its overflow sentinel,
# while P2 can add up to the 10,000-match diagnostic budget and the suggestion
# stage can contribute two warnings.  The checkpoint must accommodate the
# combined result rather than applying either stage's local limit.
MAX_CHECKPOINT_DIAGNOSTICS = 20_003

_CHECKPOINT_FIELDS = ("schema", "page", "receipt_page", "suggestion", "diagnostics")
_SUGGESTION_FIELDS = ("basis", "needs_review")
_RECT_FIELDS = ("x0", "y0", "x1", "y1")
_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

# These values are the bases emitted by ``receipt_layout.suggest_layout``.
# Keeping the set explicit prevents a bank name, filename, or free-form text
# from becoming a persisted recommendation basis.
KNOWN_SUGGESTION_BASES = frozenset({
    "native_single",
    "equal_division",
    "page_evidence",
    "source_reference",
    "manual_layout",
    "historical_reference",
})

# P2 selection diagnostics and the safe diagnostics emitted by the receipt
# layout stage.  Each specification gives the exact required fields and the
# optional fields that may safely cross the checkpoint boundary.  ``kind`` is
# limited to the two structural values emitted for content-crossing risks; it
# never carries source text.
_DIAGNOSTIC_SPECS: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    "historical_layout_applied": (frozenset({"code"}), frozenset()),
    "historical_template_ambiguous": (frozenset({"code", "template_ids"}), frozenset()),
    "special_document": (
        frozenset({"code", "document_type"}),
        frozenset(),
    ),
    "unassigned_block": (
        frozenset({"code", "query_id", "rect", "instance_ids"}),
        frozenset(),
    ),
    "ambiguous_block": (
        frozenset({"code", "query_id", "rect", "instance_ids"}),
        frozenset(),
    ),
    "cross_boundary_block": (
        frozenset({"code", "query_id", "rect", "instance_ids"}),
        frozenset(),
    ),
    "low_confidence_exclude": (
        frozenset({"code", "query_id", "rect", "instance_ids"}),
        frozenset(),
    ),
    "uncertain_text": (
        frozenset({"code", "slot_id", "rect"}),
        frozenset(),
    ),
    "content_crosses_slot": (
        frozenset({"code", "slot_id", "rect"}),
        frozenset({"kind"}),
    ),
    "visual_crosses_slot": (
        frozenset({"code", "slot_id", "rect"}),
        frozenset(),
    ),
    "occupancy_uncertain": (
        frozenset({"code", "slot_id"}),
        frozenset(),
    ),
    "suspected_invalid_slot": (
        frozenset({"code", "slot_id"}),
        frozenset(),
    ),
    "content_outside_slots": (
        frozenset({"code", "rect"}),
        frozenset(),
    ),
    "visual_outside_slots": (
        frozenset({"code", "rect"}),
        frozenset(),
    ),
    "diagnostic_budget_exceeded": (
        frozenset({"code"}),
        frozenset(),
    ),
    "layout_requires_manual_slots": (
        frozenset({"code"}),
        frozenset(),
    ),
    "reference_position_mismatch": (
        frozenset({"code"}),
        frozenset(),
    ),
    "reference_layout_conflict": (
        frozenset({"code"}),
        frozenset(),
    ),
}


def _fail(code: str, path: str) -> None:
    raise ReceiptLayoutError(code, path)


def _object(value: object, fields: Sequence[str], path: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != set(fields):
        _fail("invalid_shape", path)
    return value


def _number(value: object, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("invalid_geometry", path)
    try:
        number = float(value)
    except (OverflowError, ValueError):
        _fail("invalid_geometry", path)
    if not math.isfinite(number):
        _fail("invalid_geometry", path)
    return number


def _positive_page(value: object, path: str) -> int:
    # Checkpoint identity fields use the exact JSON integer form.  This is
    # stricter than ordinary P1 geometry numbers and avoids accepting a
    # fractional JSON representation for a page key.
    if type(value) is not int:
        _fail("invalid_instance", path)
    if value < 1 or value > MAX_SAFE_INTEGER:
        _fail("invalid_instance", path)
    return value


def _identifier(value: object, path: str, *, allow_none: bool = False) -> str | None:
    if allow_none and value is None:
        return None
    if not isinstance(value, str) or _IDENTIFIER_RE.fullmatch(value) is None:
        _fail("invalid_selection", path)
    return value


def _boolean(value: object, path: str) -> bool:
    if not isinstance(value, bool):
        _fail("invalid_selection", path)
    return value


def _rect(value: object, *, width: float, height: float, path: str) -> dict[str, float]:
    obj = _object(value, _RECT_FIELDS, path)
    result = {edge: _number(obj[edge], f"{path}.{edge}") for edge in _RECT_FIELDS}
    if result["x1"] <= result["x0"] or result["y1"] <= result["y0"]:
        _fail("invalid_geometry", path)
    return result


def _page_rect(value: object, *, width: float, height: float, path: str) -> dict[str, float]:
    """Validate a diagnostic rect that is expected to be on the visible page."""

    result = _rect(value, width=width, height=height, path=path)
    # ``near`` is the same binary64-only boundary tolerance used by P1.  The
    # original value is retained; this check never silently clamps a rect.
    if (
        (result["x0"] < 0 and not near(result["x0"], 0.0))
        or (result["y0"] < 0 and not near(result["y0"], 0.0))
        or (result["x1"] > width and not near(result["x1"], width))
        or (result["y1"] > height and not near(result["y1"], height))
    ):
        _fail("invalid_geometry", path)
    return result


def _clone(value: object) -> dict[str, object]:
    """Apply the shared JSON byte/node budget before structural copying."""

    try:
        cloned = clone_json(value, max_bytes=MAX_CHECKPOINT_BYTES)
    except BatchModelError as exc:
        # The public receipt-layout boundary uses the same structured error
        # type as the P1 parsers.  Preserve the underlying exception as the
        # cause while avoiding its free-form implementation detail in output.
        raise ReceiptLayoutError("invalid_shape", "checkpoint") from exc
    if not isinstance(cloned, dict):
        _fail("invalid_shape", "checkpoint")
    return cloned


def _validate_diagnostic(
    value: object,
    *,
    index: int,
    slot_ids: set[str],
    instance_ids: set[str],
    width: float,
    height: float,
) -> dict[str, object]:
    path = f"diagnostics[{index}]"
    if not isinstance(value, dict):
        _fail("invalid_shape", path)
    code = value.get("code")
    if not isinstance(code, str) or code not in _DIAGNOSTIC_SPECS:
        _fail("invalid_selection", f"{path}.code")
    required, optional = _DIAGNOSTIC_SPECS[code]
    allowed = required | optional
    if not required <= set(value) <= allowed:
        _fail("invalid_shape", path)
    result: dict[str, object] = {"code": code}
    if "template_ids" in value:
        template_ids = value["template_ids"]
        if (not isinstance(template_ids, list) or not 2 <= len(template_ids) <= 256
                or any(not isinstance(item, str) or not item.strip() or len(item) > 256 or "\0" in item
                       for item in template_ids) or len(set(template_ids)) != len(template_ids)):
            _fail("invalid_selection", f"{path}.template_ids")
        result["template_ids"] = list(template_ids)
    if "document_type" in value:
        document_type = value["document_type"]
        if not isinstance(document_type, str) or document_type not in DOCUMENT_TYPES:
            _fail("invalid_selection", f"{path}.document_type")
        result["document_type"] = document_type
    if "query_id" in value:
        result["query_id"] = _identifier(value["query_id"], f"{path}.query_id", allow_none=True)
    if "rect" in value:
        # Layout risk rectangles are observations from the source page and
        # may legitimately extend beyond the paper (for example a partially
        # clipped image or an OCR block crossing the page edge).  Selection
        # diagnostics, in contrast, are search hits and must stay within the
        # visible page before they can be assigned to an instance.
        rect_validator = (
            _page_rect
            if code in {
                "unassigned_block",
                "ambiguous_block",
                "cross_boundary_block",
                "low_confidence_exclude",
            }
            else _rect
        )
        result["rect"] = rect_validator(value["rect"], width=width, height=height, path=f"{path}.rect")
    if "slot_id" in value:
        slot_id = _identifier(value["slot_id"], f"{path}.slot_id")
        assert isinstance(slot_id, str)
        if slot_id not in slot_ids:
            _fail("invalid_selection", f"{path}.slot_id")
        result["slot_id"] = slot_id
    if "instance_ids" in value:
        raw_ids = value["instance_ids"]
        if not isinstance(raw_ids, list) or len(raw_ids) > len(instance_ids):
            _fail("invalid_selection", f"{path}.instance_ids")
        parsed_ids: list[str] = []
        seen: set[str] = set()
        for id_index, raw_id in enumerate(raw_ids):
            # P1 instance identities intentionally contain ':' separators
            # (receipt-v1:<sha>:<page>:<layout>:<revision>:<slot>), so the
            # generic identifier grammar is not applicable here.  Membership
            # in this page's validated instance set is the authority.
            if not isinstance(raw_id, str):
                _fail("invalid_selection", f"{path}.instance_ids[{id_index}]")
            instance_id = raw_id
            if instance_id in seen or instance_id not in instance_ids:
                _fail("invalid_selection", f"{path}.instance_ids[{id_index}]")
            seen.add(instance_id)
            parsed_ids.append(instance_id)
        result["instance_ids"] = parsed_ids
    if "kind" in value:
        kind = value["kind"]
        if kind not in ("text", "title"):
            _fail("invalid_selection", f"{path}.kind")
        result["kind"] = kind
    # Keep output ordering stable for human-readable diagnostics while the
    # canonical JSON layer remains responsible for hashes.
    for field in ("query_id", "rect", "slot_id", "instance_ids", "kind", "document_type"):
        if field in value and field not in result:
            _fail("invalid_shape", path)
    return result


def _validate_diagnostics(
    value: object,
    *,
    slot_ids: set[str],
    instance_ids: set[str],
    width: float,
    height: float,
    path: str = "diagnostics",
) -> list[dict[str, object]]:
    if not isinstance(value, list) or len(value) > MAX_CHECKPOINT_DIAGNOSTICS:
        _fail("invalid_shape", path)
    result: list[dict[str, object]] = []
    for index, item in enumerate(value):
        # _validate_diagnostic uses the public root path for stable error
        # locations; callers only expose code/path, never source content.
        result.append(_validate_diagnostic(
            item,
            index=index,
            slot_ids=slot_ids,
            instance_ids=instance_ids,
            width=width,
            height=height,
        ))
    return result


def validate_receipt_checkpoint(value: object) -> dict[str, object]:
    """Validate and deeply copy one schema-2 receipt page checkpoint."""

    obj = _clone(value)
    obj = _object(obj, _CHECKPOINT_FIELDS, "checkpoint")
    schema = obj["schema"]
    if isinstance(schema, bool) or type(schema) is not int:
        _fail("unsupported_version", "checkpoint.schema")
    if schema != CHECKPOINT_SCHEMA_VERSION:
        _fail("unsupported_version", "checkpoint.schema")

    page_number = _positive_page(obj["page"], "checkpoint.page")
    receipt_page = parse_page_result(obj["receipt_page"], "receipt_page")
    if page_number != receipt_page["page"]:
        _fail("invalid_instance", "checkpoint.page")

    suggestion = _object(obj["suggestion"], _SUGGESTION_FIELDS, "checkpoint.suggestion")
    basis = suggestion["basis"]
    if not isinstance(basis, str) or basis not in KNOWN_SUGGESTION_BASES:
        _fail("invalid_selection", "checkpoint.suggestion.basis")
    needs_review = _boolean(suggestion["needs_review"], "checkpoint.suggestion.needs_review")

    layout = receipt_page["layout_definition"]
    assert isinstance(layout, dict)
    raw_geometry = layout["page_geometry"]
    assert isinstance(raw_geometry, dict)
    width = _number(raw_geometry["width_pt"], "receipt_page.layout_definition.page_geometry.width_pt")
    height = _number(raw_geometry["height_pt"], "receipt_page.layout_definition.page_geometry.height_pt")
    raw_slots = layout["slots"]
    raw_instances = receipt_page["instances"]
    assert isinstance(raw_slots, list) and isinstance(raw_instances, list)
    slot_ids = {slot["slot_id"] for slot in raw_slots if isinstance(slot, dict)}
    instance_ids = {item["instance_id"] for item in raw_instances if isinstance(item, dict)}
    diagnostics = _validate_diagnostics(
        obj["diagnostics"],
        slot_ids=slot_ids,
        instance_ids=instance_ids,
        width=width,
        height=height,
    )
    _validate_review_consistency(receipt_page, needs_review, diagnostics)
    return {
        "schema": CHECKPOINT_SCHEMA_VERSION,
        "page": page_number,
        "receipt_page": receipt_page,
        "suggestion": {"basis": basis, "needs_review": needs_review},
        "diagnostics": diagnostics,
    }


def _validate_review_consistency(
    receipt_page: Mapping[str, object],
    suggestion_needs_review: bool,
    diagnostics: Sequence[Mapping[str, object]],
) -> None:
    """Ensure structural risks cannot be silently persisted as confirmed."""

    raw_instances = receipt_page["instances"]
    raw_candidates = receipt_page["candidates"]
    assert isinstance(raw_instances, list) and isinstance(raw_candidates, list)
    candidate_by_instance = {
        candidate["instance_id"]: candidate
        for candidate in raw_candidates
        if isinstance(candidate, dict)
    }
    instance_by_slot = {
        instance["slot_id"]: instance["instance_id"]
        for instance in raw_instances
        if isinstance(instance, dict)
    }
    if suggestion_needs_review and any(
        candidate.get("needs_review") is not True
        for candidate in raw_candidates
        if isinstance(candidate, dict)
    ):
        _fail("invalid_selection", "checkpoint.suggestion.needs_review")

    global_risk_codes = {
        "content_outside_slots",
        "visual_outside_slots",
        "diagnostic_budget_exceeded",
    }
    for index, diagnostic in enumerate(diagnostics):
        affected: set[str] = set()
        if diagnostic["code"] in global_risk_codes:
            affected.update(candidate_by_instance)
        slot_id = diagnostic.get("slot_id")
        if isinstance(slot_id, str) and slot_id in instance_by_slot:
            affected.add(instance_by_slot[slot_id])
        raw_instance_ids = diagnostic.get("instance_ids")
        if isinstance(raw_instance_ids, list):
            affected.update(item for item in raw_instance_ids if isinstance(item, str))
        for instance_id in affected:
            candidate = candidate_by_instance.get(instance_id)
            if candidate is not None and candidate.get("needs_review") is not True:
                _fail("invalid_selection", f"diagnostics[{index}]")


def _computation_diagnostics(value: object) -> list[dict[str, object]]:
    if not isinstance(value, (tuple, list)):
        _fail("invalid_shape", "computation.diagnostics")
    result: list[dict[str, object]] = []
    for index, item in enumerate(value):
        if isinstance(item, Mapping):
            result.append(dict(item))
            continue
        # SelectionDiagnostic is an internal dataclass with this explicit,
        # safe conversion.  No arbitrary object is accepted at the JSON
        # boundary; this branch only supports the existing P2 type without a
        # module-level import cycle.
        as_dict = getattr(item, "as_dict", None)
        if callable(as_dict):
            converted = as_dict()
            if isinstance(converted, dict):
                result.append(dict(converted))
                continue
        _fail("invalid_shape", f"computation.diagnostics[{index}]")
    return result


def encode_receipt_checkpoint(computation: object) -> dict[str, object]:
    """Encode a validated ``ReceiptPageComputation`` as schema 2 JSON."""

    # Local import avoids making batch_models -> receipt_checkpoint ->
    # receipt_layout a module import cycle during the P1 model import.
    from .receipt_layout import ReceiptPageComputation

    if not isinstance(computation, ReceiptPageComputation):
        _fail("invalid_shape", "computation")
    receipt_page = parse_page_result(computation.result, "computation.result")
    suggestion = computation.suggestion
    if not hasattr(suggestion, "layout_definition"):
        _fail("invalid_shape", "computation.suggestion")
    suggestion_layout = parse_layout_definition(
        suggestion.layout_definition,
        "computation.suggestion.layout_definition",
    )
    if suggestion_layout != receipt_page["layout_definition"]:
        _fail("invalid_layout", "computation.suggestion.layout_definition")
    basis = suggestion.basis
    if not isinstance(basis, str) or basis not in KNOWN_SUGGESTION_BASES:
        _fail("invalid_selection", "computation.suggestion.basis")
    needs_review = _boolean(suggestion.needs_review, "computation.suggestion.needs_review")
    payload = {
        "schema": CHECKPOINT_SCHEMA_VERSION,
        "page": receipt_page["page"],
        "receipt_page": receipt_page,
        "suggestion": {"basis": basis, "needs_review": needs_review},
        "diagnostics": _computation_diagnostics(computation.diagnostics),
    }
    # validate_receipt_checkpoint performs the final bounded JSON copy and
    # canonical P1 normalization.  It also guarantees no layout duplicate is
    # introduced while encoding.
    return validate_receipt_checkpoint(payload)


__all__ = [
    "CHECKPOINT_SCHEMA_VERSION",
    "KNOWN_SUGGESTION_BASES",
    "MAX_CHECKPOINT_BYTES",
    "MAX_CHECKPOINT_DIAGNOSTICS",
    "encode_receipt_checkpoint",
    "validate_receipt_checkpoint",
]
