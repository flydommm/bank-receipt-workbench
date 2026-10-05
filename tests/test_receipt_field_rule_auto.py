"""Automatic neutral field positions, with synthetic PDFs and no business data."""
from copy import deepcopy
import json

import pymupdf
import pytest

from engine.receipt_field_rule_models import FieldRuleError, validate_fields
from engine.receipt_field_rule_reader import compile_rule, merge_rule_reading, read_rule
from engine.receipt_grouping_models import derive_grouping_decision


PROFILE = {"company_name": "合成本公司", "account_number": "000012345678", "bank_name": "合成银行"}
RECT = {"x0": 0., "y0": 0., "x1": 600., "y1": 300.}
POSITIONS = [("counterparty", "name", 80), ("counterparty", "account", 120), ("own", "name", 180), ("own", "account", 220)]


def fields(*, both=True, accounts=False):
    return [{"role": role, "field": key, "rect": {"x0": .04, "y0": (top - 15) / 300, "x1": .95, "y1": (top + 5) / 300}}
            for role, key, top in POSITIONS if (both or role == "counterparty") and (accounts or key == "name")]


def draw(page, *, first="合成本公司", second="合成对手甲", first_account="000012345678", second_account="000099998888", generic=False):
    for index, (_, key, top) in enumerate(POSITIONS):
        side = "付款方" if index < 2 else "收款方"
        label = ("" if generic else side) + ("名称" if key == "name" else "账号")
        value = [first, first_account, second, second_account][index]
        page.insert_text((30, top), label + "：" + value, fontname="china-s", fontsize=10)


def read(page, rule, *, profile=PROFILE, base=None):
    return read_rule(page, RECT, rule, "合成银行", own_account=profile, base_parties=base or {}, allow_batch_only=True)


def decide(reading, rule, base=None, profile=PROFILE, automatic=False):
    assert reading["resolved"]
    merged = merge_rule_reading(base or {}, reading["parties"], rule, automatic=automatic,
                               resolved_fields=reading["resolved_fields"])
    return derive_grouping_decision({"parties": merged, "source_bank": "合成银行"}, profile)


@pytest.mark.parametrize("generic", [False, True])
def test_two_neutral_name_positions_follow_each_receipt_and_next_company(generic):
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=300)
        draw(page, generic=generic)
        rule = compile_rule(page, RECT, "auto", fields(), "合成银行")
        assert not rule["batch_only"]
        serialized = json.dumps(rule, ensure_ascii=False)
        assert not any(value in serialized for value in ("合成本公司", "合成对手甲", "000012345678", "000099998888"))
        assert decide(read(page, rule), rule)["counterparty"]["name"]["value"] == "合成对手甲"
        next_page = document.new_page(width=600, height=300)
        draw(next_page, first="合成客户乙", second="合成下批公司", first_account="000011112222", second_account="000055556666", generic=generic)
        profile = {**PROFILE, "company_name": "合成下批公司", "account_number": "000055556666"}
        reading = read(next_page, rule, profile=profile)
        result = decide(reading, rule, profile=profile)
        assert result["counterparty"]["name"]["value"] == "合成客户乙"
        if not generic:
            assert result["own_decision"]["side"] == "payee"


def test_single_payer_box_requires_current_own_side_and_other_reliable_fields():
    from tests.test_receipt_grouping_store import field

    with pymupdf.open() as document:
        page = document.new_page(width=600, height=300)
        draw(page)
        rule = compile_rule(page, RECT, "auto", fields(both=False), "合成银行")
        assert rule["fields"][0]["anchor"]["kind"] == "payer.name"
        assert not read(page, rule)["resolved"]  # Reading our own name alone is insufficient.
        base = {"payee": {"name": field("合成对手甲")}}
        assert decide(read(page, rule, base=base), rule, base)["counterparty"]["name"]["value"] == "合成对手甲"
        inbound = document.new_page(width=600, height=300)
        draw(inbound, first="合成客户乙", second=PROFILE["company_name"])
        assert not read(inbound, rule)["resolved"]
        base = {"payee": {"name": field(PROFILE["company_name"]), "account": field(PROFILE["account_number"])}}
        result = decide(read(inbound, rule, base=base), rule, base)
        assert result["own_decision"]["side"] == "payee"
        assert result["counterparty"]["name"]["value"] == "合成客户乙"


@pytest.mark.parametrize("generic", [False, True])
def test_same_company_names_need_one_matching_account(generic):
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=300)
        draw(page, second=PROFILE["company_name"], generic=generic)
        names = compile_rule(page, RECT, "auto", fields(), "合成银行")
        assert not read(page, names)["resolved"]
        full = compile_rule(page, RECT, "auto", fields(accounts=True), "合成银行")
        result = decide(read(page, full), full)
        assert result["route"] == "internal"
        assert result["counterparty"]["account"]["value"] == "000099998888"
        both_accounts = document.new_page(width=600, height=300)
        draw(both_accounts, second=PROFILE["company_name"], second_account=PROFILE["account_number"], generic=generic)
        assert not read(both_accounts, full)["resolved"]


def test_generic_positions_with_duplicate_own_accounts_do_not_trust_one_matching_name():
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=300)
        draw(page, second="账号与名称矛盾的公司", second_account=PROFILE["account_number"], generic=True)
        rule = compile_rule(page, RECT, "auto", fields(accounts=True), "合成银行")
        assert not read(page, rule)["resolved"]


@pytest.mark.parametrize("empty", ["", "未定位公司"])
def test_unresolved_boxes_do_not_fall_back_to_an_old_counterparty(empty):
    from tests.test_receipt_grouping_store import field

    with pymupdf.open() as document:
        page = document.new_page(width=600, height=300)
        draw(page, first=empty, second="另一公司", generic=True)
        rule = compile_rule(page, RECT, "auto", fields(both=False), "合成银行")
        base = {"payer": {"name": field(PROFILE["company_name"])}, "payee": {"name": field("旧的自动对手")}}
        reading = read(page, rule, base=base)
        assert reading["matched"] and not reading["resolved"]
        if empty == "":
            assert all((party or {}).get("name", {}).get("state") != "blank" for party in reading["parties"].values() if isinstance(party, dict))


def test_explicit_counterparty_label_can_resolve_one_box_without_payment_direction():
    from tests.test_receipt_field_rule_reader import draw as draw_direct, RECT as direct_rect, FIELDS

    with pymupdf.open() as document:
        page = document.new_page(width=600, height=500)
        draw_direct(page)
        rule = compile_rule(page, direct_rect, "auto", [FIELDS[0]], "合成银行")
        reading = read_rule(page, direct_rect, rule, "合成银行", own_account=PROFILE)
        assert reading["resolved"]
        result = decide(reading, rule)
        assert result["own_decision"]["side"] is None
        assert result["counterparty"]["name"]["value"] == "合成对方甲公司"


def test_auto_merge_preserves_unconfigured_fields_and_marks_automatic_conflicts():
    from tests.test_receipt_grouping_store import field

    with pymupdf.open() as document:
        page = document.new_page(width=600, height=300)
        draw(page)
        rule = compile_rule(page, RECT, "auto", fields(), "合成银行")
        base = {"payer": {"name": field(PROFILE["company_name"]), "account": field(PROFILE["account_number"])},
                "payee": {"name": field("旧自动对手"), "bank": field("原开户行")}}
        before = deepcopy(base)
        reading = read(page, rule, base=base)
        assert decide(reading, rule, base)["counterparty"]["name"]["value"] == "合成对手甲"
        merged = merge_rule_reading(base, reading["parties"], rule, automatic=True, resolved_fields=reading["resolved_fields"])
        assert merged["payee"]["name"]["state"] == "ambiguous"
        assert merged["payee"]["bank"] == base["payee"]["bank"]
        assert base == before
        with pytest.raises(FieldRuleError):
            merge_rule_reading(base, reading["parties"], rule, automatic=False)


def test_auto_protocol_keeps_positions_neutral_and_forbids_persisted_values():
    assert validate_fields(fields(both=False), "auto")
    with pytest.raises(FieldRuleError):
        validate_fields([{**fields(both=False)[0], "role": "payer"}], "auto")
    with pytest.raises(FieldRuleError):
        validate_fields([{**fields(both=False)[0], "value": "不可保存的名称"}], "auto")
