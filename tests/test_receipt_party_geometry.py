"""Synthetic labelled-cell regressions; no customer data or bank templates."""
from dataclasses import dataclass

import pytest

from engine.receipt_parties import extract_receipt_parties


@dataclass
class CellPage:
    rows: list

    @property
    def rect(self):
        return (0, 0, 600, 300)

    def get_text(self, mode, **kwargs):
        if mode != "dict":
            return []
        return {"blocks": [{"type": 0, "lines": [
            {"spans": [{"text": text, "bbox": (x, y, x + width, y + height)}]}
            for x, y, text, width, height in self.rows
        ]}]}


def read(rows):
    return extract_receipt_parties(CellPage(rows), (0, 0, 600, 300))


def table(*, gap=3, horizontal=False, tiny=False):
    rows = []
    for x, side, name, account in [(20, "付款人", "合成甲公司", "00123456789"),
                                    (300, "收款人", "合成乙公司", "00987654321")]:
        if horizontal:
            rows.append((x, 70, side, 30, 10))
        else:
            rows.extend((x, 48 + n * (10 + gap), ch, 10, 10) for n, ch in enumerate(side))
        for y, label, value in [(45, "账户名称", name), (70, "账号", account),
                                (95, "开户行名称", "合成银行甲支行")]:
            rows.append((x + 40, y, label, 60, 10))
            rows.append((x + 125, y + (2 if tiny else -1), value, 145, 5.5 if tiny else 9))
    return rows


@pytest.mark.parametrize("gap", [10.8, 12.8])
def test_spaced_vertical_roles_keep_all_six_fields(gap):
    result = read(table(gap=gap))
    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payee"]["name"]["value"] == "合成乙公司"
    assert all(result[s][f]["state"] == "present" for s in ("payer", "payee")
               for f in ("name", "account", "bank"))


def test_horizontal_roles_use_the_cell_not_nearest_role_center():
    result = read(table(horizontal=True))
    assert result["payer"]["account"]["value"] == "00123456789"
    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payee"]["name"]["value"] == "合成乙公司"
    assert result["payer"]["bank"]["value"] == "合成银行甲支行"


def test_small_font_values_in_same_row_are_read_without_bank_routing_pollution():
    rows = table(tiny=True)
    rows += [(60, 120, "开户行号", 60, 10), (145, 120, "000000123456", 130, 10),
             (340, 120, "开户行号", 60, 10), (425, 120, "000000654321", 130, 10)]
    result = read(rows)
    assert result["payee"]["name"]["value"] == "合成乙公司"
    assert result["payer"]["bank"]["value"] == "合成银行甲支行"
    assert result["payee"]["bank"]["state"] == "present"


def test_value_font_baseline_can_sit_above_label_within_same_row():
    rows = [(x, y - 3.1 if text == "合成银行甲支行" else y, text, width, height)
            for x, y, text, width, height in table()]
    result = read(rows)
    assert result["payer"]["bank"]["value"] == "合成银行甲支行"
    assert result["payee"]["bank"]["value"] == "合成银行甲支行"


def test_stacked_party_blocks_use_local_section_for_generic_bank_labels():
    rows = [(20, 10, "业务名称：合成业务", 140, 10)]
    for y, side, name, account, bank in [(35, "付款人", "合成甲公司", "00123456789", "合成银行甲支行"),
                                       (120, "收款人", "合成乙公司", "00987654321", "合成银行乙支行")]:
        rows += [(20, y, side + "名称", 70, 10), (100, y, name, 140, 10),
                 (20, y + 20, side + "账号", 70, 10), (100, y + 20, account, 140, 10),
                 (20, y + 40, "开户行名称", 70, 10), (100, y + 40, bank, 140, 10)]
    result = read(rows)
    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payee"]["account"]["value"] == "00987654321"
    assert result["payer"]["bank"]["value"] == "合成银行甲支行"
    assert result["payee"]["bank"]["value"] == "合成银行乙支行"


def test_geometric_value_can_be_third_in_pdf_line_order():
    rows = [(20, 20, "付款人名称", 70, 9), (300, 20, "收款人名称", 70, 9),
            (380, 20, "合成乙公司", 100, 9), (100, 23, "合成甲公司", 130, 9),
            (20, 45, "付款人账号：00123456789", 230, 9),
            (300, 45, "收款人账号：00987654321", 230, 9),
            (20, 70, "实际记账账号：11111111111", 240, 9),
            (20, 90, "银行附言：合成说明", 200, 9)]
    result = read(rows)
    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payer"]["account"]["value"] == "00123456789"
    assert result["payer"]["bank"]["state"] == "missing"


@pytest.mark.parametrize("metadata", ["付款凭证", "业务名称：汇划", "费用名称：服务费",
                                      "产品名称：活期存款", "发起行名称：合成甲银行",
                                      "接收行名称：合成乙银行", "实际记账户名：其他账户"])
def test_metadata_does_not_invent_or_conflict_with_party_name(metadata):
    result = read([(20, 20, "付款人名称：合成甲公司", 240, 10),
                   (300, 20, "收款人名称：合成乙公司", 240, 10),
                   (20, 60, metadata, 240, 10)])
    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payee"]["name"]["value"] == "合成乙公司"
    assert result["payer"]["name"]["state"] == result["payee"]["name"]["state"] == "present"


def test_missing_same_row_name_never_borrows_bank_or_other_column():
    rows = [r for r in table(horizontal=True) if r[2] != "合成甲公司"]
    result = read(rows)
    assert result["payer"]["name"]["state"] == "missing"
    assert result["payee"]["name"]["value"] == "合成乙公司"


def test_conflicting_values_within_a_cell_remain_ambiguous():
    rows = table(horizontal=True)
    rows.append((145, 44, "合成不同公司", 145, 9))
    result = read(rows)
    assert result["payer"]["name"]["state"] == "ambiguous"


def test_two_line_name_and_bank_in_a_cell_are_continuations_not_conflicts():
    rows = [r for r in table(horizontal=True) if r[2] not in {"合成乙公司", "合成银行甲支行"}]
    rows += [(425, 41, "合成乙方的长名称", 145, 9), (425, 49.5, "有限公司", 60, 9),
             (145, 91, "合成银行甲支行", 145, 9), (145, 99.5, "营业部", 60, 9)]
    result = read(rows)
    assert result["payee"]["name"]["value"] == "合成乙方的长名称有限公司"
    assert result["payer"]["bank"]["value"] == "合成银行甲支行营业部"


def test_table_values_offset_upward_stay_within_their_label_row():
    rows = [(x, y - 5.3 if text == "合成银行甲支行" else y, text, width, height)
            for x, y, text, width, height in table()]
    result = read(rows)
    assert result["payer"]["bank"]["value"] == "合成银行甲支行"
    assert result["payee"]["bank"]["value"] == "合成银行甲支行"


def test_right_aligned_short_value_can_use_full_table_cell_width():
    rows = [(535, y, text, 50, height) if text == "合成乙公司" else (x, y, text, width, height)
            for x, y, text, width, height in table(horizontal=True)]
    assert read(rows)["payee"]["name"]["value"] == "合成乙公司"


def test_multiline_english_name_is_not_silently_joined_without_word_spaces():
    rows = [r for r in table(horizontal=True) if r[2] != "合成乙公司"]
    rows += [(425, 41, "Synthetic Alpha", 145, 9), (425, 49.5, "Company", 60, 9)]
    result = read(rows)
    assert result["payee"]["name"]["state"] == "ambiguous"
    assert {c["value"] for c in result["payee"]["name"]["candidates"]} == {"Synthetic Alpha", "Company"}


def test_centered_chinese_wrapping_stays_inside_one_bank_cell():
    rows = [r for r in table(horizontal=True) if not (r[2] == "合成银行甲支行" and r[0] < 300)]
    rows += [(145, 91, "合成银行甲支", 145, 9), (213, 99.5, "行", 9, 9)]
    result = read(rows)
    assert result["payer"]["bank"]["state"] == "present"
    assert result["payer"]["bank"]["value"] == "合成银行甲支行"
    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payer"]["account"]["value"] == "00123456789"


@pytest.mark.parametrize("space", ["\u3000", "\u00a0", "\u202f"])
def test_unicode_space_separates_explicit_inline_party_fields(space):
    rows = [(20, 20, f"付款账户：00123456789{space}付款户名：合成甲公司", 510, 10),
            (20, 45, f"收款账户：00987654321{space}收款户名：合成乙公司", 510, 10),
            (20, 70, "业务名称：合成汇划业务", 220, 10)]
    result = read(rows)
    assert result["payer"]["account"]["value"] == "00123456789"
    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payee"]["account"]["value"] == "00987654321"
    assert result["payee"]["name"]["value"] == "合成乙公司"


def test_unicode_space_only_after_empty_label_is_not_proof_of_blank_cell():
    assert read([(20, 20, "付款人名称：\u3000", 200, 10)])["payer"]["name"]["state"] == "missing"


def test_explicit_label_centered_against_wrapped_name_keeps_both_lines():
    rows = [(20, 47, "付款人账号", 50, 9), (80, 47, "000123456", 50, 9),
            (300, 47, "收款人账号", 50, 9), (360, 47, "1807-C00000", 60, 9),
            (20, 62, "付款人名称", 50, 9), (80, 62, "合成甲公司", 110, 9),
            (300, 62, "收款人名称", 50, 9),
            (360, 56, "合成银行企业网银汇款手续费（新", 225, 9),
            (360, 67, "）", 9, 9),
            (20, 83, "付款人开户行：合成银行甲支行", 260, 9),
            (300, 83, "收款人开户行：合成银行乙支行", 260, 9)]
    result = read(rows)
    assert result["payee"]["name"]["value"] == "合成银行企业网银汇款手续费(新)"
    assert result["payee"]["name"]["state"] == "present"
    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payee"]["bank"]["value"] == "合成银行乙支行"


@pytest.mark.parametrize("value", ["）", ")", "...", "（ ）", "，。"])
def test_punctuation_only_name_is_unreadable_not_a_named_counterparty(value):
    result = read([(20, 20, "收款人名称：" + value, 230, 9)])
    assert result["payee"]["name"]["state"] == "ambiguous"
