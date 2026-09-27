from copy import deepcopy
import json
import sqlite3

import pytest

from engine.receipt_review_read import read_receipt_review_snapshot
from engine.receipt_review_store import RECEIPT_REVIEW_DDL
from engine.review_store_v2 import ReviewStoreV2, ReviewStoreError, ReviewStoreCorruptionError, ReviewRevisionConflict
from test_receipt_review_store import prepare, two_originals, edits


def test_read_only_recovery_returns_saved_values_without_registering_owners(tmp_path):
    database = tmp_path / "review.sqlite3"
    with ReviewStoreV2(database) as store:
        result = prepare(store)
        store.save(result["context_key"], "run-1", edits(result, two_originals()))
        prepared = prepare(store)
        store.connection.execute("DELETE FROM review_context_owners_v2")
        store.connection.commit()
        before = list(store.connection.iterdump())
        restored = read_receipt_review_snapshot(database, result["context_key"], "run-1")
        assert restored == prepared
        assert list(store.connection.iterdump()) == before
        assert store.connection.execute("SELECT COUNT(*) FROM review_context_owners_v2").fetchone()[0] == 0


def test_missing_database_is_not_created(tmp_path):
    target = tmp_path / "absent.sqlite3"
    with pytest.raises(ReviewStoreError, match="does not exist"):
        read_receipt_review_snapshot(target, "a" * 64, "run-1")
    assert not target.exists()


@pytest.mark.parametrize("context_table", ["missing", "incomplete"])
def test_incompatible_context_schema_is_reported_without_repair(tmp_path, context_table):
    database = tmp_path / "incompatible.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.executescript(RECEIPT_REVIEW_DDL)
        if context_table == "incomplete":
            connection.execute("CREATE TABLE review_contexts_v2 (context_key TEXT)")
            connection.execute("INSERT INTO review_contexts_v2 VALUES (?)", ("a" * 64,))
    before = database.read_bytes()
    with pytest.raises(ReviewStoreCorruptionError, match="incompatible"):
        read_receipt_review_snapshot(database, "a" * 64, "run-1")
    assert database.read_bytes() == before


def test_recovery_refuses_old_revision_without_mutation(tmp_path):
    database = tmp_path / "review.sqlite3"
    with ReviewStoreV2(database) as store:
        result = prepare(store, revision="run-2")
        before = list(store.connection.iterdump())
        with pytest.raises(ReviewRevisionConflict):
            read_receipt_review_snapshot(database, result["context_key"], "run-1")
        assert list(store.connection.iterdump()) == before


@pytest.mark.parametrize("damage", ["old_id", "old_revision", "geometry", "codec"])
def test_recovery_never_repairs_corrupt_or_unprepared_binding(tmp_path, damage):
    database = tmp_path / "review.sqlite3"
    with ReviewStoreV2(database) as store:
        result = prepare(store)
        saved = store.save(result["context_key"], "run-1", edits(result, two_originals()))
        record = deepcopy(saved["segments"][0])
        if damage == "old_id":
            record["original"]["id"] = "0" * 64
        elif damage == "old_revision":
            record["result_revision"] = "run-old"
        elif damage == "geometry":
            record["original"]["candidate_rect"]["y0"] += 3
            record["final_rect"]["y0"] += 3
        else:
            store.connection.execute("UPDATE review_contexts_v2 SET version=4")
        if damage != "codec":
            store.connection.execute("""UPDATE review_receipt_records_v1 SET id=?,result_revision=?,record_json=?
                WHERE instance_id=?""", (record["original"]["id"], record["result_revision"],
                    json.dumps(record, sort_keys=True, separators=(",", ":")), record["original"]["instance_id"]))
        store.connection.commit()
        before = list(store.connection.iterdump())
        with pytest.raises(ReviewStoreCorruptionError):
            read_receipt_review_snapshot(database, result["context_key"], "run-1")
        assert list(store.connection.iterdump()) == before


def test_changed_analysis_returns_revision_without_restoring_old_decision(tmp_path):
    database = tmp_path / "review.sqlite3"
    with ReviewStoreV2(database) as store:
        result = prepare(store)
        store.save(result["context_key"], "run-1", edits(result, two_originals()))
        changed = two_originals()
        changed[0]["analysis_signature"] = "6" * 64
        expected = prepare(store, originals=changed, revision="run-2")
        restored = read_receipt_review_snapshot(database, result["context_key"], "run-2")
        assert restored == expected
        assert len(restored["segments"]) == 1
        assert [row["record_revision"] for row in restored["record_revisions"]] == [1, 1]
