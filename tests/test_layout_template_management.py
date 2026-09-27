"""Template management and explicit selection use only isolated synthetic data."""
from copy import deepcopy
import json
import sqlite3

import pytest

from engine.batch_api import _dispatch, handle_batch_request
from engine.batch_store import BatchStore, BatchCapacityExceeded
from engine.computation import current_computation_version
from engine.layout_template_store import LayoutTemplateStore, LayoutTemplateError
from engine.receipt_layout_history import _active_references, pin_historical_receipt_layouts
from engine.receipt_layout_reference import save_reference_layout, historical_reference
from tests.test_layout_template_store import template as legacy_template
from tests.test_receipt_layout_history import visual_layout, remembered
from tests.test_receipt_layout_review import _pdf, _ready, private_temp
from tests.test_receipt_layout_reuse import execute
from tests.test_receipt_batch_pdf import ALL


def call(tmp_path, op, **fields):
    return handle_batch_request({"op": op, "database_path": str(tmp_path / "tasks.sqlite3"),
        "template_database_path": str(tmp_path / "pdf-search.sqlite3"), **fields})


def create_fields(path, template_id):
    return {"name": "selected synthetic", "sources": [{"source_path": str(path), "name": path.name}],
            "processing_options": ALL, "match_mode": "exact", "layout_template_id": template_id}


def test_name_version_partial_composition_and_restart_persistence(tmp_path):
    database = tmp_path / "pdf-search.sqlite3"
    first = visual_layout()
    first["uniform_height"] = False
    for slot in first["slots"]:
        slot["height_pt"] = 250
    saved = save_reference_layout(first, database, "first", name="上海银行常用回单")
    renamed = call(tmp_path, "batch_layout_template_rename", template_id=saved["id"], name="工资回单")
    assert renamed["data"]["name"] == "工资回单"
    latest = deepcopy(first)
    latest["slots"][0]["height_pt"] = 240
    latest["slots"][1]["height_pt"] = 230  # Unconfirmed geometry is discarded.
    second = save_reference_layout(latest, database, "second", confirmed_slot_ids=["slot-1"], save_mode="update", template_id=saved["id"])
    assert second["name"] == "工资回单"
    assert second["version"] == 2
    assert [slot["height_pt"] for slot in second["evidence_summary"]["layout_definition"]["slots"]] == [240, 250, 250]
    assert second["evidence_summary"]["confirmed_slot_ids"] == ["slot-1", "slot-2", "slot-3"]
    assert second["evidence_summary"]["confirmed_slot_sources"] == {"slot-1": "second", "slot-2": "first", "slot-3": "first"}
    restarted = LayoutTemplateStore(database)
    assert not restarted.get(saved["id"])["active"]
    assert restarted.list_page()["items"] == [second]
    assert save_reference_layout(latest, database, "second", confirmed_slot_ids=["slot-1"], save_mode="update", template_id=saved["id"])["id"] == second["id"]
    assert call(tmp_path, "batch_layout_template_deactivate", template_id=saved["id"], operation_id=None)["data"]["deactivated"]
    assert restarted.list_page()["total"] == 0
    inactive = restarted.list_page(active_only=False)
    assert inactive["total"] == 1 and inactive["items"][0]["id"] == second["id"]
    assert not inactive["items"][0]["active"]
    with pytest.raises(LayoutTemplateError, match="withdrawn|superseded"):
        save_reference_layout(first, database, "first")


@pytest.mark.parametrize("edge", ["left_pt", "right_pt"])
def test_partial_shared_parameter_change_preserves_previous_template(tmp_path, edge):
    database = tmp_path / "pdf-search.sqlite3"
    baseline = visual_layout()
    old = save_reference_layout(baseline, database, "old")
    changed = deepcopy(baseline)
    changed[edge] += 1
    with pytest.raises(LayoutTemplateError, match="shared parameters") as exc_info:
        save_reference_layout(changed, database, "new", confirmed_slot_ids=["slot-1"], save_mode="update", template_id=old["id"])
    assert exc_info.value.code == "shared_geometry_changed"
    assert LayoutTemplateStore(database).list()[0]["id"] == old["id"]


def test_partial_merge_rejects_overlapping_composed_geometry_without_new_version(tmp_path):
    database = tmp_path / "pdf-search.sqlite3"
    baseline = visual_layout()
    old = save_reference_layout(baseline, database, "old")

    # The incoming draft is valid on its own. Moving the confirmed first slot
    # into the old second slot makes the composed layout overlap only after
    # the previous template's unconfirmed geometry is retained.
    changed = deepcopy(baseline)
    changed["uniform_height"] = False
    changed["slots"] = [
        {**changed["slots"][0], "top_pt": 300, "height_pt": 200},
        {**changed["slots"][1], "top_pt": 510, "height_pt": 200},
        {**changed["slots"][2], "top_pt": 720, "height_pt": 180},
    ]

    templates = LayoutTemplateStore(database)
    with pytest.raises(LayoutTemplateError) as exc_info:
        save_reference_layout(changed, database, "new", confirmed_slot_ids=["slot-1"], save_mode="update", template_id=old["id"])

    assert exc_info.value.code == "template_geometry_conflict"
    assert templates.get(old["id"])["active"] is True
    rows = templates.list(active_only=False)
    assert len(rows) == 1
    assert rows[0]["id"] == old["id"] and rows[0]["version"] == old["version"]


def test_partial_uniform_height_toggle_preserves_confirmed_geometry(tmp_path):
    database = tmp_path / "pdf-search.sqlite3"
    baseline = visual_layout()
    first = save_reference_layout(baseline, database, "old")
    changed = deepcopy(baseline)
    changed["uniform_height"] = False
    changed["slots"][0]["height_pt"] -= 10

    second = save_reference_layout(changed, database, "new", confirmed_slot_ids=["slot-1"], save_mode="update", template_id=first["id"])

    assert second["version"] == first["version"] + 1
    assert [slot["height_pt"] for slot in second["evidence_summary"]["layout_definition"]["slots"]] == [
        baseline["slots"][0]["height_pt"] - 10, baseline["slots"][1]["height_pt"], baseline["slots"][2]["height_pt"],
    ]
    assert second["evidence_summary"]["confirmed_slot_ids"] == ["slot-1", "slot-2", "slot-3"]
    assert second["evidence_summary"]["confirmed_slot_sources"] == {
        "slot-1": "new", "slot-2": "old", "slot-3": "old",
    }


def test_subsequent_partial_update_preserves_prior_confirmed_and_unconfirmed_slots(tmp_path):
    database = tmp_path / "pdf-search.sqlite3"
    first_layout = visual_layout()
    first_layout["uniform_height"] = False
    first_layout["slots"][0]["height_pt"] = 260
    first = save_reference_layout(first_layout, database, "first", confirmed_slot_ids=["slot-1"])

    second_layout = deepcopy(first_layout)
    second_layout["slots"][0]["height_pt"] = 250
    second_layout["slots"][1]["height_pt"] = 255
    second_layout["slots"][2]["height_pt"] = 245
    second = save_reference_layout(second_layout, database, "second", confirmed_slot_ids=["slot-2"], save_mode="update", template_id=first["id"])

    assert second["version"] == first["version"] + 1
    assert [slot["height_pt"] for slot in second["evidence_summary"]["layout_definition"]["slots"]] == [
        first_layout["slots"][0]["height_pt"], second_layout["slots"][1]["height_pt"], first_layout["slots"][2]["height_pt"],
    ]
    assert second["evidence_summary"]["confirmed_slot_ids"] == ["slot-1", "slot-2"]
    assert second["evidence_summary"]["confirmed_slot_sources"] == {"slot-1": "first", "slot-2": "second"}


def test_missing_reference_identity_is_rejected_before_persistence(tmp_path):
    database = tmp_path / "pdf-search.sqlite3"
    unknown = visual_layout()
    unknown.update(issuer_id=None, family_id=None)

    with pytest.raises(LayoutTemplateError) as exc_info:
        save_reference_layout(unknown, database, "unknown-identity")
    assert exc_info.value.code == "identity_unavailable"
    assert LayoutTemplateStore(database).list(active_only=False) == []

    # The generic schema-2 store entry point has the same guard.  This keeps
    # callers from bypassing save_reference_layout and leaving an active row
    # that reusable_templates() would silently hide.
    known = save_reference_layout(visual_layout(), database, "known-identity")
    invalid = {key: deepcopy(known[key]) for key in (
        "id", "name", "source_scope", "layout_fingerprint", "page_geometry", "slots",
        "evidence_summary", "source_operation_id",
    )}
    invalid["id"] = "unknown-generic"
    invalid["source_operation_id"] = "unknown-generic"
    invalid["evidence_summary"]["layout_definition"].update(issuer_id=None, family_id=None)
    with pytest.raises(LayoutTemplateError) as exc_info:
        LayoutTemplateStore(database).save(invalid)
    assert exc_info.value.code == "identity_unavailable"
    assert [row["id"] for row in LayoutTemplateStore(database).list(active_only=False)] == [known["id"]]


def test_undo_inherited_position_disables_composite_without_reactivating_old_rows(tmp_path):
    database = tmp_path / "pdf-search.sqlite3"
    first = save_reference_layout(visual_layout(), database, "first")
    second = save_reference_layout(visual_layout(), database, "second", confirmed_slot_ids=["slot-1"], save_mode="update", template_id=first["id"])
    templates = LayoutTemplateStore(database)
    assert templates.withdraw_source_operation("first", "undo-first")["deactivated_count"] == 1
    assert templates.list() == []
    assert not templates.get(first["id"])["active"] and not templates.get(second["id"])["active"]


def test_management_pages_only_valid_latest_reference_families(tmp_path):
    database = tmp_path / "pdf-search.sqlite3"
    for index in range(53):
        layout = visual_layout()
        layout["issuer_id"] = f"bank-{index}"
        save_reference_layout(layout, database, f"operation-{index}")
    templates = LayoutTemplateStore(database)
    legacy = templates.save(legacy_template())
    broken = save_reference_layout(visual_layout(), database, "broken")
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE layout_templates SET evidence_json='[]' WHERE id=?", (broken["id"],))
    page = call(tmp_path, "batch_layout_template_list", active_only=True, offset=0, limit=50)
    assert page["status"] == "ok"
    assert page["data"]["total"] == 53 and len(page["data"]["items"]) == 50 and page["data"]["next_offset"] == 50
    tail = call(tmp_path, "batch_layout_template_list", active_only=True, offset=50, limit=50)["data"]
    assert len(tail["items"]) == 3 and tail["next_offset"] is None
    ids = [item["id"] for item in page["data"]["items"] + tail["items"]]
    assert len(set(ids)) == 53 and legacy["id"] not in ids and broken["id"] not in ids
    for overrides in ({"limit": 51}, {"offset": -1}, {"offset": True}, {"active_only": 1}):
        assert call(tmp_path, "batch_layout_template_list", **({"active_only": True, "offset": 0, "limit": 50} | overrides))["code"] == "batch_invalid_request"


@pytest.mark.parametrize("reason", ["missing", "inactive", "withdrawn", "corrupt", "legacy", "unknown_identity", "undo_unsynced"])
def test_explicit_unavailable_template_fails_without_creating_a_job(tmp_path, reason):
    database = tmp_path / "pdf-search.sqlite3"
    template = save_reference_layout(visual_layout(), database, "selected")
    templates = LayoutTemplateStore(database)
    selected = template["id"]
    if reason == "missing":
        selected = "missing"
    elif reason == "inactive":
        templates.deactivate(selected)
    elif reason == "withdrawn":
        templates.withdraw_source_operation("selected")
    elif reason == "legacy":
        selected = templates.save(legacy_template())["id"]
    elif reason == "unknown_identity":
        # Simulate a legacy/foreign row that was persisted before identity
        # validation was enforced. New writes reject this state, while
        # explicit selection must still fail closed if such a row is found.
        with sqlite3.connect(database) as connection:
            evidence = json.loads(connection.execute(
                "SELECT evidence_json FROM layout_templates WHERE id=?", (selected,)
            ).fetchone()[0])
            evidence["layout_definition"].update(issuer_id=None, family_id=None)
            connection.execute("UPDATE layout_templates SET evidence_json=? WHERE id=?",
                               (json.dumps(evidence), selected))
    elif reason == "corrupt":
        with sqlite3.connect(database) as connection:
            connection.execute("UPDATE layout_templates SET slots_json='broken' WHERE id=?", (selected,))
    elif reason == "undo_unsynced":
        with BatchStore(tmp_path / "tasks.sqlite3") as store:
            store.connection.execute("CREATE TABLE batch_receipt_calibration_undos (operation_id TEXT)")
            store.connection.execute("INSERT INTO batch_receipt_calibration_undos VALUES ('selected')")
    response = call(tmp_path, "batch_create_receipts", **create_fields(tmp_path / "unused.pdf", selected))
    assert response["status"] == "error" and response["code"] == "template_unavailable"
    if reason == "undo_unsynced":
        assert call(tmp_path, "batch_layout_template_list", active_only=True, offset=0, limit=50)["data"]["items"] == []
        assert not call(tmp_path, "batch_layout_template_list", active_only=False, offset=0, limit=50)["data"]["items"][0]["active"]
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        assert store.list_jobs()["total"] == 0


def test_selected_pin_created_atomically_and_preserves_processing_fingerprint(tmp_path, monkeypatch):
    template = save_reference_layout(visual_layout(), tmp_path / "pdf-search.sqlite3", "selected")
    selected = call(tmp_path, "batch_create_receipts", **create_fields(tmp_path / "selected.pdf", template["id"]))["data"]
    automatic = call(tmp_path, "batch_create_receipts", **create_fields(tmp_path / "automatic.pdf", None))["data"]
    assert selected["criteria_fingerprint"] == automatic["criteria_fingerprint"]
    assert selected["processing_options"] == ALL and set(selected) == set(automatic)
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        pins = store.connection.execute("SELECT job_id,template_count FROM batch_receipt_history_pins").fetchall()
        assert len(pins) == 1 and pins[0]["job_id"] == selected["id"] and pins[0]["template_count"] == 1
        from engine import receipt_layout_history
        def fail(*args, **kwargs):
            raise BatchCapacityExceeded("simulated capacity failure")
        monkeypatch.setattr(receipt_layout_history, "_write_history_pin_connection", fail)
        with pytest.raises(BatchCapacityExceeded):
            _dispatch(store, "batch_create_receipts", {**create_fields(tmp_path / "failed.pdf", template["id"]),
                "template_database_path": str(tmp_path / "pdf-search.sqlite3")})
        assert store.list_jobs()["total"] == 2
        assert store.connection.execute("SELECT COUNT(*) FROM batch_sources").fetchone()[0] == 2


def test_explicit_selection_stays_frozen_before_first_run_and_across_resume(tmp_path):
    first, second = [_pdf(tmp_path, name, counts=(3, 3)) for name in ("first", "second")]
    database = tmp_path / "tasks.sqlite3"
    templates_db = tmp_path / "pdf-search.sqlite3"
    with BatchStore(database) as store:
        _, preview, _ = remembered(store, tmp_path, first)
        template = LayoutTemplateStore(templates_db).list_page()["items"][0]
        selected = _dispatch(store, "batch_create_receipts", {**create_fields(second, template["id"]), "template_database_path": str(templates_db)})
        before_pin = store.connection.execute("SELECT templates_digest FROM batch_receipt_history_pins WHERE job_id=?", (selected["id"],)).fetchone()[0]
        new_layout = deepcopy(preview.draft)
        for slot in new_layout["slots"]:
            slot["height_pt"] -= 5
        updated = save_reference_layout(new_layout, templates_db, "newer", save_mode="update", template_id=template["id"])
        def pause(event, payload):
            if event == "progress" and payload.get("phase") == "page_settled":
                current = store.get_job(selected["id"])
                store.control(selected["id"], current["generation"], "pause", "pause")
        paused = execute(store, selected, pause)
        assert paused["state"] == "paused"
        LayoutTemplateStore(templates_db).deactivate(updated["id"])
    with BatchStore(database) as store:
        ready = execute(store, store.get_job(selected["id"]))
        assert ready["state"] == "ready_for_review"
        for row in store.read_page_results(selected["id"]):
            assert row["payload"]["receipt_page"]["layout_definition"]["slots"] == preview.draft["slots"]
            assert row["payload"]["suggestion"]["basis"] == "historical_reference"
        assert store.connection.execute("SELECT templates_digest FROM batch_receipt_history_pins WHERE job_id=?", (selected["id"],)).fetchone()[0] == before_pin


@pytest.mark.parametrize("title", ["中国民生银行业务回单", "贷款利息到期通知书", "贷款清算通知书", "电子缴税付款凭证"])
def test_explicit_selection_cannot_force_other_bank_or_special_document(tmp_path, title):
    first = _pdf(tmp_path, "bank", counts=(3,))
    other = _pdf(tmp_path, "other", title=title, counts=(3,))
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        remembered(store, tmp_path, first)
        template = LayoutTemplateStore(tmp_path / "pdf-search.sqlite3").list_page()["items"][0]
        selected = _dispatch(store, "batch_create_receipts", {**create_fields(other, template["id"]),
            "template_database_path": str(tmp_path / "pdf-search.sqlite3")})
        result = execute(store, selected)
        assert result["state"] == "ready_for_review"
        assert all(row["payload"]["suggestion"]["basis"] != "historical_reference" for row in store.read_page_results(selected["id"]))


def test_more_than_256_legacy_versions_do_not_disable_every_template(tmp_path):
    database = tmp_path / "pdf-search.sqlite3"
    latest = None
    for index in range(260):
        latest = save_reference_layout(visual_layout(), database, f"version-{index}",
            **({"save_mode": "update", "template_id": latest["id"]} if latest else {}))
    # Simulate an old release where every historical version stayed active.
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE layout_templates SET active=1")
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        references = _active_references(store)
        assert len(references) == 1 and references[0]["template_id"] == latest["id"]
    templates = LayoutTemplateStore(database)
    assert templates.list_page()["total"] == 1
    assert templates.deactivate(latest["id"])
    assert templates.list() == []


def test_reference_capacity_keeps_a_bounded_useful_subset(tmp_path, monkeypatch):
    from engine import receipt_layout_history
    database = tmp_path / "pdf-search.sqlite3"
    for index in range(4):
        layout = visual_layout()
        layout["issuer_id"] = f"bank-{index}"
        save_reference_layout(layout, database, f"version-{index}")
    monkeypatch.setattr(receipt_layout_history, "MAX_HISTORY_TEMPLATES", 2)
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        assert len(_active_references(store)) == 2


def legacy_partial_rows(tmp_path, *, shared_change=False, earlier_inactive=False):
    database = tmp_path / "pdf-search.sqlite3"
    first_layout = visual_layout()
    first_layout["uniform_height"] = False
    first_layout["slots"][1]["height_pt"] = 250
    first = save_reference_layout(first_layout, database, "legacy-first", confirmed_slot_ids=["slot-2"])
    # Deactivate before saving to make each row a standalone old-style partial.
    LayoutTemplateStore(database).deactivate(first["id"])
    second_layout = visual_layout()
    second_layout["uniform_height"] = False
    second_layout["slots"][0]["height_pt"] = 240
    second_layout["slots"][1]["height_pt"] = 230  # Not confirmed in latest row.
    if shared_change:
        second_layout["left_pt"] = 8
    second = save_reference_layout(second_layout, database, "legacy-second", confirmed_slot_ids=["slot-1"])
    with sqlite3.connect(database) as connection:
        # Model the former implicit family versioning without running the new
        # explicit-update merge: old rows held independent partial snapshots.
        connection.execute("UPDATE layout_templates SET series_id=?,version=2 WHERE id=?", (first["series_id"], second["id"]))
        second.update(series_id=first["series_id"], version=2)
        if not earlier_inactive:
            connection.execute("UPDATE layout_templates SET active=1 WHERE id=?", (first["id"],))
        # Schema 2 legacy rows have no per-position provenance map.
        for row in (first, second):
            evidence = deepcopy(row["evidence_summary"])
            evidence.pop("confirmed_slot_sources", None)
            connection.execute("UPDATE layout_templates SET evidence_json=? WHERE id=?", (json.dumps(evidence), row["id"]))
    return first, second


def test_legacy_active_partials_compose_identically_for_list_auto_selection_and_new_save(tmp_path):
    first, second = legacy_partial_rows(tmp_path)
    database = tmp_path / "pdf-search.sqlite3"
    templates = LayoutTemplateStore(database)
    original_rows = templates.list(active_only=False)
    listed = templates.list_page()["items"][0]
    assert listed["id"] == second["id"] and listed["version"] == second["version"]
    assert listed["evidence_summary"]["confirmed_slot_ids"] == ["slot-1", "slot-2"]
    assert [slot["height_pt"] for slot in listed["evidence_summary"]["layout_definition"]["slots"]][:2] == [240, 250]
    assert listed["evidence_summary"]["confirmed_slot_sources"] == {"slot-1": "legacy-second", "slot-2": "legacy-first"}
    assert historical_reference(listed) is not None
    assert templates.list(active_only=False) == original_rows  # read-only compatibility
    from engine.receipt_layout_history import selected_reference
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        assert _active_references(store) == [selected_reference(store, database, second["id"])]
        assert _active_references(store) == [historical_reference(listed)]
    updated = deepcopy(second["evidence_summary"]["layout_definition"])
    updated["slots"][2]["height_pt"] = 220
    saved = save_reference_layout(updated, database, "new-confirmed", confirmed_slot_ids=["slot-3"], save_mode="update", template_id=second["id"])
    assert [slot["height_pt"] for slot in saved["evidence_summary"]["layout_definition"]["slots"]] == [240, 250, 220]
    assert saved["evidence_summary"]["confirmed_slot_ids"] == ["slot-1", "slot-2", "slot-3"]
    assert len(templates.list()) == 1


@pytest.mark.parametrize("excluded", ["shared_change", "inactive", "withdrawn", "task_undo"])
def test_legacy_partials_never_inherit_incompatible_inactive_or_withdrawn_geometry(tmp_path, excluded):
    first, second = legacy_partial_rows(tmp_path, shared_change=excluded == "shared_change", earlier_inactive=excluded == "inactive")
    database = tmp_path / "pdf-search.sqlite3"
    if excluded == "withdrawn":
        LayoutTemplateStore(database).withdraw_source_operation("legacy-first", "undo")
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        if excluded == "task_undo":
            store.connection.execute("CREATE TABLE batch_receipt_calibration_undos (operation_id TEXT)")
            store.connection.execute("INSERT INTO batch_receipt_calibration_undos VALUES ('legacy-first')")
        reference = _active_references(store)[0]
        assert reference["template_id"] == second["id"]
        assert reference["confirmed_slot_ids"] == ["slot-1"]
        assert reference["layout_definition"]["slots"][1]["height_pt"] == 230


def test_withdrawn_legacy_head_does_not_resurrect_an_older_active_version(tmp_path):
    first, second = legacy_partial_rows(tmp_path)
    database = tmp_path / "pdf-search.sqlite3"
    templates = LayoutTemplateStore(database)
    templates.withdraw_source_operation(second["source_operation_id"], "undo-head")
    assert templates.get(first["id"])["active"]  # The old row remains an audit snapshot.
    assert templates.list_page()["items"] == []
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        assert _active_references(store) == []
    inactive = templates.list_page(active_only=False)["items"]
    assert len(inactive) == 1 and inactive[0]["id"] == second["id"] and not inactive[0]["active"]


def test_unchanged_reviewed_position_can_be_named_without_confirming_other_slots(tmp_path):
    from engine.receipt_layout_review import preview_receipt_calibration
    from engine.receipt_calibration_journal import retain_calibration_preview
    from tests.test_receipt_layout_review import _prepared
    review = tmp_path / "review.sqlite3"
    templates = tmp_path / "pdf-search.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "unchanged", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        preview = preview_receipt_calibration(store, prepared, deepcopy(prepared.layout), review)
        retained = retain_calibration_preview(store, preview, review)
        saved = _dispatch(store, "batch_receipt_calibration_save", {"job_id": ready["id"],
            "operation_id": retained["operation_id"], "preview_fingerprint": retained["preview_fingerprint"],
            "acknowledged_risk_ids": [risk["risk_id"] for risk in retained["risks"]],
            "review_database_path": str(review), "template_database_path": str(templates),
            "remember_reference": True, "template_name": "原样核对模板"})
        assert saved["reference_state"] == "saved"
    template = LayoutTemplateStore(templates).list_page()["items"][0]
    assert template["name"] == "原样核对模板"
    assert template["evidence_summary"]["confirmed_slot_ids"] == [prepared.sample["slot_id"]]
    assert template["evidence_summary"]["layout_definition"]["slots"] == prepared.layout["slots"]


def test_schema2_evidence_write_and_legacy_read_remove_unknown_metadata(tmp_path):
    database = tmp_path / "pdf-search.sqlite3"
    saved = save_reference_layout(visual_layout(), database, "clean-reference")
    allowed = {"slot_count", "confirmed_slot_ids", "reference_schema", "layout_definition", "shared_parameters",
        "page_width_pt", "page_height_pt", "confirmed_slot_sources"}
    injected = deepcopy(saved["evidence_summary"])
    injected.update(source_path="synthetic-private.pdf", note="synthetic private business note",
                    slot_count={"note": "synthetic private business note"})
    injected["shared_parameters"]["source_path"] = "synthetic-private.pdf"
    payload = {key: saved[key] for key in ("source_scope", "layout_fingerprint", "page_geometry", "slots", "name")}
    response = call(tmp_path, "batch_layout_template_save", template={**payload,
        "source_operation_id": "generic-write", "evidence_summary": injected,
        "save_mode": "update", "update_template_id": saved["id"]})
    assert response["status"] == "ok"
    generic_id = response["data"]["id"]
    with sqlite3.connect(database) as connection:
        persisted = json.loads(connection.execute("SELECT evidence_json FROM layout_templates WHERE id=?", (generic_id,)).fetchone()[0])
        assert set(persisted) <= allowed
        assert "synthetic-private" not in json.dumps(persisted) and "synthetic private" not in json.dumps(persisted)
        # Simulate a legacy schema-2 row with extension metadata, without
        # changing any current application's real database.
        connection.execute("UPDATE layout_templates SET evidence_json=? WHERE id=?", (json.dumps(injected), generic_id))
    listed = call(tmp_path, "batch_layout_template_list", active_only=True, offset=0, limit=50)["data"]["items"]
    assert len(listed) == 1 and listed[0]["id"] == generic_id
    assert set(listed[0]["evidence_summary"]) <= allowed
    assert listed[0]["evidence_summary"]["slot_count"] == len(visual_layout()["slots"])
    assert "synthetic-private" not in json.dumps(listed) and "synthetic private" not in json.dumps(listed)
    assert historical_reference(listed[0]) is not None
    renamed = call(tmp_path, "batch_layout_template_rename", template_id=generic_id, name="安全模板")
    assert "synthetic-private" not in json.dumps(renamed) and "synthetic private" not in json.dumps(renamed)
    with sqlite3.connect(database) as connection:
        legacy = connection.execute("SELECT evidence_json FROM layout_templates WHERE id=?", (generic_id,)).fetchone()[0]
        assert "synthetic-private" in legacy  # Read projection does not rewrite old records.


def test_read_only_legacy_database_and_migration_keep_one_stable_series(tmp_path):
    from engine.receipt_layout_reference import validate_reference_target
    source = tmp_path / "modern.sqlite3"
    first = save_reference_layout(visual_layout(), source, "legacy-first", name="旧模板")
    second = save_reference_layout(visual_layout(), source, "legacy-second", name="旧模板")
    database = tmp_path / "pdf-search.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.execute('''CREATE TABLE layout_templates (
            id TEXT PRIMARY KEY, version INTEGER NOT NULL, name TEXT, source_scope TEXT NOT NULL,
            page_geometry_json TEXT NOT NULL, layout_fingerprint TEXT NOT NULL, slots_json TEXT NOT NULL,
            evidence_json TEXT NOT NULL, source_operation_id TEXT NOT NULL, active INTEGER NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL)''')
        for version, row in enumerate((first, second), 1):
            connection.execute('INSERT INTO layout_templates VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                (row["id"], version, row["name"], row["source_scope"], json.dumps(row["page_geometry"]),
                 row["layout_fingerprint"], json.dumps(row["slots"]), json.dumps(row["evidence_summary"]),
                 row["source_operation_id"], 1, row["created_at"], row["updated_at"]))
    before = database.read_bytes()
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        references = _active_references(store)
    assert len(references) == 1 and references[0]["template_id"] == second["id"]
    target = validate_reference_target(visual_layout(), database, "update", second["id"])
    assert target["bank_name"] is None and target["version"] == 2
    assert database.read_bytes() == before
    migrated = LayoutTemplateStore(database)
    assert migrated.list_page()["items"][0]["series_id"] == target["series_id"]
    assert {row["series_id"] for row in migrated.list(active_only=False)} == {target["series_id"]}
    migrated_bytes = database.read_bytes()
    assert save_reference_layout(visual_layout(), database, "legacy-second", name="旧模板")["id"] == second["id"]
    assert database.read_bytes() == migrated_bytes
    with pytest.raises(LayoutTemplateError) as error:
        save_reference_layout(visual_layout(), database, "legacy-first", name="旧模板")
    assert error.value.code == "operation_conflict"  # Older active legacy rows do not become current again.
    updated = save_reference_layout(visual_layout(), database, "after-upgrade", save_mode="update", template_id=second["id"])
    assert updated["version"] == 3 and updated["series_id"] == target["series_id"]
    independent = save_reference_layout(visual_layout(), database, "independent")
    assert independent["version"] == 1 and independent["series_id"] != target["series_id"]
    assert migrated.list_page()["total"] == 2


@pytest.mark.parametrize("budget", ["count", "bytes"])
def test_history_budget_never_turns_competing_templates_into_unique_match(tmp_path, monkeypatch, budget):
    from engine import receipt_layout_history as history
    from engine.batch_models import canonical_json
    database = tmp_path / "pdf-search.sqlite3"
    other_layout = visual_layout()
    other_layout["issuer_id"] = "other-bank"
    other = save_reference_layout(other_layout, database, "other")
    candidates = [save_reference_layout(visual_layout(), database, f"same-form-{index}") for index in range(3)]
    if budget == "count":
        monkeypatch.setattr(history, "MAX_HISTORY_TEMPLATES", 2)
    else:
        size = max(len(canonical_json(historical_reference(row))) for row in candidates)
        monkeypatch.setattr(history, "MAX_HISTORY_BYTES", size * 2)
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        rows = _active_references(store)
    assert [row["template_id"] for row in rows] == [other["id"]]


def legacy_retry_database(tmp_path, *, confirmed=None, provenance=True):
    from engine.layout_template_store import _legacy_series
    database = tmp_path / "pdf-search.sqlite3"
    saved = save_reference_layout(visual_layout(), database, "old-operation", confirmed_slot_ids=confirmed, name="旧模板")
    # Model the exact values assigned by migration of a pre-series row.
    evidence = deepcopy(saved["evidence_summary"])
    if not provenance:
        evidence.pop("confirmed_slot_sources")
    with sqlite3.connect(database) as connection:
        connection.execute('''UPDATE layout_templates SET series_id=?,request_digest=NULL,save_mode=NULL,
            update_template_id=NULL,evidence_json=? WHERE id=?''',
            (_legacy_series(saved["source_scope"], saved["layout_fingerprint"]), json.dumps(evidence), saved["id"]))
    return database, LayoutTemplateStore(database).get(saved["id"])


@pytest.mark.parametrize("confirmed", [None, ["slot-1"]])
@pytest.mark.parametrize("name", [None, "旧模板"])
@pytest.mark.parametrize("provenance", [False, True])
def test_equivalent_legacy_save_retry_returns_existing_row_without_writes(tmp_path, confirmed, name, provenance):
    database, saved = legacy_retry_database(tmp_path, confirmed=confirmed, provenance=provenance)
    before = database.read_bytes()
    result = save_reference_layout(visual_layout(), database, "old-operation", confirmed_slot_ids=confirmed, name=name)
    assert result == saved
    assert database.read_bytes() == before
    assert len(LayoutTemplateStore(database).list(active_only=False)) == 1
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT request_digest,save_mode,update_template_id FROM layout_templates").fetchone() == (None, None, None)


@pytest.mark.parametrize("change", ["geometry", "confirmed", "name", "bank", "update", "issuer", "revision", "provenance"])
def test_legacy_retry_rejects_unproven_changed_requests_without_writes(tmp_path, change):
    database, saved = legacy_retry_database(tmp_path)
    draft = visual_layout()
    kwargs = {"name": "旧模板"}
    if change == "geometry":
        draft["left_pt"] += 1
    elif change == "confirmed":
        kwargs["confirmed_slot_ids"] = ["slot-1"]
    elif change == "name":
        kwargs["name"] = "另一模板"
    elif change == "bank":
        kwargs["bank_name"] = "新银行标签"
    elif change == "update":
        kwargs.update(save_mode="update", template_id=saved["id"])
    elif change == "issuer":
        draft["issuer_id"] = "other-bank"
    elif change == "revision":
        draft["revision"] += 1
    else:
        evidence = deepcopy(saved["evidence_summary"])
        evidence["confirmed_slot_sources"]["slot-1"] = "unproven-earlier-operation"
        with sqlite3.connect(database) as connection:
            connection.execute("UPDATE layout_templates SET evidence_json=?", (json.dumps(evidence),))
    before = database.read_bytes()
    with pytest.raises(LayoutTemplateError) as error:
        save_reference_layout(draft, database, "old-operation", **kwargs)
    assert error.value.code == "operation_conflict"
    assert database.read_bytes() == before


def test_legacy_retry_does_not_revive_inactive_or_withdrawn_template(tmp_path):
    database, saved = legacy_retry_database(tmp_path)
    templates = LayoutTemplateStore(database)
    templates.deactivate(saved["id"])
    for withdrawn in (False, True):
        if withdrawn:
            templates.withdraw_source_operation("old-operation", "undo")
        before = database.read_bytes()
        with pytest.raises(LayoutTemplateError) as error:
            save_reference_layout(visual_layout(), database, "old-operation", name="旧模板")
        assert error.value.code == "operation_inactive"
        assert database.read_bytes() == before


def test_missing_digest_on_new_row_cannot_use_legacy_retry_fallback(tmp_path):
    database = tmp_path / "pdf-search.sqlite3"
    saved = save_reference_layout(visual_layout(), database, "modern-operation")
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE layout_templates SET request_digest=NULL WHERE id=?", (saved["id"],))
    with pytest.raises(LayoutTemplateError) as error:
        save_reference_layout(visual_layout(), database, "modern-operation")
    assert error.value.code == "operation_conflict"
