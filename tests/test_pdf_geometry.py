from __future__ import annotations

import math

import pymupdf
import pytest

from engine.pdf_geometry import (
    append_visible_pdf_crop,
    raw_pdf_point_to_visible,
    read_page_geometry,
    unrotated_point_to_visible,
    unrotated_rect_to_visible,
    visible_point_to_raw_pdf,
    visible_rect_to_unrotated,
)


def _document(rotation=0, unit=1, *, media=(-40, -60, 560, 740), crop=(10, 20, 510, 680)):
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    document.xref_set_key(page.xref, 'MediaBox', '[' + ' '.join(map(str, media)) + ']')
    document.xref_set_key(page.xref, 'CropBox', '[' + ' '.join(map(str, crop)) + ']')
    document.xref_set_key(page.xref, 'UserUnit', str(unit))
    page.set_rotation(rotation)
    document.reload_page(page)
    return document


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
@pytest.mark.parametrize('unit', [1, 2])
def test_geometry_uses_effective_pdf_box_physical_units_and_rotation(rotation, unit):
    with _document(rotation, unit) as document:
        geometry = read_page_geometry(document[0])
        assert geometry == {
            'pdf_box': {'x0': 10.0, 'y0': 20.0, 'x1': 510.0, 'y1': 680.0},
            'rotation': rotation, 'user_unit': unit,
            'width_pt': (660 if rotation in (90, 270) else 500) * unit,
            'height_pt': (500 if rotation in (90, 270) else 660) * unit,
        }
        expected = {
            0: (100 * unit, 200 * unit),
            90: (460 * unit, 100 * unit),
            180: (400 * unit, 460 * unit),
            270: (200 * unit, 400 * unit),
        }[rotation]
        assert unrotated_point_to_visible((100 * unit, 200 * unit), geometry) == expected
        assert raw_pdf_point_to_visible((110, 480), geometry) == expected
        assert visible_point_to_raw_pdf(expected, geometry) == pytest.approx((110, 480))
        rect = {'x0': 40 * unit, 'y0': 50 * unit, 'x1': 130 * unit, 'y1': 170 * unit}
        assert visible_rect_to_unrotated(unrotated_rect_to_visible(rect, geometry), geometry) == pytest.approx(rect)


def test_crop_box_intersects_media_box_without_losing_nonzero_origin():
    with _document(media=(50, 80, 650, 880), crop=(20, 40, 700, 900)) as document:
        geometry = read_page_geometry(document[0])
        assert geometry['pdf_box'] == {'x0': 50, 'y0': 80, 'x1': 650, 'y1': 880}
        assert raw_pdf_point_to_visible((50, 880), geometry) == (0, 0)
        assert raw_pdf_point_to_visible((650, 80), geometry) == (600, 800)


def test_inherited_page_boxes_and_rotation_with_default_unit():
    with _document() as document:
        page = document[0]
        parent = int(document.xref_get_key(page.xref, 'Parent')[1].split()[0])
        for key, value in [('MediaBox', '[-40 -60 560 740]'), ('CropBox', '[10 20 510 680]'), ('Rotate', '270')]:
            document.xref_set_key(parent, key, value)
            document.xref_set_key(page.xref, key, 'null')
        document.xref_set_key(page.xref, 'UserUnit', 'null')
        document.xref_set_key(parent, 'UserUnit', '2')  # UserUnit is not an inheritable PDF page attribute.
        page = document.reload_page(page)
        geometry = read_page_geometry(page)
        assert geometry['rotation'] == 270 and geometry['user_unit'] == 1
        assert (geometry['width_pt'], geometry['height_pt']) == (660, 500)
        assert (page.rect.width, page.rect.height) == (660, 500)


def test_indirect_boxes_and_unit_are_resolved_without_native_repair():
    with _document() as document:
        page = document[0]
        for key, value in [('MediaBox', '[-40 -60 560 740]'), ('CropBox', '[10 20 510 680]'), ('UserUnit', '2')]:
            xref = document.get_new_xref()
            document.update_object(xref, value)
            document.xref_set_key(page.xref, key, f'{xref} 0 R')
        document.xref_set_key(page.xref, 'Rotate', '-90')
        geometry = read_page_geometry(document.reload_page(page))
        assert geometry['rotation'] == 270 and geometry['user_unit'] == 2
        assert (geometry['width_pt'], geometry['height_pt']) == (1320, 1000)


def test_cyclic_page_inheritance_is_rejected_without_unbounded_walk():
    with _document() as document:
        page = document[0]
        document.xref_set_key(page.xref, 'MediaBox', 'null')
        document.xref_set_key(page.xref, 'Parent', f'{page.xref} 0 R')
        with pytest.raises(ValueError, match='Cyclic'):
            read_page_geometry(page)


@pytest.mark.parametrize('key,value', [('UserUnit', '0'), ('UserUnit', '-2'), ('UserUnit', '/invalid'),
                                     ('MediaBox', '[0 0 0 20]'), ('CropBox', '[700 900 800 1000]'),
                                     ('Rotate', '45')])
def test_invalid_pdf_geometry_is_rejected_explicitly(key, value):
    with _document() as document:
        page = document[0]
        document.xref_set_key(page.xref, key, value)
        with pytest.raises(ValueError):
            read_page_geometry(page)


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
@pytest.mark.parametrize('unit', [1, 2])
@pytest.mark.parametrize('media,crop', [
    ((-40, -60, 560, 740), (10, 20, 510, 680)),
    ((-600, -800, 0, 0), (-550, -740, -50, -80)),
    ((50, 80, 650, 880), (20, 40, 700, 900)),
])
def test_visible_crop_preserves_pixels_and_text_for_rotated_scaled_nonzero_pdf(rotation, unit, media, crop):
    with _document(0, unit, media=media, crop=crop) as source, pymupdf.open() as target:
        page = source[0]
        # PyMuPDF's drawing/text APIs use unrotated physical page coordinates.
        page.draw_rect(pymupdf.Rect(40 * unit, 50 * unit, 240 * unit, 180 * unit),
                       color=(0, .5, .2), fill=(.8, .9, 1), width=unit)
        page.insert_text((60 * unit, 100 * unit), 'TARGET', fontsize=18 * unit)
        page.insert_text((320 * unit, 400 * unit), 'NEIGHBOR', fontsize=18 * unit)
        page.set_rotation(rotation)
        geometry = read_page_geometry(page)
        region = unrotated_rect_to_visible((30 * unit, 40 * unit, 250 * unit, 190 * unit), geometry)
        expected = page.get_pixmap(clip=pymupdf.Rect(tuple(region.values())), alpha=False)
        output = append_visible_pdf_crop(target, source, 0, region)
        actual = output.get_pixmap(alpha=False)
        assert (actual.width, actual.height) == (expected.width, expected.height)
        assert actual.samples == expected.samples
        text = output.get_text()
        assert 'TARGET' in text and 'NEIGHBOR' not in text
        assert source[0].rotation == rotation
        assert output.rect.width == pytest.approx(region['x1'] - region['x0'])
        assert output.rect.height == pytest.approx(region['y1'] - region['y0'])


def test_export_failure_restores_source_rotation_and_does_not_leave_blank_target(monkeypatch):
    with _document(90, 2) as source, pymupdf.open() as target:
        target.new_page(width=40, height=40)
        def fail(*_args, **_kwargs):
            raise RuntimeError('synthetic export failure')
        monkeypatch.setattr(pymupdf.Page, 'show_pdf_page', fail)
        with pytest.raises(RuntimeError, match='synthetic export failure'):
            append_visible_pdf_crop(target, source, 0, {'x0': 20, 'y0': 30, 'x1': 120, 'y1': 130})
        assert source[0].rotation == 90 and len(target) == 1


@pytest.mark.parametrize('rect', [(-.01, 0, 100, 100), (0, 0, 1000, 100), (0, 0, 5, 100),
                                (0, 0, math.nan, 100), (0, 0, True, 100)])
def test_export_does_not_clamp_invalid_or_undersized_crop(rect):
    with _document() as source, pymupdf.open() as target:
        with pytest.raises(ValueError):
            append_visible_pdf_crop(target, source, 0, rect)
        assert len(target) == 0 and source[0].rotation == 0


def test_tiny_page_dimension_can_only_be_kept_in_full():
    with pymupdf.open() as source, pymupdf.open() as target:
        page = source.new_page(width=5, height=10)
        page.draw_rect(pymupdf.Rect(1, 1, 4, 9), fill=(1, 0, 0))
        with pytest.raises(ValueError):
            append_visible_pdf_crop(target, source, 0, (0, 0, 4, 10))
        output = append_visible_pdf_crop(target, source, 0, (0, 0, 5, 10))
        assert output.rect.width == 5 and output.rect.height == 10


@pytest.mark.parametrize('axis', ['x', 'y'])
@pytest.mark.parametrize('size,lower,upper', [(5.0, 1e-15, 5.0), (5.0, 0, 5.0 - 1e-15),
                                          (1e-15, 0, 5e-16)])
def test_small_page_extent_must_be_exact_even_inside_numeric_tolerance(monkeypatch, axis, size, lower, upper):
    from engine import pdf_geometry

    width, height = (size, 40.0) if axis == 'x' else (40.0, size)
    geometry = {'pdf_box': {'x0': 0, 'y0': 0, 'x1': width, 'y1': height},
                'rotation': 0, 'user_unit': 1, 'width_pt': width, 'height_pt': height}
    region = {'x0': 0.0, 'y0': 0.0, 'x1': width, 'y1': height}
    region[axis + '0'], region[axis + '1'] = lower, upper
    with _document() as source, pymupdf.open() as target:
        monkeypatch.setattr(pdf_geometry, 'read_page_geometry', lambda _page: geometry)
        monkeypatch.setattr(target, 'new_page', lambda **_: pytest.fail('invalid extent must be rejected before new_page'))
        with pytest.raises(ValueError):
            append_visible_pdf_crop(target, source, 0, region)
        assert len(target) == 0 and source[0].rotation == 0


def test_normal_page_crop_keeps_existing_machine_epsilon_tolerance():
    with _document() as source, pymupdf.open() as target:
        source[0].draw_rect(pymupdf.Rect(1, 1, 10, 10), fill=(1, 0, 0))
        output = append_visible_pdf_crop(target, source, 0, (-1e-15, 0, 20, 20))
        assert output.rect.width == 20 and output.rect.height == 20


@pytest.mark.parametrize('point', [None, (True, 2), (1, math.inf), (10**400, 2)])
def test_coordinate_conversions_reject_nonfinite_or_invalid_points(point):
    with _document() as document:
        with pytest.raises(ValueError):
            unrotated_point_to_visible(point, read_page_geometry(document[0]))
