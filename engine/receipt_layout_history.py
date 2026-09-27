"""Immutable, bounded historical geometry snapshots for receipt analysis.

The only template source is the host's sibling private database. Snapshot rows
contain geometry and opaque form identities, never PDF paths, text or decisions.
"""
from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from typing import Any

from .batch_models import MAX_PAGE_RESULT_BYTES, canonical_json
from .batch_store import BatchStore, BatchStoreError, BatchCapacityExceeded
from .layout_template_store import reusable_templates
from .receipt_layout_calibration import validate_complete_layout
from .receipt_layout_reference import historical_reference


MAX_HISTORY_TEMPLATES = 256
MAX_HISTORY_BYTES = 8 * 1024 * 1024
_FIELDS = {"template_id", "source_operation_id", "layout_definition", "confirmed_slot_ids"}


def _digest(rows: list[dict[str, Any]]) -> str:
    digest = sha256()
    for row in rows:
        digest.update(sha256(canonical_json(row, max_bytes=MAX_PAGE_RESULT_BYTES)).digest())
    return digest.hexdigest()


class TemplateUnavailableError(BatchStoreError):
    """The explicitly selected template cannot authorize a new task."""


def _undone_operations(store: BatchStore) -> set[str]:
    if store.connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_receipt_calibration_undos'").fetchone():
        return {row[0] for row in store.connection.execute("SELECT operation_id FROM batch_receipt_calibration_undos")}
    return set()


def _history_group(reference: dict[str, Any]) -> bytes:
    # Visual tail layouts with different evidence versions can match the same
    # page. Budget the whole bank/form/page group, not an exact fingerprint.
    layout = reference["layout_definition"]
    return canonical_json({key: layout[key] for key in ("workspace_id", "issuer_id", "family_id", "page_geometry")})


def _drop_history_group(rows: list[dict[str, Any]]) -> None:
    group = _history_group(rows[-1])
    rows[:] = [row for row in rows if _history_group(row) != group]


def _read_references(store: BatchStore, database: Path, template_id: str | None = None) -> list[dict[str, Any]]:
    result, total = [], 0
    excluded_groups: set[bytes] = set()
    if not database.is_file() or database.resolve() != database or database == Path(store.path).resolve():
        return result
    undone = _undone_operations(store)
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='layout_templates'").fetchone():
            return result
        for template in reusable_templates(connection, template_id=template_id, withdrawn_operations=undone):
            reference = historical_reference(template)
            if reference is None:
                continue
            group = _history_group(reference)
            if group in excluded_groups:
                continue
            size = len(canonical_json(reference, max_bytes=MAX_PAGE_RESULT_BYTES))
            # Never truncate a competing series into a false unique match.
            # Scan beyond the limit to discover peers of already selected rows.
            if total + size > MAX_HISTORY_BYTES or len(result) >= MAX_HISTORY_TEMPLATES:
                excluded_groups.add(group)
                result = [row for row in result if _history_group(row) != group]
                total = sum(len(canonical_json(row, max_bytes=MAX_PAGE_RESULT_BYTES)) for row in result)
                continue
            total += size
            result.append(reference)
    return result


def selected_reference(store: BatchStore, database: Path, template_id: str) -> dict[str, Any]:
    try:
        rows = _read_references(store, database, template_id)
        if len(rows) == 1:
            return rows[0]
    except (sqlite3.Error, OSError, TypeError, ValueError, KeyError):
        pass
    raise TemplateUnavailableError("selected layout template is unavailable")


def _active_references(store: BatchStore) -> list[dict[str, Any]]:
    if store.path == ":memory:":
        return []
    try:
        return _read_references(store, Path(store.path).resolve().parent / "pdf-search.sqlite3")
    except (sqlite3.Error, OSError, TypeError, ValueError):
        # Auxiliary history cannot prevent a fresh automatic analysis.
        return []


def _validate_record(row: Any) -> dict[str, Any]:
    if not isinstance(row, dict) or set(row) not in (_FIELDS, _FIELDS | {"template_series_id"}):
        raise ValueError()
    layout = validate_complete_layout(row["layout_definition"])
    confirmed = row["confirmed_slot_ids"]
    if (layout["workspace_id"] != "default" or not layout["issuer_id"] or not layout["family_id"]
            or not isinstance(confirmed, list) or not confirmed
            or any(not isinstance(value, str) for value in confirmed)
            or len(set(confirmed)) != len(confirmed)
            or not set(confirmed) <= {slot["slot_id"] for slot in layout["slots"]}):
        raise ValueError()
    for key in ("template_id", "source_operation_id", *(["template_series_id"] if "template_series_id" in row else [])):
        if not isinstance(row[key], str) or not row[key] or len(row[key]) > 256 or "\0" in row[key]:
            raise ValueError()
    return {**deepcopy(row), "layout_definition": layout}


def _ensure_pin_tables(connection: sqlite3.Connection) -> None:
    connection.execute("""CREATE TABLE IF NOT EXISTS batch_receipt_history_pins (
        job_id TEXT PRIMARY KEY REFERENCES batch_jobs(id) ON DELETE CASCADE,
        template_count INTEGER NOT NULL, templates_digest TEXT NOT NULL
    )""")
    connection.execute("""CREATE TABLE IF NOT EXISTS batch_receipt_history_pin_rows (
        job_id TEXT NOT NULL REFERENCES batch_receipt_history_pins(job_id) ON DELETE CASCADE,
        position INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(job_id, position)
    )""")


def _write_history_pin_connection(store: BatchStore, connection: sqlite3.Connection, job_id: str,
                                  rows: list[dict[str, Any]]) -> None:
    """Internal only: caller owns the job transaction, never a renderer entry."""
    rows = [_validate_record(row) for row in rows]
    encoded = [canonical_json(row, max_bytes=MAX_PAGE_RESULT_BYTES) for row in rows]
    if len(rows) > MAX_HISTORY_TEMPLATES or sum(map(len, encoded)) > MAX_HISTORY_BYTES:
        raise BatchStoreError("historical receipt layout pin exceeds limits")
    store._ensure_capacity(sum(map(len, encoded)) + len(rows) * 1024 + 4096)
    _ensure_pin_tables(connection)
    connection.execute("INSERT INTO batch_receipt_history_pins VALUES (?, ?, ?)", (job_id, len(rows), _digest(rows)))
    connection.executemany("INSERT INTO batch_receipt_history_pin_rows VALUES (?, ?, ?)",
                           [(job_id, index, payload.decode()) for index, payload in enumerate(encoded)])


def pin_historical_receipt_layouts(store: BatchStore, job_id: str, generation: int, owner: str
                                  ) -> tuple[dict[str, Any], ...]:
    """Pin once before source processing; resumed tasks never change history."""
    with store._transaction() as connection:
        job_row = store._job_row(connection, job_id)
        store._assert_owner_generation(connection, job_row, generation, owner)
        job = store._job_snapshot_connection(connection, job_row)
        _ensure_pin_tables(connection)
        pin = connection.execute("SELECT * FROM batch_receipt_history_pins WHERE job_id=?", (job_id,)).fetchone()
        if pin is None:
            previously_started = generation > 1 or any(job["page_summary"][key] for key in ("succeeded", "failed", "processing"))
            rows = [] if previously_started else _active_references(store)
            while True:
                try:
                    _write_history_pin_connection(store, connection, job_id, rows)
                    break
                except BatchCapacityExceeded:
                    if not rows:
                        raise
                    _drop_history_group(rows)
            pin = connection.execute("SELECT * FROM batch_receipt_history_pins WHERE job_id=?", (job_id,)).fetchone()
        rows, total = [], 0
        try:
            if type(pin["template_count"]) is not int or not 0 <= pin["template_count"] <= MAX_HISTORY_TEMPLATES:
                raise ValueError()
            for index, record in enumerate(connection.execute(
                    "SELECT * FROM batch_receipt_history_pin_rows WHERE job_id=? ORDER BY position", (job_id,))):
                total += len(record["payload_json"].encode("utf-8"))
                if record["position"] != index or index >= MAX_HISTORY_TEMPLATES or total > MAX_HISTORY_BYTES:
                    raise ValueError()
                rows.append(_validate_record(json.loads(record["payload_json"])))
            if len(rows) != pin["template_count"] or _digest(rows) != pin["templates_digest"]:
                raise ValueError()
        except (ValueError, TypeError, KeyError, OverflowError) as error:
            raise BatchStoreError("historical receipt layout pin is invalid") from error
        return tuple(rows)
