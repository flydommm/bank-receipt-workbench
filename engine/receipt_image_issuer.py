"""Read small, isolated image mastheads locally; never infer issuer from account fields.

Only OCR text tied to the exact embedded image and runtime recipe is reusable.
The existing bounded private OCR cache owns expiry and the user's clear action.
"""
from __future__ import annotations

from functools import lru_cache
from hashlib import sha256
import math

import pymupdf as fitz

from .ocr import OcrRuntimeError, OcrUnavailableError, recognize_image
from .ocr_cache import OCR_RENDER_DPI, OcrTextCache
from .private_temp import private_temporary_directory
from .pdf_parser import visible_page
from .receipt_issuer import TextLine, canonical_bank_heading, issuer_masthead_bank
from .layout import _is_receipt_title

MAX_IMAGES = 128
MAX_LOGOS = 8
MAX_LOGO_BYTES = 2 * 1024 * 1024


@lru_cache(maxsize=128)
def _recognize_masthead(data: bytes, width: int, height: int) -> tuple[TextLine, ...]:
    digest = sha256(b'isolated-bank-masthead-v3\0' + data).hexdigest()
    cache = OcrTextCache(digest)
    points = (width * 72 / OCR_RENDER_DPI, height * 72 / OCR_RENDER_DPI)
    records = cache.get(1, *points)
    if records is None:
        with private_temporary_directory('bank-masthead') as directory:
            image = directory / 'masthead.png'
            image.write_bytes(data)
            records = recognize_image(image)
        if len(records) > 64:
            return ()
        context = [(record['text'], tuple(record['box'])) for record in records]
        # Inspect the complete small image before discarding non-bank records.
        # An account label printed as pixels must exclude its bank value just
        # like a label in the PDF text layer. Any such label in this standalone
        # logo-sized image disqualifies it, even when OCR splits the lines.
        if issuer_masthead_bank('演示银行', (0, 0, width, height), context) is None:
            records = []
        else:
            records = [record for record in records if canonical_bank_heading(record['text'])]
        # Save only contextualized bank names, never account labels/body text.
        cache.put(1, *points, records)
    if len(records) > 64:
        return ()
    banks = set()
    for record in records:
        confidence = record.get('confidence')
        if isinstance(confidence, (int, float)) and math.isfinite(confidence) and confidence >= 0.98:
            bank = canonical_bank_heading(record['text'])
            box = tuple(record.get('box', ()))
            if (bank and len(box) == 4 and all(isinstance(value, (int, float))
                    and math.isfinite(value) for value in box)
                    and 0 <= box[0] < box[2] <= width and 0 <= box[1] < box[3] <= height):
                banks.add((bank, box))
    return tuple(sorted(banks))


@lru_cache(maxsize=128)
def _recognize_logo(data: bytes, width: int, height: int) -> tuple[str, ...]:
    return tuple(sorted({bank for bank, _box in _recognize_masthead(data, width, height)}))


def _wide_title_band(box: tuple[float, ...], regions: list[tuple[float, float]],
                     text_lines: list[TextLine]) -> bool:
    """A wide image may supply a logo only alongside the actual receipt title."""
    x0, y0, x1, y1 = box
    for top, bottom in regions:
        titles = [line_box for text, line_box in text_lines
                  if _is_receipt_title(text) and abs(line_box[3] - bottom) <= 1
                  and x0 <= line_box[0] < line_box[2] <= x1
                  and min(y1, line_box[3]) > max(y0, line_box[1])]
        if not titles or y0 < top - 4 or y1 > bottom + 32:
            continue
        title = titles[0]
        following_body = [line_box[1] for text, line_box in text_lines
                          if line_box[1] >= title[3] and not _is_receipt_title(text)]
        if following_body and y1 > min(following_body):
            continue
        return True
    return False


def _visible_banner_lines(page: object, box: tuple[float, ...], width: int,
                          regions: list[tuple[float, float]]) -> list[TextLine]:
    # Render only the visible band. Hidden pixels outside the page, soft masks,
    # and PDF content covering a logo must never establish the issuer.
    visible = fitz.Rect(box) & page.rect
    scale = min(width / (box[2] - box[0]), 2.0)
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=visible,
                              colorspace=fitz.csRGB, alpha=False)
    if not (100 <= pixmap.width <= 1026 and 1 <= pixmap.height <= 130):
        return []
    recognized = _recognize_masthead(pixmap.tobytes('png'), pixmap.width, pixmap.height)
    result = []
    for bank, pixel_box in recognized:
        mapped = ((pixmap.x + pixel_box[0]) / scale, (pixmap.y + pixel_box[1]) / scale,
                  (pixmap.x + pixel_box[2]) / scale, (pixmap.y + pixel_box[3]) / scale)
        if (visible.x0 <= mapped[0] < mapped[2] <= visible.x1
                and visible.y0 <= mapped[1] < mapped[3] <= visible.y1
                and any(top <= mapped[1] and mapped[3] <= bottom + 3 for top, bottom in regions)):
            result.append((bank, mapped))
    # Reject conflicts even if only one name falls inside the title band, so
    # cropping/position cannot select a preferred issuer from a banner.
    if len({bank for bank, _box in recognized}) > 1:
        return []
    return result


def image_masthead_lines(page: object, regions: list[tuple[float, float]], text_lines: list[TextLine]) -> list[TextLine]:
    """Return verified bank headings only from standalone images inside title bands.

    Regions run from the prior receipt/title boundary to the current title's
    bottom. Full receipt scans, tall images, body labels and uncertain results
    do not supply issuer evidence. OCR absence keeps the previous unknown result.
    """
    try:
        page = visible_page(page)
        images = page.get_images(full=True)
        if len(images) > MAX_IMAGES:
            return []
        candidates = []
        seen = set()
        for item in {item[0]: item for item in images}.values():
            xref, _, width, height = item[:4]
            if not (isinstance(xref, int) and xref > 0 and 100 <= width <= 1024 and 20 <= height <= 256
                    and 2 <= width / height <= 32 and width * height <= 262144):
                continue
            placements = page.get_image_rects(xref)
            if len(placements) > MAX_IMAGES:
                return []
            for rect in placements:
                box = tuple(float(value) for value in rect)
                if not all(math.isfinite(value) for value in box):
                    return []
                x0, y0, x1, y1 = box
                if (xref, box) in seen:
                    continue
                seen.add((xref, box))
                if len(seen) > MAX_IMAGES:
                    return []
                if not (0 <= x0 < x1 <= page.rect.width and -4 <= y0 < y1 <= page.rect.height
                        and 5 <= y1 - y0 <= 64):
                    continue
                narrow = (width / height <= 12 and x1 - x0 <= page.rect.width * 0.65
                          and any(top <= y0 and y1 <= bottom + 3 for top, bottom in regions))
                if not narrow and not _wide_title_band(box, regions, text_lines):
                    continue
                # The same account-label exclusions apply before OCR and again
                # when the recognized line is consumed by the template builder.
                if issuer_masthead_bank('演示银行', box, text_lines) is None:
                    continue
                candidates.append((xref, width, height, box, narrow))
        if len(candidates) > MAX_LOGOS:
            return []
        result = []
        for xref, width, height, box, narrow in candidates:
            if not narrow:
                placements = page.get_image_rects(xref, transform=True)
                if len(placements) > MAX_IMAGES:
                    return []
                if not any(tuple(float(value) for value in rect) == box
                           and matrix.a > 0 and matrix.d > 0
                           and abs(matrix.b) < 0.001 and abs(matrix.c) < 0.001
                           for rect, matrix in placements):
                    continue
                result.extend(_visible_banner_lines(page, box, width, regions))
                continue
            image = page.parent.extract_image(xref)
            data = image.get('image')
            if not isinstance(data, bytes) or not data or len(data) > MAX_LOGO_BYTES:
                continue
            banks = _recognize_logo(data, width, height)
            # Multiple credible bank names are conflicting evidence.
            result.extend((bank, box) for bank in banks)
        return result
    except (OcrUnavailableError, OcrRuntimeError, OSError, RuntimeError, ValueError, TypeError, AttributeError, KeyError):
        return []
