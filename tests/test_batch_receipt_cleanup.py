"""Batch cleanup coverage for schema-3 receipt review ownership."""

from hashlib import sha256
import json
import sqlite3

import pytest

from engine.batch_cleanup import BatchCleanupError, execute_cleanup, plan_cleanup
from engine.batch_review import prepare_batch_review
from engine.batch_store import BatchStore
from engine.review_store_v2 import ReviewStoreV2
from tests.test_batch_processor_receipt import SPLIT, make_pdf, receipt_calls
from tests.test_batch_receipt_review import _make_edit, _run_receipt_job


@pytest.fixture(autouse=True)
def isolated_private_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))


def _source_digest(path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def test_receipt_cleanup_deletes_saved_rows_and_replays_idempotently(tmp_path, receipt_calls) -> None:
    path = make_pdf(tmp_path)
    before_digest = _source_digest(path)
    batch_database = tmp_path / "batch.sqlite3"
    review_database = tmp_path / "review.sqlite3"

    with BatchStore(batch_database) as store:
        store.activate_supervisor("host")
        ready = _run_receipt_job(store, [path], SPLIT)
        prepared = prepare_batch_review(store, ready["id"], ready["result_revision"], review_database)
        context_key = prepared["prepared"]["context_key"]
        originals = store.review_snapshot(ready["id"], ready["result_revision"])["originals"]
        edits = [_make_edit(context_key, ready["result_revision"], original) for original in originals]

        with ReviewStoreV2(review_database) as reviews:
            saved = reviews.save(context_key, ready["result_revision"], edits, confirm_group=False)
        assert saved["saved_count"] == len(originals)

        plan = plan_cleanup(store, review_database, ready["id"], [])
        review_scope = plan["scope"]["review"]
        assert review_scope["context_key"] == context_key
        assert review_scope["record_count"] == len(originals)
        assert review_scope["exclusive"] is True

        result = execute_cleanup(
            store,
            review_database,
            plan["id"],
            True,
            lambda _identities: {"state": "absent"},
        )
        assert result["task_data_state"] == "deleted"
        assert result["review_state"] == "deleted"
        assert result["preview_state"] == "absent"
        assert store.connection.execute(
            "SELECT 1 FROM batch_jobs WHERE id = ?", (ready["id"],)
        ).fetchone() is None

        with ReviewStoreV2(review_database) as reviews:
            assert reviews.connection.execute(
                "SELECT COUNT(*) FROM review_contexts_v2 WHERE context_key = ?", (context_key,)
            ).fetchone()[0] == 0
            assert reviews.connection.execute(
                "SELECT COUNT(*) FROM review_receipt_records_v1 WHERE context_key = ?", (context_key,)
            ).fetchone()[0] == 0
            receipt = reviews.connection.execute(
                """
                SELECT response_json FROM review_cleanup_receipts_v2
                 WHERE context_key = ? AND job_id = ? AND cleanup_id = ?
                """,
                (context_key, str(ready["id"]), plan["id"]),
            ).fetchone()
            assert receipt is not None
            assert json.loads(receipt["response_json"])["deleted_record_count"] == len(originals)

        replay = execute_cleanup(
            store,
            review_database,
            plan["id"],
            True,
            lambda _identities: {"state": "absent"},
        )
        assert replay["task_data_state"] == "deleted"
        assert replay["review_state"] == "deleted"
        assert replay["preview_state"] == "absent"

    assert _source_digest(path) == before_digest


def test_receipt_cleanup_retains_shared_context_for_another_job(tmp_path, receipt_calls) -> None:
    path = make_pdf(tmp_path)
    before_digest = _source_digest(path)
    batch_database = tmp_path / "batch.sqlite3"
    review_database = tmp_path / "review.sqlite3"

    with BatchStore(batch_database) as store:
        store.activate_supervisor("host")
        first = _run_receipt_job(store, [path], SPLIT)
        first_prepared = prepare_batch_review(store, first["id"], first["result_revision"], review_database)
        context_key = first_prepared["prepared"]["context_key"]

        second = _run_receipt_job(store, [path], SPLIT)
        second_prepared = prepare_batch_review(store, second["id"], second["result_revision"], review_database)
        assert second_prepared["prepared"]["context_key"] == context_key
        second_originals = store.review_snapshot(second["id"], second["result_revision"])["originals"]

        with ReviewStoreV2(review_database) as reviews:
            reviews.save(
                context_key,
                second["result_revision"],
                [_make_edit(context_key, second["result_revision"], second_originals[0])],
                confirm_group=False,
            )

        plan = plan_cleanup(store, review_database, first["id"], [])
        review_scope = plan["scope"]["review"]
        assert review_scope["other_job_ids"] == [str(second["id"])]
        assert review_scope["exclusive"] is False

        result = execute_cleanup(
            store,
            review_database,
            plan["id"],
            True,
            lambda _identities: {"state": "absent"},
        )
        assert result["task_data_state"] == "deleted"
        assert result["review_state"] == "retained"
        assert result["preview_state"] == "absent"
        assert result["residual"]
        assert store.connection.execute(
            "SELECT 1 FROM batch_jobs WHERE id = ?", (first["id"],)
        ).fetchone() is None
        assert store.connection.execute(
            "SELECT 1 FROM batch_jobs WHERE id = ?", (second["id"],)
        ).fetchone() is not None

        with ReviewStoreV2(review_database) as reviews:
            ownership = reviews.batch_ownership(context_key, str(second["id"]))
            assert ownership["record_count"] == 1
            assert ownership["owned_by_job"] is True
            assert ownership["exclusive"] is False
            assert reviews.connection.execute(
                "SELECT COUNT(*) FROM review_receipt_records_v1 WHERE context_key = ?", (context_key,)
            ).fetchone()[0] == 1

    assert _source_digest(path) == before_digest


def test_receipt_cleanup_rejects_unknown_review_context_schema(tmp_path, receipt_calls) -> None:
    path = make_pdf(tmp_path)
    before_digest = _source_digest(path)
    batch_database = tmp_path / "batch.sqlite3"
    review_database = tmp_path / "review.sqlite3"

    with BatchStore(batch_database) as store:
        store.activate_supervisor("host")
        ready = _run_receipt_job(store, [path], SPLIT)
        prepared = prepare_batch_review(store, ready["id"], ready["result_revision"], review_database)
        context_key = prepared["prepared"]["context_key"]

    with sqlite3.connect(review_database) as connection:
        connection.execute(
            "UPDATE review_contexts_v2 SET version = 4 WHERE context_key = ?", (context_key,)
        )
        connection.commit()

    with BatchStore(batch_database) as store:
        with pytest.raises(BatchCleanupError, match="review ownership is unavailable"):
            plan_cleanup(store, review_database, ready["id"], [])
        assert store.connection.execute(
            "SELECT 1 FROM batch_jobs WHERE id = ?", (ready["id"],)
        ).fetchone() is not None

    assert _source_digest(path) == before_digest
