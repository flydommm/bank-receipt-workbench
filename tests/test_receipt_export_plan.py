"""Pure schema-3 output plan contract tests."""

from copy import deepcopy
import pytest

from engine.receipt_export_plan import build_receipt_output_plan
from engine.receipt_review_models import ReceiptReviewError
from tests.test_receipt_review_models import _context, _edit, _original
from engine.receipt_review_models import build_receipt_record, validate_receipt_context


def make_record(mode="search", *, source_key="/documents/report.pdf", source_path="/documents/report.pdf"):
    context = _context(source_key=source_key, source_path=source_path, mode=mode)
    # This fixture uses the model's existing deterministic digest values and
    # keeps the planner test independent from PDF readers.
    validated = validate_receipt_context(context)
    original = _original(source_key=source_key)
    edit = _edit(validated[2], original)
    edit.update(context_key=validated[2], result_revision="1", record_revision=1,
                review_status="confirmed")
    record = build_receipt_record(original, edit, source_path, "a" * 64, 1)
    return validated, record


def test_search_plan_contains_real_identity_and_no_legacy_fields():
    validated, record = make_record()
    plan = build_receipt_output_plan(
        [{"source_key": "/documents/report.pdf", "name": "report.pdf", "source_path": "/documents/report.pdf", "source_sha256": "a" * 64}],
        [record], {record["original"]["id"]: [{"query_id": "include-0", "rect": {"x0": 1, "y0": 601, "x1": 3, "y1": 603}}]},
        validated[0]["processing_options"], "merged", "2026-09-14T00:00:00Z",
    )
    assert plan["schema"] == 2 and plan["total_pages"] == 1
    assert "instance_id" in plan["index_rows"][0]
    assert not {"segment_no", "confidence", "matched_text"}.intersection(plan["index_rows"][0])
    assert plan["mappings"][0]["instance_id"] == record["original"]["instance_id"]


def test_split_all_rejects_keyword_evidence():
    validated, record = make_record("split_all")
    with pytest.raises(ReceiptReviewError):
        build_receipt_output_plan(
            [{"source_key": "/documents/report.pdf", "name": "report.pdf", "source_path": "/documents/report.pdf", "source_sha256": "a" * 64}],
            [record], {record["original"]["id"]: [{"query_id": "include-0", "rect": {"x0": 1, "y0": 601, "x1": 3, "y1": 603}}]},
            validated[0]["processing_options"], "merged", "",
        )


def test_plan_rejects_unknown_evidence_and_unconfirmed_records():
    validated, record = make_record()
    with pytest.raises(ReceiptReviewError):
        build_receipt_output_plan(
            [{"source_key": "/documents/report.pdf", "name": "report.pdf", "source_path": "/documents/report.pdf", "source_sha256": "a" * 64}],
            [record], {"unknown": []}, validated[0]["processing_options"], "merged", "",
        )
    pending = deepcopy(record)
    pending["review_status"] = "needs_review"
    with pytest.raises(ReceiptReviewError):
        build_receipt_output_plan(
            [{"source_key": "/documents/report.pdf", "name": "report.pdf", "source_path": "/documents/report.pdf", "source_sha256": "a" * 64}],
            [pending], {}, validated[0]["processing_options"], "merged", "",
        )


@pytest.mark.parametrize("change", [
    {"crop_mode": "full_page", "final_rect": None, "review_status": "page_confirmed"},
    {"review_status": "needs_review"},
    {"manual_adjusted": True},
    {"original_pending": True},
])
def test_initial_export_record_cannot_bypass_review_or_change_crop(change):
    validated, record = make_record()
    record["record_revision"] = 0
    record["original"]["needs_review"] = change.get("original_pending", False)
    record.update({key: value for key, value in change.items() if key != "original_pending"})
    with pytest.raises(ReceiptReviewError):
        build_receipt_output_plan(
            [{"source_key": "/documents/report.pdf", "name": "report.pdf", "source_path": "/documents/report.pdf", "source_sha256": "a" * 64}],
            [record], {}, validated[0]["processing_options"], "merged", "",
        )
