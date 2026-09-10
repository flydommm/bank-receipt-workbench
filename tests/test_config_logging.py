from __future__ import annotations

import io
import logging
from pathlib import Path

from engine.config import (
    DEFAULT_LOG_LEVEL,
    DEFAULT_MAX_FILE_BYTES,
    DEFAULT_MAX_FILES,
    DEFAULT_MAX_PAGES,
    ENV_LOG_LEVEL,
    ENV_MAX_FILE_BYTES,
    ENV_MAX_FILES,
    ENV_MAX_PAGES,
    load_config,
)
from engine.error_codes import DEFAULT_ERROR_MESSAGES, ERROR_CODES, ErrorCode, error_response
from engine.logging_utils import configure_logging, get_logger, log_exception, sanitize_message


def test_config_defaults_are_safe_and_documented() -> None:
    config = load_config({})

    assert config.log_level == DEFAULT_LOG_LEVEL == "INFO"
    assert config.max_pages == DEFAULT_MAX_PAGES == 5_000
    assert config.max_files == DEFAULT_MAX_FILES == 500
    assert config.max_file_bytes == DEFAULT_MAX_FILE_BYTES == 500 * 1024 * 1024
    assert config.is_valid
    assert config.diagnostics == ()


def test_config_accepts_strict_decimal_limits_and_case_insensitive_level() -> None:
    config = load_config(
        {
            ENV_LOG_LEVEL: "debug",
            ENV_MAX_PAGES: "1200",
            ENV_MAX_FILES: "12",
            ENV_MAX_FILE_BYTES: str(64 * 1024 * 1024),
        }
    )

    assert config.log_level == "DEBUG"
    assert config.max_pages == 1_200
    assert config.max_files == 12
    assert config.max_file_bytes == 64 * 1024 * 1024
    assert config.log_level_number == logging.DEBUG
    assert config.is_valid


def test_config_rejects_invalid_or_out_of_range_environment_values() -> None:
    config = load_config(
        {
            ENV_LOG_LEVEL: "not-a-level",
            ENV_MAX_PAGES: "-1",
            ENV_MAX_FILES: "12.5",
            ENV_MAX_FILE_BYTES: "999999999999999999999999999999",
        }
    )

    assert config.log_level == DEFAULT_LOG_LEVEL
    assert config.max_pages == DEFAULT_MAX_PAGES
    assert config.max_files == DEFAULT_MAX_FILES
    assert config.max_file_bytes == DEFAULT_MAX_FILE_BYTES
    assert {item.variable for item in config.diagnostics} == {
        ENV_LOG_LEVEL,
        ENV_MAX_PAGES,
        ENV_MAX_FILES,
        ENV_MAX_FILE_BYTES,
    }
    # Diagnostics identify only the setting and reason, never the rejected
    # value, which may have been supplied by an untrusted host.
    assert all("999999999999999999999999999999" not in str(item) for item in config.diagnostics)


def test_config_rejects_non_string_and_whitespace_numeric_values() -> None:
    config = load_config(
        {
            ENV_MAX_PAGES: 100,
            ENV_MAX_FILES: " 12 ",
            ENV_MAX_FILE_BYTES: "1e6",
        }
    )

    assert config.max_pages == DEFAULT_MAX_PAGES
    assert config.max_files == DEFAULT_MAX_FILES
    assert config.max_file_bytes == DEFAULT_MAX_FILE_BYTES
    assert len(config.diagnostics) == 3


def test_standard_logging_redacts_paths_keywords_and_pdf_content() -> None:
    stream = io.StringIO()
    logger_name = "pdf_search.test.redaction"
    logger = configure_logging(level="DEBUG", stream=stream, logger_name=logger_name)
    source_path = r"C:\Sensitive\Bank Statements\statement.pdf"
    keyword = "手续费"
    pdf_content = "收款方：手续费；仅用于测试"

    logger.warning(
        "source_path=%s keyword=%s content=%s",
        source_path,
        keyword,
        pdf_content,
    )
    output = stream.getvalue()

    assert source_path not in output
    assert keyword not in output
    assert pdf_content not in output
    assert "<redacted>" in output


def test_logger_boundary_redacts_records_sent_to_root_handlers() -> None:
    stream = io.StringIO()
    root = logging.getLogger()
    handler = logging.StreamHandler(stream)
    root.addHandler(handler)
    try:
        logger = get_logger("pdf_search.test.root-redaction")
        logger.warning("path=%s keyword=%s", r"C:\\Secret\\statement.pdf", "手续费")
        output = stream.getvalue()
    finally:
        root.removeHandler(handler)
        handler.close()

    assert "statement.pdf" not in output
    assert "手续费" not in output
    assert "<path>" in output or "<redacted>" in output


def test_log_exception_keeps_only_safe_summary_and_exception_type() -> None:
    stream = io.StringIO()
    logger = configure_logging(
        level="DEBUG",
        stream=stream,
        logger_name="pdf_search.test.exception",
    )
    source_path = Path(r"C:\Sensitive\statement.pdf")
    keyword = "手续费"
    error = RuntimeError(f"failed to parse {source_path}: {keyword} in PDF text")

    log_exception(
        logger,
        logging.ERROR,
        operation="search",
        code=ErrorCode.SEARCH_FAILED.value,
        error=error,
        public_message=DEFAULT_ERROR_MESSAGES[ErrorCode.SEARCH_FAILED.value],
    )
    output = stream.getvalue()

    assert str(source_path) not in output
    assert keyword not in output
    assert "PDF text" not in output
    assert "search_failed" in output
    assert "RuntimeError" in output


def test_error_codes_preserve_existing_jsonl_wire_values() -> None:
    assert ErrorCode.FILE_NOT_FOUND.value == "file_not_found"
    assert ErrorCode.PDF_NOT_FOUND.value == "file_not_found"
    assert ErrorCode.SEARCH_FAILED.value == "search_failed"
    assert ErrorCode.PAGE_LIMIT_EXCEEDED.value in ERROR_CODES
    assert error_response(ErrorCode.FILE_NOT_FOUND) == {
        "status": "error",
        "code": "file_not_found",
        "message": "PDF file does not exist",
    }
    assert error_response("legacy_code") == {
        "status": "error",
        "code": "legacy_code",
        "message": "operation failed",
    }


def test_sanitize_message_redacts_explicit_sensitive_values() -> None:
    source_path = r"D:\Archive\statement.pdf"
    keyword = "手续费"
    content = "交易备注：手续费"

    result = sanitize_message(
        f"processing {source_path}",
        sensitive_values=(source_path, keyword, content),
    )

    assert source_path not in result
    assert keyword not in result
    assert content not in result
