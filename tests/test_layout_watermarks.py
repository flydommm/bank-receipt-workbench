from __future__ import annotations

import pytest

from engine.layout import MAX_TEXT_BLOCKS, infer_receipt_candidates
from engine.pdf_parser import ParsedPage, TextBlock
from engine.search import SearchQuery, search_pages


@pytest.mark.parametrize("heading", ["客户回单", "普通表格"])
def test_layout_ignores_marked_watermarks_without_removing_searchable_text(heading: str) -> None:
    blocks = (
        TextBlock(1, heading, 40, 20, 200, 40, 0),
        TextBlock(1, "税款合计", 40, 60, 400, 80, 1),
        TextBlock(1, "打印时间", 40, 90, 400, 110, 2),
        TextBlock(1, "上海银行", 40, 650, 160, 710, 3, is_watermark=True),
    )
    page = ParsedPage(1, 600, 800, "\n".join(block.text for block in blocks), blocks)

    candidates = infer_receipt_candidates(page)

    assert len(candidates) == 1
    assert 110 <= candidates[0].rect.y1 <= 130
    assert page.blocks == blocks
    assert any(match.matched_text == "上海银行" for match in search_pages([page], SearchQuery("上海银行")))


def test_layout_retains_unmarked_bank_name_as_content() -> None:
    page = ParsedPage(1, 600, 800, "", (
        TextBlock(1, "客户回单", 40, 20, 200, 40, 0),
        TextBlock(1, "上海银行", 40, 650, 160, 710, 1),
    ))
    assert infer_receipt_candidates(page)[0].rect.y1 >= 710


def test_watermark_filter_does_not_bypass_text_block_budget() -> None:
    page = ParsedPage(1, 600, 800, "", tuple(
        TextBlock(1, "上海银行", 40, 650, 160, 710, index, is_watermark=True)
        for index in range(MAX_TEXT_BLOCKS + 1)
    ))
    candidates = infer_receipt_candidates(page)
    assert len(candidates) == 1
    assert "layout_budget_exceeded" in candidates[0].evidence
    assert candidates[0].confidence < 0.9
