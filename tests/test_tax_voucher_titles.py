from __future__ import annotations

import pytest

from engine import layout as layout_module
from engine.layout import HorizontalSeparator, infer_receipt_candidates
from engine.pdf_parser import ParsedPage, TextBlock


def test_shanghai_bank_tax_voucher_title_is_recognized() -> None:
    assert layout_module._is_receipt_title("上海银行电子缴税付款凭证")


def test_shanghai_bank_tax_voucher_title_normalizes_cjk_spaces() -> None:
    assert layout_module._is_receipt_title("上 海 银 行 电 子 缴 税 付 款 凭 证")


@pytest.mark.parametrize(
    "line",
    (
        "凭证号：123456",
        "记账凭证",
        "本凭证信息可通过上海银行电子缴税付款凭证校验",
        "上海银行电子缴税付款凭证 编号：123456",
        "上海银行电子缴税付款凭证专用章",
        "上海银行电子缴税付款凭证\n专用章",
    ),
)
def test_tax_voucher_fields_explanations_and_stamps_are_not_titles(line: str) -> None:
    assert not layout_module._is_receipt_title(line)


def test_tax_voucher_title_keeps_one_full_candidate_across_internal_separator() -> None:
    blocks = (
        TextBlock(1, "上海银行电子缴税付款凭证", 40, 20, 280, 38, 0),
        TextBlock(1, "缴款单位：上海某某有限公司", 45, 55, 300, 75, 1),
        TextBlock(1, "税款：1,234.56", 45, 120, 250, 140, 2),
        TextBlock(1, "打印时间：2026-09-07 12:00", 45, 220, 300, 240, 3),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(
        page,
        separators=(HorizontalSeparator(90, 20, 580),),
    )

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.rect.y0 <= blocks[0].y0
    assert candidate.rect.y1 >= blocks[-1].y1
    assert candidate.rect.y1 - candidate.rect.y0 > blocks[0].y1 - blocks[0].y0
