"""Pin geometry selected for a receipt task for the life of that task.

New tasks receive geometry only from the active, independently verified
historical-template snapshot assembled by the analysis pipeline. A source
calibration from another task is never imported here. The pin stores geometry
only and remains immutable across pause/resume, so it cannot carry review
decisions or keyword hits between tasks.
"""
from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json
from typing import Any

from .batch_models import MAX_PAGE_RESULT_BYTES, canonical_json
from .batch_store import BatchStore, BatchStoreError
from .receipt_layout_calibration import validate_complete_layout


def _digest(value: object) -> str:
    return sha256(canonical_json(value, max_bytes=MAX_PAGE_RESULT_BYTES)).hexdigest()


def _rows_digest(rows: list[dict[str, Any]]) -> str:
    digest = sha256()
    for row in rows:
        digest.update(bytes.fromhex(_digest(row)))
    return digest.hexdigest()


def _initialize(connection: Any) -> None:
    connection.execute("""CREATE TABLE IF NOT EXISTS batch_receipt_layout_pins (
        job_id TEXT PRIMARY KEY REFERENCES batch_jobs(id) ON DELETE CASCADE,
        page_count INTEGER NOT NULL, pages_digest TEXT NOT NULL
    )""")
    connection.execute("""CREATE TABLE IF NOT EXISTS batch_receipt_layout_pin_pages (
        job_id TEXT NOT NULL REFERENCES batch_receipt_layout_pins(job_id) ON DELETE CASCADE,
        position INTEGER NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY(job_id, position)
    )""")


def pin_saved_receipt_layouts(store: BatchStore, job_id: str, generation: int, owner: str
                             ) -> dict[tuple[str, int], dict[str, Any]]:
    """Atomically select once, then validate and reload this task's fixed pin."""
    with store._transaction() as connection:
        job_row = store._job_row(connection, job_id)
        store._assert_owner_generation(connection, job_row, generation, owner)
        job = store._job_snapshot_connection(connection, job_row)
        _initialize(connection)
        pin = connection.execute("SELECT * FROM batch_receipt_layout_pins WHERE job_id=?", (job_id,)).fetchone()
        if pin is None:
            # A new task must derive geometry from the current active,
            # independently verified template snapshot (if any).  Reusing a
            # source calibration here would also let a stopped template family
            # continue through the source-calibration journal.  Existing pins
            # remain immutable below, so pause/resume of this task still uses
            # the geometry it already selected.
            rows = []
            encoded = [canonical_json(row, max_bytes=MAX_PAGE_RESULT_BYTES) for row in rows]
            store._ensure_capacity(sum(map(len, encoded)) + len(rows) * 1024 + 4096)
            connection.execute("INSERT INTO batch_receipt_layout_pins VALUES (?, ?, ?)",
                               (job_id, len(rows), _rows_digest(rows)))
            connection.executemany("INSERT INTO batch_receipt_layout_pin_pages VALUES (?, ?, ?)",
                                   [(job_id, index, payload.decode()) for index, payload in enumerate(encoded)])
            pin = connection.execute("SELECT * FROM batch_receipt_layout_pins WHERE job_id=?", (job_id,)).fetchone()
        rows = []
        result = {}
        sources = {source["source_id"]: source for source in job["sources"]}
        try:
            for index, record in enumerate(connection.execute(
                    "SELECT * FROM batch_receipt_layout_pin_pages WHERE job_id=? ORDER BY position", (job_id,))):
                if record["position"] != index:
                    raise ValueError()
                row = json.loads(record["payload_json"])
                if set(row) != {"source_id", "source_key", "source_sha256", "page", "operation_id", "layout_definition"}:
                    raise ValueError()
                source = sources[row["source_id"]]
                page = row["page"]
                if (row["source_key"] != source["source_key"] or row["source_sha256"] != source["sha256"]
                        or type(page) is not int or not 1 <= page <= source["page_count"]
                        or not isinstance(row["operation_id"], str) or not row["operation_id"]):
                    raise ValueError()
                key = (row["source_id"], page)
                if key in result:
                    raise ValueError()
                result[key] = deepcopy(validate_complete_layout(row["layout_definition"]))
                rows.append(row)
            if len(rows) != pin["page_count"] or _rows_digest(rows) != pin["pages_digest"]:
                raise ValueError()
        except (ValueError, KeyError, TypeError) as error:
            raise BatchStoreError("saved receipt layout pin is invalid") from error
        return result
