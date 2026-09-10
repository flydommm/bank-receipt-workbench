"""Durable task, page checkpoint, and result snapshot storage.

The batch store is deliberately separate from the legacy task/review
databases.  Workers use short ``BEGIN IMMEDIATE`` transactions and every
mutable page write carries the current owner, generation, and attempt so a
late worker cannot overwrite a newer run.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
from typing import Iterator, Iterable, Mapping, Sequence
import unicodedata
from uuid import uuid4

from .batch_models import (
    BUDGET_FIELDS,
    BUDGET_LIMITS,
    MAX_CRITERIA_CLAUSES,
    MAX_IDENTIFIER_BYTES,
    MAX_JSON_BYTES,
    MAX_LAYOUT_TEXT_BYTES,
    MAX_MATCH_TEXT_BYTES,
    MAX_NAME_BYTES,
    MAX_PAGE_RESULT_BYTES,
    MAX_PATH_BYTES,
    MAX_RESULTS_PAGE_BYTES,
    MAX_RESULTS_PAGE_ITEMS,
    MAX_SOURCES,
    BatchModelError,
    canonical_json,
    clone_json,
    criteria_clauses,
    normalize_criteria,
    normalize_match_mode,
    validate_budget,
    validate_page_result,
)


SCHEMA_VERSION = 1
DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024
PAGE_STAGE = "page"
MAX_PAGE_COUNT = BUDGET_LIMITS["processed_pages"]
MAX_COMMANDS_PER_JOB = 1_024

# These reservations cover the SQLite row/WAL overhead before a metadata
# write.  They are deliberately conservative; page registration scales with
# the caller-verified page count so quota checks cannot be bypassed by a large
# source manifest.
_CREATE_METADATA_RESERVE_BYTES = 64 * 1024
_SOURCE_METADATA_RESERVE_BYTES = 4 * 1024
_PAGE_METADATA_RESERVE_BYTES = 512
_START_METADATA_RESERVE_BYTES = 16 * 1024
_PAGE_CLAIM_RESERVE_BYTES = 4 * 1024
_MAX_SOURCE_SNAPSHOT_BYTES = 128 * 1024
_MAX_SOURCE_COLLECTION_BYTES = MAX_JSON_BYTES

_SNAPSHOT_SEGMENT_FIELDS = frozenset({
    "id", "source_key", "source_path", "source_sha256", "source_page", "segment_no",
    "match_rect", "candidate_rect", "final_rect", "page_width", "page_height",
    "confidence", "slot", "snap_points", "layout_fingerprint", "crop_mode",
    "review_status", "manual_adjusted",
})
_SNAPSHOT_MATCH_REQUIRED_FIELDS = frozenset({
    "page", "matched_text", "matched_field", "confidence", "x0", "y0", "x1", "y1",
})
_SNAPSHOT_MATCH_OPTIONAL_FIELDS = frozenset({"needs_review", "query_id", "role"})
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


class BatchStoreError(ValueError):
    """Base error for invalid or unavailable batch-store operations."""


class BatchConflict(BatchStoreError):
    """The requested write lost an owner/generation/state/attempt CAS."""


class BatchComputationChanged(BatchConflict):
    """The job was created by a computation version different from this worker."""


class BatchCapacityExceeded(BatchStoreError):
    """A new computation/result would exceed the persistent quota."""


class BatchSchemaIncompatible(BatchStoreError):
    """The database is from a newer or otherwise unsupported schema."""


_DDL: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS batch_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        state TEXT NOT NULL,
        resume_target TEXT,
        criteria_json TEXT NOT NULL,
        criteria_fingerprint TEXT NOT NULL,
        match_mode TEXT NOT NULL,
        computation_version TEXT NOT NULL,
        result_revision TEXT,
        owner TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deletion_pending INTEGER NOT NULL DEFAULT 0 CHECK (deletion_pending IN (0, 1))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS batch_sources (
        job_id TEXT NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        source_key TEXT NOT NULL,
        initial_path TEXT NOT NULL,
        access_path TEXT NOT NULL,
        name TEXT NOT NULL,
        sha256 TEXT,
        size_bytes INTEGER,
        page_count INTEGER CHECK (page_count IS NULL OR page_count > 0),
        state TEXT NOT NULL,
        error_json TEXT,
        budget_json TEXT NOT NULL,
        verified_generation INTEGER,
        PRIMARY KEY (job_id, source_id),
        UNIQUE (job_id, position),
        UNIQUE (job_id, source_key),
        CHECK (size_bytes IS NULL OR size_bytes >= 0)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS batch_pages (
        job_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        page INTEGER NOT NULL CHECK (page > 0),
        stage TEXT NOT NULL CHECK (stage = 'page'),
        state TEXT NOT NULL,
        owner TEXT,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        attempt INTEGER NOT NULL CHECK (attempt >= 0),
        error_json TEXT,
        budget_json TEXT NOT NULL,
        PRIMARY KEY (job_id, source_id, page, stage),
        FOREIGN KEY (job_id, source_id)
            REFERENCES batch_sources(job_id, source_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS batch_page_results (
        job_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        stage TEXT NOT NULL CHECK (stage = 'page'),
        schema INTEGER NOT NULL CHECK (schema = 1),
        payload_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (job_id, source_id, page, stage),
        FOREIGN KEY (job_id, source_id, page, stage)
            REFERENCES batch_pages(job_id, source_id, page, stage) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS batch_snapshots (
        job_id TEXT NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
        result_revision TEXT NOT NULL,
        schema INTEGER NOT NULL CHECK (schema = 1),
        source_summary_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        originals_count INTEGER NOT NULL CHECK (originals_count >= 0),
        originals_digest TEXT NOT NULL,
        source_count INTEGER NOT NULL CHECK (source_count >= 0),
        item_count INTEGER NOT NULL CHECK (item_count >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (job_id, result_revision),
        UNIQUE (job_id, result_revision)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS batch_snapshot_items (
        job_id TEXT NOT NULL,
        result_revision TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        item_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (job_id, result_revision, position),
        UNIQUE (job_id, result_revision, item_id),
        FOREIGN KEY (job_id, result_revision)
            REFERENCES batch_snapshots(job_id, result_revision) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS batch_commands (
        job_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        command_id TEXT NOT NULL,
        action TEXT NOT NULL,
        input_json TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (job_id, generation, command_id),
        FOREIGN KEY (job_id) REFERENCES batch_jobs(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS batch_supervisor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_nonce TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS batch_cleanup (
        id TEXT PRIMARY KEY,
        job_id TEXT,
        scope_json TEXT NOT NULL,
        context_key TEXT,
        preview_identity_json TEXT,
        task_data_state TEXT NOT NULL DEFAULT 'pending',
        preview_state TEXT NOT NULL DEFAULT 'pending',
        review_state TEXT NOT NULL DEFAULT 'pending',
        residual_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_batch_jobs_state ON batch_jobs(state, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_batch_sources_job ON batch_sources(job_id, position)",
    "CREATE INDEX IF NOT EXISTS idx_batch_pages_state ON batch_pages(job_id, state, source_id, page)",
    "CREATE INDEX IF NOT EXISTS idx_batch_commands_job ON batch_commands(job_id, generation, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_batch_cleanup_job ON batch_cleanup(job_id, updated_at)",
)


_EXECUTION_STATES = {
    "queued",
    "validating",
    "running",
    "pause_requested",
    "paused",
    "partial_failed",
    "finalizing",
    "blocked",
    "cancel_requested",
}
# A queued/paused/partially failed/blocked job is a resumable checkpoint, not
# an active worker.  Only these states represent a currently executing run
# for the single-active-job guard.
_ACTIVE_START_STATES = {
    "validating",
    "running",
    "pause_requested",
    "finalizing",
    "cancel_requested",
}
_TERMINAL_STATES = {"ready_for_review", "cancelled", "interrupted", "archived"}
_IDLE_CANCEL_STATES = {"queued", "paused", "partial_failed", "blocked", "interrupted"}
_WORKER_CANCEL_STATES = {"validating", "running", "pause_requested", "finalizing"}
_TRANSITIONS: dict[str, set[str]] = {
    "queued": {"validating", "cancel_requested", "cancelled", "paused", "interrupted"},
    "validating": {"running", "blocked", "cancel_requested", "paused", "interrupted"},
    "running": {"pause_requested", "partial_failed", "finalizing", "blocked", "cancel_requested", "interrupted"},
    "pause_requested": {"paused", "cancel_requested", "partial_failed", "interrupted"},
    "paused": {"validating", "cancel_requested", "cancelled", "interrupted"},
    "partial_failed": {"validating", "cancel_requested", "cancelled", "paused", "interrupted"},
    "finalizing": {"blocked", "cancel_requested", "interrupted"},
    "blocked": {"validating", "cancel_requested", "cancelled", "paused", "interrupted"},
    "cancel_requested": {"cancelled", "interrupted"},
    "ready_for_review": {"archived"},
    "cancelled": {"validating"},
    "interrupted": {"validating", "cancelled"},
    "archived": set(),
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _error(field: str, detail: str) -> BatchStoreError:
    return BatchStoreError(f"{field} {detail}")


def _text(value: object, field: str, *, max_bytes: int, strip: bool = True) -> str:
    if not isinstance(value, str):
        raise _error(field, "must be a string")
    result = value.strip() if strip else value
    if not result or "\x00" in result:
        raise _error(field, "must be non-empty and contain no NUL")
    try:
        if len(result.encode("utf-8", "strict")) > max_bytes:
            raise _error(field, "is too long")
    except UnicodeError:
        raise _error(field, "must be valid UTF-8") from None
    return result


def _integer(value: object, field: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise _error(field, f"must be an integer >= {minimum}")
    return value


def _sha(value: object, field: str = "sha256") -> str:
    if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
        raise _error(field, "must be a SHA-256 digest")
    return value.lower()


def _source_key(value: object) -> str:
    path = _text(value, "source_path", max_bytes=MAX_PATH_BYTES)
    return unicodedata.normalize("NFC", path).replace("\\", "/").lower()


def _optional_error(value: object) -> str | None:
    if value is None:
        return None
    try:
        return canonical_json(value, max_bytes=MAX_JSON_BYTES).decode("utf-8")
    except BatchModelError as exc:
        raise BatchStoreError(str(exc)) from None


def _decode_json(value: object, field: str) -> object:
    if not isinstance(value, str):
        raise _error(field, "is not valid JSON")
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, UnicodeError):
        raise _error(field, "is not valid JSON") from None
    try:
        return clone_json(parsed, max_bytes=MAX_JSON_BYTES)
    except BatchModelError as exc:
        raise BatchStoreError(str(exc)) from None


def _value(value: object) -> object:
    return value.value if hasattr(value, "value") else value


class BatchStore:
    """SQLite-backed persistent task and page-result store."""

    def __init__(self, path: str | Path = ":memory:", *, quota_bytes: int = DEFAULT_QUOTA_BYTES) -> None:
        if isinstance(quota_bytes, bool) or not isinstance(quota_bytes, int) or quota_bytes < 0:
            raise _error("quota_bytes", "must be a non-negative integer")
        self.path = str(path)
        self.quota_bytes = quota_bytes
        self._path: Path | None = None if self.path == ":memory:" else Path(self.path)
        if self._path is not None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(
            self.path,
            isolation_level=None,
            check_same_thread=False,
        )
        self.connection.row_factory = sqlite3.Row
        try:
            # Read the version before changing the journal mode.  Opening a
            # future database must be a read-only compatibility refusal, not
            # an incidental WAL/header mutation.
            version = int(self.connection.execute("PRAGMA user_version").fetchone()[0])
        except (sqlite3.DatabaseError, TypeError, ValueError) as exc:
            self.connection.close()
            raise BatchSchemaIncompatible("cannot read SQLite schema version") from exc
        if version > SCHEMA_VERSION:
            self.connection.close()
            raise BatchSchemaIncompatible(
                f"database schema {version} is newer than supported schema {SCHEMA_VERSION}"
            )
        # These connection settings are applied only after the compatibility
        # gate above.  In particular, a future schema is rejected before any
        # persistent journal/synchronous configuration can be touched.
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute("PRAGMA busy_timeout = 5000")
        self.connection.execute("PRAGMA synchronous = NORMAL")
        try:
            self._initialize_schema()
        except BaseException:
            self.connection.close()
            raise
        try:
            self.connection.execute("PRAGMA journal_mode = WAL")
        except sqlite3.DatabaseError as exc:
            self.connection.close()
            raise BatchStoreError(f"cannot enable SQLite WAL: {exc}") from None

    def _initialize_schema(self) -> None:
        try:
            version = int(self.connection.execute("PRAGMA user_version").fetchone()[0])
        except sqlite3.DatabaseError as exc:
            self.connection.close()
            raise BatchSchemaIncompatible("cannot read SQLite schema version") from exc
        if version > SCHEMA_VERSION:
            self.connection.close()
            raise BatchSchemaIncompatible(
                f"database schema {version} is newer than supported schema {SCHEMA_VERSION}"
            )
        required = {
            "batch_jobs",
            "batch_sources",
            "batch_pages",
            "batch_page_results",
            "batch_snapshots",
            "batch_snapshot_items",
            "batch_commands",
            "batch_supervisor",
            "batch_cleanup",
        }
        existing = {
            (str(row[0]), str(row[1]))
            for row in self.connection.execute(
                "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
            )
        }
        existing_tables = {name for object_type, name in existing if object_type == "table"}
        if version == SCHEMA_VERSION:
            if not required.issubset(existing_tables):
                raise BatchSchemaIncompatible("schema version 1 is missing required tables")
            return
        if existing:
            # There is no supported v0 migration.  Refuse any non-empty
            # database before DDL, backup, journal-mode, or user_version
            # changes so an unrelated legacy database remains untouched.
            raise BatchSchemaIncompatible("non-empty schema version 0 is unsupported")
        try:
            with self._transaction() as connection:
                for statement in _DDL:
                    connection.execute(statement)
                connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        except sqlite3.DatabaseError as exc:
            raise BatchSchemaIncompatible("batch schema migration failed and was rolled back") from exc

    def _backup_before_migration(self) -> None:
        if self._path is None or not self._path.exists() or self._path.stat().st_size == 0:
            return
        backup_path = self._path.with_name(
            f"{self._path.name}.pre-v{SCHEMA_VERSION}-{uuid4().hex}.sqlite3"
        )
        backup_connection: sqlite3.Connection | None = None
        try:
            backup_connection = sqlite3.connect(str(backup_path))
            self.connection.backup(backup_connection)
            backup_connection.commit()
        except sqlite3.DatabaseError as exc:
            raise BatchSchemaIncompatible("could not create a pre-migration backup") from exc
        finally:
            if backup_connection is not None:
                backup_connection.close()

    @contextmanager
    def _transaction(self, *, immediate: bool = True) -> Iterator[sqlite3.Connection]:
        try:
            self.connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        except sqlite3.DatabaseError as exc:
            raise BatchConflict(f"could not begin a batch transaction: {exc}") from None
        try:
            yield self.connection
        except BaseException:
            self.connection.rollback()
            raise
        else:
            try:
                self.connection.commit()
            except sqlite3.DatabaseError:
                self.connection.rollback()
                raise

    def close(self) -> None:
        if self.connection is not None:
            self.connection.close()

    def __enter__(self) -> "BatchStore":
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        self.close()

    def _storage_size(self) -> int:
        if self._path is None:
            row = self.connection.execute("PRAGMA page_count").fetchone()
            size = int(row[0]) * int(self.connection.execute("PRAGMA page_size").fetchone()[0])
            return size
        total = 0
        for candidate in (self._path, Path(f"{self._path}-wal"), Path(f"{self._path}-shm")):
            try:
                total += candidate.stat().st_size
            except OSError:
                pass
        return total

    def quota_usage_bytes(self) -> int:
        """Return current DB/WAL/SHM usage for diagnostics and the UI."""

        return self._storage_size()

    def _ensure_capacity(self, extra_bytes: int) -> None:
        if isinstance(extra_bytes, bool) or not isinstance(extra_bytes, int) or extra_bytes < 0:
            raise _error("extra_bytes", "must be a non-negative integer")
        if self._storage_size() + extra_bytes > self.quota_bytes:
            raise BatchCapacityExceeded("batch storage quota exceeded")

    @staticmethod
    def _job_row(connection: sqlite3.Connection, job_id: str) -> sqlite3.Row:
        row = connection.execute("SELECT * FROM batch_jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise BatchStoreError(f"job not found: {job_id}")
        return row

    @staticmethod
    def _source_row(connection: sqlite3.Connection, job_id: str, source_id: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM batch_sources WHERE job_id = ? AND source_id = ?",
            (job_id, source_id),
        ).fetchone()
        if row is None:
            raise BatchStoreError(f"source not found: {source_id}")
        return row

    @staticmethod
    def _page_row(connection: sqlite3.Connection, job_id: str, source_id: str, page: int) -> sqlite3.Row:
        row = connection.execute(
            """
            SELECT * FROM batch_pages
             WHERE job_id = ? AND source_id = ? AND page = ? AND stage = 'page'
            """,
            (job_id, source_id, page),
        ).fetchone()
        if row is None:
            raise BatchStoreError(f"page not found: {page}")
        return row

    def _assert_supervisor(self, connection: sqlite3.Connection, owner: str) -> None:
        row = connection.execute(
            "SELECT owner_nonce FROM batch_supervisor WHERE singleton = 1"
        ).fetchone()
        if row is None or row["owner_nonce"] != owner:
            raise BatchConflict("batch supervisor owner is stale")

    def _assert_owner_generation(
        self,
        connection: sqlite3.Connection,
        row: sqlite3.Row,
        generation: object,
        owner: object,
    ) -> str:
        expected_generation = _integer(generation, "generation")
        expected_owner = _text(owner, "owner", max_bytes=MAX_IDENTIFIER_BYTES)
        if row["generation"] != expected_generation or row["owner"] != expected_owner:
            raise BatchConflict("job owner or generation is stale")
        self._assert_supervisor(connection, expected_owner)
        return expected_owner

    @staticmethod
    def _budget_json(value: object) -> str:
        try:
            budget = validate_budget(value)
            return canonical_json(budget).decode("utf-8")
        except BatchModelError as exc:
            raise BatchStoreError(str(exc)) from None

    def _source_snapshot(self, connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, object]:
        counts = {
            "pending": 0,
            "processing": 0,
            "succeeded": 0,
            "failed": 0,
        }
        for count_row in connection.execute(
            "SELECT state, COUNT(*) AS count FROM batch_pages WHERE job_id = ? AND source_id = ? GROUP BY state",
            (row["job_id"], row["source_id"]),
        ):
            if count_row["state"] in counts:
                counts[count_row["state"]] = int(count_row["count"])
        error = _decode_json(row["error_json"], "source.error") if row["error_json"] is not None else None
        budget = _decode_json(row["budget_json"], "source.budget")
        try:
            budget = validate_budget(budget)
        except BatchModelError as exc:
            raise BatchStoreError(str(exc)) from None
        return {
            "source_id": row["source_id"],
            "position": int(row["position"]),
            "source_key": row["source_key"],
            "initial_path": row["initial_path"],
            "access_path": row["access_path"],
            "name": row["name"],
            "sha256": row["sha256"],
            "size_bytes": row["size_bytes"],
            "page_count": row["page_count"],
            "state": row["state"],
            "error": error,
            "budget": budget,
            "verified_generation": row["verified_generation"],
            "page_summary": counts,
        }

    def _job_snapshot_connection(
        self,
        connection: sqlite3.Connection,
        row: sqlite3.Row,
        *,
        include_sources: bool = True,
    ) -> dict[str, object]:
        criteria = _decode_json(row["criteria_json"], "job.criteria")
        try:
            criteria = normalize_criteria(criteria)
        except BatchModelError as exc:
            raise BatchStoreError(str(exc)) from None
        error = _decode_json(row["error_json"], "job.error") if row["error_json"] is not None else None
        sources: list[dict[str, object]] = []
        source_summary: dict[str, int] | None = None
        if include_sources:
            source_bytes = 0
            source_rows = connection.execute(
                "SELECT * FROM batch_sources WHERE job_id = ? ORDER BY position ASC",
                (row["id"],),
            )
            for source_row in source_rows:
                source = self._source_snapshot(connection, source_row)
                try:
                    detached = clone_json(source, max_bytes=_MAX_SOURCE_SNAPSHOT_BYTES)
                    encoded = canonical_json(detached, max_bytes=_MAX_SOURCE_SNAPSHOT_BYTES)
                except BatchModelError as exc:
                    raise BatchStoreError(str(exc)) from None
                if not isinstance(detached, dict):
                    raise BatchStoreError("source snapshot is invalid")
                source_bytes += len(encoded)
                if source_bytes > _MAX_SOURCE_COLLECTION_BYTES:
                    raise BatchStoreError("source snapshots are too large")
                sources.append(detached)
        else:
            source_summary = {
                "total": 0,
                "pending": 0,
                "registered": 0,
                "verified": 0,
                "failed": 0,
                "blocked": 0,
                "declared_pages": 0,
            }
            for source_row in connection.execute(
                """
                SELECT state, page_count
                  FROM batch_sources
                 WHERE job_id = ?
                 ORDER BY position ASC
                """,
                (row["id"],),
            ):
                source_summary["total"] += 1
                state = str(source_row["state"])
                if state in source_summary:
                    source_summary[state] += 1
                if source_row["page_count"] is not None:
                    source_summary["declared_pages"] += int(source_row["page_count"])
        page_summary = {"pending": 0, "processing": 0, "succeeded": 0, "failed": 0}
        for count_row in connection.execute(
            "SELECT state, COUNT(*) AS count FROM batch_pages WHERE job_id = ? GROUP BY state",
            (row["id"],),
        ):
            if count_row["state"] in page_summary:
                page_summary[count_row["state"]] = int(count_row["count"])
        snapshot = {
            "id": row["id"],
            "name": row["name"],
            "generation": int(row["generation"]),
            "state": row["state"],
            "resume_target": row["resume_target"],
            "criteria": criteria,
            "criteria_fingerprint": row["criteria_fingerprint"],
            "match_mode": row["match_mode"],
            "computation_version": row["computation_version"],
            "result_revision": row["result_revision"],
            "owner": row["owner"],
            "error": error,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "deletion_pending": bool(row["deletion_pending"]),
            "page_summary": page_summary,
            "total_pages": sum(page_summary.values()),
        }
        if include_sources:
            snapshot["sources"] = sources
        else:
            assert source_summary is not None
            snapshot["source_summary"] = source_summary
        try:
            # Metadata and list summaries are small enough for one ordinary
            # JSON copy.  Full source arrays were detached per row above so a
            # large manifest does not hit the aggregate node budget here.
            if include_sources:
                return snapshot
            return clone_json(snapshot, max_bytes=MAX_JSON_BYTES)
        except BatchModelError as exc:
            raise BatchStoreError(str(exc)) from None

    def create_job(
        self,
        name: object,
        sources: object,
        criteria: object,
        match_mode: object,
        computation_version: object,
    ) -> dict[str, object]:
        job_name = _text(name, "name", max_bytes=MAX_NAME_BYTES)
        if not isinstance(sources, Sequence) or isinstance(sources, (str, bytes, bytearray)):
            raise _error("sources", "must be an ordered array")
        if not sources or len(sources) > MAX_SOURCES:
            raise _error("sources", "must contain between 1 and 10000 entries")
        normalized_sources: list[dict[str, str]] = []
        source_keys: set[str] = set()
        for source in sources:
            if not isinstance(source, Mapping):
                raise _error("source", "must be an object")
            source_path = _text(source.get("source_path"), "source_path", max_bytes=MAX_PATH_BYTES)
            source_name = _text(source.get("name"), "source.name", max_bytes=MAX_NAME_BYTES)
            key = _source_key(source_path)
            if key in source_keys:
                raise BatchConflict("sources cannot contain duplicate logical paths")
            source_keys.add(key)
            normalized_sources.append({"source_path": source_path, "name": source_name})
        try:
            normalized_criteria = normalize_criteria(criteria)
        except BatchModelError as exc:
            raise BatchStoreError(str(exc)) from None
        normalized_mode = normalize_match_mode(match_mode)
        computation = _text(computation_version, "computation_version", max_bytes=256)
        criteria_payload = canonical_json(normalized_criteria).decode("utf-8")
        fingerprint_payload = {
            "criteria": normalized_criteria,
            "match_mode": normalized_mode,
            "clauses": criteria_clauses(normalized_criteria),
        }
        criteria_fingerprint = hashlib.sha256(canonical_json(fingerprint_payload)).hexdigest()
        job_id = str(uuid4())
        now = _utc_now()
        zero_budget = self._budget_json({field: 0 for field in BUDGET_FIELDS})
        estimated_bytes = _CREATE_METADATA_RESERVE_BYTES + len(criteria_payload.encode("utf-8"))
        estimated_bytes += len(zero_budget.encode("utf-8")) * len(normalized_sources)
        for source in normalized_sources:
            estimated_bytes += 2_048 + 4 * (
                len(source["source_path"].encode("utf-8")) + len(source["name"].encode("utf-8"))
            )
        with self._transaction() as connection:
            # Serialize the quota observation with the write. Concurrent
            # management processes must not reserve the same free bytes.
            self._ensure_capacity(estimated_bytes)
            connection.execute(
                """
                INSERT INTO batch_jobs (
                    id, name, generation, state, resume_target, criteria_json,
                    criteria_fingerprint, match_mode, computation_version,
                    result_revision, owner, error_json, created_at, updated_at,
                    deletion_pending
                ) VALUES (?, ?, 0, 'queued', NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 0)
                """,
                (
                    job_id,
                    job_name,
                    criteria_payload,
                    criteria_fingerprint,
                    normalized_mode,
                    computation,
                    now,
                    now,
                ),
            )
            for position, source in enumerate(normalized_sources):
                source_id = str(uuid4())
                source_path = source["source_path"]
                connection.execute(
                    """
                    INSERT INTO batch_sources (
                        job_id, source_id, position, source_key, initial_path,
                        access_path, name, sha256, size_bytes, page_count, state,
                        error_json, budget_json, verified_generation
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'pending', NULL, ?, NULL)
                    """,
                    (
                        job_id,
                        source_id,
                        position,
                        _source_key(source_path),
                        source_path,
                        source_path,
                        source["name"],
                        zero_budget,
                    ),
                )
            return self._job_snapshot_connection(connection, self._job_row(connection, job_id))

    def get_job(self, job_id: object) -> dict[str, object]:
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        row = self.connection.execute("SELECT * FROM batch_jobs WHERE id = ?", (identifier,)).fetchone()
        if row is None:
            raise BatchStoreError(f"job not found: {identifier}")
        return self._job_snapshot_connection(self.connection, row)

    def list_jobs(self, offset: object = 0, limit: object = 50) -> dict[str, object]:
        start = _integer(offset, "offset")
        page_size = _integer(limit, "limit", minimum=1)
        if page_size > 50:
            raise _error("limit", "cannot exceed 50")
        total = int(self.connection.execute("SELECT COUNT(*) FROM batch_jobs").fetchone()[0])
        rows = self.connection.execute(
            "SELECT * FROM batch_jobs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
            (page_size, start),
        ).fetchall()
        jobs = [
            self._job_snapshot_connection(self.connection, row, include_sources=False)
            for row in rows
        ]
        next_offset = start + len(jobs) if start + len(jobs) < total else None
        result = {
            "items": jobs,
            "offset": start,
            "limit": page_size,
            "total": total,
            "next_offset": next_offset,
        }
        try:
            return clone_json(result, max_bytes=MAX_JSON_BYTES)
        except BatchModelError as exc:
            raise BatchStoreError(str(exc)) from None

    def activate_supervisor(self, owner: object) -> dict[str, object]:
        owner_nonce = _text(owner, "owner", max_bytes=MAX_IDENTIFIER_BYTES)
        now = _utc_now()
        with self._transaction() as connection:
            current = connection.execute(
                "SELECT owner_nonce FROM batch_supervisor WHERE singleton = 1"
            ).fetchone()
            if current is None:
                connection.execute(
                    "INSERT INTO batch_supervisor(singleton, owner_nonce, updated_at) VALUES (1, ?, ?)",
                    (owner_nonce, now),
                )
            elif current["owner_nonce"] != owner_nonce:
                # The caller is the trusted host after taking its OS-level
                # lock.  Reclaim only non-terminal rows and keep every
                # succeeded page/budget intact.
                connection.execute(
                    """
                    UPDATE batch_pages
                       SET state = 'pending', owner = NULL, error_json = NULL
                     WHERE state = 'processing'
                       AND job_id IN (SELECT id FROM batch_jobs WHERE state IN ({states}) AND owner IS NOT NULL)
                    """.format(states=",".join("?" for _ in _ACTIVE_START_STATES)),
                    tuple(_ACTIVE_START_STATES),
                )
                connection.execute(
                    """
                    UPDATE batch_jobs
                       SET state = 'interrupted', owner = NULL, updated_at = ?
                     WHERE state IN ({states}) AND owner IS NOT NULL
                    """.format(states=",".join("?" for _ in _ACTIVE_START_STATES)),
                    (now, *tuple(_ACTIVE_START_STATES)),
                )
                connection.execute(
                    "UPDATE batch_supervisor SET owner_nonce = ?, updated_at = ? WHERE singleton = 1",
                    (owner_nonce, now),
                )
            else:
                connection.execute(
                    "UPDATE batch_supervisor SET updated_at = ? WHERE singleton = 1",
                    (now,),
                )
        return {"owner": owner_nonce}

    def start_job(
        self,
        job_id: object,
        expected_generation: object,
        owner: object,
        computation_version: object,
    ) -> dict[str, object]:
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        expected = _integer(expected_generation, "expected_generation")
        owner_nonce = _text(owner, "owner", max_bytes=MAX_IDENTIFIER_BYTES)
        version = _text(computation_version, "computation_version", max_bytes=256)
        now = _utc_now()
        with self._transaction() as connection:
            self._assert_supervisor(connection, owner_nonce)
            row = self._job_row(connection, identifier)
            if row["deletion_pending"]:
                raise BatchConflict("job cleanup is pending")
            if row["generation"] != expected:
                raise BatchConflict("job generation is stale")
            if row["computation_version"] != version:
                raise BatchComputationChanged("computation version changed")
            if row["state"] not in {"queued", "paused", "partial_failed", "blocked", "cancelled", "interrupted"}:
                raise BatchConflict(f"job cannot start from state {row['state']}")
            active = connection.execute(
                "SELECT id FROM batch_jobs WHERE id <> ? AND state IN ({states}) LIMIT 1".format(
                    states=",".join("?" for _ in _ACTIVE_START_STATES)
                ),
                (identifier, *tuple(_ACTIVE_START_STATES)),
            ).fetchone()
            if active is not None:
                raise BatchConflict("another batch job is active")
            generation = expected + 1
            self._ensure_capacity(_START_METADATA_RESERVE_BYTES)
            # Command IDs are scoped to a generation.  A resumed run starts
            # with a clean, bounded command history; stale controls cannot
            # affect the new generation and must not consume its quota.
            connection.execute("DELETE FROM batch_commands WHERE job_id = ?", (identifier,))
            connection.execute(
                """
                DELETE FROM batch_page_results
                 WHERE job_id = ?
                   AND EXISTS (
                       SELECT 1 FROM batch_pages p
                        WHERE p.job_id = batch_page_results.job_id
                          AND p.source_id = batch_page_results.source_id
                          AND p.page = batch_page_results.page
                          AND p.stage = batch_page_results.stage
                          AND p.state <> 'succeeded'
                   )
                """,
                (identifier,),
            )
            connection.execute(
                """
                UPDATE batch_pages
                   SET state = 'pending', owner = NULL, generation = ?, error_json = NULL
                 WHERE job_id = ? AND state <> 'succeeded'
                """,
                (generation, identifier),
            )
            connection.execute(
                "UPDATE batch_sources SET verified_generation = NULL WHERE job_id = ?",
                (identifier,),
            )
            connection.execute(
                """
                UPDATE batch_jobs
                   SET generation = ?, state = 'validating', resume_target = NULL,
                       result_revision = NULL, owner = ?, error_json = NULL,
                       deletion_pending = 0, updated_at = ?
                 WHERE id = ? AND generation = ?
                """,
                (generation, owner_nonce, now, identifier, expected),
            )
            if connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise BatchConflict("job changed while starting")
            return self._job_snapshot_connection(connection, self._job_row(connection, identifier))

    def register_source(
        self,
        job_id: object,
        generation: object,
        owner: object,
        source_id: object,
        sha256: object,
        size_bytes: object,
        page_count: object,
    ) -> dict[str, object]:
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        source_identifier = _text(source_id, "source_id", max_bytes=MAX_IDENTIFIER_BYTES)
        digest = _sha(sha256)
        size = _integer(size_bytes, "size_bytes")
        pages = _integer(page_count, "page_count", minimum=1)
        if pages > MAX_PAGE_COUNT:
            raise _error("page_count", "exceeds the page limit")
        with self._transaction() as connection:
            job = self._job_row(connection, identifier)
            self._assert_owner_generation(connection, job, generation, owner)
            if job["state"] not in {"validating", "running", "pause_requested", "paused", "partial_failed"}:
                raise BatchConflict(f"source cannot be registered in state {job['state']}")
            source = self._source_row(connection, identifier, source_identifier)
            if source["sha256"] is not None:
                if (
                    source["sha256"].lower() != digest
                    or source["size_bytes"] != size
                    or source["page_count"] != pages
                ):
                    raise BatchConflict("source identity cannot be replaced")
                connection.execute(
                    """
                    UPDATE batch_sources
                       SET state = 'registered', error_json = NULL, verified_generation = NULL
                     WHERE job_id = ? AND source_id = ? AND sha256 = ?
                    """,
                    (identifier, source_identifier, digest),
                )
                return self._source_snapshot(
                    connection,
                    self._source_row(connection, identifier, source_identifier),
                )
            self._ensure_capacity(_SOURCE_METADATA_RESERVE_BYTES + pages * _PAGE_METADATA_RESERVE_BYTES)
            connection.execute(
                """
                UPDATE batch_sources
                   SET sha256 = ?, size_bytes = ?, page_count = ?, state = 'registered',
                       error_json = NULL, verified_generation = NULL
                 WHERE job_id = ? AND source_id = ? AND sha256 IS NULL
                """,
                (digest, size, pages, identifier, source_identifier),
            )
            zero_budget = self._budget_json({field: 0 for field in BUDGET_FIELDS})
            for page in range(1, pages + 1):
                connection.execute(
                    """
                    INSERT OR IGNORE INTO batch_pages (
                        job_id, source_id, page, stage, state, owner, generation,
                        attempt, error_json, budget_json
                    ) VALUES (?, ?, ?, 'page', 'pending', NULL, ?, 0, NULL, ?)
                    """,
                    (identifier, source_identifier, page, job["generation"], zero_budget),
                )
            return self._source_snapshot(
                connection,
                self._source_row(connection, identifier, source_identifier),
            )

    def verify_source(
        self,
        job_id: object,
        generation: object,
        owner: object,
        source_id: object,
        sha256: object | None = None,
        size_bytes: object | None = None,
        page_count: object | None = None,
        *,
        verified_sha256: object | None = None,
        source_sha256: object | None = None,
    ) -> dict[str, object]:
        if sha256 is None:
            sha256 = verified_sha256 if verified_sha256 is not None else source_sha256
        digest = _sha(sha256)
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        source_identifier = _text(source_id, "source_id", max_bytes=MAX_IDENTIFIER_BYTES)
        with self._transaction() as connection:
            job = self._job_row(connection, identifier)
            self._assert_owner_generation(connection, job, generation, owner)
            if job["state"] != "finalizing":
                raise BatchConflict("source verification is only valid during finalizing")
            source = self._source_row(connection, identifier, source_identifier)
            if source["sha256"] is None or source["sha256"].lower() != digest:
                raise BatchConflict("source SHA-256 does not match its registration")
            if size_bytes is not None and _integer(size_bytes, "size_bytes") != source["size_bytes"]:
                raise BatchConflict("source size does not match its registration")
            if page_count is not None and _integer(page_count, "page_count", minimum=1) != source["page_count"]:
                raise BatchConflict("source page count does not match its registration")
            connection.execute(
                """
                UPDATE batch_sources
                   SET state = 'verified', error_json = NULL, verified_generation = ?
                 WHERE job_id = ? AND source_id = ? AND sha256 = ?
                """,
                (job["generation"], identifier, source_identifier, digest),
            )
            return self._source_snapshot(
                connection,
                self._source_row(connection, identifier, source_identifier),
            )

    def fail_source(
        self,
        job_id: object,
        generation: object,
        owner: object,
        source_id: object,
        error: object,
        *,
        blocked: object = False,
    ) -> dict[str, object]:
        """Persist a source-local failure without changing its identity.

        The worker uses this for an unreadable source or a failed final
        generation verification.  The job state is deliberately left to the
        orchestration state machine; source failure must not erase page
        checkpoints or rewrite the registered SHA/size/page count.
        """

        if not isinstance(blocked, bool):
            raise _error("blocked", "must be a boolean")
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        source_identifier = _text(source_id, "source_id", max_bytes=MAX_IDENTIFIER_BYTES)
        encoded_error = _optional_error(error)
        state = "blocked" if blocked else "failed"
        with self._transaction() as connection:
            job = self._job_row(connection, identifier)
            self._assert_owner_generation(connection, job, generation, owner)
            if job["state"] not in _EXECUTION_STATES:
                raise BatchConflict(f"source cannot fail in state {job['state']}")
            self._source_row(connection, identifier, source_identifier)
            connection.execute(
                """
                UPDATE batch_sources
                   SET state = ?, error_json = ?, verified_generation = NULL
                 WHERE job_id = ? AND source_id = ?
                """,
                (state, encoded_error, identifier, source_identifier),
            )
            return self._source_snapshot(
                connection,
                self._source_row(connection, identifier, source_identifier),
            )

    def pending_pages(self, job_id: object, source_id: object) -> list[int]:
        """Return only retryable page numbers for a source.

        This query intentionally selects page metadata only.  In particular,
        it never reads the potentially multi-megabyte raw page payloads.
        """

        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        source_identifier = _text(source_id, "source_id", max_bytes=MAX_IDENTIFIER_BYTES)
        self._job_row(self.connection, identifier)
        self._source_row(self.connection, identifier, source_identifier)
        rows = self.connection.execute(
            """
            SELECT page
              FROM batch_pages
             WHERE job_id = ? AND source_id = ? AND stage = 'page'
               AND state IN ('pending', 'failed')
             ORDER BY page ASC
            """,
            (identifier, source_identifier),
        ).fetchall()
        return [int(row["page"]) for row in rows]

    def transition(
        self,
        job_id: object,
        generation: object,
        owner: object,
        expected_states: object,
        next_state: object,
        *,
        error: object | None = None,
        resume_target: object | None = None,
    ) -> dict[str, object]:
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        target = str(_value(next_state))
        if target not in _TRANSITIONS:
            raise _error("next_state", "is unknown")
        if isinstance(expected_states, (str, bytes)):
            expected = {str(_value(expected_states))}
        else:
            try:
                expected = {str(_value(item)) for item in expected_states}  # type: ignore[union-attr]
            except TypeError:
                raise _error("expected_states", "must be an iterable") from None
        if not expected or any(state not in _TRANSITIONS for state in expected):
            raise _error("expected_states", "contains an unknown state")
        resume = None if resume_target is None else str(_value(resume_target))
        if resume is not None and resume not in _TRANSITIONS:
            raise _error("resume_target", "is unknown")
        encoded_error = _optional_error(error)
        now = _utc_now()
        with self._transaction() as connection:
            job = self._job_row(connection, identifier)
            self._assert_owner_generation(connection, job, generation, owner)
            current = str(job["state"])
            if current not in expected:
                raise BatchConflict("job state is stale")
            if target not in _TRANSITIONS.get(current, set()):
                raise BatchConflict(f"cannot transition job from {current} to {target}")
            if target == "ready_for_review":
                raise BatchConflict("ready_for_review can only be entered by publish_snapshot")
            connection.execute(
                """
                UPDATE batch_jobs
                   SET state = ?, resume_target = ?, error_json = ?, updated_at = ?
                 WHERE id = ? AND generation = ? AND owner = ? AND state = ?
                """,
                (target, resume, encoded_error, now, identifier, job["generation"], job["owner"], current),
            )
            if connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise BatchConflict("job changed during transition")
            return self._job_snapshot_connection(connection, self._job_row(connection, identifier))

    def begin_page(
        self,
        job_id: object,
        generation: object,
        owner: object,
        source_id: object,
        page: object,
    ) -> dict[str, object]:
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        source_identifier = _text(source_id, "source_id", max_bytes=MAX_IDENTIFIER_BYTES)
        page_number = _integer(page, "page", minimum=1)
        with self._transaction() as connection:
            job = self._job_row(connection, identifier)
            owner_nonce = self._assert_owner_generation(connection, job, generation, owner)
            if job["state"] != "running":
                raise BatchConflict(f"page cannot be claimed in state {job['state']}")
            source = self._source_row(connection, identifier, source_identifier)
            if source["page_count"] is None or page_number > source["page_count"]:
                raise BatchStoreError("page is outside the registered source")
            page_row = self._page_row(connection, identifier, source_identifier, page_number)
            if page_row["state"] == "succeeded":
                raise BatchConflict("succeeded page cannot be claimed again")
            if page_row["state"] not in {"pending", "failed"}:
                raise BatchConflict("page is already being processed")
            attempt = int(page_row["attempt"]) + 1
            source_budget = validate_budget(_decode_json(source["budget_json"], "source.budget"))
            self._ensure_capacity(_PAGE_CLAIM_RESERVE_BYTES)
            connection.execute(
                "DELETE FROM batch_page_results WHERE job_id = ? AND source_id = ? AND page = ? AND stage = 'page'",
                (identifier, source_identifier, page_number),
            )
            connection.execute(
                """
                UPDATE batch_pages
                   SET state = 'processing', owner = ?, generation = ?, attempt = ?,
                       error_json = NULL, budget_json = ?
                 WHERE job_id = ? AND source_id = ? AND page = ? AND stage = 'page'
                   AND state IN ('pending', 'failed')
                """,
                (
                    owner_nonce,
                    job["generation"],
                    attempt,
                    canonical_json(source_budget).decode("utf-8"),
                    identifier,
                    source_identifier,
                    page_number,
                ),
            )
            if connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise BatchConflict("page changed while claiming")
            return {
                "job_id": identifier,
                "generation": int(job["generation"]),
                "owner": owner_nonce,
                "source_id": source_identifier,
                "source_key": source["source_key"],
                "initial_path": source["initial_path"],
                "access_path": source["access_path"],
                "name": source["name"],
                "sha256": source["sha256"],
                "size_bytes": source["size_bytes"],
                "page_count": source["page_count"],
                "page": page_number,
                "stage": PAGE_STAGE,
                "attempt": attempt,
                "budget": source_budget,
            }

    @staticmethod
    def _budget_is_monotonic(
        previous: Mapping[str, int],
        current: Mapping[str, int],
        *,
        require_page: bool,
        allowed_page_deltas: set[int] | None = None,
    ) -> None:
        for field in BUDGET_FIELDS:
            if current[field] < previous[field]:
                raise BatchConflict(f"budget.{field} cannot decrease")
        if require_page:
            delta = current["processed_pages"] - previous["processed_pages"]
            allowed = {1} if allowed_page_deltas is None else allowed_page_deltas
            if delta not in allowed:
                raise BatchConflict("budget.processed_pages has an invalid page delta")

    def commit_page(
        self,
        job_id: object,
        generation: object,
        owner: object,
        source_id: object,
        page: object,
        attempt: object,
        payload: object,
        budget: object,
    ) -> dict[str, object]:
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        source_identifier = _text(source_id, "source_id", max_bytes=MAX_IDENTIFIER_BYTES)
        page_number = _integer(page, "page", minimum=1)
        expected_attempt = _integer(attempt, "attempt", minimum=0)
        try:
            validated_payload = validate_page_result(payload)
            validated_budget = validate_budget(budget)
        except BatchModelError as exc:
            raise BatchStoreError(str(exc)) from None
        if validated_payload["page"] != page_number:
            raise BatchStoreError("payload.page does not match the page argument")
        payload_bytes = canonical_json(validated_payload, max_bytes=MAX_PAGE_RESULT_BYTES)
        payload_json = payload_bytes.decode("utf-8")
        digest = hashlib.sha256(payload_bytes).hexdigest()
        with self._transaction() as connection:
            job = self._job_row(connection, identifier)
            owner_nonce = self._assert_owner_generation(connection, job, generation, owner)
            if job["state"] == "cancel_requested":
                raise BatchConflict("cancelled page cannot be committed")
            source = self._source_row(connection, identifier, source_identifier)
            page_row = self._page_row(connection, identifier, source_identifier, page_number)
            if (
                page_row["state"] != "processing"
                or page_row["owner"] != owner_nonce
                or page_row["generation"] != job["generation"]
                or page_row["attempt"] != expected_attempt
            ):
                raise BatchConflict("page owner, generation, or attempt is stale")
            try:
                previous_budget = validate_budget(_decode_json(source["budget_json"], "source.budget"))
            except BatchModelError as exc:
                raise BatchStoreError(str(exc)) from None
            self._budget_is_monotonic(previous_budget, validated_budget, require_page=True)
            self._ensure_capacity(len(payload_bytes) + len(payload_bytes) // 8 + 8_192)
            now = _utc_now()
            connection.execute(
                """
                INSERT INTO batch_page_results (
                    job_id, source_id, page, stage, schema, payload_json, sha256, created_at
                ) VALUES (?, ?, ?, 'page', 1, ?, ?, ?)
                """,
                (identifier, source_identifier, page_number, payload_json, digest, now),
            )
            budget_json = canonical_json(validated_budget).decode("utf-8")
            connection.execute(
                """
                UPDATE batch_sources
                   SET budget_json = ?
                 WHERE job_id = ? AND source_id = ?
                """,
                (budget_json, identifier, source_identifier),
            )
            connection.execute(
                """
                UPDATE batch_pages
                   SET state = 'succeeded', owner = NULL, error_json = NULL, budget_json = ?
                 WHERE job_id = ? AND source_id = ? AND page = ? AND stage = 'page'
                   AND state = 'processing' AND owner = ? AND generation = ? AND attempt = ?
                """,
                (
                    budget_json,
                    identifier,
                    source_identifier,
                    page_number,
                    owner_nonce,
                    job["generation"],
                    expected_attempt,
                ),
            )
            if connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise BatchConflict("page changed while committing")
            if job["state"] == "pause_requested":
                connection.execute(
                    """
                    UPDATE batch_jobs SET state = 'paused', resume_target = 'running', updated_at = ?
                     WHERE id = ? AND generation = ? AND owner = ? AND state = 'pause_requested'
                    """,
                    (now, identifier, job["generation"], owner_nonce),
                )
            return {
                "job_id": identifier,
                "generation": int(job["generation"]),
                "source_id": source_identifier,
                "page": page_number,
                "stage": PAGE_STAGE,
                "attempt": expected_attempt,
                "state": "succeeded",
                "sha256": digest,
                "budget": validated_budget,
            }

    def fail_page(
        self,
        job_id: object,
        generation: object,
        owner: object,
        source_id: object,
        page: object,
        attempt: object,
        error: object,
        *,
        budget: object | None = None,
    ) -> dict[str, object]:
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        source_identifier = _text(source_id, "source_id", max_bytes=MAX_IDENTIFIER_BYTES)
        page_number = _integer(page, "page", minimum=1)
        expected_attempt = _integer(attempt, "attempt", minimum=0)
        encoded_error = _optional_error(error)
        provided_budget: dict[str, int] | None = None
        if budget is not None:
            try:
                provided_budget = validate_budget(budget)
            except BatchModelError as exc:
                raise BatchStoreError(str(exc)) from None
        with self._transaction() as connection:
            job = self._job_row(connection, identifier)
            owner_nonce = self._assert_owner_generation(connection, job, generation, owner)
            source = self._source_row(connection, identifier, source_identifier)
            page_row = self._page_row(connection, identifier, source_identifier, page_number)
            if (
                page_row["state"] != "processing"
                or page_row["owner"] != owner_nonce
                or page_row["generation"] != job["generation"]
                or page_row["attempt"] != expected_attempt
            ):
                raise BatchConflict("page owner, generation, or attempt is stale")
            current_budget = validate_budget(_decode_json(source["budget_json"], "source.budget"))
            settled_budget = current_budget
            if provided_budget is not None:
                # A failed page may have consumed no page-level work (for
                # example, opening/OCR can fail before the page is touched),
                # or may have consumed the page.  Both 0 and 1 are valid;
                # larger jumps would make a single failure account for work
                # from pages that were never durably settled.
                self._budget_is_monotonic(
                    current_budget,
                    provided_budget,
                    require_page=True,
                    allowed_page_deltas={0, 1},
                )
                settled_budget = provided_budget
            budget_json = canonical_json(settled_budget).decode("utf-8")
            connection.execute(
                "DELETE FROM batch_page_results WHERE job_id = ? AND source_id = ? AND page = ? AND stage = 'page'",
                (identifier, source_identifier, page_number),
            )
            if provided_budget is not None:
                connection.execute(
                    "UPDATE batch_sources SET budget_json = ? WHERE job_id = ? AND source_id = ?",
                    (budget_json, identifier, source_identifier),
                )
            connection.execute(
                """
                UPDATE batch_pages
                   SET state = 'failed', owner = NULL, error_json = ?, budget_json = ?
                 WHERE job_id = ? AND source_id = ? AND page = ? AND stage = 'page'
                   AND state = 'processing' AND owner = ? AND generation = ? AND attempt = ?
                """,
                (
                    encoded_error,
                    budget_json,
                    identifier,
                    source_identifier,
                    page_number,
                    owner_nonce,
                    job["generation"],
                    expected_attempt,
                ),
            )
            if connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise BatchConflict("page changed while failing")
            return {
                "job_id": identifier,
                "generation": int(job["generation"]),
                "source_id": source_identifier,
                "page": page_number,
                "stage": PAGE_STAGE,
                "attempt": expected_attempt,
                "state": "failed",
                "budget": settled_budget,
            }

    def read_page_results(self, job_id: object) -> list[dict[str, object]]:
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        self._job_row(self.connection, identifier)
        results: list[dict[str, object]] = []
        rows = self.connection.execute(
            """
            SELECT p.source_id, p.page, p.budget_json, r.payload_json, r.sha256
              FROM batch_pages p
              LEFT JOIN batch_page_results r
                ON r.job_id = p.job_id AND r.source_id = p.source_id
               AND r.page = p.page AND r.stage = p.stage
              JOIN batch_sources s ON s.job_id = p.job_id AND s.source_id = p.source_id
             WHERE p.job_id = ? AND p.stage = 'page' AND p.state = 'succeeded'
             ORDER BY s.position ASC, p.page ASC
            """,
            (identifier,),
        ).fetchall()
        for row in rows:
            if row["payload_json"] is None:
                raise BatchStoreError("succeeded page has no durable result")
            try:
                parsed = json.loads(row["payload_json"])
                payload = validate_page_result(parsed)
                encoded = canonical_json(payload, max_bytes=MAX_PAGE_RESULT_BYTES)
                budget = validate_budget(_decode_json(row["budget_json"], "page.budget"))
            except (BatchModelError, json.JSONDecodeError) as exc:
                raise BatchStoreError("stored page result is invalid") from exc
            if payload["page"] != row["page"]:
                raise BatchStoreError("stored page result page does not match its row")
            if hashlib.sha256(encoded).hexdigest() != row["sha256"]:
                raise BatchStoreError("stored page result checksum is invalid")
            results.append({
                "source_id": row["source_id"],
                "page": int(row["page"]),
                "payload": payload,
                "budget": budget,
                "sha256": row["sha256"],
            })
        return results

    @staticmethod
    def _validate_context(context: object, sources: Sequence[sqlite3.Row], job: sqlite3.Row) -> dict[str, object]:
        if not isinstance(context, Mapping):
            raise BatchStoreError("snapshot context must be an object")
        try:
            value = clone_json(dict(context), max_bytes=MAX_JSON_BYTES)
        except BatchModelError as exc:
            raise BatchStoreError(str(exc)) from None
        if not isinstance(value, dict) or set(value) != {
            "version", "sources", "criteria_fingerprint", "computation_version"
        } or type(value.get("version")) is not int or value["version"] != 2:
            raise BatchStoreError("snapshot context version is invalid")
        raw_sources = value.get("sources")
        if not isinstance(raw_sources, list) or len(raw_sources) != len(sources):
            raise BatchStoreError("snapshot context source set is incomplete")
        for raw, source in zip(raw_sources, sources, strict=True):
            if not isinstance(raw, dict) or set(raw) != {"source_key", "source_path", "source_sha256"}:
                raise BatchStoreError("snapshot context source is invalid")
            raw_sha = raw.get("source_sha256")
            if (
                raw.get("source_key") != source["source_key"]
                or not isinstance(raw_sha, str)
                or not _SHA256_RE.fullmatch(raw_sha)
                or raw_sha.lower() != str(source["sha256"]).lower()
            ):
                raise BatchStoreError("snapshot context source identity is invalid")
            raw_path = raw.get("source_path")
            if not isinstance(raw_path, str) or (
                raw_path.strip() not in {source["initial_path"], source["access_path"]}
                and _source_key(raw_path) != source["source_key"]
            ):
                raise BatchStoreError("snapshot context source path is invalid")
        if value.get("criteria_fingerprint") != job["criteria_fingerprint"]:
            raise BatchStoreError("snapshot context criteria fingerprint is invalid")
        if value.get("computation_version") != job["computation_version"]:
            raise BatchStoreError("snapshot context computation version is invalid")
        return value

    @staticmethod
    def _validate_originals(originals: object, sources: Sequence[sqlite3.Row]) -> list[dict[str, object]]:
        if not isinstance(originals, list) or len(originals) > 50_000:
            raise BatchStoreError("snapshot originals are invalid")
        source_by_key = {str(row["source_key"]): row for row in sources}
        ids: set[str] = set()
        logical: set[tuple[str, int, int]] = set()
        result: list[dict[str, object]] = []
        required = {
            "id", "source_key", "source_page", "segment_no", "analysis_signature",
            "persistable", "page_width", "page_height", "match_rect", "candidate_rect",
            "layout_fingerprint", "confidence", "auto_full_page",
        }
        for original in originals:
            if not isinstance(original, dict) or set(original) != required:
                raise BatchStoreError("snapshot original fields are invalid")
            identifier = _text(original.get("id"), "original.id", max_bytes=MAX_IDENTIFIER_BYTES)
            source_key = _text(original.get("source_key"), "original.source_key", max_bytes=MAX_PATH_BYTES)
            source = source_by_key.get(source_key)
            if source is None or identifier in ids:
                raise BatchStoreError("snapshot original source or id is invalid")
            page = _integer(original.get("source_page"), "original.source_page", minimum=1)
            segment_no = _integer(original.get("segment_no"), "original.segment_no", minimum=1)
            if source["page_count"] is not None and page > source["page_count"]:
                raise BatchStoreError("snapshot original page is outside its source")
            key = (source_key, page, segment_no)
            if key in logical:
                raise BatchStoreError("snapshot originals contain duplicate logical keys")
            if not isinstance(original.get("analysis_signature"), str) or not _SHA256_RE.fullmatch(original["analysis_signature"]):
                raise BatchStoreError("snapshot original analysis signature is invalid")
            if not isinstance(original.get("persistable"), bool) or not isinstance(original.get("auto_full_page"), bool):
                raise BatchStoreError("snapshot original flags are invalid")
            for field in ("page_width", "page_height", "confidence"):
                value = original[field]
                if (
                    isinstance(value, bool)
                    or not isinstance(value, (int, float))
                    or not math.isfinite(float(value))
                ):
                    raise BatchStoreError("snapshot original numeric field is invalid")
            if (
                not 0 <= float(original["confidence"]) <= 1
                or original["page_width"] <= 0
                or original["page_height"] <= 0
            ):
                raise BatchStoreError("snapshot original numeric field is invalid")
            for rect_field in ("match_rect", "candidate_rect"):
                rect = original[rect_field]
                if rect is not None:
                    if not isinstance(rect, dict) or set(rect) != {"x0", "y0", "x1", "y1"}:
                        raise BatchStoreError("snapshot original rectangle is invalid")
                    if any(
                        isinstance(rect[key], bool)
                        or not isinstance(rect[key], (int, float))
                        or not math.isfinite(float(rect[key]))
                        for key in rect
                    ):
                        raise BatchStoreError("snapshot original rectangle is invalid")
            if original["persistable"]:
                if (
                    page < 1
                    or original["page_width"] <= 0
                    or original["page_height"] <= 0
                    or not isinstance(original["match_rect"], dict)
                ):
                    raise BatchStoreError("persistable original geometry is invalid")
                width = float(original["page_width"])
                height = float(original["page_height"])
                match_rect = original["match_rect"]
                if not (
                    set(match_rect) == {"x0", "y0", "x1", "y1"}
                    and 0 <= match_rect["x0"] < match_rect["x1"] <= width
                    and 0 <= match_rect["y0"] < match_rect["y1"] <= height
                ):
                    raise BatchStoreError("persistable original geometry is invalid")
                candidate_rect = original["candidate_rect"]
                if candidate_rect is not None and not (
                    isinstance(candidate_rect, dict)
                    and set(candidate_rect) == {"x0", "y0", "x1", "y1"}
                    and 0 <= candidate_rect["x0"] < candidate_rect["x1"] <= width
                    and 0 <= candidate_rect["y0"] < candidate_rect["y1"] <= height
                ):
                    raise BatchStoreError("persistable original geometry is invalid")
            try:
                # Validate and detach one original at a time.  Cloning the
                # entire 50k-element manifest would hit the generic JSON
                # node budget even though each manifest entry is bounded.
                detached = clone_json(original, max_bytes=MAX_PAGE_RESULT_BYTES)
            except BatchModelError as exc:
                raise BatchStoreError(str(exc)) from None
            if not isinstance(detached, dict):
                raise BatchStoreError("snapshot original is invalid")
            ids.add(identifier)
            logical.add(key)
            result.append(detached)
        return result

    @staticmethod
    def _snapshot_rect(
        value: object,
        field: str,
        *,
        width: float,
        height: float,
        required: bool = False,
        bounded: bool = False,
    ) -> dict[str, object] | None:
        if value is None:
            if required:
                raise BatchStoreError(f"{field} is required")
            return None
        if not isinstance(value, dict) or set(value) != {"x0", "y0", "x1", "y1"}:
            raise BatchStoreError(f"{field} is invalid")
        coordinates: dict[str, float] = {}
        for edge in ("x0", "y0", "x1", "y1"):
            number = value[edge]
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(float(number)):
                raise BatchStoreError(f"{field} is invalid")
            coordinates[edge] = float(number)
        if not (
            0 <= coordinates["x0"] < coordinates["x1"]
            and 0 <= coordinates["y0"] < coordinates["y1"]
        ):
            raise BatchStoreError(f"{field} is invalid")
        if bounded and not (
            coordinates["x1"] <= width and coordinates["y1"] <= height
        ):
            raise BatchStoreError(f"{field} is outside the page")
        return value

    @staticmethod
    def _validate_snapshot_segment(
        segment: object,
        original: Mapping[str, object],
        source: sqlite3.Row,
    ) -> dict[str, object]:
        if not isinstance(segment, dict) or set(segment) != _SNAPSHOT_SEGMENT_FIELDS:
            raise BatchStoreError("snapshot item segment fields are incomplete")
        if (
            segment["id"] != original["id"]
            or segment["source_key"] != original["source_key"]
            or segment["source_page"] != original["source_page"]
            or segment["segment_no"] != original["segment_no"]
        ):
            raise BatchStoreError("snapshot item segment identity is invalid")
        if not isinstance(segment["source_key"], str) or segment["source_key"] != source["source_key"]:
            raise BatchStoreError("snapshot item segment source is invalid")
        source_path = segment["source_path"]
        if not isinstance(source_path, str) or (
            source_path.strip() not in {source["initial_path"], source["access_path"]}
            and _source_key(source_path) != source["source_key"]
        ):
            raise BatchStoreError("snapshot item segment source path is invalid")
        try:
            segment_sha = _sha(segment["source_sha256"], "segment.source_sha256")
        except BatchStoreError:
            raise BatchStoreError("snapshot item segment source checksum is invalid") from None
        if segment_sha != str(source["sha256"]).lower():
            raise BatchStoreError("snapshot item segment source checksum is invalid")
        page = _integer(segment["source_page"], "segment.source_page", minimum=1)
        if source["page_count"] is not None and page > source["page_count"]:
            raise BatchStoreError("snapshot item segment page is outside its source")
        _integer(segment["segment_no"], "segment.segment_no", minimum=1)

        width = segment["page_width"]
        height = segment["page_height"]
        confidence = segment["confidence"]
        for value, field in ((width, "segment.page_width"), (height, "segment.page_height"), (confidence, "segment.confidence")):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                raise BatchStoreError(f"{field} is invalid")
        width_float = float(width)
        height_float = float(height)
        if width_float <= 0 or height_float <= 0 or not 0 <= float(confidence) <= 1:
            raise BatchStoreError("snapshot item segment numeric field is invalid")
        if (
            width != original["page_width"]
            or height != original["page_height"]
            or confidence != original["confidence"]
            or segment["match_rect"] != original["match_rect"]
            or segment["candidate_rect"] != original["candidate_rect"]
            or segment["layout_fingerprint"] != original["layout_fingerprint"]
        ):
            raise BatchStoreError("snapshot item segment geometry is inconsistent with original")
        bounded = bool(original["persistable"])
        BatchStore._snapshot_rect(
            segment["match_rect"], "segment.match_rect", width=width_float, height=height_float,
            required=True, bounded=bounded,
        )
        candidate_rect = BatchStore._snapshot_rect(
            segment["candidate_rect"], "segment.candidate_rect", width=width_float, height=height_float,
            bounded=bounded,
        )
        final_rect = BatchStore._snapshot_rect(
            segment["final_rect"], "segment.final_rect", width=width_float, height=height_float,
            bounded=bounded,
        )
        crop_mode = segment["crop_mode"]
        if crop_mode not in {"candidate", "full_page"}:
            raise BatchStoreError("snapshot item segment crop mode is invalid")
        if (crop_mode == "full_page") != bool(original["auto_full_page"]):
            raise BatchStoreError("snapshot item segment crop mode disagrees with original")
        if crop_mode == "full_page":
            if final_rect is not None:
                raise BatchStoreError("full-page snapshot item cannot have a final rectangle")
        elif final_rect != candidate_rect:
            raise BatchStoreError("snapshot item final rectangle disagrees with candidate")
        slot = segment["slot"]
        if slot is not None:
            _text(slot, "segment.slot", max_bytes=MAX_LAYOUT_TEXT_BYTES)
        snap_points = segment["snap_points"]
        if not isinstance(snap_points, list) or len(snap_points) > 4_096:
            raise BatchStoreError("snapshot item snap points are invalid")
        for point in snap_points:
            if isinstance(point, bool) or not isinstance(point, (int, float)) or not math.isfinite(float(point)):
                raise BatchStoreError("snapshot item snap points are invalid")
            if not 0 <= float(point) <= height_float:
                raise BatchStoreError("snapshot item snap points are invalid")
        _text(segment["layout_fingerprint"], "segment.layout_fingerprint", max_bytes=MAX_IDENTIFIER_BYTES)
        if segment["review_status"] not in {"blocked", "needs_review", "confirmed"}:
            raise BatchStoreError("snapshot item review status is invalid")
        if segment["manual_adjusted"] is not False:
            raise BatchStoreError("snapshot item manual-adjusted flag is invalid")
        return segment

    @staticmethod
    def _validate_snapshot_evidence(
        evidence: object,
        page: int,
        match_rect: Mapping[str, object],
    ) -> list[dict[str, object]]:
        if not isinstance(evidence, list) or not evidence or len(evidence) > BUDGET_LIMITS["matches"]:
            raise BatchStoreError("snapshot item evidence is incomplete")
        allowed = _SNAPSHOT_MATCH_REQUIRED_FIELDS | _SNAPSHOT_MATCH_OPTIONAL_FIELDS
        matches: list[dict[str, object]] = []
        has_representative = False
        for hit in evidence:
            if not isinstance(hit, dict) or not _SNAPSHOT_MATCH_REQUIRED_FIELDS.issubset(hit) or not set(hit) <= allowed:
                raise BatchStoreError("snapshot item evidence fields are invalid")
            if _integer(hit["page"], "evidence.page", minimum=1) != page:
                raise BatchStoreError("snapshot item evidence page is invalid")
            _text(hit["matched_text"], "evidence.matched_text", max_bytes=MAX_MATCH_TEXT_BYTES, strip=False)
            matched_field = hit["matched_field"]
            if matched_field is not None:
                _text(matched_field, "evidence.matched_field", max_bytes=MAX_LAYOUT_TEXT_BYTES, strip=False)
            confidence = hit["confidence"]
            if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not math.isfinite(float(confidence)):
                raise BatchStoreError("snapshot item evidence confidence is invalid")
            if not 0 <= float(confidence) <= 1:
                raise BatchStoreError("snapshot item evidence confidence is invalid")
            coordinates = {edge: hit[edge] for edge in ("x0", "y0", "x1", "y1")}
            BatchStore._snapshot_rect(coordinates, "evidence.rectangle", width=float("inf"), height=float("inf"), required=True)
            if "needs_review" in hit and not isinstance(hit["needs_review"], bool):
                raise BatchStoreError("snapshot item evidence needs_review is invalid")
            has_query = "query_id" in hit
            has_role = "role" in hit
            if has_query != has_role:
                raise BatchStoreError("snapshot item evidence query fields are incomplete")
            if has_query:
                query_id = _text(hit["query_id"], "evidence.query_id", max_bytes=MAX_IDENTIFIER_BYTES)
                role = hit["role"]
                if role not in {"include", "exclude"}:
                    raise BatchStoreError("snapshot item evidence role is invalid")
                if (
                    (query_id.startswith("include-") and role != "include")
                    or (query_id.startswith("exclude-") and role != "exclude")
                ):
                    raise BatchStoreError("snapshot item evidence query role is invalid")
            if all(coordinates[edge] == match_rect[edge] for edge in ("x0", "y0", "x1", "y1")):
                has_representative = True
            matches.append(hit)
        if not has_representative:
            raise BatchStoreError("snapshot item evidence does not match segment geometry")
        return matches

    @staticmethod
    def _validate_snapshot_items(
        items: object,
        originals: Sequence[Mapping[str, object]],
        sources: Sequence[sqlite3.Row],
    ) -> Iterator[tuple[int, dict[str, object], bytes]]:
        if not isinstance(items, list) or len(items) != len(originals) or len(items) > 50_000:
            raise BatchStoreError("snapshot items are incomplete")
        source_by_key = {str(row["source_key"]): row for row in sources}
        seen_ids: set[str] = set()
        for index, (item, original) in enumerate(zip(items, originals, strict=True)):
            if not isinstance(item, dict) or set(item) != {"segment", "evidence", "original"}:
                raise BatchStoreError("snapshot item wrapper is invalid")
            if item["original"] != original:
                raise BatchStoreError("snapshot item original does not match manifest")
            segment = item["segment"]
            source = source_by_key.get(str(original["source_key"]))
            if source is None:
                raise BatchStoreError("snapshot item source is invalid")
            validated_segment = BatchStore._validate_snapshot_segment(segment, original, source)
            validated_evidence = BatchStore._validate_snapshot_evidence(
                item["evidence"], int(original["source_page"]), validated_segment["match_rect"]
            )
            identifier = _text(validated_segment["id"], "item.id", max_bytes=MAX_IDENTIFIER_BYTES)
            if identifier in seen_ids:
                raise BatchStoreError("snapshot items contain duplicate ids")
            seen_ids.add(identifier)
            detached = {
                "segment": validated_segment,
                "evidence": validated_evidence,
                "original": original,
            }
            try:
                # Detach and canonicalize one row at a time.  This keeps the
                # generic JSON node limit applicable to each item while the
                # snapshot collection itself is bounded by count/bytes.
                detached = clone_json(detached, max_bytes=MAX_PAGE_RESULT_BYTES)
                if not isinstance(detached, dict):
                    raise BatchStoreError("snapshot item is invalid")
                payload = canonical_json(detached, max_bytes=MAX_PAGE_RESULT_BYTES)
            except BatchModelError as exc:
                raise BatchStoreError(str(exc)) from None
            yield index, detached, payload

    def _assert_complete_pages(self, connection: sqlite3.Connection, job_id: str) -> None:
        rows = connection.execute(
            """
            SELECT p.source_id, p.page, p.state, r.payload_json, r.sha256
              FROM batch_pages p
              LEFT JOIN batch_page_results r
                ON r.job_id = p.job_id AND r.source_id = p.source_id
               AND r.page = p.page AND r.stage = p.stage
             WHERE p.job_id = ?
            """,
            (job_id,),
        ).fetchall()
        for row in rows:
            if row["state"] != "succeeded":
                raise BatchConflict("all source pages must succeed before publication")
            if row["payload_json"] is None:
                raise BatchConflict("succeeded page has no result")
            try:
                parsed = validate_page_result(json.loads(row["payload_json"]))
                if parsed["page"] != row["page"]:
                    raise BatchModelError("stored page result page does not match its row")
                digest = hashlib.sha256(canonical_json(parsed, max_bytes=MAX_PAGE_RESULT_BYTES)).hexdigest()
            except (json.JSONDecodeError, BatchModelError) as exc:
                raise BatchConflict("stored page result is invalid") from exc
            if digest != row["sha256"]:
                raise BatchConflict("stored page result checksum is invalid")

    def publish_snapshot(
        self,
        job_id: object,
        generation: object,
        owner: object,
        context: object,
        originals: object,
        items: object,
    ) -> dict[str, object]:
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        owner_nonce = _text(owner, "owner", max_bytes=MAX_IDENTIFIER_BYTES)
        with self._transaction() as connection:
            job = self._job_row(connection, identifier)
            self._assert_owner_generation(connection, job, generation, owner_nonce)
            if job["state"] != "finalizing":
                raise BatchConflict("snapshot can only be published from finalizing")
            if bool(job["deletion_pending"]):
                raise BatchConflict("job deletion is pending")
            sources = list(connection.execute(
                "SELECT * FROM batch_sources WHERE job_id = ? ORDER BY position ASC",
                (identifier,),
            ))
            if len(sources) == 0 or any(
                source["sha256"] is None or source["page_count"] is None or source["verified_generation"] != job["generation"]
                for source in sources
            ):
                raise BatchConflict("all sources require final generation verification")
            self._assert_complete_pages(connection, identifier)
            validated_context = self._validate_context(context, sources, job)
            validated_originals = self._validate_originals(originals, sources)
            source_summary = [
                {
                    "source_id": source["source_id"],
                    "position": source["position"],
                    "source_key": source["source_key"],
                    "initial_path": source["initial_path"],
                    "access_path": source["access_path"],
                    "name": source["name"],
                    "sha256": source["sha256"],
                    "size_bytes": source["size_bytes"],
                    "page_count": source["page_count"],
                }
                for source in sources
            ]
            context_json = canonical_json(validated_context).decode("utf-8")
            source_summary_json = canonical_json(source_summary).decode("utf-8")
            originals_digest = hashlib.sha256()
            for original in validated_originals:
                originals_digest.update(canonical_json(original, max_bytes=MAX_PAGE_RESULT_BYTES))
            # Stream items through the transaction: each row has its own JSON
            # validation/canonicalization budget, while the collection is
            # bounded by count, cumulative bytes, and the database quota.
            base_usage = self._storage_size()
            static_bytes = (
                len(context_json.encode("utf-8"))
                + len(source_summary_json.encode("utf-8"))
                + 16_384
            )
            if base_usage + static_bytes > self.quota_bytes:
                raise BatchCapacityExceeded("batch storage quota exceeded")
            revision = str(uuid4())
            now = _utc_now()
            connection.execute(
                """
                INSERT INTO batch_snapshots (
                    job_id, result_revision, schema, source_summary_json,
                    context_json, originals_count, originals_digest,
                    source_count, item_count, created_at
                ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identifier,
                    revision,
                    source_summary_json,
                    context_json,
                    len(validated_originals),
                    originals_digest.hexdigest(),
                    len(sources),
                    len(items) if isinstance(items, list) else 0,
                    now,
                ),
            )
            item_bytes = 0
            item_count = 0
            for position, item, payload in self._validate_snapshot_items(items, validated_originals, sources):
                item_count += 1
                item_bytes += len(payload)
                if base_usage + static_bytes + item_bytes + item_count * 1_024 > self.quota_bytes:
                    raise BatchCapacityExceeded("batch storage quota exceeded")
                segment = item["segment"]
                connection.execute(
                    """
                    INSERT INTO batch_snapshot_items (
                        job_id, result_revision, position, item_id, source_key, payload_json
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        identifier,
                        revision,
                        position,
                        segment["id"],
                        segment["source_key"],
                        payload.decode("utf-8"),
                    ),
                )
            if item_count != len(validated_originals):
                raise BatchStoreError("snapshot items are incomplete")
            connection.execute(
                """
                UPDATE batch_jobs
                   SET state = 'ready_for_review', result_revision = ?, updated_at = ?
                 WHERE id = ? AND generation = ? AND owner = ? AND state = 'finalizing'
                """,
                (revision, now, identifier, job["generation"], owner_nonce),
            )
            if connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise BatchConflict("job changed while publishing")
            return {
                "job_id": identifier,
                "generation": int(job["generation"]),
                "result_revision": revision,
                "count": item_count,
                "state": "ready_for_review",
            }

    def results_page(
        self,
        job_id: object,
        result_revision: object,
        offset: object = 0,
        limit: object = MAX_RESULTS_PAGE_ITEMS,
    ) -> dict[str, object]:
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        revision = _text(result_revision, "result_revision", max_bytes=MAX_IDENTIFIER_BYTES)
        start = _integer(offset, "offset")
        page_size = _integer(limit, "limit", minimum=1)
        if page_size > MAX_RESULTS_PAGE_ITEMS:
            raise _error("limit", "cannot exceed 200")
        job = self._job_row(self.connection, identifier)
        if job["state"] not in {"ready_for_review", "archived"} or job["result_revision"] != revision or job["deletion_pending"]:
            raise BatchConflict("result revision is stale or unpublished")
        snapshot = self.connection.execute(
            "SELECT item_count FROM batch_snapshots WHERE job_id = ? AND result_revision = ?",
            (identifier, revision),
        ).fetchone()
        if snapshot is None:
            raise BatchStoreError("published snapshot is missing")
        total = int(snapshot["item_count"])
        if start > total:
            raise _error("offset", "is beyond the result set")
        rows = self.connection.execute(
            """
            SELECT position, payload_json FROM batch_snapshot_items
             WHERE job_id = ? AND result_revision = ?
             ORDER BY position ASC LIMIT ? OFFSET ?
            """,
            (identifier, revision, page_size, start),
        ).fetchall()
        if start + len(rows) < total and len(rows) < page_size:
            raise BatchStoreError("published snapshot items are incomplete")
        if start + len(rows) > total:
            raise BatchStoreError("published snapshot item count is invalid")
        items: list[dict[str, object]] = []
        item_bytes = 0
        for index, row in enumerate(rows):
            if row["position"] != start + index:
                raise BatchStoreError("published snapshot item positions are incomplete")
            parsed = _decode_json(row["payload_json"], "snapshot.item")
            if not isinstance(parsed, dict):
                raise BatchStoreError("stored snapshot item is invalid")
            encoded = canonical_json(parsed, max_bytes=MAX_PAGE_RESULT_BYTES)
            count = len(items) + 1
            envelope = {
                "result_revision": revision,
                "offset": start,
                "limit": page_size,
                "total": total,
                "next_offset": start + count if start + count < total else None,
                "items": [],
            }
            # Each item has already passed the bounded JSON validator. Charge
            # exact canonical envelope + item bytes + commas, without applying
            # a single-item node budget to a legal collection of 200 items.
            encoded_size = len(canonical_json(envelope)) + item_bytes + len(encoded) + count - 1
            if encoded_size > MAX_RESULTS_PAGE_BYTES:
                if not items:
                    raise BatchCapacityExceeded("one snapshot item exceeds the 4 MiB page limit")
                break
            item_bytes += len(encoded)
            items.append(parsed)
        next_offset = start + len(items) if start + len(items) < total else None
        return {
            "result_revision": revision,
            "offset": start,
            "limit": page_size,
            "total": total,
            "next_offset": next_offset,
            "items": items,
        }

    def review_snapshot(self, job_id: object, result_revision: object) -> dict[str, object]:
        """Read the authoritative original manifest, never one supplied by UI.

        A read transaction gives a consistent view without blocking a worker
        writing another job in WAL mode. The caller re-verifies every current
        access path before binding these originals into the review store.
        """
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        revision = _text(result_revision, "result_revision", max_bytes=MAX_IDENTIFIER_BYTES)
        with self._transaction(immediate=False) as connection:
            job = self._job_row(connection, identifier)
            if job["state"] not in {"ready_for_review", "archived"} or job["result_revision"] != revision or job["deletion_pending"]:
                raise BatchConflict("review snapshot is unavailable")
            header = connection.execute(
                "SELECT * FROM batch_snapshots WHERE job_id = ? AND result_revision = ?", (identifier, revision),
            ).fetchone()
            if header is None or header["schema"] != 1 or not 0 <= header["item_count"] <= 50_000:
                raise BatchStoreError("review snapshot metadata is invalid")
            sources = list(connection.execute("SELECT * FROM batch_sources WHERE job_id = ? ORDER BY position", (identifier,)))
            context = _decode_json(header["context_json"], "snapshot.context")
            if not isinstance(context, dict) or not isinstance(context.get("sources"), list) or len(context["sources"]) != len(sources):
                raise BatchStoreError("review snapshot sources are incomplete")
            for declared, current in zip(context["sources"], sources, strict=True):
                if not isinstance(declared, dict) or set(declared) != {"source_key", "source_path", "source_sha256"}:
                    raise BatchStoreError("review snapshot source is invalid")
                _text(declared["source_path"], "source_path", max_bytes=MAX_PATH_BYTES)
                # Old access spelling is not part of logical identity. A
                # second relocation must not revive or try reading that path.
                declared["source_path"] = current["access_path"]
            context = self._validate_context(context, sources, job)
            originals = []
            digest = hashlib.sha256()
            for position, row in enumerate(connection.execute(
                "SELECT position, payload_json FROM batch_snapshot_items WHERE job_id = ? AND result_revision = ? ORDER BY position",
                (identifier, revision),
            )):
                if position >= header["item_count"] or row["position"] != position:
                    raise BatchStoreError("review snapshot positions are incomplete")
                item = _decode_json(row["payload_json"], "snapshot.item")
                if not isinstance(item, dict) or not isinstance(item.get("original"), dict):
                    raise BatchStoreError("review snapshot original is missing")
                original = item["original"]
                digest.update(canonical_json(original, max_bytes=MAX_PAGE_RESULT_BYTES))
                originals.append(original)
            if len(originals) != header["item_count"] or len(originals) != header["originals_count"] or digest.hexdigest() != header["originals_digest"]:
                raise BatchStoreError("review snapshot original digest is invalid")
            return {"job": self._job_snapshot_connection(connection, job), "context": context,
                    "originals": self._validate_originals(originals, sources)}

    @contextmanager
    def hold_review_binding(self, expected_job: dict[str, object]):
        """Keep relocation/deletion behind the short cross-store review bind.

        File hashing must finish before entering this transaction. The review
        store always takes its transaction second, preserving a fixed lock order.
        """
        with self._transaction() as connection:
            job = self._job_row(connection, expected_job["id"])
            if self._job_snapshot_connection(connection, job) != expected_job:
                raise BatchConflict("batch changed during review preparation")
            yield

    def control(
        self,
        job_id: object,
        generation: object,
        command_id: object,
        action: object,
    ) -> dict[str, object]:
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        expected_generation = _integer(generation, "generation")
        command = _text(command_id, "command_id", max_bytes=MAX_IDENTIFIER_BYTES)
        operation = str(_value(action))
        if operation not in {"pause", "cancel", "archive"}:
            raise _error("action", "must be pause, cancel, or archive")
        with self._transaction() as connection:
            job = self._job_row(connection, identifier)
            if job["deletion_pending"]:
                raise BatchConflict("job cleanup is pending")
            if job["generation"] != expected_generation:
                raise BatchConflict("control generation is stale")
            existing = connection.execute(
                "SELECT action, response_json FROM batch_commands WHERE job_id = ? AND generation = ? AND command_id = ?",
                (identifier, expected_generation, command),
            ).fetchone()
            if existing is not None:
                if existing["action"] != operation:
                    raise BatchConflict("command id was already used for another action")
                decoded = _decode_json(existing["response_json"], "command.response")
                if not isinstance(decoded, dict):
                    raise BatchStoreError("stored command response is invalid")
                return decoded
            count = int(connection.execute(
                "SELECT COUNT(*) FROM batch_commands WHERE job_id = ? AND generation = ?",
                (identifier, expected_generation),
            ).fetchone()[0])
            current = str(job["state"])
            status = "ok"
            next_state = current
            persist_command = True
            if operation == "pause":
                if current == "ready_for_review":
                    status = "already_completed"
                elif current in {"paused", "pause_requested"}:
                    next_state = current
                elif current in {"queued", "validating"}:
                    next_state = "paused"
                elif current in {"running", "finalizing"}:
                    next_state = "pause_requested"
                elif current in {"partial_failed", "blocked"}:
                    next_state = "paused"
                elif current in {"cancel_requested", "cancelled", "interrupted", "archived"}:
                    raise BatchConflict(f"cannot pause job in state {current}")
            elif operation == "cancel":
                if current in {"ready_for_review", "archived"}:
                    status = "already_completed"
                elif current in {"cancel_requested", "cancelled"}:
                    next_state = current
                elif current in _WORKER_CANCEL_STATES:
                    next_state = "cancel_requested"
                elif current in _IDLE_CANCEL_STATES:
                    next_state = "cancelled"
                else:
                    raise BatchConflict(f"cannot cancel job in state {current}")
            else:
                if current == "ready_for_review":
                    next_state = "archived"
                elif current == "archived":
                    status = "already_archived"
                else:
                    raise BatchConflict("only a ready snapshot can be archived")

            if operation == "cancel":
                if count >= MAX_COMMANDS_PER_JOB:
                    # The state itself is the durable cancellation marker when
                    # an old/full command history has no reserved row left.
                    # Never let a command quota prevent cancellation or add
                    # unbounded history.
                    persist_command = False
            elif count >= max(MAX_COMMANDS_PER_JOB - 1, 0):
                # Keep one command slot available for cancellation, including
                # when tests or a future deployment set the limit to one.
                raise BatchCapacityExceeded("too many control commands for this job")
            now = _utc_now()
            if next_state != current:
                connection.execute(
                    "UPDATE batch_jobs SET state = ?, updated_at = ? WHERE id = ? AND generation = ? AND state = ?",
                    (next_state, now, identifier, expected_generation, current),
                )
                if connection.execute("SELECT changes()").fetchone()[0] != 1:
                    raise BatchConflict("job changed during control")
            response = {
                "status": status,
                "job_id": identifier,
                "generation": expected_generation,
                "command_id": command,
                "action": operation,
                "state": next_state,
            }
            if not persist_command:
                return response
            response_json = canonical_json(response).decode("utf-8")
            connection.execute(
                """
                INSERT INTO batch_commands (
                    job_id, generation, command_id, action, input_json, response_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identifier,
                    expected_generation,
                    command,
                    operation,
                    canonical_json({"action": operation}).decode("utf-8"),
                    response_json,
                    now,
                ),
            )
            return response

    def finish_stop(
        self,
        job_id: object,
        generation: object,
        owner: object,
        cancelled: object = True,
    ) -> dict[str, object]:
        if not isinstance(cancelled, bool):
            raise _error("cancelled", "must be a boolean")
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        with self._transaction() as connection:
            job = self._job_row(connection, identifier)
            owner_nonce = self._assert_owner_generation(connection, job, generation, owner)
            if job["state"] not in _EXECUTION_STATES:
                raise BatchConflict(f"job cannot stop from state {job['state']}")
            connection.execute(
                """
                UPDATE batch_pages
                   SET state = 'pending', owner = NULL
                 WHERE job_id = ? AND state = 'processing' AND owner = ? AND generation = ?
                """,
                (identifier, owner_nonce, job["generation"]),
            )
            # Cancellation can commit after the host's pre-stop snapshot.
            # Resolve the winner under this same transaction, never from a
            # stale boolean sent before the durable cancel request existed.
            target = "cancelled" if cancelled or job["state"] == "cancel_requested" else "interrupted"
            now = _utc_now()
            connection.execute(
                """
                UPDATE batch_jobs
                   SET state = ?, owner = NULL, resume_target = NULL, updated_at = ?
                 WHERE id = ? AND generation = ? AND owner = ?
                """,
                (target, now, identifier, job["generation"], owner_nonce),
            )
            if connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise BatchConflict("job changed while stopping")
            return self._job_snapshot_connection(connection, self._job_row(connection, identifier))

    def relocate_source(
        self,
        job_id: object,
        source_id: object,
        new_path: object,
        verified_sha256: object | None = None,
        size_bytes: object | None = None,
        *,
        sha256: object | None = None,
    ) -> dict[str, object]:
        if verified_sha256 is None:
            verified_sha256 = sha256
        identifier = _text(job_id, "job_id", max_bytes=MAX_IDENTIFIER_BYTES)
        source_identifier = _text(source_id, "source_id", max_bytes=MAX_IDENTIFIER_BYTES)
        path = _text(new_path, "new_path", max_bytes=MAX_PATH_BYTES)
        digest = _sha(verified_sha256, "verified_sha256")
        with self._transaction() as connection:
            job = self._job_row(connection, identifier)
            if job["deletion_pending"] or job["state"] in _ACTIVE_START_STATES:
                raise BatchConflict("source cannot be relocated while the job is executing")
            source = self._source_row(connection, identifier, source_identifier)
            if source["sha256"] is None or source["sha256"].lower() != digest:
                raise BatchConflict("relocated file SHA-256 does not match the source")
            if size_bytes is not None and _integer(size_bytes, "size_bytes") != source["size_bytes"]:
                raise BatchConflict("relocated file size does not match the source")
            connection.execute(
                """
                UPDATE batch_sources
                   SET access_path = ?, state = 'registered', error_json = NULL,
                       verified_generation = NULL
                 WHERE job_id = ? AND source_id = ? AND sha256 = ?
                """,
                (path, identifier, source_identifier, digest),
            )
            return self._job_snapshot_connection(connection, self._job_row(connection, identifier))


__all__ = [
    "BatchCapacityExceeded",
    "BatchComputationChanged",
    "BatchConflict",
    "BatchSchemaIncompatible",
    "BatchStore",
    "BatchStoreError",
    "DEFAULT_QUOTA_BYTES",
    "SCHEMA_VERSION",
]
