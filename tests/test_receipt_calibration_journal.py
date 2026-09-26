"""Crash/retry and atomic publication of whole-layout receipt decisions."""
import json
import pytest

from engine.batch_store import BatchConflict, BatchStore, BatchStoreError
from engine.batch_review import prepare_batch_review, read_batch_receipt_review_page, save_batch_receipt_review
from engine.receipt_layout_review import preview_receipt_calibration
from engine.receipt_calibration_journal import (
    retain_calibration_preview, save_calibration_preview, cancel_calibration_preview, undo_calibration_operation,
)
from engine import receipt_calibration_journal as journal
from tests.test_receipt_layout_review import _ready, _pdf, _prepared, _draft, private_temp
from tests.test_batch_receipt_review_api import _make_edit
from tests.test_receipt_batch_pdf import SEARCH, ALL


def _preview(store, tmp_path, options=SEARCH):
    review = tmp_path / "review.sqlite3"
    ready = _ready(store, [_pdf(tmp_path, "first"), _pdf(tmp_path, "second")], options)
    prepared = _prepared(store, ready, review)
    preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
    retained = retain_calibration_preview(store, preview, review)
    return ready, review, preview, retained


def _save(store, ready, review, retained, template_database=None, remember_reference=True, **kwargs):
    return save_calibration_preview(store, ready["id"], retained["operation_id"], retained["preview_fingerprint"], review,
                                    acknowledged_risk_ids=[item["risk_id"] for item in retained["risks"]],
                                    template_database=template_database, remember_reference=remember_reference, **kwargs)


def test_acknowledging_round_risks_does_not_confirm_unchanged_template_slots(tmp_path):
    from copy import deepcopy
    from engine.layout_template_store import LayoutTemplateStore

    review, templates = tmp_path / "review.sqlite3", tmp_path / "templates.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "partial", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        draft = deepcopy(prepared.layout)
        draft["revision"] += 1
        draft["uniform_height"] = False
        draft["slots"][0]["height_pt"] -= 3
        preview = preview_receipt_calibration(store, prepared, draft, review)
        assert {item["slot_id"] for item in preview.affected} == {"slot-1"}
        retained = retain_calibration_preview(store, preview, review)
        saved = _save(store, ready, review, retained, templates)
        assert saved["reference_state"] == "saved"
        template = LayoutTemplateStore(templates).list()[0]
        assert template["evidence_summary"]["confirmed_slot_ids"] == ["slot-1"]
        assert template["evidence_summary"]["confirmed_slot_sources"] == {"slot-1": retained["operation_id"]}
        # Unchanged candidates may already pass this task's automatic checks;
        # that is not evidence that their boundaries were saved as a template.
        assert template["evidence_summary"]["layout_definition"]["slots"][1:] == prepared.layout["slots"][1:]
        listed = LayoutTemplateStore(templates).list_page()["items"]
        assert len(listed) == 1
        assert listed[0]["evidence_summary"]["confirmed_slot_ids"] == ["slot-1"]


@pytest.mark.parametrize("options", [SEARCH, ALL], ids=["search", "split_all"])
def test_entire_preview_publishes_and_confirms_exact_set_with_idempotent_replay(tmp_path, options):
    database = tmp_path / "tasks.sqlite3"
    with BatchStore(database) as store:
        ready, review, preview, retained = _preview(store, tmp_path, options)
        saved = _save(store, ready, review, retained)
        assert saved["state"] == "applied" and saved["saved_count"] == 8
        assert saved["result_revision"] != ready["result_revision"]
        page = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 200, review)
        assert len(page["items"]) == 8
        expected = {item["id"]: item["after_rect"] for item in preview.affected}
        for item in page["items"]:
            assert item["record"]["final_rect"] == expected[item["original"]["id"]]
            assert item["record"]["review_status"] == "confirmed"
        assert _save(store, ready, review, retained) == saved
        assert read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 200, review) == page
        with pytest.raises(BatchConflict):
            store.review_snapshot(ready["id"], ready["result_revision"])
    with BatchStore(database) as reopened:
        assert _save(reopened, ready, review, retained) == saved
        assert read_batch_receipt_review_page(reopened, ready["id"], saved["result_revision"], 0, 200, review) == page


def test_authoritative_transaction_rolls_back_after_mid_publish_failure(tmp_path, monkeypatch):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, preview, retained = _preview(store, tmp_path)
        original_publish = journal._publish
        def fail(*args):
            original_publish(*args)
            raise OSError("synthetic write interruption")
        monkeypatch.setattr(journal, "_publish", fail)
        before = store.read_page_results(ready["id"])
        with pytest.raises(OSError):
            _save(store, ready, review, retained)
        assert store.get_job(ready["id"])["result_revision"] == ready["result_revision"]
        assert store.read_page_results(ready["id"]) == before
        page = read_batch_receipt_review_page(store, ready["id"], ready["result_revision"], 0, 200, review)
        assert all(item["record"] is None for item in page["items"])
        monkeypatch.setattr(journal, "_publish", original_publish)
        assert _save(store, ready, review, retained)["state"] == "applied"


def test_crash_before_projection_recovers_on_reopen_without_partial_confirmation(tmp_path, monkeypatch):
    database = tmp_path / "tasks.sqlite3"
    project = journal._project_reviews
    with BatchStore(database) as store:
        ready, review, preview, retained = _preview(store, tmp_path)
        def interrupted(*_args):
            raise OSError("synthetic review database unavailable")
        monkeypatch.setattr(journal, "_project_reviews", interrupted)
        with pytest.raises(OSError):
            _save(store, ready, review, retained)
        new_revision = store.get_job(ready["id"])["result_revision"]
        assert new_revision != ready["result_revision"]
        with pytest.raises(Exception, match="revision"):
            read_batch_receipt_review_page(store, ready["id"], new_revision, 0, 200, review)
    monkeypatch.setattr(journal, "_project_reviews", project)
    with BatchStore(database) as reopened:
        prepare_batch_review(reopened, ready["id"], new_revision, review)
        restored = read_batch_receipt_review_page(reopened, ready["id"], new_revision, 0, 200, review)
        assert len(restored["items"]) == 8
        assert all(item["record"]["review_status"] == "confirmed" for item in restored["items"])
        assert _save(reopened, ready, review, retained)["state"] == "applied"


def test_cancel_and_corrupt_preview_never_change_durable_receipts(tmp_path):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, preview, retained = _preview(store, tmp_path)
        with store._transaction() as connection:
            connection.execute("UPDATE batch_receipt_calibration_pages SET after_json='{}' WHERE operation_id=? AND position=0",
                               (retained["operation_id"],))
        with pytest.raises(BatchStoreError, match="journal pages"):
            _save(store, ready, review, retained)
        assert store.get_job(ready["id"])["result_revision"] == ready["result_revision"]
        cancel_calibration_preview(store, ready["id"], retained["operation_id"])
        with pytest.raises(BatchConflict, match="cancelled"):
            _save(store, ready, review, retained)


def test_review_projection_is_all_or_nothing_and_retry_does_not_double_save(tmp_path, monkeypatch):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, preview, retained = _preview(store, tmp_path)
        upsert = journal._upsert
        calls = 0
        def interrupted(connection, record, **kwargs):
            nonlocal calls
            calls += 1
            upsert(connection, record, **kwargs)
            if calls == 3:
                raise OSError("synthetic failure during review projection")
        monkeypatch.setattr(journal, "_upsert", interrupted)
        with pytest.raises(OSError):
            _save(store, ready, review, retained)
        from engine.receipt_review_read import read_receipt_review_snapshot
        before = read_receipt_review_snapshot(review, preview.preparation.context_key, ready["result_revision"])
        assert before["segments"] == []
        monkeypatch.setattr(journal, "_upsert", upsert)
        saved = _save(store, ready, review, retained)
        after = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 200, review)
        assert len(after["items"]) == 8
        assert all(item["record_revision"] == 1 for item in after["items"])


def test_crash_after_projection_commit_replays_without_incrementing_revisions(tmp_path, monkeypatch):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, preview, retained = _preview(store, tmp_path)
        digest = journal._review_digest
        def interrupted(restored):
            if restored["result_revision"] != ready["result_revision"]:
                raise OSError("synthetic crash before marking projection applied")
            return digest(restored)
        monkeypatch.setattr(journal, "_review_digest", interrupted)
        with pytest.raises(OSError):
            _save(store, ready, review, retained)
        new_revision = store.get_job(ready["id"])["result_revision"]
        before = read_batch_receipt_review_page(store, ready["id"], new_revision, 0, 200, review)
        monkeypatch.setattr(journal, "_review_digest", digest)
        assert _save(store, ready, review, retained)["state"] == "applied"
        assert read_batch_receipt_review_page(store, ready["id"], new_revision, 0, 200, review) == before


def test_undo_restores_pages_and_review_projection_idempotently(tmp_path):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, _preview_value, retained = _preview(store, tmp_path)
        before_pages = store.read_page_results(ready["id"])
        saved = _save(store, ready, review, retained)
        assert store.get_job(ready["id"])["result_revision"] == saved["result_revision"]
        undone = undo_calibration_operation(store, ready["id"], retained["operation_id"], review, undo_id="undo-1")
        assert undone["state"] == "undone" and undone["restored_count"] == 0
        assert store.get_job(ready["id"])["result_revision"] == ready["result_revision"]
        assert store.read_page_results(ready["id"]) == before_pages
        restored = read_batch_receipt_review_page(store, ready["id"], ready["result_revision"], 0, 200, review)
        assert all(item["record"] is None for item in restored["items"])
        assert undo_calibration_operation(store, ready["id"], retained["operation_id"], review, undo_id="undo-1")["state"] == "undone"


def test_undo_rejects_non_last_round_and_only_reverts_latest_round(tmp_path):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, _preview_value, first = _preview(store, tmp_path)
        first_saved = _save(store, ready, review, first)
        prepare_batch_review(store, ready["id"], first_saved["result_revision"], review)
        snapshot = store.review_snapshot(ready["id"], first_saved["result_revision"])
        prepared = journal.prepare_receipt_calibration(
            store, ready["id"], first_saved["result_revision"], snapshot["originals"][0]["id"], review
        )
        second_preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
        second = retain_calibration_preview(store, second_preview, review)
        second_saved = _save(store, ready, review, second)
        with pytest.raises(BatchConflict, match="latest operation"):
            undo_calibration_operation(store, ready["id"], first["operation_id"], review, undo_id="undo-first")
        assert store.get_job(ready["id"])["result_revision"] == second_saved["result_revision"]
        undone = undo_calibration_operation(store, ready["id"], second["operation_id"], review, undo_id="undo-second")
        assert undone["state"] == "undone"
        assert undone["result_revision"] == first_saved["result_revision"]
        restored = read_batch_receipt_review_page(store, ready["id"], first_saved["result_revision"], 0, 200, review)
        assert all(item["record"] is not None for item in restored["items"])
        assert all(item["record"]["record_revision"] == 2 for item in restored["items"])


def test_undo_projection_conflict_is_rejected_before_authority_mutation(tmp_path):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, preview_value, retained = _preview(store, tmp_path)
        saved = _save(store, ready, review, retained)
        page = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 1, review)
        item = page["items"][0]
        edit = _make_edit(preview_value.preparation.context_key, saved["result_revision"], item["original"], 1)
        edit["reviewed_at"] = "2026-09-15T10:20:30.000Z"
        save_batch_receipt_review(store, ready["id"], saved["result_revision"], [edit], review)
        with pytest.raises(BatchConflict, match="projection"):
            undo_calibration_operation(store, ready["id"], retained["operation_id"], review, undo_id="undo-conflict")
        assert store.get_job(ready["id"])["result_revision"] == saved["result_revision"]
        assert store.connection.execute(
            "SELECT COUNT(*) FROM batch_receipt_calibration_undos WHERE operation_id=?",
            (retained["operation_id"],),
        ).fetchone()[0] == 0


def test_undo_crash_after_authority_commit_recovers_on_retry(tmp_path, monkeypatch):
    database = tmp_path / "tasks.sqlite3"
    with BatchStore(database) as store:
        ready, review, _preview_value, retained = _preview(store, tmp_path)
        _save(store, ready, review, retained)
        project = journal._project_calibration_undo

        def interrupted(*_args):
            raise OSError("synthetic undo projection interruption")

        monkeypatch.setattr(journal, "_project_calibration_undo", interrupted)
        with pytest.raises(OSError):
            undo_calibration_operation(store, ready["id"], retained["operation_id"], review, undo_id="undo-retry")
        assert store.get_job(ready["id"])["result_revision"] == ready["result_revision"]
        assert store.connection.execute(
            "SELECT state FROM batch_receipt_calibration_undos WHERE operation_id=?",
            (retained["operation_id"],),
        ).fetchone()[0] == "committed"
        monkeypatch.setattr(journal, "_project_calibration_undo", project)
        assert undo_calibration_operation(
            store, ready["id"], retained["operation_id"], review, undo_id="undo-retry"
        )["state"] == "undone"


def test_undo_withdraws_historical_layout_reference(tmp_path):
    from engine.layout_template_store import LayoutTemplateStore
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, _preview_value, retained = _preview(store, tmp_path)
        template_database = tmp_path / "templates.sqlite3"
        _save(store, ready, review, retained, template_database)
        templates = LayoutTemplateStore(template_database).list(active_only=False)
        assert len(templates) == 1 and templates[0]["active"] is True
        result = undo_calibration_operation(store, ready["id"], retained["operation_id"], review,
                                             undo_id="undo-template", template_database=template_database)
        assert result["state"] == "undone"
        assert result["template_withdrawal"]["deactivated_count"] == 1
        assert LayoutTemplateStore(template_database).list() == []


def test_save_can_opt_out_of_historical_layout_reference(tmp_path):
    from engine.layout_template_store import LayoutTemplateStore
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, _preview_value, retained = _preview(store, tmp_path)
        template_database = tmp_path / "templates.sqlite3"
        saved = _save(store, ready, review, retained, template_database, remember_reference=False)
        assert saved["state"] == "applied"
        assert LayoutTemplateStore(template_database).list(active_only=False) == []


def test_failed_reference_memory_reports_and_retries_without_republishing_review(tmp_path, monkeypatch):
    from engine.layout_template_store import LayoutTemplateStore
    from engine import receipt_layout_reference as reference
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, _preview_value, retained = _preview(store, tmp_path)
        template_database = tmp_path / "templates.sqlite3"
        original = reference.save_reference
        monkeypatch.setattr(reference, "save_reference", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("template unavailable")))
        failed = _save(store, ready, review, retained, template_database)
        assert failed["state"] == "applied" and failed["reference_state"] == "failed"
        assert failed["reference_error_code"] == "storage_unavailable"
        monkeypatch.setattr(reference, "save_reference", original)
        retried = _save(store, ready, review, retained, template_database)
        assert retried["state"] == "applied" and retried["reference_state"] == "saved"
        assert retried["result_revision"] == failed["result_revision"]
        assert retried["saved_count"] == failed["saved_count"]
        assert len(LayoutTemplateStore(template_database).list()) == 1


def test_missing_reference_identity_is_rejected_before_review_commit(tmp_path):
    from engine.layout_template_store import LayoutTemplateStore
    from engine.layout_template_store import LayoutTemplateError

    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, _preview_value, retained = _preview(store, tmp_path)
        template_database = tmp_path / "templates.sqlite3"
        row = store.connection.execute(
            "SELECT header_json FROM batch_receipt_calibrations WHERE operation_id=?", (retained["operation_id"],)
        ).fetchone()
        header = json.loads(row[0])
        header["layout_definition"].update(issuer_id=None, family_id=None)
        encoded = journal.canonical_json(header, max_bytes=journal.MAX_PAGE_RESULT_BYTES)
        with store._transaction() as connection:
            connection.execute("UPDATE batch_receipt_calibrations SET header_json=?, header_digest=? WHERE operation_id=?",
                               (encoded.decode(), journal.sha256(encoded).hexdigest(), retained["operation_id"]))
        before_revision = store.get_job(ready["id"])["result_revision"]
        before_pages = store.read_page_results(ready["id"])
        with pytest.raises(LayoutTemplateError) as exc_info:
            _save(store, ready, review, retained, template_database)
        assert exc_info.value.code == "identity_unavailable"
        assert store.get_job(ready["id"])["result_revision"] == before_revision
        assert store.read_page_results(ready["id"]) == before_pages
        assert store.connection.execute("SELECT state FROM batch_receipt_calibrations WHERE operation_id=?",
                                        (retained["operation_id"],)).fetchone()[0] == "preview"
        assert not template_database.exists()

        # The same identity-less round remains usable for the ordinary
        # current-PDF review path when the user explicitly opts out of a
        # reusable template.
        saved = _save(store, ready, review, retained, template_database, remember_reference=False)
        assert saved["state"] == "applied" and saved["reference_state"] == "disabled"
        assert LayoutTemplateStore(template_database).list(active_only=False) == []


@pytest.mark.parametrize("code", ["shared_geometry_changed", "template_geometry_conflict", "operation_inactive"])
def test_template_constraint_failure_has_safe_actionable_code_after_review_save(tmp_path, monkeypatch, code):
    from engine.layout_template_store import LayoutTemplateError
    from engine import receipt_layout_reference as reference

    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, _preview_value, retained = _preview(store, tmp_path)
        error = LayoutTemplateError("private internal detail", code=code)
        monkeypatch.setattr(reference, "save_reference", lambda *_args, **_kwargs: (_ for _ in ()).throw(error))
        failed = _save(store, ready, review, retained, tmp_path / "templates.sqlite3")
        assert failed["state"] == "applied"
        assert failed["reference_state"] == "failed"
        assert failed["reference_error_code"] == code
        assert "private internal detail" not in json.dumps(failed)
        assert store.get_job(ready["id"])["result_revision"] == failed["result_revision"]


def test_invalid_template_storage_does_not_offer_transient_failure_retry(tmp_path, monkeypatch):
    import sqlite3
    from engine import receipt_layout_reference as reference

    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, _preview_value, retained = _preview(store, tmp_path)
        error = sqlite3.IntegrityError("private constraint detail")
        monkeypatch.setattr(reference, "save_reference", lambda *_args, **_kwargs: (_ for _ in ()).throw(error))
        failed = _save(store, ready, review, retained, tmp_path / "templates.sqlite3")
        assert failed["state"] == "applied"
        assert failed["reference_error_code"] == "invalid_reference"
        assert "private constraint detail" not in json.dumps(failed)


def test_template_version_update_does_not_rewrite_saved_task_snapshot(tmp_path):
    from engine.layout_template_store import LayoutTemplateStore
    from engine.receipt_layout_reference import save_reference_layout

    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, _preview_value, retained = _preview(store, tmp_path)
        template_database = tmp_path / "templates.sqlite3"
        _save(store, ready, review, retained, template_database)
        row = store.connection.execute(
            "SELECT header_json FROM batch_receipt_calibrations WHERE operation_id=?",
            (retained["operation_id"],),
        ).fetchone()
        assert row is not None
        task_snapshot = json.loads(row[0])
        layout_definition = task_snapshot["layout_definition"]
        confirmed = [slot["slot_id"] for slot in layout_definition["slots"]]

        replacement = save_reference_layout(
            layout_definition,
            template_database,
            "replacement-operation",
            confirmed_slot_ids=confirmed,
            save_mode="update", template_id=LayoutTemplateStore(template_database).list()[0]["id"],
        )
        assert replacement["version"] == 2
        original = LayoutTemplateStore(template_database).list(active_only=False)[-1]
        assert original["source_operation_id"] == retained["operation_id"]
        assert LayoutTemplateStore(template_database).deactivate(original["id"])

        restored = json.loads(store.connection.execute(
            "SELECT header_json FROM batch_receipt_calibrations WHERE operation_id=?",
            (retained["operation_id"],),
        ).fetchone()[0])
        assert restored["layout_definition"] == layout_definition
        assert restored["operation_id"] == retained["operation_id"]


def test_template_update_and_deactivation_do_not_rewrite_an_existing_task_snapshot(tmp_path):
    from copy import deepcopy
    from engine.layout_template_store import LayoutTemplateStore

    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, _preview_value, retained = _preview(store, tmp_path)
        template_database = tmp_path / "templates.sqlite3"
        saved = _save(store, ready, review, retained, template_database)
        template_store = LayoutTemplateStore(template_database)
        first = template_store.list(active_only=False)[0]
        before_snapshot = deepcopy(store.review_snapshot(ready["id"], saved["result_revision"]))

        second = template_store.save({
            "name": first["name"],
            "source_scope": first["source_scope"],
            "layout_fingerprint": first["layout_fingerprint"],
            "page_geometry": first["page_geometry"],
            "slots": first["slots"],
            "evidence_summary": {"slot_count": len(first["slots"]), "revision_note": "updated"},
            "source_operation_id": "operation-update",
            "save_mode": "update", "update_template_id": first["id"],
        })
        assert second["version"] == first["version"] + 1
        assert template_store.deactivate(second["id"])

        assert store.review_snapshot(ready["id"], saved["result_revision"]) == before_snapshot


def test_committed_retry_recovers_before_registering_named_template(tmp_path, monkeypatch):
    from engine.layout_template_store import LayoutTemplateStore
    from engine.receipt_layout_reference import historical_reference
    database, templates = tmp_path / "tasks.sqlite3", tmp_path / "pdf-search.sqlite3"
    project = journal._project_reviews
    with BatchStore(database) as store:
        ready, review, preview, retained = _preview(store, tmp_path)
        def interrupted(*_args):
            raise OSError("synthetic projection interruption")
        monkeypatch.setattr(journal, "_project_reviews", interrupted)
        with pytest.raises(OSError, match="projection interruption"):
            _save(store, ready, review, retained, templates, template_name="恢复后的模板")
        assert store.connection.execute("SELECT state FROM batch_receipt_calibrations WHERE operation_id=?",
            (retained["operation_id"],)).fetchone()[0] == "committed"
        assert not templates.exists()
    monkeypatch.setattr(journal, "_project_reviews", project)
    with BatchStore(database) as reopened:
        recovered = save_calibration_preview(reopened, ready["id"], retained["operation_id"], retained["preview_fingerprint"], review,
            acknowledged_risk_ids=[risk["risk_id"] for risk in retained["risks"]],
            template_database=templates, remember_reference=True, template_name="恢复后的模板")
        assert recovered["state"] == "applied" and recovered["reference_state"] == "saved"
        references = LayoutTemplateStore(templates).list_page()["items"]
        assert len(references) == 1 and references[0]["name"] == "恢复后的模板"
        assert references[0]["source_operation_id"] == retained["operation_id"]
        assert historical_reference(references[0]) is not None
        retried = _save(reopened, ready, review, retained, templates, template_name="恢复后的模板")
        assert retried["result_revision"] == recovered["result_revision"]
        assert len(LayoutTemplateStore(templates).list()) == 1
