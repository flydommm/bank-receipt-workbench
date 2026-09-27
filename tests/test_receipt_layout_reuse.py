"""Saved geometry survives new searches without carrying over old results."""
from copy import deepcopy
import shutil

import pymupdf
import pytest

from engine.batch_pdf import open_batch_source
from engine.batch_review import prepare_batch_review, read_batch_receipt_review_page
from engine.batch_processor import BatchProcessor, BatchProgress
from engine.batch_store import BatchStore
from engine.computation import current_computation_version
from engine.receipt_calibration_journal import retain_calibration_preview, save_calibration_preview, undo_calibration_operation
from engine.receipt_layout_review import preview_receipt_calibration
from engine.receipt_layout_reuse import pin_saved_receipt_layouts
from engine.search import SearchBudget
from tests.test_receipt_layout_review import _ready, _pdf, _prepared, _draft, private_temp
from tests.test_receipt_batch_pdf import ALL


def search(word):
    return {"processing_mode": "search", "criteria": {"include": [word], "includeMode": "all", "exclude": []}}


def source(tmp_path):
    path = _pdf(tmp_path, "source", counts=(3, 3))
    with pymupdf.open(path) as document:
        for page in document:
            for index, word in enumerate(("FIRST", "SECOND", "THIRD")):
                page.insert_text((300, 200 + index * 280), word)
        document.saveIncr()
    return path


def calibration(store, ready, review):
    prepared = _prepared(store, ready, review)
    preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
    assert preview.can_save
    retained = retain_calibration_preview(store, preview, review)
    return preview, retained


def save(store, ready, review, retained):
    return save_calibration_preview(store, ready["id"], retained["operation_id"], retained["preview_fingerprint"], review,
                                    acknowledged_risk_ids=[risk["risk_id"] for risk in retained["risks"]])


def execute(store, job, sink=None):
    version = current_computation_version()
    running = store.start_job(job["id"], job["generation"], "host", version)
    return BatchProcessor(store, job["id"], running["generation"], "host", version,
                          BatchProgress(sink or (lambda *_: None))).run()


@pytest.mark.parametrize("options,positions", [(search("SECOND"), [2]), (ALL, [1, 2, 3])])
def test_new_query_recomputes_pages_without_reusing_calibration_or_review(tmp_path, options, positions):
    path = source(tmp_path)
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [path], search("FIRST"))
        preview, retained = calibration(store, ready, tmp_path / "review.sqlite3")
        save(store, ready, tmp_path / "review.sqlite3", retained)
        changed = _ready(store, [path], options)
        rows = store.read_page_results(changed["id"])
        expected = {row["page"]: row["payload"]["receipt_page"]["layout_definition"] for row in preview.page_rows}
        for row in rows:
            receipt = row["payload"]["receipt_page"]
            assert receipt["layout_definition"] != expected[row["page"]]
            assert row["payload"]["suggestion"] == {"basis": "page_evidence", "needs_review": False}
            assert [item["position_index"] for item in receipt["instances"]] == [1, 2, 3]
            selected = {item["instance_id"] for item in receipt["candidates"]}
            assert [item["position_index"] for item in receipt["instances"] if item["instance_id"] in selected] == positions
        assert changed["sources"][0]["budget"]["processed_pages"] == 2
        assert store.connection.execute("SELECT page_count FROM batch_receipt_layout_pins WHERE job_id=?",
                                        (changed["id"],)).fetchone()[0] == 0


@pytest.mark.parametrize("saved,undone", [(False, False), (True, True)])
def test_unconfirmed_or_undone_round_cannot_enter_new_task(tmp_path, saved, undone):
    path = source(tmp_path)
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [path], search("FIRST"))
        before = [row["payload"]["receipt_page"]["layout_definition"] for row in store.read_page_results(ready["id"])]
        _, retained = calibration(store, ready, review)
        if saved:
            save(store, ready, review, retained)
        if undone:
            undo_calibration_operation(store, ready["id"], retained["operation_id"], review, undo_id="undo")
        changed = _ready(store, [path], search("SECOND"))
        assert [row["payload"]["receipt_page"]["layout_definition"] for row in store.read_page_results(changed["id"])] == before


def test_other_logical_source_and_changed_bytes_do_not_reuse_saved_geometry(tmp_path):
    path = source(tmp_path)
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [path])
        _, retained = calibration(store, ready, review)
        save(store, ready, review, retained)
        copied = tmp_path / "same-bytes-other-source.pdf"
        shutil.copyfile(path, copied)
        other = _ready(store, [copied], ALL)
        with pymupdf.open(path) as document:
            document.set_metadata({"title": "changed synthetic bytes"})
            document.saveIncr()
        changed = _ready(store, [path], ALL)
        for job in (other, changed):
            assert store.connection.execute("SELECT page_count FROM batch_receipt_layout_pins WHERE job_id=?",
                                            (job["id"],)).fetchone()[0] == 0


@pytest.mark.parametrize("save_before_pin", [False, True])
def test_pause_resume_keeps_pinned_geometry_including_empty_snapshot(tmp_path, save_before_pin):
    path = source(tmp_path)
    review = tmp_path / "review.sqlite3"
    database = tmp_path / "tasks.sqlite3"
    with BatchStore(database) as store:
        ready = _ready(store, [path], search("FIRST"))
        _, retained = calibration(store, ready, review)
        if save_before_pin:
            save(store, ready, review, retained)
        job = store.create_receipt_job("next", [{"source_path": str(path), "name": path.name}], ALL,
                                       "exact", current_computation_version())
        def pause(event, payload):
            if event == "progress" and payload.get("phase") == "page_settled":
                current = store.get_job(job["id"])
                store.control(job["id"], current["generation"], "pause-after-page", "pause")
        paused = execute(store, job, pause)
        assert paused["state"] == "paused"
        first = store.read_page_results(job["id"])[0]["payload"]["receipt_page"]["layout_definition"]
        if save_before_pin:
            undo_calibration_operation(store, ready["id"], retained["operation_id"], review, undo_id="undo-after-pin")
        else:
            save(store, ready, review, retained)
    with BatchStore(database) as store:
        complete = execute(store, store.get_job(job["id"]))
        assert complete["state"] == "ready_for_review"
        rows = store.read_page_results(job["id"])
        assert rows[1]["payload"]["receipt_page"]["layout_definition"]["slots"] == first["slots"]
        assert complete["sources"][0]["budget"]["processed_pages"] == 2


@pytest.mark.parametrize("second_keyword", ["FIRST", "SECOND"])
def test_calibration_review_projection_isolated_between_tasks_and_undo(tmp_path, second_keyword):
    path = source(tmp_path)
    review = tmp_path / "review.sqlite3"

    def decisions(page):
        return [
            (item["original"]["id"], item["record"] and item["record"]["review_status"],
             item["record"] and item["record"]["record_revision"],
             item["record"] and item["record"]["final_rect"])
            for item in page["items"]
        ]

    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        first = _ready(store, [path], search("FIRST"))
        _, first_retained = calibration(store, first, review)
        first_saved = save(store, first, review, first_retained)
        first_view = read_batch_receipt_review_page(
            store, first["id"], first_saved["result_revision"], 0, 200, review
        )
        first_decisions = decisions(first_view)
        assert first_decisions and all(status == "confirmed" for _, status, _, _ in first_decisions)

        second = _ready(store, [path], search(second_keyword))
        _, second_retained = calibration(store, second, review)
        save(store, second, review, second_retained)
        prepare_batch_review(store, first["id"], first_saved["result_revision"], review)
        assert decisions(read_batch_receipt_review_page(
            store, first["id"], first_saved["result_revision"], 0, 200, review
        )) == first_decisions

        # Restore the second task's binding before invoking its undo; review
        # reads are intentionally scoped to one current published revision.
        second_saved = store.get_job(second["id"])
        prepare_batch_review(store, second["id"], second_saved["result_revision"], review)
        undo_calibration_operation(
            store, second["id"], second_retained["operation_id"], review, undo_id="undo-second-task"
        )
        prepare_batch_review(store, first["id"], first_saved["result_revision"], review)
        assert decisions(read_batch_receipt_review_page(
            store, first["id"], first_saved["result_revision"], 0, 200, review
        )) == first_decisions


def test_new_tasks_have_empty_layout_pins_and_geometry_mismatch_falls_back(tmp_path):
    path = source(tmp_path)
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [path])
        preview, retained = calibration(store, ready, tmp_path / "review.sqlite3")
        save(store, ready, tmp_path / "review.sqlite3", retained)
        changed = _ready(store, [path], ALL)
        assert store.connection.execute("SELECT page_count FROM batch_receipt_layout_pins WHERE job_id=?",
                                        (changed["id"],)).fetchone()[0] == 0
        assert pin_saved_receipt_layouts(store, changed["id"], changed["generation"], "host") == {}
        bad_geometry = deepcopy(preview.draft)
        bad_geometry["page_geometry"]["width_pt"] += 1
        bad_geometry["page_geometry"]["pdf_box"]["x1"] += 1
        with open_batch_source(path) as opened:
            automatic = opened.compute_receipt_page(1, ALL, "exact", SearchBudget())
            mismatched = opened.compute_receipt_page(1, ALL, "exact", SearchBudget(), reused_layout_definition=bad_geometry)
            assert mismatched.result == automatic.result


def test_source_calibration_save_order_does_not_reuse_geometry_in_new_tasks(tmp_path):
    path = source(tmp_path)
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        first = _ready(store, [path], search("FIRST"))
        _, first_retained = calibration(store, first, review)
        second = _ready(store, [path], search("SECOND"))
        prepared = _prepared(store, second, review)
        draft = _draft(prepared)
        for slot in draft["slots"]:
            slot["height_pt"] -= 4
        second_preview = preview_receipt_calibration(store, prepared, draft, review)
        second_retained = retain_calibration_preview(store, second_preview, review)
        save(store, second, review, second_retained)
        save(store, first, review, first_retained)
        latest = _ready(store, [path], ALL)
        assert all(row["payload"]["suggestion"] == {"basis": "page_evidence", "needs_review": False}
                   for row in store.read_page_results(latest["id"]))
        assert store.connection.execute("SELECT page_count FROM batch_receipt_layout_pins WHERE job_id=?",
                                        (latest["id"],)).fetchone()[0] == 0


def test_later_partial_calibration_does_not_enter_a_new_task(tmp_path):
    path = source(tmp_path)
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [path])
        _, first_retained = calibration(store, ready, review)
        save(store, ready, review, first_retained)
        current = store.get_job(ready["id"])
        prepared = _prepared(store, current, review)
        draft = deepcopy(prepared.layout)
        draft["revision"] += 1
        draft["uniform_height"] = False
        draft["slots"][0]["top_pt"] += 5
        draft["slots"][0]["height_pt"] -= 5
        second_preview = preview_receipt_calibration(store, prepared, draft, review)
        second_retained = retain_calibration_preview(store, second_preview, review)
        save(store, current, review, second_retained)
        latest = _ready(store, [path], search("THIRD"))
        assert all(row["payload"]["suggestion"] == {"basis": "page_evidence", "needs_review": False}
                   for row in store.read_page_results(latest["id"]))
        assert store.connection.execute("SELECT page_count FROM batch_receipt_layout_pins WHERE job_id=?",
                                        (latest["id"],)).fetchone()[0] == 0


def test_computation_upgrade_does_not_reuse_source_calibration(tmp_path, monkeypatch):
    from engine import batch_review, receipt_layout_review
    from tests import test_receipt_layout_review as fixtures

    path = source(tmp_path)
    database = tmp_path / "tasks.sqlite3"
    review = tmp_path / "review.sqlite3"
    old_version = "synthetic-previous-release-computation"
    with monkeypatch.context() as previous_release:
        for module in (fixtures, batch_review, receipt_layout_review):
            previous_release.setattr(module, "current_computation_version", lambda: old_version)
        with BatchStore(database) as store:
            ready = _ready(store, [path], search("FIRST"))
            assert ready["computation_version"] == old_version
            preview, retained = calibration(store, ready, review)
            save(store, ready, review, retained)
    # Reopening the persisted journal with the current calculation contract
    # models an application upgrade rather than merely another live query.
    with BatchStore(database) as store:
        latest = _ready(store, [path], search("SECOND"))
        assert latest["computation_version"] == current_computation_version()
        assert latest["computation_version"] != old_version
        for row in store.read_page_results(latest["id"]):
            receipt = row["payload"]["receipt_page"]
            assert row["payload"]["suggestion"] == {"basis": "page_evidence", "needs_review": False}
            selected = {item["instance_id"] for item in receipt["candidates"]}
            assert [item["position_index"] for item in receipt["instances"] if item["instance_id"] in selected] == [2]
        pins = store.connection.execute("SELECT payload_json FROM batch_receipt_layout_pin_pages WHERE job_id=?",
                                        (latest["id"],)).fetchall()
        assert pins == []
