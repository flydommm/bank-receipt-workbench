"""Receipt export selection, attested while the batch/review locks are held.

The caller supplies only IDs and expected record revisions. Geometry, receipt
identity, evidence and processing mode come from durable task checkpoints.
"""

from pathlib import Path
import sqlite3
from typing import Any

from .export_scope import ExportScopeError, _digest
from .receipt_review_models import ReceiptReviewError, validate_receipt_context, validate_receipt_originals
from .receipt_review_read import read_receipt_review_snapshot
from .receipt_review_store import validate_context_row
from .receipt_export_plan import receipt_exclusion_audit, validate_receipt_exclusion_geometry


def _resolved(record: dict[str, Any] | None, identifier: str, geometry_valid: set[str]) -> bool:
    # Persisted receipt rows have already passed their complete codec and crop
    # invariants in read_receipt_review_snapshot. An initial row is synthesized
    # below only for unchanged, automatically confirmed candidates.
    return bool(record is not None and identifier in geometry_valid
                and record["review_status"] in {"confirmed", "page_confirmed"})


def build_receipt_export_scope(
    connection: sqlite3.Connection,
    review_database: Path,
    snapshot: dict[str, Any],
    request: dict[str, Any],
    geometry_valid: set[str],
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    descriptor, source_shas, context_key = validate_receipt_context(snapshot["context"], trusted_aliases=True)
    _, expected_manifest, _ = validate_receipt_originals(snapshot["originals"], source_shas)
    row = connection.execute("SELECT * FROM review_contexts_v2 WHERE context_key=?", (context_key,)).fetchone()
    if row is None:
        raise ExportScopeError("persisted receipt review context is unavailable")
    stored_descriptor, _ = validate_context_row(row, descriptor, context_key)
    if (descriptor != stored_descriptor or row["manifest_json"] != expected_manifest
            or row["result_revision"] != request["result_revision"]):
        raise ExportScopeError("persisted receipt manifest does not match published task", "export_scope_stale")
    reviews = read_receipt_review_snapshot(review_database, context_key, request["result_revision"])
    # Published receipt items are envelopes with immutable ``original`` and
    # ``segment`` payloads. Keep the envelope here so evidence can be carried
    # into the export scope without trusting browser supplied geometry.
    original_by_id = {item["original"]["id"]: item["original"] for item in items}
    selected = set(request["selected_segment_ids"])
    if not selected.issubset(original_by_id):
        raise ExportScopeError("selected ids are outside the published receipt set")
    if request["scope_kind"] == "all" and selected != set(original_by_id):
        raise ExportScopeError("all-results scope must include the complete receipt set")
    selected_sources = {original_by_id[identifier]["source_key"] for identifier in selected}
    if request["scope_kind"] == "sources" and selected != {
        identifier for identifier, original in original_by_id.items() if original["source_key"] in selected_sources
    }:
        raise ExportScopeError("source scope must include all receipts in each selected source")
    records_by_id = {record["original"]["id"]: record for record in reviews["segments"]}
    excluded_ids = {identifier for identifier, record in records_by_id.items()
                    if record["review_status"] == "excluded"}
    retained_ids = set(original_by_id) - excluded_ids
    if not retained_ids:
        raise ExportScopeError("all receipts are excluded; empty export is unavailable")
    if selected & excluded_ids:
        raise ExportScopeError("selected receipts include an excluded receipt")
    if selected != retained_ids:
        raise ExportScopeError("receipt export must include the complete non-excluded receipt set")
    if not excluded_ids.issubset(geometry_valid):
        raise ExportScopeError("excluded receipt geometry is no longer valid", "export_scope_stale")
    # Automatic candidates are valid export inputs without a needless review
    # write. Their immutable segment is already bound to the task snapshot;
    # a zero revision is used only for this initial, never-edited state.
    initial_by_id = {item["original"]["id"]: item["segment"] for item in items}
    expected = {item["id"]: item["record_revision"] for item in request["expected_records"]}
    for identifier in selected:
        record = records_by_id.get(identifier)
        if record is None:
            initial = initial_by_id.get(identifier)
            if initial is None or initial.get("review_status") not in {"confirmed", "page_confirmed"} or expected.get(identifier) != 0:
                raise ExportScopeError("selected receipt review must be persisted before export")
            record = {
                "schema_version": 1,
                "context_key": context_key,
                "result_revision": request["result_revision"],
                "record_revision": 0,
                "source_path": initial["source_path"],
                "source_sha256": initial["source_sha256"],
                "original": original_by_id[identifier],
                "final_rect": initial["final_rect"],
                "crop_mode": initial["crop_mode"],
                "review_status": initial["review_status"],
                "manual_adjusted": False,
                # This is the automatic result timestamp, not a persisted human review.
                "reviewed_at": snapshot["job"]["updated_at"],
            }
            records_by_id[identifier] = record
        if record["record_revision"] != expected[identifier]:
            raise ExportScopeError("persisted receipt revision changed", "export_scope_stale")
        if not _resolved(record, identifier, geometry_valid):
            raise ExportScopeError("selected receipt review must be resolved before export")

    job = snapshot["job"]
    sources = [{"source_key": source["source_key"], "name": source["name"],
                "source_path": source["access_path"], "source_sha256": source["sha256"],
                "size_bytes": source["size_bytes"], "page_count": source["page_count"]}
               for source in job["sources"]]
    source_positions = {source["source_key"]: index for index, source in enumerate(sources)}
    ordered = sorted(selected, key=lambda identifier: (
        source_positions[original_by_id[identifier]["source_key"]],
        original_by_id[identifier]["source_page"], original_by_id[identifier]["position_index"],
    ))
    records = [records_by_id[identifier] for identifier in ordered]
    excluded_order = sorted(excluded_ids, key=lambda identifier: (
        source_positions[original_by_id[identifier]["source_key"]],
        original_by_id[identifier]["source_page"], original_by_id[identifier]["position_index"],
    ))
    excluded_records = [records_by_id[identifier] for identifier in excluded_order]
    try:
        excluded = receipt_exclusion_audit(excluded_records)
        validate_receipt_exclusion_geometry(records, excluded_records)
    except ReceiptReviewError as error:
        raise ExportScopeError(str(error)) from None
    output_pages = set()
    for record in records:
        original = record["original"]
        key = (original["source_key"], original["source_page"])
        if record["crop_mode"] == "full_page":
            output_pages.add((*key, "full_page"))
        else:
            rect = record["final_rect"]
            output_pages.add((*key, "crop", rect["x0"], rect["y0"], rect["x1"], rect["y1"]))
    result = {
        "schema": 2, "job_id": job["id"], "generation": job["generation"],
        "result_revision": job["result_revision"], "context_key": context_key,
        "scope_kind": request["scope_kind"], "selected_segment_ids": ordered,
        "expected_records": [{"id": identifier, "record_revision": expected[identifier]} for identifier in ordered],
        "source_fingerprint": _digest(sources),
        "review_revision": _digest({"revisions": reviews["record_revisions"], "selected_records": records,
                                    "excluded_records": excluded_records}),
        "output_mode": request["output_mode"], "include_xlsx": request["include_xlsx"],
        "sources": sources, "records": records,
        "excluded_records": excluded_records, "excluded": excluded, "excluded_digest": _digest(excluded),
        "evidence_by_id": {item["original"]["id"]: item["evidence"] for item in items
                           if item["original"]["id"] in selected},
        "processing_options": descriptor["processing_options"],
        "summary": {"total_segments": len(items), "selected_count": len(ordered),
                    "selected_source_count": len(selected_sources), "omitted_count": len(items) - len(ordered),
                    "omitted_unresolved_count": 0, "excluded_count": len(excluded), "expected_pages": len(output_pages)},
    }
    if "output_name" in request:
        result["output_name"] = request["output_name"]
    if "include_manifest" in request:
        result["include_manifest"] = request["include_manifest"]
    result["snapshot_digest"] = _digest(result)
    return result
