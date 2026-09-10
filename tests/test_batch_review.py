"""Trusted review loading uses synthetic PDFs and isolated databases only."""

from contextlib import contextmanager
from copy import deepcopy
from hashlib import sha256
import json

import pymupdf
import pytest

from engine import batch_review
from engine.batch_api import handle_batch_request
from engine.batch_processor import BatchProcessor, BatchProgress
from engine.batch_store import BatchConflict, BatchStore
from engine.computation import current_computation_version
from engine.engine import handle_request


@pytest.fixture
def ready(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    paths = []
    for name, word in [("hit.pdf", "fee"), ("zero.pdf", "unrelated")]:
        path = tmp_path / name
        with pymupdf.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.draw_rect(pymupdf.Rect(40, 20, 560, 300))
            page.insert_text((60, 70), word)
            pdf.save(path)
        paths.append(path)
    database = tmp_path / "batch.sqlite3"
    with BatchStore(database) as store:
        version = current_computation_version()
        store.activate_supervisor("host")
        job = store.create_job("test", [{"source_path": str(p), "name": p.name} for p in paths],
                               {"include": ["fee"], "includeMode": "all", "exclude": []}, "exact", version)
        running = store.start_job(job["id"], 0, "host", version)
        result = BatchProcessor(store, job["id"], running["generation"], "host", version,
                                BatchProgress(lambda *_args: None)).run()
        assert result["state"] == "ready_for_review"
    return database, tmp_path / "review.sqlite3", result, paths


def prepare(ready, **extra):
    database, review, job, _ = ready
    return handle_batch_request({"op": "batch_prepare_review", "database_path": str(database),
                                 "review_database_path": str(review), "job_id": job["id"],
                                 "result_revision": job["result_revision"], **extra})


def save_record(ready, data):
    database, review, job, _ = ready
    with BatchStore(database) as store:
        item = store.results_page(job["id"], job["result_revision"])["items"][0]
    segment = deepcopy(item["segment"])
    for key in ("slot", "snap_points"):
        segment.pop(key, None)
    segment.update(task_id=job["id"], context_key=data["prepared"]["context_key"],
                   result_revision=job["result_revision"], record_revision=0,
                   analysis_signature=item["original"]["analysis_signature"],
                   review_status="confirmed", reviewed_at="2026-09-08T12:00:00Z")
    segment["source_path"] = data["context"]["sources"][0]["source_path"]
    request = {"op": "save_review_segments_v2", "database_path": str(review),
               "context_key": data["prepared"]["context_key"], "result_revision": job["result_revision"],
               "segments": [segment], "confirm_group": False}
    return request


def test_prepare_uses_published_manifest_and_restores_saved_review(ready):
    prepared = prepare(ready)
    assert prepared["status"] == "ok", prepared
    data = prepared["data"]
    assert len(data["context"]["sources"]) == 2
    assert len(data["prepared"]["record_revisions"]) == 1
    request = save_record(ready, data)
    saved = handle_request(request)
    assert saved["status"] == "ok", saved
    restored = prepare(ready)["data"]["prepared"]
    assert restored["segments"][0]["review_status"] == "confirmed"
    assert restored["record_revisions"][0]["record_revision"] == 1


def test_archived_snapshot_can_reopen_and_registers_batch_review_owner(ready):
    database, review_path, job, paths = ready
    before = [sha256(path.read_bytes()).hexdigest() for path in paths]
    with BatchStore(database) as store:
        store.control(job["id"], job["generation"], "archive-test", "archive")
        assert len(store.results_page(job["id"], job["result_revision"])["items"]) == 1
    data = prepare(ready)["data"]
    with batch_review.ReviewStoreV2(review_path) as reviews:
        owner = reviews.batch_ownership(data["prepared"]["context_key"], job["id"])
        assert owner["owned_by_job"] and owner["exclusive"]
    assert [sha256(path.read_bytes()).hexdigest() for path in paths] == before
    with BatchStore(database) as store:
        assert store.get_job(job["id"])["state"] == "archived"


def test_pending_cleanup_cannot_reload_or_restart_task(ready):
    database, _, job, _ = ready
    with BatchStore(database) as store:
        with store._transaction() as connection:
            connection.execute("UPDATE batch_jobs SET deletion_pending = 1 WHERE id = ?", (job["id"],))
        with pytest.raises(BatchConflict):
            store.results_page(job["id"], job["result_revision"])
        with pytest.raises(BatchConflict):
            store.control(job["id"], job["generation"], "archive-pending", "archive")
        with store._transaction() as connection:
            connection.execute("UPDATE batch_jobs SET state = 'paused' WHERE id = ?", (job["id"],))
        with pytest.raises(BatchConflict, match="cleanup"):
            store.start_job(job["id"], job["generation"], "host", current_computation_version())
    assert prepare(ready)["status"] == "error"


def test_relocate_twice_keeps_logical_identity_and_saves_through_public_api(ready, tmp_path):
    database, _, job, paths = ready
    data = prepare(ready)["data"]
    for index in range(2):
        moved = tmp_path / f"new-location-{index}.pdf"
        moved.write_bytes(paths[0].read_bytes())
        with BatchStore(database) as store:
            source = job["sources"][0]
            store.relocate_source(job["id"], source["source_id"], str(moved), source["sha256"], source["size_bytes"])
        data = prepare(ready)["data"]
        assert data["context"]["sources"][0]["source_key"] == job["sources"][0]["source_key"]
        assert data["context"]["sources"][0]["source_path"] == str(moved)
    request = save_record(ready, data)
    saved = handle_request(request)
    assert saved["status"] == "ok", saved
    request["segments"][0]["source_path"] = str(paths[0])
    assert handle_request(request)["status"] == "error"
    assert prepare(ready)["data"]["prepared"]["segments"][0]["record_revision"] == 1


@pytest.mark.parametrize("change", ["missing_zero", "changed_zero", "version", "revision", "digest", "gap", "manifest"])
def test_invalid_identity_or_manifest_never_binds_reviews(ready, monkeypatch, change):
    database, review, job, paths = ready
    extra = {}
    if change == "missing_zero":
        paths[1].unlink()  # disposable synthetic fixture
    elif change == "changed_zero":
        with paths[1].open("ab") as stream:
            stream.write(b"changed synthetic PDF")
    elif change == "version":
        monkeypatch.setattr(batch_review, "current_computation_version", lambda: "new-version")
    elif change == "revision":
        extra["result_revision"] = "stale"
    elif change == "manifest":
        extra["originals"] = []
    else:
        with BatchStore(database) as store:
            if change == "digest":
                row = store.connection.execute("SELECT payload_json FROM batch_snapshot_items").fetchone()
                value = json.loads(row[0])
                value["original"]["confidence"] = 0.1
                store.connection.execute("UPDATE batch_snapshot_items SET payload_json = ?", (json.dumps(value),))
            else:
                store.connection.execute("UPDATE batch_snapshot_items SET position = 1")
    result = prepare(ready, **extra)
    assert result["status"] == "error", result
    assert not review.exists()
    with BatchStore(database) as store:
        assert store.get_job(job["id"])["state"] == "ready_for_review"


def test_relocation_during_final_file_check_invalidates_load(ready, monkeypatch, tmp_path):
    database, review, job, paths = ready
    real_open = batch_review.open_batch_source
    moved = tmp_path / "race-location.pdf"
    moved.write_bytes(paths[0].read_bytes())

    @contextmanager
    def racing_open(path, expected):
        with real_open(path, expected) as opened:
            yield opened
        if path == str(paths[1]):
            with BatchStore(database) as other:
                source = job["sources"][0]
                other.relocate_source(job["id"], source["source_id"], str(moved), source["sha256"], source["size_bytes"])

    monkeypatch.setattr(batch_review, "open_batch_source", racing_open)
    assert prepare(ready)["code"] == "batch_conflict"
    assert not review.exists()


def test_failed_review_load_can_retry_without_recomputing_or_mutating_originals(ready):
    _, review, _, paths = ready
    checksums = [sha256(path.read_bytes()).hexdigest() for path in paths]
    review.write_bytes(b"invalid synthetic database")
    assert prepare(ready)["status"] == "error"
    review.unlink()  # only the isolated deliberately invalid fixture
    assert prepare(ready)["status"] == "ok"
    assert checksums == [sha256(path.read_bytes()).hexdigest() for path in paths]


def test_review_commit_holds_source_binding_after_final_file_check(ready, monkeypatch, tmp_path):
    database, _, job, paths = ready
    moved = tmp_path / "concurrent-relocation.pdf"
    moved.write_bytes(paths[0].read_bytes())
    actual_init = batch_review.ReviewStoreV2.__init__
    attempted = []
    other = BatchStore(database)
    other.connection.execute("PRAGMA busy_timeout = 25")

    def racing_init(reviews, review_path):
        source = job["sources"][0]
        with pytest.raises(BatchConflict, match="locked"):
            other.relocate_source(job["id"], source["source_id"], str(moved), source["sha256"], source["size_bytes"])
        attempted.append(True)
        actual_init(reviews, review_path)

    monkeypatch.setattr(batch_review.ReviewStoreV2, "__init__", racing_init)
    try:
        assert prepare(ready)["status"] == "ok"
    finally:
        other.close()
    assert attempted == [True]
    with BatchStore(database) as store:
        assert store.get_job(job["id"])["sources"][0]["access_path"] == str(paths[0])
        # The short cross-store transaction has released the binding.
        source = job["sources"][0]
        store.relocate_source(job["id"], source["source_id"], str(moved), source["sha256"], source["size_bytes"])
