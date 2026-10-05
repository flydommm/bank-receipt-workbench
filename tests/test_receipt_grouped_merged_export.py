"""Real synthetic grouped PDF publication for both output choices."""

from pathlib import Path
import json

import openpyxl
import pymupdf
import pytest

from engine.batch_review import prepare_batch_review
from engine.batch_store import BatchStore
from engine.export_publish import publish_bundle, status_bundle
from engine.review_store_v2 import ReviewStoreV2
from tests.test_batch_receipt_review import _make_edit
from tests.test_receipt_export_bundle import bundle, register
from tests.test_receipt_grouping_integration import grouping_task, call, prepare_and_page


@pytest.mark.parametrize("mode", ["by_counterparty", "by_counterparty_merged"])
@pytest.mark.parametrize("exclude_first", [False, True])
def test_grouped_choices_publish_every_retained_receipt_and_correct_page_mapping(grouping_task, monkeypatch, mode, exclude_first):
    task = grouping_task
    with BatchStore(task[0]) as store:
        prepared = prepare_batch_review(store, task[2]["id"], task[2]["result_revision"], task[1])["prepared"]
        originals = store.review_snapshot(task[2]["id"], task[2]["result_revision"])["originals"]
    edits = [_make_edit(prepared["context_key"], task[2]["result_revision"], item) for item in originals]
    if exclude_first:
        edits[0]["review_status"] = "excluded"
    retained = originals[1:] if exclude_first else originals
    with ReviewStoreV2(task[1]) as reviews:
        reviews.save(prepared["context_key"], task[2]["result_revision"], edits)
    header, page = prepare_and_page(task)
    refreshed = call(task, "batch_receipt_grouping_refresh", job_id=header["job_id"], result_revision=header["result_revision"],
        expected_grouping_revision=header["grouping_revision"], expected_review_fingerprint=header["review_fingerprint"],
        segment_ids=[item["binding"]["segment_id"] for item in page["items"]])
    header = refreshed["header"]
    request = {"job_id": header["job_id"], "result_revision": header["result_revision"], "scope_kind": "list",
        "selected_segment_ids": [item["id"] for item in retained],
        "expected_records": [{"id": item["id"], "record_revision": 1} for item in retained],
        "output_mode": mode, "include_xlsx": True, "include_manifest": True,
        "include_counterparty_pending": False, "expected_grouping_revision": header["grouping_revision"],
        "expected_review_fingerprint": header["review_fingerprint"], "own_account_fingerprint": header["own_account"]["fingerprint"]}
    service = bundle(task, monkeypatch)
    created = service.create(request)
    assert len(created["files"]) == (1 if mode == "by_counterparty_merged" else 2)
    register(service, created)
    rendered = service.render(created["intent_id"])
    assert rendered["grouped_pages"] == len(retained)
    output = task[0].parent / "grouped-output"
    output.mkdir()
    receipt = publish_bundle(service, created["intent_id"], output)
    pdf_files = [file for file in receipt["files"] if file["kind"] == "pdf"]
    assert len(pdf_files) == len(rendered["files"])
    assert receipt["summary"]["excluded_count"] == int(exclude_first)
    manifest = json.loads((Path(receipt["directory"]) / "导出清单.json").read_text(encoding="utf-8"))
    assert manifest["scope"]["output_mode"] == mode and manifest["version"] == 3
    assert {row["segment_id"] for row in manifest["plan"]["mappings"]} == {item["id"] for item in retained}
    workbook = openpyxl.load_workbook(next(file["path"] for file in receipt["files"] if file["kind"] == "xlsx"), read_only=True)
    try:
        values = list(workbook["核对明细"].values)
        rows = [dict(zip(values[0], row, strict=True)) for row in values[1:]]
        assert len(rows) == len(retained)
        assert {row["归组名称"] for row in rows} == {"合成供应商甲", "合成供应商乙"}
        for row in rows:
            with pymupdf.open(Path(receipt["directory"]) / row["输出文件"]) as pdf:
                assert row["归组名称"] in pdf[row["输出页"] - 1].get_text()
        if mode == "by_counterparty_merged":
            assert receipt["output_mode"] == mode
            assert {row["输出文件"] for row in rows} == {"全部分组回单.pdf"}
            order = [row["归组名称"] for row in sorted(rows, key=lambda row: row["输出页"])]
            expected = ["合成供应商乙", "合成供应商甲"] if exclude_first else ["合成供应商甲", "合成供应商甲", "合成供应商乙"]
            assert order == expected
    finally:
        workbook.close()
    service.close(created["intent_id"])
    assert status_bundle(service, task[2]["id"])["publication"] == receipt
