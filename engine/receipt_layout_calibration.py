"""Pure, transaction-free calibration helpers for complete receipt layouts.

These helpers deliberately validate the whole page rather than only the
currently selected candidate.  They are used by the review boundary and are
safe to call from a preview UI before a durable save exists.
"""

from __future__ import annotations

from copy import deepcopy
import math
from typing import Any, Mapping

from .receipt_layout_models import (
    MIN_CROP_SIZE,
    ReceiptLayoutError,
    parse_layout_definition,
    parse_page_geometry,
    near,
    slot_rect,
)


class ReceiptLayoutCalibrationError(ReceiptLayoutError):
    """A calibration draft cannot be represented as a complete layout."""


def _fail(path: str, message: str) -> None:
    raise ReceiptLayoutCalibrationError("invalid_layout", path) from ValueError(message)


def _number(value: object, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, "must be a finite number")
    try:
        result = float(value)
    except (OverflowError, ValueError):
        _fail(path, "must be a finite number")
    if result != result or result in (float("inf"), float("-inf")):
        _fail(path, "must be a finite number")
    return result


def suggest_calibrated_layout(
    page_geometry: Mapping[str, object],
    slot_count: int,
    *,
    top_pt: float = 0.0,
    bottom_pt: float = 0.0,
    gaps_pt: list[float] | None = None,
    left_pt: float = 0.0,
    right_pt: float = 0.0,
    layout_id: str = "calibration-suggestion",
    workspace_id: str = "default",
    issuer_id: str | None = None,
    family_id: str | None = None,
    evidence_version: str = "calibration-v1",
) -> dict[str, object]:
    """Return a complete equal-height suggestion for the actual page.

    The result is always marked as a suggestion by its evidence version; it
    does not imply that any candidate was reviewed or confirmed.
    """

    geometry = parse_page_geometry(dict(page_geometry))
    if type(slot_count) is not int or not 1 <= slot_count <= 1_000:
        _fail("slot_count", "must be a positive integer")
    page_height = float(geometry["height_pt"])
    maximum_slots = min(1_000, math.floor(page_height / min(MIN_CROP_SIZE, page_height)))
    if slot_count > maximum_slots:
        _fail("slot_count", "exceeds the page height capacity")
    top = _number(top_pt, "top_pt")
    bottom = _number(bottom_pt, "bottom_pt")
    left = _number(left_pt, "left_pt")
    right = _number(right_pt, "right_pt")
    if gaps_pt is not None and not isinstance(gaps_pt, list):
        _fail("gaps_pt", "must be a list")
    gaps = list(gaps_pt if gaps_pt is not None else [0.0] * (slot_count - 1))
    if len(gaps) != slot_count - 1:
        _fail("gaps_pt", "must contain one gap between each pair of slots")
    gaps = [_number(value, f"gaps_pt[{index}]") for index, value in enumerate(gaps)]
    usable = page_height - top - bottom - sum(gaps)
    height = usable / slot_count
    if min(top, bottom, left, right, *gaps) < 0 or height < MIN_CROP_SIZE:
        _fail("slots", "the requested layout does not leave a usable receipt height")
    slots: list[dict[str, object]] = []
    cursor = top
    for index in range(slot_count):
        slots.append({
            "slot_id": f"slot-{index + 1}",
            "position_index": index + 1,
            "top_pt": cursor,
            "height_pt": height,
        })
        cursor += height + (gaps[index] if index < len(gaps) else 0.0)
    return parse_layout_definition({
        "schema_version": 1,
        "layout_id": layout_id,
        "revision": 1,
        "workspace_id": workspace_id,
        "issuer_id": issuer_id,
        "family_id": family_id,
        "evidence_version": evidence_version,
        "page_geometry": geometry,
        "uniform_height": True,
        "left_pt": left,
        "right_pt": right,
        "slots": slots,
    })


def apply_slot_adjustment(
    layout: Mapping[str, object],
    slot_id: str,
    *,
    top_pt: float | None = None,
    height_pt: float | None = None,
    keep_uniform_height: bool = False,
    revision: int | None = None,
) -> dict[str, object]:
    """Apply one draft adjustment and revalidate every slot on the page."""

    try:
        current = parse_layout_definition(deepcopy(dict(layout)))
    except ReceiptLayoutError as exc:
        raise ReceiptLayoutCalibrationError(exc.code, exc.path) from exc
    slots = deepcopy(current["slots"])
    assert isinstance(slots, list)
    target = next((slot for slot in slots if slot["slot_id"] == slot_id), None)
    if target is None:
        _fail("slot_id", "unknown slot")
    if top_pt is not None:
        target["top_pt"] = _number(top_pt, "top_pt")  # type: ignore[index]
    if height_pt is not None:
        target["height_pt"] = _number(height_pt, "height_pt")  # type: ignore[index]
    if keep_uniform_height:
        height = target["height_pt"]
        for slot in slots:
            slot["height_pt"] = height
    next_revision = current["revision"] + 1 if revision is None else revision
    candidate = {
        **current,
        "revision": next_revision,
        "uniform_height": current["uniform_height"] if keep_uniform_height or height_pt is None else False,
        "slots": slots,
    }
    # parse_layout_definition performs complete page, ordering, overlap and
    # uniform-height validation, including slots without search hits.
    try:
        return parse_layout_definition(candidate)
    except ReceiptLayoutError as exc:
        raise ReceiptLayoutCalibrationError(exc.code, exc.path) from exc


def affected_slot_ids(
    before: Mapping[str, object], after: Mapping[str, object]
) -> list[str]:
    """Return all positions whose effective crop rectangle changed."""

    old = parse_layout_definition(deepcopy(dict(before)))
    new = parse_layout_definition(deepcopy(dict(after)))
    old_slots = old["slots"]
    new_slots = new["slots"]
    assert isinstance(old_slots, list) and isinstance(new_slots, list)

    # Keep the contract's stable ordering and include removed identities when
    # a draft changes the slot count or slot mapping.  A shared geometry
    # change invalidates every old and new position, including positions that
    # were previously saved but are absent from the draft.
    all_ids: list[str] = []
    seen: set[str] = set()
    for slot in [*old_slots, *new_slots]:
        slot_id = str(slot["slot_id"])
        if slot_id not in seen:
            seen.add(slot_id)
            all_ids.append(slot_id)

    old_geometry = old["page_geometry"]
    new_geometry = new["page_geometry"]
    assert isinstance(old_geometry, Mapping) and isinstance(new_geometry, Mapping)
    geometry_changed = (
        old_geometry["rotation"] != new_geometry["rotation"]
        or not near(old_geometry["user_unit"], new_geometry["user_unit"])  # type: ignore[arg-type]
        or not near(old_geometry["width_pt"], new_geometry["width_pt"])  # type: ignore[arg-type]
        or not near(old_geometry["height_pt"], new_geometry["height_pt"])  # type: ignore[arg-type]
        or any(
            not near(old_geometry["pdf_box"][edge], new_geometry["pdf_box"][edge])  # type: ignore[index]
            for edge in ("x0", "y0", "x1", "y1")
        )
    )
    if (
        geometry_changed
        or not near(old["left_pt"], new["left_pt"])  # type: ignore[arg-type]
        or not near(old["right_pt"], new["right_pt"])  # type: ignore[arg-type]
        or len(old_slots) != len(new_slots)
        or any(
            old_slot["slot_id"] != new_slot["slot_id"]
            for old_slot, new_slot in zip(old_slots, new_slots, strict=False)
        )
    ):
        return all_ids
    old_by_id = {slot["slot_id"]: slot for slot in old["slots"]}
    changed: list[str] = []
    for slot in new_slots:
        slot_id = str(slot["slot_id"])
        previous = old_by_id.get(slot_id)
        if previous is None:
            changed.append(slot_id)
            continue
        old_rect = slot_rect(old, previous)
        new_rect = slot_rect(new, slot)
        if any(not near(old_rect[edge], new_rect[edge]) for edge in ("x0", "y0", "x1", "y1")):  # type: ignore[arg-type]
            changed.append(slot_id)
    # A removed slot is an affected previously saved position too.
    for slot in old_slots:
        slot_id = str(slot["slot_id"])
        if slot_id not in {str(item["slot_id"]) for item in new_slots}:
            changed.append(slot_id)
    return changed


def validate_complete_layout(layout: Mapping[str, object]) -> dict[str, object]:
    """Reparse a complete layout at an API boundary and return a copy."""

    return parse_layout_definition(deepcopy(dict(layout)))
