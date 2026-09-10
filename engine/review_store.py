"""Durable persistence for user-reviewed PDF crop segments.

The review store is intentionally small and independent of ``TaskStore``.
Early UI task identifiers can exist before a normalized task row is created,
so review records use a task id but do not reference the ``tasks`` table.
Only source metadata, rectangles, and review decisions are persisted; PDF
bytes and OCR text never enter this database.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
import math
from pathlib import Path
import re
import sqlite3
from typing import Iterable

from .db import Database
from .layout import Rect


_CROP_MODES = {"candidate", "manual", "full_page"}
_REVIEW_STATUSES = {
    "pending",
    "needs_review",
    "confirmed",  # Legacy records written before page/group confirmation.
    "page_confirmed",
    "group_confirmed",
    "blocked",
}
_UTC_ISO8601 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$"
)


class ReviewStoreError(ValueError):
    """Raised when a review record cannot be safely persisted or decoded."""


@dataclass(frozen=True, slots=True)
class ReviewSegmentRecord:
    """Serializable review state for one matched segment."""

    id: str
    task_id: str
    source_path: str
    source_sha256: str
    source_page: int
    segment_no: int
    match_rect: Rect
    candidate_rect: Rect | None
    final_rect: Rect | None
    layout_fingerprint: str
    confidence: float
    crop_mode: str
    review_status: str
    manual_adjusted: bool
    reviewed_at: str

    def to_dict(self) -> dict[str, object]:
        """Return the stable JSONL representation used by the engine IPC."""

        return {
            "id": self.id,
            "task_id": self.task_id,
            "source_path": self.source_path,
            "source_sha256": self.source_sha256,
            "source_page": self.source_page,
            "segment_no": self.segment_no,
            "match_rect": _rect_to_dict(self.match_rect),
            "candidate_rect": _rect_to_dict(self.candidate_rect),
            "final_rect": _rect_to_dict(self.final_rect),
            "layout_fingerprint": self.layout_fingerprint,
            "confidence": self.confidence,
            "crop_mode": self.crop_mode,
            "review_status": self.review_status,
            "manual_adjusted": self.manual_adjusted,
            "reviewed_at": self.reviewed_at,
        }


def _rect_to_dict(rect: Rect | None) -> dict[str, float] | None:
    if rect is None:
        return None
    return {
        "x0": float(rect.x0),
        "y0": float(rect.y0),
        "x1": float(rect.x1),
        "y1": float(rect.y1),
    }


def _require_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ReviewStoreError(f"{field} must be a non-empty string")
    return value


def _require_positive_int(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ReviewStoreError(f"{field} must be a positive integer")
    return value


def _require_rect(value: object, field: str, *, nullable: bool = False) -> Rect | None:
    if value is None:
        if nullable:
            return None
        raise ReviewStoreError(f"{field} is required")
    if isinstance(value, Rect):
        values = (value.x0, value.y0, value.x1, value.y1)
    elif isinstance(value, dict):
        values = tuple(value.get(edge) for edge in ("x0", "y0", "x1", "y1"))
    else:
        raise ReviewStoreError(f"{field} must be a rectangle")
    if not all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in values):
        raise ReviewStoreError(f"{field} must contain finite coordinates")
    try:
        coordinates = tuple(float(item) for item in values)
    except (OverflowError, TypeError, ValueError):
        raise ReviewStoreError(f"{field} must contain finite coordinates") from None
    if not all(math.isfinite(item) for item in coordinates):
        raise ReviewStoreError(f"{field} must contain finite coordinates")
    x0, y0, x1, y1 = coordinates
    if x0 < 0 or y0 < 0 or x0 >= x1 or y0 >= y1:
        raise ReviewStoreError(f"{field} must be ordered and non-negative")
    return Rect(x0, y0, x1, y1)


def _require_confidence(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ReviewStoreError("confidence must be a finite number between 0 and 1")
    try:
        confidence = float(value)
    except (OverflowError, TypeError, ValueError):
        raise ReviewStoreError("confidence must be a finite number between 0 and 1") from None
    if not math.isfinite(confidence) or not 0 <= confidence <= 1:
        raise ReviewStoreError("confidence must be a finite number between 0 and 1")
    return confidence


def _require_bool(value: object, field: str) -> bool:
    if not isinstance(value, bool):
        raise ReviewStoreError(f"{field} must be a boolean")
    return value


def _require_reviewed_at(value: object) -> str:
    """Require an ISO-8601 UTC instant serialized with a trailing ``Z``."""

    if not isinstance(value, str) or not _UTC_ISO8601.fullmatch(value):
        raise ReviewStoreError("reviewed_at must be an ISO-8601 UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        raise ReviewStoreError("reviewed_at must be an ISO-8601 UTC timestamp") from None
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise ReviewStoreError("reviewed_at must be an ISO-8601 UTC timestamp")
    return value


def _validate_record(record: ReviewSegmentRecord) -> ReviewSegmentRecord:
    if not isinstance(record, ReviewSegmentRecord):
        raise ReviewStoreError("record must be a ReviewSegmentRecord")
    validated = ReviewSegmentRecord(
        id=_require_text(record.id, "id"),
        task_id=_require_text(record.task_id, "task_id"),
        source_path=_require_text(record.source_path, "source_path"),
        source_sha256=_require_text(record.source_sha256, "source_sha256"),
        source_page=_require_positive_int(record.source_page, "source_page"),
        segment_no=_require_positive_int(record.segment_no, "segment_no"),
        match_rect=_require_rect(record.match_rect, "match_rect"),  # type: ignore[arg-type]
        candidate_rect=_require_rect(record.candidate_rect, "candidate_rect", nullable=True),
        final_rect=_require_rect(record.final_rect, "final_rect", nullable=True),
        layout_fingerprint=_require_text(record.layout_fingerprint, "layout_fingerprint"),
        confidence=_require_confidence(record.confidence),
        crop_mode=_require_text(record.crop_mode, "crop_mode"),
        review_status=_require_text(record.review_status, "review_status"),
        manual_adjusted=_require_bool(record.manual_adjusted, "manual_adjusted"),
        reviewed_at=_require_reviewed_at(record.reviewed_at),
    )
    if validated.crop_mode not in _CROP_MODES:
        raise ReviewStoreError("crop_mode is unsupported")
    if validated.review_status not in _REVIEW_STATUSES:
        raise ReviewStoreError("review_status is unsupported")
    return validated


def _record_from_mapping(value: object) -> ReviewSegmentRecord:
    if not isinstance(value, dict):
        raise ReviewStoreError("each review segment must be an object")
    try:
        record = ReviewSegmentRecord(
            id=value.get("id"),  # type: ignore[arg-type]
            task_id=value.get("task_id"),  # type: ignore[arg-type]
            source_path=value.get("source_path"),  # type: ignore[arg-type]
            source_sha256=value.get("source_sha256"),  # type: ignore[arg-type]
            source_page=value.get("source_page"),  # type: ignore[arg-type]
            segment_no=value.get("segment_no"),  # type: ignore[arg-type]
            match_rect=_require_rect(value.get("match_rect"), "match_rect"),  # type: ignore[arg-type]
            candidate_rect=_require_rect(value.get("candidate_rect"), "candidate_rect", nullable=True),
            final_rect=_require_rect(value.get("final_rect"), "final_rect", nullable=True),
            layout_fingerprint=value.get("layout_fingerprint"),  # type: ignore[arg-type]
            confidence=value.get("confidence"),  # type: ignore[arg-type]
            crop_mode=value.get("crop_mode"),  # type: ignore[arg-type]
            review_status=value.get("review_status"),  # type: ignore[arg-type]
            manual_adjusted=value.get("manual_adjusted"),  # type: ignore[arg-type]
            reviewed_at=value.get("reviewed_at"),  # type: ignore[arg-type]
        )
    except (OverflowError, TypeError, ValueError, ReviewStoreError):
        raise ReviewStoreError("invalid review segment") from None
    return _validate_record(record)


def _nullable_rect_values(rect: Rect | None) -> tuple[float | None, float | None, float | None, float | None]:
    if rect is None:
        return None, None, None, None
    return rect.x0, rect.y0, rect.x1, rect.y1


def _row_rect(row: sqlite3.Row, prefix: str, *, nullable: bool) -> Rect | None:
    values = tuple(row[f"{prefix}_{edge}"] for edge in ("x0", "y0", "x1", "y1"))
    if all(value is None for value in values):
        if nullable:
            return None
        raise ReviewStoreError(f"stored {prefix} rectangle is missing")
    if any(value is None for value in values):
        raise ReviewStoreError(f"stored {prefix} rectangle is incomplete")
    return _require_rect(dict(zip(("x0", "y0", "x1", "y1"), values)), prefix)


def _record_from_row(row: sqlite3.Row) -> ReviewSegmentRecord:
    try:
        record = ReviewSegmentRecord(
            id=row["id"],
            task_id=row["task_id"],
            source_path=row["source_path"],
            source_sha256=row["source_sha256"],
            source_page=row["source_page"],
            segment_no=row["segment_no"],
            match_rect=_row_rect(row, "match", nullable=False),  # type: ignore[arg-type]
            candidate_rect=_row_rect(row, "candidate", nullable=True),
            final_rect=_row_rect(row, "final", nullable=True),
            layout_fingerprint=row["layout_fingerprint"],
            confidence=row["confidence"],
            crop_mode=row["crop_mode"],
            review_status=row["review_status"],
            manual_adjusted=bool(row["manual_adjusted"]),
            reviewed_at=row["reviewed_at"],
        )
        validated = _validate_record(record)
        if record.crop_mode not in _CROP_MODES or record.review_status not in _REVIEW_STATUSES:
            raise ReviewStoreError("stored review state is unsupported")
        if row["manual_adjusted"] not in (0, 1):
            raise ReviewStoreError("stored manual_adjusted value is invalid")
        return validated
    except (KeyError, TypeError, ValueError, sqlite3.Error, ReviewStoreError):
        raise ReviewStoreError("stored review segment is invalid") from None


class ReviewStore:
    """SQLite-backed review segment store with all-or-nothing batch writes."""

    def __init__(self, database: str | Path | Database = ":memory:") -> None:
        self.database = database if isinstance(database, Database) else Database(database)
        self.database.initialize()

    @property
    def connection(self) -> sqlite3.Connection:
        return self.database.connection

    def close(self) -> None:
        self.database.close()

    def __enter__(self) -> "ReviewStore":
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        self.close()

    def save(self, records: Iterable[ReviewSegmentRecord]) -> list[ReviewSegmentRecord]:
        """Validate a complete batch, then write it in one transaction."""

        validated = [_validate_record(record) for record in records]
        if not validated:
            return []
        if len({record.task_id for record in validated}) != 1:
            raise ReviewStoreError("all records in one save must use the same task_id")
        with self.database.transaction() as connection:
            for record in validated:
                self._upsert_connection(connection, record)
        return validated

    def upsert(self, record: ReviewSegmentRecord) -> ReviewSegmentRecord:
        """Insert or replace one segment without producing a duplicate."""

        return self.save([record])[0]

    def list_for_task(self, task_id: str) -> list[ReviewSegmentRecord]:
        task = _require_text(task_id, "task_id")
        rows = self.connection.execute(
            """
            SELECT * FROM review_segments
            WHERE task_id = ?
            ORDER BY source_page, segment_no, source_path, id
            """,
            (task,),
        ).fetchall()
        return [_record_from_row(row) for row in rows]

    def delete_for_task(self, task_id: str) -> int:
        task = _require_text(task_id, "task_id")
        with self.database.transaction() as connection:
            cursor = connection.execute("DELETE FROM review_segments WHERE task_id = ?", (task,))
        return cursor.rowcount

    @staticmethod
    def _upsert_connection(connection: sqlite3.Connection, record: ReviewSegmentRecord) -> None:
        candidate = _nullable_rect_values(record.candidate_rect)
        final = _nullable_rect_values(record.final_rect)
        connection.execute(
            """
            INSERT INTO review_segments (
                id, task_id, source_path, source_sha256, source_page, segment_no,
                match_x0, match_y0, match_x1, match_y1,
                candidate_x0, candidate_y0, candidate_x1, candidate_y1,
                final_x0, final_y0, final_x1, final_y1,
                layout_fingerprint, confidence, crop_mode, review_status,
                manual_adjusted, reviewed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_id, source_sha256, source_page, segment_no) DO UPDATE SET
                id = excluded.id,
                source_path = excluded.source_path,
                match_x0 = excluded.match_x0,
                match_y0 = excluded.match_y0,
                match_x1 = excluded.match_x1,
                match_y1 = excluded.match_y1,
                candidate_x0 = excluded.candidate_x0,
                candidate_y0 = excluded.candidate_y0,
                candidate_x1 = excluded.candidate_x1,
                candidate_y1 = excluded.candidate_y1,
                final_x0 = excluded.final_x0,
                final_y0 = excluded.final_y0,
                final_x1 = excluded.final_x1,
                final_y1 = excluded.final_y1,
                layout_fingerprint = excluded.layout_fingerprint,
                confidence = excluded.confidence,
                crop_mode = excluded.crop_mode,
                review_status = excluded.review_status,
                manual_adjusted = excluded.manual_adjusted,
                reviewed_at = excluded.reviewed_at
            """,
            (
                record.id,
                record.task_id,
                record.source_path,
                record.source_sha256,
                record.source_page,
                record.segment_no,
                record.match_rect.x0,
                record.match_rect.y0,
                record.match_rect.x1,
                record.match_rect.y1,
                *candidate,
                *final,
                record.layout_fingerprint,
                record.confidence,
                record.crop_mode,
                record.review_status,
                int(record.manual_adjusted),
                record.reviewed_at,
            ),
        )


def records_from_payload(value: object, *, task_id: str) -> list[ReviewSegmentRecord]:
    """Decode and validate a JSON payload before any database write."""

    task = _require_text(task_id, "task_id")
    if not isinstance(value, list):
        raise ReviewStoreError("segments must be an array")
    records = [_record_from_mapping(item) for item in value]
    for record in records:
        if record.task_id != task:
            raise ReviewStoreError("segment task_id does not match request task_id")
        if record.crop_mode not in _CROP_MODES or record.review_status not in _REVIEW_STATUSES:
            raise ReviewStoreError("unsupported review mode or status")
    return records


__all__ = ["ReviewSegmentRecord", "ReviewStore", "ReviewStoreError", "records_from_payload"]
