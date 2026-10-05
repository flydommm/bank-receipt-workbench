from __future__ import annotations

import copy
from pathlib import Path
import sqlite3

import pytest

from engine.export_scope import ExportScopeError, _digest, validate_scope_request
from engine import export_publish
from engine.receipt_grouped_export import (
    GROUPED_DETAIL_HEADERS,
    build_grouped_receipt_export_scope,
    build_grouped_receipt_output_plan,
)
from engine.receipt_grouping_store import GroupingStore, read_grouping_export_snapshot


SOURCE_SHA = "a" * 64
REVIEW_SHA = "b" * 64
ACCOUNT_SHA = "c" * 64


def _rect(x0: float, y0: float, x1: float, y1: float) -> dict[str, float]:
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _record(identifier: str, position: int, rect: dict[str, float], *, excluded: bool = False) -> dict:
    original = {
        "id": identifier,
        "source_key": "source-a",
        "source_page": 1,
        "instance_id": identifier,
        "slot_id": f"slot-{position}",
        "position_index": position,
        "page_geometry": {"width_pt": 100.0, "height_pt": 100.0},
        "candidate_rect": copy.deepcopy(rect),
    }
    return {
        "record_revision": 1,
        "source_path": "D:/synthetic/source-a.pdf",
        "source_sha256": SOURCE_SHA,
        "original": original,
        "final_rect": copy.deepcopy(rect),
        "crop_mode": "candidate",
        "review_status": "excluded" if excluded else "confirmed",
    }


def _item(identifier: str, route: str, group_id: str | None, group_name: str,
          *, own_status: str = "confirmed", extraction_state: str = "ready") -> dict:
    group = None if group_id is None else {
        "group_id": group_id,
        "kind": "counterparty_pending" if route == "counterparty_pending" else "named",
        "display_name": group_name,
    }
    return {
        "binding": {
            "segment_id": identifier,
            "source_key": "source-a",
            "source_sha256": SOURCE_SHA,
            "source_page": 1,
            "position_index": {"seg-a": 1, "seg-b": 2, "seg-c": 3, "seg-x": 4}[identifier],
            "slot_id": "slot-" + str({"seg-a": 1, "seg-b": 2, "seg-c": 3, "seg-x": 4}[identifier]),
            "instance_id": identifier,
            "review_record_revision": 1,
            "final_rect": copy.deepcopy({
                "seg-a": _rect(0, 0, 45, 100),
                "seg-b": _rect(0, 0, 45, 100),
                "seg-c": _rect(55, 0, 100, 100),
                "seg-x": _rect(45, 0, 55, 100),
            }[identifier]),
        },
        "extraction_state": extraction_state,
        "extracted": {
            "payer": {"name": {"raw": "本公司", "value": "本公司", "state": "present"}},
            "payee": {"name": {"raw": group_name, "value": group_name, "state": "present"}},
        },
        "own_decision": {
            "status": own_status,
            "method": "account_match",
            "side": "payer",
            "source_bank_status": "matched",
        },
        "route": route,
        "group": group,
        "field_overrides": [],
        "basis_fingerprint": "basis-1",
        "warnings": [],
    }


def _base_scope(*, include_excluded: bool = False) -> dict:
    records = [
        _record("seg-a", 1, _rect(0, 0, 45, 100)),
        _record("seg-b", 2, _rect(0, 0, 45, 100)),
        _record("seg-c", 3, _rect(55, 0, 100, 100)),
    ]
    excluded = [_record("seg-x", 4, _rect(45, 0, 55, 100), excluded=True)] if include_excluded else []
    return {
        "schema": 2,
        "job_id": "job-grouped",
        "generation": 1,
        "result_revision": "result-1",
        "context_key": "context",
        "scope_kind": "all",
        "selected_segment_ids": [record["original"]["id"] for record in records],
        "expected_records": [{"id": record["original"]["id"], "record_revision": 1} for record in records],
        "source_fingerprint": SOURCE_SHA,
        "review_revision": REVIEW_SHA,
        "output_mode": "by_counterparty",
        "include_xlsx": True,
        "sources": [{
            "source_key": "source-a",
            "name": "来源回单.pdf",
            "source_path": "D:/synthetic/source-a.pdf",
            "source_sha256": SOURCE_SHA,
            "size_bytes": 100,
            "page_count": 1,
        }],
        "records": records,
        "excluded_records": excluded,
        "excluded": [],
        "excluded_digest": _digest([]),
        "evidence_by_id": {},
        "processing_options": {"processing_mode": "split_all"},
        "summary": {"total_segments": len(records) + len(excluded), "selected_count": len(records),
                    "selected_source_count": 1, "omitted_count": len(excluded),
                    "omitted_unresolved_count": 0, "excluded_count": len(excluded), "expected_pages": 2},
    }


def _grouping(*, include_pending: bool = False, own_status: str = "confirmed") -> dict:
    items = [
        _item("seg-a", "named", "group-alpha", "客户甲", own_status=own_status),
        _item("seg-b", "named", "group-alpha", "客户甲", own_status=own_status),
        _item("seg-c", "named", "group-beta", "客户乙", own_status=own_status),
    ]
    return {
        "header": {
            "grouping_revision": 7,
            "review_fingerprint": REVIEW_SHA,
            "own_account": {"fingerprint": ACCOUNT_SHA},
        },
        "items": items,
        "groups": [
            {"group_id": "group-alpha", "kind": "named", "display_name": "客户甲"},
            {"group_id": "group-beta", "kind": "named", "display_name": "客户乙"},
        ],
    }


def _request(*, include_pending: bool = False, revision: int = 7) -> dict:
    scope = _base_scope()
    return {
        "job_id": scope["job_id"],
        "result_revision": scope["result_revision"],
        "scope_kind": scope["scope_kind"],
        "selected_segment_ids": scope["selected_segment_ids"],
        "expected_records": scope["expected_records"],
        "output_mode": "by_counterparty",
        "include_xlsx": True,
        "expected_grouping_revision": revision,
        "expected_review_fingerprint": REVIEW_SHA,
        "own_account_fingerprint": ACCOUNT_SHA,
        "include_counterparty_pending": include_pending,
    }


def test_grouped_plan_merges_same_group_rect_and_maps_each_segment():
    scope = build_grouped_receipt_export_scope(_base_scope(), _request(), _grouping())
    plan = build_grouped_receipt_output_plan(scope, "2026-09-28T00:00:00Z")

    assert plan["schema"] == 3
    assert plan["merged_pages"] == 0
    assert plan["source_pages"] == 0
    assert plan["grouped_pages"] == 2
    assert [file["file_id"] for file in plan["files"]] == ["group:group-alpha", "group:group-beta"]
    assert plan["files"][0]["page_count"] == 1
    assert {row["segment_id"] for row in plan["mappings"]} == {"seg-a", "seg-b", "seg-c"}
    assert {row["output_page"] for row in plan["mappings"] if row["group_id"] == "group-alpha"} == {1}
    assert len(plan["detail_rows"]) == 3
    assert set(GROUPED_DETAIL_HEADERS).issubset(plan["detail_rows"][0])
    assert plan["detail_rows"][0]["处理去向"] == "按交易对手"


def test_grouped_plan_keeps_excluded_out_of_output_and_rejects_cross_group_overlap():
    scope = _base_scope(include_excluded=True)
    scope["summary"]["total_segments"] = 4
    grouping = _grouping()
    grouping["items"].append({**_item("seg-x", "excluded", None, ""), "group": None})
    built = build_grouped_receipt_export_scope(scope, _request(), grouping)
    plan = build_grouped_receipt_output_plan(built, "now")
    assert all("seg-x" not in row["segment_id"] for row in plan["mappings"])

    overlapping = _base_scope()
    overlapping["records"][2]["final_rect"] = _rect(40, 0, 70, 100)
    overlapping_grouping = _grouping()
    overlapping_grouping["items"][2]["binding"]["final_rect"] = _rect(40, 0, 70, 100)
    with pytest.raises(ExportScopeError, match="同页裁剪范围") as error:
        build_grouped_receipt_export_scope(overlapping, _request(), overlapping_grouping)
    assert error.value.code == "grouping_geometry_conflict"


def test_grouped_pending_requires_explicit_selection_but_own_pending_always_blocks():
    grouping = _grouping()
    grouping["items"][2] = _item("seg-c", "counterparty_pending", None, "待确认交易对手")
    with pytest.raises(ExportScopeError) as error:
        build_grouped_receipt_export_scope(_base_scope(), _request(), grouping)
    assert error.value.code == "grouping_incomplete"

    pending_request = _request(include_pending=True)
    pending_scope = build_grouped_receipt_export_scope(_base_scope(), pending_request, grouping)
    pending_plan = build_grouped_receipt_output_plan(pending_scope, "now")
    assert any(file["group_kind"] == "counterparty_pending" for file in pending_plan["files"])

    own_pending = _grouping(own_status="pending")
    with pytest.raises(ExportScopeError) as error:
        build_grouped_receipt_export_scope(_base_scope(), _request(), own_pending)
    assert error.value.code == "grouping_identity_pending"


def test_grouped_scope_rejects_stale_revision_and_unsafe_filename_collision():
    stale = _grouping()
    stale["header"]["grouping_revision"] = 8
    with pytest.raises(ExportScopeError) as error:
        build_grouped_receipt_export_scope(_base_scope(), _request(), stale)
    assert error.value.code == "grouping_stale"

    grouping = _grouping()
    grouping["groups"] = [
        {"group_id": "group-alpha", "kind": "named", "display_name": "CON"},
        {"group_id": "group-beta", "kind": "named", "display_name": "con"},
    ]
    for item in grouping["items"]:
        item["group"]["display_name"] = "CON" if item["group"]["group_id"] == "group-alpha" else "con"
    plan = build_grouped_receipt_output_plan(
        build_grouped_receipt_export_scope(_base_scope(), _request(), grouping), "now"
    )
    names = [file["name"] for file in plan["files"]]
    assert len({name.casefold() for name in names}) == 2
    assert all(name.lower().endswith(".pdf") and not name.lower().startswith("con.pdf") for name in names)


@pytest.mark.parametrize("mode", ["by_counterparty", "by_counterparty_merged"])
def test_grouped_published_receipt_keeps_binding_and_group_page_totals(mode):
    scope = build_grouped_receipt_export_scope({**_base_scope(), "output_mode": mode}, {**_request(), "output_mode": mode}, _grouping())
    plan = build_grouped_receipt_output_plan(scope, "now")
    entry = {
        "intent_id": "00000000-0000-0000-0000-000000000001",
        "receipt_schema": 2,
        "scope": scope,
        "plan": plan,
    }
    attempt = {
        "files": [
            {
                "state": "created", "name": file["name"], "kind": "pdf",
                "page_count": file["page_count"],
                "identity": {"sha256": "a" * 64, "size": 10},
            }
            for file in plan["files"]
        ] + [
            {"state": "created", "name": "匹配索引.xlsx", "kind": "xlsx",
             "identity": {"sha256": "b" * 64, "size": 20}},
            {"state": "created", "name": "导出清单.json", "kind": "json",
             "identity": {"sha256": "d" * 64, "size": 30}},
        ],
    }
    receipt = export_publish._receipt(entry, attempt, Path("D:/synthetic/export"))
    entry["receipt"] = receipt
    checked = export_publish._validated_receipt(entry)
    assert checked["receipt_schema"] == 2
    assert checked["grouped_pages"] == 2
    assert checked["merged_pages"] == checked["source_pages"] == 0
    if mode == "by_counterparty":
        assert {file["group_id"] for file in checked["files"] if file["kind"] == "pdf"} == {"group-alpha", "group-beta"}
    else:
        pdfs = [file for file in checked["files"] if file["kind"] == "pdf"]
        assert len(pdfs) == 1 and "group_id" not in pdfs[0]
        assert checked["output_mode"] == mode
        compact = {key: value for key, value in entry.items() if key not in {"scope", "plan"}}
        assert export_publish._validated_receipt(compact) == checked
        corrupted = copy.deepcopy(compact)
        corrupted["receipt"].pop("output_mode")
        with pytest.raises(export_publish.ExportPublishError):
            export_publish._validated_receipt(corrupted)
        corrupted = copy.deepcopy(compact)
        corrupted["receipt"]["files"][0]["group_id"] = "fake-single-group"
        with pytest.raises(export_publish.ExportPublishError):
            export_publish._validated_receipt(corrupted)


def test_grouping_snapshot_reader_does_not_write_or_end_existing_transaction():
    connection = sqlite3.connect(":memory:", isolation_level=None)
    store = GroupingStore(connection, initialize=True)
    store.set_account(
        "job-read-only",
        expected_grouping_revision=0,
        account_selection={"kind": "inline", "account": {
            "company_name": "合成公司", "bank_name": "合成银行", "branch_name": "支行", "account_number": "0001"
        }},
    )
    before = connection.total_changes
    connection.execute("BEGIN IMMEDIATE")
    try:
        snapshot = read_grouping_export_snapshot(
            connection,
            "job-read-only",
            expected_grouping_revision=0,
            expected_review_fingerprint=None,
            require_complete=False,
        )
        assert snapshot["header"]["job_id"] == "job-read-only"
        assert connection.in_transaction
        assert connection.total_changes == before
    finally:
        connection.rollback()
        connection.close()


def test_grouped_merged_requires_grouping_bindings_and_index():
    request = {**_request(), "output_mode": "by_counterparty_merged"}
    assert validate_scope_request(request)["output_mode"] == "by_counterparty_merged"
    for field in ("expected_grouping_revision", "expected_review_fingerprint", "own_account_fingerprint", "include_counterparty_pending"):
        incomplete = {key: value for key, value in request.items() if key != field}
        with pytest.raises(ExportScopeError):
            validate_scope_request(incomplete)
    with pytest.raises(ExportScopeError):
        validate_scope_request({**request, "include_xlsx": False})


def test_grouped_merged_outputs_one_pdf_with_true_group_mapping_and_pending_last():
    scope = _base_scope()
    scope.update(output_mode="by_counterparty_merged", output_name="合成分组回单")
    # Three distinct clips, with a pending group first in source order.
    scope["records"][1]["final_rect"] = _rect(45, 0, 55, 100)
    scope["records"][1]["original"]["candidate_rect"] = _rect(45, 0, 55, 100)
    scope["summary"]["expected_pages"] = 3
    grouping = _grouping()
    grouping["items"][0] = _item("seg-a", "counterparty_pending", None, "对手待确认")
    grouping["items"][1]["binding"]["final_rect"] = _rect(45, 0, 55, 100)
    request = {**_request(include_pending=True), "output_mode": "by_counterparty_merged"}
    plan = build_grouped_receipt_output_plan(build_grouped_receipt_export_scope(scope, request, grouping), "now")
    assert len(plan["files"]) == 1
    file = plan["files"][0]
    assert file["name"] == "合成分组回单.pdf"
    assert file["file_id"] == "grouped-merged"
    assert "group_id" not in file
    assert plan["total_pages"] == plan["grouped_pages"] == file["page_count"] == 3
    assert plan["merged_pages"] == plan["source_pages"] == 0
    assert [page["group_id"] for page in file["pages"]] == ["group-alpha", "group-beta", "counterparty_pending"]
    mapped = {row["segment_id"]: row for row in plan["mappings"]}
    assert [(mapped[key]["output_page"], mapped[key]["group_name"]) for key in ("seg-a", "seg-b", "seg-c")] == [
        (3, "待确认交易对手"), (1, "客户甲"), (2, "客户乙")]
    assert {row["output_file"] for row in mapped.values()} == {file["name"]}


@pytest.mark.parametrize("mode", ["by_counterparty", "by_counterparty_merged"])
@pytest.mark.parametrize("code,label", [("electronic_tax_payment", "电子缴税付款凭证"),
    ("loan_settlement_notice", "贷款清算通知书"), ("loan_interest_notice", "贷款利息到期通知书"),
    ("other_special", "其他特殊单证")])
def test_special_group_names_are_chinese_in_pdf_and_excel_without_changing_group_id(mode, code, label):
    grouping = _grouping()
    special = {"group_id": "group-beta", "kind": "special", "display_name": code}
    grouping["groups"][1] = special
    grouping["items"][2].update(route="special", group=copy.deepcopy(special))
    scope = {**_base_scope(), "output_mode": mode}
    plan = build_grouped_receipt_output_plan(build_grouped_receipt_export_scope(scope, {**_request(), "output_mode": mode}, grouping), "now")
    special_row = next(row for row in plan["index_rows"] if row["group_id"] == "group-beta")
    assert special_row["group_name"] == label
    assert next(row for row in plan["detail_rows"] if row["归组类型"] == "特殊凭证")["归组名称"] == label
    if mode == "by_counterparty":
        assert plan["files"][1]["name"] == label + ".pdf"


def test_special_manual_display_name_remains_unchanged():
    from engine.receipt_group_labels import group_display_name
    assert group_display_name({"kind": "special", "display_name": "人工税款归档"}) == "人工税款归档"
    assert group_display_name({"kind": "named", "display_name": "electronic_tax_payment"}) == "electronic_tax_payment"


@pytest.mark.parametrize("state", ["pending", "stale", "failed"])
def test_pending_inclusion_does_not_bypass_unfinished_extraction(state):
    grouping = _grouping()
    grouping["items"][2] = _item("seg-c", "counterparty_pending", None, "待确认交易对手", extraction_state=state)
    with pytest.raises(ExportScopeError) as error:
        build_grouped_receipt_export_scope(_base_scope(), _request(include_pending=True), grouping)
    assert error.value.code == "grouping_stale"


def test_batch_profile_confirmed_counterparty_pending_can_export_with_explicit_inclusion():
    grouping = _grouping()
    grouping["items"][2] = _item("seg-c", "counterparty_pending", None, "待确认交易对手")
    grouping["items"][2]["own_decision"] = {"status": "confirmed", "method": "batch_profile", "side": None,
        "source_bank_status": "mismatch", "reasons": ["source_bank_mismatch"]}
    plan = build_grouped_receipt_output_plan(build_grouped_receipt_export_scope(_base_scope(), _request(include_pending=True), grouping), "now")
    assert plan["index_rows"][2]["own_method"] == "batch_profile"
    assert plan["index_rows"][2]["route"] == "counterparty_pending"
