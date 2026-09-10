"""SQLite connection and schema management for the local processing engine."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Iterator
from uuid import uuid4


SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    output_dir TEXT,
    error_message TEXT,
    status_before_pause TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_files (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER,
    modified_at TEXT,
    sha256 TEXT,
    page_count INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(task_id, path)
);

CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL CHECK(page_number > 0),
    status TEXT NOT NULL DEFAULT 'pending',
    ocr_status TEXT NOT NULL DEFAULT 'not_started',
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(source_file_id, page_number)
);

CREATE TABLE IF NOT EXISTS text_blocks (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    x0 REAL NOT NULL,
    y0 REAL NOT NULL,
    x1 REAL NOT NULL,
    y1 REAL NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    field TEXT,
    block_index INTEGER,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    matched_text TEXT NOT NULL,
    matched_field TEXT,
    confidence REAL NOT NULL DEFAULT 1.0,
    x0 REAL,
    y0 REAL,
    x1 REAL,
    y1 REAL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS layout_groups (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    name TEXT,
    confidence REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crop_regions (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    layout_group_id TEXT REFERENCES layout_groups(id) ON DELETE SET NULL,
    x0 REAL NOT NULL,
    y0 REAL NOT NULL,
    x1 REAL NOT NULL,
    y1 REAL NOT NULL,
    confidence REAL,
    mode TEXT NOT NULL DEFAULT 'candidate',
    review_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Review decisions are deliberately independent from the normalized task
-- tables above.  The first UI versions can create task identifiers before a
-- task row exists, so this table must not add a foreign-key constraint to
-- tasks.  It stores geometry and review metadata only; never PDF content.
CREATE TABLE IF NOT EXISTS review_segments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    source_page INTEGER NOT NULL CHECK(source_page > 0),
    segment_no INTEGER NOT NULL CHECK(segment_no > 0),
    match_x0 REAL NOT NULL,
    match_y0 REAL NOT NULL,
    match_x1 REAL NOT NULL,
    match_y1 REAL NOT NULL,
    candidate_x0 REAL,
    candidate_y0 REAL,
    candidate_x1 REAL,
    candidate_y1 REAL,
    final_x0 REAL,
    final_y0 REAL,
    final_x1 REAL,
    final_y1 REAL,
    layout_fingerprint TEXT NOT NULL,
    confidence REAL NOT NULL,
    crop_mode TEXT NOT NULL,
    review_status TEXT NOT NULL,
    manual_adjusted INTEGER NOT NULL CHECK(manual_adjusted IN (0, 1)),
    reviewed_at TEXT NOT NULL,
    UNIQUE(task_id, source_sha256, source_page, segment_no)
);

CREATE TABLE IF NOT EXISTS exports (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    output_path TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'combined',
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS task_logs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_source_files_task ON source_files(task_id);
CREATE INDEX IF NOT EXISTS idx_pages_source_status ON pages(source_file_id, status);
CREATE INDEX IF NOT EXISTS idx_text_blocks_page ON text_blocks(page_id);
CREATE INDEX IF NOT EXISTS idx_matches_page ON matches(page_id);
CREATE INDEX IF NOT EXISTS idx_layout_groups_task ON layout_groups(task_id);
CREATE INDEX IF NOT EXISTS idx_crop_regions_page ON crop_regions(page_id);
CREATE INDEX IF NOT EXISTS idx_review_segments_task ON review_segments(task_id);
CREATE INDEX IF NOT EXISTS idx_exports_task ON exports(task_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, created_at);
"""


class Database:
    """Small sqlite3 wrapper with repeatable initialization and transactions."""

    def __init__(
        self,
        path: str | Path = ":memory:",
        *,
        connection: sqlite3.Connection | None = None,
    ) -> None:
        self.path = str(path)
        if connection is None:
            if self.path != ":memory:":
                Path(self.path).parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(
                self.path,
                detect_types=sqlite3.PARSE_DECLTYPES,
                check_same_thread=False,
            )
        self.connection = connection
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute("PRAGMA busy_timeout = 5000")
        self._savepoint_counter = 0

    def initialize(self) -> None:
        """Create all current tables and indexes; safe to call repeatedly."""

        with self.transaction():
            self.connection.executescript(SCHEMA)
            self._migrate_review_segments()

    def _migrate_review_segments(self) -> None:
        """Apply idempotent migrations for the independently-owned review table.

        ``CREATE TABLE IF NOT EXISTS`` cannot update an already-created table.
        Older local databases therefore need the column added explicitly before
        the review store starts decoding rows that include its audit timestamp.
        """

        columns = {
            row["name"]
            for row in self.connection.execute("PRAGMA table_info(review_segments)").fetchall()
        }
        had_column = "reviewed_at" in columns
        just_added = False
        if not had_column:
            # SQLite requires a default when adding a NOT NULL column.  Existing
            # rows are immediately backfilled below with one current UTC value.
            self.connection.execute(
                "ALTER TABLE review_segments "
                "ADD COLUMN reviewed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"
            )
            just_added = True
        reviewed_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        if just_added:
            # SQLite materializes the ALTER default for every legacy row, so the
            # normal NULL/blank repair predicate would leave the sentinel in
            # place.  A newly-added column contains no legitimate timestamps;
            # replace that sentinel for every existing row with one audit value.
            self.connection.execute(
                "UPDATE review_segments SET reviewed_at = ?",
                (reviewed_at,),
            )
            return
        self.connection.execute(
            "UPDATE review_segments "
            "SET reviewed_at = ? "
            "WHERE reviewed_at IS NULL OR TRIM(reviewed_at) = ''",
            (reviewed_at,),
        )

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Yield the connection in a commit/rollback transaction.

        Nested calls use savepoints so TaskStore methods remain composable and
        an outer transaction can still roll back a group of writes atomically.
        """

        nested = self.connection.in_transaction
        savepoint: str | None = None
        if nested:
            self._savepoint_counter += 1
            savepoint = f"task_store_sp_{self._savepoint_counter}"
            self.connection.execute(f"SAVEPOINT {savepoint}")
        else:
            self.connection.execute("BEGIN")
        try:
            yield self.connection
        except BaseException:
            if savepoint is None:
                self.connection.rollback()
            else:
                self.connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                self.connection.execute(f"RELEASE SAVEPOINT {savepoint}")
            raise
        else:
            if savepoint is None:
                self.connection.commit()
            else:
                self.connection.execute(f"RELEASE SAVEPOINT {savepoint}")

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> "Database":
        self.initialize()
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        self.close()


def new_id(prefix: str) -> str:
    """Generate stable, readable identifiers for persisted records."""

    return f"{prefix}_{uuid4().hex}"
