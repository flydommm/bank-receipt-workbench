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


_FIELDS = {
    "batch_activate": {"owner"},
    "batch_create": {"name", "sources", "criteria", "match_mode"},
    "batch_start": {"job_id", "generation", "owner"},
    "batch_snapshot": {"job_id"},
    "batch_list": {"offset", "limit"},
    "batch_control": {"job_id", "generation", "command_id", "action"},
    "batch_results_page": {"job_id", "result_revision", "offset", "limit"},
    "batch_finish_stop": {"job_id", "generation", "owner", "cancelled"},
    "batch_relocate": {"job_id", "source_id", "new_path"},
    "batch_prepare_review": {"job_id", "result_revision", "review_database_path"},
    "batch_register_preview": {"job_id", "token", "preview_root"},
    "batch_release_preview": {"token"},
    "batch_cleanup_plan": {"job_id", "review_database_path"},
    "batch_cleanup_execute": {"cleanup_id", "delete_review", "review_database_path"},
    "batch_cleanup_list": {"offset", "limit"},
    "batch_storage_usage": set(),
    "batch_storage_maintain": set(),
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


def _request_identifier(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\0" in value or len(value.encode("utf-8")) > 1024:
        raise BatchModelError(f"invalid {field}")
    return value.strip()


def _dispatch(store: BatchStore, op: str, data: dict[str, Any]) -> Any:
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
        return prepare_batch_review(store, data["job_id"], data["result_revision"], database)
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
    if not isinstance(op, str) or op not in _FIELDS or set(request) != {"op", "database_path", *_FIELDS[op]}:
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
    except (BatchModelError, BatchStoreError, TypeError, ValueError):
        code, message = "batch_invalid_request", "任务请求或已保存的数据无效"
    except (OSError, sqlite3.Error):
        code, message = "batch_store_failed", "无法读取或保存任务，请稍后重试"
    except Exception:
        code, message = "batch_store_failed", "任务操作未完成，请稍后重试"
    return {"status": "error", "code": code, "message": message}
