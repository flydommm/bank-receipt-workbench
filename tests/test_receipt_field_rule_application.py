"""Rule trials with synthetic store data; no business PDFs or outside services."""
from copy import deepcopy
import json
from time import perf_counter

import pytest

from engine.receipt_field_rule_application import FieldRuleApplication
from engine.receipt_field_rule_models import FieldRuleError
from engine.receipt_grouping_models import GroupingConflict, GroupingValidationError
from test_receipt_grouping_store import configured_store, field, prepare, receipt
from test_receipt_field_rule_store import definition


@pytest.fixture
def setup(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        yield store, pdf
    finally:
        store.close()


def begin(store, pdf, count=2, *, rows=None, include_resolved=False):
    rows = rows if rows is not None else [receipt(pdf, index + 1, counterparty="") for index in range(count)]
    prepare(store, pdf, rows)
    application = FieldRuleApplication(store)
    public = application.prepare(store.header("job-1"), definition(), include_resolved)
    return application, application.get("job-1", public["operation_id"])


def formal_snapshot(store):
    return {table: [tuple(row) for row in store.connection.execute(f"SELECT * FROM {table} ORDER BY rowid")]
            for table in ("receipt_grouping_items", "receipt_grouping_groups", "receipt_grouping_tasks", "receipt_grouping_history")}


def readings_for(rows, *, name="合成修正对方", extra=None):
    results = {}
    for row in rows:
        before = json.loads(row["before_json"])
        parties = deepcopy(before["extracted"])
        parties["payee"]["name"] = field(name)
        parties["reader_dependencies"] = [{"reader_id": "local-field-rule", "version": "1"}]
        raw = {"parties": parties, "extraction_state": "ready", "field_rule_basis": {"version": 1, "definition_digest": "a" * 64}}
        raw.update(extra or {})
        results[row["segment_id"]] = {"matched": True, "raw": raw}
    return results


def finish(application, operation, *, name="合成修正对方"):
    while operation["status"] == "preparing":
        rows = application.next_items(operation, operation["completed"], 50)
        application.finish_step(operation, rows, readings_for(rows, name=name))
        operation = application.get("job-1", operation["operation_id"])
    return operation


def test_trial_chunks_leave_formal_groups_unchanged_and_publish_once(setup):
    store, pdf = setup
    application, operation = begin(store, pdf, 101)
    original = formal_snapshot(store)
    first = application.next_items(operation, 0, 50)
    assert len(first) == 50
    partial = application.finish_step(operation, first, readings_for(first))
    assert partial["completed"] == 50
    assert formal_snapshot(store) == original
    operation = application.get("job-1", operation["operation_id"])
    assert application.next_items(operation, 0, 50) == []
    ready = finish(application, operation)
    assert formal_snapshot(store) == original
    revision = store.header("job-1")["grouping_revision"]
    result = application.apply(ready)
    assert result["header"]["grouping_revision"] == revision + 1
    assert result["header"]["counts"]["assigned"] == 101
    assert result["header"]["status"] == "ready"
    applied = formal_snapshot(store)
    retry = application.apply(ready)
    assert retry["header"]["grouping_revision"] == revision + 1
    assert formal_snapshot(store) == applied


def test_cancel_during_computation_and_ready_does_not_publish(setup):
    store, pdf = setup
    application, operation = begin(store, pdf, 75)
    original = formal_snapshot(store)
    rows = application.next_items(operation, 0, 50)
    application.finish_step(operation, rows, readings_for(rows))
    assert application.cancel(operation)["status"] == "cancelled"
    assert formal_snapshot(store) == original
    with pytest.raises(GroupingConflict):
        application.apply(operation)
    public = application.prepare(store.header("job-1"), definition())
    ready = finish(application, application.get("job-1", public["operation_id"]))
    assert application.cancel(ready)["status"] == "cancelled"
    assert formal_snapshot(store) == original


def test_manual_excluded_special_and_resolved_results_are_preserved(setup):
    store, pdf = setup
    rows = [receipt(pdf, 1, counterparty=""), receipt(pdf, 2), receipt(pdf, 3, counterparty=""),
            receipt(pdf, 4, counterparty=""), receipt(pdf, 5, counterparty="")]
    rows[3]["review_status"] = "excluded"
    rows[4].update(document_type="electronic_tax_payment", special_confirmed=True)
    prepared = prepare(store, pdf, rows)
    third = next(row for row in prepared["items"] if row["binding"]["segment_id"] == "segment-3")
    store.save("job-1", result_revision="result-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
               expected_review_fingerprint="review-1", edits=[{"segment_id": "segment-3", "expected_basis_fingerprint": third["basis_fingerprint"],
               "field_overrides": [{"side": "payee", "field": "name", "value": "人工确定公司", "state": "present", "reason": "合成核对"}]}], group_edits=[])
    application = FieldRuleApplication(store)
    before = {row["binding"]["segment_id"]: row for row in store._load_items(store.connection, "job-1")}
    public = application.prepare(store.header("job-1"), definition())
    assert public["total"] == 1
    application.apply(finish(application, application.get("job-1", public["operation_id"])))
    after = {row["binding"]["segment_id"]: row for row in store._load_items(store.connection, "job-1")}
    assert all(before[key] == after[key] for key in ("segment-2", "segment-3", "segment-4", "segment-5"))
    # Explicitly rereading successful items still does not override human data.
    public = application.prepare(store.header("job-1"), definition(), include_resolved=True)
    ready = finish(application, application.get("job-1", public["operation_id"]), name="另一批量结果")
    assert application.public(ready)["skipped"] == 1
    application.apply(ready)
    current = {row["binding"]["segment_id"]: row for row in store._load_items(store.connection, "job-1")}
    assert current["segment-3"] == before["segment-3"]


@pytest.mark.parametrize("column,value", [("review_fingerprint", "other-review"), ("result_revision", "other-result"),
                                         ("grouping_revision", 19), ("basis_fingerprint", "changed-source-basis"),
                                         ("own_account_fingerprint", "changed-own-account")])
def test_version_and_source_basis_changes_reject_pending_trial(setup, column, value):
    store, pdf = setup
    application, operation = begin(store, pdf)
    ready = finish(application, operation)
    store.connection.execute(f"UPDATE receipt_grouping_tasks SET {column}=? WHERE job_id='job-1'", (value,))
    store.connection.commit()
    before = formal_snapshot(store)
    with pytest.raises(GroupingConflict):
        application.apply(ready)
    assert formal_snapshot(store) == before


def test_apply_retry_cannot_change_rule_save_intent(setup):
    store, pdf = setup
    application, operation = begin(store, pdf)
    ready = finish(application, operation)
    result = application.apply(ready, save_rule=True, rule_name="合成规则")
    assert result["operation"]["rule_id"]
    assert application.apply(ready, save_rule=True, rule_name="合成规则")["operation"]["rule_id"] == result["operation"]["rule_id"]
    with pytest.raises(GroupingConflict):
        application.apply(ready, save_rule=False)
    with pytest.raises(GroupingConflict):
        application.apply(ready, save_rule=True, rule_name="不同名称")


def test_undo_restores_fields_and_cannot_overwrite_later_edits(setup):
    store, pdf = setup
    application, operation = begin(store, pdf)
    before = store._load_items(store.connection, "job-1")
    ready = finish(application, operation)
    application.apply(ready)
    undone = application.undo(ready)
    assert undone["operation"]["status"] == "undone"
    assert store._load_items(store.connection, "job-1") == before
    snapshot = formal_snapshot(store)
    application.undo(ready)
    assert formal_snapshot(store) == snapshot
    next_op = application.prepare(store.header("job-1"), definition())
    ready = finish(application, application.get("job-1", next_op["operation_id"]))
    applied = application.apply(ready)
    item = store._load_items(store.connection, "job-1")[0]
    store.save("job-1", result_revision="result-1", expected_grouping_revision=applied["header"]["grouping_revision"], expected_review_fingerprint="review-1",
               edits=[{"segment_id": item["binding"]["segment_id"], "expected_basis_fingerprint": item["basis_fingerprint"],
                       "field_overrides": [{"side": "payee", "field": "name", "value": "后续人工名称", "state": "present", "reason": "再次核对"}]}], group_edits=[])
    snapshot = formal_snapshot(store)
    with pytest.raises(GroupingConflict):
        application.undo(ready)
    assert formal_snapshot(store) == snapshot


@pytest.mark.parametrize("extra", [{"final_rect": {"x0": 0, "y0": 0, "x1": 5, "y1": 5}},
                                  {"review_status": "excluded"}, {"source_sha256": "f" * 64},
                                  {"document_type": "electronic_tax_payment"}])
def test_reading_cannot_change_source_crop_exclusion_or_special_type(setup, extra):
    store, pdf = setup
    application, operation = begin(store, pdf)
    rows = application.next_items(operation, 0, 50)
    before = formal_snapshot(store)
    with pytest.raises(GroupingValidationError):
        application.finish_step(operation, rows, readings_for(rows, extra=extra))
    assert formal_snapshot(store) == before
    assert application.get("job-1", operation["operation_id"])["completed"] == 0


def test_failure_to_save_rule_does_not_half_publish_results(setup):
    store, pdf = setup
    application, operation = begin(store, pdf)
    ready = finish(application, operation)
    original = formal_snapshot(store)
    with pytest.raises(FieldRuleError):
        application.apply(ready, save_rule=True, rule_name="")
    assert formal_snapshot(store) == original
    assert application.get("job-1", operation["operation_id"])["status"] == "ready"


def test_mid_publish_failure_rolls_back_items_history_and_rule_together(setup, monkeypatch):
    from engine.receipt_field_rule_store import FieldRuleStore
    store, pdf = setup
    application, operation = begin(store, pdf)
    ready = finish(application, operation)
    original = formal_snapshot(store)
    insert = store._insert_item
    calls = 0

    def fail_second(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("synthetic storage failure")
        return insert(*args, **kwargs)

    monkeypatch.setattr(store, "_insert_item", fail_second)
    with pytest.raises(RuntimeError, match="synthetic"):
        application.apply(ready, save_rule=True, rule_name="合成规则")
    assert formal_snapshot(store) == original
    assert FieldRuleStore(store.connection).list() == []
    assert application.get("job-1", operation["operation_id"])["status"] == "ready"


def test_step_cannot_skip_or_reorder_pending_segments(setup):
    store, pdf = setup
    application, operation = begin(store, pdf, 3)
    rows = application.next_items(operation, 0, 50)
    with pytest.raises(GroupingValidationError):
        application.finish_step(operation, rows[1:], readings_for(rows[1:]))
    assert application.get("job-1", operation["operation_id"])["completed"] == 0


def test_2000_fragments_use_linear_history_and_one_publish(setup):
    store, pdf = setup
    application, operation = begin(store, pdf, 2000)
    original_revision = store.header("job-1")["grouping_revision"]
    history_before = store.connection.execute("SELECT COUNT(*) FROM receipt_grouping_history").fetchone()[0]
    started = perf_counter()
    ready = finish(application, operation)
    compute_seconds = perf_counter() - started
    assert store.header("job-1")["grouping_revision"] == original_revision
    assert store.connection.execute("SELECT COUNT(*) FROM receipt_grouping_history").fetchone()[0] == history_before
    started = perf_counter()
    application.apply(ready)
    publish_seconds = perf_counter() - started
    assert store.header("job-1")["grouping_revision"] == original_revision + 1
    assert store.connection.execute("SELECT COUNT(*) FROM receipt_grouping_history").fetchone()[0] - history_before == 2000
    assert store.connection.execute("SELECT COUNT(*) FROM receipt_field_rule_operation_items").fetchone()[0] == 2000
    # Loose regression ceiling, not a promise about every customer's machine.
    assert compute_seconds < 30 and publish_seconds < 15
    print(f"synthetic 2000: compute={compute_seconds:.3f}s publish={publish_seconds:.3f}s history=2000")
