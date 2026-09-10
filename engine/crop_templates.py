"""Read-only page descriptors used by the batch crop review workflow.

The descriptor deliberately contains only page geometry and opaque hashes.  It
is computed from the text layer and straight table geometry. Other visible
objects are checked for boundary crossings but never included as image data.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from typing import Any
import unicodedata

try:  # PyMuPDF renamed its import package in recent releases.
    import pymupdf as fitz
except ImportError:  # pragma: no cover - compatibility with older PyMuPDF.
    import fitz  # type: ignore[no-redef]

from .layout import (
    MAX_LAYOUT_DRAWING_ITEMS,
    MAX_LAYOUT_DRAWINGS,
    MAX_RECEIPT_TITLES,
    MAX_TEXT_BLOCKS,
    _is_receipt_title,
    _normalize_title_line,
)
from .pdf_parser import ParsedPage, TextBlock, parse_loaded_page


# Keep these public aliases close to the protocol code.  They make the
# fail-closed resource contract easy to audit and keep this module independent
# from any future changes to the general layout candidate budgets.
MAX_TEXT_BLOCK_BUDGET = MAX_TEXT_BLOCKS
MAX_DRAWING_BUDGET = MAX_LAYOUT_DRAWINGS
MAX_DRAWING_ITEM_BUDGET = MAX_LAYOUT_DRAWING_ITEMS
MAX_TITLE_BUDGET = MAX_RECEIPT_TITLES
MAX_TEXT_LINE_BUDGET = 16_384
MAX_TEXT_SPAN_BUDGET = 32_768
MAX_TEXT_CHARACTER_BUDGET = 1_000_000
MAX_VISIBLE_OBJECT_BUDGET = 32_768

_TITLE_DEDUP_GAP = 32.0
_LINE_TOLERANCE = 2.0
_MIN_HORIZONTAL_LINE = 0.35
_MIN_VERTICAL_LINE = 0.04
_MIN_LINE_LENGTH = 40.0
_MIN_HORIZONTAL_LINES = 2

_NO_TEXT = "no_text"
_NO_TITLES = "no_titles"
_AMBIGUOUS_LAYOUT = "ambiguous_layout"
_BUDGET_EXCEEDED = "budget_exceeded"


@dataclass(frozen=True)
class _Title:
    """One opaque title anchor and its page-local geometry."""

    title_text: str
    title_key: str
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass(frozen=True)
class _Line:
    """A long, axis-aligned drawing segment used as layout evidence."""

    orientation: str
    x0: float
    y0: float
    x1: float
    y1: float


class _BudgetExceeded(Exception):
    """Internal sentinel that keeps budget failures distinct."""


def _unavailable(reason: str) -> dict[str, str]:
    return {"status": "unavailable", "reason": reason}


def _finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _page_geometry(page: Any) -> tuple[float, float] | None:
    try:
        width = float(page.rect.width)
        height = float(page.rect.height)
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None
    if not (_finite(width) and _finite(height) and width > 0 and height > 0):
        return None
    return width, height


def _count_text_blocks(page: Any) -> int:
    """Bound subsequent Python work after native text extraction returns.

    PyMuPDF materializes its result first; these checks are not a native peak
    memory limit. The engine's file-size and process-time limits still apply.
    """

    raw_blocks = page.get_text("blocks")
    count = 0
    characters = 0
    for block in raw_blocks:
        count += 1
        if len(block) > 4 and isinstance(block[4], str):
            characters += len(block[4])
        if count > MAX_TEXT_BLOCK_BUDGET or characters > MAX_TEXT_CHARACTER_BUDGET:
            raise _BudgetExceeded
    return count


def _canonical_title_text(text: str) -> str | None:
    """Return only the stable heading part of a recognized title line."""

    normalized = unicodedata.normalize("NFC", _normalize_title_line(text))
    if not normalized or not _is_receipt_title(normalized):
        return None

    # A few templates append a small per-copy marker in parentheses.  That
    # marker is a variable title suffix rather than a different template.
    for opening, closing in (("（", "）"), ("(", ")")):
        if not normalized.endswith(closing):
            continue
        opening_index = normalized.rfind(opening)
        if opening_index < 0:
            continue
        base = normalized[:opening_index].rstrip()
        suffix = normalized[opening_index + 1 : -1]
        if (
            0 < len(suffix) <= 8
            and opening not in suffix
            and closing not in suffix
            and _is_receipt_title(base)
        ):
            return base
    return normalized


def _title_text_from_block(text: str) -> str | None:
    """Find the stable title line while ignoring body lines in one block."""

    if not isinstance(text, str) or not text.strip():
        return None
    lines = [_normalize_title_line(line) for line in text.splitlines()]
    lines = [line for line in lines if line]
    for index, line in enumerate(lines):
        # Match the parser's seal handling: a split ``电子回单 / 专用章`` is a
        # stamp label, not a receipt heading.
        if index + 1 < len(lines) and "专用章" in lines[index + 1]:
            continue
        canonical = _canonical_title_text(line)
        if canonical is not None:
            return canonical
    return None


def _dict_title_boxes(page: Any) -> list[tuple[str, tuple[float, float, float, float]]]:
    """Read line-level title boxes when available, without retaining body text."""

    try:
        flags = getattr(fitz, "TEXTFLAGS_DICT", 0)
        if flags:
            flags &= ~getattr(fitz, "TEXT_PRESERVE_IMAGES", 0)
            metadata = page.get_text("dict", flags=flags)
        else:
            metadata = page.get_text("dict")
    except (AttributeError, TypeError, ValueError, RuntimeError):
        return []

    if not isinstance(metadata, dict):
        return []
    blocks = metadata.get("blocks", [])
    if not isinstance(blocks, list):
        return []
    if len(blocks) > MAX_TEXT_BLOCK_BUDGET:
        raise _BudgetExceeded

    candidates: list[tuple[str, tuple[float, float, float, float]]] = []
    total_lines = 0
    total_spans = 0
    total_characters = 0
    for raw_block in blocks:
        if not isinstance(raw_block, dict) or raw_block.get("type") != 0:
            continue
        raw_lines = raw_block.get("lines", [])
        if not isinstance(raw_lines, list) or len(raw_lines) > MAX_TEXT_BLOCK_BUDGET:
            raise _BudgetExceeded
        total_lines += len(raw_lines)
        if total_lines > MAX_TEXT_LINE_BUDGET:
            raise _BudgetExceeded
        line_data: list[tuple[str, tuple[float, float, float, float]]] = []
        for raw_line in raw_lines:
            if not isinstance(raw_line, dict):
                continue
            spans = raw_line.get("spans", [])
            if not isinstance(spans, list) or len(spans) > MAX_TEXT_BLOCK_BUDGET:
                raise _BudgetExceeded
            total_spans += len(spans)
            if total_spans > MAX_TEXT_SPAN_BUDGET:
                raise _BudgetExceeded
            texts = []
            for span in spans:
                if not isinstance(span, dict):
                    continue
                value = span.get("text", "")
                if not isinstance(value, str):
                    raise ValueError("invalid span text")
                total_characters += len(value)
                if total_characters > MAX_TEXT_CHARACTER_BUDGET:
                    raise _BudgetExceeded
                texts.append(value)
            text = "".join(texts)
            normalized = _normalize_title_line(text)
            bbox = raw_line.get("bbox")
            if not normalized or not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                continue
            try:
                box = tuple(float(value) for value in bbox)
            except (TypeError, ValueError, OverflowError):
                continue
            if not all(_finite(value) for value in box):
                continue
            x0, y0, x1, y1 = box
            if x1 <= x0 or y1 <= y0:
                continue
            line_data.append((normalized, (x0, y0, x1, y1)))
        for index, (line, box) in enumerate(line_data):
            if index + 1 < len(line_data) and "专用章" in line_data[index + 1][0]:
                continue
            canonical = _canonical_title_text(line)
            if canonical is not None:
                candidates.append((canonical, box))
                if len(candidates) > MAX_TITLE_BUDGET:
                    raise _BudgetExceeded
    return candidates


def _title_records(page: Any, parsed: ParsedPage, width: float, height: float) -> list[_Title]:
    visible_blocks = [block for block in parsed.blocks if not block.is_watermark]
    block_titles: list[tuple[TextBlock, str]] = []
    for block in visible_blocks:
        if not all(_finite(value) for value in (block.x0, block.y0, block.x1, block.y1)):
            raise ValueError("text geometry is invalid")
        canonical = _title_text_from_block(block.text)
        if canonical is not None:
            block_titles.append((block, canonical))
    if len(block_titles) > MAX_TITLE_BUDGET:
        raise _BudgetExceeded
    if not block_titles:
        return []

    line_boxes = _dict_title_boxes(page)
    titles: list[_Title] = []
    for block, canonical in block_titles:
        box = (float(block.x0), float(block.y0), float(block.x1), float(block.y1))
        if line_boxes:
            matching = [
                candidate_box
                for candidate_label, candidate_box in line_boxes
                if candidate_label == canonical
                and candidate_box[1] >= block.y0 - 1.5
                and candidate_box[3] <= block.y1 + 1.5
            ]
            if matching:
                box = min(
                    matching,
                    key=lambda candidate: (
                        abs(candidate[1] - block.y0),
                        abs(candidate[0] - block.x0),
                    ),
                )
        x0, y0, x1, y1 = box
        if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
            raise ValueError("title geometry is outside the page")
        title_key = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        titles.append(_Title(canonical, title_key, x0, y0, x1, y1))

    titles.sort(key=lambda item: (item.y0, item.x0, item.y1, item.x1))
    deduplicated: list[_Title] = []
    for title in titles:
        if deduplicated and title.y0 - deduplicated[-1].y0 < _TITLE_DEDUP_GAP:
            previous = deduplicated[-1]
            x_overlap = min(previous.x1, title.x1) - max(previous.x0, title.x0)
            if previous.title_key == title.title_key and x_overlap > 0:
                continue
            # Nearby distinct headings, or headings in separate horizontal
            # slots, cannot be safely partitioned by one vertical boundary.
            raise ValueError("nearby receipt headings are ambiguous")
        deduplicated.append(title)
    return deduplicated


def _axis_line(
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    width: float,
    height: float,
) -> list[_Line]:
    if not all(_finite(value) for value in (x0, y0, x1, y1)):
        return []
    if abs(y1 - y0) <= _LINE_TOLERANCE and abs(x1 - x0) >= max(_MIN_LINE_LENGTH, width * _MIN_HORIZONTAL_LINE):
        left, right = sorted((x0, x1))
        y = (y0 + y1) / 2
        return [_Line("h", left, y, right, y)]
    if abs(x1 - x0) <= _LINE_TOLERANCE and abs(y1 - y0) >= max(_MIN_LINE_LENGTH, height * _MIN_VERTICAL_LINE):
        top, bottom = sorted((y0, y1))
        x = (x0 + x1) / 2
        return [_Line("v", x, top, x, bottom)]
    return []


def _rectangle_lines(rect: Any, width: float, height: float) -> list[_Line]:
    try:
        x0, x1 = sorted((float(rect.x0), float(rect.x1)))
        y0, y1 = sorted((float(rect.y0), float(rect.y1)))
    except (AttributeError, TypeError, ValueError, OverflowError):
        return []
    return [
        *_axis_line(x0, y0, x1, y0, width, height),
        *_axis_line(x0, y1, x1, y1, width, height),
        *_axis_line(x0, y0, x0, y1, width, height),
        *_axis_line(x1, y0, x1, y1, width, height),
    ]


def _drawing_lines(page: Any, width: float, height: float) -> list[_Line]:
    try:
        drawings = page.get_drawings()
    except (AttributeError, TypeError, ValueError, RuntimeError):
        raise ValueError("drawing geometry is unavailable") from None

    lines: list[_Line] = []
    drawing_count = 0
    item_count = 0
    for drawing in drawings:
        drawing_count += 1
        if drawing_count > MAX_DRAWING_BUDGET:
            raise _BudgetExceeded
        if not isinstance(drawing, dict):
            continue
        items = drawing.get("items", [])
        if not isinstance(items, (list, tuple)):
            continue
        item_count += len(items)
        if item_count > MAX_DRAWING_ITEM_BUDGET:
            raise _BudgetExceeded
        # Invisible fills do not provide reliable table-line evidence.  Their
        # items still count toward the resource budget above.
        if drawing.get("type") == "f" or drawing.get("color") is None:
            continue
        for item in items:
            if not isinstance(item, (list, tuple)) or not item:
                continue
            kind = item[0]
            if kind == "l" and len(item) >= 3:
                try:
                    start, end = item[1], item[2]
                    lines.extend(
                        _axis_line(
                            float(start.x),
                            float(start.y),
                            float(end.x),
                            float(end.y),
                            width,
                            height,
                        )
                    )
                except (AttributeError, TypeError, ValueError, OverflowError):
                    continue
            elif kind == "re" and len(item) >= 2:
                lines.extend(_rectangle_lines(item[1], width, height))

    unique: dict[tuple[object, ...], _Line] = {}
    for line in lines:
        key = (
            line.orientation,
            round(line.x0, 3),
            round(line.y0, 3),
            round(line.x1, 3),
            round(line.y1, 3),
        )
        unique[key] = line
    return sorted(
        unique.values(),
        key=lambda line: (line.orientation, line.y0, line.x0, line.y1, line.x1),
    )


def _last_text_y_by_title(
    parsed: ParsedPage,
    titles: list[_Title],
    height: float,
) -> list[float]:
    blocks = [block for block in parsed.blocks if not block.is_watermark]
    last_text_y: list[float] = []
    for index, title in enumerate(titles):
        next_y = titles[index + 1].y0 if index + 1 < len(titles) else height
        segment_blocks = [
            block
            for block in blocks
            if title.y0 <= block.y0 < next_y
            and not (
                block.y0 >= height * 0.9
                and block.y1 <= height
                and block.x1 - block.x0 <= parsed.width * 0.45
            )
        ]
        maximum = max((float(block.y1) for block in segment_blocks), default=title.y1)
        if not _finite(maximum) or maximum >= height:
            raise ValueError("receipt text geometry is invalid")
        if index + 1 < len(titles) and maximum >= next_y:
            raise ValueError("receipt text crosses the next heading")
        last_text_y.append(maximum)
    return last_text_y


def _visible_objects_cross_boundaries(page: Any, boundaries: list[float]) -> bool:
    """Fail closed when a receipt boundary would cut non-text content.

    The display list includes images, fills, curves, and short strokes, even
    when they are unsuitable as stable table fingerprint evidence. Text is
    handled separately so known watermarks do not become receipt contents.
    """
    entries = page.get_bboxlog()
    if len(entries) > MAX_VISIBLE_OBJECT_BUDGET:
        raise _BudgetExceeded
    for kind, box, *_rest in entries:
        if kind in {"fill-text", "stroke-text", "ignore-text"}:
            continue
        if len(box) != 4 or not all(_finite(value) for value in box):
            return True
        if any(box[1] < boundary < box[3] for boundary in boundaries[1:-1]):
            return True
    return False


def _fingerprint(
    width: float,
    height: float,
    titles: list[_Title],
    lines: list[_Line],
) -> str:
    title_payload = [
        {
            "title_key": title.title_key,
            "box": [
                round(title.x0 / width, 5),
                round(title.y0 / height, 5),
                round(title.x1 / width, 5),
                round(title.y1 / height, 5),
            ],
        }
        for title in titles
    ]
    line_payload = [
        [
            line.orientation,
            round(line.x0 / width, 5),
            round(line.y0 / height, 5),
            round(line.x1 / width, 5),
            round(line.y1 / height, 5),
        ]
        for line in lines
    ]
    payload = {
        "version": 1,
        "page": [round(width, 3), round(height, 3)],
        "titles": title_payload,
        "lines": line_payload,
    }
    encoded = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")
    return hashlib.sha256(encoded).hexdigest()


def _ready_template(
    page: Any,
    parsed: ParsedPage,
    width: float,
    height: float,
) -> dict[str, object]:
    titles = _title_records(page, parsed, width, height)
    if not titles:
        visible_blocks = [block for block in parsed.blocks if not block.is_watermark]
        return _unavailable(_NO_TEXT if not visible_blocks else _NO_TITLES)
    lines = _drawing_lines(page, width, height)
    horizontal_lines = [line for line in lines if line.orientation == "h"]
    if len(horizontal_lines) < _MIN_HORIZONTAL_LINES:
        return _unavailable(_AMBIGUOUS_LAYOUT)

    last_text_y = _last_text_y_by_title(parsed, titles, height)
    boundaries = [0.0]
    for index in range(len(titles) - 1):
        boundary = (last_text_y[index] + titles[index + 1].y0) / 2
        if not _finite(boundary) or not (boundaries[-1] < boundary < height):
            raise ValueError("receipt boundaries are ambiguous")
        boundaries.append(boundary)
    boundaries.append(height)
    if _visible_objects_cross_boundaries(page, boundaries):
        return _unavailable(_AMBIGUOUS_LAYOUT)

    # A line in each inter-title gap is the minimum table evidence needed to
    # explain the vertical partition.  Straight lines outside the gaps still
    # participate in the fingerprint, but cannot establish a boundary alone.
    for index in range(len(titles) - 1):
        lower = titles[index].y1
        upper = titles[index + 1].y0
        if not any(lower <= line.y0 <= upper for line in horizontal_lines):
            return _unavailable(_AMBIGUOUS_LAYOUT)

    for boundary in boundaries[1:-1]:
        if any(block.y0 < boundary < block.y1 for block in parsed.blocks if not block.is_watermark):
            return _unavailable(_AMBIGUOUS_LAYOUT)

    receipts = [
        {
            "anchor_y": float(title.y0),
            "bounds": {
                "x0": 0.0,
                "y0": float(boundaries[index]),
                "x1": float(width),
                "y1": float(boundaries[index + 1]),
            },
            "title_key": title.title_key,
        }
        for index, title in enumerate(titles)
    ]
    return {
        "status": "ready",
        "fingerprint": _fingerprint(width, height, titles, lines),
        "receipts": receipts,
    }


def describe_crop_page(page: Any) -> dict[str, object]:
    """Describe one loaded PDF page for batch crop planning.

    The return value is exactly the ``crop_template`` member of the engine
    protocol.  Page dimensions, page number, source hash, and page count are
    added by :func:`engine.engine._analyze_page_response` at the IPC boundary.
    """

    try:
        geometry = _page_geometry(page)
        if geometry is None:
            return _unavailable(_AMBIGUOUS_LAYOUT)
        width, height = geometry
        _count_text_blocks(page)
        raw_number = getattr(page, "number", 0)
        page_number = int(raw_number) + 1 if isinstance(raw_number, int) and not isinstance(raw_number, bool) else 1
        parsed = parse_loaded_page(page, page_number)
        if not parsed.blocks:
            return _unavailable(_NO_TEXT)
        return _ready_template(page, parsed, width, height)
    except _BudgetExceeded:
        return _unavailable(_BUDGET_EXCEEDED)
    except (OSError, RuntimeError, TypeError, ValueError, AttributeError, KeyError):
        return _unavailable(_AMBIGUOUS_LAYOUT)
    except Exception:
        # A descriptor is optional metadata.  If an unfamiliar PDF object
        # cannot be described safely, make it unavailable without exposing
        # parser details or source content through the protocol.
        return _unavailable(_AMBIGUOUS_LAYOUT)


__all__ = [
    "MAX_DRAWING_BUDGET",
    "MAX_DRAWING_ITEM_BUDGET",
    "MAX_TEXT_BLOCK_BUDGET",
    "MAX_TITLE_BUDGET",
    "describe_crop_page",
]
