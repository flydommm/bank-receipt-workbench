from copy import deepcopy

import pytest

from engine.receipt_field_rule_models import FieldRuleError, validate_fields, validate_rule


def definition():
    label = {"kind": "counterparty.name", "rect": {"x0": .05, "y0": .1, "x1": .24, "y1": .16}}
    return {"schema_version": 1, "bank_name": "合成银行", "mode": "direct", "batch_only": False, "aspect_ratio": 2.,
            "layout_signature": {"version": "field-layout-v1", "fingerprint": "a" * 64, "reliable": True, "labels": [label]},
            "fields": [{"role": "counterparty", "field": "name", "rect": {"x0": .25, "y0": .1, "x1": .8, "y1": .16}, "anchor": label}]}


def test_rule_keeps_only_declarative_keys():
    value = definition()
    assert validate_rule(value) == value
    value["source_path"] = "private.pdf"
    with pytest.raises(FieldRuleError):
        validate_rule(value)


@pytest.mark.parametrize("key", ["raw", "value", "image", "script", "regex", "company_name"])
def test_rule_rejects_business_values_and_executable_fields(key):
    value = definition()
    value["fields"][0][key] = "should-not-be-stored"
    with pytest.raises(FieldRuleError):
        validate_rule(value)


@pytest.mark.parametrize("coordinate", [-.1, 1.1, float("nan"), float("inf"), True])
def test_region_must_be_finite_inside_fragment(coordinate):
    value = definition()
    value["fields"][0]["rect"]["x0"] = coordinate
    with pytest.raises(FieldRuleError):
        validate_rule(value)


def test_missing_name_wrong_role_and_overlap_rejected():
    base = definition()["fields"][0]
    row = {key: item for key, item in base.items() if key != "anchor"}
    with pytest.raises(FieldRuleError):
        validate_fields([{**row, "field": "account"}], "direct")
    with pytest.raises(FieldRuleError):
        validate_fields([row], "sides")
    with pytest.raises(FieldRuleError):
        validate_fields([row, {**row, "field": "bank"}], "direct")


def test_anchor_must_come_from_compiled_signature():
    value = definition()
    value["fields"][0]["anchor"] = deepcopy(value["fields"][0]["anchor"])
    value["fields"][0]["anchor"]["rect"]["x0"] = .01
    with pytest.raises(FieldRuleError):
        validate_rule(value)


def test_no_anchor_rule_only_allowed_with_batch_only_scope():
    value = definition()
    value["fields"][0]["anchor"] = None
    with pytest.raises(FieldRuleError):
        validate_rule(value)
    value["batch_only"] = True
    assert validate_rule(value)["batch_only"]
