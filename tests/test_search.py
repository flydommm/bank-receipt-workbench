from __future__ import annotations

from datetime import date
from pathlib import Path

import pymupdf
import pytest

from engine import search as search_module
from engine.pdf_parser import iter_pages, page_count
from engine.pdf_parser import ParsedPage, TextBlock
from engine.search import (
    SearchBudgetExceeded,
    SearchClause,
    SearchQuery,
    normalize_text,
    search_pages,
    search_pages_multi,
)


def _make_pdf(path: Path) -> None:
    document = pymupdf.open()
    fontname = "china-s"
    page = document.new_page(width=595, height=842)
    page.insert_text((50, 80), "交易日期 2025年10月30日", fontname=fontname)
    page.insert_text((50, 110), "收款方：手续费（示例）", fontname=fontname)
    page.insert_text((50, 140), "交易金额：29,500.00", fontname=fontname)
    page2 = document.new_page(width=595, height=842)
    page2.insert_text((50, 80), "交易日期 2025年11月01日", fontname=fontname)
    page2.insert_text((50, 110), "收款方：其他项目", fontname=fontname)
    document.save(path)
    document.close()


def test_parse_pages_keeps_text_and_coordinates(tmp_path: Path) -> None:
    pdf_path = tmp_path / "text.pdf"
    _make_pdf(pdf_path)
    pages = list(iter_pages(pdf_path))
    assert page_count(pdf_path) == 2
    assert pages[0].page_number == 1
    assert "手续费" in pages[0].text
    assert pages[0].blocks[0].x0 > 0


def test_exact_search_returns_page_and_coordinate(tmp_path: Path) -> None:
    pdf_path = tmp_path / "text.pdf"
    _make_pdf(pdf_path)
    matches = search_pages(iter_pages(pdf_path), SearchQuery(keyword="手续费"))
    assert len(matches) == 1
    assert matches[0].page_number == 1
    assert matches[0].matched_field == "收款方"
    assert matches[0].confidence == 1.0
    assert matches[0].x1 > matches[0].x0


def test_exact_search_normalizes_fullwidth_edge_spaces() -> None:
    matches = search_pages(
        (_multi_page("　手续费　"),),
        SearchQuery(keyword="手续费"),
    )

    assert [match.matched_text for match in matches] == ["手续费"]


def test_date_and_amount_filters_are_applied(tmp_path: Path) -> None:
    pdf_path = tmp_path / "text.pdf"
    _make_pdf(pdf_path)
    query = SearchQuery(keyword="手续费", date_from=date(2025, 10, 1), date_to=date(2025, 10, 31), amount_min=29000, amount_max=30000)
    assert len(search_pages(iter_pages(pdf_path), query)) == 1
    assert not search_pages(iter_pages(pdf_path), SearchQuery(keyword="手续费", date_from=date(2025, 11, 1)))


def test_normalize_text_handles_fullwidth_and_whitespace() -> None:
    assert normalize_text("　手　续费！") == "手 续费!"


def test_fuzzy_search_matches_keyword_inside_long_block_and_preserves_text() -> None:
    text = (
        "中国工商银行电子回单 "
        "回单编号：100000000001 "
        "交易日期：2025年10月30日 "
        "付款方：示例公司 "
        "收款方：手续费（示例） "
        "交易金额：29,500.00 "
        "币种：人民币 "
        "交易类型：转账 "
        "附言：月度服务结算 "
        "打印时间：2025年10月30日"
    )
    page = ParsedPage(
        1,
        600,
        800,
        text,
        (TextBlock(1, text, 10, 20, 580, 220, 0, confidence=0.82),),
    )

    matches = search_pages(
        (page,),
        SearchQuery(keyword="手续费", exact=False),
    )

    assert len(matches) == 1
    assert matches[0].matched_text == normalize_text(text)
    assert matches[0].confidence == 0.82


def test_fuzzy_search_matches_keyword_with_internal_spaces() -> None:
    text = "收款方：手 续费（示例）"

    matches = search_pages(
        (_multi_page(text),),
        SearchQuery(keyword="手续费", exact=False),
    )

    assert [match.matched_text for match in matches] == [normalize_text(text)]


def test_fuzzy_search_matches_local_character_difference() -> None:
    text = "收款方：手续費（示例）"

    matches = search_pages(
        (_multi_page(text),),
        SearchQuery(keyword="手续费", exact=False),
    )

    assert [match.matched_text for match in matches] == [normalize_text(text)]


def test_fuzzy_search_rejects_unrelated_text() -> None:
    assert not search_pages(
        (_multi_page("收款方：办公用品"),),
        SearchQuery(keyword="手续费", exact=False),
    )


def test_fuzzy_search_does_not_join_adjacent_text_blocks() -> None:
    page = _multi_page("手", "续", "费")

    assert not search_pages(
        (page,),
        SearchQuery(keyword="手续费", exact=False),
    )


def test_fuzzy_search_does_not_use_shorter_than_two_character_windows() -> None:
    page = _multi_page("甲")

    assert not search_pages(
        (page,),
        SearchQuery(keyword="甲乙", exact=False),
    )
    assert search_pages(
        (_multi_page("甲乙丙"),),
        SearchQuery(keyword="甲乙", exact=False),
    )


def test_search_rejects_oversized_keyword_before_consuming_pages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(search_module, "MAX_SEARCH_KEYWORD_CHARACTERS", 2)
    consumed = False

    def pages():
        nonlocal consumed
        consumed = True
        yield ParsedPage(1, 600, 800, "目标", ())

    with pytest.raises(SearchBudgetExceeded):
        search_pages(pages(), SearchQuery(keyword="目标词"))
    assert consumed is False


def test_search_rejects_page_with_too_many_text_blocks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(search_module, "MAX_TEXT_BLOCKS_PER_PAGE", 2)
    blocks = tuple(
        TextBlock(1, "目标", 10, index * 20, 100, index * 20 + 10, index)
        for index in range(3)
    )
    page = ParsedPage(1, 600, 800, "目标", blocks)

    with pytest.raises(SearchBudgetExceeded):
        search_pages((page,), SearchQuery(keyword="目标"))


def test_search_match_budget_stops_before_unbounded_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(search_module, "MAX_SEARCH_MATCHES", 2)
    blocks = tuple(
        TextBlock(1, "目标", 10, index * 20, 100, index * 20 + 10, index)
        for index in range(3)
    )
    page = ParsedPage(1, 600, 800, "目标", blocks)

    with pytest.raises(SearchBudgetExceeded):
        search_pages((page,), SearchQuery(keyword="目标"))


def _multi_page(*texts: str) -> ParsedPage:
    blocks = tuple(
        TextBlock(1, text, 10, index * 20, 100, index * 20 + 10, index)
        for index, text in enumerate(texts)
    )
    return ParsedPage(1, 600, 800, "\n".join(texts), blocks)


def test_multi_search_tags_each_clause_match() -> None:
    page = _multi_page("手续费", "退款")
    clauses = (
        SearchClause("fee", "手续费", "include"),
        SearchClause("refund", "退款", "exclude"),
    )

    matches = search_pages_multi((page,), clauses)

    assert [(match.matched_text, match.query_id, match.role) for match in matches] == [
        ("手续费", "fee", "include"),
        ("退款", "refund", "exclude"),
    ]
    assert matches[0].x0 == page.blocks[0].x0


def test_fuzzy_multi_search_preserves_clause_metadata_and_source_text() -> None:
    texts = ("付款方：手续费及服务费", "备注：退款")
    clauses = (
        SearchClause("fee", "手续费", "include"),
        SearchClause("refund", "退款", "exclude"),
    )

    matches = search_pages_multi(
        (_multi_page(*texts),),
        clauses,
        exact=False,
    )

    assert len(matches) == 2
    assert [(match.matched_text, match.query_id, match.role) for match in matches] == [
        (normalize_text(texts[0]), "fee", "include"),
        (normalize_text(texts[1]), "refund", "exclude"),
    ]


def test_multi_search_consumes_page_iterator_once() -> None:
    consumed = 0

    def pages():
        nonlocal consumed
        consumed += 1
        yield _multi_page("手续费")
        consumed += 1
        yield _multi_page("退款")

    matches = search_pages_multi(
        pages(),
        (
            SearchClause("fee", "手续费", "include"),
            SearchClause("refund", "退款", "exclude"),
        ),
    )

    assert consumed == 2
    assert [(match.matched_text, match.query_id) for match in matches] == [
        ("手续费", "fee"),
        ("退款", "refund"),
    ]


def test_multi_search_accepts_512_unicode_code_points_and_rejects_513() -> None:
    keyword = "😀" * 512
    page = _multi_page(keyword)
    assert search_pages_multi((page,), (SearchClause("emoji", f"  {keyword}  ", "include"),))

    consumed = False

    def pages():
        nonlocal consumed
        consumed = True
        yield page

    with pytest.raises(SearchBudgetExceeded):
        search_pages_multi(
            pages(),
            (SearchClause("emoji", f"{keyword}😀", "include"),),
        )
    assert consumed is False


@pytest.mark.parametrize(
    "clauses",
    [
        (),
        (SearchClause("", "目标", "include"),),
        (SearchClause(" ", "目标", "include"),),
        (
            SearchClause("same", "目标", "include"),
            SearchClause("same", "其他", "exclude"),
        ),
        (SearchClause("target", "目标", "other"),),
        (SearchClause("target", "  ", "include"),),
    ],
)
def test_multi_search_rejects_invalid_clauses(clauses: tuple[SearchClause, ...]) -> None:
    with pytest.raises(SearchBudgetExceeded):
        search_pages_multi((_multi_page("目标"),), clauses)


def test_multi_search_rejects_non_string_role_before_set_membership() -> None:
    with pytest.raises(SearchBudgetExceeded, match="search clause role is invalid"):
        search_pages_multi(
            (_multi_page("目标"),),
            (SearchClause("target", "目标", []),),  # type: ignore[arg-type]
        )


@pytest.mark.parametrize("keyword", ["\u200b", " \u200b \u200b "])
def test_multi_search_rejects_keyword_empty_after_normalization(keyword: str) -> None:
    with pytest.raises(
        SearchBudgetExceeded,
        match="search clause keyword must be non-empty",
    ):
        search_pages_multi(
            (_multi_page("目标"),),
            (SearchClause("target", keyword, "include"),),
        )


def test_multi_search_rejects_more_than_32_clauses_before_consuming_pages() -> None:
    consumed = False

    def pages():
        nonlocal consumed
        consumed = True
        yield _multi_page("目标")

    clauses = tuple(
        SearchClause(f"query-{index}", "目标", "include")
        for index in range(33)
    )
    with pytest.raises(SearchBudgetExceeded):
        search_pages_multi(pages(), clauses)
    assert consumed is False


def test_multi_search_shares_fuzzy_work_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(search_module, "MAX_FUZZY_WORK", 10)
    page = _multi_page("abc")
    clauses = (
        SearchClause("first", "ab", "include"),
        SearchClause("second", "bc", "include"),
    )

    with pytest.raises(SearchBudgetExceeded):
        search_pages_multi((page,), clauses, exact=False)


def test_single_fuzzy_search_shares_work_budget_with_one_long_block(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(search_module, "MAX_FUZZY_WORK", 10)
    page = _multi_page("手续费手续费")

    with pytest.raises(SearchBudgetExceeded):
        search_pages((page,), SearchQuery(keyword="手续费", exact=False))


def test_search_pages_single_keyword_regression_keeps_legacy_match_metadata() -> None:
    matches = search_pages((_multi_page("手续费"),), SearchQuery(keyword="手续费"))

    assert len(matches) == 1
    assert matches[0].query_id is None
    assert matches[0].role is None
