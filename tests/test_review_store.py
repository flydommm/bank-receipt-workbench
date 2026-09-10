from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
import sqlite3
from pathlib import Path

import pytest

from engine.layout import Rect
from engine.review_store import ReviewSegmentRecord, ReviewStore, ReviewStoreError, records_from_payload


def _record(
    *,
    id: str = "sha:4:1",
    final_rect: Rect | None = Rect(0, 2, 600, 248),
    candidate_rect: Rect | None = Rect(0, 0, 600, 250),
    mode: str = "manual",
    status: str = "confirmed",
    manual_adjusted: bool = True,
    segment_no: int = 1,
) -> ReviewSegmentRecord:
    return ReviewSegmentRecord(
        id=id,
        task_id="task-1",
        source_path="source.pdf",
        source_sha256="abc",
        source_page=4,
        segment_no=segment_no,
        match_rect=Rect(10, 20, 30, 40),
        candidate_rect=candidate_rect,
        final_rect=final_rect,
        layout_fingerprint="layout-a",
        confidence=0.96,
        crop_mode=mode,
        review_status=status,
        manual_adjusted=manual_adjusted,
        reviewed_at="2026-09-01T06:20:00.000Z",
    )


def test_upsert_review_segment_preserves_candidate_and_final_rects(tmp_path: Path) -> None:
    store = ReviewStore(tmp_path / "review.sqlite3")
    record = store.upsert(_record())

    assert store.list_for_task("task-1") == [record]
    loaded = store.list_for_task("task-1")[0]
    assert loaded.match_rect == Rect(10, 20, 30, 40)
    assert loaded.candidate_rect == Rect(0, 0, 600, 250)
    assert loaded.final_rect == Rect(0, 2, 600, 248)
    store.close()


def test_second_upsert_updates_one_segment_without_duplication(tmp_path: Path) -> None:
    store = ReviewStore(tmp_path / "review.sqlite3")
    store.upsert(_record(final_rect=Rect(0, 0, 600, 250)))
    store.upsert(_record(final_rect=Rect(0, 5, 600, 245)))

    assert len(store.list_for_task("task-1")) == 1
    assert store.list_for_task("task-1")[0].final_rect == Rect(0, 5, 600, 245)
    store.close()


def test_batch_save_is_atomic_when_any_record_has_invalid_rectangle(tmp_path: Path) -> None:
    store = ReviewStore(tmp_path / "review.sqlite3")
    invalid = _record(id="sha:4:2", segment_no=2)
    invalid = replace(invalid, match_rect=Rect(30, 40, 30, 50))

    with pytest.raises(ReviewStoreError):
        store.save([_record(), invalid])

    assert store.list_for_task("task-1") == []
    store.close()


@pytest.mark.parametrize(
    ("mode", "status", "candidate", "final", "manual"),
    [
        ("full_page", "confirmed", None, None, True),
        ("candidate", "needs_review", Rect(0, 0, 600, 250), Rect(0, 0, 600, 250), False),
    ],
)
def test_round_trip_supports_nullable_rectangles_and_review_states(
    tmp_path: Path,
    mode: str,
    status: str,
    candidate: Rect | None,
    final: Rect | None,
    manual: bool,
) -> None:
    store = ReviewStore(tmp_path / "review.sqlite3")
    record = _record(mode=mode, status=status, candidate_rect=candidate, final_rect=final, manual_adjusted=manual)

    store.upsert(record)

    assert store.list_for_task("task-1") == [record]
    store.close()


def test_load_rejects_corrupt_stored_geometry_fail_closed(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    store = ReviewStore(database)
    store.upsert(_record())
    store.connection.execute("UPDATE review_segments SET final_x1 = NULL")
    store.connection.commit()

    with pytest.raises(ReviewStoreError):
        store.list_for_task("task-1")
    store.close()


def test_schema_has_no_task_foreign_key_and_deduplicates_by_source_key(tmp_path: Path) -> None:
    store = ReviewStore(tmp_path / "review.sqlite3")
    foreign_keys = store.connection.execute("PRAGMA foreign_key_list(review_segments)").fetchall()
    indexes = store.connection.execute("PRAGMA index_list(review_segments)").fetchall()

    assert foreign_keys == []
    assert any(index[1].startswith("sqlite_autoindex_review_segments") for index in indexes)
    store.close()


def test_distinct_task_identities_can_persist_same_source_page_segment(tmp_path: Path) -> None:
    store = ReviewStore(tmp_path / "review.sqlite3")
    task_a = replace(_record(id="task-a:sha:4:1"), task_id="task-a")
    task_b = replace(_record(id="task-b:sha:4:1"), task_id="task-b")

    store.save([task_a])
    store.save([task_b])

    assert store.list_for_task("task-a") == [task_a]
    assert store.list_for_task("task-b") == [task_b]
    store.close()


@pytest.mark.parametrize(
    "reviewed_at",
    ["", "2026-09-01", "2026-09-01T06:20:00+08:00", "not-a-timestamp", "2026-09-01T06:20:00Zextra"],
)
def test_reviewed_at_must_be_strict_utc_iso8601(tmp_path: Path, reviewed_at: str) -> None:
    store = ReviewStore(tmp_path / "review.sqlite3")

    with pytest.raises(ReviewStoreError):
        store.upsert(replace(_record(), reviewed_at=reviewed_at))

    assert store.list_for_task("task-1") == []
    store.close()


@pytest.mark.parametrize("field", ("final_rect", "confidence"))
def test_records_from_payload_rejects_overflowing_numbers_as_invalid_review_segments(field: str) -> None:
    payload = _record().to_dict()
    if field == "final_rect":
        payload[field] = {"x0": 0, "y0": 0, "x1": 10**1000, "y1": 1}
    else:
        payload[field] = 10**1000

    with pytest.raises(ReviewStoreError):
        records_from_payload([payload], task_id="task-1")


def test_reviewed_at_round_trips_page_and_group_confirmed_states(tmp_path: Path) -> None:
    store = ReviewStore(tmp_path / "review.sqlite3")
    page_confirmed = replace(_record(id="page:sha:4:1"), review_status="page_confirmed")
    group_confirmed = replace(_record(id="group:sha:4:2", segment_no=2), review_status="group_confirmed")

    store.save([page_confirmed, group_confirmed])

    assert store.list_for_task("task-1") == [page_confirmed, group_confirmed]
    store.close()


def test_existing_review_segments_table_is_migrated_with_reviewed_at(tmp_path: Path) -> None:
    database = tmp_path / "legacy.sqlite3"
    connection = sqlite3.connect(database)
    connection.execute(
        """
        CREATE TABLE review_segments (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            source_path TEXT NOT NULL,
            source_sha256 TEXT NOT NULL,
            source_page INTEGER NOT NULL,
            segment_no INTEGER NOT NULL,
            match_x0 REAL NOT NULL, match_y0 REAL NOT NULL,
            match_x1 REAL NOT NULL, match_y1 REAL NOT NULL,
            candidate_x0 REAL, candidate_y0 REAL, candidate_x1 REAL, candidate_y1 REAL,
            final_x0 REAL, final_y0 REAL, final_x1 REAL, final_y1 REAL,
            layout_fingerprint TEXT NOT NULL,
            confidence REAL NOT NULL,
            crop_mode TEXT NOT NULL,
            review_status TEXT NOT NULL,
            manual_adjusted INTEGER NOT NULL
        )
        """
    )
    connection.execute(
        """
        INSERT INTO review_segments (
            id, task_id, source_path, source_sha256, source_page, segment_no,
            match_x0, match_y0, match_x1, match_y1,
            candidate_x0, candidate_y0, candidate_x1, candidate_y1,
            final_x0, final_y0, final_x1, final_y1,
            layout_fingerprint, confidence, crop_mode, review_status, manual_adjusted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("legacy", "task-1", "source.pdf", "abc", 4, 1, 10, 20, 30, 40,
         0, 0, 600, 250, 0, 2, 600, 248, "layout-a", 0.96, "manual", "confirmed", 1),
    )
    connection.commit()
    connection.close()

    with ReviewStore(database) as store:
        columns = {row[1] for row in store.connection.execute("PRAGMA table_info(review_segments)")}
        loaded = store.list_for_task("task-1")

    assert "reviewed_at" in columns
    assert len(loaded) == 1
    reviewed_at = loaded[0].reviewed_at
    assert reviewed_at != "1970-01-01T00:00:00.000Z"
    assert reviewed_at.endswith("Z")
    parsed = datetime.fromisoformat(reviewed_at.replace("Z", "+00:00"))
    assert parsed.tzinfo == timezone.utc
