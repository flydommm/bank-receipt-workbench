"""Saved-rule reuse and concurrent rule changes against synthetic real PDFs."""
import pytest

import engine.receipt_grouping_api as api
from engine.batch_api import handle_batch_request
from engine.batch_store import BatchStore
from engine.receipt_field_rule_store import FieldRuleStore
from engine.receipt_grouping_store import GroupingStore
from test_receipt_grouping_integration import grouping_task
from test_receipt_field_rule_integration import begin, call, common, finish


def saved_rule_task(task):
    header, page, operation, _ = begin(task)
    operation = finish(task, header, operation)
    applied = call(task, "batch_receipt_field_rule_apply", **common(header), operation_id=operation["operation_id"], save_rule=True, rule_name="合成规则")
    undone = call(task, "batch_receipt_field_rule_undo", **common(applied["header"]), operation_id=operation["operation_id"])
    rule = call(task, "batch_receipt_field_rule_list", active_only=True)["items"][0]
    return undone["header"], page, rule


def test_automatic_reuse_retains_all_unconfigured_generic_account_bank_fields(grouping_task):
    task = grouping_task
    header, _, _ = saved_rule_task(task)
    with BatchStore(task[0]) as store:
        snapshot, raw, _ = api._trusted_inputs(store, header["job_id"], header["result_revision"], task[1])
    with GroupingStore(task[1], initialize=False) as grouping:
        rules = FieldRuleStore(grouping.connection).list()
    ids = {min(raw, key=lambda row: row["final_rect"]["y0"])["id"]}
    plain = api._extract_selected(snapshot, raw, ids)
    ruled = api._extract_selected(snapshot, raw, ids, rules)
    sid = next(iter(ids))
    for side, field in (("payer", "bank"), ("payee", "account"), ("payee", "bank")):
        assert ruled[sid]["parties"][side][field] == plain[sid]["parties"][side][field]
        assert ruled[sid]["parties"][side][field]["state"] == "present"


@pytest.mark.parametrize("change", ["deactivate", "add_competing_rule"])
def test_rule_set_change_during_read_rejects_publication_and_retry_uses_current_rules(grouping_task, monkeypatch, change):
    task = grouping_task
    header, page, rule = saved_rule_task(task)
    original = api._extract_selected

    def change_rules_after_read(*args, **kwargs):
        result = original(*args, **kwargs)
        with GroupingStore(task[1], initialize=False) as grouping:
            with grouping.transaction():
                rules = FieldRuleStore(grouping.connection)
                if change == "deactivate":
                    rules.deactivate(rule["rule_id"], rule["revision"])
                else:
                    selected = rules.get(rule["rule_id"])
                    rules.create(selected["definition"], name="另一套合成规则", operation_id="concurrent-new-rule")
        return result

    monkeypatch.setattr(api, "_extract_selected", change_rules_after_read)
    request = {"op": "batch_receipt_grouping_refresh", "database_path": str(task[0]), "grouping_database_path": str(task[1]),
               **common(header), "segment_ids": [item["binding"]["segment_id"] for item in page["items"]]}
    rejected = handle_batch_request(request)
    assert rejected["status"] == "error" and rejected["code"] == "grouping_conflict"
    actual = call(task, "batch_receipt_grouping_page", **common(header), offset=0, limit=200)
    assert actual["items"] == page["items"]
    monkeypatch.setattr(api, "_extract_selected", original)
    retried = handle_batch_request(request)
    assert retried["status"] == "ok"
    for item in retried["data"]["items"]:
        assert all(dependency["reader_id"] != "local-field-rule" for dependency in item["extracted"].get("reader_dependencies", []))
