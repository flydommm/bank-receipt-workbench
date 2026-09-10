"""Heuristics for finding repeated receipt-like regions on a page."""

from __future__ import annotations

from bisect import bisect_left
from contextlib import contextmanager
from dataclasses import dataclass, replace
import hashlib
from pathlib import Path
import re
import statistics
from typing import Any, Iterable, Iterator, TypeVar

from .pdf_parser import ParsedPage, TextBlock


MAX_LAYOUT_DRAWINGS = 4_096
MAX_LAYOUT_DRAWING_ITEMS = 16_384
MAX_SEPARATOR_SEGMENTS = 4_096
MAX_FRAME_EDGES_PER_ORIENTATION = 128
MAX_FRAME_ANCHORS = 64
MAX_PAGE_IMAGES = 2_048
MAX_IMAGE_RECTS = 4_096
MAX_VISUAL_ANCHORS = 1_024
MAX_TEXT_BLOCKS = 4_096
MAX_RECEIPT_TITLES = 128
MAX_TEXT_BLOCK_CHARACTERS = 16_384

_T = TypeVar("_T")


class LayoutBudgetExceeded(RuntimeError):
    """Signal that optional visual analysis exceeded its safe work budget."""


# Keep the old private name as a compatibility alias for callers/tests that
# imported it before the budget state became part of the public engine contract.
_LayoutBudgetExceeded = LayoutBudgetExceeded


def _bounded_tuple(values: Iterable[_T], limit: int) -> tuple[_T, ...] | None:
    """Materialize at most ``limit`` values, consuming only one extra item."""

    result: list[_T] = []
    for value in values:
        if len(result) >= limit:
            return None
        result.append(value)
    return tuple(result)


@dataclass(frozen=True)
class Rect:
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass(frozen=True)
class LayoutCandidate:
    rect: Rect
    confidence: float
    block_count: int
    reason: str


@dataclass(frozen=True)
class ReceiptCandidate:
    rect: Rect
    confidence: float
    slot: str
    evidence: tuple[str, ...]


def _mark_layout_budget_exceeded(
    candidates: Iterable[ReceiptCandidate],
) -> list[ReceiptCandidate]:
    """Make budget-limited candidates ineligible for automatic confirmation."""

    marked: list[ReceiptCandidate] = []
    for candidate in candidates:
        evidence = tuple(dict.fromkeys((*candidate.evidence, "layout_budget_exceeded")))
        marked.append(
            ReceiptCandidate(
                candidate.rect,
                round(min(0.89, max(0.0, float(candidate.confidence))), 3),
                candidate.slot,
                evidence,
            )
        )
    return marked


@dataclass(frozen=True)
class HorizontalSeparator:
    y: float
    x0: float
    x1: float


@dataclass(frozen=True)
class VisualAnchor:
    """A non-text visual element that helps preserve receipt boundaries."""

    kind: str
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass(frozen=True)
class _ReceiptBoundaryContext:
    previous_title_y: float
    next_title_y: float | None
    next_raw_visual_start: float | None
    lower: float
    title_gap: float | None


@dataclass(frozen=True)
class _ReceiptDetectionContext:
    titles: tuple[TextBlock, ...]
    slots: tuple[str, ...]
    leading_anchor_groups: tuple[tuple[VisualAnchor, ...], ...]
    raw_visual_starts: tuple[float, ...]
    frame_segments: tuple[tuple[TextBlock, ...], ...]
    associated_frames: tuple[VisualAnchor | None, ...]


@dataclass(frozen=True)
class _ReceiptFallbackContext:
    slot_anchors: tuple[VisualAnchor, ...]
    cross_boundary_anchors: tuple[VisualAnchor, ...]
    segment_blocks: tuple[TextBlock, ...]
    content_rect: Rect
    content_y1: float


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(value, upper))


def clamp_rect(
    rect: Rect,
    width: float,
    height: float,
    min_width: float = 24,
    min_height: float = 24,
    max_y1: float | None = None,
) -> Rect:
    y_limit = height if max_y1 is None else _clamp(float(max_y1), 0.0, height)
    effective_min_height = min(min_height, y_limit)
    x0 = _clamp(min(rect.x0, rect.x1), 0, max(0, width - min_width))
    y0 = _clamp(
        min(rect.y0, rect.y1),
        0,
        max(0, y_limit - effective_min_height),
    )
    x1 = _clamp(max(rect.x0, rect.x1), x0 + min_width, width)
    y1 = _clamp(
        max(rect.y0, rect.y1),
        y0 + effective_min_height,
        y_limit,
    )
    return Rect(x0, y0, x1, y1)


def layout_fingerprint(page: ParsedPage) -> str:
    """Return a stable fingerprint based on geometry, not sensitive text."""

    geometry = [f"{page.width:.1f}x{page.height:.1f}"]
    for block in page.blocks:
        geometry.append(
            f"{block.x0 / page.width:.3f},{block.y0 / page.height:.3f},"
            f"{block.x1 / page.width:.3f},{block.y1 / page.height:.3f}"
        )
    return hashlib.sha1("|".join(geometry).encode("ascii")).hexdigest()


def _points_within_tolerance(
    first: tuple[float, float], second: tuple[float, float], tolerance: float
) -> bool:
    return (
        abs(first[0] - second[0]) <= tolerance
        and abs(first[1] - second[1]) <= tolerance
    )


def _deduplicate_frame_edges(
    edges: Iterable[tuple[tuple[float, float], tuple[float, float]]],
) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    unique: list[tuple[tuple[float, float], tuple[float, float]]] = []
    seen: set[tuple[float, ...]] = set()
    for edge in edges:
        key = tuple(round(coordinate, 4) for point in edge for coordinate in point)
        if key in seen:
            continue
        seen.add(key)
        unique.append(edge)
    return unique


def _find_connecting_vertical(
    verticals: Iterable[tuple[tuple[float, float], tuple[float, float]]],
    top_corner: tuple[float, float],
    bottom_corner: tuple[float, float],
    tolerance: float,
) -> tuple[tuple[float, float], tuple[float, float]] | None:
    best: tuple[tuple[float, float], tuple[float, float]] | None = None
    best_error = float("inf")
    for edge in verticals:
        if not (
            _points_within_tolerance(edge[0], top_corner, tolerance)
            and _points_within_tolerance(edge[1], bottom_corner, tolerance)
        ):
            continue
        error = sum(
            abs(actual - expected)
            for actual, expected in zip(
                edge[0] + edge[1], top_corner + bottom_corner
            )
        )
        if error < best_error:
            best = edge
            best_error = error
    return best


@contextmanager
def _layout_page(pdf_path: str | Path, page_number: int, loaded_page: Any = None) -> Iterator[Any]:
    """Borrow an internal worker page or own a short-lived compatibility PDF."""
    if loaded_page is not None:
        if loaded_page.number != page_number - 1:
            raise ValueError("loaded page number does not match the requested page")
        yield loaded_page
        return
    try:
        import pymupdf
    except ImportError:  # pragma: no cover
        import fitz as pymupdf  # type: ignore[no-redef]
    document = pymupdf.open(str(pdf_path))
    try:
        yield document.load_page(page_number - 1)
    finally:
        document.close()


def extract_separators(
    pdf_path: str | Path, page_number: int, *, loaded_page: Any = None,
) -> list[HorizontalSeparator]:
    """Read long horizontal lines and rectangle edges from one PDF page."""
    with _layout_page(pdf_path, page_number, loaded_page) as page:
        separators: list[HorizontalSeparator] = []
        drawing_items = 0
        try:
            for drawing_index, drawing in enumerate(page.get_drawings(), start=1):
                if drawing_index > MAX_LAYOUT_DRAWINGS:
                    raise _LayoutBudgetExceeded
                for item in drawing.get("items", []):
                    drawing_items += 1
                    if drawing_items > MAX_LAYOUT_DRAWING_ITEMS:
                        raise _LayoutBudgetExceeded
                    if item[0] == "l":
                        start, end = item[1], item[2]
                        if abs(start.y - end.y) <= 2:
                            if len(separators) >= MAX_SEPARATOR_SEGMENTS:
                                raise _LayoutBudgetExceeded
                            separators.append(
                                HorizontalSeparator(
                                    (float(start.y) + float(end.y)) / 2,
                                    min(float(start.x), float(end.x)),
                                    max(float(start.x), float(end.x)),
                                )
                            )
                    elif item[0] == "re":
                        if len(separators) + 2 > MAX_SEPARATOR_SEGMENTS:
                            raise _LayoutBudgetExceeded
                        rect = item[1]
                        x0, x1 = sorted((float(rect.x0), float(rect.x1)))
                        y0, y1 = sorted((float(rect.y0), float(rect.y1)))
                        separators.extend(
                            (
                                HorizontalSeparator(y0, x0, x1),
                                HorizontalSeparator(y1, x0, x1),
                            )
                        )
        except LayoutBudgetExceeded:
            raise
        return [
            separator
            for separator in _merge_horizontal_separators(separators)
            if separator.x1 - separator.x0 >= page.rect.width * 0.35
        ]


def _matching_separator_groups(
    groups: list[tuple[float, float, float, float]],
    item: HorizontalSeparator,
    y_tolerance: float,
    gap_tolerance: float,
) -> list[int]:
    return [
        index
        for index, (group_y0, group_y1, group_x0, group_x1) in enumerate(groups)
        if (
            max(group_y1, item.y) - min(group_y0, item.y) <= y_tolerance
            and item.x0 <= group_x1 + gap_tolerance
            and item.x1 >= group_x0 - gap_tolerance
        )
    ]


def _merge_separator_groups(
    groups: list[tuple[float, float, float, float]],
    item: HorizontalSeparator,
    matching_indices: list[int],
) -> list[tuple[float, float, float, float]]:
    matched_groups = [groups[index] for index in matching_indices]
    retained = [
        group for index, group in enumerate(groups) if index not in matching_indices
    ]
    retained.append(
        (
            min(item.y, *(group[0] for group in matched_groups)),
            max(item.y, *(group[1] for group in matched_groups)),
            min(item.x0, *(group[2] for group in matched_groups)),
            max(item.x1, *(group[3] for group in matched_groups)),
        )
    )
    return retained


def _merge_horizontal_separators(
    separators: Iterable[HorizontalSeparator],
    *,
    y_tolerance: float = 0.75,
    gap_tolerance: float = 2.0,
) -> list[HorizontalSeparator]:
    """Merge collinear horizontal drawing fragments before width filtering."""

    pending = sorted(
        (
            HorizontalSeparator(
                float(item.y),
                min(float(item.x0), float(item.x1)),
                max(float(item.x0), float(item.x1)),
            )
            for item in separators
        ),
        key=lambda item: (item.y, item.x0, item.x1),
    )
    # Keep the original y range for each group.  Comparing a new fragment
    # with a running representative can chain 0.75pt steps into a group whose
    # first and last edges are no longer within tolerance.
    groups: list[tuple[float, float, float, float]] = []
    for item in pending:
        matching_indices = _matching_separator_groups(
            groups,
            item,
            y_tolerance,
            gap_tolerance,
        )
        if not matching_indices:
            groups.append((item.y, item.y, item.x0, item.x1))
            continue
        groups = _merge_separator_groups(groups, item, matching_indices)
    return sorted(
        (
            HorizontalSeparator(group_y1, group_x0, group_x1)
            for group_y0, group_y1, group_x0, group_x1 in groups
        ),
        key=lambda item: (item.y, item.x0, item.x1),
    )


def _collect_frame_edges(
    page: object,
    min_width: float,
    min_height: float,
    max_height: float,
    tolerance: float,
) -> tuple[
    list[tuple[tuple[float, float], tuple[float, float]]],
    list[tuple[tuple[float, float], tuple[float, float]]],
]:
    horizontals: list[tuple[tuple[float, float], tuple[float, float]]] = []
    verticals: list[tuple[tuple[float, float], tuple[float, float]]] = []
    drawing_items = 0
    for drawing_index, drawing in enumerate(  # type: ignore[attr-defined]
        page.get_drawings(), start=1
    ):
        if drawing_index > MAX_LAYOUT_DRAWINGS:
            raise _LayoutBudgetExceeded
        stroke_opacity = drawing.get("stroke_opacity")
        if (
            drawing.get("type") == "f"
            or drawing.get("color") is None
            or (stroke_opacity is not None and stroke_opacity <= 0)
        ):
            continue
        for item in drawing.get("items", []):
            drawing_items += 1
            if drawing_items > MAX_LAYOUT_DRAWING_ITEMS:
                raise _LayoutBudgetExceeded
            if item[0] == "l":
                start, end = item[1], item[2]
                start_x, start_y = float(start.x), float(start.y)
                end_x, end_y = float(end.x), float(end.y)
                if abs(start_y - end_y) <= tolerance:
                    left_endpoint, right_endpoint = sorted(
                        ((start_x, start_y), (end_x, end_y))
                    )
                    if right_endpoint[0] - left_endpoint[0] >= min_width - tolerance * 2:
                        if len(horizontals) >= MAX_FRAME_EDGES_PER_ORIENTATION:
                            raise _LayoutBudgetExceeded
                        horizontals.append((left_endpoint, right_endpoint))
                elif abs(start_x - end_x) <= tolerance:
                    top_endpoint, bottom_endpoint = sorted(
                        ((start_x, start_y), (end_x, end_y)), key=lambda point: point[1]
                    )
                    if min_height - tolerance <= bottom_endpoint[1] - top_endpoint[1] <= max_height + tolerance:
                        if len(verticals) >= MAX_FRAME_EDGES_PER_ORIENTATION:
                            raise _LayoutBudgetExceeded
                        verticals.append((top_endpoint, bottom_endpoint))
            elif item[0] == "re":
                rect = item[1]
                x0, x1 = sorted((float(rect.x0), float(rect.x1)))
                y0, y1 = sorted((float(rect.y0), float(rect.y1)))
                if x1 - x0 >= min_width - tolerance * 2:
                    if len(horizontals) + 2 > MAX_FRAME_EDGES_PER_ORIENTATION:
                        raise _LayoutBudgetExceeded
                    horizontals.extend((((x0, y0), (x1, y0)), ((x0, y1), (x1, y1))))
                if min_height - tolerance <= y1 - y0 <= max_height + tolerance:
                    if len(verticals) + 2 > MAX_FRAME_EDGES_PER_ORIENTATION:
                        raise _LayoutBudgetExceeded
                    verticals.extend((((x0, y0), (x0, y1)), ((x1, y0), (x1, y1))))
    return _deduplicate_frame_edges(horizontals), _deduplicate_frame_edges(verticals)


def _assemble_frame_edges(
    horizontals: list[tuple[tuple[float, float], tuple[float, float]]],
    verticals: list[tuple[tuple[float, float], tuple[float, float]]],
    min_width: float,
    min_height: float,
    max_height: float,
    tolerance: float,
) -> list[tuple[float, float, float, float]]:
    if (
        len(horizontals) > MAX_FRAME_EDGES_PER_ORIENTATION
        or len(verticals) > MAX_FRAME_EDGES_PER_ORIENTATION
    ):
        raise _LayoutBudgetExceeded
    frames: list[tuple[float, float, float, float]] = []
    for horizontal_index, horizontal_a in enumerate(horizontals):
        for horizontal_b in horizontals[horizontal_index + 1 :]:
            top, bottom = sorted(
                (horizontal_a, horizontal_b),
                key=lambda edge: (edge[0][1] + edge[1][1]) / 2,
            )
            top_y = (top[0][1] + top[1][1]) / 2
            bottom_y = (bottom[0][1] + bottom[1][1]) / 2
            if bottom_y <= top_y:
                continue
            left = _find_connecting_vertical(verticals, top[0], bottom[0], tolerance)
            right = _find_connecting_vertical(verticals, top[1], bottom[1], tolerance)
            if left is None or right is None or right[0][0] <= left[0][0]:
                continue
            frame = (
                (top[0][0] + bottom[0][0] + left[0][0] + left[1][0]) / 4,
                (top[0][1] + top[1][1] + left[0][1] + right[0][1]) / 4,
                (top[1][0] + bottom[1][0] + right[0][0] + right[1][0]) / 4,
                (bottom[0][1] + bottom[1][1] + left[1][1] + right[1][1]) / 4,
            )
            if (
                frame[2] - frame[0] < min_width
                or frame[3] - frame[1] < min_height
                or frame[3] - frame[1] > max_height
            ):
                continue
            if any(
                all(abs(existing - current) <= tolerance for existing, current in zip(previous, frame))
                for previous in frames
            ):
                continue
            if len(frames) >= MAX_FRAME_ANCHORS:
                raise _LayoutBudgetExceeded
            frames.append(frame)
    return frames


def extract_frame_anchors(
    pdf_path: str | Path, page_number: int, *, loaded_page: Any = None,
) -> list[VisualAnchor]:
    """Read sufficiently large, four-sided vector frames from one PDF page."""

    with _layout_page(pdf_path, page_number, loaded_page) as page:
        tolerance = 2.0
        min_width = page.rect.width * 0.70
        min_height = page.rect.height * 0.12
        max_height = page.rect.height * 0.50
        try:
            horizontals, verticals = _collect_frame_edges(
                page,
                min_width,
                min_height,
                max_height,
                tolerance,
            )
            frames = _assemble_frame_edges(
                horizontals,
                verticals,
                min_width,
                min_height,
                max_height,
                tolerance,
            )
        except LayoutBudgetExceeded:
            raise
        return [
            VisualAnchor("frame", *frame)
            for frame in sorted(frames, key=lambda frame: (frame[1], frame[0]))
        ]


def extract_visual_anchors(
    pdf_path: str | Path, page_number: int, *, loaded_page: Any = None,
) -> list[VisualAnchor]:
    """Extract image-backed geometry such as logos, seals and QR codes."""

    with _layout_page(pdf_path, page_number, loaded_page) as page:
        anchors: list[VisualAnchor] = []
        image_rect_count = 0
        images = page.get_images(full=True)
        if len(images) > MAX_PAGE_IMAGES:
            raise LayoutBudgetExceeded
        for image in images:
            for image_rect in page.get_image_rects(image):
                image_rect_count += 1
                if image_rect_count > MAX_IMAGE_RECTS:
                    raise LayoutBudgetExceeded
                anchor = _page_local_image_anchor(
                    float(image_rect.x0),
                    float(image_rect.y0),
                    float(image_rect.x1),
                    float(image_rect.y1),
                    float(page.rect.width),
                    float(page.rect.height),
                )
                if anchor is not None:
                    if len(anchors) >= MAX_VISUAL_ANCHORS:
                        raise LayoutBudgetExceeded
                    anchors.append(anchor)
        return anchors


def _page_local_image_anchor(
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    page_width: float,
    page_height: float,
) -> VisualAnchor | None:
    """Clip an image rectangle to the page and reject unusable backgrounds."""

    left = _clamp(min(float(x0), float(x1)), 0.0, float(page_width))
    top = _clamp(min(float(y0), float(y1)), 0.0, float(page_height))
    right = _clamp(max(float(x0), float(x1)), 0.0, float(page_width))
    bottom = _clamp(max(float(y0), float(y1)), 0.0, float(page_height))
    width = right - left
    height = bottom - top
    if width < 8.0 or height < 8.0:
        return None
    if width >= page_width * 0.85 and height >= page_height * 0.85:
        return None
    return VisualAnchor("image", left, top, right, bottom)


def infer_candidates(
    page: ParsedPage,
    *,
    margin: float = 8.0,
    separators: Iterable[HorizontalSeparator] = (),
) -> list[LayoutCandidate]:
    """Infer vertically separated receipt regions from text block geometry.

    This intentionally conservative heuristic is explainable and returns a
    low-confidence full-page candidate when there is not enough structure.
    """

    if len(page.blocks) > MAX_TEXT_BLOCKS:
        return [
            LayoutCandidate(
                Rect(0, 0, page.width, page.height),
                0.2,
                0,
                "layout budget exceeded",
            )
        ]
    blocks = sorted(page.blocks, key=lambda block: (block.y0, block.x0))
    if not blocks:
        return [LayoutCandidate(Rect(0, 0, page.width, page.height), 0.2, 0, "no text blocks")]

    heights = [max(1.0, block.y1 - block.y0) for block in blocks]
    typical_height = statistics.median(heights)
    groups: list[list[TextBlock]] = [[blocks[0]]]
    bounded_separators = _bounded_tuple(separators, MAX_SEPARATOR_SEGMENTS)
    if bounded_separators is None:
        return [
            LayoutCandidate(
                Rect(0, 0, page.width, page.height),
                0.2,
                0,
                "layout budget exceeded",
            )
        ]
    separator_ys = sorted(
        separator.y for separator in bounded_separators
    )
    for block in blocks[1:]:
        previous = groups[-1][-1]
        gap = block.y0 - previous.y1
        separator_index = bisect_left(separator_ys, previous.y1)
        line_between = (
            separator_index < len(separator_ys)
            and separator_ys[separator_index] <= block.y0
        )
        if line_between or gap > max(typical_height * 2.2, 12.0):
            groups.append([block])
        else:
            groups[-1].append(block)

    candidates: list[LayoutCandidate] = []
    for group in groups:
        rect = clamp_rect(
            Rect(
                min(block.x0 for block in group) - margin,
                min(block.y0 for block in group) - margin,
                max(block.x1 for block in group) + margin,
                max(block.y1 for block in group) + margin,
            ),
            page.width,
            page.height,
        )
        density = min(1.0, len(group) / 8)
        confidence = round(0.55 + density * 0.3 + (0.1 if len(groups) > 1 else 0), 3)
        reason = "text blocks, separators and vertical gaps" if separator_ys else "text blocks and vertical gaps"
        candidates.append(LayoutCandidate(rect, confidence, len(group), reason))
    return candidates


_CJK_CHAR = r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]"
_CJK_SPACING = re.compile(rf"(?<={_CJK_CHAR})\s+(?={_CJK_CHAR})")
_RECEIPT_BODY_MARKERS = (
    "备注",
    "凭证",
    "信息",
    "通过",
    "校验",
    "管理",
    "打印",
    "费用",
    "时间戳",
    "摘要",
    "重要提示",
    "验证",
    "下载",
)
_RECEIPT_TITLE_PREFIX_MARKERS = (
    "银行",
    "客户",
    "业务",
    "入账",
    "出账",
    "收款",
    "付款",
    "支取",
    "存入",
    "付费",
    "收费",
    "利息",
    "借记",
    "贷记",
    "通用",
    "电子",
)
_RECEIPT_TITLE_SUFFIXES = (
    "网上支付跨行清算业务",
    "小额支付系统业务",
    "电子缴税付款业务",
    "存款利息",
    "通用",
)
_RECEIPT_EXACT_TITLES = (
    "上海银行电子缴税付款凭证",
    "宁波银行网上交易凭证",
)


def _normalize_title_line(text: str) -> str:
    """Normalize extraction whitespace without joining Latin words."""

    compact = " ".join(text.split())
    return _CJK_SPACING.sub("", compact)


def _is_receipt_title_line(line: str) -> bool:
    """Recognize an explicit receipt-title form, excluding seal labels."""

    if line == "回单":
        return True
    if line.endswith("回单"):
        prefix = line[:-2]
        return bool(prefix) and any(
            marker in prefix for marker in _RECEIPT_TITLE_PREFIX_MARKERS
        )
    for suffix in _RECEIPT_TITLE_SUFFIXES:
        if line.endswith(suffix):
            base = line[: -len(suffix)]
            if _is_receipt_title_line(base):
                return True
    return False


def _is_parenthesized_receipt_title(line: str) -> bool:
    for opening, closing in (("（", "）"), ("(", ")")):
        if not line.endswith(closing):
            continue
        opening_index = line.rfind(opening)
        if opening_index < 0:
            continue
        title = line[:opening_index].rstrip()
        suffix = line[opening_index + 1 : -1]
        if (
            _is_receipt_title_line(title)
            and 0 < len(suffix) <= 8
            and opening not in suffix
            and closing not in suffix
        ):
            return True
    return False


def _is_receipt_title(text: str) -> bool:
    """Return whether a compact text line looks like a receipt title."""

    if len(text) > MAX_TEXT_BLOCK_CHARACTERS:
        return False
    lines = [_normalize_title_line(line) for line in text.splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return False
    field_markers = ("编号", "种类", "类型", "日期")
    for line_index, line in enumerate(lines):
        # OCR/table extraction may split a seal label such as
        # ``电子回单专用章`` into ``电子回单`` and ``专用章``.  The first
        # fragment still looks like a valid title, so ignore only a
        # title-shaped line immediately followed by the seal marker.  A
        # genuine title elsewhere in the same block remains eligible.
        if line_index + 1 < len(lines) and "专用章" in lines[line_index + 1]:
            continue
        if len(line) > 40:
            continue
        if ":" in line or "：" in line:
            continue
        if any(marker in line for marker in field_markers):
            continue
        if line in _RECEIPT_EXACT_TITLES:
            return True
        if any(marker in line for marker in _RECEIPT_BODY_MARKERS):
            continue
        if _is_receipt_title_line(line):
            return True
        if line.startswith("回单") and not line.endswith("回单"):
            continue
        # Some bank templates use a standalone "存款利息单"/"利息单"
        # heading instead of the usual "客户回单" wording.  These are
        # receipt titles too; without this branch a two-receipt page is
        # reduced to the one title that happens to contain “回单”, causing
        # matches in the first receipt to be reported as blocked.
        if line.endswith(("存款利息单", "利息单")):
            return True
        if line.endswith(("贷记通知", "借记通知")) and "银行" in line:
            return True
        if _is_parenthesized_receipt_title(line):
            return True
    return False


def _deduplicate_title_blocks(titles: Iterable[TextBlock], *, min_gap: float = 32.0) -> list[TextBlock]:
    """Collapse duplicate title blocks emitted by table/text-layer extraction.

    Some bank PDFs expose the visible receipt title once as a standalone line
    and again as the first line of the surrounding table block.  Treating both
    as separate receipts shifts all slots and makes the candidate span the
    following receipt or page footer.
    """

    result: list[TextBlock] = []
    for title in sorted(titles, key=lambda block: (block.y0, block.x0)):
        if result and title.y0 - result[-1].y0 < min_gap:
            continue
        result.append(title)
    return result


_STANDALONE_PAGE_NUMBER = re.compile(
    r"(?:第\d{1,6}页(?:[,，]?共\d{1,6}页)?"
    r"|\d{1,6}[/／]\d{1,6}"
    r"|page\d{1,6}(?:of\d{1,6}|[/／]\d{1,6})?"
    r"|[-—–]\d{1,6}[-—–])",
    re.IGNORECASE,
)


def _is_page_footer_noise(page: ParsedPage, block: TextBlock) -> bool:
    """Ignore isolated page-number blocks outside the receipt content."""

    return (
        block.y0 >= page.height * 0.9
        and block.y1 <= page.height
        and block.x1 - block.x0 <= page.width * 0.45
        # Business footers and seal identifiers also sit near the page bottom.
        # Only discard a whole block if all its text is an explicit page label.
        and _STANDALONE_PAGE_NUMBER.fullmatch("".join(block.text.split())) is not None
    )


def _separator_overlaps_rect(separator: HorizontalSeparator, rect: Rect) -> bool:
    """Return whether a line covers most of the current content envelope."""

    separator_x0 = min(separator.x0, separator.x1)
    separator_x1 = max(separator.x0, separator.x1)
    rect_x0, rect_x1 = sorted((rect.x0, rect.x1))
    envelope_width = rect_x1 - rect_x0
    if envelope_width <= 0:
        return False
    overlap = max(0.0, min(separator_x1, rect_x1) - max(separator_x0, rect_x0))
    return overlap / envelope_width >= 0.9


def _contains_segment_blocks(rect: Rect, blocks: Iterable[TextBlock]) -> bool:
    return all(rect.y0 <= block.y0 and rect.y1 >= block.y1 for block in blocks)


def _contains_visual_anchors(
    rect: Rect,
    anchors: Iterable[VisualAnchor],
    *,
    tolerance: float = 0.0,
) -> bool:
    """Return whether a candidate fully contains every assigned visual anchor."""

    for anchor in anchors:
        anchor_x0, anchor_x1 = sorted((anchor.x0, anchor.x1))
        anchor_y0, anchor_y1 = sorted((anchor.y0, anchor.y1))
        if not (
            rect.x0 - tolerance <= anchor_x0
            and rect.x1 + tolerance >= anchor_x1
            and rect.y0 - tolerance <= anchor_y0
            and rect.y1 + tolerance >= anchor_y1
        ):
            return False
    return True


def _select_leading_anchors(
    anchors: Iterable[VisualAnchor],
    title: TextBlock,
    previous_title_y: float,
    *,
    max_start_distance: float = 80.0,
    max_end_gap: float = 32.0,
    max_title_overlap: float = 24.0,
    near_title_tolerance: float = 8.0,
    max_height: float = 80.0,
    cluster_tolerance: float = 12.0,
) -> tuple[VisualAnchor, ...]:
    """Select the nearest compact image band immediately above a title."""

    eligible: list[VisualAnchor] = []
    for anchor in anchors:
        anchor_y0, anchor_y1 = sorted((anchor.y0, anchor.y1))
        anchor_height = anchor_y1 - anchor_y0
        end_gap = title.y0 - anchor_y1
        if (
            anchor_y0 < previous_title_y
            or anchor_y0 < title.y0 - max_start_distance
            or anchor_y0 > title.y0 + 2.0
            or (
                end_gap < -max_title_overlap
                and title.y0 - anchor_y0 > near_title_tolerance
            )
            or end_gap > max_end_gap
            or anchor_height > max_height
        ):
            continue
        eligible.append(anchor)
    if not eligible:
        return ()

    nearest_start = max(min(anchor.y0, anchor.y1) for anchor in eligible)
    return tuple(
        sorted(
            (
                anchor
                for anchor in eligible
                if nearest_start - min(anchor.y0, anchor.y1) <= cluster_tolerance
            ),
            key=lambda anchor: (anchor.y0, anchor.x0, anchor.y1, anchor.x1),
        )
    )


def _first_lower_separator_group(
    separators: Iterable[HorizontalSeparator],
    *,
    lower: float,
    upper: float,
    rect: Rect,
    edge_tolerance: float = 2.0,
) -> tuple[HorizontalSeparator, ...]:
    """Return the first reliable edge group after the visual content."""

    eligible = sorted(
        (
            separator
            for separator in separators
            if separator.y >= lower
            and separator.y <= upper
            and _separator_overlaps_rect(separator, rect)
        ),
        key=lambda separator: separator.y,
    )
    if not eligible:
        return ()
    first_y = eligible[0].y
    return tuple(
        separator
        for separator in eligible
        if abs(separator.y - first_y) <= edge_tolerance
    )


def _is_ambiguous_boundary_block(
    block: TextBlock,
    *,
    boundary_y: float | None,
    next_title_y: float | None,
    title_gap: float | None,
    max_short_height: float = 40.0,
    min_overrun: float = 8.0,
) -> bool:
    """Recognize short, materially crossing text rather than page noise."""

    if boundary_y is None or not (block.y0 < boundary_y <= block.y1):
        return False
    block_height = block.y1 - block.y0
    overrun = block.y1 - boundary_y
    if block_height > max_short_height or overrun < min_overrun:
        return False
    if (
        next_title_y is not None
        and title_gap is not None
        and title_gap > 80.0
        and block.y0 < next_title_y <= block.y1
        and (
            block.y1 - next_title_y < 8.0
            or block_height > max_short_height
        )
    ):
        return False
    return True


def _frame_contains_point(frame: VisualAnchor, x: float, y: float) -> bool:
    frame_x0, frame_x1 = sorted((frame.x0, frame.x1))
    frame_y0, frame_y1 = sorted((frame.y0, frame.y1))
    return frame_x0 <= x <= frame_x1 and frame_y0 <= y <= frame_y1


def _frame_contains_anchor(frame: VisualAnchor, anchor: VisualAnchor) -> bool:
    frame_x0, frame_x1 = sorted((frame.x0, frame.x1))
    frame_y0, frame_y1 = sorted((frame.y0, frame.y1))
    anchor_x0, anchor_x1 = sorted((anchor.x0, anchor.x1))
    anchor_y0, anchor_y1 = sorted((anchor.y0, anchor.y1))
    return (
        frame_x0 <= anchor_x0
        and frame_x1 >= anchor_x1
        and frame_y0 <= anchor_y0
        and frame_y1 >= anchor_y1
    )


def _frame_contains_block(
    frame: VisualAnchor,
    block: TextBlock,
    *,
    tolerance: float = 2.0,
) -> bool:
    frame_x0, frame_x1 = sorted((frame.x0, frame.x1))
    frame_y0, frame_y1 = sorted((frame.y0, frame.y1))
    return (
        frame_x0 - tolerance <= block.x0
        and frame_x1 + tolerance >= block.x1
        and frame_y0 - tolerance <= block.y0
        and frame_y1 + tolerance >= block.y1
    )


def _frame_overlaps_title_vertically(
    frame: VisualAnchor,
    title: TextBlock,
    *,
    tolerance: float = 2.0,
) -> bool:
    frame_y0, frame_y1 = sorted((frame.y0, frame.y1))
    title_y0, title_y1 = sorted((title.y0, title.y1))
    return (
        frame_y0 < title_y1 - tolerance
        and frame_y1 > title_y0 + tolerance
    )


def _frame_titles(
    frame: VisualAnchor,
    titles: tuple[TextBlock, ...],
) -> list[TextBlock]:
    return [
        title
        for title in titles
        if _frame_contains_point(
            frame,
            (title.x0 + title.x1) / 2,
            (title.y0 + title.y1) / 2,
        )
    ]


def _frame_visual_coverage(
    frame: VisualAnchor,
    title: TextBlock,
    next_title: TextBlock | None,
    visual_anchors: Iterable[VisualAnchor],
) -> tuple[int, int]:
    title_y1 = max(title.y0, title.y1)
    slot_anchors = [
        anchor
        for anchor in visual_anchors
        if anchor.kind != "frame"
        and (anchor.y0 + anchor.y1) / 2 >= title_y1
        and (next_title is None or (anchor.y0 + anchor.y1) / 2 < next_title.y0)
    ]
    return (
        sum(_frame_contains_anchor(frame, anchor) for anchor in slot_anchors),
        sum(
            _frame_contains_point(
                frame,
                (anchor.x0 + anchor.x1) / 2,
                (anchor.y0 + anchor.y1) / 2,
            )
            for anchor in slot_anchors
        ),
    )


def _is_receipt_frame_candidate(
    frame: VisualAnchor,
    title: TextBlock,
    titles: tuple[TextBlock, ...],
    segment_blocks: tuple[TextBlock, ...],
    tolerance: float,
) -> bool:
    title_center = ((title.x0 + title.x1) / 2, (title.y0 + title.y1) / 2)
    if frame.kind != "frame" or not _frame_contains_point(frame, *title_center):
        return False
    if _frame_titles(frame, titles) != [title]:
        return False
    title_index = titles.index(title)
    neighbors = tuple(
        neighbor
        for neighbor in (
            titles[title_index - 1] if title_index else None,
            titles[title_index + 1] if title_index + 1 < len(titles) else None,
        )
        if neighbor is not None
    )
    if any(
        _frame_overlaps_title_vertically(frame, neighbor, tolerance=tolerance)
        for neighbor in neighbors
    ):
        return False
    return all(
        _frame_contains_block(frame, block, tolerance=tolerance)
        for block in segment_blocks
    )


def _select_receipt_frame(
    frame_anchors: Iterable[VisualAnchor],
    title: TextBlock,
    titles: Iterable[TextBlock],
    segment_blocks: Iterable[TextBlock],
    visual_anchors: Iterable[VisualAnchor] = (),
    *,
    tolerance: float = 2.0,
) -> VisualAnchor | None:
    """Return the smallest reliable frame for one receipt title."""

    title_list = tuple(titles)
    segment_block_list = tuple(segment_blocks)
    title_index = title_list.index(title)
    next_title = title_list[title_index + 1] if title_index + 1 < len(title_list) else None
    eligible_frames = [
        (
            frame,
            *_frame_visual_coverage(frame, title, next_title, visual_anchors),
        )
        for frame in frame_anchors
        if _is_receipt_frame_candidate(
            frame,
            title,
            title_list,
            segment_block_list,
            tolerance,
        )
    ]
    return min(
        eligible_frames,
        key=lambda item: (
            -item[1],
            -item[2],
            abs(item[0].x1 - item[0].x0) * abs(item[0].y1 - item[0].y0),
            item[0].y0,
            item[0].x0,
        ),
        default=(None, 0, 0),
    )[0]


def _nearest_separator(
    separators: Iterable[HorizontalSeparator],
    *,
    lower: float,
    upper: float,
    rect: Rect,
    from_top: bool,
) -> HorizontalSeparator | None:
    eligible = [
        separator
        for separator in separators
        if lower <= separator.y <= upper and _separator_overlaps_rect(separator, rect)
    ]
    if not eligible:
        return None
    return (min if from_top else max)(eligible, key=lambda separator: separator.y)


def _frame_segment_blocks(
    page: ParsedPage,
    titles: tuple[TextBlock, ...],
    index: int,
    margin: float,
) -> tuple[TextBlock, ...]:
    title = titles[index]
    upper = titles[index + 1].y0 if index + 1 < len(titles) else page.height
    return tuple(
        block
        for block in page.blocks
        if (
            title.y0 - margin <= block.y0 < upper
            and not _is_page_footer_noise(page, block)
        )
    )


def _receipt_frame_context(
    page: ParsedPage,
    titles: tuple[TextBlock, ...],
    frame_anchors: tuple[VisualAnchor, ...],
    visual_anchors: tuple[VisualAnchor, ...],
    margin: float,
) -> tuple[tuple[tuple[TextBlock, ...], ...], tuple[VisualAnchor | None, ...]]:
    segment_blocks = tuple(
        _frame_segment_blocks(page, titles, index, margin)
        for index in range(len(titles))
    )
    frames = tuple(
        _select_receipt_frame(
            frame_anchors,
            title,
            titles,
            segment_blocks[index],
            visual_anchors,
        )
        for index, title in enumerate(titles)
    )
    return segment_blocks, frames


def _receipt_boundary_context(
    index: int,
    titles: tuple[TextBlock, ...],
    raw_visual_starts: tuple[float, ...],
    associated_frames: tuple[VisualAnchor | None, ...],
    page_height: float,
) -> _ReceiptBoundaryContext:
    previous_title_y = titles[index - 1].y0 if index else 0.0
    next_title_y = titles[index + 1].y0 if index + 1 < len(titles) else None
    next_raw_visual_start = (
        raw_visual_starts[index + 1]
        if index + 1 < len(raw_visual_starts)
        else None
    )
    next_frame = (
        associated_frames[index + 1]
        if index + 1 < len(associated_frames)
        else None
    )
    next_frame_raw_start = (
        min(next_frame.y0, next_frame.y1)
        if next_frame is not None
        else None
    )
    if (
        next_frame_raw_start is not None
        and next_frame_raw_start > raw_visual_starts[index]
        and (
            next_raw_visual_start is None
            or next_frame_raw_start < next_raw_visual_start
        )
    ):
        next_raw_visual_start = next_frame_raw_start
    next_boundary = next_raw_visual_start
    if next_boundary is None or (
        next_title_y is not None and next_title_y < next_boundary
    ):
        next_boundary = next_title_y
    lower = next_boundary if next_boundary is not None else page_height
    title_gap = next_title_y - titles[index].y0 if next_title_y is not None else None
    return _ReceiptBoundaryContext(
        previous_title_y,
        next_title_y,
        next_raw_visual_start,
        lower,
        title_gap,
    )


def _expanded_frame_rect(frame: VisualAnchor | None) -> Rect | None:
    if frame is None:
        return None
    return Rect(
        min(frame.x0, frame.x1) - 1.0,
        min(frame.y0, frame.y1) - 1.0,
        max(frame.x0, frame.x1) + 1.0,
        max(frame.y0, frame.y1) + 1.0,
    )


def _frame_candidate(
    frame: VisualAnchor | None,
    frame_segment_blocks: tuple[TextBlock, ...],
    slot: str,
    page: ParsedPage,
    next_raw_visual_start: float | None,
) -> tuple[ReceiptCandidate | None, bool]:
    frame_rect = _expanded_frame_rect(frame)
    frame_conflict = bool(
        frame_rect is not None
        and next_raw_visual_start is not None
        and frame_rect.y1 > next_raw_visual_start
    )
    if frame is None or frame_conflict:
        return None, frame_conflict
    assert frame_rect is not None
    rect = clamp_rect(frame_rect, page.width, page.height)
    confidence = min(0.99, 0.92 + min(len(frame_segment_blocks), 7) * 0.01)
    return (
        ReceiptCandidate(
            rect,
            round(confidence, 3),
            slot,
            ("repeated_title", "frame"),
        ),
        False,
    )


def _slot_visual_anchors(
    anchor_list: tuple[VisualAnchor, ...],
    leading_anchor_groups: tuple[tuple[VisualAnchor, ...], ...],
    index: int,
    raw_visual_start: float,
    next_raw_visual_start: float | None,
) -> tuple[tuple[VisualAnchor, ...], tuple[VisualAnchor, ...]]:
    slot_anchors: list[VisualAnchor] = []
    cross_boundary_anchors: list[VisualAnchor] = []
    leading_anchors = set(leading_anchor_groups[index])
    next_leading_anchors = (
        set(leading_anchor_groups[index + 1])
        if index + 1 < len(leading_anchor_groups)
        else set()
    )
    for anchor in anchor_list:
        anchor_y0, anchor_y1 = sorted((anchor.y0, anchor.y1))
        if raw_visual_start > anchor_y0 and anchor not in leading_anchors:
            continue
        if next_raw_visual_start is not None:
            if anchor_y0 >= next_raw_visual_start:
                continue
            if anchor_y1 > next_raw_visual_start:
                if anchor in next_leading_anchors:
                    continue
                cross_boundary_anchors.append(anchor)
                continue
        slot_anchors.append(anchor)
    return tuple(slot_anchors), tuple(cross_boundary_anchors)


def _slot_segment_blocks(
    page: ParsedPage,
    start: float,
    upper: float,
    next_title_y: float | None,
    title_gap: float | None,
) -> tuple[TextBlock, ...]:
    return tuple(
        block
        for block in page.blocks
        if (
            start <= block.y0 < upper
            and not _is_page_footer_noise(page, block)
            and not (
                title_gap is not None
                and title_gap > 80.0
                and block.y0 < next_title_y <= block.y1
                and (
                    block.y1 - next_title_y < 8.0
                    or block.y1 - block.y0 > 40.0
                )
            )
        )
    )


def _slot_content_geometry(
    page: ParsedPage,
    segment_blocks: tuple[TextBlock, ...],
    slot_anchors: tuple[VisualAnchor, ...],
    start: float,
    lower: float,
    title_y1: float,
    margin: float,
) -> tuple[Rect, float]:
    content_x0_values = [block.x0 for block in segment_blocks] + [
        min(anchor.x0, anchor.x1) for anchor in slot_anchors
    ]
    content_x1_values = [block.x1 for block in segment_blocks] + [
        max(anchor.x0, anchor.x1) for anchor in slot_anchors
    ]
    content_x0 = min(content_x0_values) - margin if content_x0_values else 0.0
    content_x1 = max(content_x1_values) + margin if content_x1_values else page.width
    content_rect = Rect(content_x0, start, content_x1, lower)
    content_y1 = max(
        max((block.y1 for block in segment_blocks), default=title_y1),
        max((anchor.y1 for anchor in slot_anchors), default=title_y1),
    )
    return content_rect, content_y1


def _fallback_y1(
    content_y1: float,
    next_raw_visual_start: float | None,
    next_title_y: float | None,
    page_height: float,
    margin: float,
) -> float:
    y1 = content_y1 + margin
    if next_raw_visual_start is not None:
        y1 = min(next_raw_visual_start, y1)
    elif next_title_y is not None and content_y1 <= next_title_y:
        y1 = min(next_title_y, y1)
    return min(page_height, y1)


def _try_separator_adjustment(
    rect: Rect,
    adjusted: Rect,
    page: ParsedPage,
    next_raw_visual_start: float | None,
    segment_blocks: tuple[TextBlock, ...],
    slot_anchors: tuple[VisualAnchor, ...],
) -> tuple[Rect, bool]:
    adjusted_rect = clamp_rect(
        adjusted,
        page.width,
        page.height,
        max_y1=next_raw_visual_start,
    )
    if (
        (adjusted_rect.y0 != rect.y0 or adjusted_rect.y1 != rect.y1)
        and _contains_segment_blocks(adjusted_rect, segment_blocks)
        and _contains_visual_anchors(adjusted_rect, slot_anchors)
    ):
        return adjusted_rect, True
    return rect, False


def _lower_separator_group(
    separator_list: tuple[HorizontalSeparator, ...],
    content_rect: Rect,
    content_y1: float,
    boundary: _ReceiptBoundaryContext,
    page_height: float,
) -> tuple[HorizontalSeparator, ...]:
    return _first_lower_separator_group(
        separator_list,
        lower=content_y1,
        upper=min(page_height, content_y1 + 24.0, boundary.lower),
        rect=content_rect,
    )


def _initial_fallback_rect(
    page: ParsedPage,
    content_y1: float,
    boundary: _ReceiptBoundaryContext,
    start: float,
    margin: float,
) -> tuple[Rect, Rect]:
    y1 = _fallback_y1(
        content_y1,
        boundary.next_raw_visual_start,
        boundary.next_title_y,
        page.height,
        margin,
    )
    base_rect = Rect(0, start, page.width, y1)
    rect = clamp_rect(
        base_rect,
        page.width,
        page.height,
        max_y1=boundary.next_raw_visual_start,
    )
    return base_rect, rect


def _apply_upper_separator(
    base_rect: Rect,
    rect: Rect,
    separator: HorizontalSeparator | None,
    page: ParsedPage,
    boundary: _ReceiptBoundaryContext,
    segment_blocks: tuple[TextBlock, ...],
    slot_anchors: tuple[VisualAnchor, ...],
) -> tuple[Rect, Rect, bool]:
    if separator is None:
        return base_rect, rect, False
    adjusted = Rect(
        base_rect.x0,
        max(base_rect.y0, separator.y),
        base_rect.x1,
        base_rect.y1,
    )
    adjusted_rect, used = _try_separator_adjustment(
        rect,
        adjusted,
        page,
        boundary.next_raw_visual_start,
        segment_blocks,
        slot_anchors,
    )
    return (adjusted if used else base_rect), adjusted_rect, used


def _apply_lower_separator(
    base_rect: Rect,
    rect: Rect,
    separator_group: tuple[HorizontalSeparator, ...],
    page: ParsedPage,
    boundary: _ReceiptBoundaryContext,
    segment_blocks: tuple[TextBlock, ...],
    slot_anchors: tuple[VisualAnchor, ...],
) -> tuple[Rect, Rect, bool]:
    if not separator_group:
        return base_rect, rect, False
    lower_separator_y = max(separator.y for separator in separator_group) + 1.1
    adjusted = Rect(
        base_rect.x0,
        base_rect.y0,
        base_rect.x1,
        min(boundary.lower, max(base_rect.y1, lower_separator_y)),
    )
    adjusted_rect, used = _try_separator_adjustment(
        rect,
        adjusted,
        page,
        boundary.next_raw_visual_start,
        segment_blocks,
        slot_anchors,
    )
    return (adjusted if used else base_rect), adjusted_rect, used


def _fallback_rect(
    page: ParsedPage,
    separator_list: tuple[HorizontalSeparator, ...],
    content_rect: Rect,
    content_y1: float,
    boundary: _ReceiptBoundaryContext,
    start: float,
    title_y0: float,
    segment_blocks: tuple[TextBlock, ...],
    slot_anchors: tuple[VisualAnchor, ...],
    margin: float,
) -> tuple[Rect, bool]:
    lower_separator_group = _lower_separator_group(
        separator_list,
        content_rect,
        content_y1,
        boundary,
        page.height,
    )
    base_rect, rect = _initial_fallback_rect(
        page,
        content_y1,
        boundary,
        start,
        margin,
    )
    upper_separator = _nearest_separator(
        separator_list,
        lower=boundary.previous_title_y,
        upper=title_y0,
        rect=content_rect,
        from_top=False,
    )
    base_rect, rect, separator_used = _apply_upper_separator(
        base_rect,
        rect,
        upper_separator,
        page,
        boundary,
        segment_blocks,
        slot_anchors,
    )
    base_rect, rect, lower_used = _apply_lower_separator(
        base_rect,
        rect,
        lower_separator_group,
        page,
        boundary,
        segment_blocks,
        slot_anchors,
    )
    return rect, separator_used or lower_used


def _fallback_candidate(
    page: ParsedPage,
    slot: str,
    rect: Rect,
    segment_blocks: tuple[TextBlock, ...],
    slot_anchors: tuple[VisualAnchor, ...],
    cross_boundary_anchors: tuple[VisualAnchor, ...],
    boundary: _ReceiptBoundaryContext,
    frame_conflict: bool,
    title: TextBlock,
    separator_used: bool,
) -> ReceiptCandidate:
    evidence: tuple[str, ...] = ("repeated_title", "page_width")
    if slot_anchors and _contains_visual_anchors(rect, slot_anchors):
        evidence += ("anchor",)
    confidence = min(0.98, 0.82 + min(len(segment_blocks), 8) * 0.02)
    boundary_y = (
        boundary.next_raw_visual_start
        if boundary.next_raw_visual_start is not None
        else boundary.next_title_y
    )
    ambiguous_boundary = bool(cross_boundary_anchors) or any(
        _is_ambiguous_boundary_block(
            block,
            boundary_y=boundary_y,
            next_title_y=boundary.next_title_y,
            title_gap=boundary.title_gap,
        )
        for block in page.blocks
    ) or frame_conflict
    if ambiguous_boundary:
        evidence += ("ambiguous_boundary",)
        confidence = max(0.0, confidence - 0.1)
    if separator_used:
        evidence += ("separator",)
        confidence = min(0.99, confidence + 0.03)
    if ambiguous_boundary:
        confidence = min(confidence, 0.89)
    return ReceiptCandidate(rect, round(confidence, 3), slot, evidence)


def _single_receipt_candidates(
    page: ParsedPage,
    margin: float,
    separators: tuple[HorizontalSeparator, ...],
) -> list[ReceiptCandidate]:
    return [
        ReceiptCandidate(
            Rect(0, candidate.rect.y0, page.width, candidate.rect.y1),
            candidate.confidence,
            "single",
            (candidate.reason,),
        )
        for candidate in infer_candidates(page, margin=margin, separators=separators)
    ]


def _receipt_slots(titles: Iterable[TextBlock]) -> tuple[str, ...]:
    title_count = len(tuple(titles))
    if title_count == 3:
        return ("top", "middle", "bottom")
    return tuple(f"slot-{index + 1}" for index in range(title_count))


def _receipt_detection_context(
    page: ParsedPage,
    titles: Iterable[TextBlock],
    anchor_list: tuple[VisualAnchor, ...],
    frame_anchors: tuple[VisualAnchor, ...],
    margin: float,
) -> _ReceiptDetectionContext:
    title_tuple = tuple(titles)
    slots = _receipt_slots(title_tuple)
    leading_anchor_groups = tuple(
        _select_leading_anchors(
            anchor_list,
            title,
            title_tuple[index - 1].y0 if index else 0.0,
        )
        for index, title in enumerate(title_tuple)
    )
    raw_visual_starts = tuple(
        min(
            [title.y0]
            + [min(anchor.y0, anchor.y1) for anchor in leading_anchors]
        )
        for title, leading_anchors in zip(title_tuple, leading_anchor_groups)
    )
    frame_segments, associated_frames = _receipt_frame_context(
        page,
        title_tuple,
        frame_anchors,
        anchor_list,
        margin,
    )
    return _ReceiptDetectionContext(
        title_tuple,
        slots,
        leading_anchor_groups,
        raw_visual_starts,
        frame_segments,
        associated_frames,
    )


def _fallback_slot_context(
    page: ParsedPage,
    anchor_list: tuple[VisualAnchor, ...],
    context: _ReceiptDetectionContext,
    index: int,
    boundary: _ReceiptBoundaryContext,
    margin: float,
) -> _ReceiptFallbackContext:
    title = context.titles[index]
    raw_visual_start = context.raw_visual_starts[index]
    slot_anchors, cross_boundary_anchors = _slot_visual_anchors(
        anchor_list,
        context.leading_anchor_groups,
        index,
        raw_visual_start,
        boundary.next_raw_visual_start,
    )
    start = raw_visual_start - margin
    segment_blocks = _slot_segment_blocks(
        page,
        start,
        boundary.lower,
        boundary.next_title_y,
        boundary.title_gap,
    )
    content_rect, content_y1 = _slot_content_geometry(
        page,
        segment_blocks,
        slot_anchors,
        start,
        boundary.lower,
        title.y1,
        margin,
    )
    return _ReceiptFallbackContext(
        slot_anchors,
        cross_boundary_anchors,
        segment_blocks,
        content_rect,
        content_y1,
    )


def _fallback_receipt_candidate(
    page: ParsedPage,
    separator_list: tuple[HorizontalSeparator, ...],
    anchor_list: tuple[VisualAnchor, ...],
    context: _ReceiptDetectionContext,
    index: int,
    boundary: _ReceiptBoundaryContext,
    frame_conflict: bool,
    margin: float,
) -> ReceiptCandidate:
    fallback_context = _fallback_slot_context(
        page,
        anchor_list,
        context,
        index,
        boundary,
        margin,
    )
    rect, separator_used = _fallback_rect(
        page,
        separator_list,
        fallback_context.content_rect,
        fallback_context.content_y1,
        boundary,
        context.raw_visual_starts[index] - margin,
        context.titles[index].y0,
        fallback_context.segment_blocks,
        fallback_context.slot_anchors,
        margin,
    )
    return _fallback_candidate(
        page,
        context.slots[index],
        rect,
        fallback_context.segment_blocks,
        fallback_context.slot_anchors,
        fallback_context.cross_boundary_anchors,
        boundary,
        frame_conflict,
        context.titles[index],
        separator_used,
    )


def _receipt_candidate_for_slot(
    page: ParsedPage,
    separator_list: tuple[HorizontalSeparator, ...],
    anchor_list: tuple[VisualAnchor, ...],
    context: _ReceiptDetectionContext,
    index: int,
    margin: float,
) -> ReceiptCandidate:
    boundary = _receipt_boundary_context(
        index,
        context.titles,
        context.raw_visual_starts,
        context.associated_frames,
        page.height,
    )
    frame_candidate, frame_conflict = _frame_candidate(
        context.associated_frames[index],
        context.frame_segments[index],
        context.slots[index],
        page,
        boundary.next_raw_visual_start,
    )
    if frame_candidate is not None:
        return frame_candidate
    return _fallback_receipt_candidate(
        page,
        separator_list,
        anchor_list,
        context,
        index,
        boundary,
        frame_conflict,
        margin,
    )


def infer_receipt_candidates(
    page: ParsedPage,
    *,
    margin: float = 8.0,
    separators: Iterable[HorizontalSeparator] = (),
    visual_anchors: Iterable[VisualAnchor] = (),
) -> list[ReceiptCandidate]:
    """Infer receipt regions anchored by repeated receipt-title text blocks."""

    bounded_separators = _bounded_tuple(separators, MAX_SEPARATOR_SEGMENTS)
    bounded_anchors = _bounded_tuple(visual_anchors, MAX_VISUAL_ANCHORS)
    layout_budget_exceeded = (
        bounded_separators is None or bounded_anchors is None
    )
    separator_list = bounded_separators or ()
    all_anchors = bounded_anchors or ()
    if len(page.blocks) > MAX_TEXT_BLOCKS:
        return _mark_layout_budget_exceeded([
            ReceiptCandidate(
                Rect(0, 0, page.width, page.height),
                0.2,
                "single",
                ("layout_budget_exceeded",),
            )
        ])
    # Use a separate layout view; the original blocks remain searchable.
    if any(block.is_watermark for block in page.blocks):
        page = replace(page, blocks=tuple(block for block in page.blocks if not block.is_watermark))
    frame_anchors = tuple(anchor for anchor in all_anchors if anchor.kind == "frame")
    anchor_list = tuple(anchor for anchor in all_anchors if anchor.kind != "frame")
    titles = _deduplicate_title_blocks(
        block for block in page.blocks if _is_receipt_title(block.text)
    )
    if len(titles) > MAX_RECEIPT_TITLES:
        return _mark_layout_budget_exceeded([
            ReceiptCandidate(
                Rect(0, 0, page.width, page.height),
                0.2,
                "single",
                ("layout_budget_exceeded",),
            )
        ])
    if not titles:
        candidates = _single_receipt_candidates(page, margin, separator_list)
        return (
            _mark_layout_budget_exceeded(candidates)
            if layout_budget_exceeded
            else candidates
        )

    context = _receipt_detection_context(
        page,
        titles,
        anchor_list,
        frame_anchors,
        margin,
    )
    candidates = [
        _receipt_candidate_for_slot(
            page,
            separator_list,
            anchor_list,
            context,
            index,
            margin,
        )
        for index in range(len(context.titles))
    ]
    return (
        _mark_layout_budget_exceeded(candidates)
        if layout_budget_exceeded
        else candidates
    )


def select_candidate_for_match(
    candidates: Iterable[ReceiptCandidate], match_rect: Rect
) -> ReceiptCandidate | None:
    """Return the smallest candidate that fully contains a matched rectangle."""

    match_x0, match_x1 = sorted((match_rect.x0, match_rect.x1))
    match_y0, match_y1 = sorted((match_rect.y0, match_rect.y1))
    containing = [
        candidate
        for candidate in candidates
        if (
            candidate.rect.x0 <= match_x0
            and candidate.rect.y0 <= match_y0
            and candidate.rect.x1 >= match_x1
            and candidate.rect.y1 >= match_y1
        )
    ]
    return min(
        containing,
        key=lambda candidate: (
            (candidate.rect.x1 - candidate.rect.x0)
            * (candidate.rect.y1 - candidate.rect.y0),
            -candidate.confidence,
        ),
        default=None,
    )
