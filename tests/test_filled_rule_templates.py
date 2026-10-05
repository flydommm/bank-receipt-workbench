"""Visible thin filled rules can establish reusable receipt form evidence."""

from copy import deepcopy

import pymupdf
import pytest

from engine.batch_api import handle_batch_request
from engine.batch_store import BatchStore
from engine.crop_templates import describe_crop_page
from engine.layout_template_store import LayoutTemplateStore
from engine.receipt_calibration_journal import retain_calibration_preview, save_calibration_preview
from engine.receipt_layout_calibration import validate_complete_layout
from engine.receipt_layout_review import preview_receipt_calibration
from tests.test_receipt_batch_pdf import ALL
from tests.test_receipt_layout_review import _ready, _prepared


def filled_page(document, kind="dark", value="合成甲公司"):
    page = document.new_page(width=600, height=900)
    for start in (50, 350, 650):
        page.insert_text((210, start), "深圳农商银行电子回单", fontname="china-s")
        page.insert_text((40, start + 40), f"付款人名称：{value}", fontname="china-s")
        page.insert_text((40, start + 65), "收款人名称：合成乙公司", fontname="china-s")
        page.insert_text((40, start + 90), "交易日期：2026-01-01", fontname="china-s")
        for delta in (30, 110):
            rect = pymupdf.Rect(20, start + delta, 580, start + delta + (.75 if kind != "thick" else 8))
            color = (1, 1, 1) if kind == "white" else (0, 0, 0)
            if kind == "curve":
                page.draw_oval(rect, color=None, fill=color)
            elif kind == "mitred":
                shape = page.new_shape()
                shape.draw_polyline([(rect.x0, rect.y1), (rect.x1, rect.y1),
                                     (rect.x1 - .75, rect.y0), (rect.x0 + .75, rect.y0)])
                shape.finish(color=None, fill=color, closePath=True)
                shape.commit()
            else:
                page.draw_rect(rect, color=None, fill=color, fill_opacity=.1 if kind == "transparent" else 1)
            if kind in {"hidden", "partial"}:
                page.draw_rect(pymupdf.Rect(20 if kind == "hidden" else 300, rect.y0 - 1, 581, rect.y1 + 1),
                               color=None, fill=(1, 1, 1))
    return page


@pytest.mark.parametrize("kind", ["dark", "mitred"])
def test_visible_filled_rules_have_stable_identity_without_business_values(kind):
    with pymupdf.open() as document:
        first = describe_crop_page(filled_page(document, kind))
        second = describe_crop_page(filled_page(document, kind, value="另一合成公司"))
        assert first["status"] == second["status"] == "ready"
        assert len(first["receipts"]) == 3
        assert all(item["issuer_bank_key"] and item["template_fingerprint"] for item in first["receipts"])
        assert first["receipts"] == second["receipts"]


@pytest.mark.parametrize("kind", ["white", "transparent", "thick", "curve", "hidden", "partial"])
def test_unverified_fills_never_authorize_a_template(kind):
    with pymupdf.open() as document:
        assert describe_crop_page(filled_page(document, kind)) == {
            "status": "unavailable", "reason": "ambiguous_layout"}


def test_filled_rule_budget_is_bounded(monkeypatch):
    monkeypatch.setattr("engine.crop_templates.MAX_FILLED_RULES", 1)
    with pymupdf.open() as document:
        assert describe_crop_page(filled_page(document)) == {
            "status": "unavailable", "reason": "budget_exceeded"}


def test_filled_rule_template_calibrate_save_and_apply_to_fresh_task(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    source = tmp_path / "synthetic.pdf"
    with pymupdf.open() as document:
        filled_page(document, "mitred")
        document.save(source)
    review = tmp_path / "review.sqlite3"
    database = tmp_path / "tasks.sqlite3"
    with BatchStore(database) as store:
        ready = _ready(store, [source], ALL)
        prepared = _prepared(store, ready, review)
        assert prepared.view()["scope_kind"] == "verified_layout"
        draft = deepcopy(prepared.layout)
        draft["revision"] += 1
        draft["uniform_height"] = True
        draft["slots"][0]["top_pt"] += 1
        for slot in draft["slots"]:
            slot["height_pt"] = 200
        preview = preview_receipt_calibration(store, prepared, validate_complete_layout(draft), review)
        assert preview.can_save
        retained = retain_calibration_preview(store, preview, review)
        saved = save_calibration_preview(store, ready["id"], retained["operation_id"], retained["preview_fingerprint"], review,
            acknowledged_risk_ids=[item["risk_id"] for item in retained["risks"]], template_database=review,
            remember_reference=True, template_bank_name="农商银行")
        assert saved["reference_state"] == "saved"
        template = LayoutTemplateStore(review).list_page()["items"][0]
        assert template["active"]
        fresh = _ready(store, [source], ALL)
        _prepared(store, fresh, review)
        applied = handle_batch_request({"op": "batch_receipt_template_apply_preview", "database_path": str(database),
            "job_id": fresh["id"], "result_revision": fresh["result_revision"], "template_id": template["id"],
            "review_database_path": str(review), "template_database_path": str(review)})
        assert applied["status"] == "ok", applied
        assert applied["data"]["page_count"] == 1
