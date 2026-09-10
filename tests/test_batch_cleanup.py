from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3

import pytest

from engine import batch_cleanup as cleanup_module
from engine.batch_cleanup import (
    BatchCleanupConflict,
    BatchCleanupError,
    execute_cleanup,
    list_cleanups,
    plan_cleanup,
    storage_maintain,
    storage_usage,
)
from engine.batch_models import canonical_json
from engine.batch_store import BatchConflict, BatchStore
from engine.review_store_v2 import ReviewStoreV2


SHA_A = "a" * 64
FINGERPRINT_A = "1" * 64


def _rect(x0: float = 10, y0: float = 20, x1: float = 30, y1: float = 40) -> dict[str, float]:
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _original(source_key: str) -> dict[str, object]:
    return {
        "id": "segment-1",
        "source_key": source_key,
        "source_page": 1,
        "segment_no": 1,
        "analysis_signature": FINGERPRINT_A,
        "persistable": True,
        "page_width": 600,
        "page_height": 800,
        "match_rect": _rect(),
        "candidate_rect": _rect(0, 0, 600, 250),
        "layout_fingerprint": "layout:v1",
        "confidence": 0.95,
        "auto_full_page": False,
    }


def _record(
    context: dict[str, object],
    original: dict[str, object],
    *,
    context_key: str,
    result_revision: str,
) -> dict[str, object]:
    source_key = str(original["source_key"])
    source_sha = next(
        source["source_sha256"]
        for source in context["sources"]  # type: ignore[index]
        if source["source_key"] == source_key  # type: ignore[index]
    )
    return {
        "id": original["id"],
        "task_id": "task-1",
        "source_path": source_key,
        "source_sha256": source_sha,
        "source_page": original["source_page"],
        "segment_no": original["segment_no"],
        "match_rect": original["match_rect"],
        "candidate_rect": original["candidate_rect"],
        "final_rect": _rect(0, 2, 600, 248),
        "layout_fingerprint": original["layout_fingerprint"],
        "confidence": original["confidence"],
        "crop_mode": "manual",
        "review_status": "confirmed",
        "manual_adjusted": True,
        "reviewed_at": "2026-09-08T06:20:00.000Z",
        "context_key": context_key,
        "source_key": source_key,
        "analysis_signature": original["analysis_signature"],
        "result_revision": result_revision,
        "record_revision": 0,
        "page_width": original["page_width"],
        "page_height": original["page_height"],
    }


def _make_job(
    store: BatchStore,
    *,
    path: str = "/docs/report.pdf",
    state: str = "ready_for_review",
    page_count: int = 2,
    with_snapshot: bool = True,
) -> tuple[dict[str, object], dict[str, object] | None]:
    job = store.create_job(
        "report search",
        [{"source_path": path, "name": "report.pdf"}],
        {"include": ["needle"], "exclude": []},
        "exact",
        "engine-schema-v2",
    )
    job_id = str(job["id"])
    source = job["sources"][0]  # type: ignore[index]
    source_id = str(source["source_id"])
    source_key = str(source["source_key"])
    result_revision = "run-1"
    store.connection.execute(
        """
        UPDATE batch_jobs
           SET state = ?, generation = 1, result_revision = ?
         WHERE id = ?
        """,
        (state, result_revision if with_snapshot else None, job_id),
    )
    store.connection.execute(
        """
        UPDATE batch_sources
           SET sha256 = ?, size_bytes = 123, page_count = ?, state = 'verified'
         WHERE job_id = ? AND source_id = ?
        """,
        (SHA_A, page_count, job_id, source_id),
    )
    for page in range(1, page_count + 1):
        store.connection.execute(
            """
            INSERT INTO batch_pages (
                job_id, source_id, page, stage, state, owner, generation,
                attempt, error_json, budget_json
            ) VALUES (?, ?, ?, 'page', 'succeeded', NULL, 1, 1, NULL, '{}')
            """,
            (job_id, source_id, page),
        )
    if not with_snapshot:
        return store.get_job(job_id), None
    context: dict[str, object] = {
        "version": 2,
        "sources": [{
            "source_key": source_key,
            "source_path": path,
            "source_sha256": SHA_A,
        }],
        "criteria_fingerprint": str(job["criteria_fingerprint"]),
        "computation_version": "engine-schema-v2",
    }
    store.connection.execute(
        """
        INSERT INTO batch_snapshots (
            job_id, result_revision, schema, source_summary_json, context_json,
            originals_count, originals_digest, source_count, item_count, created_at
        ) VALUES (?, ?, 1, ?, ?, 1, ?, 1, 1, '2026-09-08T06:00:00.000Z')
        """,
        (
            job_id,
            result_revision,
            canonical_json([{"source_key": source_key, "page_count": page_count}]).decode(),
            canonical_json(context).decode(),
            hashlib.sha256(canonical_json(_original(source_key))).hexdigest(),
        ),
    )
    return store.get_job(job_id), context


def _prepare_review(
    review_path: Path,
    context: dict[str, object],
    job_id: str,
    *,
    owner: str = "batch",
    with_record: bool = False,
    save_record: bool = True,
) -> str:
    original = _original(str(context["sources"][0]["source_key"]))  # type: ignore[index]
    with ReviewStoreV2(review_path) as review:
        if owner == "batch":
            prepared = review.prepare_batch(
                context,
                [original] if with_record else [],
                result_revision="run-1",
                job_id=job_id,
            )
        else:
            prepared = review.prepare(
                context,
                [original] if with_record else [],
                result_revision="run-1",
            )
        context_key = str(prepared["context_key"])
        if with_record and save_record:
            review.save(
                context_key,
                "run-1",
                [_record(context, original, context_key=context_key, result_revision="run-1")],
                confirm_group=False,
            )
        return context_key


def test_plan_binds_snapshot_counts_and_does_not_mark_deletion_pending(tmp_path: Path) -> None:
    store = BatchStore(":memory:")
    try:
        job, context = _make_job(store)
        assert context is not None
        plan = plan_cleanup(
            store,
            tmp_path / "review.sqlite3",
            job["id"],
            [{"path": str(tmp_path / "preview.pdf"), "size_bytes": 20, "sha256": SHA_A}],
        )

        assert plan["task_data_state"] == "pending"
        assert plan["review_state"] == "pending"
        assert plan["preview_state"] == "pending"
        assert plan["scope"]["counts"] == {  # type: ignore[index]
            "source_count": 1,
            "page_count": 2,
            "pending_pages": 0,
            "processing_pages": 0,
            "succeeded_pages": 2,
            "failed_pages": 0,
            "page_result_count": 0,
            "review_item_count": 1,
        }
        assert store.connection.execute(
            "SELECT deletion_pending FROM batch_jobs WHERE id = ?", (job["id"],)
        ).fetchone()[0] == 0
        assert plan["scope"]["job"]["snapshot_digest"]  # type: ignore[index]
        assert "items" not in plan["scope"]
        listed = list_cleanups(store, job["id"])
        assert listed[0]["preview_count"] == 1
        assert "preview_identities" not in listed[0]
    finally:
        store.close()


def test_exclusive_cleanup_deletes_job_and_review_without_touching_original(tmp_path: Path) -> None:
    review_path = tmp_path / "review.sqlite3"
    source_path = tmp_path / "original.pdf"
    source_path.write_bytes(b"immutable original")
    before = source_path.read_bytes()
    store = BatchStore(":memory:")
    try:
        job, context = _make_job(store, path=str(source_path))
        assert context is not None
        context_key = _prepare_review(review_path, context, str(job["id"]), with_record=True)
        plan = plan_cleanup(store, review_path, job["id"], [])
        result = execute_cleanup(store, review_path, plan["id"], True, lambda _: {"state": "absent"})

        assert result["outcome"] == "completed"
        assert result["task_data_state"] == "deleted"
        assert result["review_state"] == "deleted"
        assert result["preview_state"] == "absent"
        assert store.connection.execute(
            "SELECT COUNT(*) FROM batch_jobs WHERE id = ?", (job["id"],)
        ).fetchone()[0] == 0
        with ReviewStoreV2(review_path) as review:
            assert review.batch_ownership(context_key, str(job["id"]))["outcome"] == "already_absent"
        assert source_path.read_bytes() == before
        assert list_cleanups(store, job["id"])[0]["outcome"] == "completed"
    finally:
        store.close()


def test_shared_context_is_retained_even_when_delete_requested(tmp_path: Path) -> None:
    review_path = tmp_path / "review.sqlite3"
    store = BatchStore(":memory:")
    try:
        first, context = _make_job(store)
        second, second_context = _make_job(store)
        assert context is not None and second_context is not None
        first_context_key = _prepare_review(review_path, context, str(first["id"]), with_record=True)
        second_context_key = _prepare_review(
            review_path,
            second_context,
            str(second["id"]),
            with_record=True,
            save_record=False,
        )
        assert first_context_key == second_context_key
        plan = plan_cleanup(store, review_path, first["id"], [])
        result = execute_cleanup(store, review_path, plan["id"], True, lambda _: {"state": "absent"})

        assert result["task_data_state"] == "deleted"
        assert result["review_state"] == "retained"
        assert result["residual"]
        assert store.connection.execute(
            "SELECT COUNT(*) FROM batch_jobs WHERE id = ?", (second["id"],)
        ).fetchone()[0] == 1
        with ReviewStoreV2(review_path) as review:
            ownership = review.batch_ownership(second_context_key, str(second["id"]))
            assert ownership["owned_by_job"] is True
            assert ownership["record_count"] == 1
    finally:
        store.close()


def test_default_retention_and_delete_review_choice_are_durable(tmp_path: Path) -> None:
    review_path = tmp_path / "review.sqlite3"
    store = BatchStore(":memory:")
    try:
        job, context = _make_job(store)
        assert context is not None
        context_key = _prepare_review(review_path, context, str(job["id"]), with_record=True)
        plan = plan_cleanup(store, review_path, job["id"], [])
        retained = execute_cleanup(store, review_path, plan["id"], False, lambda _: {"state": "absent"})
        assert retained["outcome"] == "completed"
        assert retained["review_state"] == "retained"
        with pytest.raises(BatchCleanupConflict, match="delete_review"):
            execute_cleanup(store, review_path, plan["id"], True, lambda _: {"state": "absent"})
        with ReviewStoreV2(review_path) as review:
            ownership = review.batch_ownership(context_key, str(job["id"]))
            assert ownership["outcome"] == "ok"
            assert ownership["record_count"] == 1
            assert ownership["owned_by_job"] is False
            assert ownership["owner_count"] == 1
    finally:
        store.close()


def test_public_unknown_review_owner_is_conservatively_retained(tmp_path: Path) -> None:
    review_path = tmp_path / "review.sqlite3"
    store = BatchStore(":memory:")
    try:
        job, context = _make_job(store)
        assert context is not None
        context_key = _prepare_review(review_path, context, str(job["id"]), owner="legacy", with_record=True)
        plan = plan_cleanup(store, review_path, job["id"], [])
        assert plan["scope"]["review"]["owned_by_job"] is False  # type: ignore[index]
        result = execute_cleanup(store, review_path, plan["id"], True, lambda _: {"state": "absent"})
        assert result["review_state"] == "retained"
        with ReviewStoreV2(review_path) as review:
            ownership = review.batch_ownership(context_key, str(job["id"]))
            assert ownership["record_count"] == 1
    finally:
        store.close()


def test_other_job_snapshot_without_review_owner_forces_retention(tmp_path: Path) -> None:
    review_path = tmp_path / "review.sqlite3"
    store = BatchStore(":memory:")
    try:
        first, context = _make_job(store)
        second, second_context = _make_job(store)
        assert context is not None and second_context is not None
        context_key = _prepare_review(review_path, context, str(first["id"]), with_record=True)
        # Both batch snapshots have the same context identity, but only the
        # first job is registered in ReviewStoreV2 as an owner.
        assert context_key == _prepare_review(
            review_path,
            second_context,
            str(second["id"]),
            with_record=True,
            save_record=False,
        )
        with ReviewStoreV2(review_path) as review:
            with review.database.transaction() as connection:
                connection.execute(
                    "DELETE FROM review_context_owners_v2 WHERE context_key = ? AND owner_kind = 'batch' AND owner_id = ?",
                    (context_key, second["id"]),
                )
        plan = plan_cleanup(store, review_path, first["id"], [])
        result = execute_cleanup(store, review_path, plan["id"], True, lambda _: {"state": "absent"})
        assert result["review_state"] == "retained"
        assert any(item["kind"] == "review" for item in result["residual"])
    finally:
        store.close()


@pytest.mark.parametrize("damage_before_plan", [True, False])
def test_missing_other_published_snapshot_keeps_shared_review(tmp_path: Path, damage_before_plan: bool) -> None:
    review_path = tmp_path / "review.sqlite3"
    with BatchStore(":memory:") as store:
        first, context = _make_job(store)
        second, _ = _make_job(store)
        assert context is not None
        key = _prepare_review(review_path, context, str(first["id"]), with_record=True)
        if not damage_before_plan:
            plan = plan_cleanup(store, review_path, first["id"], [])
        with store._transaction() as connection:
            connection.execute("DELETE FROM batch_snapshots WHERE job_id = ?", (second["id"],))
        if damage_before_plan:
            plan = plan_cleanup(store, review_path, first["id"], [])
            assert plan["scope"]["review"]["other_reference_unknown"] is True
        result = execute_cleanup(store, review_path, plan["id"], True, lambda _: {"state": "absent"})
        assert result["review_state"] == "retained"
        assert store.get_job(second["id"])["result_revision"] == "run-1"
        with ReviewStoreV2(review_path) as reviews:
            assert reviews.batch_ownership(key, str(second["id"]))["record_count"] == 1


def test_active_and_stale_plans_are_rejected_and_pending_missing_job_fails_closed(tmp_path: Path) -> None:
    review_path = tmp_path / "review.sqlite3"
    store = BatchStore(":memory:")
    try:
        job, context = _make_job(store)
        assert context is not None
        plan = plan_cleanup(store, review_path, job["id"], [])
        store.connection.execute("UPDATE batch_jobs SET state = 'running' WHERE id = ?", (job["id"],))
        with pytest.raises(BatchCleanupConflict, match="active"):
            execute_cleanup(store, review_path, plan["id"], True, lambda _: {"state": "absent"})
        store.connection.execute("UPDATE batch_jobs SET state = 'ready_for_review' WHERE id = ?", (job["id"],))
        store.connection.execute("DELETE FROM batch_jobs WHERE id = ?", (job["id"],))
        with pytest.raises(BatchCleanupConflict, match="cannot be started"):
            execute_cleanup(store, review_path, plan["id"], True, lambda _: {"state": "absent"})
    finally:
        store.close()


def test_preview_failure_is_retryable_after_reopen_and_cleanup_log_survives(tmp_path: Path) -> None:
    batch_path = tmp_path / "batch.sqlite3"
    review_path = tmp_path / "review.sqlite3"
    store = BatchStore(batch_path)
    job, context = _make_job(store)
    assert context is not None
    _prepare_review(review_path, context, str(job["id"]), with_record=True)
    plan = plan_cleanup(
        store,
        review_path,
        job["id"],
        [{"path": str(tmp_path / "preview.pdf"), "token": "trusted-token"}],
    )

    def fail(_: list[dict[str, object]]) -> dict[str, object]:
        raise RuntimeError("preview process exited")

    first = execute_cleanup(store, review_path, plan["id"], True, fail)
    assert first["task_data_state"] == "deleted"
    assert first["review_state"] == "deleted"
    assert first["preview_state"] == "residual"
    assert first["outcome"] == "pending"
    store.close()

    reopened = BatchStore(batch_path)
    try:
        assert list_cleanups(reopened)[0]["outcome"] == "pending"
        second = execute_cleanup(
            reopened,
            review_path,
            plan["id"],
            True,
            lambda identities: {"state": "cleaned", "count": len(identities)},
        )
        assert second["preview_state"] == "cleaned"
        assert second["outcome"] == "completed"
        assert reopened.connection.execute("SELECT COUNT(*) FROM batch_jobs").fetchone()[0] == 0
    finally:
        reopened.close()


def test_quota_exhaustion_does_not_block_small_cleanup_and_storage_usage_is_real(tmp_path: Path) -> None:
    batch_path = tmp_path / "batch.sqlite3"
    review_path = tmp_path / "review.sqlite3"
    store = BatchStore(batch_path)
    try:
        job, context = _make_job(store)
        assert context is not None
        _prepare_review(review_path, context, str(job["id"]))
        store.quota_bytes = 0
        plan = plan_cleanup(store, review_path, job["id"], [])
        result = execute_cleanup(store, review_path, plan["id"], True, lambda _: {"state": "absent"})
        assert result["outcome"] == "completed"
        usage = storage_usage(store)
        assert usage["database_bytes"] >= 0
        assert usage["wal_bytes"] >= 0
        assert usage["shm_bytes"] >= 0
        assert usage["total_bytes"] == usage["database_bytes"] + usage["wal_bytes"] + usage["shm_bytes"]
        assert usage["within_quota"] is False
    finally:
        store.close()


def test_cleanup_list_prioritizes_unfinished_and_is_bounded(tmp_path: Path) -> None:
    store = BatchStore(":memory:")
    try:
        job, context = _make_job(store)
        assert context is not None
        for _ in range(3):
            plan_cleanup(store, tmp_path / "review.sqlite3", job["id"], [])
        rows = list_cleanups(store, job["id"])
        assert len(rows) == 1
        assert all(row["outcome"] == "pending" for row in rows)
        # A direct journal read verifies that plan creation itself never set
        # the job deletion gate.
        assert store.connection.execute(
            "SELECT deletion_pending FROM batch_jobs WHERE id = ?", (job["id"],)
        ).fetchone()[0] == 0
    finally:
        store.close()


def test_plan_deduplication_preserves_started_cleanup_log(tmp_path: Path) -> None:
    store = BatchStore(":memory:")
    try:
        job, context = _make_job(store)
        assert context is not None
        first = plan_cleanup(store, tmp_path / "review.sqlite3", job["id"], [])
        scope = dict(first["scope"])  # type: ignore[arg-type]
        scope["started"] = True
        store.connection.execute(
            "UPDATE batch_cleanup SET scope_json = ? WHERE id = ?",
            (canonical_json(scope).decode(), first["id"]),
        )
        second = plan_cleanup(store, tmp_path / "review.sqlite3", job["id"], [])
        ids = [row["id"] for row in store.connection.execute(
            "SELECT id FROM batch_cleanup WHERE job_id = ? ORDER BY id",
            (job["id"],),
        ).fetchall()]
        assert first["id"] in ids
        assert second["id"] in ids
        assert len(ids) == 2
    finally:
        store.close()


def test_review_receipt_survives_batch_journal_rollback_and_replay(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    batch_path = tmp_path / "batch.sqlite3"
    review_path = tmp_path / "review.sqlite3"
    store = BatchStore(batch_path)
    try:
        job, context = _make_job(store)
        assert context is not None
        context_key = _prepare_review(review_path, context, str(job["id"]), with_record=True)
        plan = plan_cleanup(store, review_path, job["id"], [])
        original_set_state = cleanup_module._set_cleanup_state
        calls = {"count": 0}

        def fail_journal(*args: object, **kwargs: object) -> None:
            calls["count"] += 1
            if calls["count"] == 2:
                raise sqlite3.OperationalError("injected cleanup journal failure")
            original_set_state(*args, **kwargs)

        monkeypatch.setattr(cleanup_module, "_set_cleanup_state", fail_journal)
        with pytest.raises(sqlite3.OperationalError, match="journal failure"):
            execute_cleanup(store, review_path, plan["id"], False, lambda _: {"state": "absent"})
        # The start transaction committed the deletion gate.  The second
        # batch transaction rolled back after the independent review
        # transaction committed its retained receipt.
        assert store.connection.execute(
            "SELECT COUNT(*) FROM batch_jobs WHERE id = ?", (job["id"],)
        ).fetchone()[0] == 1
        assert store.connection.execute(
            "SELECT deletion_pending FROM batch_jobs WHERE id = ?", (job["id"],)
        ).fetchone()[0] == 1
        store.activate_supervisor("owner")
        with pytest.raises(BatchConflict, match="cleanup is pending"):
            store.start_job(job["id"], 0, "owner", "compute-v1")
        store.close()

        # A restart preserves the read-only gate and the pending cleanup log.
        store = BatchStore(batch_path)
        assert store.connection.execute(
            "SELECT deletion_pending FROM batch_jobs WHERE id = ?", (job["id"],)
        ).fetchone()[0] == 1
        with ReviewStoreV2(review_path) as review:
            ownership = review.batch_ownership(context_key, str(job["id"]))
            assert ownership["owned_by_job"] is False
            with review.database.transaction() as connection:
                connection.execute(
                    "UPDATE review_contexts_v2 SET updated_at = '2099-01-01T00:00:00.000Z' WHERE context_key = ?",
                    (context_key,),
                )
        monkeypatch.setattr(cleanup_module, "_set_cleanup_state", original_set_state)

        replay = execute_cleanup(store, review_path, plan["id"], False, lambda _: {"state": "absent"})
        assert replay["outcome"] == "completed"
        assert replay["task_data_state"] == "deleted"
        assert replay["review_state"] == "retained"
        with ReviewStoreV2(review_path) as review:
            receipt = review.connection.execute(
                "SELECT response_json FROM review_cleanup_receipts_v2 WHERE context_key = ? AND job_id = ? AND cleanup_id = ?",
                (context_key, job["id"], plan["id"]),
            ).fetchone()
            assert receipt is not None
            assert json.loads(receipt["response_json"])["outcome"] == "retained"
    finally:
        store.close()


def test_storage_usage_keeps_os_errors_unknown_instead_of_reporting_zero(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = BatchStore(tmp_path / "batch.sqlite3")
    try:
        def denied_stat(_path: Path) -> object:
            raise PermissionError("stat denied")

        monkeypatch.setattr(Path, "stat", denied_stat)
        usage = storage_usage(store)
        assert usage["database_bytes"] is None
        assert usage["wal_bytes"] is None
        assert usage["shm_bytes"] is None
        assert usage["total_bytes"] is None
        assert usage["within_quota"] is None
        assert usage["available"] is False
    finally:
        store.close()


def test_storage_maintenance_rejects_active_jobs_without_mutating_cleanup_logs() -> None:
    store = BatchStore(":memory:")
    try:
        job, _context = _make_job(store, state="running")
        result = storage_maintain(store)
        assert result["outcome"] == "failed"
        assert result["warning"] == "active_jobs"
        assert store.connection.execute(
            "SELECT COUNT(*) FROM batch_cleanup"
        ).fetchone()[0] == 0
        assert store.connection.execute(
            "SELECT state FROM batch_jobs WHERE id = ?", (job["id"],)
        ).fetchone()[0] == "running"
    finally:
        store.close()
