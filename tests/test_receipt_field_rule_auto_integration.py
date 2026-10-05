"""Neutral-position rules through the actual batch command boundary."""
import json

import pymupdf
import pytest

from engine.batch_api import handle_batch_request
from engine.batch_store import BatchStore
from engine.receipt_field_rule_store import FieldRuleStore
from engine.receipt_grouping_api import _trusted_inputs
from engine.receipt_grouping_store import GroupingStore
from test_receipt_grouping_integration import grouping_task, call, prepare_and_page
from test_receipt_field_rule_integration import common, finish


def begin_auto(task, *, resolved=False, empty=False):
    header, page = prepare_and_page(task)
    if resolved:
        refreshed = call(task, "batch_receipt_grouping_refresh", **common(header),
                         segment_ids=[item["binding"]["segment_id"] for item in page["items"]])
        header = refreshed["header"]
        page = call(task, "batch_receipt_grouping_page", **common(header), offset=0, limit=200)
    with BatchStore(task[0]) as store:
        _, raw, _ = _trusted_inputs(store, header["job_id"], header["result_revision"], task[1])
    prototype = min(raw, key=lambda item: item["final_rect"]["y0"])
    crop = prototype["final_rect"]
    with pymupdf.open(task[3]) as document:
        box = next(rect for rect in document[0].search_for("合成供应商甲") if crop["y0"] <= rect.y0 and rect.y1 <= crop["y1"])
        region = {"x0": (box.x0 - .5 - crop["x0"]) / (crop["x1"] - crop["x0"]), "x1": .95,
                  "y0": (box.y0 - .5 - crop["y0"]) / (crop["y1"] - crop["y0"]),
                  "y1": (box.y1 + .5 - crop["y0"]) / (crop["y1"] - crop["y0"])}
    if empty:
        region["x0"] = .88
    operation = call(task, "batch_receipt_field_rule_prepare", **common(header), prototype_segment_id=prototype["id"],
                     mode="auto", fields=[{"role": "counterparty", "field": "name", "rect": region}], include_resolved=resolved)
    return header, page, operation


def test_auto_single_position_host_trial_apply_save_undo_and_automatic_reuse(grouping_task):
    task = grouping_task
    header, before, operation = begin_auto(task)
    operation = finish(task, header, operation)
    assert operation["changed"] == 3 and operation["unresolved"] == 0 and operation["can_save_rule"]
    applied = call(task, "batch_receipt_field_rule_apply", **common(header), operation_id=operation["operation_id"],
                   save_rule=True, rule_name="自动判断名称位置")
    after = call(task, "batch_receipt_grouping_page", **common(applied["header"]), offset=0, limit=200)
    assert {item["counterparty"]["name"]["value"] for item in after["items"]} == {"合成供应商甲", "合成供应商乙"}
    assert all(item["own_decision"]["side"] == "payer" for item in after["items"])
    with GroupingStore(task[1], initialize=False) as grouping:
        rule = FieldRuleStore(grouping.connection).list()[0]
    assert rule["definition"]["mode"] == "auto"
    serialized = json.dumps(rule["definition"], ensure_ascii=False)
    assert all(value not in serialized for value in ("合成本公司", "合成供应商甲", "合成供应商乙", "000012345678", str(task[3])))
    undone = call(task, "batch_receipt_field_rule_undo", **common(applied["header"]), operation_id=operation["operation_id"])
    restored = call(task, "batch_receipt_grouping_page", **common(undone["header"]), offset=0, limit=200)
    assert restored["items"] == before["items"]
    refreshed = call(task, "batch_receipt_grouping_refresh", **common(undone["header"]),
                     segment_ids=[item["binding"]["segment_id"] for item in restored["items"]])
    assert {item["counterparty"]["name"]["value"] for item in refreshed["items"]} == {"合成供应商甲", "合成供应商乙"}
    assert all({"reader_id": "local-field-rule", "version": "1"} in item["extracted"]["reader_dependencies"] for item in refreshed["items"])


def test_auto_unreadable_box_is_pending_even_when_old_counterparty_is_named(grouping_task):
    task = grouping_task
    header, before, operation = begin_auto(task, resolved=True, empty=True)
    assert all(item["route"] == "named" for item in before["items"])
    operation = finish(task, header, operation)
    assert operation["unresolved"] == operation["total"] == 3
    assert operation["changed"] == 0
    rejected = handle_batch_request({"op": "batch_receipt_field_rule_apply", "database_path": str(task[0]),
                                    "grouping_database_path": str(task[1]), **common(header), "operation_id": operation["operation_id"],
                                    "save_rule": True, "rule_name": "不可保存的试读"})
    assert rejected["status"] == "error"
    applied = call(task, "batch_receipt_field_rule_apply", **common(header), operation_id=operation["operation_id"],
                   save_rule=False, rule_name="")
    assert applied["header"]["grouping_revision"] == header["grouping_revision"]
    assert call(task, "batch_receipt_grouping_page", **common(applied["header"]), offset=0, limit=200)["items"] == before["items"]


def test_auto_include_resolved_preserves_manual_counterparty_correction(grouping_task):
    task = grouping_task
    header, page, trial = begin_auto(task, resolved=True)
    call(task, "batch_receipt_field_rule_cancel", job_id=header["job_id"], operation_id=trial["operation_id"])
    item = page["items"][0]
    saved = call(task, "batch_receipt_grouping_save", **common(header), group_edits=[], edits=[{
        "segment_id": item["binding"]["segment_id"], "expected_basis_fingerprint": item["basis_fingerprint"],
        "field_overrides": [{"side": "counterparty", "field": "name", "state": "present", "value": "人工确认的对手", "reason": "合成核对"}],
        "assignment": None,
    }])
    corrected = saved["items"][0]
    header, _, trial = begin_auto(task, resolved=True)
    trial = finish(task, header, trial)
    assert trial["skipped"] == 1
    applied = call(task, "batch_receipt_field_rule_apply", **common(header), operation_id=trial["operation_id"], save_rule=False, rule_name="")
    current = call(task, "batch_receipt_grouping_page", **common(applied["header"]), offset=0, limit=200)
    assert next(row for row in current["items"] if row["binding"]["segment_id"] == corrected["binding"]["segment_id"]) == corrected
