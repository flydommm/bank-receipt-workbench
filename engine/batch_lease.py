"""Cross-process lifecycle lease for a persistent batch worker.

The lease is deliberately tied to the private SQLite database supplied to a
worker.  A worker therefore cannot choose an unrelated lock location, and a
host can use the same fixed file when it coordinates activation and recovery.
The lock file is kept after release; only the operating-system lock is
released.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import os
from typing import Iterator


class BatchLeaseError(RuntimeError):
    """The worker lifecycle lease could not be acquired or prepared."""


if os.name == "nt":
    import msvcrt
else:  # pragma: no cover - selected by the host operating system
    import fcntl


def _lock_path(database: str | Path) -> Path:
    """Return the only supported lease location for a private batch DB."""

    try:
        path = Path(database)
    except (TypeError, ValueError):
        raise ValueError("batch database path must be an absolute SQLite path") from None
    if not path.is_absolute() or path.suffix != ".sqlite3":
        raise ValueError("batch database path must be an absolute SQLite path")
    return path.parent / "batch-worker.lock"


def _open_lock(lock_path: Path) -> int:
    """Open and lock the fixed lease file without changing its contents."""

    flags = os.O_RDWR | os.O_CREAT
    # Keep the descriptor out of child processes even on runtimes where the
    # platform's open flags do not provide close-on-exec by default.
    flags |= getattr(os, "O_CLOEXEC", 0)
    if os.name == "nt":
        flags |= getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0)

    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError:
        raise BatchLeaseError("worker lease unavailable") from None

    try:
        os.set_inheritable(descriptor, False)
        if os.name == "nt":
            # msvcrt.locking locks bytes beginning at the current position.
            # The first byte is valid even when this newly-created file is
            # still empty; no marker is written to the lease file.
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        try:
            os.close(descriptor)
        finally:
            raise BatchLeaseError("worker lease unavailable") from None
    return descriptor


def _close_lock(descriptor: int) -> None:
    """Release the OS lease and always close the caller-owned descriptor."""

    try:
        if os.name == "nt":
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
    except OSError:
        # Closing the descriptor still releases the lock.  Do not hide a
        # worker exception behind a best-effort cleanup operation.
        pass
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass


@contextmanager
def worker_lease(database: str | Path) -> Iterator[None]:
    """Hold the database's fixed worker lease for the context duration.

    Acquisition is non-blocking.  All acquisition failures intentionally use
    the same path-free error so private database paths cannot leak through an
    IPC or stderr message.
    """

    descriptor = _open_lock(_lock_path(database))
    try:
        yield
    finally:
        _close_lock(descriptor)


__all__ = ["BatchLeaseError", "worker_lease"]
