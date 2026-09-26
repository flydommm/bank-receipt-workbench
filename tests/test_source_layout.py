"""Synthetic source layouts protect native receipts and split multi-copy tails."""

from hashlib import sha256
from pathlib import Path

import pymupdf
import pytest

from engine import source_layout
from engine.batch_pdf import open_batch_source
from engine.engine import handle_request
from engine.pdf_parser import parse_loaded_page
from engine.search import SearchBudget
from engine.source_layout import SourceLayoutIndex


CRITERIA = {"include": ["TARGET"], "includeMode": "all", "exclude": []}


@pytest.fixture(autouse=True)
def private_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))


def write_receipts(path: Path, pages, *, title="上海银行业务回单", lines=True):
    """Each page is (slot count, target slot or None, optional heading)."""
    with pymupdf.open() as document:
        for count, target, *heading in pages:
            page = document.new_page(width=600, height=900)
            for slot in range(count):
                top = 50 + slot * 280
                page.insert_text((50, top), heading[0] if heading else title, fontname="china-s")
                page.insert_text((50, top + 30), "付款人名称：合成甲公司", fontname="china-s")
                page.insert_text((50, top + 60), "收款人名称：合成乙公司", fontname="china-s")
                page.insert_text((50, top + 90), "交易金额：123.00", fontname="china-s")
                page.insert_text((50, top + 120), "摘要：" + ("TARGET" if slot == target else "OTHER"), fontname="china-s")
                page.insert_text((50, top + 150), "打印时间：2026-01-01", fontname="china-s")
                if lines:
                    page.draw_line((20, top + 10), (580, top + 10))
                    page.draw_line((20, top + 210), (580, top + 210))
        document.save(path)


def analyze(path, page):
    with open_batch_source(path) as source:
        return source.compute_page(page, CRITERIA, "exact", SearchBudget())["analysis"]


def test_native_single_receipt_retains_full_page_even_with_only_upper_body(tmp_path):
    path = tmp_path / "native.pdf"
    write_receipts(path, [(1, 0)] * 3, title="中国工商银行业务回单", lines=False)
    before = sha256(path.read_bytes()).hexdigest()
    analysis = analyze(path, 2)
    assert analysis["page_fully_matched"] is True
    selection = analysis["selections"][0]
    assert selection["candidate_rect"]["y1"] < 450
    assert selection["rect"] == {"x0": 0, "y0": 0, "x1": 600, "y1": 900}
    assert "source_layout_uncertain" not in selection["evidence"]
    assert sha256(path.read_bytes()).hexdigest() == before


def test_unknown_single_receipt_protects_full_page_and_requires_review(tmp_path):
    path = tmp_path / "unknown.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        page.insert_text((50, 50), "TARGET unrecognized form")
        document.save(path)
    analysis = analyze(path, 1)
    assert analysis["page_fully_matched"] is True
    selection = analysis["selections"][0]
    assert selection["confidence"] <= 0.89 and selection["needs_review"] is True
    assert "source_layout_uncertain" in selection["evidence"]
    assert selection["candidate_rect"] is not None


def test_tail_uses_unmatched_same_template_reference_and_keeps_same_size(tmp_path):
    path = tmp_path / "tail.pdf"
    write_receipts(path, [(3, None), (1, 0)])
    with open_batch_source(path) as source:
        empty = source.compute_page(1, CRITERIA, "exact", SearchBudget())
        assert empty["matches"] == [] and empty["analysis"] is None
        tail = source.compute_page(2, CRITERIA, "exact", SearchBudget())["analysis"]
        reference = source.compute_page(1, {**CRITERIA, "include": ["OTHER"]}, "exact", SearchBudget())["analysis"]
    assert tail["page_fully_matched"] is False
    assert reference["page_fully_matched"] is False
    assert len(reference["selections"]) == 3
    tail_rect = tail["selections"][0]["rect"]
    first_rect = reference["selections"][0]["rect"]
    assert tail_rect == first_rect


def test_mixed_single_template_is_not_changed_by_other_bank_multi_receipts(tmp_path):
    path = tmp_path / "mixed.pdf"
    write_receipts(path, [(3, None), (1, 0, "中国工商银行业务回单")])
    analysis = analyze(path, 2)
    assert analysis["page_fully_matched"] is True
    assert "source_layout_uncertain" not in analysis["selections"][0]["evidence"]


def test_same_bank_different_table_template_is_not_treated_as_multi_tail(tmp_path):
    base = tmp_path / "same-bank-base.pdf"
    path = tmp_path / "same-bank-different.pdf"
    write_receipts(base, [(3, None), (1, 0)])
    with pymupdf.open(base) as document:
        # A separate receipt template has another stable internal table line.
        document[1].draw_line((20, 225), (580, 225))
        document.save(path)
    analysis = analyze(path, 2)
    assert analysis["page_fully_matched"] is True
    assert "source_layout_uncertain" not in analysis["selections"][0]["evidence"]


def test_missing_bank_identity_in_multi_reference_requires_review_instead_of_guessing(tmp_path):
    path = tmp_path / "no-bank.pdf"
    write_receipts(path, [(3, None), (1, 0)], title="银行客户回单")
    analysis = analyze(path, 2)
    assert analysis["page_fully_matched"] is True
    assert "source_layout_uncertain" in analysis["selections"][0]["evidence"]


def test_verified_receipt_in_partial_reference_can_prove_only_positive_template_match(tmp_path, monkeypatch):
    path = tmp_path / 'partial-reference.pdf'
    write_receipts(path, [(3, None), (1, 0), (1, 0, '中国工商银行业务回单')])
    describe = source_layout.describe_crop_page
    def partial(page):
        result = describe(page)
        if page.number == 0 and result['status'] == 'ready':
            result['receipts'][-1]['issuer_bank_key'] = None
            result['receipts'][-1]['template_fingerprint'] = None
        return result
    monkeypatch.setattr(source_layout, 'describe_crop_page', partial)
    with open_batch_source(path) as source:
        known = source.compute_page(2, CRITERIA, 'exact', SearchBudget())['analysis']
        unknown = source.compute_page(3, CRITERIA, 'exact', SearchBudget())['analysis']
    assert known['page_fully_matched'] is False
    assert 'source_multi_receipt_layout' in known['selections'][0]['evidence']
    assert unknown['page_fully_matched'] is True
    assert 'source_layout_uncertain' in unknown['selections'][0]['evidence']


def test_reference_budget_covers_later_distinct_form_before_duplicate_pages(tmp_path, monkeypatch):
    path = tmp_path / 'different-forms.pdf'
    write_receipts(path, [(3, None)] * 20 + [(3, None, '样例银行客户回单'), (1, 0, '样例银行客户回单')])
    monkeypatch.setattr(source_layout, 'MAX_MULTI_TEMPLATE_PAGES', 2)
    result = analyze(path, 22)
    assert result['page_fully_matched'] is False
    assert 'source_multi_receipt_layout' in result['selections'][0]['evidence']


def test_protocol_and_durable_analysis_agree_for_a_tail(tmp_path):
    path = tmp_path / "same.pdf"
    write_receipts(path, [(3, None), (1, 0)])
    batch_analysis = analyze(path, 2)
    response = handle_request({
        "op": "analyze_page", "path": str(path), "page": 2,
        "source_sha256": sha256(path.read_bytes()).hexdigest(),
        "matches": [selection["match_rect"] for selection in batch_analysis["selections"]],
    })
    assert response["status"] == "ok"
    assert response["page_fully_matched"] is False
    assert response["selections"] == batch_analysis["selections"]


def test_explicit_vacant_slots_are_not_included_in_the_tail_candidate(tmp_path):
    base = tmp_path / "base.pdf"
    path = tmp_path / "vacant.pdf"
    write_receipts(base, [(1, 0)])
    with pymupdf.open(base) as document:
        page = document[0]
        page.insert_text((220, 450), "此处白纸无效！", fontname="china-s")
        page.insert_text((220, 720), "此处白纸无效！", fontname="china-s")
        document.save(path)
    analysis = analyze(path, 1)
    assert analysis["page_fully_matched"] is False
    assert analysis["selections"][0]["rect"]["y1"] < 300


def test_standalone_blank_copy_marker_is_excluded_from_candidate(tmp_path):
    base = tmp_path / "blank-copy-marker-base.pdf"
    path = tmp_path / "blank-copy-marker.pdf"
    write_receipts(base, [(1, 0)])
    with pymupdf.open(base) as document:
        page = document[0]
        page.insert_text((220, 450), "此空白联无效！", fontname="china-s")
        page.insert_text((220, 720), "此空白联无效！", fontname="china-s")
        document.save(path)

    analysis = analyze(path, 1)

    assert analysis["page_fully_matched"] is False
    assert analysis["selections"][0]["rect"]["y1"] < 300


def test_blank_copy_marker_quoted_in_body_is_retained(tmp_path):
    base = tmp_path / "quoted-blank-copy-marker-base.pdf"
    path = tmp_path / "quoted-blank-copy-marker.pdf"
    write_receipts(base, [(1, 0)], title="中国工商银行业务回单", lines=False)
    with pymupdf.open(base) as document:
        document[0].insert_textbox(
            pymupdf.Rect(50, 420, 560, 480),
            "备注：印刷字样‘此空白联无效！’仅供说明\n附言：合成交易附加信息",
            fontname="china-s",
            fontsize=11,
        )
        document.save(path)

    analysis = analyze(path, 1)

    assert analysis["page_fully_matched"] is True
    assert analysis["selections"][0]["candidate_rect"]["y1"] > 450
    assert "source_multi_receipt_layout" not in analysis["selections"][0]["evidence"]


def test_native_receipt_note_quoting_vacant_wording_is_preserved(tmp_path):
    base = tmp_path / "note-base.pdf"
    path = tmp_path / "note.pdf"
    write_receipts(base, [(1, 0)], title="中国工商银行业务回单", lines=False)
    with pymupdf.open(base) as document:
        document[0].insert_textbox(
            pymupdf.Rect(50, 420, 560, 480),
            "备注：印刷字样‘此处空白无效’仅供说明\n附言：合成交易附加信息",
            fontname="china-s", fontsize=11,
        )
        document.save(path)
    analysis = analyze(path, 1)
    assert analysis["page_fully_matched"] is True
    assert analysis["selections"][0]["candidate_rect"]["y1"] > 450
    assert "source_multi_receipt_layout" not in analysis["selections"][0]["evidence"]


def test_bounded_scan_does_not_guess_single_and_never_runs_ocr(tmp_path, monkeypatch):
    path = tmp_path / "limited.pdf"
    write_receipts(path, [(1, 0)] * 3)
    monkeypatch.setattr(source_layout, "MAX_SOURCE_LAYOUT_PAGES", 1)
    analysis = analyze(path, 1)
    assert analysis["page_fully_matched"] is True
    assert "source_layout_uncertain" in analysis["selections"][0]["evidence"]


def test_source_index_reuses_scan_and_fresh_resume_finds_prior_unmatched_pages(tmp_path, monkeypatch):
    path = tmp_path / "resume.pdf"
    write_receipts(path, [(3, None), (1, 0), (1, 0)])
    calls = []
    original = source_layout.parse_loaded_page
    def parse(page, number):
        calls.append(number)
        return original(page, number)
    monkeypatch.setattr(source_layout, "parse_loaded_page", parse)
    with pymupdf.open(path) as document:
        index = SourceLayoutIndex(document)
        assert index.policy(2, parse_loaded_page(document[1], 2)) == "multiple"
        first_calls = list(calls)
        assert index.policy(3, parse_loaded_page(document[2], 3)) == "multiple"
        assert calls == first_calls
    # Resume begins directly at the tail and still reads the earlier source evidence.
    assert analyze(path, 3)["page_fully_matched"] is False


def test_side_by_side_titles_are_not_a_proven_single_receipt(tmp_path):
    path = tmp_path / "columns.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        page.insert_text((20, 50), "上海银行业务回单", fontname="china-s")
        page.insert_text((320, 50), "上海银行业务回单", fontname="china-s")
        document.save(path)
    with pymupdf.open(path) as document:
        assert SourceLayoutIndex(document).policy(1, parse_loaded_page(document[0], 1)) == "unknown"


def test_standalone_minsheng_mastheads_full_page_and_tail_have_equal_crops(tmp_path):
    path = tmp_path / "standalone-issuer.pdf"
    with pymupdf.open() as document:
        for starts in ((65.0, 365.0, 665.0), (65.0,)):
            page = document.new_page(width=600, height=900)
            for start in starts:
                page.insert_text((30, start - 22), "中国民生银行", fontname="china-s")
                page.insert_text((190, start), "支付业务回单（付款）", fontname="china-s")
                page.insert_text((30, start + 40), "付款人名称：合成甲公司TARGET", fontname="china-s")
                page.insert_text((30, start + 70), "付款人开户行：中国建设银行", fontname="china-s")
                page.insert_text((330, start + 70), "收款人开户行：中国工商银行", fontname="china-s")
                page.insert_text((30, start + 110), "金额（小写）：123.00", fontname="china-s")
                page.draw_line((20, start + 190), (580, start + 190))
        document.save(path)
    full, tail = analyze(path, 1), analyze(path, 2)
    assert full["page_fully_matched"] is tail["page_fully_matched"] is False
    assert len(full["selections"]) == 3
    all_rects = [selection["candidate_rect"] for selection in full["selections"] + tail["selections"]]
    heights = [rect["y1"] - rect["y0"] for rect in all_rects]
    assert heights == pytest.approx([heights[0]] * 4, abs=0.01)
    assert all_rects[0] == all_rects[-1]
    with pymupdf.open(path) as document:
        headers = document[0].search_for("中国民生银行")
        for index, candidate in enumerate(all_rects[:3]):
            assert candidate["y0"] <= headers[index].y0 < headers[index].y1 <= candidate["y1"]
            if index < 2:
                assert candidate["y1"] < headers[index + 1].y0
