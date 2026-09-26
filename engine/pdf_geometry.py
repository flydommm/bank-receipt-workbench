"""PDF coordinates at the boundary of the receipt-layout v1 contract.

PyMuPDF extraction coordinates are relative to the effective visible box, in
physical points, and unrotated. They differ from raw PDF coordinates and from
the rotated visible coordinates used by layout instances. In particular the
native rotation matrix cannot be reused when UserUnit is not one.
"""
from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from typing import Any

import pymupdf

from .receipt_layout_models import MIN_CROP_SIZE, near, parse_page_geometry


_PDF_NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)\Z")
_PDF_REFERENCE = re.compile(r"(\d+)\s+\d+\s+R\Z")
_MAX_PAGE_PARENTS = 64
_RECT_KEYS = ('x0', 'y0', 'x1', 'y1')


def _finite_number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('PDF geometry requires finite numeric coordinates')
    try:
        number = float(value)
    except OverflowError:
        raise ValueError('PDF geometry coordinate exceeds numeric range') from None
    if not math.isfinite(number):
        raise ValueError('PDF geometry requires finite numeric coordinates')
    return number


def _resolve_pdf_value(document: Any, kind: str, value: str) -> str | None:
    seen = set()
    while kind == 'xref':
        match = _PDF_REFERENCE.fullmatch(value.strip())
        if match is None:
            raise ValueError('Invalid PDF geometry reference')
        xref = int(match[1])
        if xref in seen or len(seen) >= _MAX_PAGE_PARENTS:
            raise ValueError('Cyclic PDF geometry reference')
        seen.add(xref)
        value = document.xref_object(xref, compressed=True).strip()
        kind = 'xref' if _PDF_REFERENCE.fullmatch(value) else 'resolved'
    return None if kind == 'null' or value == 'null' else value


def _page_value(page: Any, key: str, *, inherited: bool = False) -> str | None:
    document = page.parent
    xref = page.xref
    seen = set()
    while True:
        if xref in seen or len(seen) >= _MAX_PAGE_PARENTS:
            raise ValueError('Cyclic PDF page inheritance')
        seen.add(xref)
        kind, value = document.xref_get_key(xref, key)
        resolved = _resolve_pdf_value(document, kind, value)
        if resolved is not None or not inherited:
            return resolved
        parent_kind, parent = document.xref_get_key(xref, 'Parent')
        if parent_kind == 'null':
            return None
        match = _PDF_REFERENCE.fullmatch(parent.strip()) if parent_kind == 'xref' else None
        if match is None:
            raise ValueError('Invalid PDF page parent')
        xref = int(match[1])


def _pdf_number(value: str) -> float:
    if _PDF_NUMBER.fullmatch(value.strip()) is None:
        raise ValueError('Invalid PDF geometry number')
    return _finite_number(float(value))


def _pdf_box(value: str | None) -> tuple[float, float, float, float]:
    if value is None or not value.startswith('[') or not value.endswith(']'):
        raise ValueError('Missing or invalid PDF page box')
    tokens = value[1:-1].split()
    if len(tokens) != 4:
        raise ValueError('PDF page box must contain four numbers')
    values = tuple(_pdf_number(token) for token in tokens)
    if values[0] >= values[2] or values[1] >= values[3]:
        raise ValueError('PDF page box must have positive dimensions')
    return values


def read_page_geometry(page: Any) -> dict[str, Any]:
    """Read the effective raw PDF box and physical rotated page dimensions.

    MediaBox, CropBox and Rotate follow PDF page-tree inheritance. UserUnit is
    page-local and defaults to one. Invalid attributes are explicitly rejected
    rather than accepting MuPDF's repair/default behavior for malformed PDFs.
    """
    if page.parent is None or not page.parent.is_pdf:
        raise ValueError('Page geometry requires an attached PDF page')
    media = _pdf_box(_page_value(page, 'MediaBox', inherited=True))
    crop_value = _page_value(page, 'CropBox', inherited=True)
    crop = _pdf_box(crop_value) if crop_value is not None else media
    box = (max(media[0], crop[0]), max(media[1], crop[1]),
           min(media[2], crop[2]), min(media[3], crop[3]))
    if box[0] >= box[2] or box[1] >= box[3]:
        raise ValueError('PDF page boxes have no positive visible intersection')
    rotation_value = _page_value(page, 'Rotate', inherited=True)
    raw_rotation = _pdf_number(rotation_value) if rotation_value is not None else 0
    if raw_rotation % 90:
        raise ValueError('PDF rotation must be a multiple of 90 degrees')
    rotation = int(raw_rotation) % 360
    unit_value = _page_value(page, 'UserUnit')
    unit = _pdf_number(unit_value) if unit_value is not None else 1.0
    if unit <= 0:
        raise ValueError('PDF UserUnit must be positive')
    width, height = (box[2] - box[0]) * unit, (box[3] - box[1]) * unit
    if rotation in (90, 270):
        width, height = height, width
    return parse_page_geometry({'pdf_box': dict(zip(_RECT_KEYS, box)),
                                'rotation': rotation, 'user_unit': unit,
                                'width_pt': width, 'height_pt': height})


def _point(point: Sequence[float]) -> tuple[float, float]:
    if isinstance(point, (str, bytes, Mapping)) or not hasattr(point, '__len__') or len(point) != 2:
        raise ValueError('A point requires two coordinates')
    return _finite_number(point[0]), _finite_number(point[1])


def _rect(rect: Mapping[str, float] | Sequence[float]) -> tuple[float, float, float, float]:
    if isinstance(rect, Mapping):
        if set(rect) != set(_RECT_KEYS):
            raise ValueError('A rectangle requires exactly x0, y0, x1 and y1')
        values = tuple(_finite_number(rect[key]) for key in _RECT_KEYS)
    else:
        if isinstance(rect, (str, bytes)) or not hasattr(rect, '__len__') or len(rect) != 4:
            raise ValueError('A rectangle requires four coordinates')
        values = tuple(_finite_number(value) for value in rect)
    if values[0] >= values[2] or values[1] >= values[3]:
        raise ValueError('A rectangle requires positive dimensions')
    return values


def _unrotated_size(geometry: Mapping[str, Any]) -> tuple[float, float]:
    width, height = geometry['width_pt'], geometry['height_pt']
    return (height, width) if geometry['rotation'] in (90, 270) else (width, height)


def _rotate(point: tuple[float, float], geometry: Mapping[str, Any], *, inverse: bool = False) -> tuple[float, float]:
    x, y = point
    width, height = _unrotated_size(geometry)
    rotation = geometry['rotation']
    if rotation == 90:
        result = (y, height - x) if inverse else (height - y, x)
    elif rotation == 180:
        result = (width - x, height - y)
    elif rotation == 270:
        result = (width - y, x) if inverse else (y, width - x)
    else:
        result = (x, y)
    return _point(result)


def unrotated_point_to_visible(point: Sequence[float], geometry: Mapping[str, Any]) -> tuple[float, float]:
    """Convert an extracted unrotated physical point; do not clip page bleed."""
    return _rotate(_point(point), parse_page_geometry(geometry))


def _transform_rect(rect: Mapping[str, float] | Sequence[float], geometry: Mapping[str, Any], *, inverse: bool) -> dict[str, float]:
    checked = parse_page_geometry(geometry)
    x0, y0, x1, y1 = _rect(rect)
    corners = [_rotate(point, checked, inverse=inverse)
               for point in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
    return {'x0': min(point[0] for point in corners), 'y0': min(point[1] for point in corners),
            'x1': max(point[0] for point in corners), 'y1': max(point[1] for point in corners)}


def unrotated_rect_to_visible(rect: Mapping[str, float] | Sequence[float], geometry: Mapping[str, Any]) -> dict[str, float]:
    return _transform_rect(rect, geometry, inverse=False)


def visible_rect_to_unrotated(rect: Mapping[str, float] | Sequence[float], geometry: Mapping[str, Any]) -> dict[str, float]:
    return _transform_rect(rect, geometry, inverse=True)


def raw_pdf_point_to_visible(point: Sequence[float], geometry: Mapping[str, Any]) -> tuple[float, float]:
    checked = parse_page_geometry(geometry)
    x, y = _point(point)
    box, unit = checked['pdf_box'], checked['user_unit']
    return _rotate(((x - box['x0']) * unit, (box['y1'] - y) * unit), checked)


def visible_point_to_raw_pdf(point: Sequence[float], geometry: Mapping[str, Any]) -> tuple[float, float]:
    checked = parse_page_geometry(geometry)
    x, y = _rotate(_point(point), checked, inverse=True)
    box, unit = checked['pdf_box'], checked['user_unit']
    return _point((box['x0'] + x / unit, box['y1'] - y / unit))


def _less(left: float, right: float) -> bool:
    return left < right and not near(left, right)


def append_visible_pdf_crop(target_doc: Any, source_doc: Any, page_index: int,
                            visible_rect: Mapping[str, float] | Sequence[float]) -> Any:
    """Append a physical-size vector crop from an EXCLUSIVE export document.

    The caller must own an independent source document used solely for this
    export; never pass the shared analysis/preview document or run concurrent
    operations against it. Its page rotation is temporarily cleared because
    show_pdf_page uses unrotated physical source clips. Rotation is restored on
    success and failure. A failed append removes only its new target page.
    """
    if source_doc is target_doc or not source_doc.is_pdf or not target_doc.is_pdf:
        raise ValueError('Cropping requires separate PDF source and target documents')
    if isinstance(page_index, bool) or not isinstance(page_index, int) or not 0 <= page_index < len(source_doc):
        raise ValueError('Invalid PDF source page index')
    page = source_doc[page_index]
    geometry = read_page_geometry(page)
    x0, y0, x1, y1 = _rect(visible_rect)
    width, height = geometry['width_pt'], geometry['height_pt']
    # For a page dimension below the minimum, "whole" is exact identity,
    # not a near comparison: epsilon must not swallow an actual smaller crop.
    if ((width < MIN_CROP_SIZE and (x0 != 0 or x1 != width))
            or (height < MIN_CROP_SIZE and (y0 != 0 or y1 != height))):
        raise ValueError('Small PDF page dimensions must retain their exact full extent')
    if (_less(x0, 0) or _less(y0, 0) or _less(width, x1) or _less(height, y1)
            or _less(x1 - x0, min(MIN_CROP_SIZE, width))
            or _less(y1 - y0, min(MIN_CROP_SIZE, height))):
        raise ValueError('Visible PDF crop is out of bounds or below minimum dimensions')
    clip = visible_rect_to_unrotated((x0, y0, x1, y1), geometry)
    original_rotation = page.rotation
    target_index = len(target_doc)
    appended = False
    try:
        page.set_rotation(0)
        target = target_doc.new_page(width=x1-x0, height=y1-y0)
        appended = True
        target.show_pdf_page(target.rect, source_doc, page_index,
                             clip=pymupdf.Rect(tuple(clip.values())),
                             rotate=-geometry['rotation'], keep_proportion=False)
        return target
    except Exception:
        if appended:
            target_doc.delete_page(target_index)
        raise
    finally:
        page.set_rotation(original_rotation)
