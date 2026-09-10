from __future__ import annotations

from pathlib import Path

import pytest

from engine.queue import PageQueue, QueueLimits


def test_queue_persists_page_checkpoints_and_resumes(tmp_path: Path) -> None:
    checkpoint = tmp_path / "task.json"
    queue = PageQueue(checkpoint)
    queue.add_many([{"page": 1}, {"page": 2}, {"page": 3}])
    calls: list[int] = []
    queue.pause()
    assert queue.run(lambda payload: calls.append(payload["page"])) == []
    queue.resume()
    queue.run(lambda payload: calls.append(payload["page"]))
    assert calls == [1, 2, 3]
    resumed = PageQueue(checkpoint)
    assert resumed.summary()["completed"] == 3


def test_failed_item_does_not_block_other_items_and_can_retry(tmp_path: Path) -> None:
    queue = PageQueue(tmp_path / "task.json", max_retries=2)
    queue.add_many([{"page": 1}, {"page": 2}, {"page": 3}])
    failed_once = {2}

    def handler(payload: dict[str, int]) -> None:
        if payload["page"] in failed_once:
            failed_once.remove(payload["page"])
            raise RuntimeError("temporary failure")

    queue.run(handler)
    assert queue.summary()["failed"] == 1
    assert queue.summary()["completed"] == 2
    assert len(queue.retry_failed()) == 1
    queue.run(handler)
    assert queue.summary()["completed"] == 3


def test_queue_processes_bounded_chunks_and_rejects_unbounded_import(tmp_path: Path) -> None:
    queue = PageQueue(tmp_path / "task.json", limits=QueueLimits(max_items_per_run=2, max_pending_items=3))
    queue.add_many([{"page": 1}, {"page": 2}, {"page": 3}])
    with pytest.raises(ValueError, match="max_pending_items"):
        queue.add({"page": 4})
    calls: list[int] = []
    queue.run(lambda payload: calls.append(payload["page"]))
    assert calls == [1, 2]
    queue.run(lambda payload: calls.append(payload["page"]))
    assert calls == [1, 2, 3]


def test_queue_handles_over_5000_pages_in_bounded_runs(tmp_path: Path) -> None:
    queue = PageQueue(tmp_path / "large-task.json", limits=QueueLimits(max_items_per_run=125, max_pending_items=6_000))
    queue.add_many({"page": page} for page in range(1, 5_002))
    processed: list[int] = []
    queue.run(lambda payload: processed.append(payload["page"]))
    assert len(processed) == 125
    assert queue.summary()["pending"] == 4_876
