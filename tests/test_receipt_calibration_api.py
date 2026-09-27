"""Public calibration requests carry no caller-supplied affected receipts."""
from copy import deepcopy

from engine.batch_store import BatchStore
from engine.layout_template_store import LayoutTemplateStore
from tests.test_batch_receipt_review_api import request
from tests.test_receipt_layout_review import _ready, _pdf, _prepared, private_temp


def test_prepare_preview_save_status_round_trip_and_injected_targets_rejected(tmp_path):
    database, review = tmp_path / "tasks.sqlite3", tmp_path / "review.sqlite3"
    with BatchStore(database) as store:
        ready = _ready(store, [_pdf(tmp_path, "source")])
        internal = _prepared(store, ready, review)
    common = {"job_id": ready["id"], "result_revision": ready["result_revision"],
              "sample_id": internal.sample["id"], "review_database_path": str(review)}
    prepared = request(database, "batch_receipt_calibration_prepare", **common)
    assert prepared["status"] == "ok", prepared
    preparation = prepared["data"]
    assert preparation["selected_slot_id"] == "slot-1"
    draft = deepcopy(preparation["layout_definition"])
    draft["revision"] += 1
    draft["slots"][0]["top_pt"] = 0
    args = {**common, "preparation_fingerprint": preparation["preparation_fingerprint"],
            "layout_definition": draft, "include_exception_ids": []}
    assert request(database, "batch_receipt_calibration_preview", **args, targets=[])["code"] == "batch_invalid_request"
    stale = {**args, "preparation_fingerprint": "0" * 64}
    assert request(database, "batch_receipt_calibration_preview", **stale)["code"] == "batch_conflict"
    response = request(database, "batch_receipt_calibration_preview", **args)
    assert response["status"] == "ok", response
    preview = response["data"]
    assert len(preview["affected"]) == 2  # first position on full page and tail
    save_args = {"job_id": ready["id"], "operation_id": preview["operation_id"],
                 "preview_fingerprint": preview["preview_fingerprint"], "review_database_path": str(review),
                 "template_database_path": str(tmp_path / "pdf-search.sqlite3"),
                 "remember_reference": True, "template_name": "工资回单",
                 "template_save_mode": "create", "template_id": None, "template_bank_name": "上海银行",
                 "acknowledged_risk_ids": [item["risk_id"] for item in preview["risks"]]}
    assert request(database, "batch_receipt_calibration_save", **save_args, records=[])["code"] == "batch_invalid_request"
    saved = request(database, "batch_receipt_calibration_save", **save_args)
    assert saved["status"] == "ok", saved
    assert saved["data"]["saved_count"] == 2
    status = request(database, "batch_receipt_calibration_status", job_id=ready["id"], operation_id=preview["operation_id"])
    assert status["data"]["state"] == "applied"
    assert status["data"]["result_revision"] == saved["data"]["result_revision"]
    assert request(database, "batch_receipt_calibration_save", **save_args) == saved
    templates = LayoutTemplateStore(tmp_path / "pdf-search.sqlite3").list()
    assert len(templates) == 1 and templates[0]["name"] == "工资回单"
    assert saved["data"]["reference_state"] == "saved"
    assert saved["data"]["template_id"] == templates[0]["id"]
    assert templates[0]["bank_name"] == "上海银行"
    undone = request(
        database,
        "batch_receipt_calibration_undo",
        job_id=ready["id"],
        operation_id=preview["operation_id"],
        undo_id="undo-api-1",
        review_database_path=str(review),
    )
    assert undone["status"] == "ok", undone
    assert undone["data"]["state"] == "undone"
    assert request(
        database,
        "batch_receipt_calibration_undo",
        job_id=ready["id"],
        operation_id=preview["operation_id"],
        undo_id="undo-api-1",
        review_database_path=str(review),
    ) == undone
