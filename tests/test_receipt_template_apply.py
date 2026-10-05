"""Applying an existing layout template to an already analyzed receipt task."""

from copy import deepcopy
from hashlib import sha256

import pytest

from engine.batch_api import _dispatch
from engine.batch_models import canonical_json
from engine.batch_pdf import open_batch_source
from engine.batch_review import read_batch_receipt_review_page, save_batch_receipt_review
from engine.batch_store import BatchStore, BatchConflict
from engine.layout_template_store import LayoutTemplateStore
from engine.receipt_calibration_journal import undo_calibration_operation
from engine.receipt_checkpoint import encode_receipt_checkpoint
from engine.receipt_layout_history import TemplateUnavailableError
from engine.receipt_layout_review import TemplateNoTargetsError
from engine.receipt_layout_reference import save_reference_layout
from engine.receipt_snapshot import assemble_receipt_results
from engine.receipt_layout_calibration import validate_complete_layout
from engine.search import SearchBudget
from tests.test_batch_receipt_review_api import _make_edit
from tests.test_receipt_batch_pdf import ALL
from tests.test_receipt_layout_review import _draft, _pdf, _prepared, _ready, private_temp


def _apply(store, ready, review, templates, template_id):
    return _dispatch(store, "batch_receipt_template_apply_preview", {
        "job_id": ready["id"], "result_revision": ready["result_revision"],
        "template_id": template_id, "review_database_path": str(review),
        "template_database_path": str(templates),
    })


def _save(store, ready, review, templates, preview):
    return _dispatch(store, "batch_receipt_calibration_save", {
        "job_id": ready["id"], "operation_id": preview["operation_id"],
        "preview_fingerprint": preview["preview_fingerprint"],
        "acknowledged_risk_ids": [risk["risk_id"] for risk in preview["risks"]],
        "remember_reference": False, "review_database_path": str(review),
        "template_database_path": str(templates),
    })


def test_partial_template_changes_only_confirmed_boundary_but_reviews_all_slots_after_restart(tmp_path):
    database, review, templates = (tmp_path / name for name in
                                   ("tasks.sqlite3", "review.sqlite3", "pdf-search.sqlite3"))
    with BatchStore(database) as store:
        ready = _ready(store, [_pdf(tmp_path, "target", counts=(3, 3))], ALL)
        prepared = _prepared(store, ready, review)
        template = save_reference_layout(_draft(prepared), templates, "approved-layout",
                                         confirmed_slot_ids=["slot-1"])
        before = store.read_page_results(ready["id"])
        preview = _apply(store, ready, review, templates, template["id"])
        assert preview["mode"] == "template_apply"
        assert preview["applied_slot_ids"] == ["slot-1"]
        assert preview["can_save"] and preview["page_count"] == 2
        assert {item["slot_id"] for item in preview["affected"]} == {"slot-1", "slot-2", "slot-3"}
        assert all(item["before_rect"] == item["after_rect"] for item in preview["affected"]
                   if item["slot_id"] != "slot-1")
        assert store.read_page_results(ready["id"]) == before
        with pytest.raises(BatchConflict, match="cannot save a new template"):
            _dispatch(store, "batch_receipt_calibration_save", {
                "job_id": ready["id"], "operation_id": preview["operation_id"],
                "preview_fingerprint": preview["preview_fingerprint"],
                "acknowledged_risk_ids": [risk["risk_id"] for risk in preview["risks"]],
                "review_database_path": str(review), "template_database_path": str(templates),
            })
        saved = _save(store, ready, review, templates, preview)
        assert saved["state"] == "applied" and saved["saved_count"] == 6
        result_revision = saved["result_revision"]
    with BatchStore(database) as store:
        page = read_batch_receipt_review_page(store, ready["id"], result_revision, 0, 20, review)
        assert len(page["items"]) == 6
        for item in page["items"]:
            assert item["record"] is None
            assert item["original"]["needs_review"] is True


def test_template_application_isolates_classification_but_reuses_nonexcluded_slots(tmp_path):
    review, templates = tmp_path / "review.sqlite3", tmp_path / "pdf-search.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "target", counts=(3, 3, 3))], ALL)
        prepared = _prepared(store, ready, review)
        originals = store.review_snapshot(ready["id"], ready["result_revision"])["originals"]
        classified = next(item for item in originals if item["source_page"] == 1)
        excluded = next(item for item in originals if item["source_page"] == 2)
        special_edit = _make_edit(prepared.context_key, ready["result_revision"], classified)
        special_edit["document_type"] = "other_special"
        exclude_edit = _make_edit(prepared.context_key, ready["result_revision"], excluded)
        exclude_edit["review_status"] = "excluded"
        save_batch_receipt_review(store, ready["id"], ready["result_revision"],
                                  [special_edit, exclude_edit], review)
        template = save_reference_layout(_draft(prepared), templates, "approved-layout")
        preview = _apply(store, ready, review, templates, template["id"])
        assert preview["page_count"] == 2
        assert preview["preserved_excluded_count"] == 1
        assert preview["excluded_page_counts"]["manual_classification_scope"] == 1
        assert preview["page_count"] + sum(preview["excluded_page_counts"].values()) == 3
        assert {item["page"] for item in preview["affected"]} == {2, 3}
        assert {item["slot_id"] for item in preview["affected"] if item["page"] == 2} == {"slot-2", "slot-3"}
        saved = _save(store, ready, review, templates, preview)
        page = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 20, review)
        records = {item["original"]["source_page"]: [] for item in page["items"]}
        for item in page["items"]:
            records[item["original"]["source_page"]].append(item["record"])
        assert any(record and record.get("document_type") == "other_special" for record in records[1])
        assert any(record and record["review_status"] == "excluded" for record in records[2])
        assert sum(record is None for record in records[2]) == 2
        rebound = next(item["record"] for item in page["items"]
                       if item["original"]["source_page"] == 2 and item["original"]["slot_id"] == excluded["slot_id"])
        assert rebound["original"]["id"] != excluded["id"]
        protected_fields = ("final_rect", "crop_mode", "manual_adjusted", "review_status", "reviewed_at")
        assert {field: rebound[field] for field in protected_fields} == \
            {field: exclude_edit[field] for field in protected_fields}
        assert all(record is None for record in records[3])
        assert all(item["original"]["needs_review"] for item in page["items"]
                   if item["original"]["source_page"] == 3 or
                   (item["original"]["source_page"] == 2 and item["original"]["slot_id"] != excluded["slot_id"]))
        undo = undo_calibration_operation(store, ready["id"], preview["operation_id"], review,
                                          undo_id="undo-template-application", template_database=templates)
        assert undo["state"] == "undone"
        reverted = read_batch_receipt_review_page(store, ready["id"], ready["result_revision"], 0, 20, review)
        assert any(item["record"] and item["record"].get("document_type") == "other_special"
                   for item in reverted["items"])
        assert any(item["record"] and item["record"]["review_status"] == "excluded"
                   for item in reverted["items"])
        assert next(item["record"]["original"]["id"] for item in reverted["items"]
                    if item["original"]["source_page"] == 2 and item["original"]["slot_id"] == excluded["slot_id"]) == excluded["id"]
        assert all(item["record"] is None for item in reverted["items"]
                   if item["original"]["source_page"] == 3)


def test_excluded_page_with_different_shared_margin_is_skipped(tmp_path):
    review, templates = tmp_path / "review.sqlite3", tmp_path / "pdf-search.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "target", counts=(3, 3))], ALL)
        prepared = _prepared(store, ready, review)
        originals = store.review_snapshot(ready["id"], ready["result_revision"])["originals"]
        excluded = next(item for item in originals if item["source_page"] == 1)
        edit = _make_edit(prepared.context_key, ready["result_revision"], excluded)
        edit["review_status"] = "excluded"
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [edit], review)
        draft = deepcopy(_draft(prepared))
        draft["left_pt"] += 2
        draft = validate_complete_layout(draft)
        template = save_reference_layout(draft, templates, "shifted-margins")
        preview = _apply(store, ready, review, templates, template["id"])
        assert preview["page_count"] == 1
        assert preview["excluded_page_counts"]["excluded_shared_geometry_scope"] == 1
        assert {item["page"] for item in preview["affected"]} == {2}


def test_changed_excluded_candidate_state_blocks_template_round(tmp_path, monkeypatch):
    review, templates = tmp_path / "review.sqlite3", tmp_path / "pdf-search.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "target", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        excluded = store.review_snapshot(ready["id"], ready["result_revision"])["originals"][0]
        edit = _make_edit(prepared.context_key, ready["result_revision"], excluded)
        edit["review_status"] = "excluded"
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [edit], review)
        template = save_reference_layout(_draft(prepared), templates, "approved-layout")
        import engine.receipt_layout_review as module
        real_preserve = module._preserve_unedited_candidate_review

        def altered(*args, **kwargs):
            payload = real_preserve(*args, **kwargs)
            by_id = {item["instance_id"]: item for item in payload["receipt_page"]["instances"]}
            candidate = next(item for item in payload["receipt_page"]["candidates"]
                             if by_id[item["instance_id"]]["slot_id"] == excluded["slot_id"])
            candidate["needs_review"] = not candidate["needs_review"]
            return payload

        monkeypatch.setattr(module, "_preserve_unedited_candidate_review", altered)
        preview = _apply(store, ready, review, templates, template["id"])
        assert not preview["can_save"]
        assert any(item["code"] == "excluded_template_protection" for item in preview["blockers"])
        with pytest.raises(BatchConflict, match="unresolved"):
            _save(store, ready, review, templates, preview)
        assert store.get_job(ready["id"])["result_revision"] == ready["result_revision"]


@pytest.mark.parametrize("tamper", ["protected_rect", "neighbor_overlap"])
def test_changed_excluded_geometry_or_overlap_blocks_template_round(tmp_path, monkeypatch, tamper):
    review, templates = tmp_path / "review.sqlite3", tmp_path / "pdf-search.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "target", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        excluded = store.review_snapshot(ready["id"], ready["result_revision"])["originals"][0]
        edit = _make_edit(prepared.context_key, ready["result_revision"], excluded)
        edit["review_status"] = "excluded"
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [edit], review)
        template = save_reference_layout(_draft(prepared), templates, "approved-layout")
        import engine.receipt_layout_review as module
        real_assemble = module.assemble_receipt_results

        def altered(*args, **kwargs):
            proposed = real_assemble(*args, **kwargs)
            target_slot = excluded["slot_id"] if tamper == "protected_rect" else "slot-2"
            target = next(item for item in proposed["originals"] if item["slot_id"] == target_slot)
            target["candidate_rect"] = deepcopy(excluded["candidate_rect"])
            if tamper == "protected_rect":
                target["candidate_rect"]["y0"] += 1
            return proposed

        monkeypatch.setattr(module, "assemble_receipt_results", altered)
        preview = _apply(store, ready, review, templates, template["id"])
        assert not preview["can_save"]
        assert any(item["code"] == "excluded_template_protection" for item in preview["blockers"])


def test_concurrent_exclusion_invalidates_pending_template_preview(tmp_path):
    review, templates = tmp_path / "review.sqlite3", tmp_path / "pdf-search.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "target", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        originals = store.review_snapshot(ready["id"], ready["result_revision"])["originals"]
        first = _make_edit(prepared.context_key, ready["result_revision"], originals[0])
        first["review_status"] = "excluded"
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [first], review)
        template = save_reference_layout(_draft(prepared), templates, "approved-layout")
        preview = _apply(store, ready, review, templates, template["id"])
        second = _make_edit(prepared.context_key, ready["result_revision"], originals[1])
        second["review_status"] = "excluded"
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [second], review)
        with pytest.raises(BatchConflict, match="stale|changed"):
            _save(store, ready, review, templates, preview)


def test_deactivated_template_rejects_new_preview_and_pending_save(tmp_path):
    review, templates = tmp_path / "review.sqlite3", tmp_path / "pdf-search.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "target", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        template = save_reference_layout(_draft(prepared), templates, "approved-layout")
        preview = _apply(store, ready, review, templates, template["id"])
        LayoutTemplateStore(templates).deactivate(template["id"])
        with pytest.raises(TemplateUnavailableError):
            _apply(store, ready, review, templates, template["id"])
        with pytest.raises(TemplateUnavailableError):
            _save(store, ready, review, templates, preview)
        assert store.get_job(ready["id"])["result_revision"] == ready["result_revision"]


def test_matching_unchanged_template_still_requires_review_of_auto_candidates(tmp_path):
    review, templates = tmp_path / "review.sqlite3", tmp_path / "pdf-search.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "target", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        template = save_reference_layout(prepared.layout, templates, "approved-automatic-frame")
        preview = _apply(store, ready, review, templates, template["id"])
        assert preview["can_save"] and len(preview["affected"]) == 3
        assert all(item["before_rect"] == item["after_rect"] for item in preview["affected"])
        saved = _save(store, ready, review, templates, preview)
        page = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 20, review)
        assert all(item["original"]["needs_review"] and item["record"] is None
                   for item in page["items"])


def test_unreviewed_task_can_switch_templates_until_a_user_decides(tmp_path):
    review, templates = tmp_path / "review.sqlite3", tmp_path / "pdf-search.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "target", counts=(3, 3))], ALL)
        prepared = _prepared(store, ready, review)
        first_layout = _draft(prepared)
        second_layout = deepcopy(first_layout)
        for slot in second_layout["slots"]:
            slot["height_pt"] -= 5
        first_template = save_reference_layout(first_layout, templates, "first-approved-layout")
        second_template = save_reference_layout(second_layout, templates, "second-approved-layout")
        first_preview = _apply(store, ready, review, templates, first_template["id"])
        first_saved = _save(store, ready, review, templates, first_preview)
        current = {**ready, "result_revision": first_saved["result_revision"]}
        # All six candidates are pending from checkpoint evidence, but none is
        # falsely stored as a human review decision.
        before = read_batch_receipt_review_page(store, ready["id"], current["result_revision"], 0, 20, review)
        assert all(item["original"]["needs_review"] and item["record"] is None
                   for item in before["items"])
        second_preview = _apply(store, current, review, templates, second_template["id"])
        assert second_preview["can_save"] and second_preview["page_count"] == 2
        assert second_preview["excluded_page_counts"] == {}
        second_saved = _save(store, current, review, templates, second_preview)
        current = {**ready, "result_revision": second_saved["result_revision"]}
        prepared = _prepared(store, current, review)
        decided = _make_edit(prepared.context_key, current["result_revision"], prepared.sample)
        save_batch_receipt_review(store, ready["id"], current["result_revision"], [decided], review)
        third_preview = _apply(store, current, review, templates, first_template["id"])
        assert third_preview["page_count"] == 1
        assert third_preview["excluded_page_counts"]["prior_review_scope"] == 1
        assert {item["page"] for item in third_preview["affected"]} == {2}


def test_incompatible_bank_template_does_not_apply_to_existing_result(tmp_path):
    review, templates = tmp_path / "review.sqlite3", tmp_path / "pdf-search.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        target = _ready(store, [_pdf(tmp_path, "target", counts=(3,))], ALL)
        _prepared(store, target, review)
        other = _ready(store, [_pdf(tmp_path, "other", title="中国民生银行业务回单", counts=(3,))], ALL)
        prepared = _prepared(store, other, review)
        template = save_reference_layout(_draft(prepared), templates, "other-bank-layout")
        with pytest.raises(TemplateNoTargetsError):
            _apply(store, target, review, templates, template["id"])


def test_page_layout_change_also_changes_unchanged_protected_slot_identity(tmp_path):
    """Why pages with an excluded/special receipt must remain outside this mode."""
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "target", counts=(3,))], ALL)
        _prepared(store, ready, review)
        previous = store.review_snapshot(ready["id"], ready["result_revision"])["originals"]
        row = store.read_page_results(ready["id"])[0]
        draft = deepcopy(row["payload"]["receipt_page"]["layout_definition"])
        draft["revision"] += 1
        draft["uniform_height"] = False
        draft["slots"][0]["height_pt"] -= 3
        source = ready["sources"][0]
        with open_batch_source(source["access_path"], source["sha256"]) as opened:
            computed = opened.compute_receipt_page(
                1, ready["processing_options"], ready["match_mode"], SearchBudget(),
                layout_definition=draft)
        payload = encode_receipt_checkpoint(computed)
        updated = {**row, "payload": payload, "sha256": sha256(canonical_json(payload)).hexdigest()}
        proposed = assemble_receipt_results(
            ready["id"], ready["sources"], ready["processing_options"], ready["match_mode"],
            ready["computation_version"], [updated])
        before = next(item for item in previous if item["slot_id"] == "slot-3")
        after = next(item for item in proposed["originals"] if item["slot_id"] == "slot-3")
        assert before["candidate_rect"] == after["candidate_rect"]
        assert before["instance_id"] != after["instance_id"]
        assert before["id"] != after["id"]
        assert before["layout_signature"] != after["layout_signature"]
