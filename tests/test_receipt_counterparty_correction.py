"""Batch counterparty corrections use synthetic fields and isolated SQLite stores."""
from copy import deepcopy

import pytest

from engine.receipt_grouped_export import build_grouped_receipt_export_scope, build_grouped_receipt_output_plan
from engine.receipt_grouping_models import GroupingConflict, GroupingValidationError
from tests.test_receipt_grouped_export import _base_scope, _grouping, _request
from tests.test_receipt_grouping_store import ACCOUNT, configured_store, field, prepare, receipt


def correction(item, name="人工核对对手", target=None):
    overrides = [value for value in item["field_overrides"]
                 if (value["side"], value["field"]) != ("counterparty", "name")]
    return {
        "segment_id": item["binding"]["segment_id"],
        "expected_basis_fingerprint": item["basis_fingerprint"],
        "field_overrides": [*overrides, {"side": "counterparty", "field": "name", "value": name,
                                        "state": "present", "reason": "合成批量核对"}],
        "assignment": None if target is None else {"group_id": target, "reason": "合成批量核对"},
    }


def save(store, current, edits, groups=()):
    return store.save("job-1", result_revision="result-1",
                      expected_grouping_revision=current["header"]["grouping_revision"],
                      expected_review_fingerprint="review-1", edits=edits, group_edits=list(groups))


def ordered_items(value):
    return sorted(value["items"], key=lambda item: item["binding"]["position_index"])


def test_mixed_directions_and_unknown_side_correct_together_and_export_effective_names(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        rows = [receipt(pdf, index) for index in range(1, 4)]
        rows[1]["parties"]["payer"], rows[1]["parties"]["payee"] = rows[1]["parties"]["payee"], rows[1]["parties"]["payer"]
        rows[2]["parties"]["payer"] = {key: field() for key in ("name", "account", "bank")}
        rows[2]["parties"]["payee"]["account"] = field()
        original_rows = deepcopy(rows)
        current = prepare(store, pdf, rows)
        old = current["items"][0]
        retained_override = {"side": "payee", "field": "bank", "value": "已核对开户行", "state": "present", "reason": "先前核对"}
        current = save(store, current, [{"segment_id": old["binding"]["segment_id"],
                                       "expected_basis_fingerprint": old["basis_fingerprint"],
                                       "field_overrides": [retained_override]}])
        current = store.export_snapshot("job-1", require_complete=False)
        result = save(store, current, [correction(item) for item in current["items"]])
        result_items = ordered_items(result)
        assert [item["own_decision"]["side"] for item in result_items] == ["payer", "payee", None]
        assert {item["route"] for item in result["items"]} == {"named"}
        assert len({item["group"]["group_id"] for item in result["items"]}) == 1
        assert all(item["counterparty"]["name"]["value"] == "人工核对对手" for item in result["items"])
        assert retained_override in result_items[0]["field_overrides"]
        assert rows == original_rows
        assert [item["extracted"] for item in result_items] == [item["extracted"] for item in ordered_items(current)]

        persisted = store.export_snapshot("job-1", require_complete=True)
        # Project persisted decisions onto the established export geometry
        # fixture, so the real detail/index builders verify effective fields.
        grouping = _grouping()
        for export_item, stored in zip(grouping["items"], ordered_items(persisted)):
            for key in ("extracted", "counterparty", "field_overrides", "own_decision", "group", "route"):
                export_item[key] = deepcopy(stored[key])
        grouping["groups"] = [deepcopy(persisted["items"][0]["group"])]
        scope = build_grouped_receipt_export_scope(_base_scope(), _request(), grouping)
        plan = build_grouped_receipt_output_plan(scope, "2026-10-04T00:00:00Z")
        assert all(row["counterparty_name"] == row["group_name"] == "人工核对对手" for row in plan["index_rows"])
        assert [row["counterparty_side"] for row in plan["index_rows"]] == ["payee", "payer", ""]
        assert plan["index_rows"][0]["counterparty_name_raw"] == "对手公司"
        assert all(row["交易对手名称"] == row["归组名称"] == "人工核对对手" for row in plan["detail_rows"])
    finally:
        store.close()


@pytest.mark.parametrize("service", ["bank_fee", "deposit_interest"])
def test_correct_internal_and_blank_service_into_existing_group_in_one_save(tmp_path, service):
    store, pdf = configured_store(tmp_path)
    try:
        rows = [receipt(pdf, 1, counterparty="已存在对手"),
                receipt(pdf, 2, counterparty=ACCOUNT["company_name"]),
                receipt(pdf, 3, counterparty="", counterparty_name_state="blank")]
        rows[2]["parties"]["service_type"] = service
        current = prepare(store, pdf, rows)
        assert [item["route"] for item in current["items"]] == ["named", "internal", "special"]
        target = current["items"][0]["group"]["group_id"]
        result = save(store, current, [correction(item, "已存在对手", target) for item in current["items"][1:]])
        assert len(result["items"]) == 2
        assert all(item["route"] == "named" and item["group"]["group_id"] == target for item in result["items"])
        assert all(item["counterparty"]["name"]["value"] == "已存在对手" for item in result["items"])
        assert all(item["document_type"] == "ordinary" for item in result["items"])
        reloaded = prepare(store, pdf, rows)
        assert all(item["group"]["group_id"] == target for item in reloaded["items"])
    finally:
        store.close()


@pytest.mark.parametrize("blocked", ["pending", "failed", "stale", "excluded", "special", "bank", "company", "account", "both_accounts"])
@pytest.mark.parametrize("target_existing", [False, True])
def test_blocked_last_correction_rolls_back_items_groups_revision_and_history(tmp_path, blocked, target_existing):
    store, pdf = configured_store(tmp_path)
    try:
        rows = [receipt(pdf, 1), receipt(pdf, 2)]
        bad = rows[1]
        if blocked in {"pending", "failed", "stale"}:
            bad["extraction_state"] = blocked
        elif blocked == "excluded":
            bad["review_status"] = "excluded"
        elif blocked == "special":
            bad.update(document_type="electronic_tax_payment", document_type_confirmed=True)
        elif blocked == "bank":
            bad["source_bank"]["value"] = "另一银行"
        elif blocked == "company":
            bad["parties"]["payer"]["name"] = field("另一公司")
        elif blocked == "account":
            bad["parties"]["payer"]["account"] = field("88889999")
        else:
            bad["parties"]["payee"]["account"] = field(ACCOUNT["account_number"])
        current = prepare(store, pdf, rows)
        before = store.export_snapshot("job-1", require_complete=False)
        history = store.connection.execute("SELECT COUNT(*) FROM receipt_grouping_history").fetchone()[0]
        target = current["items"][0]["group"]["group_id"] if target_existing else None
        with pytest.raises(GroupingValidationError):
            save(store, current, [correction(item, target=target) for item in current["items"]],
                 [{"action": "create", "group_id": "manual-must-rollback", "kind": "named", "display_name": "未保存的新组"}])
        assert store.export_snapshot("job-1", require_complete=False) == before
        assert store.connection.execute("SELECT COUNT(*) FROM receipt_grouping_history").fetchone()[0] == history
        assert store.connection.execute("SELECT COUNT(*) FROM receipt_grouping_groups WHERE group_id='manual-must-rollback'").fetchone()[0] == 0
    finally:
        store.close()


def test_pending_boundary_can_still_correct_counterparty_fields(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        row = receipt(pdf)
        row["review_status"] = "needs_review"
        current = prepare(store, pdf, [row])
        result = save(store, current, [correction(current["items"][0])])
        assert result["items"][0]["route"] == "named"
        assert result["items"][0]["boundary_status"] == "needs_review"
    finally:
        store.close()


def test_resending_unchanged_legacy_counterparty_override_does_not_require_new_extraction(tmp_path, monkeypatch):
    import engine.receipt_grouping_store as storage

    store, pdf = configured_store(tmp_path)
    try:
        row = receipt(pdf)
        current = prepare(store, pdf, [row])
        current = save(store, current, [correction(current["items"][0])])
        old_grouping = storage.grouping_algorithm_version()
        old_extraction = storage.extraction_algorithm_version()
        monkeypatch.setattr(storage, "grouping_algorithm_version", lambda: old_grouping + "-synthetic-upgrade")
        monkeypatch.setattr(storage, "extraction_algorithm_version", lambda: old_extraction + "-synthetic-upgrade")
        row.pop("parties")
        current = prepare(store, pdf, [row])
        item = current["items"][0]
        assert item["extraction_state"] == "stale"
        result = save(store, current, [{"segment_id": item["binding"]["segment_id"],
                                       "expected_basis_fingerprint": item["basis_fingerprint"],
                                       "field_overrides": item["field_overrides"]}])
        assert result["items"][0]["field_overrides"] == item["field_overrides"]
        assert result["items"][0]["extraction_state"] == "stale"
    finally:
        store.close()


@pytest.mark.parametrize("conflict", ["basis", "grouping", "review", "result"])
def test_batch_name_correction_uses_existing_compare_and_swap(tmp_path, conflict):
    store, pdf = configured_store(tmp_path)
    try:
        current = prepare(store, pdf, [receipt(pdf, 1), receipt(pdf, 2)])
        before = store.export_snapshot("job-1", require_complete=False)
        edits = [correction(item) for item in current["items"]]
        arguments = dict(result_revision="result-1", expected_grouping_revision=current["header"]["grouping_revision"],
                         expected_review_fingerprint="review-1", edits=edits, group_edits=[])
        if conflict == "basis":
            edits[-1]["expected_basis_fingerprint"] = "stale-basis"
        elif conflict == "grouping":
            arguments["expected_grouping_revision"] += 1
        elif conflict == "review":
            arguments["expected_review_fingerprint"] = "stale-review"
        else:
            arguments["result_revision"] = "stale-result"
        with pytest.raises(GroupingConflict):
            store.save("job-1", **arguments)
        assert store.export_snapshot("job-1", require_complete=False) == before
    finally:
        store.close()
