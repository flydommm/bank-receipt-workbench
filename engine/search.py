"""Search and filtering for parsed PDF text."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
import re
from difflib import SequenceMatcher
from typing import Iterable

try:
    from .pdf_parser import ParsedPage, TextBlock
except ImportError:  # Running through the standalone engine.py entrypoint.
    from pdf_parser import ParsedPage, TextBlock  # type: ignore[no-redef]


_FULLWIDTH_START = ord("！")
_FULLWIDTH_END = ord("｠")
_DATE_RE = re.compile(r"(?P<year>20\d{2})[年./-](?P<month>\d{1,2})[月./-](?P<day>\d{1,2})日?")
_AMOUNT_RE = re.compile(r"(?P<amount>\d[\d,]*(?:\.\d{1,2})?)")
MAX_SEARCH_KEYWORD_CHARACTERS = 512
MAX_SEARCH_CLAUSES = 32
MAX_SEARCH_PAGES = 5_000
MAX_TEXT_BLOCKS_PER_PAGE = 4_096
MAX_PAGE_TEXT_CHARACTERS = 4_000_000
MAX_TOTAL_TEXT_CHARACTERS = 64_000_000
MAX_TEXT_BLOCK_CHARACTERS = 65_536
MAX_FUZZY_WORK = 64_000_000
MAX_SEARCH_MATCHES = 10_000
MAX_MATCH_TEXT_CHARACTERS = 8_000_000


class SearchBudgetExceeded(RuntimeError):
    """The PDF exceeds the bounded work or response budget for search."""


_SEARCH_BUDGET_FIELDS = (
    "processed_pages",
    "text_characters",
    "fuzzy_work",
    "matches",
    "matched_text_characters",
)
_SEARCH_BUDGET_LIMIT_NAMES = {
    "processed_pages": "MAX_SEARCH_PAGES",
    "text_characters": "MAX_TOTAL_TEXT_CHARACTERS",
    "fuzzy_work": "MAX_FUZZY_WORK",
    "matches": "MAX_SEARCH_MATCHES",
    "matched_text_characters": "MAX_MATCH_TEXT_CHARACTERS",
}


def _search_budget_limit(field: str) -> int:
    return int(globals()[_SEARCH_BUDGET_LIMIT_NAMES[field]])


def _validate_search_budget_value(field: str, value: object) -> None:
    if type(value) is not int or value < 0:
        raise SearchBudgetExceeded(
            f"search budget {field} must be a non-negative Python int"
        )
    if value > _search_budget_limit(field):
        raise SearchBudgetExceeded(f"search budget {field} exceeds safe limits")


@dataclass(slots=True)
class SearchBudget:
    """Cumulative bounded work consumed by one or more search calls."""

    processed_pages: int = 0
    text_characters: int = 0
    fuzzy_work: int = 0
    matches: int = 0
    matched_text_characters: int = 0

    def __setattr__(self, name: str, value: object) -> None:
        if name in _SEARCH_BUDGET_FIELDS:
            _validate_search_budget_value(name, value)
        object.__setattr__(self, name, value)

    def _validate(self) -> None:
        for field in _SEARCH_BUDGET_FIELDS:
            _validate_search_budget_value(field, getattr(self, field))

    def to_dict(self) -> dict[str, int]:
        """Return a validated copy suitable for persistence."""

        self._validate()
        return {field: getattr(self, field) for field in _SEARCH_BUDGET_FIELDS}

    @classmethod
    def from_dict(cls, value: Mapping[object, object]) -> "SearchBudget":
        """Read one exact, validated budget mapping without retaining aliases."""

        if not isinstance(value, Mapping):
            raise SearchBudgetExceeded("search budget must be a mapping")
        keys = set(value)
        expected_keys = set(_SEARCH_BUDGET_FIELDS)
        unknown_keys = keys - expected_keys
        missing_keys = expected_keys - keys
        if unknown_keys or missing_keys:
            details: list[str] = []
            if unknown_keys:
                details.append(f"unknown keys: {sorted(map(str, unknown_keys))}")
            if missing_keys:
                details.append(f"missing keys: {sorted(missing_keys)}")
            raise SearchBudgetExceeded(
                "search budget fields must be exact (" + "; ".join(details) + ")"
            )
        return cls(**{
            field: value[field]
            for field in _SEARCH_BUDGET_FIELDS
        })


def _coerce_search_budget(budget: SearchBudget | None) -> SearchBudget:
    if budget is None:
        return SearchBudget()
    if not isinstance(budget, SearchBudget):
        raise SearchBudgetExceeded("invalid search budget")
    budget._validate()
    return budget


def normalize_text(value: str) -> str:
    chars: list[str] = []
    for char in value:
        code = ord(char)
        if code == 0x3000:
            char = " "
        elif _FULLWIDTH_START <= code <= _FULLWIDTH_END:
            char = chr(code - 0xfee0)
        chars.append(char)
    return "".join(chars).replace("\u200b", "").strip()


@dataclass(frozen=True)
class SearchQuery:
    keyword: str
    exact: bool = True
    date_from: date | None = None
    date_to: date | None = None
    amount_min: float | None = None
    amount_max: float | None = None
    field: str | None = None


@dataclass(frozen=True)
class SearchClause:
    query_id: str
    keyword: str
    role: str


@dataclass(frozen=True)
class SearchMatch:
    page_number: int
    matched_text: str
    matched_field: str | None
    confidence: float
    x0: float
    y0: float
    x1: float
    y1: float
    query_id: str | None = None
    role: str | None = None


def _page_date(text: str) -> date | None:
    match = _DATE_RE.search(normalize_text(text))
    if not match:
        return None
    return date(int(match.group("year")), int(match.group("month")), int(match.group("day")))


def _page_amounts(text: str) -> list[float]:
    return [float(item.replace(",", "")) for item in _AMOUNT_RE.findall(normalize_text(text))]


def _field_for_block(text: str) -> str | None:
    for label, field in (("收款方", "收款方"), ("付款方", "付款方"), ("户名", "户名"), ("交易金额", "交易金额")):
        if label in text:
            return field
    return None


@dataclass(frozen=True)
class _SearchTarget:
    keyword: str
    query_id: str | None = None
    role: str | None = None


def _fuzzy_comparison_text(value: str) -> str:
    return "".join(value.split())


def _fuzzy_window_lengths(keyword_length: int, text_length: int) -> tuple[int, ...]:
    if keyword_length <= 0 or text_length <= 0:
        return ()
    minimum_length = (
        keyword_length
        if keyword_length <= 2
        else keyword_length - 1
    )
    return tuple(
        length
        for length in sorted({keyword_length - 1, keyword_length, keyword_length + 1})
        if minimum_length <= length <= text_length
    )


def _match_block(
    keyword: str,
    block_text: str,
    block_confidence: float,
    *,
    exact: bool,
    fuzzy_work: int,
    budget: SearchBudget | None = None,
) -> tuple[bool, float, int]:
    """Evaluate one block and return ``(found, confidence, fuzzy_work)``."""

    if exact:
        found = keyword in block_text
        confidence = block_confidence if found else 0.0
        return found, confidence, fuzzy_work

    comparison_keyword = _fuzzy_comparison_text(keyword)
    comparison_text = _fuzzy_comparison_text(block_text)
    window_lengths = _fuzzy_window_lengths(
        len(comparison_keyword),
        len(comparison_text),
    )
    if not comparison_keyword or not comparison_text or not window_lengths:
        return False, 0.0, fuzzy_work

    best_similarity = 0.0
    for window_length in window_lengths:
        for start in range(len(comparison_text) - window_length + 1):
            next_fuzzy_work = fuzzy_work + len(comparison_keyword) * window_length
            if next_fuzzy_work > MAX_FUZZY_WORK:
                raise SearchBudgetExceeded("fuzzy search exceeds safe work limits")
            fuzzy_work = next_fuzzy_work
            if budget is not None:
                budget.fuzzy_work = fuzzy_work
            similarity = SequenceMatcher(
                None,
                comparison_keyword,
                comparison_text[start : start + window_length],
            ).ratio()
            best_similarity = max(best_similarity, similarity)
    return (
        best_similarity >= 0.65,
        min(best_similarity, block_confidence),
        fuzzy_work,
    )


def _search_pages(
    pages: Iterable[ParsedPage],
    targets: tuple[_SearchTarget, ...],
    *,
    exact: bool,
    query: SearchQuery | None = None,
    budget: SearchBudget | None = None,
) -> list[SearchMatch]:
    """Search pages once for all targets while sharing safety budgets."""

    budget = _coerce_search_budget(budget)
    matches: list[SearchMatch] = []
    fuzzy_work = budget.fuzzy_work
    for page_index, page in enumerate(pages, start=1):
        if page_index > MAX_SEARCH_PAGES or budget.processed_pages >= MAX_SEARCH_PAGES:
            raise SearchBudgetExceeded("PDF has too many pages to search safely")
        budget.processed_pages += 1
        if (
            len(page.text) > MAX_PAGE_TEXT_CHARACTERS
            or len(page.blocks) > MAX_TEXT_BLOCKS_PER_PAGE
        ):
            raise SearchBudgetExceeded("PDF page text exceeds safe search limits")
        block_text_characters = sum(len(block.text) for block in page.blocks)
        next_text_characters = budget.text_characters + len(page.text) + block_text_characters
        if next_text_characters > MAX_TOTAL_TEXT_CHARACTERS:
            raise SearchBudgetExceeded("PDF text exceeds safe search limits")
        budget.text_characters = next_text_characters
        if query is not None and (query.date_from is not None or query.date_to is not None):
            page_date = _page_date(page.text)
            if query.date_from and (page_date is None or page_date < query.date_from):
                continue
            if query.date_to and (page_date is None or page_date > query.date_to):
                continue
        if query is not None and (query.amount_min is not None or query.amount_max is not None):
            amounts = _page_amounts(page.text)
            if query.amount_min is not None and (
                not amounts or max(amounts) < query.amount_min
            ):
                continue
            if query.amount_max is not None and (
                not amounts or min(amounts) > query.amount_max
            ):
                continue
        for block in page.blocks:
            if len(block.text) > MAX_TEXT_BLOCK_CHARACTERS:
                raise SearchBudgetExceeded("PDF text block exceeds safe search limits")
            block_text = normalize_text(block.text)
            field = _field_for_block(block_text)
            for target in targets:
                found, confidence, fuzzy_work = _match_block(
                    target.keyword,
                    block_text,
                    block.confidence,
                    exact=exact,
                    fuzzy_work=fuzzy_work,
                    budget=budget,
                )
                if not found:
                    continue
                if query is not None and query.field and field != query.field:
                    continue
                if budget.matches >= MAX_SEARCH_MATCHES:
                    raise SearchBudgetExceeded("search result limit exceeded")
                next_matched_text_characters = (
                    budget.matched_text_characters + len(block_text)
                )
                if next_matched_text_characters > MAX_MATCH_TEXT_CHARACTERS:
                    raise SearchBudgetExceeded("search response size limit exceeded")
                budget.matched_text_characters = next_matched_text_characters
                budget.matches += 1
                matches.append(
                    SearchMatch(
                        page.page_number,
                        block_text,
                        field,
                        round(confidence, 4),
                        block.x0,
                        block.y0,
                        block.x1,
                        block.y1,
                        target.query_id,
                        target.role,
                    )
                )
    return matches


def search_pages(
    pages: Iterable[ParsedPage],
    query: SearchQuery,
    *,
    budget: SearchBudget | None = None,
) -> list[SearchMatch]:
    """Return one match per matching text block, preserving its coordinates."""

    if len(query.keyword) > MAX_SEARCH_KEYWORD_CHARACTERS:
        raise SearchBudgetExceeded("search keyword is too long")
    keyword = normalize_text(query.keyword)
    if not keyword:
        return []
    budget = _coerce_search_budget(budget)
    return _search_pages(
        pages,
        (_SearchTarget(keyword),),
        exact=query.exact,
        query=query,
        budget=budget,
    )


def _prepare_search_clauses(
    clauses: Iterable[SearchClause],
) -> tuple[_SearchTarget, ...]:
    try:
        clause_items = tuple(clauses)
    except TypeError as exc:
        raise SearchBudgetExceeded("invalid search clauses") from exc
    if not clause_items:
        raise SearchBudgetExceeded("at least one search clause is required")
    if len(clause_items) > MAX_SEARCH_CLAUSES:
        raise SearchBudgetExceeded("too many search clauses")

    seen_query_ids: set[str] = set()
    targets: list[_SearchTarget] = []
    for clause in clause_items:
        if not isinstance(clause, SearchClause):
            raise SearchBudgetExceeded("invalid search clause")
        if not isinstance(clause.query_id, str) or not clause.query_id.strip():
            raise SearchBudgetExceeded("search clause query_id must be non-empty")
        if clause.query_id in seen_query_ids:
            raise SearchBudgetExceeded("search clause query_id must be unique")
        seen_query_ids.add(clause.query_id)
        if not isinstance(clause.role, str) or clause.role not in {"include", "exclude"}:
            raise SearchBudgetExceeded("search clause role is invalid")
        if not isinstance(clause.keyword, str):
            raise SearchBudgetExceeded("search clause keyword is invalid")
        trimmed_keyword = clause.keyword.strip()
        if not trimmed_keyword:
            raise SearchBudgetExceeded("search clause keyword must be non-empty")
        if len(trimmed_keyword) > MAX_SEARCH_KEYWORD_CHARACTERS:
            raise SearchBudgetExceeded("search keyword is too long")
        normalized_keyword = normalize_text(trimmed_keyword)
        if not normalized_keyword:
            raise SearchBudgetExceeded("search clause keyword must be non-empty")
        targets.append(_SearchTarget(normalized_keyword, clause.query_id, clause.role))
    return tuple(targets)


def search_pages_multi(
    pages: Iterable[ParsedPage],
    clauses: Iterable[SearchClause],
    *,
    exact: bool = True,
    budget: SearchBudget | None = None,
) -> list[SearchMatch]:
    """Search all clauses in one pass over ``pages`` and tag each match."""

    targets = _prepare_search_clauses(clauses)
    budget = _coerce_search_budget(budget)
    return _search_pages(pages, targets, exact=exact, budget=budget)
