from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from engine.receipt_review_store import record_table
from engine.review_read import read_review_snapshot
from engine.review_store import ReviewStoreError
from engine.review_store_v2 import ReviewStoreCorruptionError, ReviewStoreV2
from test_receipt_review_models import _context, _edit, _original
from test_review_ownership import (
    _context as legacy_context,
    _original as legacy_original,
    _segment as legacy_segment,
)


def _receipt_originals() -> list[dict[str, object]]:
    return [
        _original(slot_id="slot-1", position_index=1, item_id="1" * 64),
        _original(slot_id="slot-3", position_index=3, item_id="2" * 64),
    ]


def _receipt_edits(context_key: str, originals: list[dict[str, object]], *, revision: int = 0) -> list[dict[str, object]]:
    return [
        _edit(context_key, original, revision=revision)
        for original in originals
    ]


def _owners(store: ReviewStoreV2, context_key: str) -> list[tuple[str, str]]:
    rows = store.connection.execute(
        """
        SELECT owner_kind, owner_id
          FROM review_context_owners_v2
         WHERE context_key = ?
         ORDER BY owner_kind, owner_id
        """,
        (context_key,),
    ).fetchall()
    return [(row["owner_kind"], row["owner_id"]) for row in rows]


def test_receipt_ownership_fingerprint_includes_record_revisions() -> None:
    originals = _receipt_originals()
    with ReviewStoreV2() as store:
        prepared = store.prepare_batch(
            _context(),
            originals,
            result_revision="run-1",
            job_id="job-1",
        )
        key = prepared["context_key"]
        assert store.connection.execute(
            "SELECT version FROM review_contexts_v2 WHERE context_key = ?", (key,)
        ).fetchone()["version"] == 3
        assert record_table(store.connection, key) == "review_receipt_records_v1"

        first = store.save(key, "run-1", _receipt_edits(key, originals))
        before = store.batch_ownership(key, "job-1")
        assert before["record_count"] == 2
        assert [record["record_revision"] for record in first["segments"]] == [1, 1]

        revised = _receipt_edits(key, originals, revision=1)
        revised[0]["final_rect"] = {"x0": 0.0, "y0": 610.0, "x1": 600.0, "y1": 890.0}
        revised[0]["crop_mode"] = "manual"
        revised[0]["manual_adjusted"] = True
        second = store.save(key, "run-1", revised[:1])
        after = store.batch_ownership(key, "job-1")

        assert second["saved_count"] == 1
        assert second["segments"][0]["record_revision"] == 2
        assert before["fingerprint"] != after["fingerprint"]
        assert store.connection.execute(
            "SELECT COUNT(*) FROM review_segments_v2 WHERE context_key = ?", (key,)
        ).fetchone()[0] == 0


def test_receipt_exclusive_cleanup_deletes_receipt_rows_and_replays_idempotently() -> None:
    originals = _receipt_originals()
    with ReviewStoreV2() as store:
        prepared = store.prepare_batch(
            _context(), originals, result_revision="run-1", job_id="job-1"
        )
        key = prepared["context_key"]
        store.save(key, "run-1", _receipt_edits(key, originals))
        view = store.batch_ownership(key, "job-1")

        deleted = store.release_batch_owner(
            key, "job-1", "cleanup-1", True, view["fingerprint"]
        )
        assert deleted["outcome"] == "deleted"
        assert deleted["deleted_record_count"] == 2
        assert store.connection.execute(
            "SELECT COUNT(*) FROM review_receipt_records_v1 WHERE context_key = ?", (key,)
        ).fetchone()[0] == 0
        assert store.connection.execute(
            "SELECT COUNT(*) FROM review_contexts_v2 WHERE context_key = ?", (key,)
        ).fetchone()[0] == 0

        replay = store.release_batch_owner(
            key, "job-1", "cleanup-1", True, view["fingerprint"]
        )
        assert replay["outcome"] == "already_absent"
        assert replay["original_outcome"] == "deleted"


def test_receipt_shared_release_preserves_records_and_owner_state() -> None:
    originals = _receipt_originals()
    with ReviewStoreV2() as store:
        first = store.prepare_batch(
            _context(), originals, result_revision="run-1", job_id="job-1"
        )
        key = first["context_key"]
        store.prepare_batch(
            _context(), originals, result_revision="run-1", job_id="job-2"
        )
        store.save(key, "run-1", _receipt_edits(key, originals))
        view = store.batch_ownership(key, "job-1")

        released = store.release_batch_owner(
            key, "job-1", "cleanup-1", True, view["fingerprint"]
        )
        assert released["outcome"] == "released_shared"
        assert _owners(store, key) == [("batch", "job-2")]
        assert store.connection.execute(
            "SELECT COUNT(*) FROM review_receipt_records_v1 WHERE context_key = ?", (key,)
        ).fetchone()[0] == 2

        second_view = store.batch_ownership(key, "job-2")
        retained = store.release_batch_owner(
            key, "job-2", "cleanup-2", False, second_view["fingerprint"]
        )
        assert retained["outcome"] == "retained"
        assert _owners(store, key) == [("retained", "cleanup-2")]
        assert store.connection.execute(
            "SELECT COUNT(*) FROM review_receipt_records_v1 WHERE context_key = ?", (key,)
        ).fetchone()[0] == 2


def test_mixed_receipt_rows_are_rejected_for_a_legacy_context() -> None:
    with ReviewStoreV2() as store:
        context = legacy_context()
        original = legacy_original()
        prepared = store.prepare_batch(context, [original], result_revision="run-1", job_id="legacy-job")
        key = prepared["context_key"]
        store.save(key, "run-1", [legacy_segment(key, "run-1")])
        store.connection.execute(
            """
            INSERT INTO review_receipt_records_v1
              (context_key, source_key, instance_id, id, analysis_signature,
               result_revision, record_revision, record_json, decision_scope)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (key, "legacy", "instance", "id", "a" * 64, "run-1", 1, "{}", ""),
        )
        store.connection.commit()

        with pytest.raises(ReviewStoreCorruptionError):
            store.batch_ownership(key, "legacy-job")
        with pytest.raises(ReviewStoreCorruptionError):
            record_table(store.connection, key)


def test_migration_adds_receipt_codec_without_dropping_legacy_rows(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    context = legacy_context()
    original = legacy_original()
    with ReviewStoreV2(database) as store:
        prepared = store.prepare_batch(context, [original], result_revision="run-1", job_id="legacy-job")
        key = prepared["context_key"]
        store.save(key, "run-1", [legacy_segment(key, "run-1")])

    # Recreate the actual pre-receipt schema before the writer opens it.
    with sqlite3.connect(database) as connection:
        connection.execute("DROP TABLE review_receipt_records_v1")
        connection.commit()

    with ReviewStoreV2(database) as store:
        assert store.connection.execute(
            "SELECT COUNT(*) FROM review_segments_v2 WHERE context_key = ?", (key,)
        ).fetchone()[0] == 1
        assert store.connection.execute(
            "SELECT COUNT(*) FROM review_receipt_records_v1 WHERE context_key = ?", (key,)
        ).fetchone()[0] == 0


def test_read_only_legacy_snapshot_accepts_a_database_without_receipt_table(tmp_path: Path) -> None:
    database = tmp_path / "legacy-review.sqlite3"
    context = legacy_context()
    original = legacy_original()
    with ReviewStoreV2(database) as store:
        prepared = store.prepare_batch(context, [original], result_revision="run-1", job_id="legacy-job")
        key = prepared["context_key"]
        store.save(key, "run-1", [legacy_segment(key, "run-1")])

    with sqlite3.connect(database) as connection:
        connection.execute("DROP TABLE review_receipt_records_v1")
        connection.commit()

    snapshot = read_review_snapshot(database, key, "run-1")
    assert len(snapshot["segments"]) == 1
    with sqlite3.connect(database) as connection:
        assert connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_receipt_records_v1'"
        ).fetchone() is None


def test_schema3_public_prepare_cannot_create_an_unattributed_owner() -> None:
    with ReviewStoreV2() as store:
        with pytest.raises(ReviewStoreError, match="server-attested"):
            store.prepare(_context(), _receipt_originals(), result_revision="run-1")
        with pytest.raises(ReviewStoreError, match="server-attested"):
            store.prepare_batch(_context(), _receipt_originals(), result_revision="run-1")
        assert store.connection.execute(
            "SELECT COUNT(*) FROM review_contexts_v2"
        ).fetchone()[0] == 0
