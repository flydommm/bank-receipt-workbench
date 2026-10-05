"""Internal JSONL boundary for native-managed frozen export bundles."""

from pathlib import Path
from typing import Any

from .export_bundle import ExportBundleService
from .export_journal import ExportJournalQuotaError
from .export_scope import ExportScopeError
from .export_progress import report_export_progress

_PRIVATE_FIELDS = {"batch_database_path", "review_database_path", "journal_root", "preview_root"}
_OPERATIONS = {
    "export_intent_create": {"scope"},
    "export_intent_render": {"intent_id"},
    "export_intent_describe": {"intent_id"},
    "export_intent_close": {"intent_id"},
    "export_intent_publish": {"intent_id", "directory"},
    "export_intent_status": {"job_id"},
    "export_intent_reconcile": {"active_tokens"},
    "export_intent_grouping_draft": {"job_id", "result_revision", "expected_grouping_revision", "expected_review_fingerprint", "own_account_fingerprint", "directory"},
}
_PROGRESS_OPERATIONS = frozenset({"export_intent_create", "export_intent_render", "export_intent_publish"})
_MESSAGES = {
    "export_scope_invalid": "导出范围无效或包含未解决片段，请返回审核后重试。",
    "export_scope_stale": "任务结果或审核记录已变化，请重新生成导出预览。",
    "source_changed": "原始 PDF 已变化，请重新分析后再导出。",
    "file_not_found": "找不到原始 PDF，请重新定位文件后再导出。",
    "export_capacity_exceeded": "导出暂存空间或文件数量达到限制，请先清理不再需要的预览。",
    "pdf_export_failed": "PDF 导出预览生成失败，请重试。",
    "cleanup_failed": "临时导出文件清理失败，文件已保留，请稍后重试。",
    "export_recovery_required": "上次导出尚待核对，请重新打开任务检查发布状态。",
    "draft_export_failed": "核对草稿未能保存，请检查输出目录后重试；草稿不替代正式导出审核。",
    "grouping_stale": "本方资料、分组或审核依据已变化，请重新载入分组并生成导出结果。",
    "grouping_incomplete": "仍有片段的本方身份或交易对手去向未确认，请返回分组核对。",
}


def _public_residuals(value: object) -> list[dict[str, str]]:
    result = []
    if not isinstance(value, list):
        return result
    for row in value:
        if not isinstance(row, dict) or not isinstance(row.get("path"), str) or not isinstance(row.get("reason"), str):
            continue
        reason = row["reason"]
        if not any("\u4e00" <= char <= "\u9fff" for char in reason):
            if any(word in reason for word in ("unregistered", "foreign", "reserved", "exists")):
                reason = "无法确认该文件属于本次导出，已保留，请检查该路径。"
            elif any(word in reason for word in ("deleted", "deletion", "removed", "empty")):
                reason = "暂时无法清理，该文件或目录可能仍被占用，请关闭占用程序后重试。"
            elif any(word in reason for word in ("identity", "SHA", "manifest", "receipt", "mismatch", "registry", "invalid")):
                reason = "文件或目录校验未通过，已保留现有内容，请检查该路径后重试。"
            else:
                reason = "上次导出尚待恢复核对，该路径已保留，请重试或检查存储目录。"
        result.append({"path": row["path"], "reason": reason})
    return result


def handle_export_request(request: dict[str, Any]) -> dict[str, Any]:
    operation = request.get("op")
    if operation not in _OPERATIONS or set(request) != {"op"} | _PRIVATE_FIELDS | _OPERATIONS[operation]:
        return {"status": "error", "code": "invalid_request", "message": "导出请求字段无效。"}
    report_progress = operation in _PROGRESS_OPERATIONS
    if report_progress:
        report_export_progress("validating", force=True)
    try:
        paths = {}
        for key in _PRIVATE_FIELDS:
            value = request[key]
            if not isinstance(value, str) or not 0 < len(value.encode("utf-8")) <= 32768 or "\x00" in value:
                raise ExportScopeError("host path is invalid")
            path = Path(value)
            if not path.is_absolute():
                raise ExportScopeError("host path must be absolute")
            paths[key] = path
        if operation == "export_intent_grouping_draft":
            from .receipt_grouping_draft import publish_grouping_draft
            return {"status": "ok", "data": publish_grouping_draft(paths["batch_database_path"], paths["review_database_path"], request)}
        service = ExportBundleService(paths["batch_database_path"], paths["review_database_path"],
                                      paths["journal_root"], paths["preview_root"])
        if operation == "export_intent_create":
            data = service.create(request["scope"])
        elif operation == "export_intent_render":
            data = service.render(request["intent_id"])
        elif operation == "export_intent_describe":
            data = service.describe(request["intent_id"])
        elif operation == "export_intent_close":
            data = service.close(request["intent_id"])
        elif operation == "export_intent_publish":
            from .export_publish import publish_bundle
            data = publish_bundle(service, request["intent_id"], request["directory"])
        elif operation == "export_intent_reconcile":
            data = service.reconcile(request["active_tokens"])
        else:
            from .export_publish import status_bundle
            data = status_bundle(service, request["job_id"])
        if isinstance(data, dict) and "residuals" in data:
            data["residuals"] = _public_residuals(data["residuals"])
        return {"status": "ok", "data": data}
    except ExportJournalQuotaError:
        return {"status": "error", "code": "export_capacity_exceeded", "message": _MESSAGES["export_capacity_exceeded"]}
    except ExportScopeError as error:
        response: dict[str, Any] = {"status": "error", "code": error.code,
                                    "message": _MESSAGES.get(error.code, "整套导出未能完成，预览已保留，可重试或选择其他目录。")}
        residuals = getattr(error, "residuals", None)
        if isinstance(residuals, list):
            response["residuals"] = _public_residuals(residuals)
        return response
    except Exception:
        return {"status": "error", "code": "export_failed", "message": "导出操作未完成，请检查任务与存储目录后重试。"}
    finally:
        if report_progress:
            report_export_progress("finalizing", force=True)
