"""Serial page checkpoints with source validation and trusted final publication.

The supervisor owns process deadlines and forced termination.  This layer
checks durable controls at safe boundaries; it never kills a process or trusts
frontend result arrays.  Only the calling thread uses its BatchStore instance.
"""

from __future__ import annotations

from contextlib import ExitStack, contextmanager
from threading import Lock
from typing import Any, Callable, Iterator
from uuid import uuid4

from .batch_pdf import BatchSourceError, open_batch_source
from .batch_results import assemble_batch_results
from .batch_store import BatchCapacityExceeded, BatchConflict, BatchStore, BatchStoreError
from .ocr import OcrRuntimeError, OcrUnavailableError
from .search import SearchBudget, SearchBudgetExceeded


EventSink = Callable[[str, dict[str, Any]], Any]


class _Stopped(Exception):
    """A durable pause/cancel has won the race with the next work unit."""


def public_summary(job: dict[str, Any]) -> dict[str, Any]:
    """Small event payload; paths, text and the full source list use snapshots."""
    return {
        "state": job["state"], "page_summary": job["page_summary"],
        "total_pages": job["total_pages"], "source_count": len(job["sources"]),
        "failed_sources": sum(source["state"] in {"failed", "blocked"} for source in job["sources"]),
        "result_revision": job["result_revision"], "error": job["error"],
    }


class BatchProgress:
    """Track one immutable unit identity, shared only with heartbeat reading."""

    def __init__(self, emit: EventSink, check_health: Callable[[], None] | None = None) -> None:
        self.emit = emit
        self.check_health = check_health or (lambda: None)
        self._lock = Lock()
        self._unit: dict[str, Any] | None = None

    def current_unit(self) -> dict[str, Any] | None:
        with self._lock:
            return dict(self._unit) if self._unit is not None else None

    @contextmanager
    def unit(self, stage: str, source_id: str | None = None, page: int | None = None) -> Iterator[None]:
        value = {"unit_id": str(uuid4()), "stage": stage, "source_id": source_id, "page": page}
        with self._lock:
            if self._unit is not None:
                raise RuntimeError("batch work units cannot overlap")
            self._unit = value
        self.emit("progress", {"phase": "unit_start", **value})
        try:
            yield
        finally:
            with self._lock:
                self._unit = None
            self.emit("progress", {"phase": "unit_end", **value})


def _failure(error: Exception, stage: str) -> dict[str, str]:
    if isinstance(error, BatchSourceError):
        code = error.code
    elif isinstance(error, OcrRuntimeError):
        # OcrRuntimeError already carries one of the stable public OCR
        # categories.  Keep the persisted error limited to code/stage so a
        # backend exception (for example, a native oneDNN message) cannot
        # cross the batch protocol boundary.
        code = error.code
    elif isinstance(error, OcrUnavailableError):
        code = "ocr_unavailable"
    elif isinstance(error, SearchBudgetExceeded):
        code = "search_budget_exceeded"
    elif isinstance(error, BatchCapacityExceeded):
        code = "batch_capacity_exceeded"
    else:
        code = "batch_processing_failed"
    return {"code": code, "stage": stage}


class BatchProcessor:
    def __init__(
        self, store: BatchStore, job_id: str, generation: int, owner: str,
        computation_version: str, progress: BatchProgress,
    ) -> None:
        self.store = store
        self.job_id = job_id
        self.generation = generation
        self.owner = owner
        self.version = computation_version
        self.progress = progress

    def _job(self) -> dict[str, Any]:
        job = self.store.get_job(self.job_id)
        if job["generation"] != self.generation or job["owner"] != self.owner:
            raise BatchConflict("worker no longer owns this generation")
        return job

    def _transition(self, state: str, *, error: dict[str, str] | None = None) -> dict[str, Any]:
        job = self._checkpoint()
        result = self.store.transition(self.job_id, self.generation, self.owner, {job["state"]}, state, error=error)
        self.progress.emit("state_changed", public_summary(result))
        return result

    def _checkpoint(self) -> dict[str, Any]:
        self.progress.check_health()
        job = self._job()
        if job["state"] == "pause_requested":
            job = self.store.transition(self.job_id, self.generation, self.owner, {"pause_requested"}, "paused")
            self.progress.emit("state_changed", public_summary(job))
        if job["state"] in {"paused", "cancel_requested", "cancelled", "interrupted"} or job["deletion_pending"]:
            # A forced/cooperative cancellation is settled by the host only
            # after the worker and its pipes have actually stopped.
            raise _Stopped()
        return job

    def _source_failed(self, source_id: str, error: Exception, stage: str) -> dict[str, str]:
        self._checkpoint()
        failure = _failure(error, stage)
        self.store.fail_source(
            self.job_id, self.generation, self.owner, source_id, failure,
            blocked=isinstance(error, (OcrRuntimeError, OcrUnavailableError, SearchBudgetExceeded)) or
                   failure["code"] in {"source_changed", "search_budget_exceeded", "ocr_unavailable"},
        )
        self.progress.emit("page_failed", {"source_id": source_id, "page": None, "error": failure})
        return failure

    def _validate_sources(self) -> tuple[set[str], dict[str, str] | None]:
        valid = set()
        first_failure = None
        for source in self._job()["sources"]:
            self._checkpoint()
            try:
                with self.progress.unit("validating", source["source_id"]):
                    with open_batch_source(source["access_path"], source["sha256"]) as opened:
                        self._checkpoint()
                        self.store.register_source(self.job_id, self.generation, self.owner, source["source_id"],
                                                   opened.sha256, opened.size_bytes, opened.page_count)
                valid.add(source["source_id"])
            except _Stopped:
                raise
            except BatchStoreError:
                raise
            except Exception as error:
                failure = self._source_failed(source["source_id"], error, "validating")
                first_failure = first_failure or failure
        return valid, first_failure

    def _compute_source(self, source: dict[str, Any], criteria: dict[str, Any], mode: str) -> None:
        pending = self.store.pending_pages(self.job_id, source["source_id"])
        if not pending:
            return
        try:
            # Copy/hash/open has its own deadline, not a deadline for the
            # entire source.  The opened private PDF is reused across pages.
            with ExitStack() as resources:
                with self.progress.unit("source_open", source["source_id"]):
                    opened = resources.enter_context(open_batch_source(source["access_path"], source["sha256"], reuse_ocr=True))
                for page in pending:
                    self._checkpoint()
                    with self.progress.unit("page", source["source_id"], page):
                        claim = self.store.begin_page(self.job_id, self.generation, self.owner, source["source_id"], page)
                        budget = SearchBudget.from_dict(claim["budget"])
                        try:
                            payload = opened.compute_page(page, criteria, mode, budget)
                        except Exception as error:
                            # Settle known work even if OCR failed before
                            # search, or search hit a cumulative limit.
                            failure = _failure(error, "page")
                            self.store.fail_page(self.job_id, self.generation, self.owner, source["source_id"],
                                                 page, claim["attempt"], failure, budget=budget.to_dict())
                            self.progress.emit("page_failed", {"source_id": source["source_id"], "page": page, "error": failure})
                            if isinstance(error, (SearchBudgetExceeded, OcrRuntimeError, OcrUnavailableError)):
                                self._transition("blocked", error=failure)
                                raise _Stopped() from None
                        else:
                            try:
                                self.store.commit_page(self.job_id, self.generation, self.owner, source["source_id"],
                                                       page, claim["attempt"], payload, budget.to_dict())
                            except BatchCapacityExceeded as error:
                                self.store.fail_page(self.job_id, self.generation, self.owner, source["source_id"],
                                                     page, claim["attempt"], _failure(error, "storage"), budget=budget.to_dict())
                                raise
                    self.progress.emit("progress", {"phase": "page_settled", **public_summary(self._job())})
        except _Stopped:
            raise
        except BatchStoreError:
            raise
        except Exception as error:
            failure = self._source_failed(source["source_id"], error, "source_open")
            if isinstance(error, (SearchBudgetExceeded, OcrRuntimeError, OcrUnavailableError)):
                self._transition("blocked", error=failure)
                raise _Stopped() from None

    def _finalize(self) -> None:
        job = self._transition("finalizing")
        for source in job["sources"]:
            self._checkpoint()
            try:
                with self.progress.unit("final_source_verification", source["source_id"]):
                    with open_batch_source(source["access_path"], source["sha256"]) as opened:
                        self._checkpoint()
                        self.store.verify_source(self.job_id, self.generation, self.owner, source["source_id"],
                                                 opened.sha256, opened.size_bytes, opened.page_count)
            except _Stopped:
                raise
            except BatchStoreError:
                raise
            except Exception as error:
                failure = self._source_failed(source["source_id"], error, "final_source_verification")
                self._transition("blocked", error=failure)
                return
        self._checkpoint()
        with self.progress.unit("assembling"):
            job = self._checkpoint()
            result = assemble_batch_results(self.job_id, job["sources"], job["criteria"], job["match_mode"],
                                            self.version, self.store.read_page_results(self.job_id))
            self._checkpoint()
            self.store.publish_snapshot(self.job_id, self.generation, self.owner, **result)
        self.progress.emit("state_changed", public_summary(self._job()))

    def _run_with_capacity_handling(self) -> dict[str, Any]:
        try:
            job = self._checkpoint()
            if job["state"] != "validating":
                raise BatchConflict("worker must start in validating state")
            if job["computation_version"] != self.version:
                self._transition("blocked", error={"code": "computation_version_changed", "stage": "validating"})
                return self._job()
            self.progress.emit("snapshot", public_summary(job))
            valid, failure = self._validate_sources()
            # Resume must verify *all* originals before trusting any saved
            # page.  A first run can still settle the other valid sources.
            if failure and (self.generation > 1 or failure["code"] == "source_changed"):
                self._transition("blocked", error=failure)
                return self._job()
            job = self._transition("running")
            for source in job["sources"]:
                self._checkpoint()
                if source["source_id"] in valid:
                    self._compute_source(source, job["criteria"], job["match_mode"])
            job = self._checkpoint()
            if any(source["state"] in {"failed", "blocked"} for source in job["sources"]) or any(
                job["page_summary"][state] for state in ("pending", "processing", "failed")
            ):
                self._transition("partial_failed", error=failure)
            else:
                self._finalize()
        except BatchCapacityExceeded as error:
            self._transition("blocked", error=_failure(error, "storage"))
        return self._job()

    def run(self) -> dict[str, Any]:
        try:
            return self._run_with_capacity_handling()
        except _Stopped:
            pass
        except BatchConflict:
            # Control may win inside the commit/publish transaction after
            # the last checkpoint.  Only those durable stop states explain
            # a legitimate CAS loss; stale ownership remains a hard error.
            try:
                self._checkpoint()
            except _Stopped:
                pass
            else:
                raise
        return self._job()
