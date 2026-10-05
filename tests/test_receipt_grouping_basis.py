"""Warm grouping reuses audited rows without weakening current evidence."""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from unittest.mock import patch

import pytest

from engine.batch_api import handle_batch_request
from engine.batch_store import BatchStore
from engine.receipt_grouping_basis import GroupingBasisCache
from engine.review_store_v2 import ReviewStoreV2
from tests.test_receipt_grouping_integration import grouping_task, prepare_and_page, call


def request(task, header, op="batch_receipt_grouping_page", **fields):
    body = dict(op=op, database_path=str(task[0]), grouping_database_path=str(task[1]),
                job_id=header["job_id"], result_revision=header["result_revision"],
                expected_grouping_revision=header["grouping_revision"],
                expected_review_fingerprint=header["review_fingerprint"])
    body.update(dict(offset=0, limit=200) if op.endswith("page") else fields)
    return body


def test_cache_is_bounded_detached_and_projects_only_selected_authority():
    cache = GroupingBasisCache(max_entries=1, max_bytes=1024)
    value = ({"job": {"id": "j"}, "originals": [{"id": "a"}]}, [{"id": "a"}, {"id": "b"}], "f")
    cache.put("a", value)
    value[0]["job"]["id"] = "modified"
    read = cache.get("a", {"b"})
    assert read == ({"job": {"id": "j"}}, [{"id": "b"}], "f")
    read[1][0]["id"] = "modified"
    assert cache.get("a", set()) == ({"job": {"id": "j"}}, [], "f")
    assert cache.get("a", {"b"})[1] == [{"id": "b"}]
    cache.put("b", value)
    assert cache.get("a") is None
    cache.put("large", "x" * 2000)
    assert cache.get("large") is None


def test_unchanged_page_and_selected_refresh_do_not_rebuild_whole_task(grouping_task):
    task = grouping_task
    header, page = prepare_and_page(task)
    with patch("engine.receipt_grouping_api._trusted_inputs", side_effect=AssertionError("reconstructed unchanged task")):
        assert handle_batch_request(request(task, header))["data"] == page
        refreshed = handle_batch_request(request(task, header, "batch_receipt_grouping_refresh",
            segment_ids=[page["items"][0]["binding"]["segment_id"]]))
        assert refreshed["status"] == "ok", refreshed
        assert len(refreshed["data"]["items"]) == 1
        assert handle_batch_request(request(task, refreshed["data"]["header"]))["status"] == "ok"


@pytest.mark.parametrize("damage", ["checkpoint", "snapshot", "manifest", "schema", "revision", "source_binding", "history"])
def test_warm_basis_rejects_changed_or_corrupt_durable_inputs(grouping_task, damage):
    task = grouping_task
    header, _ = prepare_and_page(task)
    target = task[1] if damage in {"manifest", "schema", "history"} else task[0]
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
        elif damage == "source_binding":
            connection.execute("UPDATE batch_sources SET access_path=access_path || '.absent'")
        else:
            context = connection.execute("SELECT context_key FROM review_contexts_v2").fetchone()[0]
            connection.execute("INSERT INTO review_receipt_records_v1 VALUES (?, 'missing', 'old', 'old', 'bad', 'old', 1, '{}', '')", (context,))
    assert handle_batch_request(request(task, header))["status"] == "error"


def edit_review(task):
    from engine.batch_review import _receipt_context_key
    from tests.test_batch_receipt_review import _make_edit
    with BatchStore(task[0]) as store:
        snapshot = store.review_snapshot(task[2]["id"], task[2]["result_revision"])
    _, key = _receipt_context_key(snapshot["context"])
    edit = _make_edit(key, task[2]["result_revision"], snapshot["originals"][0])
    with ReviewStoreV2(task[1]) as reviews:
        reviews.save(key, task[2]["result_revision"], [edit])


def test_warm_basis_rejects_valid_review_change(grouping_task):
    task = grouping_task
    header, _ = prepare_and_page(task)
    edit_review(task)
    response = handle_batch_request(request(task, header))
    assert response["status"] == "error" and response["code"] == "grouping_conflict"


def test_extraction_rechecks_review_under_locks(grouping_task):
    import engine.receipt_grouping_api as api
    task = grouping_task
    header, page = prepare_and_page(task)
    original = api._extract_selected
    def racing_extract(*args, **kwargs):
        result = original(*args, **kwargs)
        edit_review(task)
        return result
    with patch.object(api, "_extract_selected", side_effect=racing_extract):
        response = handle_batch_request(request(task, header, "batch_receipt_grouping_refresh",
            segment_ids=[page["items"][0]["binding"]["segment_id"]]))
    assert response["status"] == "error" and response["code"] == "grouping_conflict"


def test_warm_basis_rechecks_analysis_version(grouping_task):
    task = grouping_task
    header, _ = prepare_and_page(task)
    with patch("engine.computation.current_computation_version", return_value="changed"):
        assert handle_batch_request(request(task, header))["status"] == "error"


def test_warm_refresh_still_hashes_actual_pdf_bytes(grouping_task):
    task = grouping_task
    header, page = prepare_and_page(task)
    original = task[3].read_bytes()
    try:
        changed = bytearray(original)
        changed[-10] ^= 1
        task[3].write_bytes(changed)
        response = handle_batch_request(request(task, header, "batch_receipt_grouping_refresh",
            segment_ids=[page["items"][0]["binding"]["segment_id"]]))
        assert response["status"] == "error" and response["code"] == "source_changed"
    finally:
        task[3].write_bytes(original)


def test_real_serve_handles_grouping_sequence_failure_and_changed_review(grouping_task):
    task = grouping_task
    engine = Path(__file__).parents[1] / "engine" / "engine.py"
    process = subprocess.Popen([sys.executable, "-X", "utf8", str(engine), "--serve"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
    def send(body):
        process.stdin.write(json.dumps(body) + "\n")
        process.stdin.flush()
        return json.loads(process.stdout.readline())
    try:
        prepared = send(dict(op="batch_receipt_grouping_prepare", database_path=str(task[0]),
            grouping_database_path=str(task[1]), job_id=task[2]["id"],
            result_revision=task[2]["result_revision"], expected_grouping_revision=-1))
        assert prepared["status"] == "ok"
        header = prepared["data"]
        first = send(request(task, header))
        assert first["status"] == "ok" and first["data"]["total"] == 3
        invalid = send(request(task, header, "batch_receipt_grouping_refresh", segment_ids=[]))
        assert invalid["status"] == "error"
        refreshed = send(request(task, header, "batch_receipt_grouping_refresh",
            segment_ids=[item["binding"]["segment_id"] for item in first["data"]["items"]]))
        assert refreshed["status"] == "ok"
        header = refreshed["data"]["header"]
        assert header["counts"]["extraction_pending"] == 0
        item = refreshed["data"]["items"][0]
        saved = send(request(task, header, "batch_receipt_grouping_save", edits=[], group_edits=[
            {"action": "rename", "group_id": item["group"]["group_id"], "display_name": "合成核对后的名称"}]))
        assert saved["status"] == "ok"
        header = saved["data"]["header"]
        assert send(request(task, header))["status"] == "ok"
        edit_review(task)
        changed = send(request(task, header))
        assert changed["status"] == "error" and changed["code"] == "grouping_conflict"
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        assert process.returncode == 0
