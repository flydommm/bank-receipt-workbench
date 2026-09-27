from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path

import pytest

from engine.receipt_layout_models import (
    ReceiptLayoutError,
    can_include_target,
    changed_slot_ids,
    legacy_processing_mode,
    make_instance_id,
    parse_capabilities,
    parse_layout_definition,
    parse_page_geometry,
    parse_page_result,
    parse_processing_options,
    require_layout_capability,
    slot_rect,
)


FIXTURE = Path(__file__).parent / "fixtures" / "receipt_layout_v1.json"
OPTIONS_FIXTURE = Path(__file__).parent / "fixtures" / "receipt_layout_options_v1.json"


def _fixture() -> dict[str, object]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _options_fixture() -> dict[str, object]:
    return json.loads(OPTIONS_FIXTURE.read_text(encoding="utf-8"))


def test_fixture_valid_cases_are_accepted_by_python_contract() -> None:
    fixture = _fixture()
    for case in fixture["valid_cases"]:  # type: ignore[index]
        assert parse_page_result(case["value"]) == case["value"]  # type: ignore[index]


def test_fixture_invalid_cases_report_the_declared_error_code() -> None:
    fixture = _fixture()
    for case in fixture["invalid_cases"]:  # type: ignore[index]
        with pytest.raises(ReceiptLayoutError) as error:
            parse_page_result(case["value"])  # type: ignore[index]
        assert error.value.code == case["code"]  # type: ignore[index]


def test_geometry_preserves_nonzero_origin_and_rotated_physical_dimensions() -> None:
    fixture = _fixture()
    value = fixture["valid_cases"][5]["value"]["layout_definition"]["page_geometry"]  # type: ignore[index]
    assert parse_page_geometry(value)["pdf_box"]["x0"] == -10  # type: ignore[index]
    assert parse_page_geometry(value)["rotation"] == 90  # type: ignore[index]


def test_layout_slots_have_absolute_rects_and_instance_ids_use_slot_identity() -> None:
    fixture = _fixture()
    page_result = fixture["valid_cases"][0]["value"]  # type: ignore[index]
    layout = parse_layout_definition(page_result["layout_definition"])  # type: ignore[index]
    slot = layout["slots"][1]  # type: ignore[index]
    assert slot_rect(layout, slot) == {"x0": 0, "y0": 300, "x1": 600, "y1": 600}  # type: ignore[arg-type]
    assert make_instance_id(page_result["source_sha256"], 1, layout, "slot-2") == (  # type: ignore[index]
        "receipt-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1:synthetic-three:1:slot-2"
    )


def test_split_all_requires_candidates_for_uncertain_instances_but_manual_slot_can_confirm() -> None:
    fixture = _fixture()
    uncertain = deepcopy(fixture["valid_cases"][3]["value"])  # type: ignore[index]
    uncertain["candidates"] = uncertain["candidates"][:-1]  # type: ignore[index]
    with pytest.raises(ReceiptLayoutError) as error:
        parse_page_result(uncertain)
    assert error.value.code == "invalid_selection"

    manual = fixture["valid_cases"][4]["value"]  # type: ignore[index]
    result = parse_page_result(manual)
    assert result["candidates"][-1]["selection_basis"] == "manual_slot"  # type: ignore[index]


def test_processing_options_are_strict_and_normalized_for_search() -> None:
    assert parse_processing_options({"processing_mode": "split_all", "criteria": None}) == {
        "processing_mode": "split_all",
        "criteria": None,
    }
    assert parse_processing_options({
        "processing_mode": "search",
        "criteria": {"include": [" 手续费 ", "手续费"], "includeMode": "any", "exclude": []},
    }) == {
        "processing_mode": "search",
        "criteria": {"include": ["手续费"], "includeMode": "any", "exclude": []},
    }
    with pytest.raises(ReceiptLayoutError) as error:
        parse_processing_options({
            "processing_mode": "split_all",
            "criteria": {"include": ["stale"], "includeMode": "all", "exclude": []},
        })
    assert error.value.code == "invalid_processing"


def test_processing_options_fixture_cases_match_the_cross_language_contract() -> None:
    fixture = _options_fixture()
    for case in fixture["options_valid"]:  # type: ignore[index]
        assert parse_processing_options(case["input"]) == case["output"]  # type: ignore[index]
    for case in fixture["options_invalid"]:  # type: ignore[index]
        with pytest.raises(ReceiptLayoutError) as error:
            parse_processing_options(case["input"])  # type: ignore[index]
        assert error.value.code == case["code"]  # type: ignore[index]


def test_capabilities_fixture_cases_match_the_cross_language_contract() -> None:
    fixture = _options_fixture()
    for case in fixture["capabilities_valid"]:  # type: ignore[index]
        assert parse_capabilities(case["input"]) == case["input"]  # type: ignore[index]
    for case in fixture["capabilities_invalid"]:  # type: ignore[index]
        with pytest.raises(ReceiptLayoutError) as error:
            parse_capabilities(case["input"])  # type: ignore[index]
        assert error.value.code == case["code"]  # type: ignore[index]


def test_capability_handshake_requires_both_endpoints_to_advertise_mode() -> None:
    capabilities = {
        "contract_version": 1,
        "processing_modes": ["search", "split_all"],
        "layout_schema_versions": [1],
    }
    assert parse_capabilities(capabilities) == capabilities
    require_layout_capability(capabilities, capabilities, "split_all")
    search_only = {**capabilities, "processing_modes": ["search"]}
    for host, engine in ((None, capabilities), (capabilities, None),
                         (search_only, capabilities), (capabilities, search_only)):
        with pytest.raises(ReceiptLayoutError):
            require_layout_capability(host, engine, "split_all")


def test_changed_slots_expand_for_shared_changes_but_not_an_independent_top_change() -> None:
    fixture = _fixture()
    before = parse_layout_definition(fixture["valid_cases"][0]["value"]["layout_definition"])  # type: ignore[index]
    after = deepcopy(before)
    before["uniform_height"] = False  # type: ignore[index]
    after["uniform_height"] = False  # type: ignore[index]
    after["slots"][1]["top_pt"] += 5  # type: ignore[index]
    after["slots"][1]["height_pt"] -= 5  # type: ignore[index]
    assert changed_slot_ids(before, after) == ["slot-2"]

    after_shared = deepcopy(before)
    for slot in after_shared["slots"]:  # type: ignore[index]
        slot["height_pt"] -= 1  # type: ignore[index]
    assert changed_slot_ids(before, after_shared) == ["slot-1", "slot-2", "slot-3"]


def test_legacy_mode_defaults_only_when_omitted_and_target_override_is_explicit() -> None:
    assert legacy_processing_mode() == "search"
    assert legacy_processing_mode("split_all") == "split_all"
    assert can_include_target(False, False, False) is True
    assert can_include_target(True, False, False) is False
    assert can_include_target(True, True, True) is True
    with pytest.raises(ReceiptLayoutError):
        can_include_target(True, True, "false")
    with pytest.raises(ReceiptLayoutError):
        legacy_processing_mode(None)
