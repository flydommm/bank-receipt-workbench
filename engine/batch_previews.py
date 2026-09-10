"""Task ownership for host-created temporary previews; never accepts UI paths.

The export registry supplies file identity and the existing handle-based unlink
primitive. This table binds only a token in the dedicated host cache to a job.
It deliberately survives task deletion so interrupted cleanup can be retried.
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path
import stat
from typing import Any, Iterator

from .batch_models import BatchModelError
from .batch_store import BatchConflict, BatchStore
from . import engine as exports


def _initialize(store: BatchStore) -> None:
    with store._transaction() as connection:
        connection.execute("""CREATE TABLE IF NOT EXISTS batch_preview_owners (
            token TEXT PRIMARY KEY, job_id TEXT NOT NULL, root TEXT NOT NULL,
            root_identity TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_batch_preview_job ON batch_preview_owners(job_id)")


def _stable_root_path(value: Path | str) -> str:
    path = str(value)
    if os.name == "nt":
        if path.startswith("\\\\?\\UNC\\"):
            path = "\\\\" + path[8:]
        elif path.startswith("\\\\?\\"):
            path = path[4:]
    return os.path.normcase(os.path.normpath(path))


def _root_identity(root: Path) -> dict[str, int | str]:
    info = root.lstat()
    if (not stat.S_ISDIR(info.st_mode) or root.is_symlink()
            or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
        raise BatchConflict("preview directory identity is invalid")
    if root.name != "export-previews" or not root.is_absolute():
        raise BatchModelError("preview directory is not host managed")
    return {"device": info.st_dev, "inode": info.st_ino,
            "resolved_path": _stable_root_path(root.resolve(strict=True))}


def _token(value: Any) -> str:
    if not isinstance(value, str) or not exports.EXPORT_TOKEN_PATTERN.fullmatch(value):
        raise BatchModelError("invalid preview token")
    return value


def register_preview(store: BatchStore, job_id: str, token: str, root: Path) -> None:
    """Called only by the host while allocating a new managed preview path."""
    _token(token)
    identity = _root_identity(root)
    path = root / f"{token}.pdf"
    if os.path.lexists(path):
        raise BatchConflict("preview already exists")
    _initialize(store)
    with store._transaction() as connection:
        job = store._job_row(connection, job_id)
        if job["deletion_pending"] or job["state"] not in {"ready_for_review", "archived"}:
            raise BatchConflict("task cannot own an export preview")
        if connection.execute("SELECT 1 FROM batch_preview_owners WHERE token = ?", (token,)).fetchone():
            raise BatchConflict("preview token already belongs to a task")
        if connection.execute("SELECT COUNT(*) FROM batch_preview_owners WHERE job_id = ?", (job_id,)).fetchone()[0] >= 1000:
            raise BatchConflict("too many retained previews; cleanup is required")
        connection.execute("INSERT INTO batch_preview_owners(token, job_id, root, root_identity) VALUES (?, ?, ?, ?)",
                           (token, job_id, str(root), json.dumps(identity, sort_keys=True)))


def _registered(store: BatchStore, token: str) -> dict[str, Any] | None:
    row = store.connection.execute("SELECT * FROM batch_preview_owners WHERE token = ?", (token,)).fetchone()
    return dict(row) if row is not None else None


def _path(record: dict[str, Any]) -> Path:
    token = _token(record["token"])
    root = Path(record["root"])
    if _root_identity(root) != json.loads(record["root_identity"]):
        raise BatchConflict("preview directory changed")
    return root / f"{token}.pdf"


@contextmanager
def _locked_preview_root(root: Path, expected_identity: object) -> Iterator[str]:
    """Hold the managed root while resolving and deleting one preview."""

    if os.name != "nt":
        # POSIX has no matching directory-handle delete boundary in the
        # stdlib.  Pass a marker so engine cleanup reports a residual instead
        # of falling back to an unsafe pathname unlink.
        yield str(root)
        return

    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    create_file.restype = wintypes.HANDLE
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL
    get_final_path = kernel32.GetFinalPathNameByHandleW
    get_final_path.argtypes = [
        wintypes.HANDLE,
        wintypes.LPWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
    ]
    get_final_path.restype = wintypes.DWORD

    file_list_directory = 0x0001
    file_read_attributes = 0x0080
    synchronize = 0x00100000
    file_share_read = 0x00000001
    open_existing = 3
    file_flag_open_reparse_point = 0x00200000
    file_flag_backup_semantics = 0x02000000
    file_attribute_reparse_point = 0x0400
    invalid_handle = ctypes.c_void_p(-1).value

    raw_handle = create_file(
        str(root),
        file_list_directory | file_read_attributes | synchronize,
        file_share_read,
        None,
        open_existing,
        file_flag_open_reparse_point | file_flag_backup_semantics,
        None,
    )
    if raw_handle == invalid_handle:
        error_code = ctypes.get_last_error()
        raise OSError(error_code, "unable to open managed preview root")

    descriptor = -1
    try:
        descriptor = msvcrt.open_osfhandle(raw_handle, os.O_RDONLY | getattr(os, "O_BINARY", 0))
        raw_handle = None
        info = os.fstat(descriptor)
        attributes = int(getattr(info, "st_file_attributes", 0))
        if not stat.S_ISDIR(info.st_mode) or attributes & file_attribute_reparse_point:
            raise BatchConflict("preview directory identity is invalid")
        actual_identity = {"device": info.st_dev, "inode": info.st_ino}
        if (not isinstance(expected_identity, dict)
                or actual_identity != {key: expected_identity.get(key) for key in ("device", "inode")}
                or not isinstance(expected_identity.get("resolved_path"), str)):
            raise BatchConflict("preview directory changed")

        buffer = ctypes.create_unicode_buffer(512)
        while True:
            length = get_final_path(
                msvcrt.get_osfhandle(descriptor),
                buffer,
                len(buffer),
                0,  # FILE_NAME_NORMALIZED
            )
            if length == 0:
                error_code = ctypes.get_last_error()
                raise OSError(error_code, "unable to resolve managed preview root")
            if length < len(buffer):
                final_root = buffer[:length]
                if _stable_root_path(final_root) != expected_identity["resolved_path"]:
                    raise BatchConflict("preview directory moved outside its registered location")
                yield final_root
                return
            if len(buffer) >= 32_768:
                raise OSError(206, "managed preview root path is too long")
            buffer = ctypes.create_unicode_buffer(len(buffer) * 2)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        elif raw_handle not in (None, invalid_handle):
            close_handle(raw_handle)


def snapshot_previews(store: BatchStore, job_id: str) -> list[dict[str, Any]]:
    _initialize(store)
    records = [dict(row) for row in store.connection.execute(
        "SELECT * FROM batch_preview_owners WHERE job_id = ? ORDER BY token", (job_id,))]
    result = []
    for record in records:
        item = {**record, "identity": None, "state": "unverified"}
        try:
            path = _path(record)
            if not os.path.lexists(path):
                item["state"] = "absent"
            else:
                item["identity"] = exports._owned_created_output_identity(record["token"], path, "pdf")
                item["state"] = "owned"
        except (OSError, ValueError, BatchConflict, exports.ExportOwnershipError):
            pass
        result.append(item)
    return result


def cleanup_previews(store: BatchStore, identities: list[dict[str, Any]]) -> dict[str, Any]:
    """Receives a persisted server plan, never raw webview cleanup paths."""
    _initialize(store)
    outcomes = []
    for item in identities:
        token = _token(item.get("token"))
        current = _registered(store, token)
        outcome = "unverified"
        if current is None:
            # A previously completed cleanup removes the registration only
            # after proving absence/deletion. A foreign replacement is never
            # removed even if it later occupies that former filename.
            outcome = "already_released"
        elif any(current[field] != item.get(field) for field in ("job_id", "root", "root_identity")):
            outcome = "owner_mismatch"
        else:
            try:
                root = Path(current["root"])
                with _locked_preview_root(root, json.loads(current["root_identity"])) as expected_parent:
                    path = _path(current)
                    if not os.path.lexists(path):
                        outcome = "absent"
                    else:
                        identity = item.get("identity")
                        if identity is None and item.get("state") == "unverified":
                            identity = exports._owned_created_output_identity(token, path, "pdf")
                        if identity is not None:
                            removed = exports._unlink_owned_file(
                                path,
                                identity,
                                expected_parent=expected_parent,
                            )
                            if removed is exports._UnlinkOutcome.DELETED:
                                outcome = "deleted"
                            elif removed is exports._UnlinkOutcome.IDENTITY_MISMATCH:
                                outcome = "identity_mismatch"
                            else:
                                outcome = "retryable_failure"
            except (OSError, ValueError, BatchConflict, exports.ExportOwnershipError):
                outcome = "unverified"
        if outcome in {"deleted", "absent"}:
            with store._transaction() as connection:
                connection.execute("DELETE FROM batch_preview_owners WHERE token = ? AND job_id = ?",
                                   (token, item["job_id"]))
        outcomes.append({"token": token, "outcome": outcome})
    residuals = [item for item in outcomes if item["outcome"] not in {"deleted", "absent", "already_released"}]
    state = "residual" if residuals else "cleaned" if any(item["outcome"] == "deleted" for item in outcomes) else "absent"
    return {"state": state, "complete": not residuals, "items": outcomes, "residuals": residuals}


def release_absent_preview(store: BatchStore, token: str) -> None:
    """After ordinary preview close, forget only registrations proven absent."""
    _initialize(store)
    _token(token)
    current = _registered(store, token)
    if current is not None and not os.path.lexists(_path(current)):
        with store._transaction() as connection:
            connection.execute("DELETE FROM batch_preview_owners WHERE token = ?", (token,))
