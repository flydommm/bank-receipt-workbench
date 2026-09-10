from __future__ import annotations

from pathlib import Path
import sqlite3

import pytest

from engine.review_store_v2 import ReviewStoreV2, ReviewStoreCorruptionError, ReviewStoreError


SHA_A = "a" * 64
FINGERPRINT_A = "1" * 64


def _rect(x0: float = 10, y0: float = 20, x1: float = 30, y1: float = 40) -> dict[str, float]:
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _context(path: str = "/docs/report.pdf") -> dict[str, object]:
    return {
        "version": 2,
        "sources": [{"source_key": path, "source_path": path, "source_sha256": SHA_A}],
        "criteria_fingerprint": FINGERPRINT_A,
        "computation_version": "engine-schema-v2",
    }


def _original(path: str = "/docs/report.pdf") -> dict[str, object]:
    return {
        "id": "segment-1",
        "source_key": path,
        "source_page": 1,
        "segment_no": 1,
        "analysis_signature": FINGERPRINT_A,
        "persistable": True,
        "page_width": 600,
        "page_height": 800,
        "match_rect": _rect(),
        "candidate_rect": _rect(0, 0, 600, 250),
        "layout_fingerprint": "geometry:review-v1",
        "confidence": 0.96,
        "auto_full_page": False,
    }


def _segment(context_key: str, result_revision: str, *, record_revision: int = 0) -> dict[str, object]:
    return {
        "id": "segment-1",
        "task_id": "job-1",
        "source_path": "/docs/report.pdf",
        "source_sha256": SHA_A,
        "source_page": 1,
        "segment_no": 1,
        "match_rect": _rect(),
        "candidate_rect": _rect(0, 0, 600, 250),
        "final_rect": _rect(0, 2, 600, 248),
        "layout_fingerprint": "geometry:review-v1",
        "confidence": 0.96,
        "crop_mode": "manual",
        "review_status": "confirmed",
        "manual_adjusted": True,
        "reviewed_at": "2026-09-08T06:20:00.000Z",
        "context_key": context_key,
        "source_key": "/docs/report.pdf",
        "analysis_signature": FINGERPRINT_A,
        "result_revision": result_revision,
        "record_revision": record_revision,
        "page_width": 600,
        "page_height": 800,
    }


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


def test_replay_keeps_user_request_stable_when_external_reference_guard_changes() -> None:
    with ReviewStoreV2(":memory:") as store:
        prepared = store.prepare_batch(_context(), [_original()], result_revision="run-1", job_id="job-1")
        key = prepared["context_key"]
        store.save(key, "run-1", [_segment(key, "run-1")])
        view = store.batch_ownership(key, "job-1")
        first = store.release_batch_owner(key, "job-1", "cleanup-shared", True, view["fingerprint"], force_retained=True)
        assert first["outcome"] == "retained"
        second = store.release_batch_owner(key, "job-1", "cleanup-shared", True, view["fingerprint"], force_retained=False)
        assert second["outcome"] == "already_released"
        assert second["original_outcome"] == "retained"
        assert store.connection.execute("SELECT COUNT(*) FROM review_segments_v2").fetchone()[0] == 1


def test_prepare_uses_explicit_owner_kind_and_does_not_mark_new_batch_legacy() -> None:
    context = _context()
    original = _original()
    unattributed_context = _context("/docs/unattributed.pdf")
    public_context = _context("/docs/public.pdf")

    with ReviewStoreV2(":memory:") as store:
        first_key = store.context_key(context)
        assert _owners(store, first_key) == []

        prepared = store.prepare_batch(
            context,
            [original],
            result_revision="run-1",
            job_id="job-1",
        )
        assert _owners(store, prepared["context_key"]) == [("batch", "job-1")]

        unattributed = store.prepare_batch(
            unattributed_context,
            [_original("/docs/unattributed.pdf")],
            result_revision="run-1",
        )
        assert _owners(store, unattributed["context_key"]) == [("legacy", "unattributed")]

        public = store.prepare(
            public_context,
            [_original("/docs/public.pdf")],
            result_revision="run-1",
        )
        assert _owners(store, public["context_key"]) == [("legacy", "public")]


def test_migration_marks_existing_context_unknown_and_preserves_legacy_table(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    context = _context()
    original = _original()

    with ReviewStoreV2(database) as store:
        prepared = store.prepare_batch(context, [original], result_revision="run-1", job_id="job-1")
        store.connection.execute("CREATE TABLE legacy_marker (value TEXT NOT NULL)")
        store.connection.execute("INSERT INTO legacy_marker (value) VALUES ('keep')")
        store.connection.execute(
            "DELETE FROM review_context_owners_v2 WHERE context_key = ?",
            (prepared["context_key"],),
        )
        store.connection.commit()

    with ReviewStoreV2(database) as store:
        assert _owners(store, prepared["context_key"]) == [("legacy", "unknown")]
        assert store.connection.execute("SELECT value FROM legacy_marker").fetchone()["value"] == "keep"


def test_batch_ownership_reports_records_and_exclusive_release_deletes_v2_only(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    context = _context()
    original = _original()

    with ReviewStoreV2(database) as store:
        prepared = store.prepare_batch(context, [original], result_revision="run-1", job_id="job-1")
        context_key = prepared["context_key"]
        store.save(
            context_key,
            "run-1",
            [_segment(context_key, "run-1")],
            confirm_group=False,
        )
        ownership = store.batch_ownership(context_key, "job-1")
        assert ownership["outcome"] == "ok"
        assert ownership["record_count"] == 1
        assert ownership["owned_by_job"] is True
        assert ownership["other_owner_count"] == 0
        assert ownership["exclusive"] is True
        assert isinstance(ownership["fingerprint"], str)

        released = store.release_batch_owner(
            context_key,
            "job-1",
            "cleanup-1",
            True,
            ownership["fingerprint"],
        )
        assert released["outcome"] == "deleted"
        assert released["deleted_record_count"] == 1
        assert store.batch_ownership(context_key, "job-1")["outcome"] == "already_absent"
        assert store.connection.execute(
            "SELECT COUNT(*) AS count FROM review_segments_v2 WHERE context_key = ?",
            (context_key,),
        ).fetchone()["count"] == 0


def test_shared_release_only_drops_current_owner_and_default_release_retains(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    context = _context()
    original = _original()

    with ReviewStoreV2(database) as store:
        prepared = store.prepare_batch(context, [original], result_revision="run-1", job_id="job-1")
        context_key = prepared["context_key"]
        store.prepare_batch(context, [original], result_revision="run-1", job_id="job-2")
        store.save(context_key, "run-1", [_segment(context_key, "run-1")], confirm_group=False)

        first_view = store.batch_ownership(context_key, "job-1")
        assert first_view["owner_count"] == 2
        assert first_view["other_owner_count"] == 1
        assert first_view["exclusive"] is False
        shared = store.release_batch_owner(
            context_key,
            "job-1",
            "cleanup-1",
            True,
            first_view["fingerprint"],
        )
        assert shared["outcome"] == "released_shared"
        assert _owners(store, context_key) == [("batch", "job-2")]

        second_view = store.batch_ownership(context_key, "job-2")
        retained = store.release_batch_owner(
            context_key,
            "job-2",
            "cleanup-2",
            False,
            second_view["fingerprint"],
        )
        assert retained["outcome"] == "retained"
        assert _owners(store, context_key) == [("retained", "cleanup-2")]
        assert store.connection.execute(
            "SELECT COUNT(*) AS count FROM review_segments_v2 WHERE context_key = ?",
            (context_key,),
        ).fetchone()["count"] == 1

        repeated = store.release_batch_owner(
            context_key,
            "job-2",
            "cleanup-2",
            False,
            second_view["fingerprint"],
        )
        assert repeated["outcome"] == "already_released"
        assert _owners(store, context_key) == [("retained", "cleanup-2")]


def test_changed_fingerprint_and_cross_task_release_fail_closed() -> None:
    context = _context()
    original = _original()

    with ReviewStoreV2(":memory:") as store:
        prepared = store.prepare_batch(context, [original], result_revision="run-1", job_id="job-1")
        context_key = prepared["context_key"]
        before = store.batch_ownership(context_key, "job-1")
        store.prepare_batch(context, [original], result_revision="run-2", job_id="job-1")
        after = store.batch_ownership(context_key, "job-1")
        assert after["fingerprint"] != before["fingerprint"]

        changed = store.release_batch_owner(
            context_key,
            "job-1",
            "cleanup-1",
            True,
            before["fingerprint"],
        )
        assert changed["outcome"] == "changed"
        assert _owners(store, context_key) == [("batch", "job-1")]

        cross_task = store.release_batch_owner(
            context_key,
            "job-2",
            "cleanup-2",
            True,
            after["fingerprint"],
        )
        assert cross_task["outcome"] == "not_owner"
        assert _owners(store, context_key) == [("batch", "job-1")]


def test_unknown_owner_prevents_exclusive_delete_and_cross_task_is_idempotent() -> None:
    context = _context()
    original = _original()

    with ReviewStoreV2(":memory:") as store:
        prepared = store.prepare_batch(context, [original], result_revision="run-1", job_id="job-1")
        context_key = prepared["context_key"]
        store.connection.execute(
            """
            INSERT INTO review_context_owners_v2 (context_key, owner_kind, owner_id)
            VALUES (?, 'legacy', 'unknown')
            """,
            (context_key,),
        )
        store.connection.commit()
        before = store.batch_ownership(context_key, "job-1")
        released = store.release_batch_owner(
            context_key,
            "job-1",
            "cleanup-1",
            True,
            before["fingerprint"],
        )
        assert released["outcome"] == "released_shared"
        assert _owners(store, context_key) == [("legacy", "unknown")]
        assert store.batch_ownership(context_key, "job-1")["record_count"] == 0


def test_release_rolls_back_when_owner_delete_fails() -> None:
    context = _context()
    original = _original()

    with ReviewStoreV2(":memory:") as store:
        prepared = store.prepare_batch(context, [original], result_revision="run-1", job_id="job-1")
        context_key = prepared["context_key"]
        before = store.batch_ownership(context_key, "job-1")
        store.connection.execute(
            """
            CREATE TRIGGER fail_review_owner_delete
            BEFORE DELETE ON review_context_owners_v2
            BEGIN
                SELECT RAISE(ABORT, 'synthetic owner delete failure');
            END
            """
        )
        store.connection.commit()

        with pytest.raises(sqlite3.IntegrityError, match="synthetic owner delete failure"):
            store.release_batch_owner(
                context_key,
                "job-1",
                "cleanup-1",
                True,
                before["fingerprint"],
            )

        assert _owners(store, context_key) == [("batch", "job-1")]
        assert store.connection.execute(
            "SELECT COUNT(*) AS count FROM review_contexts_v2 WHERE context_key = ?",
            (context_key,),
        ).fetchone()["count"] == 1


def test_shared_cleanup_receipt_survives_reopen_and_later_saves(tmp_path):
    database = tmp_path / "review.sqlite3"
    with ReviewStoreV2(database) as store:
        key = store.prepare_batch(_context(), [_original()], result_revision="run-1", job_id="job-1")["context_key"]
        store.prepare_batch(_context(), [_original()], result_revision="run-1", job_id="job-2")
        before = store.batch_ownership(key, "job-1")
        result = store.release_batch_owner(key, "job-1", "cleanup-1", True, before["fingerprint"])
        assert result["outcome"] == "released_shared"
        store.save(key, "run-1", [_segment(key, "run-1")], confirm_group=False)
    with ReviewStoreV2(database) as reopened:
        repeated = reopened.release_batch_owner(key, "job-1", "cleanup-1", True, before["fingerprint"])
        assert repeated["outcome"] == "already_released"
        assert repeated["original_outcome"] == "released_shared"
        assert reopened.batch_ownership(key, "job-2")["record_count"] == 1
        with pytest.raises(ReviewStoreError, match="different request"):
            reopened.release_batch_owner(key, "job-1", "cleanup-1", False, before["fingerprint"])


@pytest.mark.parametrize("corruption", ["descriptor", "manifest", "source_key", "sha", "path"])
def test_cleanup_rejects_corrupt_manifest_and_all_historical_source_bindings(corruption):
    with ReviewStoreV2(":memory:") as store:
        key = store.prepare_batch(_context(), [_original()], result_revision="run-1", job_id="job-1")["context_key"]
        store.save(key, "run-1", [_segment(key, "run-1")], confirm_group=False)
        before = store.batch_ownership(key, "job-1")
        statements = {
            "descriptor": ("UPDATE review_contexts_v2 SET descriptor_json = ? WHERE context_key = ?", "{}"),
            "manifest": ("UPDATE review_contexts_v2 SET manifest_json = ? WHERE context_key = ?", "[]"),
            "source_key": ("UPDATE review_segments_v2 SET source_key = ? WHERE context_key = ?", "/foreign/unrelated.pdf"),
            "sha": ("UPDATE review_segments_v2 SET source_sha256 = ? WHERE context_key = ?", "b" * 64),
            "path": ("UPDATE review_segments_v2 SET source_path = ? WHERE context_key = ?", "/foreign/unrelated.pdf"),
        }
        statement, value = statements[corruption]
        store.connection.execute(statement, (value, key))
        store.connection.commit()
        with pytest.raises(ReviewStoreCorruptionError):
            store.release_batch_owner(key, "job-1", "cleanup-1", True, before["fingerprint"])
        assert store.connection.execute("SELECT COUNT(*) FROM review_segments_v2 WHERE context_key = ?", (key,)).fetchone()[0] == 1


def test_receipt_write_failure_rolls_back_exclusive_deletion():
    with ReviewStoreV2(":memory:") as store:
        key = store.prepare_batch(_context(), [_original()], result_revision="run-1", job_id="job-1")["context_key"]
        before = store.batch_ownership(key, "job-1")
        store.connection.execute("""CREATE TRIGGER fail_receipt BEFORE INSERT ON review_cleanup_receipts_v2
            BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END""")
        store.connection.commit()
        with pytest.raises(sqlite3.IntegrityError, match="receipt failure"):
            store.release_batch_owner(key, "job-1", "cleanup-1", True, before["fingerprint"])
        assert store.batch_ownership(key, "job-1")["exclusive"]
