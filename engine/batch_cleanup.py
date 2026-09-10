"""Durable, fail-closed cleanup plans for persistent batch jobs.

The batch and review stores intentionally remain separate databases.  This
module owns only the small cleanup journal in ``batch_cleanup`` and coordinates
the two stores in the fixed batch-then-review lock order.  It never reads,
hashes, or removes an original PDF.  Preview file operations are delegated to
the trusted host through the executor supplied to :func:`execute_cleanup`.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

from .batch_models import (
    MAX_IDENTIFIER_BYTES,
    MAX_JSON_BYTES,
    MAX_PATH_BYTES,
    BatchModelError,
    canonical_json,
)
from .batch_store import BatchStore
from .review_store_v2 import (
    ReviewStoreError,
    ReviewStoreV2,
    _validate_context as _validate_review_context,
)


_CLEANUP_SCHEMA = 1
_MAX_CLEANUP_PLANS = 4_096
_MAX_LIST_CLEANUPS = 100
_MAX_REFERENCE_IDS = 1_000
_MAX_PREVIEW_IDENTITIES = 1_024
_MAX_PREVIEW_BYTES = 4 * 1024 * 1024
_MAX_RESIDUAL_BYTES = 256 * 1024
_MAX_RESIDUAL_ENTRIES = 256
_ACTIVE_STATES = {
    "validating",
    "running",
    "pause_requested",
    "finalizing",
    "cancel_requested",
}
_KNOWN_JOB_STATES = {
    "queued",
    "validating",
    "running",
    "pause_requested",
    "paused",
    "partial_failed",
    "finalizing",
    "ready_for_review",
    "blocked",
    "cancel_requested",
    "cancelled",
    "interrupted",
    "archived",
}
_TERMINAL_TASK_STATE = "deleted"
_TERMINAL_REVIEW_STATES = {"deleted", "retained", "absent"}
_TERMINAL_PREVIEW_STATES = {"cleaned", "absent"}
_VALID_TASK_STATES = {_TERMINAL_TASK_STATE, "pending"}
_VALID_REVIEW_STATES = _TERMINAL_REVIEW_STATES | {"pending", "residual"}
_VALID_PREVIEW_STATES = _TERMINAL_PREVIEW_STATES | {"pending", "residual"}


class BatchCleanupError(ValueError):
    """Base error for invalid or unavailable cleanup operations."""


class BatchCleanupConflict(BatchCleanupError):
    """Raised when a cleanup plan no longer matches its batch job."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text(value: object, field: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise BatchCleanupError(f"{field} must be a non-empty string")
    result = value.strip()
    try:
        if len(result.encode("utf-8")) > maximum:
            raise BatchCleanupError(f"{field} is too long")
    except UnicodeError:
        raise BatchCleanupError(f"{field} must be valid UTF-8") from None
    return result


def _identifier(value: object, field: str) -> str:
    return _text(value, field, MAX_IDENTIFIER_BYTES)


def _sha(value: object, field: str) -> str:
    text = _text(value, field, 64)
    if len(text) != 64 or any(char not in "0123456789abcdefABCDEF" for char in text):
        raise BatchCleanupError(f"{field} must be a SHA-256 digest")
    return text.lower()


def _bool(value: object, field: str) -> bool:
    if not isinstance(value, bool):
        raise BatchCleanupError(f"{field} must be a boolean")
    return value


def _json_bytes(value: object, *, maximum: int = MAX_JSON_BYTES) -> bytes:
    try:
        encoded = canonical_json(value, max_bytes=maximum)
    except BatchModelError as exc:
        raise BatchCleanupError(f"cleanup JSON is invalid: {exc}") from None
    if len(encoded) > maximum:
        raise BatchCleanupError("cleanup JSON is too large")
    return encoded


def _json_text(value: object, *, maximum: int = MAX_JSON_BYTES) -> str:
    return _json_bytes(value, maximum=maximum).decode("utf-8")


def _decode_json(value: object, field: str) -> object:
    if not isinstance(value, str):
        raise BatchCleanupError(f"{field} is invalid")
    try:
        return json.loads(value)
    except (TypeError, ValueError, UnicodeError):
        raise BatchCleanupError(f"{field} is invalid") from None


def _decode_object(value: object, field: str) -> dict[str, object]:
    decoded = _decode_json(value, field)
    if not isinstance(decoded, dict):
        raise BatchCleanupError(f"{field} must be an object")
    return decoded


def _decode_array(value: object, field: str) -> list[dict[str, object]]:
    decoded = _decode_json(value, field)
    if not isinstance(decoded, list) or any(not isinstance(item, dict) for item in decoded):
        raise BatchCleanupError(f"{field} must be an array of objects")
    return decoded  # type: ignore[return-value]


def _digest(value: object) -> str:
    return hashlib.sha256(_json_bytes(value)).hexdigest()


def _context_key(value: object) -> str:
    try:
        _descriptor, _sha_by_key, context_key = _validate_review_context(
            value,
            trusted_aliases=True,
        )
    except ReviewStoreError as exc:
        raise BatchCleanupError(f"snapshot review context is invalid: {exc}") from None
    return context_key


def _preview_identities(value: object) -> tuple[list[dict[str, object]], str]:
    if not isinstance(value, list):
        raise BatchCleanupError("preview_identities must be an array")
    if len(value) > _MAX_PREVIEW_IDENTITIES:
        raise BatchCleanupError("preview_identities exceeds the limit")
    try:
        encoded = _json_bytes(value, maximum=_MAX_PREVIEW_BYTES)
        copied = json.loads(encoded)
    except (TypeError, ValueError, UnicodeError):
        raise BatchCleanupError("preview_identities must be JSON-compatible") from None
    if not isinstance(copied, list) or any(not isinstance(item, dict) for item in copied):
        raise BatchCleanupError("preview_identities must be an array of objects")
    for item in copied:
        path = item.get("path")
        if path is not None:
            _text(path, "preview.path", MAX_PATH_BYTES)
    return copied, encoded.decode("utf-8")


def _source_binding(connection: sqlite3.Connection, job_id: str) -> list[dict[str, object]]:
    rows = connection.execute(
        """
        SELECT source_id, position, source_key, access_path, sha256, page_count
          FROM batch_sources
         WHERE job_id = ?
         ORDER BY position ASC
        """,
        (job_id,),
    ).fetchall()
    result: list[dict[str, object]] = []
    seen_positions: set[int] = set()
    for row in rows:
        source_id = _identifier(row["source_id"], "source_id")
        source_key = _text(row["source_key"], "source_key", MAX_PATH_BYTES)
        access_path = _text(row["access_path"], "access_path", MAX_PATH_BYTES)
        position = row["position"]
        if isinstance(position, bool) or not isinstance(position, int) or position < 0 or position in seen_positions:
            raise BatchCleanupError("stored source position is invalid")
        seen_positions.add(position)
        source_sha = row["sha256"]
        if source_sha is not None:
            source_sha = _sha(source_sha, "source.sha256")
        page_count = row["page_count"]
        if page_count is not None and (
            isinstance(page_count, bool) or not isinstance(page_count, int) or page_count <= 0
        ):
            raise BatchCleanupError("stored source page_count is invalid")
        result.append(
            {
                "source_id": source_id,
                "position": position,
                "source_key": source_key,
                "access_path": access_path,
                "sha256": source_sha,
                "page_count": page_count,
            }
        )
    return result


def _job_binding(
    connection: sqlite3.Connection,
    row: sqlite3.Row,
) -> tuple[dict[str, object], str, list[dict[str, object]]]:
    job_id = _identifier(row["id"], "job_id")
    generation = row["generation"]
    if isinstance(generation, bool) or not isinstance(generation, int) or generation < 0:
        raise BatchCleanupError("stored job generation is invalid")
    state = _text(row["state"], "job.state", MAX_IDENTIFIER_BYTES)
    if state not in _KNOWN_JOB_STATES:
        raise BatchCleanupError("stored job state is invalid")
    result_revision = row["result_revision"]
    if result_revision is not None:
        result_revision = _identifier(result_revision, "result_revision")
    sources = _source_binding(connection, job_id)
    binding = {
        "id": job_id,
        "generation": generation,
        "result_revision": result_revision,
        "state": state,
        "sources": sources,
    }
    return binding, _digest(binding), sources


def _job_counts(connection: sqlite3.Connection, job_id: str, result_revision: str | None) -> dict[str, int]:
    source_count = int(connection.execute(
        "SELECT COUNT(*) FROM batch_sources WHERE job_id = ?",
        (job_id,),
    ).fetchone()[0])
    page_count = int(connection.execute(
        "SELECT COUNT(*) FROM batch_pages WHERE job_id = ?",
        (job_id,),
    ).fetchone()[0])
    page_counts = {"pending": 0, "processing": 0, "succeeded": 0, "failed": 0}
    for row in connection.execute(
        "SELECT state, COUNT(*) AS count FROM batch_pages WHERE job_id = ? GROUP BY state",
        (job_id,),
    ):
        state = str(row["state"])
        if state in page_counts:
            page_counts[state] = int(row["count"])
    page_result_count = int(connection.execute(
        "SELECT COUNT(*) FROM batch_page_results WHERE job_id = ?",
        (job_id,),
    ).fetchone()[0])
    review_item_count = 0
    if result_revision is not None:
        row = connection.execute(
            """
            SELECT item_count FROM batch_snapshots
             WHERE job_id = ? AND result_revision = ?
            """,
            (job_id, result_revision),
        ).fetchone()
        if row is not None:
            review_item_count = int(row["item_count"])
    return {
        "source_count": source_count,
        "page_count": page_count,
        "pending_pages": page_counts["pending"],
        "processing_pages": page_counts["processing"],
        "succeeded_pages": page_counts["succeeded"],
        "failed_pages": page_counts["failed"],
        "page_result_count": page_result_count,
        "review_item_count": review_item_count,
    }


def _snapshot_context(
    connection: sqlite3.Connection,
    job_id: str,
    result_revision: str | None,
) -> tuple[str | None, dict[str, object] | None]:
    if result_revision is None:
        return None, None
    row = connection.execute(
        """
        SELECT context_json FROM batch_snapshots
         WHERE job_id = ? AND result_revision = ?
        """,
        (job_id, result_revision),
    ).fetchone()
    if row is None:
        raise BatchCleanupError("current batch snapshot is missing")
    context = _decode_object(row["context_json"], "snapshot.context")
    return _validated_snapshot_context(connection, job_id, context), context


def _validated_snapshot_context(
    connection: sqlite3.Connection,
    job_id: str,
    context: dict[str, object],
) -> str:
    """Validate a snapshot context against its owning batch job binding.

    The review context key is intentionally independent of access-path
    spelling, but the batch snapshot still has to name exactly this job's
    source keys and verified SHA values before its review ownership can be
    considered for cleanup.
    """

    job = connection.execute(
        "SELECT criteria_fingerprint, computation_version FROM batch_jobs WHERE id = ?",
        (job_id,),
    ).fetchone()
    if job is None:
        raise BatchCleanupError("batch job for snapshot context is missing")
    if context.get("criteria_fingerprint") != job["criteria_fingerprint"]:
        raise BatchCleanupError("snapshot context criteria identity is invalid")
    if context.get("computation_version") != job["computation_version"]:
        raise BatchCleanupError("snapshot context computation identity is invalid")
    raw_sources = context.get("sources")
    if not isinstance(raw_sources, list):
        raise BatchCleanupError("snapshot context sources are invalid")
    stored_sources = _source_binding(connection, job_id)
    if len(raw_sources) != len(stored_sources):
        raise BatchCleanupError("snapshot context source set is incomplete")
    for raw, stored in zip(raw_sources, stored_sources, strict=True):
        if not isinstance(raw, dict):
            raise BatchCleanupError("snapshot context source is invalid")
        source_key = raw.get("source_key")
        source_sha = raw.get("source_sha256")
        if source_key != stored["source_key"] or stored["sha256"] is None:
            raise BatchCleanupError("snapshot context source identity is invalid")
        if not isinstance(source_sha, str) or source_sha.lower() != stored["sha256"]:
            raise BatchCleanupError("snapshot context source SHA is invalid")
    return _context_key(context)


def _scan_other_contexts(
    connection: sqlite3.Connection,
    job_id: str,
    context_key: str | None,
) -> tuple[list[str], bool]:
    if context_key is None:
        return [], False
    matching: list[str] = []
    unknown = False
    rows = connection.execute(
        "SELECT id, result_revision FROM batch_jobs WHERE id <> ? ORDER BY id",
        (job_id,),
    ).fetchall()
    for row in rows:
        other_id = _identifier(row["id"], "job_id")
        revision = row["result_revision"]
        if revision is None:
            continue
        revision = _identifier(revision, "result_revision")
        snapshot = connection.execute(
            """
            SELECT context_json FROM batch_snapshots
             WHERE job_id = ? AND result_revision = ?
            """,
            (other_id, revision),
        ).fetchone()
        if snapshot is None:
            # A published revision without its snapshot is damaged evidence,
            # not proof that the remaining job has no review references.
            unknown = True
            continue
        try:
            other_context = _decode_object(snapshot["context_json"], "snapshot.context")
            other_key = _validated_snapshot_context(connection, other_id, other_context)
        except BatchCleanupError:
            # An unreadable snapshot cannot safely prove that the context is
            # independent, so preserve review content conservatively.
            unknown = True
            continue
        if other_key == context_key:
            if len(matching) < _MAX_REFERENCE_IDS:
                matching.append(other_id)
            else:
                # The exact owner list is only explanatory metadata.  Once
                # its bound is reached, the conservative unknown flag keeps
                # deletion disabled without storing an unbounded scope.
                unknown = True
    return matching, unknown


def _review_view(review_database: Path, context_key: str, job_id: str) -> dict[str, object]:
    try:
        with ReviewStoreV2(review_database) as reviews:
            return reviews.batch_ownership(context_key, job_id)
    except (ReviewStoreError, sqlite3.Error) as exc:
        raise BatchCleanupError(f"review ownership is unavailable: {exc}") from None


def _scope_from_job(
    connection: sqlite3.Connection,
    row: sqlite3.Row,
    review_database: Path,
) -> tuple[dict[str, object], str | None]:
    binding, binding_digest, _sources = _job_binding(connection, row)
    counts = _job_counts(connection, binding["id"], binding["result_revision"])
    context_key, _context = _snapshot_context(
        connection,
        binding["id"],
        binding["result_revision"],
    )
    other_job_ids, other_unknown = _scan_other_contexts(connection, binding["id"], context_key)
    if context_key is None:
        review: dict[str, object] = {
            "context_key": None,
            "record_count": 0,
            "owner_count": 0,
            "owned_by_job": False,
            "other_owner_count": 0,
            "exclusive": False,
            "fingerprint": None,
            "other_job_ids": other_job_ids,
            "other_reference_unknown": other_unknown,
        }
    else:
        review = dict(_review_view(review_database, context_key, binding["id"]))
        # The ownership helper includes identity fields; keep only the stable
        # summary in the cleanup scope rather than duplicating its response.
        review = {
            "context_key": context_key,
            "record_count": review.get("record_count", 0),
            "owner_count": review.get("owner_count", 0),
            "owned_by_job": review.get("owned_by_job", False),
            "other_owner_count": review.get("other_owner_count", 0),
            "exclusive": review.get("exclusive", False),
            "fingerprint": review.get("fingerprint"),
            "other_job_ids": other_job_ids,
            "other_reference_unknown": other_unknown,
        }
    scope = {
        "schema": _CLEANUP_SCHEMA,
        "job": {
            "id": binding["id"],
            "name": _text(row["name"], "job.name", MAX_IDENTIFIER_BYTES),
            "generation": binding["generation"],
            "result_revision": binding["result_revision"],
            "state": binding["state"],
            "snapshot_digest": binding_digest,
        },
        "counts": counts,
        "review": review,
        "delete_review": None,
    }
    return scope, context_key


def _validate_scope(scope: object) -> dict[str, object]:
    if not isinstance(scope, dict) or scope.get("schema") != _CLEANUP_SCHEMA:
        raise BatchCleanupError("cleanup scope is invalid")
    _json_bytes(scope)
    job = scope.get("job")
    review = scope.get("review")
    if not isinstance(job, dict) or not isinstance(review, dict):
        raise BatchCleanupError("cleanup scope is incomplete")
    _identifier(job.get("id"), "scope.job.id")
    _text(job.get("name"), "scope.job.name", MAX_IDENTIFIER_BYTES)
    if not isinstance(job.get("generation"), int) or isinstance(job.get("generation"), bool) or job["generation"] < 0:
        raise BatchCleanupError("scope.job.generation is invalid")
    if job.get("result_revision") is not None:
        _identifier(job["result_revision"], "scope.job.result_revision")
    _text(job.get("state"), "scope.job.state", MAX_IDENTIFIER_BYTES)
    _sha(job.get("snapshot_digest"), "scope.job.snapshot_digest")
    counts = scope.get("counts")
    required_counts = {
        "source_count",
        "page_count",
        "pending_pages",
        "processing_pages",
        "succeeded_pages",
        "failed_pages",
        "page_result_count",
        "review_item_count",
    }
    if not isinstance(counts, dict) or set(counts) != required_counts:
        raise BatchCleanupError("scope.counts is invalid")
    for field in required_counts:
        value = counts[field]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise BatchCleanupError(f"scope.counts.{field} is invalid")
    preview_count = scope.get("preview_count", 0)
    if isinstance(preview_count, bool) or not isinstance(preview_count, int) or preview_count < 0:
        raise BatchCleanupError("scope.preview_count is invalid")
    context_key = review.get("context_key")
    if context_key is not None:
        _sha(context_key, "scope.review.context_key")
        fingerprint = review.get("fingerprint")
        if fingerprint is not None:
            _sha(fingerprint, "scope.review.fingerprint")
    elif review.get("fingerprint") is not None:
        raise BatchCleanupError("scope.review.fingerprint requires a context")
    for field in ("record_count", "owner_count", "other_owner_count"):
        value = review.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise BatchCleanupError(f"scope.review.{field} is invalid")
    for field in ("owned_by_job", "exclusive", "other_reference_unknown"):
        if not isinstance(review.get(field), bool):
            raise BatchCleanupError(f"scope.review.{field} is invalid")
    for field in ("other_job_ids", "execution_other_job_ids"):
        if field in review:
            values = review[field]
            if not isinstance(values, list) or any(
                not isinstance(item, str) for item in values
            ):
                raise BatchCleanupError(f"scope.review.{field} is invalid")
    for field in ("execution_other_reference_unknown",):
        if field in review and not isinstance(review[field], bool):
            raise BatchCleanupError(f"scope.review.{field} is invalid")
    delete_review = scope.get("delete_review")
    if delete_review is not None:
        _bool(delete_review, "scope.delete_review")
    return scope


def _cleanup_row(row: sqlite3.Row) -> dict[str, object]:
    cleanup_id = _identifier(row["id"], "cleanup_id")
    job_id = _identifier(row["job_id"], "cleanup.job_id")
    scope = _validate_scope(_decode_object(row["scope_json"], "cleanup.scope"))
    preview_raw = _decode_array(row["preview_identity_json"] or "[]", "cleanup.preview_identities")
    preview, _preview_json = _preview_identities(preview_raw)
    residual = None if row["residual_json"] is None else _decode_json(row["residual_json"], "cleanup.residual")
    if residual is not None:
        if not isinstance(residual, list) or any(not isinstance(item, dict) for item in residual):
            raise BatchCleanupError("cleanup.residual must be an array of objects")
        _json_bytes(residual, maximum=_MAX_RESIDUAL_BYTES)
    task_state = _text(row["task_data_state"], "cleanup.task_data_state", 32)
    review_state = _text(row["review_state"], "cleanup.review_state", 32)
    preview_state = _text(row["preview_state"], "cleanup.preview_state", 32)
    if task_state not in _VALID_TASK_STATES:
        raise BatchCleanupError("cleanup.task_data_state is invalid")
    if review_state not in _VALID_REVIEW_STATES:
        raise BatchCleanupError("cleanup.review_state is invalid")
    if preview_state not in _VALID_PREVIEW_STATES:
        raise BatchCleanupError("cleanup.preview_state is invalid")
    scope_job = scope["job"]
    scope_review = scope["review"]
    if not isinstance(scope_job, dict) or scope_job.get("id") != job_id:
        raise BatchCleanupError("cleanup job identity does not match its scope")
    if row["context_key"] != (scope_review.get("context_key") if isinstance(scope_review, dict) else None):
        raise BatchCleanupError("cleanup context identity does not match its scope")
    complete = (
        task_state == _TERMINAL_TASK_STATE
        and review_state in _TERMINAL_REVIEW_STATES
        and preview_state in _TERMINAL_PREVIEW_STATES
    )
    return {
        "id": cleanup_id,
        "cleanup_id": cleanup_id,
        "job_id": job_id,
        "scope": scope,
        "context_key": row["context_key"],
        "preview_identities": preview,
        "task_data_state": task_state,
        "review_state": review_state,
        "preview_state": preview_state,
        "residual": residual,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "outcome": "completed" if complete else "pending",
    }


def _notice_codes(
    review_state: str,
    preview_state: str,
    residual: object,
) -> list[str]:
    """Return stable, UI-safe notices without persisting exception text."""

    review_changed = False
    if isinstance(residual, list):
        review_changed = any(
            isinstance(item, dict)
            and item.get("kind") == "review"
            and item.get("reason") == "changed"
            for item in residual
        )
    notices: list[str] = []
    if review_state == "residual":
        notices.append("review_residual")
    elif review_changed:
        notices.append("review_changed")
    elif review_state == "retained":
        notices.append("review_retained")
    if preview_state == "residual":
        notices.append("preview_residual")
    return notices


def cleanup_dto(cleanup: Mapping[str, object]) -> dict[str, object]:
    """Project a cleanup row to the bounded public response shape."""

    scope_value = cleanup.get("scope")
    if isinstance(scope_value, dict):
        scope = _validate_scope(scope_value)
        job = scope["job"]
        review = scope["review"]
        counts = scope["counts"]
        if not isinstance(job, dict) or not isinstance(review, dict) or not isinstance(counts, dict):
            raise BatchCleanupError("cleanup scope is incomplete")
        job_id = _identifier(job.get("id"), "cleanup.job_id")
        job_name = _text(job.get("name"), "cleanup.job_name", MAX_IDENTIFIER_BYTES)
        source_count = counts["source_count"]
        page_result_count = counts["page_result_count"]
        review_record_count = review["record_count"]
        review_exclusive = review["exclusive"]
        preview_count = scope.get("preview_count", 0)
        delete_review = scope.get("delete_review")
        residual = cleanup.get("residual")
        task_state = cleanup.get("task_data_state")
        review_state = cleanup.get("review_state")
        preview_state = cleanup.get("preview_state")
        cleanup_id = cleanup.get("cleanup_id", cleanup.get("id"))
        created_at = cleanup.get("created_at")
        updated_at = cleanup.get("updated_at")
    else:
        # Lightweight list rows already contain the projected fields and do
        # not load the persisted preview_identity_json column.
        cleanup_id = cleanup.get("cleanup_id", cleanup.get("id"))
        job_id = cleanup.get("job_id")
        job_name = cleanup.get("job_name")
        source_count = cleanup.get("source_count")
        page_result_count = cleanup.get("page_result_count")
        review_record_count = cleanup.get("review_record_count")
        review_exclusive = cleanup.get("review_exclusive")
        preview_count = cleanup.get("preview_count")
        delete_review = cleanup.get("delete_review")
        task_state = cleanup.get("task_data_state")
        review_state = cleanup.get("review_state")
        preview_state = cleanup.get("preview_state")
        residual = cleanup.get("residual")
        created_at = cleanup.get("created_at")
        updated_at = cleanup.get("updated_at")

    cleanup_id = _identifier(cleanup_id, "cleanup_id")
    job_id = _identifier(job_id, "cleanup.job_id")
    job_name = _text(job_name, "cleanup.job_name", MAX_IDENTIFIER_BYTES)
    for value, field in (
        (source_count, "source_count"),
        (page_result_count, "page_result_count"),
        (review_record_count, "review_record_count"),
        (preview_count, "preview_count"),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise BatchCleanupError(f"cleanup.{field} is invalid")
    if not isinstance(review_exclusive, bool):
        raise BatchCleanupError("cleanup.review_exclusive is invalid")
    if delete_review is not None:
        _bool(delete_review, "cleanup.delete_review")
    task_state = _text(task_state, "cleanup.task_data_state", 32)
    review_state = _text(review_state, "cleanup.review_state", 32)
    preview_state = _text(preview_state, "cleanup.preview_state", 32)
    if task_state not in _VALID_TASK_STATES:
        raise BatchCleanupError("cleanup.task_data_state is invalid")
    if review_state not in _VALID_REVIEW_STATES:
        raise BatchCleanupError("cleanup.review_state is invalid")
    if preview_state not in _VALID_PREVIEW_STATES:
        raise BatchCleanupError("cleanup.preview_state is invalid")
    created_at = _text(created_at, "cleanup.created_at", 128)
    updated_at = _text(updated_at, "cleanup.updated_at", 128)
    outcome = (
        "completed"
        if task_state == _TERMINAL_TASK_STATE
        and review_state in _TERMINAL_REVIEW_STATES
        and preview_state in _TERMINAL_PREVIEW_STATES
        else "pending"
    )
    return {
        "cleanup_id": cleanup_id,
        "job_id": job_id,
        "job_name": job_name,
        "source_count": source_count,
        "page_result_count": page_result_count,
        "review_record_count": review_record_count,
        "review_exclusive": review_exclusive,
        "preview_count": preview_count,
        "delete_review": delete_review,
        "task_data_state": task_state,
        "review_state": review_state,
        "preview_state": preview_state,
        "outcome": outcome,
        "created_at": created_at,
        "updated_at": updated_at,
        "notice_codes": _notice_codes(review_state, preview_state, residual),
    }


def _append_residual(residual: list[dict[str, object]], kind: str, reason: str) -> None:
    entry = {"kind": kind, "reason": reason[:2_048]}
    if len(residual) >= _MAX_RESIDUAL_ENTRIES:
        # Keep the journal bounded while retaining the newest failure.  The
        # durable state remains non-terminal, so omitted historical details
        # can never be mistaken for a successful cleanup.
        del residual[_MAX_RESIDUAL_ENTRIES - 1 :]
    residual.append(entry)


def _cleanup_summary_row(row: sqlite3.Row) -> dict[str, object]:
    """Decode a log without selecting its potentially large preview list."""

    cleanup_id = _identifier(row["id"], "cleanup_id")
    job_id = _identifier(row["job_id"], "cleanup.job_id")
    scope = _validate_scope(_decode_object(row["scope_json"], "cleanup.scope"))
    scope_job = scope["job"]
    scope_review = scope["review"]
    counts = scope["counts"]
    if (
        not isinstance(scope_job, dict)
        or not isinstance(scope_review, dict)
        or not isinstance(counts, dict)
        or scope_job.get("id") != job_id
    ):
        raise BatchCleanupError("cleanup job identity does not match its scope")
    if row["context_key"] != scope_review.get("context_key"):
        raise BatchCleanupError("cleanup context identity does not match its scope")
    residual = None if row["residual_json"] is None else _decode_json(row["residual_json"], "cleanup.residual")
    if residual is not None:
        if not isinstance(residual, list) or any(not isinstance(item, dict) for item in residual):
            raise BatchCleanupError("cleanup.residual must be an array of objects")
        _json_bytes(residual, maximum=_MAX_RESIDUAL_BYTES)
    task_state = _text(row["task_data_state"], "cleanup.task_data_state", 32)
    review_state = _text(row["review_state"], "cleanup.review_state", 32)
    preview_state = _text(row["preview_state"], "cleanup.preview_state", 32)
    if task_state not in _VALID_TASK_STATES:
        raise BatchCleanupError("cleanup.task_data_state is invalid")
    if review_state not in _VALID_REVIEW_STATES:
        raise BatchCleanupError("cleanup.review_state is invalid")
    if preview_state not in _VALID_PREVIEW_STATES:
        raise BatchCleanupError("cleanup.preview_state is invalid")
    return {
        "id": cleanup_id,
        "cleanup_id": cleanup_id,
        "job_id": job_id,
        "job_name": _text(scope_job.get("name"), "cleanup.job_name", MAX_IDENTIFIER_BYTES),
        "source_count": counts["source_count"],
        "page_result_count": counts["page_result_count"],
        "review_record_count": scope_review["record_count"],
        "review_exclusive": scope_review["exclusive"],
        "preview_count": scope.get("preview_count", 0),
        "delete_review": scope.get("delete_review"),
        "task_data_state": task_state,
        "review_state": review_state,
        "preview_state": preview_state,
        "residual": residual,
        "created_at": _text(row["created_at"], "cleanup.created_at", 128),
        "updated_at": _text(row["updated_at"], "cleanup.updated_at", 128),
        "outcome": (
            "completed"
            if task_state == _TERMINAL_TASK_STATE
            and review_state in _TERMINAL_REVIEW_STATES
            and preview_state in _TERMINAL_PREVIEW_STATES
            else "pending"
        ),
    }


def _residual_json(residual: list[dict[str, object]]) -> str | None:
    if not residual:
        return None
    bounded = residual[-_MAX_RESIDUAL_ENTRIES:]
    # A malformed or manually edited journal must not turn a retry into an
    # unbounded write.  Trim the oldest entries until the bounded encoding is
    # accepted; the latest failure is always kept for retry diagnostics.
    while bounded:
        try:
            return _json_text(bounded, maximum=_MAX_RESIDUAL_BYTES)
        except BatchCleanupError:
            if len(bounded) == 1:
                return _json_text([bounded[-1]], maximum=_MAX_RESIDUAL_BYTES)
            bounded = bounded[len(bounded) // 4 :]
    return None


def _set_cleanup_state(
    connection: sqlite3.Connection,
    cleanup_id: str,
    *,
    scope: dict[str, object],
    task_state: str,
    review_state: str,
    preview_state: str,
    residual: list[dict[str, object]],
) -> None:
    if task_state not in _VALID_TASK_STATES:
        raise BatchCleanupError("cleanup.task_data_state is invalid")
    if review_state not in _VALID_REVIEW_STATES:
        raise BatchCleanupError("cleanup.review_state is invalid")
    if preview_state not in _VALID_PREVIEW_STATES:
        raise BatchCleanupError("cleanup.preview_state is invalid")
    now = _utc_now()
    connection.execute(
        """
        UPDATE batch_cleanup
           SET scope_json = ?, task_data_state = ?, review_state = ?,
               preview_state = ?, residual_json = ?, updated_at = ?
         WHERE id = ?
        """,
        (
            _json_text(scope),
            task_state,
            review_state,
            preview_state,
            _residual_json(residual),
            now,
            cleanup_id,
        ),
    )
    if connection.execute("SELECT changes()").fetchone()[0] != 1:
        raise BatchCleanupError("cleanup log disappeared during update")


def _load_cleanup_row(store: BatchStore, cleanup_id: str) -> sqlite3.Row:
    row = store.connection.execute(
        "SELECT * FROM batch_cleanup WHERE id = ?",
        (cleanup_id,),
    ).fetchone()
    if row is None:
        raise BatchCleanupError("cleanup plan not found")
    return row


def _drop_unstarted_pending_plans(connection: sqlite3.Connection, job_id: str) -> None:
    """Drop replaceable plans while retaining every started cleanup log."""

    rows = connection.execute(
        """
        SELECT id, scope_json
          FROM batch_cleanup
         WHERE job_id = ?
           AND task_data_state = 'pending'
           AND review_state = 'pending'
           AND preview_state = 'pending'
        """,
        (job_id,),
    ).fetchall()
    for row in rows:
        scope = _validate_scope(_decode_object(row["scope_json"], "cleanup.scope"))
        started = scope.get("started", False)
        if not isinstance(started, bool):
            raise BatchCleanupError("cleanup.started is invalid")
        if not started:
            connection.execute("DELETE FROM batch_cleanup WHERE id = ?", (row["id"],))


def plan_cleanup(
    store: BatchStore,
    review_database: Path,
    job_id: object,
    preview_identities: list[dict[str, object]],
) -> dict[str, object]:
    """Create a server-bound cleanup plan without disabling the job."""

    identifier = _identifier(job_id, "job_id")
    review_path = Path(review_database)
    _preview_values, preview_json = _preview_identities(preview_identities)
    with store._transaction(immediate=True) as connection:
        row = connection.execute(
            "SELECT * FROM batch_jobs WHERE id = ?",
            (identifier,),
        ).fetchone()
        if row is None:
            raise BatchCleanupError(f"job not found: {identifier}")
        state = _text(row["state"], "job.state", MAX_IDENTIFIER_BYTES)
        if state not in _KNOWN_JOB_STATES:
            raise BatchCleanupError("stored job state is invalid")
        if state in _ACTIVE_STATES:
            raise BatchCleanupConflict("active job cannot be cleaned")
        if bool(row["deletion_pending"]):
            raise BatchCleanupConflict("job cleanup is already pending")
        scope, context_key = _scope_from_job(connection, row, review_path)
        scope["preview_count"] = len(_preview_values)
        scope["started"] = False
        # A plan that has never started has no independent work to recover.
        # Keep only the newest such plan for a job; executed or residual logs
        # remain durable evidence and are never removed here.
        _drop_unstarted_pending_plans(connection, identifier)
        pending_count = int(connection.execute(
            """
            SELECT COUNT(*) FROM batch_cleanup
             WHERE job_id = ? AND task_data_state = 'pending'
            """,
            (identifier,),
        ).fetchone()[0])
        if pending_count >= _MAX_CLEANUP_PLANS:
            raise BatchCleanupError("too many pending cleanup plans")
        cleanup_id = f"cleanup_{uuid4().hex}"
        now = _utc_now()
        connection.execute(
            """
            INSERT INTO batch_cleanup (
                id, job_id, scope_json, context_key, preview_identity_json,
                task_data_state, preview_state, review_state, residual_json,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', 'pending', 'pending', NULL, ?, ?)
            """,
            (
                cleanup_id,
                identifier,
                _json_text(scope),
                context_key,
                preview_json,
                now,
                now,
            ),
        )
        created = connection.execute(
            "SELECT * FROM batch_cleanup WHERE id = ?",
            (cleanup_id,),
        ).fetchone()
        if created is None:
            raise BatchCleanupError("cleanup plan was not persisted")
        return _cleanup_row(created)


def _review_state_from_release(result: Mapping[str, object]) -> tuple[str, str | None]:
    outcome = result.get("outcome")
    if outcome == "deleted":
        return "deleted", None
    if outcome == "already_absent":
        return "absent", None
    if outcome in {"retained", "released_shared", "already_released", "not_owner"}:
        return "retained", str(outcome)
    if outcome == "changed":
        return "retained", "changed"
    return "residual", f"unexpected review cleanup outcome: {outcome}"


def _classify_preview_result(result: object) -> tuple[str, str | None]:
    if not isinstance(result, dict):
        return "residual", "preview executor returned a non-object result"
    residuals = result.get("residuals", result.get("residual"))
    if residuals:
        return "residual", "preview files remain or could not be verified"
    state = result.get("state", result.get("status"))
    if state == "cleaned":
        return "cleaned", None
    if state == "absent":
        return "absent", None
    if state is None and result.get("complete") is True:
        return "cleaned", None
    if state in {"residual", "failed", "error"}:
        return "residual", "preview files remain or could not be verified"
    return "residual", "preview executor did not report cleaned or absent"


def execute_cleanup(
    store: BatchStore,
    review_database: Path,
    cleanup_id: object,
    delete_review: object,
    preview_executor: Callable[[list[dict[str, object]]], dict[str, object]],
) -> dict[str, object]:
    """Execute or resume one cleanup plan with durable sub-operation states."""

    identifier = _identifier(cleanup_id, "cleanup_id")
    should_delete_review = _bool(delete_review, "delete_review")
    if not callable(preview_executor):
        raise BatchCleanupError("preview_executor must be callable")
    review_path = Path(review_database)

    # First commit a durable deletion gate.  If the subsequent cross-database
    # work fails, the job remains read-only and cannot be picked up by a new
    # start/control/review request while the same cleanup ID is retried.
    with store._transaction(immediate=True) as connection:
        cleanup = connection.execute(
            "SELECT * FROM batch_cleanup WHERE id = ?",
            (identifier,),
        ).fetchone()
        if cleanup is None:
            raise BatchCleanupError("cleanup plan not found")
        _cleanup_row(cleanup)
        scope = _validate_scope(_decode_object(cleanup["scope_json"], "cleanup.scope"))
        recorded_delete_review = scope.get("delete_review")
        if recorded_delete_review is not None and recorded_delete_review is not should_delete_review:
            raise BatchCleanupConflict("delete_review cannot change after cleanup starts")
        scope["delete_review"] = should_delete_review
        task_state = _text(cleanup["task_data_state"], "cleanup.task_data_state", 32)
        review_state = _text(cleanup["review_state"], "cleanup.review_state", 32)
        preview_state = _text(cleanup["preview_state"], "cleanup.preview_state", 32)
        job_id = _identifier(cleanup["job_id"], "cleanup.job_id")
        started = scope.get("started", False)
        if not isinstance(started, bool):
            raise BatchCleanupError("cleanup.started is invalid")
        job = connection.execute(
            "SELECT * FROM batch_jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
        if not started:
            if task_state != "pending" or job is None:
                raise BatchCleanupConflict("cleanup plan cannot be started")
            current_state = _text(job["state"], "job.state", MAX_IDENTIFIER_BYTES)
            if current_state in _ACTIVE_STATES:
                raise BatchCleanupConflict("active job cannot be cleaned")
            if bool(job["deletion_pending"]):
                raise BatchCleanupConflict("job cleanup is already pending")
            expected_job = scope["job"]
            _binding, current_digest, _sources = _job_binding(connection, job)
            if current_digest != expected_job["snapshot_digest"]:
                raise BatchCleanupConflict("cleanup plan is stale")
            connection.execute(
                "UPDATE batch_jobs SET deletion_pending = 1 WHERE id = ? AND deletion_pending = 0",
                (job_id,),
            )
            if connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise BatchCleanupConflict("job changed before cleanup started")
            scope["started"] = True
            residual_raw = None if cleanup["residual_json"] is None else _decode_json(cleanup["residual_json"], "cleanup.residual")
            residual = [item for item in residual_raw if isinstance(item, dict)] if isinstance(residual_raw, list) else []
            _set_cleanup_state(
                connection,
                identifier,
                scope=scope,
                task_state=task_state,
                review_state=review_state,
                preview_state=preview_state,
                residual=residual,
            )
        else:
            if task_state == _TERMINAL_TASK_STATE and job is not None:
                raise BatchCleanupConflict("started cleanup job is unexpectedly present")
            if task_state != _TERMINAL_TASK_STATE and job is None:
                raise BatchCleanupConflict("cleanup job is missing before deletion started")
            if job is not None:
                if not bool(job["deletion_pending"]):
                    raise BatchCleanupConflict("cleanup deletion gate was cleared")
                if _text(job["state"], "job.state", MAX_IDENTIFIER_BYTES) in _ACTIVE_STATES:
                    raise BatchCleanupConflict("active job cannot be cleaned")

    # The gate is now durable.  Delete the task and release review ownership
    # in a second batch transaction, preserving batch -> review lock order.
    with store._transaction(immediate=True) as connection:
        cleanup = connection.execute(
            "SELECT * FROM batch_cleanup WHERE id = ?",
            (identifier,),
        ).fetchone()
        if cleanup is None:
            raise BatchCleanupError("cleanup log disappeared after start")
        _cleanup_row(cleanup)
        scope = _validate_scope(_decode_object(cleanup["scope_json"], "cleanup.scope"))
        if scope.get("started") is not True:
            raise BatchCleanupConflict("cleanup was not durably started")
        preview_values = _decode_array(cleanup["preview_identity_json"] or "[]", "cleanup.preview_identities")
        recorded_delete_review = scope.get("delete_review")
        if recorded_delete_review is not should_delete_review:
            raise BatchCleanupConflict("delete_review cannot change after cleanup starts")
        residual_raw = None if cleanup["residual_json"] is None else _decode_json(cleanup["residual_json"], "cleanup.residual")
        residual: list[dict[str, object]] = [item for item in residual_raw if isinstance(item, dict)] if isinstance(residual_raw, list) else []
        task_state = _text(cleanup["task_data_state"], "cleanup.task_data_state", 32)
        review_state = _text(cleanup["review_state"], "cleanup.review_state", 32)
        preview_state = _text(cleanup["preview_state"], "cleanup.preview_state", 32)
        job_id = _identifier(cleanup["job_id"], "cleanup.job_id")
        job = connection.execute(
            "SELECT * FROM batch_jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
        if task_state != _TERMINAL_TASK_STATE:
            if job is None:
                raise BatchCleanupConflict("cleanup job is missing before deletion started")
            if not bool(job["deletion_pending"]):
                raise BatchCleanupConflict("cleanup deletion gate was cleared")
            if _text(job["state"], "job.state", MAX_IDENTIFIER_BYTES) in _ACTIVE_STATES:
                raise BatchCleanupConflict("active job cannot be cleaned")
            expected_job = scope["job"]
            _binding, current_digest, _sources = _job_binding(connection, job)
            if current_digest != expected_job["snapshot_digest"]:
                raise BatchCleanupConflict("cleanup plan is stale")
            connection.execute("DELETE FROM batch_jobs WHERE id = ?", (job_id,))
            if connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise BatchCleanupConflict("batch job changed during cleanup")
            task_state = _TERMINAL_TASK_STATE
        elif job is not None:
            raise BatchCleanupConflict("started cleanup job is unexpectedly present")

        review_scope = scope["review"]
        assert isinstance(review_scope, dict)
        context_key = review_scope.get("context_key")
        if review_state not in _TERMINAL_REVIEW_STATES:
            if not isinstance(context_key, str):
                review_state = "absent"
            else:
                other_job_ids, other_unknown = _scan_other_contexts(connection, job_id, context_key)
                review_scope["execution_other_job_ids"] = other_job_ids
                review_scope["execution_other_reference_unknown"] = other_unknown
                force_retained = bool(other_job_ids) or other_unknown
                expected_fingerprint = review_scope.get("fingerprint")
                if not isinstance(expected_fingerprint, str):
                    review_state = "absent"
                else:
                    try:
                        with ReviewStoreV2(review_path) as reviews:
                            release = reviews.release_batch_owner(
                                context_key,
                                job_id,
                                identifier,
                                should_delete_review,
                                expected_fingerprint,
                                force_retained=force_retained,
                            )
                        review_state, reason = _review_state_from_release(release)
                        if reason is not None:
                            _append_residual(residual, "review", reason)
                        if force_retained:
                            _append_residual(residual, "review", "other job references the same context")
                    except Exception as exc:
                        review_state = "residual"
                        _append_residual(residual, "review", f"review cleanup failed: {exc}")

        # The preview executor is intentionally not called in this database
        # transaction.  It may stat/hash/delete only host-registered preview
        # files and must be retried from the persisted identity list.
        _set_cleanup_state(
            connection,
            identifier,
            scope=scope,
            task_state=task_state,
            review_state=review_state,
            preview_state=preview_state,
            residual=residual,
        )

    if preview_state not in _TERMINAL_PREVIEW_STATES:
        if not preview_values:
            preview_state = "absent"
        else:
            try:
                preview_result = preview_executor(preview_values)
                preview_state, reason = _classify_preview_result(preview_result)
                if reason is not None:
                    residual.append({"kind": "preview", "reason": reason})
            except Exception as exc:
                preview_state = "residual"
                residual.append({"kind": "preview", "reason": f"preview cleanup failed: {exc}"[:2_048]})
        with store._transaction(immediate=True) as connection:
            cleanup = connection.execute(
                "SELECT * FROM batch_cleanup WHERE id = ?",
                (identifier,),
            ).fetchone()
            if cleanup is None:
                raise BatchCleanupError("cleanup log disappeared during preview cleanup")
            scope = _validate_scope(_decode_object(cleanup["scope_json"], "cleanup.scope"))
            residual_raw = None if cleanup["residual_json"] is None else _decode_json(cleanup["residual_json"], "cleanup.residual")
            persisted_residual = [item for item in residual_raw if isinstance(item, dict)] if isinstance(residual_raw, list) else []
            persisted_residual.extend(residual)
            current_preview_state = _text(cleanup["preview_state"], "cleanup.preview_state", 32)
            # A concurrent retry may already have completed the preview while
            # this executor was running.  Never let a slower residual result
            # regress a terminal state.
            persisted_preview_state = (
                current_preview_state
                if current_preview_state in _TERMINAL_PREVIEW_STATES
                else preview_state
            )
            _set_cleanup_state(
                connection,
                identifier,
                scope=scope,
                task_state=_text(cleanup["task_data_state"], "cleanup.task_data_state", 32),
                review_state=_text(cleanup["review_state"], "cleanup.review_state", 32),
                preview_state=persisted_preview_state,
                residual=persisted_residual,
            )

    return _cleanup_row(_load_cleanup_row(store, identifier))


def _pagination(value: object, field: str, *, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > maximum:
        raise BatchCleanupError(f"{field} is out of range")
    return value


def list_cleanups_page(
    store: BatchStore,
    job_id: object | None = None,
    *,
    offset: object = 0,
    limit: object = _MAX_LIST_CLEANUPS,
) -> dict[str, object]:
    """Return bounded cleanup summaries and a finite continuation offset.

    ``preview_identity_json`` is deliberately omitted from this query.  The
    preview count is carried in the small signed plan scope, so listing a
    history page never loads retained file identities into Python.
    """

    start = _pagination(offset, "offset", maximum=2_147_483_647)
    page_size = _pagination(limit, "limit", maximum=_MAX_LIST_CLEANUPS)
    if page_size < 1:
        raise BatchCleanupError("limit must be positive")
    identifier = None if job_id is None else _identifier(job_id, "job_id")
    columns = """
        id, job_id, scope_json, context_key, task_data_state,
        preview_state, review_state, residual_json, created_at, updated_at
    """
    order = """
        ORDER BY CASE WHEN task_data_state = 'deleted'
                           AND review_state IN ('deleted', 'retained', 'absent')
                           AND preview_state IN ('cleaned', 'absent')
                      THEN 1 ELSE 0 END ASC,
                 updated_at ASC, id ASC
    """
    if identifier is None:
        rows = store.connection.execute(
            f"SELECT {columns} FROM batch_cleanup {order} LIMIT ? OFFSET ?",
            (page_size + 1, start),
        ).fetchall()
    else:
        rows = store.connection.execute(
            f"SELECT {columns} FROM batch_cleanup WHERE job_id = ? {order} LIMIT ? OFFSET ?",
            (identifier, page_size + 1, start),
        ).fetchall()
    has_more = len(rows) > page_size
    items = [_cleanup_summary_row(row) for row in rows[:page_size]]
    return {
        "items": items,
        "next_offset": start + page_size if has_more else None,
    }


def list_cleanups(
    store: BatchStore,
    job_id: object | None = None,
    offset: object = 0,
    limit: object = _MAX_LIST_CLEANUPS,
) -> list[dict[str, object]]:
    """List bounded cleanup summaries without loading preview identities."""

    return list_cleanups_page(store, job_id, offset=offset, limit=limit)["items"]  # type: ignore[return-value]


def _checkpoint_truncate(connection: sqlite3.Connection) -> None:
    """Run a truncating WAL checkpoint and reject a busy/invalid result.

    SQLite reports checkpoint status as ``(busy, log, checkpointed)``.  The
    statement itself can succeed while ``busy`` is non-zero when another
    connection holds a read snapshot, so execute success alone cannot prove
    that maintenance reclaimed the WAL.
    """

    result = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    if result is None:
        raise BatchCleanupError("SQLite WAL checkpoint returned no status")
    try:
        values = tuple(result)
    except TypeError:
        raise BatchCleanupError("SQLite WAL checkpoint returned an invalid status") from None
    if len(values) != 3 or any(
        isinstance(value, bool) or not isinstance(value, int)
        for value in values
    ):
        raise BatchCleanupError("SQLite WAL checkpoint returned an invalid status")
    busy, log_frames, checkpointed_frames = values
    if busy != 0:
        raise BatchCleanupError("SQLite WAL checkpoint is busy")
    if log_frames < -1 or checkpointed_frames < -1:
        raise BatchCleanupError("SQLite WAL checkpoint returned an invalid status")
    if (log_frames == -1) != (checkpointed_frames == -1):
        raise BatchCleanupError("SQLite WAL checkpoint returned an invalid status")
    if log_frames >= 0 and checkpointed_frames != log_frames:
        raise BatchCleanupError("SQLite WAL checkpoint did not finish")


def storage_maintain(store: BatchStore) -> dict[str, object]:
    """Reclaim idle SQLite space without rolling back cleanup decisions."""

    active = store.connection.execute(
        """
        SELECT 1 FROM batch_jobs
         WHERE deletion_pending = 1
            OR state IN ('validating', 'running', 'pause_requested', 'finalizing', 'cancel_requested')
         LIMIT 1
        """
    ).fetchone()
    if active is not None:
        return {
            "outcome": "failed",
            "warning": "active_jobs",
            "usage": storage_usage(store),
        }
    try:
        _checkpoint_truncate(store.connection)
        store.connection.execute("VACUUM")
        _checkpoint_truncate(store.connection)
    except (OSError, sqlite3.Error, BatchCleanupError):
        return {
            "outcome": "failed",
            "warning": "maintenance_failed",
            "usage": storage_usage(store),
        }
    return {"outcome": "completed", "usage": storage_usage(store)}


def storage_usage(store: BatchStore) -> dict[str, int | bool | None]:
    """Report actual batch DB/WAL/SHM bytes and the configured quota."""

    path_value = getattr(store, "_path", None)
    if path_value is None:
        row = store.connection.execute("PRAGMA page_count").fetchone()
        page_size = store.connection.execute("PRAGMA page_size").fetchone()
        database_bytes = int(row[0]) * int(page_size[0])
        wal_bytes = 0
        shm_bytes = 0
    else:
        base = Path(path_value)
        def file_size(candidate: Path) -> int | None:
            try:
                return int(candidate.stat().st_size)
            except FileNotFoundError:
                return 0
            except OSError:
                return None
        database_bytes = file_size(base)
        wal_bytes = file_size(Path(f"{base}-wal"))
        shm_bytes = file_size(Path(f"{base}-shm"))
    available = all(value is not None for value in (database_bytes, wal_bytes, shm_bytes))
    total_bytes = (
        database_bytes + wal_bytes + shm_bytes
        if available
        else None
    )
    quota_bytes = int(store.quota_bytes)
    return {
        "database_bytes": database_bytes,
        "wal_bytes": wal_bytes,
        "shm_bytes": shm_bytes,
        "total_bytes": total_bytes,
        "quota_bytes": quota_bytes,
        "within_quota": total_bytes <= quota_bytes if total_bytes is not None else None,
        "available": available,
    }


__all__ = [
    "BatchCleanupConflict",
    "BatchCleanupError",
    "cleanup_dto",
    "execute_cleanup",
    "list_cleanups",
    "list_cleanups_page",
    "plan_cleanup",
    "storage_maintain",
    "storage_usage",
]
