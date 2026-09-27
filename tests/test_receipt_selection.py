from __future__ import annotations

import pytest

from engine.pdf_parser import ParsedPage, TextBlock
from engine.receipt_layout_models import ReceiptLayoutError
from engine.receipt_selection import (
    ReceiptSelectionResult,
    SelectionDiagnostic,
    select_receipt_instances,
)
from engine.search import (
    MAX_PAGE_TEXT_CHARACTERS,
    MAX_SEARCH_PAGES,
    SearchBudget,
    SearchBudgetExceeded,
)


def _page(*blocks: tuple[str, float, float, float, float], width: float = 600, height: float = 900) -> ParsedPage:
    parsed_blocks = tuple(
        TextBlock(1, text, x0, y0, x1, y1, index)
        for index, (text, x0, y0, x1, y1) in enumerate(blocks)
    )
    return ParsedPage(1, width, height, "\n".join(block[0] for block in blocks), parsed_blocks)


def _instances(*rects: tuple[float, float, float, float], uncertain: set[int] | None = None) -> list[dict[str, object]]:
    uncertain = uncertain or set()
    return [
        {
            "instance_id": f"instance-{index + 1}",
            "rect": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
            "occupancy": "uncertain" if index in uncertain else "occupied",
        }
        for index, (x0, y0, x1, y1) in enumerate(rects)
    ]


def _search_options(include: list[str], *, mode: str = "all", exclude: list[str] | None = None) -> dict[str, object]:
    return {
        "processing_mode": "search",
        "criteria": {
            "include": include,
            "includeMode": mode,
            "exclude": exclude or [],
        },
    }


def _split_options() -> dict[str, object]:
    return {"processing_mode": "split_all", "criteria": None}


def test_same_instance_multiple_blocks_satisfy_all_and_emit_one_candidate() -> None:
    page = _page(
        ("alpha", 40, 50, 120, 70),
        ("beta", 40, 100, 120, 120),
    )
    result = select_receipt_instances(
        page,
        _instances((0, 0, 600, 300)),
        _search_options(["alpha", "beta"]),
    )

    assert isinstance(result, ReceiptSelectionResult)
    assert len(result.matches) == 2
    assert len(result.candidates) == 1
    assert result.candidates[0]["instance_id"] == "instance-1"
    assert [evidence["query_id"] for evidence in result.candidates[0]["evidence"]] == [
        "include-0",
        "include-1",
    ]
    assert result.candidates[0]["needs_review"] is False


def test_include_all_does_not_join_hits_from_different_instances() -> None:
    page = _page(
        ("alpha", 40, 50, 120, 70),
        ("beta", 40, 350, 120, 370),
    )
    result = select_receipt_instances(
        page,
        _instances((0, 0, 600, 300), (0, 300, 600, 600)),
        _search_options(["alpha", "beta"]),
    )

    assert result.candidates == ()
    assert result.diagnostics == ()


def test_exclude_is_local_to_the_matching_instance() -> None:
    page = _page(
        ("include", 40, 50, 120, 70),
        ("exclude", 40, 100, 120, 120),
        ("include", 40, 350, 120, 370),
    )
    result = select_receipt_instances(
        page,
        _instances((0, 0, 600, 300), (0, 300, 600, 600)),
        _search_options(["include"], exclude=["exclude"]),
    )

    assert [candidate["instance_id"] for candidate in result.candidates] == ["instance-2"]


def test_three_slots_search_consumes_one_physical_page_budget() -> None:
    page = _page(
        ("fee", 40, 50, 120, 70),
        ("fee", 40, 350, 120, 370),
        ("fee", 40, 650, 120, 670),
    )
    budget = SearchBudget()
    result = select_receipt_instances(
        page,
        _instances((0, 0, 600, 300), (0, 300, 600, 600), (0, 600, 600, 900)),
        _search_options(["fee"]),
        budget=budget,
    )

    assert [candidate["instance_id"] for candidate in result.candidates] == [
        "instance-1",
        "instance-2",
        "instance-3",
    ]
    assert budget.processed_pages == 1
    assert budget.matches == 3


def test_duplicate_hits_do_not_duplicate_candidate_or_evidence() -> None:
    page = _page(
        ("fee", 40, 50, 120, 70),
        ("fee", 40, 50, 120, 70),
    )
    result = select_receipt_instances(
        page,
        _instances((0, 0, 600, 300)),
        _search_options(["fee"]),
    )

    assert len(result.matches) == 2
    assert len(result.candidates) == 1
    assert len(result.candidates[0]["evidence"]) == 1  # type: ignore[arg-type]


def test_fuzzy_match_mode_reuses_bounded_search_and_marks_keyword_evidence() -> None:
    page = _page(("alpah", 40, 50, 120, 70))
    result = select_receipt_instances(
        page,
        _instances((0, 0, 600, 300)),
        _search_options(["alpha"]),
        match_mode="fuzzy",
    )

    assert len(result.matches) == 1
    assert result.matches[0].query_id == "include-0"
    assert [candidate["instance_id"] for candidate in result.candidates] == ["instance-1"]
    assert result.candidates[0]["evidence"] == [
        {
            "query_id": "include-0",
            "rect": {"x0": 40.0, "y0": 50.0, "x1": 120.0, "y1": 70.0},
        }
    ]


def test_low_confidence_include_is_kept_for_review() -> None:
    page = ParsedPage(
        1,
        600,
        900,
        "fee",
        (TextBlock(1, "fee", 40, 50, 120, 70, 0, confidence=0.1),),
    )
    result = select_receipt_instances(
        page,
        _instances((0, 0, 600, 300)),
        _search_options(["fee"]),
    )

    assert len(result.candidates) == 1
    assert result.candidates[0]["needs_review"] is True


def test_low_confidence_exclude_cannot_silently_remove_candidate() -> None:
    page = ParsedPage(
        1,
        600,
        900,
        "include\nprivate text",
        (
            TextBlock(1, "include", 40, 50, 120, 70, 0),
            TextBlock(1, "private text", 40, 100, 120, 120, 1, confidence=0.1),
        ),
    )
    result = select_receipt_instances(
        page,
        _instances((0, 0, 600, 300)),
        _search_options(["include"], exclude=["private text"]),
    )

    assert [candidate["instance_id"] for candidate in result.candidates] == ["instance-1"]
    assert result.candidates[0]["needs_review"] is True
    assert [diagnostic.code for diagnostic in result.diagnostics] == ["low_confidence_exclude"]
    assert "private text" not in repr(result.diagnostics[0])


def test_split_all_never_searches_and_marks_uncertain_slots_for_review(monkeypatch: pytest.MonkeyPatch) -> None:
    import engine.receipt_selection as selection_module

    monkeypatch.setattr(
        selection_module,
        "search_pages_multi",
        lambda *_args, **_kwargs: pytest.fail("split_all must not search"),
    )
    result = select_receipt_instances(
        _page(("ignored", 40, 50, 120, 70)),
        _instances((0, 0, 600, 300), (0, 300, 600, 600), (0, 600, 600, 900), uncertain={1}),
        _split_options(),
    )

    assert result.matches == ()
    assert result.diagnostics == ()
    assert [candidate["selection_basis"] for candidate in result.candidates] == [
        "occupied_slot",
        "occupied_slot",
        "occupied_slot",
    ]
    assert [candidate["needs_review"] for candidate in result.candidates] == [False, True, False]


def test_split_all_registers_one_page_and_enforces_page_budget() -> None:
    budget = SearchBudget(processed_pages=MAX_SEARCH_PAGES)
    with pytest.raises(SearchBudgetExceeded):
        select_receipt_instances(
            _page(("ignored", 40, 50, 120, 70)),
            _instances((0, 0, 600, 300)),
            _split_options(),
            budget=budget,
        )
    assert budget.processed_pages == MAX_SEARCH_PAGES


def test_split_all_enforces_text_budget_without_searching() -> None:
    page = ParsedPage(1, 600, 900, "x" * (MAX_PAGE_TEXT_CHARACTERS + 1), ())
    with pytest.raises(SearchBudgetExceeded):
        select_receipt_instances(
            page,
            _instances((0, 0, 600, 300)),
            _split_options(),
        )


def test_ambiguous_include_is_review_only_and_never_automatically_confirmed() -> None:
    page = _page(("fee", 40, 280, 120, 320))
    result = select_receipt_instances(
        page,
        _instances((0, 0, 600, 300), (0, 300, 600, 600)),
        _search_options(["fee"]),
    )

    assert [candidate["instance_id"] for candidate in result.candidates] == [
        "instance-1",
        "instance-2",
    ]
    assert all(candidate["needs_review"] is True for candidate in result.candidates)
    assert len(result.diagnostics) == 1
    diagnostic = result.diagnostics[0]
    assert isinstance(diagnostic, SelectionDiagnostic)
    assert diagnostic.code == "ambiguous_block"
    assert diagnostic.query_id == "include-0"
    assert diagnostic.instance_ids == ("instance-1", "instance-2")
    assert "fee" not in repr(diagnostic)


def test_ambiguous_exclude_does_not_remove_candidate_and_requires_review() -> None:
    page = _page(
        ("include", 40, 50, 120, 70),
        ("exclude", 40, 280, 120, 320),
    )
    result = select_receipt_instances(
        page,
        _instances((0, 0, 600, 300), (0, 300, 600, 600)),
        _search_options(["include"], exclude=["exclude"]),
    )

    assert [candidate["instance_id"] for candidate in result.candidates] == ["instance-1"]
    assert result.candidates[0]["needs_review"] is True
    assert result.diagnostics[0].code == "ambiguous_block"
    assert result.diagnostics[0].query_id == "exclude-0"


def test_selection_recomputes_against_adjusted_instance_geometry() -> None:
    page = _page(("fee", 40, 320, 120, 340))
    old_instances = _instances((0, 0, 600, 300), (0, 300, 600, 600))
    new_instances = _instances((0, 0, 600, 350), (0, 350, 600, 600))

    old_result = select_receipt_instances(page, old_instances, _search_options(["fee"]))
    new_result = select_receipt_instances(page, new_instances, _search_options(["fee"]))

    assert [candidate["instance_id"] for candidate in old_result.candidates] == ["instance-2"]
    assert [candidate["instance_id"] for candidate in new_result.candidates] == ["instance-1"]
    assert new_result.diagnostics == ()


def test_invalid_match_mode_and_instances_are_rejected() -> None:
    with pytest.raises(ReceiptLayoutError):
        select_receipt_instances(
            _page(("fee", 40, 50, 120, 70)),
            _instances((0, 0, 600, 300)),
            _search_options(["fee"]),
            match_mode="approximate",
        )
    invalid = _instances((0, 0, 600, 300))
    invalid[0]["occupancy"] = True
    with pytest.raises(ReceiptLayoutError):
        select_receipt_instances(_page(("fee", 40, 50, 120, 70)), invalid, _search_options(["fee"]))
