from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

from engine.engine import _analyze_page_geometry, _parse_pdf_page, _selection_payloads
from engine.layout import Rect


INPUT_DIR = Path(os.environ.get(
    "PDF_SEARCH_REAL_INPUT_DIR",
    str(Path(__file__).parents[1] / ".local-data" / "input"),
))
SHANGHAI_PDF = INPUT_DIR / "银行回单_样例甲_上海银行_202607.pdf"


@pytest.mark.skipif(not SHANGHAI_PDF.is_file(), reason="上海银行真实样本不可用")
@pytest.mark.parametrize("page_number, footer_y", [
    (14, 304.9), (15, 289.9), (218, 229.9), (357, 274.9),
])
def test_tax_voucher_includes_body_and_footer_without_background_watermarks(
    page_number: int, footer_y: float,
) -> None:
    before = (SHANGHAI_PDF.stat().st_size, hashlib.sha256(SHANGHAI_PDF.read_bytes()).digest())
    parsed = _parse_pdf_page(SHANGHAI_PDF, page_number)
    assert parsed is not None
    separators, anchors, candidates, budget_exceeded = _analyze_page_geometry(
        SHANGHAI_PDF, page_number, parsed,
    )
    title = next(block for block in parsed.blocks if "电子缴税付款凭证" in block.text)
    _, selections = _selection_payloads(
        [Rect(title.x0, title.y0, title.x1, title.y1)],
        separators, anchors, candidates, parsed.width, parsed.height, budget_exceeded,
    )
    assert len(candidates) == 1, f"page {page_number}: fragmented into {len(candidates)} candidates"
    candidate = candidates[0]
    assert candidate.rect.x0 == 0 and candidate.rect.x1 == parsed.width
    assert candidate.rect.y0 <= title.y0
    assert footer_y <= candidate.rect.y1 <= footer_y + 20, (
        f"page {page_number}: bottom {candidate.rect.y1} must contain footer, not blank watermark area"
    )
    assert selections[0]["candidate_rect"] is not None
    assert selections[0]["candidate_rect"]["y1"] == candidate.rect.y1
    for block in parsed.blocks:
        if block.text.strip() != "上海银行":
            assert candidate.rect.y0 <= block.y0 and candidate.rect.y1 >= block.y1, (
                f"page {page_number}: content block {block.block_index} was clipped"
            )
    # Layout exclusions must preserve the original searchable text and blocks.
    assert len([block for block in parsed.blocks if block.text.strip() == "上海银行"]) == 8
    assert "上海银行" in parsed.text
    assert (SHANGHAI_PDF.stat().st_size, hashlib.sha256(SHANGHAI_PDF.read_bytes()).digest()) == before
