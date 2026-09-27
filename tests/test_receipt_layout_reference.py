from engine.layout_template_store import LayoutTemplateStore
from engine.receipt_layout_reference import (
    apply_historical_reference,
    apply_reference,
    historical_reference,
    reference_fingerprint,
    reference_scope,
    reference_slots,
    save_reference_layout,
    compatible_historical_references,
    validate_reference_target,
)
from engine.receipt_layout_review import CalibrationPreparation


GEOMETRY = {"pdf_box": {"x0": 0, "y0": 0, "x1": 600, "y1": 900}, "rotation": 0, "user_unit": 1, "width_pt": 600, "height_pt": 900}


def layout():
    return {"schema_version": 1, "layout_id": "layout-1", "revision": 1, "workspace_id": "company-a", "issuer_id": "issuer-a", "family_id": "family-a", "evidence_version": "v1", "page_geometry": GEOMETRY, "uniform_height": True, "left_pt": 0, "right_pt": 0, "slots": [{"slot_id": "slot-1", "position_index": 1, "top_pt": 0, "height_pt": 440}, {"slot_id": "slot-2", "position_index": 2, "top_pt": 460, "height_pt": 440}]}


def test_apply_reference_reuses_saved_rectangles_without_cross_workspace_mix(tmp_path):
    value = layout()
    store = LayoutTemplateStore(tmp_path / "templates.sqlite3")
    store.save({"source_scope": reference_scope(value), "layout_fingerprint": reference_fingerprint(value), "page_geometry": GEOMETRY, "slots": [{"slot_id": "slot-1", "position_index": 1, "rect": {"x0": 10, "y0": 20, "x1": 590, "y1": 430}}, {"slot_id": "slot-2", "position_index": 2, "rect": {"x0": 10, "y0": 450, "x1": 590, "y1": 860}}], "evidence_summary": {"slot_count": 2}, "source_operation_id": "op-1"})
    prepared = CalibrationPreparation({}, [], {}, "context", {"id": "sample"}, value, (("source", 1),), {})
    updated = apply_reference(prepared, tmp_path / "templates.sqlite3")
    assert updated.layout["left_pt"] == 10
    assert updated.layout["slots"][0]["top_pt"] == 20
    assert updated.layout["slots"][1]["height_pt"] == 410


def test_reference_applies_only_confirmed_slots_when_partial_round_is_saved(tmp_path):
    value = {**layout(), "uniform_height": False}
    database = tmp_path / "templates.sqlite3"
    store = LayoutTemplateStore(database)
    saved = store.save({"source_scope": reference_scope(value), "layout_fingerprint": reference_fingerprint(value),
                        "page_geometry": GEOMETRY, "slots": [{"slot_id": "slot-1", "position_index": 1,
                        "rect": {"x0": 10, "y0": 20, "x1": 590, "y1": 430}}, {"slot_id": "slot-2", "position_index": 2,
                        "rect": {"x0": 10, "y0": 450, "x1": 590, "y1": 860}}],
                        "evidence_summary": {"confirmed_slot_ids": ["slot-1"]}, "source_operation_id": "op-partial"})
    prepared = CalibrationPreparation({}, [], {}, "context", {"id": "sample"}, value, (("source", 1),), {})
    updated = apply_reference(prepared, database)
    assert saved["evidence_summary"]["confirmed_slot_ids"] == ["slot-1"]
    assert updated.layout["slots"][0]["top_pt"] == 20
    assert updated.layout["slots"][1]["top_pt"] == 460
    assert updated.layout["slots"][1]["height_pt"] == 440


def test_reference_is_invalidated_when_shared_parameters_change(tmp_path):
    value = {**layout(), "uniform_height": False}
    database = tmp_path / "templates.sqlite3"
    store = LayoutTemplateStore(database)
    store.save({"source_scope": reference_scope(value), "layout_fingerprint": reference_fingerprint(value),
                "page_geometry": GEOMETRY, "slots": [{"slot_id": "slot-1", "position_index": 1,
                "rect": {"x0": 10, "y0": 20, "x1": 590, "y1": 430}}, {"slot_id": "slot-2", "position_index": 2,
                "rect": {"x0": 10, "y0": 450, "x1": 590, "y1": 860}}],
                "evidence_summary": {"confirmed_slot_ids": ["slot-1"], "shared_parameters":
                                     {"left_pt": 0, "right_pt": 0, "uniform_height": False}}, "source_operation_id": "op-shared"})
    changed = {**value, "left_pt": 12}
    prepared = CalibrationPreparation({}, [], {}, "context", {"id": "sample"}, changed, (("source", 1),), {})
    assert apply_reference(prepared, database).layout["left_pt"] == 12


def test_partial_single_slot_replay_normalizes_uniform_flag_without_resizing_unconfirmed_slot(tmp_path):
    database = tmp_path / "templates.sqlite3"
    saved_layout = layout()
    saved_layout["uniform_height"] = False
    saved_layout["slots"][0] = {**saved_layout["slots"][0], "top_pt": 20, "height_pt": 430}
    saved = save_reference_layout(saved_layout, database, "op-partial", confirmed_slot_ids=["slot-1"])
    reference = historical_reference(saved, workspace_id=saved_layout["workspace_id"])
    assert reference is not None

    target = layout()
    # Reuse the persisted geometry representation so the active-template lookup
    # sees the same PDF identity as a fresh automatic result.
    target["page_geometry"] = saved["evidence_summary"]["layout_definition"]["page_geometry"]
    historical = apply_historical_reference(target, (reference,))
    prepared = CalibrationPreparation({}, [], {}, "context", {"id": "sample"}, target, (("source", 1),), {})
    applied = apply_reference(prepared, database).layout

    for result in (historical, applied):
        assert result is not None
        assert result["uniform_height"] is False
        assert result["slots"][0]["top_pt"] == 20
        assert result["slots"][0]["height_pt"] == 430
        assert result["slots"][1]["top_pt"] == 460
        assert result["slots"][1]["height_pt"] == 440


def test_independent_margins_require_selection_and_updates_never_merge_siblings(tmp_path):
    from copy import deepcopy
    database = tmp_path / "templates.sqlite3"
    first_layout = layout()
    first_layout["left_pt"] = 5
    first = save_reference_layout(first_layout, database, "first", name="窄边", bank_name="示例银行")
    second_layout = deepcopy(first_layout)
    second_layout["left_pt"] = 15
    second = save_reference_layout(second_layout, database, "second", name="宽边")
    refs = tuple(historical_reference(row, workspace_id="company-a") for row in (first, second))
    current = deepcopy(first["evidence_summary"]["layout_definition"])
    current["left_pt"] = 0
    assert len(compatible_historical_references(current, refs)) == 2
    assert apply_historical_reference(current, refs) is None
    assert apply_historical_reference(current, (refs[0],))["left_pt"] == 5
    assert apply_historical_reference(current, (refs[1],))["left_pt"] == 15
    revised = deepcopy(first_layout)
    revised["uniform_height"] = False
    revised["slots"][0]["height_pt"] = 420
    revised["slots"][1]["height_pt"] = 410
    updated = save_reference_layout(revised, database, "update", confirmed_slot_ids=["slot-1"],
                                    save_mode="update", template_id=first["id"])
    assert updated["evidence_summary"]["layout_definition"]["slots"][1]["height_pt"] == 440
    store = LayoutTemplateStore(database)
    assert store.get(second["id"]) == second
    store.withdraw_source_operation("first", "undo")
    assert not store.get(updated["id"])["active"]
    assert store.get(second["id"])["active"]


def test_new_partial_template_does_not_inherit_existing_series(tmp_path):
    database = tmp_path / "templates.sqlite3"
    first = save_reference_layout(layout(), database, "first", name="已有模板", bank_name="示例银行")
    partial = save_reference_layout(layout(), database, "partial", confirmed_slot_ids=["slot-1"])
    assert partial["series_id"] != first["series_id"]
    assert partial["name"] is None and partial["bank_name"] is None
    assert partial["evidence_summary"]["confirmed_slot_ids"] == ["slot-1"]
    assert partial["evidence_summary"]["confirmed_slot_sources"] == {"slot-1": "partial"}


def test_target_preflight_is_read_only_and_bank_label_cannot_authorize_identity(tmp_path):
    import pytest
    from engine.layout_template_store import LayoutTemplateError
    database = tmp_path / "templates.sqlite3"
    assert validate_reference_target(layout(), database) is None
    assert not database.exists()
    saved = save_reference_layout(layout(), database, "saved", bank_name="任意显示名称")
    before = database.read_bytes()
    assert validate_reference_target(layout(), database, "update", saved["id"])["id"] == saved["id"]
    assert database.read_bytes() == before
    for changed in ({"issuer_id": "other"}, {"family_id": "other"}, {"evidence_version": "other"}):
        with pytest.raises(LayoutTemplateError) as error:
            validate_reference_target(layout() | changed, database, "update", saved["id"])
        assert error.value.code == "template_incompatible"
    with pytest.raises(LayoutTemplateError) as error:
        save_reference_layout(layout() | {"issuer_id": None}, database, "unknown", bank_name="示例银行")
    assert error.value.code == "identity_unavailable"
