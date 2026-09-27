"""Explicit receipt jobs and durable page bindings; synthetic metadata only."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

import pytest

from engine.batch_models import canonical_json
from engine.batch_store import BatchConflict, BatchStore, BatchStoreError
from engine.receipt_snapshot import assemble_receipt_results


SEARCH = {"processing_mode": "search", "criteria": {
    "include": ["synthetic-a", "synthetic-b"], "includeMode": "all", "exclude": ["synthetic-x"]}}
ALL = {"processing_mode": "split_all", "criteria": None}
SOURCE = [{"source_path": "C:/synthetic/source.pdf", "name": "synthetic"}]
BUDGET = {"processed_pages": 1, "text_characters": 20, "fuzzy_work": 0,
          "matches": 0, "matched_text_characters": 0}


def payload(mode="split_all"):
    fixtures = json.loads((Path(__file__).parent / "fixtures/receipt_layout_v1.json").read_text(encoding="utf-8"))
    name = "split_all_full_page" if mode == "split_all" else "search_same_slot_multiple_hits"
    receipt = next(case["value"] for case in fixtures["valid_cases"] if case["name"] == name)
    return {"schema": 2, "page": receipt["page"], "receipt_page": receipt,
            "suggestion": {"basis": "page_evidence", "needs_review": False}, "diagnostics": []}


def running(store, mode="split_all"):
    job = store.create_receipt_job("receipt", SOURCE, ALL if mode == "split_all" else SEARCH, "exact", "test-v2")
    store.activate_supervisor("host")
    job = store.start_job(job["id"], 0, "host", "test-v2")
    source_id = job["sources"][0]["source_id"]
    receipt = payload(mode)["receipt_page"]
    store.register_source(job["id"], 1, "host", source_id, receipt["source_sha256"], 100, 1)
    store.transition(job["id"], 1, "host", {"validating"}, "running")
    claim = store.begin_page(job["id"], 1, "host", source_id, 1)
    return job, source_id, claim["attempt"]


def commit(store, job, source_id, attempt, value):
    return store.commit_page(job["id"], 1, "host", source_id, 1, attempt, value, BUDGET)


@pytest.mark.parametrize("options", [ALL, SEARCH])
def test_explicit_processing_options_reopen_without_legacy_guess(tmp_path, options):
    path = tmp_path / "tasks.sqlite3"
    input_options = deepcopy(options)
    with BatchStore(path) as store:
        new = store.create_receipt_job("receipt", SOURCE, input_options, "exact", "test-v2")
        old = store.create_job("legacy", SOURCE, SEARCH["criteria"], "exact", "test-v2")
        assert new["page_result_schema"] == 2 and new["processing_options"] == options
        assert new["criteria"] == options["criteria"]
        assert "page_result_schema" not in old and "processing_options" not in old
        assert new["criteria_fingerprint"] != old["criteria_fingerprint"]
        new["processing_options"]["processing_mode"] = "invalid"
        input_options["processing_mode"] = "invalid"
    with BatchStore(path) as store:
        assert store.get_job(new["id"])["processing_options"] == options
        assert store.list_jobs()["total"] == 2


@pytest.mark.parametrize("options", [None, {}, {"processing_mode": "split_all", "criteria": SEARCH["criteria"]},
                                      {"processing_mode": "search", "criteria": None}])
def test_invalid_new_mode_does_not_create_a_job(options):
    with BatchStore() as store:
        with pytest.raises(BatchStoreError):
            store.create_receipt_job("receipt", SOURCE, options, "exact", "test-v2")
        assert store.list_jobs()["total"] == 0


@pytest.mark.parametrize("mode", ["search", "split_all"])
def test_receipt_page_commit_and_reopen_is_lossless(tmp_path, mode):
    path = tmp_path / "tasks.sqlite3"
    expected = payload(mode)
    with BatchStore(path) as store:
        job, source_id, attempt = running(store, mode)
        commit(store, job, source_id, attempt, expected)
        assert store.connection.execute("SELECT schema FROM batch_page_results").fetchone()[0] == 2
        returned = store.read_page_results(job["id"])
        assert returned[0]["payload"] == expected
        assert store.read_page_results(job["id"], page_keys=[(source_id, 1)]) == returned
        returned[0]["payload"]["receipt_page"]["candidates"].clear()
        store._assert_complete_pages(store.connection, job["id"])
    with BatchStore(path) as store:
        assert store.read_page_results(job["id"])[0]["payload"] == expected
        assert store.get_job(job["id"])["sources"][0]["budget"] == BUDGET


@pytest.mark.parametrize("damage", ["source", "mode", "query", "and_clause"])
def test_task_binding_rejects_individually_valid_other_page_semantics(damage):
    with BatchStore() as store:
        job, source_id, attempt = running(store, "search")
        value = payload("search")
        if damage == "source":
            value = json.loads(json.dumps(value).replace("a" * 64, "b" * 64))
        elif damage == "mode":
            value = payload("split_all")
        elif damage == "query":
            value["receipt_page"]["candidates"][0]["evidence"][0]["query_id"] = "include-99"
        else:
            value["receipt_page"]["candidates"][0]["evidence"] = [value["receipt_page"]["candidates"][0]["evidence"][0]]
        with pytest.raises(BatchStoreError):
            commit(store, job, source_id, attempt, value)
        assert store.connection.execute("SELECT state FROM batch_pages").fetchone()[0] == "processing"
        assert store.get_job(job["id"])["sources"][0]["budget"]["processed_pages"] == 0
        assert store.connection.execute("SELECT COUNT(*) FROM batch_page_results").fetchone()[0] == 0


@pytest.mark.parametrize("damage", ["row_codec", "source", "query", "job_fingerprint"])
def test_recovery_rechecks_binding_even_when_payload_checksum_is_valid(damage):
    with BatchStore() as store:
        job, source_id, attempt = running(store, "search")
        value = payload("search")
        commit(store, job, source_id, attempt, value)
        if damage == "row_codec":
            store.connection.execute("UPDATE batch_page_results SET schema=1")
        elif damage == "job_fingerprint":
            store.connection.execute("UPDATE batch_jobs SET criteria_fingerprint=?", ("f" * 64,))
        else:
            if damage == "source":
                value = json.loads(json.dumps(value).replace("a" * 64, "b" * 64))
            else:
                value["receipt_page"]["candidates"][0]["evidence"][0]["query_id"] = "include-99"
            encoded = canonical_json(value)
            store.connection.execute("UPDATE batch_page_results SET payload_json=?,sha256=?",
                                     (encoded.decode(), hashlib.sha256(encoded).hexdigest()))
        with pytest.raises((BatchStoreError, BatchConflict)):
            store.read_page_results(job["id"])
        with pytest.raises((BatchStoreError, BatchConflict)):
            store._assert_complete_pages(store.connection, job["id"])


def test_zero_keyword_candidates_still_commit_complete_page():
    with BatchStore() as store:
        job, source_id, attempt = running(store, "search")
        value = payload("search")
        value["receipt_page"]["candidates"] = []
        commit(store, job, source_id, attempt, value)
        store._assert_complete_pages(store.connection, job["id"])
        assert len(store.read_page_results(job["id"])[0]["payload"]["receipt_page"]["instances"]) == 3


def test_selected_page_read_is_bounded_and_keeps_checkpoint_integrity_checks():
    with BatchStore() as store:
        job, source_id, attempt = running(store)
        commit(store, job, source_id, attempt, payload())
        # A non-selected corrupt page must not be loaded/deserialized by this
        # bounded reader; selected pages still get all normal integrity checks.
        store.connection.execute("UPDATE batch_page_results SET payload_json='invalid'")
        assert store.read_page_results(job["id"], page_keys=[]) == []
        assert store.read_page_results(job["id"], page_keys=[(source_id, 2)]) == []
        assert store.read_page_results(job["id"], page_keys=[("other-source", 1)]) == []
        with pytest.raises(BatchStoreError):
            store.read_page_results(job["id"], page_keys=[(source_id, 1)])
        with pytest.raises(BatchStoreError):
            store.read_page_results(job["id"], page_keys=[(source_id, 1)] * 201)
        with pytest.raises(BatchStoreError):
            store.read_page_results(job["id"], page_keys=[(source_id, True)])
        with pytest.raises(BatchStoreError):
            store.read_page_results(job["id"], page_keys=[(source_id, 10**100)])


def finalizing(store, mode="split_all", *, empty=False):
    job, source_id, attempt = running(store, mode)
    value = payload(mode)
    if empty:
        value["receipt_page"]["candidates"] = []
    commit(store, job, source_id, attempt, value)
    store.transition(job["id"], 1, "host", {"running"}, "finalizing")
    store.verify_source(job["id"], 1, "host", source_id, value["receipt_page"]["source_sha256"], 100, 1)
    current = store.get_job(job["id"])
    assembled = assemble_receipt_results(job["id"], current["sources"], current["processing_options"],
        current["match_mode"], current["computation_version"], store.read_page_results(job["id"]))
    return job, assembled


@pytest.mark.parametrize("mode,empty", [("search", False), ("search", True), ("split_all", False)])
def test_receipt_publication_reopens_and_reads_the_full_original_manifest(tmp_path, mode, empty):
    path = tmp_path / "tasks.sqlite3"
    with BatchStore(path) as store:
        job, assembled = finalizing(store, mode, empty=empty)
        published = store.publish_snapshot(job["id"], 1, "host", **assembled)
        assert published["count"] == len(assembled["items"])
    with BatchStore(path) as store:
        page = store.results_page(job["id"], published["result_revision"])
        assert page["schema"] == 2 and page["items"] == assembled["items"]
        snapshot = store.review_snapshot(job["id"], published["result_revision"])
        assert snapshot["context"] == assembled["context"]
        assert snapshot["originals"] == assembled["originals"]
        assert all("match_rect" not in original for original in snapshot["originals"])


@pytest.mark.parametrize("damage", ["mode", "drop", "reorder", "geometry", "signature", "evidence", "boolean"])
def test_publication_compares_to_durable_computation_not_consistent_forgeries(damage):
    with BatchStore() as store:
        job, assembled = finalizing(store)
        if damage == "mode":
            assembled["context"]["processing_options"] = SEARCH
        elif damage == "drop":
            assembled["originals"].pop()
            assembled["items"].pop()
        elif damage == "reorder":
            assembled["originals"].reverse()
            assembled["items"].reverse()
        else:
            item = assembled["items"][0]
            if damage == "geometry":
                item["original"]["candidate_rect"]["y1"] -= 1
                item["segment"]["candidate_rect"]["y1"] -= 1
                item["segment"]["final_rect"]["y1"] -= 1
            elif damage == "signature":
                item["original"]["analysis_signature"] = "f" * 64
                item["segment"]["analysis_signature"] = "f" * 64
            elif damage == "evidence":
                item["evidence"] = [{"query_id": "include-0", "rect": item["original"]["candidate_rect"]}]
            else:
                item["original"]["layout_revision"] = True
                item["segment"]["layout_revision"] = True
            assembled["originals"][0] = deepcopy(item["original"])
        with pytest.raises(BatchStoreError):
            store.publish_snapshot(job["id"], 1, "host", **assembled)
        assert store.get_job(job["id"])["state"] == "finalizing"
        assert store.connection.execute("SELECT COUNT(*) FROM batch_snapshots").fetchone()[0] == 0
        assert store.connection.execute("SELECT COUNT(*) FROM batch_snapshot_items").fetchone()[0] == 0


@pytest.mark.parametrize("damage", ["codec", "item_id", "source_key", "geometry", "access_path"])
def test_result_reads_reject_corrupt_receipt_rows(damage):
    with BatchStore() as store:
        job, assembled = finalizing(store)
        published = store.publish_snapshot(job["id"], 1, "host", **assembled)
        if damage == "codec":
            store.connection.execute("UPDATE batch_snapshots SET schema=1")
        elif damage == "item_id":
            store.connection.execute("UPDATE batch_snapshot_items SET item_id='wrong' WHERE position=0")
        elif damage == "source_key":
            store.connection.execute("UPDATE batch_snapshot_items SET source_key='c:/other.pdf' WHERE position=0")
        else:
            item = deepcopy(assembled["items"][0])
            if damage == "geometry":
                item["segment"]["final_rect"]["y1"] += 1
            else:
                item["segment"]["source_path"] = "D:/unrelated/another.pdf"
            store.connection.execute("UPDATE batch_snapshot_items SET payload_json=? WHERE position=0",
                                     (canonical_json(item).decode(),))
        with pytest.raises(BatchStoreError):
            store.results_page(job["id"], published["result_revision"])
        with pytest.raises(BatchStoreError):
            store.review_snapshot(job["id"], published["result_revision"])


def test_review_reconstruction_rejects_forged_geometry_even_with_changed_manifest_digest():
    with BatchStore() as store:
        job, assembled = finalizing(store)
        published = store.publish_snapshot(job["id"], 1, "host", **assembled)
        item = assembled["items"][0]
        item["original"]["candidate_rect"]["y1"] -= 1
        item["segment"]["candidate_rect"]["y1"] -= 1
        item["segment"]["final_rect"]["y1"] -= 1
        assembled["originals"][0] = item["original"]
        digest = hashlib.sha256()
        for original in assembled["originals"]:
            digest.update(canonical_json(original))
        store.connection.execute("UPDATE batch_snapshot_items SET payload_json=? WHERE position=0",
                                 (canonical_json(item).decode(),))
        store.connection.execute("UPDATE batch_snapshots SET originals_digest=?", (digest.hexdigest(),))
        with pytest.raises(BatchStoreError, match="durable computation"):
            store.review_snapshot(job["id"], published["result_revision"])


def test_receipt_relocation_preserves_logical_manifest_and_current_access_path():
    with BatchStore() as store:
        job, assembled = finalizing(store)
        published = store.publish_snapshot(job["id"], 1, "host", **assembled)
        source = store.get_job(job["id"])["sources"][0]
        for path in ["D:/moved/first.pdf", "D:/moved/second.pdf"]:
            store.relocate_source(job["id"], source["source_id"], path, source["sha256"], 100)
            snapshot = store.review_snapshot(job["id"], published["result_revision"])
            assert snapshot["context"]["sources"][0]["source_path"] == path
            assert snapshot["originals"] == assembled["originals"]
            assert store.results_page(job["id"], published["result_revision"])["items"][0]["segment"]["source_path"] == path


def test_receipt_pagination_charges_schema_and_returns_every_item(monkeypatch):
    from engine import batch_store
    with BatchStore() as store:
        job, assembled = finalizing(store)
        published = store.publish_snapshot(job["id"], 1, "host", **assembled)
        monkeypatch.setattr(batch_store, "MAX_RESULTS_PAGE_BYTES", 5_000)
        offset, ids, pages = 0, [], 0
        while offset is not None:
            result = store.results_page(job["id"], published["result_revision"], offset)
            assert len(canonical_json(result)) <= 5_000
            assert result["schema"] == 2
            ids.extend(item["segment"]["id"] for item in result["items"])
            offset = result["next_offset"]
            pages += 1
        assert ids == [item["segment"]["id"] for item in assembled["items"]]
        assert pages > 1


def test_late_item_rejection_rolls_back_previously_inserted_items():
    with BatchStore() as store:
        job, assembled = finalizing(store)
        assembled["items"][-1]["segment"]["final_rect"]["y1"] -= 1
        with pytest.raises(BatchStoreError):
            store.publish_snapshot(job["id"], 1, "host", **assembled)
        assert store.get_job(job["id"])["result_revision"] is None
        assert store.connection.execute("SELECT COUNT(*) FROM batch_snapshots").fetchone()[0] == 0
        assert store.connection.execute("SELECT COUNT(*) FROM batch_snapshot_items").fetchone()[0] == 0


def test_receipt_publication_requires_source_verification_and_all_registered_pages():
    with BatchStore() as store:
        job, assembled = finalizing(store)
        store.connection.execute("UPDATE batch_sources SET verified_generation=NULL")
        with pytest.raises(BatchConflict, match="verification"):
            store.publish_snapshot(job["id"], 1, "host", **assembled)
        store.connection.execute("UPDATE batch_sources SET verified_generation=1")
        # Even if the page table itself has lost its zero-hit page, the
        # registered source count is authoritative for the reconstruction.
        store.connection.execute("DELETE FROM batch_pages")
        with pytest.raises(BatchStoreError):
            store.publish_snapshot(job["id"], 1, "host", **assembled)
        assert store.connection.execute("SELECT COUNT(*) FROM batch_snapshots").fetchone()[0] == 0
