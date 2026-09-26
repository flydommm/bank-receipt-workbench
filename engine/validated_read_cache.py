"""Bounded process-local reuse of fully audited, unchanged SQLite content.

Keys hash actual rows inside the caller's read transaction, never timestamps or
an assumed immutable result revision. A changed checkpoint, record, descriptor,
schema or source binding therefore takes the complete validation path again.
PDF bytes are deliberately outside this cache and remain checked by callers.
"""
from collections import OrderedDict
from copy import deepcopy
import hashlib
import json
import sqlite3
from threading import RLock


class ValidatedReadCache:
    def __init__(self, *, max_entries: int = 4, max_bytes: int = 32 * 1024 * 1024):
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self._entries = OrderedDict()
        self._bytes = 0
        self._lock = RLock()

    def get(self, key):
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            self._entries.move_to_end(key)
            return deepcopy(entry[1])

    def put(self, key, value):
        # Cache only JSON-shaped output that already passed the domain codec.
        size = len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
        if size > self.max_bytes or self.max_entries < 1:
            return
        with self._lock:
            old = self._entries.pop(key, None)
            if old is not None:
                self._bytes -= old[0]
            self._entries[key] = (size, deepcopy(value))
            self._bytes += size
            while len(self._entries) > self.max_entries or self._bytes > self.max_bytes:
                _, (removed_size, _) = self._entries.popitem(last=False)
                self._bytes -= removed_size


def sqlite_content_fingerprint(connection: sqlite3.Connection, queries) -> str:
    """Hash typed SQL values with unambiguous row/query framing.

    SQL and parameters come exclusively from the internal caller. Raw payload
    strings are hashed without parsing; this is cheaper than their full audit.
    The audit is reused only when *all* relevant bytes match a previous audit.
    """
    if not connection.in_transaction:
        raise ValueError("content fingerprints require a read transaction")
    digest = hashlib.sha256()
    for sql, parameters in queries:
        digest.update(b"Q")
        for row in connection.execute(sql, parameters):
            digest.update(b"R")
            for value in row:
                if isinstance(value, bytes):
                    kind, encoded = b"B", value
                else:
                    kind = b"J"
                    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
                digest.update(kind)
                digest.update(len(encoded).to_bytes(8, "big"))
                digest.update(encoded)
            digest.update(b"E")
    return digest.hexdigest()
