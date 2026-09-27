"""Synthetic schema-2 receipt review API contract tests."""

from copy import deepcopy
from dataclasses import replace
import pytest

from engine.batch_pdf import BatchPdfSource
from engine.batch_processor import BatchProcessor, BatchProgress
from engine.batch_store import BatchStore
from engine.computation import current_computation_version
from engine.engine import handle_request
from tests.test_batch_processor_receipt import SEARCH, SPLIT, make_pdf
from tests.test_receipt_review_models import _edit


def request(database, op, **fields):
    return handle_request({"op": op, "database_path": str(database), **fields})


@pytest.fixture(autouse=True)
def isolated_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))


@pytest.fixture
def receipt_calls(monkeypatch):
    original = BatchPdfSource.compute_receipt_page
    calls = []

    def compute(source, page, options, mode, budget):
        calls.append((page, deepcopy(options), mode))
        return original(source, page, options, mode, budget, slot_count=3, allow_ocr=False)

    monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", compute)
    return calls


def _create_and_run(tmp_path, options, _receipt_calls):
    path = make_pdf(tmp_path, "receipt.pdf")
    database = tmp_path / "batch.sqlite3"
    response = request(
        database,
        "batch_create_receipts",
        name="synthetic receipt",
        sources=[{"source_path": str(path), "name": path.name}],
        processing_options=deepcopy(options),
        match_mode="exact",
    )
    assert response["status"] == "ok", response
    job = response["data"]
    version = current_computation_version()
    with BatchStore(database) as store:
        store.activate_supervisor("host")
        running = store.start_job(job["id"], 0, "host", version)
        ready = BatchProcessor(
            store,
            job["id"],
            running["generation"],
            "host",
            version,
            BatchProgress(lambda *_args: None),
        ).run()
    assert ready["state"] == "ready_for_review"
    return database, tmp_path / "review.sqlite3", ready, path


def _prepare(database, review, ready):
    return request(
        database,
        "batch_prepare_review",
        review_database_path=str(review),
        job_id=ready["id"],
        result_revision=ready["result_revision"],
    )


def _page(database, review, ready, *, offset=0, limit=200):
    return request(
        database,
        "batch_receipt_review_page",
        review_database_path=str(review),
        job_id=ready["id"],
        result_revision=ready["result_revision"],
        offset=offset,
        limit=limit,
    )


def _make_edit(context_key, revision, original, record_revision=0):
    edit = _edit(context_key, original, revision=record_revision)
    edit["result_revision"] = revision
    return edit


@pytest.mark.parametrize(
    ("options", "expected_total"),
    [(SEARCH, 1), (SPLIT, 3)],
    ids=["search", "split_all"],
)
def test_receipt_create_prepare_and_page_use_compact_contract(
    tmp_path, options, expected_total, receipt_calls,
):
    database, review, ready, _path = _create_and_run(tmp_path, options, receipt_calls)

    prepared = _prepare(database, review, ready)
    assert prepared["status"] == "ok", prepared
    compact = prepared["data"]["prepared"]
    assert compact == {
        "status": "ok",
        "schema_version": 1,
        "context_key": compact["context_key"],
        "result_revision": ready["result_revision"],
        "total": expected_total,
    }
    assert "segments" not in compact and "record_revisions" not in compact

    first = _page(database, review, ready, limit=2)
    assert first["status"] == "ok", first
    value = first["data"]
    assert value["schema_version"] == 1
    assert value["context_key"] == compact["context_key"]
    assert value["result_revision"] == ready["result_revision"]
    assert value["offset"] == 0 and value["limit"] == 2 and value["total"] == expected_total
    assert len(value["items"]) == min(2, expected_total)
    assert all(set(item) == {"original", "record_revision", "record"} for item in value["items"])
    assert all(item["record"] is None and item["record_revision"] == 0 for item in value["items"])

    if expected_total > 2:
        second = _page(database, review, ready, offset=value["next_offset"], limit=2)
        assert second["status"] == "ok"
        assert second["data"]["offset"] == 2
        assert second["data"]["next_offset"] is None


def test_save_accepts_only_mutable_edits_and_page_restores_by_logical_identity(tmp_path, receipt_calls):
    database, review, ready, _path = _create_and_run(tmp_path, SPLIT, receipt_calls)
    prepared = _prepare(database, review, ready)["data"]["prepared"]
    initial = _page(database, review, ready)["data"]
    target = initial["items"][1]
    edit = _make_edit(prepared["context_key"], ready["result_revision"], target["original"])

    saved = request(
        database,
        "batch_save_receipt_review",
        review_database_path=str(review),
        job_id=ready["id"],
        result_revision=ready["result_revision"],
        edits=[edit],
    )
    assert saved["status"] == "ok", saved
    assert saved["data"]["schema_version"] == 1
    assert saved["data"]["saved_count"] == 1
    assert len(saved["data"]["segments"]) == 1
    assert saved["data"]["segments"][0]["original"] == target["original"]

    restored = _page(database, review, ready)["data"]["items"][1]
    assert restored["record_revision"] == 1
    assert restored["record"]["original"] == target["original"]
    assert restored["record"]["record_revision"] == 1


@pytest.mark.parametrize("automatic_type", [None, "loan_interest_notice"])
def test_manual_classification_notice_is_per_slot_and_can_override_detection(
    tmp_path, receipt_calls, monkeypatch, automatic_type,
):
    if automatic_type is not None:
        compute = BatchPdfSource.compute_receipt_page

        def with_notice(*args, **kwargs):
            result = compute(*args, **kwargs)
            return replace(result, diagnostics=(*result.diagnostics,
                {"code": "special_document", "document_type": automatic_type}))

        monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", with_notice)
    database, review, ready, _path = _create_and_run(tmp_path, SPLIT, receipt_calls)
    prepared = _prepare(database, review, ready)["data"]["prepared"]
    items = _page(database, review, ready)["data"]["items"]
    edits = []
    for index, kind in [(0, "ordinary"), (1, "other_special")]:
        edit = _make_edit(prepared["context_key"], ready["result_revision"], items[index]["original"])
        edit.update(document_type=kind, review_status="needs_review")
        edits.append(edit)
    saved = request(database, "batch_save_receipt_review", review_database_path=str(review),
                    job_id=ready["id"], result_revision=ready["result_revision"], edits=edits)
    assert saved["status"] == "ok", saved
    current = _page(database, review, ready)["data"]["items"]
    assert "page_notice" not in current[0]
    assert current[1]["page_notice"] == {"code": "special_document", "document_type": "other_special"}
    assert current[0]["record"]["document_type"] == "ordinary"
    assert current[1]["record"]["document_type"] == "other_special"
    assert current[2] == items[2]
    assert [item["original"] for item in current] == [item["original"] for item in items]


@pytest.mark.parametrize("document_type", ["loan_interest_notice", "loan_settlement_notice", "electronic_tax_payment"])
def test_special_document_notice_is_derived_from_checkpoint_without_changing_original(
    tmp_path, receipt_calls, monkeypatch, document_type,
):
    compute = BatchPdfSource.compute_receipt_page
    notice = {"code": "special_document", "document_type": document_type}

    def with_notice(*args, **kwargs):
        result = compute(*args, **kwargs)
        return replace(result, diagnostics=(*result.diagnostics, notice))

    monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", with_notice)
    database, review, ready, _path = _create_and_run(tmp_path, SPLIT, receipt_calls)
    assert _prepare(database, review, ready)["status"] == "ok"
    with BatchStore(database) as store:
        originals = store.review_snapshot(ready["id"], ready["result_revision"])["originals"]
    response = _page(database, review, ready)
    assert response["status"] == "ok", response
    items = response["data"]["items"]
    assert [item["original"] for item in items] == originals
    assert all(item["page_notice"] == notice for item in items)
    assert all("page_notice" not in item["original"] for item in items)
    assert all(set(item) == {"original", "record_revision", "record", "page_notice"} for item in items)


def test_suspected_invalid_slot_notice_is_per_slot_and_never_excludes(tmp_path, receipt_calls, monkeypatch):
    compute = BatchPdfSource.compute_receipt_page

    def with_suggestion(*args, **kwargs):
        result = compute(*args, **kwargs)
        page = deepcopy(result.result)
        instance = page["instances"][1]
        for candidate in page["candidates"]:
            if candidate["instance_id"] == instance["instance_id"]:
                candidate["needs_review"] = True
        return replace(result, result=page, diagnostics=(*result.diagnostics,
            {"code": "suspected_invalid_slot", "slot_id": instance["slot_id"]}))

    monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", with_suggestion)
    database, review, ready, _path = _create_and_run(tmp_path, SPLIT, receipt_calls)
    prepared = _prepare(database, review, ready)["data"]["prepared"]
    items = _page(database, review, ready)["data"]["items"]
    assert len(items) == 3
    assert [item.get("exclusion_notice") for item in items] == [
        None, {"code": "suspected_invalid_slot"}, None,
    ]
    assert all(item["record"] is None for item in items)
    assert items[1]["original"]["needs_review"] is True
    assert all("exclusion_notice" not in item["original"] for item in items)

    # A per-receipt manual special classification wins over this suggestion.
    edit = _make_edit(prepared["context_key"], ready["result_revision"], items[1]["original"])
    edit.update(document_type="other_special", review_status="needs_review")
    assert request(database, "batch_save_receipt_review", review_database_path=str(review),
                   job_id=ready["id"], result_revision=ready["result_revision"], edits=[edit])["status"] == "ok"
    classified = _page(database, review, ready)["data"]["items"]
    assert classified[1]["page_notice"] == {"code": "special_document", "document_type": "other_special"}
    assert "exclusion_notice" not in classified[1]
    assert classified[0] == items[0] and classified[2] == items[2]


def test_save_is_atomic_on_record_cas_conflict(tmp_path, receipt_calls):
    database, review, ready, _path = _create_and_run(tmp_path, SPLIT, receipt_calls)
    prepared = _prepare(database, review, ready)["data"]["prepared"]
    items = _page(database, review, ready)["data"]["items"]
    first = _make_edit(prepared["context_key"], ready["result_revision"], items[0]["original"])
    second = _make_edit(prepared["context_key"], ready["result_revision"], items[1]["original"])
    assert request(
        database,
        "batch_save_receipt_review",
        review_database_path=str(review),
        job_id=ready["id"],
        result_revision=ready["result_revision"],
        edits=[first],
    )["status"] == "ok"

    # The stale first edit is validated together with a fresh second edit.
    # The storage transaction must reject both before inserting the second.
    conflict = request(
        database,
        "batch_save_receipt_review",
        review_database_path=str(review),
        job_id=ready["id"],
        result_revision=ready["result_revision"],
        edits=[first, second],
    )
    assert conflict["status"] == "error" and conflict["code"] == "batch_conflict", conflict
    page = _page(database, review, ready)["data"]["items"]
    assert [item["record_revision"] for item in page] == [1, 0, 0]


def test_review_page_and_save_reject_strict_bounds_and_private_database_injection(tmp_path, receipt_calls):
    database, review, ready, _path = _create_and_run(tmp_path, SPLIT, receipt_calls)
    assert _prepare(database, review, ready)["status"] == "ok"
    for fields in [
        {"offset": True, "limit": 1},
        {"offset": -1, "limit": 1},
        {"offset": 0, "limit": 0},
        {"offset": 0, "limit": 201},
        {"offset": 4, "limit": 1},
    ]:
        result = _page(database, review, ready, **fields)
        assert result["status"] == "error" and result["code"] == "batch_invalid_request", result

    same_database = request(
        database,
        "batch_receipt_review_page",
        review_database_path=str(database),
        job_id=ready["id"],
        result_revision=ready["result_revision"],
        offset=0,
        limit=1,
    )
    assert same_database["status"] == "error" and same_database["code"] == "batch_invalid_request"


def test_save_cannot_implicitly_prepare_or_accept_confirm_group(tmp_path, receipt_calls):
    database, review, ready, _path = _create_and_run(tmp_path, SEARCH, receipt_calls)
    # The review database does not exist yet; a save must not create it by
    # interpreting the request as a prepare operation.
    with BatchStore(database) as store:
        originals = store.review_snapshot(ready["id"], ready["result_revision"])["originals"]
    edit = {
        "schema_version": 1,
        "context_key": "0" * 64,
        "result_revision": ready["result_revision"],
        "id": originals[0]["id"],
        "source_key": originals[0]["source_key"],
        "instance_id": originals[0]["instance_id"],
        "analysis_signature": originals[0]["analysis_signature"],
        "record_revision": 0,
        "final_rect": originals[0]["candidate_rect"],
        "crop_mode": "candidate",
        "review_status": "confirmed",
        "manual_adjusted": False,
        "reviewed_at": "2026-09-14T10:20:30.000Z",
    }
    result = request(
        database,
        "batch_save_receipt_review",
        review_database_path=str(review),
        job_id=ready["id"],
        result_revision=ready["result_revision"],
        edits=[edit],
    )
    assert result["status"] == "error"
    assert not review.exists()


def test_source_relocation_invalidates_existing_review_binding(tmp_path, receipt_calls):
    database, review, ready, path = _create_and_run(tmp_path, SEARCH, receipt_calls)
    prepared = _prepare(database, review, ready)["data"]["prepared"]
    item = _page(database, review, ready)["data"]["items"][0]
    edit = _make_edit(prepared["context_key"], ready["result_revision"], item["original"])
    moved = tmp_path / "relocated.pdf"
    moved.write_bytes(path.read_bytes())
    with BatchStore(database) as store:
        source = store.get_job(ready["id"])["sources"][0]
        store.relocate_source(ready["id"], source["source_id"], str(moved), source["sha256"], source["size_bytes"])
    result = request(
        database,
        "batch_save_receipt_review",
        review_database_path=str(review),
        job_id=ready["id"],
        result_revision=ready["result_revision"],
        edits=[edit],
    )
    assert result["status"] == "error" and result["code"] == "batch_conflict", result


def test_large_save_request_is_rejected_before_any_review_write(tmp_path, receipt_calls):
    database, review, ready, _path = _create_and_run(tmp_path, SEARCH, receipt_calls)
    _prepare(database, review, ready)
    with BatchStore(database) as store:
        original = store.review_snapshot(ready["id"], ready["result_revision"])["originals"][0]
    oversized = _make_edit("0" * 64, ready["result_revision"], original)
    oversized["reviewed_at"] = "x" * (4 * 1024 * 1024)
    result = request(
        database,
        "batch_save_receipt_review",
        review_database_path=str(review),
        job_id=ready["id"],
        result_revision=ready["result_revision"],
        edits=[oversized],
    )
    assert result["status"] == "error" and result["code"] == "batch_capacity_exceeded", result
