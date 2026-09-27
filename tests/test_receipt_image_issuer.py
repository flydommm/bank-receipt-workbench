from types import SimpleNamespace

import pytest
import pymupdf

from engine import receipt_image_issuer as module


@pytest.fixture(autouse=True)
def isolated_cache(monkeypatch):
    values = {}
    class Cache:
        def __init__(self, digest): self.digest = digest
        def get(self, *_): return values.get(self.digest)
        def put(self, _page, _width, _height, records): values[self.digest] = records
    module._recognize_logo.cache_clear()
    module._recognize_masthead.cache_clear()
    monkeypatch.setattr(module, 'OcrTextCache', Cache)
    yield values
    module._recognize_logo.cache_clear()
    module._recognize_masthead.cache_clear()


def page(box=(20, 18, 180, 58), width=320, height=82):
    return SimpleNamespace(rect=SimpleNamespace(width=595, height=842),
        get_images=lambda **_: [(1, 0, width, height)], get_image_rects=lambda _: [box],
        parent=SimpleNamespace(extract_image=lambda _: {'image': b'synthetic-logo'}))


def records(text='演示银行', confidence=.999):
    return [{'text': text, 'confidence': confidence, 'box': [0, 0, 150, 40]}]


def test_bounded_masthead_ocr_and_exact_image_cache(monkeypatch, isolated_cache):
    calls = []
    monkeypatch.setattr(module, 'recognize_image', lambda _: calls.append(1) or records())
    lines = module.image_masthead_lines(page(), [(0, 57.5)], [])
    assert lines == [('演示银行', (20, 18, 180, 58))]
    module._recognize_logo.cache_clear()  # Simulate another worker process.
    module._recognize_masthead.cache_clear()
    assert module.image_masthead_lines(page(), [(0, 57.5)], []) == lines
    assert calls == [1]
    assert len(isolated_cache) == 1


@pytest.mark.parametrize('candidate,labels', [
    (page((20, 118, 180, 158)), []),
    (page(width=1200, height=600), []),
    (page(), [('付款人开户行', (10, 25, 18, 45))]),
])
def test_body_account_fields_and_large_images_never_start_ocr(monkeypatch, candidate, labels):
    monkeypatch.setattr(module, 'recognize_image', lambda _: pytest.fail('ineligible image reached OCR'))
    assert module.image_masthead_lines(candidate, [(0, 57.5)], labels) == []


@pytest.mark.parametrize('value', [records(confidence=.97), records('中国银行付款人'), []])
def test_low_confidence_and_non_masthead_text_cannot_identify_bank(monkeypatch, value):
    monkeypatch.setattr(module, 'recognize_image', lambda _: value)
    assert module.image_masthead_lines(page(), [(0, 57.5)], []) == []

    module._recognize_logo.cache_clear()
    module._recognize_masthead.cache_clear()
    monkeypatch.setattr(module, 'recognize_image', lambda _: pytest.fail('cache should retain contextual rejection'))
    assert module.image_masthead_lines(page(), [(0, 57.5)], []) == []


def test_conflicting_names_remain_visible_to_template_conflict_check(monkeypatch):
    monkeypatch.setattr(module, 'recognize_image', lambda _: records() + records('样例银行'))
    lines = module.image_masthead_lines(page(), [(0, 57.5)], [])
    assert {text for text, _ in lines} == {'演示银行', '样例银行'}


def test_missing_ocr_keeps_unknown_without_a_failed_disk_cache(monkeypatch, isolated_cache):
    def fail(_): raise module.OcrUnavailableError('not installed')
    monkeypatch.setattr(module, 'recognize_image', fail)
    assert module.image_masthead_lines(page(), [(0, 57.5)], []) == []
    assert isolated_cache == {}


@pytest.mark.parametrize('label_box', [[0, 0, 140, 15], [0, 20, 140, 40]])
def test_account_label_inside_image_cannot_become_an_issuer_even_after_cache_reload(monkeypatch, label_box):
    value = [{'text': '付款人开户行', 'confidence': .999, 'box': label_box},
             {'text': '样例银行', 'confidence': .999, 'box': [150, 20, 300, 40]}]
    monkeypatch.setattr(module, 'recognize_image', lambda _: value)
    assert module.image_masthead_lines(page(), [(0, 57.5)], []) == []
    module._recognize_logo.cache_clear()
    module._recognize_masthead.cache_clear()
    monkeypatch.setattr(module, 'recognize_image', lambda _: pytest.fail('cache should retain contextual rejection'))
    assert module.image_masthead_lines(page(), [(0, 57.5)], []) == []


def _banner_page(document, *, top=-3, body_y=48, rotate=0):
    target = document.new_page(width=595, height=842)
    pixels = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 1000, 55), False)
    pixels.clear_with(255)
    # Red pixels lie outside the visible page in the first placement.
    pixels.set_rect(pymupdf.IRect(0, 0, 1000, 5), (255, 0, 0))
    image = pixels.tobytes('png')
    for offset in (0, 293, 578):
        target.insert_image(pymupdf.Rect(28, top + offset, 564, top + 30 + offset),
                            stream=image, keep_proportion=False, rotate=rotate)
        target.insert_text((200, 15 + offset), '支付业务回单（付款）', fontname='china-s', fontsize=11)
        target.insert_text((30, body_y + offset), '付款人名称：合成公司', fontname='china-s', fontsize=11)
    lines = [(line['spans'][0]['text'], tuple(line['bbox']))
             for block in target.get_text('dict')['blocks'] if 'lines' in block for line in block['lines']]
    regions = [(max(0, box[1] - 64), box[3]) for text, box in lines if '支付业务' in text]
    return target, lines, regions


def test_wide_masthead_uses_visible_pixels_exact_bank_box_and_unique_placements(monkeypatch):
    calls = []
    def ocr(path):
        image = pymupdf.Pixmap(str(path))
        calls.append((image.width, image.height))
        if image.height < 55:  # The partly clipped first banner contains no hidden red strip.
            assert not any(image.pixel(x, 0)[:3] == (255, 0, 0) for x in range(image.width))
        return [{'text': '中国民生银行', 'confidence': .999, 'box': [10, 8, 250, 25]}]
    monkeypatch.setattr(module, 'recognize_image', ocr)
    with pymupdf.open() as document:
        target, lines, regions = _banner_page(document)
        images = target.get_images(full=True)
        original = target.get_images
        monkeypatch.setattr(target, 'get_images', lambda **_: images * 7)
        found = module.image_masthead_lines(target, regions, lines)
        assert len(found) == 3
        assert {text for text, _box in found} == {'中国民生银行'}
        assert all(box[2] - box[0] < 150 for _text, box in found)  # Not the full 536-point banner.
        assert found[0][1][1] >= 0
        assert 1 <= len(calls) <= 3
        monkeypatch.setattr(target, 'get_images', original)


@pytest.mark.parametrize('kind', ['body', 'rotated', 'account-label', 'low-confidence', 'conflict', 'hidden-box'])
def test_wide_masthead_cannot_supply_unproven_bank(monkeypatch, kind):
    def ocr(_):
        result = [{'text': '中国民生银行', 'confidence': .97 if kind == 'low-confidence' else .999,
                   'box': [10, -2 if kind == 'hidden-box' else 8, 250, 25]}]
        if kind == 'account-label':
            result.append({'text': '付款人开户行', 'confidence': .999, 'box': [500, 8, 700, 25]})
        if kind == 'conflict':
            result.append({'text': '上海银行', 'confidence': .999, 'box': [500, 8, 700, 25]})
        return result
    monkeypatch.setattr(module, 'recognize_image', ocr)
    with pymupdf.open() as document:
        target, lines, regions = _banner_page(document, body_y=32 if kind == 'body' else 48,
                                            rotate=180 if kind == 'rotated' else 0)
        assert module.image_masthead_lines(target, regions, lines) == []


def test_repeated_image_placement_budget_precedes_ocr(monkeypatch):
    target = page()
    target.get_image_rects = lambda _: [(20, 18, 180, 58)] * (module.MAX_IMAGES + 1)
    monkeypatch.setattr(module, 'recognize_image', lambda _: pytest.fail('placement budget must precede OCR'))
    assert module.image_masthead_lines(target, [(0, 57.5)], []) == []


def test_visible_banner_and_bitmap_rules_prove_same_bank_template_across_pages(monkeypatch):
    from engine.crop_templates import describe_crop_page

    monkeypatch.setattr(module, 'recognize_image', lambda _: [
        {'text': '中国民生银行', 'confidence': .999, 'box': [10, 8, 250, 25]}])
    with pymupdf.open() as document:
        for _ in range(2):
            target, _lines, _regions = _banner_page(document)
            pixels = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 977, 2), False)
            pixels.clear_with(0)
            for offset in (0, 293, 578):
                for y in (114, 227):
                    target.insert_image(pymupdf.Rect(36, y + offset, 556, y + offset + 1),
                                        pixmap=pixels, keep_proportion=False)
                target.insert_text((40, 90 + offset), '交易日期：2026-09-14', fontname='china-s')
                target.insert_text((40, 180 + offset), '金额（小写）：123.00', fontname='china-s')
        first, second = [describe_crop_page(target) for target in document]
        assert first['status'] == second['status'] == 'ready'
        assert len(first['receipts']) == 3
        assert {row['issuer_bank_name'] for row in first['receipts']} == {'中国民生银行'}
        assert [row['template_fingerprint'] for row in first['receipts']] == [
            row['template_fingerprint'] for row in second['receipts']]
        assert all(row['template_fingerprint'] for row in first['receipts'])
