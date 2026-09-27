"""Receipt checkpoint execution with synthetic PDFs and isolated task stores."""
from copy import deepcopy
from hashlib import sha256

import pymupdf
import pytest

from engine import batch_processor
from engine.batch_pdf import BatchPdfSource
from engine.batch_processor import BatchProcessor, BatchProgress
from engine.batch_store import BatchConflict, BatchStore, BatchStoreError


VERSION = "synthetic-receipt-v3"
SEARCH = {"processing_mode": "search", "criteria": {
    "include": ["processingcharge"], "includeMode": "all", "exclude": []}}
SPLIT = {"processing_mode": "split_all", "criteria": None}


@pytest.fixture(autouse=True)
def isolated_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))


@pytest.fixture
def receipt_calls(monkeypatch):
    """Use the real page pipeline with a known synthetic three-slot form."""
    original = BatchPdfSource.compute_receipt_page
    calls = []

    def compute(source, page, options, mode, budget):
        calls.append((page, deepcopy(options), mode))
        return original(source, page, options, mode, budget, slot_count=3, allow_ocr=False)

    monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", compute)
    return calls


def make_pdf(tmp_path, name="source.pdf", pages=1, *, hit_pages=None):
    path = tmp_path / name
    with pymupdf.open() as document:
        for number in range(1, pages + 1):
            page = document.new_page(width=600, height=900)
            for position in range(3):
                top = position * 300
                page.draw_rect(pymupdf.Rect(20, top + 20, 580, top + 280))
                word = "processingcharge" if position == 2 and (hit_pages is None or number in hit_pages) else "transfer"
                page.insert_text((50, top + 70), f"{word} synthetic page {number} slot {position + 1}")
        document.save(path)
    return path


def create(store, paths, options=SEARCH, mode="exact"):
    return store.create_receipt_job("synthetic", [
        {"source_path": str(path), "name": path.name} for path in paths], options, mode, VERSION)


def execute(store, job, sink=None):
    running = store.start_job(job["id"], job["generation"], "host", VERSION)
    return BatchProcessor(store, job["id"], running["generation"], "host", VERSION,
                          BatchProgress(sink or (lambda *_args: None))).run()


@pytest.mark.parametrize("options,positions", [(SEARCH, [3]), (SPLIT, [1, 2, 3])])
@pytest.mark.parametrize("mode", ["exact", "fuzzy"])
def test_receipt_modes_publish_new_checkpoints_and_snapshot(tmp_path, monkeypatch, receipt_calls, options, positions, mode):
    path = make_pdf(tmp_path)
    original_sha = sha256(path.read_bytes()).hexdigest()
    monkeypatch.setattr(BatchPdfSource, "compute_page", lambda *_: pytest.fail("receipt job used legacy computation"))
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        store.activate_supervisor("host")
        ready = execute(store, create(store, [path], options, mode))
        assert ready["state"] == "ready_for_review"
        rows = store.read_page_results(ready["id"])
        assert len(rows) == 1 and rows[0]["payload"]["schema"] == 2
        assert ready["sources"][0]["budget"]["processed_pages"] == 1
        result = store.results_page(ready["id"], ready["result_revision"])
        assert [item["segment"]["position_index"] for item in result["items"]] == positions
        assert all(bool(item["evidence"]) == (options == SEARCH) for item in result["items"])
        assert receipt_calls == [(1, options, mode)]
    assert sha256(path.read_bytes()).hexdigest() == original_sha


def test_zero_hit_receipt_pages_are_computed_checkpointed_and_finally_verified(tmp_path, receipt_calls, monkeypatch):
    path = make_pdf(tmp_path, pages=2, hit_pages={2})
    checked = []
    original_open = batch_processor.open_batch_source

    def opened(*args, **kwargs):
        checked.append(args[0])
        return original_open(*args, **kwargs)

    monkeypatch.setattr(batch_processor, "open_batch_source", opened)
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        store.activate_supervisor("host")
        ready = execute(store, create(store, [path]))
        assert ready["state"] == "ready_for_review"
        rows = store.read_page_results(ready["id"])
        assert [row["page"] for row in rows] == [1, 2]
        assert rows[0]["payload"]["receipt_page"]["candidates"] == []
        assert ready["sources"][0]["verified_generation"] == 1 and len(checked) == 3
        result = store.results_page(ready["id"], ready["result_revision"])
        assert result["total"] == 1 and result["items"][0]["segment"]["source_page"] == 2


@pytest.mark.parametrize("options", [SEARCH, SPLIT])
def test_pause_during_computation_commits_finished_page_and_budget_before_resume(tmp_path, monkeypatch, receipt_calls, options):
    path = make_pdf(tmp_path, pages=3)
    compute = BatchPdfSource.compute_receipt_page
    database = tmp_path / "tasks.sqlite3"
    with BatchStore(database) as store:
        store.activate_supervisor("host")
        job = create(store, [path], options)

        def pause(source, page, *args):
            result = compute(source, page, *args)
            if page == 1:
                store.control(job["id"], 1, "pause", "pause")
            return result

        monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", pause)
        paused = execute(store, job)
        assert paused["state"] == "paused"
        assert paused["page_summary"] == {"pending": 2, "processing": 0, "succeeded": 1, "failed": 0}
        assert paused["sources"][0]["budget"]["processed_pages"] == 1
        saved_budget = deepcopy(paused["sources"][0]["budget"])
    monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", compute)
    with BatchStore(database) as store:
        store.activate_supervisor("host")
        ready = execute(store, store.get_job(job["id"]))
        assert ready["state"] == "ready_for_review"
        assert ready["sources"][0]["budget"]["processed_pages"] == 3
        assert ready["sources"][0]["budget"]["text_characters"] > saved_budget["text_characters"]
        assert [call[0] for call in receipt_calls] == [1, 2, 3]


@pytest.mark.parametrize("field", ["processing_options", "match_mode", "computation_version", "criteria_fingerprint", "page_result_schema"])
@pytest.mark.parametrize("failed_compute", [False, True])
def test_late_result_with_changed_job_binding_cannot_commit_or_become_page_failure(tmp_path, monkeypatch, receipt_calls, field, failed_compute):
    compute = BatchPdfSource.compute_receipt_page
    changed = False
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        store.activate_supervisor("host")
        job = create(store, [make_pdf(tmp_path)])
        get_job = store.get_job

        def job_snapshot(*args, **kwargs):
            result = get_job(*args, **kwargs)
            if changed:
                if field == "processing_options":
                    result[field]["criteria"]["include"] = ["changed"]
                else:
                    result[field] = {"match_mode": "fuzzy", "computation_version": "changed",
                        "criteria_fingerprint": "f" * 64, "page_result_schema": 1}[field]
            return result

        def late_result(source, page, *args):
            nonlocal changed
            result = compute(source, page, *args)
            changed = True
            if failed_compute:
                raise RuntimeError("synthetic calculation failed after parameters changed")
            return result

        monkeypatch.setattr(store, "get_job", job_snapshot)
        monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", late_result)
        with pytest.raises(BatchConflict):
            execute(store, job)
        durable = get_job(job["id"])
        assert durable["page_summary"] == {"pending": 0, "processing": 1, "succeeded": 0, "failed": 0}
        assert durable["sources"][0]["budget"]["processed_pages"] == 0
        assert store.read_page_results(job["id"]) == []


def test_compute_conflict_escapes_without_marking_page_or_source_failed(tmp_path, monkeypatch):
    def conflict(*_args):
        raise BatchConflict("synthetic stale generation")

    monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", conflict)
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        store.activate_supervisor("host")
        job = create(store, [make_pdf(tmp_path)])
        with pytest.raises(BatchConflict):
            execute(store, job)
        assert store.get_job(job["id"])["page_summary"]["failed"] == 0
        assert store.get_job(job["id"])["sources"][0]["error"] is None


def test_receipt_page_cannot_commit_mixed_legacy_codec(tmp_path, monkeypatch, receipt_calls):
    legacy = {"schema": 1, "page": 1, "page_width": 600, "page_height": 900, "matches": [], "analysis": None}
    monkeypatch.setattr(batch_processor, "encode_receipt_checkpoint", lambda _result: legacy, raising=False)
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        store.activate_supervisor("host")
        job = create(store, [make_pdf(tmp_path)])
        with pytest.raises(BatchStoreError):
            execute(store, job)
        assert store.read_page_results(job["id"]) == []
        assert store.get_job(job["id"])["result_revision"] is None


def test_legacy_job_uses_legacy_compute_codec_and_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", lambda *_: pytest.fail("legacy job used receipt computation"))
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        store.activate_supervisor("host")
        path = make_pdf(tmp_path)
        job = store.create_job("legacy", [{"source_path": str(path), "name": path.name}], SEARCH["criteria"], "exact", VERSION)
        ready = execute(store, job)
        assert ready["state"] == "ready_for_review"
        assert store.read_page_results(job["id"])[0]["payload"]["schema"] == 1
        result = store.results_page(job["id"], ready["result_revision"])
        assert result["total"] == 1 and "segment_no" in result["items"][0]["segment"]


def test_zero_candidate_job_still_publishes_verified_empty_snapshot(tmp_path, receipt_calls):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        store.activate_supervisor("host")
        ready = execute(store, create(store, [make_pdf(tmp_path, pages=2, hit_pages=set())]))
        assert ready["state"] == "ready_for_review"
        assert len(store.read_page_results(ready["id"])) == 2
        assert ready["sources"][0]["verified_generation"] == 1
        assert store.results_page(ready["id"], ready["result_revision"])["items"] == []


@pytest.mark.parametrize("options", [SEARCH, SPLIT])
def test_failed_receipt_page_retries_only_failure_and_retains_spent_budget(tmp_path, monkeypatch, receipt_calls, options):
    compute = BatchPdfSource.compute_receipt_page
    failed = False

    def fail_once(source, page, *args):
        nonlocal failed
        result = compute(source, page, *args)
        if page == 2 and not failed:
            failed = True
            raise RuntimeError("synthetic failure")
        return result

    monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", fail_once)
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        store.activate_supervisor("host")
        partial = execute(store, create(store, [make_pdf(tmp_path, pages=3)], options))
        assert partial["state"] == "partial_failed"
        assert partial["page_summary"] == {"pending": 0, "processing": 0, "succeeded": 2, "failed": 1}
        assert partial["sources"][0]["budget"]["processed_pages"] == 3
        ready = execute(store, partial)
        assert ready["state"] == "ready_for_review"
        assert ready["sources"][0]["budget"]["processed_pages"] == 4
        assert [call[0] for call in receipt_calls] == [1, 2, 3, 2]


def test_cancellation_during_receipt_computation_prevents_late_page_commit(tmp_path, monkeypatch, receipt_calls):
    compute = BatchPdfSource.compute_receipt_page
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        store.activate_supervisor("host")
        job = create(store, [make_pdf(tmp_path)])

        def cancel(source, page, *args):
            result = compute(source, page, *args)
            store.control(job["id"], 1, "cancel", "cancel")
            return result

        monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", cancel)
        stopped = execute(store, job)
        assert stopped["state"] == "cancel_requested" and stopped["result_revision"] is None
        assert store.read_page_results(job["id"]) == []
        assert store.finish_stop(job["id"], 1, "host")["state"] == "cancelled"


@pytest.mark.parametrize("change", ["cancel", "parameters"])
def test_receipt_snapshot_cannot_publish_after_final_assembly_control_or_binding_change(tmp_path, monkeypatch, receipt_calls, change):
    assemble = batch_processor.assemble_receipt_results
    changed = False
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        store.activate_supervisor("host")
        job = create(store, [make_pdf(tmp_path)])
        get_job = store.get_job

        def job_snapshot(*args, **kwargs):
            result = get_job(*args, **kwargs)
            if changed:
                result["criteria_fingerprint"] = "f" * 64
            return result

        def late_snapshot(*args):
            nonlocal changed
            result = assemble(*args)
            if change == "cancel":
                store.control(job["id"], 1, "cancel", "cancel")
            else:
                changed = True
            return result

        monkeypatch.setattr(store, "get_job", job_snapshot)
        monkeypatch.setattr(batch_processor, "assemble_receipt_results", late_snapshot)
        if change == "parameters":
            with pytest.raises(BatchConflict):
                execute(store, job)
        else:
            assert execute(store, job)["state"] == "cancel_requested"
        assert get_job(job["id"])["result_revision"] is None
        assert get_job(job["id"])["page_summary"]["succeeded"] == 1
