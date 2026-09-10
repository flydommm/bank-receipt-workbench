"""Rendering and searchable working-copy helpers for scanned PDFs."""

from __future__ import annotations

import math
from pathlib import Path

try:
    import pymupdf
except ImportError:  # pragma: no cover
    import fitz as pymupdf  # type: ignore[no-redef]

from .ocr import OcrUnavailableError, recognize_image
from .private_temp import private_temporary_directory


MAX_RASTER_PIXELS_PER_SIDE = 16_384
MAX_RASTER_PIXELS = 64_000_000


def _validate_raster_budget(page_rect: object, dpi: int) -> None:
    """Reject pathological page sizes before PyMuPDF allocates a pixmap."""

    if isinstance(dpi, bool) or not isinstance(dpi, int) or dpi <= 0:
        raise ValueError("dpi must be a positive integer")
    try:
        width = math.ceil(float(page_rect.width) * dpi / 72)
        height = math.ceil(float(page_rect.height) * dpi / 72)
    except (AttributeError, OverflowError, TypeError, ValueError) as error:
        raise ValueError("rendered page exceeds the pixel budget") from error
    if (
        width <= 0
        or height <= 0
        or width > MAX_RASTER_PIXELS_PER_SIDE
        or height > MAX_RASTER_PIXELS_PER_SIDE
        or width * height > MAX_RASTER_PIXELS
    ):
        raise ValueError("rendered page exceeds the pixel budget")


def render_page_to_png(pdf_path: str | Path, page_number: int, output_dir: str | Path, dpi: int = 200) -> Path:
    if page_number < 1:
        raise ValueError("page_number must be positive")
    document = pymupdf.open(str(pdf_path))
    try:
        if page_number > document.page_count:
            raise ValueError(f"page number out of range: {page_number}")
        destination = Path(output_dir)
        destination.mkdir(parents=True, exist_ok=True)
        scale = dpi / 72
        page = document.load_page(page_number - 1)
        _validate_raster_budget(page.rect, dpi)
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        image_path = destination / f"page-{page_number:05d}.png"
        pixmap.save(str(image_path))
        return image_path
    finally:
        document.close()


def create_ocr_working_copy(source_path: str | Path, output_path: str | Path, language: str = "ch") -> Path:
    """Create a new PDF with OCR text positioned over copied source pages.

    The function intentionally fails before writing output when PaddleOCR is
    unavailable, preserving a clear retry path and the source PDF.
    """

    source = pymupdf.open(str(source_path))
    output = pymupdf.open()
    try:
        with private_temporary_directory("ocr-copy") as temporary_dir:
            for page_number in range(1, source.page_count + 1):
                image_path = render_page_to_png(source_path, page_number, temporary_dir)
                records = recognize_image(image_path, language)
                source_page = source.load_page(page_number - 1)
                target = output.new_page(width=source_page.rect.width, height=source_page.rect.height)
                target.show_pdf_page(target.rect, source, page_number - 1)
                for record in records:
                    box = record.get("box", [0, 0, 0, 0])
                    if len(box) >= 4 and record.get("text"):
                        scale = 72 / 200
                        target.insert_text((float(box[0]) * scale, float(box[3]) * scale), str(record["text"]), fontsize=6, render_mode=3)
            destination = Path(output_path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            output.save(str(destination))
            return destination
    except OcrUnavailableError:
        raise
    finally:
        output.close()
        source.close()
