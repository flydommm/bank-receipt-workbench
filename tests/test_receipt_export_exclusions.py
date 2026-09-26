"""Excluded receipt decisions are attested without entering PDF/XLSX detail."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path

import openpyxl
import pymupdf
import pytest

from engine import export_publish
from engine.export_scope import ExportScopeError, _digest, hold_export_scope
from engine.batch_store import BatchStore
from engine.receipt_export_plan import build_receipt_output_plan, validate_receipt_exclusion_geometry
from engine.receipt_review_models import ReceiptReviewError, build_receipt_record, validate_receipt_context
from engine.review_store_v2 import ReviewStoreV2
from tests.test_batch_processor_receipt import receipt_calls
from tests.test_receipt_export_scope import capture, isolated_temp, receipt_export_task
from tests.test_receipt_export_bundle import bundle, register
from tests.test_receipt_review_models import _context, _edit, _original


def excluded_task(factory, *, excluded=(1,), pending=(), two_sources=False, full_page=None):
    task = factory(saved=False, two_sources=two_sources)
    edits = deepcopy(task[5])
    for index in excluded:
        edits[index]["review_status"] = "excluded"
    for index in pending:
        edits[index]["review_status"] = "needs_review"
    if full_page is not None:
        edits[full_page].update(crop_mode="full_page", final_rect=None, review_status="page_confirmed", manual_adjusted=False)
    with ReviewStoreV2(task[1]) as reviews:
        reviews.save(edits[0]["context_key"], task[2]["result_revision"], edits)
    request = deepcopy(task[6])
    request["scope_kind"] = "list"
    omitted = {task[4][index]["id"] for index in excluded}
    request["selected_segment_ids"] = [identifier for identifier in request["selected_segment_ids"] if identifier not in omitted]
    request["expected_records"] = [item for item in request["expected_records"] if item["id"] not in omitted]
    return task, request, edits


def restore(task, edits, index=1):
    edit = deepcopy(edits[index])
    edit.update(record_revision=1, review_status="needs_review", reviewed_at="2026-09-20T12:00:00.000Z")
    with ReviewStoreV2(task[1]) as reviews:
        reviews.save(edit["context_key"], task[2]["result_revision"], [edit])


def test_scope_omits_only_authoritative_exclusions_and_attests_decisions(receipt_export_task):
    task, request, edits = excluded_task(receipt_export_task)
    scope = capture(task, request)
    original = task[4][1]
    assert scope["summary"] == {"total_segments": 3, "selected_count": 2, "selected_source_count": 1,
                                "omitted_count": 1, "omitted_unresolved_count": 0, "excluded_count": 1, "expected_pages": 2}
    assert scope["excluded"] == [{
        **{key: original[key] for key in ("id", "source_key", "source_page", "instance_id", "slot_id", "position_index")},
        "source_sha256": task[2]["sources"][0]["sha256"], "record_revision": 1,
        "decision": "excluded", "reviewed_at": edits[1]["reviewed_at"],
    }]
    assert scope["excluded_digest"] == _digest(scope["excluded"])
    assert [record["original"]["position_index"] for record in scope["records"]] == [1, 3]
    assert set(scope["evidence_by_id"]) == set(request["selected_segment_ids"])
    assert scope["snapshot_digest"] == _digest({key: value for key, value in scope.items() if key != "snapshot_digest"})


def test_excluded_revision_and_timestamp_change_invalidates_scope_even_when_selection_is_unchanged(receipt_export_task):
    task, request, edits = excluded_task(receipt_export_task)
    frozen = capture(task, request)
    changed = deepcopy(edits[1])
    changed.update(record_revision=1, reviewed_at="2026-09-20T12:00:00.000Z")
    with ReviewStoreV2(task[1]) as reviews:
        reviews.save(changed["context_key"], task[2]["result_revision"], [changed])
    current = capture(task, request)
    assert current["selected_segment_ids"] == frozen["selected_segment_ids"]
    assert current["expected_records"] == frozen["expected_records"]
    for field in ("excluded_digest", "review_revision", "snapshot_digest"):
        assert current[field] != frozen[field]
    with BatchStore(task[0]) as store:
        with pytest.raises(ExportScopeError) as caught:
            with hold_export_scope(store, task[1], request, expected_snapshot=frozen):
                pytest.fail("changed exclusion decision must invalidate a frozen scope")
    assert caught.value.code == "export_scope_stale"


@pytest.mark.parametrize("kind", ["all", "sources", "list"])
def test_forged_request_cannot_export_an_excluded_receipt(receipt_export_task, kind):
    task, _, _ = excluded_task(receipt_export_task)
    request = deepcopy(task[6])
    request["scope_kind"] = kind
    with pytest.raises(ExportScopeError):
        capture(task, request)


@pytest.mark.parametrize("omit_pending", [False, True])
def test_pending_receipt_cannot_be_exported_or_silently_omitted(receipt_export_task, omit_pending):
    task, request, _ = excluded_task(receipt_export_task, pending=(2,))
    if omit_pending:
        request["selected_segment_ids"] = request["selected_segment_ids"][:1]
        request["expected_records"] = request["expected_records"][:1]
    with pytest.raises(ExportScopeError):
        capture(task, request)


def test_all_excluded_refuses_empty_or_forged_nonempty_export(receipt_export_task):
    task, request, _ = excluded_task(receipt_export_task, excluded=(0, 1, 2))
    with pytest.raises(ExportScopeError):
        capture(task, request)
    with pytest.raises(ExportScopeError, match="all receipts are excluded"):
        capture(task, task[6])


def test_same_page_full_page_cannot_reintroduce_excluded_region(receipt_export_task):
    task, request, _ = excluded_task(receipt_export_task, full_page=0)
    with pytest.raises(ExportScopeError, match="full-page.*excluded"):
        capture(task, request)


def test_same_bytes_in_another_source_does_not_create_false_geometry_conflict(receipt_export_task):
    task, request, _ = excluded_task(receipt_export_task, excluded=(3, 4, 5), two_sources=True, full_page=0)
    scope = capture(task, request)
    assert scope["summary"]["selected_count"] == 3 and scope["summary"]["excluded_count"] == 3
    assert scope["summary"]["selected_source_count"] == 1


@pytest.mark.parametrize("overlap,blocked", [(0, False), (1e-12, False), (1e-6, True), (100, True)])
def test_crop_overlap_ignores_only_machine_epsilon_at_adjacent_edges(overlap, blocked):
    selected = {"original": {"source_key": "/synthetic.pdf", "source_page": 1}, "crop_mode": "candidate",
                "final_rect": {"x0": 0, "y0": 0, "x1": 600, "y1": 300 + overlap}}
    excluded = {"original": {"source_key": "/synthetic.pdf", "source_page": 1,
                             "candidate_rect": {"x0": 0, "y0": 300, "x1": 600, "y1": 600}}}
    if blocked:
        with pytest.raises(ReceiptReviewError, match="excluded receipt region"):
            validate_receipt_exclusion_geometry([selected], [excluded])
    else:
        validate_receipt_exclusion_geometry([selected], [excluded])


def test_plan_cannot_output_excluded_records_or_overlapping_selected_crop():
    context = validate_receipt_context(_context(mode="split_all"))
    source = context[0]["sources"][0]
    sources = [{**source, "name": "synthetic.pdf"}]
    records = []
    for index, state in enumerate(("confirmed", "excluded")):
        original = _original(slot_id=f"slot-{index + 1}", position_index=index + 1, item_id=str(index + 1) * 64)
        original["selection_basis"] = "occupied_slot"
        edit = _edit(context[2], original, status=state)
        records.append(build_receipt_record(original, edit, source["source_path"], source["source_sha256"], 1))
    options = context[0]["processing_options"]
    with pytest.raises(ReceiptReviewError):
        build_receipt_output_plan(sources, records, {}, options, "merged", "")
    with pytest.raises(ReceiptReviewError, match="excluded receipt region"):
        build_receipt_output_plan(sources, records[:1], {}, options, "merged", "", excluded_records=records[1:])


@pytest.mark.parametrize("mode,expected_files,multiplier", [("merged", 1, 1), ("by_source", 2, 1), ("both", 3, 2)])
def test_real_bundle_omits_excluded_pdf_and_xlsx_detail_but_audits_manifest(
    receipt_export_task, monkeypatch, mode, expected_files, multiplier,
):
    task, request, _ = excluded_task(receipt_export_task, two_sources=True, excluded=(1, 4))
    request["output_mode"] = mode
    before = [sha256(path.read_bytes()).hexdigest() for path in task[3]]
    service = bundle(task, monkeypatch)
    created = service.create(request)
    assert len(created["files"]) == expected_files
    assert created["summary"]["excluded_count"] == 2
    assert len(created["excluded"]) == 2 and created["excluded_digest"] == _digest(created["excluded"])
    register(service, created)
    rendered = service.render(created["intent_id"])
    assert rendered["excluded"] == created["excluded"] and rendered["excluded_digest"] == created["excluded_digest"]
    assert rendered["total_pages"] == 4 * multiplier
    for file in rendered["files"]:
        with pymupdf.open(file["preview_path"]) as document:
            assert all("slot 2" not in page.get_text() for page in document)
            assert all("slot 1" in page.get_text() or "slot 3" in page.get_text() for page in document)
    destination = task[0].parent / "published"
    destination.mkdir()
    receipt = export_publish.publish_bundle(service, created["intent_id"], destination)
    assert receipt["row_count"] == 4 and receipt["summary"] == created["summary"]
    assert receipt["excluded"] == created["excluded"] and receipt["excluded_digest"] == created["excluded_digest"]
    manifest = json.loads((Path(receipt["directory"]) / "导出清单.json").read_text(encoding="utf-8"))
    assert manifest["scope"]["excluded"] == created["excluded"]
    assert manifest["scope"]["excluded_digest"] == created["excluded_digest"]
    assert {row["position_index"] for row in manifest["plan"]["mappings"]} == {1, 3}
    xlsx = next(file["path"] for file in receipt["files"] if file["kind"] == "xlsx")
    workbook = openpyxl.load_workbook(xlsx, read_only=True)
    try:
        for sheet in ("索引", "输出映射"):
            rows = list(workbook[sheet].values)
            position = rows[0].index("position_index")
            assert {row[position] for row in rows[1:]} == {1, 3}
        assert len(list(workbook["索引"].values)) == 5
        assert len(list(workbook["输出映射"].values)) == 4 * multiplier + 1
    finally:
        workbook.close()
    service.close(created["intent_id"])
    assert export_publish.status_bundle(service, task[2]["id"])["publication"] == receipt
    assert [sha256(path.read_bytes()).hexdigest() for path in task[3]] == before


@pytest.mark.parametrize("stage", ["before_render", "before_publish", "during_publish"])
def test_restoring_excluded_receipt_invalidates_frozen_preview(receipt_export_task, monkeypatch, stage):
    task, request, edits = excluded_task(receipt_export_task)
    service = bundle(task, monkeypatch)
    created = service.create(request)
    register(service, created)
    if stage == "before_render":
        restore(task, edits)
        with pytest.raises(ExportScopeError):
            service.render(created["intent_id"])
        assert not list(service.preview_root.glob("*.pdf"))
        return
    service.render(created["intent_id"])
    if stage == "before_publish":
        restore(task, edits)
    else:
        write_json = export_publish._write_json_exclusive

        def restore_during_assembly(path, value):
            result = write_json(path, value)
            restore(task, edits)
            return result

        monkeypatch.setattr(export_publish, "_write_json_exclusive", restore_during_assembly)
    destination = task[0].parent / "stale-output"
    destination.mkdir()
    with pytest.raises((ExportScopeError, export_publish.ExportPublishError)):
        export_publish.publish_bundle(service, created["intent_id"], destination)
    assert not any((path / "导出清单.json").exists() for path in destination.iterdir() if not path.name.startswith("."))


@pytest.mark.parametrize("mutation", ["missing", "decision", "revision", "digest", "count"])
def test_published_exclusion_receipt_rejects_corrupt_audit(receipt_export_task, monkeypatch, mutation):
    task, request, _ = excluded_task(receipt_export_task)
    service = bundle(task, monkeypatch)
    created = service.create(request)
    register(service, created)
    service.render(created["intent_id"])
    destination = task[0].parent / "published"
    destination.mkdir()
    published = export_publish.publish_bundle(service, created["intent_id"], destination)
    damaged = deepcopy(published)
    if mutation == "missing":
        damaged.pop("excluded")
    elif mutation == "decision":
        damaged["excluded"][0]["decision"] = "confirmed"
    elif mutation == "revision":
        damaged["excluded"][0]["record_revision"] = 0
    elif mutation == "digest":
        damaged["excluded_digest"] = "0" * 64
    else:
        damaged["summary"]["excluded_count"] = 0
    with pytest.raises(export_publish.ExportPublishError):
        export_publish._validated_receipt({"intent_id": published["intent_id"], "receipt_schema": 2, "receipt": damaged})
