"""Host protocol errors remain stable and user-readable."""

from uuid import uuid4
import json
from pathlib import Path
import subprocess
import sys

import pytest

from engine.export_api import handle_export_request
from test_export_bundle import bundle, register, request_all
from test_export_scope import export_task


def request(service, operation, **fields):
    return {"op": operation, "batch_database_path": str(service.batch_database),
            "review_database_path": str(service.review_database), "journal_root": str(service.journal.root),
            "preview_root": str(service.preview_root), **fields}


def test_host_protocol_create_render_close(bundle, export_task):
    response = handle_export_request(request(bundle, "export_intent_create", scope=request_all(export_task, "merged")))
    assert response["status"] == "ok"
    created = response["data"]
    register(bundle, created)
    rendered = handle_export_request(request(bundle, "export_intent_render", intent_id=created["intent_id"]))
    assert rendered["status"] == "ok" and rendered["data"]["total_pages"] == 2
    closed = handle_export_request(request(bundle, "export_intent_close", intent_id=created["intent_id"]))
    assert closed == {"status": "ok", "data": {"intent_id": created["intent_id"], "state": "closed"}}


@pytest.mark.parametrize("field", ["selections", "source_path", "output_path"])
def test_host_protocol_rejects_unexpected_fields_before_allocating(bundle, export_task, field):
    payload = request(bundle, "export_intent_create", scope=request_all(export_task))
    payload[field] = "unused"
    assert handle_export_request(payload)["code"] == "invalid_request"
    assert bundle.journal.list_metadata() == []


def test_unknown_intent_is_chinese_and_does_not_expose_internal_exception(bundle):
    result = handle_export_request(request(bundle, "export_intent_render", intent_id=str(uuid4())))
    assert result["status"] == "error"
    assert "导出" in result["message"] and str(bundle.journal.root) not in result["message"]


def test_export_jsonl_route_returns_only_one_serializable_response(bundle, export_task):
    payload = request(bundle, "export_intent_create", scope=request_all(export_task, "merged", False))
    completed = subprocess.run(
        [sys.executable, "-E", "-s", "-X", "utf8", str(Path(__file__).parents[1] / "engine" / "engine.py"), "--serve"],
        input=json.dumps(payload, ensure_ascii=False) + "\n", capture_output=True,
        encoding="utf-8", timeout=30,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert completed.returncode == 0 and completed.stderr == ""
    assert len(completed.stdout.splitlines()) == 1
    result = json.loads(completed.stdout)
    assert result["status"] == "ok" and result["data"]["state"] == "created"
    assert result["data"]["summary"]["selected_count"] == 2


def test_residual_response_keeps_exact_path_with_chinese_explanation(bundle, monkeypatch):
    from engine import export_publish
    path = str(bundle.preview_root / "retained.pdf")
    monkeypatch.setattr(export_publish, "status_bundle", lambda *_: {
        "job_id": "job", "publication": None,
        "residuals": [{"path": path, "reason": "owned file deletion failed"}]})
    result = handle_export_request(request(bundle, "export_intent_status", job_id="job"))
    assert result["status"] == "ok"
    assert result["data"]["residuals"] == [{"path": path, "reason": "暂时无法清理，该文件或目录可能仍被占用，请关闭占用程序后重试。"}]


def test_journal_capacity_error_is_actionable_and_chinese(bundle, export_task, monkeypatch):
    from engine.export_bundle import ExportBundleService
    from engine.export_journal import ExportJournalQuotaError

    def full(*_args):
        raise ExportJournalQuotaError("private internal quota detail")

    monkeypatch.setattr(ExportBundleService, "create", full)
    result = handle_export_request(request(bundle, "export_intent_create", scope=request_all(export_task)))
    assert result["code"] == "export_capacity_exceeded"
    assert "达到限制" in result["message"] and "private" not in result["message"]
