"""Manual per-receipt types cannot leak through whole-page calibration."""
from copy import deepcopy

import pymupdf
import pytest

from engine.batch_review import prepare_batch_review, read_batch_receipt_review_page, save_batch_receipt_review
from engine.batch_store import BatchConflict, BatchStore
from engine.layout_template_store import LayoutTemplateError
from engine.receipt_calibration_journal import retain_calibration_preview, save_calibration_preview, undo_calibration_operation
from engine.receipt_layout_reference import apply_reference, save_reference
from engine.receipt_layout_review import prepare_receipt_calibration, preview_receipt_calibration
from engine.receipt_layout_models import ReceiptLayoutError
from tests.test_batch_receipt_review_api import _make_edit
from tests.test_receipt_batch_pdf import ALL, make_source
from tests.test_receipt_layout_review import _pdf, _ready, private_temp


def _setup(store, tmp_path, *, search=False, counts=(3, 3), last_page_shift=0):
    if last_page_shift:
        source_folder = tmp_path / "source"
        source_folder.mkdir()
        path = make_source(source_folder, counts=counts, last_page_shift=last_page_shift)
    else:
        path = _pdf(tmp_path, "source", counts=counts)
    options = ALL
    if search:
        with pymupdf.open(path) as source:
            for page in source:
                page.insert_text((350, 150), "UNIQUE")
            source.saveIncr()
        options = {"processing_mode": "search", "criteria": {"include": ["UNIQUE"], "includeMode": "all", "exclude": []}}
    review = tmp_path / "review.sqlite3"
    ready = _ready(store, [path], options)
    binding = prepare_batch_review(store, ready["id"], ready["result_revision"], review)
    originals = store.review_snapshot(ready["id"], ready["result_revision"])["originals"]
    return ready, review, binding["prepared"]["context_key"], originals


def _classify(store, ready, review, context, original, kind="other_special", status="confirmed"):
    edit = _make_edit(context, ready["result_revision"], original)
    edit.update(document_type=kind, review_status=status)
    save_batch_receipt_review(store, ready["id"], ready["result_revision"], [edit], review)


def _prepare(store, ready, review, original):
    return prepare_receipt_calibration(store, ready["id"], ready["result_revision"], original["id"], review)


def _draft(prepared):
    draft = deepcopy(prepared.layout)
    draft["revision"] += 1
    draft["uniform_height"] = False
    next(slot for slot in draft["slots"] if slot["slot_id"] == prepared.sample["slot_id"])["height_pt"] -= 2
    return draft


def _save(store, ready, review, retained, **kwargs):
    return save_calibration_preview(store, ready["id"], retained["operation_id"], retained["preview_fingerprint"], review,
        acknowledged_risk_ids=[risk["risk_id"] for risk in retained["risks"]], remember_reference=False, **kwargs)


def _items(store, ready, review, revision=None):
    return read_batch_receipt_review_page(store, ready["id"], revision or ready["result_revision"], 0, 200, review)["items"]


def _slot_key(value):
    original = value["original"]
    return original["source_key"], original["source_page"], original["slot_id"]


@pytest.mark.parametrize("kind", ["other_special", "ordinary", "loan_interest_notice"])
def test_ordinary_calibration_excludes_entire_manually_classified_page(tmp_path, kind):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, context, originals = _setup(store, tmp_path)
        _classify(store, ready, review, context, originals[0], kind)
        before = _items(store, ready, review)[0]
        prepared = _prepare(store, ready, review, originals[3])
        assert prepared.view()["page_count"] == 1
        assert prepared.view()["excluded_page_counts"] == {"manual_classification_scope": 1}
        assert "editable_slot_ids" not in prepared.view()
        preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
        assert {item["page"] for item in preview.affected} == {2}
        saved = _save(store, ready, review, retain_calibration_preview(store, preview, review))
        after = _items(store, ready, review, saved["result_revision"])[0]
        assert after["original"] == before["original"]
        for field in ("final_rect", "review_status", "document_type", "reviewed_at"):
            assert after["record"][field] == before["record"][field]


@pytest.mark.parametrize("selected_index", [0, 1], ids=["special-slot", "ordinary-neighbor"])
def test_mixed_page_calibration_changes_only_selected_slot_and_retains_other_types_and_decisions(tmp_path, selected_index):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, context, originals = _setup(store, tmp_path)
        _classify(store, ready, review, context, originals[0])
        _classify(store, ready, review, context, originals[2], "loan_interest_notice", "needs_review")
        save_batch_receipt_review(store, ready["id"], ready["result_revision"],
            [_make_edit(context, ready["result_revision"], originals[1])], review)
        before = _items(store, ready, review)
        prepared = _prepare(store, ready, review, originals[selected_index])
        assert prepared.view()["editable_slot_ids"] == [originals[selected_index]["slot_id"]]
        assert prepared.view()["template_allowed"] is False
        assert prepared.view()["page_count"] == 1
        preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
        assert preview.can_save, preview.blockers
        assert len(preview.affected) == 1
        assert preview.view()["template_allowed"] is False
        retained = retain_calibration_preview(store, preview, review)
        saved = _save(store, ready, review, retained)
        after = _items(store, ready, review, saved["result_revision"])
        for index, prior in enumerate(before):
            assert after[index].get("page_notice") == prior.get("page_notice")
            if prior["record"]:
                assert after[index]["record"].get("document_type") == prior["record"].get("document_type")
            if index == selected_index:
                assert after[index]["record"]["final_rect"]["y1"] == prior["record"]["final_rect"]["y1"] - 2
                continue
            assert after[index]["original"]["candidate_rect"] == prior["original"]["candidate_rect"]
            if prior["record"]:
                for field in ("final_rect", "review_status", "reviewed_at"):
                    assert after[index]["record"][field] == prior["record"][field]
            else:
                # A protected one-slot edit must not manufacture a confirmed
                # review decision for untouched automatic candidates. Their
                # candidate risk state remains the source of truth.
                assert after[index]["record"] is None
                assert after[index]["original"]["needs_review"] == prior["original"]["needs_review"]
        undone = undo_calibration_operation(store, ready["id"], retained["operation_id"], review)
        restored = _items(store, ready, review, undone["result_revision"])
        assert restored[0]["record"]["document_type"] == "other_special"
        assert restored[2]["record"]["document_type"] == "loan_interest_notice"
        assert restored[2]["record"]["review_status"] == "needs_review"


def test_one_slot_calibration_preserves_untouched_automatic_and_pending_candidates(tmp_path):
    task_database = tmp_path / "tasks.sqlite3"
    review = tmp_path / "review.sqlite3"
    with BatchStore(task_database) as store:
        # The short, shifted tail page is an intentionally pending automatic
        # candidate. Page 1 keeps an untouched automatic neighbor beside the
        # selected special document.
        ready, review, context, originals = _setup(
            store, tmp_path, counts=(3, 2), last_page_shift=2
        )
        _classify(store, ready, review, context, originals[0], "other_special", "needs_review")
        _classify(store, ready, review, context, originals[1], "ordinary", "excluded")
        before = {_slot_key(item): item for item in _items(store, ready, review)}
        automatic_key = (originals[0]["source_key"], 1, "slot-3")
        pending_key = (originals[0]["source_key"], 2, "slot-1")
        assert before[automatic_key]["record"] is None
        assert before[automatic_key]["original"]["needs_review"] is False
        assert before[pending_key]["record"] is None
        assert before[pending_key]["original"]["needs_review"] is True

        prepared = _prepare(store, ready, review, originals[0])
        preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
        assert preview.can_save, preview.blockers
        assert len(preview.affected) == 1
        retained = retain_calibration_preview(store, preview, review)
        saved = _save(store, ready, review, retained)
        assert saved["saved_count"] == 1
        after = {_slot_key(item): item for item in _items(store, ready, review, saved["result_revision"])}

        assert after[automatic_key]["record"] is None
        assert after[automatic_key]["original"]["needs_review"] is False
        assert after[pending_key]["record"] is None
        assert after[pending_key]["original"]["needs_review"] is True
        assert after[(originals[0]["source_key"], 1, "slot-1")]["record"]["review_status"] == "confirmed"
        excluded = after[(originals[0]["source_key"], 1, "slot-2")]["record"]
        assert excluded["review_status"] == "excluded"
        assert excluded["document_type"] == "ordinary"

    # Reopening the durable stores must expose the same projection, and a
    # repeated save request must be idempotent rather than adding decisions.
    with BatchStore(task_database) as reopened:
        retry = _save(reopened, ready, review, retained)
        assert retry == saved
        reopened_items = {_slot_key(item): item for item in _items(reopened, ready, review, saved["result_revision"])}
        assert reopened_items == after

        undone = undo_calibration_operation(reopened, ready["id"], retained["operation_id"], review)
        restored = {_slot_key(item): item for item in _items(reopened, ready, review, undone["result_revision"])}
        assert restored[automatic_key]["record"] is None
        assert restored[automatic_key]["original"]["needs_review"] is False
        assert restored[pending_key]["record"] is None
        assert restored[pending_key]["original"]["needs_review"] is True
        assert restored[(originals[0]["source_key"], 1, "slot-1")]["record"]["document_type"] == "other_special"
        assert restored[(originals[0]["source_key"], 1, "slot-1")]["record"]["review_status"] == "needs_review"
        assert restored[(originals[0]["source_key"], 1, "slot-2")]["record"]["review_status"] == "excluded"


@pytest.mark.parametrize("change", ["left", "right", "neighbor", "uniform", "delete", "rename", "position"])
def test_classified_page_rejects_shared_or_neighbor_or_structural_changes(tmp_path, change):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, context, originals = _setup(store, tmp_path)
        _classify(store, ready, review, context, originals[0])
        prepared = _prepare(store, ready, review, originals[0])
        draft = deepcopy(prepared.layout)
        if change in {"left", "right"}:
            draft[f"{change}_pt"] += 2
        elif change == "neighbor":
            draft["slots"][1]["height_pt"] -= 2
        elif change == "uniform":
            draft["uniform_height"] = True
        elif change == "delete":
            draft["slots"].pop()
        elif change == "rename":
            draft["slots"][0]["slot_id"] = "renamed-slot"
        else:
            draft["slots"][0]["position_index"] = 4
        with pytest.raises((BatchConflict, ReceiptLayoutError)):
            preview_receipt_calibration(store, prepared, draft, review)


def test_keyword_unmatched_neighbor_remains_locked_in_full_page_layout(tmp_path):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, context, originals = _setup(store, tmp_path, search=True)
        assert len(originals) == 2
        _classify(store, ready, review, context, originals[0])
        prepared = _prepare(store, ready, review, originals[0])
        assert len(prepared.layout["slots"]) == 3
        draft = _draft(prepared)
        draft["slots"][1]["height_pt"] -= 2
        with pytest.raises(BatchConflict, match="selected slot"):
            preview_receipt_calibration(store, prepared, draft, review)
        ordinary = _prepare(store, ready, review, originals[1])
        assert ordinary.view()["page_count"] == 1


def test_protected_slot_calibration_preserves_excluded_neighbor_and_its_classification(tmp_path):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, context, originals = _setup(store, tmp_path)
        _classify(store, ready, review, context, originals[0])
        _classify(store, ready, review, context, originals[1], "ordinary", "excluded")
        before = _items(store, ready, review)[1]
        prepared = _prepare(store, ready, review, originals[0])
        preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
        assert preview.can_save
        saved = _save(store, ready, review, retain_calibration_preview(store, preview, review))
        after = _items(store, ready, review, saved["result_revision"])[1]
        assert after["original"]["instance_id"] != before["original"]["instance_id"]
        for field in ("final_rect", "review_status", "reviewed_at", "document_type"):
            assert after["record"][field] == before["record"][field]
        assert after["record"]["review_status"] == "excluded"


def test_manual_classification_invalidates_prepared_and_persisted_previews(tmp_path):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, context, originals = _setup(store, tmp_path)
        prepared = _prepare(store, ready, review, originals[3])
        preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
        retained = retain_calibration_preview(store, preview, review)
        _classify(store, ready, review, context, originals[0])
        with pytest.raises(BatchConflict, match="decisions changed"):
            preview_receipt_calibration(store, prepared, _draft(prepared), review)
        with pytest.raises(BatchConflict, match="stale"):
            _save(store, ready, review, retained)


def test_keyword_boundary_cannot_silently_drop_a_manual_classification(tmp_path):
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, context, originals = _setup(store, tmp_path, search=True)
        _classify(store, ready, review, context, originals[0])
        prepared = _prepare(store, ready, review, originals[0])
        draft = _draft(prepared)
        draft["slots"][0]["height_pt"] = 70
        preview = preview_receipt_calibration(store, prepared, draft, review)
        assert not preview.can_save
        assert any(item.get("code") == "manual_classification_membership" for item in preview.blockers)


def test_manual_classification_cannot_apply_or_register_templates_including_retry(tmp_path):
    templates = tmp_path / "templates.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, context, originals = _setup(store, tmp_path)
        _classify(store, ready, review, context, originals[0])
        prepared = _prepare(store, ready, review, originals[0])
        assert apply_reference(prepared, templates) is prepared
        assert not templates.exists()
        preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
        with pytest.raises(LayoutTemplateError, match="independent template identity"):
            save_reference(preview, templates, "manual")
        retained = retain_calibration_preview(store, preview, review)
        arguments = dict(acknowledged_risk_ids=[risk["risk_id"] for risk in retained["risks"]],
                         remember_reference=True, template_database=templates)
        with pytest.raises(BatchConflict, match="layout template"):
            save_calibration_preview(store, ready["id"], retained["operation_id"], retained["preview_fingerprint"], review, **arguments)
        _save(store, ready, review, retained)
        with pytest.raises(BatchConflict, match="layout template"):
            save_calibration_preview(store, ready["id"], retained["operation_id"], retained["preview_fingerprint"], review, **arguments)
        assert not templates.exists()


@pytest.mark.parametrize("initial_template_failure", [False, True], ids=["opted-out", "storage-failed"])
def test_old_ordinary_round_cannot_register_template_after_manual_classification(tmp_path, monkeypatch, initial_template_failure):
    from engine import receipt_layout_reference as reference

    templates = tmp_path / "templates.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready, review, context, originals = _setup(store, tmp_path)
        prepared = _prepare(store, ready, review, originals[0])
        preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
        retained = retain_calibration_preview(store, preview, review)
        arguments = dict(acknowledged_risk_ids=[risk["risk_id"] for risk in retained["risks"]], template_database=templates)
        real_save = reference.save_reference
        if initial_template_failure:
            monkeypatch.setattr(reference, "save_reference", lambda *_a, **_k: (_ for _ in ()).throw(OSError("storage unavailable")))
        saved = save_calibration_preview(store, ready["id"], retained["operation_id"], retained["preview_fingerprint"], review,
                                        remember_reference=initial_template_failure, **arguments)
        assert saved["state"] == "applied"
        assert saved["reference_state"] == ("failed" if initial_template_failure else "disabled")
        monkeypatch.setattr(reference, "save_reference", real_save)
        item = _items(store, ready, review, saved["result_revision"])[0]
        edit = _make_edit(context, saved["result_revision"], item["original"], item["record_revision"])
        edit.update(document_type="other_special", review_status="needs_review")
        save_batch_receipt_review(store, ready["id"], saved["result_revision"], [edit], review)
        if not initial_template_failure:
            with pytest.raises(BatchConflict, match="destination"):
                save_calibration_preview(store, ready["id"], retained["operation_id"], retained["preview_fingerprint"], review,
                                         remember_reference=True, **arguments)
        else:
            retried = save_calibration_preview(store, ready["id"], retained["operation_id"], retained["preview_fingerprint"], review,
                                              remember_reference=True, **arguments)
            assert retried["state"] == "applied"
            assert retried["reference_state"] == "failed"
            assert retried["reference_error_code"] == "operation_inactive"
            assert retried["result_revision"] == saved["result_revision"]
        assert not templates.exists()
        assert _items(store, ready, review, saved["result_revision"])[0]["record"]["document_type"] == "other_special"
