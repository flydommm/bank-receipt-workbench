"""Independent template choices across the durable analysis/review boundary."""
from copy import deepcopy

import pytest

from engine.batch_api import _dispatch
from engine.batch_store import BatchConflict, BatchStore
from engine.computation import current_computation_version
from engine.layout_template_store import LayoutTemplateStore
from engine.receipt_layout_history import selected_reference
from engine.receipt_layout_reference import save_reference_layout
from tests.test_receipt_calibration_journal import _preview, _save
from tests.test_receipt_layout_history import remembered
from tests.test_receipt_layout_review import _ready, _pdf, private_temp
from tests.test_receipt_layout_reuse import execute
from tests.test_receipt_batch_pdf import ALL


def test_ambiguous_templates_reach_review_and_explicit_choice_uses_only_selected_geometry(tmp_path):
    templates = tmp_path / "pdf-search.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        _, preview, _ = remembered(store, tmp_path, _pdf(tmp_path, "company-a", counts=(3, 3)))
        first = LayoutTemplateStore(templates).list()[0]
        alternate = deepcopy(preview.draft)
        for slot in alternate["slots"]:
            slot["height_pt"] -= 4
        second = save_reference_layout(alternate, templates, "different-margins", name="紧凑版")
        assert first["series_id"] != second["series_id"]
        other_company = _pdf(tmp_path, "company-b", counts=(3, 3))
        ready = _ready(store, [other_company], ALL)
        rows = store.read_page_results(ready["id"])
        for row in rows:
            payload = row["payload"]
            assert payload["suggestion"]["basis"] != "historical_reference"
            assert payload["suggestion"]["needs_review"] is True
            warning = next(item for item in payload["diagnostics"] if item["code"] == "historical_template_ambiguous")
            assert set(warning["template_ids"]) == {first["id"], second["id"]}
        prepared = _dispatch(store, "batch_prepare_review", {"job_id": ready["id"],
            "result_revision": ready["result_revision"], "review_database_path": str(tmp_path / "review.sqlite3")})
        assert set(prepared["template_choice_ids"]) == {first["id"], second["id"]}
        job = store.create_receipt_job("selected", [{"source_path": str(other_company), "name": other_company.name}],
            ALL, "exact", current_computation_version(), historical_reference=selected_reference(store, templates, first["id"]))
        selected = execute(store, job)
        for row in store.read_page_results(selected["id"]):
            assert row["payload"]["receipt_page"]["layout_definition"]["slots"] == preview.draft["slots"]
            assert row["payload"]["suggestion"]["basis"] == "historical_reference"
            assert not any(item["code"] == "historical_template_ambiguous" for item in row["payload"]["diagnostics"])


def test_journal_updates_only_explicit_series_and_binds_retries_to_original_intent(tmp_path):
    templates = tmp_path / "templates.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, preview, retained = _preview(store, tmp_path)
        first = save_reference_layout(preview.draft, templates, "existing-one", name="常用版", bank_name="上海银行")
        sibling = save_reference_layout(preview.draft, templates, "existing-two", name="打印版", bank_name="上海银行")
        args = {"template_save_mode": "update", "template_id": first["id"], "template_name": "已核对常用版"}
        saved = _save(store, ready, review, retained, templates, **args)
        assert saved["reference_state"] == "saved"
        assert saved["template_version"] == 2 and saved["template_name"] == "已核对常用版"
        assert _save(store, ready, review, retained, templates, **args) == saved
        with pytest.raises(BatchConflict, match="destination"):
            _save(store, ready, review, retained, templates, **{**args, "template_id": sibling["id"]})
        with pytest.raises(BatchConflict, match="destination"):
            _save(store, ready, review, retained, templates)
        rows = {item["id"]: item for item in LayoutTemplateStore(templates).list()}
        assert rows[sibling["id"]] == sibling
        assert rows[saved["template_id"]]["series_id"] == first["series_id"]


def test_deactivated_target_is_rejected_before_review_round_is_published(tmp_path):
    templates = tmp_path / "templates.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, preview, retained = _preview(store, tmp_path)
        first = save_reference_layout(preview.draft, templates, "existing")
        LayoutTemplateStore(templates).deactivate(first["id"])
        with pytest.raises(ValueError):
            _save(store, ready, review, retained, templates, template_save_mode="update", template_id=first["id"])
        assert store.get_job(ready["id"])["result_revision"] == ready["result_revision"]


def test_auxiliary_retry_checks_frozen_target_operations_again(tmp_path, monkeypatch):
    from engine import receipt_layout_reference, receipt_layout_history
    templates = tmp_path / "templates.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, preview, retained = _preview(store, tmp_path)
        first = save_reference_layout(preview.draft, templates, "old-operation")
        args = {"template_save_mode": "update", "template_id": first["id"]}
        def interrupted(*_args, **_kwargs):
            raise OSError("synthetic auxiliary storage failure")
        with monkeypatch.context() as context:
            context.setattr(receipt_layout_reference, "save_reference", interrupted)
            failed = _save(store, ready, review, retained, templates, **args)
        assert failed["state"] == "applied" and failed["reference_state"] == "failed"
        # Simulate the authoritative task undo outliving failed auxiliary sync.
        monkeypatch.setattr(receipt_layout_history, "_undone_operations", lambda _store: {"old-operation"})
        retried = _save(store, ready, review, retained, templates, **args)
        assert retried["reference_state"] == "failed"
        assert retried["reference_error_code"] == "operation_inactive"
        assert LayoutTemplateStore(templates).list() == [first]
