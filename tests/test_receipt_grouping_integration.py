"""Synthetic PDF -> real task/review -> grouping command integration."""
from hashlib import sha256
from pathlib import Path

import pymupdf
import pytest

from engine.batch_api import handle_batch_request
from engine.batch_processor import BatchProcessor, BatchProgress
from engine.batch_review import prepare_batch_review
from engine.batch_store import BatchStore
from engine.computation import current_computation_version
from engine.receipt_grouping_api import dispatch_grouping

ACCOUNT = {"company_name": "合成本公司", "bank_name": "上海银行", "branch_name": "", "account_number": "000012345678"}


def synthetic_receipts(path):
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        for position, name in enumerate(("合成供应商甲", "合成供应商乙", "合成供应商甲")):
            top = 35 + position * 285
            for offset, text in [(0, "上海银行业务回单"), (28, "付款方名称：合成本公司"),
                                 (52, "付款方账号：000012345678"), (76, "付款方开户行：上海银行"),
                                 (108, "收款方名称：" + name), (132, f"收款方账号：00009999{position}"),
                                 (156, "收款方开户行：中国银行"), (190, "打印时间：2026-01-01")]:
                page.insert_text((50, top + offset), text, fontname="china-s", fontsize=11)
            page.draw_line((20, top + 10), (580, top + 10))
            page.draw_line((20, top + 215), (580, top + 215))
        document.save(path)


@pytest.fixture
def grouping_task(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    path = tmp_path / "synthetic.pdf"
    synthetic_receipts(path)
    original = (path.stat().st_size, sha256(path.read_bytes()).hexdigest())
    batch, review = tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3"
    with BatchStore(batch) as store:
        store.activate_supervisor("host")
        version = current_computation_version()
        job = store.create_receipt_job("synthetic-grouping", [{"source_path": str(path), "name": path.name}],
                                      {"processing_mode": "split_all", "criteria": None}, "exact", version)
        header = dispatch_grouping(store, "batch_receipt_grouping_set_account", {"job_id": job["id"],
            "expected_grouping_revision": 0, "account_selection": {"kind": "inline", "account": ACCOUNT}}, review)
        assert header["own_account"]["account_number"].startswith("0000")
        running = store.start_job(job["id"], job["generation"], "host", version)
        ready = BatchProcessor(store, job["id"], running["generation"], "host", version, BatchProgress(lambda *_: None)).run()
        assert ready["state"] == "ready_for_review"
        prepare_batch_review(store, ready["id"], ready["result_revision"], review)
    yield batch, review, ready, path
    assert (path.stat().st_size, sha256(path.read_bytes()).hexdigest()) == original


def call(task, op, **fields):
    value = handle_batch_request({"op": op, "database_path": str(task[0]), "grouping_database_path": str(task[1]), **fields})
    assert value["status"] == "ok", value
    return value["data"]


def prepare_and_page(task):
    job = task[2]
    header = call(task, "batch_receipt_grouping_prepare", job_id=job["id"], result_revision=job["result_revision"], expected_grouping_revision=-1)
    page = call(task, "batch_receipt_grouping_page", job_id=job["id"], result_revision=job["result_revision"],
                expected_grouping_revision=header["grouping_revision"], expected_review_fingerprint=header["review_fingerprint"], offset=0, limit=200)
    return header, page


def test_real_pipeline_prepares_and_extracts_named_groups(grouping_task):
    task = grouping_task
    header, page = prepare_and_page(task)
    assert set(header) == {"schema_version", "job_id", "result_revision", "grouping_revision", "own_account", "review_fingerprint", "counts"}
    assert page["total"] == 3
    refreshed = call(task, "batch_receipt_grouping_refresh", job_id=header["job_id"], result_revision=header["result_revision"],
                     expected_grouping_revision=header["grouping_revision"], expected_review_fingerprint=header["review_fingerprint"],
                     segment_ids=[item["binding"]["segment_id"] for item in page["items"]])
    items = refreshed["items"]
    assert {item["extraction_state"] for item in items} == {"ready"}
    assert {item["own_decision"]["status"] for item in items} == {"confirmed"}
    assert {item["group"]["display_name"] for item in items} == {"合成供应商甲", "合成供应商乙"}
    again, _ = prepare_and_page(task)
    assert again["grouping_revision"] == refreshed["header"]["grouping_revision"]


def test_grouping_algorithm_change_invalidates_grouping_without_changing_review(grouping_task, monkeypatch):
    import engine.receipt_grouping_store as grouping_store_module
    from engine.receipt_review_read import read_receipt_review_snapshot

    task = grouping_task
    with BatchStore(task[0]) as store:
        prepared_review = prepare_batch_review(store, task[2]["id"], task[2]["result_revision"], task[1])["prepared"]
    context_key = prepared_review["context_key"]
    before_review = read_receipt_review_snapshot(task[1], context_key, task[2]["result_revision"])

    extracted = extract_task(task)
    header = extracted["header"]
    assert {item["extraction_state"] for item in extracted["items"]} == {"ready"}
    current_version = grouping_store_module.grouping_algorithm_version()
    monkeypatch.setattr(grouping_store_module, "grouping_algorithm_version", lambda: current_version + "-changed")

    stale = handle_batch_request({
        "op": "batch_receipt_grouping_page", "database_path": str(task[0]),
        "grouping_database_path": str(task[1]), "job_id": header["job_id"],
        "result_revision": header["result_revision"], "expected_grouping_revision": header["grouping_revision"],
        "expected_review_fingerprint": header["review_fingerprint"], "offset": 0, "limit": 200,
    })
    assert stale["status"] == "error" and stale["code"] == "grouping_conflict"

    reprovisioned = call(task, "batch_receipt_grouping_prepare", job_id=header["job_id"],
                         result_revision=header["result_revision"], expected_grouping_revision=-1)
    assert reprovisioned["grouping_revision"] > header["grouping_revision"]
    assert reprovisioned["review_fingerprint"] == header["review_fingerprint"]
    reloaded = call(task, "batch_receipt_grouping_page", job_id=reprovisioned["job_id"],
                    result_revision=reprovisioned["result_revision"],
                    expected_grouping_revision=reprovisioned["grouping_revision"],
                    expected_review_fingerprint=reprovisioned["review_fingerprint"], offset=0, limit=200)
    # A rule-only upgrade rebuilds group decisions without discarding usable
    # field extraction or sending already reviewed receipts through extraction.
    assert {item["extraction_state"] for item in reloaded["items"]} == {"ready"}
    assert [item["extracted"] for item in reloaded["items"]] == [item["extracted"] for item in extracted["items"]]

    after_review = read_receipt_review_snapshot(task[1], context_key, task[2]["result_revision"])
    assert after_review == before_review


def extract_task(task):
    header, page = prepare_and_page(task)
    return call(task, "batch_receipt_grouping_refresh", job_id=header["job_id"], result_revision=header["result_revision"],
                expected_grouping_revision=header["grouping_revision"], expected_review_fingerprint=header["review_fingerprint"],
                segment_ids=[item["binding"]["segment_id"] for item in page["items"]])


def save_grouping(task, snapshot, edits, groups=None):
    header = snapshot["header"]
    return call(task, "batch_receipt_grouping_save", job_id=header["job_id"], result_revision=header["result_revision"],
                expected_grouping_revision=header["grouping_revision"], expected_review_fingerprint=header["review_fingerprint"],
                edits=edits, group_edits=groups or [])


def test_field_correction_manual_move_and_clear_rederive_without_review_changes(grouping_task):
    task = grouping_task
    from engine.receipt_review_read import read_receipt_review_snapshot
    with BatchStore(task[0]) as store:
        context = prepare_batch_review(store, task[2]["id"], task[2]["result_revision"], task[1])["prepared"]["context_key"]
    before = read_receipt_review_snapshot(task[1], context, task[2]["result_revision"])
    snapshot = extract_task(task)
    item = snapshot["items"][0]
    segment_id = item["binding"]["segment_id"]
    saved = save_grouping(task, snapshot, [{"segment_id": segment_id, "expected_basis_fingerprint": item["basis_fingerprint"],
        "field_overrides": [{"side": "payee", "field": "name", "state": "present", "value": "合成修正名称", "reason": "核对合成原件"}]}])
    edited = next(i for i in saved["items"] if i["binding"]["segment_id"] == segment_id)
    assert edited["own_decision"]["status"] == "confirmed"
    assert edited["counterparty"]["name"]["value"] == "合成修正名称"
    assert edited["extracted"]["payee"]["name"]["value"] == item["extracted"]["payee"]["name"]["value"]
    assert edited["group"]["display_name"] == "合成修正名称"
    assert edited["basis_fingerprint"] != item["basis_fingerprint"]
    moved = save_grouping(task, saved, [{"segment_id": segment_id, "expected_basis_fingerprint": edited["basis_fingerprint"],
        "assignment": {"group_id": "manual-separate", "reason": "核对后单独整理"}}],
        [{"action": "create", "group_id": "manual-separate", "kind": "named", "display_name": "单独核对组"}])
    moved_item = next(i for i in moved["items"] if i["binding"]["segment_id"] == segment_id)
    assert moved_item["group"]["display_name"] == "单独核对组"
    reset = save_grouping(task, moved, [{"segment_id": segment_id, "expected_basis_fingerprint": moved_item["basis_fingerprint"], "assignment": None, "field_overrides": None}])
    reset_item = next(i for i in reset["items"] if i["binding"]["segment_id"] == segment_id)
    assert reset_item["group"]["display_name"] == item["group"]["display_name"] and reset_item["field_overrides"] == []
    assert read_receipt_review_snapshot(task[1], context, task[2]["result_revision"]) == before


def test_adjusting_one_slot_preserves_other_manual_decisions(grouping_task):
    task = grouping_task
    from engine.review_store_v2 import ReviewStoreV2
    from tests.test_batch_receipt_review import _make_edit
    snapshot = extract_task(task)
    first, second = snapshot["items"][:2]
    saved = save_grouping(task, snapshot, [{"segment_id": second["binding"]["segment_id"], "expected_basis_fingerprint": second["basis_fingerprint"],
        "assignment": {"group_id": "manual-preserved", "reason": "单独整理"}}],
        [{"action": "create", "group_id": "manual-preserved", "kind": "named", "display_name": "保留人工组"}])
    saved_second = next(i for i in saved["items"] if i["binding"]["segment_id"] == second["binding"]["segment_id"])
    with BatchStore(task[0]) as store:
        prepared = prepare_batch_review(store, task[2]["id"], task[2]["result_revision"], task[1])["prepared"]
        originals = store.review_snapshot(task[2]["id"], task[2]["result_revision"])["originals"]
    original = next(i for i in originals if i["id"] == first["binding"]["segment_id"])
    edit = _make_edit(prepared["context_key"], task[2]["result_revision"], original)
    edit.update(crop_mode="manual", manual_adjusted=True)
    edit["final_rect"]["y1"] -= 1
    with ReviewStoreV2(task[1]) as reviews:
        reviews.save(prepared["context_key"], task[2]["result_revision"], [edit])
    header, page = prepare_and_page(task)
    after_first = next(i for i in page["items"] if i["binding"]["segment_id"] == first["binding"]["segment_id"])
    after_second = next(i for i in page["items"] if i["binding"]["segment_id"] == second["binding"]["segment_id"])
    assert header["review_fingerprint"] != saved["header"]["review_fingerprint"]
    assert after_first["extraction_state"] in {"pending", "stale"}
    assert after_second["basis_fingerprint"] == saved_second["basis_fingerprint"]
    assert after_second["group"]["group_id"] == "manual-preserved"
    assert after_second["own_decision"]["status"] == "confirmed"


def test_draft_authority_does_not_need_boundary_approval(grouping_task, tmp_path):
    from engine.receipt_grouping_draft import publish_grouping_draft
    header, _ = prepare_and_page(grouping_task)
    output = tmp_path / "output"
    output.mkdir()
    result = publish_grouping_draft(grouping_task[0], grouping_task[1], {
        "job_id": header["job_id"], "result_revision": header["result_revision"],
        "expected_grouping_revision": header["grouping_revision"], "expected_review_fingerprint": header["review_fingerprint"],
        "own_account_fingerprint": header["own_account"]["fingerprint"], "directory": str(output)})
    assert result["row_count"] == 3 and Path(result["path"]).is_file()


@pytest.mark.parametrize("exclude_first", [False, True])
def test_real_pipeline_exports_each_group_and_complete_index(grouping_task, monkeypatch, exclude_first):
    import json
    import openpyxl
    from engine.export_publish import publish_bundle, status_bundle
    from engine.review_store_v2 import ReviewStoreV2
    from tests.test_batch_receipt_review import _make_edit
    from tests.test_receipt_export_bundle import bundle, register

    task = grouping_task
    with BatchStore(task[0]) as store:
        prepared = prepare_batch_review(store, task[2]["id"], task[2]["result_revision"], task[1])["prepared"]
        originals = store.review_snapshot(task[2]["id"], task[2]["result_revision"])["originals"]
    edits = [_make_edit(prepared["context_key"], task[2]["result_revision"], item) for item in originals]
    if exclude_first:
        edits[0]["review_status"] = "excluded"
    retained = originals[1:] if exclude_first else originals
    expected_count = len(retained)
    with ReviewStoreV2(task[1]) as reviews:
        reviews.save(prepared["context_key"], task[2]["result_revision"], edits)
    header, page = prepare_and_page(task)
    refreshed = call(task, "batch_receipt_grouping_refresh", job_id=header["job_id"], result_revision=header["result_revision"],
                     expected_grouping_revision=header["grouping_revision"], expected_review_fingerprint=header["review_fingerprint"],
                     segment_ids=[item["binding"]["segment_id"] for item in page["items"]])
    header = refreshed["header"]
    assert header["counts"]["extraction_pending"] == 0
    assert header["counts"]["excluded"] == int(exclude_first)
    request = {"job_id": header["job_id"], "result_revision": header["result_revision"], "scope_kind": "list",
               "selected_segment_ids": [item["id"] for item in retained],
               "expected_records": [{"id": item["id"], "record_revision": 1} for item in retained],
               "output_mode": "by_counterparty", "include_xlsx": True, "include_counterparty_pending": False,
               "expected_grouping_revision": header["grouping_revision"], "expected_review_fingerprint": header["review_fingerprint"],
               "own_account_fingerprint": header["own_account"]["fingerprint"]}
    service = bundle(task, monkeypatch)
    created = service.create(request)
    assert len(created["files"]) == 2
    register(service, created)
    rendered = service.render(created["intent_id"])
    assert rendered["grouped_pages"] == expected_count and rendered["total_pages"] == expected_count
    page_counts = []
    for file in rendered["files"]:
        with pymupdf.open(file["preview_path"]) as pdf:
            page_counts.append(len(pdf))
            names = {name for name in ("合成供应商甲", "合成供应商乙") if any(name in p.get_text() for p in pdf)}
            assert len(names) == 1
    assert sorted(page_counts) == ([1, 1] if exclude_first else [1, 2])
    output = task[0].parent / "grouped-output"
    output.mkdir()
    # Editing a group after preview must invalidate that preview before any
    # complete bundle becomes visible. A new version can still be exported.
    from engine.export_scope import ExportScopeError
    target_group = next(i["group"]["group_id"] for i in refreshed["items"] if i["group"])
    renamed = save_grouping(task, refreshed, [], [{"action": "rename", "group_id": target_group, "display_name": "合成核对后的组名"}])
    assert renamed["items"] == []  # group changes reload through bounded pages
    with pytest.raises(ExportScopeError):
        publish_bundle(service, created["intent_id"], output)
    assert not any(p.name.startswith("回单导出") for p in output.iterdir())
    service.close(created["intent_id"])
    request["expected_grouping_revision"] = renamed["header"]["grouping_revision"]
    created = service.create(request)
    register(service, created)
    rendered = service.render(created["intent_id"])
    receipt = publish_bundle(service, created["intent_id"], output)
    assert receipt["state"] == "published" and receipt["row_count"] == expected_count
    manifest = json.loads((Path(receipt["directory"]) / "导出清单.json").read_text(encoding="utf-8"))
    mappings = manifest["plan"]["mappings"]
    assert len(mappings) == expected_count
    assert {row["segment_id"] for row in mappings} == {row["id"] for row in retained}
    xlsx = next(file["path"] for file in receipt["files"] if file["kind"] == "xlsx")
    workbook = openpyxl.load_workbook(xlsx, read_only=True)
    try:
        rows = list(workbook["索引"].values)
        assert len(rows) == expected_count + 1
        columns = rows[0]
        account = columns.index("payer_account")
        assert {row[account] for row in rows[1:]} == {ACCOUNT["account_number"]}
    finally:
        workbook.close()
    assert status_bundle(service, task[2]["id"])["publication"] == receipt
    # Synthetic-only protocol evidence for cross-language client verification.
    (task[0].parent / "protocol-contract.json").write_text(json.dumps({"request": request, "preview": rendered, "receipt": receipt}), encoding="utf-8")
