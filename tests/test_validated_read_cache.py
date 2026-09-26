"""Warm reads retain full corruption/source/version checks."""
import os
import sqlite3
from unittest.mock import patch

import pytest

from engine.batch_store import BatchStore
from engine.batch_review import read_batch_receipt_review_page
from engine.validated_read_cache import ValidatedReadCache, sqlite_content_fingerprint
from tests.test_batch_receipt_review_api import (
    _create_and_run, _prepare, _page, _make_edit, request, receipt_calls, isolated_temp,
)
from tests.test_batch_processor_receipt import SPLIT


def test_cache_validation_code_participates_in_computation_identity():
    from engine.computation import COMPUTATION_SOURCE_FILES
    assert "engine/validated_read_cache.py" in COMPUTATION_SOURCE_FILES


def test_cache_is_bounded_detached_and_lru():
    cache = ValidatedReadCache(max_entries=2, max_bytes=100)
    original = {"items": [1]}
    cache.put("a", original)
    original["items"].append(2)
    assert cache.get("a") == {"items": [1]}
    read = cache.get("a")
    read["items"].append(3)
    cache.put("b", {})
    assert cache.get("a") == {"items": [1]}
    cache.put("c", {})
    assert cache.get("b") is None
    cache.put("large", "x" * 101)
    assert cache.get("large") is None
    cache.put("d", "x" * 85)
    assert cache.get("a") is None


def test_fingerprint_requires_transaction_and_distinguishes_types_and_row_boundaries():
    with sqlite3.connect(":memory:") as connection:
        connection.execute("CREATE TABLE sample(value)")
        with pytest.raises(ValueError, match="transaction"):
            sqlite_content_fingerprint(connection, [("SELECT * FROM sample", ())])
        connection.execute("BEGIN")
        fingerprints = []
        for value in (1, "1", b"1", None, 1.0):
            connection.execute("DELETE FROM sample")
            connection.execute("INSERT INTO sample VALUES (?)", (value,))
            fingerprints.append(sqlite_content_fingerprint(connection, [("SELECT * FROM sample", ())]))
        assert len(set(fingerprints)) == len(fingerprints)


def _warm(tmp_path, receipt_calls):
    database, review, ready, path = _create_and_run(tmp_path, SPLIT, receipt_calls)
    assert _prepare(database, review, ready)["status"] == "ok"
    first = _page(database, review, ready)
    assert first["status"] == "ok", first
    return database, review, ready, path, first


def test_unchanged_pages_reuse_audit_but_always_recheck_source(tmp_path, receipt_calls):
    database, review, ready, _path, first = _warm(tmp_path, receipt_calls)
    from engine import batch_review, receipt_review_read
    with patch.object(BatchStore, "_receipt_snapshot", side_effect=AssertionError("reconstructed unchanged pages")), \
         patch.object(receipt_review_read, "validate_context_row", side_effect=AssertionError("reaudited unchanged reviews")), \
         patch.object(batch_review, "open_batch_source", wraps=batch_review.open_batch_source) as opened:
        assert _page(database, review, ready) == first
        assert _page(database, review, ready) == first
        assert opened.call_count == 2
    first["data"]["items"][0]["original"]["candidate_rect"]["y0"] = 999
    assert _page(database, review, ready)["data"]["items"][0]["original"]["candidate_rect"]["y0"] != 999


@pytest.mark.parametrize("damage", ["checkpoint", "snapshot", "manifest", "schema", "revision", "source_binding"])
def test_warm_cache_rejects_changed_durable_inputs(tmp_path, receipt_calls, damage):
    database, review, ready, _path, _first = _warm(tmp_path, receipt_calls)
    target = review if damage in {"manifest", "schema"} else database
    with sqlite3.connect(target) as connection:
        if damage == "checkpoint":
            connection.execute("UPDATE batch_page_results SET payload_json='{}'")
        elif damage == "snapshot":
            connection.execute("UPDATE batch_snapshot_items SET payload_json='{}'")
        elif damage == "manifest":
            connection.execute("UPDATE review_contexts_v2 SET manifest_json='[]'")
        elif damage == "schema":
            connection.execute("ALTER TABLE review_receipt_records_v1 ADD COLUMN unexpected TEXT")
        elif damage == "revision":
            connection.execute("UPDATE batch_jobs SET result_revision='new-revision'")
        else:
            connection.execute("UPDATE batch_sources SET access_path=access_path || '.absent'")
    assert _page(database, review, ready)["status"] == "error"


def test_warm_cache_does_not_trust_source_size_or_timestamp(tmp_path, receipt_calls):
    database, review, ready, path, _first = _warm(tmp_path, receipt_calls)
    before = path.stat()
    content = bytearray(path.read_bytes())
    content[-10] ^= 1
    path.write_bytes(content)
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert path.stat().st_size == before.st_size
    result = _page(database, review, ready)
    assert result["status"] == "error" and result["code"] == "source_changed"


def test_warm_cache_observes_review_save_and_rejects_corrupt_record(tmp_path, receipt_calls):
    database, review, ready, _path, first = _warm(tmp_path, receipt_calls)
    data = first["data"]
    edit = _make_edit(data["context_key"], ready["result_revision"], data["items"][0]["original"])
    assert request(database, "batch_save_receipt_review", review_database_path=str(review),
                   job_id=ready["id"], result_revision=ready["result_revision"], edits=[edit])["status"] == "ok"
    saved = _page(database, review, ready)
    assert saved["data"]["items"][0]["record_revision"] == 1
    assert saved["data"]["items"][0]["record"] is not None
    with sqlite3.connect(review) as connection:
        connection.execute("UPDATE review_receipt_records_v1 SET record_json='{}'")
    assert _page(database, review, ready)["status"] == "error"


def test_warm_cache_still_checks_current_computation_version(tmp_path, receipt_calls):
    database, review, ready, _path, _first = _warm(tmp_path, receipt_calls)
    with patch("engine.batch_review.current_computation_version", return_value="changed-version"):
        response = _page(database, review, ready)
    assert response["code"] == "computation_version_changed"


def test_review_page_byte_budget_uses_exact_envelope_size(tmp_path, receipt_calls, monkeypatch):
    from engine.batch_models import canonical_json
    import engine.batch_review as module
    database, review, ready, _path, first = _warm(tmp_path, receipt_calls)
    one = _page(database, review, ready, limit=1)["data"]
    # Request limit is also part of the encoded envelope.
    one["limit"] = 200
    budget = len(canonical_json(one))
    monkeypatch.setattr(module, "MAX_RESULTS_PAGE_BYTES", budget)
    with BatchStore(database) as store:
        page = read_batch_receipt_review_page(store, ready["id"], ready["result_revision"], 0, 200, review)
    assert page == one
    assert len(canonical_json(page)) == budget
