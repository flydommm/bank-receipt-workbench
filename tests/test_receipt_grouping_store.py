"""分组存储的合成数据回归，不读取真实回单。"""

from copy import deepcopy
import hashlib
import sqlite3

import pytest

from engine.receipt_grouping_models import GroupingConflict, GroupingError, GroupingSourceChanged, GroupingValidationError
from engine.receipt_grouping_store import GroupingStore, read_grouping_export_snapshot


ACCOUNT = {
    "company_name": "合成公司",
    "bank_name": "合成银行",
    "branch_name": "合成支行",
    "account_number": "000012345678",
}


def field(value: str = "", state: str | None = None):
    return {
        "raw": value,
        "value": value,
        "state": state or ("present" if value else "missing"),
        "evidence": [{"label": "合成字段", "rect": {"x0": 1, "y0": 1, "x1": 20, "y1": 10}}],
        "diagnostics": [],
    }


def receipt(path, index=1, *, counterparty="对手公司", counterparty_account="00009999", counterparty_bank="另一银行",
            counterparty_name_state=None, source_bank="合成银行", own_account="000012345678"):
    return {
        "segment_id": f"segment-{index}",
        "source_key": "synthetic.pdf",
        "source_path": str(path),
        "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "source_page": 1,
        "segment_no": index,
        "slot_id": f"slot-{index}",
        "final_rect": {"x0": 1, "y0": index * 20, "x1": 200, "y1": index * 20 + 15},
        "source_bank": {"value": source_bank, "state": "present" if source_bank else "unknown"},
        "parties": {
            "payer": {"name": field("合成公司"), "account": field(own_account), "bank": field("合成银行")},
            "payee": {"name": field(counterparty, counterparty_name_state), "account": field(counterparty_account), "bank": field(counterparty_bank)},
        },
        "review_status": "confirmed",
        "document_type": "ordinary",
    }


def configured_store(tmp_path):
    pdf = tmp_path / "synthetic.pdf"
    pdf.write_bytes(b"synthetic receipt bytes")
    store = GroupingStore(tmp_path / "grouping.sqlite3")
    saved = store.account_save(ACCOUNT, expected_account_revision=0, active=True)
    store.set_account(
        "job-1", expected_grouping_revision=0,
        account_selection={"kind": "saved", "account_id": saved["account_id"], "account_revision": 1},
    )
    return store, pdf


def prepare(store, pdf, rows, *, result="result-1"):
    return store.prepare(
        "job-1", result_revision=result, expected_grouping_revision=-1,
        authoritative=rows, source_manifest=[{"source_bank": "合成银行"}],
        source_bank="合成银行", review_fingerprint="review-1",
    )


def test_same_name_and_internal_accounts_merge_by_name(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        named = prepare(store, pdf, [
            receipt(pdf, 1, counterparty="同名对手", counterparty_account="00009999"),
            receipt(pdf, 2, counterparty="同名对手", counterparty_account="00008888", counterparty_bank="第三银行"),
        ])
        assert {item["route"] for item in named["items"]} == {"named"}
        assert named["items"][0]["group"]["group_id"] == named["items"][1]["group"]["group_id"]

        internal = prepare(store, pdf, [
            receipt(pdf, 1, counterparty="合成公司", counterparty_account="00009999", counterparty_bank="另一银行"),
            receipt(pdf, 2, counterparty="合成公司", counterparty_account="00008888", counterparty_bank="第三银行"),
        ])
        assert {item["route"] for item in internal["items"]} == {"internal"}
        assert internal["items"][0]["group"]["group_id"] == internal["items"][1]["group"]["group_id"]

        mixed = prepare(store, pdf, [
            receipt(pdf, 1, counterparty="", counterparty_name_state="blank"),
            receipt(pdf, 2, counterparty="", counterparty_name_state="missing"),
        ])
        assert mixed["items"][0]["route"] == "blank"
        assert mixed["items"][1]["route"] == "counterparty_pending"
        assert mixed["items"][1]["group"] is not None
    finally:
        store.close()


def test_excluded_unidentified_fragment_does_not_block_ready_export(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        excluded = receipt(pdf, 1, counterparty="", counterparty_name_state="missing")
        excluded["review_status"] = "excluded"
        prepared = prepare(store, pdf, [excluded, receipt(pdf, 2)])
        assert prepared["header"]["counts"]["excluded"] == 1
        assert prepared["header"]["counts"]["extraction_pending"] == 0
        assert prepared["header"]["counts"]["own_pending"] == 0
        snapshot = store.export_snapshot(
            "job-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
            expected_review_fingerprint="review-1", require_complete=True,
        )
        assert snapshot["exportable"] is True
    finally:
        store.close()


def test_save_recomputes_from_manual_values_and_null_restores_default(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        prepared = prepare(store, pdf, [receipt(pdf)])
        item = prepared["items"][0]
        changed = store.save(
            "job-1", result_revision="result-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
            expected_review_fingerprint="review-1", edits=[{
                "segment_id": item["binding"]["segment_id"],
                "expected_basis_fingerprint": item["basis_fingerprint"],
                "field_overrides": [{"side": "payee", "field": "name", "value": "", "state": "blank", "reason": "核对原件"}],
            }], group_edits=[],
        )
        changed_item = changed["items"][0]
        assert changed_item["route"] == "blank"
        assert changed_item["counterparty"]["name"]["raw"] == "对手公司"
        assert changed_item["extracted"]["payee"]["name"]["raw"] == "对手公司"

        restored = store.save(
            "job-1", result_revision="result-1", expected_grouping_revision=changed["header"]["grouping_revision"],
            expected_review_fingerprint="review-1", edits=[{
                "segment_id": item["binding"]["segment_id"],
                "expected_basis_fingerprint": changed_item["basis_fingerprint"],
                "field_overrides": None,
                "assignment": None,
            }], group_edits=[],
        )
        assert restored["items"][0]["route"] == "named"
        assert restored["items"][0]["field_overrides"] == []
        assert store.connection.execute("SELECT COUNT(*) FROM receipt_grouping_history").fetchone()[0] >= 2
        with pytest.raises(GroupingConflict):
            store.save(
                "job-1", result_revision="result-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
                expected_review_fingerprint="review-1", edits=[], group_edits=[],
            )
    finally:
        store.close()


def test_group_rename_is_reflected_in_items_and_export_definition(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        prepared = prepare(store, pdf, [receipt(pdf)])
        item = prepared["items"][0]
        group_id = item["group"]["group_id"]
        renamed = store.save(
            "job-1", result_revision="result-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
            expected_review_fingerprint="review-1", edits=[],
            group_edits=[{"action": "rename", "group_id": group_id, "display_name": "人工重命名组"}],
        )
        assert renamed["items"] == []
        snapshot = store.export_snapshot(
            "job-1", expected_grouping_revision=renamed["header"]["grouping_revision"],
            expected_review_fingerprint="review-1", require_complete=True,
        )
        group = next(value for value in snapshot["groups"] if value["group_id"] == group_id)
        member = next(value for value in snapshot["items"] if value["group"]["group_id"] == group_id)
        assert group["display_name"] == member["group"]["display_name"] == "人工重命名组"
    finally:
        store.close()


def test_single_party_counterparty_override_keeps_single_confirmation(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        one_sided = receipt(pdf)
        one_sided["source_bank"] = {"value": "", "state": "unknown"}
        one_sided["parties"] = {}
        prepared = prepare(store, pdf, [one_sided])
        item = prepared["items"][0]
        saved = store.save(
            "job-1", result_revision="result-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
            expected_review_fingerprint="review-1", edits=[{
                "segment_id": item["binding"]["segment_id"],
                "expected_basis_fingerprint": item["basis_fingerprint"],
                "own_confirmation": {"side": "single", "confirms_selected_account": True,
                                      "confirms_source_bank": True, "reason": "核对单方凭证"},
                "field_overrides": [{"side": "counterparty", "field": "name", "value": "", "state": "blank", "reason": "原件无对手名称"}],
            }], group_edits=[],
        )
        assert saved["items"][0]["route"] == "blank"
        assert saved["items"][0]["own_decision"]["side"] == "single"
    finally:
        store.close()


def test_unknown_source_bank_is_not_replaced_by_selected_account_bank_on_recompute(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        unknown = receipt(pdf)
        unknown["source_bank"] = {"value": "", "state": "unknown"}
        prepared = store.prepare(
            "job-1", result_revision="result-1", expected_grouping_revision=-1,
            authoritative=[unknown], source_manifest=[], source_bank="合成银行", review_fingerprint="review-1",
        )
        item = prepared["items"][0]
        assert item["route"] == "named"
        assert item["own_decision"]["method"] == "batch_profile"
        refreshed = store.refresh(
            "job-1", result_revision="result-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
            expected_review_fingerprint="review-1", segment_ids=[item["binding"]["segment_id"]],
            source_reader=lambda _path, _page, _item: {
                "parties": {}, "source_bank": {"value": "", "state": "unknown"},
                "extraction_state": "ready", "extractor_version": "receipt-parties-v1",
            },
        )
        item = refreshed["items"][0]
        assert item["extraction_state"] == "ready"
        assert item["route"] == "counterparty_pending"
        saved = store.save(
            "job-1", result_revision="result-1", expected_grouping_revision=refreshed["header"]["grouping_revision"],
            expected_review_fingerprint="review-1", edits=[{
                "segment_id": item["binding"]["segment_id"],
                "expected_basis_fingerprint": item["basis_fingerprint"],
                "field_overrides": [],
            }], group_edits=[],
        )
        assert saved["items"][0]["route"] == "counterparty_pending"
        assert saved["items"][0]["own_decision"]["source_bank_status"] == "unknown"
    finally:
        store.close()


def test_refresh_reextracts_and_rederives_only_when_reader_returns_data(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        missing = receipt(pdf, counterparty="", counterparty_name_state="missing")
        missing["parties"]["payer"]["account"] = field("", "missing")
        prepared = prepare(store, pdf, [missing])
        segment = prepared["items"][0]["binding"]["segment_id"]
        before = prepared["header"]["grouping_revision"]
        unchanged = store.refresh(
            "job-1", result_revision="result-1", expected_grouping_revision=before,
            expected_review_fingerprint="review-1", segment_ids=[segment], source_reader=None,
        )
        assert unchanged["header"]["grouping_revision"] == before

        refreshed = store.refresh(
            "job-1", result_revision="result-1", expected_grouping_revision=before,
            expected_review_fingerprint="review-1", segment_ids=[segment],
            source_reader=lambda _path, _page, _item: {
                "parties": receipt(pdf)["parties"],
                "source_bank": {"value": "合成银行", "state": "present"},
                "extractor_version": "receipt-parties-v1",
                "extraction_state": "ready",
            },
        )
        assert refreshed["header"]["grouping_revision"] == before + 1
        assert refreshed["items"][0]["route"] == "named"
        assert refreshed["items"][0]["own_decision"]["status"] == "confirmed"
    finally:
        store.close()


def test_refresh_rejects_changed_source_hash(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        prepared = prepare(store, pdf, [receipt(pdf)])
        pdf.write_bytes(b"changed synthetic bytes")
        with pytest.raises(GroupingSourceChanged):
            store.refresh(
                "job-1", result_revision="result-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
                expected_review_fingerprint="review-1", segment_ids=[prepared["items"][0]["binding"]["segment_id"]],
            )
    finally:
        store.close()


def test_rule_only_upgrade_invalidates_snapshot_but_keeps_extraction_and_manual_fields(tmp_path, monkeypatch):
    import engine.receipt_grouping_store as grouping_store_module

    store, pdf = configured_store(tmp_path)
    try:
        prepared = prepare(store, pdf, [receipt(pdf)])
        item = prepared["items"][0]
        saved = store.save(
            "job-1", result_revision="result-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
            expected_review_fingerprint="review-1", edits=[{
                "segment_id": item["binding"]["segment_id"],
                "expected_basis_fingerprint": item["basis_fingerprint"],
                "field_overrides": [{"side": "payee", "field": "name", "state": "present", "value": "人工核对名称", "reason": "版本回归"}],
            }], group_edits=[],
        )
        current_version = grouping_store_module.grouping_algorithm_version()
        monkeypatch.setattr(grouping_store_module, "grouping_algorithm_version", lambda: current_version + "-changed")

        for operation in ("page", "save", "export"):
            if operation == "page":
                with pytest.raises(GroupingConflict):
                    store.page("job-1", result_revision="result-1", expected_grouping_revision=saved["header"]["grouping_revision"],
                               expected_review_fingerprint="review-1", offset=0, limit=10)
            elif operation == "save":
                with pytest.raises(GroupingConflict):
                    store.save("job-1", result_revision="result-1", expected_grouping_revision=saved["header"]["grouping_revision"],
                               expected_review_fingerprint="review-1", edits=[], group_edits=[])
            else:
                with pytest.raises(GroupingConflict):
                    store.export_snapshot("job-1", expected_grouping_revision=saved["header"]["grouping_revision"],
                                          expected_review_fingerprint="review-1", require_complete=False)
        connection = sqlite3.connect(tmp_path / "grouping.sqlite3", isolation_level=None)
        try:
            connection.execute("BEGIN IMMEDIATE")
            with pytest.raises(GroupingConflict):
                read_grouping_export_snapshot(
                    connection, "job-1", expected_grouping_revision=saved["header"]["grouping_revision"],
                    expected_review_fingerprint="review-1", require_complete=False,
                )
            connection.rollback()
        finally:
            connection.close()

        refreshed_basis = receipt(pdf)
        refreshed_basis.pop("parties")
        reprovisioned = store.prepare(
            "job-1", result_revision="result-1", expected_grouping_revision=-1,
            authoritative=[refreshed_basis], source_manifest=[{"source_bank": "合成银行"}],
            source_bank="合成银行", review_fingerprint="review-1",
        )
        rebuilt = reprovisioned["items"][0]
        assert rebuilt["extraction_state"] == "ready"
        assert rebuilt["field_overrides"] == saved["items"][0]["field_overrides"]
        assert rebuilt["counterparty"]["name"]["value"] == "人工核对名称"
        assert rebuilt["own_decision"]["status"] == "confirmed"
    finally:
        store.close()


def test_switching_own_account_keeps_extracted_cache_but_invalidates_decision(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        prepared = prepare(store, pdf, [receipt(pdf)])
        before = store._load_items(store.connection, "job-1")[0]
        switched = store.set_account(
            "job-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
            account_selection={"kind": "inline", "account": {
                **ACCOUNT, "company_name": "另一公司", "account_number": "000099999999",
            }},
        )
        after = store._load_items(store.connection, "job-1")[0]
        assert switched["grouping_revision"] == prepared["header"]["grouping_revision"] + 1
        assert after["extracted"] == before["extracted"]
        assert after["extraction_fingerprint"] == before["extraction_fingerprint"]
        assert after["own_decision"]["status"] == "confirmed"
        assert after["own_decision"]["method"] == "batch_profile"
        assert after["route"] == "counterparty_pending"
        assert after["_manual"] == {}
    finally:
        store.close()


def test_read_export_snapshot_uses_existing_connection_without_schema_write(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        prepared = prepare(store, pdf, [receipt(pdf)])
        database = tmp_path / "grouping.sqlite3"
        connection = sqlite3.connect(database, isolation_level=None)
        try:
            connection.execute("BEGIN IMMEDIATE")
            before_changes = connection.total_changes
            snapshot = read_grouping_export_snapshot(
                connection, "job-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
                expected_review_fingerprint="review-1", require_complete=False,
            )
            assert snapshot["header"]["job_id"] == "job-1"
            assert connection.in_transaction
            assert connection.total_changes == before_changes
            connection.rollback()
        finally:
            connection.close()
    finally:
        store.close()


def test_save_rejects_more_than_200_edits_and_future_schema_is_not_downgraded(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        prepared = prepare(store, pdf, [receipt(pdf)])
        item = prepared["items"][0]
        edit = {"segment_id": item["binding"]["segment_id"], "expected_basis_fingerprint": item["basis_fingerprint"]}
        with pytest.raises(GroupingValidationError):
            store.save(
                "job-1", result_revision="result-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
                expected_review_fingerprint="review-1", edits=[edit] * 201, group_edits=[],
            )
    finally:
        store.close()

    future = tmp_path / "future.sqlite3"
    connection = sqlite3.connect(future, isolation_level=None)
    try:
        connection.execute("CREATE TABLE receipt_grouping_meta (schema_name TEXT PRIMARY KEY, schema_version INTEGER NOT NULL)")
        connection.execute("INSERT INTO receipt_grouping_meta(schema_name, schema_version) VALUES ('receipt_grouping', 99)")
    finally:
        connection.close()
    with pytest.raises(GroupingError):
        GroupingStore(future)


@pytest.mark.parametrize("legacy_basis", [False, True])
def test_extraction_upgrade_preserves_manual_corrections_and_unaffected_group(tmp_path, monkeypatch, legacy_basis):
    import json
    import engine.receipt_grouping_store as module
    store, pdf = configured_store(tmp_path)
    try:
        initial = prepare(store, pdf, [receipt(pdf)])
        item = initial["items"][0]
        override = {"side": "payee", "field": "name", "value": "人工核对对手", "state": "present", "reason": "已看原件"}
        saved = store.save("job-1", result_revision="result-1", expected_grouping_revision=initial["header"]["grouping_revision"],
                           expected_review_fingerprint="review-1", edits=[{
                               "segment_id": item["binding"]["segment_id"], "expected_basis_fingerprint": item["basis_fingerprint"],
                               "field_overrides": [override], "assignment": {"group_id": "manual-preserved", "reason": "已核对分组"},
                           }], group_edits=[{"action": "create", "group_id": "manual-preserved", "kind": "named", "display_name": "保留人工组"}])
        old_algorithm = module.grouping_algorithm_version()
        monkeypatch.setattr(module, "grouping_algorithm_version", lambda: old_algorithm + "-upgrade")
        if legacy_basis:
            basis = json.loads(store.connection.execute("SELECT basis_json FROM receipt_grouping_tasks WHERE job_id='job-1'").fetchone()[0])
            basis.pop("extraction_algorithm_version")
            store.connection.execute("UPDATE receipt_grouping_tasks SET basis_json=? WHERE job_id='job-1'", (json.dumps(basis),))
        else:
            old_extraction = module.extraction_algorithm_version()
            monkeypatch.setattr(module, "extraction_algorithm_version", lambda: old_extraction + "-upgrade")
        authoritative = receipt(pdf)
        authoritative.pop("parties")
        stale = prepare(store, pdf, [authoritative])
        row = stale["items"][0]
        assert row["extraction_state"] == "stale"
        assert row["field_overrides"] == [override]
        assert row["binding"]["final_rect"] == initial["items"][0]["binding"]["final_rect"]
        fresh_parties = receipt(pdf)["parties"]
        fresh_parties["payee"]["bank"] = field("新解析开户行")
        fresh_parties["payee"]["name"] = field("新解析名称")
        refreshed = store.refresh("job-1", result_revision="result-1", expected_grouping_revision=stale["header"]["grouping_revision"],
                                  expected_review_fingerprint="review-1", segment_ids=[row["binding"]["segment_id"]],
                                  source_reader=lambda *_: {"parties": fresh_parties, "extraction_state": "ready", "source_bank": "合成银行"})
        final = refreshed["items"][0]
        assert final["field_overrides"] == [override]
        assert final["counterparty"]["name"]["value"] == "人工核对对手"
        assert final["group"]["group_id"] == "manual-preserved"
        assert final["boundary_status"] == "confirmed"
        # A later crop change really changes the source evidence and must
        # invalidate the old correction rather than attaching it elsewhere.
        changed = receipt(pdf)
        changed["final_rect"]["x0"] = 2
        moved = prepare(store, pdf, [changed])["items"][0]
        assert moved["field_overrides"] == []
    finally:
        store.close()


def test_internal_unique_group_is_enforced_in_store_mutations(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        prepared = prepare(store, pdf, [receipt(pdf, counterparty=ACCOUNT["company_name"])])
        item = prepared["items"][0]
        expected = dict(result_revision="result-1", expected_grouping_revision=prepared["header"]["grouping_revision"], expected_review_fingerprint="review-1")
        for action in [
            {"action": "create", "group_id": "manual-extra", "kind": "internal", "display_name": "分拆内部组"},
            {"action": "rename", "group_id": item["group"]["group_id"], "display_name": "别的名称"},
        ]:
            with pytest.raises(GroupingValidationError):
                store.save("job-1", **expected, edits=[], group_edits=[action])
        with pytest.raises(GroupingValidationError):
            store.save("job-1", **expected, edits=[{"segment_id": item["binding"]["segment_id"],
                       "expected_basis_fingerprint": item["basis_fingerprint"], "assignment": {"group_id": "manual-normal", "reason": "尝试拆组"}}],
                       group_edits=[{"action": "create", "group_id": "manual-normal", "kind": "named", "display_name": "普通组"}])
        assert store.header("job-1")["grouping_revision"] == prepared["header"]["grouping_revision"]
    finally:
        store.close()


@pytest.mark.parametrize("migration", ["prepare", "refresh", "save"])
def test_legacy_internal_assignment_migrates_once_and_keeps_manual_history(tmp_path, migration):
    import json
    store, pdf = configured_store(tmp_path)
    try:
        rows = [receipt(pdf, 1),
                receipt(pdf, 2, counterparty=ACCOUNT["company_name"]),
                receipt(pdf, 3, counterparty=ACCOUNT["company_name"], counterparty_account="00008888")]
        initial = prepare(store, pdf, rows)
        override = {"side": "payee", "field": "bank", "value": "已核对开户行", "state": "present", "reason": "合成原件核对"}
        saved = store.save("job-1", result_revision="result-1", expected_grouping_revision=initial["header"]["grouping_revision"],
                           expected_review_fingerprint="review-1", group_edits=[], edits=[{
                               "segment_id": item["binding"]["segment_id"], "expected_basis_fingerprint": item["basis_fingerprint"],
                               "field_overrides": [override],
                           } for item in initial["items"]])
        # Seed a format accepted by the former version: even an external
        # counterparty could be manually assigned to a per-account internal group.
        legacy_group = {"group_id": "manual-legacy-internal", "kind": "internal", "key": "old-account-key",
                        "display_name": "旧内部账户组", "manual": True}
        assignment = {"group_id": legacy_group["group_id"], "reason": "旧版人工整理说明"}
        store.connection.execute(
            "INSERT INTO receipt_grouping_groups(job_id, group_id, kind, group_key, display_name, manual, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, '', '')",
            ("job-1", legacy_group["group_id"], "internal", legacy_group["key"], legacy_group["display_name"]),
        )
        for item in saved["items"]:
            stored = store.connection.execute("SELECT manual_json, derived_json FROM receipt_grouping_items WHERE job_id=? AND segment_id=?",
                                              ("job-1", item["binding"]["segment_id"])).fetchone()
            manual = json.loads(stored[0]); manual["assignment"] = assignment
            derived = json.loads(stored[1]); derived["group"] = legacy_group
            store.connection.execute("UPDATE receipt_grouping_items SET manual_json=?, derived_json=?, route='internal', group_id=? WHERE job_id=? AND segment_id=?",
                                     (json.dumps(manual), json.dumps(derived), legacy_group["group_id"], "job-1", item["binding"]["segment_id"]))
        expected = dict(result_revision="result-1", expected_grouping_revision=saved["header"]["grouping_revision"], expected_review_fingerprint="review-1")
        if migration == "prepare":
            migrated = prepare(store, pdf, rows)
        elif migration == "refresh":
            migrated = store.refresh("job-1", **expected, segment_ids=[row["segment_id"] for row in rows],
                                     source_reader=lambda *_: {"extractor_version": "synthetic-migration", "extraction_state": "ready"})
        else:
            migrated = store.save("job-1", **expected, group_edits=[], edits=[{
                "segment_id": item["binding"]["segment_id"], "expected_basis_fingerprint": item["basis_fingerprint"],
            } for item in saved["items"]])

        # The former implementation removed the unused group but left an
        # assignment pointing at it, causing this next prepare to throw.
        repeated = prepare(store, pdf, rows)
        by_segment = {item["binding"]["segment_id"]: item for item in repeated["items"]}
        assert by_segment["segment-1"]["route"] == "named"
        assert by_segment["segment-2"]["route"] == by_segment["segment-3"]["route"] == "internal"
        assert by_segment["segment-2"]["group"]["group_id"] == by_segment["segment-3"]["group"]["group_id"]
        for row in store._load_items(store.connection, "job-1"):
            assert "assignment" not in row["_manual"]
            assert row["field_overrides"] == [override]
            assert row["boundary_status"] == "confirmed"
            assert row["binding"]["final_rect"] == rows[int(row["binding"]["segment_id"][-1]) - 1]["final_rect"]
        history = [json.loads(row[0]) for row in store.connection.execute(
            "SELECT previous_json FROM receipt_grouping_history WHERE job_id=? AND grouping_revision=? AND entity_kind='item'",
            ("job-1", migrated["header"]["grouping_revision"]),
        )]
        assert len(history) == 3
        assert all(row["group"]["group_id"] == legacy_group["group_id"] for row in history)
        assert all(row["manual"]["assignment"] == assignment for row in history)
        assert all(row["manual"]["field_overrides"] == [override] for row in history)

        latest = repeated
        latest = store.refresh("job-1", result_revision="result-1", expected_grouping_revision=latest["header"]["grouping_revision"],
                               expected_review_fingerprint="review-1", segment_ids=["segment-1"],
                               source_reader=lambda *_: {"extractor_version": "synthetic-after-migration", "extraction_state": "ready"})
        item = latest["items"][0]
        final = store.save("job-1", result_revision="result-1", expected_grouping_revision=latest["header"]["grouping_revision"],
                           expected_review_fingerprint="review-1", group_edits=[], edits=[{
                               "segment_id": item["binding"]["segment_id"], "expected_basis_fingerprint": item["basis_fingerprint"],
                           }])
        assert final["items"][0]["route"] == "named"
    finally:
        store.close()


@pytest.mark.parametrize("route", ["internal", "special", "counterparty_pending"])
def test_ignored_named_assignment_does_not_outlive_its_removed_group(tmp_path, route):
    import json
    store, pdf = configured_store(tmp_path)
    try:
        row = receipt(pdf, counterparty=ACCOUNT["company_name"] if route == "internal" else "对手公司")
        if route == "special":
            row.update(special_type="electronic_tax_payment", special_confirmed=True)
        if route == "counterparty_pending":
            row["source_bank"] = {"value": "另一来源银行", "state": "present"}
        initial = prepare(store, pdf, [row])
        item = initial["items"][0]
        override = {"side": "payee", "field": "bank", "value": "人工核对银行", "state": "present", "reason": "原件核对"}
        saved = store.save("job-1", result_revision="result-1", expected_grouping_revision=initial["header"]["grouping_revision"],
                           expected_review_fingerprint="review-1", edits=[{
                               "segment_id": item["binding"]["segment_id"], "expected_basis_fingerprint": item["basis_fingerprint"],
                               "field_overrides": [override],
                           }], group_edits=[{"action": "create", "group_id": "manual-old-named", "kind": "named", "display_name": "旧人工组"}])
        assignment = {"group_id": "manual-old-named", "reason": "旧版人工归组说明"}
        stored = store.connection.execute("SELECT manual_json FROM receipt_grouping_items WHERE job_id='job-1'").fetchone()
        manual = json.loads(stored[0]); manual["assignment"] = assignment
        store.connection.execute("UPDATE receipt_grouping_items SET manual_json=? WHERE job_id='job-1'", (json.dumps(manual),))

        migrated = prepare(store, pdf, [row])
        repeated = prepare(store, pdf, [row])
        assert migrated["items"][0]["route"] == repeated["items"][0]["route"] == route
        current = store._load_items(store.connection, "job-1")[0]
        assert "assignment" not in current["_manual"]
        assert current["field_overrides"] == [override]
        assert store.connection.execute("SELECT COUNT(*) FROM receipt_grouping_groups WHERE group_id='manual-old-named'").fetchone()[0] == 0
        previous = json.loads(store.connection.execute(
            "SELECT previous_json FROM receipt_grouping_history WHERE job_id=? AND grouping_revision=? AND entity_kind='item'",
            ("job-1", migrated["header"]["grouping_revision"]),
        ).fetchone()[0])
        assert previous["manual"]["assignment"] == assignment
    finally:
        store.close()
