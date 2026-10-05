"""Synthetic fields for own-account / transaction-counterparty receipts."""

import pymupdf
import pytest

from engine.receipt_grouping_models import derive_grouping_decision
from engine.receipt_parties import extract_receipt_parties


PROFILE = {"company_name": "合成本方公司", "account_number": "000111222333",
           "bank_name": "华夏银行", "branch_name": ""}


def draw(page, top=0, *, direction="借", counterparty="合成交易对手公司",
         account="000999888777", title="客户回单 网上支付跨行清算业务"):
    rows = [
        (180, 25, title),
        (30, 55, "交易机构：0857"), (310, 55, "账号：" + PROFILE["account_number"]),
        (30, 72, "名称：" + PROFILE["company_name"]), (310, 72, "交易对方账号：" + account),
        (30, 89, "交易对方名称：" + counterparty), (310, 89, "交易对方银行行号：000123456789"),
        (30, 106, "交易对方银行名称：合成银行示例支行"),
        (30, 123, "币种：CNY"), (310, 123, "发生额：123.00"),
    ]
    if direction is not None:
        rows.append((310, 106, "借贷标志：" + direction))
    for x, y, text in rows:
        page.insert_text((x, top + y), text, fontname="china-s", fontsize=9)
    return (0, top, 595, top + 220)


@pytest.mark.parametrize(("direction", "own", "other"), [("借", "payer", "payee"), ("贷", "payee", "payer")])
def test_huaxia_debit_credit_fields_and_grouping(direction, own, other):
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        result = extract_receipt_parties(page, draw(page, direction=direction))
    assert result[own]["name"]["value"] == PROFILE["company_name"]
    assert result[own]["account"]["value"] == PROFILE["account_number"]
    assert result[other]["name"]["value"] == "合成交易对手公司"
    assert result[other]["account"]["value"] == "000999888777"
    assert result[other]["bank"]["value"] == "合成银行示例支行"
    assert result[other]["bank"]["state"] == "present"
    assert result[other]["name"]["evidence"]["label"]["text"] == "交易对方名称"
    decision = derive_grouping_decision({"parties": result, "review_status": "confirmed"}, PROFILE)
    assert decision["route"] == "named"
    assert decision["counterparty"]["name"]["value"] == "合成交易对手公司"


@pytest.mark.parametrize("direction", [None, "未知", "借贷"])
def test_huaxia_unknown_direction_does_not_guess_a_side(direction):
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        result = extract_receipt_parties(page, draw(page, direction=direction))
    assert all(result[side]["name"]["state"] == "missing" for side in ("payer", "payee"))


@pytest.mark.parametrize(("value", "expected"), [("", "missing"), ("—", "blank")])
def test_huaxia_empty_name_never_borrows_bank_or_other_row(value, expected):
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        result = extract_receipt_parties(page, draw(page, counterparty=value))
    assert result["payee"]["name"]["state"] == expected
    assert not result["payee"]["name"]["value"]
    assert result["payee"]["bank"]["value"] == "合成银行示例支行"


def test_huaxia_bank_routing_number_does_not_fill_empty_account():
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        result = extract_receipt_parties(page, draw(page, account=""))
    assert result["payee"]["account"]["state"] == "missing"
    assert not result["payee"]["account"]["value"]


def test_huaxia_masked_account_remains_ambiguous():
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        result = extract_receipt_parties(page, draw(page, account="****8777"))
    assert result["payee"]["account"]["state"] == "ambiguous"


def test_huaxia_duplicate_conflicting_name_is_not_silently_chosen():
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        rect = draw(page)
        page.insert_text((30, 145), "交易对方名称：合成另一公司", fontname="china-s", fontsize=9)
        result = extract_receipt_parties(page, rect)
    assert result["payee"]["name"]["state"] == "ambiguous"


def test_huaxia_conflicting_direction_and_combined_receipts_do_not_guess():
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        first = draw(page)
        second = draw(page, 270, direction="贷", counterparty="合成另一对手")
        a = extract_receipt_parties(page, first)
        b = extract_receipt_parties(page, second)
        combined = extract_receipt_parties(page, (0, 0, 595, 500))
        page.insert_text((310, 145), "借贷标志：贷", fontname="china-s", fontsize=9)
        conflict = extract_receipt_parties(page, first)
    assert a["payee"]["name"]["value"] == "合成交易对手公司"
    assert b["payer"]["name"]["value"] == "合成另一对手"
    for result in (combined, conflict):
        assert all(result[side]["name"]["state"] != "present" for side in ("payer", "payee"))


def test_huaxia_header_required_to_map_generic_own_labels():
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        result = extract_receipt_parties(page, draw(page, title="合成普通说明"))
    assert all(result[side]["name"]["state"] == "missing" for side in ("payer", "payee"))


def draw_small(page, *, transaction="普通贷记", own_payer=True, payee_name=None):
    other_name, other_account = "合成交易对手公司", "000999888777"
    names = (PROFILE["company_name"], other_name) if own_payer else (other_name, PROFILE["company_name"])
    accounts = (PROFILE["account_number"], other_account) if own_payer else (other_account, PROFILE["account_number"])
    rows = [
        (180, 25, "客户回单 小额支付系统业务"),
        (30, 50, "交易种类：" + transaction),
        (30, 68, "发起人开户行行号：000123456789"),
        (310, 68, "发起行名称：合成发起银行"),
        (30, 86, "发起人名称：" + names[0]),
        (30, 104, "发起人账号：" + accounts[0]),
        (310, 104, "接收人账号：" + accounts[1]),
        (30, 122, "接收人开户行行号：000987654321"),
        (310, 122, "接收行名称：合成接收银行"),
        (30, 140, "接收人名称：" + (names[1] if payee_name is None else payee_name)),
    ]
    for x, y, text in rows:
        page.insert_text((x, y), text, fontname="china-s", fontsize=9)
    return (0, 0, 595, 220)


@pytest.mark.parametrize("own_payer", [True, False])
def test_huaxia_small_credit_transfer_maps_initiator_and_recipient(own_payer):
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        result = extract_receipt_parties(page, draw_small(page, own_payer=own_payer))
    own_side = "payer" if own_payer else "payee"
    other_side = "payee" if own_payer else "payer"
    assert result[own_side]["account"]["value"] == PROFILE["account_number"]
    assert result[other_side]["name"]["value"] == "合成交易对手公司"
    assert result[other_side]["account"]["value"] == "000999888777"
    assert result["payer"]["bank"]["value"] == "合成发起银行"
    assert result["payee"]["bank"]["value"] == "合成接收银行"
    assert derive_grouping_decision({"parties": result}, PROFILE)["route"] == "named"


@pytest.mark.parametrize("transaction", ["", "普通借记", "普通贷记退汇"])
def test_huaxia_small_payment_unknown_transaction_does_not_assume_payment_sides(transaction):
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        result = extract_receipt_parties(page, draw_small(page, transaction=transaction))
    assert derive_grouping_decision({"parties": result}, PROFILE)["route"] == "counterparty_pending"


def test_huaxia_small_payment_missing_recipient_does_not_read_routing_code():
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        result = extract_receipt_parties(page, draw_small(page, payee_name=""))
    assert result["payee"]["name"]["state"] == "missing"
    assert derive_grouping_decision({"parties": result}, PROFILE)["route"] == "counterparty_pending"


@pytest.mark.parametrize("other_line", [
    "交易对方名称： 交易对方银行名称：合成银行",
    "交易对方名称： 交易对方账号：000999888777",
    "交易对方名称： 交易对方银行行号：000123456789",
])
def test_huaxia_empty_inline_name_never_becomes_following_field(other_line):
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        for y, text in [(25, "客户回单 网上支付跨行清算业务"),
                        (50, "名称：" + PROFILE["company_name"]),
                        (68, "账号：" + PROFILE["account_number"]),
                        (86, other_line), (104, "借贷标志：借")]:
            page.insert_text((30, y), text, fontname="china-s", fontsize=9)
        result = extract_receipt_parties(page, (0, 0, 595, 220))
    assert result["payee"]["name"]["state"] == "missing"
    assert not result["payee"]["name"]["value"]
    assert derive_grouping_decision({"parties": result}, PROFILE)["route"] == "counterparty_pending"


def test_huaxia_inline_name_account_and_bank_are_separate_values():
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        for y, text in [(25, "客户回单 网上支付跨行清算业务"),
                        (50, "名称：" + PROFILE["company_name"] + " 账号：" + PROFILE["account_number"]),
                        (68, "交易对方名称：合成对手 交易对方账号：000999888777"),
                        (86, "交易对方银行名称：合成银行 交易对方银行行号：000123456789"),
                        (104, "借贷标志：借")]:
            page.insert_text((30, y), text, fontname="china-s", fontsize=9)
        result = extract_receipt_parties(page, (0, 0, 595, 220))
    assert result["payer"]["name"]["value"] == PROFILE["company_name"]
    assert result["payer"]["account"]["value"] == PROFILE["account_number"]
    assert result["payee"]["name"]["value"] == "合成对手"
    assert result["payee"]["account"]["value"] == "000999888777"
    assert result["payee"]["bank"]["value"] == "合成银行"


@pytest.mark.parametrize("payee_name", ["", "合成对手"])
def test_huaxia_small_payment_inline_fields_keep_empty_name_missing(payee_name):
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        for y, text in [(25, "客户回单 小额支付系统业务"),
                        (50, "交易种类：普通贷记"),
                        (68, "发起人名称：" + PROFILE["company_name"] + " 发起人账号：" + PROFILE["account_number"]),
                        (86, "接收人名称：" + payee_name + " 接收人账号：000999888777 接收行名称：合成银行")]:
            page.insert_text((30, y), text, fontname="china-s", fontsize=9)
        result = extract_receipt_parties(page, (0, 0, 595, 220))
    assert result["payer"]["name"]["value"] == PROFILE["company_name"]
    assert result["payer"]["account"]["value"] == PROFILE["account_number"]
    assert result["payee"]["name"]["value"] == payee_name
    assert result["payee"]["name"]["state"] == ("present" if payee_name else "missing")
    assert result["payee"]["account"]["value"] == "000999888777"
    assert result["payee"]["bank"]["value"] == "合成银行"
