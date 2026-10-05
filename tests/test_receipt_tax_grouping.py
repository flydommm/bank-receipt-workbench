"""Synthetic tax voucher: PDF text extraction feeds the real grouping rules."""
from copy import deepcopy

import pymupdf
import pytest

from engine.receipt_grouping_models import derive_grouping_decision
from engine.receipt_parties import extract_receipt_parties


ACCOUNT = {"company_name": "合成甲公司", "bank_name": "上海银行",
           "branch_name": "", "account_number": "000123456789"}


def tax_item(*, account_present=True, conflicting_name=False):
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=400)
        rows = [
            (150, 30, "上海银行电子缴税付款凭证"),
            (25, 70, "纳税人全称及纳税人识别号：合成甲公司 91310000MA5TEST01"),
            (25, 95, "付款人全称：合成甲公司"),
            (25, 120, "付款人账号：" + (ACCOUNT["account_number"] if account_present else "")),
            (25, 145, "付款人开户银行：上海银行示例支行"),
            (320, 170, "征收机关名称：示例税务机关"),
            (320, 195, "收款国库(银行)名称：示例国库"),
        ]
        if conflicting_name:
            rows.append((25, 220, "付款人全称：另一家合成公司"))
        for x, y, text in rows:
            page.insert_text((x, y), text, fontname="china-s", fontsize=10)
        extracted = extract_receipt_parties(page, (0, 0, 600, 400))
    return {
        "parties": extracted,
        "source_bank": {"value": "上海银行", "state": "present"},
        "document_type": "electronic_tax_payment",
        "special_confirmed": True,
        "review_status": "confirmed",
        "final_rect": {"x0": 0, "y0": 0, "x1": 600, "y1": 400},
    }


@pytest.mark.parametrize("confirmed,route", [(True, "special"), (False, "named")])
def test_extracted_tax_voucher_confirms_own_account_without_inventing_payee_account(confirmed, route):
    item = tax_item()
    item["special_confirmed"] = confirmed
    before = deepcopy(item)
    result = derive_grouping_decision(item, ACCOUNT)
    assert result["own_decision"]["status"] == "confirmed"
    assert result["own_decision"]["side"] == "payer"
    assert result["route"] == route
    assert result["parties"]["payee"]["account"]["state"] == "missing"
    assert result["parties"]["payee"]["account"]["value"] == ""
    assert item == before  # Review type and crop remain the user's decision.


def test_tax_voucher_missing_own_account_uses_batch_and_keeps_special_type():
    result = derive_grouping_decision(tax_item(account_present=False), ACCOUNT)
    assert result["route"] == "special"
    assert result["own_decision"]["method"] == "batch_profile"
    assert result["parties"]["payer"]["account"]["state"] == "missing"
    assert "own_account_missing" in result["own_decision"]["reasons"]


def test_tax_name_conflict_remains_visible_without_losing_confirmed_type():
    result = derive_grouping_decision(tax_item(conflicting_name=True), ACCOUNT, manual={
        "own_confirmation": {"side": "payer", "confirms_selected_account": True,
                             "confirms_source_bank": True, "reason": "用户在合成测试中核对本方。"},
    })
    assert result["route"] == "special"
    assert result["parties"]["payer"]["name"]["state"] == "ambiguous"
    assert "own_company_ambiguous" in result["own_decision"]["reasons"]


def test_tax_voucher_already_excluded_remains_excluded():
    item = tax_item()
    item["review_status"] = "excluded"
    result = derive_grouping_decision(item, ACCOUNT)
    assert result["route"] == "excluded"
    assert result["group"] is None
