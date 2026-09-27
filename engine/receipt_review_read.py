"""Read-only receipt review recovery, without migration or ownership changes."""

from copy import deepcopy
from pathlib import Path
import sqlite3

from .batch_models import MAX_JSON_BYTES
from .receipt_review_store import current_record, read_records, validate_context_row, validate_receipt_schema, _same_original, _decode, _excluded_outside_result
from .review_read import _read_only_uri
from .review_store_v2 import (
    ReviewRevisionConflict, ReviewStoreCorruptionError, ReviewStoreError,
    _bounded_result_revision, _require_sha,
)
from .validated_read_cache import ValidatedReadCache, sqlite_content_fingerprint


_RECEIPT_READ_CACHE = ValidatedReadCache()


def read_receipt_review_snapshot(database_path: str | Path, context_key: str, result_revision: str):
    return read_receipt_review_binding(database_path, context_key, result_revision)["snapshot"]


def read_receipt_review_binding(database_path: str | Path, context_key: str, result_revision: str):
    """Audit descriptor, manifest and historical records in one read view."""
    key = _require_sha(context_key, "context_key", lowercase=True)
    revision = _bounded_result_revision(result_revision)
    uri = _read_only_uri(database_path)
    connection = None
    try:
        try:
            connection = sqlite3.connect(uri, uri=True, isolation_level=None)
        except (OSError, sqlite3.Error):
            raise ReviewStoreError("review database cannot be opened") from None
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        scoped = validate_receipt_schema(connection)
        record_order = "source_key,instance_id,decision_scope" if scoped else "source_key,instance_id"
        fingerprint = sqlite_content_fingerprint(connection, [
            ("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name", ()),
            ("SELECT * FROM review_contexts_v2 WHERE context_key=?", (key,)),
            (f"SELECT * FROM review_receipt_records_v1 WHERE context_key=? ORDER BY {record_order}", (key,)),
            ("SELECT * FROM review_segments_v2 WHERE context_key=? ORDER BY id", (key,)),
        ])
        cache_key = (uri, key, revision, fingerprint)
        cached = _RECEIPT_READ_CACHE.get(cache_key)
        if cached is not None:
            return cached
        row = connection.execute("SELECT * FROM review_contexts_v2 WHERE context_key=?", (key,)).fetchone()
        if row is None:
            raise ReviewStoreError("review context does not exist")
        try:
            descriptor = _decode(row["descriptor_json"], MAX_JSON_BYTES)
        except (TypeError, ValueError, RecursionError, OverflowError):
            raise ReviewStoreCorruptionError("stored receipt context is invalid") from None
        descriptor, items = validate_context_row(row, descriptor, key)
        if row["result_revision"] != revision:
            raise ReviewRevisionConflict(context_key=key, expected_revision=None, actual_revision=None,
                                         message="result_revision does not match current receipt context")
        stored = read_records(connection, key, descriptor)
        public_records, revisions = [], []
        for item in items:
            record = current_record(stored, item, revision)
            revisions.append({"id": item["id"], "source_key": item["source_key"], "instance_id": item["instance_id"],
                              "source_page": item["source_page"], "position_index": item["position_index"],
                              "record_revision": 0 if record is None else record["record_revision"]})
            if record is None or record["original"]["analysis_signature"] != item["analysis_signature"]:
                continue
            # A recovery read never repairs IDs, geometry or revisions. Those
            # transitions belong to an attested prepare transaction.
            if not _same_original(record["original"], item):
                raise ReviewStoreCorruptionError("stored receipt binding is not current")
            if _excluded_outside_result(record, item, revision):
                continue
            if (record["original"]["id"] != item["id"]
                    or record["result_revision"] != revision):
                raise ReviewStoreCorruptionError("stored receipt binding is not current")
            public_records.append(deepcopy(record))
        result = {"descriptor": descriptor, "originals": items, "snapshot": {
            "schema_version": 1, "context_key": key, "result_revision": revision,
            "segments": public_records, "record_revisions": revisions, "group_confirmed": False}}
        _RECEIPT_READ_CACHE.put(cache_key, result)
        return result
    except (sqlite3.Error, IndexError, KeyError):
        # A damaged or older table must be a domain error at the protocol
        # boundary, without exposing raw SQL or attempting a recovery write.
        raise ReviewStoreCorruptionError("stored receipt review database is incompatible") from None
    finally:
        if connection is not None:
            try:
                if connection.in_transaction:
                    connection.rollback()
            finally:
                connection.close()
