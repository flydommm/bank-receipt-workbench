"""Titleless receipt tables stay whole without depending on an issuer name.

All PDFs in this module are generated synthetic data, including their images.
"""

from hashlib import sha256

import pymupdf
import pytest

from engine.batch_pdf import open_batch_source
from engine.crop import PdfSegment, export_segments
from engine.engine import _analyze_page_geometry
from engine.layout import Rect, infer_receipt_candidates
from engine.pdf_parser import parse_loaded_page
from engine.search import SearchBudget


ALL = {"processing_mode": "split_all", "criteria": None}


@pytest.fixture(autouse=True)
def private_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))


def _bitmap():
    image = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 32, 16), False)
    image.clear_with(100)
    return image.tobytes("png")


def _table(page, top, marker, *, style="segments", issuer=None,
           left=40, right=560, sx=1.0, sy=1.0, stamp_kind="image"):
    """Draw a closed grid whose exterior consists of separate cell edges."""
    xs = [left, left + (right - left) * .27, left + (right - left) * .54, right]
    ys = [top + offset for offset in (0, 22, 82, 108, 134, 158)]
    if style == "cells":
        for x0, x1 in zip(xs, xs[1:]):
            for y0, y1 in zip(ys, ys[1:]):
                page.draw_rect(pymupdf.Rect(x0*sx, y0*sy, x1*sx, y1*sy),
                               color=(0, 0, 0), width=.6)
    else:
        for y in ys:
            for x0, x1 in zip(xs, xs[1:]):
                page.draw_line((x0*sx, y*sy), (x1*sx, y*sy), width=.6)
        for x in xs:
            for y0, y1 in zip(ys, ys[1:]):
                page.draw_line((x*sx, y0*sy), (x*sx, y1*sy), width=.6)
    for offset, text in ((15, "凭证编号：合成数据"), (43, "账号：SYNTHETIC"),
                         (70, marker), (100, "金额：12.00"),
                         (126, "摘要：合成交易"), (150, "流水编号：SYNTHETIC")):
        page.insert_text(((left+10)*sx, (top+offset)*sy), text,
                         fontname="china-s", fontsize=9*min(sx, sy))
    logo = pymupdf.Rect((left+4)*sx, (top-24)*sy, (left+114)*sx, (top-7)*sy)
    stamp = pymupdf.Rect((right-85)*sx, (top+120)*sy, (right-15)*sx, (top+190)*sy)
    page.insert_image(logo, stream=_bitmap(), keep_proportion=False)
    if stamp_kind == "vector":
        page.draw_oval(stamp, color=(1, 0, 0), width=1.5)
    else:
        page.insert_image(stamp, stream=_bitmap(), keep_proportion=False)
    if issuer is not None:
        page.insert_text(((left+130)*sx, (top-10)*sy), issuer,
                         fontname="china-s", fontsize=10*min(sx, sy))
    page.insert_text((left*sx, (top+174)*sy), "本凭证请勿重复记账。",
                     fontname="china-s", fontsize=8*min(sx, sy))
    return pymupdf.Rect(left*sx, logo.y0, right*sx, stamp.y1)


def _source(tmp_path, *, count=1, style="segments", issuer=None, size=(600, 900),
            stamp_kind="image"):
    path = tmp_path / "titleless-tables.pdf"
    envelopes = []
    with pymupdf.open() as document:
        page = document.new_page(width=size[0], height=size[1])
        for index in range(count):
            envelopes.append(_table(page, 50+280*index, f"TARGET_{index}",
                                    style=style, issuer=issuer,
                                    sx=size[0]/600, sy=size[1]/900, stamp_kind=stamp_kind))
        document.save(path)
    return path, envelopes


def _analyze(path):
    with pymupdf.open(path) as document:
        page = document[0]
        parsed = parse_loaded_page(page, 1)
        return _analyze_page_geometry(path, 1, parsed, loaded_page=page)


@pytest.mark.parametrize("count", [1, 2, 3])
@pytest.mark.parametrize("style", ["segments", "cells"])
def test_titleless_grids_are_whole_receipts_with_complete_images_and_footer(tmp_path, count, style):
    path, envelopes = _source(tmp_path, count=count, style=style)
    original = path.read_bytes()
    _separators, _anchors, candidates, exceeded = _analyze(path)
    assert not exceeded
    assert len(candidates) == count
    for candidate, expected in zip(candidates, envelopes, strict=True):
        rect = candidate.rect
        assert rect.x0 <= expected.x0 and rect.x1 >= expected.x1
        assert rect.y0 <= expected.y0 and rect.y1 >= expected.y1
    assert all(a.rect.y1 < b.rect.y0 for a, b in zip(candidates, candidates[1:]))
    assert path.read_bytes() == original


@pytest.mark.parametrize("issuer", [None, "中国民生银行", "中国建设银行", "合成地方银行"])
@pytest.mark.parametrize("size", [(595, 842), (1008, 842)])
def test_titleless_detection_uses_structure_across_issuers_and_page_sizes(tmp_path, issuer, size):
    path, envelopes = _source(tmp_path, count=2, issuer=issuer, size=size)
    _separators, _anchors, candidates, exceeded = _analyze(path)
    assert not exceeded
    assert len(candidates) == 2
    for candidate, expected in zip(candidates, envelopes, strict=True):
        assert candidate.rect.y0 <= expected.y0
        assert candidate.rect.y1 >= expected.y1


def test_titleless_batch_search_and_export_keep_other_receipt_out(tmp_path):
    path, envelopes = _source(tmp_path, count=2, style="cells")
    original = path.read_bytes()
    search = {"processing_mode": "search", "criteria": {
        "include": ["TARGET_0"], "includeMode": "all", "exclude": []}}
    with open_batch_source(path, sha256(original).hexdigest()) as source:
        all_receipts = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), allow_ocr=False)
        result = source.compute_receipt_page(1, search, "exact", SearchBudget(), allow_ocr=False)
    assert len(all_receipts.result["candidates"]) == 2
    assert len(result.result["instances"]) == 2
    assert len(result.result["candidates"]) == 1
    selected = result.result["candidates"][0]["instance_id"]
    instance = next(item for item in result.result["instances"] if item["instance_id"] == selected)
    rect = Rect(**instance["rect"])
    assert rect.y0 <= envelopes[0].y0 and rect.y1 >= envelopes[0].y1
    assert rect.y1 < envelopes[1].y0
    output = tmp_path / "selected.pdf"
    export_segments(path, output, [PdfSegment(1, rect)])
    with pymupdf.open(output) as exported:
        assert exported.page_count == 1
        text = exported[0].get_text()
        assert "TARGET_0" in text and "TARGET_1" not in text
        assert "请勿重复记账" in text
    assert path.read_bytes() == original


def test_horizontal_lines_without_a_closed_grid_retain_existing_fallback(tmp_path):
    path = tmp_path / "separate-text-bands.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        for index, top in enumerate((80, 330, 580)):
            page.insert_text((50, top), f"SYNTHETIC_{index}", fontsize=12)
            page.draw_line((35, top+20), (565, top+20))
        document.save(path)
    with pymupdf.open(path) as document:
        page = document[0]
        parsed = parse_loaded_page(page, 1)
        separators, _anchors, candidates, exceeded = _analyze_page_geometry(
            path, 1, parsed, loaded_page=page)
        expected = infer_receipt_candidates(parsed, separators=separators)
    assert not exceeded
    assert candidates == expected
    assert len(candidates) == 3


def test_side_by_side_tables_do_not_become_overlapping_vertical_slots(tmp_path):
    path = tmp_path / "side-by-side.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        _table(page, 60, "LEFT", left=20, right=285)
        _table(page, 60, "RIGHT", left=315, right=580)
        document.save(path)
    with open_batch_source(path) as source:
        result = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), allow_ocr=False)
    slots = result.result["layout_definition"]["slots"]
    assert all(a["top_pt"]+a["height_pt"] <= b["top_pt"]
               for a, b in zip(slots, slots[1:]))
    assert result.suggestion.needs_review


@pytest.mark.parametrize("defect", ["missing_side", "broken_side", "fill_only"])
def test_open_or_fill_only_tables_do_not_supply_closed_table_evidence(tmp_path, defect):
    path = tmp_path / "unproven-table.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        xs, ys = (40, 280, 560), (80, 110, 150, 190, 238)
        if defect == "fill_only":
            for x0, x1 in zip(xs, xs[1:]):
                for y0, y1 in zip(ys, ys[1:]):
                    page.draw_rect(pymupdf.Rect(x0, y0, x1, y1),
                                   color=None, fill=(.9, .9, .9))
        else:
            for y in ys:
                page.draw_line((xs[0], y), (xs[-1], y))
            for x in xs[:-1]:
                page.draw_line((x, ys[0]), (x, ys[-1]))
            if defect == "broken_side":
                # A real eight-point gap cannot be healed as endpoint noise.
                page.draw_line((xs[-1], ys[0]), (xs[-1], 160))
                page.draw_line((xs[-1], 168), (xs[-1], ys[-1]))
        for index, y in enumerate(ys[:-1]):
            page.insert_text((50, y+20), f"SYNTHETIC_FIELD_{index}", fontsize=10)
        document.save(path)
    _separators, anchors, candidates, exceeded = _analyze(path)
    assert not exceeded
    assert not any(anchor.kind == "table" for anchor in anchors)
    assert not any("closed_table" in candidate.evidence for candidate in candidates)


@pytest.mark.parametrize("limit", ["MAX_SEGMENTS", "MAX_COMPARISONS"])
def test_table_geometry_budget_discards_all_optional_page_evidence(tmp_path, monkeypatch, limit):
    from engine import table_geometry

    path, _envelopes = _source(tmp_path)
    monkeypatch.setattr(table_geometry, limit, 1)
    separators, anchors, candidates, exceeded = _analyze(path)
    assert exceeded
    assert separators == [] and anchors == []
    assert candidates
    assert not any("closed_table" in candidate.evidence for candidate in candidates)


@pytest.mark.parametrize("stamp_kind", ["image", "vector"])
def test_stamp_crossing_two_tables_prevents_the_closed_table_shortcut(tmp_path, stamp_kind):
    path = tmp_path / "crossing-stamp.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        _table(page, 50, "TARGET_0")
        _table(page, 330, "TARGET_1")
        stamp = pymupdf.Rect(430, 175, 550, 430)
        if stamp_kind == "vector":
            page.draw_oval(stamp, color=(1, 0, 0), width=1.5)
        else:
            page.insert_image(stamp, stream=_bitmap(), keep_proportion=False)
        document.save(path)
    _separators, anchors, candidates, exceeded = _analyze(path)
    assert not exceeded
    assert sum(anchor.kind == "table" for anchor in anchors) == 2
    assert not any("closed_table" in candidate.evidence for candidate in candidates)
    with open_batch_source(path) as source:
        result = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), allow_ocr=False)
    assert result.suggestion.needs_review


def test_vector_stamp_below_a_table_is_included_in_its_receipt(tmp_path):
    path, envelopes = _source(tmp_path, count=2, stamp_kind="vector")
    _separators, _anchors, candidates, exceeded = _analyze(path)
    assert not exceeded
    assert len(candidates) == 2
    for candidate, expected in zip(candidates, envelopes, strict=True):
        assert candidate.rect.y0 <= expected.y0
        assert candidate.rect.y1 >= expected.y1
    assert candidates[0].rect.y1 < candidates[1].rect.y0


def test_titled_receipt_path_does_not_depend_on_new_table_extraction(tmp_path, monkeypatch):
    from engine import table_geometry

    path, _envelopes = _source(tmp_path, count=2, issuer="合成银行业务回单")
    original = _analyze(path)
    assert len(original[2]) == 2 and not original[3]
    # The established title-based path should not incur the extra grid work.
    monkeypatch.setattr(table_geometry, "MAX_SEGMENTS", 0)
    assert _analyze(path) == original


def test_shared_side_rules_do_not_join_two_complete_receipts(tmp_path):
    path = tmp_path / "shared-side-rules.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        _table(page, 50, "TARGET_FIRST")
        _table(page, 330, "TARGET_SECOND")
        # A printed page border joins the two grids, but the two independent
        # transaction bodies and their mastheads still establish two receipts.
        page.draw_line((40, 208), (40, 330))
        page.draw_line((560, 208), (560, 330))
        document.save(path)
    _separators, _anchors, candidates, exceeded = _analyze(path)
    assert not exceeded
    assert len(candidates) == 2
    assert candidates[0].rect.y1 < candidates[1].rect.y0
    search = {"processing_mode": "search", "criteria": {
        "include": ["TARGET_FIRST"], "includeMode": "all", "exclude": []}}
    with open_batch_source(path) as source:
        result = source.compute_receipt_page(1, search, "exact", SearchBudget(), allow_ocr=False)
    assert len(result.result["instances"]) == 2
    assert len(result.result["candidates"]) == 1
    selected_id = result.result["candidates"][0]["instance_id"]
    selected = next(item for item in result.result["instances"] if item["instance_id"] == selected_id)
    assert selected["rect"]["y1"] < 306  # The second receipt's logo starts here.


@pytest.mark.parametrize("stamp_top", [220, 190])
def test_rectangular_vector_stamp_is_complete_inside_the_receipt(tmp_path, stamp_top):
    path = tmp_path / "rectangular-vector-stamp.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        _table(page, 50, "TARGET")
        page.draw_rect(pymupdf.Rect(475, stamp_top, 550, 310), color=(1, 0, 0), width=1.5)
        document.save(path)
    _separators, _anchors, candidates, exceeded = _analyze(path)
    assert not exceeded
    assert len(candidates) == 1
    assert "closed_table" in candidates[0].evidence
    assert candidates[0].rect.y1 >= 310


def test_tall_merged_remarks_row_does_not_split_one_complete_table(tmp_path):
    path = tmp_path / "merged-remarks-row.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        for y in (50, 90, 130, 180, 300, 340, 380, 430):
            page.draw_line((40, y), (560, y))
        for x in (40, 560):
            page.draw_line((x, 50), (x, 430))
        # The tall middle row is one merged remarks cell. Column strokes
        # resume underneath; that alone is not a second receipt masthead.
        for x in (200, 400):
            page.draw_line((x, 50), (x, 180))
            page.draw_line((x, 300), (x, 430))
        for y, text in ((75, "NAME"), (115, "ACCOUNT"), (165, "AMOUNT"),
                        (240, "REMARKS"), (325, "DETAIL_1"),
                        (365, "DETAIL_2"), (415, "TOTAL")):
            page.insert_text((60, y), text, fontsize=10)
        document.save(path)
    _separators, _anchors, candidates, exceeded = _analyze(path)
    assert not exceeded
    assert len(candidates) == 1
    assert candidates[0].rect.y0 <= 50
    assert candidates[0].rect.y1 >= 430
