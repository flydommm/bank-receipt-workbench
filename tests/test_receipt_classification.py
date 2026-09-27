"""Manual type decisions remain strict, task-bound and independent of review."""

from copy import deepcopy

import pytest

from engine.receipt_classification import (
    MANUAL_DOCUMENT_TYPES, classification_notice, effective_document_type,
)
from engine.receipt_layout_review import _review_digest
from engine.receipt_review_models import (
    ReceiptReviewError, build_receipt_record, validate_receipt_context,
    validate_receipt_edit, validate_receipt_record,
)
from engine.review_store import ReviewStoreError
from engine.review_store_v2 import ReviewRevisionConflict, ReviewStoreV2
from tests.test_receipt_review_models import SHA_A, _context, _edit, _original
from tests.test_receipt_review_store import edits, prepare, two_originals


@pytest.mark.parametrize("kind", sorted(MANUAL_DOCUMENT_TYPES))
def test_optional_classification_survives_strict_record_codec(kind):
    key = validate_receipt_context(_context())[2]
    original = _original()
    edit = {**_edit(key, original), "document_type": kind}
    assert validate_receipt_edit(edit) == edit
    record = build_receipt_record(original, edit, "/documents/report.pdf", SHA_A, 1)
    assert validate_receipt_record(record)["document_type"] == kind
    assert effective_document_type(record, "loan_interest_notice") == kind
    notice = classification_notice(record, {"code": "special_document", "document_type": "loan_interest_notice"})
    assert notice == (None if kind == "ordinary" else {"code": "special_document", "document_type": kind})


@pytest.mark.parametrize("value", [None, "", "custom_type", 1, True, [], {}])
def test_unknown_or_non_string_classification_is_rejected(value):
    edit = {**_edit(validate_receipt_context(_context())[2], _original()), "document_type": value}
    with pytest.raises(ReceiptReviewError, match="document_type"):
        validate_receipt_edit(edit)


def test_classification_does_not_loosen_unknown_field_rejection():
    edit = {**_edit(validate_receipt_context(_context())[2], _original()),
            "document_type": "other_special", "document_type_override": "ordinary"}
    with pytest.raises(ReceiptReviewError, match="schema-1"):
        validate_receipt_edit(edit)


def test_absent_override_retains_automatic_detection_and_legacy_record_shape():
    original = _original()
    edit = _edit(validate_receipt_context(_context())[2], original)
    record = build_receipt_record(original, edit, "/documents/report.pdf", SHA_A, 1)
    assert "document_type" not in validate_receipt_record(record)
    notice = {"code": "special_document", "document_type": "loan_interest_notice"}
    assert effective_document_type(record, "loan_interest_notice") == "loan_interest_notice"
    assert effective_document_type(None) == "ordinary"
    assert classification_notice(record, notice) == notice
    assert classification_notice(record, notice) is not notice


def test_classification_reopens_and_normal_confirmation_exclusion_restore_preserve_it(tmp_path):
    database = tmp_path / "reviews.sqlite3"
    originals = two_originals()
    with ReviewStoreV2(database) as store:
        prepared = prepare(store)
        edit = {**edits(prepared, originals)[0], "document_type": "other_special", "review_status": "needs_review"}
        saved = store.save(prepared["context_key"], "run-1", [edit])
        assert saved["segments"][0]["review_status"] == "needs_review"
    with ReviewStoreV2(database) as store:
        restored = prepare(store)
        assert restored["segments"][0]["document_type"] == "other_special"
        assert [row["record_revision"] for row in restored["record_revisions"]] == [1, 0]
        for revision, status in enumerate(["confirmed", "excluded", "needs_review", "confirmed"], start=1):
            edit = {**edits(restored, originals)[0], "record_revision": revision, "review_status": status}
            saved = store.save(restored["context_key"], "run-1", [edit])["segments"][0]
            assert saved["document_type"] == "other_special"
            assert saved["review_status"] == status
            assert saved["record_revision"] == revision + 1
        edit.update(record_revision=5, document_type="ordinary", review_status="needs_review")
        reset = store.save(restored["context_key"], "run-1", [edit])["segments"][0]
        assert reset["document_type"] == "ordinary"
        assert reset["review_status"] == "needs_review"


def test_classification_change_uses_edit_review_status_and_invalidates_digest():
    with ReviewStoreV2() as store:
        prepared = prepare(store)
        edit = edits(prepared, two_originals())[0]
        store.save(prepared["context_key"], "run-1", [edit])
        before = prepare(store)
        edit.update(record_revision=1, document_type="other_special", review_status="needs_review")
        store.save(prepared["context_key"], "run-1", [edit])
        after = prepare(store)
        assert after["segments"][0]["review_status"] == "needs_review"
        assert _review_digest(before) != _review_digest(after)


@pytest.mark.parametrize("state", ["blocked", "excluded"])
@pytest.mark.parametrize("target_state", ["needs_review", "confirmed", "page_confirmed"])
def test_changing_classification_cannot_restore_or_confirm_unavailable_receipt(state, target_state):
    with ReviewStoreV2() as store:
        prepared = prepare(store)
        edit = {**edits(prepared, two_originals())[0], "review_status": state}
        store.save(prepared["context_key"], "run-1", [edit])
        edit.update(record_revision=1, document_type="other_special", review_status=target_state)
        with pytest.raises(ReviewStoreError):
            store.save(prepared["context_key"], "run-1", [edit])
        current = prepare(store)["segments"][0]
        assert current["review_status"] == state
        assert "document_type" not in current


def test_classification_cas_conflict_rolls_back_all_selected_receipts():
    with ReviewStoreV2() as store:
        prepared = prepare(store)
        batch = edits(prepared, two_originals())
        batch[1].update(document_type="loan_interest_notice", review_status="needs_review")
        first = store.save(prepared["context_key"], "run-1", [batch[1]])
        for edit in batch:
            edit.update(document_type="other_special", review_status="confirmed")
        with pytest.raises(ReviewRevisionConflict):
            store.save(prepared["context_key"], "run-1", batch)
        assert prepare(store)["segments"] == first["segments"]


@pytest.mark.parametrize("include_type", [False, True])
@pytest.mark.parametrize("status", ["needs_review", "confirmed"])
def test_existing_blocked_type_cannot_be_bypassed_by_omitting_or_repeating_it(include_type, status):
    with ReviewStoreV2() as store:
        prepared = prepare(store)
        edit = {**edits(prepared, two_originals())[0], "document_type": "other_special", "review_status": "blocked"}
        store.save(prepared["context_key"], "run-1", [edit])
        edit.update(record_revision=1, review_status=status)
        if not include_type:
            edit.pop("document_type")
        with pytest.raises(ReviewStoreError, match="requires layout calibration"):
            store.save(prepared["context_key"], "run-1", [edit])
        assert prepare(store)["segments"][0]["review_status"] == "blocked"


def test_classification_cannot_change_geometry_and_accepts_explicit_full_page_confirmation():
    with ReviewStoreV2() as store:
        prepared = prepare(store)
        edit = {**edits(prepared, two_originals())[0], "document_type": "other_special", "crop_mode": "full_page",
                "review_status": "page_confirmed", "final_rect": None}
        with pytest.raises(ReviewStoreError, match="preserve current geometry"):
            store.save(prepared["context_key"], "run-1", [edit])
        edit.pop("document_type")
        store.save(prepared["context_key"], "run-1", [edit])
        edit.update(record_revision=1, document_type="other_special")
        saved = store.save(prepared["context_key"], "run-1", [edit])["segments"][0]
        assert saved["document_type"] == "other_special"
        assert saved["review_status"] == "page_confirmed"
        assert saved["final_rect"] is None


def test_new_task_does_not_inherit_manual_classification():
    with ReviewStoreV2() as store:
        prepared = prepare(store)
        edit = {**edits(prepared, two_originals())[0], "document_type": "other_special"}
        store.save(prepared["context_key"], "run-1", [edit])
        newer = deepcopy(two_originals())
        for index, original in enumerate(newer):
            original["id"] = str(index + 7) * 64
        assert prepare(store, originals=newer, revision="run-2", owner="second-job")["segments"] == []
