"""Explicit exclusion is a task/result decision, never a crop or confirmation."""
from copy import deepcopy
import hashlib
import sqlite3

import pytest

from engine.receipt_review_read import read_receipt_review_snapshot
from engine.review_store_v2 import ReviewStoreV2, ReviewStoreError, ReviewRevisionConflict, ReviewStoreCorruptionError
from tests.test_receipt_review_store import prepare, two_originals, edits


_LEGACY_RECEIPT_COLUMNS = ("context_key", "source_key", "instance_id", "id", "analysis_signature",
                           "result_revision", "record_revision", "record_json")
_LEGACY_RECEIPT_DDL = """CREATE TABLE review_receipt_records_v1 (
    context_key TEXT NOT NULL, source_key TEXT NOT NULL, instance_id TEXT NOT NULL,
    id TEXT NOT NULL, analysis_signature TEXT NOT NULL, result_revision TEXT NOT NULL,
    record_revision INTEGER NOT NULL CHECK(record_revision > 0), record_json TEXT NOT NULL,
    PRIMARY KEY(context_key, source_key, instance_id),
    FOREIGN KEY(context_key) REFERENCES review_contexts_v2(context_key) ON DELETE CASCADE)"""


def _legacy_database(path, excluded=False):
    with ReviewStoreV2(path) as store:
        prepared = prepare(store)
        pending = edits(prepared, two_originals())
        if excluded:
            pending[0]["review_status"] = "excluded"
        expected = store.save(prepared["context_key"], "run-1", pending)["segments"]
        rows = list(store.connection.execute("SELECT " + ",".join(_LEGACY_RECEIPT_COLUMNS) + " FROM review_receipt_records_v1"))
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE review_receipt_records_v1")
        connection.execute(_LEGACY_RECEIPT_DDL)
        connection.executemany("INSERT INTO review_receipt_records_v1 VALUES (?,?,?,?,?,?,?,?)", [tuple(row) for row in rows])
    return prepared, expected


def _decision(prepared, original, status, revision=0, record=None):
    edit = edits(prepared, [original])[0]
    edit.update(review_status=status, record_revision=revision)
    if record:
        edit.update({field: deepcopy(record[field]) for field in ("final_rect", "crop_mode", "manual_adjusted")})
    return edit


@pytest.mark.parametrize("a_status", ["excluded", "needs_review", "confirmed"])
@pytest.mark.parametrize("b_status", ["confirmed", "excluded"])
def test_task_scoped_exclusion_history_survives_other_task_writes(tmp_path, a_status, b_status):
    database = tmp_path / "review.sqlite3"
    a = two_originals()
    b = deepcopy(a)
    b[0]["id"], b[1]["id"] = "8" * 64, "9" * 64
    with ReviewStoreV2(database) as store:
        first = prepare(store)
        store.save(first["context_key"], "run-1", [_decision(first, a[0], "excluded")])
        if a_status != "excluded":
            store.save(first["context_key"], "run-1", [_decision(first, a[0], "needs_review", 1)])
        if a_status == "confirmed":
            store.save(first["context_key"], "run-1", [_decision(first, a[0], "confirmed", 2)])
        before = read_receipt_review_snapshot(database, first["context_key"], "run-1")
        second = prepare(store, originals=b, revision="run-2", owner="job-two")
        assert second["segments"] == []
        assert second["record_revisions"][0]["record_revision"] == 0
        store.save(second["context_key"], "run-2", [_decision(second, b[0], b_status)])
        second_saved = read_receipt_review_snapshot(database, second["context_key"], "run-2")
        assert prepare(store) == before
        assert read_receipt_review_snapshot(database, first["context_key"], "run-1") == before
        assert prepare(store, originals=b, revision="run-2", owner="job-two") == second_saved
    with ReviewStoreV2(database) as store:
        assert prepare(store) == before
        assert prepare(store, originals=b, revision="run-2", owner="job-two") == second_saved


@pytest.mark.parametrize("excluded", [False, True])
def test_legacy_eight_column_database_reads_without_mutation_then_migrates_losslessly(tmp_path, excluded):
    path = tmp_path / "review.sqlite3"
    prepared, expected = _legacy_database(path, excluded)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    old = read_receipt_review_snapshot(path, prepared["context_key"], "run-1")
    assert old["segments"] == expected
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    with ReviewStoreV2(path) as store:
        actual = prepare(store)
        assert actual == old
        columns = [row["name"] for row in store.connection.execute("PRAGMA table_info(review_receipt_records_v1)")]
        # The old codec requires exactly the eight names above and a 3-column
        # primary key. Even a restored (non-excluded) decision cannot evade it.
        assert columns == [*_LEGACY_RECEIPT_COLUMNS, "decision_scope"]
        scopes = {row["id"]: row["decision_scope"] for row in store.connection.execute("SELECT id,decision_scope FROM review_receipt_records_v1")}
        assert bool(scopes[two_originals()[0]["id"]]) == excluded
        changed = deepcopy(two_originals())
        changed[0]["id"], changed[1]["id"] = "8" * 64, "9" * 64
        second = prepare(store, originals=changed, revision="run-2", owner="job-two")
        assert second["segments"] == []


def test_receipt_schema_migration_failure_rolls_back_schema_and_rows(tmp_path, monkeypatch):
    from engine import receipt_review_store as receipt_store
    path = tmp_path / "review.sqlite3"
    _legacy_database(path)
    with sqlite3.connect(path) as connection:
        before = list(connection.iterdump())
    upsert = receipt_store._upsert
    calls = 0
    def fail_second(connection, record, **kwargs):
        nonlocal calls
        upsert(connection, record, **kwargs)
        calls += 1
        if calls == 2:
            raise OSError("synthetic migration failure")
    monkeypatch.setattr(receipt_store, "_upsert", fail_second)
    with pytest.raises(OSError, match="synthetic migration"):
        ReviewStoreV2(path)
    with sqlite3.connect(path) as connection:
        assert list(connection.iterdump()) == before


def test_scoped_history_is_counted_by_ownership_cleanup_and_bounded_atomically(tmp_path, monkeypatch):
    from engine import receipt_review_store as receipt_store
    path = tmp_path / "review.sqlite3"
    with ReviewStoreV2(path) as store:
        first = prepare(store)
        original = two_originals()[0]
        store.save(first["context_key"], "run-1", [_decision(first, original, "excluded")])
        before = store.batch_ownership(first["context_key"], "job-one")
        second_original = deepcopy(original)
        second_original["id"] = "8" * 64
        second = prepare(store, originals=[second_original, two_originals()[1]], revision="run-2", owner="job-two")
        monkeypatch.setattr(receipt_store, "MAX_RECEIPT_REVIEW_HISTORY_RECORDS", 1)
        with pytest.raises(ReviewStoreError, match="bounded storage"):
            store.save(second["context_key"], "run-2", [_decision(second, second_original, "excluded")])
        assert store.connection.execute("SELECT COUNT(*) FROM review_receipt_records_v1").fetchone()[0] == 1
        monkeypatch.setattr(receipt_store, "MAX_RECEIPT_REVIEW_HISTORY_RECORDS", 10)
        store.save(second["context_key"], "run-2", [_decision(second, second_original, "excluded")])
        after = store.batch_ownership(first["context_key"], "job-one")
        assert after["record_count"] == 2 and before["fingerprint"] != after["fingerprint"]
        monkeypatch.setattr(receipt_store, "MAX_RECEIPT_REVIEW_HISTORY_BYTES", 1)
        with pytest.raises(ReviewStoreError, match="bounded storage"):
            prepare(store)
        monkeypatch.setattr(receipt_store, "MAX_RECEIPT_REVIEW_HISTORY_BYTES", 1024 * 1024)
        latest = store.batch_ownership(first["context_key"], "job-one")
        released = store.release_batch_owner(first["context_key"], "job-one", "cleanup-scoped-first", True, latest["fingerprint"])
        assert released["outcome"] == "released_shared"
        latest = store.batch_ownership(first["context_key"], "job-two")
        deleted = store.release_batch_owner(first["context_key"], "job-two", "cleanup-scoped", True, latest["fingerprint"])
        assert deleted["outcome"] == "deleted" and deleted["deleted_record_count"] == 2
        assert store.connection.execute("SELECT COUNT(*) FROM review_receipt_records_v1").fetchone()[0] == 0


@pytest.mark.parametrize("mode", ["candidate", "manual", "full_page"])
def test_exclusion_restore_keeps_current_geometry_and_unselected_record(tmp_path, mode):
    database = tmp_path / "review.sqlite3"
    originals = two_originals()
    with ReviewStoreV2(database) as store:
        prepared = prepare(store)
        initial = edits(prepared, originals)
        initial[0]["crop_mode"] = mode
        if mode == "manual":
            initial[0]["manual_adjusted"] = True
            initial[0]["final_rect"]["y0"] += 4
        elif mode == "full_page":
            initial[0]["final_rect"] = None
        saved = store.save(prepared["context_key"], "run-1", initial)["segments"]
        before = read_receipt_review_snapshot(database, prepared["context_key"], "run-1")
        excluded = _decision(prepared, originals[0], "excluded", 1, saved[0])
        result = store.save(prepared["context_key"], "run-1", [excluded])
        assert result["saved_count"] == 1
        actual = read_receipt_review_snapshot(database, prepared["context_key"], "run-1")
        assert actual["segments"][0]["review_status"] == "excluded"
        assert actual["segments"][0]["original"] == before["segments"][0]["original"]
        assert actual["segments"][1] == before["segments"][1]
        for field in ("final_rect", "crop_mode", "manual_adjusted"):
            assert actual["segments"][0][field] == before["segments"][0][field]
        # A stale retry cannot reapply or overwrite a newer decision.
        with pytest.raises(ReviewRevisionConflict):
            store.save(prepared["context_key"], "run-1", [excluded])
        restored = _decision(prepared, originals[0], "needs_review", 2, actual["segments"][0])
        store.save(prepared["context_key"], "run-1", [restored])
        current = read_receipt_review_snapshot(database, prepared["context_key"], "run-1")
        assert current["segments"][0]["review_status"] == "needs_review"
        assert current["segments"][0]["record_revision"] == 3
        for field in ("final_rect", "crop_mode", "manual_adjusted"):
            assert current["segments"][0][field] == before["segments"][0][field]


@pytest.mark.parametrize("status", ["confirmed", "page_confirmed", "pending", "blocked"])
def test_excluded_cannot_be_reincluded_by_single_or_batch_confirmation(status):
    with ReviewStoreV2() as store:
        prepared = prepare(store)
        first, second = two_originals()
        store.save(prepared["context_key"], "run-1", [_decision(prepared, first, "excluded")])
        before = list(store.connection.iterdump())
        with pytest.raises(ReviewStoreError, match="restore.*needs_review"):
            store.save(prepared["context_key"], "run-1", [
                _decision(prepared, second, "confirmed"), _decision(prepared, first, status, 1)])
        assert list(store.connection.iterdump()) == before


@pytest.mark.parametrize("phase", ["exclude", "restore"])
def test_exclusion_and_restore_cannot_silently_change_crop(phase):
    with ReviewStoreV2() as store:
        prepared = prepare(store)
        first = two_originals()[0]
        if phase == "restore":
            store.save(prepared["context_key"], "run-1", [_decision(prepared, first, "excluded")])
        edit = _decision(prepared, first, "excluded" if phase == "exclude" else "needs_review", int(phase == "restore"))
        edit.update(crop_mode="manual", manual_adjusted=True)
        edit["final_rect"]["y0"] += 3
        before = list(store.connection.iterdump())
        with pytest.raises(ReviewStoreError, match="preserve.*geometry"):
            store.save(prepared["context_key"], "run-1", [edit])
        assert list(store.connection.iterdump()) == before


@pytest.mark.parametrize("change", ["new_job", "new_analysis", "new_signature"])
def test_new_task_does_not_rebind_exclusion_or_ordinary_review(tmp_path, change):
    database = tmp_path / "review.sqlite3"
    with ReviewStoreV2(database) as store:
        prepared = prepare(store)
        originals = two_originals()
        store.save(prepared["context_key"], "run-1", [
            _decision(prepared, originals[0], "excluded"), _decision(prepared, originals[1], "confirmed")])
        changed = deepcopy(originals)
        if change in {"new_job", "new_analysis"}:
            changed[0]["id"], changed[1]["id"] = "8" * 64, "9" * 64
        elif change == "new_signature":
            changed[0]["analysis_signature"] = "6" * 64
        newer = prepare(store, originals=changed, revision="run-2", owner="job-two" if change == "new_job" else "job-one")
        if change in {"new_job", "new_analysis"}:
            assert newer["segments"] == []
            assert [r["record_revision"] for r in newer["record_revisions"]] == [0, 0]
        else:
            assert [r["original"]["id"] for r in newer["segments"]] == [changed[1]["id"]]
            assert newer["segments"][0]["review_status"] == "confirmed"
            assert [r["record_revision"] for r in newer["record_revisions"]] == [1, 1]
        assert read_receipt_review_snapshot(database, prepared["context_key"], "run-2") == newer
        # The inaccessible historical exclusion does not block a new current decision.
        saved = store.save(newer["context_key"], "run-2", [_decision(
            newer, changed[0], "confirmed", newer["record_revisions"][0]["record_revision"])] )
        assert saved["segments"][0]["review_status"] == "confirmed"


def test_same_task_result_reopen_preserves_exclusion_and_unknown_old_codec_refuses_without_write(tmp_path, monkeypatch):
    from engine import receipt_review_models
    database = tmp_path / "review.sqlite3"
    with ReviewStoreV2(database) as store:
        prepared = prepare(store)
        store.save(prepared["context_key"], "run-1", [_decision(prepared, two_originals()[0], "excluded")])
        assert prepare(store)["segments"][0]["review_status"] == "excluded"
    with ReviewStoreV2(database) as store:
        assert prepare(store)["segments"][0]["review_status"] == "excluded"
        before = list(store.connection.iterdump())
        # Model the unchanged 0.1.38 strict status set: no coercion or repair.
        monkeypatch.setattr(receipt_review_models, "_REVIEW_STATUSES", receipt_review_models._REVIEW_STATUSES - {"excluded"})
        with pytest.raises(ReviewStoreCorruptionError):
            read_receipt_review_snapshot(database, prepared["context_key"], "run-1")
        with pytest.raises(ReviewStoreCorruptionError):
            prepare(store)
        assert list(store.connection.iterdump()) == before


@pytest.mark.parametrize("target", ["same_layout", "different_bank"])
@pytest.mark.parametrize("mode", ["candidate", "manual", "full_page"])
def test_calibration_preserves_only_unchanged_exclusion_and_undo_restores_decision(tmp_path, monkeypatch, target, mode):
    from engine.batch_store import BatchStore
    from engine.batch_review import read_batch_receipt_review_page, save_batch_receipt_review
    from engine.receipt_layout_review import preview_receipt_calibration
    from engine.receipt_calibration_journal import retain_calibration_preview, undo_calibration_operation
    from tests.test_receipt_layout_review import _ready, _pdf, _prepared, _draft
    from tests.test_receipt_calibration_journal import _save
    from tests.test_receipt_batch_pdf import ALL
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "first"), _pdf(tmp_path, "other", "中国民生银行业务回单")], ALL)
        prepared = _prepared(store, ready, review)
        originals = prepared.snapshot["originals"]
        excluded_original = originals[0 if target == "same_layout" else 4]
        public = {"context_key": prepared.context_key, "result_revision": ready["result_revision"]}
        baseline = _decision(public, excluded_original, "confirmed")
        baseline["crop_mode"] = mode
        if mode == "manual":
            baseline["manual_adjusted"] = True
            baseline["final_rect"]["y0"] += 2
        elif mode == "full_page":
            baseline["final_rect"] = None
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [baseline], review)
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [_decision(public, excluded_original, "excluded", 1, baseline)], review)
        before = read_batch_receipt_review_page(store, ready["id"], ready["result_revision"], 0, 200, review)
        prepared = _prepared(store, ready, review)
        preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
        retained = retain_calibration_preview(store, preview, review)
        saved = _save(store, ready, review, retained)
        after = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 200, review)
        matching = next(x for x in after["items"] if all(x["original"][k] == excluded_original[k] for k in ("source_key", "source_page", "slot_id")))
        assert matching["record"]["review_status"] == ("needs_review" if target == "same_layout" else "excluded")
        if target == "different_bank":
            assert matching["original"] == excluded_original
        # Another task may reuse ordinary history, but its save must not replace
        # either the retained exclusion or the needs_review invalidation produced
        # by this journal. Rebind back before the normal undo precondition.
        snapshot = store.review_snapshot(ready["id"], saved["result_revision"])
        other_originals = deepcopy(snapshot["originals"])
        for item in other_originals:
            item["id"] = hashlib.sha256((item["id"] + "other-task").encode()).hexdigest()
        with ReviewStoreV2(review) as reviews:
            other = reviews.prepare_batch(snapshot["context"], other_originals,
                result_revision="other-task-result", job_id="other-task")
            other_item = next(item for item in other_originals if all(
                item[k] == matching["original"][k] for k in ("source_key", "source_page", "slot_id")))
            revision = next(item["record_revision"] for item in other["record_revisions"] if item["id"] == other_item["id"])
            old_record = next((item for item in other["segments"] if item["original"]["id"] == other_item["id"]), None)
            reviews.save(other["context_key"], "other-task-result", [_decision(other, other_item, "confirmed", revision, old_record)])
            reviews.prepare_batch(snapshot["context"], snapshot["originals"],
                result_revision=saved["result_revision"], job_id=ready["id"])
        still_current = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 200, review)
        assert next(item for item in still_current["items"] if item["original"]["id"] == matching["original"]["id"]) == matching
        undone = undo_calibration_operation(store, ready["id"], retained["operation_id"], review, undo_id="undo-exclusion")
        assert undone["state"] == "undone"
        restored = read_batch_receipt_review_page(store, ready["id"], ready["result_revision"], 0, 200, review)
        old = next(x for x in before["items"] if x["original"]["id"] == excluded_original["id"])
        actual = next(x for x in restored["items"] if x["original"]["id"] == excluded_original["id"])
        assert actual["original"] == old["original"]
        assert actual["record"]["review_status"] == "excluded"
        assert all(actual["record"][k] == old["record"][k] for k in ("final_rect", "crop_mode", "manual_adjusted", "reviewed_at"))


def test_same_page_rebuilt_identity_keeps_untouched_exclusion_even_when_its_rect_is_unchanged(tmp_path, monkeypatch):
    from engine.batch_store import BatchStore
    from engine.batch_review import read_batch_receipt_review_page, save_batch_receipt_review
    from engine.receipt_layout_review import preview_receipt_calibration
    from engine.receipt_calibration_journal import retain_calibration_preview, undo_calibration_operation
    from tests.test_receipt_layout_review import _ready, _pdf, _prepared
    from tests.test_receipt_calibration_journal import _save
    from tests.test_receipt_batch_pdf import ALL
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "first", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        original = prepared.snapshot["originals"][0]
        public = {"context_key": prepared.context_key, "result_revision": ready["result_revision"]}
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [_decision(public, original, "excluded")], review)
        prepared = _prepared(store, ready, review, 1)
        draft = deepcopy(prepared.layout)
        draft["uniform_height"] = False
        draft["slots"][1]["height_pt"] -= 1
        preview = preview_receipt_calibration(store, prepared, draft, review)
        retained = retain_calibration_preview(store, preview, review)
        saved = _save(store, ready, review, retained)
        current = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 200, review)["items"][0]
        assert current["original"]["candidate_rect"] == original["candidate_rect"]
        assert current["original"]["instance_id"] != original["instance_id"]
        assert current["record"]["review_status"] == "excluded"
        assert _save(store, ready, review, retained) == saved
        undo_calibration_operation(store, ready["id"], retained["operation_id"], review, undo_id="undo-unchanged")
        restored = read_batch_receipt_review_page(store, ready["id"], ready["result_revision"], 0, 200, review)
        assert restored["items"][0]["record"]["review_status"] == "excluded"


def test_manual_final_rect_expansion_beyond_candidate_is_rejected():
    with ReviewStoreV2() as store:
        prepared = prepare(store)
        original = two_originals()[0]
        edit = _decision(prepared, original, "confirmed")
        edit.update(crop_mode="manual", manual_adjusted=True)
        edit["final_rect"]["y1"] += 1
        before = list(store.connection.iterdump())
        with pytest.raises(ReviewStoreError, match="inside"):
            store.save(prepared["context_key"], "run-1", [edit])
        assert list(store.connection.iterdump()) == before


@pytest.mark.parametrize("mode,expected_status", [("manual", "excluded"), ("full_page", "needs_review")])
def test_untouched_excluded_neighbor_manual_or_full_page_policy(tmp_path, monkeypatch, mode, expected_status):
    from engine.batch_store import BatchStore
    from engine.batch_review import read_batch_receipt_review_page, save_batch_receipt_review
    from engine.receipt_layout_review import preview_receipt_calibration
    from engine.receipt_calibration_journal import retain_calibration_preview
    from tests.test_receipt_layout_review import _ready, _pdf, _prepared
    from tests.test_receipt_calibration_journal import _save
    from tests.test_receipt_batch_pdf import ALL
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "first", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        excluded = next(item for item in prepared.snapshot["originals"] if item["slot_id"] == "slot-3")
        public = {"context_key": prepared.context_key, "result_revision": ready["result_revision"]}
        baseline = _decision(public, excluded, "confirmed")
        if mode == "manual":
            baseline.update(crop_mode="manual", manual_adjusted=True)
            baseline["final_rect"]["y0"] += 2
        else:
            baseline.update(crop_mode="full_page", manual_adjusted=False, final_rect=None)
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [baseline], review)
        decision = _decision(public, excluded, "excluded", 1, baseline)
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [decision], review)
        prepared = _prepared(store, ready, review)
        draft = deepcopy(prepared.layout)
        draft["uniform_height"] = False
        draft["slots"][0]["height_pt"] -= 1
        preview = preview_receipt_calibration(store, prepared, draft, review)
        reset_risks = [item for item in preview.risks
                       if item["diagnostic"].get("code") == "excluded_decision_reset"
                       and item["diagnostic"].get("slot_id") == "slot-3"]
        assert bool(reset_risks) is (mode == "full_page")
        retained = retain_calibration_preview(store, preview, review)
        saved = _save(store, ready, review, retained, remember_reference=False)
        current = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 200, review)
        actual = next(item for item in current["items"] if item["original"]["slot_id"] == "slot-3")
        assert actual["record"]["review_status"] == expected_status
        if mode == "manual":
            assert actual["record"]["final_rect"] == decision["final_rect"]


def test_changed_excluded_slot_warns_and_undo_restores_exclusion(tmp_path, monkeypatch):
    from engine.batch_store import BatchStore
    from engine.batch_review import read_batch_receipt_review_page, save_batch_receipt_review
    from engine.receipt_layout_review import preview_receipt_calibration
    from engine.receipt_calibration_journal import retain_calibration_preview, undo_calibration_operation
    from tests.test_receipt_layout_review import _ready, _pdf, _prepared
    from tests.test_receipt_calibration_journal import _save
    from tests.test_receipt_batch_pdf import ALL
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "first", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        excluded = next(item for item in prepared.snapshot["originals"] if item["slot_id"] == "slot-3")
        public = {"context_key": prepared.context_key, "result_revision": ready["result_revision"]}
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [_decision(public, excluded, "excluded")], review)
        prepared = _prepared(store, ready, review)
        draft = deepcopy(prepared.layout)
        draft["uniform_height"] = False
        draft["slots"][2]["top_pt"] += 1
        draft["slots"][2]["height_pt"] -= 1
        preview = preview_receipt_calibration(store, prepared, draft, review)
        third = next(item for item in preview.proposed["originals"] if item["slot_id"] == "slot-3")
        assert third["candidate_rect"] != excluded["candidate_rect"]
        assert third["instance_id"] != excluded["instance_id"]
        assert any(item["slot_id"] == "slot-3" for item in preview.affected)
        reset_risks = [item for item in preview.risks if item["diagnostic"].get("code") == "excluded_decision_reset"]
        assert [(item["page"], item["diagnostic"]["slot_id"]) for item in reset_risks] == [(1, "slot-3")]
        retained = retain_calibration_preview(store, preview, review)
        saved = _save(store, ready, review, retained, remember_reference=False)
        current = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 200, review)
        third_saved = next(item for item in current["items"] if item["original"]["slot_id"] == "slot-3")
        assert third_saved["record"]["review_status"] == "needs_review"
        undo_calibration_operation(store, ready["id"], retained["operation_id"], review, undo_id="undo-third-slot")
        original = read_batch_receipt_review_page(store, ready["id"], ready["result_revision"], 0, 200, review)
        third_restored = next(item for item in original["items"] if item["original"]["slot_id"] == "slot-3")
        assert third_restored["record"]["review_status"] == "excluded"


@pytest.mark.parametrize("difference", ["geometry", "evidence"])
def test_ordinary_exclusion_proof_rejects_neighbor_geometry_or_evidence_change(tmp_path, monkeypatch, difference):
    from engine.batch_store import BatchStore
    from engine.batch_review import save_batch_receipt_review
    from engine.receipt_layout_review import _ordinary_exclusion_proof, preview_receipt_calibration
    from tests.test_receipt_layout_review import _ready, _pdf, _prepared
    from tests.test_receipt_batch_pdf import ALL
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "first", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        excluded = next(item for item in prepared.snapshot["originals"] if item["slot_id"] == "slot-3")
        public = {"context_key": prepared.context_key, "result_revision": ready["result_revision"]}
        save_batch_receipt_review(store, ready["id"], ready["result_revision"],
                                  [_decision(public, excluded, "excluded")], review)
        prepared = _prepared(store, ready, review)
        draft = deepcopy(prepared.layout)
        draft["uniform_height"] = False
        draft["slots"][0]["height_pt"] -= 1
        preview = preview_receipt_calibration(store, prepared, draft, review)
        key = (excluded["source_key"], excluded["source_page"], excluded["slot_id"])
        assert key in _ordinary_exclusion_proof(prepared, preview.proposed, preview.page_rows, {"slot-1"})
        rows = deepcopy(preview.page_rows)
        row = next(item for item in rows if item["source_id"] ==
                   next(source["source_id"] for source in prepared.snapshot["job"]["sources"]
                        if source["source_key"] == excluded["source_key"]) and item["page"] == excluded["source_page"])
        page = row["payload"]["receipt_page"]
        if difference == "geometry":
            page["layout_definition"]["slots"][2]["height_pt"] += 1
        else:
            instance_id = next(instance["instance_id"] for instance in page["instances"]
                               if instance["slot_id"] == "slot-3")
            candidate = next(item for item in page["candidates"] if item["instance_id"] == instance_id)
            candidate["evidence"] = [{"query_id": "include-1",
                                       "rect": {"x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0}}]
        assert key not in _ordinary_exclusion_proof(prepared, preview.proposed, rows, {"slot-1"})


def test_journal_changed_slots_match_preview_when_affected_has_other_page_slot(tmp_path, monkeypatch):
    from engine.batch_store import BatchStore
    from engine.batch_review import read_batch_receipt_review_page, save_batch_receipt_review
    from engine.receipt_layout_review import preview_receipt_calibration
    from engine.receipt_calibration_journal import retain_calibration_preview
    from tests.test_receipt_layout_review import _ready, _pdf, _prepared
    from tests.test_receipt_calibration_journal import _save
    from tests.test_receipt_batch_pdf import ALL
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "first", counts=(3, 3))], ALL)
        prepared = _prepared(store, ready, review)
        excluded = next(item for item in prepared.snapshot["originals"]
                        if item["source_page"] == 1 and item["slot_id"] == "slot-3")
        public = {"context_key": prepared.context_key, "result_revision": ready["result_revision"]}
        save_batch_receipt_review(store, ready["id"], ready["result_revision"],
                                  [_decision(public, excluded, "excluded")], review)
        prepared = _prepared(store, ready, review)
        draft = deepcopy(prepared.layout)
        draft["uniform_height"] = False
        draft["slots"][0]["height_pt"] -= 1
        preview = preview_receipt_calibration(store, prepared, draft, review)
        assert not [item for item in preview.risks
                     if item["diagnostic"].get("code") == "excluded_decision_reset"]
        page_two_slot_three = next(item for item in preview.proposed["originals"]
                                   if item["source_page"] == 2 and item["slot_id"] == "slot-3")
        extra = deepcopy(next(item for item in preview.affected if item["page"] == 2))
        extra.update({"slot_id": "slot-3", "previous_id": None, "id": page_two_slot_three["id"],
                      "before_rect": page_two_slot_three["candidate_rect"],
                      "after_rect": page_two_slot_three["candidate_rect"], "status": "updated"})
        preview.affected.append(extra)
        retained = retain_calibration_preview(store, preview, review)
        saved = _save(store, ready, review, retained, remember_reference=False)
        current = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 200, review)
        page_one_slot_three = next(item for item in current["items"]
                                   if item["original"]["source_page"] == 1
                                   and item["original"]["slot_id"] == "slot-3")
        assert page_one_slot_three["record"]["review_status"] == "excluded"


def test_exclusion_rebind_rejects_concurrent_review_change(tmp_path, monkeypatch):
    from engine.batch_store import BatchConflict, BatchStore
    from engine.batch_review import save_batch_receipt_review
    from engine.receipt_layout_review import preview_receipt_calibration
    from engine.receipt_calibration_journal import retain_calibration_preview
    from tests.test_receipt_layout_review import _ready, _pdf, _prepared
    from tests.test_receipt_calibration_journal import _save
    from tests.test_receipt_batch_pdf import ALL
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "first", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        excluded = next(item for item in prepared.snapshot["originals"] if item["slot_id"] == "slot-3")
        public = {"context_key": prepared.context_key, "result_revision": ready["result_revision"]}
        save_batch_receipt_review(store, ready["id"], ready["result_revision"],
                                  [_decision(public, excluded, "excluded")], review)
        prepared = _prepared(store, ready, review)
        draft = deepcopy(prepared.layout)
        draft["uniform_height"] = False
        draft["slots"][0]["height_pt"] -= 1
        preview = preview_receipt_calibration(store, prepared, draft, review)
        retained = retain_calibration_preview(store, preview, review)
        concurrent = _decision(public, excluded, "needs_review", 1)
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [concurrent], review)
        with pytest.raises(BatchConflict, match="stale"):
            _save(store, ready, review, retained, remember_reference=False)
        assert store.get_job(ready["id"])["result_revision"] == ready["result_revision"]


@pytest.mark.parametrize("replacement", ["rename", "split", "merge"])
def test_replaced_slot_over_excluded_region_needs_review_and_undo_restores_exclusion(tmp_path, monkeypatch, replacement):
    from engine.batch_store import BatchStore
    from engine.batch_review import read_batch_receipt_review_page, save_batch_receipt_review
    from engine.receipt_layout_review import preview_receipt_calibration
    from engine.receipt_calibration_journal import retain_calibration_preview, undo_calibration_operation
    from engine.receipt_review_store import record_is_scoped
    from tests.test_receipt_layout_review import _ready, _pdf, _prepared
    from tests.test_receipt_calibration_journal import _save
    from tests.test_receipt_batch_pdf import ALL
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "first", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        original = prepared.snapshot["originals"][0]
        public = {"context_key": prepared.context_key, "result_revision": ready["result_revision"]}
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [_decision(public, original, "excluded")], review)
        prepared = _prepared(store, ready, review)
        draft = deepcopy(prepared.layout)
        draft["uniform_height"] = False
        draft["slots"][0]["slot_id"] = "slot-replaced"
        replaced_ids = {"slot-replaced"}
        if replacement == "split":
            second = deepcopy(draft["slots"][0])
            draft["slots"][0]["height_pt"] /= 2
            second["top_pt"] += draft["slots"][0]["height_pt"]
            second["height_pt"] = draft["slots"][0]["height_pt"]
            second["slot_id"] = "slot-added"
            draft["slots"].insert(1, second)
            replaced_ids.add("slot-added")
            for index, slot in enumerate(draft["slots"], 1):
                slot["position_index"] = index
        elif replacement == "merge":
            removed = draft["slots"].pop(1)
            draft["slots"][0]["height_pt"] = removed["top_pt"] + removed["height_pt"] - draft["slots"][0]["top_pt"]
            for index, slot in enumerate(draft["slots"], 1):
                slot["position_index"] = index
        preview = preview_receipt_calibration(store, prepared, draft, review)
        reset_slots = {item["diagnostic"]["slot_id"] for item in preview.risks
                       if item["diagnostic"].get("code") == "excluded_decision_reset"}
        assert replaced_ids <= reset_slots
        retained = retain_calibration_preview(store, preview, review)
        assert retained["can_save"] is True
        saved = _save(store, ready, review, retained)
        current = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 200, review)
        replacements = [item for item in current["items"] if item["original"]["slot_id"] in replaced_ids]
        assert {item["original"]["slot_id"] for item in replacements} == replaced_ids
        assert all(item["record"]["review_status"] == "needs_review" for item in replacements)
        assert all(item["record"]["review_status"] == "confirmed" for item in current["items"] if item not in replacements)
        with ReviewStoreV2(review) as reviews:
            assert all(record_is_scoped(reviews.connection, item["record"]) for item in replacements)
        undo_calibration_operation(store, ready["id"], retained["operation_id"], review, undo_id="undo-replaced-slot")
        restored = read_batch_receipt_review_page(store, ready["id"], ready["result_revision"], 0, 200, review)
        assert len(restored["items"]) == 3
        assert restored["items"][0]["original"] == original
        assert restored["items"][0]["record"]["review_status"] == "excluded"


def test_interrupted_calibration_projection_recovers_excluded_without_implicit_confirmation(tmp_path, monkeypatch):
    from engine.batch_store import BatchStore
    from engine.batch_review import prepare_batch_review, read_batch_receipt_review_page, save_batch_receipt_review
    from engine.receipt_layout_review import preview_receipt_calibration
    from engine import receipt_calibration_journal as journal
    from tests.test_receipt_layout_review import _ready, _pdf, _prepared, _draft
    from tests.test_receipt_calibration_journal import _save
    from tests.test_receipt_batch_pdf import ALL
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    database, review = tmp_path / "tasks.sqlite3", tmp_path / "review.sqlite3"
    projection = journal._project_reviews
    with BatchStore(database) as store:
        ready = _ready(store, [_pdf(tmp_path, "first"), _pdf(tmp_path, "other", "中国民生银行业务回单")], ALL)
        prepared = _prepared(store, ready, review)
        excluded = prepared.snapshot["originals"][4]
        public = {"context_key": prepared.context_key, "result_revision": ready["result_revision"]}
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [_decision(public, excluded, "excluded")], review)
        prepared = _prepared(store, ready, review)
        preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
        retained = journal.retain_calibration_preview(store, preview, review)
        def fail(*_args):
            raise OSError("synthetic interrupted projection")
        monkeypatch.setattr(journal, "_project_reviews", fail)
        with pytest.raises(OSError, match="synthetic"):
            _save(store, ready, review, retained)
        new_revision = store.get_job(ready["id"])["result_revision"]
    monkeypatch.setattr(journal, "_project_reviews", projection)
    with BatchStore(database) as store:
        prepare_batch_review(store, ready["id"], new_revision, review)
        actual = read_batch_receipt_review_page(store, ready["id"], new_revision, 0, 200, review)["items"][4]
        assert actual["record"]["review_status"] == "excluded"
        assert actual["original"] == excluded
        _save(store, ready, review, retained)
        assert read_batch_receipt_review_page(store, ready["id"], new_revision, 0, 200, review)["items"][4] == actual
        journal.undo_calibration_operation(store, ready["id"], retained["operation_id"], review, undo_id="undo-recovered-exclusion")
        restored = read_batch_receipt_review_page(store, ready["id"], ready["result_revision"], 0, 200, review)["items"][4]
        assert restored["record"]["review_status"] == "excluded"
        assert restored["original"] == excluded
