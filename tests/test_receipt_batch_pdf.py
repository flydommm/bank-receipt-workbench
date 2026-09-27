"""New page pipeline on SHA-bound synthetic PDF working copies."""

from hashlib import sha256

import pymupdf
import pytest

from engine import batch_pdf
from engine.batch_pdf import open_batch_source
from engine.receipt_layout_models import ReceiptLayoutError
from engine.search import SearchBudget


SEARCH = {"processing_mode": "search", "criteria": {"include": ["TARGET"], "includeMode": "all", "exclude": []}}
ALL = {"processing_mode": "split_all", "criteria": None}


@pytest.fixture(autouse=True)
def private_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))


def make_source(tmp_path, counts=(3, 1), *, title="上海银行业务回单", last_page_shift=0):
    path = tmp_path / "synthetic.pdf"
    with pymupdf.open() as document:
        for page_index, count in enumerate(counts):
            page = document.new_page(width=600, height=900)
            for index in range(count):
                top = 50 + index * 280 + (last_page_shift if page_index == len(counts) - 1 else 0)
                page.insert_text((50, top), title, fontname="china-s")
                for y, text in ((30, "付款人名称：合成甲公司"), (60, "收款人名称：合成乙公司"),
                                (90, "交易金额：123.00"), (120, "摘要：TARGET"), (150, "打印时间：2026-01-01")):
                    page.insert_text((50, top + y), text, fontname="china-s")
                page.draw_line((20, top + 10), (580, top + 10))
                page.draw_line((20, top + 210), (580, top + 210))
        document.save(path)
    return path


@pytest.mark.parametrize("tail_count", [1, 2])
def test_tail_read_first_uses_full_source_layout_and_source_stays_unchanged(tmp_path, tail_count):
    path = make_source(tmp_path, (3, tail_count))
    original = path.read_bytes()
    with open_batch_source(path, sha256(original).hexdigest()) as source:
        budget = SearchBudget()
        tail = source.compute_receipt_page(2, SEARCH, "exact", budget, allow_ocr=False)
        full = source.compute_receipt_page(1, SEARCH, "exact", budget, allow_ocr=False)
        assert tail.suggestion.basis == "source_reference"
        assert len(tail.result["layout_definition"]["slots"]) == 3
        assert len(tail.result["candidates"]) == tail_count
        assert len(full.result["candidates"]) == 3
        assert tail.result["instances"][0]["rect"] == full.result["instances"][0]["rect"]
        assert budget.processed_pages == 2  # Reference inspection is not another search.
        snapshot = source.snapshot_path
    assert not snapshot.exists() and path.read_bytes() == original


def test_native_single_source_retains_full_visible_page(tmp_path):
    path = make_source(tmp_path, (1, 1), title="中国工商银行业务回单")
    with open_batch_source(path) as source:
        result = source.compute_receipt_page(1, SEARCH, "exact", SearchBudget(), allow_ocr=False)
    assert result.suggestion.basis == "native_single"
    assert result.result["instances"][0]["rect"] == {"x0": 0, "y0": 0, "x1": 600, "y1": 900}


def test_query_change_reuses_evidence_and_stable_slots(tmp_path, monkeypatch):
    path = make_source(tmp_path)
    calls = []
    original = batch_pdf.core._analyze_page_geometry
    def analyze(*args, **kwargs):
        calls.append(args[1])
        return original(*args, **kwargs)
    monkeypatch.setattr(batch_pdf.core, "_analyze_page_geometry", analyze)
    with open_batch_source(path) as source:
        first = source.compute_receipt_page(1, SEARCH, "exact", SearchBudget(), allow_ocr=False)
        absent = {"processing_mode": "search", "criteria": {"include": ["ABSENT"], "includeMode": "all", "exclude": []}}
        second = source.compute_receipt_page(1, absent, "exact", SearchBudget(), allow_ocr=False)
        third = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), allow_ocr=False)
    assert calls == [1]
    assert first.result["instances"] == second.result["instances"] == third.result["instances"]
    assert len(first.result["candidates"]) == len(third.result["candidates"]) == 3
    assert second.result["candidates"] == []


def test_core_scan_is_uncertain_and_an_empty_ocr_result_is_cached(tmp_path, monkeypatch):
    path = tmp_path / "scan.pdf"
    with pymupdf.open() as drawing:
        page = drawing.new_page(width=600, height=900)
        page.draw_rect(pymupdf.Rect(20, 20, 580, 850))
        bitmap = page.get_pixmap().tobytes("png")
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        page.insert_image(page.rect, stream=bitmap)
        document.save(path)
    calls = []
    def recognize(*args, **kwargs):
        calls.append(1)
        return []
    monkeypatch.setattr(batch_pdf, "recognize_image", recognize)
    with open_batch_source(path) as source:
        core = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), slot_count=3, allow_ocr=False)
        assert calls == []
        assert len(core.result["candidates"]) == 3
        assert all(candidate["needs_review"] for candidate in core.result["candidates"])
        for _ in range(2):
            result = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), slot_count=3, allow_ocr=True)
            assert result.result["excluded_slots"] == []
    assert calls == [1]


def test_invalid_options_reject_before_page_evidence(tmp_path, monkeypatch):
    with open_batch_source(make_source(tmp_path)) as source:
        monkeypatch.setattr(source, "_page_evidence", lambda *_a, **_k: pytest.fail("invalid request analyzed a page"))
        with pytest.raises(ReceiptLayoutError):
            source.compute_receipt_page(1, {"processing_mode": "search", "criteria": None}, "exact", SearchBudget())


def test_result_mutation_does_not_change_cached_evidence_or_next_result(tmp_path):
    with open_batch_source(make_source(tmp_path)) as source:
        first = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), allow_ocr=False)
        first.result["layout_definition"]["slots"][0]["height_pt"] = 13
        first.result["instances"].clear()
        next_result = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), allow_ocr=False)
        assert len(next_result.result["instances"]) == 3
        assert next_result.result["layout_definition"]["slots"][0]["height_pt"] > 13


def test_full_reference_budget_does_not_evict_and_recompute_active_tail(tmp_path, monkeypatch):
    path = make_source(tmp_path, (3,) * 16 + (1,))
    calls = []
    original = batch_pdf.core._analyze_page_geometry
    def analyze(*args, **kwargs):
        calls.append(args[1])
        return original(*args, **kwargs)
    monkeypatch.setattr(batch_pdf.core, "_analyze_page_geometry", analyze)
    with open_batch_source(path) as source:
        first = source.compute_receipt_page(17, ALL, "exact", SearchBudget(), allow_ocr=False)
        assert len(calls) == 17
        second = source.compute_receipt_page(17, SEARCH, "exact", SearchBudget(), allow_ocr=False)
        assert len(calls) == 17
        assert first.result["instances"] == second.result["instances"]


def test_sequential_pages_reuse_full_reference_budget_without_repeated_geometry_analysis(tmp_path, monkeypatch):
    path = make_source(tmp_path, (3,) * 39 + (1,))
    calls = []
    original = batch_pdf.core._analyze_page_geometry
    def analyze(*args, **kwargs):
        calls.append(args[1])
        return original(*args, **kwargs)
    monkeypatch.setattr(batch_pdf.core, "_analyze_page_geometry", analyze)
    with open_batch_source(path) as source:
        budget = SearchBudget()
        first = None
        for page in range(1, 41):
            result = source.compute_receipt_page(page, ALL, "exact", budget, allow_ocr=False)
            if first is None:
                first = result
        assert result.result["instances"][0]["rect"] == first.result["instances"][0]["rect"]
        assert budget.processed_pages == 40
    assert len(calls) == len(set(calls)) == 40


def test_reference_candidates_remain_bounded_after_visiting_later_pages(tmp_path, monkeypatch):
    from engine import source_layout
    monkeypatch.setattr(source_layout, "MAX_MULTI_TEMPLATE_PAGES", 2)
    path = make_source(tmp_path, (3,) * 8 + (1,))
    with open_batch_source(path) as source:
        for page in range(1, 9):
            source.compute_receipt_page(page, ALL, "exact", SearchBudget(), allow_ocr=False)
        index = source._source_layout
        assert index is not None
        evidence = source._page_evidence(9, allow_ocr=False)
        assert len(index.matching_reference_pages(9, evidence.parsed)) <= 2


def test_receipt_page_and_reference_scan_share_descriptors_only_within_source(tmp_path, monkeypatch):
    from engine import source_layout
    path = make_source(tmp_path, (3,) * 39 + (1,))
    calls = []
    original = batch_pdf.describe_crop_page

    def describe(page):
        calls.append(page.number + 1)
        return original(page)

    monkeypatch.setattr(batch_pdf, "describe_crop_page", describe)
    monkeypatch.setattr(source_layout, "describe_crop_page", describe)
    first_result = None
    for run in range(2):
        with open_batch_source(path) as source:
            for page in range(1, 41):
                result = source.compute_receipt_page(page, ALL, "exact", SearchBudget(), allow_ocr=False)
                if page == 1:
                    if first_result is None:
                        first_result = result
                    else:
                        assert result == first_result
            assert len(calls) == (run + 1) * 40
            # Revisit an evicted page with another query: descriptor identity
            # remains source-local and independent of keyword membership.
            searched = source.compute_receipt_page(1, SEARCH, "exact", SearchBudget(), allow_ocr=False)
            assert searched.result["instances"] == first_result.result["instances"]
            assert len(calls) == (run + 1) * 40
    assert all(calls.count(page) == 2 for page in range(1, 41))


def test_same_receipt_form_with_changed_page_positions_requires_review_on_repeated_queries(tmp_path):
    path = make_source(tmp_path, (3, 2), last_page_shift=2)
    with open_batch_source(path) as source:
        for setting in (ALL, SEARCH):
            result = source.compute_receipt_page(2, setting, "exact", SearchBudget(), allow_ocr=False)
            assert result.suggestion.basis == "page_evidence"
            assert result.suggestion.needs_review
            assert {"code": "reference_position_mismatch"} in result.diagnostics
            assert len(result.result["instances"]) == 2
            assert all(candidate["needs_review"] for candidate in result.result["candidates"])


def test_native_tail_reuses_source_heading_and_geometry_when_descriptor_unavailable(tmp_path, monkeypatch):
    import engine.source_layout as source_layout
    unavailable = lambda *args, **kwargs: {"status": "unavailable", "receipts": []}
    monkeypatch.setattr(batch_pdf, "describe_crop_page", unavailable)
    monkeypatch.setattr(source_layout, "describe_crop_page", unavailable)
    path = make_source(tmp_path, (3, 1))
    with open_batch_source(path) as source:
        tail = source.compute_receipt_page(2, SEARCH, "exact", SearchBudget(), allow_ocr=False)
        first = source.compute_receipt_page(1, SEARCH, "exact", SearchBudget(), allow_ocr=False)
    assert tail.suggestion.basis == "source_reference"
    assert tail.result["instances"][0]["rect"] == first.result["instances"][0]["rect"]
    assert len(tail.result["instances"]) == 1
