"""Synthetic regressions for the production extraction / crop coordinate chain."""
from __future__ import annotations

import hashlib

import pymupdf
import pytest

from engine.crop import PdfSegment, export_merged_segments, export_segments
from engine.layout import Rect, extract_frame_anchors, extract_separators, extract_visual_anchors
from engine.pdf_geometry import read_page_geometry, unrotated_rect_to_visible, visible_rect_to_unrotated
from engine.pdf_parser import parse_loaded_page


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
@pytest.mark.parametrize('unit', [1, 2])
def test_decimal_pdf_boxes_have_identical_analysis_preview_and_inspection_dimensions(tmp_path, monkeypatch, rotation, unit):
    from engine.batch_pdf import open_batch_source
    from engine.engine import _parse_pdf_segments, handle_request
    from engine.search import SearchBudget

    monkeypatch.setenv('PDF_SEARCH_PRIVATE_TEMP', str(tmp_path / 'private'))
    path = tmp_path / 'decimal-box.pdf'
    with pymupdf.open() as source:
        page = source.new_page(width=600, height=850)
        source.xref_set_key(page.xref, 'MediaBox', '[0 0 595.275 841.889]')
        source.xref_set_key(page.xref, 'UserUnit', str(unit))
        page = source.reload_page(page)
        page.insert_text((50, 80), 'TARGET')
        page.set_rotation(rotation)
        source.save(path)
    original = path.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    with pymupdf.open(path) as source:
        geometry = read_page_geometry(source[0])
        expected = (geometry['width_pt'], geometry['height_pt'])
        assert expected != (source[0].rect.width, source[0].rect.height)
        parsed = parse_loaded_page(source[0], 1)
        assert (parsed.width, parsed.height) == expected
        # The upper edge of a legitimate reviewed crop uses the same PDF-box
        # coordinates as analysis; float32 raster extents must not reject it.
        segments = _parse_pdf_segments(source, [{'page_number': 1, 'review_status': 'confirmed',
            'rect': {'x0': 0, 'y0': 0, 'x1': expected[0], 'y1': expected[1]}}])
        assert segments[0].rect == Rect(0, 0, *expected)
    with open_batch_source(path, digest) as batch:
        criteria = {'include': ['TARGET'], 'includeMode': 'all', 'exclude': []}
        legacy = batch.compute_page(1, criteria, 'exact', SearchBudget())
        current = batch.compute_receipt_page(1, {'processing_mode': 'search', 'criteria': criteria},
                                             'exact', SearchBudget(), allow_ocr=False)
        assert (legacy['page_width'], legacy['page_height']) == expected
        assert current.result['layout_definition']['page_geometry'] == geometry
    common = {'path': str(path), 'page': 1, 'source_sha256': digest}
    responses = [
        handle_request({**common, 'op': 'render_page'}),
        handle_request({**common, 'op': 'inspect_pages', 'pages': [1]})['pages'][0],
        handle_request({**common, 'op': 'analyze_page', 'matches': [], 'include_crop_template': True}),
    ]
    for response in responses:
        assert response['status'] == 'ok'
        assert (response['page_width'], response['page_height']) == expected
    assert path.read_bytes() == original


def _source(rotation, unit):
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    document.xref_set_key(page.xref, 'MediaBox', '[-40 -60 560 740]')
    document.xref_set_key(page.xref, 'CropBox', '[10 20 510 680]')
    page = document.reload_page(page)
    page.insert_text((60, 85), 'TARGET', fontsize=12)
    page.insert_text((260, 240), 'NEIGHBOR', fontsize=12)
    page.draw_rect(pymupdf.Rect(40, 50, 180, 100), color=(1, 0, 0))
    document.xref_set_key(page.xref, 'UserUnit', str(unit))
    page.set_rotation(rotation)
    document.reload_page(page)
    return document


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
@pytest.mark.parametrize('unit', [1, 2])
def test_parser_returns_visible_physical_coordinates(rotation, unit):
    with _source(rotation, unit) as source:
        page = source[0]
        geometry = read_page_geometry(page)
        expected = unrotated_rect_to_visible(page.get_text('blocks')[0][:4], geometry)
        parsed = parse_loaded_page(page, 1)
        block = parsed.blocks[0]
        assert (block.x0, block.y0, block.x1, block.y1) == pytest.approx(tuple(expected.values()))
        assert (parsed.width, parsed.height) == (geometry['width_pt'], geometry['height_pt'])


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
@pytest.mark.parametrize('unit', [1, 2])
@pytest.mark.parametrize('merged', [False, True])
def test_reviewed_crop_exports_exact_visible_pixels_and_text(tmp_path, rotation, unit, merged):
    source_path = tmp_path / 'synthetic.pdf'
    output_path = tmp_path / 'export.pdf'
    with _source(rotation, unit) as source:
        source.save(source_path)
        geometry = read_page_geometry(source[0])
        visible = unrotated_rect_to_visible((30 * unit, 40 * unit, 190 * unit, 110 * unit), geometry)
        expected = source[0].get_pixmap(clip=pymupdf.Rect(tuple(visible.values())), alpha=False)
    before = hashlib.sha256(source_path.read_bytes()).digest()
    segment = PdfSegment(1, Rect(**visible))
    if merged:
        export_merged_segments(output_path, [(source_path, [segment])])
    else:
        export_segments(source_path, output_path, [segment])
    with pymupdf.open(output_path) as output:
        actual = output[0].get_pixmap(alpha=False)
        assert 'TARGET' in output[0].get_text()
        assert 'NEIGHBOR' not in output[0].get_text()
        assert (actual.width, actual.height, actual.samples) == (expected.width, expected.height, expected.samples)
    assert hashlib.sha256(source_path.read_bytes()).digest() == before


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
@pytest.mark.parametrize('unit', [1, 2])
def test_layout_frame_image_and_separator_coordinates_follow_visible_page(rotation, unit):
    with _source(rotation, 1) as source:
        page = source[0]
        geometry = read_page_geometry(page)
        width, height = geometry['width_pt'], geometry['height_pt']
        visible_frame = (20, 30, width - 20, height * .3)
        visible_image = (40, height * .6, 100, height * .6 + 40)
        frame = tuple(visible_rect_to_unrotated(visible_frame, geometry).values())
        image = tuple(visible_rect_to_unrotated(visible_image, geometry).values())
        page.set_rotation(0)
        page.draw_rect(pymupdf.Rect(frame), color=(0, 0, 0))
        pixels = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 120, 80), False)
        pixels.clear_with(0)
        page.insert_image(pymupdf.Rect(image), pixmap=pixels, keep_proportion=False)
        source.xref_set_key(page.xref, 'UserUnit', str(unit))
        page.set_rotation(rotation)
        page = source.reload_page(page)
        frames = extract_frame_anchors('unused.pdf', 1, loaded_page=page)
        expected = tuple(value * unit for value in visible_frame)
        assert any((f.x0, f.y0, f.x1, f.y1) == pytest.approx(expected) for f in frames)
        anchors = extract_visual_anchors('unused.pdf', 1, loaded_page=page)
        assert len(anchors) == 1
        assert (anchors[0].x0, anchors[0].y0, anchors[0].x1, anchors[0].y1) == pytest.approx(
            tuple(value * unit for value in visible_image))
        separators = extract_separators('unused.pdf', 1, loaded_page=page)
        assert any((s.x0, s.y, s.x1) == pytest.approx((expected[0], expected[1], expected[2])) for s in separators)


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_visible_page_adapter_is_idempotent_and_does_not_rotate_pixmaps(rotation):
    from engine.pdf_parser import visible_page

    with _source(rotation, 2) as source:
        raw = source[0]
        adapted = visible_page(raw)
        assert visible_page(adapted) is adapted
        assert parse_loaded_page(adapted, 1) == parse_loaded_page(raw, 1)
        assert adapted.get_pixmap().samples == raw.get_pixmap().samples
        assert adapted.get_text() == raw.get_text()
        assert raw.rotation == rotation


def _upright_receipts(rotation, unit, *, bitmap=False, crossing=False):
    """Same visually upright receipt strips stored under each PDF rotation."""
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    document.xref_set_key(page.xref, 'MediaBox', '[-40 -60 560 740]')
    document.xref_set_key(page.xref, 'CropBox', '[10 20 510 680]')
    page = document.reload_page(page)
    width, height = (660, 500) if rotation in (90, 270) else (500, 660)
    with pymupdf.open() as content:
        upright = content.new_page(width=width, height=height)
        banner = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 1000, 55), False)
        banner.clear_with(255)
        rule = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 977, 2), False)
        rule.clear_with(0)
        for slot in range(3):
            top = slot * height / 3
            if bitmap:
                upright.insert_image((20, top + 5, width - 20, top + 25), pixmap=banner, keep_proportion=False)
                title = '支付业务回单'
            else:
                title = '上海银行业务回单'
            upright.insert_text((width * .4, top + 22), title, fontname='china-s', fontsize=11)
            for offset, label in [(52, '付款人名称：合成公司'), (78, '交易日期：2026-09-14'), (100, '金额：100.00')]:
                upright.insert_text((35, top + offset), label, fontname='china-s', fontsize=9)
            for offset in (63, 117):
                if bitmap:
                    upright.insert_image((30, top + offset, width - 30, top + offset + 1), pixmap=rule, keep_proportion=False)
                else:
                    upright.draw_line((30, top + offset), (width - 30, top + offset))
        if crossing:
            # A filled seal spans all plausible gaps between copies.
            upright.draw_circle((width - 40, height / 3), 65, color=(1, 0, 0), fill=(1, 0, 0))
        page.show_pdf_page(page.rect, content, 0, rotate=rotation)
    document.xref_set_key(page.xref, 'UserUnit', str(unit))
    page.set_rotation(rotation)
    document.reload_page(page)
    return document


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
@pytest.mark.parametrize('unit', [1, 2])
@pytest.mark.parametrize('bitmap', [False, True])
def test_template_and_image_issuer_use_upright_visible_geometry(monkeypatch, rotation, unit, bitmap):
    from engine.crop_templates import describe_crop_page
    from engine import receipt_image_issuer

    # Stub OCR recognition only; real PDF image placement, visible rendering,
    # bitmap pixel checks and image-to-page bank boxes all run in production.
    monkeypatch.setattr(receipt_image_issuer, '_recognize_masthead',
                        lambda *_: (('中国民生银行', (10, 8, 150, 20)),))
    with _upright_receipts(rotation, unit, bitmap=bitmap) as source:
        result = describe_crop_page(source[0])
        assert result['status'] == 'ready'
        assert len(result['receipts']) == 3
        bank = '中国民生银行' if bitmap else '上海银行'
        assert {row['issuer_bank_name'] for row in result['receipts']} == {bank}
        assert all(row['template_fingerprint'] for row in result['receipts'])
        assert all(row['bounds']['y0'] <= row['anchor_y'] < row['bounds']['y1'] for row in result['receipts'])
        assert source[0].rotation == rotation


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_rotated_crossing_visual_object_still_blocks_template(rotation):
    from engine.crop_templates import describe_crop_page

    with _upright_receipts(rotation, 2, crossing=True) as source:
        assert describe_crop_page(source[0]) == {'status': 'unavailable', 'reason': 'ambiguous_layout'}


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_adapter_maps_dict_span_bboxlog_and_visible_clip(rotation):
    from engine.pdf_parser import visible_page

    with _source(rotation, 2) as source:
        page = source[0]
        adapted = visible_page(page)
        geometry = read_page_geometry(page)
        native = page.get_text('dict')['blocks'][0]['lines'][0]['spans'][0]
        span = adapted.get_text('dict')['blocks'][0]['lines'][0]['spans'][0]
        assert span['bbox'] == pytest.approx(tuple(unrotated_rect_to_visible(native['bbox'], geometry).values()))
        for raw, mapped in zip(page.get_bboxlog(), adapted.get_bboxlog(), strict=True):
            assert mapped[0] == raw[0]
            assert mapped[1] == pytest.approx(tuple(unrotated_rect_to_visible(raw[1], geometry).values()))
        clip = tuple(unrotated_rect_to_visible((30, 40, 380, 220), geometry).values())
        assert 'TARGET' in adapted.get_text(clip=pymupdf.Rect(clip))
        assert 'NEIGHBOR' not in adapted.get_text(clip=pymupdf.Rect(clip))


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_rotation_does_not_change_repeated_diagonal_watermark_classification(rotation):
    with pymupdf.open() as source:
        page = source.new_page(width=600, height=800)
        for y in (150, 300, 450, 600):
            point = pymupdf.Point(80, y)
            page.insert_text(point, '上海银行', fontname='china-s', fontsize=18,
                             morph=(point, pymupdf.Matrix(30)))
        page.set_rotation(rotation)
        assert len(parse_loaded_page(page, 1).blocks) == 4
        assert all(block.is_watermark for block in parse_loaded_page(page, 1).blocks)


@pytest.mark.parametrize('merged', [False, True])
def test_production_export_accepts_only_whole_tiny_page_extent(tmp_path, merged):
    source_path, target_path = tmp_path / 'tiny.pdf', tmp_path / 'output.pdf'
    with pymupdf.open() as source:
        page = source.new_page(width=5, height=30)
        page.draw_rect((1, 2, 4, 20), fill=(1, 0, 0))
        source.save(source_path)
    def run(rect):
        segments = [PdfSegment(1, Rect(*rect))]
        return (export_merged_segments(target_path, [(source_path, segments)]) if merged else
                export_segments(source_path, target_path, segments))
    with pytest.raises(ValueError):
        run((1e-15, 0, 5, 20))
    run((0, 0, 5, 20))
    with pymupdf.open(target_path) as result:
        assert (result[0].rect.width, result[0].rect.height) == (5, 20)
