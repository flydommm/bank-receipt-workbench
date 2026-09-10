"""Stable error codes for the local JSONL processing engine.

The React/Tauri boundary consumes ``code`` as a machine-readable value.  Keep
the values in one place and use the existing strings for backwards
compatibility.  Messages are intentionally short and contain no local paths,
keywords, or extracted PDF text.
"""

from __future__ import annotations

from enum import Enum
from typing import Mapping


class ErrorCode(str, Enum):
    """Public error categories exposed by the engine protocol."""

    INVALID_JSON = "invalid_json"
    INVALID_REQUEST = "invalid_request"
    UNSUPPORTED_OPERATION = "unsupported_operation"
    INVALID_PATH = "invalid_path"
    EMPTY_KEYWORD = "empty_keyword"
    INVALID_QUERIES = "invalid_queries"
    EMPTY_INCLUDE_QUERIES = "empty_include_queries"
    UNSUPPORTED_FILE = "unsupported_file"
    FILE_NOT_FOUND = "file_not_found"
    PDF_NOT_FOUND = "file_not_found"  # descriptive alias; value is stable
    INVALID_PAGE = "invalid_page"
    PAGE_OUT_OF_RANGE = "page_out_of_range"
    PAGE_LIMIT_EXCEEDED = "page_limit_exceeded"
    FILE_TOO_LARGE = "file_too_large"
    FILE_LIMIT_EXCEEDED = "file_limit_exceeded"
    OCR_UNAVAILABLE = "ocr_unavailable"
    OCR_INITIALIZATION_FAILED = "ocr_initialization_failed"
    OCR_INFERENCE_FAILED = "ocr_inference_failed"
    OCR_RESULT_INVALID = "ocr_result_invalid"
    SEARCH_FAILED = "search_failed"
    RENDER_FAILED = "render_failed"
    INVALID_MATCH_RECT = "invalid_match_rect"
    INVALID_MATCHES = "invalid_matches"
    ANALYZE_FAILED = "analyze_failed"
    SOURCE_CHANGED = "source_changed"
    EXPORT_TOKEN_REQUIRED = "export_token_required"
    INVALID_EXPORT_TOKEN = "invalid_export_token"
    EXPORT_BUSY = "export_busy"
    OWNERSHIP_UNAVAILABLE = "ownership_unavailable"
    OWNERSHIP_LOST = "ownership_lost"
    INVALID_OUTPUT_PATH = "invalid_output_path"
    UNSUPPORTED_OUTPUT = "unsupported_output"
    OUTPUT_UNAVAILABLE = "output_unavailable"
    OUTPUT_EXISTS = "output_exists"
    EXPORT_FAILED = "export_failed"
    PDF_EXPORT_FAILED = "pdf_export_failed"
    CLEANUP_FAILED = "cleanup_failed"
    INVALID_CLEANUP_REQUEST = "invalid_cleanup_request"
    INVALID_ROWS = "invalid_rows"
    UNREVIEWED_ROWS = "unreviewed_rows"
    INVALID_SELECTIONS = "invalid_selections"
    INVALID_DATABASE_PATH = "invalid_database_path"
    INVALID_TASK_ID = "invalid_task_id"
    INVALID_REVIEW_SEGMENTS = "invalid_review_segments"
    REVIEW_STORE_FAILED = "review_store_failed"
    REVIEW_REVISION_CONFLICT = "review_revision_conflict"
    COMPUTATION_VERSION_CHANGED = "computation_version_changed"
    INVALID_CONFIG = "invalid_config"


DEFAULT_ERROR_MESSAGES: Mapping[str, str] = {
    ErrorCode.INVALID_JSON.value: "request must be valid JSON",
    ErrorCode.INVALID_REQUEST.value: "request must be a JSON object",
    ErrorCode.UNSUPPORTED_OPERATION.value: "unsupported operation",
    ErrorCode.INVALID_PATH.value: "path is required",
    ErrorCode.EMPTY_KEYWORD.value: "keyword is required",
    ErrorCode.INVALID_QUERIES.value: "search queries are invalid",
    ErrorCode.EMPTY_INCLUDE_QUERIES.value: "at least one include query is required",
    ErrorCode.UNSUPPORTED_FILE.value: "only PDF files are supported",
    ErrorCode.FILE_NOT_FOUND.value: "PDF file does not exist",
    ErrorCode.INVALID_PAGE.value: "page must be a positive integer",
    ErrorCode.PAGE_OUT_OF_RANGE.value: "page is out of range",
    ErrorCode.PAGE_LIMIT_EXCEEDED.value: "PDF page count exceeds the configured limit",
    ErrorCode.FILE_TOO_LARGE.value: "PDF file exceeds the configured size limit",
    ErrorCode.FILE_LIMIT_EXCEEDED.value: "file count exceeds the configured limit",
    ErrorCode.OCR_UNAVAILABLE.value: "OCR runtime is unavailable",
    ErrorCode.OCR_INITIALIZATION_FAILED.value: "OCR runtime initialization failed",
    ErrorCode.OCR_INFERENCE_FAILED.value: "OCR inference failed",
    ErrorCode.OCR_RESULT_INVALID.value: "OCR returned an invalid result",
    ErrorCode.SEARCH_FAILED.value: "PDF search failed",
    ErrorCode.RENDER_FAILED.value: "PDF page rendering failed",
    ErrorCode.INVALID_MATCH_RECT.value: "each match must be finite, ordered, and inside the page",
    ErrorCode.INVALID_MATCHES.value: "matches must be an array",
    ErrorCode.ANALYZE_FAILED.value: "PDF page analysis failed",
    ErrorCode.SOURCE_CHANGED.value: "source PDF changed during processing",
    ErrorCode.EXPORT_TOKEN_REQUIRED.value: "export token is required",
    ErrorCode.INVALID_EXPORT_TOKEN.value: "export token is invalid",
    ErrorCode.EXPORT_BUSY.value: "导出正在进行，请稍后重试",
    ErrorCode.OWNERSHIP_UNAVAILABLE.value: "导出文件登记不可用，请重试",
    ErrorCode.OWNERSHIP_LOST.value: "导出文件登记已失效，请重试",
    ErrorCode.INVALID_OUTPUT_PATH.value: "output path is invalid",
    ErrorCode.UNSUPPORTED_OUTPUT.value: "unsupported output",
    ErrorCode.OUTPUT_UNAVAILABLE.value: "导出目录不可用，请选择其他位置",
    ErrorCode.OUTPUT_EXISTS.value: "导出文件已存在，请更换输出位置后重试",
    ErrorCode.EXPORT_FAILED.value: "导出失败",
    ErrorCode.PDF_EXPORT_FAILED.value: "PDF 导出失败",
    ErrorCode.CLEANUP_FAILED.value: "导出文件清理失败，请稍后重试",
    ErrorCode.INVALID_CLEANUP_REQUEST.value: "cleanup requires its own operation",
    ErrorCode.INVALID_ROWS.value: "rows must be an array",
    ErrorCode.UNREVIEWED_ROWS.value: "all rows must be reviewed before export",
    ErrorCode.INVALID_SELECTIONS.value: "selections must be an array",
    ErrorCode.INVALID_DATABASE_PATH.value: "database_path is invalid",
    ErrorCode.INVALID_TASK_ID.value: "task_id is required",
    ErrorCode.INVALID_REVIEW_SEGMENTS.value: "review segments are invalid",
    ErrorCode.REVIEW_STORE_FAILED.value: "review store operation failed",
    ErrorCode.REVIEW_REVISION_CONFLICT.value: "review revision conflict; reload the current review state",
    ErrorCode.COMPUTATION_VERSION_CHANGED.value: "computation version is incompatible; run analysis again",
    ErrorCode.INVALID_CONFIG.value: "engine configuration is invalid",
}

# A plain set is useful for adapters that only validate a response code.
ERROR_CODES = frozenset(item.value for item in ErrorCode)


def code_value(code: ErrorCode | str) -> str:
    """Normalize an enum or a compatible string to its wire value."""

    return code.value if isinstance(code, ErrorCode) else str(code)


def error_response(
    code: ErrorCode | str,
    message: str | None = None,
) -> dict[str, str]:
    """Build a stable JSONL error response without implementation details."""

    normalized = code_value(code)
    return {
        "status": "error",
        "code": normalized,
        "message": message if message is not None else DEFAULT_ERROR_MESSAGES.get(normalized, "operation failed"),
    }


__all__ = [
    "DEFAULT_ERROR_MESSAGES",
    "ERROR_CODES",
    "ErrorCode",
    "code_value",
    "error_response",
]
