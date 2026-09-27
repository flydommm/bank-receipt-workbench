from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path

import pytest

from engine.batch_models import BatchModelError, validate_page_result
from engine.pdf_parser import ParsedPage, TextBlock
from engine.receipt_layout import LayoutSuggestion, PageLayoutEvidence, ReceiptPageComputation, compute_receipt_page
from engine.receipt_layout_models import ReceiptLayoutError
from engine.receipt_checkpoint import encode_receipt_checkpoint, validate_receipt_checkpoint


FIXTURE = Path(__file__).parent / "fixtures" / "receipt_layout_v1.json"
SHA = "a" * 64
SEARCH = {"processing_mode": "search", "criteria": {
    "include": ["fee"], "includeMode": "all", "exclude": []}}
GEOMETRY = {"pdf_box": {"x0": 10, "y0": 20, "x1": 310, "y1": 470},
            "rotation": 0, "user_unit": 2, "width_pt": 600, "height_pt": 900}


def _fixture() -> dict[str, object]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _page(name: str) -> dict[str, object]:
    fixture = _fixture()
    for case in fixture["valid_cases"]:  # type: ignore[index]
        if case["name"] == name:  # type: ignore[index]
            return deepcopy(case["value"])  # type: ignore[index]
    raise AssertionError(f"missing fixture case {name}")


def _computation(page: dict[str, object], *, basis: str = "equal_division",
                 needs_review: bool = False,
                 diagnostics: tuple[dict[str, object], ...] = ()) -> ReceiptPageComputation:
    return ReceiptPageComputation(
        result=page,
        suggestion=LayoutSuggestion(page["layout_definition"], basis, needs_review),  # type: ignore[arg-type]
        diagnostics=diagnostics,
    )


def _checkpoint(source_page: dict[str, object], *, diagnostics: list[dict[str, object]] | None = None,
                **changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schema": 2,
        "page": source_page["page"],
        "receipt_page": deepcopy(source_page),
        "suggestion": {"basis": "equal_division", "needs_review": False},
        "diagnostics": diagnostics or [],
    }
    value.update(changes)
    return value


def _synthetic_evidence(*blocks: TextBlock, visible_objects: tuple[tuple[str, tuple[float, float, float, float]], ...] = (),
                        visual_complete: bool = False) -> PageLayoutEvidence:
    parsed = ParsedPage(1, 600, 900, "\n".join(block.text for block in blocks), blocks)
    return PageLayoutEvidence(GEOMETRY, parsed, (), {}, visible_objects, visual_complete)


def _three_slot_layout() -> dict[str, object]:
    return _page("split_all_full_page")["layout_definition"]  # type: ignore[return-value]


def test_checkpoint_round_trips_split_all_and_does_not_duplicate_layout() -> None:
    page = _page("split_all_full_page")
    expected = _checkpoint(page)

    result = validate_receipt_checkpoint(expected)

    assert result == expected
    assert set(result) == {"schema", "page", "receipt_page", "suggestion", "diagnostics"}
    assert "layout_definition" not in result
    assert "layout_definition" not in result["suggestion"]  # type: ignore[operator]


def test_checkpoint_round_trips_search_with_empty_candidates() -> None:
    page = _page("search_same_slot_multiple_hits")
    page["candidates"] = []

    result = validate_receipt_checkpoint(_checkpoint(page))

    assert result["receipt_page"]["processing_mode"] == "search"  # type: ignore[index]
    assert result["receipt_page"]["candidates"] == []  # type: ignore[index]


def test_encode_receipt_page_computation_uses_result_layout_once() -> None:
    page = _page("search_same_slot_multiple_hits")
    computation = _computation(page, basis="page_evidence", needs_review=False)

    encoded = encode_receipt_checkpoint(computation)

    assert encoded == _checkpoint(page, **{
        "suggestion": {"basis": "page_evidence", "needs_review": False},
    })
    assert encoded["receipt_page"]["layout_definition"] == page["layout_definition"]  # type: ignore[index]


def test_historical_reference_basis_and_controlled_notice_round_trip():
    page = _page("search_same_slot_multiple_hits")
    for candidate in page["candidates"]:
        candidate["needs_review"] = True
    computation = _computation(page, basis="historical_reference", needs_review=True,
                               diagnostics=({"code": "historical_layout_applied"},))
    encoded = encode_receipt_checkpoint(computation)
    assert validate_receipt_checkpoint(encoded) == encoded
    assert encoded["suggestion"] == {"basis": "historical_reference", "needs_review": True}
    assert encoded["diagnostics"] == [{"code": "historical_layout_applied"}]


@pytest.mark.parametrize("field", ["schema", "page"])
def test_checkpoint_rejects_boolean_identity_values(field: str) -> None:
    page = _page("split_all_full_page")
    value = _checkpoint(page, **{field: True})

    with pytest.raises(ReceiptLayoutError):
        validate_receipt_checkpoint(value)


def test_checkpoint_rejects_page_binding_mismatch() -> None:
    page = _page("split_all_full_page")
    value = _checkpoint(page, page=2)

    with pytest.raises(ReceiptLayoutError) as error:
        validate_receipt_checkpoint(value)

    assert error.value.code == "invalid_instance"


def test_checkpoint_rejects_mismatched_computation_suggestion_layout() -> None:
    page = _page("split_all_full_page")
    altered = deepcopy(page["layout_definition"])  # type: ignore[arg-type]
    altered["revision"] = 2  # type: ignore[index]
    computation = ReceiptPageComputation(
        page,
        LayoutSuggestion(altered, "equal_division", True),
        (),
    )

    with pytest.raises(ReceiptLayoutError) as error:
        encode_receipt_checkpoint(computation)

    assert error.value.code == "invalid_layout"


def test_checkpoint_rejects_unknown_fields_and_unknown_basis() -> None:
    page = _page("split_all_full_page")
    unknown_field = _checkpoint(page, extra="untrusted")
    unknown_basis = _checkpoint(page, suggestion={"basis": "bank_name", "needs_review": True})

    with pytest.raises(ReceiptLayoutError) as shape_error:
        validate_receipt_checkpoint(unknown_field)
    assert shape_error.value.code == "invalid_shape"

    with pytest.raises(ReceiptLayoutError) as basis_error:
        validate_receipt_checkpoint(unknown_basis)
    assert basis_error.value.code == "invalid_selection"


def test_checkpoint_keeps_p2_diagnostic_shape_and_references() -> None:
    page = _page("search_same_slot_multiple_hits")
    instance_id = page["instances"][0]["instance_id"]  # type: ignore[index]
    diagnostic = {
        "code": "ambiguous_block",
        "query_id": "include-0",
        "rect": {"x0": 10, "y0": 10, "x1": 20, "y1": 20},
        "instance_ids": [instance_id],
    }

    result = validate_receipt_checkpoint(_checkpoint(page, diagnostics=[diagnostic]))

    assert result["diagnostics"] == [diagnostic]


def test_suspected_invalid_slot_diagnostic_is_bounded_and_requires_review() -> None:
    page = _page("split_all_full_page")
    slot = page["instances"][0]["slot_id"]  # type: ignore[index]
    candidate = page["candidates"][0]  # type: ignore[index]
    candidate["needs_review"] = True
    diagnostic = {"code": "suspected_invalid_slot", "slot_id": slot}

    assert validate_receipt_checkpoint(_checkpoint(page, diagnostics=[diagnostic]))["diagnostics"] == [diagnostic]

    candidate["needs_review"] = False
    with pytest.raises(ReceiptLayoutError, match="invalid_selection"):
        validate_receipt_checkpoint(_checkpoint(page, diagnostics=[diagnostic]))
    for invalid in ({**diagnostic, "text": "private source content"},
                    {"code": "suspected_invalid_slot", "slot_id": "missing-slot"}):
        with pytest.raises(ReceiptLayoutError):
            validate_receipt_checkpoint(_checkpoint(page, diagnostics=[invalid]))


def test_checkpoint_rejects_business_text_and_invalid_diagnostic_references() -> None:
    page = _page("search_same_slot_multiple_hits")
    instance_id = page["instances"][0]["instance_id"]  # type: ignore[index]
    business_text = {
        "code": "ambiguous_block",
        "query_id": "include-0",
        "rect": {"x0": 10, "y0": 10, "x1": 20, "y1": 20},
        "instance_ids": [instance_id],
        "matched_text": "private business text",
    }
    bad_instance = {
        "code": "ambiguous_block",
        "query_id": "include-0",
        "rect": {"x0": 10, "y0": 10, "x1": 20, "y1": 20},
        "instance_ids": ["missing-instance"],
    }

    for diagnostic, code in ((business_text, "invalid_shape"), (bad_instance, "invalid_selection")):
        with pytest.raises(ReceiptLayoutError) as error:
            validate_receipt_checkpoint(_checkpoint(page, diagnostics=[diagnostic]))
        assert error.value.code == code


def test_checkpoint_rejects_diagnostic_rect_outside_visible_page() -> None:
    page = _page("search_same_slot_multiple_hits")
    diagnostic = {
        "code": "ambiguous_block",
        "rect": {"x0": -1, "y0": 10, "x1": 20, "y1": 20},
        "query_id": "include-0",
        "instance_ids": [],
    }

    with pytest.raises(ReceiptLayoutError) as error:
        validate_receipt_checkpoint(_checkpoint(page, diagnostics=[diagnostic]))

    assert error.value.code == "invalid_geometry"


def test_checkpoint_enforces_json_budget_before_copy() -> None:
    page = _page("split_all_full_page")
    value = _checkpoint(page, diagnostics=[{"code": "layout_requires_manual_slots"}])
    value["diagnostics"] = [{"code": "layout_requires_manual_slots", "padding": "x" * (64 * 1024 * 1024)}]

    with pytest.raises((ReceiptLayoutError, BatchModelError)):
        validate_receipt_checkpoint(value)


def test_schema2_dispatches_through_batch_page_result_validator() -> None:
    page = _page("split_all_full_page")
    value = _checkpoint(page)

    result = validate_page_result(value)

    assert result == value


def test_encode_rejects_non_computation_objects() -> None:
    with pytest.raises(ReceiptLayoutError) as error:
        encode_receipt_checkpoint({})  # type: ignore[arg-type]
    assert error.value.code == "invalid_shape"


def test_encode_real_p2_cross_slot_diagnostic_without_business_text() -> None:
    page = _synthetic_evidence(TextBlock(1, "fee", 40, 280, 120, 320, 0))
    computation = compute_receipt_page(
        page,
        SHA,
        SEARCH,
        suggestion=LayoutSuggestion(_three_slot_layout(), "manual_layout", False),
    )

    encoded = encode_receipt_checkpoint(computation)

    codes = {item["code"] for item in encoded["diagnostics"]}  # type: ignore[index]
    assert {"ambiguous_block", "content_crosses_slot"} <= codes
    assert all("text" not in item and "matched_text" not in item for item in encoded["diagnostics"])  # type: ignore[union-attr]


def test_encode_real_p2_paper_outside_visual_diagnostic() -> None:
    page = _synthetic_evidence(
        visible_objects=(("fill-image", (-20.0, -20.0, -10.0, -10.0)),),
    )
    computation = compute_receipt_page(
        page,
        SHA,
        {"processing_mode": "split_all", "criteria": None},
        suggestion=LayoutSuggestion(_three_slot_layout(), "manual_layout", False),
    )

    encoded = encode_receipt_checkpoint(computation)

    assert any(item["code"] == "visual_outside_slots" for item in encoded["diagnostics"])  # type: ignore[union-attr]


def test_encode_real_p2_split_all_keeps_crossing_text_and_partial_paper_image() -> None:
    # Layout risks are observations from the source display list.  A text
    # block may cross two slots and a bitmap may extend past the paper edge;
    # both must survive the split_all compute -> checkpoint boundary so the
    # caller can review them instead of silently clipping either observation.
    page = _synthetic_evidence(
        TextBlock(1, "fee", 40, 280, 120, 320, 0),
        visible_objects=(("fill-image", (590.0, 100.0, 610.0, 120.0)),),
    )
    computation = compute_receipt_page(
        page,
        SHA,
        {"processing_mode": "split_all", "criteria": None},
        suggestion=LayoutSuggestion(_three_slot_layout(), "manual_layout", False),
    )

    encoded = encode_receipt_checkpoint(computation)

    codes = {item["code"] for item in encoded["diagnostics"]}  # type: ignore[index]
    assert {"content_crosses_slot", "visual_crosses_slot"} <= codes
    assert all(candidate["needs_review"] for candidate in encoded["receipt_page"]["candidates"])  # type: ignore[index]


def test_encode_real_p2_unassigned_hit_diagnostic() -> None:
    layout = deepcopy(_three_slot_layout())
    layout["uniform_height"] = False  # type: ignore[index]
    layout["slots"] = [  # type: ignore[index]
        {"slot_id": "slot-1", "position_index": 1, "top_pt": 0, "height_pt": 280},
        {"slot_id": "slot-2", "position_index": 2, "top_pt": 310, "height_pt": 280},
        {"slot_id": "slot-3", "position_index": 3, "top_pt": 620, "height_pt": 280},
    ]
    page = _synthetic_evidence(
        TextBlock(1, "fee", 40, 50, 120, 70, 0),
        TextBlock(1, "orphan", 40, 290, 120, 300, 1),
    )
    search = {"processing_mode": "search", "criteria": {
        "include": ["fee", "orphan"], "includeMode": "all", "exclude": []}}
    computation = compute_receipt_page(
        page,
        SHA,
        search,
        suggestion=LayoutSuggestion(layout, "manual_layout", False),
    )

    encoded = encode_receipt_checkpoint(computation)

    assert any(item["code"] == "unassigned_block" for item in encoded["diagnostics"])  # type: ignore[union-attr]
