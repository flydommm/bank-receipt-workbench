"""Bundle performance boundaries, using generated receipts and real ownership."""

from collections import Counter
from pathlib import Path

import pytest

from engine import engine as core
from engine.batch_review import prepare_batch_review
from engine.batch_store import BatchStore
from engine.export_journal import JournalRecord
from engine.export_scope import ExportScopeError
from engine.review_store_v2 import ReviewStoreV2
from tests.test_batch_receipt_review import _make_edit
from tests.test_receipt_export_bundle import bundle, register
from tests.test_receipt_grouping_integration import grouping_task, call, prepare_and_page


def _grouped_bundle(task, monkeypatch, mode="by_counterparty"):
    with BatchStore(task[0]) as store:
        prepared = prepare_batch_review(store, task[2]["id"], task[2]["result_revision"], task[1])["prepared"]
        originals = store.review_snapshot(task[2]["id"], task[2]["result_revision"])["originals"]
    with ReviewStoreV2(task[1]) as reviews:
        reviews.save(prepared["context_key"], task[2]["result_revision"], [
            _make_edit(prepared["context_key"], task[2]["result_revision"], item) for item in originals
        ])
    header, page = prepare_and_page(task)
    header = call(task, "batch_receipt_grouping_refresh", job_id=header["job_id"],
                  result_revision=header["result_revision"], expected_grouping_revision=header["grouping_revision"],
                  expected_review_fingerprint=header["review_fingerprint"],
                  segment_ids=[item["binding"]["segment_id"] for item in page["items"]])["header"]
    request = {
        "job_id": header["job_id"], "result_revision": header["result_revision"], "scope_kind": "list",
        "selected_segment_ids": [item["id"] for item in originals],
        "expected_records": [{"id": item["id"], "record_revision": 1} for item in originals],
        "output_mode": mode, "include_xlsx": True, "include_manifest": True,
        "include_counterparty_pending": False, "expected_grouping_revision": header["grouping_revision"],
        "expected_review_fingerprint": header["review_fingerprint"],
        "own_account_fingerprint": header["own_account"]["fingerprint"],
    }
    service = bundle(task, monkeypatch)
    created = service.create(request)
    register(service, created)
    return service, created


@pytest.mark.parametrize("mode", ["by_counterparty", "by_counterparty_merged"])
def test_render_source_copies_and_checkpoints_do_not_scale_with_groups(grouping_task, monkeypatch, mode):
    service, created = _grouped_bundle(grouping_task, monkeypatch, mode)
    counts = Counter()
    snapshot_paths = []
    original_copy = core._snapshot_pdf_source
    original_save = JournalRecord.save

    def count_copy(*args, **kwargs):
        copied = original_copy(*args, **kwargs)
        counts["source_copies"] += 1
        snapshot_paths.append(copied.path)
        return copied

    def count_save(self, data):
        counts["journal_saves"] += 1
        return original_save(self, data)

    monkeypatch.setattr(core, "_snapshot_pdf_source", count_copy)
    monkeypatch.setattr(JournalRecord, "save", count_save)
    rendered = service.render(created["intent_id"])
    assert rendered["total_pages"] == 3
    assert len(rendered["files"]) == (2 if mode == "by_counterparty" else 1)
    # One full source check at each scope boundary, one private render copy.
    assert counts == {"source_copies": 3, "journal_saves": 1}
    assert all(not path.exists() for path in snapshot_paths)
    assert core._PDF_EXPORT_SOURCE_CACHE.get() is None
    loaded = service.journal.load(created["intent_id"])
    assert loaded["state"] == "rendered"
    assert all(file["sha256"] and file["identity"] for file in loaded["files"])


@pytest.mark.parametrize("crash", [False, True])
def test_partial_render_cleans_all_owned_tokens_without_progress_checkpoints(grouping_task, monkeypatch, crash):
    service, created = _grouped_bundle(grouping_task, monkeypatch)
    original_export = core._export_pdf_response
    calls = 0

    class SimulatedCrash(BaseException):
        pass

    def fail_second(request):
        nonlocal calls
        calls += 1
        if calls == 2:
            if crash:
                raise SimulatedCrash()
            return {"status": "error", "code": "pdf_export_failed"}
        return original_export(request)

    monkeypatch.setattr(core, "_export_pdf_response", fail_second)
    with pytest.raises(SimulatedCrash if crash else ExportScopeError):
        service.render(created["intent_id"])
    assert core._PDF_EXPORT_SOURCE_CACHE.get() is None
    assert len(list(service.preview_root.glob("*.pdf"))) == 1
    loaded = service.journal.load(created["intent_id"])
    assert loaded["state"] == "created"
    assert all("sha256" not in file for file in loaded["files"])
    # Recovery needs the initially anchored tokens, not per-file progress.
    service.reconcile([])
    assert not list(service.preview_root.glob("*.pdf"))


def test_shared_render_snapshot_does_not_bypass_final_source_check(grouping_task, monkeypatch):
    service, created = _grouped_bundle(grouping_task, monkeypatch)
    original_export = core._export_pdf_response
    source = grouping_task[3]
    original_bytes = source.read_bytes()
    calls = 0

    def change_original_after_first(request):
        nonlocal calls
        response = original_export(request)
        calls += 1
        if calls == 1:
            # Only the generated fixture is changed; the second PDF must use
            # its immutable copy, and the final scope check must reject it.
            source.write_bytes(original_bytes + b"\n% synthetic change\n")
        return response

    monkeypatch.setattr(core, "_export_pdf_response", change_original_after_first)
    try:
        with pytest.raises(ExportScopeError) as failure:
            service.render(created["intent_id"])
        assert failure.value.code == "source_changed"
        assert calls == 2
        assert service.journal.load(created["intent_id"])["state"] == "created"
        assert core._PDF_EXPORT_SOURCE_CACHE.get() is None
        service.close(created["intent_id"])
        assert not list(service.preview_root.glob("*.pdf"))
    finally:
        source.write_bytes(original_bytes)
