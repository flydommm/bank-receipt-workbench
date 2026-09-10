from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from engine.computation import (
    COMPUTATION_SOURCE_FILES,
    ComputationInfoError,
    FRONTEND_ASSEMBLY_VERSION,
    RESULT_SCHEMA_VERSION,
    computation_info,
    computation_summary,
)


def test_computation_info_exposes_a_stable_versioned_result_fingerprint() -> None:
    info = computation_info()

    assert info["status"] == "ok"
    version = info["computation_version"]
    assert isinstance(version, str)
    assert 1 <= len(version) <= 256
    assert set(info) == {"status", "computation_version"}
    summary = computation_summary()
    assert summary["result_schema_version"] == RESULT_SCHEMA_VERSION
    assert summary["frontend_assembly_version"] == FRONTEND_ASSEMBLY_VERSION


def test_engine_computation_info_command_returns_only_the_protocol_version() -> None:
    import engine.engine as engine_module

    response = engine_module.handle_request({"op": "engine_computation_info"})

    assert response["status"] == "ok"
    assert response["computation_version"] == computation_info()["computation_version"]
    assert set(response) == {"status", "computation_version"}


def test_computation_info_lists_code_content_and_runtime_versions_without_loading_models() -> None:
    summary = computation_summary()
    root = Path(__file__).parents[1]

    digests = summary["engine_modules"]
    assert set(digests) == set(COMPUTATION_SOURCE_FILES)
    for relative_path in COMPUTATION_SOURCE_FILES:
        source = root / relative_path
        assert digests[relative_path] == hashlib.sha256(source.read_bytes()).hexdigest()

    dependencies = summary["dependencies"]
    assert set(dependencies) == {"PyMuPDF", "PaddleOCR", "PaddlePaddle", "PaddlePaddleGPU", "PaddleX"}
    assert all(isinstance(version, str) and version for version in dependencies.values())

    ocr = summary["ocr"]
    assert ocr["languages"] == ["ch"]
    assert ocr["direction"] == {
        "document_orientation_classify": False,
        "document_unwarping": False,
        "textline_orientation": False,
    }
    assert ocr["preprocess_recipe"]["render_dpi"] == 200
    assert ocr["preprocess_recipe"]["alpha"] is False
    assert "PaddleOCR" in json.dumps(summary, ensure_ascii=False)


def test_computation_info_reports_the_effective_load_config_budget() -> None:
    from engine.config import EngineConfig

    config = EngineConfig(max_pages=7, max_files=8, max_file_bytes=9)
    summary = computation_summary(config)

    assert summary["budgets"] == {
        "max_pages": 7,
        "max_files": 8,
        "max_file_bytes": 9,
    }


def test_computation_info_uses_a_stable_marker_for_missing_distributions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import engine.computation as computation

    def missing(_: str) -> str:
        raise computation.PackageNotFoundError("missing")

    monkeypatch.setattr(computation.importlib.metadata, "version", missing)
    info = computation.computation_summary()

    assert info["dependencies"] == {
        "PyMuPDF": "not-installed",
        "PaddleOCR": "not-installed",
        "PaddlePaddle": "not-installed",
        "PaddlePaddleGPU": "not-installed",
        "PaddleX": "not-installed",
    }


@pytest.mark.parametrize("invalid_metadata", [None, "", 1])
def test_computation_info_fails_closed_for_invalid_distribution_metadata(
    monkeypatch: pytest.MonkeyPatch,
    invalid_metadata: object,
) -> None:
    import engine.computation as computation

    monkeypatch.setattr(
        computation.importlib.metadata,
        "version",
        lambda _distribution: invalid_metadata,
    )

    with pytest.raises(ComputationInfoError):
        computation.computation_summary()


def test_version_identification_failure_does_not_break_health_protocol(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import engine.engine as engine_module

    def fail(*_: object, **__: object) -> str:
        raise engine_module.ComputationInfoError("unavailable")

    monkeypatch.setattr(engine_module, "current_computation_version", fail)

    assert engine_module.handle_request({"op": "health"})["status"] == "ok"
    response = engine_module.handle_request({
        "op": "prepare_review_context_v2",
        "database_path": ":memory:",
        "context": {},
        "originals": [],
        "result_revision": "run-1",
    })
    assert response["code"] == "review_store_failed"
