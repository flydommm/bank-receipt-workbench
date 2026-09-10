from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pymupdf
import pytest

from engine import layout as layout_module
from engine.layout import (
    HorizontalSeparator,
    Rect,
    ReceiptCandidate,
    VisualAnchor,
    clamp_rect,
    extract_frame_anchors,
    extract_separators,
    infer_candidates,
    infer_receipt_candidates,
    layout_fingerprint,
    select_candidate_for_match,
)
from engine.pdf_parser import ParsedPage, TextBlock


def _page() -> ParsedPage:
    return ParsedPage(
        page_number=3,
        width=600,
        height=800,
        text="手续费",
        blocks=(
            TextBlock(3, "标题", 50, 40, 200, 60, 0),
            TextBlock(3, "收款方：手续费", 50, 80, 250, 100, 1),
            TextBlock(3, "交易金额：29,500.00", 50, 120, 260, 140, 2),
            TextBlock(3, "另一张回单", 50, 350, 220, 370, 3),
        ),
    )


def test_infer_candidates_splits_large_vertical_gap() -> None:
    candidates = infer_candidates(_page())
    assert len(candidates) == 2
    assert candidates[0].rect.y0 < 40
    assert candidates[1].rect.y0 > 300
    assert candidates[0].confidence > 0.5


def test_fingerprint_uses_page_geometry() -> None:
    assert layout_fingerprint(_page()) == layout_fingerprint(_page())


def test_clamp_rect_keeps_minimum_inside_page() -> None:
    rect = clamp_rect(Rect(-20, -10, 900, 900), 600, 800)
    assert rect == Rect(0, 0, 600, 800)


def test_extract_separators_merges_collinear_segments_before_width_filter(tmp_path: Path) -> None:
    pdf_path = tmp_path / "split-horizontal-edge.pdf"
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    page.draw_line((90, 320), (297, 320))
    page.draw_line((298, 320), (505, 320))
    document.save(pdf_path)
    document.close()

    separators = extract_separators(pdf_path, 1)

    assert any(
        separator.y == pytest.approx(320, abs=0.5)
        and separator.x0 <= 90
        and separator.x1 >= 505
        for separator in separators
    )


def test_merge_horizontal_separators_keeps_lower_edge_of_tolerant_group() -> None:
    merged = layout_module._merge_horizontal_separators(
        (
            HorizontalSeparator(320.0, 20, 300),
            HorizontalSeparator(320.7, 20, 300),
        )
    )

    assert merged == [HorizontalSeparator(320.7, 20, 300)]


def test_merge_horizontal_separators_does_not_chain_y_drift_past_tolerance() -> None:
    merged = layout_module._merge_horizontal_separators(
        (
            HorizontalSeparator(320.0, 20, 100),
            HorizontalSeparator(320.75, 101, 180),
            HorizontalSeparator(321.5, 181, 260),
        )
    )

    assert merged == [
        HorizontalSeparator(320.75, 20, 180),
        HorizontalSeparator(321.5, 181, 260),
    ]


def test_page_local_image_anchor_filters_and_clips_page_rectangles() -> None:
    assert hasattr(layout_module, "_page_local_image_anchor")
    anchor = layout_module._page_local_image_anchor
    assert anchor(-80, -40, -10, 20, 600, 800) is None
    assert anchor(-4, 20, 40, 60, 600, 800) == VisualAnchor(
        "image", 0, 20, 40, 60
    )
    assert anchor(0, 0, 600, 800, 600, 800) is None


def test_extract_frame_anchors_pairs_only_closed_outer_frames(tmp_path: Path) -> None:
    pdf_path = tmp_path / "frames.pdf"
    document = pymupdf.open()
    page = document.new_page(width=600, height=840)
    expected = ((10, 10, 590, 275), (10, 285, 590, 550), (10, 560, 590, 830))
    for x0, y0, x1, y1 in expected:
        page.draw_line((x0, y0), (x1, y0))
        page.draw_line((x1, y0), (x1, y1))
        page.draw_line((x1, y1), (x0, y1))
        page.draw_line((x0, y1), (x0, y0))
        page.draw_line((20, y0 + 50), (580, y0 + 50))
    document.save(pdf_path)
    document.close()

    frames = extract_frame_anchors(pdf_path, 1)

    assert [(item.x0, item.y0, item.x1, item.y1) for item in frames] == list(expected)
    assert all(item.kind == "frame" for item in frames)


def test_extract_frame_anchors_accepts_exactly_two_point_endpoint_mismatch(tmp_path: Path) -> None:
    pdf_path = tmp_path / "two-point-mismatch.pdf"
    document = pymupdf.open()
    page = document.new_page(width=600, height=840)
    page.draw_line((10, 10), (590, 10))
    page.draw_line((590, 10), (590, 275))
    page.draw_line((590, 275), (10, 275))
    page.draw_line((8, 10), (10, 275))
    document.save(pdf_path)
    document.close()

    frames = extract_frame_anchors(pdf_path, 1)

    assert len(frames) == 1
    assert frames[0].kind == "frame"


def test_extract_frame_anchors_rejects_three_point_endpoint_mismatch(tmp_path: Path) -> None:
    pdf_path = tmp_path / "three-point-mismatch.pdf"
    document = pymupdf.open()
    page = document.new_page(width=600, height=840)
    page.draw_line((10, 10), (590, 10))
    page.draw_line((590, 10), (590, 275))
    page.draw_line((590, 275), (10, 275))
    page.draw_line((7, 10), (9, 275))
    document.save(pdf_path)
    document.close()

    frames = extract_frame_anchors(pdf_path, 1)

    assert frames == []


def test_extract_frame_anchors_handles_rectangles_deduplicates_and_sorts(tmp_path: Path) -> None:
    pdf_path = tmp_path / "rectangles.pdf"
    document = pymupdf.open()
    page = document.new_page(width=1000, height=840)
    expected = ((5, 10, 705, 300), (295, 10, 995, 300))
    for x0, y0, x1, y1 in reversed(expected):
        page.draw_rect((x0, y0, x1, y1))
    for x0, y0, x1, y1 in (expected[0],):
        page.draw_line((x0, y0), (x1, y0))
        page.draw_line((x1, y0), (x1, y1))
        page.draw_line((x1, y1), (x0, y1))
        page.draw_line((x0, y1), (x0, y0))
    document.save(pdf_path)
    document.close()

    frames = extract_frame_anchors(pdf_path, 1)

    assert [(item.x0, item.y0, item.x1, item.y1) for item in frames] == list(expected)


def test_extract_frame_anchors_ignores_fill_only_rectangles(tmp_path: Path) -> None:
    pdf_path = tmp_path / "fill-only.pdf"
    document = pymupdf.open()
    page = document.new_page(width=600, height=840)
    page.draw_rect((10, 10, 590, 275), color=None, fill=(1, 0, 0))
    document.save(pdf_path)
    document.close()

    assert extract_frame_anchors(pdf_path, 1) == []


def test_extract_frame_anchors_edge_dedup_is_order_independent(tmp_path: Path) -> None:
    frames_by_order = []
    for order, top_lines in enumerate(((8, 10), (10, 8))):
        pdf_path = tmp_path / f"edge-order-{order}.pdf"
        document = pymupdf.open()
        page = document.new_page(width=600, height=840)
        for y in top_lines:
            page.draw_line((10, y), (590, y))
        page.draw_line((10, 275), (590, 275))
        page.draw_line((10, 12), (10, 275))
        page.draw_line((590, 12), (590, 275))
        document.save(pdf_path)
        document.close()
        frames_by_order.append(extract_frame_anchors(pdf_path, 1))

    assert all(len(frames) == 1 for frames in frames_by_order)
    first, second = (frames[0] for frames in frames_by_order)
    assert first.kind == second.kind == "frame"
    assert all(
        abs(first_coordinate - second_coordinate) <= 2
        for first_coordinate, second_coordinate in zip(
            (first.x0, first.y0, first.x1, first.y1),
            (second.x0, second.y0, second.x1, second.y1),
        )
    )
    assert abs(first.y0 - 11) <= 2


def test_collect_frame_edges_rejects_an_oversized_vector_page(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(layout_module, "MAX_LAYOUT_DRAWING_ITEMS", 2)
    start = SimpleNamespace(x=10, y=10)
    end = SimpleNamespace(x=590, y=10)
    page = SimpleNamespace(
        get_drawings=lambda: [
            {
                "type": "s",
                "color": (0, 0, 0),
                "items": [("l", start, end)] * 3,
            }
        ]
    )

    with pytest.raises(layout_module._LayoutBudgetExceeded):
        layout_module._collect_frame_edges(page, 400, 100, 400, 2)


def test_assemble_frame_edges_rejects_excess_edges_before_pairing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(layout_module, "MAX_FRAME_EDGES_PER_ORIENTATION", 2)
    monkeypatch.setattr(
        layout_module,
        "_find_connecting_vertical",
        lambda *_args, **_kwargs: pytest.fail("frame pairing must not start"),
    )
    horizontals = [
        ((10.0, float(y)), (590.0, float(y))) for y in (10, 275, 540)
    ]

    with pytest.raises(layout_module._LayoutBudgetExceeded):
        layout_module._assemble_frame_edges(horizontals, [], 400, 100, 400, 2)


def test_extract_visual_anchors_stops_before_oversized_image_rect_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(layout_module, "MAX_PAGE_IMAGES", 2)
    closed = False

    class FakePage:
        rect = SimpleNamespace(width=600, height=800)

        @staticmethod
        def get_images(*, full: bool) -> list[object]:
            assert full is True
            return [object(), object(), object()]

        @staticmethod
        def get_image_rects(_image: object) -> list[object]:
            pytest.fail("image rectangles must not be read after the page limit")

    class FakeDocument:
        @staticmethod
        def load_page(_index: int) -> FakePage:
            return FakePage()

        @staticmethod
        def close() -> None:
            nonlocal closed
            closed = True

    monkeypatch.setattr(pymupdf, "open", lambda _path: FakeDocument())

    with pytest.raises(layout_module.LayoutBudgetExceeded):
        layout_module.extract_visual_anchors("oversized.pdf", 1)
    assert closed is True


def test_extract_separators_propagates_drawing_budget_exceeded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(layout_module, "MAX_LAYOUT_DRAWING_ITEMS", 2)
    start = SimpleNamespace(x=10, y=10)
    end = SimpleNamespace(x=590, y=10)
    closed = False

    class FakePage:
        rect = SimpleNamespace(width=600, height=800)

        @staticmethod
        def get_drawings() -> list[dict[str, object]]:
            return [{"items": [("l", start, end)] * 3}]

    class FakeDocument:
        @staticmethod
        def load_page(_index: int) -> FakePage:
            return FakePage()

        @staticmethod
        def close() -> None:
            nonlocal closed
            closed = True

    monkeypatch.setattr(pymupdf, "open", lambda _path: FakeDocument())

    with pytest.raises(layout_module.LayoutBudgetExceeded):
        extract_separators("oversized.pdf", 1)
    assert closed is True


def test_infer_candidates_returns_full_page_when_text_block_budget_is_exceeded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(layout_module, "MAX_TEXT_BLOCKS", 2)
    page = ParsedPage(
        1,
        600,
        800,
        "oversized",
        tuple(
            TextBlock(1, f"block-{index}", 10, index * 20, 200, index * 20 + 10, index)
            for index in range(3)
        ),
    )

    assert infer_candidates(page) == [
        layout_module.LayoutCandidate(
            Rect(0, 0, 600, 800),
            0.2,
            0,
            "layout budget exceeded",
        )
    ]


def test_receipt_inference_stops_consuming_oversized_anchor_iterable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(layout_module, "MAX_VISUAL_ANCHORS", 2)
    consumed: list[int] = []

    def anchors():
        for index in range(10):
            consumed.append(index)
            yield VisualAnchor("image", 10, index * 20, 40, index * 20 + 10)

    candidates = infer_receipt_candidates(_three_receipt_page(), visual_anchors=anchors())

    assert len(consumed) == 3
    assert len(candidates) == 3
    assert all(candidate.confidence <= 0.89 for candidate in candidates)
    assert all(
        "layout_budget_exceeded" in candidate.evidence for candidate in candidates
    )


def test_receipt_inference_marks_oversized_separator_iterable_for_manual_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(layout_module, "MAX_SEPARATOR_SEGMENTS", 2)

    separators = (
        HorizontalSeparator(100, 0, 600),
        HorizontalSeparator(200, 0, 600),
        HorizontalSeparator(300, 0, 600),
    )
    candidates = infer_receipt_candidates(_three_receipt_page(), separators=separators)

    assert len(candidates) == 3
    assert all(candidate.confidence <= 0.89 for candidate in candidates)
    assert all(
        "layout_budget_exceeded" in candidate.evidence for candidate in candidates
    )


def test_separator_line_splits_adjacent_blocks_even_with_small_gap() -> None:
    page = ParsedPage(
        1, 600, 800, "手续费", (
            TextBlock(1, "上方", 50, 40, 150, 55, 0),
            TextBlock(1, "下方", 50, 64, 150, 79, 1),
        ),
    )
    candidates = infer_candidates(page, separators=[HorizontalSeparator(60, 30, 570)])
    assert len(candidates) == 2
    assert "separators" in candidates[0].reason


def _three_receipt_page() -> ParsedPage:
    blocks = []
    for slot, top in enumerate((20, 280, 540), start=1):
        blocks.extend((
            TextBlock(1, "银行客户回单", 40, top, 200, top + 18, slot * 10),
            TextBlock(1, f"收款方：目标{slot}", 45, top + 55, 280, top + 75, slot * 10 + 1),
            TextBlock(1, "打印时间", 45, top + 205, 180, top + 220, slot * 10 + 2),
        ))
    return ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), tuple(blocks))


def _receipt_page(tops: tuple[int, ...]) -> ParsedPage:
    blocks = []
    for slot, top in enumerate(tops, start=1):
        blocks.extend((
            TextBlock(1, "银行客户回单", 40, top, 200, top + 18, slot * 10),
            TextBlock(1, f"收款方：目标{slot}", 45, top + 55, 280, top + 75, slot * 10 + 1),
            TextBlock(1, "打印时间", 45, top + 105, 180, top + 120, slot * 10 + 2),
        ))
    return ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), tuple(blocks))


def test_receipt_candidates_find_three_repeated_title_regions() -> None:
    candidates = infer_receipt_candidates(_three_receipt_page())
    assert len(candidates) == 3
    assert [candidate.slot for candidate in candidates] == ["top", "middle", "bottom"]
    assert all(candidate.rect.x0 == 0 for candidate in candidates)
    assert all(candidate.rect.x1 == _three_receipt_page().width for candidate in candidates)


def test_receipt_candidates_prefer_unique_closed_frames() -> None:
    blocks = []
    for slot, top in enumerate((30, 305, 580), start=1):
        blocks.extend(
            (
                TextBlock(1, "银行客户回单", 40, top, 200, top + 18, slot * 10),
                TextBlock(1, f"收款方：目标{slot}", 45, top + 55, 280, top + 75, slot * 10 + 1),
                TextBlock(1, "打印时间", 45, top + 205, 180, top + 220, slot * 10 + 2),
            )
        )
    page = ParsedPage(
        1,
        600,
        840,
        "\n".join(block.text for block in blocks),
        tuple(blocks),
    )
    internal_lines = tuple(
        HorizontalSeparator(top + 50, 20, 580) for top in (30, 305, 580)
    )
    frames = (
        VisualAnchor("frame", 10, 10, 590, 275),
        VisualAnchor("frame", 10, 285, 590, 550),
        VisualAnchor("frame", 10, 560, 590, 830),
    )

    candidates = infer_receipt_candidates(
        page,
        separators=internal_lines,
        visual_anchors=frames,
    )

    assert [item.rect for item in candidates] == [
        Rect(9, 9, 591, 276),
        Rect(9, 284, 591, 551),
        Rect(9, 559, 591, 831),
    ]
    assert all("frame" in item.evidence and "page_width" not in item.evidence for item in candidates)


def _single_framed_receipt_page() -> ParsedPage:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 100, 200, 118, 0),
        TextBlock(1, "收款方：目标", 45, 155, 280, 175, 1),
        TextBlock(1, "打印时间", 45, 305, 180, 320, 2),
    )
    return ParsedPage(1, 600, 840, "\n".join(block.text for block in blocks), blocks)


def test_receipt_candidates_choose_smallest_valid_nested_frame() -> None:
    page = _single_framed_receipt_page()
    frames = (
        VisualAnchor("frame", 10, 80, 590, 400),
        VisualAnchor("frame", 20, 90, 580, 380),
    )

    candidates = infer_receipt_candidates(page, visual_anchors=frames)

    assert [candidate.rect for candidate in candidates] == [Rect(19, 89, 581, 381)]
    assert candidates[0].evidence == ("repeated_title", "frame")


def test_nested_frame_selection_keeps_required_slot_visual_anchor() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 100, 200, 118, 0),
        TextBlock(1, "收款方：目标", 45, 155, 280, 175, 1),
    )
    page = ParsedPage(1, 600, 400, "\n".join(block.text for block in blocks), blocks)
    frames = (
        VisualAnchor("frame", 10, 70, 590, 300),
        VisualAnchor("frame", 20, 80, 580, 200),
    )
    stamp = VisualAnchor("image", 420, 220, 560, 280)

    candidates = infer_receipt_candidates(
        page,
        visual_anchors=frames + (stamp,),
    )

    assert candidates[0].rect == Rect(9, 69, 591, 301)
    assert candidates[0].evidence == ("repeated_title", "frame")


def test_nested_frame_selection_prefers_full_visual_anchor_containment() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 100, 200, 118, 0),
        TextBlock(1, "收款方：目标", 45, 155, 280, 175, 1),
    )
    page = ParsedPage(1, 600, 400, "\n".join(block.text for block in blocks), blocks)
    frames = (
        VisualAnchor("frame", 10, 70, 590, 300),
        VisualAnchor("frame", 20, 80, 580, 260),
    )
    stamp = VisualAnchor("image", 420, 220, 560, 280)

    candidates = infer_receipt_candidates(
        page,
        visual_anchors=frames + (stamp,),
    )

    assert candidates[0].rect == Rect(9, 69, 591, 301)
    assert candidates[0].evidence == ("repeated_title", "frame")


def test_too_small_frame_omitting_body_preserves_legacy_candidate() -> None:
    page = _single_framed_receipt_page()
    plain = infer_receipt_candidates(page)
    rejected = infer_receipt_candidates(
        page,
        visual_anchors=(VisualAnchor("frame", 10, 90, 590, 145),),
    )

    assert rejected == plain


def test_frame_body_containment_accepts_two_points_but_rejects_more() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 100, 200, 118, 0),
        TextBlock(1, "收款方：目标", 45, 155, 280, 175, 1),
        TextBlock(1, "交易金额：100.00", 45, 300, 280, 315, 2),
    )
    page = ParsedPage(1, 600, 840, "\n".join(block.text for block in blocks), blocks)
    plain = infer_receipt_candidates(page)

    accepted = infer_receipt_candidates(
        page,
        visual_anchors=(VisualAnchor("frame", 10, 80, 590, 313),),
    )
    rejected = infer_receipt_candidates(
        page,
        visual_anchors=(VisualAnchor("frame", 10, 80, 590, 312.9),),
    )

    assert accepted[0].rect == Rect(9, 79, 591, 314)
    assert accepted[0].evidence == ("repeated_title", "frame")
    assert rejected == plain


def test_visual_anchor_generator_preserves_legacy_anchor_behavior() -> None:
    page = _receipt_page((200, 500))
    anchors = (VisualAnchor("logo", 40, 180, 120, 198),)

    from_list = infer_receipt_candidates(page, visual_anchors=anchors)
    from_generator = infer_receipt_candidates(
        page,
        visual_anchors=(anchor for anchor in anchors),
    )

    assert from_generator == from_list


def test_frame_crossing_offset_neighbor_title_preserves_legacy_candidate() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 100, 200, 118, 0),
        TextBlock(1, "收款方：目标1", 45, 155, 280, 175, 1),
        TextBlock(1, "银行客户回单", 500, 300, 580, 318, 2),
        TextBlock(1, "收款方：目标2", 505, 355, 580, 375, 3),
    )
    page = ParsedPage(1, 600, 840, "\n".join(block.text for block in blocks), blocks)
    plain = infer_receipt_candidates(page)
    with_crossing_frame = infer_receipt_candidates(
        page,
        visual_anchors=(VisualAnchor("frame", 10, 80, 400, 310),),
    )

    assert with_crossing_frame == plain


def test_frame_crossing_next_leading_start_is_rejected_as_ambiguous() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 118, 0),
        TextBlock(1, "第一栏正文", 40, 150, 300, 220, 1),
        TextBlock(1, "银行客户回单", 220, 360, 380, 378, 2),
        TextBlock(1, "第二栏正文", 40, 400, 300, 450, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    next_leading_anchor = VisualAnchor("image", 400, 300, 550, 340)
    crossing_frame = VisualAnchor("frame", 10, 80, 590, 350)

    first, second = infer_receipt_candidates(
        page,
        visual_anchors=(crossing_frame, next_leading_anchor),
    )

    assert first.rect.y1 <= next_leading_anchor.y0
    assert "frame" not in first.evidence
    assert "ambiguous_boundary" in first.evidence
    assert "frame" not in second.evidence


def test_frame_ending_at_next_leading_start_is_rejected_after_expansion() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 118, 0),
        TextBlock(1, "第一栏正文", 40, 150, 300, 220, 1),
        TextBlock(1, "银行客户回单", 220, 360, 380, 378, 2),
        TextBlock(1, "第二栏正文", 40, 400, 300, 450, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    next_leading_anchor = VisualAnchor("image", 400, 300, 550, 340)
    touching_frame = VisualAnchor("frame", 10, 80, 590, 300)

    first, _ = infer_receipt_candidates(
        page,
        visual_anchors=(touching_frame, next_leading_anchor),
    )

    assert first.rect.y1 <= next_leading_anchor.y0
    assert "frame" not in first.evidence
    assert "ambiguous_boundary" in first.evidence


def test_frame_half_point_before_next_leading_start_is_rejected_after_expansion() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 118, 0),
        TextBlock(1, "第一栏正文", 40, 150, 300, 220, 1),
        TextBlock(1, "银行客户回单", 220, 360, 380, 378, 2),
        TextBlock(1, "第二栏正文", 40, 400, 300, 450, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    next_leading_anchor = VisualAnchor("image", 400, 300, 550, 340)
    near_frame = VisualAnchor("frame", 10, 80, 590, 299.5)

    first, _ = infer_receipt_candidates(
        page,
        visual_anchors=(near_frame, next_leading_anchor),
    )

    assert first.rect.y1 <= next_leading_anchor.y0
    assert "frame" not in first.evidence
    assert "ambiguous_boundary" in first.evidence


def test_adjacent_associated_frame_start_is_a_hard_boundary() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 118, 0),
        TextBlock(1, "第一栏正文", 40, 150, 300, 220, 1),
        TextBlock(1, "银行客户回单", 220, 360, 380, 378, 2),
        TextBlock(1, "第二栏正文", 40, 400, 300, 450, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    frames = (
        VisualAnchor("frame", 10, 80, 590, 330),
        VisualAnchor("frame", 10, 300, 590, 550),
    )

    first, second = infer_receipt_candidates(page, visual_anchors=frames)

    assert first.rect.y1 <= frames[1].y0
    assert "frame" not in first.evidence
    assert "ambiguous_boundary" in first.evidence
    assert second.rect == Rect(9, 299, 591, 551)
    assert second.evidence == ("repeated_title", "frame")


def test_receipt_candidate_horizontal_bounds_are_independent_of_text_extent() -> None:
    page = _three_receipt_page()
    candidates = infer_receipt_candidates(page)

    assert [(candidate.rect.x0, candidate.rect.x1) for candidate in candidates] == [
        (0, page.width),
        (0, page.width),
        (0, page.width),
    ]


def test_visual_anchor_above_title_extends_candidate_top() -> None:
    page = _receipt_page((200, 500))
    candidates = infer_receipt_candidates(
        page,
        visual_anchors=[VisualAnchor("logo", 40, 180, 120, 198)],
    )

    assert candidates[0].rect.y0 <= 172
    assert "anchor" in candidates[0].evidence


def test_visual_anchor_of_next_receipt_is_not_included_in_previous_candidate() -> None:
    page = _receipt_page((200, 500))
    candidates = infer_receipt_candidates(
        page,
        visual_anchors=[VisualAnchor("logo", 40, 470, 120, 498)],
    )

    assert candidates[0].rect.y1 < 470
    assert candidates[1].rect.y0 <= 470


def test_cross_boundary_text_is_ambiguous_but_previous_candidate_stops_at_raw_visual_start() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 118, 0),
        TextBlock(1, "跨界正文", 40, 320, 300, 350, 1),
        TextBlock(1, "银行客户回单", 220, 400, 380, 418, 2),
        TextBlock(1, "第二栏正文", 40, 440, 300, 530, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    anchors = (VisualAnchor("image", 30, 342, 190, 378),)

    candidates = infer_receipt_candidates(page, visual_anchors=anchors)

    assert candidates[0].rect.y1 <= 342
    assert "ambiguous_boundary" in candidates[0].evidence


def test_cross_boundary_visual_anchor_is_not_assigned_to_previous_slot() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 118, 0),
        TextBlock(1, "第一栏正文", 40, 140, 300, 220, 1),
        TextBlock(1, "银行客户回单", 220, 400, 380, 418, 2),
        TextBlock(1, "第二栏正文", 40, 440, 300, 500, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    anchors = (
        VisualAnchor("image", 300, 330, 420, 360),
        VisualAnchor("image", 30, 342, 190, 378),
    )

    first, second = infer_receipt_candidates(page, visual_anchors=anchors)

    assert first.rect.y1 < 342
    assert "anchor" not in first.evidence
    assert second.rect.y0 <= 334
    assert "anchor" in second.evidence


def test_next_leading_anchor_does_not_mark_previous_slot_ambiguous() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 118, 0),
        TextBlock(1, "第一栏正文", 40, 140, 300, 220, 1),
        TextBlock(1, "银行客户回单", 220, 313.261, 380, 326.761, 2),
        TextBlock(1, "第二栏正文", 40, 440, 300, 500, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    next_leading_anchor = VisualAnchor("image", 400, 312.75, 550, 357.75)

    first, second = infer_receipt_candidates(
        page,
        visual_anchors=(next_leading_anchor,),
    )

    assert "ambiguous_boundary" not in first.evidence
    assert second.rect.y0 == pytest.approx(304.75, abs=0.01)
    assert "anchor" in second.evidence


def test_visual_anchor_starting_just_before_title_belongs_to_following_slot() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 118, 0),
        TextBlock(1, "第一栏正文", 40, 140, 300, 220, 1),
        TextBlock(1, "银行客户回单", 220, 313, 380, 326, 2),
        TextBlock(1, "第二栏正文", 40, 440, 300, 500, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    qr = VisualAnchor("image", 400, 312, 550, 357)

    first, second = infer_receipt_candidates(page, visual_anchors=(qr,))

    assert first.rect.y1 <= second.rect.y0
    assert second.rect.y0 <= 305
    assert "anchor" in second.evidence
    assert second.rect.y1 >= 357


def test_compact_candidate_never_expands_past_next_raw_visual_start() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 108, 0),
        TextBlock(1, "银行客户回单", 220, 146, 380, 154, 1),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    next_leading_anchor = VisualAnchor("image", 400, 114, 550, 125)

    first, second = infer_receipt_candidates(
        page,
        visual_anchors=(next_leading_anchor,),
    )

    assert first.rect.y1 <= 114


def test_frame_first_result_is_unchanged_by_an_ordinary_image_anchor() -> None:
    blocks = (
        TextBlock(1, "框外页眉", 40, 60, 180, 70, 0),
        TextBlock(1, "银行客户回单", 40, 100, 200, 118, 1),
        TextBlock(1, "收款方：目标", 45, 155, 280, 175, 2),
        TextBlock(1, "打印时间", 45, 305, 180, 320, 3),
    )
    page = ParsedPage(1, 600, 840, "\n".join(block.text for block in blocks), blocks)
    frame = VisualAnchor("frame", 10, 80, 590, 400)

    without_image = infer_receipt_candidates(page, visual_anchors=(frame,))
    with_image = infer_receipt_candidates(
        page,
        visual_anchors=(frame, VisualAnchor("image", 30, 40, 100, 78)),
    )

    assert with_image == without_image
    assert with_image[0].evidence == ("repeated_title", "frame")


def test_receipt_candidates_use_header_and_in_slot_visual_envelopes() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 118, 0),
        TextBlock(1, "第一栏正文", 40, 140, 300, 230, 1),
        TextBlock(1, "银行客户回单", 220, 400, 380, 418, 2),
        TextBlock(1, "第二栏正文", 40, 440, 300, 530, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    anchors = (
        VisualAnchor("image", 30, 40, 190, 78),
        VisualAnchor("image", 400, 240, 560, 330),
        VisualAnchor("image", 30, 342, 190, 378),
        VisualAnchor("image", 400, 540, 560, 630),
    )

    first, second = infer_receipt_candidates(page, visual_anchors=anchors)

    assert first.rect.y0 <= 32
    assert first.rect.y1 >= 338
    assert first.rect.y1 <= 342
    assert second.rect.y0 <= 334
    assert second.rect.y1 >= 638
    assert "anchor" in first.evidence
    assert "anchor" in second.evidence


def test_previous_large_seal_is_not_a_following_header_anchor() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 118, 0),
        TextBlock(1, "第一栏正文", 40, 140, 300, 220, 1),
        TextBlock(1, "银行客户回单", 220, 400, 380, 418, 2),
        TextBlock(1, "第二栏正文", 40, 440, 300, 530, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    anchors = (
        VisualAnchor("image", 410, 250, 550, 340),
        VisualAnchor("image", 30, 342, 190, 378),
    )

    first, second = infer_receipt_candidates(page, visual_anchors=anchors)

    assert first.rect.y1 >= 340
    assert second.rect.y0 <= 334
    assert second.rect.y0 > 270


def test_separator_adjustment_does_not_cut_assigned_visual_anchor() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 118, 0),
        TextBlock(1, "第一栏正文", 40, 140, 300, 230, 1),
        TextBlock(1, "银行客户回单", 220, 400, 380, 418, 2),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    anchors = (VisualAnchor("image", 30, 40, 190, 78),)

    candidates = infer_receipt_candidates(
        page,
        separators=(HorizontalSeparator(90, 0, 600),),
        visual_anchors=anchors,
    )

    assert candidates[0].rect.y0 <= 32
    assert "separator" not in candidates[0].evidence


def test_anchor_evidence_requires_full_visual_anchor_containment() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 220, 100, 380, 118, 0),
        TextBlock(1, "第一栏正文", 40, 140, 300, 230, 1),
        TextBlock(1, "银行客户回单", 220, 400, 380, 418, 2),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    anchor = VisualAnchor("image", 30, 40, 190, 78)

    candidate = infer_receipt_candidates(
        page,
        separators=(HorizontalSeparator(41.5, 0, 600),),
        visual_anchors=(anchor,),
    )[0]

    assert candidate.rect.y0 <= anchor.y0
    assert "anchor" in candidate.evidence


def test_lower_separator_search_starts_after_content_and_uses_first_edge_group() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 100, 200, 118, 0),
        TextBlock(1, "正文", 45, 280, 280, 300, 1),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    separators = (
        HorizontalSeparator(150, 20, 580),
        HorizontalSeparator(220, 20, 580),
        HorizontalSeparator(320, 20, 580),
        HorizontalSeparator(320.7, 20, 580),
    )

    candidate = infer_receipt_candidates(page, separators=separators)[0]

    assert candidate.rect.y1 >= 321.6


def test_borderless_tail_defaults_to_margin_when_only_unrelated_lines_exist() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 100, 200, 118, 0),
        TextBlock(1, "正文", 45, 140, 280, 380, 1),
        TextBlock(1, "银行客户回单", 40, 400, 200, 418, 2),
        TextBlock(1, "第二栏正文", 45, 440, 280, 500, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(
        page,
        separators=(HorizontalSeparator(700, 0, 600),),
    )

    assert candidates[0].rect.y1 == pytest.approx(388)


def test_large_cross_boundary_watermark_does_not_mark_candidate_ambiguous() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 100, 200, 118, 0),
        TextBlock(1, "正文", 45, 140, 280, 220, 1),
        TextBlock(1, "水印", 45, 343, 560, 400, 2),
        TextBlock(1, "银行客户回单", 40, 400, 200, 418, 3),
        TextBlock(1, "第二栏正文", 45, 440, 280, 500, 4),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidate = infer_receipt_candidates(page)[0]

    assert "ambiguous_boundary" not in candidate.evidence


def test_slight_cross_boundary_text_does_not_mark_candidate_ambiguous() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 100, 200, 118, 0),
        TextBlock(1, "正文", 45, 140, 280, 220, 1),
        TextBlock(1, "轻微越界", 45, 268, 280, 284, 2),
        TextBlock(1, "银行客户回单", 40, 280, 200, 298, 3),
        TextBlock(1, "第二栏正文", 45, 330, 280, 380, 4),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidate = infer_receipt_candidates(page)[0]

    assert "ambiguous_boundary" not in candidate.evidence


def test_separator_that_only_touches_content_edge_is_not_a_boundary() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 100, 200, 118, 0),
        TextBlock(1, "正文", 45, 280, 280, 300, 1),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidate = infer_receipt_candidates(
        page,
        separators=(HorizontalSeparator(320, 287, 560),),
    )[0]

    assert candidate.rect.y1 < 320
    assert "separator" not in candidate.evidence


def test_select_candidate_returns_region_containing_middle_match() -> None:
    candidates = infer_receipt_candidates(_three_receipt_page())
    selected = select_candidate_for_match(candidates, Rect(45, 335, 280, 355))
    assert selected is not None
    assert selected.slot == "middle"
    assert selected.rect.y0 < 335 < selected.rect.y1
    assert selected.rect.x0 <= 45 <= 280 <= selected.rect.x1


def test_receipt_fields_are_not_mistaken_for_title_anchors() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 20, 200, 38, 0),
        TextBlock(1, "回单编号：12345", 45, 55, 220, 73, 1),
        TextBlock(1, "回单种类：转账", 45, 90, 220, 108, 2),
        TextBlock(1, "打印时间", 45, 125, 180, 140, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    candidates = infer_receipt_candidates(page)
    assert len(candidates) == 1
    assert candidates[0].slot == "slot-1"


def test_receipt_titles_support_multiline_and_controlled_parenthesized_suffixes() -> None:
    blocks = (
        TextBlock(1, "银行电子回单\nElectronic Receipt", 40, 20, 240, 55, 0),
        TextBlock(1, "银行电子回单（补打）", 40, 280, 240, 300, 1),
        TextBlock(1, "银行电子回单(补打)", 40, 540, 240, 560, 2),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    candidates = infer_receipt_candidates(page)
    assert len(candidates) == 3
    assert [candidate.slot for candidate in candidates] == ["top", "middle", "bottom"]


def test_receipt_titles_normalize_spaces_between_cjk_characters() -> None:
    blocks = (
        TextBlock(1, "银 行 客 户 回 单", 40, 20, 240, 38, 0),
        TextBlock(1, "收款方：目标1", 45, 55, 280, 75, 1),
        TextBlock(1, "客 户 回 单 网 上 支 付 跨 行 清 算 业 务", 40, 280, 340, 298, 2),
        TextBlock(1, "收款方：目标2", 45, 315, 280, 335, 3),
        TextBlock(1, "出 账 回 单", 40, 540, 200, 558, 4),
        TextBlock(1, "收款方：目标3", 45, 575, 280, 595, 5),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 3
    assert [candidate.slot for candidate in candidates] == ["top", "middle", "bottom"]


def test_receipt_title_recognizes_bank_credit_notice_without_matching_field_text() -> None:
    blocks = (
        TextBlock(1, "中国 光 大 银 行 贷 记 通 知", 40, 20, 260, 38, 0),
        TextBlock(1, "收款方：手续费", 45, 55, 280, 75, 1),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 1
    assert candidates[0].slot == "slot-1"
    assert "repeated_title" in candidates[0].evidence


def test_receipt_title_recognizes_bank_debit_notice_without_matching_field_text() -> None:
    blocks = (
        TextBlock(1, "中国 光 大 银 行 借 记 通 知", 40, 20, 260, 38, 0),
        TextBlock(1, "收款方：手续费", 45, 55, 280, 75, 1),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 1
    assert candidates[0].slot == "slot-1"
    assert "repeated_title" in candidates[0].evidence


def test_receipt_title_recognizes_standalone_interest_statement() -> None:
    blocks = (
        TextBlock(1, "存款利息单", 40, 20, 220, 40, 0),
        TextBlock(1, "计息账号：123", 45, 80, 280, 100, 1),
        TextBlock(1, "收款回单", 40, 420, 220, 440, 2),
        TextBlock(1, "用途：往来", 45, 480, 280, 500, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 2
    assert candidates[0].rect.y0 < 20 < candidates[0].rect.y1
    assert candidates[1].rect.y0 < 420 < candidates[1].rect.y1


def test_receipt_explanatory_line_containing_receipt_keyword_is_not_title() -> None:
    blocks = (
        TextBlock(1, "深圳农商银行电子回单", 40, 20, 260, 38, 0),
        TextBlock(1, "本凭证信息可通过电子回单校验功能核对", 40, 280, 300, 298, 1),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 1
    assert candidates[0].slot == "slot-1"


def test_receipt_body_labels_containing_receipt_keyword_are_not_title_anchors() -> None:
    blocks = (
        TextBlock(1, "中国工商银行电子回单", 40, 20, 260, 38, 0),
        TextBlock(
            1,
            "业务(产品)种类：对公收费\n摘要：自动打印回单手续费\n产品名称：\n回单管理\n费用名称：\n自动回单打印定额季费",
            40,
            280,
            360,
            340,
            1,
        ),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 1
    assert candidates[0].slot == "slot-1"


def test_receipt_footer_line_starting_with_receipt_keyword_is_not_title() -> None:
    blocks = (
        TextBlock(1, "深圳农商银行电子回单", 40, 20, 260, 38, 0),
        TextBlock(1, "回单的，请注意校对后使用", 40, 280, 300, 298, 1),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 1
    assert candidates[0].slot == "slot-1"


def test_receipt_title_length_limit_applies_to_title_line_not_subtitle_block() -> None:
    block = TextBlock(
        1,
        "中国工商银行电子回单\nIndustrial and Commercial Bank of China Electronic Receipt",
        40,
        20,
        420,
        55,
        0,
    )
    page = ParsedPage(1, 600, 800, block.text, (block,))
    candidates = infer_receipt_candidates(page)
    assert len(candidates) == 1
    assert candidates[0].slot == "slot-1"
    assert "repeated_title" in candidates[0].evidence


def test_electronic_receipt_stamp_is_not_mistaken_for_a_title() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 20, 200, 38, 0),
        TextBlock(1, "电子回单专用章", 420, 300, 560, 320, 1),
        TextBlock(1, "收款方：目标", 45, 340, 280, 360, 2),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 1
    assert candidates[0].slot == "slot-1"


def test_receipt_stamp_is_not_mistaken_for_a_title() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 20, 200, 38, 0),
        TextBlock(1, "回单专用章", 420, 300, 560, 320, 1),
        TextBlock(1, "收款方：目标", 45, 340, 280, 360, 2),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 1
    assert candidates[0].slot == "slot-1"


@pytest.mark.parametrize("stamp", ("电子回单\n专用章", "回单\n专用章"))
def test_multiline_receipt_stamp_is_not_mistaken_for_a_title(stamp: str) -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 20, 200, 38, 0),
        TextBlock(1, stamp, 420, 300, 560, 340, 1),
        TextBlock(1, "收款方：目标", 45, 360, 280, 380, 2),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 1
    assert candidates[0].slot == "slot-1"


@pytest.mark.parametrize(
    "title",
    (
        "回单",
        "入账回单",
        "出账回单",
        "客户回单",
        "通用回单",
        "银行业务回单",
        "客户回单网上支付跨行清算业务",
        "客户回单小额支付系统业务",
        "客户回单电子缴税付款业务",
        "银行电子回单（补打）",
        "中国光大银行借记通知",
        "中国光大银行贷记通知",
    ),
)
def test_known_receipt_title_forms_remain_recognized(title: str) -> None:
    assert layout_module._is_receipt_title(title)


def test_receipt_segment_contains_body_block_before_next_title() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 40, 20, 200, 38, 0),
        TextBlock(1, "跨界前正文", 45, 268, 280, 278, 1),
        TextBlock(1, "银行客户回单", 40, 280, 200, 298, 2),
        TextBlock(1, "打印时间", 45, 330, 180, 345, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    candidates = infer_receipt_candidates(page)
    assert candidates[0].rect.y0 <= 268
    assert candidates[0].rect.y1 >= 278


def test_receipt_segment_marks_content_crossing_next_title_ambiguous() -> None:
    clean_blocks = (
        TextBlock(1, "银行客户回单", 40, 20, 200, 38, 0),
        TextBlock(1, "正文", 45, 268, 280, 278, 1),
        TextBlock(1, "银行客户回单", 40, 280, 200, 298, 2),
    )
    crossing_blocks = (
        clean_blocks[0],
        TextBlock(1, "跨界正文", 45, 268, 280, 292, 1),
        clean_blocks[2],
    )
    clean_page = ParsedPage(1, 600, 800, "\n".join(block.text for block in clean_blocks), clean_blocks)
    crossing_page = ParsedPage(
        1, 600, 800, "\n".join(block.text for block in crossing_blocks), crossing_blocks
    )
    clean = infer_receipt_candidates(clean_page)[0]
    crossing = infer_receipt_candidates(crossing_page)[0]
    assert "ambiguous_boundary" in crossing.evidence
    assert crossing.confidence < clean.confidence
    assert crossing.rect.y1 <= 280


def test_ambiguous_high_density_candidate_rejects_separator_cutting_crossing_text() -> None:
    blocks = [TextBlock(1, "银行客户回单", 40, 20, 200, 38, 0)]
    blocks.extend(
        TextBlock(1, f"字段{index}", 45, 50 + index * 30, 280, 65 + index * 30, index)
        for index in range(1, 7)
    )
    blocks.append(TextBlock(1, "跨界正文", 45, 268, 280, 292, 7))
    blocks.append(TextBlock(1, "银行客户回单", 40, 280, 200, 298, 8))
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), tuple(blocks))
    candidate = infer_receipt_candidates(
        page, separators=[HorizontalSeparator(15, 20, 580)]
    )[0]
    assert "ambiguous_boundary" in candidate.evidence
    assert "separator" not in candidate.evidence
    assert candidate.confidence <= 0.89
    assert candidate.rect.y0 == 12
    assert candidate.rect.y1 <= 280


def test_receipt_candidates_fall_back_to_infer_candidates_without_title() -> None:
    page = ParsedPage(
        1,
        600,
        800,
        "普通文本",
        (
            TextBlock(1, "普通标题", 50, 40, 200, 60, 0),
            TextBlock(1, "收款方：目标", 50, 80, 250, 100, 1),
        ),
    )
    candidates = infer_receipt_candidates(page)
    inferred = infer_candidates(page)
    assert len(candidates) == len(inferred)
    assert all(candidate.slot == "single" for candidate in candidates)
    assert [candidate.evidence for candidate in candidates] == [(item.reason,) for item in inferred]


def test_select_candidate_returns_none_without_containing_region() -> None:
    candidates = infer_receipt_candidates(_three_receipt_page())
    assert select_candidate_for_match(candidates, Rect(10, 250, 590, 550)) is None


def test_select_candidate_prefers_smallest_containing_area() -> None:
    match = Rect(45, 335, 280, 355)
    candidates = (
        ReceiptCandidate(Rect(0, 0, 600, 800), 0.99, "large", ("test",)),
        ReceiptCandidate(Rect(20, 280, 320, 420), 0.80, "small", ("test",)),
    )
    selected = select_candidate_for_match(candidates, match)
    assert selected is not None
    assert selected.slot == "small"


def test_select_candidate_uses_confidence_to_break_area_ties() -> None:
    match = Rect(45, 335, 280, 355)
    candidates = (
        ReceiptCandidate(Rect(20, 280, 320, 420), 0.80, "low-confidence", ("test",)),
        ReceiptCandidate(Rect(20, 280, 320, 420), 0.90, "high-confidence", ("test",)),
    )
    selected = select_candidate_for_match(candidates, match)
    assert selected is not None
    assert selected.slot == "high-confidence"


def test_receipt_slot_names_are_indexed_unless_there_is_no_title() -> None:
    for tops, expected in (
        ((20,), ["slot-1"]),
        ((20, 400), ["slot-1", "slot-2"]),
        ((20, 180, 340, 500), ["slot-1", "slot-2", "slot-3", "slot-4"]),
    ):
        candidates = infer_receipt_candidates(_receipt_page(tops))
        assert [candidate.slot for candidate in candidates] == expected


def test_separator_evidence_increases_candidate_confidence() -> None:
    page = _three_receipt_page()
    plain = infer_receipt_candidates(page)[0]
    with_lines = infer_receipt_candidates(page, separators=[HorizontalSeparator(15, 20, 580)])[0]
    assert "separator" in with_lines.evidence
    assert with_lines.confidence > plain.confidence
    assert with_lines.confidence == round(plain.confidence + 0.03, 3)
    assert with_lines.rect.y0 != plain.rect.y0 or with_lines.rect.y1 != plain.rect.y1


def test_duplicate_table_title_and_page_footer_do_not_expand_single_receipt() -> None:
    blocks = (
        TextBlock(1, "宁波银行客户回单", 240, 12, 355, 26, 0),
        TextBlock(1, "宁波银行客户回单\n交易日期：2025年11月01日", 50, 32, 540, 140, 1),
        TextBlock(1, "收款方：手续费", 55, 150, 300, 165, 2),
        TextBlock(1, "打印方式：网银", 55, 225, 180, 240, 3),
        TextBlock(1, "第52页，共52页", 500, 815, 570, 824, 4),
    )
    page = ParsedPage(1, 595, 842, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 1
    assert candidates[0].slot == "slot-1"
    assert candidates[0].rect.y1 < 300


@pytest.mark.parametrize("footer", [
    "核心流水号：SAMPLE123 页数：1/1",
    "回单验真：请使用银行官网核验此回单",
    "12345678901234567890",
    "回单专用章",
])
def test_bottom_receipt_keeps_business_footer_and_stamp_text(footer: str) -> None:
    blocks = (
        TextBlock(1, "客户回单", 240, 20, 355, 38, 0),
        TextBlock(1, "交易明细", 40, 80, 500, 350, 1),
        TextBlock(1, "收费回单", 240, 435, 355, 453, 2),
        TextBlock(1, "收费种类：手续费", 40, 490, 500, 610, 3),
        TextBlock(1, footer, 45, 790, 260, 810, 4),
    )
    page = ParsedPage(1, 595, 842, "\n".join(block.text for block in blocks), blocks)
    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 2
    assert candidates[0].rect.y1 < 435
    assert candidates[1].rect.y0 <= 435
    assert candidates[1].rect.y1 >= 810


@pytest.mark.parametrize("footer", ["第 52 页，共 52 页", "52 / 52", "Page 52 of 52", "— 52 —"])
def test_standalone_page_numbers_still_do_not_expand_receipt(footer: str) -> None:
    blocks = (
        TextBlock(1, "客户回单", 240, 20, 355, 38, 0),
        TextBlock(1, "交易明细", 40, 80, 500, 350, 1),
        TextBlock(1, footer, 230, 815, 360, 830, 2),
    )
    page = ParsedPage(1, 595, 842, "\n".join(block.text for block in blocks), blocks)
    candidates = infer_receipt_candidates(page)
    assert len(candidates) == 1
    assert candidates[0].rect.y1 < 400


def test_separator_confidence_caps_at_099() -> None:
    top = 20
    blocks = [TextBlock(1, "银行客户回单", 40, top, 200, top + 18, 0)]
    blocks.extend(
        TextBlock(1, f"字段{index}", 45, top + 25 + index * 20, 280, top + 40 + index * 20, index)
        for index in range(1, 8)
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), tuple(blocks))
    plain = infer_receipt_candidates(page)[0]
    with_lines = infer_receipt_candidates(page, separators=[HorizontalSeparator(15, 20, 580)])[0]
    assert plain.confidence == 0.98
    assert with_lines.confidence == 0.99


def test_irrelevant_separators_do_not_change_candidate_evidence() -> None:
    page = _three_receipt_page()
    plain = infer_receipt_candidates(page)[0]
    for separator in (
        HorizontalSeparator(700, 20, 580),
        HorizontalSeparator(15, 300, 580),
    ):
        candidate = infer_receipt_candidates(page, separators=[separator])[0]
        assert "separator" not in candidate.evidence
        assert candidate.confidence == plain.confidence


def test_separator_inside_existing_text_extent_does_not_add_evidence() -> None:
    page = _three_receipt_page()
    plain = infer_receipt_candidates(page)[0]
    candidate = infer_receipt_candidates(
        page, separators=[HorizontalSeparator(200, 20, 580)]
    )[0]
    assert candidate.rect == plain.rect
    assert "separator" not in candidate.evidence
    assert candidate.confidence == plain.confidence


def test_receipt_candidate_clamps_page_edges_and_contains_text_extent() -> None:
    blocks = (
        TextBlock(1, "银行客户回单", 2, 2, 20, 16, 0),
        TextBlock(1, "收款方：页面边缘", 1, 30, 40, 48, 1),
        TextBlock(1, "打印时间", 590, 60, 599, 75, 2),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)
    candidates = infer_receipt_candidates(page)
    assert len(candidates) == 1
    candidate = candidates[0]
    assert 0 <= candidate.rect.x0 <= candidate.rect.x1 <= page.width
    assert 0 <= candidate.rect.y0 <= candidate.rect.y1 <= page.height
    assert candidate.rect == Rect(0, 0, 600, 83)
    assert all(
        candidate.rect.x0 <= block.x0 <= block.x1 <= candidate.rect.x1
        and candidate.rect.y0 <= block.y0 <= block.y1 <= candidate.rect.y1
        for block in blocks
    )
