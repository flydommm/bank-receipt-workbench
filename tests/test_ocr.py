from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest

from engine.ocr import OcrUnavailableError, is_scanned_page, normalize_result_payload, recognize_image, runtime_status
from engine import ocr_pdf
from engine.ocr_pdf import render_page_to_png
from engine.pdf_parser import ParsedPage, TextBlock


def test_is_scanned_page_detects_missing_text_layer() -> None:
    scanned = ParsedPage(1, 600, 800, "", ())
    text_page = ParsedPage(2, 600, 800, "手续费 交易日期 2025年10月30日", (TextBlock(2, "手续费", 1, 1, 30, 12, 0),))
    assert is_scanned_page(scanned)
    assert not is_scanned_page(text_page)


def test_render_page_to_png_creates_intermediate_image(tmp_path: Path) -> None:
    source = tmp_path / "scan.pdf"
    document = pymupdf.open()
    document.new_page(width=300, height=300)
    document.save(source)
    document.close()
    image = render_page_to_png(source, 1, tmp_path / "rendered", dpi=100)
    assert image.exists()
    assert image.stat().st_size > 0


def test_render_page_to_png_rejects_extreme_page_before_pixmap_allocation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class HugePage:
        class Rect:
            width = 20_000
            height = 20_000

        rect = Rect()

        def get_pixmap(self, **_kwargs):
            raise AssertionError("pixmap allocation must not be reached")

    class HugeDocument:
        page_count = 1

        @staticmethod
        def load_page(_index: int) -> HugePage:
            return HugePage()

        @staticmethod
        def close() -> None:
            return None

    monkeypatch.setattr(ocr_pdf.pymupdf, "open", lambda _path: HugeDocument())

    with pytest.raises(ValueError, match="pixel budget"):
        render_page_to_png(tmp_path / "huge.pdf", 1, tmp_path / "rendered")


def test_normalize_result_payload_accepts_wrapped_json() -> None:
    assert normalize_result_payload('{"res":{"rec_texts":["手续费"]}}')["rec_texts"] == ["手续费"]


def test_missing_paddleocr_is_explicit() -> None:
    if runtime_status()["available"]:
        pytest.skip("PaddleOCR runtime is installed; missing-runtime branch is not applicable")
    with pytest.raises(OcrUnavailableError, match="PaddleOCR"):
        recognize_image("not-used.png")
