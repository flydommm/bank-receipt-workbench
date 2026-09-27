"""Historical geometry is applied during analysis, with immutable task pins."""
from copy import deepcopy
from dataclasses import replace
import json

import pytest

from engine.batch_api import _dispatch
from engine.batch_review import read_batch_receipt_review_page
from engine.batch_store import BatchStore, BatchStoreError
from engine.computation import current_computation_version
from engine.layout_template_store import LayoutTemplateStore
from engine.receipt_calibration_journal import retain_calibration_preview, save_calibration_preview, undo_calibration_operation
from engine.receipt_layout import suggest_layout
from engine.receipt_layout_history import pin_historical_receipt_layouts
from engine.receipt_layout_reference import apply_historical_reference, historical_reference, save_reference_layout
from engine.receipt_layout_review import preview_receipt_calibration
from tests.test_receipt_layout import evidence
from tests.test_receipt_layout_review import _ready, _pdf, _prepared, _draft, private_temp
from tests.test_receipt_layout_reuse import execute
from tests.test_receipt_batch_pdf import ALL


def remembered(store, tmp_path, path):
    ready = _ready(store, [path], ALL)
    review = tmp_path / "review.sqlite3"
    prepared = _prepared(store, ready, review)
    draft = _draft(prepared)
    preview = preview_receipt_calibration(store, prepared, draft, review)
    retained = retain_calibration_preview(store, preview, review)
    saved = save_calibration_preview(store, ready["id"], retained["operation_id"], retained["preview_fingerprint"], review,
        acknowledged_risk_ids=[risk["risk_id"] for risk in retained["risks"]],
        template_database=tmp_path / "pdf-search.sqlite3", remember_reference=True)
    assert saved["reference_state"] == "saved"
    return ready, preview, retained


def test_remembered_layout_applies_during_new_source_analysis_without_confirmations(tmp_path):
    first, second = [_pdf(tmp_path, name, counts=(3, 3)) for name in ("first", "second")]
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, preview, _ = remembered(store, tmp_path, first)
        new = _ready(store, [second], ALL)
        assert ready["sources"][0]["source_key"] != new["sources"][0]["source_key"]
        for row in store.read_page_results(new["id"]):
            payload = row["payload"]
            assert payload["receipt_page"]["layout_definition"]["slots"] == preview.draft["slots"]
            assert payload["receipt_page"]["layout_definition"]["uniform_height"] is True
            assert payload["suggestion"] == {"basis": "historical_reference", "needs_review": True}
            assert {"code": "historical_layout_applied"} in payload["diagnostics"]
            assert all(item["needs_review"] for item in payload["receipt_page"]["candidates"])
        _prepared(store, new, tmp_path / "review.sqlite3")
        restored = read_batch_receipt_review_page(store, new["id"], new["result_revision"], 0, 200, tmp_path / "review.sqlite3")
        assert all(item["record"] is None for item in restored["items"])
        assert store.connection.execute("SELECT page_count FROM batch_receipt_layout_pins WHERE job_id=?", (new["id"],)).fetchone()[0] == 0


@pytest.mark.parametrize("initial_reference", [False, True])
def test_pause_and_restart_keep_nonempty_and_empty_history_snapshot(tmp_path, initial_reference):
    first, second = [_pdf(tmp_path, name, counts=(3, 3)) for name in ("first", "second")]
    database = tmp_path / "tasks.sqlite3"
    with BatchStore(database) as store:
        ready, preview, retained = remembered(store, tmp_path, first)
        templates = LayoutTemplateStore(tmp_path / "pdf-search.sqlite3")
        if not initial_reference:
            templates.deactivate(templates.list()[0]["id"])
        job = store.create_receipt_job("next", [{"source_path": str(second), "name": second.name}], ALL,
                                       "exact", current_computation_version())
        def pause(event, payload):
            if event == "progress" and payload.get("phase") == "page_settled":
                current = store.get_job(job["id"])
                store.control(job["id"], current["generation"], "pause-after-page", "pause")
        paused = execute(store, job, pause)
        assert paused["state"] == "paused"
        first_payload = store.read_page_results(job["id"])[0]["payload"]
        if initial_reference:
            undo_calibration_operation(store, ready["id"], retained["operation_id"], tmp_path / "review.sqlite3",
                                       undo_id="undo-after-pin", template_database=tmp_path / "pdf-search.sqlite3")
        else:
            save_reference_layout(preview.draft, tmp_path / "pdf-search.sqlite3", "new-reference")
    with BatchStore(database) as store:
        result = execute(store, store.get_job(job["id"]))
        assert result["state"] == "ready_for_review"
        next_payload = store.read_page_results(job["id"])[1]["payload"]
        assert next_payload["receipt_page"]["layout_definition"]["slots"] == first_payload["receipt_page"]["layout_definition"]["slots"]
        assert next_payload["suggestion"]["basis"] == first_payload["suggestion"]["basis"]
        assert (next_payload["suggestion"]["basis"] == "historical_reference") == initial_reference


@pytest.mark.parametrize("withdrawal", ["deactivate", "undo", "undo_auxiliary_failure"])
def test_withdrawal_stops_new_tasks_including_unsynced_auxiliary_database(tmp_path, monkeypatch, withdrawal):
    first, second = [_pdf(tmp_path, name, counts=(3,)) for name in ("first", "second")]
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, _, retained = remembered(store, tmp_path, first)
        database = tmp_path / "pdf-search.sqlite3"
        if withdrawal == "deactivate":
            templates = LayoutTemplateStore(database)
            templates.deactivate(templates.list()[0]["id"])
        else:
            if withdrawal == "undo_auxiliary_failure":
                def fail(*args, **kwargs):
                    raise OSError("simulated unavailable history")
                monkeypatch.setattr(LayoutTemplateStore, "withdraw_source_operation", fail)
            if withdrawal == "undo_auxiliary_failure":
                with pytest.raises(OSError, match="simulated"):
                    undo_calibration_operation(store, ready["id"], retained["operation_id"], tmp_path / "review.sqlite3",
                                               undo_id="undo-history", template_database=database)
            else:
                undo_calibration_operation(store, ready["id"], retained["operation_id"], tmp_path / "review.sqlite3",
                                           undo_id="undo-history", template_database=database)
        result = _ready(store, [second], ALL)
        assert store.read_page_results(result["id"])[0]["payload"]["suggestion"]["basis"] != "historical_reference"


def test_stopped_template_does_not_fallback_to_source_calibration_and_new_active_reuses(tmp_path):
    first = _pdf(tmp_path, "first", counts=(3,))
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        _, preview, _ = remembered(store, tmp_path, first)
        templates = LayoutTemplateStore(tmp_path / "pdf-search.sqlite3")
        templates.deactivate(templates.list()[0]["id"])
        stopped = _ready(store, [first], ALL)
        stopped_payload = store.read_page_results(stopped["id"])[0]["payload"]
        assert stopped_payload["suggestion"] == {"basis": "page_evidence", "needs_review": False}
        assert store.connection.execute("SELECT page_count FROM batch_receipt_layout_pins WHERE job_id=?",
                                        (stopped["id"],)).fetchone()[0] == 0

        newer = deepcopy(preview.draft)
        for slot in newer["slots"]:
            slot["height_pt"] -= 5
        save_reference_layout(newer, tmp_path / "pdf-search.sqlite3", "newer-history")
        result = _ready(store, [first], ALL)
        payload = store.read_page_results(result["id"])[0]["payload"]
        assert payload["receipt_page"]["layout_definition"]["slots"] == newer["slots"]
        assert payload["suggestion"] == {"basis": "historical_reference", "needs_review": True}
        assert {"code": "historical_layout_applied"} in payload["diagnostics"]


def test_prepare_with_history_keeps_authoritative_base_through_preview_and_save(tmp_path):
    path = _pdf(tmp_path, "source", counts=(3,))
    review, templates = tmp_path / "review.sqlite3", tmp_path / "pdf-search.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [path], ALL)
        baseline = _prepared(store, ready, review)
        save_reference_layout(_draft(baseline), templates, "preexisting-template")
        request = {"job_id": ready["id"], "result_revision": ready["result_revision"],
                   "sample_id": baseline.sample["id"], "review_database_path": str(review),
                   "template_database_path": str(templates)}
        prepared = _dispatch(store, "batch_receipt_calibration_prepare", request)
        assert prepared["layout_definition"] == baseline.layout
        assert prepared["preparation_fingerprint"] == baseline.fingerprint
        retained = _dispatch(store, "batch_receipt_calibration_preview", {**request,
            "preparation_fingerprint": prepared["preparation_fingerprint"],
            "layout_definition": _draft(baseline), "include_exception_ids": []})
        saved = _dispatch(store, "batch_receipt_calibration_save", {"job_id": ready["id"],
            "operation_id": retained["operation_id"], "preview_fingerprint": retained["preview_fingerprint"],
            "review_database_path": str(review), "template_database_path": str(templates),
            "acknowledged_risk_ids": [risk["risk_id"] for risk in retained["risks"]]})
        assert saved["state"] == "applied"


def visual_layout(count=3):
    current = evidence(tuple("row" for _ in range(count)))
    descriptor = deepcopy(current.descriptor)
    descriptor["layout_compatibility"] = {"kind": "visible_form_v1", "issuer_id": "visual-" + "a" * 64,
        "family_id": "b" * 64, "evidence_version": "receipt-visual-v1." + ".".join(f"p{300 + index * 3000}" for index in range(count))}
    return suggest_layout(replace(current, descriptor=descriptor)).layout_definition


def reference(tmp_path, layout, operation="saved", confirmed=None, **kwargs):
    return historical_reference(save_reference_layout(layout, tmp_path / "pdf-search.sqlite3", operation,
                                confirmed_slot_ids=confirmed, **kwargs))


@pytest.mark.parametrize("tail", [1, 2, 3])
def test_full_reference_projects_only_existing_tail_positions_and_shared_parameters(tmp_path, tail):
    saved = visual_layout()
    saved.update(uniform_height=True, left_pt=12, right_pt=10)
    for slot in saved["slots"]:
        slot["height_pt"] = 260
    current = visual_layout(tail)
    result = apply_historical_reference(current, (reference(tmp_path, saved),))
    assert result["slots"] == saved["slots"][:tail]
    assert result["left_pt"] == 12 and result["right_pt"] == 10
    assert result["layout_id"] == current["layout_id"]
    assert result["evidence_version"] == current["evidence_version"]


def test_full_then_partial_history_composes_latest_confirmed_slots_only(tmp_path):
    current = visual_layout()
    first = deepcopy(current)
    first.update(uniform_height=False, left_pt=7)
    for slot in first["slots"]:
        slot["height_pt"] = 250
    full = reference(tmp_path, first, "full")
    latest = deepcopy(first)
    latest["slots"][0]["height_pt"] = 240
    latest["slots"][1]["height_pt"] = 230  # This position was not confirmed.
    partial = reference(tmp_path, latest, "partial", ["slot-1"], save_mode="update", template_id=full["template_id"])
    result = apply_historical_reference(current, (partial, full))
    assert [slot["height_pt"] for slot in result["slots"]] == [240, 250, 250]
    assert result["left_pt"] == 7
    # A version is now self-contained: previously confirmed slots are merged
    # before older rows become inactive.
    assert apply_historical_reference(current, (partial,)) == result
    assert apply_historical_reference(current, (full,))["slots"] == first["slots"]


@pytest.mark.parametrize("change", ["unknown", "bank", "family", "rotation", "workspace", "positions"])
def test_history_requires_independent_current_positive_identity_and_position_evidence(tmp_path, change):
    saved, current = visual_layout(), visual_layout()
    if change == "unknown":
        current.update(issuer_id=None, family_id=None)
    elif change == "bank":
        current["issuer_id"] = "d" * 64
    elif change == "family":
        current["family_id"] = "e" * 64
    elif change == "workspace":
        current["workspace_id"] = "different-workspace"
    elif change == "rotation":
        current["page_geometry"]["rotation"] = 180
    else:
        current["evidence_version"] = "receipt-visual-v1.p300.p3500.p6300"
    assert apply_historical_reference(current, (reference(tmp_path, saved),)) is None


def test_legacy_missing_identity_and_inconsistent_saved_metadata_are_not_automatic_references(tmp_path):
    template = save_reference_layout(visual_layout(), tmp_path / "pdf-search.sqlite3", "saved")
    assert historical_reference(template) is not None
    for mutate in (
        lambda value: value["evidence_summary"].pop("reference_schema"),
        lambda value: value["evidence_summary"]["layout_definition"].update(issuer_id=None),
        lambda value: value.update(layout_fingerprint="0" * 64),
        lambda value: value.update(source_scope="different"),
        lambda value: value.update(evidence_summary=[]),
    ):
        invalid = deepcopy(template)
        mutate(invalid)
        assert historical_reference(invalid) is None


def test_history_pin_corruption_is_detected_and_contains_no_document_payload(tmp_path):
    path = _pdf(tmp_path, "source", counts=(3,))
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        remembered(store, tmp_path, path)
        job = _ready(store, [_pdf(tmp_path, "other", counts=(3,))], ALL)
        row = store.connection.execute("SELECT payload_json FROM batch_receipt_history_pin_rows WHERE job_id=?", (job["id"],)).fetchone()
        payload = json.loads(row[0])
        assert set(payload) == {"template_id", "template_series_id", "source_operation_id", "layout_definition", "confirmed_slot_ids"}
        assert "TARGET" not in row[0] and "source_path" not in row[0]
        payload["layout_definition"]["slots"][0]["height_pt"] -= 1
        payload["layout_definition"]["uniform_height"] = False
        store.connection.execute("UPDATE batch_receipt_history_pin_rows SET payload_json=? WHERE job_id=?",
                                 (json.dumps(payload), job["id"]))
        with pytest.raises(BatchStoreError, match="history|historical"):
            pin_historical_receipt_layouts(store, job["id"], job["generation"], "host")


def test_preupgrade_task_without_history_pin_remains_empty(tmp_path):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        job = _ready(store, [_pdf(tmp_path, "source", counts=(3,))], ALL)
        reference(tmp_path, visual_layout())
        store.connection.execute("DELETE FROM batch_receipt_history_pins WHERE job_id=?", (job["id"],))
        assert pin_historical_receipt_layouts(store, job["id"], job["generation"], "host") == ()


@pytest.mark.parametrize("invalid_database", ["unreadable", "malformed", "oversized"])
def test_auxiliary_history_failure_does_not_block_automatic_analysis(tmp_path, monkeypatch, invalid_database):
    from engine import receipt_layout_history
    database = tmp_path / "pdf-search.sqlite3"
    if invalid_database == "unreadable":
        database.write_bytes(b"not a sqlite database")
    else:
        reference(tmp_path, visual_layout())
        if invalid_database == "oversized":
            monkeypatch.setattr(receipt_layout_history, "MAX_HISTORY_BYTES", 1)
        else:
            import sqlite3
            with sqlite3.connect(database) as connection:
                connection.execute("UPDATE layout_templates SET evidence_json='[]'")
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        job = _ready(store, [_pdf(tmp_path, "source", counts=(3,))], ALL)
        assert store.read_page_results(job["id"])[0]["payload"]["suggestion"]["basis"] != "historical_reference"


def test_special_document_and_ordinary_form_histories_are_separate(tmp_path):
    from tests.test_receipt_document_types import evidence as special_evidence, page, block
    normal = suggest_layout(evidence(("ordinary",))).layout_definition
    forms = [suggest_layout(replace(special_evidence(page(block(title, 60), block("body", 180))),
                                   descriptor=deepcopy(evidence(("ordinary",)).descriptor))).layout_definition
             for title in ("贷款利息到期通知书", "电子缴税付款凭证")]
    references = [reference(tmp_path, layout, f"saved-{index}") for index, layout in enumerate([normal, *forms])]
    assert all(value is not None for value in references)
    for index, current in enumerate([normal, *forms]):
        for other_index, saved in enumerate(references):
            assert (apply_historical_reference(current, (saved,)) is not None) == (index == other_index)


def test_legacy_four_field_pin_keeps_digest_and_replay_after_upgrade(tmp_path):
    from engine.receipt_layout_history import _digest
    path = _pdf(tmp_path, "source", counts=(3,))
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        remembered(store, tmp_path, path)
        job = _ready(store, [_pdf(tmp_path, "other", counts=(3,))], ALL)
        record = store.connection.execute("SELECT payload_json FROM batch_receipt_history_pin_rows WHERE job_id=?", (job["id"],)).fetchone()
        old = json.loads(record[0])
        old.pop("template_series_id")
        digest = _digest([old])
        store.connection.execute("UPDATE batch_receipt_history_pin_rows SET payload_json=? WHERE job_id=?", (json.dumps(old), job["id"]))
        store.connection.execute("UPDATE batch_receipt_history_pins SET templates_digest=? WHERE job_id=?", (digest, job["id"]))
        pinned = pin_historical_receipt_layouts(store, job["id"], job["generation"], "host")
        assert pinned == (old,)
        assert _digest(list(pinned)) == digest
        assert apply_historical_reference(old["layout_definition"], pinned) is not None


def test_legacy_pin_can_still_compose_old_partial_versions(tmp_path):
    from copy import deepcopy
    full_layout = visual_layout()
    full = reference(tmp_path, full_layout, "full")
    changed = deepcopy(full_layout)
    changed["uniform_height"] = False
    changed["slots"][0]["height_pt"] -= 10
    partial = reference(tmp_path, changed, "partial", ["slot-1"])
    for old in (full, partial):
        old.pop("template_series_id")
    applied = apply_historical_reference(full_layout, (partial, full))
    assert applied["slots"][0]["height_pt"] == changed["slots"][0]["height_pt"]
    assert applied["slots"][1:] == full_layout["slots"][1:]


def test_capacity_fallback_drops_competing_series_as_one_group():
    from engine.receipt_layout_history import _drop_history_group
    base = {"template_id": "first", "source_operation_id": "op", "layout_definition": visual_layout(),
            "confirmed_slot_ids": ["slot-1"], "template_series_id": "first"}
    unrelated = deepcopy(base)
    unrelated["layout_definition"]["issuer_id"] = "other-bank"
    other_series = {**deepcopy(base), "template_id": "second", "template_series_id": "second"}
    rows = [base, unrelated, other_series]
    _drop_history_group(rows)
    assert rows == [unrelated]
