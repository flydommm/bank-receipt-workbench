"""Pure, bounded models for schema-3 receipt review persistence.

This module is deliberately independent from the review store.  It validates
the immutable analysis manifest produced by :mod:`receipt_snapshot`, validates
the small mutable edit submitted by a client, and binds both into the shape a
future store can read or write.  No PDF, database, IPC, or capability code is
used here.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta
import hashlib
import json
import math
import re
import unicodedata
from typing import Any

from .batch_models import (
    MAX_IDENTIFIER_BYTES,
    MAX_JSON_BYTES,
    MAX_PATH_BYTES,
    MAX_RESULTS_PAGE_BYTES,
    MAX_SOURCES,
    MAX_VERSION_BYTES,
    clone_json,
    normalize_match_mode,
)
from .receipt_layout_models import (
    MAX_LAYOUT_SLOTS,
    MAX_SAFE_INTEGER,
    MIN_CROP_SIZE,
    make_instance_id,
    near,
    parse_page_geometry,
    parse_processing_options,
)
from .receipt_snapshot import processing_fingerprint
from .receipt_classification import MANUAL_DOCUMENT_TYPES


RECEIPT_REVIEW_CONTEXT_VERSION = 3
RECEIPT_REVIEW_EDIT_SCHEMA_VERSION = 1
MAX_RECEIPT_REVIEW_ORIGINALS = 50_000
MAX_RECEIPT_REVIEW_SOURCES = MAX_SOURCES
MAX_RECEIPT_REVIEW_ITEM_BYTES = MAX_RESULTS_PAGE_BYTES
# A manifest is assembled item-by-item, so its collection budget must be
# independent from the per-item JSON budget.  This keeps ordinary large
# snapshots within the 50,000-item bound without giving any one item an
# unbounded payload.
MAX_RECEIPT_REVIEW_MANIFEST_BYTES = 128 * 1024 * 1024
MAX_RECEIPT_REVIEW_EDIT_BYTES = MAX_RESULTS_PAGE_BYTES
MAX_RECEIPT_REVIEW_RECORD_BYTES = MAX_RESULTS_PAGE_BYTES

_SHA = re.compile(r"[a-f0-9]{64}\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_RECT_FIELDS = ("x0", "y0", "x1", "y1")
_CONTEXT_FIELDS = frozenset({
    "version", "sources", "processing_options", "match_mode",
    "criteria_fingerprint", "computation_version",
})
_SOURCE_FIELDS = frozenset({"source_key", "source_path", "source_sha256"})
_ORIGINAL_FIELDS = frozenset({
    "id", "source_key", "source_page", "instance_id", "slot_id", "position_index",
    "layout_id", "layout_revision", "layout_signature", "page_geometry",
    "candidate_rect", "occupancy", "selection_basis", "needs_review", "analysis_signature",
})
_EDIT_FIELDS = frozenset({
    "schema_version", "context_key", "result_revision", "id", "source_key", "instance_id",
    "analysis_signature", "record_revision", "final_rect", "crop_mode", "review_status",
    "manual_adjusted", "reviewed_at",
})
_RECORD_FIELDS = frozenset({
    "schema_version", "context_key", "result_revision", "record_revision", "source_path",
    "source_sha256", "original", "final_rect", "crop_mode", "review_status",
    "manual_adjusted", "reviewed_at",
})
_CLASSIFICATION_FIELDS = frozenset({"document_type"})
_CROP_MODES = frozenset({"candidate", "manual", "full_page"})
# This is the old review status set without group_confirmed.  Group-wide
# confirmation belongs to the guided workflow, never to one durable edit.
_REVIEW_STATUSES = frozenset({"pending", "needs_review", "confirmed", "page_confirmed", "blocked", "excluded"})
_UTC_ISO8601 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")


class ReceiptReviewError(ValueError):
    """A value violates the schema-3 receipt review contract."""


def _fail(message: str) -> None:
    raise ReceiptReviewError(message)


def _text(value: object, field: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        _fail(f"{field} must be a non-empty string")
    try:
        if len(value.encode("utf-8", "strict")) > maximum:
            _fail(f"{field} is too long")
    except UnicodeError:
        _fail(f"{field} must be valid UTF-8")
    return value


def _sha(value: object, field: str) -> str:
    text = _text(value, field, 64)
    if _SHA.fullmatch(text) is None:
        _fail(f"{field} must be a lowercase SHA-256 digest")
    return text


def _safe_revision(value: object, field: str, *, positive: bool = False) -> int:
    if type(value) is not int or value < (1 if positive else 0) or value > MAX_SAFE_INTEGER:
        _fail(f"{field} must be a safe {'positive' if positive else 'non-negative'} integer")
    return value


def _number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{field} must be a finite number")
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError):
        _fail(f"{field} must be a finite number")
    if not math.isfinite(number):
        _fail(f"{field} must be a finite number")
    return number


def _boolean(value: object, field: str) -> bool:
    if type(value) is not bool:
        _fail(f"{field} must be a boolean")
    return value


def _normalize_path(value: object, field: str) -> str:
    raw = _text(value, field, MAX_PATH_BYTES)
    normalized = unicodedata.normalize("NFC", raw.strip()).replace("\\", "/").lower()
    if not normalized or not _is_absolute_path(normalized):
        _fail(f"{field} must be an absolute path")
    return normalized


def _is_absolute_path(value: str) -> bool:
    return value.startswith("/") or bool(re.match(r"^[A-Za-z]:/", value))


def _clone(value: object, *, max_bytes: int, field: str) -> Any:
    try:
        return clone_json(value, max_bytes=max_bytes)
    except (ValueError, TypeError, OverflowError, UnicodeError, RecursionError) as exc:
        raise ReceiptReviewError(f"{field} is not bounded JSON") from exc


def _canonical_bytes(value: object, *, max_bytes: int = MAX_JSON_BYTES) -> bytes:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8", "strict")
    except (TypeError, ValueError, OverflowError, UnicodeError) as exc:
        raise ReceiptReviewError("value is not canonical JSON") from exc
    if len(encoded) > max_bytes:
        _fail("canonical JSON exceeds the limit")
    return encoded


def _same_rect(left: Mapping[str, float], right: Mapping[str, float]) -> bool:
    return all(near(left[field], right[field]) for field in _RECT_FIELDS)


def _contains(outer: Mapping[str, float], inner: Mapping[str, float]) -> bool:
    return (
        (outer["x0"] <= inner["x0"] or near(outer["x0"], inner["x0"]))
        and (outer["y0"] <= inner["y0"] or near(outer["y0"], inner["y0"]))
        and (inner["x1"] <= outer["x1"] or near(inner["x1"], outer["x1"]))
        and (inner["y1"] <= outer["y1"] or near(inner["y1"], outer["y1"]))
    )


def _rect(value: object, field: str, *, geometry: Mapping[str, object] | None = None,
          minimum: bool = False, nullable: bool = False) -> dict[str, float] | None:
    if value is None:
        if nullable:
            return None
        _fail(f"{field} is required")
    if not isinstance(value, dict) or set(value) != set(_RECT_FIELDS):
        _fail(f"{field} must contain exactly four coordinates")
    result = {edge: _number(value[edge], f"{field}.{edge}") for edge in _RECT_FIELDS}
    x0, y0, x1, y1 = (result[edge] for edge in _RECT_FIELDS)
    if not (x0 >= 0 or near(x0, 0)) or not (y0 >= 0 or near(y0, 0)) or x0 >= x1 or y0 >= y1:
        _fail(f"{field} must be ordered and non-negative")
    if geometry is None:
        return result

    width = _number(geometry["width_pt"], "page_geometry.width_pt")
    height = _number(geometry["height_pt"], "page_geometry.height_pt")
    for axis, size in (("x", width), ("y", height)):
        start, end = result[axis + "0"], result[axis + "1"]
        if not (start >= 0 or near(start, 0)) or not (end <= size or near(end, size)):
            _fail(f"{field} must be inside the visible page")
        if minimum:
            extent = end - start
            if size < MIN_CROP_SIZE:
                if not (near(start, 0) and near(end, size)):
                    _fail(f"{field} must retain a small page dimension in full")
            elif extent < MIN_CROP_SIZE and not near(extent, MIN_CROP_SIZE):
                _fail(f"{field} is below the minimum crop size")
    return result


def _reviewed_at(value: object) -> str:
    if not isinstance(value, str) or _UTC_ISO8601.fullmatch(value) is None:
        _fail("reviewed_at must be an ISO-8601 UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        _fail("reviewed_at must be an ISO-8601 UTC timestamp")
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        _fail("reviewed_at must be an ISO-8601 UTC timestamp")
    return value


def _context_sources(value: object, *, trusted_aliases: bool) -> tuple[list[dict[str, str]], dict[str, str]]:
    if not isinstance(value, list) or not value or len(value) > MAX_RECEIPT_REVIEW_SOURCES:
        _fail("context.sources must be a non-empty bounded array")
    sources: list[dict[str, str]] = []
    sha_by_key: dict[str, str] = {}
    for index, raw in enumerate(value):
        source = _clone(raw, max_bytes=MAX_RECEIPT_REVIEW_ITEM_BYTES, field=f"context.sources[{index}]")
        if not isinstance(source, dict) or set(source) != _SOURCE_FIELDS:
            _fail(f"context.sources[{index}] has an invalid shape")
        source_key = _normalize_path(source["source_key"], f"context.sources[{index}].source_key")
        source_path = _normalize_path(source["source_path"], f"context.sources[{index}].source_path")
        source_sha256 = _sha(source["source_sha256"], f"context.sources[{index}].source_sha256")
        if not trusted_aliases and source_path != source_key:
            _fail("source_path must normalize to source_key without trusted aliases")
        if source_key in sha_by_key:
            _fail("context sources must have unique source_key values")
        sha_by_key[source_key] = source_sha256
        # source_path is an access path.  Preserve its spelling while using
        # the normalized source_key as the immutable identity component.
        sources.append({
            "source_key": source_key,
            "source_path": source["source_path"],
            "source_sha256": source_sha256,
        })
    return sources, sha_by_key


def validate_receipt_context(value: object, trusted_aliases: bool = False) -> tuple[dict[str, Any], dict[str, str], str]:
    """Validate a schema-3 snapshot context and return its stable identity.

    ``source_path`` is retained for access but omitted from ``context_key``.
    Callers may set ``trusted_aliases`` only after independently verifying a
    relocated access path against the source SHA.
    """

    try:
        if type(trusted_aliases) is not bool:
            _fail("trusted_aliases must be a boolean")
        context = _clone(value, max_bytes=MAX_JSON_BYTES, field="context")
        if not isinstance(context, dict) or set(context) != _CONTEXT_FIELDS:
            _fail("context must contain exactly the schema-3 fields")
        if type(context["version"]) is not int or context["version"] != RECEIPT_REVIEW_CONTEXT_VERSION:
            _fail("context.version must be 3")
        sources, sha_by_key = _context_sources(context["sources"], trusted_aliases=trusted_aliases)
        try:
            options = parse_processing_options(context["processing_options"])
            match_mode = normalize_match_mode(context["match_mode"])
            expected_fingerprint = processing_fingerprint(options, match_mode)
        except (ValueError, TypeError, OverflowError) as exc:
            raise ReceiptReviewError("invalid receipt processing context") from exc
        fingerprint = _sha(context["criteria_fingerprint"], "criteria_fingerprint")
        if fingerprint != expected_fingerprint:
            _fail("criteria_fingerprint does not match processing_options and match_mode")
        computation_version = _text(context["computation_version"], "computation_version", MAX_VERSION_BYTES)
        descriptor: dict[str, Any] = {
            "version": RECEIPT_REVIEW_CONTEXT_VERSION,
            "sources": sources,
            "processing_options": _clone(options, max_bytes=MAX_RECEIPT_REVIEW_ITEM_BYTES,
                                          field="processing_options"),
            "match_mode": match_mode,
            "criteria_fingerprint": fingerprint,
            "computation_version": computation_version,
        }
        identity = {
            "version": RECEIPT_REVIEW_CONTEXT_VERSION,
            "sources": [
                {"source_key": source["source_key"], "source_sha256": source["source_sha256"]}
                for source in sources
            ],
            "processing_options": descriptor["processing_options"],
            "match_mode": match_mode,
            "criteria_fingerprint": fingerprint,
            "computation_version": computation_version,
        }
        context_key = hashlib.sha256(_canonical_bytes(identity)).hexdigest()
        return descriptor, dict(sha_by_key), context_key
    except ReceiptReviewError:
        raise
    except (ValueError, TypeError, OverflowError, UnicodeError) as exc:
        raise ReceiptReviewError("invalid receipt context") from exc


def _source_map(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        _fail("source_sha_by_key must be an object")
    if len(value) > MAX_RECEIPT_REVIEW_SOURCES:
        _fail("source_sha_by_key exceeds the source limit")
    result: dict[str, str] = {}
    for index, (raw_key, raw_sha) in enumerate(value.items()):
        key = _normalize_path(raw_key, f"source_sha_by_key[{index}].source_key")
        sha = _sha(raw_sha, f"source_sha_by_key[{index}].source_sha256")
        if key in result:
            _fail("source_sha_by_key contains duplicate normalized keys")
        result[key] = sha
    return result


def _validate_original_item(raw: object, source_sha_by_key: Mapping[str, str], *, index: int) -> dict[str, Any]:
    original = _clone(raw, max_bytes=MAX_RECEIPT_REVIEW_ITEM_BYTES, field=f"originals[{index}]")
    if not isinstance(original, dict) or set(original) != _ORIGINAL_FIELDS:
        _fail(f"originals[{index}] has an invalid shape")
    item_id = _sha(original["id"], f"originals[{index}].id")
    source_key = _normalize_path(original["source_key"], f"originals[{index}].source_key")
    if original["source_key"] != source_key:
        _fail(f"originals[{index}].source_key must be normalized")
    source_sha256 = source_sha_by_key.get(source_key)
    if source_sha256 is None:
        _fail(f"originals[{index}].source_key is absent from the context")
    source_page = _safe_revision(original["source_page"], f"originals[{index}].source_page", positive=True)
    position_index = _safe_revision(original["position_index"], f"originals[{index}].position_index", positive=True)
    if position_index > MAX_LAYOUT_SLOTS:
        _fail(f"originals[{index}].position_index exceeds the slot limit")
    layout_revision = _safe_revision(original["layout_revision"], f"originals[{index}].layout_revision", positive=True)
    for field in ("slot_id", "layout_id"):
        if not isinstance(original[field], str) or _ID.fullmatch(original[field]) is None:
            _fail(f"originals[{index}].{field} is invalid")
    for field in ("layout_signature", "analysis_signature"):
        _sha(original[field], f"originals[{index}].{field}")
    try:
        geometry = parse_page_geometry(original["page_geometry"])
    except (ValueError, TypeError, OverflowError) as exc:
        raise ReceiptReviewError(f"originals[{index}].page_geometry is invalid") from exc
    candidate = _rect(original["candidate_rect"], f"originals[{index}].candidate_rect",
                      geometry=geometry, minimum=True)
    assert candidate is not None
    expected_instance = make_instance_id(
        source_sha256,
        source_page,
        {"layout_id": original["layout_id"], "revision": layout_revision,
         "slots": [{"slot_id": original["slot_id"]}]},
        original["slot_id"],
    )
    if original["instance_id"] != expected_instance:
        _fail(f"originals[{index}].instance_id is not bound to source/layout/page")
    if original["occupancy"] not in {"occupied", "uncertain"}:
        _fail(f"originals[{index}].occupancy is invalid")
    if original["selection_basis"] not in {"keyword", "occupied_slot", "manual_slot"}:
        _fail(f"originals[{index}].selection_basis is invalid")
    _boolean(original["needs_review"], f"originals[{index}].needs_review")
    if original["occupancy"] == "uncertain" and original["selection_basis"] != "manual_slot" and not original["needs_review"]:
        _fail(f"originals[{index}].uncertain occupancy requires review")
    # Keep the snapshot representation intact, apart from the source key that
    # is required to be canonical.  Numeric validation above follows P1's
    # physical near() policy without inventing evidence or match fields.
    original["id"] = item_id
    original["source_key"] = source_key
    return original


def validate_receipt_originals(value: object, source_sha_by_key: object) -> tuple[list[dict[str, Any]], str, str]:
    """Validate immutable schema-3 originals and return a canonical manifest.

    Each original is bounded and cloned independently.  This keeps the
    per-item JSON/node budget separate from the 50,000-item collection bound.
    """

    try:
        if not isinstance(value, list) or len(value) > MAX_RECEIPT_REVIEW_ORIGINALS:
            _fail("originals must be a bounded array of at most 50,000 items")
        source_map = _source_map(source_sha_by_key)
        originals: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        seen_source_instances: set[tuple[str, str]] = set()
        parts: list[bytes] = []
        total = 2  # the surrounding '[' and ']'
        for index, raw in enumerate(value):
            original = _validate_original_item(raw, source_map, index=index)
            item_id = original["id"]
            logical_key = (original["source_key"], original["instance_id"])
            if item_id in seen_ids:
                _fail("original IDs must be unique")
            if logical_key in seen_source_instances:
                _fail("original source_key and instance_id must be unique")
            seen_ids.add(item_id)
            seen_source_instances.add(logical_key)
            encoded = _canonical_bytes(original, max_bytes=MAX_RECEIPT_REVIEW_ITEM_BYTES)
            total += len(encoded) + (1 if parts else 0)
            if total > MAX_RECEIPT_REVIEW_MANIFEST_BYTES:
                _fail("original manifest exceeds the aggregate JSON limit")
            parts.append(encoded)
            originals.append(original)
        manifest_bytes = b"[" + b",".join(parts) + b"]"
        manifest = manifest_bytes.decode("utf-8", "strict")
        digest = hashlib.sha256(manifest_bytes).hexdigest()
        return originals, manifest, digest
    except ReceiptReviewError:
        raise
    except (ValueError, TypeError, OverflowError, UnicodeError) as exc:
        raise ReceiptReviewError("invalid receipt originals") from exc


def validate_receipt_edit(value: object) -> dict[str, Any]:
    """Validate one mutable edit and return an independent canonical copy."""

    try:
        edit = _clone(value, max_bytes=MAX_RECEIPT_REVIEW_EDIT_BYTES, field="edit")
        if (not isinstance(edit, dict) or not _EDIT_FIELDS <= set(edit)
                or set(edit) - _EDIT_FIELDS - _CLASSIFICATION_FIELDS):
            _fail("edit must contain exactly the schema-1 fields")
        if "document_type" in edit and (not isinstance(edit["document_type"], str)
                                         or edit["document_type"] not in MANUAL_DOCUMENT_TYPES):
            _fail("edit.document_type is invalid")
        if type(edit["schema_version"]) is not int or edit["schema_version"] != RECEIPT_REVIEW_EDIT_SCHEMA_VERSION:
            _fail("edit.schema_version must be 1")
        _sha(edit["context_key"], "edit.context_key")
        _text(edit["result_revision"], "edit.result_revision", 128)
        _text(edit["id"], "edit.id", MAX_IDENTIFIER_BYTES)
        edit["source_key"] = _normalize_path(edit["source_key"], "edit.source_key")
        _text(edit["instance_id"], "edit.instance_id", MAX_IDENTIFIER_BYTES)
        _sha(edit["analysis_signature"], "edit.analysis_signature")
        _safe_revision(edit["record_revision"], "edit.record_revision")
        mode = edit["crop_mode"]
        if not isinstance(mode, str) or mode not in _CROP_MODES:
            _fail("edit.crop_mode is invalid")
        final = _rect(edit["final_rect"], "edit.final_rect", nullable=mode == "full_page")
        if mode == "full_page" and final is not None:
            _fail("full_page edit must have a null final_rect")
        if mode != "full_page" and final is None:
            _fail(f"{mode} edit must have a final_rect")
        if edit["review_status"] not in _REVIEW_STATUSES:
            _fail("edit.review_status is invalid")
        manual_adjusted = _boolean(edit["manual_adjusted"], "edit.manual_adjusted")
        if mode in {"candidate", "full_page"} and manual_adjusted:
            _fail(f"{mode} edit must not be marked manually adjusted")
        if mode == "manual" and not manual_adjusted:
            _fail("manual edit must be marked manually adjusted")
        _reviewed_at(edit["reviewed_at"])
        if final is not None:
            edit["final_rect"] = final
        return edit
    except ReceiptReviewError:
        raise
    except (ValueError, TypeError, OverflowError, UnicodeError) as exc:
        raise ReceiptReviewError("invalid receipt edit") from exc


def _bind_edit(original: Mapping[str, Any], edit: Mapping[str, Any]) -> None:
    for field in ("id", "source_key", "instance_id", "analysis_signature"):
        if edit[field] != original[field]:
            _fail(f"edit.{field} does not match immutable original")


def build_receipt_record(original: object, edit: object, source_path: object,
                         source_sha256: object, new_revision: object) -> dict[str, Any]:
    """Bind one validated edit to its immutable snapshot original."""

    try:
        source_sha = _sha(source_sha256, "source_sha256")
        # source_path is a verified access path supplied by the store/owner;
        # its spelling remains useful to the reader while its shape is strict.
        _normalize_path(source_path, "source_path")
        revision = _safe_revision(new_revision, "new_revision", positive=True)
        raw_original = _clone(original, max_bytes=MAX_RECEIPT_REVIEW_ITEM_BYTES, field="original")
        if not isinstance(raw_original, dict) or "source_key" not in raw_original:
            _fail("original must be a schema-3 original")
        canonical_key = _normalize_path(raw_original["source_key"], "original.source_key")
        validated_original = _validate_original_item(raw_original, {canonical_key: source_sha}, index=0)
        validated_edit = validate_receipt_edit(edit)
        _bind_edit(validated_original, validated_edit)
        geometry = parse_page_geometry(validated_original["page_geometry"])
        candidate = _rect(validated_original["candidate_rect"], "original.candidate_rect",
                          geometry=geometry, minimum=True)
        assert candidate is not None
        mode = validated_edit["crop_mode"]
        final_input = validated_edit["final_rect"]
        if mode == "candidate":
            final = _rect(final_input, "edit.final_rect", geometry=geometry, minimum=True)
            assert final is not None
            if not _same_rect(final, candidate) or validated_edit["manual_adjusted"] is not False:
                _fail("candidate record must retain the candidate rectangle and manual_adjusted=false")
        elif mode == "manual":
            final = _rect(final_input, "edit.final_rect", geometry=geometry, minimum=True)
            assert final is not None
            if not _contains(candidate, final):
                _fail("manual final rectangle must be inside the original candidate")
        else:
            if final_input is not None or validated_edit["manual_adjusted"] is not False:
                _fail("full_page record must have final_rect=null and manual_adjusted=false")
            final = None
        record = {
            "schema_version": RECEIPT_REVIEW_EDIT_SCHEMA_VERSION,
            "context_key": validated_edit["context_key"],
            "result_revision": validated_edit["result_revision"],
            "record_revision": revision,
            "source_path": source_path,
            "source_sha256": source_sha,
            "original": validated_original,
            "final_rect": final,
            "crop_mode": mode,
            "review_status": validated_edit["review_status"],
            "manual_adjusted": validated_edit["manual_adjusted"],
            "reviewed_at": validated_edit["reviewed_at"],
        }
        if "document_type" in validated_edit:
            record["document_type"] = validated_edit["document_type"]
        return record
    except ReceiptReviewError:
        raise
    except (ValueError, TypeError, OverflowError, UnicodeError) as exc:
        raise ReceiptReviewError("invalid receipt record binding") from exc


def validate_receipt_record(value: object) -> dict[str, Any]:
    """Strictly validate a record read from storage and return a deep copy."""

    try:
        record = _clone(value, max_bytes=MAX_RECEIPT_REVIEW_RECORD_BYTES, field="record")
        if (not isinstance(record, dict) or not _RECORD_FIELDS <= set(record)
                or set(record) - _RECORD_FIELDS - _CLASSIFICATION_FIELDS):
            _fail("record must contain exactly the schema-3 fields")
        source_sha = _sha(record["source_sha256"], "record.source_sha256")
        _normalize_path(record["source_path"], "record.source_path")
        original = record["original"]
        if not isinstance(original, dict) or "source_key" not in original:
            _fail("record.original is invalid")
        original_key = _normalize_path(original["source_key"], "record.original.source_key")
        edit = {
            "schema_version": record["schema_version"],
            "context_key": record["context_key"],
            "result_revision": record["result_revision"],
            "id": original.get("id"),
            "source_key": original_key,
            "instance_id": original.get("instance_id"),
            "analysis_signature": original.get("analysis_signature"),
            "record_revision": record["record_revision"],
            "final_rect": record["final_rect"],
            "crop_mode": record["crop_mode"],
            "review_status": record["review_status"],
            "manual_adjusted": record["manual_adjusted"],
            "reviewed_at": record["reviewed_at"],
        }
        if "document_type" in record:
            edit["document_type"] = record["document_type"]
        expected = build_receipt_record(original, edit, record["source_path"], source_sha,
                                        record["record_revision"])
        if expected != record:
            _fail("record does not match its canonical immutable binding")
        return expected
    except ReceiptReviewError:
        raise
    except (ValueError, TypeError, OverflowError, UnicodeError) as exc:
        raise ReceiptReviewError("invalid receipt record") from exc


__all__ = [
    "ReceiptReviewError",
    "RECEIPT_REVIEW_CONTEXT_VERSION",
    "RECEIPT_REVIEW_EDIT_SCHEMA_VERSION",
    "MAX_RECEIPT_REVIEW_ORIGINALS",
    "MAX_RECEIPT_REVIEW_MANIFEST_BYTES",
    "validate_receipt_context",
    "validate_receipt_originals",
    "validate_receipt_edit",
    "build_receipt_record",
    "validate_receipt_record",
]
