"""Read-only recovery snapshots for the versioned review store.

The normal :class:`~engine.review_store_v2.ReviewStoreV2` constructor performs
schema setup and ownership backfilling.  Recovery reads must not do either, so
this module opens the existing database directly through SQLite's ``mode=ro``
URI and keeps one explicit read transaction around the complete snapshot.
"""

from __future__ import annotations

import json
from pathlib import Path
import sqlite3
from typing import Any

from .review_store_v2 import (
    ReviewRevisionConflict,
    ReviewStoreCorruptionError,
    ReviewStoreError,
    ReviewStoreV2,
    _bounded_result_revision,
    _immutable_matches,
    _normalize_source_path,
    _public_record,
    _row_to_record,
    _validate_context,
    _validate_originals,
    _final_rect_is_legal,
    _require_sha,
)


def _read_only_uri(database_path: str | Path) -> str:
    """Return a SQLite file URI that cannot create a database."""

    try:
        path = Path(database_path)
    except (TypeError, ValueError):
        raise ReviewStoreError("review database path is invalid") from None
    if not str(path).strip() or not path.is_file():
        raise ReviewStoreError("review database does not exist")
    try:
        return f"{path.resolve().as_uri()}?mode=ro"
    except (OSError, ValueError):
        raise ReviewStoreError("review database path is invalid") from None


def _stored_context(
    connection: sqlite3.Connection,
    context_key: str,
) -> tuple[
    sqlite3.Row,
    dict[str, str],
    dict[str, str],
    dict[str, object],
    list[Any],
]:
    """Load and validate the current context and its manifest.

    The descriptor and manifest are deliberately read from the database row;
    the public read API accepts no caller-supplied context that could rebind a
    trusted alias or otherwise repair the stored state.
    """

    row = connection.execute(
        "SELECT * FROM review_contexts_v2 WHERE context_key = ?",
        (context_key,),
    ).fetchone()
    if row is None:
        raise ReviewStoreError("review context does not exist")

    try:
        descriptor = json.loads(row["descriptor_json"])
    except (TypeError, ValueError, json.JSONDecodeError):
        raise ReviewStoreCorruptionError("stored review context is invalid") from None
    if not isinstance(descriptor, dict):
        raise ReviewStoreCorruptionError("stored review context is invalid")

    # This validates the schema-bound descriptor, its canonical encoding, the
    # manifest digest and every manifest item.  Passing the stored descriptor
    # as the expected descriptor is intentional: there is no external context
    # in this read-only API, so the row itself is the source of truth to audit.
    ReviewStoreV2._validate_context_row(row, descriptor, context_key)
    try:
        stored_descriptor, source_sha_by_key, expected_context_key = _validate_context(
            descriptor,
            trusted_aliases=True,
        )
        manifest_raw = json.loads(row["manifest_json"])
        manifest_items, canonical_manifest_json, canonical_manifest_digest = _validate_originals(
            manifest_raw,
            source_sha_by_key,
        )
    except (TypeError, ValueError, json.JSONDecodeError, ReviewStoreError):
        raise ReviewStoreCorruptionError("stored review context is invalid") from None
    if expected_context_key != context_key:
        raise ReviewStoreCorruptionError("stored review context key is invalid")
    if canonical_manifest_json != row["manifest_json"] or canonical_manifest_digest != row["manifest_digest"]:
        raise ReviewStoreCorruptionError("stored review manifest is invalid")

    source_path_by_key = {
        source["source_key"]: source["source_path"]
        for source in stored_descriptor["sources"]  # type: ignore[index]
    }
    return row, source_path_by_key, source_sha_by_key, stored_descriptor, manifest_items


def _validate_historical_row(
    stored: dict[str, object],
    *,
    context_key: str,
    source_path_by_key: dict[str, str],
    source_sha_by_key: dict[str, str],
) -> None:
    """Validate a persisted row against the database-owned source binding."""

    if stored["context_key"] != context_key:
        raise ReviewStoreCorruptionError("stored review segment context is invalid")
    source_key = stored["source_key"]
    if not isinstance(source_key, str) or source_key not in source_path_by_key:
        raise ReviewStoreCorruptionError("stored review source descriptor is incomplete")
    expected_path = source_path_by_key[source_key]
    expected_sha = source_sha_by_key.get(source_key)
    if expected_sha is None:
        raise ReviewStoreCorruptionError("stored review source descriptor is incomplete")

    # Historical rows use the same normalized source identity as prepare().
    # The current compatible-row check below additionally requires the exact
    # bound access-path spelling because a read cannot perform prepare's repair.
    try:
        path_matches = _normalize_source_path(stored["source_path"], "source_path") == _normalize_source_path(
            expected_path,
            "source_path",
        )
    except ReviewStoreError:
        raise ReviewStoreCorruptionError("stored review source path is invalid") from None
    if not path_matches:
        raise ReviewStoreCorruptionError("stored review source binding is invalid")
    if stored["source_sha256"] != expected_sha:
        raise ReviewStoreCorruptionError("stored review source binding is invalid")
    record_revision = stored["record_revision"]
    if isinstance(record_revision, bool) or not isinstance(record_revision, int) or record_revision <= 0:
        raise ReviewStoreCorruptionError("stored review record revision is invalid")


def read_review_snapshot(
    database_path: str | Path,
    context_key: str,
    result_revision: str,
) -> dict[str, object]:
    """Read the current persisted review state without changing the database.

    The result has the same shape as ``ReviewStoreV2.prepare`` and intentionally
    omits the engine-level ``status`` wrapper.  Rows whose immutable analysis
    signature no longer matches the current manifest remain visible in
    ``record_revisions`` but are not returned as editable ``segments``.
    """

    canonical_context_key = _require_sha(context_key, "context_key")
    current_result_revision = _bounded_result_revision(result_revision)
    uri = _read_only_uri(database_path)
    connection: sqlite3.Connection | None = None
    try:
        try:
            connection = sqlite3.connect(
                uri,
                uri=True,
                detect_types=sqlite3.PARSE_DECLTYPES,
                check_same_thread=False,
                isolation_level=None,
            )
        except (OSError, sqlite3.Error):
            raise ReviewStoreError("review database cannot be opened") from None
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("BEGIN")

        # Schema validation is intentionally read-only.  In particular, do not
        # construct ReviewStoreV2, whose setup would migrate and backfill owner
        # rows in a normal writable connection.
        ReviewStoreV2._validate_schema(connection)
        (
            context_row,
            source_path_by_key,
            source_sha_by_key,
            _descriptor,
            manifest_items,
        ) = _stored_context(connection, canonical_context_key)
        stored_result_revision = context_row["result_revision"]
        if stored_result_revision != current_result_revision:
            raise ReviewRevisionConflict(
                context_key=canonical_context_key,
                expected_revision=None,
                actual_revision=None,
                message="result_revision does not match current review context",
            )

        stored_rows = connection.execute(
            "SELECT * FROM review_segments_v2 WHERE context_key = ?",
            (canonical_context_key,),
        ).fetchall()
        stored_by_key: dict[tuple[str, int, int], dict[str, object]] = {}
        for raw_row in stored_rows:
            stored = _row_to_record(raw_row)
            key = (stored["source_key"], stored["source_page"], stored["segment_no"])
            if key in stored_by_key:
                raise ReviewStoreCorruptionError("stored review segments contain duplicate logical keys")
            _validate_historical_row(
                stored,
                context_key=canonical_context_key,
                source_path_by_key=source_path_by_key,
                source_sha_by_key=source_sha_by_key,
            )
            stored_by_key[key] = stored

        public_segments: list[dict[str, object]] = []
        record_revisions: list[dict[str, object]] = []
        compatible_by_key: dict[tuple[str, int, int], dict[str, object]] = {}
        for item in manifest_items:
            stored = stored_by_key.get(item.logical_key)
            actual_revision = 0 if stored is None else stored["record_revision"]
            record_revisions.append(
                {
                    "id": item.id,
                    "source_key": item.source_key,
                    "source_page": item.source_page,
                    "segment_no": item.segment_no,
                    "record_revision": actual_revision,
                    "task_id": None if stored is None else stored["task_id"],
                }
            )
            if stored is None:
                continue
            # A changed analysis signature identifies an older decision for
            # this logical item.  Preserve its revision metadata, but never
            # restore that decision into the current editable snapshot.
            if stored["analysis_signature"] != item.analysis_signature:
                continue
            if not _immutable_matches(
                stored,
                item,
                source_sha_by_key[item.source_key],
                include_id=False,
                expected_source_path=source_path_by_key[item.source_key],
            ):
                raise ReviewStoreCorruptionError("stored review segment metadata does not match manifest")

            # prepare() would repair these fields.  A recovery read must never
            # do that, so a row is public only when all current bindings already
            # agree with the stored row.
            if (
                stored["id"] != item.id
                or stored["source_path"] != source_path_by_key[item.source_key]
                or stored["result_revision"] != current_result_revision
            ):
                raise ReviewStoreCorruptionError("stored review segment binding is not current")
            if not _final_rect_is_legal(
                stored["final_rect"],
                stored["crop_mode"],
                item.page_width,
                item.page_height,
                require_final=stored["review_status"] in {"confirmed", "page_confirmed", "group_confirmed"},
            ):
                raise ReviewStoreCorruptionError("stored review segment has an illegal final_rect")
            compatible_by_key[item.logical_key] = stored
            public_segments.append(_public_record(stored))

        if len(compatible_by_key) == len(manifest_items):
            group_confirmed = ReviewStoreV2._group_is_confirmed(
                manifest_items,
                compatible_by_key,
                source_sha_by_key,
                canonical_context_key,
                source_path_by_key,
            )
        else:
            group_confirmed = False

        return {
            "context_key": canonical_context_key,
            "result_revision": current_result_revision,
            "segments": public_segments,
            "record_revisions": record_revisions,
            "group_confirmed": group_confirmed,
        }
    finally:
        if connection is not None:
            try:
                if connection.in_transaction:
                    connection.rollback()
            finally:
                connection.close()


__all__ = [
    "read_review_snapshot",
    "ReviewRevisionConflict",
    "ReviewStoreCorruptionError",
    "ReviewStoreError",
]
