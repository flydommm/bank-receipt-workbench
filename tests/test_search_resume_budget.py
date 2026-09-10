from __future__ import annotations

from datetime import date
from math import inf

import pytest

from engine import search as search_module
from engine.pdf_parser import ParsedPage, TextBlock
from engine.search import (
    SearchBudget,
    SearchBudgetExceeded,
    SearchClause,
    SearchQuery,
    search_pages,
    search_pages_multi,
)


def _page(text: str) -> ParsedPage:
    block = TextBlock(1, text, 10, 20, 100, 30, 0)
    return ParsedPage(1, 600, 800, text, (block,))


def test_resumed_page_search_counts_matches_across_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(search_module, "MAX_SEARCH_MATCHES", 1)
    budget = SearchBudget()

    assert len(search_pages((_page("目标"),), SearchQuery("目标"), budget=budget)) == 1

    with pytest.raises(SearchBudgetExceeded, match="search result limit exceeded"):
        search_pages((_page("目标"),), SearchQuery("目标"), budget=budget)


def test_search_budget_round_trips_a_copy_and_rejects_invalid_shapes() -> None:
    budget = SearchBudget(
        processed_pages=1,
        text_characters=2,
        fuzzy_work=3,
        matches=4,
        matched_text_characters=5,
    )
    payload = budget.to_dict()
    assert SearchBudget.from_dict(payload) == budget
    payload["matches"] = 99
    assert budget.matches == 4

    for value in (True, -1, 1.0, inf):
        with pytest.raises(SearchBudgetExceeded):
            SearchBudget.from_dict({
                "processed_pages": value,
                "text_characters": 0,
                "fuzzy_work": 0,
                "matches": 0,
                "matched_text_characters": 0,
            })

    with pytest.raises(SearchBudgetExceeded):
        SearchBudget.from_dict({
            "processed_pages": 0,
            "text_characters": 0,
            "fuzzy_work": 0,
            "matches": 0,
            "matched_text_characters": 0,
            "unknown": 0,
        })
    with pytest.raises(SearchBudgetExceeded):
        SearchBudget.from_dict({
            "processed_pages": 0,
            "text_characters": 0,
            "fuzzy_work": 0,
            "matches": 0,
        })


@pytest.mark.parametrize(
    ("field", "limit"),
    [
        ("processed_pages", search_module.MAX_SEARCH_PAGES),
        ("text_characters", search_module.MAX_TOTAL_TEXT_CHARACTERS),
        ("fuzzy_work", search_module.MAX_FUZZY_WORK),
        ("matches", search_module.MAX_SEARCH_MATCHES),
        ("matched_text_characters", search_module.MAX_MATCH_TEXT_CHARACTERS),
    ],
)
def test_search_budget_rejects_values_above_each_safe_limit(
    field: str,
    limit: int,
) -> None:
    payload = {
        "processed_pages": 0,
        "text_characters": 0,
        "fuzzy_work": 0,
        "matches": 0,
        "matched_text_characters": 0,
    }
    payload[field] = limit + 1

    with pytest.raises(SearchBudgetExceeded):
        SearchBudget.from_dict(payload)


def test_whole_search_and_serialized_page_resume_have_the_same_budget() -> None:
    pages = (_page("目标"), _page("其他"), _page("目标"))
    query = SearchQuery("目标")

    whole_budget = SearchBudget()
    whole_matches = search_pages(pages, query, budget=whole_budget)

    resumed_budget = SearchBudget()
    resumed_matches = []
    for page in pages:
        page_budget = SearchBudget.from_dict(resumed_budget.to_dict())
        resumed_matches.extend(search_pages((page,), query, budget=page_budget))
        resumed_budget = SearchBudget.from_dict(page_budget.to_dict())

    assert resumed_matches == whole_matches
    assert resumed_budget == whole_budget


@pytest.mark.parametrize(
    ("query", "text"),
    [
        (SearchQuery("目标", date_from=date(2025, 11, 1)), "交易日期 2025年10月30日\n目标"),
        (SearchQuery("目标", amount_min=100), "交易金额：29\n目标"),
    ],
)
def test_filtered_pages_still_consume_page_and_text_budget(
    query: SearchQuery,
    text: str,
) -> None:
    page = _page(text)
    budget = SearchBudget()

    assert search_pages((page,), query, budget=budget) == []
    assert budget.processed_pages == 1
    assert budget.text_characters == len(page.text) + len(page.blocks[0].text)
    assert budget.matches == 0
    assert budget.matched_text_characters == 0


def test_multi_search_counts_duplicate_text_for_each_matching_clause() -> None:
    page = _page("目标")
    clauses = (
        SearchClause("one", "目标", "include"),
        SearchClause("two", "目标", "exclude"),
    )
    budget = SearchBudget()

    matches = search_pages_multi((page,), clauses, budget=budget)

    assert len(matches) == 2
    assert budget.processed_pages == 1
    assert budget.text_characters == len(page.text) + len(page.blocks[0].text)
    assert budget.matches == 2
    assert budget.matched_text_characters == 2 * len("目标")


def test_fuzzy_work_accumulates_across_pages_and_stops_at_the_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(search_module, "MAX_FUZZY_WORK", 14)
    budget = SearchBudget()
    query = SearchQuery("ab", exact=False)

    assert len(search_pages((_page("abc"),), query, budget=budget)) == 1
    assert budget.fuzzy_work == 14

    with pytest.raises(SearchBudgetExceeded, match="fuzzy search exceeds safe work limits"):
        search_pages((_page("abc"),), query, budget=budget)
    assert budget.fuzzy_work == 14


def test_budget_keeps_consumed_work_when_a_later_match_exceeds_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(search_module, "MAX_MATCH_TEXT_CHARACTERS", 2)
    budget = SearchBudget()
    query = SearchQuery("目标")

    assert len(search_pages((_page("目标"),), query, budget=budget)) == 1
    with pytest.raises(SearchBudgetExceeded, match="search response size limit exceeded"):
        search_pages((_page("目标"),), query, budget=budget)

    assert budget.processed_pages == 2
    assert budget.matches == 1
    assert budget.matched_text_characters == 2
