from __future__ import annotations

from copy import deepcopy
import json

import pytest

from engine.batch_models import (
    BatchModelError,
    BatchBudget,
    clone_json,
    normalize_criteria,
    validate_page_result,
)


def _selection(match: dict[str, object]) -> dict[str, object]:
    return {
        "match_rect": {"x0": match["x0"], "y0": match["y0"], "x1": match["x1"], "y1": match["y1"]},
        "rect": {"x0": 0.0, "y0": 0.0, "x1": 600.0, "y1": 800.0},
        "candidate_index": 0,
        "candidate_rect": {"x0": 0.0, "y0": 0.0, "x1": 600.0, "y1": 400.0},
        "confidence": 0.95,
        "slot": "top",
        "evidence": ["separator"],
        "needs_review": False,
        "snap_points": [0.0, 400.0, 800.0],
    }


def _page_result(*, matches: list[dict[str, object]] | None = None) -> dict[str, object]:
    actual_matches = matches if matches is not None else [
        {
            "page": 1,
            "matched_text": "手续费",
            "matched_field": "收款方",
            "confidence": 0.95,
            "needs_review": False,
            "x0": 10.0,
            "y0": 20.0,
            "x1": 100.0,
            "y1": 40.0,
            "query_id": "include-0",
            "role": "include",
        }
    ]
    return {
        "schema": 1,
        "page": 1,
        "page_width": 600.0,
        "page_height": 800.0,
        "matches": actual_matches,
        "analysis": None if not actual_matches else {
            "status": "ok",
            "page": 1,
            "page_width": 600.0,
            "page_height": 800.0,
            "page_fully_matched": False,
            "selections": [_selection(actual_matches[0])],
        },
    }


def test_normalize_criteria_matches_typescript_shape_and_deduplicates() -> None:
    assert normalize_criteria({
        "include": [" 手 续费 ", "手续费", "中文"],
        "includeMode": "any",
        "exclude": [" 内部 ", "内部"],
        "future_field": "ignored by the TS normalizer",
    }) == {
        "include": ["手 续费", "手续费", "中文"],
        "includeMode": "any",
        "exclude": ["内部"],
    }


def test_normalize_criteria_rejects_empty_and_bounded_inputs() -> None:
    with pytest.raises(BatchModelError):
        normalize_criteria({"include": [], "includeMode": "all", "exclude": []})
    with pytest.raises(BatchModelError):
        normalize_criteria({"include": ["x" * 513], "exclude": []})
    with pytest.raises(BatchModelError):
        normalize_criteria({"include": [str(index) for index in range(32)], "exclude": ["too-many"]})


def test_page_schema_and_page_number_require_exact_integer_types() -> None:
    value = _page_result()
    with pytest.raises(BatchModelError):
        validate_page_result({**value, "schema": 1.0})
    with pytest.raises(BatchModelError):
        validate_page_result({**value, "page": True})


def test_validate_page_result_deep_copies_and_requires_analysis_for_hits() -> None:
    value = _page_result()
    result = validate_page_result(value)
    assert result == value
    assert result is not value
    assert result["matches"] is not value["matches"]

    value["matches"][0]["matched_text"] = "changed"  # type: ignore[index]
    assert result["matches"][0]["matched_text"] == "手续费"  # type: ignore[index]

    empty = _page_result(matches=[])
    assert validate_page_result(empty)["analysis"] is None
    with pytest.raises(BatchModelError):
        validate_page_result({**empty, "analysis": {}})


@pytest.mark.parametrize(
    "mutator",
    [
        lambda value: value["matches"][0].update(source_path="C:/forbidden.pdf"),
        lambda value: value["analysis"]["selections"].clear(),
        lambda value: value["analysis"].update(page_width=601.0),
        lambda value: value["matches"][0].update(role="exclude"),
        lambda value: value.update(unexpected=True),
    ],
)
def test_validate_page_result_rejects_malformed_or_untrusted_fields(mutator) -> None:
    value = _page_result()
    mutator(value)
    with pytest.raises(BatchModelError):
        validate_page_result(value)


def test_repeated_strings_are_rejected_before_serialization(monkeypatch) -> None:
    def forbidden(*_args, **_kwargs):
        pytest.fail("unbounded shared content reached JSON encoding")

    monkeypatch.setattr(json, "dumps", forbidden)
    with pytest.raises(BatchModelError, match="too large"):
        clone_json(["x" * 1024] * 1024, max_bytes=64)
    with pytest.raises(BatchModelError, match="too large"):
        clone_json({"long-key" * 128: 0}, max_bytes=64)


@pytest.mark.parametrize("value", [
    {"税": [None, False, True, 1.5, -25, "a\nb\t\\\"\x01"]},
    [[], {}, "", 1e-7, -0.0],
])
def test_json_budget_matches_actual_utf8_and_escape_boundary(value) -> None:
    size = len(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    assert clone_json(value, max_bytes=size) == value
    with pytest.raises(BatchModelError, match="too large"):
        clone_json(value, max_bytes=size - 1)


@pytest.mark.parametrize("value", [True, 1.5, -1, 5001])
def test_budget_dataclass_cannot_erase_invalid_counter_types(value) -> None:
    with pytest.raises(BatchModelError):
        BatchBudget(processed_pages=value)
