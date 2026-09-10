from __future__ import annotations

from copy import deepcopy
import hashlib
import sqlite3
from pathlib import Path

import pytest

from engine.review_read import (
    ReviewRevisionConflict,
    ReviewStoreCorruptionError,
    ReviewStoreError,
    read_review_snapshot,
)
from engine.review_store_v2 import ReviewStoreV2


SHA_A = "a" * 64
FINGERPRINT_A = "1" * 64
FINGERPRINT_B = "2" * 64


def _rect(x0: float = 10, y0: float = 20, x1: float = 30, y1: float = 40) -> dict[str, float]:
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _source(path: str, sha256: str = SHA_A) -> dict[str, str]:
    return {"source_key": path, "source_path": path, "source_sha256": sha256}


def _context(*, source_path: str = "/docs/report.pdf") -> dict[str, object]:
    return {
        "version": 2,
        "sources": [_source(source_path)],
        "criteria_fingerprint": FINGERPRINT_A,
        "computation_version": "engine-schema-v2",
    }


def _original(
    *,
    item_id: str = "segment-1",
    segment_no: int = 1,
    analysis_signature: str = FINGERPRINT_A,
) -> dict[str, object]:
    return {
        "id": item_id,
        "source_key": "/docs/report.pdf",
        "source_page": 1,
        "segment_no": segment_no,
        "analysis_signature": analysis_signature,
        "persistable": True,
        "page_width": 600,
        "page_height": 800,
        "match_rect": _rect(),
        "candidate_rect": _rect(0, 0, 600, 250),
        "layout_fingerprint": "geometry:report-v1",
        "confidence": 0.96,
        "auto_full_page": False,
    }


def _record(
    context: dict[str, object],
    original: dict[str, object],
    *,
    context_key: str,
    result_revision: str,
    task_id: str = "task-1",
    record_revision: int = 0,
    review_status: str = "confirmed",
) -> dict[str, object]:
    return {
        "id": original["id"],
        "task_id": task_id,
        "source_path": context["sources"][0]["source_path"],  # type: ignore[index]
        "source_sha256": SHA_A,
        "source_page": original["source_page"],
        "segment_no": original["segment_no"],
        "match_rect": original["match_rect"],
        "candidate_rect": original["candidate_rect"],
        "final_rect": _rect(0, 2, 600, 248),
        "layout_fingerprint": original["layout_fingerprint"],
        "confidence": original["confidence"],
        "crop_mode": "manual",
        "review_status": review_status,
        "manual_adjusted": True,
        "reviewed_at": "2026-09-08T06:20:00.000Z",
        "context_key": context_key,
        "source_key": original["source_key"],
        "analysis_signature": original["analysis_signature"],
        "result_revision": result_revision,
        "record_revision": record_revision,
        "page_width": original["page_width"],
        "page_height": original["page_height"],
    }


def _db_hash(database: Path) -> str:
    connection = sqlite3.connect(database)
    try:
        dump = "\n".join(connection.iterdump()).encode("utf-8")
    finally:
        connection.close()
    return hashlib.sha256(dump).hexdigest()


def test_missing_database_is_rejected_without_creating_anything(tmp_path: Path) -> None:
    database = tmp_path / "missing" / "review.sqlite3"

    with pytest.raises(ReviewStoreError):
        read_review_snapshot(database, "a" * 64, "run-1")

    assert not database.exists()
    assert not database.parent.exists()


def test_snapshot_matches_saved_state_and_does_not_modify_database(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    context = _context()
    original = _original()

    with ReviewStoreV2(database) as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        saved = store.save(
            prepared["context_key"],
            "run-1",
            [_record(context, original, context_key=prepared["context_key"], result_revision="run-1")],
            confirm_group=False,
        )
    before = _db_hash(database)

    snapshot = read_review_snapshot(database, prepared["context_key"], "run-1")

    assert snapshot["context_key"] == prepared["context_key"]
    assert snapshot["result_revision"] == "run-1"
    assert snapshot["segments"] == saved["segments"]
    assert snapshot["record_revisions"] == [
        {
            "id": "segment-1",
            "source_key": "/docs/report.pdf",
            "source_page": 1,
            "segment_no": 1,
            "record_revision": 1,
            "task_id": "task-1",
        }
    ]
    assert snapshot["group_confirmed"] is False
    assert _db_hash(database) == before


def test_incompatible_manifest_keeps_actual_revision_and_task_id(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    context = _context()
    first = _original(analysis_signature=FINGERPRINT_A)
    changed = _original(analysis_signature=FINGERPRINT_B)

    with ReviewStoreV2(database) as store:
        prepared = store.prepare(context, [first], result_revision="run-1")
        store.save(
            prepared["context_key"],
            "run-1",
            [_record(context, first, context_key=prepared["context_key"], result_revision="run-1", task_id="task-a")],
            confirm_group=False,
        )
        current = store.prepare(context, [changed], result_revision="run-2")

    snapshot = read_review_snapshot(database, current["context_key"], "run-2")

    assert snapshot["segments"] == []
    assert snapshot["record_revisions"] == [
        {
            "id": "segment-1",
            "source_key": "/docs/report.pdf",
            "source_page": 1,
            "segment_no": 1,
            "record_revision": 1,
            "task_id": "task-a",
        }
    ]


def test_stale_result_revision_is_a_revision_conflict(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    context = _context()
    original = _original()

    with ReviewStoreV2(database) as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        store.prepare(context, [original], result_revision="run-2")

    with pytest.raises(ReviewRevisionConflict):
        read_review_snapshot(database, prepared["context_key"], "run-1")


def test_corrupt_context_manifest_and_record_fail_closed(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    context = _context()
    original = _original()

    with ReviewStoreV2(database) as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        store.save(
            prepared["context_key"],
            "run-1",
            [_record(context, original, context_key=prepared["context_key"], result_revision="run-1")],
            confirm_group=False,
        )
        store.connection.execute(
            "UPDATE review_contexts_v2 SET manifest_digest = ? WHERE context_key = ?",
            ("f" * 64, prepared["context_key"]),
        )
        store.connection.commit()

    with pytest.raises(ReviewStoreCorruptionError):
        read_review_snapshot(database, prepared["context_key"], "run-1")

    with sqlite3.connect(database) as connection:
        manifest_json = connection.execute(
            "SELECT manifest_json FROM review_contexts_v2 WHERE context_key = ?",
            (prepared["context_key"],),
        ).fetchone()[0]
        connection.execute(
            "UPDATE review_contexts_v2 SET manifest_digest = ? WHERE context_key = ?",
            (hashlib.sha256(manifest_json.encode("utf-8")).hexdigest(), prepared["context_key"]),
        )

    with sqlite3.connect(database) as connection:
        connection.execute(
            "UPDATE review_segments_v2 SET source_sha256 = ? WHERE context_key = ?",
            ("b" * 64, prepared["context_key"]),
        )

    with pytest.raises(ReviewStoreCorruptionError):
        read_review_snapshot(database, prepared["context_key"], "run-1")


@pytest.mark.parametrize(
    ("column", "value"),
    [("id", "stale-id"), ("result_revision", "old-result")],
)
def test_current_compatible_row_mismatch_is_rejected_without_repair(
    tmp_path: Path,
    column: str,
    value: str,
) -> None:
    database = tmp_path / f"{column}.sqlite3"
    context = _context()
    original = _original()

    with ReviewStoreV2(database) as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        store.save(
            prepared["context_key"],
            "run-1",
            [_record(context, original, context_key=prepared["context_key"], result_revision="run-1")],
            confirm_group=False,
        )
        store.connection.execute(
            f"UPDATE review_segments_v2 SET {column} = ? WHERE context_key = ?",
            (value, prepared["context_key"]),
        )
        store.connection.commit()

    before = _db_hash(database)
    with pytest.raises(ReviewStoreCorruptionError):
        read_review_snapshot(database, prepared["context_key"], "run-1")
    assert _db_hash(database) == before


def test_trusted_alias_is_read_from_the_bound_descriptor_without_rebinding(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    context = _context()
    relocated = deepcopy(context)
    relocated["sources"][0]["source_path"] = "/relocated/report.pdf"  # type: ignore[index]
    original = _original()

    with ReviewStoreV2(database) as store:
        prepared = store.prepare_batch(context, [original], result_revision="run-1", job_id="job-a")
        record = _record(context, original, context_key=prepared["context_key"], result_revision="run-1", task_id="job-a")
        store.save(prepared["context_key"], "run-1", [record], confirm_group=False)
        current = store.prepare_batch(relocated, [original], result_revision="run-2", job_id="job-a")

    snapshot = read_review_snapshot(database, current["context_key"], "run-2")

    assert snapshot["segments"][0]["source_path"] == "/relocated/report.pdf"  # type: ignore[index]
    assert snapshot["segments"][0]["record_revision"] == 1  # type: ignore[index]


def test_group_confirmation_is_reported_only_for_a_complete_current_group(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    context = _context()
    originals = [_original(item_id="segment-1", segment_no=1), _original(item_id="segment-2", segment_no=2)]

    with ReviewStoreV2(database) as store:
        prepared = store.prepare(context, originals, result_revision="run-1")
        records = [
            _record(context, original, context_key=prepared["context_key"], result_revision="run-1", review_status="group_confirmed")
            for original in originals
        ]
        store.save(prepared["context_key"], "run-1", records, confirm_group=True)

    snapshot = read_review_snapshot(database, prepared["context_key"], "run-1")

    assert snapshot["group_confirmed"] is True
    assert [item["id"] for item in snapshot["segments"]] == ["segment-1", "segment-2"]  # type: ignore[index]
