"""Receipt export uses persisted revisions and real synthetic PDF geometry."""

from copy import deepcopy
from hashlib import sha256
import json

import pytest

from engine.batch_review import prepare_batch_review
from engine.batch_store import BatchStore
from engine.export_scope import ExportScopeError, capture_export_scope, hold_export_scope
from engine.review_store_v2 import ReviewStoreV2
from tests.test_batch_processor_receipt import SEARCH, SPLIT, make_pdf, receipt_calls
from tests.test_batch_receipt_review import _make_edit, _run_receipt_job


@pytest.fixture(autouse=True)
def isolated_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))


@pytest.fixture
def receipt_export_task(tmp_path, receipt_calls):
    def create(options=SPLIT, *, two_sources=False, saved=True):
        paths = [make_pdf(tmp_path)]
        if two_sources:
            second = tmp_path / "second.pdf"
            second.write_bytes(paths[0].read_bytes())
            paths.append(second)
        batch = tmp_path / "batch.sqlite3"
        review = tmp_path / "review.sqlite3"
        with BatchStore(batch) as store:
            store.activate_supervisor("host")
            job = _run_receipt_job(store, paths, options)
            prepared = prepare_batch_review(store, job["id"], job["result_revision"], review)["prepared"]
            originals = store.review_snapshot(job["id"], job["result_revision"])["originals"]
        edits = [_make_edit(prepared["context_key"], job["result_revision"], item) for item in originals]
        if saved:
            with ReviewStoreV2(review) as reviews:
                reviews.save(prepared["context_key"], job["result_revision"], edits)
        request = {"job_id": job["id"], "result_revision": job["result_revision"], "scope_kind": "all",
                   "selected_segment_ids": [item["id"] for item in originals],
                   "expected_records": [{"id": item["id"], "record_revision": 1} for item in originals],
                   "output_mode": "merged", "include_xlsx": True}
        return batch, review, job, paths, originals, edits, request
    return create


def capture(task, request=None):
    with BatchStore(task[0]) as store:
        return capture_export_scope(store, task[1], task[6] if request is None else request)


@pytest.mark.parametrize("options,count,positions", [(SEARCH, 1, [3]), (SPLIT, 3, [1, 2, 3])])
def test_real_receipt_modes_bind_geometry_evidence_and_order(receipt_export_task, options, count, positions):
    task = receipt_export_task(options)
    before = sha256(task[3][0].read_bytes()).hexdigest()
    scope = capture(task)
    assert scope["schema"] == 2 and scope["processing_options"] == options
    assert scope["summary"]["expected_pages"] == count
    assert [record["original"]["position_index"] for record in scope["records"]] == positions
    assert len(scope["selected_segment_ids"]) == count
    assert all(bool(value) == (options == SEARCH) for value in scope["evidence_by_id"].values())
    assert all("segment_no" not in record["original"] for record in scope["records"])
    assert sha256(task[3][0].read_bytes()).hexdigest() == before


def test_same_bytes_distinct_sources_and_reversed_request_keep_source_slot_order(receipt_export_task):
    task = receipt_export_task(two_sources=True)
    request = deepcopy(task[6])
    request["selected_segment_ids"].reverse()
    request["expected_records"].reverse()
    scope = capture(task, request)
    assert scope["summary"]["expected_pages"] == 6
    assert [record["original"]["position_index"] for record in scope["records"]] == [1, 2, 3, 1, 2, 3]
    assert len({record["original"]["source_key"] for record in scope["records"]}) == 2
    assert len({record["original"]["instance_id"] for record in scope["records"]}) == 3


@pytest.mark.parametrize("status", ["pending", "needs_review", "blocked"])
def test_unresolved_saved_receipt_cannot_be_exported(receipt_export_task, status):
    task = receipt_export_task(saved=False)
    edits = deepcopy(task[5])
    edits[0]["review_status"] = status
    with ReviewStoreV2(task[1]) as reviews:
        reviews.save(edits[0]["context_key"], task[2]["result_revision"], edits)
    with pytest.raises(ExportScopeError, match="resolved"):
        capture(task)


def test_full_page_confirmation_deduplicates_instances_on_the_same_page(receipt_export_task):
    task = receipt_export_task(saved=False)
    edits = deepcopy(task[5])
    for edit in edits:
        edit.update(crop_mode="full_page", final_rect=None, review_status="page_confirmed", manual_adjusted=False)
    with ReviewStoreV2(task[1]) as reviews:
        reviews.save(edits[0]["context_key"], task[2]["result_revision"], edits)
    scope = capture(task)
    assert scope["summary"]["selected_count"] == 3
    assert scope["summary"]["expected_pages"] == 1


def test_receipt_scope_cannot_omit_any_retained_receipt(receipt_export_task):
    task = receipt_export_task()
    request = deepcopy(task[6])
    request["selected_segment_ids"] = request["selected_segment_ids"][1:2]
    request["expected_records"] = request["expected_records"][1:2]
    for kind in ("all", "sources", "list"):
        request["scope_kind"] = kind
        with pytest.raises(ExportScopeError, match="complete|all receipts"):
            capture(task, request)


def test_receipt_scope_requires_current_selected_revisions(receipt_export_task):
    task = receipt_export_task()
    request = deepcopy(task[6])
    request["expected_records"][0]["record_revision"] += 1
    with pytest.raises(ExportScopeError) as caught:
        capture(task, request)
    assert caught.value.code == "export_scope_stale"


def test_frozen_scope_refuses_review_changes_before_publish(receipt_export_task):
    task = receipt_export_task()
    frozen = capture(task)
    edit = deepcopy(task[5][0])
    edit["record_revision"] = 1
    edit.update(crop_mode="manual", manual_adjusted=True)
    edit["final_rect"]["y1"] -= 2
    with ReviewStoreV2(task[1]) as reviews:
        reviews.save(edit["context_key"], task[2]["result_revision"], [edit])
    with BatchStore(task[0]) as store:
        with pytest.raises(ExportScopeError):
            with hold_export_scope(store, task[1], task[6], expected_snapshot=frozen):
                pytest.fail("stale frozen scope must not reach publication")


@pytest.mark.parametrize("review_status", ["needs_review", "confirmed"])
def test_manual_classification_invalidates_frozen_export_and_uses_new_decision(receipt_export_task, review_status):
    task = receipt_export_task()
    frozen = capture(task)
    original_hash = sha256(task[3][0].read_bytes()).hexdigest()
    edit = deepcopy(task[5][0])
    edit.update(record_revision=1, document_type="other_special", review_status=review_status)
    with ReviewStoreV2(task[1]) as reviews:
        saved = reviews.save(edit["context_key"], task[2]["result_revision"], [edit])
    assert saved["segments"][0]["document_type"] == "other_special"
    with BatchStore(task[0]) as store:
        with pytest.raises(ExportScopeError):
            with hold_export_scope(store, task[1], task[6], expected_snapshot=frozen):
                pytest.fail("classification changes must invalidate an earlier export")
    current = deepcopy(task[6])
    current["expected_records"][0]["record_revision"] = 2
    if review_status == "needs_review":
        with pytest.raises(ExportScopeError, match="resolved"):
            capture(task, current)
    else:
        scope = capture(task, current)
        assert scope["records"][0]["document_type"] == "other_special"
        assert scope["records"][0]["final_rect"] == frozen["records"][0]["final_rect"]
        assert scope["records"][1:] == frozen["records"][1:]
        assert scope["summary"]["expected_pages"] == frozen["summary"]["expected_pages"]
    assert sha256(task[3][0].read_bytes()).hexdigest() == original_hash


def test_changed_source_and_corrupt_published_evidence_are_rejected(receipt_export_task):
    task = receipt_export_task(SEARCH)
    with BatchStore(task[0]) as store:
        row = store.connection.execute("SELECT payload_json FROM batch_snapshot_items").fetchone()
        payload = json.loads(row[0])
        payload["evidence"][0]["query_id"] = "include-1"
        store.connection.execute("UPDATE batch_snapshot_items SET payload_json=?", (json.dumps(payload),))
        store.connection.commit()
    with pytest.raises(ExportScopeError):
        capture(task)


def test_changed_source_sha_refuses_export_without_rewriting_original(receipt_export_task):
    task = receipt_export_task()
    with task[3][0].open("ab") as stream:
        stream.write(b"synthetic source mutation")
    changed = sha256(task[3][0].read_bytes()).hexdigest()
    with pytest.raises(ExportScopeError) as caught:
        capture(task)
    assert caught.value.code == "source_changed"
    assert sha256(task[3][0].read_bytes()).hexdigest() == changed
