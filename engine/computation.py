"""Versioned description of the deterministic PDF computation contract.

The batch/review boundary needs one value that identifies the result-producing
code and its runtime settings.  This module deliberately gathers metadata only:
it reads source files and distribution metadata, but never imports PaddleOCR,
constructs an OCR model, opens a PDF, or walks a user directory.
"""

from __future__ import annotations

from hashlib import sha256
import importlib.metadata
import json
from pathlib import Path
from typing import Mapping

from .config import EngineConfig, load_config
from .ocr import OCR_RUNTIME_PROFILE


RESULT_SCHEMA_VERSION = "analysis-result-v3-page-checkpoints"
FRONTEND_ASSEMBLY_VERSION = "review-context-v2"

# Keep this set explicit.  A future result-producing module must be added here
# intentionally so changing it invalidates persisted analysis/review context.
COMPUTATION_SOURCE_FILES: tuple[str, ...] = (
    "engine/engine.py",
    "engine/pdf_parser.py",
    "engine/search.py",
    "engine/layout.py",
    "engine/ocr.py",
    "engine/ocr_cache.py",
    "engine/ocr_pdf.py",
    "engine/crop.py",
    "engine/config.py",
    "engine/computation.py",
    "engine/batch_models.py",
    "engine/batch_pdf.py",
    "engine/batch_processor.py",
    "engine/batch_results.py",
)

MISSING_DISTRIBUTION_VERSION = "not-installed"


class ComputationInfoError(RuntimeError):
    """Raised when the current computation cannot be identified safely."""

OCR_LANGUAGES: tuple[str, ...] = ("ch",)
OCR_DIRECTION = {
    "document_orientation_classify": False,
    "document_unwarping": False,
    "textline_orientation": False,
}
OCR_PREPROCESS_RECIPE = {
    "render_dpi": 200,
    "alpha": False,
    "coordinate_scale": "72/200",
    "working_copy": "private-temporary-pdf",
}


PackageNotFoundError = importlib.metadata.PackageNotFoundError


def _distribution_version(distribution: str) -> str:
    """Read one installed distribution version without importing its package."""

    try:
        value = importlib.metadata.version(distribution)
        if not isinstance(value, str) or not value.strip():
            raise ComputationInfoError("runtime distribution metadata is invalid")
        return value
    except PackageNotFoundError:
        return MISSING_DISTRIBUTION_VERSION
    except Exception:
        # Metadata can be malformed or inaccessible in a partially installed
        # environment.  A guessed version could incorrectly revive old data.
        raise ComputationInfoError("runtime distribution metadata is unavailable") from None


def _dependency_versions() -> dict[str, str]:
    return {
        "PyMuPDF": _distribution_version("PyMuPDF"),
        "PaddleOCR": _distribution_version("PaddleOCR"),
        "PaddlePaddle": _distribution_version("paddlepaddle"),
        "PaddlePaddleGPU": _distribution_version("paddlepaddle-gpu"),
        "PaddleX": _distribution_version("paddlex"),
    }


def _module_digests() -> dict[str, str]:
    root = Path(__file__).resolve().parent.parent
    digests: dict[str, str] = {}
    for relative_path in COMPUTATION_SOURCE_FILES:
        path = root / relative_path
        try:
            content = path.read_bytes()
        except (OSError, ValueError):
            # A missing source file means the computation contract cannot be
            # safely identified.  Do not substitute a digest and continue.
            raise ComputationInfoError("computation source is unavailable") from None
        digests[relative_path] = sha256(content).hexdigest()
    return digests


def _effective_budgets(config: EngineConfig) -> dict[str, object]:
    # ``as_dict`` contains only configured scalar values.  Diagnostics are
    # intentionally omitted because an invalid environment value that falls
    # back to the same safe setting does not alter computation semantics.
    values = config.as_dict()
    return {
        "max_pages": values["max_pages"],
        "max_files": values["max_files"],
        "max_file_bytes": values["max_file_bytes"],
    }


def _summary(config: EngineConfig) -> dict[str, object]:
    module_digests = _module_digests()
    dependencies = _dependency_versions()
    engine_modules = dict(module_digests)
    ocr = {
        "languages": list(OCR_LANGUAGES),
        "direction": dict(OCR_DIRECTION),
        "preprocess_recipe": dict(OCR_PREPROCESS_RECIPE),
        "runtime_profile": dict(OCR_RUNTIME_PROFILE),
    }
    budgets = _effective_budgets(config)
    return {
        "result_schema_version": RESULT_SCHEMA_VERSION,
        "frontend_assembly_version": FRONTEND_ASSEMBLY_VERSION,
        # The explicit constant defines the ordered set; this single mapping
        # carries the content digest for every result-producing module.
        "engine_modules": engine_modules,
        "dependencies": dependencies,
        "ocr": ocr,
        "budgets": budgets,
    }


def _version_for_summary(summary: Mapping[str, object]) -> str:
    serialized = json.dumps(summary, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    digest = sha256(serialized.encode("utf-8")).hexdigest()
    # Keep the labels visible to diagnostics while remaining below the v2
    # 256-character context field limit.
    return f"m3-{RESULT_SCHEMA_VERSION}-{FRONTEND_ASSEMBLY_VERSION}-{digest[:32]}"


def computation_info(config: EngineConfig | None = None) -> dict[str, object]:
    """Return the current computation version for the JSONL boundary.

    The detailed summary is deliberately kept internal: exposing it over the
    worker protocol duplicates a large payload and creates another public
    schema to maintain.  ``computation_summary`` is available to diagnostics
    and tests that need to inspect the inputs used to derive the version.
    """

    effective_config = config if config is not None else load_config()
    summary = _summary(effective_config)
    version = _version_for_summary(summary)
    return {"status": "ok", "computation_version": version}


def computation_summary(config: EngineConfig | None = None) -> dict[str, object]:
    """Return the single internal summary used to derive the version."""

    effective_config = config if config is not None else load_config()
    return _summary(effective_config)


def current_computation_version(config: EngineConfig | None = None) -> str:
    """Return only the value used to bind a review context."""

    return str(computation_info(config)["computation_version"])


__all__ = [
    "COMPUTATION_SOURCE_FILES",
    "FRONTEND_ASSEMBLY_VERSION",
    "MISSING_DISTRIBUTION_VERSION",
    "OCR_DIRECTION",
    "OCR_LANGUAGES",
    "OCR_PREPROCESS_RECIPE",
    "RESULT_SCHEMA_VERSION",
    "ComputationInfoError",
    "computation_info",
    "computation_summary",
    "current_computation_version",
]
