"""Page-oriented batch queue with pause, cancellation and retry support."""

from __future__ import annotations

from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Callable, Iterable
from uuid import uuid4

from .checkpoint import CheckpointStore


@dataclass
class WorkItem:
    id: str
    payload: dict[str, Any]
    status: str = "pending"
    retry_count: int = 0
    error: str | None = None


@dataclass(frozen=True)
class QueueLimits:
    """Safe defaults for large folders on ordinary office machines.

    ``max_items_per_run`` bounds one foreground batch so pause/cancel stays
    responsive. ``max_pending_items`` prevents an accidental folder import
    from retaining an unbounded in-memory queue. ``max_workers`` is recorded
    for the future parallel worker implementation and is intentionally capped
    at one today because PDF/OCR libraries are not all thread-safe.
    """

    max_items_per_run: int = 250
    max_pending_items: int = 10_000
    max_workers: int = 1


class PageQueue:
    def __init__(self, checkpoint_path: str | Path, *, max_retries: int = 1, limits: QueueLimits | None = None) -> None:
        self.checkpoint = CheckpointStore(checkpoint_path)
        self.max_retries = max_retries
        self.limits = limits or QueueLimits()
        if self.limits.max_items_per_run < 1 or self.limits.max_pending_items < 1 or self.limits.max_workers < 1:
            raise ValueError("queue limits must be positive")
        saved = self.checkpoint.load()
        self.items = [WorkItem(**item) for item in saved.get("items", [])]
        self.paused = bool(saved.get("paused", False))
        self.cancelled = bool(saved.get("cancelled", False))

    def _save(self) -> None:
        self.checkpoint.save({"items": [asdict(item) for item in self.items], "paused": self.paused, "cancelled": self.cancelled})

    def add(self, payload: dict[str, Any], item_id: str | None = None) -> WorkItem:
        if sum(item.status == "pending" for item in self.items) >= self.limits.max_pending_items:
            raise ValueError(f"queue exceeds max_pending_items={self.limits.max_pending_items}")
        item = WorkItem(item_id or str(uuid4()), dict(payload))
        self.items.append(item)
        self._save()
        return item

    def add_many(self, payloads: Iterable[dict[str, Any]]) -> list[WorkItem]:
        items = [WorkItem(str(uuid4()), dict(payload)) for payload in payloads]
        pending = sum(item.status == "pending" for item in self.items)
        if pending + len(items) > self.limits.max_pending_items:
            raise ValueError(f"queue exceeds max_pending_items={self.limits.max_pending_items}")
        self.items.extend(items)
        self._save()
        return items

    def pause(self) -> None:
        self.paused = True
        self._save()

    def resume(self) -> None:
        self.paused = False
        self.cancelled = False
        self._save()

    def cancel(self) -> None:
        self.cancelled = True
        self._save()

    def retry_failed(self) -> list[WorkItem]:
        retried: list[WorkItem] = []
        for item in self.items:
            if item.status == "failed" and item.retry_count < self.max_retries:
                item.status, item.error = "pending", None
                item.retry_count += 1
                retried.append(item)
        self._save()
        return retried

    def run(self, handler: Callable[[dict[str, Any]], None]) -> list[WorkItem]:
        completed: list[WorkItem] = []
        processed = 0
        for item in self.items:
            if self.paused or self.cancelled:
                break
            if processed >= self.limits.max_items_per_run:
                break
            if item.status != "pending":
                continue
            processed += 1
            item.status, item.error = "processing", None
            self._save()
            try:
                handler(item.payload)
            except Exception as error:  # one failed page must not stop the queue
                item.status, item.error = "failed", str(error)
            else:
                item.status = "completed"
                completed.append(item)
            self._save()
        return completed

    def summary(self) -> dict[str, int]:
        return {status: sum(item.status == status for item in self.items) for status in ("pending", "processing", "completed", "failed")}
