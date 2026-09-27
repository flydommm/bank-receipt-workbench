"""Confirmed document types remain isolated during later layout changes."""
from copy import deepcopy
from hashlib import sha256

import pymupdf
import pytest

from engine.batch_review import prepare_batch_review, read_batch_receipt_review_page, save_batch_receipt_review
from engine.batch_store import BatchStore
from engine.receipt_calibration_journal import retain_calibration_preview, save_calibration_preview
from engine.receipt_layout_review import prepare_receipt_calibration, preview_receipt_calibration
from tests.test_batch_receipt_review_api import _make_edit
from tests.test_receipt_batch_pdf import ALL
from tests.test_receipt_layout_review import _pdf, _ready, private_temp


def _mixed_source(tmp_path):
    # All four documents share paper geometry and one source. That alone
    # cannot bypass the independently detected document type boundary.
    titles = ("上海银行业务回单", "贷款清算通知书", "贷款利息到期通知书", "电子缴税付款凭证")
    target = tmp_path / "mixed-synthetic.pdf"
    with pymupdf.open() as mixed:
        for index, title in enumerate(titles):
            path = _pdf(tmp_path, f"page-{index}", title=title, counts=(1,))
            with pymupdf.open(path) as source:
                mixed.insert_pdf(source)
        mixed.save(target)
    return target


@pytest.mark.parametrize("adjusted_page", [1, 2, 3, 4], ids=["ordinary", "settlement", "interest", "tax"])
def test_confirmed_documents_keep_their_boundaries_and_decisions_after_other_type_calibration(tmp_path, adjusted_page):
    source = _mixed_source(tmp_path)
    original_hash = sha256(source.read_bytes()).hexdigest()
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [source], ALL)
        prepared_review = prepare_batch_review(store, ready["id"], ready["result_revision"], review)
        originals = store.review_snapshot(ready["id"], ready["result_revision"])["originals"]
        assert len(originals) == 4
        edits = [_make_edit(prepared_review["prepared"]["context_key"], ready["result_revision"], item) for item in originals]
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], edits, review)
        before = read_batch_receipt_review_page(store, ready["id"], ready["result_revision"], 0, 200, review)
        assert all(item["record"]["review_status"] == "confirmed" for item in before["items"])
        assert [item.get("page_notice", {}).get("document_type") for item in before["items"]] == [
            None, "loan_settlement_notice", "loan_interest_notice", "electronic_tax_payment",
        ]
        rows = store.read_page_results(ready["id"])

        sample = next(item for item in originals if item["source_page"] == adjusted_page)
        prepared = prepare_receipt_calibration(store, ready["id"], ready["result_revision"], sample["id"], review)
        assert prepared.view()["page_count"] == 1
        assert prepared.view()["excluded_page_counts"] == {"different_document_type": 3}
        draft = deepcopy(prepared.layout)
        draft["revision"] += 1
        draft["right_pt"] += 2
        preview = preview_receipt_calibration(store, prepared, draft, review)
        assert preview.can_save, preview.blockers
        assert {item["page"] for item in preview.affected} == {adjusted_page}
        retained = retain_calibration_preview(store, preview, review)
        saved = save_calibration_preview(
            store, ready["id"], retained["operation_id"], retained["preview_fingerprint"], review,
            acknowledged_risk_ids=[risk["risk_id"] for risk in retained["risks"]], remember_reference=False,
        )
        assert saved["state"] == "applied" and saved["saved_count"] == 1
        after = read_batch_receipt_review_page(store, ready["id"], saved["result_revision"], 0, 200, review)
        by_page = {item["original"]["source_page"]: item for item in after["items"]}
        for item in before["items"]:
            page = item["original"]["source_page"]
            updated = by_page[page]
            assert updated.get("page_notice") == item.get("page_notice")
            if page == adjusted_page:
                assert updated["record"]["final_rect"]["x1"] == item["record"]["final_rect"]["x1"] - 2
                continue
            assert updated["original"] == item["original"]
            for field in ("final_rect", "crop_mode", "manual_adjusted", "review_status", "reviewed_at"):
                assert updated["record"][field] == item["record"][field]
        remaining_rows = lambda values: [row for row in values if row["page"] != adjusted_page]
        assert remaining_rows(store.read_page_results(ready["id"])) == remaining_rows(rows)
    assert sha256(source.read_bytes()).hexdigest() == original_hash
