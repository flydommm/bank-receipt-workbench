"""Export scopes use published synthetic tasks, never a UI-supplied full set."""

from copy import deepcopy
from hashlib import sha256

import pymupdf
import pytest

from engine.batch_results import assemble_batch_results
from engine.batch_processor import BatchProcessor, BatchProgress
from engine.batch_review import prepare_batch_review
from engine.batch_store import BatchStore
from engine.computation import current_computation_version
from engine.engine import handle_request
from engine.export_scope import ExportScopeError, capture_export_scope, hold_export_scope


def _duplicate_candidate_payload() -> dict[str, object]:
    candidate_rect = {"x0": 0.0, "y0": 0.0, "x1": 600.0, "y1": 400.0}
    matches = []
    selections = []
    for y0 in (40.0, 80.0):
        match_rect = {"x0": 40.0, "y0": y0, "x1": 140.0, "y1": y0 + 20.0}
        matches.append({
            "page": 1,
            "matched_text": "fee",
            "matched_field": "摘要",
            "confidence": 0.95,
            "needs_review": False,
            **match_rect,
        })
        selections.append({
            "match_rect": match_rect,
            "rect": dict(candidate_rect),
            "confidence": 0.95,
            "slot": "top",
            "evidence": ["synthetic"],
            "needs_review": False,
            "snap_points": [0.0, 400.0, 800.0],
        })
    return {
        "schema": 1,
        "page": 1,
        "page_width": 600.0,
        "page_height": 800.0,
        "matches": matches,
        "analysis": {
            "status": "ok",
            "page": 1,
            "page_width": 600.0,
            "page_height": 800.0,
            "page_fully_matched": False,
            "selections": selections,
        },
    }


def _duplicate_candidate_budget() -> dict[str, int]:
    return {
        "processed_pages": 1,
        "text_characters": 10,
        "fuzzy_work": 0,
        "matches": 2,
        "matched_text_characters": 6,
    }


@pytest.fixture
def export_task(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    paths = []
    for name, text in [("first.pdf", "fee"), ("second.pdf", "fee"), ("zero.pdf", "none")]:
        path = tmp_path / name
        with pymupdf.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.draw_rect(pymupdf.Rect(40, 20, 560, 300))
            page.insert_text((60, 70), text)
            pdf.save(path)
        paths.append(path)
    database = tmp_path / "batch.sqlite3"
    review = tmp_path / "review.sqlite3"
    with BatchStore(database) as store:
        version = current_computation_version()
        store.activate_supervisor("export-host")
        job = store.create_job("scope test", [{"source_path": str(p), "name": p.name} for p in paths],
                               {"include": ["fee"], "includeMode": "all", "exclude": []}, "exact", version)
        running = store.start_job(job["id"], 0, "export-host", version)
        job = BatchProcessor(store, job["id"], running["generation"], "export-host", version,
                             BatchProgress(lambda *_args: None)).run()
        assert job["state"] == "ready_for_review"
        prepared = prepare_batch_review(store, job["id"], job["result_revision"], review)
        items = store.results_page(job["id"], job["result_revision"])["items"]
    records = []
    for item in items:
        record = deepcopy(item["segment"])
        for key in ("slot", "snap_points"):
            record.pop(key)
        record.update(task_id=job["id"], context_key=prepared["prepared"]["context_key"],
                      result_revision=job["result_revision"], record_revision=0,
                      analysis_signature=item["original"]["analysis_signature"],
                      review_status="confirmed", reviewed_at="2026-09-08T12:00:00Z")
        records.append(record)
    request = {"job_id": job["id"], "result_revision": job["result_revision"], "scope_kind": "list",
               "selected_segment_ids": [records[0]["id"]],
               "expected_records": [{"id": records[0]["id"], "record_revision": 1}],
               "output_mode": "merged", "include_xlsx": False}
    return database, review, job, paths, records, request


@pytest.fixture
def duplicate_export_task(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    path = tmp_path / "duplicate.pdf"
    with pymupdf.open() as pdf:
        page = pdf.new_page(width=600, height=800)
        page.insert_text((40, 60), "fee")
        page.insert_text((40, 100), "fee")
        pdf.save(path)

    database = tmp_path / "batch.sqlite3"
    review = tmp_path / "review.sqlite3"
    source_sha256 = sha256(path.read_bytes()).hexdigest()
    source_size = path.stat().st_size
    with BatchStore(database) as store:
        version = current_computation_version()
        store.activate_supervisor("export-host")
        job = store.create_job(
            "duplicate scope test",
            [{"source_path": str(path), "name": path.name}],
            {"include": ["fee"], "includeMode": "all", "exclude": []},
            "exact",
            version,
        )
        running = store.start_job(job["id"], 0, "export-host", version)
        source = running["sources"][0]
        store.register_source(
            running["id"], running["generation"], "export-host", source["source_id"],
            source_sha256, source_size, 1,
        )
        store.transition(running["id"], running["generation"], "export-host", {"validating"}, "running")
        claimed = store.begin_page(running["id"], running["generation"], "export-host", source["source_id"], 1)
        store.commit_page(
            running["id"], running["generation"], "export-host", source["source_id"], 1,
            claimed["attempt"], _duplicate_candidate_payload(), _duplicate_candidate_budget(),
        )
        store.transition(running["id"], running["generation"], "export-host", {"running"}, "finalizing")
        store.verify_source(
            running["id"], running["generation"], "export-host", source["source_id"],
            source_sha256, source_size, 1,
        )
        current = store.get_job(running["id"])
        assembled = assemble_batch_results(
            running["id"], current["sources"], current["criteria"], current["match_mode"],
            current["computation_version"], store.read_page_results(running["id"]),
        )
        published = store.publish_snapshot(
            running["id"], running["generation"], "export-host",
            assembled["context"], assembled["originals"], assembled["items"],
        )
        job = store.get_job(running["id"])
        prepared = prepare_batch_review(store, running["id"], published["result_revision"], review)
        items = store.results_page(running["id"], published["result_revision"])["items"]

    records = []
    for item in items:
        record = deepcopy(item["segment"])
        for key in ("slot", "snap_points"):
            record.pop(key, None)
        record.update(
            task_id=running["id"],
            context_key=prepared["prepared"]["context_key"],
            result_revision=published["result_revision"],
            record_revision=0,
            analysis_signature=item["original"]["analysis_signature"],
            review_status="confirmed",
            reviewed_at="2026-09-08T12:00:00Z",
        )
        records.append(record)
    request = {
        "job_id": job["id"],
        "result_revision": job["result_revision"],
        "scope_kind": "all",
        "selected_segment_ids": [record["id"] for record in records],
        "expected_records": [{"id": record["id"], "record_revision": 1} for record in records],
        "output_mode": "merged",
        "include_xlsx": True,
    }
    return database, review, job, [path], records, request


def save(task, records):
    _, review, job, _, _, _ = task
    response = handle_request({"op": "save_review_segments_v2", "database_path": str(review),
                               "context_key": records[0]["context_key"], "result_revision": job["result_revision"],
                               "segments": records, "confirm_group": False})
    assert response["status"] == "ok", response


def capture(task, request=None):
    database, review, _, _, _, original = task
    with BatchStore(database) as store:
        return capture_export_scope(store, review, original if request is None else request)


def test_explicit_subset_preserves_unselected_reviews_and_all_sources(export_task):
    save(export_task, export_task[4][:1])
    before = [sha256(p.read_bytes()).hexdigest() for p in export_task[3]]
    frozen = capture(export_task)
    assert frozen["selected_segment_ids"] == export_task[5]["selected_segment_ids"]
    assert len(frozen["sources"]) == 3
    assert frozen["summary"]["total_segments"] == 2
    assert frozen["summary"]["selected_count"] == 1
    assert frozen["summary"]["omitted_count"] == 1
    assert len(frozen["records"]) == 1
    assert len(frozen["review_revision"]) == 64
    assert [sha256(p.read_bytes()).hexdigest() for p in export_task[3]] == before


@pytest.mark.parametrize("change", ["empty", "duplicate", "forged", "all_subset", "wrong_cas", "no_cas", "extra", "bad_mode", "bad_xlsx"])
def test_bad_scope_rejected(export_task, change):
    save(export_task, export_task[4][:1])
    request = deepcopy(export_task[5])
    if change == "empty":
        request["selected_segment_ids"] = []
    elif change == "duplicate":
        request["selected_segment_ids"] *= 2
    elif change == "forged":
        request["selected_segment_ids"] = ["invented"]
    elif change == "all_subset":
        request["scope_kind"] = "all"
    elif change == "wrong_cas":
        request["expected_records"][0]["record_revision"] = 2
    elif change == "no_cas":
        request["expected_records"] = []
    elif change == "extra":
        request["originals"] = []
    elif change == "bad_mode":
        request["output_mode"] = "zip"
    else:
        request["include_xlsx"] = "false"
    with pytest.raises(ExportScopeError):
        capture(export_task, request)


def test_auto_confirmed_but_unsaved_row_cannot_export(export_task):
    with pytest.raises(ExportScopeError, match="persisted"):
        capture(export_task)


def test_unresolved_selected_row_cannot_export(export_task):
    record = deepcopy(export_task[4][0])
    record["review_status"] = "needs_review"
    save(export_task, [record])
    with pytest.raises(ExportScopeError, match="resolved"):
        capture(export_task)


@pytest.mark.parametrize("change", ["missing_zero", "changed_zero", "failed", "deleted", "version", "revision", "missing_item", "failed_zero_source", "failed_zero_page", "missing_zero_page", "missing_zero_result", "wrong_source_generation"])
def test_full_task_gate_cannot_be_bypassed_by_subset(export_task, change):
    database, _, job, paths, records, _ = export_task
    save(export_task, records[:1])
    if change == "missing_zero":
        paths[2].unlink()  # isolated generated fixture
    elif change == "changed_zero":
        paths[2].write_bytes(paths[0].read_bytes())  # isolated generated fixture
    else:
        with BatchStore(database) as store:
            with store._transaction() as conn:
                if change == "missing_item":
                    conn.execute("DELETE FROM batch_snapshot_items WHERE job_id=? AND position=1", (job["id"],))
                elif change == "failed":
                    conn.execute("UPDATE batch_jobs SET state='failed' WHERE id=?", (job["id"],))
                elif change == "deleted":
                    conn.execute("UPDATE batch_jobs SET deletion_pending=1 WHERE id=?", (job["id"],))
                elif change == "version":
                    conn.execute("UPDATE batch_jobs SET computation_version='old' WHERE id=?", (job["id"],))
                elif change == "failed_zero_source":
                    conn.execute("UPDATE batch_sources SET state='failed' WHERE job_id=? AND position=2", (job["id"],))
                elif change == "wrong_source_generation":
                    conn.execute("UPDATE batch_sources SET verified_generation=999 WHERE job_id=? AND position=2", (job["id"],))
                elif change == "failed_zero_page":
                    conn.execute("UPDATE batch_pages SET state='failed' WHERE job_id=? AND source_id=?", (job["id"], job["sources"][2]["source_id"]))
                elif change == "missing_zero_page":
                    conn.execute("DELETE FROM batch_pages WHERE job_id=? AND source_id=?", (job["id"], job["sources"][2]["source_id"]))
                elif change == "missing_zero_result":
                    conn.execute("DELETE FROM batch_page_results WHERE job_id=? AND source_id=?", (job["id"], job["sources"][2]["source_id"]))
                else:
                    conn.execute("UPDATE batch_jobs SET result_revision='old' WHERE id=?", (job["id"],))
    with pytest.raises(ExportScopeError):
        capture(export_task)


def test_frozen_revision_and_options_are_revalidated(export_task):
    save(export_task, export_task[4][:1])
    frozen = capture(export_task)
    database, review, _, _, records, request = export_task
    with BatchStore(database) as store:
        with hold_export_scope(store, review, request, expected_snapshot=frozen) as current:
            assert current["snapshot_digest"] == frozen["snapshot_digest"]
    changed_options = {**request, "include_xlsx": True}
    with BatchStore(database) as store:
        with pytest.raises(ExportScopeError):
            with hold_export_scope(store, review, changed_options, expected_snapshot=frozen):
                pytest.fail("modified frozen options accepted")
    updated = deepcopy(records[0])
    updated["record_revision"] = 1
    save(export_task, [updated])
    with pytest.raises(ExportScopeError):
        capture(export_task)


def test_all_scope_canonicalizes_original_order_and_exact_sources(export_task):
    save(export_task, export_task[4])
    request = deepcopy(export_task[5])
    request.update(scope_kind="all", selected_segment_ids=[r["id"] for r in reversed(export_task[4])],
                   expected_records=[{"id": r["id"], "record_revision": 1} for r in export_task[4]])
    frozen = capture(export_task, request)
    assert frozen["selected_segment_ids"] == [r["id"] for r in export_task[4]]
    assert frozen["summary"]["omitted_count"] == 0


def test_read_missing_review_db_never_creates_file(export_task):
    database, _, _, _, _, request = export_task
    missing = database.parent / "not-created" / "reviews.sqlite3"
    with BatchStore(database) as store:
        with pytest.raises(ExportScopeError):
            capture_export_scope(store, missing, request)
    assert not missing.parent.exists()


def test_verified_relocated_sources_remain_exportable(export_task):
    save(export_task, export_task[4][:1])
    database, review, job, paths, _, request = export_task
    relocated = paths[0].with_name("relocated-first.pdf")
    relocated.write_bytes(paths[0].read_bytes())
    with BatchStore(database) as store:
        store.relocate_source(job["id"], job["sources"][0]["source_id"], str(relocated),
                              job["sources"][0]["sha256"], job["sources"][0]["size_bytes"])
        prepare_batch_review(store, job["id"], job["result_revision"], review)
        frozen = capture_export_scope(store, review, request)
    assert frozen["sources"][0]["source_path"] == str(relocated)
