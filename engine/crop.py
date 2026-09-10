"""Crop-region validation and user-review state helpers."""

from __future__ import annotations

from dataclasses import replace
from dataclasses import dataclass
import math
from pathlib import Path
from collections.abc import Iterable
from typing import Any

from .layout import LayoutCandidate, Rect, clamp_rect

try:
    import pymupdf
except ImportError:  # pragma: no cover
    import fitz as pymupdf  # type: ignore[no-redef]


@dataclass(frozen=True)
class PdfSegment:
    page_number: int
    rect: Rect | None = None
    segment_no: int = 1
    keep_full_page: bool = False


# Keep the lower-level exporter conservative as well as the JSON protocol.
# The UI uses the same minimum for pointer editing.  This prevents
# zero-area/near-empty pages from being emitted by callers that bypass the UI.
MIN_EXPORT_RECT_SIZE = 12.0


def normalize_region(candidate: LayoutCandidate, page_width: float, page_height: float) -> LayoutCandidate:
    return replace(candidate, rect=clamp_rect(candidate.rect, page_width, page_height))


def region_from_points(x0: float, y0: float, x1: float, y1: float, page_width: float, page_height: float) -> Rect:
    return clamp_rect(Rect(x0, y0, x1, y1), page_width, page_height)


def _is_real_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _validated_clip(segment: PdfSegment, source_page: Any) -> Any:
    """Return a clip that is already proven to be inside the source page.

    ``pymupdf.Rect`` normalizes reversed coordinates, so constructing one
    before validation would silently turn malformed review data into a
    different crop.  Export must fail closed instead.
    """

    if isinstance(segment.page_number, bool) or not isinstance(segment.page_number, int) or segment.page_number < 1:
        raise ValueError("page number must be a positive integer")
    if isinstance(segment.segment_no, bool) or not isinstance(segment.segment_no, int) or segment.segment_no < 1:
        raise ValueError("segment number must be a positive integer")
    if segment.keep_full_page is True:
        return source_page.rect
    if segment.rect is None:
        raise ValueError("reviewed rectangle is required unless full page was explicitly selected")

    rect = segment.rect
    values = (rect.x0, rect.y0, rect.x1, rect.y1)
    if not all(_is_real_number(value) for value in values):
        raise ValueError("reviewed rectangle must contain finite numbers")
    x0, y0, x1, y1 = (float(value) for value in values)
    page_width = float(source_page.rect.width)
    page_height = float(source_page.rect.height)
    if not (
        0 <= x0 < x1 <= page_width
        and 0 <= y0 < y1 <= page_height
        and x1 - x0 >= MIN_EXPORT_RECT_SIZE
        and y1 - y0 >= MIN_EXPORT_RECT_SIZE
    ):
        raise ValueError("reviewed rectangle must be ordered, non-empty, and inside the page")
    return pymupdf.Rect(x0, y0, x1, y1)


def _ensure_distinct_output(source_path: str | Path, output_path: str | Path) -> None:
    try:
        source = Path(source_path).resolve()
        destination = Path(output_path).resolve()
    except (OSError, RuntimeError, ValueError) as error:
        raise ValueError("source and output paths are invalid") from error
    if source == destination:
        raise ValueError("output must be a new path and cannot overwrite the source PDF")


def export_segments(source_path: str | Path, output_path: str | Path, segments: list[PdfSegment]) -> Path:
    """Write selected page regions to a new PDF without modifying the source."""

    if not isinstance(segments, list) or not segments:
        raise ValueError("at least one reviewed segment is required")
    _ensure_distinct_output(source_path, output_path)
    source = pymupdf.open(str(source_path))
    output = pymupdf.open()
    try:
        for segment in segments:
            if segment.page_number < 1 or segment.page_number > source.page_count:
                raise ValueError(f"page number out of range: {segment.page_number}")
            source_page = source.load_page(segment.page_number - 1)
            clip = _validated_clip(segment, source_page)
            target = output.new_page(width=clip.width, height=clip.height)
            target.show_pdf_page(target.rect, source, segment.page_number - 1, clip=clip)
        destination = Path(output_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        output.save(str(destination))
        return destination
    finally:
        output.close()
        source.close()


def export_merged_segments(
    output_path: str | Path,
    selections: Iterable[tuple[str | Path, list[PdfSegment]]],
) -> Path:
    """Merge reviewed segments from multiple source PDFs into one new PDF."""

    materialized = list(selections)
    if not materialized or not any(segments for _, segments in materialized):
        raise ValueError("at least one reviewed segment is required")
    output = pymupdf.open()
    opened: list[Any] = []
    try:
        for source_path, segments in materialized:
            _ensure_distinct_output(source_path, output_path)
            if not isinstance(segments, list) or not segments:
                raise ValueError("at least one reviewed segment is required for each source")
            source = pymupdf.open(str(source_path))
            opened.append(source)
            for segment in segments:
                if segment.page_number < 1 or segment.page_number > source.page_count:
                    raise ValueError(f"page number out of range: {segment.page_number}")
                source_page = source.load_page(segment.page_number - 1)
                clip = _validated_clip(segment, source_page)
                target = output.new_page(width=clip.width, height=clip.height)
                target.show_pdf_page(target.rect, source, segment.page_number - 1, clip=clip)
        destination = Path(output_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        output.save(str(destination))
        return destination
    finally:
        output.close()
        for source in opened:
            source.close()
