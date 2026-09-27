import pytest

from engine.layout_template_store import LayoutTemplateError, LayoutTemplateStore


GEOMETRY = {
    "pdf_box": {"x0": 0, "y0": 0, "x1": 600, "y1": 900},
    "rotation": 0, "user_unit": 1, "width_pt": 600, "height_pt": 900,
}
SLOTS = [
    {"slot_id": "slot-1", "position_index": 1, "rect": {"x0": 0, "y0": 0, "x1": 600, "y1": 440}},
    {"slot_id": "slot-2", "position_index": 2, "rect": {"x0": 0, "y0": 460, "x1": 600, "y1": 900}},
]


def template(**overrides):
    value = {
        "source_scope": "workspace-main",
        "layout_fingerprint": "a" * 64,
        "page_geometry": GEOMETRY,
        "slots": SLOTS,
        "evidence_summary": {"title_digest": "b" * 64, "line_count": 2},
        "source_operation_id": "review-op-1",
        "name": "常用两栏",
    }
    value.update(overrides)
    return value


def test_save_match_versions_and_deactivate(tmp_path):
    database = tmp_path / "templates.sqlite3"
    store = LayoutTemplateStore(database)
    first = store.save(template())
    second = store.save(template(source_operation_id="review-op-2", save_mode="update", update_template_id=first["id"]))
    assert first["version"] == 1 and second["version"] == 2
    assert store.match("workspace-main", GEOMETRY, "a" * 64, SLOTS)["id"] == second["id"]
    assert store.deactivate(second["id"])
    assert store.match("workspace-main", GEOMETRY, "a" * 64, SLOTS) is None
    assert not store.get(first["id"])["active"]
    assert not store.deactivate(second["id"])
    reopened = LayoutTemplateStore(database)
    assert reopened.match("workspace-main", GEOMETRY, "a" * 64, SLOTS) is None
    assert reopened.match_reference("workspace-main", GEOMETRY, "a" * 64, SLOTS) is None
    assert reopened.list() == []
    assert all(not row["active"] for row in reopened.list(active_only=False))


def test_explicit_create_after_deactivation_starts_independent_series(tmp_path):
    database = tmp_path / "templates.sqlite3"
    store = LayoutTemplateStore(database)
    first = store.save(template())
    second = store.save(template(source_operation_id="review-op-2", save_mode="update", update_template_id=first["id"]))
    assert store.deactivate(second["id"])

    reopened = LayoutTemplateStore(database)
    third = reopened.save(template(source_operation_id="review-op-3", name="新版模板"))

    assert third["version"] == 1 and third["series_id"] != first["series_id"]
    assert third["active"]
    assert not reopened.get(first["id"])["active"]
    assert not reopened.get(second["id"])["active"]
    assert reopened.match("workspace-main", GEOMETRY, "a" * 64, SLOTS)["id"] == third["id"]


def test_updated_geometry_is_a_new_version_and_old_row_remains_audit_snapshot(tmp_path):
    store = LayoutTemplateStore(tmp_path / "templates.sqlite3")
    first = store.save(template())
    updated_slots = [
        {**SLOTS[0], "rect": {"x0": 8, "y0": 0, "x1": 592, "y1": 440}},
        {**SLOTS[1], "rect": {"x0": 8, "y0": 460, "x1": 592, "y1": 900}},
    ]

    second = store.save(template(slots=updated_slots, source_operation_id="review-op-2", save_mode="update", update_template_id=first["id"]))

    assert second["version"] == first["version"] + 1
    assert second["id"] != first["id"]
    assert store.get(first["id"])["slots"] == SLOTS
    assert store.match_reference("workspace-main", GEOMETRY, "a" * 64, SLOTS)["id"] == second["id"]

    # Disabling the family must not expose any obsolete active version.
    assert store.deactivate(second["id"])
    assert store.match_reference("workspace-main", GEOMETRY, "a" * 64, SLOTS) is None
    assert store.get(second["id"])["slots"] == updated_slots


@pytest.mark.parametrize("field,value", [
    ("layout_fingerprint", "not-a-sha"),
    ("evidence_summary", {"full_text": "private"}),
    ("evidence_summary", {"metadata": {"matched_text": "private"}}),
    ("evidence_summary", {"line_count": float("inf")}),
    ("slots", [{"slot_id": "a", "position_index": 1, "rect": {"x0": 0, "y0": 0, "x1": 600, "y1": 500}},
                {"slot_id": "b", "position_index": 2, "rect": {"x0": 0, "y0": 400, "x1": 600, "y1": 900}}]),
    ("unexpected_payload", "private document text"),
])
def test_invalid_template_is_rejected(tmp_path, field, value):
    store = LayoutTemplateStore(tmp_path / "templates.sqlite3")
    with pytest.raises(LayoutTemplateError):
        store.save(template(**{field: value}))


def test_geometry_mismatch_and_scope_isolation(tmp_path):
    store = LayoutTemplateStore(tmp_path / "templates.sqlite3")
    saved = store.save(template())
    changed = {**GEOMETRY, "height_pt": 901, "pdf_box": {"x0": 0, "y0": 0, "x1": 600, "y1": 901}}
    assert store.match("other-workspace", GEOMETRY, "a" * 64, SLOTS) is None
    assert store.match("workspace-main", changed, "a" * 64, SLOTS) is None
    assert store.get(saved["id"])["active"]


def test_reference_match_reuses_calibrated_rectangles_for_same_slot_shape(tmp_path):
    store = LayoutTemplateStore(tmp_path / "templates.sqlite3")
    saved = store.save(template())
    incoming = [
        {**SLOTS[0], "rect": {"x0": 0, "y0": 10, "x1": 600, "y1": 450}},
        {**SLOTS[1], "rect": {"x0": 0, "y0": 470, "x1": 600, "y1": 890}},
    ]
    reference = store.match_reference("workspace-main", GEOMETRY, "a" * 64, incoming)
    assert reference["id"] == saved["id"]
    assert reference["slots"] == SLOTS


def test_withdraw_source_operation_is_idempotent_and_blocks_future_templates(tmp_path):
    store = LayoutTemplateStore(tmp_path / "templates.sqlite3")
    saved = store.save(template(source_operation_id="review-op-withdraw"))
    first = store.withdraw_source_operation("review-op-withdraw", "undo-42")
    assert first["operation_id"] == "review-op-withdraw"
    assert first["undo_id"] == "undo-42"
    assert first["deactivated_count"] == 1
    assert not store.get(saved["id"])["active"]
    assert store.is_source_operation_withdrawn("review-op-withdraw")
    second = store.withdraw_source_operation("review-op-withdraw", "undo-new")
    assert second["undo_id"] == "undo-42"
    assert second["deactivated_count"] == 0
    with pytest.raises(LayoutTemplateError, match="withdrawn"):
        store.save(template(source_operation_id="review-op-withdraw"))


def test_same_form_templates_have_independent_names_versions_and_lifecycles(tmp_path):
    store = LayoutTemplateStore(tmp_path / "templates.sqlite3")
    first = store.save(template(bank_name="示例银行", name="窄留白"))
    second = store.save(template(source_operation_id="second", name="宽留白"))
    assert first["version"] == second["version"] == 1
    assert first["series_id"] != second["series_id"]
    assert second["bank_name"] is None
    assert store.match("workspace-main", GEOMETRY, "a" * 64, SLOTS) is None
    assert store.match_reference("workspace-main", GEOMETRY, "a" * 64, SLOTS) is None
    store.rename(first["id"], "常用留白")
    updated = store.save(template(source_operation_id="update-first", name=None, save_mode="update", update_template_id=first["id"]))
    assert updated["version"] == 2 and updated["series_id"] == first["series_id"]
    assert updated["name"] == "常用留白" and updated["bank_name"] == "示例银行"
    assert store.get(second["id"]) == second
    assert store.deactivate(first["id"])
    assert store.match("workspace-main", GEOMETRY, "a" * 64, SLOTS)["id"] == second["id"]


def test_update_requires_latest_active_target_and_compatible_identity(tmp_path):
    store = LayoutTemplateStore(tmp_path / "templates.sqlite3")
    first = store.save(template())
    for overrides in ({"source_scope": "other"}, {"layout_fingerprint": "b" * 64}):
        with pytest.raises(LayoutTemplateError) as error:
            store.save(template(source_operation_id="bad", save_mode="update", update_template_id=first["id"], **overrides))
        assert error.value.code == "template_incompatible"
    second = store.save(template(source_operation_id="update", save_mode="update", update_template_id=first["id"]))
    for target in (first["id"], second["id"]):
        if target == second["id"]:
            store.deactivate(target)
        with pytest.raises(LayoutTemplateError) as error:
            store.save(template(source_operation_id="stale", save_mode="update", update_template_id=target))
        assert error.value.code == "template_conflict"
    assert len(store.list(active_only=False)) == 2


def test_save_retry_is_bound_to_action_target_and_original_input(tmp_path):
    store = LayoutTemplateStore(tmp_path / "templates.sqlite3")
    first = store.save(template())
    other = store.save(template(source_operation_id="other"))
    request = template(source_operation_id="update", save_mode="update", update_template_id=first["id"])
    saved = store.save(request)
    assert store.save(request) == saved
    for change in ({"save_mode": "create", "update_template_id": None},
                   {"update_template_id": other["id"]}, {"name": "changed"}, {"bank_name": "changed"}):
        with pytest.raises(LayoutTemplateError) as error:
            store.save(request | change)
        assert error.value.code == "operation_conflict"
    assert len(store.list(active_only=False)) == 3


@pytest.mark.parametrize("changes", [{"save_mode": "unknown"}, {"save_mode": "update"},
    {"update_template_id": "unexpected"}, {"bank_name": ""}, {"bank_name": "x" * 81}])
def test_invalid_save_selection_or_bank_label_is_rejected(tmp_path, changes):
    store = LayoutTemplateStore(tmp_path / "templates.sqlite3")
    with pytest.raises(LayoutTemplateError):
        store.save(template(**changes))
    assert store.list(active_only=False) == []
