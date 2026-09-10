"""Versioned, context-aware persistence for reviewed PDF segments.

The original :mod:`engine.review_store` schema is intentionally left alone.
This module adds a parallel schema whose logical identity includes the source
path (``source_key``), while the immutable analysis manifest keeps source
metadata separate from user-edited review state.

Only JSON-compatible dictionaries cross this API boundary.  The implementation
uses the legacy record parser for the fields shared with the v1 review store,
then applies the v2 context, manifest, geometry, and compare-and-swap rules.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
from typing import Any, Iterable
from uuid import uuid4

from .db import Database
from .review_store import ReviewStoreError, _record_from_mapping


_HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")
_LOWER_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_CROP_MODES = {"candidate", "manual", "full_page"}
_REVIEW_STATUSES = {
    "pending",
    "needs_review",
    "confirmed",
    "page_confirmed",
    "group_confirmed",
    "blocked",
}
_UTC_ISO8601 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$"
)

_MAX_SEGMENTS = 50_000
_MAX_SOURCES = 10_000
_MAX_RESULT_REVISION = 128
_MAX_ID = 1_024
_MAX_PATH = 32_768
_MAX_FINGERPRINT = 1_024
_MAX_COMPUTATION_VERSION = 256
_MAX_GENERIC_TEXT = 32_768
_MIN_CROP_SIZE = 12.0
_OWNER_KINDS = {"batch", "legacy", "retained"}


class ReviewStoreCorruptionError(ReviewStoreError):
    """Raised when an existing v2 schema, context, or record is malformed."""


def _ddl_statements() -> tuple[str, ...]:
    """Return each v2 migration statement separately.

    Keeping statements as individual ``execute`` calls is deliberate: the
    migration runs inside one explicit transaction and must roll back as a
    unit if any statement fails.
    """

    return (
        """
        CREATE TABLE IF NOT EXISTS review_contexts_v2 (
            context_key TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            descriptor_json TEXT NOT NULL,
            criteria_fingerprint TEXT NOT NULL,
            computation_version TEXT NOT NULL,
            result_revision TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            manifest_digest TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS review_segments_v2 (
            context_key TEXT NOT NULL,
            source_key TEXT NOT NULL,
            source_page INTEGER NOT NULL,
            segment_no INTEGER NOT NULL,
            id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            source_path TEXT NOT NULL,
            source_sha256 TEXT NOT NULL,
            analysis_signature TEXT NOT NULL,
            result_revision TEXT NOT NULL,
            record_revision INTEGER NOT NULL CHECK(record_revision > 0),
            persistable INTEGER NOT NULL CHECK(persistable IN (0, 1)),
            match_x0 REAL,
            match_y0 REAL,
            match_x1 REAL,
            match_y1 REAL,
            candidate_x0 REAL,
            candidate_y0 REAL,
            candidate_x1 REAL,
            candidate_y1 REAL,
            final_x0 REAL,
            final_y0 REAL,
            final_x1 REAL,
            final_y1 REAL,
            page_width REAL NOT NULL,
            page_height REAL NOT NULL,
            layout_fingerprint TEXT NOT NULL,
            confidence REAL NOT NULL,
            auto_full_page INTEGER NOT NULL CHECK(auto_full_page IN (0, 1)),
            crop_mode TEXT NOT NULL,
            review_status TEXT NOT NULL,
            manual_adjusted INTEGER NOT NULL CHECK(manual_adjusted IN (0, 1)),
            reviewed_at TEXT NOT NULL,
            group_operation_id TEXT,
            group_scope_digest TEXT,
            PRIMARY KEY (context_key, source_key, source_page, segment_no),
            FOREIGN KEY (context_key) REFERENCES review_contexts_v2(context_key)
                ON DELETE CASCADE
        )
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_review_segments_v2_context
            ON review_segments_v2(context_key)
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_review_segments_v2_task
            ON review_segments_v2(context_key, task_id)
        """,
        """
        CREATE TABLE IF NOT EXISTS review_context_owners_v2 (
            context_key TEXT NOT NULL,
            owner_kind TEXT NOT NULL CHECK(owner_kind IN ('batch', 'legacy', 'retained')),
            owner_id TEXT NOT NULL,
            PRIMARY KEY (context_key, owner_kind, owner_id),
            FOREIGN KEY (context_key) REFERENCES review_contexts_v2(context_key)
                ON DELETE CASCADE
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS review_cleanup_receipts_v2 (
            context_key TEXT NOT NULL, job_id TEXT NOT NULL, cleanup_id TEXT NOT NULL,
            delete_exclusive INTEGER NOT NULL CHECK(delete_exclusive IN (0, 1)),
            expected_fingerprint TEXT NOT NULL, response_json TEXT NOT NULL,
            PRIMARY KEY(context_key, job_id, cleanup_id)
        )
        """,
    )


_V2_DDL = _ddl_statements()


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, OverflowError):
        raise ReviewStoreError("value must be JSON serializable") from None


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _owner_kind(value: object, field: str = "owner_kind") -> str:
    kind = _bounded_text(value, field, 16)
    if kind not in _OWNER_KINDS:
        raise ReviewStoreError(f"{field} is invalid")
    return kind


def _owner_id(value: object, field: str = "owner_id") -> str:
    return _bounded_text(value, field, _MAX_ID)


def _bounded_text(value: object, field: str, maximum: int, *, non_empty: bool = True) -> str:
    if not isinstance(value, str):
        raise ReviewStoreError(f"{field} must be a string")
    if non_empty and not value.strip():
        raise ReviewStoreError(f"{field} must be a non-empty string")
    if "\x00" in value:
        raise ReviewStoreError(f"{field} contains an invalid character")
    if len(value) > maximum:
        raise ReviewStoreError(f"{field} is too long")
    return value


def _normalize_source_path(value: object, field: str = "source_key") -> str:
    raw = _bounded_text(value, field, _MAX_PATH)
    # ``str.normalize`` is not available; use the standard-library module
    # lazily to keep all path normalization in one small helper.
    import unicodedata

    normalized = unicodedata.normalize("NFC", raw.strip()).replace("\\", "/").lower()
    if not normalized:
        raise ReviewStoreError(f"{field} must be a non-empty string")
    if len(normalized) > _MAX_PATH:
        raise ReviewStoreError(f"{field} is too long")
    return normalized


def _bounded_result_revision(value: object, field: str = "result_revision") -> str:
    return _bounded_text(value, field, _MAX_RESULT_REVISION)


def _require_sha(value: object, field: str, *, lowercase: bool = False) -> str:
    text = _bounded_text(value, field, 64)
    if len(text) != 64 or not _HEX64.fullmatch(text):
        raise ReviewStoreError(f"{field} must be a 64-character hexadecimal string")
    if lowercase and not _LOWER_HEX64.fullmatch(text):
        raise ReviewStoreError(f"{field} must use lowercase hexadecimal characters")
    return text.lower()


def _require_int(value: object, field: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ReviewStoreError(f"{field} must be an integer")
    # SQLite INTEGER is signed 64-bit.  Rejecting larger values before a write
    # gives callers a protocol error instead of a driver OverflowError.
    if value < -(2**63) or value > 2**63 - 1:
        raise ReviewStoreError(f"{field} is out of range")
    if positive and value <= 0:
        raise ReviewStoreError(f"{field} must be a positive integer")
    return value


def _require_number(value: object, field: str, *, positive: bool = False, non_negative: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ReviewStoreError(f"{field} must be a finite number")
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError):
        raise ReviewStoreError(f"{field} must be a finite number") from None
    if not math.isfinite(number):
        raise ReviewStoreError(f"{field} must be a finite number")
    if positive and number <= 0:
        raise ReviewStoreError(f"{field} must be positive")
    if non_negative and number < 0:
        raise ReviewStoreError(f"{field} must be non-negative")
    return number


def _require_bool(value: object, field: str) -> bool:
    if not isinstance(value, bool):
        raise ReviewStoreError(f"{field} must be a boolean")
    return value


def _rect_from_mapping(
    value: object,
    field: str,
    *,
    nullable: bool,
    require_ordered_non_negative: bool = True,
) -> dict[str, float] | None:
    if value is None:
        if nullable:
            return None
        raise ReviewStoreError(f"{field} is required")
    if not isinstance(value, dict):
        raise ReviewStoreError(f"{field} must be a rectangle")
    coordinates: list[float] = []
    for edge in ("x0", "y0", "x1", "y1"):
        if edge not in value:
            raise ReviewStoreError(f"{field} must contain four coordinates")
        coordinates.append(_require_number(value[edge], f"{field}.{edge}", non_negative=False))
    x0, y0, x1, y1 = coordinates
    if require_ordered_non_negative and (x0 < 0 or y0 < 0 or x0 >= x1 or y0 >= y1):
        raise ReviewStoreError(f"{field} must be ordered and non-negative")
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _rect_values(value: dict[str, float] | None) -> tuple[float | None, float | None, float | None, float | None]:
    if value is None:
        return None, None, None, None
    return value["x0"], value["y0"], value["x1"], value["y1"]


def _rect_from_row(row: sqlite3.Row, prefix: str, *, nullable: bool) -> dict[str, float] | None:
    values = tuple(row[f"{prefix}_{edge}"] for edge in ("x0", "y0", "x1", "y1"))
    if all(value is None for value in values):
        if nullable:
            return None
        raise ReviewStoreError(f"stored {prefix} rectangle is missing")
    if any(value is None for value in values):
        raise ReviewStoreError(f"stored {prefix} rectangle is incomplete")
    return _rect_from_mapping(dict(zip(("x0", "y0", "x1", "y1"), values)), prefix, nullable=False)


def _rect_equal(left: dict[str, float] | None, right: dict[str, float] | None) -> bool:
    return _rect_values(left) == _rect_values(right)


def _rect_in_page(rect: dict[str, float], page_width: float, page_height: float, *, minimum: bool) -> bool:
    if not (page_width > 0 and page_height > 0):
        return False
    if not (
        0 <= rect["x0"] < rect["x1"] <= page_width
        and 0 <= rect["y0"] < rect["y1"] <= page_height
    ):
        return False
    if not minimum:
        return True
    width = rect["x1"] - rect["x0"]
    height = rect["y1"] - rect["y0"]
    valid_width = page_width < _MIN_CROP_SIZE and rect["x0"] == 0 and rect["x1"] == page_width
    valid_height = page_height < _MIN_CROP_SIZE and rect["y0"] == 0 and rect["y1"] == page_height
    if page_width >= _MIN_CROP_SIZE:
        valid_width = width >= _MIN_CROP_SIZE
    if page_height >= _MIN_CROP_SIZE:
        valid_height = height >= _MIN_CROP_SIZE
    return valid_width and valid_height


def _final_rect_is_legal(
    final_rect: dict[str, float] | None,
    crop_mode: str,
    page_width: float,
    page_height: float,
    *,
    require_final: bool,
) -> bool:
    if final_rect is None:
        return crop_mode == "full_page" or not require_final
    return _rect_in_page(final_rect, page_width, page_height, minimum=True)


@dataclass(frozen=True, slots=True)
class _ManifestItem:
    id: str
    source_key: str
    source_page: int
    segment_no: int
    analysis_signature: str
    persistable: bool
    page_width: float
    page_height: float
    match_rect: dict[str, float] | None
    candidate_rect: dict[str, float] | None
    layout_fingerprint: str
    confidence: float
    auto_full_page: bool

    @property
    def logical_key(self) -> tuple[str, int, int]:
        return self.source_key, self.source_page, self.segment_no

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "source_key": self.source_key,
            "source_page": self.source_page,
            "segment_no": self.segment_no,
            "analysis_signature": self.analysis_signature,
            "persistable": self.persistable,
            "page_width": self.page_width,
            "page_height": self.page_height,
            "match_rect": self.match_rect,
            "candidate_rect": self.candidate_rect,
            "layout_fingerprint": self.layout_fingerprint,
            "confidence": self.confidence,
            "auto_full_page": self.auto_full_page,
        }


def _validate_context(
    value: object,
    *,
    trusted_aliases: bool = False,
) -> tuple[dict[str, object], dict[str, str], str]:
    if not isinstance(value, dict):
        raise ReviewStoreError("context must be an object")
    version = _require_int(value.get("version"), "context.version")
    if version != 2:
        raise ReviewStoreError("context.version must be 2")
    sources_value = value.get("sources")
    if not isinstance(sources_value, list):
        raise ReviewStoreError("context.sources must be an array")
    if not sources_value:
        raise ReviewStoreError("context.sources must not be empty")
    if len(sources_value) > _MAX_SOURCES:
        raise ReviewStoreError("context.sources exceeds the limit")

    canonical_sources: list[dict[str, str]] = []
    sha_by_key: dict[str, str] = {}
    for source in sources_value:
        if not isinstance(source, dict):
            raise ReviewStoreError("each context source must be an object")
        source_key = _normalize_source_path(source.get("source_key"), "source_key")
        source_path = _normalize_source_path(source.get("source_path"), "source_path")
        if not trusted_aliases and source_path != source_key:
            raise ReviewStoreError("source_path must normalize to source_key")
        source_sha256 = _require_sha(source.get("source_sha256"), "source_sha256")
        if source_key in sha_by_key:
            raise ReviewStoreError("context sources must have unique source_key values")
        sha_by_key[source_key] = source_sha256
        canonical_sources.append(
            {
                "source_key": source_key,
                # Keep the access path spelling in the descriptor.  It is
                # deliberately absent from the context hash, while callers
                # still get the path they supplied for subsequent access.
                "source_path": source["source_path"],
                "source_sha256": source_sha256,
            }
        )

    criteria_fingerprint = _require_sha(
        value.get("criteria_fingerprint"),
        "criteria_fingerprint",
        lowercase=True,
    )
    computation_version = _bounded_text(
        value.get("computation_version"),
        "computation_version",
        _MAX_COMPUTATION_VERSION,
    )
    descriptor: dict[str, object] = {
        "version": 2,
        "sources": canonical_sources,
        "criteria_fingerprint": criteria_fingerprint,
        "computation_version": computation_version,
    }
    key_payload = {
        "version": 2,
        "sources": [
            {"source_key": source["source_key"], "source_sha256": source["source_sha256"]}
            for source in canonical_sources
        ],
        "criteria_fingerprint": criteria_fingerprint,
        "computation_version": computation_version,
    }
    context_key = _sha256_text(_canonical_json(key_payload))
    return descriptor, sha_by_key, context_key


def _descriptor_identity(descriptor: dict[str, object]) -> dict[str, object]:
    """Return the context fields that participate in ``context_key``."""

    return {
        "version": descriptor["version"],
        "sources": [
            {
                "source_key": source["source_key"],
                "source_sha256": source["source_sha256"],
            }
            for source in descriptor["sources"]  # type: ignore[index]
        ],
        "criteria_fingerprint": descriptor["criteria_fingerprint"],
        "computation_version": descriptor["computation_version"],
    }


def _validate_originals(
    value: object,
    source_sha_by_key: dict[str, str],
) -> tuple[list[_ManifestItem], str, str]:
    if not isinstance(value, list):
        raise ReviewStoreError("originals must be an array")
    if len(value) > _MAX_SEGMENTS:
        raise ReviewStoreError("originals exceeds the segment limit")

    items: list[_ManifestItem] = []
    ids: set[str] = set()
    logical_keys: set[tuple[str, int, int]] = set()
    for raw in value:
        if not isinstance(raw, dict):
            raise ReviewStoreError("each original review item must be an object")
        item_id = _bounded_text(raw.get("id"), "id", _MAX_ID)
        if item_id in ids:
            raise ReviewStoreError("original IDs must be unique")
        ids.add(item_id)
        source_key = _normalize_source_path(raw.get("source_key"), "source_key")
        if source_key not in source_sha_by_key:
            raise ReviewStoreError("original source_key is absent from context.sources")
        source_page = _require_int(raw.get("source_page"), "source_page")
        segment_no = _require_int(raw.get("segment_no"), "segment_no", positive=True)
        persistable = _require_bool(raw.get("persistable"), "persistable")
        if persistable and source_page <= 0:
            raise ReviewStoreError("persistable source_page must be positive")
        if persistable:
            page_width = _require_number(raw.get("page_width"), "page_width", positive=True)
            page_height = _require_number(raw.get("page_height"), "page_height", positive=True)
        else:
            # The frontend uses finite zero sentinels when page dimensions are
            # unknown.  Negative dimensions are still malformed input.
            page_width = _require_number(raw.get("page_width"), "page_width", non_negative=True)
            page_height = _require_number(raw.get("page_height"), "page_height", non_negative=True)

        match_rect = _rect_from_mapping(
            raw.get("match_rect"),
            "match_rect",
            nullable=not persistable,
            require_ordered_non_negative=persistable,
        )
        candidate_rect = _rect_from_mapping(
            raw.get("candidate_rect"),
            "candidate_rect",
            nullable=True,
            require_ordered_non_negative=persistable,
        )
        if persistable:
            if not _rect_in_page(match_rect, page_width, page_height, minimum=False):  # type: ignore[arg-type]
                raise ReviewStoreError("match_rect must be inside the page")
            if candidate_rect is not None and not _rect_in_page(candidate_rect, page_width, page_height, minimum=False):
                raise ReviewStoreError("candidate_rect must be inside the page")
        analysis_signature = _require_sha(raw.get("analysis_signature"), "analysis_signature")
        layout_fingerprint = _bounded_text(raw.get("layout_fingerprint"), "layout_fingerprint", _MAX_FINGERPRINT)
        confidence = _require_number(raw.get("confidence"), "confidence")
        if not 0 <= confidence <= 1:
            raise ReviewStoreError("confidence must be between 0 and 1")
        auto_full_page = _require_bool(raw.get("auto_full_page"), "auto_full_page")
        item = _ManifestItem(
            item_id,
            source_key,
            source_page,
            segment_no,
            analysis_signature,
            persistable,
            page_width,
            page_height,
            match_rect,
            candidate_rect,
            layout_fingerprint,
            confidence,
            auto_full_page,
        )
        if item.logical_key in logical_keys:
            raise ReviewStoreError("original logical keys must be unique")
        logical_keys.add(item.logical_key)
        items.append(item)

    manifest_json = _canonical_json([item.to_dict() for item in items])
    manifest_digest = _sha256_text(manifest_json)
    return items, manifest_json, manifest_digest


_MISSING = object()


def _validate_shared_record(
    raw: object,
    *,
    allow_source_alias: bool = False,
) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise ReviewStoreError("each review segment must be an object")
    try:
        parsed = _record_from_mapping(raw)
    except ReviewStoreError:
        raise ReviewStoreError("invalid review segment") from None
    record = parsed.to_dict()
    # ``source_path`` is an access path and must retain its original spelling
    # in responses.  Every comparison below uses its normalized form.
    _normalize_source_path(record["source_path"], "source_path")
    record["id"] = _bounded_text(record["id"], "id", _MAX_ID)
    record["task_id"] = _bounded_text(record["task_id"], "task_id", _MAX_ID)
    record["source_sha256"] = _require_sha(record["source_sha256"], "source_sha256")
    record["source_page"] = _require_int(record["source_page"], "source_page", positive=True)
    record["segment_no"] = _require_int(record["segment_no"], "segment_no", positive=True)
    record["layout_fingerprint"] = _bounded_text(record["layout_fingerprint"], "layout_fingerprint", _MAX_FINGERPRINT)
    record["analysis_signature"] = _require_sha(raw.get("analysis_signature"), "analysis_signature")
    record["context_key"] = _require_sha(raw.get("context_key"), "context_key")
    record["result_revision"] = _bounded_result_revision(raw.get("result_revision"))
    record_revision = _require_int(raw.get("record_revision"), "record_revision")
    if record_revision < 0:
        raise ReviewStoreError("record_revision must be non-negative")
    record["record_revision"] = record_revision
    record["source_key"] = _normalize_source_path(raw.get("source_key"), "source_key")
    record["page_width"] = _require_number(raw.get("page_width"), "page_width", positive=True)
    record["page_height"] = _require_number(raw.get("page_height"), "page_height", positive=True)
    raw_persistable = raw.get("persistable", _MISSING)
    raw_auto_full_page = raw.get("auto_full_page", _MISSING)
    record["persistable"] = (
        None if raw_persistable is _MISSING else _require_bool(raw_persistable, "persistable")
    )
    record["auto_full_page"] = (
        None if raw_auto_full_page is _MISSING else _require_bool(raw_auto_full_page, "auto_full_page")
    )
    if record["persistable"] is False:
        raise ReviewStoreError("non-persistable records cannot be saved")
    if not allow_source_alias and _normalize_source_path(record["source_path"], "source_path") != record["source_key"]:
        raise ReviewStoreError("source_path must normalize to source_key")
    if record["crop_mode"] not in _CROP_MODES or record["review_status"] not in _REVIEW_STATUSES:
        raise ReviewStoreError("unsupported review mode or status")
    match_rect = record["match_rect"]
    candidate_rect = record["candidate_rect"]
    if not isinstance(match_rect, dict) or not _rect_in_page(match_rect, record["page_width"], record["page_height"], minimum=False):  # type: ignore[arg-type]
        raise ReviewStoreError("match_rect must be inside the page")
    if candidate_rect is not None and (
        not isinstance(candidate_rect, dict)
        or not _rect_in_page(candidate_rect, record["page_width"], record["page_height"], minimum=False)  # type: ignore[arg-type]
    ):
        raise ReviewStoreError("candidate_rect must be inside the page")
    if not _final_rect_is_legal(
        record["final_rect"],
        record["crop_mode"],
        record["page_width"],
        record["page_height"],
        require_final=record["review_status"] in {"confirmed", "page_confirmed", "group_confirmed"},
    ):
        raise ReviewStoreError("final_rect is not legal for the page")
    return record


def _immutable_matches(
    record: dict[str, object],
    item: _ManifestItem,
    source_sha256: str,
    *,
    include_id: bool = True,
    expected_source_path: str | None = None,
) -> bool:
    expected_path = item.source_key if expected_source_path is None else expected_source_path
    path_matches = _normalize_source_path(record["source_path"], "source_path") == _normalize_source_path(
        expected_path,
        "source_path",
    )
    return (
        (not include_id or record["id"] == item.id)
        and record["source_key"] == item.source_key
        and path_matches
        and record["source_sha256"] == source_sha256
        and record["source_page"] == item.source_page
        and record["segment_no"] == item.segment_no
        and record["analysis_signature"] == item.analysis_signature
        and (record["persistable"] is None or bool(record["persistable"]) == item.persistable)
        and record["page_width"] == item.page_width
        and record["page_height"] == item.page_height
        and _rect_equal(record["match_rect"], item.match_rect)
        and _rect_equal(record["candidate_rect"], item.candidate_rect)
        and record["layout_fingerprint"] == item.layout_fingerprint
        and record["confidence"] == item.confidence
        and (record["auto_full_page"] is None or bool(record["auto_full_page"]) == item.auto_full_page)
    )


def _group_scope_digest(items: list[_ManifestItem]) -> str:
    scope = [
        {
            "source_key": item.source_key,
            "source_page": item.source_page,
            "segment_no": item.segment_no,
            "analysis_signature": item.analysis_signature,
        }
        for item in items
    ]
    return _sha256_text(_canonical_json(scope))


def _row_to_record(row: sqlite3.Row) -> dict[str, object]:
    try:
        record: dict[str, object] = {
            "id": row["id"],
            "task_id": row["task_id"],
            "source_path": row["source_path"],
            "source_sha256": row["source_sha256"],
            "source_page": row["source_page"],
            "segment_no": row["segment_no"],
            "match_rect": _rect_from_row(row, "match", nullable=False),
            "candidate_rect": _rect_from_row(row, "candidate", nullable=True),
            "final_rect": _rect_from_row(row, "final", nullable=True),
            "layout_fingerprint": row["layout_fingerprint"],
            "confidence": row["confidence"],
            "crop_mode": row["crop_mode"],
            "review_status": row["review_status"],
            "manual_adjusted": row["manual_adjusted"],
            "reviewed_at": row["reviewed_at"],
            "context_key": row["context_key"],
            "source_key": row["source_key"],
            "analysis_signature": row["analysis_signature"],
            "result_revision": row["result_revision"],
            "record_revision": row["record_revision"],
            "page_width": row["page_width"],
            "page_height": row["page_height"],
            "persistable": row["persistable"],
            "auto_full_page": row["auto_full_page"],
        }
        for field in ("persistable", "auto_full_page"):
            if record[field] not in (0, 1):
                raise ReviewStoreError(f"stored {field} value is invalid")
        record["persistable"] = bool(record["persistable"])
        record["auto_full_page"] = bool(record["auto_full_page"])
        if record["manual_adjusted"] not in (0, 1):
            raise ReviewStoreError("stored manual_adjusted value is invalid")
        record["manual_adjusted"] = bool(record["manual_adjusted"])
        # Stored rows may carry a trusted access alias after a batch source
        # relocation.  The owning context descriptor is checked separately
        # by prepare/save before the row is used.
        decoded = _validate_shared_record(record, allow_source_alias=True)
        # A row with a nullable match rectangle or a non-persistable marker is
        # invalid in the v2 segment table, even if SQLite accepted a direct
        # tampering attempt.
        if not decoded["persistable"]:
            raise ReviewStoreError("stored review segment is non-persistable")
        group_operation_id = row["group_operation_id"]
        group_scope_digest = row["group_scope_digest"]
        if group_operation_id is not None:
            group_operation_id = _bounded_text(group_operation_id, "group_operation_id", _MAX_GENERIC_TEXT)
        if group_scope_digest is not None:
            group_scope_digest = _require_sha(group_scope_digest, "group_scope_digest")
        if (group_operation_id is None) != (group_scope_digest is None):
            raise ReviewStoreError("stored group operation metadata is incomplete")
        if decoded["review_status"] == "group_confirmed" and group_operation_id is None:
            raise ReviewStoreError("stored group-confirmed record has no group operation")
        decoded["group_operation_id"] = group_operation_id
        decoded["group_scope_digest"] = group_scope_digest
        return decoded
    except (KeyError, TypeError, ValueError, OverflowError, sqlite3.Error, ReviewStoreError):
        raise ReviewStoreCorruptionError("stored review segment is invalid") from None


def _public_record(record: dict[str, object], *, result_revision: str | None = None, record_revision: int | None = None) -> dict[str, object]:
    result: dict[str, object] = {
        "id": record["id"],
        "task_id": record["task_id"],
        "source_path": record["source_path"],
        "source_sha256": record["source_sha256"],
        "source_page": record["source_page"],
        "segment_no": record["segment_no"],
        "match_rect": record["match_rect"],
        "candidate_rect": record["candidate_rect"],
        "final_rect": record["final_rect"],
        "layout_fingerprint": record["layout_fingerprint"],
        "confidence": record["confidence"],
        "crop_mode": record["crop_mode"],
        "review_status": record["review_status"],
        "manual_adjusted": record["manual_adjusted"],
        "reviewed_at": record["reviewed_at"],
        "context_key": record["context_key"],
        "source_key": record["source_key"],
        "analysis_signature": record["analysis_signature"],
        "result_revision": result_revision if result_revision is not None else record["result_revision"],
        "record_revision": record_revision if record_revision is not None else record["record_revision"],
        "page_width": record["page_width"],
        "page_height": record["page_height"],
    }
    return result


class ReviewRevisionConflict(ReviewStoreError):
    """Raised when a save uses an obsolete per-record revision."""

    def __init__(
        self,
        message: str = "review record revision is stale",
        *,
        context_key: str | None = None,
        record_id: str | None = None,
        expected_revision: int | None = None,
        actual_revision: int | None = None,
    ) -> None:
        super().__init__(message)
        self.context_key = context_key
        self.record_id = record_id
        self.expected_revision = expected_revision
        self.actual_revision = actual_revision


class ReviewStoreV2:
    """SQLite-backed v2 review store with immutable manifests and CAS writes."""

    def __init__(self, database: str | Path | Database = ":memory:") -> None:
        owns_database = not isinstance(database, Database)
        self.database = database if not owns_database else Database(database)
        try:
            self.database.initialize()
            self._migrate_v2()
        except BaseException:
            # ReviewStoreV2 owns only Database instances it creates itself.
            # Do not close an injected Database: its caller may reuse it
            # after a failed v2 setup or migration.
            if owns_database:
                try:
                    self.database.close()
                except Exception:
                    pass
            raise

    @staticmethod
    def context_key(context: object) -> str:
        """Return the stable context key for a validated descriptor."""

        _descriptor, _sha_by_key, context_key = _validate_context(context)
        return context_key

    @property
    def connection(self) -> sqlite3.Connection:
        return self.database.connection

    def _migrate_v2(self) -> None:
        with self.database.transaction() as connection:
            for statement in _V2_DDL:
                connection.execute(statement)
            self._validate_schema(connection)
            self._validate_owner_rows(connection)
            self._backfill_unknown_owners(connection)

    @staticmethod
    def _validate_schema(connection: sqlite3.Connection) -> None:
        required_context_columns = {
            "context_key",
            "version",
            "descriptor_json",
            "criteria_fingerprint",
            "computation_version",
            "result_revision",
            "manifest_json",
            "manifest_digest",
            "created_at",
            "updated_at",
        }
        required_segment_columns = {
            "context_key",
            "source_key",
            "source_page",
            "segment_no",
            "id",
            "task_id",
            "source_path",
            "source_sha256",
            "analysis_signature",
            "result_revision",
            "record_revision",
            "persistable",
            "match_x0",
            "match_y0",
            "match_x1",
            "match_y1",
            "candidate_x0",
            "candidate_y0",
            "candidate_x1",
            "candidate_y1",
            "final_x0",
            "final_y0",
            "final_x1",
            "final_y1",
            "page_width",
            "page_height",
            "layout_fingerprint",
            "confidence",
            "auto_full_page",
            "crop_mode",
            "review_status",
            "manual_adjusted",
            "reviewed_at",
            "group_operation_id",
            "group_scope_digest",
        }
        required_owner_columns = {
            "context_key",
            "owner_kind",
            "owner_id",
        }
        context_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(review_contexts_v2)").fetchall()
        }
        segment_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(review_segments_v2)").fetchall()
        }
        owner_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(review_context_owners_v2)").fetchall()
        }
        owner_info = connection.execute("PRAGMA table_info(review_context_owners_v2)").fetchall()
        owner_primary_key = {
            row["name"] for row in owner_info if row["pk"] in (1, 2, 3)
        }
        owner_foreign_keys = connection.execute("PRAGMA foreign_key_list(review_context_owners_v2)").fetchall()
        if (
            not required_context_columns.issubset(context_columns)
            or not required_segment_columns.issubset(segment_columns)
            or not required_owner_columns.issubset(owner_columns)
            or owner_primary_key != required_owner_columns
            or not any(
                row["table"] == "review_contexts_v2"
                and row["from"] == "context_key"
                and row["to"] == "context_key"
                for row in owner_foreign_keys
            )
        ):
            raise ReviewStoreCorruptionError("v2 review schema is incompatible")

    @staticmethod
    def _validate_owner_rows(connection: sqlite3.Connection) -> None:
        context_keys = {
            row["context_key"]
            for row in connection.execute("SELECT context_key FROM review_contexts_v2").fetchall()
        }
        for row in connection.execute(
            "SELECT context_key, owner_kind, owner_id FROM review_context_owners_v2"
        ).fetchall():
            try:
                context_key = _require_sha(row["context_key"], "owner.context_key")
                _owner_kind(row["owner_kind"], "owner.owner_kind")
                _owner_id(row["owner_id"], "owner.owner_id")
            except ReviewStoreError:
                raise ReviewStoreCorruptionError("stored review ownership is invalid") from None
            if context_key != row["context_key"] or context_key not in context_keys:
                raise ReviewStoreCorruptionError("stored review ownership references an unknown context")

    @staticmethod
    def _backfill_unknown_owners(connection: sqlite3.Connection) -> None:
        rows = connection.execute(
            "SELECT context_key FROM review_contexts_v2"
        ).fetchall()
        for row in rows:
            try:
                context_key = _require_sha(row["context_key"], "context.context_key")
            except ReviewStoreError:
                raise ReviewStoreCorruptionError("stored review context identity is invalid") from None
            if context_key != row["context_key"]:
                raise ReviewStoreCorruptionError("stored review context identity is not canonical")
            owner = connection.execute(
                """
                SELECT 1 FROM review_context_owners_v2
                 WHERE context_key = ?
                 LIMIT 1
                """,
                (context_key,),
            ).fetchone()
            if owner is None:
                connection.execute(
                    """
                    INSERT INTO review_context_owners_v2 (context_key, owner_kind, owner_id)
                    VALUES (?, 'legacy', 'unknown')
                    """,
                    (context_key,),
                )

    @staticmethod
    def _register_owner_connection(
        connection: sqlite3.Connection,
        context_key: str,
        owner_kind: str,
        owner_id: str,
    ) -> None:
        canonical_context_key = _require_sha(context_key, "context_key")
        canonical_owner_kind = _owner_kind(owner_kind)
        canonical_owner_id = _owner_id(owner_id)
        context = connection.execute(
            "SELECT 1 FROM review_contexts_v2 WHERE context_key = ?",
            (canonical_context_key,),
        ).fetchone()
        if context is None:
            raise ReviewStoreError("review context does not exist")
        connection.execute(
            """
            INSERT INTO review_context_owners_v2 (context_key, owner_kind, owner_id)
            VALUES (?, ?, ?)
            ON CONFLICT(context_key, owner_kind, owner_id) DO NOTHING
            """,
            (canonical_context_key, canonical_owner_kind, canonical_owner_id),
        )

    @staticmethod
    def _ownership_fingerprint_connection(
        connection: sqlite3.Connection,
        context_key: str,
        context_row: sqlite3.Row | None = None,
    ) -> str | None:
        row = context_row or connection.execute(
            """
            SELECT result_revision, updated_at
              FROM review_contexts_v2
             WHERE context_key = ?
            """,
            (context_key,),
        ).fetchone()
        if row is None:
            return None
        try:
            result_revision = _bounded_result_revision(row["result_revision"])
            updated_at = _bounded_text(row["updated_at"], "updated_at", 128)
            record_row = connection.execute(
                """
                SELECT COUNT(*) AS record_count,
                       COALESCE(SUM(record_revision), 0) AS record_revision_total,
                       COALESCE(MAX(record_revision), 0) AS record_revision_max
                  FROM review_segments_v2
                 WHERE context_key = ?
                """,
                (context_key,),
            ).fetchone()
            if record_row is None:
                raise ReviewStoreError("review ownership fingerprint is unavailable")
            record_count = _require_int(record_row["record_count"], "record_count", positive=False)
            record_revision_total = _require_int(
                record_row["record_revision_total"],
                "record_revision_total",
                positive=False,
            )
            record_revision_max = _require_int(
                record_row["record_revision_max"],
                "record_revision_max",
                positive=False,
            )
        except (KeyError, TypeError, ValueError, ReviewStoreError):
            raise ReviewStoreCorruptionError("stored review ownership fingerprint is invalid") from None
        return _sha256_text(
            _canonical_json(
                {
                    "result_revision": result_revision,
                    "updated_at": updated_at,
                    "record_count": record_count,
                    "record_revision_total": record_revision_total,
                    "record_revision_max": record_revision_max,
                }
            )
        )

    @staticmethod
    def _ownership_view_connection(
        connection: sqlite3.Connection,
        context_key: str,
        job_id: str,
    ) -> dict[str, object]:
        context_row = connection.execute(
            "SELECT * FROM review_contexts_v2 WHERE context_key = ?",
            (context_key,),
        ).fetchone()
        if context_row is None:
            return {
                "outcome": "already_absent",
                "context_key": context_key,
                "job_id": job_id,
                "record_count": 0,
                "owner_count": 0,
                "owned_by_job": False,
                "other_owner_count": 0,
                "exclusive": False,
                "fingerprint": None,
            }

        # Cleanup is a destructive consumer of the stored binding. Validate
        # historical rows too: they can legitimately be absent from the latest
        # analysis manifest, but must still belong to its immutable source set.
        try:
            descriptor = json.loads(context_row["descriptor_json"])
            ReviewStoreV2._validate_context_row(context_row, descriptor, context_key)
            sources = {source["source_key"]: source for source in descriptor["sources"]}
            for raw in connection.execute("SELECT * FROM review_segments_v2 WHERE context_key = ?", (context_key,)):
                record = _row_to_record(raw)
                source = sources.get(record["source_key"])
                if (source is None or record["source_sha256"] != source["source_sha256"]
                        or _normalize_source_path(record["source_path"]) != _normalize_source_path(source["source_path"])):
                    raise ReviewStoreCorruptionError("stored review source binding is invalid")
        except (KeyError, TypeError, ValueError, ReviewStoreError):
            raise ReviewStoreCorruptionError("stored review cleanup binding is invalid") from None

        ReviewStoreV2._validate_owner_rows(connection)
        owners = connection.execute(
            """
            SELECT owner_kind, owner_id
              FROM review_context_owners_v2
             WHERE context_key = ?
             ORDER BY owner_kind, owner_id
            """,
            (context_key,),
        ).fetchall()
        owned_by_job = any(row["owner_kind"] == "batch" and row["owner_id"] == job_id for row in owners)
        record_row = connection.execute(
            "SELECT COUNT(*) AS record_count FROM review_segments_v2 WHERE context_key = ?",
            (context_key,),
        ).fetchone()
        if record_row is None:
            raise ReviewStoreCorruptionError("stored review ownership records are invalid")
        record_count = _require_int(record_row["record_count"], "record_count")
        fingerprint = ReviewStoreV2._ownership_fingerprint_connection(connection, context_key, context_row)
        owner_count = len(owners)
        other_owner_count = owner_count - int(owned_by_job)
        return {
            "outcome": "ok",
            "context_key": context_key,
            "job_id": job_id,
            "record_count": record_count,
            "owner_count": owner_count,
            "owned_by_job": owned_by_job,
            "other_owner_count": other_owner_count,
            "exclusive": owned_by_job and owner_count == 1,
            "fingerprint": fingerprint,
        }

    def close(self) -> None:
        self.database.close()

    def batch_ownership(self, context_key: object, job_id: object) -> dict[str, object]:
        """Return the bounded ownership and CAS view for one batch context."""

        canonical_context_key = _require_sha(context_key, "context_key")
        canonical_job_id = _owner_id(job_id, "job_id")
        with self.database.transaction() as connection:
            return self._ownership_view_connection(
                connection,
                canonical_context_key,
                canonical_job_id,
            )

    def release_batch_owner(
        self,
        context_key: object,
        job_id: object,
        cleanup_id: object,
        delete_exclusive: object,
        expected_fingerprint: object,
        *,
        force_retained: bool = False,
    ) -> dict[str, object]:
        """Release one batch owner under a review-record CAS check.

        Exclusive deletion removes only v2 rows and is allowed when the
        context still has exactly this batch owner and its fingerprint is
        unchanged.  Shared or explicitly retained contexts keep their
        review rows and receive a durable retained owner when requested.
        """

        canonical_context_key = _require_sha(context_key, "context_key")
        canonical_job_id = _owner_id(job_id, "job_id")
        canonical_cleanup_id = _owner_id(cleanup_id, "cleanup_id")
        should_delete_exclusive = _require_bool(delete_exclusive, "delete_exclusive")
        preserve_for_external_reference = _require_bool(force_retained, "force_retained")
        canonical_expected_fingerprint = _require_sha(
            expected_fingerprint,
            "expected_fingerprint",
            lowercase=True,
        )

        with self.database.transaction() as connection:
            receipt = connection.execute(
                "SELECT * FROM review_cleanup_receipts_v2 WHERE context_key = ? AND job_id = ? AND cleanup_id = ?",
                (canonical_context_key, canonical_job_id, canonical_cleanup_id),
            ).fetchone()
            if receipt is not None:
                if (receipt["delete_exclusive"] != int(should_delete_exclusive)
                        or receipt["expected_fingerprint"] != canonical_expected_fingerprint):
                    raise ReviewStoreError("cleanup operation was already used with a different request")
                try:
                    result = json.loads(receipt["response_json"])
                    if (not isinstance(result, dict) or result["context_key"] != canonical_context_key
                            or result["job_id"] != canonical_job_id or result["cleanup_id"] != canonical_cleanup_id
                            or result["outcome"] not in {"deleted", "retained", "released_shared"}):
                        raise ValueError("invalid receipt")
                except (KeyError, TypeError, ValueError):
                    raise ReviewStoreCorruptionError("stored cleanup receipt is invalid") from None
                return {**result, "original_outcome": result["outcome"],
                        "outcome": "already_absent" if result["outcome"] == "deleted" else "already_released"}

            def completed(result: dict[str, object]) -> dict[str, object]:
                connection.execute(
                    """INSERT INTO review_cleanup_receipts_v2
                       (context_key, job_id, cleanup_id, delete_exclusive, expected_fingerprint, response_json)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (canonical_context_key, canonical_job_id, canonical_cleanup_id, int(should_delete_exclusive),
                     canonical_expected_fingerprint, _canonical_json(result)),
                )
                return result

            view = self._ownership_view_connection(
                connection,
                canonical_context_key,
                canonical_job_id,
            )
            if view["outcome"] == "already_absent":
                return {
                    **view,
                    "cleanup_id": canonical_cleanup_id,
                    "delete_exclusive": should_delete_exclusive,
                    "deleted_record_count": 0,
                }

            current_fingerprint = view["fingerprint"]
            if current_fingerprint != canonical_expected_fingerprint:
                return {
                    **view,
                    "outcome": "changed",
                    "cleanup_id": canonical_cleanup_id,
                    "delete_exclusive": should_delete_exclusive,
                    "deleted_record_count": 0,
                }

            owned_by_job = bool(view["owned_by_job"])
            if not owned_by_job:
                retained = connection.execute(
                    """
                    SELECT 1 FROM review_context_owners_v2
                     WHERE context_key = ? AND owner_kind = 'retained' AND owner_id = ?
                     LIMIT 1
                    """,
                    (canonical_context_key, canonical_cleanup_id),
                ).fetchone()
                return {
                    **view,
                    "outcome": "already_released" if retained is not None else "not_owner",
                    "cleanup_id": canonical_cleanup_id,
                    "delete_exclusive": should_delete_exclusive,
                    "deleted_record_count": 0,
                }

            owner_count = int(view["owner_count"])
            if should_delete_exclusive and not preserve_for_external_reference and owner_count == 1:
                count_row = connection.execute(
                    "SELECT COUNT(*) AS record_count FROM review_segments_v2 WHERE context_key = ?",
                    (canonical_context_key,),
                ).fetchone()
                if count_row is None:
                    raise ReviewStoreCorruptionError("stored review ownership records are invalid")
                deleted_record_count = _require_int(count_row["record_count"], "record_count")
                # Keep deletion order explicit even though the context has an
                # ON DELETE CASCADE foreign key for defensive compatibility.
                connection.execute(
                    "DELETE FROM review_segments_v2 WHERE context_key = ?",
                    (canonical_context_key,),
                )
                connection.execute(
                    "DELETE FROM review_context_owners_v2 WHERE context_key = ?",
                    (canonical_context_key,),
                )
                connection.execute(
                    "DELETE FROM review_contexts_v2 WHERE context_key = ?",
                    (canonical_context_key,),
                )
                return completed({
                    "outcome": "deleted",
                    "context_key": canonical_context_key,
                    "job_id": canonical_job_id,
                    "cleanup_id": canonical_cleanup_id,
                    "delete_exclusive": should_delete_exclusive,
                    "record_count": 0,
                    "owner_count": 0,
                    "owned_by_job": False,
                    "other_owner_count": 0,
                    "exclusive": False,
                    "fingerprint": None,
                    "deleted_record_count": deleted_record_count,
                })

            if should_delete_exclusive and not preserve_for_external_reference:
                connection.execute(
                    """
                    DELETE FROM review_context_owners_v2
                     WHERE context_key = ? AND owner_kind = 'batch' AND owner_id = ?
                    """,
                    (canonical_context_key, canonical_job_id),
                )
                outcome = "released_shared"
            else:
                connection.execute(
                    """
                    INSERT INTO review_context_owners_v2 (context_key, owner_kind, owner_id)
                    VALUES (?, 'retained', ?)
                    ON CONFLICT(context_key, owner_kind, owner_id) DO NOTHING
                    """,
                    (canonical_context_key, canonical_cleanup_id),
                )
                connection.execute(
                    """
                    DELETE FROM review_context_owners_v2
                     WHERE context_key = ? AND owner_kind = 'batch' AND owner_id = ?
                    """,
                    (canonical_context_key, canonical_job_id),
                )
                outcome = "retained"

            final_view = self._ownership_view_connection(
                connection,
                canonical_context_key,
                canonical_job_id,
            )
            return completed({
                **final_view,
                "outcome": outcome,
                "cleanup_id": canonical_cleanup_id,
                "delete_exclusive": should_delete_exclusive,
                "deleted_record_count": 0,
            })

    def __enter__(self) -> "ReviewStoreV2":
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        self.close()

    def prepare(
        self,
        context: object,
        originals: object,
        *,
        result_revision: str,
    ) -> dict[str, object]:
        """Prepare a public review context with canonical source paths."""

        return self._prepare(
            context,
            originals,
            result_revision=result_revision,
            trusted_aliases=False,
            owner_kind="legacy",
            owner_id="public",
        )

    def prepare_batch(
        self,
        context: object,
        originals: object,
        *,
        result_revision: str,
        job_id: str | None = None,
    ) -> dict[str, object]:
        """Prepare a server-attested batch context with access path aliases.

        ``context`` must come from the batch snapshot after the caller has
        independently re-verified each source SHA.  This private-in-practice
        entry point only relaxes the path-to-key equality; descriptor identity
        and every manifest/record invariant remain shared with ``prepare``.
        """

        owner_kind = "batch" if job_id is not None else "legacy"
        owner_id = _owner_id(job_id, "job_id") if job_id is not None else "unattributed"

        return self._prepare(
            context,
            originals,
            result_revision=result_revision,
            trusted_aliases=True,
            owner_kind=owner_kind,
            owner_id=owner_id,
        )

    def _prepare(
        self,
        context: object,
        originals: object,
        *,
        result_revision: str,
        trusted_aliases: bool,
        owner_kind: str,
        owner_id: str,
    ) -> dict[str, object]:
        descriptor, source_sha_by_key, context_key = _validate_context(
            context,
            trusted_aliases=trusted_aliases,
        )
        owner_kind = _owner_kind(owner_kind)
        owner_id = _owner_id(owner_id)
        current_result_revision = _bounded_result_revision(result_revision)
        manifest_items, manifest_json, manifest_digest = _validate_originals(originals, source_sha_by_key)
        descriptor_json = _canonical_json(descriptor)
        source_path_by_key = {
            source["source_key"]: source["source_path"]
            for source in descriptor["sources"]  # type: ignore[index]
        }
        stored_source_path_by_key: dict[str, str] = {}
        stored_source_sha_by_key: dict[str, str] = {}
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM review_contexts_v2 WHERE context_key = ?",
                (context_key,),
            ).fetchone()
            now = _now_utc()
            if row is None:
                connection.execute(
                    """
                    INSERT INTO review_contexts_v2 (
                        context_key, version, descriptor_json, criteria_fingerprint,
                        computation_version, result_revision, manifest_json,
                        manifest_digest, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        context_key,
                        2,
                        descriptor_json,
                        descriptor["criteria_fingerprint"],
                        descriptor["computation_version"],
                        current_result_revision,
                        manifest_json,
                        manifest_digest,
                        now,
                        now,
                    ),
                )
            else:
                self._validate_context_row(row, descriptor, context_key)
                try:
                    stored_descriptor_value = json.loads(row["descriptor_json"])
                except (TypeError, ValueError):
                    raise ReviewStoreCorruptionError("stored review context is invalid") from None
                if not isinstance(stored_descriptor_value, dict):
                    raise ReviewStoreCorruptionError("stored review context is invalid")
                stored_descriptor, stored_source_sha_by_key, stored_context_key = _validate_context(
                    stored_descriptor_value,
                    trusted_aliases=True,
                )
                if stored_context_key != context_key:
                    raise ReviewStoreCorruptionError("stored review context key is invalid")
                stored_source_path_by_key = {
                    source["source_key"]: source["source_path"]
                    for source in stored_descriptor["sources"]  # type: ignore[index]
                }
                stored_revision = row["result_revision"]
                stored_manifest_json = row["manifest_json"]
                if stored_revision == current_result_revision and stored_manifest_json != manifest_json:
                    raise ReviewStoreError("same result_revision cannot register a different manifest")
                if stored_revision != current_result_revision or row["descriptor_json"] != descriptor_json:
                    connection.execute(
                        """
                        UPDATE review_contexts_v2
                        SET version = ?, descriptor_json = ?, criteria_fingerprint = ?,
                            computation_version = ?, result_revision = ?, manifest_json = ?,
                            manifest_digest = ?, updated_at = ?
                        WHERE context_key = ?
                        """,
                        (
                            2,
                            descriptor_json,
                            descriptor["criteria_fingerprint"],
                            descriptor["computation_version"],
                            current_result_revision,
                            manifest_json,
                            manifest_digest,
                            now,
                            context_key,
                        ),
                    )

            self._register_owner_connection(connection, context_key, owner_kind, owner_id)

            rows = connection.execute(
                "SELECT * FROM review_segments_v2 WHERE context_key = ?",
                (context_key,),
            ).fetchall()
            stored_by_key: dict[tuple[str, int, int], dict[str, object]] = {}
            for stored_row in rows:
                decoded = _row_to_record(stored_row)
                key = (
                    decoded["source_key"],
                    decoded["source_page"],
                    decoded["segment_no"],
                )
                if key in stored_by_key:
                    raise ReviewStoreError("stored review segments contain duplicate logical keys")
                stored_by_key[key] = decoded

            # Validate every historical row against the descriptor that was
            # in force when it was written before changing any access paths.
            # Rows omitted from the new analysis manifest still belong to the
            # same immutable source set and must be rebound safely.
            for key, stored in stored_by_key.items():
                source_key = key[0]
                old_source_path = stored_source_path_by_key.get(source_key)
                old_source_sha = stored_source_sha_by_key.get(source_key)
                current_source_path = source_path_by_key.get(source_key)
                if old_source_path is None or old_source_sha is None or current_source_path is None:
                    raise ReviewStoreCorruptionError("stored review source descriptor is incomplete")
                try:
                    stored_path_matches = _normalize_source_path(
                        stored["source_path"],
                        "source_path",
                    ) == _normalize_source_path(old_source_path, "source_path")
                except ReviewStoreError:
                    raise ReviewStoreCorruptionError("stored review source path is invalid") from None
                if not stored_path_matches or stored["source_sha256"] != old_source_sha:
                    raise ReviewStoreCorruptionError("stored review source binding is invalid")
                if stored["source_path"] != current_source_path:
                    connection.execute(
                        """
                        UPDATE review_segments_v2
                           SET source_path = ?
                         WHERE context_key = ? AND source_key = ?
                           AND source_page = ? AND segment_no = ?
                        """,
                        (
                            current_source_path,
                            context_key,
                            source_key,
                            key[1],
                            key[2],
                        ),
                    )
                    stored["source_path"] = current_source_path

            public_segments: list[dict[str, object]] = []
            record_revisions: list[dict[str, object]] = []
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
                if not _immutable_matches(
                    stored,
                    item,
                    source_sha_by_key[item.source_key],
                    include_id=False,
                    expected_source_path=source_path_by_key[item.source_key],
                ):
                    continue
                if not _final_rect_is_legal(
                    stored["final_rect"],
                    stored["crop_mode"],
                    item.page_width,
                    item.page_height,
                    require_final=stored["review_status"] in {"confirmed", "page_confirmed", "group_confirmed"},
                ):
                    raise ReviewStoreError("stored review segment has an illegal final_rect")
                current_source_path = source_path_by_key[item.source_key]
                if (
                    stored["id"] != item.id
                    or stored["source_path"] != current_source_path
                    or stored["result_revision"] != current_result_revision
                ):
                    connection.execute(
                        """
                        UPDATE review_segments_v2
                        SET id = ?, source_path = ?, result_revision = ?
                        WHERE context_key = ? AND source_key = ? AND source_page = ? AND segment_no = ?
                        """,
                        (
                            item.id,
                            current_source_path,
                            current_result_revision,
                            context_key,
                            item.source_key,
                            item.source_page,
                            item.segment_no,
                        ),
                    )
                    stored["id"] = item.id
                    stored["source_path"] = current_source_path
                    stored["result_revision"] = current_result_revision
                stored["context_key"] = context_key
                public_segments.append(_public_record(stored))

            group_confirmed = self._group_is_confirmed(
                manifest_items,
                stored_by_key,
                source_sha_by_key,
                context_key,
                source_path_by_key,
            )

        return {
            "context_key": context_key,
            "result_revision": current_result_revision,
            "segments": public_segments,
            "record_revisions": record_revisions,
            "group_confirmed": group_confirmed,
        }

    @staticmethod
    def _validate_context_row(row: sqlite3.Row, descriptor: dict[str, object], context_key: str) -> None:
        try:
            if row["context_key"] != context_key or row["version"] != 2:
                raise ReviewStoreError("stored review context is invalid")
            stored_descriptor = json.loads(row["descriptor_json"])
            stored_manifest = json.loads(row["manifest_json"])
            if not isinstance(stored_descriptor, dict) or not isinstance(stored_manifest, list):
                raise ReviewStoreError("stored review context is invalid")
            stored_descriptor, source_sha_by_key, stored_context_key = _validate_context(
                stored_descriptor,
                trusted_aliases=True,
            )
            if stored_context_key != context_key or _descriptor_identity(stored_descriptor) != _descriptor_identity(descriptor):
                raise ReviewStoreError("stored review context descriptor does not match context key")
            if _canonical_json(stored_descriptor) != row["descriptor_json"]:
                raise ReviewStoreError("stored review context descriptor is not canonical")
            _bounded_result_revision(row["result_revision"])
            if row["criteria_fingerprint"] != descriptor["criteria_fingerprint"]:
                raise ReviewStoreError("stored review context criteria is invalid")
            if row["computation_version"] != descriptor["computation_version"]:
                raise ReviewStoreError("stored review context computation version is invalid")
            if _require_sha(row["manifest_digest"], "manifest_digest") != _sha256_text(row["manifest_json"]):
                raise ReviewStoreError("stored review manifest digest is invalid")
            _items, canonical_manifest_json, canonical_manifest_digest = _validate_originals(
                stored_manifest,
                source_sha_by_key,
            )
            if canonical_manifest_json != row["manifest_json"] or canonical_manifest_digest != row["manifest_digest"]:
                raise ReviewStoreError("stored review manifest is invalid")
        except (KeyError, TypeError, ValueError, ReviewStoreError):
            raise ReviewStoreCorruptionError("stored review context is invalid") from None

    @staticmethod
    def _group_is_confirmed(
        items: list[_ManifestItem],
        stored_by_key: dict[tuple[str, int, int], dict[str, object]],
        source_sha_by_key: dict[str, str],
        context_key: str,
        source_path_by_key: dict[str, str],
    ) -> bool:
        if not items or any(not item.persistable for item in items):
            return False
        operations: set[str] = set()
        scopes: set[str] = set()
        for item in items:
            stored = stored_by_key.get(item.logical_key)
            if stored is None or stored["context_key"] != context_key:
                return False
            if not _immutable_matches(
                stored,
                item,
                source_sha_by_key[item.source_key],
                include_id=False,
                expected_source_path=source_path_by_key.get(item.source_key),
            ):
                return False
            if stored["review_status"] != "group_confirmed":
                return False
            if not _final_rect_is_legal(
                stored["final_rect"],
                stored["crop_mode"],
                item.page_width,
                item.page_height,
                require_final=True,
            ):
                return False
            operation = stored.get("group_operation_id")
            scope = stored.get("group_scope_digest")
            if not isinstance(operation, str) or not isinstance(scope, str):
                return False
            operations.add(operation)
            scopes.add(scope)
        return len(operations) == 1 and scopes == {_group_scope_digest(items)}

    def save(
        self,
        context_key: str,
        result_revision: str,
        records: object,
        *,
        confirm_group: bool = False,
    ) -> dict[str, object]:
        canonical_context_key = _require_sha(context_key, "context_key")
        current_result_revision = _bounded_result_revision(result_revision)
        confirm_group = _require_bool(confirm_group, "confirm_group")
        if not isinstance(records, list):
            raise ReviewStoreError("records must be an array")
        if len(records) > _MAX_SEGMENTS:
            raise ReviewStoreError("records exceeds the segment limit")
        # Alias paths are admitted only after the stored context descriptor
        # binds source_key to the server's current access path below.
        parsed_records = [
            _validate_shared_record(value, allow_source_alias=True)
            for value in records
        ]
        ids: set[str] = set()
        logical_keys: set[tuple[str, int, int]] = set()
        for record in parsed_records:
            if record["context_key"] != canonical_context_key:
                raise ReviewStoreError("record context_key does not match request")
            if record["result_revision"] != current_result_revision:
                raise ReviewStoreError("record result_revision does not match request")
            if record["id"] in ids:
                raise ReviewStoreError("records must have unique IDs")
            ids.add(record["id"])
            key = (record["source_key"], record["source_page"], record["segment_no"])
            if key in logical_keys:
                raise ReviewStoreError("records must have unique logical keys")
            logical_keys.add(key)

        with self.database.transaction() as connection:
            context_row = connection.execute(
                "SELECT * FROM review_contexts_v2 WHERE context_key = ?",
                (canonical_context_key,),
            ).fetchone()
            if context_row is None:
                raise ReviewStoreError("review context does not exist")
            try:
                descriptor = json.loads(context_row["descriptor_json"])
                manifest_json = context_row["manifest_json"]
            except (TypeError, ValueError):
                raise ReviewStoreCorruptionError("stored review context is invalid") from None
            if not isinstance(descriptor, dict):
                raise ReviewStoreCorruptionError("stored review context is invalid")
            self._validate_context_row(context_row, descriptor, canonical_context_key)
            try:
                _stored_descriptor, source_sha_by_key, expected_context_key = _validate_context(
                    descriptor,
                    trusted_aliases=True,
                )
            except ReviewStoreError:
                raise ReviewStoreCorruptionError("stored review context is invalid") from None
            if expected_context_key != canonical_context_key:
                raise ReviewStoreCorruptionError("stored review context key is invalid")
            source_path_by_key = {
                source["source_key"]: source["source_path"]
                for source in _stored_descriptor["sources"]  # type: ignore[index]
            }
            if context_row["result_revision"] != current_result_revision:
                raise ReviewRevisionConflict(
                    context_key=canonical_context_key,
                    expected_revision=None,
                    actual_revision=None,
                    message="result_revision does not match current review context",
                )
            try:
                manifest_raw = json.loads(manifest_json)
            except (TypeError, ValueError):
                raise ReviewStoreCorruptionError("stored review manifest is invalid") from None
            try:
                manifest_items, expected_manifest_json, _manifest_digest = _validate_originals(manifest_raw, source_sha_by_key)
            except ReviewStoreError:
                raise ReviewStoreCorruptionError("stored review manifest is invalid") from None
            if expected_manifest_json != manifest_json:
                raise ReviewStoreCorruptionError("stored review manifest is invalid")
            item_by_key = {item.logical_key: item for item in manifest_items}

            stored_rows = connection.execute(
                "SELECT * FROM review_segments_v2 WHERE context_key = ?",
                (canonical_context_key,),
            ).fetchall()
            stored_by_key: dict[tuple[str, int, int], dict[str, object]] = {}
            for stored_row in stored_rows:
                stored = _row_to_record(stored_row)
                key = (stored["source_key"], stored["source_page"], stored["segment_no"])
                if key in stored_by_key:
                    raise ReviewStoreError("stored review segments contain duplicate logical keys")
                stored_by_key[key] = stored

            prepared: list[tuple[dict[str, object], _ManifestItem, dict[str, object] | None, int]] = []
            for record in parsed_records:
                item = item_by_key.get((record["source_key"], record["source_page"], record["segment_no"]))
                if item is None or item.id != record["id"]:
                    raise ReviewStoreError("record logical key is absent from the manifest")
                if not item.persistable:
                    raise ReviewStoreError("non-persistable manifest items cannot be saved")
                if record["source_sha256"] != source_sha_by_key[item.source_key]:
                    raise ReviewStoreError("record source_sha256 does not match context source")
                if not _immutable_matches(
                    record,
                    item,
                    source_sha_by_key[item.source_key],
                    expected_source_path=source_path_by_key.get(item.source_key),
                ):
                    raise ReviewStoreError("record analysis metadata does not match manifest")
                stored = stored_by_key.get(item.logical_key)
                expected_revision = record["record_revision"]
                if stored is None:
                    if expected_revision != 0:
                        raise ReviewRevisionConflict(
                            context_key=canonical_context_key,
                            record_id=item.id,
                            expected_revision=expected_revision,
                            actual_revision=0,
                        )
                    actual_revision = 0
                else:
                    expected_path = source_path_by_key.get(item.source_key)
                    if expected_path is None:
                        raise ReviewStoreCorruptionError("stored review source descriptor is incomplete")
                    try:
                        stored_path_matches = _normalize_source_path(
                            stored["source_path"],
                            "source_path",
                        ) == _normalize_source_path(expected_path, "source_path")
                    except ReviewStoreError:
                        raise ReviewStoreCorruptionError("stored review source path is invalid") from None
                    if not stored_path_matches or stored["source_sha256"] != source_sha_by_key[item.source_key]:
                        raise ReviewStoreCorruptionError("stored review source binding is invalid")
                    actual_revision = stored["record_revision"]
                    if expected_revision != actual_revision:
                        raise ReviewRevisionConflict(
                            context_key=canonical_context_key,
                            record_id=item.id,
                            expected_revision=expected_revision,
                            actual_revision=actual_revision,
                        )
                    # ``task_id`` is retained for legacy association and is
                    # immutable once a v2 row exists.
                    if record["task_id"] != stored["task_id"]:
                        raise ReviewStoreError("task_id cannot change for an existing v2 record")
                prepared.append((record, item, stored, actual_revision + 1))

            if confirm_group:
                if not manifest_items:
                    raise ReviewStoreError("group confirmation requires a non-empty manifest")
                if len(parsed_records) != len(manifest_items) or any(
                    item.logical_key not in logical_keys for item in manifest_items
                ):
                    raise ReviewStoreError("group confirmation must cover the complete manifest")
                if any(not item.persistable for item in manifest_items):
                    raise ReviewStoreError("group confirmation cannot include non-persistable items")
                if any(record["review_status"] != "group_confirmed" for record in parsed_records):
                    raise ReviewStoreError("all records must be group_confirmed")
                for record in parsed_records:
                    if not _final_rect_is_legal(
                        record["final_rect"],
                        record["crop_mode"],
                        record["page_width"],
                        record["page_height"],
                        require_final=True,
                    ):
                        raise ReviewStoreError("group confirmation contains an illegal final_rect")
                group_operation_id = uuid4().hex
                group_scope_digest = _group_scope_digest(manifest_items)
            else:
                if any(record["review_status"] == "group_confirmed" for record in parsed_records):
                    raise ReviewStoreError("ordinary save cannot write group_confirmed records")
                group_operation_id = None
                group_scope_digest = None

            for record, item, stored, new_revision in prepared:
                self._upsert_connection(
                    connection,
                    record,
                    item,
                    source_sha_by_key[item.source_key],
                    current_result_revision,
                    new_revision,
                    record["source_path"],
                    group_operation_id,
                    group_scope_digest,
                )

            saved_records: list[dict[str, object]] = []
            # Preserve manifest order in complete group responses and make
            # partial responses deterministic even if the caller sends a
            # different order.
            by_key = {
                (record["source_key"], record["source_page"], record["segment_no"]): (record, revision)
                for record, _item, _stored, revision in prepared
            }
            for item in manifest_items:
                value = by_key.get(item.logical_key)
                if value is None:
                    continue
                record, revision = value
                saved_records.append(
                    _public_record(
                        record,
                        result_revision=current_result_revision,
                        record_revision=revision,
                    )
                )

        return {
            "context_key": canonical_context_key,
            "result_revision": current_result_revision,
            "saved_count": len(saved_records),
            "segments": saved_records,
        }

    @staticmethod
    def _upsert_connection(
        connection: sqlite3.Connection,
        record: dict[str, object],
        item: _ManifestItem,
        source_sha256: str,
        result_revision: str,
        record_revision: int,
        source_path: str,
        group_operation_id: str | None,
        group_scope_digest: str | None,
    ) -> None:
        match = _rect_values(record["match_rect"])
        candidate = _rect_values(record["candidate_rect"])
        final = _rect_values(record["final_rect"])
        connection.execute(
            """
            INSERT INTO review_segments_v2 (
                context_key, source_key, source_page, segment_no, id, task_id,
                source_path, source_sha256, analysis_signature, result_revision,
                record_revision, persistable,
                match_x0, match_y0, match_x1, match_y1,
                candidate_x0, candidate_y0, candidate_x1, candidate_y1,
                final_x0, final_y0, final_x1, final_y1,
                page_width, page_height, layout_fingerprint, confidence,
                auto_full_page, crop_mode, review_status, manual_adjusted,
                reviewed_at, group_operation_id, group_scope_digest
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(context_key, source_key, source_page, segment_no) DO UPDATE SET
                id = excluded.id,
                task_id = excluded.task_id,
                source_path = excluded.source_path,
                source_sha256 = excluded.source_sha256,
                analysis_signature = excluded.analysis_signature,
                result_revision = excluded.result_revision,
                record_revision = excluded.record_revision,
                persistable = excluded.persistable,
                match_x0 = excluded.match_x0, match_y0 = excluded.match_y0,
                match_x1 = excluded.match_x1, match_y1 = excluded.match_y1,
                candidate_x0 = excluded.candidate_x0, candidate_y0 = excluded.candidate_y0,
                candidate_x1 = excluded.candidate_x1, candidate_y1 = excluded.candidate_y1,
                final_x0 = excluded.final_x0, final_y0 = excluded.final_y0,
                final_x1 = excluded.final_x1, final_y1 = excluded.final_y1,
                page_width = excluded.page_width, page_height = excluded.page_height,
                layout_fingerprint = excluded.layout_fingerprint,
                confidence = excluded.confidence,
                auto_full_page = excluded.auto_full_page,
                crop_mode = excluded.crop_mode,
                review_status = excluded.review_status,
                manual_adjusted = excluded.manual_adjusted,
                reviewed_at = excluded.reviewed_at,
                group_operation_id = excluded.group_operation_id,
                group_scope_digest = excluded.group_scope_digest
            """,
            (
                record["context_key"],
                item.source_key,
                item.source_page,
                item.segment_no,
                item.id,
                record["task_id"],
                source_path,
                source_sha256,
                item.analysis_signature,
                result_revision,
                record_revision,
                int(item.persistable),
                *match,
                *candidate,
                *final,
                item.page_width,
                item.page_height,
                item.layout_fingerprint,
                item.confidence,
                int(item.auto_full_page),
                record["crop_mode"],
                record["review_status"],
                int(record["manual_adjusted"]),
                record["reviewed_at"],
                group_operation_id,
                group_scope_digest,
            ),
        )


__all__ = [
    "ReviewStoreV2",
    "ReviewRevisionConflict",
    "ReviewStoreCorruptionError",
    "ReviewStoreError",
]
