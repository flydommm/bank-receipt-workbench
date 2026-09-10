"""Text extraction helpers for text-based PDFs."""

from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import re
from typing import Iterator

try:  # PyMuPDF renamed its import package in recent releases.
    import pymupdf as fitz
except ImportError:  # pragma: no cover - compatibility for older installations
    import fitz  # type: ignore[no-redef]


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
        for keys in groups.values():
            if len(keys) < 3:
                continue
            row_height = max(key[1][3] - key[1][1] for key in keys)
            row_starts: list[float] = []
            for y in sorted({key[1][1] for key in keys}):
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
