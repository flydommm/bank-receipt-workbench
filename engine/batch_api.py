"""Short batch management operations called with host-owned database paths.

Page writes and snapshot publication deliberately have no command entry.  The
desktop host injects the private database and supervisor nonce; webview input
cannot choose them.  Each short operation owns a fresh SQLite connection.
"""

from __future__ import annotations

from pathlib import Path
import sqlite3
from typing import Any

from .batch_models import BatchModelError
from .batch_pdf import BatchSourceError, open_batch_source
from .batch_cleanup import (
    BatchCleanupConflict,
    BatchCleanupError,
    cleanup_dto,
    execute_cleanup,
    list_cleanups_page,
    plan_cleanup,
    storage_maintain,
    storage_usage,
)
from .batch_store import (
    BatchCapacityExceeded, BatchComputationChanged, BatchConflict, BatchSchemaIncompatible,
    BatchStore, BatchStoreError,
)
from .computation import current_computation_version
from .review_store_v2 import ReviewRevisionConflict
from .receipt_layout_history import TemplateUnavailableError


_FIELDS = {
    "batch_activate": {"owner"},
    "batch_create": {"name", "sources", "criteria", "match_mode"},
    "batch_create_receipts": {"name", "sources", "processing_options", "match_mode"},
    "batch_start": {"job_id", "generation", "owner"},
    "batch_snapshot": {"job_id"},
    "batch_list": {"offset", "limit"},
    "batch_control": {"job_id", "generation", "command_id", "action"},
    "batch_results_page": {"job_id", "result_revision", "offset", "limit"},
    "batch_finish_stop": {"job_id", "generation", "owner", "cancelled"},
    "batch_relocate": {"job_id", "source_id", "new_path"},
    "batch_prepare_review": {"job_id", "result_revision", "review_database_path"},
    "batch_receipt_review_page": {"job_id", "result_revision", "offset", "limit", "review_database_path"},
    "batch_save_receipt_review": {"job_id", "result_revision", "edits", "review_database_path"},
    "batch_receipt_calibration_prepare": {"job_id", "result_revision", "sample_id", "review_database_path"},
    "batch_receipt_calibration_preview": {"job_id", "result_revision", "sample_id", "preparation_fingerprint",
                                          "layout_definition", "include_exception_ids", "review_database_path"},
    "batch_receipt_template_apply_preview": {"job_id", "result_revision", "template_id",
                                             "review_database_path", "template_database_path"},
    "batch_receipt_calibration_save": {"job_id", "operation_id", "preview_fingerprint", "acknowledged_risk_ids", "review_database_path"},
    "batch_receipt_calibration_undo": {"job_id", "operation_id", "undo_id", "review_database_path"},
    "batch_receipt_calibration_status": {"job_id", "operation_id"},
    "batch_receipt_calibration_cancel": {"job_id", "operation_id"},
    # Layout references are persisted by the host-owned template database.
    # The path is deliberately an injected/private field, just like the
    # review database path above; it must never be supplied by the webview.
    "batch_layout_template_save": {"template", "template_database_path"},
    "batch_layout_template_list": {"active_only", "offset", "limit", "template_database_path"},
    "batch_layout_template_rename": {"template_id", "name", "template_database_path"},
    "batch_layout_template_match": {
        "source_scope", "page_geometry", "layout_fingerprint", "slots", "template_database_path",
    },
    "batch_layout_template_deactivate": {"template_id", "operation_id", "template_database_path"},
    "batch_layout_template_withdraw_operation": {"operation_id", "undo_id", "template_database_path"},
    "batch_register_preview": {"job_id", "token", "preview_root"},
    "batch_release_preview": {"token"},
    "batch_cleanup_plan": {"job_id", "review_database_path"},
    "batch_cleanup_execute": {"cleanup_id", "delete_review", "review_database_path"},
    "batch_cleanup_list": {"offset", "limit"},
    "batch_storage_usage": set(),
    "batch_storage_maintain": set(),
}

# The desktop host injects this path after the webview request has passed the
# Rust allowlist. Keep it optional for direct Python callers and older clients;
# dispatch still validates it before opening the auxiliary database.
_OPTIONAL_FIELDS = {
    "batch_create_receipts": {"layout_template_id", "template_database_path"},
    "batch_receipt_calibration_prepare": {"template_database_path"},
    "batch_receipt_calibration_preview": {"template_database_path"},
    "batch_receipt_calibration_save": {"template_database_path", "remember_reference", "template_name",
                                       "template_save_mode", "template_id", "template_bank_name"},
    "batch_receipt_calibration_undo": {"template_database_path"},
}


def _private_review_database(store: BatchStore, value: object) -> Path:
    if not isinstance(value, str) or len(value) > 32768 or "\0" in value:
        raise BatchModelError("invalid review database")
    database = Path(value)
    try:
        same_database = database.resolve(strict=False) == Path(store.path).resolve(strict=False)
    except OSError:
        same_database = False
    if not database.is_absolute() or database.suffix != ".sqlite3" or same_database:
        raise BatchModelError("invalid review database")
    return database


def _private_template_database(store: BatchStore, value: object) -> Path:
    """Validate the host-injected path used for layout references.

    Template records live outside the task database so a renderer/webview
    cannot redirect writes into arbitrary files.  The review and template
    databases may intentionally be the same private app database (SQLite
    tables are independent), but neither may be the task database itself.
    """
    return _private_review_database(store, value)


def _request_identifier(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\0" in value or len(value.encode("utf-8")) > 1024:
        raise BatchModelError(f"invalid {field}")
    return value.strip()


def _dispatch(store: BatchStore, op: str, data: dict[str, Any]) -> Any:
    if op == "batch_receipt_template_apply_preview":
        from .receipt_layout_review import prepare_receipt_template_apply, preview_receipt_calibration
        from .receipt_calibration_journal import retain_calibration_preview
        review_database = _private_review_database(store, data["review_database_path"])
        template_database = _private_template_database(store, data["template_database_path"])
        template_id = _request_identifier(data["template_id"], "template id")
        prepared, draft, reference = prepare_receipt_template_apply(
            store, data["job_id"], data["result_revision"], template_id,
            review_database, template_database)
        preview = preview_receipt_calibration(
            store, prepared, draft, review_database, template_reference=reference)
        return retain_calibration_preview(store, preview, review_database)
    if op in {"batch_receipt_calibration_prepare", "batch_receipt_calibration_preview"}:
        from .receipt_layout_review import prepare_receipt_calibration, preview_receipt_calibration
        from .receipt_calibration_journal import retain_calibration_preview
        database = _private_review_database(store, data["review_database_path"])
        prepared = prepare_receipt_calibration(store, data["job_id"], data["result_revision"], data["sample_id"], database)
        if "template_database_path" in data:
            # Validate host injection without changing the authoritative base.
            # Historical geometry is pinned and applied during analysis. Save
            # reconstructs this same preparation, including its fingerprint.
            _private_template_database(store, data["template_database_path"])
        if op == "batch_receipt_calibration_prepare":
            return prepared.view()
        if data["preparation_fingerprint"] != prepared.fingerprint:
            raise BatchConflict("calibration preparation changed")
        preview = preview_receipt_calibration(store, prepared, data["layout_definition"], database,
                                              include_exception_ids=data["include_exception_ids"])
        return retain_calibration_preview(store, preview, database)
    if op == "batch_receipt_calibration_save":
        from .receipt_calibration_journal import save_calibration_preview
        template_database = (_private_template_database(store, data["template_database_path"])
                             if "template_database_path" in data else None)
        return save_calibration_preview(store, data["job_id"], data["operation_id"], data["preview_fingerprint"],
            _private_review_database(store, data["review_database_path"]), acknowledged_risk_ids=data["acknowledged_risk_ids"],
            template_database=template_database,
            remember_reference=data.get("remember_reference", True), template_name=data.get("template_name"),
            template_save_mode=data.get("template_save_mode", "create"), template_id=data.get("template_id"),
            template_bank_name=data.get("template_bank_name"))
    if op == "batch_receipt_calibration_undo":
        from .receipt_calibration_journal import undo_calibration_operation
        return undo_calibration_operation(
            store, data["job_id"], data["operation_id"],
            _private_review_database(store, data["review_database_path"]),
            undo_id=data["undo_id"],
            template_database=(_private_template_database(store, data["template_database_path"])
                               if "template_database_path" in data else None),
        )
    if op == "batch_receipt_calibration_status":
        from .receipt_calibration_journal import calibration_operation_status
        return calibration_operation_status(store, data["job_id"], data["operation_id"])
    if op == "batch_receipt_calibration_cancel":
        from .receipt_calibration_journal import cancel_calibration_preview
        cancel_calibration_preview(store, data["job_id"], data["operation_id"])
        return {"cancelled": True}
    if op == "batch_register_preview":
        from .batch_previews import register_preview

        root = data["preview_root"]
        if not isinstance(root, str) or len(root) > 32768 or "\0" in root:
            raise BatchModelError("invalid private preview root")
        register_preview(store, data["job_id"], data["token"], Path(root))
        return {"registered": True}
    if op == "batch_release_preview":
        from .batch_previews import release_absent_preview

        release_absent_preview(store, data["token"])
        return {"checked": True}
    if op == "batch_activate":
        return store.activate_supervisor(data["owner"])
    if op == "batch_create":
        return store.create_job(data["name"], data["sources"], data["criteria"], data["match_mode"], current_computation_version())
    if op == "batch_create_receipts":
        from .receipt_layout_history import selected_reference
        template_id = data.get("layout_template_id")
        database = (_private_template_database(store, data["template_database_path"])
                    if "template_database_path" in data else None)
        reference = None
        if template_id is not None:
            template_id = _request_identifier(template_id, "layout_template_id")
            if database is None:
                raise TemplateUnavailableError("selected layout template database is unavailable")
            reference = selected_reference(store, database, template_id)
        return store.create_receipt_job(
            data["name"], data["sources"], data["processing_options"], data["match_mode"],
            current_computation_version(), historical_reference=reference,
        )
    if op == "batch_start":
        return store.start_job(data["job_id"], data["generation"], data["owner"], current_computation_version())
    if op == "batch_snapshot":
        return store.get_job(data["job_id"])
    if op == "batch_list":
        return store.list_jobs(data["offset"], data["limit"])
    if op == "batch_control":
        return store.control(data["job_id"], data["generation"], data["command_id"], data["action"])
    if op == "batch_results_page":
        return store.results_page(data["job_id"], data["result_revision"], data["offset"], data["limit"])
    if op == "batch_prepare_review":
        from .batch_review import prepare_batch_review

        database = _private_review_database(store, data["review_database_path"])
        result = prepare_batch_review(store, data["job_id"], data["result_revision"], database)
        # Keep the rich helper result for internal callers, but expose only a
        # compact preparation acknowledgement for schema-2 receipt jobs.  The
        # item records and per-item revisions are obtained through the
        # explicit read page operation below.
        if isinstance(result.get("context"), dict) and result["context"].get("version") == 3:
            prepared = result["prepared"]
            revisions = prepared.get("record_revisions")
            if not isinstance(revisions, list):
                raise BatchStoreError("receipt preparation revisions are invalid")
            return {
                "context": result["context"],
                **({"template_choice_ids": result["template_choice_ids"]} if result.get("template_choice_ids") else {}),
                "prepared": {
                    "status": "ok",
                    "schema_version": 1,
                    "context_key": prepared["context_key"],
                    "result_revision": prepared["result_revision"],
                    "total": len(revisions),
                },
            }
        return result
    if op == "batch_receipt_review_page":
        from .batch_review import read_batch_receipt_review_page

        database = _private_review_database(store, data["review_database_path"])
        return read_batch_receipt_review_page(
            store, data["job_id"], data["result_revision"], data["offset"], data["limit"], database,
        )
    if op == "batch_save_receipt_review":
        from .batch_review import save_batch_receipt_review

        database = _private_review_database(store, data["review_database_path"])
        return save_batch_receipt_review(
            store, data["job_id"], data["result_revision"], data["edits"], database,
        )
    if op in {"batch_layout_template_list", "batch_layout_template_rename"}:
        from .layout_template_store import LayoutTemplateStore
        templates = LayoutTemplateStore(_private_template_database(store, data["template_database_path"]))
        if op == "batch_layout_template_list":
            from .receipt_layout_history import _undone_operations
            return templates.list_page(data["active_only"], data["offset"], data["limit"],
                                       withdrawn_operations=_undone_operations(store))
        return templates.rename(_request_identifier(data["template_id"], "template id"), data["name"])
    if op == "batch_layout_template_save":
        from .layout_template_store import LayoutTemplateStore

        database = _private_template_database(store, data["template_database_path"])
        template = data["template"]
        if not isinstance(template, dict):
            raise BatchModelError("invalid layout template")
        return LayoutTemplateStore(database).save(template)
    if op == "batch_layout_template_match":
        from .layout_template_store import LayoutTemplateStore

        database = _private_template_database(store, data["template_database_path"])
        return LayoutTemplateStore(database).match(
            data["source_scope"], data["page_geometry"], data["layout_fingerprint"], data["slots"],
        )
    if op == "batch_layout_template_deactivate":
        from .layout_template_store import LayoutTemplateStore

        database = _private_template_database(store, data["template_database_path"])
        template_id = _request_identifier(data["template_id"], "template id")
        operation_id = data["operation_id"]
        if operation_id is not None:
            operation_id = _request_identifier(operation_id, "operation id")
        return {"deactivated": LayoutTemplateStore(database).deactivate(template_id, operation_id)}
    if op == "batch_layout_template_withdraw_operation":
        from .layout_template_store import LayoutTemplateStore

        database = _private_template_database(store, data["template_database_path"])
        operation_id = _request_identifier(data["operation_id"], "operation id")
        undo_id = _request_identifier(data["undo_id"], "undo id")
        return LayoutTemplateStore(database).withdraw_source_operation(operation_id, undo_id)
    if op == "batch_cleanup_plan":
        from .batch_previews import snapshot_previews

        database = _private_review_database(store, data["review_database_path"])
        job_id = _request_identifier(data["job_id"], "job id")
        preview_identities = snapshot_previews(store, job_id)
        return cleanup_dto(plan_cleanup(store, database, job_id, preview_identities))
    if op == "batch_cleanup_execute":
        from .batch_previews import cleanup_previews

        database = _private_review_database(store, data["review_database_path"])
        cleanup_id = _request_identifier(data["cleanup_id"], "cleanup id")
        if not isinstance(data["delete_review"], bool):
            raise BatchModelError("invalid delete_review")

        def preview_executor(identities: list[dict[str, object]]) -> dict[str, object]:
            return cleanup_previews(store, identities)

        return cleanup_dto(
            execute_cleanup(
                store,
                database,
                cleanup_id,
                data["delete_review"],
                preview_executor,
            )
        )
    if op == "batch_cleanup_list":
        offset = data["offset"]
        limit = data["limit"]
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0 or offset > 2_147_483_647:
            raise BatchModelError("cleanup list offset is invalid")
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > 20:
            raise BatchModelError("cleanup list limit is invalid")
        page = list_cleanups_page(
            store,
            offset=offset,
            limit=limit,
        )
        items = page["items"]
        if not isinstance(items, list):
            raise BatchCleanupError("cleanup list is invalid")
        return {
            "items": [cleanup_dto(item) for item in items],
            "next_offset": page["next_offset"],
        }
    if op == "batch_storage_usage":
        return storage_usage(store)
    if op == "batch_storage_maintain":
        maintenance = storage_maintain(store)
        return {
            "outcome": maintenance["outcome"],
            "usage": maintenance["usage"],
        }
    if op == "batch_finish_stop":
        return store.finish_stop(data["job_id"], data["generation"], data["owner"], data["cancelled"])
    if op == "batch_relocate":
        job = store.get_job(data["job_id"])
        source = next((source for source in job["sources"] if source["source_id"] == data["source_id"]), None)
        if source is None or source["sha256"] is None:
            raise BatchConflict("source has no immutable identity to relocate")
        with open_batch_source(data["new_path"], source["sha256"]) as opened:
            if opened.page_count != source["page_count"]:
                raise BatchConflict("relocated source page count does not match")
            return store.relocate_source(data["job_id"], data["source_id"], data["new_path"], opened.sha256, opened.size_bytes)
    raise BatchModelError("unsupported batch operation")


def handle_batch_request(request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(request, dict):
        return {"status": "error", "code": "batch_invalid_request", "message": "任务请求无效"}
    op = request.get("op")
    if not isinstance(op, str) or op not in _FIELDS:
        return {"status": "error", "code": "batch_invalid_request", "message": "任务请求无效"}
    required_fields = {"op", "database_path", *_FIELDS[op]}
    optional_fields = _OPTIONAL_FIELDS.get(op, set())
    request_fields = set(request)
    if not required_fields <= request_fields or not request_fields - required_fields <= optional_fields:
        return {"status": "error", "code": "batch_invalid_request", "message": "任务请求无效"}
    database = request.get("database_path")
    if not isinstance(database, str) or len(database) > 32768 or "\0" in database:
        return {"status": "error", "code": "batch_invalid_request", "message": "任务请求无效"}
    path = Path(database)
    if not path.is_absolute() or path.suffix != ".sqlite3":
        return {"status": "error", "code": "batch_invalid_request", "message": "任务请求无效"}
    try:
        with BatchStore(path) as store:
            result = _dispatch(store, op, request)
        return {"status": "ok", "data": result}
    except TemplateUnavailableError:
        code, message = "template_unavailable", "所选版式模板已停用、撤销或不可用，请刷新模板列表后重新选择"
    except BatchCapacityExceeded:
        code, message = "batch_capacity_exceeded", "任务存储空间不足，可清理已完成的任务后继续"
    except BatchSchemaIncompatible:
        code, message = "batch_schema_incompatible", "任务数据来自较新版本，请使用相应版本打开"
    except BatchComputationChanged:
        code, message = "computation_version_changed", "计算版本已变化，请重新选择原始 PDF 开始新的分析任务"
    except BatchConflict:
        code, message = "batch_conflict", "任务状态已变化，请刷新后重试"
    except BatchCleanupConflict:
        code, message = "batch_conflict", "任务状态已变化，请刷新后重试"
    except BatchCleanupError:
        code, message = "batch_cleanup_failed", "清理操作未完成，请刷新后重试"
    except BatchSourceError as error:
        code, message = error.code, "原始文件无法核验，请选择内容相同的 PDF"
    except ReviewRevisionConflict:
        code, message = "batch_conflict", "审核记录已被其他操作更新，请刷新后重试"
    except (BatchModelError, BatchStoreError, TypeError, ValueError):
        code, message = "batch_invalid_request", "任务请求或已保存的数据无效"
    except (OSError, sqlite3.Error):
        code, message = "batch_store_failed", "无法读取或保存任务，请稍后重试"
    except Exception:
        code, message = "batch_store_failed", "任务操作未完成，请稍后重试"
    return {"status": "error", "code": code, "message": message}
