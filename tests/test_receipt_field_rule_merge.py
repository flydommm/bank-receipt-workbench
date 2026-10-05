from copy import deepcopy

import pytest

from engine.receipt_field_candidates import empty_party
from engine.receipt_field_rule_reader import merge_rule_reading
from test_receipt_field_rule_store import definition
from test_receipt_grouping_store import field


def base_parties():
    party = empty_party()
    party.update(name=field("合成旧名称"), account=field("000111222333"), bank=field("合成开户行"))
    return {"counterparty_observed": party, "payer": deepcopy(party), "payee": empty_party(),
            "own_observed": None, "layout_signature": "a" * 64,
            "reader_dependencies": [{"reader_id": "direct_counterparty", "version": "1"}]}


def rule_parties(name, state):
    party = empty_party()
    party["name"] = field(name, state)
    return {"counterparty_observed": party, "payer": empty_party(), "payee": empty_party(), "own_observed": None,
            "reader_dependencies": [{"reader_id": "local-field-rule", "version": "1"}]}


@pytest.mark.parametrize("state", ["missing", "ambiguous"])
def test_automatic_rule_failure_keeps_successful_generic_field(state):
    base = base_parties()
    result = merge_rule_reading(base, rule_parties("截断候选" if state == "ambiguous" else "", state), definition(), automatic=True)
    assert result["counterparty_observed"] == base["counterparty_observed"]
    assert any(issue["code"] == "rule_incompatible" for issue in result["issues"])
    assert result["payer"] == base["payer"]
    assert len(result["reader_dependencies"]) == 2


def test_automatic_different_valid_names_remain_pending_with_both_candidates():
    result = merge_rule_reading(base_parties(), rule_parties("合成另一个名称", "present"), definition(), automatic=True)
    name = result["counterparty_observed"]["name"]
    assert name["state"] == "ambiguous"
    assert {candidate["value"] for candidate in name["candidates"]} == {"合成旧名称", "合成另一个名称"}
    assert any(issue["code"] == "conflicting_field" for issue in result["issues"])


def test_explicit_trial_only_replaces_configured_name_and_keeps_account_bank_roles():
    base = base_parties()
    result = merge_rule_reading(base, rule_parties("合成新名称", "present"), definition(), automatic=False)
    assert result["counterparty_observed"]["name"]["value"] == "合成新名称"
    for key in ("account", "bank"):
        assert result["counterparty_observed"][key] == base["counterparty_observed"][key]
    assert result["payer"] == base["payer"]
    assert result["layout_signature"] == base["layout_signature"]
    assert base["counterparty_observed"]["name"]["value"] == "合成旧名称"


def test_blank_conflicts_with_a_different_automatic_present_value():
    result = merge_rule_reading(base_parties(), rule_parties("", "blank"), definition(), automatic=True)
    assert result["counterparty_observed"]["name"]["state"] == "ambiguous"
