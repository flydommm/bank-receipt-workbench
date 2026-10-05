import sqlite3

import pytest

from engine.receipt_field_rule_models import FieldRuleConflict, FieldRuleError
from engine.receipt_field_rule_store import FieldRuleStore


def definition():
    label = {"kind": "counterparty.name", "rect": {"x0": .05, "y0": .1, "x1": .24, "y1": .16}}
    return {"schema_version": 1, "bank_name": "合成银行", "mode": "direct", "batch_only": False, "aspect_ratio": 2.,
            "layout_signature": {"version": "field-layout-v1", "fingerprint": "a" * 64, "reliable": True, "labels": [label]},
            "fields": [{"role": "counterparty", "field": "name", "rect": {"x0": .25, "y0": .1, "x1": .8, "y1": .16}, "anchor": label}]}


@pytest.fixture
def store():
    connection = sqlite3.connect(":memory:")
    try:
        connection.execute("PRAGMA user_version=73")
        connection.execute("CREATE TABLE review_sentinel (value TEXT)")
        connection.execute("INSERT INTO review_sentinel VALUES ('unchanged')")
        connection.commit()
        yield FieldRuleStore(connection)
    finally:
        connection.close()


def test_create_is_idempotent_and_does_not_touch_review_or_global_schema(store):
    first = store.create(definition(), name="合成普通回单", operation_id="create-1")
    again = store.create(definition(), name="合成普通回单", operation_id="create-1")
    assert first == again
    assert len(store.list()) == 1
    assert store.connection.execute("PRAGMA user_version").fetchone()[0] == 73
    assert store.connection.execute("SELECT value FROM review_sentinel").fetchone()[0] == "unchanged"
    with pytest.raises(FieldRuleConflict):
        store.create(definition(), name="不同请求", operation_id="create-1")


def test_version_update_is_immutable_and_deactivate_has_compare_and_swap(store):
    first = store.create(definition(), name="规则", operation_id="create-1")
    changed = definition()
    changed["fields"][0]["rect"]["x1"] = .85
    second = store.create(changed, name="规则新版", operation_id="update-1", update_rule_id=first["rule_id"], expected_version=1)
    assert second["series_id"] == first["series_id"]
    assert second["version"] == 2
    assert store.get(first["rule_id"])["definition"] == first["definition"]
    assert not store.get(first["rule_id"])["active"]
    assert [rule["rule_id"] for rule in store.list()] == [second["rule_id"]]
    with pytest.raises(FieldRuleConflict):
        store.deactivate(first["rule_id"], 1)
    with pytest.raises(FieldRuleConflict):
        store.deactivate(second["rule_id"], 1)
    assert not store.deactivate(second["rule_id"], 2)["active"]
    assert store.list() == []
    assert len(store.list(active_only=False)) == 2


def test_caller_transaction_can_rollback_rule_with_job_apply(store):
    store.connection.execute("BEGIN IMMEDIATE")
    saved = store.create(definition(), name="规则", operation_id="apply-1")
    assert store.get(saved["rule_id"])
    store.connection.rollback()
    assert store.get(saved["rule_id"]) is None


def test_batch_only_rule_cannot_be_persisted_for_reuse(store):
    value = definition()
    value["batch_only"] = True
    value["fields"][0]["anchor"] = None
    with pytest.raises(FieldRuleError):
        store.create(value, name="无标签", operation_id="create-1")


def test_different_bank_must_create_a_new_series(store):
    first = store.create(definition(), name="规则", operation_id="create-1")
    value = definition()
    value["bank_name"] = "另一合成银行"
    with pytest.raises(FieldRuleError):
        store.create(value, name="其他银行", operation_id="update-1", update_rule_id=first["rule_id"], expected_version=1)
    other = store.create(value, name="其他银行", operation_id="create-2")
    assert other["series_id"] != first["series_id"]
