"""Synthetic slot inference and mode invariance, without business PDFs."""

from dataclasses import replace

import pymupdf
import pytest

from engine.layout import Rect, ReceiptCandidate
from engine.pdf_geometry import read_page_geometry
from engine.pdf_parser import ParsedPage, TextBlock, parse_loaded_page, visible_page
from engine.receipt_layout import (
    PageLayoutEvidence, LayoutSuggestion, collect_visible_objects, compatible_reference,
    compute_receipt_page, instantiate_receipts, split_cross_slot_text, suggest_equal_slots, suggest_layout,
)
from engine.receipt_layout_models import ReceiptLayoutError
from engine.search import SearchBudget


SHA = "a" * 64
GEOMETRY = {"pdf_box": {"x0": 0, "y0": 0, "x1": 600, "y1": 900},
            "rotation": 0, "user_unit": 1, "width_pt": 600, "height_pt": 900}


def evidence(texts=("alpha", "beta", "alpha beta"), *, geometry=None, bank="b", form="c"):
    blocks = tuple(TextBlock(1, text, 30, index * 300 + 30, 570, index * 300 + 55, index)
                   for index, text in enumerate(texts))
    parsed = ParsedPage(1, 600, 900, "\n".join(texts), blocks)
    candidates = tuple(ReceiptCandidate(Rect(0, index * 300, 600, index * 300 + 270), .99,
                                         "unused", ("title",)) for index in range(len(texts)))
    descriptor = {"status": "ready", "receipts": [
        {"issuer_bank_key": bank * 64, "template_fingerprint": form * 64,
         "anchor_y": index * 300 + 30} for index, _ in enumerate(texts)]}
    return PageLayoutEvidence(geometry or GEOMETRY, parsed, candidates, descriptor,
                              visual_complete=True)


def options(include, mode="all", exclude=()):
    return {"processing_mode": "search", "criteria": {"include": list(include), "includeMode": mode, "exclude": list(exclude)}}


def test_same_slots_and_instance_ids_across_keywords_and_split_all():
    page = evidence()
    results = [compute_receipt_page(page, SHA, setting).result for setting in (
        options(["alpha"]), options(["beta"]), options(["alpha", "beta"]),
        {"processing_mode": "split_all", "criteria": None})]
    assert all(result["layout_definition"] == results[0]["layout_definition"] for result in results)
    assert all(result["instances"] == results[0]["instances"] for result in results)
    assert [len(result["candidates"]) for result in results] == [2, 2, 1, 3]
    assert results[2]["candidates"][0]["instance_id"] == results[0]["instances"][2]["instance_id"]
    assert all(candidate["evidence"] == [] for candidate in results[3]["candidates"])


@pytest.mark.parametrize("other_evidence", ["text", "image"])
def test_retained_invalid_marker_is_only_a_review_suggestion(other_evidence):
    page = evidence(("alpha", "此空白联无效！", "gamma"))
    if other_evidence == "text":
        block = TextBlock(1, "other visible content", 30, 370, 570, 395, 3)
        page = replace(page, parsed=replace(page.parsed,
            blocks=(*page.parsed.blocks, block), text=page.parsed.text + "\nother visible content"))
    else:
        page = replace(page, visible_objects=(("fill-image", (30, 370, 570, 395)),))
    suggestion = suggest_equal_slots(GEOMETRY, 3)

    result = compute_receipt_page(page, SHA, {"processing_mode": "split_all", "criteria": None},
                                  suggestion=suggestion)

    assert {"code": "suspected_invalid_slot", "slot_id": "slot-2"} in result.diagnostics
    assert "slot-2" not in {item["slot_id"] for item in result.result["excluded_slots"]}
    second = result.result["candidates"][1]
    assert second["needs_review"] is True


def test_marker_without_other_evidence_is_excluded_and_quoted_marker_is_not_flagged():
    options = {"processing_mode": "split_all", "criteria": None}
    suggestion = suggest_equal_slots(GEOMETRY, 3)
    vacant = compute_receipt_page(evidence(("alpha", "此空白联无效！", "gamma")), SHA, options,
                                  suggestion=suggestion)
    assert {"slot_id": "slot-2", "reason": "invalid"} in vacant.result["excluded_slots"]
    assert not any(item["code"] == "suspected_invalid_slot" for item in vacant.diagnostics)

    quoted = evidence(("alpha", "备注：此空白联无效仅为引文", "gamma"))
    result = compute_receipt_page(quoted, SHA, options, suggestion=suggestion)
    assert not any(item["code"] == "suspected_invalid_slot" for item in result.diagnostics)


def test_special_document_does_not_inherit_invalid_slot_suggestion(monkeypatch):
    page = evidence(("alpha", "此空白联无效！", "gamma"))
    block = TextBlock(1, "other visible content", 30, 370, 570, 395, 3)
    page = replace(page, parsed=replace(page.parsed,
        blocks=(*page.parsed.blocks, block), text=page.parsed.text + "\nother visible content"))
    monkeypatch.setattr("engine.receipt_layout.detect_document_type", lambda _parsed: "loan_interest_notice")

    result = compute_receipt_page(page, SHA, {"processing_mode": "split_all", "criteria": None},
                                  suggestion=suggest_equal_slots(GEOMETRY, 3))

    assert {"code": "special_document", "document_type": "loan_interest_notice"} in result.diagnostics
    assert not any(item["code"] == "suspected_invalid_slot" for item in result.diagnostics)


def test_native_single_stays_whole_page_but_verified_tail_keeps_three_slots():
    tail = evidence(("alpha",))
    single = compute_receipt_page(tail, SHA, options(["alpha"]), source_policy="single")
    assert single.result["instances"][0]["rect"] == {"x0": 0, "y0": 0, "x1": 600, "y1": 900}
    result = compute_receipt_page(tail, SHA, options(["alpha"]), source_policy="multiple", reference=evidence())
    assert len(result.result["layout_definition"]["slots"]) == 3
    assert len(result.result["instances"]) == 1
    assert result.result["instances"][0]["rect"]["y1"] == 270
    assert result.result["excluded_slots"] == [{"slot_id": "slot-2", "reason": "blank"}, {"slot_id": "slot-3", "reason": "blank"}]
    assert result.result["instances"][0]["layout_id"] == compute_receipt_page(evidence(), SHA, options(["alpha"])).result["instances"][0]["layout_id"]


@pytest.mark.parametrize("changes", [{"bank": "d"}, {"form": "d"}, {"geometry": {**GEOMETRY, "rotation": 180}},
    {"geometry": {**GEOMETRY, "pdf_box": {"x0": 0, "y0": 0, "x1": 602, "y1": 900}, "width_pt": 602}}])
def test_other_bank_form_size_or_rotation_cannot_supply_tail_reference(changes):
    assert not compatible_reference(evidence(("alpha",)), evidence(**changes))
    with pytest.raises(ReceiptLayoutError, match="incompatible_layout"):
        suggest_layout(evidence(("alpha",)), reference=evidence(**changes))


def test_common_height_suggestion_never_truncates_longer_receipt_to_fit():
    base = evidence()
    base = replace(base, candidates=(
        ReceiptCandidate(Rect(0, 0, 600, 295), .99, "unused", ()),
        ReceiptCandidate(Rect(0, 300, 600, 575), .99, "unused", ()),
        ReceiptCandidate(Rect(0, 620, 600, 900), .99, "unused", ()),
    ))
    result = suggest_layout(base)
    assert result.layout_definition["uniform_height"] is False
    assert [slot["height_pt"] for slot in result.layout_definition["slots"]] == [295, 275, 280]


def test_small_separator_overlap_keeps_tail_on_its_candidate_slot():
    """A one-point shared separator must not collapse a tail to full-page."""
    page = replace(evidence(("alpha", "beta"), geometry={**GEOMETRY, "height_pt": 580,
                                                             "pdf_box": {"x0": 0, "y0": 0, "x1": 600, "y1": 580}}), candidates=(
        ReceiptCandidate(Rect(0, 10, 600, 301), .99, "unused", ("frame",)),
        ReceiptCandidate(Rect(0, 300, 600, 570), .99, "unused", ("frame",)),
    ))

    result = suggest_layout(page, source_policy="multiple")

    assert result.basis == "page_evidence"
    assert len(result.layout_definition["slots"]) == 2
    slots = result.layout_definition["slots"]
    assert slots[0]["top_pt"] == pytest.approx(10)
    assert slots[0]["top_pt"] + slots[0]["height_pt"] == pytest.approx(slots[1]["top_pt"])
    assert slots[1]["top_pt"] > 300
    assert slots[1]["top_pt"] + slots[1]["height_pt"] == pytest.approx(570)


def test_repeated_title_padding_overlap_keeps_three_slots_when_seam_is_clear():
    page = replace(evidence(), candidates=(
        ReceiptCandidate(Rect(0, 0, 600, 305), .98, "unused", ("repeated_title",)),
        ReceiptCandidate(Rect(0, 302, 600, 605), .98, "unused", ("repeated_title",)),
        ReceiptCandidate(Rect(0, 597, 600, 900), .98, "unused", ("repeated_title",)),
    ), visible_objects=(("fill-image", (2, 592, 598, 600)),
                        ("fill-image", (28, 606, 564, 636))))

    result = suggest_layout(page)

    assert result.basis == "page_evidence"
    slots = result.layout_definition["slots"]
    assert len(slots) == 3
    assert slots[1]["top_pt"] + slots[1]["height_pt"] == 601
    assert slots[2]["top_pt"] == 601


@pytest.mark.parametrize("unsafe", ["text", "image", "uncertain", "not_repeated", "large"])
def test_title_overlap_is_not_reconciled_without_clear_seam_evidence(unsafe):
    page = replace(evidence(), candidates=(
        ReceiptCandidate(Rect(0, 0, 600, 305), .98, "unused", ("repeated_title",)),
        ReceiptCandidate(Rect(0, 302, 600, 605), .98, "unused", ("repeated_title",)),
        ReceiptCandidate(Rect(0, 597 if unsafe != "large" else 585, 600, 900), .98,
                         "unused", ("repeated_title",) if unsafe != "not_repeated" else ()),
    ))
    if unsafe == "text":
        block = replace(page.parsed.blocks[-1], y0=598, y1=608)
        page = replace(page, parsed=replace(page.parsed, blocks=(*page.parsed.blocks[:-1], block)))
    elif unsafe == "image":
        page = replace(page, visible_objects=(("fill-image", (20, 598, 580, 608)),))
    elif unsafe == "uncertain":
        page = replace(page, visual_complete=False)

    result = suggest_layout(page)

    assert result.basis == "equal_division"
    assert result.needs_review
    assert result.diagnostics == ({"code": "layout_requires_manual_slots"},)


def test_equal_initial_slots_use_actual_height_gaps_and_count_bound():
    result = suggest_equal_slots(GEOMETRY, 4, top_pt=10, bottom_pt=20, gaps_pt=[10, 20, 10])
    assert result.needs_review and result.basis == "equal_division"
    assert [slot["top_pt"] for slot in result.layout_definition["slots"]] == [10, 227.5, 455, 672.5]
    assert all(slot["height_pt"] == 207.5 for slot in result.layout_definition["slots"])
    for count in (0, -1, True, 1.5, 76, 10**30):
        with pytest.raises(ReceiptLayoutError):
            suggest_equal_slots(GEOMETRY, count)


def test_invalid_markers_are_excluded_but_business_notes_and_unknown_scans_remain():
    page = evidence(("alpha", "此空白联无效！", "备注：此空白联无效"))
    result = compute_receipt_page(page, SHA, {"processing_mode": "split_all", "criteria": None}).result
    assert result["excluded_slots"] == [{"slot_id": "slot-2", "reason": "invalid"}]
    assert [instance["slot_id"] for instance in result["instances"]] == ["slot-1", "slot-3"]
    scan = replace(evidence(), parsed=ParsedPage(1, 600, 900, "", ()), native_text=False,
                   visible_objects=(("fill-image", (0, 0, 600, 900)),))
    result = compute_receipt_page(scan, SHA, {"processing_mode": "split_all", "criteria": None}).result
    assert len(result["candidates"]) == 3 and result["excluded_slots"] == []
    assert all(instance["occupancy"] == "uncertain" for instance in result["instances"])
    assert all(candidate["needs_review"] for candidate in result["candidates"])


def test_incomplete_visual_evidence_cannot_prove_blank():
    page = replace(evidence(), parsed=ParsedPage(1, 600, 900, "", ()), visual_complete=False)
    instances, excluded, diagnostics = instantiate_receipts(page, suggest_layout(page).layout_definition, SHA)
    assert len(instances) == 3 and excluded == []
    assert all(item["code"] == "occupancy_uncertain" for item in diagnostics)


def test_changed_geometry_reassigns_text_and_does_not_reuse_query_selection():
    page = evidence(("alpha", "beta"))
    layout = suggest_equal_slots(GEOMETRY, 2).layout_definition
    first = compute_receipt_page(page, SHA, options(["beta"]), suggestion=LayoutSuggestion(layout, "manual_layout", True))
    assert first.result["candidates"][0]["instance_id"].endswith(":slot-1")
    revised = {**layout, "revision": 2, "uniform_height": False,
               "slots": [{"slot_id": "slot-1", "position_index": 1, "top_pt": 0, "height_pt": 300},
                         {"slot_id": "slot-2", "position_index": 2, "top_pt": 300, "height_pt": 600}]}
    second = compute_receipt_page(page, SHA, options(["beta"]), suggestion=LayoutSuggestion(revised, "manual_layout", True))
    assert second.result["candidates"][0]["instance_id"].endswith(":slot-2")
    assert first.result["candidates"][0]["instance_id"] != second.result["candidates"][0]["instance_id"]


def test_native_block_crossing_two_slots_splits_using_real_lines():
    with pymupdf.open() as document:
        loaded = document.new_page(width=300, height=200)
        loaded.insert_text((20, 90), "alpha\nbeta", fontsize=10, lineheight=1.5)
        parsed = parse_loaded_page(loaded, 1)
        assert len(parsed.blocks) == 1 and parsed.blocks[0].y0 < 95 < parsed.blocks[0].y1
        geometry = read_page_geometry(loaded)
        layout = suggest_equal_slots(geometry, 2).layout_definition
        layout["uniform_height"] = False
        layout["slots"][0]["height_pt"] = 94
        layout["slots"][1]["top_pt"] = 94
        layout["slots"][1]["height_pt"] = 106
        split = split_cross_slot_text(parsed, layout, visible_page(loaded))
        assert [block.text for block in split.blocks] == ["alpha", "beta"]
        objects, complete = collect_visible_objects(visible_page(loaded))
        page = PageLayoutEvidence(geometry, parsed, (), {}, objects, complete)
        result = compute_receipt_page(page, SHA, options(["alpha", "beta"]),
            suggestion=LayoutSuggestion(layout, "manual_layout", True), visible_page=visible_page(loaded))
        assert result.result["candidates"] == []
        assert result.diagnostics == ()


def test_optional_text_metadata_failure_keeps_crossing_block_for_review():
    parsed = ParsedPage(1, 600, 900, "alpha", (TextBlock(1, "alpha", 30, 290, 570, 310, 0),))
    layout = suggest_equal_slots(GEOMETRY, 3).layout_definition
    class BrokenPage:
        def get_text(self, *args, **kwargs):
            raise RuntimeError("synthetic failure")
    assert split_cross_slot_text(parsed, layout, BrokenPage()) is parsed


def test_paper_geometry_mismatch_is_a_hard_error_before_instance_generation():
    layout = suggest_equal_slots(GEOMETRY, 3).layout_definition
    altered = replace(evidence(), geometry={**GEOMETRY, "rotation": 180})
    with pytest.raises(ReceiptLayoutError, match="incompatible_layout"):
        instantiate_receipts(altered, layout, SHA)


def test_visual_stamp_crossing_boundary_requires_review_without_silent_shrinking():
    page = replace(evidence(), visible_objects=(("fill-image", (200, 260, 300, 330)),))
    result = compute_receipt_page(page, SHA, {"processing_mode": "split_all", "criteria": None})
    assert result.result["instances"][0]["rect"]["y1"] == 270
    assert [candidate["needs_review"] for candidate in result.result["candidates"]] == [True, True, False]
    assert [item["slot_id"] for item in result.diagnostics if item["code"] == "visual_crosses_slot"] == ["slot-1", "slot-2"]


def test_content_in_user_excluded_gap_is_an_explicit_diagnostic():
    page = evidence()
    extra = TextBlock(1, "unassigned receipt note", 20, 280, 200, 290, 4)
    page = replace(page, parsed=replace(page.parsed, blocks=(*page.parsed.blocks, extra)))
    result = compute_receipt_page(page, SHA, {"processing_mode": "split_all", "criteria": None})
    assert any(item["code"] == "content_outside_slots" for item in result.diagnostics)
    assert all(candidate["needs_review"] for candidate in result.result["candidates"])


def test_distinct_initial_geometry_has_distinct_definition_and_instance_identity():
    first = suggest_equal_slots(GEOMETRY, 3).layout_definition
    second = suggest_equal_slots(GEOMETRY, 3, top_pt=15).layout_definition
    assert first["layout_id"] != second["layout_id"]
    before, _, _ = instantiate_receipts(evidence(), first, SHA)
    after, _, _ = instantiate_receipts(evidence(), second, SHA)
    assert before[0]["instance_id"] != after[0]["instance_id"]


def test_even_a_thin_unknown_bitmap_is_not_evidence_of_blank():
    page = replace(evidence(), parsed=ParsedPage(1, 600, 900, "", ()),
                   visible_objects=(("fill-image", (0, 0, 600, 1)),))
    result = compute_receipt_page(page, SHA, {"processing_mode": "split_all", "criteria": None})
    assert len(result.result["instances"]) == 1
    assert result.result["instances"][0]["occupancy"] == "uncertain"
    assert result.result["candidates"][0]["needs_review"]


@pytest.mark.parametrize("source_size", [100, 400])
@pytest.mark.parametrize("edge_ink", ["none", "red", "faint_pixel"])
def test_white_image_margin_crossing_saved_slot_does_not_create_blank_receipt(edge_ink, source_size):
    """A neighbouring stamp's bitmap rectangle is not its visible ink extent."""
    with pymupdf.open() as stamp_document, pymupdf.open() as document:
        stamp = stamp_document.new_page(width=100, height=100)
        stamp.draw_rect(pymupdf.Rect(10, 10, 90, 80), color=(1, 0, 0))
        if edge_ink == "red":
            stamp.draw_rect(pymupdf.Rect(10, 99, 90, 100), fill=(1, 0, 0))
        image = stamp.get_pixmap(matrix=pymupdf.Matrix(source_size / 100, source_size / 100))
        if edge_ink == "faint_pixel":
            for x in range(source_size // 10, source_size * 9 // 10):
                image.set_pixel(x, source_size - 1, (254, 255, 255))
        loaded = document.new_page(width=600, height=900)
        loaded.insert_text((30, 50), "Synthetic receipt")
        loaded.insert_image(pymupdf.Rect(50, 200, 150, 300), stream=image.tobytes("png"))
        visible = visible_page(loaded)
        parsed = parse_loaded_page(loaded, 1)
        objects, complete = collect_visible_objects(visible)
        page = PageLayoutEvidence(read_page_geometry(loaded), parsed, (), {}, objects, complete)
        layout = suggest_equal_slots(page.geometry, 3).layout_definition
        layout["uniform_height"] = False
        layout["slots"][0]["height_pt"] = 298
        layout["slots"][1].update(top_pt=299.5, height_pt=300)
        result = compute_receipt_page(page, SHA, {"processing_mode": "split_all", "criteria": None},
            suggestion=LayoutSuggestion(layout, "manual_layout", True), visible_page=visible)
        assert [item["position_index"] for item in result.result["instances"]] == ([1] if edge_ink == "none" else [1, 2])
        assert {item["slot_id"] for item in result.result["excluded_slots"]} == (
            {"slot-2", "slot-3"} if edge_ink == "none" else {"slot-3"})
        # The first crop still clips the stamp rectangle: excluding an actually
        # blank neighbour must not erase review diagnostics on the receipt.
        assert any(item["code"] == "visual_crosses_slot" and item["slot_id"] == "slot-1"
                   for item in result.diagnostics)


@pytest.mark.parametrize("failure", ["missing_renderer", "renderer_failed", "decoder_failed", "oversized",
                                     "non_native", "incomplete", "missing_metadata", "skewed_image"])
def test_uncertain_image_margin_remains_a_candidate_without_bounded_blank_proof(failure):
    page = replace(evidence(("alpha",)), visible_objects=(("fill-image", (50, 200, 150, 301)),))
    layout = suggest_equal_slots(GEOMETRY, 3).layout_definition
    render_calls = []
    class Renderer:
        def get_image_info(self):
            if failure == "missing_metadata":
                return []
            return [{"bbox": (50, 200, 150, 301),
                     "transform": (100, 1 if failure == "skewed_image" else 0, 0, 101, 50, 200),
                     "width": 100_000 if failure == "oversized" else 100,
                     "height": 101_000 if failure == "oversized" else 101}]
        def get_pixmap(self, **kwargs):
            render_calls.append(kwargs)
            if failure == "decoder_failed":
                raise pymupdf.mupdf.FzErrorFormat("synthetic decoder failure")
            raise RuntimeError("render unavailable")
    renderer = Renderer() if failure != "missing_renderer" else None
    if failure == "non_native":
        page = replace(page, native_text=False)
    elif failure == "incomplete":
        page = replace(page, visual_complete=False)
    result = compute_receipt_page(page, SHA, {"processing_mode": "split_all", "criteria": None},
        suggestion=LayoutSuggestion(layout, "manual_layout", True), visible_page=renderer)
    assert [item["position_index"] for item in result.result["instances"]][:2] == [1, 2]
    assert len(render_calls) == (1 if failure in {"renderer_failed", "decoder_failed"} else 0)


def test_blank_image_margin_budget_is_shared_by_slots_without_renumbering(monkeypatch):
    from engine import receipt_layout
    monkeypatch.setattr(receipt_layout, "MAX_BLANK_CHECK_PIXELS", 725_000)
    with pymupdf.open() as document:
        loaded = document.new_page(width=600, height=900)
        white = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 600, 900), False)
        white.clear_with(255)
        loaded.insert_image(loaded.rect, stream=white.tobytes("png"))
        loaded.insert_text((30, 50), "Synthetic receipt")
        visible = visible_page(loaded)
        objects, complete = collect_visible_objects(visible)
        page = PageLayoutEvidence(read_page_geometry(loaded), parse_loaded_page(loaded, 1), (), {}, objects, complete)
        layout = suggest_equal_slots(page.geometry, 3).layout_definition
        result = compute_receipt_page(page, SHA, {"processing_mode": "split_all", "criteria": None},
            suggestion=LayoutSuggestion(layout, "manual_layout", True), visible_page=visible)
        assert [item["position_index"] for item in result.result["instances"]] == [1, 3]
        assert result.result["excluded_slots"] == [{"slot_id": "slot-2", "reason": "blank"}]
        assert result.result["instances"][-1]["occupancy"] == "uncertain"


def test_uncertain_ocr_in_split_all_cannot_be_automatically_confirmed():
    page = evidence()
    page = replace(page, native_text=False, parsed=replace(page.parsed,
                   blocks=tuple(replace(block, confidence=.1) for block in page.parsed.blocks)))
    result = compute_receipt_page(page, SHA, {"processing_mode": "split_all", "criteria": None})
    assert all(candidate["needs_review"] for candidate in result.result["candidates"])


def test_equal_slots_roundoff_is_accepted_consistently_in_selection():
    geometry = {**GEOMETRY, "pdf_box": {"x0": 0, "y0": 0, "x1": 600, "y1": 841.89}, "height_pt": 841.89}
    page = replace(evidence(), geometry=geometry, parsed=ParsedPage(1, 600, 841.89, "", ()), visual_complete=False)
    result = compute_receipt_page(page, SHA, {"processing_mode": "split_all", "criteria": None}, slot_count=6)
    assert len(result.result["instances"]) == 6


def test_image_wholly_inside_a_gap_is_not_silently_discarded():
    page = replace(evidence(), visible_objects=(("fill-image", (20, 280, 50, 290)),))
    result = compute_receipt_page(page, SHA, {"processing_mode": "split_all", "criteria": None})
    assert any(item["code"] == "visual_outside_slots" for item in result.diagnostics)
    assert all(candidate["needs_review"] for candidate in result.result["candidates"])


@pytest.mark.parametrize("anchor", [32, 100, None, True, float("nan")])
def test_same_internal_form_with_wrong_or_unknown_row_origin_is_not_compatible(anchor):
    current = evidence(("alpha",))
    current.descriptor["receipts"][0]["anchor_y"] = anchor
    assert not compatible_reference(current, evidence())


def test_reference_position_matching_is_one_to_one_and_accepts_middle_only():
    current = evidence(("alpha",))
    current.descriptor["receipts"][0]["anchor_y"] = 330
    current = replace(current, parsed=replace(current.parsed,
        blocks=(replace(current.parsed.blocks[0], y0=330, y1=355),)))
    reference = evidence()
    assert compatible_reference(current, reference)
    result = compute_receipt_page(current, SHA, options(["alpha"]), reference=reference)
    assert result.result["instances"][0]["slot_id"] == "slot-2"
    reference.descriptor["receipts"][0]["anchor_y"] = 330
    assert not compatible_reference(current, reference)


def test_empty_display_list_sentinel_is_not_transformed_into_page_spanning_ink(monkeypatch):
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=900)
        monkeypatch.setattr(pymupdf.Page, "get_bboxlog", lambda self, **kwargs: [
            ("stroke-path", (2147483520., 2147484416., -2147483648., -2147482624.)),
            ("fill-image", (20., 20., 50., 50.)),
        ])
        objects, complete = collect_visible_objects(visible_page(page))
        assert complete and objects == (("fill-image", (20., 20., 50., 50.)),)


def test_seam_image_is_included_in_suggestion_but_manual_clip_stays_a_risk():
    page = replace(evidence(), visible_objects=(("fill-image", (200, 250, 300, 280)),))
    result = compute_receipt_page(page, SHA, options(["alpha"]))
    assert result.result["instances"][0]["rect"]["y1"] == 280
    assert not result.result["candidates"][0]["needs_review"]
    manual = suggest_layout(evidence())
    checked = compute_receipt_page(page, SHA, options(["alpha"]), suggestion=manual)
    assert checked.result["candidates"][0]["needs_review"]
    assert any(risk["code"] == "visual_crosses_slot" for risk in checked.diagnostics)


def test_unknown_nonfinite_visual_evidence_is_not_treated_as_blank():
    class Page:
        def get_bboxlog(self):
            return [("fill-image", (0, 0, float("inf"), 100))]
    assert collect_visible_objects(Page()) == ((), False)


@pytest.mark.parametrize("invalid", [float("nan"), float("inf")])
def test_visible_page_adapter_keeps_nonfinite_evidence_unknown(monkeypatch, invalid):
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=900)
        monkeypatch.setattr(pymupdf.Page, "get_bboxlog", lambda self, **kwargs: [
            ("fill-image", (0, 0, invalid, 100))])
        assert collect_visible_objects(visible_page(page)) == ((), False)
