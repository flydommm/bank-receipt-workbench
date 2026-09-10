from __future__ import annotations

import hashlib
from pathlib import Path

import pymupdf
import pytest

from engine.crop import PdfSegment, export_merged_segments, export_segments
from engine.layout import Rect


def _source_pdf(tmp_path: Path, *, width: float = 600, height: float = 800) -> Path:
    source_path = tmp_path / "source.pdf"
    document = pymupdf.open()
    page = document.new_page(width=width, height=height)
    page.insert_text((30, 80), "手续费")
    document.save(source_path)
    document.close()
    return source_path


def test_export_segments_preserves_source_and_writes_selected_pages(tmp_path: Path) -> None:
    source_path = tmp_path / "source.pdf"
    document = pymupdf.open()
    for index in range(2):
        page = document.new_page(width=600, height=800)
        page.insert_text((50, 80), f"手续费 第 {index + 1} 页", fontname="china-s")
    document.save(source_path)
    document.close()
    original_bytes = source_path.read_bytes()
    original_hash = hashlib.sha256(original_bytes).hexdigest()

    output_path = export_segments(
        source_path,
        tmp_path / "results" / "matches.pdf",
        [PdfSegment(1, Rect(0, 0, 300, 200)), PdfSegment(2, keep_full_page=True)],
    )

    assert output_path.exists()
    result = pymupdf.open(output_path)
    assert result.page_count == 2
    result.close()
    assert source_path.read_bytes() == original_bytes
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == original_hash


def test_export_merged_segments_combines_sources_without_touching_inputs(tmp_path: Path) -> None:
    sources: list[Path] = []
    for index in range(2):
        source = tmp_path / f"source-{index}.pdf"
        document = pymupdf.open()
        page = document.new_page(width=200, height=200)
        page.insert_text((20, 40), f"手续费 {index}")
        document.save(source)
        document.close()
        sources.append(source)
    output = export_merged_segments(
        tmp_path / "merged.pdf",
        [(sources[0], [PdfSegment(1, keep_full_page=True)]), (sources[1], [PdfSegment(1, keep_full_page=True)])],
    )
    result = pymupdf.open(output)
    assert result.page_count == 2
    result.close()


def test_export_segments_rejects_out_of_bounds_or_tiny_rectangles(tmp_path: Path) -> None:
    source = _source_pdf(tmp_path)

    with pytest.raises(ValueError, match="rectangle"):
        export_segments(
            source,
            tmp_path / "out-of-bounds.pdf",
            [PdfSegment(1, Rect(-1, 0, 200, 200))],
        )

    with pytest.raises(ValueError, match="rectangle"):
        export_segments(
            source,
            tmp_path / "tiny.pdf",
            [PdfSegment(1, Rect(0, 0, 1, 1))],
        )
