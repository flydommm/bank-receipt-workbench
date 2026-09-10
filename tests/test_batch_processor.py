"""Synthetic PDFs exercise durable execution, not a mock result assembler."""

from hashlib import sha256

import pymupdf
import pytest

from engine import batch_processor
from engine.batch_pdf import BatchPdfSource, BatchSourceError
from engine.batch_processor import BatchProcessor, BatchProgress
from engine.batch_store import BatchCapacityExceeded, BatchStore
from engine.error_codes import ErrorCode
from engine.ocr import OcrRuntimeError, OcrUnavailableError


@pytest.fixture(autouse=True)
def isolated_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))


def make_pdf(tmp_path, name="source.pdf", pages=3, word="fee"):
    path = tmp_path / name
    with pymupdf.open() as document:
        for number in range(pages):
            page = document.new_page(width=600, height=800)
            page.draw_rect(pymupdf.Rect(40, 20, 560, 300))
            page.insert_text((60, 70), f"{word} bank page {number + 1}")
        document.save(path)
    return path


def create(store, paths):
    return store.create_job("synthetic", [{"source_path": str(path), "name": path.name} for path in paths],
                            {"include": ["fee"], "includeMode": "all", "exclude": []}, "exact", "test-v1")


def execute(store, job, sink=None):
    running = store.start_job(job["id"], job["generation"], "host", "test-v1")
    return BatchProcessor(store, job["id"], running["generation"], "host", "test-v1",
                          BatchProgress(sink or (lambda *_args: None))).run()


def test_forty_page_pause_reopen_resume_skips_successful_page_computation(tmp_path, monkeypatch):
    path = make_pdf(tmp_path, pages=40)
    original_sha = sha256(path.read_bytes()).hexdigest()
    calls = []
    original_compute = BatchPdfSource.compute_page

    def compute(source, page, *args):
        calls.append(page)
        return original_compute(source, page, *args)

    monkeypatch.setattr(BatchPdfSource, "compute_page", compute)
    database = tmp_path / "batch.sqlite3"
    with BatchStore(database) as store:
        store.activate_supervisor("host")
        job = create(store, [path])

        def pause_after_three(event_type, payload):
            if payload.get("phase") == "page_settled" and payload["page_summary"]["succeeded"] == 3:
                store.control(job["id"], 1, "pause-1", "pause")

        paused = execute(store, job, pause_after_three)
        assert paused["state"] == "paused"
        assert paused["sources"][0]["budget"]["processed_pages"] == 3
        assert calls == [1, 2, 3]
    with BatchStore(database) as store:
        resumed = execute(store, store.get_job(job["id"]))
        assert resumed["state"] == "ready_for_review"
        assert resumed["page_summary"]["succeeded"] == 40
        assert resumed["sources"][0]["budget"]["processed_pages"] == 40
        result = store.results_page(job["id"], resumed["result_revision"])
        assert result["total"] == 40 and len(result["items"]) == 40
    assert calls == list(range(1, 41))
    assert sha256(path.read_bytes()).hexdigest() == original_sha


def test_page_failure_does_not_stop_other_pages_and_retry_keeps_spent_budget(tmp_path, monkeypatch):
    path = make_pdf(tmp_path)
    original_compute = BatchPdfSource.compute_page
    failed_once = False
    calls = []

    def compute(source, page, *args):
        nonlocal failed_once
        calls.append(page)
        result = original_compute(source, page, *args)
        if page == 2 and not failed_once:
            failed_once = True
            raise RuntimeError("private document text must not be recorded")
        return result

    monkeypatch.setattr(BatchPdfSource, "compute_page", compute)
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        store.activate_supervisor("host")
        job = create(store, [path])
        failed = execute(store, job)
        assert failed["state"] == "partial_failed"
        assert failed["page_summary"] == {"pending": 0, "processing": 0, "succeeded": 2, "failed": 1}
        assert failed["sources"][0]["budget"]["processed_pages"] == 3
        assert calls == [1, 2, 3]
        ready = execute(store, failed)
        assert ready["state"] == "ready_for_review"
        assert ready["sources"][0]["budget"]["processed_pages"] == 4
        assert calls == [1, 2, 3, 2]


def test_missing_source_first_run_keeps_valid_work_but_resume_verifies_all_before_ocr(tmp_path, monkeypatch):
    good = make_pdf(tmp_path)
    missing = tmp_path / "missing.pdf"
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        store.activate_supervisor("host")
        job = create(store, [good, missing])
        failed = execute(store, job)
        assert failed["state"] == "partial_failed" and failed["page_summary"]["succeeded"] == 3
        assert failed["sources"][1]["error"]["code"] == "file_not_found"
        monkeypatch.setattr(BatchPdfSource, "compute_page", lambda *_args: pytest.fail("resume must verify every source first"))
        blocked = execute(store, failed)
        assert blocked["state"] == "blocked" and blocked["result_revision"] is None
        assert blocked["page_summary"]["succeeded"] == 3


def test_zero_hit_source_is_still_verified_before_publication(tmp_path, monkeypatch):
    hit, zero = make_pdf(tmp_path, "hit.pdf", pages=1), make_pdf(tmp_path, "zero.pdf", pages=1, word="unrelated")
    checked = []
    original_open = batch_processor.open_batch_source

    def open_source(path, expected=None, **kwargs):
        checked.append(str(path))
        return original_open(path, expected, **kwargs)

    monkeypatch.setattr(batch_processor, "open_batch_source", open_source)
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        store.activate_supervisor("host")
        ready = execute(store, create(store, [hit, zero]))
        assert ready["state"] == "ready_for_review"
        assert checked.count(str(zero)) == 3
        assert all(source["verified_generation"] == 1 for source in ready["sources"])
        assert store.results_page(ready["id"], ready["result_revision"])["total"] == 1


@pytest.mark.parametrize("phase", ["final_source_verification", "assembling"])
def test_cancel_during_finalizing_cannot_publish(tmp_path, phase):
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        store.activate_supervisor("host")
        job = create(store, [make_pdf(tmp_path, pages=1)])

        def cancel(_event, payload):
            if payload.get("phase") == "unit_start" and payload["stage"] == phase:
                store.control(job["id"], 1, "cancel", "cancel")

        stopped = execute(store, job, cancel)
        assert stopped["state"] == "cancel_requested" and stopped["result_revision"] is None
        # This test invocation has returned, standing in for the host's
        # confirmed process exit.  Only then is cancellation settled.
        assert store.finish_stop(job["id"], 1, "host")["state"] == "cancelled"


def test_ocr_unavailable_settles_zero_search_work_and_blocks(tmp_path, monkeypatch):
    def unavailable(*_args):
        raise OcrUnavailableError("runtime unavailable")

    monkeypatch.setattr(BatchPdfSource, "compute_page", unavailable)
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        store.activate_supervisor("host")
        blocked = execute(store, create(store, [make_pdf(tmp_path)]))
        assert blocked["state"] == "blocked"
        assert blocked["sources"][0]["budget"]["processed_pages"] == 0
        assert blocked["page_summary"]["failed"] == 1
        assert blocked["error"]["code"] == "ocr_unavailable"


@pytest.mark.parametrize("code", [
    ErrorCode.OCR_INITIALIZATION_FAILED.value,
    ErrorCode.OCR_INFERENCE_FAILED.value,
    ErrorCode.OCR_RESULT_INVALID.value,
])
def test_ocr_runtime_failure_settles_current_page_blocks_and_leaves_remaining_pending(tmp_path, monkeypatch, code):
    calls = []

    def runtime_failure(_source, page, *_args):
        calls.append(page)
        raise OcrRuntimeError(code)

    monkeypatch.setattr(BatchPdfSource, "compute_page", runtime_failure)
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        store.activate_supervisor("host")
        blocked = execute(store, create(store, [make_pdf(tmp_path)]))
        assert blocked["state"] == "blocked"
        assert blocked["page_summary"] == {"pending": 2, "processing": 0, "succeeded": 0, "failed": 1}
        assert blocked["sources"][0]["page_summary"] == {
            "pending": 2, "processing": 0, "succeeded": 0, "failed": 1,
        }
        assert blocked["error"] == {"code": code, "stage": "page"}
        assert calls == [1]


def test_changed_original_during_final_validation_preserves_pages_without_ready(tmp_path):
    path = make_pdf(tmp_path, pages=1)
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        store.activate_supervisor("host")
        job = create(store, [path])

        def change(_event, payload):
            if payload.get("phase") == "unit_start" and payload["stage"] == "final_source_verification":
                # Synthetic test fixture only; production originals are read-only.
                with path.open("ab") as synthetic:
                    synthetic.write(b"changed test source")

        blocked = execute(store, job, change)
        assert blocked["state"] == "blocked" and blocked["result_revision"] is None
        assert blocked["page_summary"]["succeeded"] == 1
        assert blocked["error"]["code"] == "source_changed"


def test_transient_final_verification_failure_can_resume_without_recomputing_pages(tmp_path, monkeypatch):
    path = make_pdf(tmp_path, pages=1)
    original_open = batch_processor.open_batch_source
    count = 0

    def open_source(*args, **kwargs):
        nonlocal count
        count += 1
        if count == 3:
            raise BatchSourceError("search_failed")
        return original_open(*args, **kwargs)

    monkeypatch.setattr(batch_processor, "open_batch_source", open_source)
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        store.activate_supervisor("host")
        failed = execute(store, create(store, [path]))
        assert failed["state"] == "blocked" and failed["sources"][0]["state"] == "failed"
        assert failed["page_summary"]["succeeded"] == 1
        monkeypatch.setattr(BatchPdfSource, "compute_page", lambda *_args: pytest.fail("successful page must be reused"))
        ready = execute(store, failed)
        assert ready["state"] == "ready_for_review"
        assert ready["sources"][0]["state"] == "verified" and ready["sources"][0]["error"] is None
        assert ready["sources"][0]["budget"]["processed_pages"] == 1


@pytest.mark.parametrize("action, expected", [("cancel", "cancel_requested"), ("pause", "paused")])
def test_stop_wins_a_race_with_storage_capacity_error(tmp_path, monkeypatch, action, expected):
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        store.activate_supervisor("host")
        job = create(store, [make_pdf(tmp_path, pages=1)])

        def capacity_race(*_args, **_kwargs):
            store.control(job["id"], 1, "stop", action)
            raise BatchCapacityExceeded("synthetic capacity limit")

        monkeypatch.setattr(store, "commit_page", capacity_race)
        stopped = execute(store, job)
        assert stopped["state"] == expected
        assert stopped["result_revision"] is None
        assert stopped["sources"][0]["budget"]["processed_pages"] == 1


@pytest.mark.parametrize("action, expected", [("cancel", "cancel_requested"), ("pause", "paused")])
def test_stop_wins_inside_capacity_error_transition(tmp_path, monkeypatch, action, expected):
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        store.activate_supervisor("host")
        job = create(store, [make_pdf(tmp_path, pages=1)])
        transition = store.transition

        def capacity(*_args, **_kwargs):
            raise BatchCapacityExceeded("synthetic capacity limit")

        def concurrent_stop(job_id, generation, owner, states, next_state, **kwargs):
            if next_state == "blocked":
                store.control(job_id, generation, "stop", action)
            return transition(job_id, generation, owner, states, next_state, **kwargs)

        monkeypatch.setattr(store, "commit_page", capacity)
        monkeypatch.setattr(store, "transition", concurrent_stop)
        stopped = execute(store, job)
        assert stopped["state"] == expected and stopped["result_revision"] is None
        assert stopped["sources"][0]["budget"]["processed_pages"] == 1
