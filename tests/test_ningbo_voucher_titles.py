from __future__ import annotations

import pytest

from engine import layout as layout_module
from engine.layout import HorizontalSeparator, infer_receipt_candidates
from engine.pdf_parser import ParsedPage, TextBlock


NINGBO_VOUCHER_TITLE = "宁波银行网上交易凭证"


@pytest.mark.parametrize(
    "title",
    (
        NINGBO_VOUCHER_TITLE,
        "宁 波 银 行 网 上 交 易 凭 证",
        "  宁 波  银 行 网 上 交 易 凭 证  ",
    ),
)
def test_ningbo_online_voucher_title_normalizes_whitespace(title: str) -> None:
    assert layout_module._is_receipt_title(title)


@pytest.mark.parametrize(
    "line",
    (
        "说明：宁波银行网上交易凭证",
        "字段：宁波银行网上交易凭证",
        "印章：宁波银行网上交易凭证",
        "凭证编号：12345",
        "宁波银行网上交易凭证 编号：12345",
        "宁波银行网上交易凭证专用章",
        "宁波银行网上交易凭证\n专用章",
    ),
)
def test_ningbo_voucher_explanations_fields_stamps_and_numbers_are_not_titles(
    line: str,
) -> None:
    assert not layout_module._is_receipt_title(line)


def _ningbo_three_receipt_page() -> tuple[
    ParsedPage,
    tuple[HorizontalSeparator, ...],
    tuple[tuple[TextBlock, ...], ...],
]:
    blocks: list[TextBlock] = []
    separator_list: list[HorizontalSeparator] = []
    receipt_blocks: list[tuple[TextBlock, ...]] = []
    for index, top in enumerate((20, 320, 620), start=1):
        slot_blocks = (
            TextBlock(1, NINGBO_VOUCHER_TITLE, 40, top, 300, top + 18, index * 10),
            TextBlock(
                1,
                f"交易账号：合成账户{index}",
                45,
                top + 48,
                280,
                top + 66,
                index * 10 + 1,
            ),
            TextBlock(
                1,
                f"交易金额：合成金额{index}",
                45,
                top + 95,
                280,
                top + 113,
                index * 10 + 2,
            ),
            TextBlock(
                1,
                f"页脚：第{index}联",
                45,
                top + 175,
                220,
                top + 193,
                index * 10 + 3,
            ),
        )
        blocks.extend(slot_blocks)
        receipt_blocks.append(slot_blocks)
        separator_list.extend(
            (
                HorizontalSeparator(top + 80, 20, 580),
                HorizontalSeparator(top + 130, 20, 580),
                HorizontalSeparator(top + 198, 20, 580),
            )
        )

    page = ParsedPage(
        1,
        600,
        900,
        "\n".join(block.text for block in blocks),
        tuple(blocks),
    )
    return page, tuple(separator_list), tuple(receipt_blocks)


def test_ningbo_three_vouchers_keep_one_candidate_per_internal_separator() -> None:
    page, separators, receipt_blocks = _ningbo_three_receipt_page()

    candidates = infer_receipt_candidates(page, separators=separators)

    assert len(candidates) == 3
    assert [candidate.slot for candidate in candidates] == ["top", "middle", "bottom"]
    for candidate, slot_blocks in zip(candidates, receipt_blocks):
        assert all(
            candidate.rect.y0 <= block.y0
            and candidate.rect.y1 >= block.y1
            for block in slot_blocks
        )
    assert all(
        first.rect.y1 <= second.rect.y0
        for first, second in zip(candidates, candidates[1:])
    )
