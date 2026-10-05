"""Read-only page descriptors used by the batch crop review workflow.

The descriptor deliberately contains only page geometry and opaque hashes.  It
is computed from the text layer and verified straight table geometry. Other visible
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
    MAX_FRAME_EDGES_PER_ORIENTATION,
    MAX_LAYOUT_DRAWING_ITEMS,
    MAX_LAYOUT_DRAWINGS,
    MAX_RECEIPT_TITLES,
    MAX_TEXT_BLOCKS,
    _is_receipt_title,
    _normalize_title_line,
)
from .pdf_parser import ParsedPage, TextBlock, parse_loaded_page, visible_page
from .receipt_issuer import canonical_bank_heading as _canonical_bank_heading, issuer_masthead_bank
from .receipt_image_issuer import image_masthead_lines
from .receipt_visual_identity import describe_visual_form
from .receipt_headers import (
    MAX_PRINT_COUNT_PAIR_COMPARISONS as _PRINT_COUNT_SPLIT_PAIR_BUDGET,
    PrintCountBudgetExceeded,
    is_print_count_line as _is_print_count_line,
    is_print_count_label as _is_print_count_label,
    is_print_count_value as _is_print_count_value,
    print_count_prefixes,
    split_print_count_pair_candidates,
)


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
MAX_BITMAP_IMAGES = 128
MAX_BITMAP_PLACEMENTS = 128
MAX_FILLED_RULES = 128

_TITLE_DEDUP_GAP = 32.0
_LINE_TOLERANCE = 2.0
_MIN_HORIZONTAL_LINE = 0.35
_MIN_VERTICAL_LINE = 0.04
_MIN_LINE_LENGTH = 40.0
_MIN_HORIZONTAL_LINES = 1
_MAX_HEADER_BAND_LINES = 32

_FIXED_LABELS = tuple(sorted((
    "付款人名称", "付款人账号", "付款人开户行", "收款人名称", "收款人账号", "收款人开户行",
    "付款人户名", "收款人户名", "付款单位", "收款单位", "交易日期", "交易时间", "交易流水号",
    "记账日期", "回单编号", "回单号码", "交易金额", "业务类型", "业务名称", "打印时间",
    "金额(大写)", "金额（大写）", "金额(小写)", "金额（小写）", "币种", "金额", "摘要", "用途",
), key=len, reverse=True))

_NO_TEXT = "no_text"
_NO_TITLES = "no_titles"
_AMBIGUOUS_LAYOUT = "ambiguous_layout"
_BUDGET_EXCEEDED = "budget_exceeded"
_VISUAL_BOUNDARY_MIN_WIDTH_RATIO = 0.70
_VISUAL_BOUNDARY_MIN_HEIGHT_RATIO = 0.12
_VISUAL_BOUNDARY_MAX_HEIGHT_RATIO = 0.50
_VISUAL_BOUNDARY_DIMENSION_TOLERANCE = 4.0
_VISUAL_BOUNDARY_IOU = 0.85
_VISUAL_BOUNDARY_MIN_EMPTY_GAP = 0.75


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
    """A long, axis-aligned visible rule used as layout evidence."""

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


def _split_print_count_pair_candidates(
    line_boxes: list[tuple[str, tuple[float, float, float, float]]],
) -> list[tuple[tuple[float, float, float, float], tuple[float, float, float, float]]]:
    try:
        return split_print_count_pair_candidates(
            line_boxes, pair_budget=_PRINT_COUNT_SPLIT_PAIR_BUDGET,
        )
    except PrintCountBudgetExceeded as error:
        raise _BudgetExceeded from error


def _print_count_prefixes(
    titles: list[_Title],
    line_boxes: list[tuple[str, tuple[float, float, float, float]]],
) -> tuple[set[tuple[float, float, float, float]], list[float | None]]:
    try:
        return print_count_prefixes(
            titles, line_boxes, pair_budget=_PRINT_COUNT_SPLIT_PAIR_BUDGET,
        )
    except PrintCountBudgetExceeded as error:
        raise _BudgetExceeded from error


def _dict_title_boxes(page: Any, *, titles_only: bool = True) -> list[tuple[str, tuple[float, float, float, float]]]:
    """Read line-level title boxes when available, without retaining body text."""

    try:
        page = visible_page(page)
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
            if not titles_only:
                candidates.append((line, box))
                continue
            if index + 1 < len(line_data) and "专用章" in line_data[index + 1][0]:
                continue
            canonical = _canonical_title_text(line)
            if canonical is not None:
                candidates.append((canonical, box))
                if len(candidates) > MAX_TITLE_BUDGET:
                    raise _BudgetExceeded
    return candidates


def _issuer_bank_name(
    title: _Title,
    text_lines: list[tuple[str, tuple[float, float, float, float]]],
    lower_boundary: float,
) -> str | None:
    """Only receipt titles and nearby independent mastheads establish issuer.

    A payer/payee bank in a field below the heading is deliberately ineligible,
    even if its value is the only recognizable bank anywhere on the page.
    Conflicting mastheads are ambiguous and do not establish an issuer.
    """
    banks: set[str] = set()
    # A title prefix is only a candidate. The shared canonicalizer rejects
    # channel headings such as online banking; they never establish a bank.
    bank_end = title.title_text.find("银行")
    if bank_end >= 0:
        bank = _canonical_bank_heading(title.title_text[:bank_end + 2])
        if bank:
            banks.add(bank)
    header_candidates = []
    for text, (x0, y0, x1, y1) in text_lines:
        if y0 < max(lower_boundary, title.y0 - 64.0) or y0 > title.y1 or y1 > title.y1 + 3.0:
            continue
        if _canonical_bank_heading(text) is None:
            continue
        header_candidates.append((text, (x0, y0, x1, y1)))
        if len(header_candidates) > 16:
            return None
    for text, box in header_candidates:
        bank = issuer_masthead_bank(text, box, text_lines)
        if bank:
            banks.add(bank)
    if len(banks) != 1:
        return None
    return next(iter(banks))


def _issuer_bank_key(
    title: _Title,
    text_lines: list[tuple[str, tuple[float, float, float, float]]],
    lower_boundary: float,
) -> str | None:
    bank = _issuer_bank_name(title, text_lines, lower_boundary)
    return hashlib.sha256(bank.encode("utf-8")).hexdigest() if bank else None


def _receipt_header_fields(
    titles: list[_Title],
    issuer_keys: list[str | None],
    text_lines: list[tuple[str, tuple[float, float, float, float]]],
) -> list[list[tuple[str, tuple[float, float, float, float]]]]:
    """Prove a repeated metadata band around a centred receipt heading.

    Some forms put their receipt number above the title and accounting date
    beside its lower edge. Neither field alone establishes a header. Require
    a complete, unique pair anchored at the page top, a trusted common issuer
    and title, and matching fixed-field geometry on every occupied row. Values
    and their widths are deliberately not identity evidence.
    """
    empty: list[list[tuple[str, tuple[float, float, float, float]]]] = [[] for _ in titles]
    if (not titles or titles[0].y0 > 64.0 or not all(issuer_keys)
            or len(set(issuer_keys)) != 1 or len({title.title_key for title in titles}) != 1):
        return empty
    groups = []
    bands: list[list[tuple[tuple[str, str], tuple[float, float, float, float]]]] = []
    verified_fields = []
    for index, title in enumerate(titles):
        fields: dict[str, list[tuple[str, tuple[float, float, float, float]]]] = {
            "date": [], "number": [],
        }
        lower = max(titles[index - 1].y1 if index else 0.0, title.y0 - 64.0)
        for text, box in text_lines:
            if not (lower <= box[1] <= title.y1 and box[3] <= title.y1 + 4.0):
                continue
            normalized = text.replace(" ", "")
            for label, kind in (("记账日期", "date"), ("回单编号", "number"), ("回单号码", "number")):
                if not normalized.startswith(label):
                    continue
                suffix = normalized[len(label):]
                if not suffix or suffix[0] in ":：" or suffix[0].isdigit():
                    fields[kind].append((label, box))
                break
        if any(len(group) != 1 for group in fields.values()):
            return empty
        group = [fields["date"][0], fields["number"][0]]
        if min(box[1] for _label, box in group) >= title.y0:
            return empty
        if groups:
            for (label, box), (first_label, first_box) in zip(group, groups[0], strict=True):
                if (label != first_label or abs(box[0] - first_box[0]) > _LINE_TOLERANCE
                        or abs((box[1] - title.y0) - (first_box[1] - titles[0].y0)) > _LINE_TOLERANCE
                        or abs((box[3] - box[1]) - (first_box[3] - first_box[1])) > _LINE_TOLERANCE):
                    return empty
        # Advancing the start must not silently absorb other body text that
        # begins between the metadata and the title. Every line intersecting
        # this band must have a unique equivalent in the page-top header.
        start, end = min(box[1] for _label, box in group), title.y1 + 4.0
        band = [(text, box) for text, box in text_lines if box[1] < end and box[3] > start]
        if (len(band) > _MAX_HEADER_BAND_LINES
                or any(box[1] < start - _LINE_TOLERANCE or box[3] > end for _text, box in band)):
            return empty
        field_lines = []
        for text, box in band:
            normalized = text.replace(" ", "")
            label = next((label for label in _FIXED_LABELS if normalized.startswith(label)
                          and (not normalized[len(label):] or normalized[len(label)] in ":："
                               or normalized[len(label)].isdigit())), None)
            if label is not None:
                field_lines.append((label, box))
        keyed_band = []
        for text, box in band:
            fields_here = [label for label, field_box in field_lines if box == field_box]
            if fields_here:
                key = ("field", fields_here[0])
            else:
                # Separate values are eligible only beside a unique label,
                # with an unobstructed gap on the same baseline. Their text
                # may vary, but their position must repeat in every header.
                labels_left = [(label, field_box) for label, field_box in field_lines
                               if 0 <= box[0] - field_box[2] <= 64.0
                               and abs(box[1] - field_box[1]) <= _LINE_TOLERANCE
                               and abs(box[3] - field_box[3]) <= _LINE_TOLERANCE]
                if len(labels_left) == 1:
                    label, field_box = labels_left[0]
                    if any(other != box and other != field_box
                           and other[0] < box[0] and other[2] > field_box[2]
                           and abs(other[1] - box[1]) <= _LINE_TOLERANCE
                           for _other_text, other in band):
                        return empty
                    key = ("value", label)
                else:
                    key = ("fixed", text)
            keyed_band.append((key, box))
        if bands:
            if len(keyed_band) != len(bands[0]):
                return empty
            matched = set()
            for key, box in keyed_band:
                matches = [i for i, (first_key, first_box) in enumerate(bands[0])
                           if key == first_key and abs(box[0] - first_box[0]) <= _LINE_TOLERANCE
                           and abs((box[1] - title.y0) - (first_box[1] - titles[0].y0)) <= _LINE_TOLERANCE
                           and abs((box[3] - box[1]) - (first_box[3] - first_box[1])) <= _LINE_TOLERANCE]
                if len(matches) != 1 or matches[0] in matched:
                    return empty
                matched.add(matches[0])
        groups.append(group)
        bands.append(keyed_band)
        verified_fields.append(field_lines)
    return verified_fields


def _receipt_fingerprint(
    title: _Title,
    issuer_bank_key: str | None,
    lines: list[_Line],
    text_lines: list[tuple[str, tuple[float, float, float, float]]],
    top: float,
    bottom: float,
    width: float,
    height: float,
    header_fields: list[tuple[str, tuple[float, float, float, float]]] | None = None,
) -> str | None:
    """Hash stable receipt geometry relative to its title, excluding values.

    Neither slot, title count, whitespace after the receipt nor page-local y
    participates, so a final page's one receipt can match a complete page.
    """
    if issuer_bank_key is None:
        return None
    relative_lines = sorted([
        [line.orientation, round(line.x0, 1), round(line.y0 - title.y0, 1),
         round(line.x1, 1), round(line.y1 - title.y0, 1)]
        for line in lines if top <= line.y0 and line.y1 <= bottom
    ])
    labels = []
    for text, (x0, y0, _x1, y1) in text_lines:
        if y0 < title.y1 or y1 > bottom:
            continue
        normalized = text.replace(" ", "")
        label = next((label for label in _FIXED_LABELS if normalized.startswith(label)), None)
        if label is not None:
            labels.append([label, round(x0, 1), round(y0 - title.y0, 1)])
    # One divider alone does not distinguish two forms from the same bank.
    # Borderless bodies need several fixed field anchors as additional proof.
    if len(relative_lines) < 2 and len(labels) < 3:
        return None
    payload = {
        "version": 1,
        "issuer_bank_key": issuer_bank_key,
        "title_key": title.title_key,
        "page": [round(width, 1), round(height, 1)],
        "title": [round(title.x0, 1), round(title.y1 - title.y0, 1)],
        "lines": relative_lines,
        "labels": sorted(labels),
    }
    if header_fields:
        # A different header offset must not reuse an otherwise identical body
        # template: its crop could omit the leading metadata. Leave unrelated
        # forms' existing identity unchanged.
        payload["header_labels"] = sorted([
            [label, round(box[0], 1), round(box[1] - title.y0, 1), round(box[3] - box[1], 1)]
            for label, box in header_fields
        ])
    encoded = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")
    return hashlib.sha256(encoded).hexdigest()


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


def _filled_rule(drawing: dict[str, Any], width: float, height: float) -> tuple[_Line, Any] | None:
    """A narrow fill can draw a rule, but a cell background cannot."""
    fill = drawing.get("fill")
    if (drawing.get("type") != "f" or not isinstance(fill, (tuple, list)) or not fill
            or any(not _finite(value) or not 0 <= value <= .35 for value in fill)
            or drawing.get("fill_opacity", 0) < .99):
        return None
    items = drawing.get("items", ())
    if not items or any(not isinstance(item, (tuple, list)) or not item or item[0] not in {"l", "re"} for item in items):
        return None
    try:
        rect = fitz.Rect(drawing["rect"])
    except (KeyError, TypeError, ValueError):
        return None
    if (not all(_finite(value) for value in rect) or not 0 <= rect.x0 < rect.x1 <= width
            or not 0 <= rect.y0 < rect.y1 <= height or min(rect.width, rect.height) > 2):
        return None
    if rect.width >= rect.height:
        candidates = _axis_line(rect.x0, (rect.y0 + rect.y1) / 2, rect.x1, (rect.y0 + rect.y1) / 2, width, height)
    else:
        candidates = _axis_line((rect.x0 + rect.x1) / 2, rect.y0, (rect.x0 + rect.x1) / 2, rect.y1, width, height)
    return (candidates[0], rect) if candidates else None


def _visible_filled_rules(page: Any, candidates: list[tuple[_Line, Any]]) -> list[_Line]:
    """Require continuous visible ink, including clipping and later overlays."""
    if not candidates:
        return []
    if len(candidates) > MAX_FILLED_RULES:
        raise _BudgetExceeded
    # Reuse one display list instead of parsing every drawing for every rule.
    displayed = page.get_displaylist()
    result = []
    for line, rect in candidates:
        if (math.ceil(rect.width * 2) + 1) * (math.ceil(rect.height * 2) + 1) > 32768:
            continue
        pixmap = displayed.get_pixmap(matrix=fitz.Matrix(2, 2), clip=rect, colorspace=fitz.csGRAY, alpha=False)
        width, height, samples = pixmap.width, pixmap.height, pixmap.samples
        if not width or not height or width * height > 32768:
            continue
        if line.orientation == "h":
            ink = sum(any(samples[y * pixmap.stride + x] < 120 for y in range(height)) for x in range(width))
            length = width
        else:
            ink = sum(any(samples[y * pixmap.stride + x] < 120 for x in range(width)) for y in range(height))
            length = height
        if ink >= length * .98:
            result.append(line)
    return result


def _drawing_lines(page: Any, width: float, height: float) -> list[_Line]:
    try:
        page = visible_page(page)
        drawings = page.get_drawings()
    except (AttributeError, TypeError, ValueError, RuntimeError):
        raise ValueError("drawing geometry is unavailable") from None

    lines: list[_Line] = []
    filled_rules = []
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
        if (filled := _filled_rule(drawing, width, height)) is not None:
            filled_rules.append(filled)
        # Filled table rules must pass rendered visibility checks below;
        # background fills never contribute their bounding rectangle edges.
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

    lines.extend(_visible_filled_rules(page, filled_rules))
    lines.extend(_bitmap_horizontal_lines(page, width, height))
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


def _bitmap_horizontal_lines(page: Any, width: float, height: float) -> list[_Line]:
    """Verify thin image rules from visible pixels, including transparency.

    Some banks embed their table rules as tiny bitmaps. A wide image rectangle
    alone is insufficient evidence: only an unrotated, page-contained, nearly
    full-width dark pixel row contributes the same geometry as a drawn rule.
    Rendering the small placement also respects masks and overlaid content.
    """
    if not hasattr(page, "get_images"):
        return []
    images = page.get_images(full=True)
    if len(images) > MAX_BITMAP_IMAGES:
        raise _BudgetExceeded
    unique_images = {item[0]: item for item in images}
    result: list[_Line] = []
    placements_seen = set()
    for xref, item in unique_images.items():
        pixel_width, pixel_height = item[2:4]
        if not (100 <= pixel_width <= 4096 and 1 <= pixel_height <= 8
                and pixel_width / pixel_height >= 64):
            continue
        placements = page.get_image_rects(xref, transform=True)
        if len(placements) > MAX_BITMAP_PLACEMENTS:
            raise _BudgetExceeded
        for rectangle, transform in placements:
            coordinates = tuple(float(value) for value in rectangle)
            matrix = tuple(float(value) for value in transform)
            if not all(_finite(value) for value in (*coordinates, *matrix)):
                raise ValueError("bitmap rule geometry is invalid")
            x0, y0, x1, y1 = coordinates
            if not (matrix[0] > 0 and matrix[3] > 0
                    and abs(matrix[1]) < 0.001 and abs(matrix[2]) < 0.001
                    and 0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height
                    and x1 - x0 >= width * _MIN_HORIZONTAL_LINE and y1 - y0 <= 3):
                continue
            key = (xref, coordinates)
            if key in placements_seen:
                continue
            placements_seen.add(key)
            if len(placements_seen) > MAX_BITMAP_PLACEMENTS:
                raise _BudgetExceeded
            scale = min(pixel_width / (x1 - x0), 2048 / (x1 - x0), 2.0)
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=rectangle,
                                      colorspace=fitz.csRGB, alpha=False)
            if not (100 <= pixmap.width <= 2050 and 1 <= pixmap.height <= 8):
                continue
            pixels = pixmap.samples
            dark_rows = []
            for row in range(pixmap.height):
                dark = [column for column in range(pixmap.width)
                        if max(pixels[row * pixmap.stride + column * 3:
                                      row * pixmap.stride + column * 3 + 3]) < 120]
                if len(dark) >= pixmap.width * 0.98:
                    dark_rows.append(row)
            if dark_rows:
                y = min(y1, max(y0, (pixmap.y + sum(dark_rows) / len(dark_rows) + 0.5) / scale))
                result.append(_Line("h", x0, y, x1, y))
    return result


def _frame_rectangles(
    lines: list[_Line],
    width: float,
    height: float,
) -> list[tuple[float, float, float, float]]:
    """Assemble bounded four-sided visual frames from drawing lines.

    These frames are layout evidence only.  A frame is useful for a receipt
    boundary when its four edges are present, large enough to be a receipt,
    and its dimensions are within the same conservative range used by the
    candidate detector.  The small pair budget keeps malformed drawing lists
    fail-closed rather than turning this descriptor into an unbounded search.
    """

    tolerance = _LINE_TOLERANCE
    minimum_width = max(_MIN_LINE_LENGTH, width * _VISUAL_BOUNDARY_MIN_WIDTH_RATIO)
    minimum_height = height * _VISUAL_BOUNDARY_MIN_HEIGHT_RATIO
    maximum_height = height * _VISUAL_BOUNDARY_MAX_HEIGHT_RATIO
    horizontals = [
        line for line in lines
        if line.orientation == "h" and line.x1 - line.x0 >= minimum_width - tolerance * 2
    ]
    verticals = [
        line for line in lines
        if line.orientation == "v"
        and minimum_height - tolerance <= line.y1 - line.y0 <= maximum_height + tolerance
    ]
    if (
        len(horizontals) > MAX_FRAME_EDGES_PER_ORIENTATION
        or len(verticals) > MAX_FRAME_EDGES_PER_ORIENTATION
    ):
        raise _BudgetExceeded

    def connecting_vertical(
        x: float,
        top: float,
        bottom: float,
    ) -> _Line | None:
        candidates = [
            line for line in verticals
            if (
                abs(line.x0 - x) <= tolerance
                and abs(line.y0 - top) <= tolerance
                and abs(line.y1 - bottom) <= tolerance
            )
        ]
        if not candidates:
            return None
        candidates.sort(
            key=lambda line: (
                abs(line.x0 - x) + abs(line.y0 - top) + abs(line.y1 - bottom),
                line.x0,
                line.y0,
                line.y1,
            )
        )
        return candidates[0]

    rectangles: list[tuple[float, float, float, float]] = []
    pair_comparisons = 0
    for first_index, first in enumerate(horizontals):
        for second in horizontals[first_index + 1:]:
            pair_comparisons += 1
            if pair_comparisons > MAX_FRAME_EDGES_PER_ORIENTATION * MAX_FRAME_EDGES_PER_ORIENTATION:
                raise _BudgetExceeded
            top, bottom = sorted((first, second), key=lambda line: line.y0)
            if bottom.y0 - top.y0 < minimum_height - tolerance:
                continue
            if bottom.y0 - top.y0 > maximum_height + tolerance:
                continue
            if abs(top.x0 - bottom.x0) > tolerance or abs(top.x1 - bottom.x1) > tolerance:
                continue
            left = connecting_vertical(top.x0, top.y0, bottom.y0)
            right = connecting_vertical(top.x1, top.y0, bottom.y0)
            if left is None or right is None or right.x0 <= left.x0:
                continue
            rectangle = (
                (top.x0 + bottom.x0 + left.x0 + left.x0) / 4,
                (top.y0 + top.y0 + left.y0 + right.y0) / 4,
                (top.x1 + bottom.x1 + right.x0 + right.x0) / 4,
                (bottom.y0 + bottom.y0 + left.y1 + right.y1) / 4,
            )
            if not (
                0 <= rectangle[0] < rectangle[2] <= width
                and 0 <= rectangle[1] < rectangle[3] <= height
                and rectangle[2] - rectangle[0] >= minimum_width - tolerance * 2
                and minimum_height - tolerance <= rectangle[3] - rectangle[1] <= maximum_height + tolerance
            ):
                continue
            if any(
                all(abs(existing - current) <= tolerance for existing, current in zip(previous, rectangle))
                for previous in rectangles
            ):
                continue
            if len(rectangles) >= MAX_FRAME_EDGES_PER_ORIENTATION:
                raise _BudgetExceeded
            rectangles.append(rectangle)
    return rectangles


def _large_image_rectangles(
    page: Any,
    width: float,
    height: float,
) -> list[tuple[float, float, float, float]]:
    """Read only large image geometry that can represent one complete copy."""

    try:
        entries = page.get_bboxlog()
    except (AttributeError, TypeError, ValueError, RuntimeError):
        return []
    if len(entries) > MAX_VISIBLE_OBJECT_BUDGET:
        raise _BudgetExceeded
    minimum_width = max(_MIN_LINE_LENGTH, width * _VISUAL_BOUNDARY_MIN_WIDTH_RATIO)
    minimum_height = height * _VISUAL_BOUNDARY_MIN_HEIGHT_RATIO
    maximum_height = height * _VISUAL_BOUNDARY_MAX_HEIGHT_RATIO
    rectangles: list[tuple[float, float, float, float]] = []
    for entry in entries:
        if not isinstance(entry, (list, tuple)) or len(entry) < 2 or entry[0] != "fill-image":
            continue
        box = entry[1]
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            return []
        try:
            x0, y0, x1, y1 = (float(value) for value in box)
        except (TypeError, ValueError, OverflowError):
            return []
        left, right = sorted((x0, x1))
        top, bottom = sorted((y0, y1))
        if not all(_finite(value) for value in (left, top, right, bottom)):
            return []
        if (
            right - left < minimum_width - _LINE_TOLERANCE * 2
            or not minimum_height - _LINE_TOLERANCE <= bottom - top <= maximum_height + _LINE_TOLERANCE
            or left < 0
            or top < 0
            or right > width
            or bottom > height
        ):
            continue
        rectangle = (left, top, right, bottom)
        if any(
            all(abs(existing - current) <= _LINE_TOLERANCE for existing, current in zip(previous, rectangle))
            for previous in rectangles
        ):
            continue
        rectangles.append(rectangle)
    return rectangles


def _rectangle_iou(
    first: tuple[float, float, float, float],
    second: tuple[float, float, float, float],
) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    first_area = max(0.0, first[2] - first[0]) * max(0.0, first[3] - first[1])
    second_area = max(0.0, second[2] - second[0]) * max(0.0, second[3] - second[1])
    union = first_area + second_area - intersection
    return intersection / union if union > 0 else 0.0


def _visual_layout_rectangles(
    page: Any,
    lines: list[_Line],
    width: float,
    height: float,
) -> list[tuple[float, float, float, float]]:
    """Combine complete frame/image rectangles without counting duplicates."""

    # Frames take precedence over the nearly identical raster image they may
    # surround.  Both sources remain optional; a partial visual signal never
    # overrides the ordinary text evidence by itself.
    rectangles = [
        *[("frame", rectangle) for rectangle in _frame_rectangles(lines, width, height)],
        *[("image", rectangle) for rectangle in _large_image_rectangles(page, width, height)],
    ]
    unique: list[tuple[float, float, float, float]] = []
    for kind, rectangle in rectangles:
        if any(_rectangle_iou(rectangle, existing) >= _VISUAL_BOUNDARY_IOU for existing in unique):
            continue
        unique.append(rectangle)
    return unique


def _visual_empty_gap(
    page: Any,
    lower: float,
    upper: float,
) -> tuple[float, float] | None:
    """Find an actual empty interval between two visual copy containers."""

    if not (_finite(lower) and _finite(upper) and lower < upper):
        return None
    try:
        entries = page.get_bboxlog()
    except (AttributeError, TypeError, ValueError, RuntimeError):
        return (lower, upper)
    if len(entries) > MAX_VISIBLE_OBJECT_BUDGET:
        raise _BudgetExceeded
    blocked: list[tuple[float, float]] = []
    for entry in entries:
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            return None
        if entry[0] in {"fill-text", "stroke-text", "ignore-text"}:
            continue
        box = entry[1]
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            return None
        try:
            y0, y1 = float(box[1]), float(box[3])
        except (TypeError, ValueError, OverflowError):
            return None
        if not all(_finite(value) for value in (y0, y1)):
            return None
        # PyMuPDF can report an empty clipping path with reversed sentinel
        # coordinates.  It is not visible content and mirrors the existing
        # boundary check, which only treats ordered boxes as occupied.
        if y1 <= y0:
            continue
        clipped_start = max(lower, y0)
        clipped_end = min(upper, y1)
        if clipped_start < clipped_end:
            blocked.append((clipped_start, clipped_end))
    blocked.sort()
    free: list[tuple[float, float]] = []
    cursor = lower
    for start, end in blocked:
        if start > cursor:
            free.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < upper:
        free.append((cursor, upper))
    usable = [
        gap for gap in free
        if gap[1] - gap[0] >= _VISUAL_BOUNDARY_MIN_EMPTY_GAP
    ]
    return max(usable, key=lambda gap: (gap[1] - gap[0], -gap[0])) if usable else None


def _visual_gap_boundaries(
    page: Any,
    titles: list[_Title],
    lines: list[_Line],
    width: float,
    height: float,
    last_text_y: list[float],
    heading_starts: list[float],
) -> list[float] | None:
    """Use visual gaps only inside the text-proven safe interval.

    A frame gap can be wider than the text-derived receipt interval. Keep any
    current-receipt footer before the boundary and keep the next receipt's
    masthead (including an image-backed masthead) after it.
    """

    if len(titles) < 2:
        return None
    if len(last_text_y) != len(titles) or len(heading_starts) != len(titles):
        raise ValueError("visual boundary text constraints are invalid")
    rectangles = _visual_layout_rectangles(page, lines, width, height)
    if not rectangles:
        return None

    matched: list[tuple[float, float, float, float]] = []
    tolerance = _LINE_TOLERANCE
    for title in titles:
        containing = [
            rectangle for rectangle in rectangles
            if (
                rectangle[0] - tolerance <= title.x0
                and title.x1 <= rectangle[2] + tolerance
                and rectangle[1] - tolerance <= title.y0
                and title.y1 <= rectangle[3] + tolerance
            )
        ]
        if len(containing) > 1:
            raise ValueError("visual receipt frames overlap")
        if not containing:
            # A visual object may be incidental; only use the visual path
            # when every title has exactly one complete visual container.
            return None
        matched.append(containing[0])

    boundaries = [0.0]
    for index, (current, following) in enumerate(zip(matched[:-1], matched[1:], strict=True)):
        current_width = current[2] - current[0]
        following_width = following[2] - following[0]
        current_height = current[3] - current[1]
        following_height = following[3] - following[1]
        if (
            following[1] - current[3] <= tolerance
            or abs(current[0] - following[0]) > _VISUAL_BOUNDARY_DIMENSION_TOLERANCE
            or abs(current[2] - following[2]) > _VISUAL_BOUNDARY_DIMENSION_TOLERANCE
            or abs(current_width - following_width) > _VISUAL_BOUNDARY_DIMENSION_TOLERANCE
            or abs(current_height - following_height) > _VISUAL_BOUNDARY_DIMENSION_TOLERANCE
        ):
            raise ValueError("visual receipt frame gap is ambiguous")
        if not (_finite(last_text_y[index]) and _finite(heading_starts[index + 1])):
            raise ValueError("visual boundary text constraints are invalid")
        lower = max(current[3], float(last_text_y[index]))
        upper = min(following[1], float(heading_starts[index + 1]))
        if not _finite(lower) or not _finite(upper) or lower >= upper:
            raise ValueError("visual receipt frame gap is outside text bounds")
        empty_gap = _visual_empty_gap(page, lower, upper)
        if empty_gap is None:
            raise ValueError("visual receipt frame gap is occupied")
        boundary = (empty_gap[0] + empty_gap[1]) / 2
        if not _finite(boundary) or not boundaries[-1] < boundary < height:
            raise ValueError("visual receipt boundaries are ambiguous")
        boundaries.append(boundary)
    boundaries.append(height)
    return boundaries


def _last_text_y_by_title(
    parsed: ParsedPage,
    titles: list[_Title],
    height: float,
    heading_starts: list[float] | None = None,
    line_boxes: list[tuple[str, tuple[float, float, float, float]]] | None = None,
    assigned_print_count_lines: set[tuple[float, float, float, float]] | None = None,
) -> list[float]:
    blocks = [block for block in parsed.blocks if not block.is_watermark]
    last_text_y: list[float] = []
    for index, title in enumerate(titles):
        next_y = (heading_starts[index + 1] if heading_starts else titles[index + 1].y0) if index + 1 < len(titles) else height
        maximum_values: list[float] = []
        for block in blocks:
            if not (title.y0 <= block.y0 < next_y):
                continue
            if (
                block.y0 >= height * 0.9
                and block.y1 <= height
                and block.x1 - block.x0 <= parsed.width * 0.45
            ):
                continue

            if line_boxes is None:
                maximum_values.append(float(block.y1))
                continue

            contained_lines = [
                (text, box)
                for text, box in line_boxes
                if (
                    block.x0 - 1.5 <= box[0]
                    and box[2] <= block.x1 + 1.5
                    and block.y0 - 1.5 <= box[1]
                    and box[3] <= block.y1 + 1.5
                )
            ]
            marker_lines = [
                box for _text, box in contained_lines
                if assigned_print_count_lines is not None
                and box in assigned_print_count_lines
            ]
            if not marker_lines:
                maximum_values.append(float(block.y1))
                continue

            # A marker may share one raw PDF block with the next title.  Use
            # line boxes to retain any preceding body lines while excluding
            # the marker and all lines at/after the next title boundary.
            maximum_values.extend(
                float(box[3])
                for text, box in contained_lines
                if not _is_print_count_line(text) and box[1] < next_y
            )

        maximum = max(maximum_values, default=title.y1)
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

    # The parser has already identified repeated/diagonal watermark blocks.
    # Do not let a line from the same block re-enter as an issuer masthead:
    # a bank watermark above a title would move its protected start into the
    # preceding receipt. Match exact geometry and text, never mere overlap.
    watermark_lines = {
        (_normalize_title_line(block.text), (block.x0, block.y0, block.x1, block.y1))
        for block in parsed.blocks if block.is_watermark
    }
    text_lines = [item for item in _dict_title_boxes(page, titles_only=False) if item not in watermark_lines]
    text_issuer_names = [
        _issuer_bank_name(title, text_lines, titles[index - 1].y1 if index else 0.0)
        for index, title in enumerate(titles)
    ]
    image_regions = [
        (
            max(titles[index - 1].y1 if index else 0.0, title.y0 - 64.0),
            title.y1,
        )
        for index, (title, issuer_name) in enumerate(zip(titles, text_issuer_names, strict=True))
        if issuer_name is None
    ]
    if image_regions:
        text_lines = [*text_lines, *image_masthead_lines(page, image_regions, text_lines)]
    issuer_names = [
        _issuer_bank_name(title, text_lines, titles[index - 1].y1 if index else 0.0)
        for index, title in enumerate(titles)
    ]
    issuer_keys = [
        hashlib.sha256(name.encode("utf-8")).hexdigest() if name else None
        for name in issuer_names
    ]
    assigned_print_count_lines, print_count_starts = _print_count_prefixes(titles, text_lines)
    header_fields = _receipt_header_fields(titles, issuer_keys, text_lines)
    # A standalone issuer masthead belongs to the following receipt. Using
    # its title alone as the next start would count that masthead as the
    # previous receipt's last body line and cut it out of the protection box.
    heading_starts = []
    for index, title in enumerate(titles):
        matching_headers = [
            box[1] for text, box in text_lines
            if issuer_keys[index] is not None
            and max(titles[index - 1].y1 if index else 0.0, title.y0 - 64.0) <= box[1] <= title.y0
            and box[3] <= title.y1 + 3.0
            and (bank := issuer_masthead_bank(text, box, text_lines)) is not None
            and hashlib.sha256(bank.encode("utf-8")).hexdigest() == issuer_keys[index]
        ]
        starts = [*matching_headers, *(box[1] for _label, box in header_fields[index])]
        if print_count_starts[index] is not None:
            starts.append(print_count_starts[index])
        heading_starts.append(min(starts, default=title.y0))
    last_text_y = _last_text_y_by_title(
        parsed, titles, height, heading_starts, text_lines or None,
        assigned_print_count_lines,
    )
    visual_boundaries = _visual_gap_boundaries(
        page, titles, lines, width, height, last_text_y, heading_starts,
    )
    if len(horizontal_lines) < _MIN_HORIZONTAL_LINES and visual_boundaries is None:
        return _unavailable(_AMBIGUOUS_LAYOUT)
    boundaries = [0.0]
    for index in range(len(titles) - 1):
        boundary = (last_text_y[index] + heading_starts[index + 1]) / 2
        last_rule = max((
            line.y0 for line in horizontal_lines
            if titles[index].y1 <= line.y0 < heading_starts[index + 1]
        ), default=last_text_y[index])
        if (heading_starts[index + 1] < titles[index + 1].y0
                and abs(last_rule - boundary) <= _LINE_TOLERANCE):
            boundary = (last_rule + heading_starts[index + 1]) / 2
        if not _finite(boundary) or not (boundaries[-1] < boundary < height):
            raise ValueError("receipt boundaries are ambiguous")
        boundaries.append(boundary)
    boundaries.append(height)
    if visual_boundaries is not None:
        boundaries = visual_boundaries
    elif _visible_objects_cross_boundaries(page, boundaries):
        # A thin bitmap divider can occupy the text midpoint. Move only within
        # the same text-proven gap to an actually empty interval. Stamps, tall
        # images, curves and other crossing objects remain ambiguous.
        for kind, box, *_rest in page.get_bboxlog():
            if kind in {"fill-text", "stroke-text", "ignore-text"}:
                continue
            if any(box[1] < boundary < box[3] for boundary in boundaries[1:-1]):
                if not (kind == "fill-image" and box[2] - box[0] >= width * 0.7
                        and 0 < box[3] - box[1] <= 12):
                    return _unavailable(_AMBIGUOUS_LAYOUT)
        for index in range(len(titles) - 1):
            empty_gap = _visual_empty_gap(page, last_text_y[index], heading_starts[index + 1])
            if empty_gap is None:
                return _unavailable(_AMBIGUOUS_LAYOUT)
            boundaries[index + 1] = (empty_gap[0] + empty_gap[1]) / 2
    if _visible_objects_cross_boundaries(page, boundaries):
        return _unavailable(_AMBIGUOUS_LAYOUT)

    # A line in each inter-title gap is the minimum table evidence needed to
    # explain the vertical partition.  Complete, one-to-one visual copies
    # provide the same evidence for image-backed pages; straight lines outside
    # the gaps still participate in the fingerprint, but cannot establish a
    # boundary alone.
    if visual_boundaries is None:
        for index in range(len(titles) - 1):
            lower = titles[index].y1
            upper = titles[index + 1].y0
            if not any(lower <= line.y0 <= upper for line in horizontal_lines):
                return _unavailable(_AMBIGUOUS_LAYOUT)

    for boundary in boundaries[1:-1]:
        if any(block.y0 < boundary < block.y1 for block in parsed.blocks if not block.is_watermark):
            return _unavailable(_AMBIGUOUS_LAYOUT)

    receipts = []
    for index, title in enumerate(titles):
        issuer_key = issuer_keys[index]
        receipts.append({
            "anchor_y": float(title.y0),
            "bounds": {
                "x0": 0.0,
                "y0": float(boundaries[index]),
                "x1": float(width),
                "y1": float(boundaries[index + 1]),
            },
            "title_key": title.title_key,
            "issuer_bank_key": issuer_key,
            "issuer_bank_name": issuer_names[index],
            "template_fingerprint": _receipt_fingerprint(
                title, issuer_key, lines, text_lines, boundaries[index], boundaries[index + 1], width, height,
                header_fields[index],
            ),
        })
    result = {
        "status": "ready",
        "fingerprint": _fingerprint(width, height, titles, lines),
        "receipts": receipts,
    }
    frames = None
    if all(title.title_text.startswith("客户回单") for title in titles):
        try:
            frames = _frame_rectangles(lines, width, height)
        except _BudgetExceeded:
            pass  # Optional visual identity must not invalidate a descriptor.
    visual_form = describe_visual_form(page, titles, frames=frames, text_lines=text_lines)
    if visual_form is not None:
        result["layout_compatibility"] = visual_form
    return result


def describe_crop_page(page: Any) -> dict[str, object]:
    """Describe one loaded PDF page for batch crop planning.

    The return value is exactly the ``crop_template`` member of the engine
    protocol.  Page dimensions, page number, source hash, and page count are
    added by :func:`engine.engine._analyze_page_response` at the IPC boundary.
    """

    try:
        page = visible_page(page)
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
