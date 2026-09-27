"""Text extraction helpers for text-based PDFs."""

from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import re
from typing import Any, Iterator

from .pdf_geometry import read_page_geometry, visible_rect_to_unrotated

try:  # PyMuPDF renamed its import package in recent releases.
    import pymupdf as fitz
except ImportError:  # pragma: no cover - compatibility for older installations
    import fitz  # type: ignore[no-redef]


class _VisiblePage:
    """Read-only extraction adapter; raster rendering is already visible.

    Only the extraction methods below change coordinates. The underlying PDF
    page/document remain untouched, including rotation. Native coordinates have
    already applied CropBox and UserUnit, so this layer applies rotation only.
    Never pass this adapter to a native PDF mutation / export API.
    """

    def __init__(self, page: Any):
        self._page = page
        self.geometry = read_page_geometry(page)
        width, height = self.geometry['width_pt'], self.geometry['height_pt']
        self.rect = fitz.Rect(0, 0, width, height)
        self._matrix = {
            0: (1, 0, 0, 1, 0, 0),
            90: (0, 1, -1, 0, width, 0),
            180: (-1, 0, 0, -1, width, height),
            270: (0, -1, 1, 0, 0, height),
        }[self.geometry['rotation']]

    def __getattr__(self, name: str) -> Any:
        return getattr(self._page, name)

    def _point(self, point: Any) -> tuple[float, float]:
        x, y = point
        a, b, c, d, e, f = self._matrix
        return a * x + c * y + e, b * x + d * y + f

    def _box(self, box: Any) -> tuple[float, float, float, float]:
        x0, y0, x1, y1 = box
        points = [self._point((x, y)) for x in (x0, x1) for y in (y0, y1)]
        return (min(p[0] for p in points), min(p[1] for p in points),
                max(p[0] for p in points), max(p[1] for p in points))

    def _image_matrix(self, matrix: Any) -> fitz.Matrix:
        a, b, c, d, e, f = matrix
        ra, rb, rc, rd, re, rf = self._matrix
        return fitz.Matrix(a * ra + b * rc, a * rb + b * rd,
                           c * ra + d * rc, c * rb + d * rd,
                           e * ra + f * rc + re, e * rb + f * rd + rf)

    def get_text(self, option: str = 'text', **kwargs: Any) -> Any:
        if kwargs.get('clip') is not None:
            kwargs['clip'] = fitz.Rect(tuple(visible_rect_to_unrotated(kwargs['clip'], self.geometry).values()))
        result = self._page.get_text(option, **kwargs)
        if self.geometry['rotation'] == 0:
            return result
        if option in {'blocks', 'words'}:
            result = [(*self._box(block[:4]), *block[4:]) for block in result]
            if kwargs.get('sort'):
                result.sort(key=lambda block: (block[1], block[0]))
        elif option in {'dict', 'rawdict'}:
            # Native get_text returns a fresh object. Keep all text/span fields
            # intact, including origins and raw-character boxes when requested.
            result['width'], result['height'] = self.rect.width, self.rect.height
            for block in result.get('blocks', []):
                block['bbox'] = self._box(block['bbox'])
                if 'transform' in block:
                    block['transform'] = tuple(self._image_matrix(block['transform']))
                for line in block.get('lines', []):
                    line['bbox'] = self._box(line['bbox'])
                    dx, dy = line.get('dir', (1, 0))
                    a, b, c, d, _e, _f = self._matrix
                    line['dir'] = (a * dx + c * dy, b * dx + d * dy)
                    for span in line.get('spans', []):
                        span['bbox'] = self._box(span['bbox'])
                        span['origin'] = self._point(span['origin'])
                        for character in span.get('chars', []):
                            character['bbox'] = self._box(character['bbox'])
                            character['origin'] = self._point(character['origin'])
            if kwargs.get('sort'):
                result['blocks'].sort(key=lambda block: (block['bbox'][1], block['bbox'][0]))
        return result

    def get_drawings(self, **kwargs: Any) -> list:
        drawings = self._page.get_drawings(**kwargs)
        if self.geometry['rotation'] == 0:
            return drawings
        for drawing in drawings:
            for key in ('rect', 'scissor'):
                if key in drawing:
                    drawing[key] = fitz.Rect(self._box(drawing[key]))
            items = []
            for item in drawing.get('items', []):
                kind = item[0]
                if kind in {'l', 'c'}:
                    items.append((kind, *(fitz.Point(self._point(p)) for p in item[1:])))
                elif kind == 're':
                    items.append((kind, fitz.Rect(self._box(item[1])), *item[2:]))
                elif kind == 'qu':
                    items.append((kind, fitz.Quad([self._point(p) for p in item[1]]), *item[2:]))
                else:
                    items.append(item)
            drawing['items'] = items
        return drawings

    def get_image_rects(self, name: Any, transform: bool = False) -> list:
        placements = self._page.get_image_rects(name, transform=transform)
        if transform:
            return [(fitz.Rect(self._box(rect)), self._image_matrix(matrix)) for rect, matrix in placements]
        return [fitz.Rect(self._box(rect)) for rect in placements]

    def get_bboxlog(self, **kwargs: Any) -> list:
        # An empty/inverted display-list box must remain empty. Applying the
        # coordinate transform first normalizes MuPDF's empty sentinel into
        # a huge positive rectangle and falsely overlaps every receipt.
        result = []
        for kind, box, *rest in self._page.get_bboxlog(**kwargs):
            if len(box) != 4 or not all(math.isfinite(value) for value in box):
                raise ValueError("invalid display-list geometry")
            if box[2] > box[0] and box[3] > box[1]:
                result.append((kind, self._box(box), *rest))
        return result


def visible_page(page: Any) -> Any:
    """Return an idempotent view for physical, rotated extraction coordinates.

    Real PDF pages always validate their original geometry. Lightweight callers
    implementing the historical page protocol without an xref already provide
    visible coordinates and remain compatible (not a malformed-PDF fallback).
    """
    if isinstance(page, _VisiblePage) or not hasattr(page, 'xref'):
        return page
    return _VisiblePage(page)


@dataclass(frozen=True)
class TextBlock:
    page_number: int
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    block_index: int
    confidence: float = 1.0
    is_watermark: bool = False


@dataclass(frozen=True)
class ParsedPage:
    page_number: int
    width: float
    height: float
    text: str
    blocks: tuple[TextBlock, ...]


_BANK_NAME = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]{2,18}银行")
_MAX_WATERMARK_BLOCKS = 4096
_WatermarkKey = tuple[str, tuple[float, ...]]


def _watermark_key(text: str, bbox: object) -> _WatermarkKey | None:
    if len(text) > 80 or not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    name = "".join(text.split())
    if not _BANK_NAME.fullmatch(name):
        return None
    try:
        rect = tuple(round(float(value), 3) for value in bbox)
    except (TypeError, ValueError, OverflowError):
        return None
    if not all(math.isfinite(value) for value in rect) or rect[2] <= rect[0] or rect[3] <= rect[1]:
        return None
    return name, rect


def _watermark_keys(page: fitz.Page, raw_blocks: list) -> set[_WatermarkKey]:
    """Recognize repeated diagonal bank-name backgrounds, conservatively."""
    if len(raw_blocks) > _MAX_WATERMARK_BLOCKS:
        return set()
    raw_keys = {
        key for block in raw_blocks
        if (key := _watermark_key(str(block[4]).strip(), block[:4])) is not None
    }
    if len(raw_keys) < 3:
        return set()
    try:
        # Read only text geometry: embedded bitmap payloads are unnecessary.
        metadata = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)
        blocks = metadata.get("blocks", [])
        if len(blocks) > _MAX_WATERMARK_BLOCKS:
            return set()
        groups: dict[str, set[_WatermarkKey]] = {}
        for block in blocks:
            if block.get("type") != 0:
                continue
            lines = block.get("lines", [])
            if not lines or len(lines) > 64:
                continue
            text_parts = []
            for line in lines:
                dx, dy = line.get("dir", (1.0, 0.0))
                spans = line.get("spans", [])
                if not (0.2 < abs(dx) <= 1 and 0.2 < abs(dy) <= 1) or len(spans) > 128:
                    break
                text_parts.append("".join(span.get("text", "") for span in spans))
            else:
                key = _watermark_key("\n".join(text_parts), block.get("bbox"))
                if key is not None and key in raw_keys:
                    groups.setdefault(key[0], set()).add(key)

        result: set[_WatermarkKey] = set()
        # The historical repetition check follows the source's row axis. A
        # page rotation turns those rows into columns, not into different text.
        row_axis = 0 if isinstance(page, _VisiblePage) and page.geometry['rotation'] in (90, 270) else 1
        for keys in groups.values():
            if len(keys) < 3:
                continue
            row_height = max(key[1][row_axis + 2] - key[1][row_axis] for key in keys)
            row_starts: list[float] = []
            for y in sorted({key[1][row_axis] for key in keys}):
                if not row_starts or y - row_starts[-1] > row_height:
                    row_starts.append(y)
            if len(row_starts) >= 3:
                result.update(keys)
        return result
    except Exception:
        # Optional metadata must never remove text or prevent ordinary parsing.
        return set()


def parse_loaded_page(page: fitz.Page, page_number: int) -> ParsedPage:
    """Keep searchable blocks intact and attach optional layout-only metadata."""
    page = visible_page(page)
    raw_blocks = page.get_text("blocks")
    watermark_keys = _watermark_keys(page, raw_blocks)
    blocks: list[TextBlock] = []
    for block_index, block in enumerate(raw_blocks):
        x0, y0, x1, y1, text = block[:5]
        if not str(text).strip():
            continue
        blocks.append(TextBlock(
            page_number, str(text).strip(), x0, y0, x1, y1, block_index,
            is_watermark=_watermark_key(str(text).strip(), block[:4]) in watermark_keys,
        ))
    return ParsedPage(page_number, page.rect.width, page.rect.height, page.get_text(), tuple(blocks))


def iter_pages(path: str | Path) -> Iterator[ParsedPage]:
    """Yield page text and word-block coordinates without loading all pages."""

    document = fitz.open(str(path))
    try:
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            yield parse_loaded_page(page, page_index + 1)
    finally:
        document.close()


def page_count(path: str | Path) -> int:
    document = fitz.open(str(path))
    try:
        return document.page_count
    finally:
        document.close()
