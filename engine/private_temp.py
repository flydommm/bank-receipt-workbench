"""Managed private temporary directories for sensitive document derivatives."""

from __future__ import annotations

from contextlib import contextmanager
import ctypes
from itertools import islice
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
from typing import Iterator


PRIVATE_TEMP_ENV = "PDF_SEARCH_PRIVATE_TEMP"
MAX_ABANDONED_JOB_SCAN = 512
_WINDOWS_REPARSE_ATTRIBUTE = 0x0400
_JOB_NAME = re.compile(r"^job-([1-9][0-9]{0,9})-[a-z0-9-]+-[A-Za-z0-9_-]+$")
_PURPOSE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


def _default_private_root() -> Path:
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return Path(local_app_data) / "PDF Search" / "private-temp"
    cache_home = os.environ.get("XDG_CACHE_HOME")
    if cache_home:
        return Path(cache_home) / "pdf-search" / "private-temp"
    return Path.home() / ".cache" / "pdf-search" / "private-temp"


def _is_reparse_or_symlink(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except OSError:
        return True
    attributes = int(getattr(metadata, "st_file_attributes", 0))
    return stat.S_ISLNK(metadata.st_mode) or bool(attributes & _WINDOWS_REPARSE_ATTRIBUTE)


def _process_is_running(pid: int) -> bool:
    if pid == os.getpid():
        return True
    if pid <= 0 or pid > 0xFFFF_FFFF:
        return False
    if os.name == "nt":
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        open_process.restype = wintypes.HANDLE
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = [wintypes.HANDLE]
        close_handle.restype = wintypes.BOOL
        handle = open_process(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if handle:
            close_handle(handle)
            return True
        # ERROR_INVALID_PARAMETER means the PID does not exist. Access denied
        # and unexpected failures are treated as alive so cleanup fails closed.
        return ctypes.get_last_error() != 87
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True
    return True


def _remove_private_job(root: Path, job: Path) -> None:
    """Remove one direct, ordinary child without following links/junctions."""

    try:
        if _is_reparse_or_symlink(job) or not job.is_dir():
            return
        resolved = job.resolve(strict=True)
        if resolved.parent != root:
            return
        shutil.rmtree(resolved)
    except (OSError, RuntimeError):
        # A later invocation retries abandoned cleanup. Never widen deletion
        # scope merely because a sensitive file is temporarily locked.
        return


def _cleanup_abandoned_jobs(root: Path) -> None:
    try:
        entries = list(islice(root.iterdir(), MAX_ABANDONED_JOB_SCAN))
    except OSError:
        return
    for entry in entries:
        match = _JOB_NAME.fullmatch(entry.name)
        if match is None or _is_reparse_or_symlink(entry):
            continue
        try:
            pid = int(match.group(1))
        except ValueError:
            continue
        if not _process_is_running(pid):
            _remove_private_job(root, entry)


def _private_root() -> Path:
    configured = os.environ.get(PRIVATE_TEMP_ENV)
    candidate = Path(configured) if configured else _default_private_root()
    try:
        candidate.mkdir(mode=0o700, parents=True, exist_ok=True)
        if _is_reparse_or_symlink(candidate) or not candidate.is_dir():
            raise RuntimeError("private temporary root is not an ordinary directory")
        candidate.chmod(0o700)
        return candidate.resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as error:
        raise RuntimeError("private temporary storage is unavailable") from error


def private_storage_root() -> Path:
    """Return the validated, user-private root shared by engine state."""

    return _private_root()


def private_storage_directory(name: str) -> Path:
    """Create and validate one ordinary direct child of the private root."""

    if not isinstance(name, str) or _PURPOSE.fullmatch(name) is None:
        raise ValueError("invalid private storage directory name")
    root = _private_root()
    directory = root / name
    try:
        directory.mkdir(mode=0o700, exist_ok=True)
        if _is_reparse_or_symlink(directory) or not directory.is_dir():
            raise RuntimeError("private storage directory is not ordinary")
        directory.chmod(0o700)
        resolved = directory.resolve(strict=True)
        if resolved.parent != root:
            raise RuntimeError("private storage directory escaped its root")
        return resolved
    except (OSError, RuntimeError, ValueError) as error:
        raise RuntimeError("private storage directory is unavailable") from error


@contextmanager
def private_temporary_directory(purpose: str) -> Iterator[Path]:
    """Yield a process-owned directory and clean dead-process leftovers."""

    if not isinstance(purpose, str) or _PURPOSE.fullmatch(purpose) is None:
        raise ValueError("invalid private temporary purpose")
    root = _private_root()
    _cleanup_abandoned_jobs(root)
    raw_directory = tempfile.mkdtemp(
        prefix=f"job-{os.getpid()}-{purpose}-",
        dir=root,
    )
    directory = Path(raw_directory)
    try:
        directory.chmod(0o700)
        resolved = directory.resolve(strict=True)
        if resolved.parent != root or _is_reparse_or_symlink(resolved):
            raise RuntimeError("private temporary directory escaped its root")
        yield resolved
    finally:
        _remove_private_job(root, directory)
