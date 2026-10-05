"""Large synthetic grouping jobs keep bounded writes and complete audit evidence."""

from copy import deepcopy
import json

import pytest

from engine.receipt_grouping_models import GroupingConflict
from tests.test_receipt_grouping_store import configured_store, prepare, receipt


def expected(header):
    return dict(result_revision="result-1", expected_grouping_revision=header["grouping_revision"],
                expected_review_fingerprint="review-1")


def stored_rows(store):
    return [tuple(row) for row in store.connection.execute(
        "SELECT * FROM receipt_grouping_items ORDER BY fragment_key")]


def test_4150_fragments_complete_83_refreshes_with_linear_history(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        rows = [receipt(pdf, index + 1) for index in range(4150)]
        reading = {"parties": deepcopy(rows[0]["parties"]), "extractor_version": "synthetic-new",
                   "extraction_state": "ready"}
        for row in rows:
            row.pop("parties")
        current = prepare(store, pdf, rows)
        assert current["header"]["counts"]["extraction_pending"] == 4150
        initial_revision = current["header"]["grouping_revision"]
        for offset in range(0, 4150, 50):
            selected = [f"segment-{index + 1}" for index in range(offset, offset + 50)]
            current = store.refresh("job-1", **expected(current["header"]), segment_ids=selected,
                                    source_reader=lambda *_: reading, verify_sources=False)
            assert len(current["items"]) == 50
            assert current["header"]["counts"]["total"] == 4150
            assert current["header"]["counts"]["extraction_pending"] == 4150 - offset - 50
            history_count = store.connection.execute(
                "SELECT COUNT(*) FROM receipt_grouping_history WHERE reason='refresh'").fetchone()[0]
            assert history_count == offset + 50
        assert current["header"]["grouping_revision"] == initial_revision + 83
        assert current["header"]["counts"]["assigned"] == 4150
        identifiers = []
        offset = 0
        while True:
            page = store.page("job-1", **expected(current["header"]), offset=offset, limit=200)
            identifiers.extend(item["binding"]["segment_id"] for item in page["items"])
            assert page["header"] == current["header"]
            assert page["total"] == 4150
            if page["next_offset"] is None:
                break
            offset = page["next_offset"]
        assert len(identifiers) == len(set(identifiers)) == 4150
        assert set(identifiers) == {f"segment-{index + 1}" for index in range(4150)}
        assert store.page("job-1", **expected(current["header"]), offset=4150, limit=200)["items"] == []
    finally:
        store.close()


def test_refresh_keeps_unselected_rows_manual_decisions_and_group_definitions(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        prepared = prepare(store, pdf, [receipt(pdf, 1), receipt(pdf, 2)])
        item = prepared["items"][0]
        override = {"side": "payee", "field": "bank", "value": "核对银行", "state": "present", "reason": "合成核对"}
        group_id = item["group"]["group_id"]
        saved = store.save("job-1", **expected(prepared["header"]), edits=[{
            "segment_id": item["binding"]["segment_id"], "expected_basis_fingerprint": item["basis_fingerprint"],
            "field_overrides": [override], "assignment": {"group_id": group_id, "reason": "核对归组"},
        }], group_edits=[{"action": "rename", "group_id": group_id, "display_name": "核对后的对手"}])
        unselected_before = tuple(store.connection.execute(
            "SELECT * FROM receipt_grouping_items WHERE segment_id='segment-2'").fetchone())
        groups_before = [tuple(row) for row in store.connection.execute("SELECT * FROM receipt_grouping_groups ORDER BY group_id")]
        manual_before = store._load_items(store.connection, "job-1", segment_ids=["segment-1"])[0]["_manual"]
        refreshed = store.refresh("job-1", **expected(saved["header"]), segment_ids=["segment-1"],
                                  source_reader=lambda *_: {"extractor_version": "synthetic-new", "extraction_state": "ready"})
        assert refreshed["items"][0]["field_overrides"] == [override]
        assert refreshed["items"][0]["group"]["display_name"] == "核对后的对手"
        assert store._load_items(store.connection, "job-1", segment_ids=["segment-1"])[0]["_manual"] == manual_before
        assert tuple(store.connection.execute(
            "SELECT * FROM receipt_grouping_items WHERE segment_id='segment-2'").fetchone()) == unselected_before
        assert [tuple(row) for row in store.connection.execute("SELECT * FROM receipt_grouping_groups ORDER BY group_id")] == groups_before
        history = store.connection.execute(
            "SELECT previous_json FROM receipt_grouping_history WHERE grouping_revision=? AND reason='refresh'",
            (refreshed["header"]["grouping_revision"],),
        ).fetchall()
        assert len(history) == 1
        assert json.loads(history[0][0])["manual"] == manual_before
        assert json.loads(history[0][0])["group"]["display_name"] == "核对后的对手"
        # Clearing a manual assignment still works after the incremental write.
        item = refreshed["items"][0]
        cleared = store.save("job-1", **expected(refreshed["header"]), edits=[{
            "segment_id": "segment-1", "expected_basis_fingerprint": item["basis_fingerprint"], "assignment": None,
        }], group_edits=[])
        assert cleared["items"][0]["route"] == "named"
        assert "assignment" not in store._load_items(store.connection, "job-1", segment_ids=["segment-1"])[0]["_manual"]
    finally:
        store.close()


def test_incremental_refresh_cas_failure_rolls_back_items_groups_and_history(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        prepared = prepare(store, pdf, [receipt(pdf, 1), receipt(pdf, 2)])
        before_items = stored_rows(store)
        before_groups = [tuple(row) for row in store.connection.execute("SELECT * FROM receipt_grouping_groups")]
        before_history = [tuple(row) for row in store.connection.execute("SELECT * FROM receipt_grouping_history")]
        store.connection.execute("""CREATE TRIGGER fail_grouping_cas BEFORE UPDATE ON receipt_grouping_tasks
                                  BEGIN SELECT RAISE(IGNORE); END""")
        changed = {"parties": receipt(pdf, counterparty="新对手")["parties"], "extraction_state": "ready"}
        with pytest.raises(GroupingConflict):
            store.refresh("job-1", **expected(prepared["header"]), segment_ids=["segment-1"], source_reader=lambda *_: changed)
        assert stored_rows(store) == before_items
        assert [tuple(row) for row in store.connection.execute("SELECT * FROM receipt_grouping_groups")] == before_groups
        assert [tuple(row) for row in store.connection.execute("SELECT * FROM receipt_grouping_history")] == before_history
        assert store.header("job-1") == prepared["header"]
    finally:
        store.close()
