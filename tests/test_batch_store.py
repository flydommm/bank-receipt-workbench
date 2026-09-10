from __future__ import annotations

from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
from threading import Barrier
from time import sleep
from pathlib import Path

import pytest

import engine.batch_store as batch_store_module
from engine.batch_results import assemble_batch_results
from engine.batch_store import (
    BatchCapacityExceeded,
    BatchComputationChanged,
    BatchConflict,
    BatchSchemaIncompatible,
    BatchStoreError,
    BatchStore,
)


SHA = "a" * 64


def test_cancel_wins_when_host_stop_snapshot_was_taken_before_control(tmp_path):
    with BatchStore(tmp_path / "cancel-race.sqlite3") as store:
        job, _source = _new_job(store)
        assert store.get_job(job["id"])["state"] == "running"
        store.control(job["id"], 1, "cancel", "cancel")
        # The host observed the previous state; the transaction must honor
        # the durable cancellation accepted after that observation.
        stopped = store.finish_stop(job["id"], 1, "owner-a", cancelled=False)
        assert stopped["state"] == "cancelled"


def test_concurrent_creates_cannot_reserve_the_same_storage_capacity(tmp_path, monkeypatch):
    database = tmp_path / "capacity.sqlite3"
    ready = Barrier(4)
    original_capacity = BatchStore._ensure_capacity

    def delayed_capacity(store, size):
        original_capacity(store, size)
        sleep(0.05)  # Make a pre-transaction check/write race observable.

    monkeypatch.setattr(BatchStore, "_ensure_capacity", delayed_capacity)
    with BatchStore(database) as anchor:
        anchor.create_job("baseline", [{"source_path": "C:/test/baseline.pdf", "name": "baseline"}],
                          _criteria(), "exact", "test")
        quota = anchor.quota_usage_bytes() + 70_000

        def create(number):
            with BatchStore(database, quota_bytes=quota) as store:
                ready.wait(timeout=5)
                try:
                    store.create_job(f"test-{number}", [{"source_path": f"C:/test/{number}.pdf", "name": "test"}],
                                     _criteria(), "exact", "test")
                except BatchCapacityExceeded:
                    return False
                return True

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(create, range(4)))
        assert 0 < sum(results) < 4
        assert anchor.quota_usage_bytes() <= quota


def _payload(page: int = 1, *, matched: bool = False) -> dict[str, object]:
    matches: list[dict[str, object]] = []
    analysis = None
    if matched:
        match = {
            "page": page,
            "matched_text": "手续费",
            "matched_field": "收款方",
            "confidence": 0.95,
            "needs_review": False,
            "x0": 10.0,
            "y0": 20.0,
            "x1": 100.0,
            "y1": 40.0,
            "query_id": "include-0",
            "role": "include",
        }
        matches.append(match)
        analysis = {
            "status": "ok",
            "page": page,
            "page_width": 600.0,
            "page_height": 800.0,
            "selections": [{
                "match_rect": {"x0": 10.0, "y0": 20.0, "x1": 100.0, "y1": 40.0},
                "rect": {"x0": 0.0, "y0": 0.0, "x1": 600.0, "y1": 800.0},
                "candidate_index": None,
                "candidate_rect": None,
                "confidence": 0.95,
                "slot": "full",
                "evidence": ["page_fully_matched"],
                "needs_review": False,
                "snap_points": [0.0, 800.0],
            }],
        }
    return {
        "schema": 1,
        "page": page,
        "page_width": 600.0,
        "page_height": 800.0,
        "matches": matches,
        "analysis": analysis,
    }


def _criteria() -> dict[str, object]:
    return {"include": ["手续费"], "includeMode": "all", "exclude": []}


def _new_job(store: BatchStore, *, page_count: int = 1) -> tuple[dict[str, object], dict[str, object]]:
    job = store.create_job(
        "batch",
        [{"source_path": r"C:\Input\Report.PDF", "name": "Report"}],
        _criteria(),
        "exact",
        "test-v1",
    )
    store.activate_supervisor("owner-a")
    running = store.start_job(job["id"], 0, "owner-a", "test-v1")
    source = running["sources"][0]
    store.register_source(running["id"], 1, "owner-a", source["source_id"], SHA, 100, page_count)
    store.transition(running["id"], 1, "owner-a", {"validating"}, "running")
    return running, store.get_job(running["id"])


def _complete_snapshot(store: BatchStore) -> tuple[dict[str, object], dict[str, object]]:
    """Build a publish payload from a real validated page result."""

    job, _ = _new_job(store)
    source_id = job["sources"][0]["source_id"]
    store.begin_page(job["id"], 1, "owner-a", source_id, 1)
    store.commit_page(job["id"], 1, "owner-a", source_id, 1, 1, _payload(matched=True), _budget())
    store.transition(job["id"], 1, "owner-a", {"running"}, "finalizing")
    store.verify_source(job["id"], 1, "owner-a", source_id, SHA, 100, 1)
    current = store.get_job(job["id"])
    assembled = assemble_batch_results(
        job["id"], current["sources"], current["criteria"], current["match_mode"],
        current["computation_version"], store.read_page_results(job["id"]),
    )
    return job, assembled


def _budget(processed_pages: int = 1, **overrides: int) -> dict[str, int]:
    value = {
        "processed_pages": processed_pages,
        "text_characters": 10,
        "fuzzy_work": 0,
        "matches": 0,
        "matched_text_characters": 0,
    }
    value.update(overrides)
    return value


def test_new_schema_is_versioned_foreign_keyed_and_wal_enabled(tmp_path: Path) -> None:
    database = tmp_path / "batch-tasks.sqlite3"
    with BatchStore(database) as store:
        assert store.connection.execute("PRAGMA user_version").fetchone()[0] == 1
        assert store.connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert store.connection.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        tables = {
            row[0]
            for row in store.connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {"batch_jobs", "batch_sources", "batch_pages", "batch_page_results", "batch_snapshots", "batch_snapshot_items", "batch_commands", "batch_supervisor", "batch_cleanup"} <= tables


def test_source_key_and_access_path_are_independent_and_same_sha_is_kept_separate(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job = store.create_job(
            "batch",
            [
                {"source_path": r"C:\Input\Report.PDF", "name": "first"},
                {"source_path": r"D:\Archive\Report.PDF", "name": "second"},
            ],
            _criteria(),
            "exact",
            "test-v1",
        )
        first, second = job["sources"]
        assert first["source_key"] == "c:/input/report.pdf"
        assert first["access_path"] == r"C:\Input\Report.PDF"
        assert first["source_key"] != second["source_key"]
        assert first["sha256"] is None


def test_owner_generation_and_attempt_are_cas_guards(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store)
        source_id = job["sources"][0]["source_id"]
        claimed = store.begin_page(job["id"], 1, "owner-a", source_id, 1)
        assert claimed["attempt"] == 1
        with pytest.raises(BatchConflict):
            store.begin_page(job["id"], 1, "stale-owner", source_id, 1)
        with pytest.raises(BatchConflict):
            store.commit_page(job["id"], 1, "owner-a", source_id, 1, 0, _payload(), _budget())
        with pytest.raises(BatchConflict):
            store.commit_page(job["id"], 1, "owner-a", source_id, 1, 2, _payload(), _budget())


def test_only_execution_states_block_a_second_start(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        first = store.create_job("first", [{"source_path": "C:/first.pdf", "name": "first"}], _criteria(), "exact", "test-v1")
        second = store.create_job("second", [{"source_path": "C:/second.pdf", "name": "second"}], _criteria(), "exact", "test-v1")
        store.activate_supervisor("owner-a")
        running = store.start_job(first["id"], 0, "owner-a", "test-v1")
        with pytest.raises(BatchConflict):
            store.start_job(second["id"], 0, "owner-a", "test-v1")
        store.transition(running["id"], 1, "owner-a", {"validating"}, "paused")
        resumed = store.start_job(second["id"], 0, "owner-a", "test-v1")
        assert resumed["state"] == "validating"


def test_start_job_classifies_computation_version_mismatch_without_changing_state(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job = store.create_job(
            "batch",
            [{"source_path": r"C:\Input\Report.PDF", "name": "Report"}],
            _criteria(),
            "exact",
            "stored-v1",
        )
        store.activate_supervisor("owner-a")
        with pytest.raises(BatchComputationChanged) as changed:
            store.start_job(job["id"], 0, "owner-a", "current-v2")
        assert type(changed.value) is BatchComputationChanged
        current = store.get_job(job["id"])
        assert current["state"] == "queued" and current["generation"] == 0

        with pytest.raises(BatchConflict) as stale:
            store.start_job(job["id"], 1, "owner-a", "stored-v1")
        assert type(stale.value) is BatchConflict


def test_fail_page_keeps_job_running_and_allows_zero_or_one_page_budget_delta(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store, page_count=2)
        source_id = job["sources"][0]["source_id"]
        store.begin_page(job["id"], 1, "owner-a", source_id, 1)
        failed = store.fail_page(
            job["id"], 1, "owner-a", source_id, 1, 1, {"code": "before-page"},
            budget=_budget(0, text_characters=10),
        )
        assert failed["state"] == "failed"
        assert store.get_job(job["id"])["state"] == "running"
        assert store.get_job(job["id"])["sources"][0]["budget"] == _budget(0, text_characters=10)

        store.begin_page(job["id"], 1, "owner-a", source_id, 1)
        store.fail_page(
            job["id"], 1, "owner-a", source_id, 1, 2, {"code": "after-page"},
            budget=_budget(1, text_characters=20),
        )
        assert store.get_job(job["id"])["sources"][0]["budget"] == _budget(1, text_characters=20)

        store.begin_page(job["id"], 1, "owner-a", source_id, 1)
        with pytest.raises(BatchConflict):
            store.fail_page(
                job["id"], 1, "owner-a", source_id, 1, 3, {"code": "too-many"},
                budget=_budget(3, text_characters=30),
            )


def test_fail_source_persists_only_source_error_and_pending_pages_is_lightweight(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store, page_count=2)
        source_id = job["sources"][0]["source_id"]
        store.begin_page(job["id"], 1, "owner-a", source_id, 1)
        store.commit_page(job["id"], 1, "owner-a", source_id, 1, 1, _payload(), _budget())
        store.begin_page(job["id"], 1, "owner-a", source_id, 2)
        store.fail_page(job["id"], 1, "owner-a", source_id, 2, 1, {"code": "temporary"})
        assert store.pending_pages(job["id"], source_id) == [2]
        failed = store.fail_source(job["id"], 1, "owner-a", source_id, {"code": "unreadable"}, blocked=True)
        assert failed["state"] == "blocked"
        assert failed["error"] == {"code": "unreadable"}
        assert failed["sha256"] == SHA
        assert failed["page_count"] == 2
        assert len(store.read_page_results(job["id"])) == 1


def test_reregistering_same_source_identity_resets_failure_without_losing_checkpoint(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store)
        source_id = job["sources"][0]["source_id"]
        store.begin_page(job["id"], 1, "owner-a", source_id, 1)
        store.commit_page(job["id"], 1, "owner-a", source_id, 1, 1, _payload(), _budget())
        before = store.get_job(job["id"])["sources"][0]
        failed = store.fail_source(
            job["id"], 1, "owner-a", source_id, {"code": "final_verify_failed"}, blocked=True,
        )
        assert failed["state"] == "blocked"
        assert failed["error"] == {"code": "final_verify_failed"}

        restored = store.register_source(job["id"], 1, "owner-a", source_id, SHA, 100, 1)
        assert restored["state"] == "registered"
        assert restored["error"] is None
        assert restored["verified_generation"] is None
        assert restored["sha256"] == before["sha256"] == SHA
        assert restored["size_bytes"] == before["size_bytes"] == 100
        assert restored["page_count"] == before["page_count"] == 1
        assert restored["budget"] == before["budget"] == _budget()
        assert restored["page_summary"] == before["page_summary"] == {
            "pending": 0, "processing": 0, "succeeded": 1, "failed": 0,
        }


def test_source_verification_is_finalizing_only(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store)
        source_id = job["sources"][0]["source_id"]
        with pytest.raises(BatchConflict):
            store.verify_source(job["id"], 1, "owner-a", source_id, SHA, 100, 1)
        store.transition(job["id"], 1, "owner-a", {"running"}, "finalizing")
        verified = store.verify_source(job["id"], 1, "owner-a", source_id, SHA, 100, 1)
        assert verified["state"] == "verified"
        assert verified["verified_generation"] == 1


def test_commit_page_atomically_persists_result_state_and_budget_and_reopens(tmp_path: Path) -> None:
    database = tmp_path / "batch.sqlite3"
    with BatchStore(database) as store:
        job, _ = _new_job(store)
        source_id = job["sources"][0]["source_id"]
        store.begin_page(job["id"], 1, "owner-a", source_id, 1)
        committed = store.commit_page(job["id"], 1, "owner-a", source_id, 1, 1, _payload(), _budget())
        assert committed["state"] == "succeeded"
        assert store.get_job(job["id"])["sources"][0]["budget"] == _budget()
        assert list(store.read_page_results(job["id"]))[0]["payload"] == _payload()
    with BatchStore(database) as reopened:
        assert reopened.get_job(job["id"])["sources"][0]["budget"] == _budget()
        assert len(list(reopened.read_page_results(job["id"]))) == 1


def test_failed_page_retry_does_not_readd_old_result_or_double_count(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store, page_count=2)
        source_id = job["sources"][0]["source_id"]
        store.begin_page(job["id"], 1, "owner-a", source_id, 1)
        store.commit_page(job["id"], 1, "owner-a", source_id, 1, 1, _payload(), _budget())
        with pytest.raises(BatchConflict):
            store.begin_page(job["id"], 1, "owner-a", source_id, 1)

        # A second page is failed, then retried.  The first successful page
        # remains exactly once in the internal iterator.
        store.begin_page(job["id"], 1, "owner-a", source_id, 2)
        store.fail_page(job["id"], 1, "owner-a", source_id, 2, 1, {"code": "temporary"})
        assert store.get_job(job["id"])["state"] == "running"
        store.transition(job["id"], 1, "owner-a", {"running"}, "partial_failed")
        resumed = store.start_job(job["id"], 1, "owner-a", "test-v1")
        store.transition(job["id"], 2, "owner-a", {"validating"}, "running")
        store.begin_page(job["id"], 2, "owner-a", source_id, 2)
        store.commit_page(job["id"], 2, "owner-a", source_id, 2, 2, _payload(2), _budget(2, text_characters=20))
        results = list(store.read_page_results(job["id"]))
        assert [(item["page"], item["payload"]["page"]) for item in results] == [(1, 1), (2, 2)]


def test_publish_requires_all_pages_and_final_generation_verification(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, assembled = _complete_snapshot(store)
        published = store.publish_snapshot(job["id"], 1, "owner-a", **assembled)
        assert published["result_revision"]
        assert store.get_job(job["id"])["state"] == "ready_for_review"
        assert store.results_page(job["id"], published["result_revision"])["items"] == assembled["items"]


def test_publish_streams_thousands_of_snapshot_items_without_aggregate_json_limit(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, assembled = _complete_snapshot(store)
        template_item = assembled["items"][0]
        template_original = assembled["originals"][0]
        originals = []
        items = []
        for number in range(1, 4_001):
            identifier = f"{job['id']}:{SHA}:1:{number}"
            original = deepcopy(template_original)
            original["id"] = identifier
            original["segment_no"] = number
            original["analysis_signature"] = f"{number:064x}"
            item = deepcopy(template_item)
            item["segment"]["id"] = identifier
            item["segment"]["segment_no"] = number
            item["original"] = original
            originals.append(original)
            items.append(item)

        payload = dict(assembled)
        payload["originals"] = originals
        payload["items"] = items
        published = store.publish_snapshot(job["id"], 1, "owner-a", **payload)
        assert published["count"] == 4_000
        page = store.results_page(job["id"], published["result_revision"], limit=200)
        assert page["total"] == 4_000 and len(page["items"]) == 200
        columns = {
            row["name"]
            for row in store.connection.execute("PRAGMA table_info(batch_snapshots)")
        }
        assert {"originals_count", "originals_digest"} <= columns
        assert "originals_json" not in columns


@pytest.mark.parametrize("evidence_count", [60, 140])
def test_results_pages_use_collection_bytes_and_keep_every_item(tmp_path: Path, evidence_count: int) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, assembled = _complete_snapshot(store)
        template = assembled["items"][0]
        items = []
        for number in range(1, 201):
            item = deepcopy(template)
            for entry in (item["segment"], item["original"]):
                entry["id"] = f"{job['id']}:{SHA}:1:{number}"
                entry["segment_no"] = number
            item["evidence"] *= evidence_count
            items.append(item)
        assembled["items"] = items
        assembled["originals"] = [item["original"] for item in items]
        published = store.publish_snapshot(job["id"], 1, "owner-a", **assembled)
        offset = 0
        seen = []
        while offset is not None:
            page = store.results_page(job["id"], published["result_revision"], offset=offset)
            encoded = json.dumps(page, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
            assert len(encoded) <= 4 * 1024 * 1024
            seen.extend(item["segment"]["id"] for item in page["items"])
            offset = page["next_offset"]
        assert seen == [item["segment"]["id"] for item in items]


def test_publish_rejects_float_context_version_and_incomplete_segment(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, assembled = _complete_snapshot(store)
        bad_context = deepcopy(assembled["context"])
        bad_context["version"] = 2.0
        with pytest.raises(BatchStoreError):
            store.publish_snapshot(job["id"], 1, "owner-a", bad_context, assembled["originals"], assembled["items"])

        bad_items = deepcopy(assembled["items"])
        bad_items[0]["segment"] = {
            key: bad_items[0]["segment"][key]
            for key in ("id", "source_key", "source_page", "segment_no")
        }
        with pytest.raises(BatchStoreError):
            store.publish_snapshot(job["id"], 1, "owner-a", assembled["context"], assembled["originals"], bad_items)


def test_publish_rejects_segment_geometry_or_evidence_field_mismatch(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, assembled = _complete_snapshot(store)
        bad_items = deepcopy(assembled["items"])
        bad_items[0]["segment"]["page_width"] += 1
        with pytest.raises(BatchStoreError):
            store.publish_snapshot(job["id"], 1, "owner-a", assembled["context"], assembled["originals"], bad_items)

        bad_items = deepcopy(assembled["items"])
        bad_items[0]["evidence"][0].pop("matched_field")
        with pytest.raises(BatchStoreError):
            store.publish_snapshot(job["id"], 1, "owner-a", assembled["context"], assembled["originals"], bad_items)

        bad_items = deepcopy(assembled["items"])
        bad_items[0]["evidence"] = [{}]
        with pytest.raises(BatchStoreError):
            store.publish_snapshot(job["id"], 1, "owner-a", assembled["context"], assembled["originals"], bad_items)


def test_control_is_idempotent_and_different_action_for_same_id_conflicts(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store)
        first = store.control(job["id"], 1, "command-1", "pause")
        repeated = store.control(job["id"], 1, "command-1", "pause")
        assert repeated == first
        with pytest.raises(BatchConflict):
            store.control(job["id"], 1, "command-1", "cancel")
        assert store.get_job(job["id"])["state"] == "pause_requested"


@pytest.mark.parametrize("checkpoint", ["partial_failed", "blocked"])
def test_pause_on_a_checkpoint_is_already_paused_and_does_not_block_another_job(
    tmp_path: Path, checkpoint: str,
) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        first, _ = _new_job(store)
        store.transition(first["id"], 1, "owner-a", {"running"}, checkpoint)
        paused = store.control(first["id"], 1, "pause-checkpoint", "pause")
        assert paused["state"] == "paused"

        second = store.create_job(
            "second", [{"source_path": "C:/second.pdf", "name": "second"}],
            _criteria(), "exact", "test-v1",
        )
        resumed = store.start_job(second["id"], 0, "owner-a", "test-v1")
        assert resumed["state"] == "validating"


def test_cancel_on_idle_states_is_cancelled_without_reserving_an_active_slot(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        queued = store.create_job(
            "queued", [{"source_path": "C:/queued.pdf", "name": "queued"}],
            _criteria(), "exact", "test-v1",
        )
        cancelled = store.control(queued["id"], 0, "cancel-queued", "cancel")
        assert cancelled["state"] == "cancelled"
        assert store.get_job(queued["id"])["owner"] is None

        store.activate_supervisor("owner-b")
        other = store.create_job(
            "other", [{"source_path": "C:/other.pdf", "name": "other"}],
            _criteria(), "exact", "test-v1",
        )
        assert store.start_job(other["id"], 0, "owner-b", "test-v1")["state"] == "validating"


def test_cancel_on_interrupted_is_cancelled_and_running_cancel_waits_for_host(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        idle, _ = _new_job(store)
        store.transition(idle["id"], 1, "owner-a", {"running"}, "interrupted")
        assert store.control(idle["id"], 1, "cancel-interrupted", "cancel")["state"] == "cancelled"

        running, _ = _new_job(store)
        assert store.control(running["id"], 1, "cancel-running", "cancel")["state"] == "cancel_requested"


def test_control_reserves_the_last_command_slot_for_cancel(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(batch_store_module, "MAX_COMMANDS_PER_JOB", 3)
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store)
        assert store.control(job["id"], 1, "pause-1", "pause")["state"] == "pause_requested"
        assert store.control(job["id"], 1, "pause-2", "pause")["state"] == "pause_requested"
        with pytest.raises(BatchCapacityExceeded):
            store.control(job["id"], 1, "pause-3", "pause")
        assert store.control(job["id"], 1, "cancel-1", "cancel")["state"] == "cancel_requested"
        assert store.connection.execute(
            "SELECT COUNT(*) FROM batch_commands WHERE job_id = ? AND generation = 1", (job["id"],)
        ).fetchone()[0] == 3


def test_cancel_remains_available_when_the_reserved_slot_is_already_full(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    monkeypatch.setattr(batch_store_module, "MAX_COMMANDS_PER_JOB", 1)
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store)
        first = store.control(job["id"], 1, "cancel-1", "cancel")
        repeated = store.control(job["id"], 1, "cancel-2", "cancel")
        assert first["state"] == repeated["state"] == "cancel_requested"
        assert store.connection.execute(
            "SELECT COUNT(*) FROM batch_commands WHERE job_id = ? AND generation = 1", (job["id"],)
        ).fetchone()[0] == 1


def test_start_job_cleans_old_generation_commands_before_new_controls(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store)
        store.control(job["id"], 1, "old-pause", "pause")
        store.transition(job["id"], 1, "owner-a", {"pause_requested"}, "paused")
        started = store.start_job(job["id"], 1, "owner-a", "test-v1")
        assert started["generation"] == 2
        assert store.connection.execute(
            "SELECT COUNT(*) FROM batch_commands WHERE job_id = ?", (job["id"],)
        ).fetchone()[0] == 0


def test_zero_quota_rejects_create_job_without_persisting_metadata() -> None:
    with BatchStore(":memory:", quota_bytes=0) as store:
        with pytest.raises(BatchCapacityExceeded):
            store.create_job("blocked", [{"source_path": "C:/blocked.pdf", "name": "blocked"}], _criteria(), "exact", "test-v1")
        assert store.connection.execute("SELECT COUNT(*) FROM batch_jobs").fetchone()[0] == 0


def test_zero_quota_rejects_start_and_register_metadata(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job = store.create_job(
            "queued", [{"source_path": "C:/queued.pdf", "name": "queued"}],
            _criteria(), "exact", "test-v1",
        )
        store.activate_supervisor("owner-a")
        store.quota_bytes = 0
        with pytest.raises(BatchCapacityExceeded):
            store.start_job(job["id"], 0, "owner-a", "test-v1")
        assert store.get_job(job["id"])["generation"] == 0

    with BatchStore(tmp_path / "register.sqlite3") as store:
        job = store.create_job(
            "queued", [{"source_path": "C:/register.pdf", "name": "register"}],
            _criteria(), "exact", "test-v1",
        )
        store.activate_supervisor("owner-a")
        job = store.start_job(job["id"], 0, "owner-a", "test-v1")
        source = job["sources"][0]
        store.quota_bytes = 0
        with pytest.raises(BatchCapacityExceeded):
            store.register_source(job["id"], 1, "owner-a", source["source_id"], SHA, 100, 2)
        assert store.get_job(job["id"])["sources"][0]["sha256"] is None


def test_zero_quota_rejects_page_claim_but_control_read_fail_and_transition_remain_available(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store)
        source_id = job["sources"][0]["source_id"]
        store.quota_bytes = 0
        with pytest.raises(BatchCapacityExceeded):
            store.begin_page(job["id"], 1, "owner-a", source_id, 1)
        store.quota_bytes = 2 * 1024 * 1024 * 1024
        claim = store.begin_page(job["id"], 1, "owner-a", source_id, 1)
        store.quota_bytes = 0
        assert store.control(job["id"], 1, "cancel-running", "cancel")["state"] == "cancel_requested"
        store.fail_page(
            job["id"], 1, "owner-a", source_id, 1, claim["attempt"], {"code": "cancelled"},
        )
        assert store.read_page_results(job["id"]) == []
        store.transition(job["id"], 1, "owner-a", {"cancel_requested"}, "cancelled")
        assert store.get_job(job["id"])["state"] == "cancelled"


def test_result_page_has_a_hard_item_and_response_bound(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, assembled = _complete_snapshot(store)
        item = deepcopy(assembled["items"][0])
        item["evidence"] = [
            {**item["evidence"][0], "matched_text": "x" * 60_000}
            for _ in range(100)
        ]
        revision = store.publish_snapshot(
            job["id"], 1, "owner-a", assembled["context"], assembled["originals"], [item],
        )["result_revision"]
        with pytest.raises(BatchCapacityExceeded):
            store.results_page(job["id"], revision)


def test_commit_rolls_back_page_state_and_budget_when_result_insert_fails(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store)
        source_id = job["sources"][0]["source_id"]
        store.begin_page(job["id"], 1, "owner-a", source_id, 1)
        store.connection.execute(
            """
            CREATE TRIGGER abort_batch_result BEFORE INSERT ON batch_page_results
            BEGIN SELECT RAISE(ABORT, 'test rollback'); END
            """
        )
        with pytest.raises(sqlite3.IntegrityError):
            store.commit_page(job["id"], 1, "owner-a", source_id, 1, 1, _payload(), _budget())
        page = store.connection.execute(
            "SELECT state FROM batch_pages WHERE job_id = ? AND source_id = ? AND page = 1",
            (job["id"], source_id),
        ).fetchone()
        source = store.connection.execute(
            "SELECT budget_json FROM batch_sources WHERE job_id = ? AND source_id = ?",
            (job["id"], source_id),
        ).fetchone()
        assert page["state"] == "processing"
        assert json.loads(source["budget_json"]) == {
            "processed_pages": 0, "text_characters": 0, "fuzzy_work": 0,
            "matches": 0, "matched_text_characters": 0,
        }
        assert store.connection.execute("SELECT COUNT(*) FROM batch_page_results").fetchone()[0] == 0


def test_future_schema_is_rejected_without_writing_the_database(tmp_path: Path) -> None:
    database = tmp_path / "future.sqlite3"
    connection = sqlite3.connect(database)
    connection.execute("PRAGMA user_version = 99")
    connection.commit()
    connection.close()
    with pytest.raises(Exception):
        BatchStore(database)
    connection = sqlite3.connect(database)
    assert connection.execute("PRAGMA user_version").fetchone()[0] == 99
    assert connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'").fetchone()[0] == 0
    connection.close()


def test_unknown_nonempty_v0_database_is_rejected_without_mutation(tmp_path: Path) -> None:
    migrated = tmp_path / "unknown.sqlite3"
    connection = sqlite3.connect(migrated)
    connection.execute("CREATE TABLE legacy_marker (value TEXT)")
    connection.execute("PRAGMA user_version = 0")
    connection.commit()
    connection.close()
    with pytest.raises(BatchSchemaIncompatible):
        BatchStore(migrated)
    with sqlite3.connect(migrated) as unchanged:
        assert unchanged.execute("PRAGMA user_version").fetchone()[0] == 0
        assert unchanged.execute("SELECT value FROM legacy_marker").fetchone() is None
        assert unchanged.execute("PRAGMA journal_mode").fetchone()[0].lower() == "delete"
    assert list(tmp_path.glob("unknown.sqlite3.pre-v1-*.sqlite3")) == []

def test_empty_v0_ddl_failure_rolls_back_without_persisting_schema(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    failed = tmp_path / "failed-migration.sqlite3"
    sqlite3.connect(failed).close()
    monkeypatch.setattr(batch_store_module, "_DDL", batch_store_module._DDL + ("CREATE TABLE broken (",))
    with pytest.raises(BatchSchemaIncompatible):
        BatchStore(failed)
    with sqlite3.connect(failed) as unchanged:
        assert unchanged.execute("PRAGMA user_version").fetchone()[0] == 0
        assert unchanged.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
        ).fetchone()[0] == 0
def test_supervisor_takeover_interrupts_old_owner_but_preserves_succeeded_pages(tmp_path: Path) -> None:
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job, _ = _new_job(store)
        source_id = job["sources"][0]["source_id"]
        store.begin_page(job["id"], 1, "owner-a", source_id, 1)
        store.commit_page(job["id"], 1, "owner-a", source_id, 1, 1, _payload(), _budget())
        # A second source page is claimed by the old process and remains in
        # processing when the host takes ownership again.
        store.register_source(job["id"], 1, "owner-a", source_id, SHA, 100, 1)
        store.activate_supervisor("owner-b")
        assert store.get_job(job["id"])["state"] == "interrupted"
        page = store.connection.execute(
            "SELECT state FROM batch_pages WHERE job_id = ? AND source_id = ? AND page = 1",
            (job["id"], source_id),
        ).fetchone()
        assert page["state"] == "succeeded"
        assert len(list(store.read_page_results(job["id"]))) == 1
