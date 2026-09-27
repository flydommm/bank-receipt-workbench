from __future__ import annotations

import copy

import pytest

from engine.receipt_layout_calibration import (
    ReceiptLayoutCalibrationError,
    affected_slot_ids,
    apply_slot_adjustment,
    suggest_calibrated_layout,
    validate_complete_layout,
)
from engine.receipt_layout_models import parse_page_geometry, slot_rect


GEOMETRY = {
    "pdf_box": {"x0": 0, "y0": 0, "x1": 600, "y1": 900},
    "rotation": 0,
    "user_unit": 1,
    "width_pt": 600,
    "height_pt": 900,
}


def test_suggestion_uses_actual_page_height_and_explicit_gaps() -> None:
    layout = suggest_calibrated_layout(GEOMETRY, 3, top_pt=10, bottom_pt=20, gaps_pt=[5, 7])
    assert layout["uniform_height"] is True
    slots = layout["slots"]
    assert len(slots) == 3
    assert slots[0]["top_pt"] == 10
    assert slots[1]["top_pt"] == pytest.approx(slots[0]["top_pt"] + slots[0]["height_pt"] + 5)
    assert slots[-1]["top_pt"] + slots[-1]["height_pt"] == pytest.approx(880)


def test_adjustment_revalidates_unselected_neighbors_and_tracks_impact() -> None:
    before = suggest_calibrated_layout(GEOMETRY, 3)
    after = apply_slot_adjustment(before, "slot-1", top_pt=0, height_pt=250)
    assert affected_slot_ids(before, after) == ["slot-1"]
    assert slot_rect(after, after["slots"][0])["y1"] == 250
    shared = apply_slot_adjustment(before, "slot-1", height_pt=250, keep_uniform_height=True)
    assert affected_slot_ids(before, shared) == ["slot-1", "slot-2", "slot-3"]


def test_invalid_adjustment_cannot_overlap_or_escape_page() -> None:
    before = suggest_calibrated_layout(GEOMETRY, 3)
    with pytest.raises(ReceiptLayoutCalibrationError):
        apply_slot_adjustment(before, "slot-2", top_pt=100, height_pt=500)
    with pytest.raises(ReceiptLayoutCalibrationError):
        apply_slot_adjustment(before, "slot-3", top_pt=800, height_pt=200)


def test_validation_returns_copy_and_rejects_unknown_slot() -> None:
    before = suggest_calibrated_layout(GEOMETRY, 2)
    checked = validate_complete_layout(before)
    checked["slots"][0]["top_pt"] = 99
    assert before["slots"][0]["top_pt"] == 0
    with pytest.raises(ReceiptLayoutCalibrationError):
        apply_slot_adjustment(before, "missing", height_pt=100)


def test_suggestion_rejects_page_capacity_and_overflow_inputs() -> None:
    with pytest.raises(ReceiptLayoutCalibrationError):
        suggest_calibrated_layout(GEOMETRY, 76)
    with pytest.raises(ReceiptLayoutCalibrationError):
        suggest_calibrated_layout(GEOMETRY, 2, top_pt=10**400)
    with pytest.raises(ReceiptLayoutCalibrationError):
        suggest_calibrated_layout(GEOMETRY, 2, gaps_pt=(1,))  # type: ignore[arg-type]


def test_affected_slots_include_removed_identities_and_use_float_tolerance() -> None:
    before = suggest_calibrated_layout(GEOMETRY, 3)
    after = copy.deepcopy(before)
    after["slots"] = after["slots"][:2]
    after["uniform_height"] = False
    # A slot-count change is a shared layout change and includes the removed
    # position so a previously saved confirmation cannot be left stale.
    assert affected_slot_ids(before, after) == ["slot-1", "slot-2", "slot-3"]

    near_copy = copy.deepcopy(before)
    near_copy["slots"][0]["top_pt"] += 1e-14
    assert affected_slot_ids(before, near_copy) == []
