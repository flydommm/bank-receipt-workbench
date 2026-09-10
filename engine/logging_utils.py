"""Privacy-preserving standard-library logging helpers for the local engine."""

from __future__ import annotations

import logging
from pathlib import Path
import re
from typing import Iterable, Mapping, TextIO


LOGGER_NAME = "pdf_search"
_LOGGER_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"

# These patterns are intentionally conservative: they target path-shaped
# tokens and named fields, rather than attempting to interpret arbitrary PDF
# text.  Structured engine logging should use ``log_event`` below so keywords
# and source metadata are never included in the first place.
_WINDOWS_PATH = re.compile(
    r"(?i)(?:(?:[A-Za-z]:\\|\\\\)(?:[^\\/\r\n\"'<>]*\\)+[^\r\n\"'<>]*)"
)
_UNIX_PATH = re.compile(r"(?<![A-Za-z0-9])/(?:[^\s\"'<>]+/)*[^\s\"'<>]+")
_SENSITIVE_FIELD_NAMES = (
    r"path|file(?:name)?|source(?:_path)?|output(?:_path)?|"
    r"database(?:_path)?|keyword|query|matched_text|text|content|"
    r"pdf_content|token|secret|password"
)
_SENSITIVE_FIELD = re.compile(
    rf"(?i)(\b(?:{_SENSITIVE_FIELD_NAMES})\s*[=:]\s*)"
    rf"(.*?)(?=\s+\b(?:{_SENSITIVE_FIELD_NAMES})\s*[=:]|\s*$)"
)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)(\b(?:api[_-]?key|authorization|bearer|access[_-]?token|password)\s*[=:]\s*)(\S+)"
)


def sanitize_message(
    message: object,
    *,
    sensitive_values: Iterable[object] = (),
    max_length: int = 512,
) -> str:
    """Redact path- and content-shaped values from diagnostic text.

    This helper is for warning/error logs and diagnostics, not debug
    tracebacks.  Debug tracebacks can retain the original exception for local
    troubleshooting, but no exception text is returned over JSONL.
    """

    text = str(message)
    for value in sensitive_values:
        if value is None:
            continue
        candidate = str(value)
        if candidate:
            text = text.replace(candidate, "<redacted>")
    text = _SECRET_ASSIGNMENT.sub(r"\1<redacted>", text)
    text = _SENSITIVE_FIELD.sub(r"\1<redacted>", text)
    text = _WINDOWS_PATH.sub("<path>", text)
    text = _UNIX_PATH.sub("<path>", text)
    text = text.replace("\r", " ").replace("\n", " ")
    if len(text) > max_length:
        text = text[: max_length - 1].rstrip() + "…"
    return text


def get_logger(name: str = LOGGER_NAME) -> logging.Logger:
    """Return a package logger with a silent fallback handler.

    A ``NullHandler`` keeps the JSONL engine quiet when the host has not
    configured logging.  Applications and tests can still attach their own
    standard logging handler, and propagation remains enabled for that use.
    """

    logger = logging.getLogger(name)
    if not logger.handlers:
        logger.addHandler(logging.NullHandler())
    # Apply redaction at the logger boundary, not only on our optional
    # destination handler.  This protects applications that attach a root
    # handler (or a custom handler) before configuring the engine logger.
    if not any(getattr(item, "_pdf_search_sanitizer", False) for item in logger.filters):
        sanitizer = _SanitizingFilter()
        setattr(sanitizer, "_pdf_search_sanitizer", True)
        logger.addFilter(sanitizer)
    return logger


def configure_logging(
    *,
    level: str | int = "INFO",
    stream: TextIO | None = None,
    log_file: str | Path | None = None,
    logger_name: str = LOGGER_NAME,
) -> logging.Logger:
    """Configure an optional standard logging destination.

    No destination is added by default, which prevents protocol noise and
    accidental sensitive output.  ``stream`` and ``log_file`` are explicit
    opt-ins for a desktop host or development diagnostics.
    """

    logger = get_logger(logger_name)
    numeric_level = _coerce_level(level)
    logger.setLevel(numeric_level)
    if stream is None and log_file is None:
        return logger

    # Reconfiguration is common in desktop hosts and tests.  Do not append a
    # second equivalent handler on every call, which would duplicate records.
    for existing in logger.handlers:
        if getattr(existing, "_pdf_search_sanitizer", False):
            return logger

    formatter = logging.Formatter(_LOGGER_FORMAT)
    handler: logging.Handler
    if stream is not None:
        handler = logging.StreamHandler(stream)
    else:
        assert log_file is not None
        destination = Path(log_file)
        destination.parent.mkdir(parents=True, exist_ok=True)
        handler = logging.FileHandler(destination, encoding="utf-8")
    handler.setFormatter(formatter)
    handler.addFilter(_SanitizingFilter())
    setattr(handler, "_pdf_search_sanitizer", True)
    logger.addHandler(handler)
    return logger


class _SanitizingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # Render once so a format argument cannot bypass sanitization.
        record.msg = sanitize_message(record.getMessage())
        record.args = ()
        return True


def log_event(
    logger: logging.Logger,
    level: int,
    event: str,
    *,
    operation: str | None = None,
    code: str | None = None,
    page: int | None = None,
    count: int | None = None,
    reason: str | None = None,
) -> None:
    """Emit an allowlisted, content-free structured event."""

    fields: dict[str, object] = {}
    if operation is not None:
        fields["operation"] = operation
    if code is not None:
        fields["code"] = code
    if page is not None:
        fields["page"] = page
    if count is not None:
        fields["count"] = count
    if reason is not None:
        fields["reason"] = sanitize_message(reason)
    suffix = f" {fields!r}" if fields else ""
    logger.log(level, "%s%s", sanitize_message(event), suffix)


def log_exception(
    logger: logging.Logger,
    level: int,
    *,
    operation: str,
    code: str,
    error: BaseException,
    public_message: str | None = None,
) -> None:
    """Log a safe summary and retain the original exception at DEBUG only."""

    summary = sanitize_message(public_message or "operation failed")
    logger.log(level, "%s: %s", code, summary)
    # Keep the exception *type* as an allowlisted diagnostic.  Exception text
    # can contain a full PDF path, a search keyword, or extracted PDF text;
    # retaining it in a traceback would violate the local logging contract.
    logger.debug(
        "engine exception operation=%s code=%s error_type=%s",
        operation,
        code,
        type(error).__name__,
    )


def _coerce_level(level: str | int) -> int:
    if isinstance(level, bool):
        return logging.INFO
    if isinstance(level, int):
        return level if level >= 0 else logging.INFO
    normalized = str(level).strip().upper()
    if normalized == "WARN":
        normalized = "WARNING"
    return logging.getLevelNamesMapping().get(normalized, logging.INFO)


__all__ = [
    "LOGGER_NAME",
    "configure_logging",
    "get_logger",
    "log_event",
    "log_exception",
    "sanitize_message",
]
