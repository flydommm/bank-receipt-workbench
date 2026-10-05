import pytest

from engine.receipt_grouping_models import GroupingConflict, GroupingValidationError
from tests.test_receipt_grouping_store import configured_store, prepare, receipt


def test_correct_one_blank_service_then_move_39_without_overwriting_original_fields(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        rows = [receipt(pdf, index + 1, counterparty="", counterparty_name_state="blank") for index in range(40)]
        for row in rows:
            row["parties"]["service_type"] = "bank_fee"
        current = prepare(store, pdf, rows)
        assert all(item["route"] == "special" for item in current["items"])
        first = current["items"][0]
        current = store.save("job-1", result_revision="result-1",
            expected_grouping_revision=current["header"]["grouping_revision"], expected_review_fingerprint="review-1",
            edits=[{"segment_id": first["binding"]["segment_id"], "expected_basis_fingerprint": first["basis_fingerprint"],
                    "field_overrides": [{"side": "payee", "field": "name", "state": "present", "value": "合成银行收费支行", "reason": "核对原件"}]}], group_edits=[])
        target = next(item["group"]["group_id"] for item in current["items"] if item["route"] == "named")
        current = store.export_snapshot("job-1", require_complete=False)
        rest = [item for item in current["items"] if item["route"] == "special"]
        current = store.save("job-1", result_revision="result-1",
            expected_grouping_revision=current["header"]["grouping_revision"], expected_review_fingerprint="review-1",
            edits=[{"segment_id": item["binding"]["segment_id"], "expected_basis_fingerprint": item["basis_fingerprint"],
                    "assignment": {"group_id": target, "reason": "确认同类收费后批量整理"}} for item in rest], group_edits=[])
        assert all(item["route"] == "named" and item["group"]["group_id"] == target for item in current["items"])
        moved = [item for item in current["items"] if item["binding"]["segment_id"] != first["binding"]["segment_id"]]
        assert len(moved) == 39
        assert all(item["counterparty"]["name"]["state"] == "blank" and not item["field_overrides"] for item in moved)
        assert all(item["document_type"] == "ordinary" for item in current["items"])
        reloaded = prepare(store, pdf, rows)
        assert all(item["group"]["group_id"] == target for item in reloaded["items"])
    finally:
        store.close()


def test_pending_id_query_checks_revision_and_reads_only_selected(tmp_path, monkeypatch):
    store, pdf = configured_store(tmp_path)
    try:
        rows = [receipt(pdf, 1), receipt(pdf, 2)]
        rows[0].pop("parties")
        current = prepare(store, pdf, rows)
        expected = dict(expected_grouping_revision=current["header"]["grouping_revision"], expected_review_fingerprint="review-1")
        monkeypatch.setattr(store, "_load_items", lambda *_args, **_kwargs: pytest.fail("must not load full items"))
        assert store.pending_segment_ids("job-1", ["segment-1", "segment-2"], **expected) == {"segment-1"}
        with pytest.raises(GroupingValidationError):
            store.pending_segment_ids("job-1", ["missing"], **expected)
        with pytest.raises(GroupingConflict):
            store.pending_segment_ids("job-1", ["segment-1"], **{**expected, "expected_grouping_revision": 999})
        with pytest.raises(GroupingConflict):
            store.pending_segment_ids("job-1", ["segment-1"], **{**expected, "expected_review_fingerprint": "changed"})
    finally:
        store.close()


def test_repeated_single_corrections_record_only_affected_receipts(tmp_path, monkeypatch):
    import engine.receipt_grouping_store as storage
    monkeypatch.setattr(storage, "MAX_HISTORY_ROWS", 100)
    store, pdf = configured_store(tmp_path)
    try:
        current = prepare(store, pdf, [receipt(pdf, index + 1) for index in range(40)])
        first = current["items"][0]
        for index in range(12):
            current = store.save("job-1", result_revision="result-1",
                expected_grouping_revision=current["header"]["grouping_revision"], expected_review_fingerprint="review-1",
                edits=[{"segment_id": first["binding"]["segment_id"], "expected_basis_fingerprint": first["basis_fingerprint"],
                        "field_overrides": [{"side": "payee", "field": "name", "state": "present", "value": f"合成修正{index}", "reason": "复核"}]}], group_edits=[])
            first = current["items"][0]
        assert store.header("job-1")["counts"]["total"] == 40
        assert store.connection.execute("SELECT COUNT(*) FROM receipt_grouping_history WHERE reason='save'").fetchone()[0] == 12
        assert store.export_snapshot("job-1")["items"][1]["counterparty"]["name"]["value"] == "对手公司"
    finally:
        store.close()
