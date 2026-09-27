"""Receipt review persistence uses immutable server originals, never UI geometry."""

from copy import deepcopy
import json
import sqlite3

import pytest

from engine.receipt_review_store import read_records, record_table
from engine.review_store import ReviewStoreError
from engine.review_store_v2 import ReviewRevisionConflict, ReviewStoreCorruptionError, ReviewStoreV2
from test_receipt_review_models import _context, _original, _edit


def two_originals():
    return [_original(slot_id="slot-1", position_index=1, item_id="1" * 64),
            _original(slot_id="slot-3", position_index=3, item_id="2" * 64)]


def prepare(store, context=None, originals=None, revision="run-1", owner="job-one"):
    return store.prepare_batch(context or _context(), originals if originals is not None else two_originals(),
                               result_revision=revision, job_id=owner)


def edits(prepared, originals):
    return [{**_edit(prepared["context_key"], item), "result_revision": prepared["result_revision"]}
            for item in originals]


def test_only_attested_batch_path_may_register_receipt_manifest():
    with ReviewStoreV2() as store:
        with pytest.raises(ReviewStoreError, match="server-attested"):
            store.prepare(_context(), two_originals(), result_revision="run-1")
        with pytest.raises(ReviewStoreError, match="server-attested"):
            store.prepare_batch(_context(), two_originals(), result_revision="run-1")
        assert store.connection.execute("SELECT COUNT(*) FROM review_contexts_v2").fetchone()[0] == 0
        result = prepare(store)
        assert result["schema_version"] == 1
        assert result["segments"] == []
        assert result["group_confirmed"] is False
        assert [row["record_revision"] for row in result["record_revisions"]] == [0, 0]
        assert [row["position_index"] for row in result["record_revisions"]] == [1, 3]


@pytest.mark.parametrize("mode", ["search", "split_all"])
def test_save_restore_preserves_receipt_identity_without_fake_match_data(mode):
    originals = two_originals()
    if mode == "split_all":
        for item in originals:
            item["selection_basis"] = "occupied_slot"
    with ReviewStoreV2() as store:
        result = prepare(store, _context(mode=mode), originals)
        pending = edits(result, originals)
        pending[0].update(crop_mode="manual", manual_adjusted=True)
        pending[0]["final_rect"]["y0"] += 4
        saved = store.save(result["context_key"], "run-1", list(reversed(pending)))
        assert saved["saved_count"] == 2
        assert [row["original"]["id"] for row in saved["segments"]] == [item["id"] for item in originals]
        assert saved["segments"][0]["final_rect"]["y0"] == originals[0]["candidate_rect"]["y0"] + 4
        assert all(row["record_revision"] == 1 for row in saved["segments"])
        restored = prepare(store, _context(mode=mode), originals)
        assert restored["segments"] == saved["segments"]
        assert store.connection.execute("SELECT COUNT(*) FROM review_segments_v2").fetchone()[0] == 0
        assert record_table(store.connection, result["context_key"]) == "review_receipt_records_v1"
        forbidden = {"match_rect", "confidence", "matched_text", "segment_no"}
        assert all(not (forbidden & row.keys()) and not (forbidden & row["original"].keys()) for row in saved["segments"])
        restored["segments"][0]["final_rect"]["y0"] += 20
        assert prepare(store, _context(mode=mode), originals)["segments"] == saved["segments"]


def test_split_all_manifest_cannot_register_keyword_selection_basis():
    with ReviewStoreV2() as store:
        with pytest.raises(ReviewStoreError, match="selection basis"):
            prepare(store, _context(mode="split_all"))
        assert store.connection.execute("SELECT COUNT(*) FROM review_contexts_v2").fetchone()[0] == 0


def test_manual_slot_is_only_available_in_explicit_split_all_mode():
    originals = two_originals()
    for item in originals:
        item["selection_basis"] = "manual_slot"
    with ReviewStoreV2() as store:
        with pytest.raises(ReviewStoreError, match="selection basis"):
            prepare(store, originals=originals)
        assert len(prepare(store, _context(mode="split_all"), originals)["record_revisions"]) == 2


@pytest.mark.parametrize("damage", ["revision", "id", "signature", "immutable_field", "geometry"])
def test_last_edit_failure_rolls_back_complete_save(damage):
    originals = two_originals()
    with ReviewStoreV2() as store:
        result = prepare(store)
        pending = edits(result, originals)
        target = pending[-1]
        if damage == "revision":
            target["record_revision"] = 1
        elif damage == "id":
            target["id"] = "3" * 64
        elif damage == "signature":
            target["analysis_signature"] = "4" * 64
        elif damage == "immutable_field":
            target["candidate_rect"] = deepcopy(originals[-1]["candidate_rect"])
        else:
            target["crop_mode"], target["manual_adjusted"] = "manual", True
            target["final_rect"]["y0"] -= 10
        before = tuple(store.connection.execute("SELECT * FROM review_contexts_v2").fetchone())
        with pytest.raises(ReviewStoreError):
            store.save(result["context_key"], "run-1", pending)
        assert store.connection.execute("SELECT COUNT(*) FROM review_receipt_records_v1").fetchone()[0] == 0
        assert tuple(store.connection.execute("SELECT * FROM review_contexts_v2").fetchone()) == before


def test_sqlite_failure_after_first_insert_rolls_back_all_records():
    with ReviewStoreV2() as store:
        result = prepare(store)
        store.connection.execute("""CREATE TRIGGER reject_second_receipt BEFORE INSERT ON review_receipt_records_v1
            WHEN NEW.id = '""" + "2" * 64 + "' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
        with pytest.raises(sqlite3.IntegrityError, match="synthetic failure"):
            store.save(result["context_key"], "run-1", edits(result, two_originals()))
        assert store.connection.execute("SELECT COUNT(*) FROM review_receipt_records_v1").fetchone()[0] == 0


def test_changed_revision_and_same_revision_different_manifest_are_not_silently_overwritten():
    with ReviewStoreV2() as store:
        result = prepare(store)
        pending = edits(result, two_originals())
        with pytest.raises(ReviewStoreError, match="same result_revision"):
            prepare(store, originals=two_originals()[:1], owner="invalid-owner")
        assert store.connection.execute("SELECT COUNT(*) FROM review_context_owners_v2").fetchone()[0] == 1
        newer = prepare(store, revision="run-2")
        with pytest.raises(ReviewRevisionConflict):
            store.save(result["context_key"], "run-1", pending)
        saved = store.save(newer["context_key"], "run-2", edits(newer, two_originals()))
        with pytest.raises(ReviewRevisionConflict):
            store.save(newer["context_key"], "run-2", edits(newer, two_originals()))
        assert prepare(store, revision="run-2")["segments"] == saved["segments"]


def test_new_task_ids_start_without_the_previous_task_review():
    with ReviewStoreV2() as store:
        result = prepare(store)
        store.save(result["context_key"], "run-1", edits(result, two_originals()))
        newer_originals = two_originals()
        for index, item in enumerate(newer_originals):
            item["id"] = str(index + 7) * 64
        newer = prepare(store, originals=newer_originals, revision="run-2", owner="job-two")
        assert newer["segments"] == []
        assert [row["record_revision"] for row in newer["record_revisions"]] == [0, 0]
        obsolete = edits(newer, two_originals())
        for edit in obsolete:
            edit["record_revision"] = 1
        with pytest.raises(ReviewRevisionConflict):
            store.save(newer["context_key"], "run-2", obsolete)


def test_changed_immutable_geometry_does_not_restore_old_crop():
    with ReviewStoreV2() as store:
        result = prepare(store)
        store.save(result["context_key"], "run-1", edits(result, two_originals()))
        changed = two_originals()
        changed[0]["candidate_rect"]["y0"] += 6
        changed[0]["analysis_signature"] = "5" * 64
        newer = prepare(store, originals=changed, revision="run-2")
        assert [row["original"]["id"] for row in newer["segments"]] == [changed[1]["id"]]
        assert [row["record_revision"] for row in newer["record_revisions"]] == [1, 1]
        pending = edits(newer, changed[:1])
        pending[0]["record_revision"] = 1
        saved = store.save(newer["context_key"], "run-2", pending)
        assert saved["segments"][0]["record_revision"] == 2
        assert saved["segments"][0]["original"] == changed[0]


def test_same_signature_cannot_cover_changed_immutable_geometry():
    with ReviewStoreV2() as store:
        result = prepare(store)
        store.save(result["context_key"], "run-1", edits(result, two_originals()))
        changed = two_originals()
        changed[0]["candidate_rect"]["y0"] += 6
        with pytest.raises(ReviewStoreCorruptionError, match="signature conflicts"):
            prepare(store, originals=changed, revision="run-2", owner="new-owner")
        assert prepare(store)["result_revision"] == "run-1"
        assert store.connection.execute("SELECT COUNT(*) FROM review_context_owners_v2").fetchone()[0] == 1


def test_same_task_relocation_rebinds_scoped_records_after_old_binding_is_verified():
    with ReviewStoreV2() as store:
        result = prepare(store)
        original_saved = store.save(result["context_key"], "run-1", edits(result, two_originals()))
        context = _context(source_path="/relocated/new.pdf")
        partial = prepare(store, context, two_originals()[:1], revision="run-2")
        assert len(partial["segments"]) == 1
        stored = read_records(store.connection, result["context_key"], context)
        # The old scoped rows remain auditable while the relocated task gets
        # a new scoped row for its published revision.
        assert len(stored) == 3
        assert all(row["source_path"] == "/relocated/new.pdf" for row in stored.values())
        complete = prepare(store, context, two_originals(), revision="run-3")
        assert len(complete["segments"]) == 2
        assert [row["record_revision"] for row in complete["segments"]] == [1, 1]
        assert [row["final_rect"] for row in complete["segments"]] == [row["final_rect"] for row in original_saved["segments"]]


@pytest.mark.parametrize("damage", ["json_revision", "source_path", "sql_signature", "candidate_rect", "manifest_digest", "descriptor"])
def test_corrupt_historical_rows_fail_before_relocation_or_registration(damage):
    with ReviewStoreV2() as store:
        result = prepare(store)
        saved = store.save(result["context_key"], "run-1", edits(result, two_originals()))
        if damage == "manifest_digest":
            store.connection.execute("UPDATE review_contexts_v2 SET manifest_digest=?", ("0" * 64,))
        elif damage == "descriptor":
            store.connection.execute("UPDATE review_contexts_v2 SET descriptor_json='{}'")
        elif damage == "sql_signature":
            store.connection.execute("UPDATE review_receipt_records_v1 SET analysis_signature=?", ("0" * 64,))
        else:
            record = deepcopy(saved["segments"][-1])
            if damage == "json_revision":
                record["record_revision"] = 0
            elif damage == "source_path":
                record["source_path"] = "/unrelated/path.pdf"
            else:
                record["original"]["candidate_rect"]["y0"] += 2
            store.connection.execute("UPDATE review_receipt_records_v1 SET record_json=? WHERE id=?",
                                     (json.dumps(record, sort_keys=True, separators=(",", ":")), record["original"]["id"]))
        before = tuple(store.connection.execute("SELECT * FROM review_contexts_v2").fetchone())
        with pytest.raises(ReviewStoreCorruptionError):
            prepare(store, _context(source_path="/relocated/new.pdf"), two_originals()[:1], "run-2", owner="new-owner")
        assert tuple(store.connection.execute("SELECT * FROM review_contexts_v2").fetchone()) == before
        assert store.connection.execute("SELECT COUNT(*) FROM review_context_owners_v2").fetchone()[0] == 1


def test_empty_manifest_and_legacy_group_confirmation_have_explicit_behavior():
    with ReviewStoreV2() as store:
        result = prepare(store, originals=[])
        assert result["segments"] == [] and result["record_revisions"] == []
        assert store.save(result["context_key"], "run-1", [])["saved_count"] == 0
        with pytest.raises(ReviewStoreError, match="preview scope"):
            store.save(result["context_key"], "run-1", [], confirm_group=True)


def test_duplicate_edit_identity_is_rejected_before_any_write():
    with ReviewStoreV2() as store:
        result = prepare(store)
        first = edits(result, two_originals())[0]
        with pytest.raises(ReviewStoreError, match="unique"):
            store.save(result["context_key"], "run-1", [first, deepcopy(first)])
        assert prepare(store)["segments"] == []
