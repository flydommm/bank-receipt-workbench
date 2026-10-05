import json

import pymupdf
import pytest

from engine.receipt_field_rule_models import FieldRuleError
from engine.receipt_field_rule_reader import compile_rule, match_rule, read_rule, select_rule


FIELDS = [{"role": "counterparty", "field": "name", "rect": {"x0": .16, "y0": .32, "x1": .95, "y1": .45}},
          {"role": "counterparty", "field": "account", "rect": {"x0": .16, "y0": .48, "x1": .8, "y1": .61}}]
RECT = {"x0": 0., "y0": 0., "x1": 600., "y1": 250.}


def draw(page, *, company="合成本方甲公司", other="合成对方甲公司", account="000999888777", offset=0., scale=1., labels=True, shifted=False):
    rows = [(30, 50, "本方名称：" + company),
            (30, 100, ("交易对方名称：" if labels else "") + other),
            (30, 140, ("交易对方账号：" if labels else "") + account)]
    for x, y, value in rows:
        if shifted and y == 100:
            x += 40
        page.insert_text((x * scale, y * scale + offset), value, fontname="china-s", fontsize=10 * scale)


def rule_for(page):
    return compile_rule(page, RECT, "direct", FIELDS, "合成银行")


def test_rule_reads_other_company_same_bank_layout_and_never_stores_business_values():
    with pymupdf.open() as document:
        first = document.new_page(width=600, height=500)
        draw(first)
        rule = rule_for(first)
        assert not rule["batch_only"]
        serialized = json.dumps(rule, ensure_ascii=False)
        for private in ("合成本方甲公司", "合成对方甲公司", "000999888777"):
            assert private not in serialized
        second = document.new_page(width=600, height=500)
        draw(second, company="合成本方乙公司", other="合成另外一家贸易公司", account="000555444333")
        result = read_rule(second, RECT, rule, "合成银行")
    assert result["matched"]
    assert result["parties"]["counterparty_observed"]["name"]["value"] == "合成另外一家贸易公司"
    assert result["parties"]["counterparty_observed"]["account"]["value"] == "000555444333"
    assert result["parties"]["counterparty_observed"]["name"]["state"] == "present"
    assert result["parties"]["counterparty_observed"]["account"]["state"] == "present"
    assert result["parties"]["own_observed"] is None
    assert result["parties"]["payer"]["name"]["state"] == "missing"
    assert result["parties"]["payee"]["name"]["state"] == "missing"


def test_other_bank_or_label_layout_rejected():
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=500)
        draw(page)
        rule = rule_for(page)
        assert not match_rule(page, RECT, rule, "另一合成银行")["matched"]
        other = document.new_page(width=600, height=500)
        draw(other, shifted=True)
        assert not match_rule(other, RECT, rule, "合成银行")["matched"]


def test_relative_region_follows_scaled_fragment_in_another_page_slot():
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=500)
        draw(page)
        rule = rule_for(page)
        next_page = document.new_page(width=900, height=1000)
        draw(next_page, other="同版式下栏公司", offset=400, scale=1.5)
        rect = {"x0": 0., "y0": 400., "x1": 900., "y1": 775.}
        result = read_rule(next_page, rect, rule, "合成银行")
    assert result["matched"]
    assert result["parties"]["counterparty_observed"]["name"]["value"] == "同版式下栏公司"


@pytest.mark.parametrize("other,expected", [("", "missing"), ("—", "blank")])
def test_empty_field_never_borrows_neighbouring_account(other, expected):
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=500)
        draw(page)
        rule = rule_for(page)
        next_page = document.new_page(width=600, height=500)
        draw(next_page, other=other)
        result = read_rule(next_page, RECT, rule, "合成银行")
    name = result["parties"]["counterparty_observed"]["name"]
    assert name["state"] == expected
    assert not name["value"]


def test_field_region_including_label_reads_only_value():
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=500)
        draw(page)
        fields = [{**FIELDS[0], "rect": {"x0": .04, "y0": .32, "x1": .95, "y1": .45}}, FIELDS[1]]
        rule = compile_rule(page, RECT, "direct", fields, "合成银行")
        result = read_rule(page, RECT, rule, "合成银行")
    assert result["parties"]["counterparty_observed"]["name"]["value"] == "合成对方甲公司"


def test_multiple_lines_within_one_region_remain_ambiguous():
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=500)
        draw(page)
        page.insert_text((180, 125), "合成另一公司", fontname="china-s", fontsize=10)
        fields = [{**FIELDS[0], "rect": {"x0": .16, "y0": .32, "x1": .95, "y1": .51}}]
        rule = compile_rule(page, RECT, "direct", fields, "合成银行")
        result = read_rule(page, RECT, rule, "合成银行")
    assert result["parties"]["counterparty_observed"]["name"]["state"] == "ambiguous"


def test_missing_anchor_allows_batch_only_and_automatic_reuse_requires_unique_rule():
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=500)
        draw(page, labels=False)
        rule = rule_for(page)
        assert rule["batch_only"]
        assert not match_rule(page, RECT, rule, "合成银行")["matched"]
        assert match_rule(page, RECT, rule, "合成银行", allow_batch_only=True)["matched"]
        anchored = document.new_page(width=600, height=500)
        draw(anchored)
        rule = rule_for(anchored)
        rows = [{"rule_id": "a", "definition": rule, "active": True}]
        assert select_rule(anchored, RECT, rows, "合成银行")["rule"]["rule_id"] == "a"
        rows.append({"rule_id": "b", "definition": rule, "active": True})
        assert select_rule(anchored, RECT, rows, "合成银行")["reason"] == "multiple_rules"


def test_rule_cannot_read_outside_final_fragment():
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=500)
        draw(page)
        with pytest.raises(FieldRuleError):
            compile_rule(page, RECT, "direct", [{**FIELDS[0], "rect": {"x0": .2, "y0": .3, "x1": 1.01, "y1": .45}}], "合成银行")


def test_cutting_a_name_exactly_between_letters_is_not_a_valid_shorter_name():
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=500)
        draw(page, other="合成另外一家贸易公司")
        fields = [{**FIELDS[0], "rect": {"x0": .25, "y0": .32, "x1": .95, "y1": .45}}]
        rule = compile_rule(page, RECT, "direct", fields, "合成银行")
        result = read_rule(page, RECT, rule, "合成银行")
    assert result["parties"]["counterparty_observed"]["name"]["state"] == "ambiguous"


def test_name_retains_meaningful_internal_spaces():
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=500)
        draw(page, other="John Smith")
        rule = rule_for(page)
        result = read_rule(page, RECT, rule, "合成银行")
    assert result["parties"]["counterparty_observed"]["name"]["value"] == "John Smith"


def test_sides_mode_keeps_payer_and_payee_without_direct_observations():
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=500)
        page.insert_text((30, 80), "付款方名称：合成付款公司", fontname="china-s", fontsize=10)
        page.insert_text((30, 140), "收款方名称：合成收款公司", fontname="china-s", fontsize=10)
        fields = [{"role": "payer", "field": "name", "rect": {"x0": .04, "y0": .24, "x1": .9, "y1": .37}},
                  {"role": "payee", "field": "name", "rect": {"x0": .04, "y0": .48, "x1": .9, "y1": .61}}]
        rule = compile_rule(page, RECT, "sides", fields, "合成银行")
        result = read_rule(page, RECT, rule, "合成银行")
    assert result["parties"]["payer"]["name"]["value"] == "合成付款公司"
    assert result["parties"]["payee"]["name"]["value"] == "合成收款公司"
    assert result["parties"]["counterparty_observed"] is None


def test_masked_account_remains_ambiguous():
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=500)
        draw(page, account="****8777")
        rule = rule_for(page)
        result = read_rule(page, RECT, rule, "合成银行")
    assert result["parties"]["counterparty_observed"]["account"]["state"] == "ambiguous"
