"""One cross-process batch, review, and cleanup workflow regression."""

from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
from pathlib import Path

from engine.batch_api import handle_batch_request
from engine.batch_store import BatchStore
from engine.computation import current_computation_version
from engine.engine import handle_request
from engine.review_store_v2 import ReviewStoreV2

from tests.test_batch_worker import create_task, drain, send, worker


def test_real_worker_review_and_cleanup_workflow_preserves_original(tmp_path: Path) -> None:
    """Pause/resume a real worker, save review data, then retain it on cleanup."""

    database, started = create_task(tmp_path, pages=40)
    source_path = Path(str(started["sources"][0]["access_path"]))  # type: ignore[index]
    original_sha = sha256(source_path.read_bytes()).hexdigest()

    # Reuse the worker test's stable page_settled synchronization so the
    # process exits after a real pause rather than relying on timing sleeps.
    with worker(tmp_path, database, started) as (process, events):
        paused_events = []
        while True:
            frame = events.get(timeout=20)
            assert isinstance(frame, dict)
            paused_events.append(frame)
            if frame["payload"].get("phase") == "page_settled":
                send(process, started)
                break
        paused_events.extend(drain(events))
        assert process.wait(timeout=10) == 0, process.stderr.read().decode()
        assert paused_events[-1]["type"] == "completed"
        assert paused_events[-1]["payload"]["state"] == "paused"

    with BatchStore(database) as store:
        paused = store.get_job(started["id"])
        completed_pages = paused["page_summary"]["succeeded"]
        assert 0 < completed_pages < 40
        resumed = store.start_job(
            started["id"],
            paused["generation"],
            "host",
            current_computation_version(),
        )

    with worker(tmp_path, database, resumed) as (process, events):
        resumed_events = drain(events)
        assert process.wait(timeout=10) == 0, process.stderr.read().decode()
        assert resumed_events[-1]["type"] == "completed"
        assert resumed_events[-1]["payload"]["state"] == "ready_for_review"
        computed_pages = [
            frame["payload"]["page"]
            for frame in resumed_events
            if frame["payload"].get("phase") == "unit_start"
            and frame["payload"].get("stage") == "page"
        ]
        assert computed_pages == list(range(completed_pages + 1, 41))

    with BatchStore(database) as store:
        ready = store.get_job(started["id"])
        results = store.results_page(ready["id"], ready["result_revision"])
    assert results["items"]

    review_path = tmp_path / "review.sqlite3"
    prepared_response = handle_batch_request(
        {
            "op": "batch_prepare_review",
            "database_path": str(database),
            "review_database_path": str(review_path),
            "job_id": ready["id"],
            "result_revision": ready["result_revision"],
        }
    )
    assert prepared_response["status"] == "ok", prepared_response
    prepared_data = prepared_response["data"]
    context = prepared_data["context"]
    context_key = prepared_data["prepared"]["context_key"]

    # Save one real result item through the engine's v2 review API.  The
    # worker's snapshot is the source of the segment and immutable identity.
    item = results["items"][0]
    segment = deepcopy(item["segment"])
    for field in ("slot", "snap_points"):
        segment.pop(field, None)
    segment.update(
        task_id=ready["id"],
        context_key=context_key,
        result_revision=ready["result_revision"],
        record_revision=0,
        analysis_signature=item["original"]["analysis_signature"],
        review_status="confirmed",
        reviewed_at="2026-09-08T12:00:00Z",
    )
    segment["source_path"] = context["sources"][0]["source_path"]
    saved = handle_request(
        {
            "op": "save_review_segments_v2",
            "database_path": str(review_path),
            "context_key": context_key,
            "result_revision": ready["result_revision"],
            "segments": [segment],
            "confirm_group": False,
        }
    )
    assert saved["status"] == "ok", saved
    assert saved["saved_count"] == 1

    planned_response = handle_batch_request(
        {
            "op": "batch_cleanup_plan",
            "database_path": str(database),
            "review_database_path": str(review_path),
            "job_id": ready["id"],
        }
    )
    assert planned_response["status"] == "ok", planned_response
    plan = planned_response["data"]
    assert plan["review_record_count"] == 1
    assert plan["review_exclusive"] is True
    assert plan["delete_review"] is None

    # The default is to delete task data while retaining user review history.
    executed_response = handle_batch_request(
        {
            "op": "batch_cleanup_execute",
            "database_path": str(database),
            "review_database_path": str(review_path),
            "cleanup_id": plan["cleanup_id"],
            "delete_review": False,
        }
    )
    assert executed_response["status"] == "ok", executed_response
    executed = executed_response["data"]
    assert executed["task_data_state"] == "deleted"
    assert executed["review_state"] == "retained"
    assert executed["preview_state"] == "absent"
    assert executed["outcome"] == "completed"

    with BatchStore(database) as store:
        assert store.connection.execute(
            "SELECT COUNT(*) FROM batch_jobs WHERE id = ?", (ready["id"],)
        ).fetchone()[0] == 0
        history = store.connection.execute(
            "SELECT task_data_state, review_state, preview_state FROM batch_cleanup WHERE id = ?",
            (plan["cleanup_id"],),
        ).fetchone()
        assert tuple(history) == ("deleted", "retained", "absent")

    with ReviewStoreV2(review_path) as reviews:
        ownership = reviews.batch_ownership(context_key, ready["id"])
        assert ownership["record_count"] == 1
        assert ownership["owned_by_job"] is False

    assert sha256(source_path.read_bytes()).hexdigest() == original_sha
