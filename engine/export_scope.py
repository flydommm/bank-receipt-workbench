"""Trusted, revision-bound export scopes derived only from published tasks.

This module neither registers front-end result arrays nor changes reviews. The
short cross-store guard follows batch -> review lock order and can be retained
through the final directory rename. Source hashing happens before those locks.
"""

from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from typing import Any, Iterator

from .batch_models import BatchModelError
from .batch_pdf import BatchSourceError, open_batch_source
from .batch_store import BatchStore, BatchStoreError
from .computation import current_computation_version
from .review_read import _stored_context, read_review_snapshot
from .review_store_v2 import ReviewStoreError, _final_rect_is_legal, _validate_context, _validate_originals
from .export_plan import _normalise_output_name

MAX_SCOPE_ITEMS = 50_000
_REQUEST_FIELDS = {"job_id", "result_revision", "scope_kind", "selected_segment_ids",
                   "expected_records", "output_mode", "include_xlsx"}
_REQUEST_FIELDS_WITH_NAME = _REQUEST_FIELDS | {"output_name"}
_CONFIRMED = {"confirmed", "page_confirmed", "group_confirmed"}


class ExportScopeError(ValueError):
    """Stable scope failure without source paths or database contents."""

    def __init__(self, message: str, code: str = "export_scope_invalid") -> None:
        super().__init__(message)
        self.code = code


def _digest(value: object) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                             allow_nan=False).encode("utf-8")).hexdigest()


def _identifier(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value.encode("utf-8")) <= 1024


def validate_scope_request(request: object) -> dict[str, Any]:
    if (not isinstance(request, dict)
            or (set(request) != _REQUEST_FIELDS and set(request) != _REQUEST_FIELDS_WITH_NAME)):
        raise ExportScopeError("export scope fields are invalid")
    if not _identifier(request["job_id"]) or not _identifier(request["result_revision"]):
        raise ExportScopeError("a published task and result revision are required")
    if request["scope_kind"] not in ("all", "sources", "list"):
        raise ExportScopeError("export scope kind is invalid")
    if request["output_mode"] not in ("merged", "by_source", "both") or type(request["include_xlsx"]) is not bool:
        raise ExportScopeError("export output options are invalid")
    selected = request["selected_segment_ids"]
    if not isinstance(selected, list) or not 1 <= len(selected) <= MAX_SCOPE_ITEMS or not all(map(_identifier, selected)):
        raise ExportScopeError("selected export ids must be a nonempty bounded set")
    if len(set(selected)) != len(selected):
        raise ExportScopeError("duplicate selected export ids are invalid")
    expected = request["expected_records"]
    if not isinstance(expected, list) or len(expected) != len(selected):
        raise ExportScopeError("persisted selected record revisions are required")
    seen = set()
    for row in expected:
        if (not isinstance(row, dict) or set(row) != {"id", "record_revision"}
                or not _identifier(row["id"]) or row["id"] in seen
                or type(row["record_revision"]) is not int or not 1 <= row["record_revision"] < 2 ** 53):
            raise ExportScopeError("persisted selected record revisions are invalid")
        seen.add(row["id"])
    if seen != set(selected):
        raise ExportScopeError("persisted selected record revisions do not match selected ids")
    result = deepcopy(request)
    if "output_name" in result:
        try:
            result["output_name"] = _normalise_output_name(result["output_name"])
        except ValueError as error:
            raise ExportScopeError(str(error)) from None
    return result


@contextmanager
def _hold_existing_reviews(path: Path) -> Iterator[sqlite3.Connection]:
    # mode=rw refuses missing databases. No normal ReviewStore constructor,
    # schema initialization, ownership backfill or persistent write is needed.
    if not path.is_file():
        raise ExportScopeError("persisted review database is unavailable")
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=rw", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("BEGIN IMMEDIATE")
        yield connection
    finally:
        if connection.in_transaction:
            connection.rollback()
        connection.close()


def _published_items(store: BatchStore, snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    job = snapshot["job"]
    items: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = store.results_page(job["id"], job["result_revision"], offset, 200)
        if page["total"] != len(snapshot["originals"]):
            raise ExportScopeError("published result set is incomplete")
        items.extend(page["items"])
        if page["next_offset"] is None:
            break
        if page["next_offset"] <= offset:
            raise ExportScopeError("published result paging is invalid")
        offset = page["next_offset"]
    source_rows = list(store.connection.execute(
        "SELECT * FROM batch_sources WHERE job_id=? ORDER BY position", (job["id"],)))
    header = store.connection.execute(
        "SELECT source_count, source_summary_json FROM batch_snapshots WHERE job_id=? AND result_revision=?",
        (job["id"], job["result_revision"])).fetchone()
    published_sources = json.loads(header["source_summary_json"])
    if header["source_count"] != len(source_rows) or not isinstance(published_sources, list) or len(published_sources) != len(source_rows):
        raise ExportScopeError("published task source set is incomplete")
    expected_pages = set()
    for source, published in zip(source_rows, published_sources, strict=True):
        if any(source[key] != published[key] for key in ("source_id", "position", "source_key", "initial_path", "sha256", "size_bytes", "page_count")):
            raise ExportScopeError("published task source identity is inconsistent")
        # relocate_source intentionally clears final-generation verification;
        # our fresh complete SHA/size/page checks re-establish that evidence
        # without mutating the task. Failed/pending sources never pass.
        if source["state"] not in {"verified", "registered"} or source["error_json"] is not None:
            raise ExportScopeError("all task sources must have completed successfully")
        if source["state"] == "verified" and source["verified_generation"] != job["generation"]:
            raise ExportScopeError("task source verification generation is stale")
        if source["state"] == "registered" and source["verified_generation"] is not None:
            raise ExportScopeError("relocated task source verification is invalid")
        expected_pages.update((source["source_id"], page) for page in range(1, source["page_count"] + 1))
    current_pages = {(row["source_id"], row["page"]) for row in store.connection.execute(
        "SELECT source_id,page FROM batch_pages WHERE job_id=?", (job["id"],))}
    if current_pages != expected_pages:
        raise ExportScopeError("all task pages must be present before export")
    store._assert_complete_pages(store.connection, job["id"])
    return [item for _, item, _ in store._validate_snapshot_items(items, snapshot["originals"], source_rows)]


def _check_sources(snapshot: dict[str, Any]) -> set[str]:
    originals_by_source: dict[str, list[dict[str, Any]]] = {}
    for original in snapshot["originals"]:
        originals_by_source.setdefault(original["source_key"], []).append(original)
    geometry_valid = set()
    for source in snapshot["job"]["sources"]:
        # This also checks zero-hit files and never parses a mutable original.
        with open_batch_source(source["access_path"], source["sha256"]) as opened:
            if opened.size_bytes != source["size_bytes"] or opened.page_count != source["page_count"]:
                raise ExportScopeError("task source identity changed", "source_changed")
            page_sizes = {}
            for original in originals_by_source.get(source["source_key"], []):
                page = original["source_page"]
                if page not in page_sizes:
                    loaded = opened._document.load_page(page - 1)
                    page_sizes[page] = (float(loaded.rect.width), float(loaded.rect.height))
                width, height = page_sizes[page]
                if (original["persistable"] and abs(width - original["page_width"]) <= 1e-6
                        and abs(height - original["page_height"]) <= 1e-6):
                    geometry_valid.add(original["id"])
    return geometry_valid


def _build_scope(store: BatchStore, connection: sqlite3.Connection, review_database: Path,
                 snapshot: dict[str, Any], request: dict[str, Any], geometry_valid: set[str]) -> dict[str, Any]:
    descriptor, source_shas, context_key = _validate_context(snapshot["context"], trusted_aliases=True)
    _, expected_manifest, _ = _validate_originals(snapshot["originals"], source_shas)
    context_row, _, _, stored_descriptor, _ = _stored_context(connection, context_key)
    if descriptor != stored_descriptor or context_row["manifest_json"] != expected_manifest:
        raise ExportScopeError("persisted review manifest does not match published task")
    # The outer writer reservation keeps this independent read transaction on
    # the same committed state, while preserving the M4 reader's read-only API.
    reviews = read_review_snapshot(review_database, context_key, request["result_revision"])
    items = _published_items(store, snapshot)
    original_by_id = {item["original"]["id"]: item["original"] for item in items}
    selected = set(request["selected_segment_ids"])
    if not selected.issubset(original_by_id):
        raise ExportScopeError("selected ids are outside the published result set")
    if request["scope_kind"] == "all" and selected != set(original_by_id):
        raise ExportScopeError("all-results scope must include the complete result set")
    selected_sources = {original_by_id[identifier]["source_key"] for identifier in selected}
    if request["scope_kind"] == "sources" and selected != {
        identifier for identifier, item in original_by_id.items() if item["source_key"] in selected_sources
    }:
        raise ExportScopeError("source scope must include all fragments in each selected source")
    records_by_id = {record["id"]: record for record in reviews["segments"]}
    expected = {item["id"]: item["record_revision"] for item in request["expected_records"]}
    for identifier in selected:
        record = records_by_id.get(identifier)
        if record is None:
            raise ExportScopeError("selected review must be persisted before export")
        if record["record_revision"] != expected[identifier]:
            raise ExportScopeError("persisted review revision changed", "export_scope_stale")
        if not _resolved(record, identifier, geometry_valid):
            raise ExportScopeError("selected review must be resolved before export")
    job = snapshot["job"]
    sources = [{"source_key": source["source_key"], "name": source["name"],
                "source_path": source["access_path"], "source_sha256": source["sha256"],
                "size_bytes": source["size_bytes"], "page_count": source["page_count"]}
               for source in job["sources"]]
    source_positions = {source["source_key"]: index for index, source in enumerate(sources)}
    ordered = sorted(selected, key=lambda identifier: (
        source_positions[original_by_id[identifier]["source_key"]],
        original_by_id[identifier]["source_page"], original_by_id[identifier]["segment_no"]))
    records = [records_by_id[identifier] for identifier in ordered]
    expected_pages = 0
    full_pages = set()
    crop_pages = set()
    for record in records:
        source_page = (record["source_key"], record["source_page"])
        if record["crop_mode"] == "full_page":
            full_key = source_page
            if full_key in full_pages:
                continue
            full_pages.add(full_key)
        else:
            rect = record["final_rect"]
            crop_key = (source_page, rect["x0"], rect["y0"], rect["x1"], rect["y1"])
            if crop_key in crop_pages:
                continue
            crop_pages.add(crop_key)
        expected_pages += 1
    original_segments = {item["segment"]["id"]: item["segment"] for item in items}
    omitted_unresolved = sum(not _resolved(records_by_id.get(identifier, original_segments[identifier]),
                                            identifier, geometry_valid)
                              for identifier in original_by_id if identifier not in selected)
    result = {
        "schema": 1, "job_id": job["id"], "generation": job["generation"],
        "result_revision": job["result_revision"], "context_key": context_key,
        "scope_kind": request["scope_kind"], "selected_segment_ids": ordered,
        "expected_records": [{"id": identifier, "record_revision": expected[identifier]} for identifier in ordered],
        "source_fingerprint": _digest(sources),
        "review_revision": _digest({"revisions": reviews["record_revisions"], "selected_records": records}),
        "output_mode": request["output_mode"], "include_xlsx": request["include_xlsx"],
        "sources": sources, "records": records,
        "evidence_by_id": {item["segment"]["id"]: item["evidence"] for item in items if item["segment"]["id"] in selected},
        "criteria": job["criteria"],
        "summary": {"total_segments": len(items), "selected_count": len(ordered),
                    "selected_source_count": len(selected_sources), "omitted_count": len(items) - len(ordered),
                    "omitted_unresolved_count": omitted_unresolved, "expected_pages": expected_pages},
    }
    if "output_name" in request:
        result["output_name"] = request["output_name"]
    result["snapshot_digest"] = _digest(result)
    return result


def _resolved(record: dict[str, Any], identifier: str, geometry_valid: set[str]) -> bool:
    return (identifier in geometry_valid and record["review_status"] in _CONFIRMED
            and _final_rect_is_legal(record["final_rect"], record["crop_mode"],
                                     record["page_width"], record["page_height"], require_final=True))


@contextmanager
def hold_export_scope(store: BatchStore, review_database: str | Path, request: object, *,
                      expected_snapshot: dict[str, Any] | None = None) -> Iterator[dict[str, Any]]:
    validated = validate_scope_request(request)
    try:
        snapshot = store.review_snapshot(validated["job_id"], validated["result_revision"])
        if snapshot["job"]["computation_version"] != current_computation_version():
            raise ExportScopeError("task computation version changed", "export_scope_stale")
        geometry_valid = _check_sources(snapshot)
        with store.hold_review_binding(snapshot["job"]):
            with _hold_existing_reviews(Path(review_database)) as connection:
                current = _build_scope(store, connection, Path(review_database), snapshot, validated, geometry_valid)
                if expected_snapshot is not None and current != expected_snapshot:
                    raise ExportScopeError("frozen export scope changed", "export_scope_stale")
                yield current
    except ExportScopeError:
        raise
    except BatchSourceError as error:
        raise ExportScopeError("task source cannot be verified", error.code) from None
    except (BatchStoreError, BatchModelError, ReviewStoreError, sqlite3.Error, OSError, ValueError, KeyError, TypeError):
        raise ExportScopeError("published task or persisted review is unavailable", "export_scope_stale") from None


def capture_export_scope(store: BatchStore, review_database: str | Path, request: object) -> dict[str, Any]:
    with hold_export_scope(store, review_database, request) as snapshot:
        return snapshot
