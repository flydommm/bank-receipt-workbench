"""Only synthetic PDFs exercise bank-independent counterparty observations."""
from copy import deepcopy
import json

import pymupdf
import pytest

from engine.receipt_field_candidates import candidate_field, empty_party, normalize_issues
from engine.receipt_field_readers import FIELD_LAYOUT_KINDS, field_layout_signature
from engine.receipt_grouping_models import derive_grouping_decision, normalize_parties
from engine.receipt_parties import _extract_legacy_receipt_parties, extract_receipt_parties

PROFILE = {"company_name": "合成本方公司", "account_number": "000111222333",
           "bank_name": "合成未知银行", "branch_name": ""}


def draw(page, *, name="合成供应商", own_name=None, own_account=None, counterparty_account="000999888777", top=0):
    rows = [(30, 20, "合成陌生银行回执"), (30, 50, "交易对方名称：" + name),
            (30, 75, "交易对方账号：" + counterparty_account),
            (30, 100, "对方开户行：合成对手银行")]
    if own_name is not None:
        rows.append((300, 50, "本方名称：" + own_name))
    if own_account is not None:
        rows.append((300, 75, "本方账号：" + own_account))
    for x, y, text in rows:
        page.insert_text((x, top + y), text, fontname="china-s", fontsize=9)
    return (0, top, 595, top + 180)


def decision(result, manual=None):
    return derive_grouping_decision({"parties": result}, PROFILE, manual=manual)


def test_unknown_bank_reads_explicit_counterparty_without_faking_payment_sides():
    with pymupdf.open() as doc:
        page = doc.new_page()
        result = extract_receipt_parties(page, draw(page))
    assert all(result[side][field]["state"] == "missing" for side in ("payer", "payee") for field in ("name", "account", "bank"))
    assert result["counterparty_observed"]["name"]["value"] == "合成供应商"
    assert result["own_observed"] is None
    grouped = decision(result)
    assert grouped["route"] == "named"
    assert grouped["our_side"] is None and grouped["counterparty_side"] is None
    assert grouped["field_overrides"] == []
    assert grouped["own_decision"]["status"] == "confirmed"


@pytest.mark.parametrize("suffix", ["对方开户行：合成银行", "交易对方账号：000999888777", "交易对方银行行号：000123456789"])
def test_unknown_bank_empty_inline_name_does_not_borrow_following_field(suffix):
    with pymupdf.open() as doc:
        page = doc.new_page()
        page.insert_text((30, 50), "交易对方名称： " + suffix, fontname="china-s", fontsize=9)
        result = extract_receipt_parties(page, (0, 0, 595, 180))
    assert result["counterparty_observed"]["name"]["state"] == "missing"
    assert decision(result)["route"] == "counterparty_pending"
    assert {i["code"] for i in result["issues"]} == {"missing_field"}


@pytest.mark.parametrize(("name", "route"), [("", "counterparty_pending"), ("—", "blank"), (PROFILE["company_name"], "internal")])
def test_direct_blank_missing_and_internal_are_distinct(name, route):
    with pymupdf.open() as doc:
        page = doc.new_page()
        result = extract_receipt_parties(page, draw(page, name=name))
    assert decision(result)["route"] == route


def test_direct_punctuation_only_name_requires_review_with_invalid_text_reason():
    with pymupdf.open() as doc:
        page = doc.new_page()
        result = extract_receipt_parties(page, draw(page, name="）"))
    assert result["counterparty_observed"]["name"]["state"] == "ambiguous"
    assert decision(result)["route"] == "counterparty_pending"
    assert any(issue["code"] == "invalid_text" and issue["field"] == "name" for issue in result["issues"])


def test_direct_wrapped_name_reads_aligned_unlabelled_row_only():
    with pymupdf.open() as doc:
        page = doc.new_page()
        for y, text in [(40, "交易对方名称："), (56, "合成长名称供应商"), (90, "对方账号：000888777666")]:
            page.insert_text((30, y), text, fontname="china-s", fontsize=9)
        result = extract_receipt_parties(page, (0, 0, 595, 180))
    assert result["counterparty_observed"]["name"]["value"] == "合成长名称供应商"
    assert decision(result)["route"] == "named"


def test_direct_true_duplicate_conflict_keeps_candidates_and_manual_fix_wins():
    with pymupdf.open() as doc:
        page = doc.new_page()
        rect = draw(page)
        page.insert_text((30, 125), "交易对方名称：合成另一供应商", fontname="china-s", fontsize=9)
        result = extract_receipt_parties(page, rect)
    assert result["counterparty_observed"]["name"]["state"] == "ambiguous"
    assert len(normalize_parties(result)["counterparty_observed"]["name"]["candidates"]) == 2
    assert decision(result)["route"] == "counterparty_pending"
    assert any(i["code"] == "conflicting_field" for i in result["issues"])
    manual = {"field_overrides": [{"side": "counterparty", "field": "name", "value": "合成人工核对名称", "state": "present", "reason": "合成核对"}]}
    assert decision(result, manual)["counterparty"]["name"]["value"] == "合成人工核对名称"
    assert decision(result, manual)["route"] == "named"


@pytest.mark.parametrize(("name", "account"), [("合成其他本方", PROFILE["account_number"]), (PROFILE["company_name"], "000111222999")])
def test_direct_positive_own_conflict_stays_pending(name, account):
    with pymupdf.open() as doc:
        page = doc.new_page()
        result = extract_receipt_parties(page, draw(page, own_name=name, own_account=account))
    assert decision(result)["route"] == "counterparty_pending"
    assert decision(result)["reason"] == "batch_identity_conflict"


def test_masked_observed_own_account_does_not_block_explicit_counterparty_name():
    with pymupdf.open() as doc:
        page = doc.new_page()
        result = extract_receipt_parties(page, draw(page, own_account="****2333", counterparty_account=""))
    assert decision(result)["route"] == "named"
    assert any(i["code"] == "incomplete_account" and i["role"] == "own" for i in result["issues"])


def test_legacy_and_direct_name_conflict_requires_confirmation_but_manual_side_fix_wins():
    with pymupdf.open() as doc:
        page = doc.new_page()
        rect = draw(page, counterparty_account="")
        for y, text in [(125, "付款方账号：" + PROFILE["account_number"]), (145, "收款方名称：合成不同名称")]:
            page.insert_text((30, y), text, fontname="china-s", fontsize=9)
        result = extract_receipt_parties(page, rect)
    assert decision(result)["route"] == "counterparty_pending"
    manual = {"field_overrides": [{"side": "payee", "field": "name", "state": "present", "value": "合成人工选定", "reason": "合成核对"}]}
    assert decision(result, manual)["counterparty"]["name"]["value"] == "合成人工选定"


def test_legacy_success_fields_and_evidence_are_not_replaced():
    with pymupdf.open() as doc:
        page = doc.new_page()
        for y, text in [(25, "付款方名称：合成本方公司"), (50, "付款方账号：000111222333"),
                        (75, "收款方名称：合成对手"), (100, "收款方账号：000999888777")]:
            page.insert_text((30, y), text, fontname="china-s", fontsize=9)
        rect = (0, 0, 595, 180)
        legacy = _extract_legacy_receipt_parties(page, rect)
        result = extract_receipt_parties(page, rect)
    assert all(result[key] == legacy[key] for key in ("payer", "payee", "diagnostics"))
    assert decision(result)["counterparty"] == decision(legacy)["counterparty"]


def test_structure_signature_contains_only_fixed_labels_and_is_value_independent():
    with pymupdf.open() as doc:
        a = doc.new_page()
        rect = draw(a, name="合成短名", own_name="合成甲", own_account="0011223344")
        first = field_layout_signature(a, rect)
        b = doc.new_page()
        draw(b, name="合成很长很长的不同供应商公司", own_name="合成乙公司", own_account="8899001122334455")
        second = field_layout_signature(b, rect)
    assert first == second and first["reliable"]
    assert all(label["kind"] in FIELD_LAYOUT_KINDS for label in first["labels"])
    assert not any(value in json.dumps(first, ensure_ascii=False) for value in ["合成甲", "0011223344", "合成短名", "8899001122334455"])


def test_scope_isolation_and_no_text_get_explicit_problem_code():
    with pymupdf.open() as doc:
        page = doc.new_page()
        draw(page, name="合成甲", top=0)
        rect = draw(page, name="合成乙", top=220)
        result = extract_receipt_parties(page, rect)
        empty = extract_receipt_parties(page, (0, 450, 595, 600))
    assert result["counterparty_observed"]["name"]["value"] == "合成乙"
    assert [issue["code"] for issue in empty["issues"]] == ["no_text"]
    assert empty["layout_signature"] is None


def test_metadata_normalization_is_bounded_and_discards_arbitrary_messages():
    raw = {"counterparty_observed": {**empty_party(), "name": candidate_field("name", "合成对手")},
           "issues": [{"code": "missing_field", "field": "name", "role": "counterparty", "message": "PRIVATE-SENTINEL"}],
           "reader_dependencies": [{"reader_id": "direct_counterparty", "version": "1"}], "layout_signature": "a" * 64}
    before = deepcopy(raw)
    normalized = normalize_parties(raw)
    assert raw == before
    assert normalized["counterparty_observed"]["name"]["value"] == "合成对手"
    assert "PRIVATE-SENTINEL" not in json.dumps(normalized)
    assert normalize_issues([{"code": ["bad"]}]) == []
    assert normalize_parties({}) == {"payer": normalize_parties({})["payer"], "payee": normalize_parties({})["payee"]}
