"""End-to-end receipt review binding through the published batch snapshot."""

from copy import deepcopy
from hashlib import sha256

import pytest

from engine.batch_pdf import BatchSourceError
from engine.batch_processor import BatchProcessor, BatchProgress
from engine.batch_review import prepare_batch_review
from engine.batch_store import BatchStore
from engine.computation import current_computation_version
from engine.review_store_v2 import ReviewRevisionConflict, ReviewStoreV2
from tests.test_batch_processor_receipt import SEARCH, SPLIT, make_pdf, receipt_calls
from tests.test_receipt_review_models import _edit


def _run_receipt_job(store: BatchStore, paths: list[object], options: dict[str, object]) -> dict[str, object]:
    """Run the same real batch processor used by the receipt integration tests."""

    version = current_computation_version()
    job = store.create_receipt_job(
        "synthetic-review",
        [{"source_path": str(path), "name": str(path).split("\\")[-1]} for path in paths],
        deepcopy(options),
        "exact",
        version,
    )
    running = store.start_job(job["id"], job["generation"], "host", version)
    ready = BatchProcessor(
        store,
        job["id"],
        running["generation"],
        "host",
        version,
        BatchProgress(lambda *_args: None),
    ).run()
    assert ready["state"] == "ready_for_review"
    return ready


def _make_edit(context_key: str, result_revision: str, original: dict[str, object], *, revision: int = 0) -> dict[str, object]:
    edit = _edit(context_key, original, revision=revision)
    edit["result_revision"] = result_revision
    return edit


@pytest.fixture(autouse=True)
def isolated_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))


@pytest.mark.parametrize(
    ("options", "expected_count"),
    [(SEARCH, 1), (SPLIT, 3)],
    ids=["search", "split_all"],
)
def test_published_receipt_modes_prepare_save_and_restore(
    tmp_path, receipt_calls, options, expected_count,
) -> None:
    path = make_pdf(tmp_path)
    batch_database = tmp_path / "batch.sqlite3"
    review_database = tmp_path / "review.sqlite3"

    with BatchStore(batch_database) as store:
        store.activate_supervisor("host")
        ready = _run_receipt_job(store, [path], options)
        prepared = prepare_batch_review(store, ready["id"], ready["result_revision"], review_database)
        context_key = prepared["prepared"]["context_key"]
        originals = store.review_snapshot(ready["id"], ready["result_revision"])["originals"]
        assert len(originals) == expected_count
        assert len(prepared["prepared"]["record_revisions"]) == expected_count
        edit = _make_edit(context_key, ready["result_revision"], originals[0])

    with ReviewStoreV2(review_database) as reviews:
        saved = reviews.save(context_key, ready["result_revision"], [edit], confirm_group=False)
        assert saved["saved_count"] == 1

    with BatchStore(batch_database) as store:
        restored = prepare_batch_review(store, ready["id"], ready["result_revision"], review_database)
        restored_prepared = restored["prepared"]
        assert restored_prepared["record_revisions"][0]["record_revision"] == 1
        assert len(restored_prepared["segments"]) == 1
        assert restored_prepared["segments"][0]["original"] == originals[0]
        assert restored_prepared["segments"][0]["crop_mode"] == "candidate"


def test_changed_source_sha_is_rejected_before_receipt_review_registration(tmp_path, receipt_calls) -> None:
    path = make_pdf(tmp_path)
    batch_database = tmp_path / "batch.sqlite3"
    review_database = tmp_path / "review.sqlite3"

    with BatchStore(batch_database) as store:
        store.activate_supervisor("host")
        ready = _run_receipt_job(store, [path], SEARCH)
        with path.open("ab") as stream:
            stream.write(b"changed synthetic source")
        with pytest.raises(BatchSourceError) as caught:
            prepare_batch_review(store, ready["id"], ready["result_revision"], review_database)
        assert caught.value.code == "source_changed"

    assert not review_database.exists()


def test_new_task_does_not_restore_or_overwrite_an_old_snapshot_review(tmp_path, receipt_calls) -> None:
    path = make_pdf(tmp_path)
    batch_database = tmp_path / "batch.sqlite3"
    review_database = tmp_path / "review.sqlite3"

    with BatchStore(batch_database) as store:
        store.activate_supervisor("host")
        first = _run_receipt_job(store, [path], SEARCH)
        first_prepared = prepare_batch_review(store, first["id"], first["result_revision"], review_database)
        first_context_key = first_prepared["prepared"]["context_key"]
        first_original = store.review_snapshot(first["id"], first["result_revision"])["originals"][0]
        old_edit = _make_edit(first_context_key, first["result_revision"], first_original)

    with ReviewStoreV2(review_database) as reviews:
        assert reviews.save(first_context_key, first["result_revision"], [old_edit], confirm_group=False)["saved_count"] == 1

    with BatchStore(batch_database) as store:
        second = _run_receipt_job(store, [path], SEARCH)
        second_prepared = prepare_batch_review(store, second["id"], second["result_revision"], review_database)
        assert second_prepared["prepared"]["context_key"] == first_context_key
        with ReviewStoreV2(review_database) as reviews:
            with pytest.raises(ReviewRevisionConflict):
                reviews.save(first_context_key, first["result_revision"], [old_edit], confirm_group=False)
        current = prepare_batch_review(store, second["id"], second["result_revision"], review_database)["prepared"]
        assert current["segments"] == []
        assert all(item["record_revision"] == 0 for item in current["record_revisions"])


def test_same_sha_distinct_source_keys_save_separately(tmp_path, receipt_calls) -> None:
    first_path = make_pdf(tmp_path, "first.pdf")
    second_path = tmp_path / "second.pdf"
    second_path.write_bytes(first_path.read_bytes())
    assert sha256(first_path.read_bytes()).digest() == sha256(second_path.read_bytes()).digest()
    batch_database = tmp_path / "batch.sqlite3"
    review_database = tmp_path / "review.sqlite3"

    with BatchStore(batch_database) as store:
        store.activate_supervisor("host")
        ready = _run_receipt_job(store, [first_path, second_path], SPLIT)
        prepared = prepare_batch_review(store, ready["id"], ready["result_revision"], review_database)
        context_key = prepared["prepared"]["context_key"]
        originals = store.review_snapshot(ready["id"], ready["result_revision"])["originals"]
        assert len(originals) == 6
        by_source = {}
        for original in originals:
            by_source.setdefault(original["source_key"], original)
        assert len(by_source) == 2
        edits = [_make_edit(context_key, ready["result_revision"], original) for original in by_source.values()]

    with ReviewStoreV2(review_database) as reviews:
        first_saved = reviews.save(context_key, ready["result_revision"], [edits[0]], confirm_group=False)
        assert first_saved["saved_count"] == 1

    with BatchStore(batch_database) as store:
        after_first = prepare_batch_review(store, ready["id"], ready["result_revision"], review_database)["prepared"]
        assert sorted(item["record_revision"] for item in after_first["record_revisions"]) == [0, 0, 0, 0, 0, 1]
        assert len(after_first["segments"]) == 1

    with ReviewStoreV2(review_database) as reviews:
        second_saved = reviews.save(context_key, ready["result_revision"], [edits[1]], confirm_group=False)
        assert second_saved["saved_count"] == 1

    with BatchStore(batch_database) as store:
        restored = prepare_batch_review(store, ready["id"], ready["result_revision"], review_database)["prepared"]
        assert sorted(item["record_revision"] for item in restored["record_revisions"]) == [0, 0, 0, 0, 1, 1]
        assert {item["original"]["source_key"] for item in restored["segments"]} == set(by_source)
