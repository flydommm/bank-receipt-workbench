"""Real receipt previews and local publication, using generated test PDFs."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path

import openpyxl
import pymupdf
import pytest

from engine import engine as core
from engine import export_publish
from engine.batch_previews import register_preview
from engine.batch_store import BatchStore
from engine.export_bundle import ExportBundleService
from engine.export_scope import ExportScopeError
from engine.review_store_v2 import ReviewStoreV2
from tests.test_batch_processor_receipt import SEARCH, SPLIT, receipt_calls
from tests.test_receipt_export_scope import isolated_temp, receipt_export_task
from tests.test_batch_receipt_review import _run_receipt_job
from tests.test_receipt_batch_pdf import make_source, SEARCH as AUTO_SEARCH
from engine.batch_review import prepare_batch_review
from engine.receipt_review_read import read_receipt_review_snapshot


def bundle(task, monkeypatch):
    batch, review = task[:2]
    root = batch.parent / "export-intents"
    previews = batch.parent / "export-previews"
    root.mkdir()
    previews.mkdir()
    monkeypatch.setattr(core, "EXPORT_OWNERSHIP_DIR", batch.parent / ".owned")
    return ExportBundleService(batch, review, root, previews)


def register(service, created):
    with BatchStore(service.batch_database) as store:
        for item in created["files"]:
            register_preview(store, created["job_id"], item["preview_token"], service.preview_root)


def test_automatic_candidates_export_without_persisting_fake_review(tmp_path, monkeypatch):
    source = make_source(tmp_path, (3,))
    batch, review = tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3"
    before = sha256(source.read_bytes()).hexdigest()
    with BatchStore(batch) as store:
        store.activate_supervisor("host")
        job = _run_receipt_job(store, [source], AUTO_SEARCH)
        prepared = prepare_batch_review(store, job["id"], job["result_revision"], review)["prepared"]
        originals = store.review_snapshot(job["id"], job["result_revision"])["originals"]
    assert len(originals) == 3 and not any(item["needs_review"] for item in originals)
    service = bundle((batch, review), monkeypatch)
    request = {"job_id": job["id"], "result_revision": job["result_revision"], "scope_kind": "list",
               "selected_segment_ids": [item["id"] for item in originals],
               "expected_records": [{"id": item["id"], "record_revision": 0} for item in originals],
               "output_mode": "merged", "include_xlsx": True}
    created = service.create(request)
    register(service, created)
    rendered = service.render(created["intent_id"])
    with pymupdf.open(rendered["files"][0]["preview_path"]) as document:
        assert len(document) == 3
        assert all("TARGET" in page.get_text() and page.rect.height < 350 for page in document)
    destination = tmp_path / "output"
    destination.mkdir()
    published = export_publish.publish_bundle(service, created["intent_id"], destination)
    assert published["state"] == "published" and published["row_count"] == 3
    snapshot = read_receipt_review_snapshot(review, prepared["context_key"], job["result_revision"])
    assert snapshot["segments"] == []
    assert all(item["record_revision"] == 0 for item in snapshot["record_revisions"])
    assert sha256(source.read_bytes()).hexdigest() == before


@pytest.mark.parametrize("options,selected", [(SEARCH, 2), (SPLIT, 6)])
@pytest.mark.parametrize("mode,file_count,multiplier", [("merged", 1, 1), ("by_source", 2, 1), ("both", 3, 2)])
def test_receipt_modes_create_render_publish_indexes_and_restore(
    receipt_export_task, monkeypatch, options, selected, mode, file_count, multiplier,
):
    task = receipt_export_task(options, two_sources=True)
    service = bundle(task, monkeypatch)
    request = deepcopy(task[6])
    request["output_mode"] = mode
    before = [sha256(path.read_bytes()).hexdigest() for path in task[3]]
    created = service.create(request)
    assert len(created["files"]) == file_count
    assert created["summary"]["selected_count"] == selected
    register(service, created)
    rendered = service.render(created["intent_id"])
    assert rendered["total_pages"] == selected * multiplier
    with service.journal.locked(created["intent_id"]) as record:
        plan = deepcopy(record.data["plan"])
    assert plan["schema"] == 2
    for file, planned in zip(rendered["files"], plan["files"], strict=True):
        with pymupdf.open(file["preview_path"]) as document:
            assert document.page_count == planned["page_count"]
            for page, clip in zip(document, planned["pages"], strict=True):
                rect = clip["rect"]
                assert page.rect.width == pytest.approx(rect["x1"] - rect["x0"], abs=1e-3)
                assert page.rect.height == pytest.approx(rect["y1"] - rect["y0"], abs=1e-3)
                assert f"slot {clip['position_index']}" in page.get_text()
        assert sha256(Path(file["preview_path"]).read_bytes()).hexdigest() == file["sha256"]
    output = task[0].parent / "output"
    output.mkdir()
    receipt = export_publish.publish_bundle(service, created["intent_id"], output)
    assert receipt["state"] == "published" and receipt["row_count"] == selected
    manifest = json.loads((Path(receipt["directory"]) / "导出清单.json").read_text(encoding="utf-8"))
    assert manifest["version"] == 2
    assert manifest["scope"]["processing_mode"] == options["processing_mode"]
    assert len(manifest["plan"]["mappings"]) == selected * multiplier
    assert all("instance_id" in mapping and "segment_no" not in mapping for mapping in manifest["plan"]["mappings"])
    xlsx = next(file["path"] for file in receipt["files"] if file["kind"] == "xlsx")
    workbook = openpyxl.load_workbook(xlsx, read_only=True)
    try:
        headers = [cell.value for cell in next(workbook["索引"].rows)]
        assert "instance_id" in headers and "processing_mode" in headers
        assert not {"segment_no", "matched_text", "confidence"}.intersection(headers)
        assert sum(1 for _ in workbook["索引"].rows) == selected + 1
        assert sum(1 for _ in workbook["输出映射"].rows) == selected * multiplier + 1
    finally:
        workbook.close()
    assert [sha256(path.read_bytes()).hexdigest() for path in task[3]] == before
    service.close(created["intent_id"])
    assert not list(service.preview_root.glob("*.pdf"))
    assert export_publish.status_bundle(service, task[2]["id"])["publication"] == receipt


def test_receipt_revision_changes_during_publication_do_not_publish_stale_preview(receipt_export_task, monkeypatch):
    task = receipt_export_task()
    service = bundle(task, monkeypatch)
    created = service.create(task[6])
    register(service, created)
    service.render(created["intent_id"])
    write_json = export_publish._write_json_exclusive

    def change_review(path, value):
        # This is after file assembly, before the final batch/review guard and
        # directory rename. The final guard must notice the intervening save.
        result = write_json(path, value)
        edit = deepcopy(task[5][0])
        edit["record_revision"] = 1
        with ReviewStoreV2(task[1]) as reviews:
            reviews.save(edit["context_key"], task[2]["result_revision"], [edit])
        return result

    monkeypatch.setattr(export_publish, "_write_json_exclusive", change_review)
    destination = task[0].parent / "stale-output"
    destination.mkdir()
    with pytest.raises((ExportScopeError, export_publish.ExportPublishError)):
        export_publish.publish_bundle(service, created["intent_id"], destination)
    assert not any((path / "导出清单.json").exists() for path in destination.iterdir() if not path.name.startswith("."))


def test_receipt_source_change_prevents_render(receipt_export_task, monkeypatch):
    task = receipt_export_task()
    service = bundle(task, monkeypatch)
    created = service.create(task[6])
    register(service, created)
    with task[3][0].open("ab") as output:
        output.write(b"synthetic change before preview")
    with pytest.raises(ExportScopeError):
        service.render(created["intent_id"])
    assert not list(service.preview_root.glob("*.pdf"))
