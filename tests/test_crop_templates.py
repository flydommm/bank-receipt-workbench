from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path

import pymupdf
import pytest

from engine.crop_templates import describe_crop_page
from engine.engine import handle_request


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
