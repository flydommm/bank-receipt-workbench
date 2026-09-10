from __future__ import annotations

from pathlib import Path
import sqlite3

from engine.batch_api import handle_batch_request
from engine.batch_store import BatchStore


def _request(database: Path, op: str, **data: object) -> dict[str, object]:
    return handle_batch_request({"op": op, "database_path": str(database), **data})


def _create_job(database: Path) -> dict[str, object]:
    response = _request(
        database,
        "batch_create",
        name="API cleanup",
        sources=[{"source_path": "/docs/api.pdf", "name": "api.pdf"}],
        criteria={"include": ["needle"], "exclude": []},
        match_mode="exact",
    )
    assert response["status"] == "ok"
    return response["data"]  # type: ignore[return-value]


def test_cleanup_plan_execute_and_list_are_compact_enveloped_operations(tmp_path: Path) -> None:
    batch_path = tmp_path / "batch.sqlite3"
    review_path = tmp_path / "review.sqlite3"
    job = _create_job(batch_path)
    job_id = str(job["id"])

    planned = _request(
        batch_path,
        "batch_cleanup_plan",
        job_id=job_id,
        review_database_path=str(review_path),
    )
    assert planned["status"] == "ok"
    plan = planned["data"]
    assert set(plan) == {
        "cleanup_id",
        "job_id",
        "job_name",
        "source_count",
        "page_result_count",
        "review_record_count",
        "review_exclusive",
        "preview_count",
        "delete_review",
        "task_data_state",
        "review_state",
        "preview_state",
        "outcome",
        "created_at",
        "updated_at",
        "notice_codes",
    }
    assert plan["delete_review"] is None
    assert plan["preview_count"] == 0
    assert plan["outcome"] == "pending"

    executed = _request(
        batch_path,
        "batch_cleanup_execute",
        cleanup_id=plan["cleanup_id"],
        delete_review=True,
        review_database_path=str(review_path),
    )
    assert executed["status"] == "ok"
    result = executed["data"]
    assert result["delete_review"] is True
    assert result["task_data_state"] == "deleted"
    assert result["review_state"] == "absent"
    assert result["preview_state"] == "absent"
    assert result["outcome"] == "completed"
    assert result["notice_codes"] == []

    listed = _request(batch_path, "batch_cleanup_list", offset=0, limit=20)
    assert listed["status"] == "ok"
    assert listed["data"]["next_offset"] is None  # type: ignore[index]
    assert listed["data"]["items"][0]["cleanup_id"] == plan["cleanup_id"]  # type: ignore[index]


def test_cleanup_api_has_strict_fields_and_maps_state_conflict(tmp_path: Path) -> None:
    batch_path = tmp_path / "batch.sqlite3"
    review_path = tmp_path / "review.sqlite3"
    job = _create_job(batch_path)
    job_id = str(job["id"])
    with BatchStore(batch_path) as store:
        store.connection.execute("UPDATE batch_jobs SET state = 'running' WHERE id = ?", (job_id,))

    active = _request(
        batch_path,
        "batch_cleanup_plan",
        job_id=job_id,
        review_database_path=str(review_path),
    )
    assert active == {
        "status": "error",
        "code": "batch_conflict",
        "message": "任务状态已变化，请刷新后重试",
    }

    extra = _request(
        batch_path,
        "batch_storage_usage",
        unexpected=True,
    )
    assert extra["status"] == "error"
    assert extra["code"] == "batch_invalid_request"

    invalid_path = _request(
        batch_path,
        "batch_cleanup_plan",
        job_id=job_id,
        review_database_path=str(batch_path),
    )
    assert invalid_path["status"] == "error"
    assert invalid_path["code"] == "batch_invalid_request"


def test_cleanup_list_limit_and_storage_maintenance_api(tmp_path: Path) -> None:
    batch_path = tmp_path / "batch.sqlite3"
    review_path = tmp_path / "review.sqlite3"
    job = _create_job(batch_path)
    job_id = str(job["id"])
    bad_limit = _request(batch_path, "batch_cleanup_list", offset=0, limit=21)
    assert bad_limit["status"] == "error"
    assert bad_limit["code"] == "batch_invalid_request"

    usage = _request(batch_path, "batch_storage_usage")
    assert usage["status"] == "ok"
    usage_data = usage["data"]
    assert set(usage_data) == {
        "database_bytes",
        "wal_bytes",
        "shm_bytes",
        "total_bytes",
        "quota_bytes",
        "within_quota",
        "available",
    }
    assert usage_data["available"] is True
    assert usage_data["database_bytes"] >= 0

    planned = _request(
        batch_path,
        "batch_cleanup_plan",
        job_id=job_id,
        review_database_path=str(review_path),
    )
    assert planned["status"] == "ok"
    maintained = _request(batch_path, "batch_storage_maintain")
    assert maintained["status"] == "ok"
    assert maintained["data"]["outcome"] == "completed"  # type: ignore[index]


def test_storage_maintenance_reports_active_job_without_running_vacuum(tmp_path: Path) -> None:
    batch_path = tmp_path / "batch.sqlite3"
    job = _create_job(batch_path)
    with BatchStore(batch_path) as store:
        store.connection.execute("UPDATE batch_jobs SET state = 'running' WHERE id = ?", (job["id"],))
    response = _request(batch_path, "batch_storage_maintain")
    assert response["status"] == "ok"
    assert response["data"]["outcome"] == "failed"  # type: ignore[index]
    assert set(response["data"]) == {"outcome", "usage"}  # type: ignore[arg-type]


def test_storage_maintenance_reports_busy_checkpoint_and_retries_after_reader_release(
    tmp_path: Path,
) -> None:
    batch_path = tmp_path / "batch.sqlite3"
    writer = BatchStore(batch_path)
    reader = sqlite3.connect(batch_path, isolation_level=None)
    try:
        reader.execute("BEGIN")
        reader.execute("SELECT COUNT(*) FROM batch_jobs").fetchone()
        writer.create_job(
            "checkpoint busy",
            [{"source_path": "/docs/checkpoint.pdf", "name": "checkpoint.pdf"}],
            {"include": ["needle"], "exclude": []},
            "exact",
            "engine-schema-v2",
        )
        writer.close()
        writer = None  # type: ignore[assignment]

        busy = _request(batch_path, "batch_storage_maintain")
        assert busy["status"] == "ok"
        assert set(busy["data"]) == {"outcome", "usage"}  # type: ignore[arg-type]
        assert busy["data"]["outcome"] == "failed"  # type: ignore[index]

        reader.rollback()
        released = _request(batch_path, "batch_storage_maintain")
        assert released["status"] == "ok"
        assert set(released["data"]) == {"outcome", "usage"}  # type: ignore[arg-type]
        assert released["data"]["outcome"] == "completed"  # type: ignore[index]
    finally:
        reader.rollback()
        reader.close()
        if writer is not None:
            writer.close()
