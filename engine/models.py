"""Dataclasses and enums used by the local task persistence layer.

The persistence layer deliberately keeps these models small.  PDF parsing,
OCR, search and layout analysis can attach their results incrementally without
having to load a complete document into memory.
"""

from __future__ import annotations

from dataclasses import dataclass, field as dataclass_field
from datetime import datetime, timezone
from enum import Enum


def utc_now() -> str:
    """Return a sortable, timezone-aware UTC timestamp for SQLite."""

    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class TaskStatus(str, Enum):
    """Lifecycle states for a processing task."""

    PENDING = "pending"
    PARSING = "parsing"
    OCR = "ocr"
    SEARCHING = "searching"
    REVIEW = "review"
    EXPORTING = "exporting"
    COMPLETED = "completed"
    PARTIAL_FAILED = "partial_failed"
    FAILED = "failed"
    PAUSED = "paused"
    CANCELLED = "cancelled"

    # Friendly aliases used by callers that describe the state in prose.
    WAITING_REVIEW = REVIEW
    OCRING = OCR


class PageStatus(str, Enum):
    """Checkpoint states for an individual source page."""

    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


class CropMode(str, Enum):
    """How a crop region was selected."""

    CANDIDATE = "candidate"
    MANUAL = "manual"
    GROUP = "group"
    FULL_PAGE = "full_page"

    # Alias that reads naturally at call sites.
    WHOLE_PAGE = FULL_PAGE


class ReviewStatus(str, Enum):
    """Human review state for a crop region."""

    PENDING = "pending"
    CONFIRMED = "confirmed"
    NEEDS_REVIEW = "needs_review"
    REJECTED = "rejected"


@dataclass(slots=True)
class Task:
    id: str
    name: str
    status: TaskStatus = TaskStatus.PENDING
    output_dir: str | None = None
    error_message: str | None = None
    status_before_pause: TaskStatus | None = None
    created_at: str = dataclass_field(default_factory=utc_now)
    updated_at: str = dataclass_field(default_factory=utc_now)


@dataclass(slots=True)
class SourceFile:
    id: str
    task_id: str
    path: str
    filename: str
    size_bytes: int | None = None
    modified_at: str | None = None
    sha256: str | None = None
    page_count: int | None = None
    status: str = "pending"
    error_message: str | None = None
    created_at: str = dataclass_field(default_factory=utc_now)
    updated_at: str = dataclass_field(default_factory=utc_now)


@dataclass(slots=True)
class Page:
    id: str
    source_file_id: str
    page_number: int
    status: PageStatus = PageStatus.PENDING
    ocr_status: str = "not_started"
    error_message: str | None = None
    retry_count: int = 0
    started_at: str | None = None
    completed_at: str | None = None
    updated_at: str = dataclass_field(default_factory=utc_now)


@dataclass(slots=True)
class TextBlock:
    id: str
    page_id: str
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    confidence: float = 1.0
    field: str | None = None
    block_index: int | None = None
    created_at: str = dataclass_field(default_factory=utc_now)


@dataclass(slots=True)
class Match:
    id: str
    page_id: str
    query: str
    matched_text: str
    matched_field: str | None = None
    confidence: float = 1.0
    x0: float | None = None
    y0: float | None = None
    x1: float | None = None
    y1: float | None = None
    created_at: str = dataclass_field(default_factory=utc_now)


@dataclass(slots=True)
class LayoutGroup:
    id: str
    task_id: str
    fingerprint: str
    name: str | None = None
    confidence: float | None = None
    created_at: str = dataclass_field(default_factory=utc_now)
    updated_at: str = dataclass_field(default_factory=utc_now)


@dataclass(slots=True)
class CropRegion:
    id: str
    page_id: str
    x0: float
    y0: float
    x1: float
    y1: float
    layout_group_id: str | None = None
    confidence: float | None = None
    mode: CropMode = CropMode.CANDIDATE
    review_status: ReviewStatus | str = ReviewStatus.PENDING
    created_at: str = dataclass_field(default_factory=utc_now)
    updated_at: str = dataclass_field(default_factory=utc_now)


@dataclass(slots=True)
class ExportRecord:
    id: str
    task_id: str
    output_path: str
    kind: str = "combined"
    status: str = "pending"
    error_message: str | None = None
    created_at: str = dataclass_field(default_factory=utc_now)
    completed_at: str | None = None


# ``Export`` is a convenient singular name for callers while the table and
# the canonical dataclass name remain explicit about this being a record.
Export = ExportRecord


@dataclass(slots=True)
class TaskLog:
    id: str
    task_id: str
    level: str
    message: str
    page_id: str | None = None
    created_at: str = dataclass_field(default_factory=utc_now)
