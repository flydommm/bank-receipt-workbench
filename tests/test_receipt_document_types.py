"""Special document boundaries use synthetic text/geometry, never business PDFs."""
from dataclasses import replace

import pytest

from engine.layout import Rect, ReceiptCandidate, infer_receipt_candidates
from engine.pdf_parser import ParsedPage, TextBlock
from engine.receipt_checkpoint import encode_receipt_checkpoint, validate_receipt_checkpoint
from engine.receipt_document_types import detect_document_type, document_layout_family, document_type_for_title
from engine.receipt_layout import PageLayoutEvidence, LayoutSuggestion, compatible_reference, compute_receipt_page
from engine.receipt_layout_models import ReceiptLayoutError


GEOMETRY = {"pdf_box": {"x0": 0, "y0": 0, "x1": 600, "y1": 900},
            "rotation": 0, "user_unit": 1, "width_pt": 600, "height_pt": 900}
SPLIT = {"processing_mode": "split_all", "criteria": None}
SHA = "a" * 64


def block(text, top, *, x=200, bottom=None, index=0):
    return TextBlock(1, text, x, top, x + 160, bottom if bottom is not None else top + 12, index)


def page(*blocks):
    return ParsedPage(1, 600, 900, "\n".join(b.text for b in blocks), tuple(blocks))


def evidence(parsed, *, candidates=None, descriptor=None):
    return PageLayoutEvidence(GEOMETRY, parsed,
        tuple(infer_receipt_candidates(parsed) if candidates is None else candidates),
        descriptor or {}, visual_complete=True)


@pytest.mark.parametrize("heading,kind", [
    ("贷款利息到期通知书", "loan_interest_notice"),
    ("贷 款 利 息 到 期 通 知 书", "loan_interest_notice"),
    ("贷款清算通知书", "loan_settlement_notice"),
    ("贷 款 清 算 通 知 书", "loan_settlement_notice"),
    ("上海银行电子缴税付款凭证", "electronic_tax_payment"),
    ("电子缴税付款凭证", "electronic_tax_payment"),
])
def test_exact_heading_classification(heading, kind):
    assert document_type_for_title(heading) == kind
    assert detect_document_type(page(block(heading, 60))) == kind


@pytest.mark.parametrize("text", [
    "备注：贷款利息到期通知书", "请根据贷款利息到期通知书缴费", "贷款利息到期通知书\n客户资料",
    "贷款通知书", "摘要：电子缴税付款凭证", "LOAN INTEREST CHARGED ADVICE",
    "备注：贷款清算通知书", "请根据贷款清算通知书缴费", "贷款清算通知书\n客户资料",
    "DEBIT ADVICE FOR LOAN SETTLEMENT", "上海银行", "中国民生银行",
])
def test_body_mentions_and_generic_notices_do_not_classify(text):
    assert detect_document_type(page(block(text, 60))) is None


@pytest.mark.parametrize("title", ["贷款利息到期通知书", "贷款清算通知书", "电子缴税付款凭证"])
def test_heading_like_body_and_watermarks_cannot_classify(title):
    assert detect_document_type(page(block(title, 400))) is None
    assert detect_document_type(page(replace(block(title, 60), is_watermark=True))) is None


@pytest.mark.parametrize("title,kind", [
    ("贷款利息到期通知书", "loan_interest_notice"),
    ("贷款清算通知书", "loan_settlement_notice"),
])
def test_loan_notice_is_one_complete_document_with_metadata_and_stamp(title, kind):
    parsed = page(block("打印次数: 0", 20), block("回单编号: synthetic", 38),
                  block(title, 60), block("synthetic body", 180, bottom=490),
                  block("validation footer", 525))
    detected = infer_receipt_candidates(parsed)
    assert len(detected) == 1
    assert detected[0].rect == Rect(0, 0, 600, 900)
    source = replace(evidence(parsed), visible_objects=(("fill-image", (490, 500, 570, 580)),))
    result = compute_receipt_page(source, SHA, SPLIT)
    assert len(result.result["instances"]) == 1
    assert result.result["instances"][0]["rect"] == {"x0": 0, "y0": 0, "x1": 600, "y1": 900}
    assert result.result["candidates"][0]["needs_review"]
    assert result.diagnostics == ({"code": "special_document", "document_type": kind},)
    checkpoint = encode_receipt_checkpoint(result)
    assert validate_receipt_checkpoint(checkpoint) == checkpoint


def test_two_actual_tax_vouchers_keep_their_two_slots_and_show_notice():
    parsed = page(block("上海银行电子缴税付款凭证", 30), block("tax body", 100),
                  block("上海银行电子缴税付款凭证", 460), block("tax body", 530))
    candidates = [ReceiptCandidate(Rect(0, 20, 600, 420), .98, "slot-1", ("repeated_title",)),
                  ReceiptCandidate(Rect(0, 450, 600, 850), .98, "slot-2", ("repeated_title",))]
    result = compute_receipt_page(evidence(parsed, candidates=candidates), SHA, SPLIT)
    assert [item["rect"]["y0"] for item in result.result["instances"]] == [20, 450]
    assert [item["rect"]["y1"] for item in result.result["instances"]] == [420, 850]
    assert all(item["needs_review"] for item in result.result["candidates"])
    assert result.diagnostics == ({"code": "special_document", "document_type": "electronic_tax_payment"},)


@pytest.mark.parametrize("title", ["贷款利息到期通知书", "贷款清算通知书"])
def test_multiple_actual_headings_are_not_collapsed_to_one_loan_document(title):
    parsed = page(block(title, 50), block("loan body", 150),
                  block("客户回单", 450), block("receipt body", 550))
    assert len(infer_receipt_candidates(parsed)) == 2


@pytest.mark.parametrize("title", ["贷款利息到期通知书", "贷款清算通知书", "电子缴税付款凭证"])
def test_special_notice_survives_saved_geometry_without_forcing_new_review(title):
    parsed = page(block(title, 60), block("body", 180))
    source = evidence(parsed)
    initial = compute_receipt_page(source, SHA, SPLIT)
    saved = LayoutSuggestion(initial.result["layout_definition"], "manual_layout", False)
    result = compute_receipt_page(source, SHA, SPLIT, suggestion=saved)
    assert result.diagnostics == initial.diagnostics
    assert not result.result["candidates"][0]["needs_review"]


def test_special_types_cannot_borrow_ordinary_or_other_type_source_templates():
    descriptor = {"status": "ready", "receipts": [{"issuer_bank_key": "b" * 64,
                  "template_fingerprint": "c" * 64, "anchor_y": 60}]}
    loan = evidence(page(block("贷款利息到期通知书", 60)), descriptor=descriptor)
    ordinary = evidence(page(block("客户回单", 60)), descriptor=descriptor)
    tax = evidence(page(block("电子缴税付款凭证", 60)), descriptor=descriptor)
    settlement = evidence(page(block("贷款清算通知书", 60)), descriptor=descriptor)
    documents = (loan, ordinary, tax, settlement)
    for current in documents:
        for reference in documents:
            if current is not reference:
                assert not compatible_reference(current, reference)
    layouts = [compute_receipt_page(item, SHA, SPLIT).result["layout_definition"] for item in documents]
    assert len({layout["family_id"] for layout in layouts}) == 4


@pytest.mark.parametrize("title,kind", [
    ("贷款利息到期通知书", "loan_interest_notice"),
    ("贷款清算通知书", "loan_settlement_notice"),
])
def test_special_family_binds_fixed_field_positions_but_not_business_values(title, kind):
    initial = page(block(title, 60), block("日期:2026-01-01", 180, x=20),
                   block("放款编号:00001", 180, x=300))
    revalued = page(initial.blocks[0], replace(initial.blocks[1], text="日期:2027-12-31"),
                    replace(initial.blocks[2], text="放款编号:999999999999"))
    moved = page(initial.blocks[0], initial.blocks[1], replace(initial.blocks[2], y0=210, y1=222))
    assert document_layout_family(initial, kind) == document_layout_family(revalued, kind)
    assert document_layout_family(initial, kind) != document_layout_family(moved, kind)


@pytest.mark.parametrize("kind", ["unknown", "bank-private-text", 1, None, {}, ["loan_interest_notice"]])
def test_checkpoint_rejects_uncontrolled_document_type(kind):
    source = evidence(page(block("贷款利息到期通知书", 60)))
    checkpoint = encode_receipt_checkpoint(compute_receipt_page(source, SHA, SPLIT))
    checkpoint["diagnostics"][0]["document_type"] = kind
    with pytest.raises(ReceiptLayoutError):
        validate_receipt_checkpoint(checkpoint)
