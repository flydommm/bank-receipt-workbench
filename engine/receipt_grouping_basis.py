"""Bounded warm-process reuse of fully audited grouping inputs.

Only in-memory, already validated data is retained. Every request hashes all
analysis/review rows in read transactions; the same stamp is checked again
under the existing write locks. No timestamp, revision alone, or persisted
cache can authorize a grouping operation.
"""
from collections import OrderedDict
from contextlib import ExitStack
from copy import deepcopy
import json
from pathlib import Path
from threading import RLock

from .batch_review import _receipt_context_key
from .receipt_grouping_models import GroupingConflict
from .validated_read_cache import sqlite_content_fingerprint


def content_stamp(store, grouping, job_id, result_revision):
    """Read complete input bytes, including schema and historical reviews."""
    with ExitStack() as stack:
        if not store.connection.in_transaction:
            stack.enter_context(store._transaction(immediate=False))
        if not grouping.connection.in_transaction:
            stack.enter_context(grouping.transaction(immediate=False))
        row = store.connection.execute(
            "SELECT context_json FROM batch_snapshots WHERE job_id=? AND result_revision=?",
            (job_id, result_revision),
        ).fetchone()
        if row is None:
            raise GroupingConflict("当前分析结果已变化，请重新载入归组")
        try:
            _, context_key = _receipt_context_key(json.loads(row["context_json"]))
        except (TypeError, ValueError):
            raise GroupingConflict("当前分析结果无效，请重新分析") from None
        batch_stamp = sqlite_content_fingerprint(store.connection, [
            ("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name", ()),
            ("SELECT * FROM batch_jobs WHERE id=?", (job_id,)),
            ("SELECT * FROM batch_sources WHERE job_id=? ORDER BY position", (job_id,)),
            ("SELECT * FROM batch_pages WHERE job_id=? ORDER BY source_id,page,stage", (job_id,)),
            ("SELECT * FROM batch_page_results WHERE job_id=? ORDER BY source_id,page,stage", (job_id,)),
            ("SELECT * FROM batch_snapshots WHERE job_id=? AND result_revision=?", (job_id, result_revision)),
            ("SELECT * FROM batch_snapshot_items WHERE job_id=? AND result_revision=? ORDER BY position", (job_id, result_revision)),
        ])
        # rowid keeps both legacy and scoped record schemas compatible. Every
        # column remains in the digest, including any unexpected alteration.
        review_stamp = sqlite_content_fingerprint(grouping.connection, [
            ("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN ('review_contexts_v2','review_receipt_records_v1','review_segments_v2') ORDER BY type,name", ()),
            ("SELECT * FROM review_contexts_v2 WHERE context_key=?", (context_key,)),
            ("SELECT * FROM review_receipt_records_v1 WHERE context_key=? ORDER BY rowid", (context_key,)),
            ("SELECT * FROM review_segments_v2 WHERE context_key=? ORDER BY id", (context_key,)),
        ])
    return batch_stamp, review_stamp


class GroupingBasisCache:
    def __init__(self, *, max_entries=2, max_bytes=64 * 1024 * 1024):
        self.max_entries, self.max_bytes = max_entries, max_bytes
        self._entries, self._bytes, self._lock = OrderedDict(), 0, RLock()

    def get(self, key, selected_ids=None):
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            self._entries.move_to_end(key)
            snapshot, items, review_fp = entry[1]
            if selected_ids is None:
                return deepcopy((snapshot, items, review_fp))
            # Pages/save need only the attested job and review fingerprint;
            # extraction needs at most 50 authoritative fragments.
            return ({"job": deepcopy(snapshot["job"])},
                    deepcopy([item for item in items if item["id"] in selected_ids]), review_fp)

    def put(self, key, value):
        size = len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
        if size > self.max_bytes or self.max_entries < 1:
            return
        with self._lock:
            prior = self._entries.pop(key, None)
            if prior is not None:
                self._bytes -= prior[0]
            self._entries[key] = (size, deepcopy(value))
            self._bytes += size
            while len(self._entries) > self.max_entries or self._bytes > self.max_bytes:
                _, (removed, _) = self._entries.popitem(last=False)
                self._bytes -= removed


_BASIS_CACHE = GroupingBasisCache()


def trusted_basis(store, grouping, job_id, result_revision, database, loader, *, selected_ids=None):
    from .computation import current_computation_version
    version = current_computation_version()
    stamp = content_stamp(store, grouping, job_id, result_revision)
    batch_identity = store.connection if store.path == ":memory:" else str(Path(store.path).resolve())
    key = (batch_identity, str(Path(database).resolve()), job_id, result_revision, version, stamp)
    value = _BASIS_CACHE.get(key, selected_ids)
    if value is None:
        full = loader(store, job_id, result_revision, database)
        if content_stamp(store, grouping, job_id, result_revision) != stamp:
            raise GroupingConflict("审核结果已变化，请重新载入归组")
        _BASIS_CACHE.put(key, full)
        value = full
    if value[0]["job"]["computation_version"] != version:
        raise GroupingConflict("当前分析不能用于交易对手整理")
    return (*value, stamp)
