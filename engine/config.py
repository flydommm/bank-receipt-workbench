"""Centralized, fail-closed configuration for the local PDF engine.

The engine is intentionally configured from a very small set of environment
variables.  Values are parsed strictly and invalid values fall back to the
safe built-in default; the diagnostic records contain the variable name and
reason only, never the supplied value.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import logging
import os
import re
from typing import Mapping


DEFAULT_LOG_LEVEL = "INFO"
DEFAULT_MAX_PAGES = 5_000
DEFAULT_MAX_FILES = 500
# Keep the documented 500 MB default exact.  The binary conversion makes the
# limit deterministic across platforms and avoids relying on locale-specific
# units in environment variables.
DEFAULT_MAX_FILE_BYTES = 500 * 1024 * 1024

MIN_MAX_PAGES = 1
MAX_MAX_PAGES = 100_000
MIN_MAX_FILES = 1
MAX_MAX_FILES = 10_000
MIN_MAX_FILE_BYTES = 1
MAX_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024

ENV_LOG_LEVEL = "PDF_SEARCH_LOG_LEVEL"
ENV_MAX_PAGES = "PDF_SEARCH_MAX_PAGES"
ENV_MAX_FILES = "PDF_SEARCH_MAX_FILES"
ENV_MAX_FILE_BYTES = "PDF_SEARCH_MAX_FILE_BYTES"

_INTEGER_PATTERN = re.compile(r"^[0-9]+$")
_LOG_LEVELS = frozenset({"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"})
_LOG_LEVEL_ALIASES = {"WARN": "WARNING"}


@dataclass(frozen=True)
class ConfigDiagnostic:
    """A safe explanation for one rejected environment setting."""

    variable: str
    reason: str

    def __str__(self) -> str:
        return f"{self.variable}:{self.reason}"


@dataclass(frozen=True)
class EngineConfig:
    """Runtime limits and logging settings used by the local engine."""

    log_level: str = DEFAULT_LOG_LEVEL
    max_pages: int = DEFAULT_MAX_PAGES
    max_files: int = DEFAULT_MAX_FILES
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES
    diagnostics: tuple[ConfigDiagnostic, ...] = field(default_factory=tuple)

    @property
    def log_level_number(self) -> int:
        """Return the standard-library numeric level for this config."""

        return logging.getLevelNamesMapping().get(self.log_level, logging.INFO)

    @property
    def is_valid(self) -> bool:
        """Whether all values came from defaults or valid settings."""

        return not self.diagnostics

    @property
    def warnings(self) -> tuple[ConfigDiagnostic, ...]:
        """Compatibility alias for callers that call diagnostics warnings."""

        return self.diagnostics

    def as_dict(self, *, include_diagnostics: bool = False) -> dict[str, object]:
        """Return safe configuration metadata without environment values."""

        payload: dict[str, object] = {
            "log_level": self.log_level,
            "max_pages": self.max_pages,
            "max_files": self.max_files,
            "max_file_bytes": self.max_file_bytes,
        }
        if include_diagnostics:
            payload["diagnostics"] = [
                {"variable": item.variable, "reason": item.reason}
                for item in self.diagnostics
            ]
        return payload

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, object] | None = None,
        *,
        logger: logging.Logger | None = None,
    ) -> "EngineConfig":
        """Build configuration from an environment-like mapping.

        ``environ`` is injectable for deterministic tests.  The process
        environment is used when it is omitted.  Invalid settings never make
        the engine accept a broader workload than the built-in safe default.
        """

        values = os.environ if environ is None else environ
        diagnostics: list[ConfigDiagnostic] = []

        log_level = _parse_log_level(values.get(ENV_LOG_LEVEL), diagnostics)
        max_pages = _parse_integer(
            values.get(ENV_MAX_PAGES),
            name=ENV_MAX_PAGES,
            default=DEFAULT_MAX_PAGES,
            minimum=MIN_MAX_PAGES,
            maximum=MAX_MAX_PAGES,
            diagnostics=diagnostics,
        )
        max_files = _parse_integer(
            values.get(ENV_MAX_FILES),
            name=ENV_MAX_FILES,
            default=DEFAULT_MAX_FILES,
            minimum=MIN_MAX_FILES,
            maximum=MAX_MAX_FILES,
            diagnostics=diagnostics,
        )
        max_file_bytes = _parse_integer(
            values.get(ENV_MAX_FILE_BYTES),
            name=ENV_MAX_FILE_BYTES,
            default=DEFAULT_MAX_FILE_BYTES,
            minimum=MIN_MAX_FILE_BYTES,
            maximum=MAX_MAX_FILE_BYTES,
            diagnostics=diagnostics,
        )

        config = cls(
            log_level=log_level,
            max_pages=max_pages,
            max_files=max_files,
            max_file_bytes=max_file_bytes,
            diagnostics=tuple(diagnostics),
        )
        if logger is not None:
            for diagnostic in config.diagnostics:
                # Do not include the rejected value: it could contain a
                # secret or a path even though these variables normally hold
                # simple scalar values.
                logger.warning(
                    "configuration fallback variable=%s reason=%s",
                    diagnostic.variable,
                    diagnostic.reason,
                )
        return config


def _diagnostic(
    diagnostics: list[ConfigDiagnostic], name: str, reason: str
) -> None:
    diagnostics.append(ConfigDiagnostic(name, reason))


def _parse_log_level(
    raw: object,
    diagnostics: list[ConfigDiagnostic],
) -> str:
    if raw is None:
        return DEFAULT_LOG_LEVEL
    if not isinstance(raw, str):
        _diagnostic(diagnostics, ENV_LOG_LEVEL, "invalid_type")
        return DEFAULT_LOG_LEVEL
    normalized = raw.strip().upper()
    normalized = _LOG_LEVEL_ALIASES.get(normalized, normalized)
    if normalized not in _LOG_LEVELS:
        _diagnostic(diagnostics, ENV_LOG_LEVEL, "invalid_value")
        return DEFAULT_LOG_LEVEL
    return normalized


def _parse_integer(
    raw: object,
    *,
    name: str,
    default: int,
    minimum: int,
    maximum: int,
    diagnostics: list[ConfigDiagnostic],
) -> int:
    if raw is None:
        return default
    if not isinstance(raw, str):
        _diagnostic(diagnostics, name, "invalid_type")
        return default
    # Environment values are deliberately accepted only as decimal digits;
    # units, signs, floating-point notation and surrounding whitespace are
    # rejected instead of being silently reinterpreted.
    normalized = raw
    if not _INTEGER_PATTERN.fullmatch(normalized):
        _diagnostic(diagnostics, name, "invalid_integer")
        return default
    try:
        value = int(normalized, 10)
    except (OverflowError, ValueError):
        _diagnostic(diagnostics, name, "invalid_integer")
        return default
    if not minimum <= value <= maximum:
        _diagnostic(diagnostics, name, "out_of_range")
        return default
    return value


def load_config(
    environ: Mapping[str, object] | None = None,
    *,
    logger: logging.Logger | None = None,
) -> EngineConfig:
    """Public configuration loader used by the engine and embedding hosts."""

    return EngineConfig.from_env(environ, logger=logger)


DEFAULT_CONFIG = EngineConfig()


__all__ = [
    "ConfigDiagnostic",
    "DEFAULT_CONFIG",
    "DEFAULT_LOG_LEVEL",
    "DEFAULT_MAX_FILE_BYTES",
    "DEFAULT_MAX_FILES",
    "DEFAULT_MAX_PAGES",
    "EngineConfig",
    "ENV_LOG_LEVEL",
    "ENV_MAX_FILE_BYTES",
    "ENV_MAX_FILES",
    "ENV_MAX_PAGES",
    "load_config",
]
