"""High-level persistence operations for PDF processing tasks.

The store is intentionally independent from the PDF/OCR implementation.  It
offers small page-oriented writes so a long-running task can be paused or
resumed without keeping the complete document in memory.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
from enum import Enum
import hashlib
from pathlib import Path
import sqlite3
from typing import Iterable, Iterator, Sequence
from uuid import uuid4

from .db import Database, new_id
from .models import (
    CropMode,
    CropRegion,
    ExportRecord,
    LayoutGroup,
    Match,
    Page,
    PageStatus,
    ReviewStatus,
    SourceFile,
    Task,
    TaskLog,
    TaskStatus,
    TextBlock,
    utc_now,
)


class InvalidTaskTransition(ValueError):
    """Raised when a task is asked to move to an invalid lifecycle state."""


_TASK_TRANSITIONS: dict[TaskStatus, set[TaskStatus]] = {
    TaskStatus.PENDING: {TaskStatus.PARSING, TaskStatus.CANCELLED},
    TaskStatus.PARSING: {
        TaskStatus.OCR,
        TaskStatus.SEARCHING,
        TaskStatus.PAUSED,
        TaskStatus.FAILED,
        TaskStatus.PARTIAL_FAILED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.OCR: {
        TaskStatus.SEARCHING,
        TaskStatus.PAUSED,
        TaskStatus.FAILED,
        TaskStatus.PARTIAL_FAILED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.SEARCHING: {
        TaskStatus.REVIEW,
        TaskStatus.PAUSED,
        TaskStatus.FAILED,
        TaskStatus.PARTIAL_FAILED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.REVIEW: {
        TaskStatus.EXPORTING,
        TaskStatus.PAUSED,
        TaskStatus.FAILED,
        TaskStatus.PARTIAL_FAILED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.EXPORTING: {
        TaskStatus.COMPLETED,
        TaskStatus.PARTIAL_FAILED,
        TaskStatus.FAILED,
        TaskStatus.PAUSED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.PARTIAL_FAILED: {
        TaskStatus.REVIEW,
        TaskStatus.EXPORTING,
        TaskStatus.COMPLETED,
        TaskStatus.FAILED,
        TaskStatus.PAUSED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.FAILED: {
        TaskStatus.PENDING,
        TaskStatus.PARSING,
        TaskStatus.OCR,
        TaskStatus.SEARCHING,
        TaskStatus.REVIEW,
        TaskStatus.EXPORTING,
        TaskStatus.CANCELLED,
    },
    TaskStatus.PAUSED: {
        TaskStatus.PENDING,
        TaskStatus.PARSING,
        TaskStatus.OCR,
        TaskStatus.SEARCHING,
        TaskStatus.REVIEW,
        TaskStatus.EXPORTING,
        TaskStatus.FAILED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.COMPLETED: set(),
    TaskStatus.CANCELLED: {TaskStatus.PENDING},
}


def _value(value: object) -> object:
    return value.value if isinstance(value, Enum) else value


def _as_enum(enum_type: type[Enum], value: str | Enum | None) -> object:
    if value is None:
        return None
    if isinstance(value, enum_type):
        return value
    try:
        return enum_type(value)
    except ValueError:
        # Forward compatibility: a newer database status should still be
        # readable by an older engine rather than making the whole task list
        # unusable.
        return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _modified_at(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(
        timespec="seconds"
    )


class TaskStore:
    """CRUD and checkpoint operations backed by :class:`sqlite3`."""

    def __init__(self, database: str | Path | Database = ":memory:") -> None:
        self.database = database if isinstance(database, Database) else Database(database)
        self.database.initialize()

    @property
    def connection(self) -> sqlite3.Connection:
        return self.database.connection

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Group multiple store writes into one atomic transaction."""

        with self.database.transaction() as connection:
            yield connection

    def close(self) -> None:
        self.database.close()

    def __enter__(self) -> "TaskStore":
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Row conversion helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _task_from_row(row: sqlite3.Row) -> Task:
        return Task(
            id=row["id"],
            name=row["name"],
            status=_as_enum(TaskStatus, row["status"]),
            output_dir=row["output_dir"],
            error_message=row["error_message"],
            status_before_pause=_as_enum(TaskStatus, row["status_before_pause"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _source_file_from_row(row: sqlite3.Row) -> SourceFile:
        return SourceFile(
            id=row["id"],
            task_id=row["task_id"],
            path=row["path"],
            filename=row["filename"],
            size_bytes=row["size_bytes"],
            modified_at=row["modified_at"],
            sha256=row["sha256"],
            page_count=row["page_count"],
            status=row["status"],
            error_message=row["error_message"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _page_from_row(row: sqlite3.Row) -> Page:
        return Page(
            id=row["id"],
            source_file_id=row["source_file_id"],
            page_number=row["page_number"],
            status=_as_enum(PageStatus, row["status"]),
            ocr_status=row["ocr_status"],
            error_message=row["error_message"],
            retry_count=row["retry_count"],
            started_at=row["started_at"],
            completed_at=row["completed_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _text_block_from_row(row: sqlite3.Row) -> TextBlock:
        return TextBlock(
            id=row["id"],
            page_id=row["page_id"],
            text=row["text"],
            x0=row["x0"],
            y0=row["y0"],
            x1=row["x1"],
            y1=row["y1"],
            confidence=row["confidence"],
            field=row["field"],
            block_index=row["block_index"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _match_from_row(row: sqlite3.Row) -> Match:
        return Match(
            id=row["id"],
            page_id=row["page_id"],
            query=row["query"],
            matched_text=row["matched_text"],
            matched_field=row["matched_field"],
            confidence=row["confidence"],
            x0=row["x0"],
            y0=row["y0"],
            x1=row["x1"],
            y1=row["y1"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _layout_group_from_row(row: sqlite3.Row) -> LayoutGroup:
        return LayoutGroup(
            id=row["id"],
            task_id=row["task_id"],
            fingerprint=row["fingerprint"],
            name=row["name"],
            confidence=row["confidence"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _crop_region_from_row(row: sqlite3.Row) -> CropRegion:
        return CropRegion(
            id=row["id"],
            page_id=row["page_id"],
            layout_group_id=row["layout_group_id"],
            x0=row["x0"],
            y0=row["y0"],
            x1=row["x1"],
            y1=row["y1"],
            confidence=row["confidence"],
            mode=_as_enum(CropMode, row["mode"]),
            review_status=_as_enum(ReviewStatus, row["review_status"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _export_from_row(row: sqlite3.Row) -> ExportRecord:
        return ExportRecord(
            id=row["id"],
            task_id=row["task_id"],
            output_path=row["output_path"],
            kind=row["kind"],
            status=row["status"],
            error_message=row["error_message"],
            created_at=row["created_at"],
            completed_at=row["completed_at"],
        )

    @staticmethod
    def _task_log_from_row(row: sqlite3.Row) -> TaskLog:
        return TaskLog(
            id=row["id"],
            task_id=row["task_id"],
            page_id=row["page_id"],
            level=row["level"],
            message=row["message"],
            created_at=row["created_at"],
        )

    # ------------------------------------------------------------------
    # Tasks
    # ------------------------------------------------------------------
    def create_task(
        self,
        name: str,
        *,
        output_dir: str | Path | None = None,
        task_id: str | None = None,
    ) -> Task:
        if not name or not name.strip():
            raise ValueError("task name must not be empty")
        now = utc_now()
        task = Task(
            id=task_id or new_id("task"),
            name=name.strip(),
            output_dir=str(output_dir) if output_dir is not None else None,
            created_at=now,
            updated_at=now,
        )
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO tasks
                    (id, name, status, output_dir, error_message,
                     status_before_pause, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task.id,
                    task.name,
                    _value(task.status),
                    task.output_dir,
                    task.error_message,
                    _value(task.status_before_pause),
                    task.created_at,
                    task.updated_at,
                ),
            )
        return task

    def get_task(self, task_id: str) -> Task | None:
        row = self.connection.execute(
            "SELECT * FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        return self._task_from_row(row) if row is not None else None

    def list_tasks(self, status: TaskStatus | str | None = None) -> list[Task]:
        if status is None:
            rows = self.connection.execute(
                "SELECT * FROM tasks ORDER BY created_at DESC, id DESC"
            ).fetchall()
        else:
            rows = self.connection.execute(
                "SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC, id DESC",
                (_value(status),),
            ).fetchall()
        return [self._task_from_row(row) for row in rows]

    def transition_task(
        self,
        task_id: str,
        new_status: TaskStatus | str,
        *,
        error_message: str | None = None,
    ) -> Task:
        try:
            target = new_status if isinstance(new_status, TaskStatus) else TaskStatus(new_status)
        except ValueError as exc:
            raise ValueError(f"unknown task status: {new_status!r}") from exc

        with self.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"task not found: {task_id}")
            current = TaskStatus(row["status"])
            if current != target and target not in _TASK_TRANSITIONS.get(current, set()):
                raise InvalidTaskTransition(
                    f"cannot transition task {task_id} from {current.value} to {target.value}"
                )

            now = utc_now()
            if target is TaskStatus.PAUSED:
                # A repeated pause must retain the state that resume() will
                # restore instead of replacing it with ``paused``.
                previous = row["status_before_pause"] or (
                    current if current is not TaskStatus.PAUSED else None
                )
            else:
                previous = None
            connection.execute(
                """
                UPDATE tasks
                   SET status = ?, error_message = ?, status_before_pause = ?, updated_at = ?
                 WHERE id = ?
                """,
                (_value(target), error_message, _value(previous), now, task_id),
            )
            updated = connection.execute(
                "SELECT * FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
        return self._task_from_row(updated)

    def pause_task(self, task_id: str) -> Task:
        return self.transition_task(task_id, TaskStatus.PAUSED)

    def resume_task(self, task_id: str) -> Task:
        task = self.get_task(task_id)
        if task is None:
            raise KeyError(f"task not found: {task_id}")
        if task.status is not TaskStatus.PAUSED:
            raise InvalidTaskTransition(f"task {task_id} is not paused")
        target = task.status_before_pause or TaskStatus.PENDING
        return self.transition_task(task_id, target)

    def cancel_task(self, task_id: str) -> Task:
        return self.transition_task(task_id, TaskStatus.CANCELLED)

    # ------------------------------------------------------------------
    # Source files and pages
    # ------------------------------------------------------------------
    def register_source_file(
        self,
        task_id: str,
        path: str | Path,
        *,
        filename: str | None = None,
        size_bytes: int | None = None,
        modified_at: str | None = None,
        sha256: str | None = None,
        page_count: int | None = None,
        status: str = "pending",
        error_message: str | None = None,
        source_file_id: str | None = None,
    ) -> SourceFile:
        source_path = Path(path)
        if sha256 is None:
            if not source_path.is_file():
                raise FileNotFoundError(source_path)
            sha256 = _sha256(source_path)
        if size_bytes is None and source_path.is_file():
            size_bytes = source_path.stat().st_size
        if modified_at is None and source_path.is_file():
            modified_at = _modified_at(source_path)
        now = utc_now()
        path_string = str(source_path)
        with self.transaction() as connection:
            existing = connection.execute(
                "SELECT * FROM source_files WHERE task_id = ? AND path = ?",
                (task_id, path_string),
            ).fetchone()
            if existing is None and sha256:
                duplicate = connection.execute(
                    "SELECT * FROM source_files WHERE task_id = ? AND sha256 = ? ORDER BY created_at, id LIMIT 1",
                    (task_id, sha256),
                ).fetchone()
                if duplicate is not None:
                    # Same bytes under another path are one logical input.
                    return self._source_file_from_row(duplicate)
            if existing is None:
                source_file = SourceFile(
                    id=source_file_id or new_id("source"),
                    task_id=task_id,
                    path=path_string,
                    filename=filename or source_path.name or path_string,
                    size_bytes=size_bytes,
                    modified_at=modified_at,
                    sha256=sha256,
                    page_count=page_count,
                    status=status,
                    error_message=error_message,
                    created_at=now,
                    updated_at=now,
                )
                connection.execute(
                    """
                    INSERT INTO source_files
                        (id, task_id, path, filename, size_bytes, modified_at, sha256,
                         page_count, status, error_message, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        source_file.id,
                        source_file.task_id,
                        source_file.path,
                        source_file.filename,
                        source_file.size_bytes,
                        source_file.modified_at,
                        source_file.sha256,
                        source_file.page_count,
                        source_file.status,
                        source_file.error_message,
                        source_file.created_at,
                        source_file.updated_at,
                    ),
                )
            else:
                connection.execute(
                    """
                    UPDATE source_files
                       SET filename = ?, size_bytes = ?, modified_at = ?, sha256 = ?,
                           page_count = COALESCE(?, page_count), status = ?,
                           error_message = ?, updated_at = ?
                     WHERE id = ?
                    """,
                    (
                        filename or existing["filename"],
                        size_bytes,
                        modified_at,
                        sha256,
                        page_count,
                        status,
                        error_message,
                        now,
                        existing["id"],
                    ),
                )
                source_file = self._source_file_from_row(
                    connection.execute(
                        "SELECT * FROM source_files WHERE id = ?", (existing["id"],)
                    ).fetchone()
                )
        return source_file

    def add_source_file(self, *args: object, **kwargs: object) -> SourceFile:
        """Alias for :meth:`register_source_file` used by import pipelines."""

        return self.register_source_file(*args, **kwargs)  # type: ignore[arg-type]

    def get_source_file(self, source_file_id: str) -> SourceFile | None:
        row = self.connection.execute(
            "SELECT * FROM source_files WHERE id = ?", (source_file_id,)
        ).fetchone()
        return self._source_file_from_row(row) if row is not None else None

    def list_source_files(self, task_id: str) -> list[SourceFile]:
        rows = self.connection.execute(
            "SELECT * FROM source_files WHERE task_id = ? ORDER BY created_at, id",
            (task_id,),
        ).fetchall()
        return [self._source_file_from_row(row) for row in rows]

    def source_file_changed(self, source_file_or_id: str | SourceFile) -> bool:
        """Check whether a registered source changed since task import.

        Stat metadata is checked first for speed; when it is unchanged we also
        compare SHA-256 so replacing a file while preserving its timestamp is
        detected before export.
        """

        source = source_file_or_id if isinstance(source_file_or_id, SourceFile) else self.get_source_file(source_file_or_id)
        if source is None:
            raise KeyError(f"source file not found: {source_file_or_id}")
        path = Path(source.path)
        if not path.is_file():
            return True
        stat = path.stat()
        if source.size_bytes is not None and stat.st_size != source.size_bytes:
            return True
        if source.modified_at is not None and _modified_at(path) != source.modified_at:
            return True
        return source.sha256 is not None and _sha256(path) != source.sha256

    def add_page(
        self,
        source_file_or_page: str | Page,
        page_number: int | None = None,
        *,
        page_id: str | None = None,
        status: PageStatus | str = PageStatus.PENDING,
        ocr_status: str = "not_started",
    ) -> Page:
        if isinstance(source_file_or_page, Page):
            page = source_file_or_page
        else:
            if page_number is None:
                raise TypeError("page_number is required")
            page = Page(
                id=page_id or new_id("page"),
                source_file_id=source_file_or_page,
                page_number=page_number,
                status=status if isinstance(status, PageStatus) else PageStatus(status),
                ocr_status=ocr_status,
            )
        if page.page_number < 1:
            raise ValueError("page_number must be positive")
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO pages
                    (id, source_file_id, page_number, status, ocr_status, error_message,
                     retry_count, started_at, completed_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    page.id,
                    page.source_file_id,
                    page.page_number,
                    _value(page.status),
                    page.ocr_status,
                    page.error_message,
                    page.retry_count,
                    page.started_at,
                    page.completed_at,
                    page.updated_at,
                ),
            )
        return page

    def add_pages(
        self,
        source_file_id: str,
        page_numbers: Iterable[int],
    ) -> list[Page]:
        pages: list[Page] = []
        with self.transaction():
            for page_number in page_numbers:
                pages.append(self.add_page(source_file_id, page_number))
        return pages

    def get_page(self, page_id: str) -> Page | None:
        row = self.connection.execute(
            "SELECT * FROM pages WHERE id = ?", (page_id,)
        ).fetchone()
        return self._page_from_row(row) if row is not None else None

    def list_pages(
        self,
        source_file_id: str | None = None,
        *,
        task_id: str | None = None,
        status: PageStatus | str | None = None,
    ) -> list[Page]:
        # Accepting a task id positionally is useful to queue consumers and is
        # unambiguous once source-file ids are checked against the database.
        if source_file_id is not None and task_id is None:
            source_exists = self.connection.execute(
                "SELECT 1 FROM source_files WHERE id = ?", (source_file_id,)
            ).fetchone()
            task_exists = self.connection.execute(
                "SELECT 1 FROM tasks WHERE id = ?", (source_file_id,)
            ).fetchone()
            if source_exists is None and task_exists is not None:
                task_id, source_file_id = source_file_id, None

        clauses: list[str] = []
        params: list[object] = []
        join = ""
        if source_file_id is not None:
            clauses.append("p.source_file_id = ?")
            params.append(source_file_id)
        if task_id is not None:
            join = " JOIN source_files sf ON sf.id = p.source_file_id"
            clauses.append("sf.task_id = ?")
            params.append(task_id)
        if status is not None:
            clauses.append("p.status = ?")
            params.append(_value(status))
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.connection.execute(
            f"SELECT p.* FROM pages p{join}{where} ORDER BY p.source_file_id, p.page_number",
            params,
        ).fetchall()
        return [self._page_from_row(row) for row in rows]

    def update_page_status(
        self,
        page_id: str,
        status: PageStatus | str,
        *,
        error_message: str | None = None,
        ocr_status: str | None = None,
    ) -> Page:
        try:
            target = status if isinstance(status, PageStatus) else PageStatus(status)
        except ValueError as exc:
            raise ValueError(f"unknown page status: {status!r}") from exc
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM pages WHERE id = ?", (page_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"page not found: {page_id}")
            now = utc_now()
            started_at = row["started_at"]
            completed_at = row["completed_at"]
            if target is PageStatus.PROCESSING and started_at is None:
                started_at = now
            if target is PageStatus.COMPLETED:
                completed_at = now
            if target in {PageStatus.PENDING, PageStatus.FAILED, PageStatus.SKIPPED}:
                completed_at = None
            connection.execute(
                """
                UPDATE pages
                   SET status = ?, error_message = ?, ocr_status = COALESCE(?, ocr_status),
                       started_at = ?, completed_at = ?, updated_at = ?
                 WHERE id = ?
                """,
                (
                    _value(target),
                    error_message,
                    ocr_status,
                    started_at,
                    completed_at,
                    now,
                    page_id,
                ),
            )
            updated = connection.execute(
                "SELECT * FROM pages WHERE id = ?", (page_id,)
            ).fetchone()
        return self._page_from_row(updated)

    def claim_next_page(self, task_id: str) -> Page | None:
        """Atomically claim the next pending page for a task."""

        with self.transaction() as connection:
            row = connection.execute(
                """
                SELECT p.*
                  FROM pages p
                  JOIN source_files sf ON sf.id = p.source_file_id
                 WHERE sf.task_id = ? AND p.status = 'pending'
                 ORDER BY sf.created_at, sf.id, p.page_number
                 LIMIT 1
                """,
                (task_id,),
            ).fetchone()
            if row is None:
                return None
            now = utc_now()
            connection.execute(
                """
                UPDATE pages
                   SET status = 'processing', started_at = COALESCE(started_at, ?),
                       error_message = NULL, updated_at = ?
                 WHERE id = ? AND status = 'pending'
                """,
                (now, now, row["id"]),
            )
            claimed = connection.execute(
                "SELECT * FROM pages WHERE id = ?", (row["id"],)
            ).fetchone()
        return self._page_from_row(claimed)

    def mark_page_completed(self, page_id: str, *, ocr_status: str | None = None) -> Page:
        return self.update_page_status(
            page_id,
            PageStatus.COMPLETED,
            error_message=None,
            ocr_status=ocr_status,
        )

    def mark_page_failed(self, page_id: str, error_message: str) -> Page:
        if not error_message:
            raise ValueError("error_message must not be empty")
        return self.update_page_status(
            page_id, PageStatus.FAILED, error_message=error_message
        )

    def list_retryable_pages(
        self,
        task_id: str | None = None,
        *,
        source_file_id: str | None = None,
        max_retries: int | None = None,
    ) -> list[Page]:
        clauses = ["p.status = 'failed'"]
        params: list[object] = []
        join = ""
        if task_id is not None:
            join = " JOIN source_files sf ON sf.id = p.source_file_id"
            clauses.append("sf.task_id = ?")
            params.append(task_id)
        if source_file_id is not None:
            clauses.append("p.source_file_id = ?")
            params.append(source_file_id)
        if max_retries is not None:
            if max_retries < 0:
                raise ValueError("max_retries must not be negative")
            clauses.append("p.retry_count < ?")
            params.append(max_retries)
        rows = self.connection.execute(
            f"SELECT p.* FROM pages p{join} WHERE {' AND '.join(clauses)} "
            "ORDER BY p.source_file_id, p.page_number",
            params,
        ).fetchall()
        return [self._page_from_row(row) for row in rows]

    def get_failed_pages(self, task_id: str | None = None) -> list[Page]:
        return self.list_retryable_pages(task_id)

    def retry_page(self, page_id: str) -> Page:
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM pages WHERE id = ?", (page_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"page not found: {page_id}")
            if row["status"] != PageStatus.FAILED.value:
                raise ValueError(f"page {page_id} is not failed")
            now = utc_now()
            connection.execute(
                """
                UPDATE pages
                   SET status = 'pending', error_message = NULL, retry_count = retry_count + 1,
                       started_at = NULL, completed_at = NULL, updated_at = ?
                 WHERE id = ?
                """,
                (now, page_id),
            )
            updated = connection.execute(
                "SELECT * FROM pages WHERE id = ?", (page_id,)
            ).fetchone()
        return self._page_from_row(updated)

    def retry_failed_pages(
        self,
        task_id: str,
        *,
        page_ids: Sequence[str] | None = None,
    ) -> list[Page]:
        pages = self.list_retryable_pages(task_id)
        if page_ids is not None:
            requested = set(page_ids)
            pages = [page for page in pages if page.id in requested]
        with self.transaction():
            retried = [self.retry_page(page.id) for page in pages]
        return retried

    # ------------------------------------------------------------------
    # Text, matches and layout/crop records
    # ------------------------------------------------------------------
    def add_text_block(
        self,
        block_or_page_id: TextBlock | str,
        text: str | None = None,
        x0: float | None = None,
        y0: float | None = None,
        x1: float | None = None,
        y1: float | None = None,
        *,
        confidence: float = 1.0,
        field: str | None = None,
        block_index: int | None = None,
        block_id: str | None = None,
    ) -> TextBlock:
        if isinstance(block_or_page_id, TextBlock):
            block = block_or_page_id
        else:
            if text is None or None in {x0, y0, x1, y1}:
                raise TypeError("text and all four coordinates are required")
            block = TextBlock(
                id=block_id or new_id("block"),
                page_id=block_or_page_id,
                text=text,
                x0=float(x0),
                y0=float(y0),
                x1=float(x1),
                y1=float(y1),
                confidence=confidence,
                field=field,
                block_index=block_index,
            )
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO text_blocks
                    (id, page_id, text, x0, y0, x1, y1, confidence, field,
                     block_index, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    block.id,
                    block.page_id,
                    block.text,
                    block.x0,
                    block.y0,
                    block.x1,
                    block.y1,
                    block.confidence,
                    block.field,
                    block.block_index,
                    block.created_at,
                ),
            )
        return block

    def add_text_blocks(self, blocks: Iterable[TextBlock]) -> list[TextBlock]:
        created: list[TextBlock] = []
        with self.transaction():
            for block in blocks:
                created.append(self.add_text_block(block))
        return created

    def get_text_blocks(self, page_id: str) -> list[TextBlock]:
        rows = self.connection.execute(
            "SELECT * FROM text_blocks WHERE page_id = ? ORDER BY block_index, id",
            (page_id,),
        ).fetchall()
        return [self._text_block_from_row(row) for row in rows]

    list_text_blocks = get_text_blocks

    def add_match(
        self,
        match_or_page_id: Match | str,
        query: str | None = None,
        matched_text: str | None = None,
        *,
        matched_field: str | None = None,
        confidence: float = 1.0,
        x0: float | None = None,
        y0: float | None = None,
        x1: float | None = None,
        y1: float | None = None,
        match_id: str | None = None,
    ) -> Match:
        if isinstance(match_or_page_id, Match):
            match = match_or_page_id
        else:
            if query is None or matched_text is None:
                raise TypeError("query and matched_text are required")
            match = Match(
                id=match_id or new_id("match"),
                page_id=match_or_page_id,
                query=query,
                matched_text=matched_text,
                matched_field=matched_field,
                confidence=confidence,
                x0=x0,
                y0=y0,
                x1=x1,
                y1=y1,
            )
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO matches
                    (id, page_id, query, matched_text, matched_field, confidence,
                     x0, y0, x1, y1, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    match.id,
                    match.page_id,
                    match.query,
                    match.matched_text,
                    match.matched_field,
                    match.confidence,
                    match.x0,
                    match.y0,
                    match.x1,
                    match.y1,
                    match.created_at,
                ),
            )
        return match

    def add_matches(self, matches: Iterable[Match]) -> list[Match]:
        created: list[Match] = []
        with self.transaction():
            for match in matches:
                created.append(self.add_match(match))
        return created

    def get_matches(self, page_id: str) -> list[Match]:
        rows = self.connection.execute(
            "SELECT * FROM matches WHERE page_id = ? ORDER BY created_at, id",
            (page_id,),
        ).fetchall()
        return [self._match_from_row(row) for row in rows]

    list_matches = get_matches

    def add_layout_group(
        self,
        group_or_task_id: LayoutGroup | str,
        fingerprint: str | None = None,
        *,
        name: str | None = None,
        confidence: float | None = None,
        group_id: str | None = None,
    ) -> LayoutGroup:
        if isinstance(group_or_task_id, LayoutGroup):
            group = group_or_task_id
        else:
            if fingerprint is None:
                raise TypeError("fingerprint is required")
            now = utc_now()
            group = LayoutGroup(
                id=group_id or new_id("layout"),
                task_id=group_or_task_id,
                fingerprint=fingerprint,
                name=name,
                confidence=confidence,
                created_at=now,
                updated_at=now,
            )
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO layout_groups
                    (id, task_id, fingerprint, name, confidence, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    group.id,
                    group.task_id,
                    group.fingerprint,
                    group.name,
                    group.confidence,
                    group.created_at,
                    group.updated_at,
                ),
            )
        return group

    def get_layout_groups(self, task_id: str) -> list[LayoutGroup]:
        rows = self.connection.execute(
            "SELECT * FROM layout_groups WHERE task_id = ? ORDER BY created_at, id",
            (task_id,),
        ).fetchall()
        return [self._layout_group_from_row(row) for row in rows]

    list_layout_groups = get_layout_groups

    def add_crop_region(
        self,
        region_or_page_id: CropRegion | str,
        x0: float | None = None,
        y0: float | None = None,
        x1: float | None = None,
        y1: float | None = None,
        *,
        layout_group_id: str | None = None,
        confidence: float | None = None,
        mode: CropMode | str = CropMode.CANDIDATE,
        review_status: ReviewStatus | str = ReviewStatus.PENDING,
        region_id: str | None = None,
    ) -> CropRegion:
        if isinstance(region_or_page_id, CropRegion):
            region = region_or_page_id
        else:
            if None in {x0, y0, x1, y1}:
                raise TypeError("all four crop coordinates are required")
            region = CropRegion(
                id=region_id or new_id("crop"),
                page_id=region_or_page_id,
                x0=float(x0),
                y0=float(y0),
                x1=float(x1),
                y1=float(y1),
                layout_group_id=layout_group_id,
                confidence=confidence,
                mode=mode,
                review_status=review_status,
            )
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO crop_regions
                    (id, page_id, layout_group_id, x0, y0, x1, y1, confidence,
                     mode, review_status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    region.id,
                    region.page_id,
                    region.layout_group_id,
                    region.x0,
                    region.y0,
                    region.x1,
                    region.y1,
                    region.confidence,
                    _value(region.mode),
                    _value(region.review_status),
                    region.created_at,
                    region.updated_at,
                ),
            )
        return region

    def get_crop_regions(self, page_id: str) -> list[CropRegion]:
        rows = self.connection.execute(
            "SELECT * FROM crop_regions WHERE page_id = ? ORDER BY created_at, id",
            (page_id,),
        ).fetchall()
        return [self._crop_region_from_row(row) for row in rows]

    list_crop_regions = get_crop_regions

    def update_crop_region(
        self,
        region_id: str,
        *,
        x0: float | None = None,
        y0: float | None = None,
        x1: float | None = None,
        y1: float | None = None,
        layout_group_id: str | None = None,
        confidence: float | None = None,
        mode: CropMode | str | None = None,
        review_status: ReviewStatus | str | None = None,
    ) -> CropRegion:
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM crop_regions WHERE id = ?", (region_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"crop region not found: {region_id}")
            current = self._crop_region_from_row(row)
            updated = replace(
                current,
                x0=current.x0 if x0 is None else x0,
                y0=current.y0 if y0 is None else y0,
                x1=current.x1 if x1 is None else x1,
                y1=current.y1 if y1 is None else y1,
                layout_group_id=(
                    current.layout_group_id if layout_group_id is None else layout_group_id
                ),
                confidence=current.confidence if confidence is None else confidence,
                mode=current.mode if mode is None else mode,
                review_status=(
                    current.review_status if review_status is None else review_status
                ),
                updated_at=utc_now(),
            )
            connection.execute(
                """
                UPDATE crop_regions
                   SET layout_group_id = ?, x0 = ?, y0 = ?, x1 = ?, y1 = ?,
                       confidence = ?, mode = ?, review_status = ?, updated_at = ?
                 WHERE id = ?
                """,
                (
                    updated.layout_group_id,
                    updated.x0,
                    updated.y0,
                    updated.x1,
                    updated.y1,
                    updated.confidence,
                    _value(updated.mode),
                    _value(updated.review_status),
                    updated.updated_at,
                    region_id,
                ),
            )
        return updated

    # ------------------------------------------------------------------
    # Exports, logs and progress
    # ------------------------------------------------------------------
    def add_export(
        self,
        export_or_task_id: ExportRecord | str,
        output_path: str | Path | None = None,
        *,
        kind: str = "combined",
        status: str = "pending",
        error_message: str | None = None,
        export_id: str | None = None,
    ) -> ExportRecord:
        if isinstance(export_or_task_id, ExportRecord):
            export = export_or_task_id
        else:
            if output_path is None:
                raise TypeError("output_path is required")
            export = ExportRecord(
                id=export_id or new_id("export"),
                task_id=export_or_task_id,
                output_path=str(output_path),
                kind=kind,
                status=status,
                error_message=error_message,
            )
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO exports
                    (id, task_id, output_path, kind, status, error_message,
                     created_at, completed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    export.id,
                    export.task_id,
                    export.output_path,
                    export.kind,
                    export.status,
                    export.error_message,
                    export.created_at,
                    export.completed_at,
                ),
            )
        return export

    def get_exports(self, task_id: str) -> list[ExportRecord]:
        rows = self.connection.execute(
            "SELECT * FROM exports WHERE task_id = ? ORDER BY created_at, id",
            (task_id,),
        ).fetchall()
        return [self._export_from_row(row) for row in rows]

    list_exports = get_exports

    def update_export(
        self,
        export_id: str,
        status: str,
        *,
        error_message: str | None = None,
        completed_at: str | None = None,
    ) -> ExportRecord:
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM exports WHERE id = ?", (export_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"export not found: {export_id}")
            if completed_at is None and status in {"completed", "failed"}:
                completed_at = utc_now()
            connection.execute(
                """
                UPDATE exports
                   SET status = ?, error_message = ?, completed_at = ?
                 WHERE id = ?
                """,
                (status, error_message, completed_at, export_id),
            )
            updated = connection.execute(
                "SELECT * FROM exports WHERE id = ?", (export_id,)
            ).fetchone()
        return self._export_from_row(updated)

    def add_task_log(
        self,
        task_or_log: TaskLog | str,
        level: str | None = None,
        message: str | None = None,
        *,
        page_id: str | None = None,
        log_id: str | None = None,
    ) -> TaskLog:
        if isinstance(task_or_log, TaskLog):
            log = task_or_log
        else:
            if level is None or message is None:
                raise TypeError("level and message are required")
            log = TaskLog(
                id=log_id or new_id("log"),
                task_id=task_or_log,
                level=level,
                message=message,
                page_id=page_id,
            )
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO task_logs
                    (id, task_id, page_id, level, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    log.id,
                    log.task_id,
                    log.page_id,
                    log.level,
                    log.message,
                    log.created_at,
                ),
            )
        return log

    def get_task_logs(self, task_id: str) -> list[TaskLog]:
        rows = self.connection.execute(
            "SELECT * FROM task_logs WHERE task_id = ? ORDER BY created_at, id",
            (task_id,),
        ).fetchall()
        return [self._task_log_from_row(row) for row in rows]

    list_task_logs = get_task_logs

    def get_task_progress(self, task_id: str) -> dict[str, int]:
        """Return page counts for a task without loading page records."""

        rows = self.connection.execute(
            """
            SELECT p.status, COUNT(*) AS count
              FROM pages p
              JOIN source_files sf ON sf.id = p.source_file_id
             WHERE sf.task_id = ?
             GROUP BY p.status
            """,
            (task_id,),
        ).fetchall()
        progress = {status.value: 0 for status in PageStatus}
        progress.update({row["status"]: row["count"] for row in rows})
        progress["total"] = sum(progress[status.value] for status in PageStatus)
        return progress


__all__ = ["InvalidTaskTransition", "TaskStore"]
