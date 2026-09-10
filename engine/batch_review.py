"""Bind a published server manifest to reviews after rechecking all originals."""

from pathlib import Path
from typing import Any

from .batch_pdf import BatchSourceError, open_batch_source
from .batch_store import BatchConflict, BatchStore
from .computation import current_computation_version
from .review_store_v2 import ReviewStoreV2


def _binding(job: dict[str, Any]) -> tuple:
    return (job["id"], job["generation"], job["state"], job["result_revision"], job["deletion_pending"],
            tuple((source["source_id"], source["source_key"], source["access_path"], source["sha256"],
                   source["size_bytes"], source["page_count"]) for source in job["sources"]))


def prepare_batch_review(store: BatchStore, job_id: str, revision: str, review_database: Path) -> dict[str, Any]:
    snapshot = store.review_snapshot(job_id, revision)
    job = snapshot["job"]
    if job["computation_version"] != current_computation_version():
        raise BatchConflict("batch computation version has changed")
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
    return {"context": snapshot["context"], "prepared": {"status": "ok", **prepared}}
