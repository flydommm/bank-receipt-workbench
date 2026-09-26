"""Bind a published server manifest to reviews after rechecking all originals.

The receipt review entry points in this module deliberately keep the batch
snapshot as the authority.  A browser may submit only mutable edits; context,
originals, source paths, and revisions are loaded again from the task and the
private review database before a write.
"""

from copy import deepcopy
from pathlib import Path
from typing import Any

from .batch_models import (
    MAX_RESULTS_PAGE_BYTES,
    MAX_RESULTS_PAGE_ITEMS,
    BatchModelError,
    canonical_json,
)
from .batch_pdf import BatchSourceError, open_batch_source
from .batch_store import (
    BatchCapacityExceeded,
    BatchComputationChanged,
    BatchConflict,
    BatchStore,
)
from .computation import current_computation_version
from .receipt_review_models import (
    ReceiptReviewError,
    validate_receipt_context,
    validate_receipt_edit,
)
from .receipt_review_read import read_receipt_review_binding
from .receipt_classification import classification_notice
from .review_store import ReviewStoreError
from .review_store_v2 import ReviewStoreV2


def _binding(job: dict[str, Any]) -> tuple:
    return (job["id"], job["generation"], job["state"], job["result_revision"], job["deletion_pending"],
            tuple((source["source_id"], source["source_key"], source["access_path"], source["sha256"],
                   source["size_bytes"], source["page_count"]) for source in job["sources"]))


def prepare_batch_review(store: BatchStore, job_id: str, revision: str, review_database: Path) -> dict[str, Any]:
    from .receipt_calibration_journal import recover_receipt_calibration
    recover_receipt_calibration(store, job_id, review_database)
    snapshot = store.review_snapshot(job_id, revision)
    job = snapshot["job"]
    if job["computation_version"] != current_computation_version():
        raise BatchComputationChanged("batch computation version has changed")
    for source in job["sources"]:
        with open_batch_source(source["access_path"], source["sha256"]) as opened:
            if opened.size_bytes != source["size_bytes"] or opened.page_count != source["page_count"]:
                raise BatchSourceError("source_changed")
    # Relocation/archive/delete during the file checks invalidates this load.
    # UI commits are also bound to the exact result revision and current view.
    if _binding(store.get_job(job_id)) != _binding(job):
        raise BatchConflict("batch changed during review preparation")
    with store.hold_review_binding(job):
        with ReviewStoreV2(review_database) as reviews:
            prepared = reviews.prepare_batch(snapshot["context"], snapshot["originals"], result_revision=revision, job_id=job["id"])
        template_ids: set[str] = set()
        if job.get("page_result_schema") == 2:
            for row in store.read_page_results(job_id):
                for diagnostic in row["payload"].get("diagnostics", []):
                    if diagnostic.get("code") == "historical_template_ambiguous":
                        template_ids.update(diagnostic["template_ids"])
    return {"context": snapshot["context"], "prepared": {"status": "ok", **prepared},
            **({"template_choice_ids": sorted(template_ids)} if template_ids else {})}


def _receipt_snapshot(store: BatchStore, job_id: object, revision: object) -> dict[str, Any]:
    """Load and reverify a published schema-2 snapshot for a review request."""

    snapshot = store.review_snapshot(job_id, revision)
    job = snapshot["job"]
    if job.get("page_result_schema") != 2 or snapshot["context"].get("version") != 3:
        raise BatchConflict("receipt review requires a schema-2 receipt snapshot")
    if job["computation_version"] != current_computation_version():
        raise BatchComputationChanged("batch computation version has changed")
    for source in job["sources"]:
        with open_batch_source(source["access_path"], source["sha256"]) as opened:
            if opened.size_bytes != source["size_bytes"] or opened.page_count != source["page_count"]:
                raise BatchSourceError("source_changed")
    # Relocation, archival, and a result revision change must not race a
    # review read/write.  The write path takes the same check again while
    # holding the batch transaction.
    if _binding(store.get_job(job_id)) != _binding(job):
        raise BatchConflict("batch changed during receipt review")
    return snapshot


def _receipt_context_key(context: object) -> tuple[dict[str, Any], str]:
    try:
        descriptor, _sha_by_key, context_key = validate_receipt_context(context, trusted_aliases=True)
    except ReceiptReviewError as exc:
        raise ReviewStoreError("receipt review context is invalid") from exc
    return descriptor, context_key


def _validated_review_binding(
    store: BatchStore,
    snapshot: dict[str, Any],
    review_database: Path,
) -> tuple[str, dict[str, Any]]:
    """Validate the stored context/manifest and every historical record."""

    current_descriptor, context_key = _receipt_context_key(snapshot["context"])
    binding = read_receipt_review_binding(
        review_database, context_key, snapshot["job"]["result_revision"]
    )
    if binding["descriptor"] != current_descriptor or binding["originals"] != snapshot["originals"]:
        raise BatchConflict("receipt review context is stale or source binding changed")
    restored = binding["snapshot"]
    if restored["context_key"] != context_key or restored["result_revision"] != snapshot["job"]["result_revision"]:
        raise BatchConflict("receipt review snapshot is stale")
    return context_key, restored


def _page_bounds(offset: object, limit: object, total: int) -> tuple[int, int]:
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise BatchModelError("offset must be a non-negative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > MAX_RESULTS_PAGE_ITEMS:
        raise BatchModelError(f"limit must be between 1 and {MAX_RESULTS_PAGE_ITEMS}")
    if offset > total:
        raise BatchModelError("offset is beyond the result set")
    return offset, limit


def _receipt_page_item(
    original: dict[str, Any],
    record_revisions: dict[tuple[str, str], int],
    records: dict[tuple[str, str], dict[str, Any]],
) -> dict[str, Any]:
    key = (original["source_key"], original["instance_id"])
    if key not in record_revisions:
        raise ReviewStoreError("receipt review revisions are incomplete")
    record = records.get(key)
    if record is not None and record["original"] != original:
        raise ReviewStoreError("receipt review record is bound to another original")
    return {
        "original": deepcopy(original),
        "record_revision": record_revisions[key],
        "record": None if record is None else deepcopy(record),
    }


def read_batch_receipt_review_page(
    store: BatchStore,
    job_id: object,
    revision: object,
    offset: object,
    limit: object,
    review_database: Path,
) -> dict[str, Any]:
    """Return a bounded, independently bound page of receipt review items."""

    snapshot = _receipt_snapshot(store, job_id, revision)
    context_key, restored = _validated_review_binding(store, snapshot, review_database)
    originals = snapshot["originals"]
    start, page_size = _page_bounds(offset, limit, len(originals))
    # Automatic notices are SHA-bound checkpoint metadata. A mutable, bound
    # per-receipt classification below can override this page-level detection.
    selected_pages = {(item["source_key"], item["source_page"])
                      for item in originals[start : start + page_size]}
    sources = {source["source_id"]: source["source_key"] for source in snapshot["job"]["sources"]}
    source_ids = {key: identifier for identifier, key in sources.items()}
    notices = {}
    suspected_invalid_slots: dict[tuple[str, int], set[str]] = {}
    for row in store.read_page_results(snapshot["job"]["id"], page_keys=[(source_ids[key], page) for key, page in selected_pages]):
        key = (sources[row["source_id"]], row["page"])
        if key not in selected_pages:
            continue
        special = [item for item in row["payload"]["diagnostics"] if item["code"] == "special_document"]
        if special:
            notices[key] = deepcopy(special[0])
        suspected_invalid_slots[key] = {
            item["slot_id"] for item in row["payload"]["diagnostics"]
            if item["code"] == "suspected_invalid_slot"
        }
    if _binding(store.get_job(snapshot["job"]["id"])) != _binding(snapshot["job"]):
        raise BatchConflict("batch changed while loading receipt notices")
    revisions = {
        (item["source_key"], item["instance_id"]): item["record_revision"]
        for item in restored["record_revisions"]
    }
    records = {
        (item["original"]["source_key"], item["original"]["instance_id"]): item
        for item in restored["segments"]
    }
    if len(revisions) != len(originals):
        raise ReviewStoreError("receipt review revisions are incomplete")
    items: list[dict[str, Any]] = []
    item_bytes = 0

    def envelope(values):
        next_offset = start + len(values) if start + len(values) < len(originals) else None
        return {
            "schema_version": 1, "context_key": context_key,
            "result_revision": snapshot["job"]["result_revision"],
            "offset": start, "limit": page_size, "total": len(originals),
            "next_offset": next_offset, "items": values,
        }

    for original in originals[start : start + page_size]:
        item = _receipt_page_item(original, revisions, records)
        notice = classification_notice(item["record"], notices.get((original["source_key"], original["source_page"])))
        if notice is not None:
            item["page_notice"] = notice
        elif original["slot_id"] in suspected_invalid_slots.get((original["source_key"], original["source_page"]), ()):
            item["exclusion_notice"] = {"code": "suspected_invalid_slot"}
        try:
            encoded_size = len(canonical_json(item, max_bytes=MAX_RESULTS_PAGE_BYTES))
        except BatchModelError:
            raise BatchCapacityExceeded("one receipt review item exceeds the 4 MiB page limit") from None
        # Each item is serialized once, not once per progressively larger
        # prefix. The short header changes only at next_offset boundaries.
        candidate_count = len(items) + 1
        header = envelope([])
        header["next_offset"] = start + candidate_count if start + candidate_count < len(originals) else None
        size = len(canonical_json(header, max_bytes=MAX_RESULTS_PAGE_BYTES)) + item_bytes + encoded_size + len(items)
        if size > MAX_RESULTS_PAGE_BYTES:
            if not items:
                raise BatchCapacityExceeded("one receipt review item exceeds the 4 MiB page limit")
            break
        items.append(item)
        item_bytes += encoded_size
    result = envelope(items)
    try:
        canonical_json(result, max_bytes=MAX_RESULTS_PAGE_BYTES)
    except BatchModelError:
        # The aggregate JSON node/depth budget still applies. Find the largest
        # valid prefix if it, rather than byte size, limits a pathological page.
        low, high = 0, len(items)
        while low < high:
            middle = (low + high + 1) // 2
            try:
                canonical_json(envelope(items[:middle]), max_bytes=MAX_RESULTS_PAGE_BYTES)
                low = middle
            except BatchModelError:
                high = middle - 1
        if low == 0:
            raise BatchCapacityExceeded("one receipt review item exceeds the 4 MiB page limit") from None
        result = envelope(items[:low])
    return result



def _validated_receipt_edits(
    edits: object,
    context_key: str,
    result_revision: str,
    originals: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not isinstance(edits, list):
        raise BatchModelError("edits must be an array")
    by_id = {original["id"]: original for original in originals}
    by_key = {(original["source_key"], original["instance_id"]): original for original in originals}
    parsed: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for raw in edits:
        try:
            edit = validate_receipt_edit(raw)
        except ReceiptReviewError as exc:
            raise BatchModelError("receipt edit is invalid") from exc
        if edit["context_key"] != context_key or edit["result_revision"] != result_revision:
            raise BatchConflict("receipt edit is bound to a stale review context")
        original = by_id.get(edit["id"])
        logical = (edit["source_key"], edit["instance_id"])
        if original is None or by_key.get(logical) is not original:
            raise BatchConflict("receipt edit is absent from the current manifest")
        if logical in seen:
            raise BatchModelError("receipt edits must have unique identities")
        seen.add(logical)
        parsed.append(edit)
    try:
        canonical_json(parsed, max_bytes=MAX_RESULTS_PAGE_BYTES)
    except BatchModelError:
        raise BatchCapacityExceeded("receipt review save request exceeds the 4 MiB limit") from None
    return parsed


def save_batch_receipt_review(
    store: BatchStore,
    job_id: object,
    revision: object,
    edits: object,
    review_database: Path,
) -> dict[str, Any]:
    """Atomically save only mutable receipt edits under the batch binding."""

    # The caller can never supply a context key or originals.  The server
    # derives both from the current published snapshot and checks the request
    # aggregate before doing any write.
    try:
        canonical_json({"job_id": job_id, "result_revision": revision, "edits": edits},
                       max_bytes=MAX_RESULTS_PAGE_BYTES)
    except BatchModelError:
        raise BatchCapacityExceeded("receipt review save request exceeds the 4 MiB limit") from None
    snapshot = _receipt_snapshot(store, job_id, revision)
    context_key, _restored = _validated_review_binding(store, snapshot, review_database)
    parsed = _validated_receipt_edits(
        edits, context_key, snapshot["job"]["result_revision"], snapshot["originals"]
    )
    job = snapshot["job"]
    with store.hold_review_binding(job):
        # Re-read the review binding after acquiring the task lock.  Prepare,
        # relocate, and cleanup use the same lock order, while the review
        # codec supplies the per-record CAS check inside its transaction.
        context_key, _restored = _validated_review_binding(store, snapshot, review_database)
        with ReviewStoreV2(review_database) as reviews:
            saved = reviews.save(context_key, job["result_revision"], parsed, confirm_group=False)
    return {
        "schema_version": 1,
        "context_key": saved["context_key"],
        "result_revision": saved["result_revision"],
        "saved_count": saved["saved_count"],
        "segments": saved["segments"],
    }
