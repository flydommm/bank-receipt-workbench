"""Handle-backed protection for ordinary export destination directories.

The publication code writes children of a user-selected directory and then
renames a temporary child into place.  A pathname identity check alone leaves
an empty-directory window in which another actor can replace the directory by
a junction/reparse point.  Windows therefore uses a short-lived guard file to
make the directory non-empty while a read/write directory handle (without
delete sharing) protects the parent during the write/rename boundary.

POSIX does not expose an equivalent portable directory-handle boundary in the
standard library.  The helper fails explicitly there rather than pretending
that before/after ``stat`` checks provide the same guarantee.
"""

from __future__ import annotations

from contextlib import contextmanager
import ctypes
import os
from pathlib import Path
import stat
from typing import Iterator
from uuid import uuid4


_WINDOWS_REPARSE_POINT = 0x0400
_FILE_ATTRIBUTE_HIDDEN = 0x00000002
_FILE_ATTRIBUTE_TEMPORARY = 0x00000100
_FILE_FLAG_DELETE_ON_CLOSE = 0x04000000
_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
_FILE_LIST_DIRECTORY = 0x0001
_FILE_READ_ATTRIBUTES = 0x0080
_SYNCHRONIZE = 0x00100000
_GENERIC_READ = 0x80000000
_GENERIC_WRITE = 0x40000000
_DELETE = 0x00010000
_FILE_SHARE_READ = 0x00000001
_FILE_SHARE_WRITE = 0x00000002
_OPEN_EXISTING = 3
_CREATE_NEW = 1
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_FILE_RENAME_INFO = 3
_FILE_DISPOSITION_INFO = 4


class ExportDirectoryError(RuntimeError):
    """The selected directory cannot be safely protected for publication."""


def _stable_path(value: Path | str) -> str:
    """Normalize native and extended Windows paths for identity comparison."""

    path = os.fspath(value)
    if os.name == "nt":
        if path.startswith("\\\\?\\UNC\\"):
            path = "\\\\" + path[8:]
        elif path.startswith("\\\\?\\"):
            path = path[4:]
    return os.path.normcase(os.path.normpath(path))


def _is_reparse(info: os.stat_result) -> bool:
    return bool(int(getattr(info, "st_file_attributes", 0)) & _WINDOWS_REPARSE_POINT)


def directory_identity(path: Path | str) -> dict[str, int | str]:
    """Return the identity of an existing ordinary absolute directory.

    The returned fields intentionally match the identities already persisted
    by the export scope and journal layers: device, inode and the resolved
    path.  A symlink/reparse point is never accepted as the selected root.
    """

    if isinstance(path, Path):
        candidate = path
    elif isinstance(path, str):
        candidate = Path(path)
    else:
        raise ExportDirectoryError("export directory is invalid")
    raw = str(candidate)
    if not candidate.is_absolute() or "\x00" in raw:
        raise ExportDirectoryError("export directory must be an existing absolute directory")
    try:
        info = candidate.lstat()
        resolved = candidate.resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as error:
        raise ExportDirectoryError("export directory is unavailable") from error
    if not stat.S_ISDIR(info.st_mode) or candidate.is_symlink() or _is_reparse(info):
        raise ExportDirectoryError("export directory must be an ordinary directory")
    return {
        "device": int(info.st_dev),
        "inode": int(info.st_ino),
        "resolved_path": _stable_path(resolved),
    }


def _same_identity(actual: object, expected: object, *, require_path: bool = True) -> bool:
    if not isinstance(actual, dict) or not isinstance(expected, dict):
        return False
    try:
        if int(actual["device"]) != int(expected["device"]):
            return False
        if int(actual["inode"]) != int(expected["inode"]):
            return False
        if require_path and _stable_path(str(actual["resolved_path"])) != _stable_path(str(expected["resolved_path"])):
            return False
    except (KeyError, TypeError, ValueError):
        return False
    return True


def _win32_functions() -> tuple[object, object, object]:
    import ctypes.wintypes as wintypes

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
    return create_file, close_handle, get_final_path


def _open_windows_handle(
    path: Path,
    desired_access: int,
    share: int,
    *,
    disposition: int = _OPEN_EXISTING,
    flags: int = _FILE_FLAG_OPEN_REPARSE_POINT | _FILE_FLAG_BACKUP_SEMANTICS,
) -> int:
    create_file, close_handle, _get_final_path = _win32_functions()
    raw = create_file(
        str(path),
        desired_access,
        share,
        None,
        disposition,
        flags,
        None,
    )
    if raw == _INVALID_HANDLE_VALUE:
        code = ctypes.get_last_error()
        raise OSError(code, "unable to open export directory")
    try:
        import msvcrt

        descriptor = msvcrt.open_osfhandle(raw, os.O_RDONLY | getattr(os, "O_BINARY", 0))
    except BaseException:
        close_handle(raw)
        raise
    return descriptor


def _open_windows_directory(path: Path, share: int) -> int:
    return _open_windows_handle(
        path,
        _FILE_LIST_DIRECTORY | _FILE_READ_ATTRIBUTES | _SYNCHRONIZE,
        share,
    )


def _set_file_information(descriptor: int, information_class: int, payload: object) -> None:
    """Apply one native file-information update to an already-open handle."""

    import ctypes.wintypes as wintypes
    import msvcrt

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    set_file_information = kernel32.SetFileInformationByHandle
    set_file_information.argtypes = [
        wintypes.HANDLE,
        wintypes.INT,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    set_file_information.restype = wintypes.BOOL
    if not set_file_information(
        msvcrt.get_osfhandle(descriptor),
        information_class,
        ctypes.byref(payload),
        ctypes.sizeof(payload),
    ):
        code = ctypes.get_last_error()
        raise OSError(code, "unable to update export directory handle")


def _coerce_operation_path(value: Path | str, label: str) -> Path:
    candidate = value if isinstance(value, Path) else Path(value) if isinstance(value, str) else None
    if candidate is None or not candidate.is_absolute() or "\x00" in str(candidate):
        raise ExportDirectoryError(f"{label} is invalid")
    return candidate


def _validate_same_parent_paths(source: Path | str, destination: Path | str) -> tuple[Path, Path, Path]:
    source_path = _coerce_operation_path(source, "source directory")
    destination_path = _coerce_operation_path(destination, "destination directory")
    if not source_path.name or source_path.name in {".", ".."}:
        raise ExportDirectoryError("source directory name is invalid")
    if not destination_path.name or destination_path.name in {".", ".."}:
        raise ExportDirectoryError("destination directory name is invalid")
    if source_path.parent != destination_path.parent:
        raise ExportDirectoryError("source and destination directories must share a parent")
    return source_path, destination_path, source_path.parent


def _windows_rename_directory_handle(source: Path, destination: Path, parent_descriptor: int, source_descriptor: int) -> None:
    """Rename ``source`` from its opened handle without replacement.

    Windows rejects a relative ``FileRenameInfo`` name rooted at a directory
    handle for some ordinary directory providers (ERROR_INVALID_PARAMETER).
    The parent handle is still held and verified for the whole operation; the
    native request uses the absolute same-parent destination while the source
    object itself is bound to ``source_descriptor``.
    """

    import ctypes.wintypes as wintypes
    import msvcrt

    class FileRenameInfo(ctypes.Structure):
        _fields_ = [
            ("replace_if_exists", ctypes.c_ubyte),
            ("root_directory", wintypes.HANDLE),
            ("file_name_length", wintypes.DWORD),
            ("file_name", wintypes.WCHAR * 1),
        ]

    # Keep the destination absolute for provider compatibility.  The source
    # and parent handles still provide the identity and same-parent boundary;
    # ``replace_if_exists=0`` makes the kernel's no-replace check authoritative.
    _ = parent_descriptor
    name = os.path.abspath(os.fspath(destination)).replace("/", "\\")
    name_bytes = name.encode("utf-16-le", "strict")
    name_offset = FileRenameInfo.file_name.offset
    buffer = ctypes.create_string_buffer(name_offset + len(name_bytes) + 2)
    rename_info = ctypes.cast(buffer, ctypes.POINTER(FileRenameInfo)).contents
    rename_info.replace_if_exists = 0
    rename_info.root_directory = None
    rename_info.file_name_length = len(name_bytes)
    ctypes.memmove(
        ctypes.addressof(buffer) + name_offset,
        name_bytes,
        len(name_bytes),
    )
    try:
        _set_file_information(source_descriptor, _FILE_RENAME_INFO, buffer)
    except OSError as error:
        code = getattr(error, "winerror", None)
        if code is None:
            code = getattr(error, "errno", None)
        if code in {80, 183}:  # ERROR_FILE_EXISTS / ERROR_ALREADY_EXISTS
            raise FileExistsError(code, "destination directory already exists") from error
        raise


def _windows_delete_directory_handle(descriptor: int) -> None:
    import ctypes

    class FileDispositionInfo(ctypes.Structure):
        _fields_ = [("delete_file", ctypes.c_ubyte)]

    _set_file_information(descriptor, _FILE_DISPOSITION_INFO, FileDispositionInfo(1))


def _validate_expected_child(expected: object, parent: Path, label: str) -> None:
    try:
        resolved = Path(str(expected["resolved_path"]))  # type: ignore[index]
    except (KeyError, TypeError, ValueError):
        raise ExportDirectoryError(f"{label} identity is invalid") from None
    if _stable_path(resolved.parent) != _stable_path(parent):
        raise ExportDirectoryError(f"{label} is outside the selected parent")


def rename_directory_no_replace(
    source: Path | str,
    destination: Path | str,
    expected_source_identity: object,
    expected_parent_identity: object,
) -> None:
    """Rename an exact opened child directory to a new same-parent name.

    The source and parent handles stay open through ``FileRenameInfo``.  The
    destination is resolved as an absolute same-parent path for compatibility
    with local Windows directory providers, and ``replace_if_exists=0``
    remains authoritative if a foreign entry appears after preflight.
    """

    source_path, destination_path, parent = _validate_same_parent_paths(source, destination)
    if os.name != "nt":
        _unsupported_posix()
    _validate_expected_child(expected_source_identity, parent, "source directory")
    if not isinstance(expected_parent_identity, dict):
        raise ExportDirectoryError("parent directory identity is invalid")
    try:
        current_parent = directory_identity(parent)
    except ExportDirectoryError:
        raise
    if not _same_identity(current_parent, expected_parent_identity):
        raise ExportDirectoryError("parent directory identity changed")

    parent_descriptor = -1
    source_descriptor = -1
    try:
        # Keep a guard-backed writable parent for the complete operation.  A
        # source directory handle opened without FILE_SHARE_DELETE then binds
        # the rename to the exact inode checked below.
        with writable_directory(parent, expected_parent_identity):
            parent_descriptor = _open_windows_directory(parent, _FILE_SHARE_READ | _FILE_SHARE_WRITE)
            _handle_identity(parent, parent_descriptor, expected_parent_identity)
            source_descriptor = _open_windows_handle(
                source_path,
                _GENERIC_READ | _DELETE | _FILE_READ_ATTRIBUTES,
                _FILE_SHARE_READ | _FILE_SHARE_WRITE,
            )
            _handle_identity(source_path, source_descriptor, expected_source_identity)
            if os.path.lexists(destination_path):
                raise FileExistsError(183, "destination directory already exists")
            _windows_rename_directory_handle(
                source_path,
                destination_path,
                parent_descriptor,
                source_descriptor,
            )
    except FileExistsError:
        raise
    except ExportDirectoryError:
        raise
    except (OSError, ValueError, TypeError, UnicodeError) as error:
        raise ExportDirectoryError("atomic no-replace directory rename failed") from error
    finally:
        if source_descriptor >= 0:
            _close_descriptor(source_descriptor)
        if parent_descriptor >= 0:
            _close_descriptor(parent_descriptor)


def remove_directory_owned(
    path: Path | str,
    expected_identity: object,
    expected_parent_identity: object,
) -> None:
    """Delete exactly one verified empty child directory through its handle."""

    target, _unused_destination, parent = _validate_same_parent_paths(path, path)
    if os.name != "nt":
        _unsupported_posix()
    _validate_expected_child(expected_identity, parent, "temporary directory")
    if not isinstance(expected_parent_identity, dict):
        raise ExportDirectoryError("parent directory identity is invalid")
    try:
        current_parent = directory_identity(parent)
    except ExportDirectoryError:
        raise
    if not _same_identity(current_parent, expected_parent_identity):
        raise ExportDirectoryError("parent directory identity changed")

    parent_descriptor = -1
    target_descriptor = -1
    try:
        with writable_directory(parent, expected_parent_identity):
            parent_descriptor = _open_windows_directory(parent, _FILE_SHARE_READ | _FILE_SHARE_WRITE)
            _handle_identity(parent, parent_descriptor, expected_parent_identity)
            target_descriptor = _open_windows_handle(
                target,
                _GENERIC_READ | _DELETE | _FILE_READ_ATTRIBUTES,
                _FILE_SHARE_READ | _FILE_SHARE_WRITE,
            )
            _handle_identity(target, target_descriptor, expected_identity)
            _windows_delete_directory_handle(target_descriptor)
    except ExportDirectoryError:
        raise
    except OSError as error:
        code = getattr(error, "winerror", None)
        if code is None:
            code = getattr(error, "errno", None)
        if code == 145:  # ERROR_DIR_NOT_EMPTY
            raise ExportDirectoryError("temporary directory is not empty") from error
        raise ExportDirectoryError("owned temporary directory removal failed") from error
    except (ValueError, TypeError) as error:
        raise ExportDirectoryError("owned temporary directory removal failed") from error
    finally:
        if target_descriptor >= 0:
            _close_descriptor(target_descriptor)
        if parent_descriptor >= 0:
            _close_descriptor(parent_descriptor)


def _close_descriptor(descriptor: int) -> None:
    try:
        os.close(descriptor)
    except OSError:
        pass


def _handle_identity(path: Path, descriptor: int, expected: object) -> None:
    info = os.fstat(descriptor)
    if not stat.S_ISDIR(info.st_mode) or _is_reparse(info):
        raise ExportDirectoryError("export directory handle is not an ordinary directory")
    try:
        expected_pair = (int(expected["device"]), int(expected["inode"]))  # type: ignore[index]
    except (KeyError, TypeError, ValueError):
        raise ExportDirectoryError("export directory identity is invalid") from None
    if (int(info.st_dev), int(info.st_ino)) != expected_pair:
        raise ExportDirectoryError("export directory identity changed")
    try:
        _create_file, _close_handle, get_final_path = _win32_functions()
        import msvcrt

        buffer = ctypes.create_unicode_buffer(512)
        while True:
            length = get_final_path(
                msvcrt.get_osfhandle(descriptor),
                buffer,
                len(buffer),
                0,  # FILE_NAME_NORMALIZED
            )
            if length == 0:
                code = ctypes.get_last_error()
                raise OSError(code, "unable to resolve export directory")
            if length < len(buffer):
                actual_path = _stable_path(buffer[:length])
                break
            if len(buffer) >= 32768:
                raise OSError(206, "export directory path is too long")
            buffer = ctypes.create_unicode_buffer(len(buffer) * 2)
    except OSError as error:
        raise ExportDirectoryError("export directory handle cannot be resolved") from error
    try:
        expected_path = _stable_path(str(expected["resolved_path"]))  # type: ignore[index]
    except (KeyError, TypeError, ValueError):
        raise ExportDirectoryError("export directory identity is invalid") from None
    if actual_path != expected_path or not _same_identity(directory_identity(path), expected):
        raise ExportDirectoryError("export directory identity changed")


def _create_guard(path: Path) -> int:
    """Create an exclusive delete-on-close child with restrictive sharing."""

    create_file, close_handle, _get_final_path = _win32_functions()
    import msvcrt
    last_error: OSError | None = None
    for _ in range(32):
        guard = path / f".{uuid4().hex}.export-directory-guard"
        raw = create_file(
            str(guard),
            _GENERIC_READ | _GENERIC_WRITE | _DELETE,
            _FILE_SHARE_READ,
            None,
            _CREATE_NEW,
            _FILE_ATTRIBUTE_HIDDEN | _FILE_ATTRIBUTE_TEMPORARY | _FILE_FLAG_DELETE_ON_CLOSE,
            None,
        )
        if raw != _INVALID_HANDLE_VALUE:
            descriptor = -1
            try:
                descriptor = msvcrt.open_osfhandle(raw, os.O_RDWR | getattr(os, "O_BINARY", 0))
                raw = _INVALID_HANDLE_VALUE
                handle_info = os.fstat(descriptor)
                path_info = guard.lstat()
                if (
                    not stat.S_ISREG(handle_info.st_mode)
                    or _is_reparse(handle_info)
                    or not stat.S_ISREG(path_info.st_mode)
                    or _is_reparse(path_info)
                    or (int(handle_info.st_dev), int(handle_info.st_ino))
                    != (int(path_info.st_dev), int(path_info.st_ino))
                ):
                    raise ExportDirectoryError("export directory guard identity is invalid")
                return descriptor
            except BaseException:
                if raw != _INVALID_HANDLE_VALUE:
                    close_handle(raw)
                elif descriptor >= 0:
                    _close_descriptor(descriptor)
                raise
        code = ctypes.get_last_error()
        if code in {183}:  # ERROR_FILE_EXISTS / ERROR_ALREADY_EXISTS
            continue
        last_error = OSError(code, "unable to create export directory guard")
        break
    if last_error is not None:
        raise last_error
    raise OSError(183, "unable to create a unique export directory guard")


def _unsupported_posix() -> None:
    raise ExportDirectoryError("safe writable export directory is unsupported on this platform")


@contextmanager
def writable_directory(path: Path | str, expected_identity: object) -> Iterator[Path]:
    """Protect ``path`` while callers create children and rename one child.

    The context yields the original ``Path``.  On Windows the strict
    read-shared handle is acquired first, then an exclusive delete-on-close
    guard child is created, then a read/write directory handle without delete
    sharing is acquired.  The strict handle is released only after the latter
    is active.  On exit the strict handle is reacquired before the writable
    handle and guard are closed, so there is no unprotected empty-directory
    interval.
    """

    candidate = path if isinstance(path, Path) else Path(path) if isinstance(path, str) else None
    if candidate is None:
        raise ExportDirectoryError("export directory is invalid")
    # Validate the lexical and ordinary-directory constraints before opening
    # native handles.  The strict handle repeats the identity check at the
    # actual operation boundary below.
    try:
        current = directory_identity(candidate)
    except ExportDirectoryError:
        raise
    if not _same_identity(current, expected_identity):
        raise ExportDirectoryError("export directory identity changed")
    if os.name != "nt":
        _unsupported_posix()

    strict_descriptor = -1
    writable_descriptor = -1
    guard_descriptor = -1
    close_error: BaseException | None = None
    try:
        strict_descriptor = _open_windows_directory(candidate, _FILE_SHARE_READ)
        _handle_identity(candidate, strict_descriptor, expected_identity)
        guard_descriptor = _create_guard(candidate)
        writable_descriptor = _open_windows_directory(candidate, _FILE_SHARE_READ | _FILE_SHARE_WRITE)
        _handle_identity(candidate, writable_descriptor, expected_identity)
        _close_descriptor(strict_descriptor)
        strict_descriptor = -1
        try:
            yield candidate
        except BaseException as error:
            close_error = error
        finally:
            # Reacquire the strict handle while the writable handle and guard
            # are still holding the directory in its protected state.
            final_strict = -1
            try:
                final_strict = _open_windows_directory(candidate, _FILE_SHARE_READ)
                _handle_identity(candidate, final_strict, expected_identity)
            except BaseException as error:
                if close_error is None:
                    close_error = error
            finally:
                if writable_descriptor >= 0:
                    _close_descriptor(writable_descriptor)
                    writable_descriptor = -1
                if guard_descriptor >= 0:
                    _close_descriptor(guard_descriptor)
                    guard_descriptor = -1
                if final_strict >= 0:
                    _close_descriptor(final_strict)
            if close_error is not None:
                raise close_error
    finally:
        # If setup failed before entering the body, no strict reacquisition is
        # needed.  The guard is still closed only after any writable handle,
        # preserving the no-delete boundary until all setup cleanup is done.
        if writable_descriptor >= 0:
            _close_descriptor(writable_descriptor)
        if guard_descriptor >= 0:
            _close_descriptor(guard_descriptor)
        if strict_descriptor >= 0:
            _close_descriptor(strict_descriptor)
