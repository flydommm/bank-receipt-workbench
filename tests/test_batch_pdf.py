"""Batch page computation uses synthetic copies and preserves original files."""

from hashlib import sha256
from pathlib import Path

import pymupdf
import pytest

from engine import batch_pdf
from engine.batch_pdf import BatchSourceError, open_batch_source
from engine.search import SearchBudget


@pytest.fixture(autouse=True)
def private_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))


def pdf(tmp_path, text=True):
    path = tmp_path / "source.pdf"
    with pymupdf.open() as document:
        for number in range(3):
            page = document.new_page(width=600, height=800)
            page.draw_rect(pymupdf.Rect(40, 20, 560, 300))
            if text:
                page.insert_text((60, 70), f"fee bank page {number + 1}")
        document.save(path)
    return path


def test_copy_is_sha_bound_and_pages_reuse_open_pdf(tmp_path, monkeypatch):
    path = pdf(tmp_path)
    digest = sha256(path.read_bytes()).hexdigest()
    with open_batch_source(path, digest) as source:
        assert source.sha256 == digest and source.page_count == 3
        assert source.snapshot_path != path
        copied_path = source.snapshot_path
        monkeypatch.setattr(pymupdf, "open", lambda *_args, **_kwargs: pytest.fail("page computation reopened the PDF"))
        budget = SearchBudget()
        pages = [source.compute_page(number, {"include": ["fee"], "includeMode": "all", "exclude": []}, "exact", budget)
                 for number in (1, 2, 3)]
        assert all(page["matches"] and page["analysis"]["selections"] for page in pages)
        assert budget.processed_pages == 3
    assert not copied_path.exists()
    assert sha256(path.read_bytes()).hexdigest() == digest


def test_wrong_sha_and_configured_limits_reject_before_computation(tmp_path, monkeypatch):
    path = pdf(tmp_path)
    with pytest.raises(BatchSourceError) as changed:
        with open_batch_source(path, "b" * 64):
            pytest.fail("wrong source accepted")
    assert changed.value.code == "source_changed"
    monkeypatch.setattr(batch_pdf.core, "ENGINE_CONFIG", batch_pdf.core.EngineConfig(max_pages=2))
    with pytest.raises(BatchSourceError) as limited:
        with open_batch_source(path):
            pytest.fail("over-limit source accepted")
    assert limited.value.code == "page_limit_exceeded"
    assert path.exists()


def test_zero_hits_do_not_analyze_layout_and_keep_page_budget(tmp_path, monkeypatch):
    path = pdf(tmp_path)
    monkeypatch.setattr(batch_pdf.core, "_analyze_page_geometry", lambda *_args, **_kwargs: pytest.fail("unneeded layout"))
    with open_batch_source(path) as source:
        budget = SearchBudget()
        result = source.compute_page(2, {"include": ["absent"], "includeMode": "all", "exclude": []}, "exact", budget)
    assert result["matches"] == [] and result["analysis"] is None
    assert result["page"] == 2 and budget.processed_pages == 1
    assert budget.text_characters > 0


def test_ocr_uses_loaded_page_scales_coordinates_and_releases_image(tmp_path, monkeypatch):
    path = pdf(tmp_path, text=False)
    images = []

    def recognize(image_path, language="ch"):
        images.append(Path(image_path))
        assert Path(image_path).exists() and language == "ch"
        return [{"text": "fee bank", "box": [200, 200, 400, 250], "confidence": 0.91}]

    monkeypatch.setattr(batch_pdf, "recognize_image", recognize)
    with open_batch_source(path) as source:
        result = source.compute_page(1, {"include": ["fee", "bank"], "includeMode": "all", "exclude": []}, "exact", SearchBudget())
    assert len(result["matches"]) == 2
    assert [hit["query_id"] for hit in result["matches"]] == ["include-0", "include-1"]
    assert result["matches"][0]["x0"] == 72
    assert all(not image.exists() for image in images)


def test_only_requested_page_is_parsed_for_resume(tmp_path, monkeypatch):
    path = pdf(tmp_path)
    parsed = []
    original = batch_pdf.parse_loaded_page

    def parse(page, number):
        parsed.append(number)
        return original(page, number)

    monkeypatch.setattr(batch_pdf, "parse_loaded_page", parse)
    with open_batch_source(path) as source:
        source.compute_page(3, {"include": ["fee"], "includeMode": "all", "exclude": []}, "exact", SearchBudget())
    assert parsed == [3]


@pytest.mark.parametrize("hit_confidence", [0.99, 0.8])
def test_scanned_receipt_layout_uses_the_recognized_text_layer(tmp_path, monkeypatch, hit_confidence):
    path = tmp_path / "scan.pdf"
    # One full-page bitmap has no native PDF text or vector separators.
    with pymupdf.open() as drawing:
        page = drawing.new_page(width=600, height=800)
        image = page.get_pixmap().tobytes("png")
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=800)
        page.insert_image(page.rect, stream=image)
        document.save(path)

    records = []
    for slot, top in enumerate((40, 290, 540)):
        lines = [("回 单", 270, top, 330, top + 14)]
        lines.extend(("fee" if slot == 1 and line == 4 else f"field {line}",
                      40, top + 25 + line * 15, 560, top + 36 + line * 15)
                     for line in range(12))
        records.extend({"text": text, "box": [value * 200 / 72 for value in box], "confidence": 0.99}
                       for text, *box in lines)
    monkeypatch.setattr(batch_pdf, "recognize_image", lambda *_args, **_kwargs: records)
    for record in records:
        if record["text"] == "fee":
            record["confidence"] = hit_confidence
    with open_batch_source(path) as source:
        result = source.compute_page(1, {"include": ["fee"], "includeMode": "all", "exclude": []}, "exact", SearchBudget())
    assert len(result["matches"]) == 1
    assert result["analysis"]["page_fully_matched"] is False
    selection = result["analysis"]["selections"][0]
    assert selection["slot"] == "middle"
    assert 250 < selection["rect"]["y0"] < 300
    assert 480 < selection["rect"]["y1"] < 540
    assert selection["confidence"] <= hit_confidence
    assert selection["needs_review"] is (hit_confidence < 0.9)
    if hit_confidence >= 0.9:
        assert selection["confidence"] >= 0.9


@pytest.mark.parametrize("keyword, expected_slot", [("fee", "top"), ("bank", "middle")])
def test_uncertain_ocr_title_requires_review_on_both_sides_of_boundary(
    tmp_path, monkeypatch, keyword, expected_slot,
):
    path = tmp_path / "uncertain-title-scan.pdf"
    with pymupdf.open() as drawing:
        page = drawing.new_page(width=600, height=800)
        image = page.get_pixmap().tobytes("png")
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=800)
        page.insert_image(page.rect, stream=image)
        document.save(path)

    records = []

    def add(text, y, confidence=0.99):
        records.append({"text": text, "confidence": confidence,
                        "box": [value * 200 / 72 for value in (40, y, 560, y + 8)]})

    add("回单", 40)
    for index, y in enumerate(range(60, 150, 10)):
        add("fee" if index == 2 else f"field {index}", y)
    # OCR invents a title inside the first receipt, whose body ends at y=368.
    # Previously the resulting truncated candidate scored 0.98 and was accepted.
    add("回单", 160, confidence=0.51)
    for index, y in enumerate(range(180, 361, 15)):
        add("bank" if index == 2 else f"body {index}", y)
    add("回单", 400)
    for index, y in enumerate(range(420, 701, 20)):
        add(f"other {index}", y)

    monkeypatch.setattr(batch_pdf, "recognize_image", lambda *_args, **_kwargs: records)
    with open_batch_source(path) as source:
        result = source.compute_page(
            1, {"include": [keyword], "includeMode": "all", "exclude": []}, "exact", SearchBudget(),
        )

    assert len(result["matches"]) == 1
    assert result["matches"][0]["confidence"] == 0.99
    assert result["analysis"]["page_fully_matched"] is False
    selection = result["analysis"]["selections"][0]
    # Retain the uncertain boundary for manual review rather than dropping the
    # title and silently merging what may actually be distinct receipts.
    assert selection["slot"] == expected_slot
    if keyword == "fee":
        assert 30 < selection["rect"]["y0"] < 40
        assert 140 < selection["rect"]["y1"] < 160
    else:
        assert 150 < selection["rect"]["y0"] < 160
        assert 360 < selection["rect"]["y1"] < 400
    assert selection["confidence"] <= 0.51
    assert selection["needs_review"] is True


def test_native_layout_retains_text_metadata_without_calling_ocr(tmp_path, monkeypatch):
    from dataclasses import replace
    path = pdf(tmp_path)
    original_parse = batch_pdf.parse_loaded_page
    parsed_pages = []
    def parse(page, number):
        parsed = original_parse(page, number)
        parsed = replace(parsed, blocks=tuple(replace(block, is_watermark=True) for block in parsed.blocks))
        parsed_pages.append(parsed)
        return parsed
    analyzed = []
    original_analyze = batch_pdf.core._analyze_page_geometry
    def analyze(path, number, parsed, **options):
        analyzed.append(parsed)
        return original_analyze(path, number, parsed, **options)
    monkeypatch.setattr(batch_pdf, "parse_loaded_page", parse)
    monkeypatch.setattr(batch_pdf.core, "_analyze_page_geometry", analyze)
    monkeypatch.setattr(batch_pdf, "recognize_image", lambda *_args, **_kwargs: pytest.fail("native PDF must not run OCR"))
    with open_batch_source(path) as source:
        source.compute_page(1, {"include": ["fee"], "includeMode": "all", "exclude": []}, "exact", SearchBudget())
    assert analyzed[0] is parsed_pages[0]
    assert all(block.is_watermark for block in analyzed[0].blocks)
