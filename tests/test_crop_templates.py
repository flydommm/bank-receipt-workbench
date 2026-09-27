from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import shutil
import subprocess

import pymupdf
import pytest

from engine.crop_templates import describe_crop_page
from engine.engine import handle_request
from engine.pdf_parser import parse_loaded_page


def _source_sha256(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def _write_receipts(
    path: Path,
    *,
    titles: tuple[str, ...] = ("银行客户回单", "银行客户回单", "银行客户回单"),
    body_suffix: str = "stable body",
    line_shift: float = 0.0,
    crossing: bool = False,
) -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=900)
    starts = (50.0, 350.0, 650.0)
    for index, title in enumerate(titles):
        start = starts[index]
        page.insert_text((50, start), title, fontname="china-s")
        body_y = start + 100
        page.insert_text((70, body_y), f"内容 {body_suffix} {index}", fontname="china-s")
        page.insert_text((70, start + 150), "固定字段", fontname="china-s")
        page.draw_line((20, start + 210 + line_shift), (580, start + 210 + line_shift))
    if crossing:
        # The first receipt's final block crosses the midpoint before the next
        # title, so the boundary cannot be proven safe.
        page.insert_textbox(
            pymupdf.Rect(70, 330, 500, 385),
            "跨越边界的长文本块",
            fontname="china-s",
        )
    document.save(path)
    document.close()


def _describe(path: Path, page_number: int = 1) -> dict[str, object]:
    document = pymupdf.open(path)
    try:
        return describe_crop_page(document.load_page(page_number - 1))
    finally:
        document.close()


def test_variable_body_content_does_not_change_fingerprint(tmp_path: Path) -> None:
    first = tmp_path / "first.pdf"
    second = tmp_path / "second.pdf"
    _write_receipts(first, body_suffix="one")
    _write_receipts(second, body_suffix="a much longer variable value")

    first_template = _describe(first)
    second_template = _describe(second)

    assert first_template["status"] == second_template["status"] == "ready"
    assert first_template["fingerprint"] == second_template["fingerprint"]
    assert first_template["receipts"] == second_template["receipts"]


def test_different_heading_or_table_geometry_changes_fingerprint(tmp_path: Path) -> None:
    first = tmp_path / "first.pdf"
    different_title = tmp_path / "different-title.pdf"
    different_lines = tmp_path / "different-lines.pdf"
    _write_receipts(first)
    _write_receipts(different_title, titles=("宁波银行网上交易凭证",) * 3)
    _write_receipts(different_lines, line_shift=7)

    first_fingerprint = _describe(first)["fingerprint"]
    assert _describe(different_title)["fingerprint"] != first_fingerprint
    assert _describe(different_lines)["fingerprint"] != first_fingerprint


def test_three_receipts_are_partitioned_by_text_gap_midpoints(tmp_path: Path) -> None:
    path = tmp_path / "three.pdf"
    _write_receipts(path)

    template = _describe(path)

    assert template["status"] == "ready"
    receipts = template["receipts"]
    assert isinstance(receipts, list)
    assert len(receipts) == 3
    bounds = [item["bounds"] for item in receipts]
    assert bounds[0]["y0"] == pytest.approx(0)
    assert bounds[-1]["y1"] == pytest.approx(900)
    assert bounds[0]["y1"] == pytest.approx(270.6, abs=0.2)
    assert bounds[1]["y0"] == pytest.approx(bounds[0]["y1"])
    assert bounds[1]["y1"] == pytest.approx(570.6, abs=0.2)
    assert bounds[2]["y0"] == pytest.approx(bounds[1]["y1"])
    assert all(
        item["bounds"]["x0"] == 0
        and item["bounds"]["x1"] == 600
        and item["bounds"]["y0"] < item["anchor_y"] < item["bounds"]["y1"]
        for item in receipts
    )


def _bitmap_rule_page(document, *, kind="dark", separator=False, crossing=False):
    page = document.new_page(width=600, height=900)
    pixels = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 977, 2), kind == "transparent")
    pixels.clear_with() if kind == "transparent" else pixels.clear_with(255 if kind == "white" else 0)
    if kind == "partial":
        pixels.set_rect(pymupdf.IRect(400, 0, 977, 2), (255, 255, 255))
    for start in (50, 350, 650):
        page.insert_text((210, start), "中国民生银行支付业务回单", fontname="china-s")
        page.insert_text((40, start + 40), "付款人名称：合成甲公司", fontname="china-s")
        page.insert_text((40, start + 150), "打印时间：2026-09-14", fontname="china-s")
        page.insert_image(pymupdf.Rect(20, start + 210, 150 if kind == "short" else 580,
                                      start + (240 if kind == "thick" else 211)),
                          pixmap=pixels, keep_proportion=False, rotate=180 if kind == "rotated" else 0)
    if separator:
        divider = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 976, 22), False)
        divider.clear_with(100)
        for y in (267, 567):
            page.insert_image(pymupdf.Rect(2, y, 598, y + 8), pixmap=divider, keep_proportion=False)
    if crossing:
        page.draw_circle((70, 270), 30, color=(1, 0, 0))
    return page


def test_verified_bitmap_rules_support_three_receipts_and_keep_whole_dividers():
    with pymupdf.open() as document:
        first = describe_crop_page(_bitmap_rule_page(document, separator=True))
        second = describe_crop_page(_bitmap_rule_page(document, separator=True))
        assert first['status'] == second['status'] == 'ready'
        assert len(first['receipts']) == 3
        assert first['receipts'][0]['template_fingerprint'] == second['receipts'][0]['template_fingerprint']
        for receipt, y in zip(first['receipts'], (267, 567)):
            assert not y < receipt['bounds']['y1'] < y + 8


@pytest.mark.parametrize('kind', ['white', 'transparent', 'partial', 'short', 'thick', 'rotated'])
def test_unverified_bitmap_rectangles_are_not_table_line_evidence(kind):
    with pymupdf.open() as document:
        assert describe_crop_page(_bitmap_rule_page(document, kind=kind)) == {
            'status': 'unavailable', 'reason': 'ambiguous_layout'}


def test_bitmap_rule_does_not_weaken_stamp_boundary_protection():
    with pymupdf.open() as document:
        assert describe_crop_page(_bitmap_rule_page(document, separator=True, crossing=True)) == {
            'status': 'unavailable', 'reason': 'ambiguous_layout'}


def test_bitmap_rule_placement_budget_fails_closed(monkeypatch):
    with pymupdf.open() as document:
        page = _bitmap_rule_page(document)
        original = page.get_image_rects
        monkeypatch.setattr(page, 'get_image_rects', lambda xref, **kwargs: original(xref, **kwargs) * 44)
        assert describe_crop_page(page) == {'status': 'unavailable', 'reason': 'budget_exceeded'}


def _write_print_count_receipts(path: Path, *, merged_marker_title: bool = False) -> None:
    """Build three vertically repeated receipts with the next-copy marker."""

    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        for start in (65.0, 365.0, 665.0):
            if merged_marker_title:
                page.insert_textbox(
                    pymupdf.Rect(220, start - 31, 500, start + 5),
                    "打印次数：0\n上海银行业务回单",
                    fontname="china-s",
                    fontsize=11,
                )
            else:
                page.insert_text((430, start - 20), "打印次数：0", fontname="china-s")
                page.insert_text((230, start), "上海银行业务回单", fontname="china-s")
            page.insert_text((30, start + 40), "付款人名称：合成甲公司", fontname="china-s")
            page.insert_text((30, start + 70), "付款人开户行：中国建设银行", fontname="china-s")
            page.insert_text((330, start + 70), "收款人开户行：中国工商银行", fontname="china-s")
            page.insert_text((30, start + 110), "金额（小写）：123.00", fontname="china-s")
            page.insert_text((330, start + 200), "打印时间：2026-09-13", fontname="china-s")
            page.draw_line((20, start + 230), (580, start + 230))
        document.save(path)


@pytest.mark.parametrize("merged_marker_title", [False, True])
def test_print_count_marker_belongs_to_following_receipt(
    tmp_path: Path,
    merged_marker_title: bool,
) -> None:
    path = tmp_path / ("print-count-merged.pdf" if merged_marker_title else "print-count.pdf")
    _write_print_count_receipts(path, merged_marker_title=merged_marker_title)

    template = _describe(path)

    assert template["status"] == "ready"
    receipts = template["receipts"]
    assert isinstance(receipts, list) and len(receipts) == 3
    with pymupdf.open(path) as document:
        markers = document[0].search_for("打印次数：0")
    assert len(markers) == 3
    # The marker immediately before copies two and three must remain outside
    # the preceding receipt's protection range.  A merged marker/title block
    # exercises the line-level extraction path used by real PDFs.
    assert receipts[0]["bounds"]["y1"] <= markers[1].y0
    assert receipts[1]["bounds"]["y1"] <= markers[2].y0
    assert all(
        item["bounds"]["y0"] <= item["anchor_y"] < item["bounds"]["y1"]
        for item in receipts
    )


def test_current_receipt_print_count_footer_is_retained_when_far_from_next_title(
    tmp_path: Path,
) -> None:
    path = tmp_path / "print-count-footer.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        for start in (65.0, 365.0, 665.0):
            page.insert_text((230, start), "上海银行业务回单", fontname="china-s")
            page.insert_text((30, start + 40), "付款人名称：合成甲公司", fontname="china-s")
            page.insert_text((30, start + 70), "收款人名称：合成乙公司", fontname="china-s")
            page.insert_text((30, start + 110), "金额（小写）：123.00", fontname="china-s")
            page.insert_text((430, start + 225), "打印次数：0", fontname="china-s")
            page.draw_line((20, start + 235), (580, start + 235))
        document.save(path)

    template = _describe(path)

    assert template["status"] == "ready"
    receipts = template["receipts"]
    assert isinstance(receipts, list) and len(receipts) == 3
    with pymupdf.open(path) as document:
        markers = document[0].search_for("打印次数：0")
    assert len(markers) == 3
    # Each footer marker and its divider belong to the current receipt.  The
    # marker is deliberately far from the next title, so it must be retained
    # rather than treated as a prefix for the next copy.
    assert all(
        item["bounds"]["y1"] > marker.y1
        for item, marker in zip(receipts, markers, strict=True)
    )
    assert all(
        item["bounds"]["y1"] >= start + 235
        for item, start in zip(receipts, (65.0, 365.0, 665.0), strict=True)
    )
    assert [item["bounds"]["y1"] for item in receipts] == pytest.approx(
        [323.1, 623.1, 900.0], abs=0.2,
    )
    assert len({item["template_fingerprint"] for item in receipts}) == 1


def _write_split_print_count_receipts(
    path: Path,
    *,
    marker_offset: float = -20.0,
    separator_offset: float = 230.0,
) -> None:
    """Build three copies whose print count is split into two text lines."""

    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        for start in (65.0, 365.0, 665.0):
            # A small gap and separate insertions reproduce the label/value
            # line boxes emitted by the affected Shanghai Bank PDF.
            page.insert_text(
                (430, start + marker_offset), "打印次数：",
                fontname="china-s", fontsize=10,
            )
            page.insert_text(
                (488, start + marker_offset), "0",
                fontname="china-s", fontsize=10,
            )
            page.insert_text((230, start), "上海银行业务回单", fontname="china-s")
            page.insert_text((30, start + 40), "付款人名称：合成甲公司", fontname="china-s")
            page.insert_text((30, start + 70), "收款人名称：合成乙公司", fontname="china-s")
            page.insert_text((30, start + 110), "金额（小写）：123.00", fontname="china-s")
            page.insert_text((330, start + 200), "打印时间：2026-09-13", fontname="china-s")
            page.draw_line(
                (20, start + separator_offset),
                (580, start + separator_offset),
            )
        document.save(path)


def test_split_print_count_label_and_value_are_assigned_as_one_marker(
    tmp_path: Path,
) -> None:
    """Keep both text objects of a split counter with the following copy."""

    from engine import crop_templates as module

    path = tmp_path / "print-count-split.pdf"
    _write_split_print_count_receipts(path)

    template = _describe(path)

    assert template["status"] == "ready"
    receipts = template["receipts"]
    assert isinstance(receipts, list) and len(receipts) == 3
    with pymupdf.open(path) as document:
        lines = module._dict_title_boxes(document[0], titles_only=False)
    labels = sorted(
        (box for text, box in lines if module._is_print_count_label(text)),
        key=lambda box: (box[1], box[0]),
    )
    values = sorted(
        (box for text, box in lines if module._is_print_count_value(text)),
        key=lambda box: (box[1], box[0]),
    )
    pairs = module._split_print_count_pair_candidates(lines)
    assert len(labels) == len(values) == len(pairs) == 3
    assert len({item["template_fingerprint"] for item in receipts}) == 1

    for index, (label, value) in enumerate(zip(labels, values, strict=True)):
        bounds = receipts[index]["bounds"]
        for box in (label, value):
            assert bounds["y0"] <= box[1] < box[3] <= bounds["y1"]
        if index:
            assert receipts[index - 1]["bounds"]["y1"] <= label[1]


def test_split_print_count_pairing_rejects_ambiguous_geometry() -> None:
    from engine import crop_templates as module

    label = (100.0, 100.0, 145.0, 110.0)
    valid_value = (150.0, 100.0, 155.0, 110.0)
    assert module._split_print_count_pair_candidates(
        [("打印次数：", label), ("0", valid_value)],
    ) == [(label, valid_value)]
    for value in (
        (150.0, 103.0, 155.0, 113.0),  # different baseline
        (162.0, 100.0, 167.0, 110.0),  # too far to the right
        (150.0, 100.0, 200.0, 110.0),  # value is too wide
    ):
        assert not module._split_print_count_pair_candidates(
            [("打印次数：", label), ("0", value)],
        )
    assert not module._split_print_count_pair_candidates(
        [("打印次数：", label), ("0", valid_value), ("1", (160.0, 100.0, 165.0, 110.0))],
    )
    assert not module._split_print_count_pair_candidates(
        [("打印次数：", label), ("零", valid_value)],
    )


def test_split_print_count_footer_is_retained_when_far_from_next_title(
    tmp_path: Path,
) -> None:
    path = tmp_path / "print-count-split-footer.pdf"
    _write_split_print_count_receipts(
        path,
        marker_offset=225.0,
        separator_offset=235.0,
    )

    template = _describe(path)

    assert template["status"] == "ready"
    receipts = template["receipts"]
    assert isinstance(receipts, list) and len(receipts) == 3
    assert [item["bounds"]["y1"] for item in receipts] == pytest.approx(
        [323.1, 623.1, 900.0], abs=0.2,
    )
    assert len({item["template_fingerprint"] for item in receipts}) == 1


def test_split_print_count_pair_budget_fails_closed(tmp_path: Path, monkeypatch) -> None:
    from engine import crop_templates as module

    path = tmp_path / "print-count-split-budget.pdf"
    _write_split_print_count_receipts(path)
    monkeypatch.setattr(module, "_PRINT_COUNT_SPLIT_PAIR_BUDGET", 2)

    assert _describe(path) == {"status": "unavailable", "reason": "budget_exceeded"}


def _write_visual_receipts(
    path: Path,
    *,
    overlapping: bool = False,
    with_frames: bool = True,
    with_gap_footer: bool = False,
) -> None:
    """Build raster-backed copies with complete vector frames and a seal overhang."""

    starts = (
        (10.0, 276.0, 565.0)
        if overlapping
        else (10.0, 350.0, 690.0)
        if with_gap_footer
        else (10.0, 288.0, 565.0)
    )
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=1000 if with_gap_footer else 900)
        pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 4, 4))
        image = pixmap.tobytes("png")
        try:
            for index, start in enumerate(starts):
                page.insert_image(
                    pymupdf.Rect(10, start + 2, 581, start + 268),
                    stream=image,
                )
                if with_frames:
                    page.draw_rect(
                        pymupdf.Rect(10, start, 584, start + 268),
                        color=(0, 0, 0),
                        width=1,
                    )
                page.insert_image(
                    pymupdf.Rect(55, start + 176, 175, start + 275),
                    stream=image,
                )
                page.insert_text((230, start + 31), "银行客户回单", fontname="china-s")
                page.insert_text((30, start + 70), f"固定字段 {index}", fontname="china-s")
                page.insert_text((30, start + 110), "金额：123.00", fontname="china-s")
                if with_gap_footer and index < len(starts) - 1:
                    page.insert_text(
                        (30, start + 320),
                        f"当前回单页脚 {index}",
                        fontname="china-s",
                        fontsize=11,
                    )
        finally:
            del pixmap
        document.save(path)


def test_complete_visual_frames_use_empty_gaps_for_boundaries(tmp_path: Path) -> None:
    path = tmp_path / "visual-frames.pdf"
    _write_visual_receipts(path)

    result = _describe(path)

    assert result["status"] == "ready"
    receipts = result["receipts"]
    assert isinstance(receipts, list) and len(receipts) == 3
    boundaries = [receipt["bounds"]["y1"] for receipt in receipts]
    # The seal overhangs each frame, so the boundary must stay in the
    # remaining visible gap before the following frame's side edge.
    assert boundaries[:2] == pytest.approx([286.25, 563.75], abs=0.2)
    assert all(
        previous < following
        for previous, following in zip(
            [receipt["bounds"]["y0"] for receipt in receipts],
            [receipt["bounds"]["y1"] for receipt in receipts],
            strict=True,
        )
    )


def test_overlapping_visual_frames_remain_ambiguous(tmp_path: Path) -> None:
    path = tmp_path / "visual-frames-overlap.pdf"
    _write_visual_receipts(path, overlapping=True)

    assert _describe(path) == {"status": "unavailable", "reason": "ambiguous_layout"}


def test_complete_raster_copies_can_supply_boundaries_without_frames(tmp_path: Path) -> None:
    path = tmp_path / "visual-images.pdf"
    _write_visual_receipts(path, with_frames=False)

    result = _describe(path)

    assert result["status"] == "ready"
    receipts = result["receipts"]
    assert isinstance(receipts, list) and len(receipts) == 3
    assert all(
        receipt["bounds"]["y0"] < receipt["anchor_y"] < receipt["bounds"]["y1"]
        for receipt in receipts
    )


def test_visual_gap_boundary_keeps_current_footer_in_current_copy(tmp_path: Path) -> None:
    path = tmp_path / "visual-frames-footer.pdf"
    _write_visual_receipts(path, with_gap_footer=True)

    document = pymupdf.open(path)
    try:
        parsed = parse_loaded_page(document[0], 1)
        footer_bottoms = [
            block.y1 for block in parsed.blocks if "当前回单页脚" in block.text
        ]
    finally:
        document.close()

    result = _describe(path)

    assert result["status"] == "ready"
    receipts = result["receipts"]
    assert isinstance(receipts, list) and len(receipts) == 3
    boundaries = [receipt["bounds"]["y1"] for receipt in receipts]
    assert len(footer_bottoms) == 2
    assert boundaries[0] > footer_bottoms[0]
    assert boundaries[1] > footer_bottoms[1]


@pytest.mark.parametrize(
    ("builder", "reason"),
    (
        (lambda path: _write_receipts(path, titles=()), "no_text"),
        (lambda path: _write_receipts(path, titles=("普通报告",)), "no_titles"),
        (lambda path: _write_receipts(path, crossing=True), "ambiguous_layout"),
    ),
)
def test_unavailable_layouts_fail_closed(tmp_path: Path, builder, reason: str) -> None:
    path = tmp_path / f"{reason}.pdf"
    builder(path)

    assert _describe(path) == {"status": "unavailable", "reason": reason}


def test_too_many_text_blocks_return_budget_reason(tmp_path: Path) -> None:
    class BudgetPage:
        rect = type("Rect", (), {"width": 600, "height": 900})()
        number = 0

        def get_text(self, kind="text", **_kwargs):
            if kind == "blocks":
                return [(0, 0, 1, 1, "x")] * 4_097
            if kind == "dict":
                return {"blocks": []}
            return ""

        def get_drawings(self):
            return []

    assert describe_crop_page(BudgetPage()) == {
        "status": "unavailable",
        "reason": "budget_exceeded",
    }


def test_engine_crop_template_uses_one_private_snapshot_and_returns_page_metadata(tmp_path: Path) -> None:
    path = tmp_path / "engine.pdf"
    _write_receipts(path)
    source_hash = _source_sha256(path)

    response = handle_request({
        "op": "analyze_page",
        "path": str(path),
        "page": 1,
        "matches": [],
        "source_sha256": source_hash,
        "include_crop_template": True,
    })

    assert response["status"] == "ok"
    assert response["page"] == 1
    assert response["page_count"] == 1
    assert response["page_width"] == pytest.approx(600)
    assert response["page_height"] == pytest.approx(900)
    assert response["source_sha256"] == source_hash
    assert response["crop_template"]["status"] == "ready"
    assert "selections" not in response
    encoded = json.dumps(response, ensure_ascii=False)
    assert "内容" not in encoded
    assert "固定字段" not in encoded


def test_engine_crop_template_validates_flag_matches_page_and_sha(tmp_path: Path) -> None:
    path = tmp_path / "engine.pdf"
    _write_receipts(path)
    source_hash = _source_sha256(path)
    common = {
        "op": "analyze_page",
        "path": str(path),
        "page": 1,
        "matches": [],
        "source_sha256": source_hash,
    }

    assert handle_request({**common, "include_crop_template": "true"})["code"] == "invalid_request"
    assert handle_request({
        **common,
        "include_crop_template": True,
        "matches": [{"x0": 1, "y0": 1, "x1": 2, "y1": 2}],
    })["code"] == "invalid_matches"
    assert handle_request({**common, "include_crop_template": True, "page": 0})["code"] == "invalid_page"
    assert handle_request({**common, "include_crop_template": True, "source_sha256": "0" * 64})["code"] == "source_changed"


def test_receipt_height_column_lines_distinguish_layouts(tmp_path: Path) -> None:
    fingerprints = []
    for column_x in (120, 180):
        path = tmp_path / f"column-{column_x}.pdf"
        _write_receipts(path)
        with pymupdf.open(path) as document:
            page = document[0]
            page.draw_line((column_x, 100), (column_x, 165))
            result = describe_crop_page(page)
            assert result["status"] == "ready"
            fingerprints.append(result["fingerprint"])
    assert fingerprints[0] != fingerprints[1]


@pytest.mark.parametrize("kind", ["image", "fill", "curve", "short_line", "rectangle"])
def test_non_text_objects_crossing_receipt_boundary_are_rejected(tmp_path: Path, kind: str) -> None:
    path = tmp_path / f"crossing-{kind}.pdf"
    _write_receipts(path)
    with pymupdf.open(path) as document:
        page = document[0]
        assert describe_crop_page(page)["status"] == "ready"
        if kind == "image":
            pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 2, 2), False)
            pixmap.clear_with(80)
            page.insert_image(pymupdf.Rect(40, 250, 100, 310), pixmap=pixmap)
        elif kind == "fill":
            page.draw_rect(pymupdf.Rect(40, 250, 100, 310), color=None, fill=(1, 0, 0))
        elif kind == "curve":
            page.draw_bezier((40, 250), (80, 255), (60, 300), (100, 310))
        elif kind == "short_line":
            page.draw_line((40, 250), (40, 310))
        else:
            page.draw_rect(pymupdf.Rect(20, 100, 580, 310))
        assert describe_crop_page(page) == {"status": "unavailable", "reason": "ambiguous_layout"}


def test_cumulative_text_budgets_apply_across_blocks_and_lines(monkeypatch) -> None:
    from engine import crop_templates as module

    class TextPage:
        def __init__(self, blocks):
            self.blocks = blocks

        def get_text(self, kind, **kwargs):
            return {"blocks": self.blocks}

    line = {"bbox": (0, 0, 10, 10), "spans": [{"text": "a"}, {"text": "b"}]}
    blocks = [{"type": 0, "lines": [line, line]}] * 2
    for name, limit in (("MAX_TEXT_LINE_BUDGET", 3), ("MAX_TEXT_SPAN_BUDGET", 7), ("MAX_TEXT_CHARACTER_BUDGET", 7)):
        with monkeypatch.context() as patch:
            patch.setattr(module, name, limit)
            with pytest.raises(module._BudgetExceeded):
                module._dict_title_boxes(TextPage(blocks))


def test_raw_block_character_budget_precedes_parsing(monkeypatch) -> None:
    from engine import crop_templates as module

    class TextPage:
        def get_text(self, kind):
            return [(0, 0, 1, 1, "abcd"), (0, 0, 1, 1, "efgh")]

    monkeypatch.setattr(module, "MAX_TEXT_CHARACTER_BUDGET", 7)
    with pytest.raises(module._BudgetExceeded):
        module._count_text_blocks(TextPage())


def _issuer_receipts(
    page,
    starts=(65.0, 365.0, 665.0),
    *,
    issuer="中国民生银行",
    counterparty_bank="中国建设银行",
    line_shift=0.0,
    title="支付业务回单（付款）",
    heading_in_title=False,
):
    for start in starts:
        if issuer and not heading_in_title:
            page.insert_text((30, start - 22), issuer, fontname="china-s")
        page.insert_text((190, start), (issuer if heading_in_title else "") + title, fontname="china-s")
        page.insert_text((30, start + 40), "付款人名称：测试甲公司", fontname="china-s")
        page.insert_text((30, start + 70), f"付款人开户行：{counterparty_bank}", fontname="china-s")
        page.insert_text((330, start + 70), "收款人开户行：中国工商银行", fontname="china-s")
        page.insert_text((30, start + 110), "金额（小写）：123.00", fontname="china-s")
        page.draw_line((20, start + 190 + line_shift), (580, start + 190 + line_shift))


def test_receipt_templates_match_full_page_tail_and_different_slots_without_body_bank_values() -> None:
    with pymupdf.open() as document:
        document.new_page(width=600, height=900)
        document.new_page(width=600, height=900)
        document.new_page(width=600, height=900)
        _issuer_receipts(document[0])
        _issuer_receipts(document[1], starts=(65.0,), counterparty_bank="上海银行")
        _issuer_receipts(document[2], starts=(365.0,))
        full, tail, shifted = [describe_crop_page(page) for page in document]
        assert full["status"] == tail["status"] == shifted["status"] == "ready"
        assert full["fingerprint"] != tail["fingerprint"] != shifted["fingerprint"]
        receipts = full["receipts"] + tail["receipts"] + shifted["receipts"]
        assert len({item["template_fingerprint"] for item in receipts}) == 1
        assert receipts[0]["template_fingerprint"] is not None
        assert {item["issuer_bank_key"] for item in receipts} == {sha256("中国民生银行".encode()).hexdigest()}
        assert {item["issuer_bank_name"] for item in receipts} == {"中国民生银行"}


@pytest.mark.parametrize("issuer", [None, "付款人开户行：中国民生银行", "收款人开户行：中国民生银行"])
def test_account_bank_or_unknown_heading_never_establishes_receipt_issuer(issuer) -> None:
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        _issuer_receipts(page, starts=(65.0,), issuer=issuer)
        result = describe_crop_page(page)
        assert result["status"] == "ready"
        assert result["receipts"][0]["issuer_bank_key"] is None
        assert result["receipts"][0]["template_fingerprint"] is None


def test_same_counterparty_bank_does_not_join_different_issuers_and_geometry() -> None:
    with pymupdf.open() as document:
        for _ in range(3):
            document.new_page(width=600, height=900)
        _issuer_receipts(document[0], starts=(65.0,), issuer="上海银行")
        _issuer_receipts(document[1], starts=(65.0,), issuer="中国民生银行")
        _issuer_receipts(document[2], starts=(65.0,), issuer="上海银行", line_shift=7)
        receipts = [describe_crop_page(page)["receipts"][0] for page in document]
        assert receipts[0]["issuer_bank_key"] != receipts[1]["issuer_bank_key"]
        assert receipts[0]["issuer_bank_key"] == receipts[2]["issuer_bank_key"]
        assert len({item["template_fingerprint"] for item in receipts}) == 3


def test_issuer_in_receipt_title_is_accepted_but_conflicting_header_is_unknown() -> None:
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        _issuer_receipts(page, starts=(65.0,), issuer="上海银行", title="业务回单", heading_in_title=True)
        result = describe_crop_page(page)
        assert result["receipts"][0]["issuer_bank_key"] == sha256("上海银行".encode()).hexdigest()
        page.insert_text((30, 43), "中国民生银行", fontname="china-s")
        result = describe_crop_page(page)
        assert result["receipts"][0]["issuer_bank_key"] is None


@pytest.mark.parametrize("label_y,bank_y", [(43, 43), (28, 43)])
def test_split_account_bank_near_first_title_is_not_an_issuer(label_y, bank_y) -> None:
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        _issuer_receipts(page, starts=(65.0,), issuer=None)
        page.insert_text((20, label_y), "付款人开户行：", fontname="china-s")
        page.insert_text((350, bank_y), "中国建设银行", fontname="china-s")
        descriptor = describe_crop_page(page)
        assert descriptor["status"] == "ready"
        assert descriptor["receipts"][0]["issuer_bank_key"] is None


def test_previous_receipt_split_account_bank_cannot_become_next_receipt_issuer() -> None:
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        for position, text in (
            ((190, 65), "测试甲银行业务回单"), ((30, 105), "付款人名称：合成甲公司"),
            ((30, 140), "金额（小写）：123.00"), ((30, 330), "付款人开户行："),
            ((350, 330), "中国建设银行"), ((190, 365), "业务回单"),
            ((30, 405), "付款人名称：合成乙公司"), ((30, 445), "金额（小写）：456.00"),
        ):
            page.insert_text(position, text, fontname="china-s")
        page.draw_line((20, 342), (580, 342))
        page.draw_line((20, 555), (580, 555))
        descriptor = describe_crop_page(page)
        assert descriptor["status"] == "ready"
        assert descriptor["receipts"][0]["issuer_bank_key"] == sha256("测试甲银行".encode()).hexdigest()
        assert descriptor["receipts"][1]["issuer_bank_key"] is None
        assert descriptor["receipts"][1]["template_fingerprint"] is None


def test_split_bank_field_exact_header_geometry_is_rejected() -> None:
    from engine.crop_templates import _Title, _issuer_bank_key

    title = _Title("业务回单", "unused", 190, 300, 250, 316)
    lines = [("付款人开户行：", (20, 274, 120, 290)), ("中国建设银行", (350, 274, 450, 290))]
    assert _issuer_bank_key(title, lines, 70) is None


def test_one_divider_without_fixed_fields_does_not_establish_same_bank_template() -> None:
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        page.insert_text((190, 65), "上海银行业务回单", fontname="china-s")
        page.insert_text((30, 105), "不明确的凭证正文", fontname="china-s")
        page.draw_line((20, 255), (580, 255))
        receipt = describe_crop_page(page)["receipts"][0]
        assert receipt["issuer_bank_key"] == sha256("上海银行".encode()).hexdigest()
        assert receipt["template_fingerprint"] is None


@pytest.mark.skipif(shutil.which("bun") is None, reason="Bun is needed for the Python-to-TypeScript crop contract")
def test_generated_full_tail_and_cross_pdf_candidates_feed_the_linked_planner(tmp_path: Path) -> None:
    """Exercise real candidate + descriptor output, not hand-made equal hashes."""
    paths = [tmp_path / "complete-and-tail.pdf", tmp_path / "same-bank-other-file.pdf"]
    for source_index, path in enumerate(paths):
        with pymupdf.open() as document:
            document.new_page(width=600, height=900)
            if source_index == 0:
                document.new_page(width=600, height=900)
                _issuer_receipts(document[0])
                _issuer_receipts(document[1], starts=(65.0,))
            else:
                _issuer_receipts(document[0], starts=(65.0,))
            document.save(path)
    segments = []
    descriptors = []
    for path in paths:
        digest = _source_sha256(path)
        with pymupdf.open(path) as document:
            for page_index, page in enumerate(document):
                matches = [{"x0": box.x0, "y0": box.y0, "x1": box.x1, "y1": box.y1}
                           for box in page.search_for("测试甲公司")]
                common = {"op": "analyze_page", "path": str(path), "page": page_index + 1, "source_sha256": digest}
                analysis = handle_request({**common, "matches": matches})
                metadata = handle_request({**common, "matches": [], "include_crop_template": True})
                assert analysis["status"] == metadata["status"] == "ok"
                for index, selection in enumerate(analysis["selections"]):
                    assert selection["candidate_rect"] is not None
                    segment = {
                        "id": f"{path.stem}-{page_index}-{index}", "sourcePath": str(path),
                        "sourceKey": path.stem, "sourceSha256": digest, "sourcePage": page_index + 1,
                        "segmentNo": index + 1, "matchRect": selection["match_rect"],
                        "candidateRect": selection["candidate_rect"], "finalRect": selection["candidate_rect"],
                        "pageWidth": 600, "pageHeight": 900, "confidence": selection["confidence"],
                        "slot": selection["slot"], "layoutFingerprint": "generated-fixture",
                        "mode": "candidate", "manualAdjusted": False, "reviewStatus": "needs_review",
                    }
                    segments.append(segment)
                    descriptors.append(metadata)
    assert len(segments) == 5
    module = (Path(__file__).resolve().parents[1] / "src/domain/batchCrop.ts").as_posix()
    script = f"""
import {{ createLinkedCropPlan, cropPageKey }} from {json.dumps(module)};
    const data = await Bun.stdin.json();
    const pages = new Map(data.segments.map((segment, i) => [cropPageKey(segment), data.descriptors[i]]));
    const applied = [];
    for (const sampleIndex of [0, 1, 2]) {{
      const sample = structuredClone(data.segments[sampleIndex]);
      const targets = data.segments.filter((_, index) => index !== sampleIndex);
      sample.mode = 'manual'; sample.manualAdjusted = true;
      // Try each physical column as the saved sample. The crop includes its
      // masthead and bottom rule while excluding the next receipt.
      const anchor = data.descriptors[sampleIndex].crop_template.receipts[sample.segmentNo - 1].anchor_y;
      sample.finalRect = {{ x0: 2, y0: anchor - 30, x1: 598, y1: anchor + 220 }};
      const result = createLinkedCropPlan(sample, targets, pages);
      if (result.applicable.length !== targets.length) throw new Error(JSON.stringify(result.skipped.map(item => ({{ id: item.segment.id, reason: item.reason }}))));
      for (const {{ after }} of result.applicable) {{
        if (Math.abs((after.finalRect.x1 - after.finalRect.x0) - (sample.finalRect.x1 - sample.finalRect.x0)) > 0.01 ||
            Math.abs((after.finalRect.y1 - after.finalRect.y0) - (sample.finalRect.y1 - sample.finalRect.y0)) > 0.01 ||
            after.reviewStatus !== 'needs_review') throw new Error('Linked sizes/status differ');
      }}
      applied.push(result.applicable.length);
    }}
    process.stdout.write(JSON.stringify({{ applied }}));
"""
    result = subprocess.run(
        [shutil.which("bun"), "-e", script],
        input=json.dumps({"segments": segments, "descriptors": descriptors}),
        text=True, encoding="utf-8", capture_output=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"applied": [4, 4, 4]}
