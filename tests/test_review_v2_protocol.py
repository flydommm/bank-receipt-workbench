from __future__ import annotations

from copy import deepcopy
import hashlib
from pathlib import Path

import pytest

import engine.engine as engine_module
from engine.engine import handle_request


def _digest(label: str) -> str:
    return hashlib.sha256(label.encode("utf-8")).hexdigest()


def _context(computation_version: str | None = None) -> dict[str, object]:
    return {
        "version": 2,
        "sources": [
            {
                "source_key": "c:/input/alpha.pdf",
                "source_path": "C:\\Input\\Alpha.pdf",
                "source_sha256": "a" * 64,
            },
            {
                "source_key": "c:/input/beta.pdf",
                "source_path": "C:\\Input\\Beta.pdf",
                "source_sha256": "b" * 64,
            },
        ],
        "criteria_fingerprint": _digest("criteria"),
        "computation_version": computation_version or engine_module.current_computation_version(),
    }


def _original(
    source_key: str,
    source_page: int,
    segment_no: int = 1,
    *,
    suffix: str = "",
) -> dict[str, object]:
    return {
        "id": f"{source_key}:{source_page}:{segment_no}{suffix}",
        "source_key": source_key,
        "source_page": source_page,
        "segment_no": segment_no,
        "analysis_signature": _digest(f"analysis:{source_key}:{source_page}:{segment_no}{suffix}"),
        "persistable": True,
        "page_width": 600.0,
        "page_height": 800.0,
        "match_rect": {"x0": 20.0, "y0": 30.0, "x1": 160.0, "y1": 180.0},
        "candidate_rect": {"x0": 0.0, "y0": 0.0, "x1": 600.0, "y1": 250.0},
        "layout_fingerprint": _digest(f"layout:{source_key}"),
        "confidence": 0.96,
        "auto_full_page": False,
    }


def _segment(
    original: dict[str, object],
    *,
    final_rect: dict[str, float] | None = None,
    record_revision: int = 0,
) -> dict[str, object]:
    source_key = str(original["source_key"])
    return {
        **deepcopy(original),
        "context_key": "",
        "result_revision": "run-1",
        "record_revision": record_revision,
        "task_id": "task-v2",
        "source_path": "C:\\Input\\" + source_key.rsplit("/", 1)[-1],
        "source_sha256": "a" * 64 if source_key.endswith("alpha.pdf") else "b" * 64,
        "final_rect": final_rect or {"x0": 4.0, "y0": 5.0, "x1": 590.0, "y1": 245.0},
        "crop_mode": "manual",
        "review_status": "needs_review",
        "manual_adjusted": True,
        "reviewed_at": "2026-09-08T00:00:00.000Z",
    }


def test_prepare_review_context_v2_rejects_a_stale_computation_version(tmp_path: Path) -> None:
    context = _context("m2-schema-analysis-v1-stale")
    response = handle_request({
        "op": "prepare_review_context_v2",
        "database_path": str(tmp_path / "review.sqlite3"),
        "context": context,
        "originals": [],
        "result_revision": "run-1",
    })

    assert response == {
        "status": "error",
        "code": "computation_version_changed",
        "message": "computation version is incompatible; run analysis again",
    }


@pytest.mark.parametrize(
    ("payload", "expected_code"),
    [
        ({"op": "prepare_review_context_v2", "context": {}, "originals": [], "result_revision": "run-1"}, "invalid_database_path"),
        ({"op": "prepare_review_context_v2", "database_path": "x", "context": {}, "originals": [], "result_revision": ""}, "invalid_review_segments"),
        ({"op": "save_review_segments_v2", "database_path": "x", "context_key": "x", "result_revision": "run-1", "segments": "bad", "confirm_group": False}, "invalid_review_segments"),
        ({"op": "save_review_segments_v2", "database_path": "x", "context_key": "x", "result_revision": "run-1", "segments": [], "confirm_group": 1}, "invalid_review_segments"),
    ],
)
def test_v2_protocol_rejects_invalid_parameters_without_store_access(
    payload: dict[str, object],
    expected_code: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_store(*_: object, **__: object) -> None:
        raise AssertionError("invalid protocol input must fail before opening the store")

    monkeypatch.setattr(engine_module, "ReviewStoreV2", fail_store)
    response = handle_request(payload)

    assert response["status"] == "error"
    assert response["code"] == expected_code


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("crop_mode", []),
        ("crop_mode", {}),
        ("review_status", []),
        ("review_status", {}),
    ],
)
def test_v2_protocol_rejects_non_string_review_enums_without_store_access(
    field: str,
    value: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = _original("c:/input/alpha.pdf", 1)
    record = _segment(original)
    record["context_key"] = "a" * 64
    record[field] = value

    def fail_store(*_: object, **__: object) -> None:
        raise AssertionError("invalid enum input must fail before opening the store")

    monkeypatch.setattr(engine_module, "ReviewStoreV2", fail_store)
    response = handle_request({
        "op": "save_review_segments_v2",
        "database_path": "x",
        "context_key": "a" * 64,
        "result_revision": "run-1",
        "segments": [record],
        "confirm_group": False,
    })

    assert response == {
        "status": "error",
        "code": "invalid_review_segments",
        "message": "review segments are invalid",
    }


def test_v2_protocol_prepares_two_sources_and_saves_loadable_segments_with_cas(
    tmp_path: Path,
) -> None:
    context = _context()
    originals = [_original("c:/input/alpha.pdf", 1), _original("c:/input/beta.pdf", 1)]
    prepared = handle_request({
        "op": "prepare_review_context_v2",
        "database_path": str(tmp_path / "review.sqlite3"),
        "context": context,
        "originals": originals,
        "result_revision": "run-1",
    })
    assert prepared["status"] == "ok"
    assert len(prepared["record_revisions"]) == 2
    context_key = str(prepared["context_key"])
    records = [_segment(original) for original in originals]
    for record in records:
        record["context_key"] = context_key
    saved = handle_request({
        "op": "save_review_segments_v2",
        "database_path": str(tmp_path / "review.sqlite3"),
        "context_key": context_key,
        "result_revision": "run-1",
        "segments": records,
        "confirm_group": False,
    })

    assert saved["status"] == "ok"
    assert saved["saved_count"] == 2
    assert {item["source_key"] for item in saved["segments"]} == {"c:/input/alpha.pdf", "c:/input/beta.pdf"}
    assert len({item["record_revision"] for item in saved["segments"]}) == 1
    assert {item["source_path"] for item in saved["segments"]} == {
        record["source_path"] for record in records
    }

    loaded = handle_request({
        "op": "prepare_review_context_v2",
        "database_path": str(tmp_path / "review.sqlite3"),
        "context": context,
        "originals": originals,
        "result_revision": "run-2",
    })
    assert loaded["status"] == "ok"
    assert {item["source_key"] for item in loaded["segments"]} == {
        "c:/input/alpha.pdf",
        "c:/input/beta.pdf",
    }


def test_v2_protocol_maps_compare_and_swap_conflict_without_leaking_payload(
    tmp_path: Path,
) -> None:
    context = _context()
    originals = [_original("c:/input/alpha.pdf", 1), _original("c:/input/beta.pdf", 1)]
    prepared = handle_request({
        "op": "prepare_review_context_v2",
        "database_path": str(tmp_path / "review.sqlite3"),
        "context": context,
        "originals": originals,
        "result_revision": "run-1",
    })
    context_key = str(prepared["context_key"])
    first = _segment(originals[0])
    first["context_key"] = context_key
    first_saved = handle_request({
        "op": "save_review_segments_v2",
        "database_path": str(tmp_path / "review.sqlite3"),
        "context_key": context_key,
        "result_revision": "run-1",
        "segments": [first],
        "confirm_group": False,
    })
    stale = deepcopy(first)
    stale["record_revision"] = 0
    stale["final_rect"] = {"x0": 8.0, "y0": 9.0, "x1": 580.0, "y1": 240.0}
    response = handle_request({
        "op": "save_review_segments_v2",
        "database_path": str(tmp_path / "review.sqlite3"),
        "context_key": context_key,
        "result_revision": "run-1",
        "segments": [stale],
        "confirm_group": False,
    })

    assert first_saved["status"] == "ok"
    assert response == {
        "status": "error",
        "code": "review_revision_conflict",
        "message": "review revision conflict; reload the current review state",
    }
    assert "final_rect" not in response
    assert str(stale["final_rect"]) not in str(response)


def test_v2_protocol_maps_manifest_mismatch_to_invalid_segments_without_partial_write(
    tmp_path: Path,
) -> None:
    context = _context()
    originals = [_original("c:/input/alpha.pdf", 1)]
    database = str(tmp_path / "review.sqlite3")
    prepared = handle_request({
        "op": "prepare_review_context_v2",
        "database_path": database,
        "context": context,
        "originals": originals,
        "result_revision": "run-1",
    })
    context_key = str(prepared["context_key"])
    mismatched = _segment(originals[0])
    mismatched["context_key"] = context_key
    mismatched["analysis_signature"] = "f" * 64

    response = handle_request({
        "op": "save_review_segments_v2",
        "database_path": database,
        "context_key": context_key,
        "result_revision": "run-1",
        "segments": [mismatched],
        "confirm_group": False,
    })

    assert response == {
        "status": "error",
        "code": "invalid_review_segments",
        "message": "review segments are invalid",
    }
    reloaded = handle_request({
        "op": "prepare_review_context_v2",
        "database_path": database,
        "context": context,
        "originals": originals,
        "result_revision": "run-1",
    })
    assert reloaded["status"] == "ok"
    assert reloaded["segments"] == []
    assert reloaded["record_revisions"] == [
        {
            "id": originals[0]["id"],
            "source_key": "c:/input/alpha.pdf",
            "source_page": 1,
            "segment_no": 1,
            "record_revision": 0,
            "task_id": None,
        },
    ]


def test_read_snapshot_protocol_never_prepares_or_creates_missing_database(tmp_path: Path, monkeypatch) -> None:
    database = str(tmp_path / "review.sqlite3")
    context = _context()
    originals = [_original("c:/input/alpha.pdf", 1)]
    prepared = handle_request({"op": "prepare_review_context_v2", "database_path": database,
                               "context": context, "originals": originals, "result_revision": "run-1"})
    assert prepared["status"] == "ok"
    before = Path(database).read_bytes()

    def forbidden_constructor(*args, **kwargs):
        pytest.fail("read protocol must not initialize the writable store")

    monkeypatch.setattr(engine_module, "ReviewStoreV2", forbidden_constructor)
    request = {"op": "read_review_snapshot_v2", "database_path": database,
               "context_key": prepared["context_key"], "result_revision": "run-1"}
    assert handle_request(request) == prepared
    assert Path(database).read_bytes() == before
    stale = handle_request({**request, "result_revision": "old"})
    assert stale["code"] == "review_revision_conflict"
    missing = tmp_path / "missing" / "review.sqlite3"
    assert handle_request({**request, "database_path": str(missing)})["status"] == "error"
    assert not missing.parent.exists()
    assert handle_request({**request, "context_key": "invalid"})["code"] == "invalid_review_segments"


def test_read_snapshot_protocol_sanitizes_failed_and_invalid_backend_responses(tmp_path: Path, monkeypatch) -> None:
    request = {"op": "read_review_snapshot_v2", "database_path": str(tmp_path / "r.sqlite3"),
               "context_key": "a" * 64, "result_revision": "run-1"}
    monkeypatch.setattr(engine_module, "read_review_snapshot", lambda *args: {"context_key": "b" * 64})
    response = handle_request(request)
    assert response["status"] == "error"
    assert response["code"] == "review_store_failed"


def test_legacy_review_save_and_load_remain_available(tmp_path: Path) -> None:
    segment = {
        "id": "legacy:1:1",
        "task_id": "legacy-task",
        "source_path": "legacy.pdf",
        "source_sha256": "c" * 64,
        "source_page": 1,
        "segment_no": 1,
        "match_rect": {"x0": 10.0, "y0": 20.0, "x1": 30.0, "y1": 40.0},
        "candidate_rect": {"x0": 0.0, "y0": 0.0, "x1": 600.0, "y1": 250.0},
        "final_rect": {"x0": 0.0, "y0": 2.0, "x1": 600.0, "y1": 248.0},
        "layout_fingerprint": "legacy-layout",
        "confidence": 0.96,
        "crop_mode": "manual",
        "review_status": "confirmed",
        "manual_adjusted": True,
        "reviewed_at": "2026-09-08T00:00:00.000Z",
    }
    database = str(tmp_path / "review.sqlite3")
    saved = handle_request({"op": "save_review_segments", "database_path": database, "task_id": "legacy-task", "segments": [segment]})
    loaded = handle_request({"op": "load_review_segments", "database_path": database, "task_id": "legacy-task"})

    assert saved == {"status": "ok", "task_id": "legacy-task", "saved_count": 1}
    assert loaded["status"] == "ok"
    assert loaded["segments"] == [segment]
