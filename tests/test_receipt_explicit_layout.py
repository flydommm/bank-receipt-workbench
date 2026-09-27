"""Explicit drafts retain content/risk checks without redetecting their geometry."""
from copy import deepcopy
from hashlib import sha256

import pymupdf
import pytest

from engine import batch_pdf
from engine.batch_pdf import open_batch_source
from engine.receipt_layout import LayoutSuggestion, compute_receipt_page
from engine.receipt_layout_models import ReceiptLayoutError
from engine.pdf_parser import visible_page
from engine.search import SearchBudget
from tests.test_receipt_batch_pdf import ALL, SEARCH, make_source


@pytest.fixture(autouse=True)
def private_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))


@pytest.mark.parametrize("options", [SEARCH, ALL])
@pytest.mark.parametrize("count", [1, 2, 3])
def test_explicit_draft_matches_full_evidence_without_redetection(tmp_path, monkeypatch, options, count):
    path = make_source(tmp_path, (3, count))
    original = sha256(path.read_bytes()).hexdigest()
    with open_batch_source(path) as source:
        initial = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), allow_ocr=False)
        draft = deepcopy(initial.result["layout_definition"])
        draft["revision"] += 1
        # Move a boundary across content to ensure risks and fresh keyword
        # membership are compared, not just unchanged rectangle serialization.
        draft["uniform_height"] = False
        draft["slots"][0]["height_pt"] = 100
        evidence = source._page_evidence(2, allow_ocr=False)
        expected = compute_receipt_page(evidence, source.sha256, options, budget=SearchBudget(),
            suggestion=LayoutSuggestion(draft, "manual_layout", True),
            visible_page=visible_page(source._document.load_page(1)))
    with open_batch_source(path) as source:
        def unnecessary(*_args, **_kwargs):
            pytest.fail("explicit draft repeated automatic geometry / descriptor extraction")
        monkeypatch.setattr(batch_pdf.core, "_analyze_page_geometry", unnecessary)
        monkeypatch.setattr(batch_pdf, "describe_crop_page", unnecessary)
        actual = source.compute_receipt_page(2, options, "exact", SearchBudget(),
            layout_definition=draft, allow_ocr=False)
        assert actual == expected
        assert actual.diagnostics
    assert sha256(path.read_bytes()).hexdigest() == original


def test_explicit_draft_preserves_special_notice_and_visual_boundary_risk(tmp_path):
    path = make_source(tmp_path, (1,), title="贷款利息到期通知书")
    with pymupdf.open(path) as doc:
        doc[0].draw_rect(pymupdf.Rect(200, 250, 320, 350), fill=(1, 0, 0))
        doc.saveIncr()
    with open_batch_source(path) as source:
        initial = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), allow_ocr=False)
        draft = deepcopy(initial.result["layout_definition"])
        draft["slots"][0].update(top_pt=0, height_pt=300)
        result = source.compute_receipt_page(1, ALL, "exact", SearchBudget(),
            layout_definition=draft, allow_ocr=False)
        assert {"code": "special_document", "document_type": "loan_interest_notice"} in result.diagnostics
        assert any(item["code"] == "visual_crosses_slot" for item in result.diagnostics)


def test_explicit_scanned_page_still_requests_ocr_and_retains_unknown_occupancy(tmp_path, monkeypatch):
    path = tmp_path / "scan.pdf"
    with pymupdf.open() as canvas:
        page = canvas.new_page(width=600, height=900)
        page.draw_rect(pymupdf.Rect(20, 20, 580, 850))
        bitmap = page.get_pixmap().tobytes("png")
    with pymupdf.open() as doc:
        doc.new_page(width=600, height=900).insert_image(pymupdf.Rect(0, 0, 600, 900), stream=bitmap)
        doc.save(path)
    calls = []
    monkeypatch.setattr(batch_pdf, "recognize_image", lambda *_args, **_kwargs: calls.append(1) or [])
    with open_batch_source(path) as source:
        initial = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), slot_count=3, allow_ocr=False)
        result = source.compute_receipt_page(1, ALL, "exact", SearchBudget(),
            layout_definition=initial.result["layout_definition"], allow_ocr=True)
        assert calls == [1]
        assert result.result["excluded_slots"] == []
        assert all(item["needs_review"] for item in result.result["candidates"])


def test_explicit_read_does_not_replace_automatic_evidence_cache(tmp_path, monkeypatch):
    path = make_source(tmp_path, (3, 1))
    with open_batch_source(path) as source:
        expected = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), allow_ocr=False)
    with open_batch_source(path) as source:
        source.compute_receipt_page(1, ALL, "exact", SearchBudget(),
            layout_definition=expected.result["layout_definition"], allow_ocr=False)
        assert source.compute_receipt_page(1, ALL, "exact", SearchBudget(), allow_ocr=False) == expected


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_explicit_draft_preserves_visible_geometry_and_rejects_mismatched_page(tmp_path, rotation):
    path = make_source(tmp_path, (1,))
    with pymupdf.open(path) as doc:
        page = doc[0]
        page.set_cropbox(pymupdf.Rect(10, 10, 590, 890))
        page.set_rotation(rotation)
        doc.xref_set_key(page.xref, "UserUnit", "1.5")
        doc.saveIncr()
    with open_batch_source(path) as source:
        automatic = source.compute_receipt_page(1, ALL, "exact", SearchBudget(), slot_count=1, allow_ocr=False)
        draft = automatic.result["layout_definition"]
        evidence = source._page_evidence(1, allow_ocr=False)
        expected = compute_receipt_page(evidence, source.sha256, ALL, budget=SearchBudget(),
            suggestion=LayoutSuggestion(draft, "manual_layout", True),
            visible_page=visible_page(source._document.load_page(0)))
        assert source.compute_receipt_page(1, ALL, "exact", SearchBudget(),
            layout_definition=draft, allow_ocr=False) == expected
        invalid = deepcopy(draft)
        invalid["page_geometry"]["rotation"] = (rotation + 90) % 360
        with pytest.raises(ReceiptLayoutError):
            source.compute_receipt_page(1, ALL, "exact", SearchBudget(),
                layout_definition=invalid, allow_ocr=False)
