"""Local PDF/OCR engine entrypoint. Only --health is side-effect free."""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat as stat_module
import sqlite3
import sys
import tempfile
from typing import Iterator, TextIO
import unicodedata

try:
    import pymupdf
except ImportError:  # pragma: no cover - compatibility with older PyMuPDF.
    import fitz as pymupdf  # type: ignore[no-redef]

if __package__:
    from .config import EngineConfig, load_config
    from .computation import ComputationInfoError, computation_info, current_computation_version
    from .error_codes import DEFAULT_ERROR_MESSAGES, ErrorCode, error_response
    from .logging_utils import get_logger, log_event, log_exception
    from .pdf_parser import iter_pages, page_count, parse_loaded_page
    from .private_temp import private_storage_directory, private_temporary_directory
    from .search import (
        MAX_SEARCH_CLAUSES,
        MAX_SEARCH_KEYWORD_CHARACTERS,
        SearchBudgetExceeded,
        SearchClause,
        SearchQuery,
        normalize_text,
        search_pages,
        search_pages_multi,
    )
    from .exporter import export_index
    from .crop import MIN_EXPORT_RECT_SIZE, PdfSegment, export_merged_segments, region_from_points
    from .crop_templates import describe_crop_page
    from .ocr import runtime_status, recognize_image, is_scanned_page, OcrUnavailableError, OcrRuntimeError
    from .ocr_cache import cache_info as ocr_cache_info, clear_cache as ocr_cache_clear
    from .ocr_pdf import render_page_to_png
    from .pdf_parser import ParsedPage, TextBlock
    from .layout import (
        Rect,
        HorizontalSeparator,
        LayoutBudgetExceeded,
        ReceiptCandidate,
        VisualAnchor,
        extract_separators,
        extract_frame_anchors,
        extract_visual_anchors,
        infer_receipt_candidates,
        select_candidate_for_match,
    )
    from .review_store import ReviewStore, ReviewStoreError, records_from_payload
    from .review_read import read_review_snapshot
    from .review_store_v2 import (
        ReviewStoreCorruptionError as _ReviewStoreCorruptionErrorV2,
        ReviewRevisionConflict as _ReviewRevisionConflictV2,
        ReviewStoreError as _ReviewStoreErrorV2,
        ReviewStoreV2,
    )
else:  # Running as ``python engine/engine.py`` from the project root.
    # Keep the project root ahead of ``engine/`` so third-party imports such as
    # urllib3's stdlib ``queue`` cannot be shadowed by engine/queue.py.
    project_root = Path(__file__).resolve().parent.parent
    engine_dir = str(Path(__file__).resolve().parent)
    sys.path[:] = [entry for entry in sys.path if entry != engine_dir]
    if str(project_root) in sys.path:
        sys.path.remove(str(project_root))
    sys.path.insert(0, str(project_root))
    from engine.config import EngineConfig, load_config  # type: ignore[no-redef]
    from engine.computation import ComputationInfoError, computation_info, current_computation_version  # type: ignore[no-redef]
    from engine.error_codes import DEFAULT_ERROR_MESSAGES, ErrorCode, error_response  # type: ignore[no-redef]
    from engine.logging_utils import get_logger, log_event, log_exception  # type: ignore[no-redef]
    from engine.pdf_parser import iter_pages, page_count, parse_loaded_page  # type: ignore[no-redef]
    from engine.private_temp import (  # type: ignore[no-redef]
        private_storage_directory,
        private_temporary_directory,
    )
    from engine.search import (  # type: ignore[no-redef]
        MAX_SEARCH_CLAUSES,
        MAX_SEARCH_KEYWORD_CHARACTERS,
        SearchBudgetExceeded,
        SearchClause,
        SearchQuery,
        normalize_text,
        search_pages,
        search_pages_multi,
    )
    from engine.exporter import export_index  # type: ignore[no-redef]
    from engine.crop import (  # type: ignore[no-redef]
        MIN_EXPORT_RECT_SIZE,
        PdfSegment,
        export_merged_segments,
        region_from_points,
    )
    from engine.crop_templates import describe_crop_page  # type: ignore[no-redef]
    from engine.ocr import runtime_status, recognize_image, is_scanned_page, OcrUnavailableError, OcrRuntimeError  # type: ignore[no-redef]
    from engine.ocr_cache import cache_info as ocr_cache_info, clear_cache as ocr_cache_clear  # type: ignore[no-redef]
    from engine.ocr_pdf import render_page_to_png  # type: ignore[no-redef]
    from engine.pdf_parser import ParsedPage, TextBlock  # type: ignore[no-redef]
    from engine.layout import (  # type: ignore[no-redef]
        Rect,
        HorizontalSeparator,
        LayoutBudgetExceeded,
        ReceiptCandidate,
        VisualAnchor,
        extract_separators,
        extract_frame_anchors,
        extract_visual_anchors,
        infer_receipt_candidates,
        select_candidate_for_match,
    )
    from engine.review_store import ReviewStore, ReviewStoreError, records_from_payload  # type: ignore[no-redef]
    from engine.review_store_v2 import (  # type: ignore[no-redef]
        ReviewStoreCorruptionError as _ReviewStoreCorruptionErrorV2,
        ReviewRevisionConflict as _ReviewRevisionConflictV2,
        ReviewStoreError as _ReviewStoreErrorV2,
        ReviewStoreV2,
    )
    from engine.review_read import read_review_snapshot  # type: ignore[no-redef]

ReviewRevisionConflict = _ReviewRevisionConflictV2
_V2_STORAGE_CORRUPTION_ERRORS = (_ReviewStoreCorruptionErrorV2,)


class _V2InvalidStoreResponse(RuntimeError):
    """Raised when the real v2 store returns an invalid response shape."""


ENGINE_VERSION = "0.1.27"
EXPORT_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$")
SOURCE_SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
RENDER_DPI = 144
RENDER_MAX_PIXELS_PER_SIDE = 16_384
RENDER_MAX_PIXELS = 64_000_000
EXPORT_OWNERSHIP_VERSION = 1
EXPORT_OWNERSHIP_DIR: Path | None = None
OCR_CACHE_MAX_BYTES = 268_435_456
OCR_CACHE_RETENTION_DAYS = 30
LOGGER = get_logger()
ENGINE_CONFIG: EngineConfig = load_config(logger=LOGGER)
LOGGER.setLevel(ENGINE_CONFIG.log_level_number)


class ExportOwnershipError(RuntimeError):
    """A fail-closed error from the token-scoped export registry."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _UnlinkOutcome(str, Enum):
    """Classify why an owned output was or was not removed."""

    DELETED = "deleted"
    IDENTITY_MISMATCH = "identity_mismatch"
    RETRYABLE_FAILURE = "retryable_failure"


@dataclass(frozen=True)
class _ParsedPdfSelection:
    """Keep source semantics while routing the exporter through a snapshot."""

    source_path: str
    snapshot_path: Path
    segments: list[PdfSegment]
    source_sha256: str


@dataclass(frozen=True)
class _CopiedPdfSource:
    """Immutable per-request PDF copy and the digest of its open source handle."""

    path: Path
    sha256: str
    size: int


def _safe_error(code: ErrorCode | str, message: str | None = None) -> dict[str, str]:
    """Return one protocol error using the centralized stable code map."""

    return error_response(code, message)


def _validated_export_token(request: dict[str, object]) -> str | dict[str, str]:
    raw_token = request.get("export_token")
    if not isinstance(raw_token, str) or not raw_token.strip():
        return _safe_error(ErrorCode.EXPORT_TOKEN_REQUIRED)
    token = raw_token.strip()
    if not EXPORT_TOKEN_PATTERN.fullmatch(token):
        return _safe_error(ErrorCode.INVALID_EXPORT_TOKEN)
    return token


def _validated_named_export_token(
    request: dict[str, object],
    field: str,
) -> str | dict[str, str]:
    raw_token = request.get(field)
    if not isinstance(raw_token, str) or not raw_token.strip():
        return _safe_error(ErrorCode.EXPORT_TOKEN_REQUIRED)
    token = raw_token.strip()
    if not EXPORT_TOKEN_PATTERN.fullmatch(token):
        return _safe_error(ErrorCode.INVALID_EXPORT_TOKEN)
    return token


def _export_error(error: ExportOwnershipError) -> dict[str, str]:
    return _safe_error(error.code, error.message)


def _ownership_directory() -> Path:
    if EXPORT_OWNERSHIP_DIR is not None:
        return EXPORT_OWNERSHIP_DIR
    return private_storage_directory("export-ownership")


def _ownership_manifest_path(token: str) -> Path:
    token_digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    return _ownership_directory() / f"{token_digest}.json"


def _ownership_lock_path(token: str) -> Path:
    token_digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    return _ownership_directory() / f"{token_digest}.lock"


@contextmanager
def _ownership_lock(token: str) -> Iterator[None]:
    try:
        ownership_directory = _ownership_directory()
        ownership_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock_path = _ownership_lock_path(token)
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0)
        descriptor = os.open(lock_path, flags, 0o600)
    except FileExistsError as error:
        raise ExportOwnershipError("export_busy", "导出正在进行，请稍后重试") from error
    except OSError as error:
        raise ExportOwnershipError("ownership_unavailable", "导出文件登记不可用，请重试") from error

    try:
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            handle.write("locked")
        yield
    finally:
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            # A stale lock makes subsequent operations fail closed; never
            # broaden cleanup to compensate for an inability to unlock.
            pass


def _empty_ownership_manifest(token: str) -> dict[str, object]:
    return {
        "version": EXPORT_OWNERSHIP_VERSION,
        "token_hash": hashlib.sha256(token.encode("utf-8")).hexdigest(),
        "outputs": [],
    }


def _load_ownership_manifest(token: str) -> dict[str, object]:
    manifest_path = _ownership_manifest_path(token)
    if not manifest_path.exists():
        return _empty_ownership_manifest(token)
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ExportOwnershipError("ownership_unavailable", "导出文件登记不可用，请重试") from error
    if not isinstance(raw, dict):
        raise ExportOwnershipError("ownership_unavailable", "导出文件登记不可用，请重试")
    expected_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    if raw.get("version") != EXPORT_OWNERSHIP_VERSION or raw.get("token_hash") != expected_hash:
        raise ExportOwnershipError("ownership_unavailable", "导出文件登记不可用，请重试")
    outputs = raw.get("outputs")
    if not isinstance(outputs, list):
        raise ExportOwnershipError("ownership_unavailable", "导出文件登记不可用，请重试")
    for record in outputs:
        if not isinstance(record, dict):
            raise ExportOwnershipError("ownership_unavailable", "导出文件登记不可用，请重试")
        if not isinstance(record.get("path"), str) or record.get("kind") not in {"xlsx", "pdf"}:
            raise ExportOwnershipError("ownership_unavailable", "导出文件登记不可用，请重试")
        if record.get("state") not in {"reserved", "created"}:
            raise ExportOwnershipError("ownership_unavailable", "导出文件登记不可用，请重试")
        if record.get("state") == "created":
            identity = record.get("identity")
            if not isinstance(identity, dict) or not isinstance(identity.get("sha256"), str):
                raise ExportOwnershipError("ownership_unavailable", "导出文件登记不可用，请重试")
    return raw


def _write_ownership_manifest(token: str, manifest: dict[str, object]) -> None:
    manifest_path = _ownership_manifest_path(token)
    temporary_path: Path | None = None
    try:
        ownership_directory = _ownership_directory()
        descriptor, raw_temporary_path = tempfile.mkstemp(
            prefix=f".{manifest_path.stem}-",
            suffix=".tmp",
            dir=str(ownership_directory),
        )
        temporary_path = Path(raw_temporary_path)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, manifest_path)
        temporary_path = None
    except (OSError, TypeError, ValueError) as error:
        raise ExportOwnershipError("ownership_unavailable", "导出文件登记不可用，请重试") from error
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except OSError:
                pass


def _normalized_output_path(raw_path: object, suffix: str) -> Path | dict[str, str]:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return _safe_error(ErrorCode.INVALID_OUTPUT_PATH, "output path is required")
    stripped_path = raw_path.strip()
    if "\x00" in stripped_path:
        return _safe_error(ErrorCode.INVALID_OUTPUT_PATH)
    try:
        output = Path(os.path.abspath(stripped_path))
    except (OSError, TypeError, ValueError):
        return _safe_error(ErrorCode.INVALID_OUTPUT_PATH)
    if output.suffix.lower() != suffix:
        return _safe_error(ErrorCode.UNSUPPORTED_OUTPUT, f"output must be {suffix.upper()}")
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
    except ValueError:
        return _safe_error(ErrorCode.INVALID_OUTPUT_PATH)
    except OSError as error:
        raise ExportOwnershipError("output_unavailable", "导出目录不可用，请选择其他位置") from error
    return output


def _normalized_existing_pdf_path(raw_path: object) -> Path | dict[str, str]:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return _safe_error(ErrorCode.INVALID_OUTPUT_PATH, "preview path is required")
    try:
        path = Path(raw_path.strip()).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return _safe_error(ErrorCode.INVALID_OUTPUT_PATH, "PDF 预览不存在，请重新生成")
    if path.suffix.lower() != ".pdf" or not path.is_file():
        return _safe_error(ErrorCode.INVALID_OUTPUT_PATH, "PDF 预览不存在，请重新生成")
    return path


def _same_output_path(left: object, right: Path) -> bool:
    if not isinstance(left, str):
        return False
    try:
        if os.path.lexists(left) and os.path.lexists(right):
            return os.path.samefile(left, right)
    except (OSError, TypeError, ValueError):
        pass
    try:
        return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.fspath(right))
    except (OSError, TypeError, ValueError):
        return False


def _file_identity(path: Path) -> dict[str, object]:
    try:
        stat = path.stat()
        return {
            "st_dev": int(stat.st_dev),
            "st_ino": int(stat.st_ino),
            "size": int(stat.st_size),
            "mtime_ns": int(stat.st_mtime_ns),
            "sha256": _file_sha256(path),
        }
    except (OSError, ValueError) as error:
        raise ExportOwnershipError("export_failed", "导出文件无法登记") from error


def _reserve_output(token: str, destination: Path, kind: str) -> None:
    with _ownership_lock(token):
        manifest = _load_ownership_manifest(token)
        outputs = manifest["outputs"]
        assert isinstance(outputs, list)
        retained: list[dict[str, object]] = []
        for record in outputs:
            if isinstance(record, dict) and _same_output_path(record.get("path"), destination):
                if os.path.lexists(destination):
                    raise ExportOwnershipError("output_exists", "导出文件已存在，请更换输出位置后重试")
                # A stale reservation or a deleted previous output can be
                # safely replaced by a fresh reservation for this token.
                continue
            if isinstance(record, dict):
                retained.append(record)
        if os.path.lexists(destination):
            raise ExportOwnershipError("output_exists", "导出文件已存在，请更换输出位置后重试")
        retained.append({"path": str(destination), "kind": kind, "state": "reserved"})
        manifest["outputs"] = retained
        _write_ownership_manifest(token, manifest)


def _discard_reservation(token: str, destination: Path) -> None:
    try:
        with _ownership_lock(token):
            manifest = _load_ownership_manifest(token)
            outputs = manifest["outputs"]
            assert isinstance(outputs, list)
            retained = [
                record for record in outputs
                if not (isinstance(record, dict) and record.get("state") == "reserved" and _same_output_path(record.get("path"), destination))
            ]
            if retained:
                manifest["outputs"] = retained
                _write_ownership_manifest(token, manifest)
            else:
                try:
                    _ownership_manifest_path(token).unlink()
                except FileNotFoundError:
                    pass
    except Exception:
        # Failure to discard a reservation is safe: it never authorizes a
        # cleanup operation to remove a file without a created identity.
        pass


def _publish_new_file(temporary_path: Path, destination: Path) -> None:
    """Publish without replacing an existing directory entry."""

    if os.path.lexists(destination):
        raise ExportOwnershipError("output_exists", "导出文件已存在，请更换输出位置后重试")
    if os.name == "nt":
        try:
            # Windows os.rename maps to MoveFileEx without replace semantics;
            # it is atomic and works on filesystems that do not support links.
            os.rename(temporary_path, destination)
            return
        except FileExistsError as error:
            raise ExportOwnershipError("output_exists", "导出文件已存在，请更换输出位置后重试") from error
        except OSError:
            # Some Windows providers reject rename across their staging
            # boundary.  The hard-link path below is still no-replace.
            pass
    try:
        # A hard link is an atomic no-replace publish on POSIX and as a
        # fallback for Windows providers that support it.
        os.link(temporary_path, destination)
    except FileExistsError as error:
        raise ExportOwnershipError("output_exists", "导出文件已存在，请更换输出位置后重试") from error
    except OSError as error:
        # A hard link is the only no-replace primitive used here.  Falling
        # back to an O_EXCL placeholder followed by os.replace would reopen a
        # TOCTOU window in which a different file could be overwritten.
        raise ExportOwnershipError("export_failed", "导出文件发布失败") from error
    else:
        try:
            temporary_path.unlink()
        except OSError:
            # The temporary directory cleanup will remove this second hard
            # link; the destination is already safely published.
            pass
        return


def _mark_output_created(
    token: str,
    destination: Path,
    kind: str,
    expected_identity: dict[str, object],
) -> dict[str, object]:
    try:
        if not _is_owned_file(destination, expected_identity):
            raise ExportOwnershipError("ownership_lost", "导出文件登记已失效，请重试")
        with _ownership_lock(token):
            manifest = _load_ownership_manifest(token)
            outputs = manifest["outputs"]
            assert isinstance(outputs, list)
            for record in outputs:
                if isinstance(record, dict) and _same_output_path(record.get("path"), destination):
                    if record.get("state") != "reserved" or record.get("kind") != kind:
                        raise ExportOwnershipError("ownership_lost", "导出文件登记已失效，请重试")
                    record["state"] = "created"
                    record["identity"] = dict(expected_identity)
                    _write_ownership_manifest(token, manifest)
                    return dict(expected_identity)
        raise ExportOwnershipError("ownership_lost", "导出文件登记已失效，请重试")
    except ExportOwnershipError:
        # The no-replace publish already proved this path was created by this
        # request. If its registry update fails, remove only that exact file.
        _remove_published_file(destination, expected_identity)
        raise


def _remove_published_file(destination: Path, identity: dict[str, object]) -> None:
    try:
        if destination.is_symlink() or not destination.is_file():
            return
        _unlink_owned_file(destination, identity)
    except (OSError, ExportOwnershipError):
        pass


def _is_owned_file(path: Path, identity: object) -> bool:
    if not isinstance(identity, dict):
        return False
    try:
        link_stat = path.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        # Permission and I/O failures must reach the caller so cleanup can
        # retain the manifest and report a retryable failure.
        raise
    if stat_module.S_ISLNK(link_stat.st_mode) or not stat_module.S_ISREG(link_stat.st_mode):
        return False
    # Inode/device identity prevents a same-content replacement from being
    # mistaken for the output created by this token.
    if not isinstance(identity.get("st_dev"), int) or not isinstance(identity.get("st_ino"), int):
        return False
    try:
        stat = path.stat()
        if int(stat.st_dev) != identity["st_dev"] or int(stat.st_ino) != identity["st_ino"]:
            return False
        if int(stat.st_size) != identity.get("size") or int(stat.st_mtime_ns) != identity.get("mtime_ns"):
            return False
        return hmac.compare_digest(_file_sha256(path), str(identity.get("sha256", "")))
    except FileNotFoundError:
        return False
    except (ValueError, TypeError):
        return False


def _stat_matches_identity(stat_result: os.stat_result, identity: object) -> bool:
    if not isinstance(identity, dict):
        return False
    try:
        return (
            int(stat_result.st_dev) == int(identity["st_dev"])
            and int(stat_result.st_ino) == int(identity["st_ino"])
            and int(stat_result.st_size) == int(identity["size"])
            and int(stat_result.st_mtime_ns) == int(identity["mtime_ns"])
        )
    except (KeyError, TypeError, ValueError):
        return False


def _unlink_owned_windows(
    path: Path,
    identity: object,
    expected_parent: Path | str | None = None,
) -> _UnlinkOutcome:
    """Delete the opened file handle, never a subsequently replaced path."""

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
    set_file_information = kernel32.SetFileInformationByHandle
    set_file_information.argtypes = [
        wintypes.HANDLE,
        wintypes.INT,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    set_file_information.restype = wintypes.BOOL
    get_final_path = kernel32.GetFinalPathNameByHandleW
    get_final_path.argtypes = [
        wintypes.HANDLE,
        wintypes.LPWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
    ]
    get_final_path.restype = wintypes.DWORD

    desired_access = 0x80000000 | 0x00010000 | 0x00000080  # GENERIC_READ | DELETE | FILE_READ_ATTRIBUTES
    # Reject new writers while the handle is open.  The hash below is read
    # from this same descriptor, so a pathname replacement cannot turn the
    # ownership check into deletion of a different file.
    # A managed preview cleanup supplies the locked root as expected_parent;
    # withholding FILE_SHARE_DELETE then keeps both the leaf and its parent
    # stable until the handle-based delete completes.  Ordinary export
    # cleanup retains its previous sharing behavior.
    share_mode = 0x00000001 if expected_parent is not None else 0x00000001 | 0x00000004
    open_existing = 3
    open_reparse_point = 0x00200000
    invalid_handle = ctypes.c_void_p(-1).value
    raw_handle = create_file(
        str(path),
        desired_access,
        share_mode,
        None,
        open_existing,
        open_reparse_point,
        None,
    )
    if raw_handle == invalid_handle:
        error_code = ctypes.get_last_error()
        if error_code in {2, 3}:
            return _UnlinkOutcome.IDENTITY_MISMATCH
        raise OSError(error_code, "unable to open owned export")

    descriptor = -1
    try:
        if expected_parent is not None:
            buffer = ctypes.create_unicode_buffer(512)
            while True:
                length = get_final_path(
                    raw_handle,
                    buffer,
                    len(buffer),
                    0,  # FILE_NAME_NORMALIZED
                )
                if length == 0:
                    error_code = ctypes.get_last_error()
                    raise OSError(error_code, "unable to resolve owned export path")
                if length < len(buffer):
                    final_path = buffer[:length]
                    break
                if len(buffer) >= 32_768:
                    raise OSError(206, "owned export path is too long")
                buffer = ctypes.create_unicode_buffer(len(buffer) * 2)

            def normalize_windows_path(value: object) -> str:
                if isinstance(value, Path):
                    value = str(value)
                if not isinstance(value, str):
                    return ""
                normalized = value.replace("/", "\\")
                if normalized.startswith("\\\\?\\"):
                    normalized = normalized[4:]
                while len(normalized) > 1 and normalized.endswith("\\"):
                    normalized = normalized[:-1]
                return normalized.casefold()

            if "\\" not in final_path:
                return _UnlinkOutcome.IDENTITY_MISMATCH
            final_parent = final_path.rsplit("\\", 1)[0]
            if normalize_windows_path(final_parent) != normalize_windows_path(expected_parent):
                return _UnlinkOutcome.IDENTITY_MISMATCH

        descriptor = msvcrt.open_osfhandle(raw_handle, os.O_RDONLY | getattr(os, "O_BINARY", 0))
        raw_handle = None
        if not _stat_matches_identity(os.fstat(descriptor), identity):
            return _UnlinkOutcome.IDENTITY_MISMATCH
        expected_sha256 = identity.get("sha256") if isinstance(identity, dict) else None
        if not isinstance(expected_sha256, str):
            return _UnlinkOutcome.IDENTITY_MISMATCH
        if not hmac.compare_digest(_file_sha256_descriptor(descriptor), expected_sha256):
            return _UnlinkOutcome.IDENTITY_MISMATCH

        class FileDispositionInfo(ctypes.Structure):
            _fields_ = [("delete_file", ctypes.c_ubyte)]

        disposition = FileDispositionInfo(1)
        if not set_file_information(
            msvcrt.get_osfhandle(descriptor),
            4,  # FileDispositionInfo
            ctypes.byref(disposition),
            ctypes.sizeof(disposition),
        ):
            error_code = ctypes.get_last_error()
            raise OSError(error_code, "unable to delete owned export")
        return _UnlinkOutcome.DELETED
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        elif raw_handle not in (None, invalid_handle):
            close_handle(raw_handle)


def _unlink_owned_file(
    path: Path,
    identity: object,
    expected_parent: Path | str | None = None,
) -> _UnlinkOutcome:
    """Delete only the file represented by a registered identity."""

    if expected_parent is not None and os.name != "nt":
        # The stdlib has no portable delete-by-handle primitive on POSIX.
        # Batch cleanup must remain retryable instead of falling back to a
        # pathname unlink without the Windows atomic boundary.
        return _UnlinkOutcome.RETRYABLE_FAILURE

    try:
        owned = _is_owned_file(path, identity)
    except FileNotFoundError:
        return _UnlinkOutcome.IDENTITY_MISMATCH
    except OSError:
        return _UnlinkOutcome.RETRYABLE_FAILURE
    if not owned:
        return _UnlinkOutcome.IDENTITY_MISMATCH
    if os.name == "nt":
        try:
            if expected_parent is None:
                return _unlink_owned_windows(path, identity)
            return _unlink_owned_windows(path, identity, expected_parent=expected_parent)
        except FileNotFoundError:
            return _UnlinkOutcome.IDENTITY_MISMATCH
        except OSError:
            return _UnlinkOutcome.RETRYABLE_FAILURE
    # POSIX has no portable delete-by-handle API in the stdlib; a second
    # identity check narrows the replacement window before unlinking.
    try:
        still_owned = _is_owned_file(path, identity)
    except FileNotFoundError:
        return _UnlinkOutcome.IDENTITY_MISMATCH
    except OSError:
        return _UnlinkOutcome.RETRYABLE_FAILURE
    if not still_owned:
        return _UnlinkOutcome.IDENTITY_MISMATCH
    try:
        path.unlink()
    except FileNotFoundError:
        return _UnlinkOutcome.IDENTITY_MISMATCH
    except OSError:
        return _UnlinkOutcome.RETRYABLE_FAILURE
    return _UnlinkOutcome.DELETED


def _owned_created_output_identity(token: str, path: Path, kind: str) -> dict[str, object]:
    with _ownership_lock(token):
        manifest = _load_ownership_manifest(token)
        outputs = manifest["outputs"]
        assert isinstance(outputs, list)
        for record in outputs:
            if (
                isinstance(record, dict)
                and record.get("kind") == kind
                and record.get("state") == "created"
                and _same_output_path(record.get("path"), path)
                and _is_owned_file(path, record.get("identity"))
            ):
                identity = record.get("identity")
                assert isinstance(identity, dict)
                return dict(identity)
    raise ExportOwnershipError("ownership_lost", "PDF 预览登记已失效，请重新生成")


def _cleanup_exports_response(request: dict[str, object]) -> dict[str, object]:
    validated = _validated_export_token(request)
    if isinstance(validated, dict):
        return validated
    token = validated
    try:
        with _ownership_lock(token):
            manifest_path = _ownership_manifest_path(token)
            if not manifest_path.exists():
                return {"status": "ok", "cleaned_count": 0}
            manifest = _load_ownership_manifest(token)
            outputs = manifest["outputs"]
            assert isinstance(outputs, list)
            retained: list[dict[str, object]] = []
            cleaned_count = 0
            cleanup_failed = False
            for record in outputs:
                if not isinstance(record, dict) or record.get("state") != "created":
                    # Reserved files have not been published and are never
                    # eligible for deletion.
                    continue
                path = Path(str(record["path"]))
                if not os.path.lexists(path):
                    continue
                try:
                    outcome = _unlink_owned_file(path, record.get("identity"))
                    if outcome is _UnlinkOutcome.DELETED or outcome is True:
                        cleaned_count += 1
                    elif outcome is _UnlinkOutcome.IDENTITY_MISMATCH:
                        # The path no longer identifies the file we created.
                        # Drop cleanup authority, but report the failure so
                        # callers never mistake an untouched foreign file for
                        # a successfully cleaned output.
                        cleanup_failed = True
                    else:
                        # A legacy/monkeypatched bool False and any unknown
                        # result are treated as retryable.  Keep the record so
                        # the next cleanup attempt still has authority.
                        cleanup_failed = True
                        retained.append(record)
                except OSError:
                    cleanup_failed = True
                    retained.append(record)
            if retained:
                manifest["outputs"] = retained
                _write_ownership_manifest(token, manifest)
            else:
                try:
                    manifest_path.unlink()
                except FileNotFoundError:
                    pass
            if cleanup_failed:
                raise ExportOwnershipError("cleanup_failed", "导出文件清理失败，请稍后重试")
            return {"status": "ok", "cleaned_count": cleaned_count}
    except ExportOwnershipError as error:
        return _export_error(error)


def _release_exports_response(request: dict[str, object]) -> dict[str, object]:
    """Forget cleanup authority after outputs have been handed to the user."""

    validated = _validated_export_token(request)
    if isinstance(validated, dict):
        return validated
    token = validated
    try:
        with _ownership_lock(token):
            manifest_path = _ownership_manifest_path(token)
            if not manifest_path.exists():
                return {"status": "ok", "released_count": 0}
            manifest = _load_ownership_manifest(token)
            outputs = manifest["outputs"]
            assert isinstance(outputs, list)
            released_count = sum(
                1
                for record in outputs
                if isinstance(record, dict) and record.get("state") == "created"
            )
            try:
                manifest_path.unlink()
            except OSError as error:
                raise ExportOwnershipError(
                    "ownership_unavailable",
                    "导出文件登记无法释放，请重试",
                ) from error
            return {"status": "ok", "released_count": released_count}
    except ExportOwnershipError as error:
        return _export_error(error)


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_sha256_descriptor(descriptor: int) -> str:
    digest = hashlib.sha256()
    original_offset = os.lseek(descriptor, 0, os.SEEK_CUR)
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
        for chunk in iter(lambda: os.read(descriptor, 1024 * 1024), b""):
            digest.update(chunk)
    finally:
        os.lseek(descriptor, original_offset, os.SEEK_SET)
    return digest.hexdigest()


def _source_limit_error(path: Path) -> tuple[dict[str, object] | None, int | None]:
    """Apply configured source limits and return the parsed page count once."""

    try:
        if path.stat().st_size > ENGINE_CONFIG.max_file_bytes:
            log_event(
                LOGGER,
                30,
                "source rejected",
                operation="source_validation",
                code=ErrorCode.FILE_TOO_LARGE.value,
            )
            return _safe_error(ErrorCode.FILE_TOO_LARGE), None
    except OSError:
        # The caller will report the operation-specific stable failure if the
        # source disappears or becomes unreadable between validation steps.
        return None, None

    try:
        total_pages = page_count(path)
    except Exception:
        # Do not turn a parser failure into a path-bearing exception.  The
        # operation's existing outer handler will map it to a stable code.
        return None, None
    if total_pages > ENGINE_CONFIG.max_pages:
        log_event(
            LOGGER,
            30,
            "source rejected",
            operation="source_validation",
            code=ErrorCode.PAGE_LIMIT_EXCEEDED.value,
            count=total_pages,
        )
        return {
            **_safe_error(ErrorCode.PAGE_LIMIT_EXCEEDED),
            "page_count": total_pages,
            "max_pages": ENGINE_CONFIG.max_pages,
        }, total_pages
    return None, total_pages


def _validated_source_sha256(request: dict[str, object]) -> str | dict[str, str]:
    """Require the caller to bind page work to the reviewed source bytes."""

    raw_sha256 = request.get("source_sha256")
    if not isinstance(raw_sha256, str):
        return _safe_error(ErrorCode.SOURCE_CHANGED)
    source_sha256 = raw_sha256.strip()
    if not SOURCE_SHA256_PATTERN.fullmatch(source_sha256):
        return _safe_error(ErrorCode.SOURCE_CHANGED)
    return source_sha256.lower()


def _snapshot_request_source(
    source: Path,
    expected_sha256: str | None,
    snapshot_directory: Path,
) -> _CopiedPdfSource | dict[str, str]:
    """Copy, hash, and limit a request source before opening it for work."""

    try:
        copied = _snapshot_pdf_source(source, expected_sha256, snapshot_directory)
    except ValueError:
        return _safe_error(ErrorCode.SOURCE_CHANGED)
    if isinstance(copied, dict):
        return copied
    limit_error, _total_pages = _source_limit_error(copied.path)
    if limit_error is not None:
        return limit_error
    return copied


def _iter_pages_with_ocr(path: Path):
    """Yield text pages and OCR-enriched pages through one search interface."""

    with private_temporary_directory("search-ocr") as temporary_dir:
        for parsed in iter_pages(path):
            # A sparse text layer is still preferable to OCR (and preserves
            # searchable text even when an embedded font decodes imperfectly).
            if parsed.blocks or not is_scanned_page(parsed):
                yield parsed
                continue
            image_path = render_page_to_png(path, parsed.page_number, temporary_dir, dpi=200)
            records = recognize_image(image_path, language="ch")
            blocks: list[TextBlock] = []
            for block_index, record in enumerate(records):
                text = str(record.get("text", "")).strip()
                box = record.get("box", [0, 0, 0, 0])
                if not text or not isinstance(box, (list, tuple)) or len(box) < 4:
                    continue
                scale = 72 / 200
                x0, y0, x1, y1 = (float(box[0]) * scale, float(box[1]) * scale, float(box[2]) * scale, float(box[3]) * scale)
                blocks.append(TextBlock(parsed.page_number, text, x0, y0, x1, y1, block_index, float(record.get("confidence", 0.0))))
            yield ParsedPage(parsed.page_number, parsed.width, parsed.height, "\n".join(block.text for block in blocks), tuple(blocks))


def health_payload() -> dict[str, str]:
    """Return the side-effect-free health response shared by both entrypoints."""

    return {"status": "ok", "engine": "pdf-search", "version": ENGINE_VERSION}


def _search_response(request: dict[str, object]) -> dict[str, object]:
    raw_path = request.get("path")
    keyword = request.get("keyword")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return _safe_error(ErrorCode.INVALID_PATH)
    if not isinstance(keyword, str) or not keyword.strip():
        return _safe_error(ErrorCode.EMPTY_KEYWORD)
    path = Path(raw_path)
    if path.suffix.lower() != ".pdf":
        return _safe_error(ErrorCode.UNSUPPORTED_FILE)
    if not path.is_file():
        return _safe_error(ErrorCode.FILE_NOT_FOUND)
    try:
        with private_temporary_directory("source") as snapshot_dir:
            copied = _snapshot_request_source(path, None, snapshot_dir)
            if isinstance(copied, dict):
                return copied
            limit_error, total_pages = _source_limit_error(copied.path)
            if limit_error is not None:
                return limit_error
            if total_pages is None:
                total_pages = page_count(copied.path)
            matches = search_pages(
                _iter_pages_with_ocr(copied.path),
                SearchQuery(keyword=keyword, exact=bool(request.get("exact", True))),
            )
            return {
                "status": "ok",
                "page_count": total_pages,
                "source_sha256": copied.sha256,
                "matches": [
                    {
                        "page": match.page_number,
                        "matched_text": match.matched_text,
                        "matched_field": match.matched_field,
                        "confidence": match.confidence,
                        "needs_review": match.confidence < 0.85,
                        "x0": match.x0,
                        "y0": match.y0,
                        "x1": match.x1,
                        "y1": match.y1,
                    }
                    for match in matches
                ],
            }
    except SearchBudgetExceeded as error:
        log_exception(
            LOGGER,
            30,
            operation="search",
            code=ErrorCode.SEARCH_FAILED.value,
            error=error,
            public_message="PDF 文本内容超过安全搜索上限",
        )
        return _safe_error(ErrorCode.SEARCH_FAILED, "PDF 文本内容超过安全搜索上限")
    except OcrUnavailableError as error:
        log_exception(
            LOGGER,
            30,
            operation="search",
            code=ErrorCode.OCR_UNAVAILABLE.value,
            error=error,
            public_message=DEFAULT_ERROR_MESSAGES[ErrorCode.OCR_UNAVAILABLE.value],
        )
        return _safe_error(ErrorCode.OCR_UNAVAILABLE)
    except OcrRuntimeError as error:
        return _safe_error(error.code)
    except Exception as error:  # Keep the JSONL worker alive for later requests.
        log_exception(
            LOGGER,
            40,
            operation="search",
            code=ErrorCode.SEARCH_FAILED.value,
            error=error,
            public_message=DEFAULT_ERROR_MESSAGES[ErrorCode.SEARCH_FAILED.value],
        )
        return _safe_error(ErrorCode.SEARCH_FAILED)


def _validated_search_multi_queries(
    raw_queries: object,
) -> tuple[tuple[SearchClause, ...], None] | tuple[None, dict[str, str]]:
    """Validate and normalize the wire representation of search clauses."""

    if not isinstance(raw_queries, list) or not 1 <= len(raw_queries) <= MAX_SEARCH_CLAUSES:
        return None, _safe_error(ErrorCode.INVALID_QUERIES)

    clauses: list[SearchClause] = []
    seen_ids: set[str] = set()
    include_count = 0
    for raw_query in raw_queries:
        if not isinstance(raw_query, dict):
            return None, _safe_error(ErrorCode.INVALID_QUERIES)

        raw_id = raw_query.get("id")
        raw_keyword = raw_query.get("keyword")
        raw_role = raw_query.get("role")
        if not isinstance(raw_id, str) or not raw_id.strip():
            return None, _safe_error(ErrorCode.INVALID_QUERIES)
        if not isinstance(raw_keyword, str):
            return None, _safe_error(ErrorCode.INVALID_QUERIES)
        if not isinstance(raw_role, str) or raw_role not in {"include", "exclude"}:
            return None, _safe_error(ErrorCode.INVALID_QUERIES)

        query_id = raw_id.strip()
        if query_id in seen_ids:
            return None, _safe_error(ErrorCode.INVALID_QUERIES)
        seen_ids.add(query_id)

        keyword = raw_keyword.strip()
        if not keyword or len(keyword) > MAX_SEARCH_KEYWORD_CHARACTERS:
            return None, _safe_error(ErrorCode.INVALID_QUERIES)
        normalized_keyword = normalize_text(keyword)
        if not normalized_keyword:
            return None, _safe_error(ErrorCode.INVALID_QUERIES)

        if raw_role == "include":
            include_count += 1
        clauses.append(SearchClause(query_id, normalized_keyword, raw_role))

    if include_count == 0:
        return None, _safe_error(ErrorCode.EMPTY_INCLUDE_QUERIES)
    return tuple(clauses), None


def _search_multi_response(request: dict[str, object]) -> dict[str, object]:
    """Search all validated clauses in one snapshot/page iterator pass."""

    raw_path = request.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return _safe_error(ErrorCode.INVALID_PATH)
    path = Path(raw_path)
    if path.suffix.lower() != ".pdf":
        return _safe_error(ErrorCode.UNSUPPORTED_FILE)
    if not path.is_file():
        return _safe_error(ErrorCode.FILE_NOT_FOUND)

    validated_queries = _validated_search_multi_queries(request.get("queries"))
    clauses, query_error = validated_queries
    if query_error is not None:
        return query_error
    assert clauses is not None

    try:
        with private_temporary_directory("source") as snapshot_dir:
            copied = _snapshot_request_source(path, None, snapshot_dir)
            if isinstance(copied, dict):
                return copied
            limit_error, total_pages = _source_limit_error(copied.path)
            if limit_error is not None:
                return limit_error
            if total_pages is None:
                total_pages = page_count(copied.path)
            matches = search_pages_multi(
                _iter_pages_with_ocr(copied.path),
                clauses,
                exact=bool(request.get("exact", True)),
            )
            return {
                "status": "ok",
                "page_count": total_pages,
                "source_sha256": copied.sha256,
                "matches": [
                    {
                        "page": match.page_number,
                        "matched_text": match.matched_text,
                        "matched_field": match.matched_field,
                        "confidence": match.confidence,
                        "needs_review": match.confidence < 0.85,
                        "x0": match.x0,
                        "y0": match.y0,
                        "x1": match.x1,
                        "y1": match.y1,
                        "query_id": match.query_id,
                        "role": match.role,
                    }
                    for match in matches
                ],
            }
    except SearchBudgetExceeded as error:
        log_exception(
            LOGGER,
            30,
            operation="search_multi",
            code=ErrorCode.SEARCH_FAILED.value,
            error=error,
            public_message="PDF 文本内容超过安全搜索上限",
        )
        return _safe_error(ErrorCode.SEARCH_FAILED, "PDF 文本内容超过安全搜索上限")
    except OcrUnavailableError as error:
        log_exception(
            LOGGER,
            30,
            operation="search_multi",
            code=ErrorCode.OCR_UNAVAILABLE.value,
            error=error,
            public_message=DEFAULT_ERROR_MESSAGES[ErrorCode.OCR_UNAVAILABLE.value],
        )
        return _safe_error(ErrorCode.OCR_UNAVAILABLE)
    except OcrRuntimeError as error:
        return _safe_error(error.code)
    except Exception as error:  # Keep the JSONL worker alive for later requests.
        log_exception(
            LOGGER,
            40,
            operation="search_multi",
            code=ErrorCode.SEARCH_FAILED.value,
            error=error,
            public_message=DEFAULT_ERROR_MESSAGES[ErrorCode.SEARCH_FAILED.value],
        )
        return _safe_error(ErrorCode.SEARCH_FAILED)


def _validated_pdf_page(
    request: dict[str, object],
) -> tuple[Path, int, str] | dict[str, object]:
    """Validate the common source-PDF and one-based page request fields."""

    raw_path = request.get("path")
    raw_page = request.get("page")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return _safe_error(ErrorCode.INVALID_PATH)
    if not isinstance(raw_page, int) or isinstance(raw_page, bool) or raw_page < 1:
        return _safe_error(ErrorCode.INVALID_PAGE)
    path = Path(raw_path)
    if path.suffix.lower() != ".pdf":
        return _safe_error(ErrorCode.UNSUPPORTED_FILE)
    if not path.is_file():
        return _safe_error(ErrorCode.FILE_NOT_FOUND)
    source_sha256 = _validated_source_sha256(request)
    if isinstance(source_sha256, dict):
        return source_sha256
    return path, raw_page, source_sha256


def _parse_pdf_page(path: Path, page_number: int) -> ParsedPage | None:
    """Parse one requested page without scanning preceding pages."""

    document = pymupdf.open(str(path))
    try:
        if page_number > document.page_count:
            return None
        page = document.load_page(page_number - 1)
        return parse_loaded_page(page, page_number)
    finally:
        document.close()


def _render_pixel_dimensions(page_rect: object) -> tuple[int, int] | None:
    """Return bounded 144-DPI dimensions without allocating a pixmap."""

    try:
        width = math.ceil(float(page_rect.width) * RENDER_DPI / 72)
        height = math.ceil(float(page_rect.height) * RENDER_DPI / 72)
    except (AttributeError, OverflowError, TypeError, ValueError):
        return None
    if (
        width <= 0
        or height <= 0
        or width > RENDER_MAX_PIXELS_PER_SIDE
        or height > RENDER_MAX_PIXELS_PER_SIDE
        or width * height > RENDER_MAX_PIXELS
    ):
        return None
    return width, height


def _render_page_response(request: dict[str, object]) -> dict[str, object]:
    """Render one source page for the review UI without modifying the PDF."""

    validated = _validated_pdf_page(request)
    if isinstance(validated, dict):
        return validated
    path, raw_page, expected_sha256 = validated

    try:
        with private_temporary_directory("source") as snapshot_dir:
            copied = _snapshot_request_source(path, expected_sha256, snapshot_dir)
            if isinstance(copied, dict):
                return copied
            document = pymupdf.open(str(copied.path))
            try:
                if raw_page > document.page_count:
                    return _safe_error(
                        ErrorCode.PAGE_OUT_OF_RANGE,
                        f"page must be between 1 and {document.page_count}",
                    )
                page = document.load_page(raw_page - 1)
                if _render_pixel_dimensions(page.rect) is None:
                    return _safe_error(ErrorCode.RENDER_FAILED)
                scale = RENDER_DPI / 72
                pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
                image_data = base64.b64encode(pixmap.tobytes("png")).decode("ascii")
                return {
                    "status": "ok",
                    "page": raw_page,
                    "page_count": document.page_count,
                    "page_width": page.rect.width,
                    "page_height": page.rect.height,
                    "source_sha256": copied.sha256,
                    "image_data": f"data:image/png;base64,{image_data}",
                }
            finally:
                document.close()
    except Exception as error:
        log_exception(
            LOGGER,
            40,
            operation="render_page",
            code=ErrorCode.RENDER_FAILED.value,
            error=error,
            public_message=DEFAULT_ERROR_MESSAGES[ErrorCode.RENDER_FAILED.value],
        )
        return _safe_error(ErrorCode.RENDER_FAILED)


def _inspect_pdf_response(request: dict[str, object]) -> dict[str, object]:
    """Read source PDF metadata without copying or modifying the source."""

    path = _normalized_existing_pdf_path(request.get("path"))
    if isinstance(path, dict):
        return path
    try:
        total_pages = page_count(path)
        if total_pages < 1:
            return _safe_error(ErrorCode.PAGE_LIMIT_EXCEEDED, "PDF has no pages")
        return {
            "status": "ok",
            "page_count": total_pages,
            "source_sha256": _file_sha256(path),
        }
    except Exception as error:
        log_exception(
            LOGGER,
            40,
            operation="inspect_pdf",
            code=ErrorCode.RENDER_FAILED.value,
            error=error,
            public_message=DEFAULT_ERROR_MESSAGES[ErrorCode.RENDER_FAILED.value],
        )
        return _safe_error(ErrorCode.RENDER_FAILED)


def _rect_payload(rect: Rect) -> dict[str, float]:
    return {
        "x0": float(rect.x0),
        "y0": float(rect.y0),
        "x1": float(rect.x1),
        "y1": float(rect.y1),
    }


def _invalid_match_rect_response() -> dict[str, str]:
    return _safe_error(ErrorCode.INVALID_MATCH_RECT)


def _analyze_failed_response() -> dict[str, str]:
    return _safe_error(ErrorCode.ANALYZE_FAILED)


def _unexpected_analyze_failure(error: Exception) -> dict[str, str]:
    log_exception(
        LOGGER,
        40,
        operation="analyze_page",
        code=ErrorCode.ANALYZE_FAILED.value,
        error=error,
        public_message=DEFAULT_ERROR_MESSAGES[ErrorCode.ANALYZE_FAILED.value],
    )
    return _analyze_failed_response()


def _match_rects(
    raw_matches: list[object], page_width: float, page_height: float
) -> list[Rect] | dict[str, str]:
    match_rects: list[Rect] = []
    for raw_match in raw_matches:
        if not isinstance(raw_match, dict):
            return _invalid_match_rect_response()
        coordinates: list[float] = []
        for field in ("x0", "y0", "x1", "y1"):
            value = raw_match.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return _invalid_match_rect_response()
            try:
                coordinate = float(value)
            except (OverflowError, TypeError, ValueError):
                return _invalid_match_rect_response()
            if not math.isfinite(coordinate):
                return _invalid_match_rect_response()
            coordinates.append(coordinate)
        match_rect = Rect(*coordinates)
        if not (
            0 <= match_rect.x0 < match_rect.x1 <= page_width
            and 0 <= match_rect.y0 < match_rect.y1 <= page_height
        ):
            return _invalid_match_rect_response()
        match_rects.append(match_rect)
    return match_rects


def _analyze_page_geometry(
    path: Path,
    page_number: int,
    parsed: ParsedPage,
    *,
    loaded_page: object | None = None,
) -> tuple[
    list[HorizontalSeparator],
    list[VisualAnchor],
    list[ReceiptCandidate],
    bool,
]:
    layout_budget_exceeded = False
    page_options = {"loaded_page": loaded_page} if loaded_page is not None else {}
    try:
        separators = extract_separators(path, page_number, **page_options)
        visual_anchors = [
            *extract_visual_anchors(path, page_number, **page_options),
            *extract_frame_anchors(path, page_number, **page_options),
        ]
    except LayoutBudgetExceeded:
        # Optional visual evidence is deliberately all-or-nothing for a page:
        # using only the subset extracted before a budget failure could make a
        # fallback candidate look more certain than it is.
        separators = []
        visual_anchors = []
        layout_budget_exceeded = True
    candidates = infer_receipt_candidates(
        parsed,
        separators=separators,
        visual_anchors=visual_anchors,
    )
    layout_budget_exceeded = layout_budget_exceeded or any(
        "layout_budget_exceeded" in candidate.evidence
        for candidate in candidates
    )
    return separators, visual_anchors, candidates, layout_budget_exceeded


def _selection_payloads(
    match_rects: list[Rect],
    separators: list[HorizontalSeparator],
    visual_anchors: list[VisualAnchor],
    candidates: list[ReceiptCandidate],
    page_width: float,
    page_height: float,
    layout_budget_exceeded: bool = False,
) -> tuple[bool, list[dict[str, object]]]:
    selected_candidates = [
        select_candidate_for_match(candidates, match_rect)
        for match_rect in match_rects
    ]
    selected_candidate_indices = [
        next(
            (
                index
                for index, candidate in enumerate(candidates)
                if candidate is selected
            ),
            None,
        )
        if selected is not None
        else None
        for selected in selected_candidates
    ]
    page_fully_matched = (
        not layout_budget_exceeded
        and bool(candidates)
        and len({
            candidate for candidate in selected_candidates if candidate is not None
        }) == len(candidates)
    )
    snap_points = sorted({
        round(float(point), 2)
        for point in [
            *(separator.y for separator in separators),
            *(anchor.y0 for anchor in visual_anchors),
            *(anchor.y1 for anchor in visual_anchors),
            *(candidate.rect.y0 for candidate in candidates),
            *(candidate.rect.y1 for candidate in candidates),
        ]
        if math.isfinite(float(point)) and 0 <= float(point) <= page_height
    })
    selections: list[dict[str, object]] = []
    for match_rect, selected, candidate_index in zip(
        match_rects,
        selected_candidates,
        selected_candidate_indices,
        strict=True,
    ):
        confidence = (
            max(0.0, min(1.0, float(selected.confidence)))
            if selected is not None
            else 0.0
        )
        evidence = list(selected.evidence) if selected is not None else []
        if layout_budget_exceeded:
            confidence = min(confidence, 0.89)
            if "layout_budget_exceeded" not in evidence:
                evidence.append("layout_budget_exceeded")
        if page_fully_matched and selected is not None:
            evidence.append("page_fully_matched")
        selections.append({
            "match_rect": _rect_payload(match_rect),
            "candidate_index": candidate_index,
            "candidate_rect": (
                _rect_payload(selected.rect) if selected is not None else None
            ),
            "rect": _rect_payload(
                Rect(0, 0, page_width, page_height)
                if page_fully_matched and selected is not None
                else selected.rect
            ) if selected is not None else None,
            "confidence": confidence,
            "slot": selected.slot if selected is not None else None,
            "evidence": evidence,
            "needs_review": (
                selected is None
                or layout_budget_exceeded
                or confidence < 0.9
            ),
            "snap_points": snap_points,
        })
    return page_fully_matched, selections


def _crop_template_page_response(
    snapshot_path: Path,
    page_number: int,
    source_sha256: str,
) -> dict[str, object]:
    """Describe one page from the already validated private PDF snapshot."""

    document = pymupdf.open(str(snapshot_path))
    try:
        total_pages = int(document.page_count)
        if page_number > total_pages:
            return _safe_error(ErrorCode.PAGE_OUT_OF_RANGE)
        page = document.load_page(page_number - 1)
        geometry = page.rect
        return {
            "status": "ok",
            "page": page_number,
            "page_count": total_pages,
            "page_width": float(geometry.width),
            "page_height": float(geometry.height),
            "source_sha256": source_sha256,
            "crop_template": describe_crop_page(page),
        }
    finally:
        document.close()


def _analyze_page_response(request: dict[str, object]) -> dict[str, object]:
    """Analyze one parsed page and select receipt candidates for each match."""

    validated = _validated_pdf_page(request)
    if isinstance(validated, dict):
        return validated
    path, page_number, expected_sha256 = validated

    raw_matches = request.get("matches")
    if not isinstance(raw_matches, list):
        return _safe_error(ErrorCode.INVALID_MATCHES)
    include_crop_template = request.get("include_crop_template", False)
    if not isinstance(include_crop_template, bool):
        return _safe_error(
            ErrorCode.INVALID_REQUEST,
            "include_crop_template must be a boolean",
        )
    if include_crop_template and raw_matches:
        return _safe_error(
            ErrorCode.INVALID_MATCHES,
            "matches must be empty when include_crop_template is true",
        )

    try:
        with private_temporary_directory("source") as snapshot_dir:
            copied = _snapshot_request_source(path, expected_sha256, snapshot_dir)
            if isinstance(copied, dict):
                return copied
            if include_crop_template:
                return _crop_template_page_response(
                    copied.path,
                    page_number,
                    copied.sha256,
                )
            parsed = _parse_pdf_page(copied.path, page_number)
            if parsed is None:
                return _safe_error(ErrorCode.PAGE_OUT_OF_RANGE)

            match_rects = _match_rects(raw_matches, parsed.width, parsed.height)
            if isinstance(match_rects, dict):
                return match_rects

            (
                separators,
                visual_anchors,
                candidates,
                layout_budget_exceeded,
            ) = _analyze_page_geometry(
                copied.path,
                page_number,
                parsed,
            )
            page_fully_matched, selections = _selection_payloads(
                match_rects,
                separators,
                visual_anchors,
                candidates,
                parsed.width,
                parsed.height,
                layout_budget_exceeded,
            )

            return {
                "status": "ok",
                "page": page_number,
                "page_width": parsed.width,
                "page_height": parsed.height,
                "source_sha256": copied.sha256,
                "page_fully_matched": page_fully_matched,
                "selections": selections,
            }
    except (OSError, RuntimeError, ValueError):
        return _analyze_failed_response()
    except Exception as error:
        return _unexpected_analyze_failure(error)


def _export_index_response(request: dict[str, object]) -> dict[str, object]:
    """Persist reviewed rows through the same JSONL boundary as search.

    The engine only writes a new XLSX file. It never modifies the source PDF.
    Rows are deliberately treated as opaque JSON objects so the UI can include
    review status and crop decisions without coupling the engine to React.
    """

    validated_token = _validated_export_token(request)
    if isinstance(validated_token, dict):
        return validated_token
    token = validated_token
    raw_path = request.get("output_path")
    rows = request.get("rows")
    try:
        output = _normalized_output_path(raw_path, ".xlsx")
    except ExportOwnershipError as error:
        return _export_error(error)
    if isinstance(output, dict):
        return output
    if not isinstance(rows, list):
        return _safe_error(ErrorCode.INVALID_ROWS)
    normalized_rows = [row for row in rows if isinstance(row, dict)]
    if len(normalized_rows) != len(rows):
        return _safe_error(ErrorCode.INVALID_ROWS, "every row must be an object")
    cleanup_marker = "__pdf_search_cleanup__"
    if len(normalized_rows) == 1 and cleanup_marker in normalized_rows[0]:
        return _safe_error(ErrorCode.INVALID_CLEANUP_REQUEST)
    if any(row.get("review_status") not in {"approved", "confirmed", "整组确认", "逐页确认"} for row in normalized_rows):
        return _safe_error(ErrorCode.UNREVIEWED_ROWS)

    try:
        _reserve_output(token, output, "xlsx")
    except ExportOwnershipError as error:
        return _export_error(error)
    try:
        with tempfile.TemporaryDirectory(
            prefix=f".{output.stem}-",
            dir=str(output.parent),
        ) as temporary_dir:
            temporary_output = Path(temporary_dir) / output.name
            export_index(temporary_output, normalized_rows)
            expected_identity = _file_identity(temporary_output)
            _publish_new_file(temporary_output, output)
        _mark_output_created(token, output, "xlsx", expected_identity)
        return {"status": "ok", "output_path": str(output), "row_count": len(normalized_rows)}
    except ExportOwnershipError as error:
        _discard_reservation(token, output)
        return _export_error(error)
    except Exception as error:
        _discard_reservation(token, output)
        log_exception(
            LOGGER,
            40,
            operation="export_index",
            code=ErrorCode.EXPORT_FAILED.value,
            error=error,
            public_message="XLSX 索引导出失败",
        )
        return _safe_error(ErrorCode.EXPORT_FAILED, "XLSX 索引导出失败")


def _export_rect_from_payload(raw_rect: object, page_width: float, page_height: float) -> Rect:
    if not isinstance(raw_rect, dict):
        raise ValueError("reviewed rectangle is required unless full page was explicitly selected")
    coordinates: list[float] = []
    for field in ("x0", "y0", "x1", "y1"):
        value = raw_rect.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("reviewed rectangle must contain finite numbers")
        coordinate = float(value)
        if not math.isfinite(coordinate):
            raise ValueError("reviewed rectangle must contain finite numbers")
        coordinates.append(coordinate)
    x0, y0, x1, y1 = coordinates
    if not (
        0 <= x0 < x1 <= page_width
        and 0 <= y0 < y1 <= page_height
        and x1 - x0 >= MIN_EXPORT_RECT_SIZE
        and y1 - y0 >= MIN_EXPORT_RECT_SIZE
    ):
        raise ValueError("reviewed rectangle must be ordered, non-empty, and inside the page")
    return region_from_points(x0, y0, x1, y1, page_width, page_height)


def _snapshot_pdf_source(
    source: Path,
    expected_sha256: str | None,
    snapshot_directory: Path,
) -> _CopiedPdfSource | dict[str, str]:
    """Copy and hash one opened source handle before any PDF parsing."""

    snapshot_path: Path | None = None
    completed = False
    try:
        with source.open("rb") as source_handle:
            with tempfile.NamedTemporaryFile(
                prefix="source-",
                suffix=".pdf",
                dir=snapshot_directory,
                delete=False,
            ) as snapshot_handle:
                snapshot_path = Path(snapshot_handle.name)
                digest = hashlib.sha256()
                total_bytes = 0
                for chunk in iter(lambda: source_handle.read(1024 * 1024), b""):
                    total_bytes += len(chunk)
                    if total_bytes > ENGINE_CONFIG.max_file_bytes:
                        return _safe_error(ErrorCode.FILE_TOO_LARGE)
                    snapshot_handle.write(chunk)
                    digest.update(chunk)
                snapshot_handle.flush()
                os.fsync(snapshot_handle.fileno())
        actual_sha256 = digest.hexdigest()
        if expected_sha256 is not None and not hmac.compare_digest(actual_sha256, expected_sha256):
            raise ValueError("source PDF SHA-256 does not match the reviewed source")
        completed = True
        return _CopiedPdfSource(snapshot_path, actual_sha256, total_bytes)
    finally:
        # The enclosing TemporaryDirectory owns successful snapshots.  Remove
        # an early partial file so a rejected source is never left behind if
        # this helper is reused outside that context.
        if not completed and snapshot_path is not None and snapshot_path.exists():
            try:
                snapshot_path.unlink()
            except OSError:
                pass


def _parse_pdf_segments(
    source_document: object,
    raw_segments: list[object],
) -> list[PdfSegment]:
    segments: list[PdfSegment] = []
    seen_page_segments: set[tuple[int, int]] = set()
    for item in raw_segments:
        if not isinstance(item, dict):
            raise ValueError("each reviewed segment must be an object")
        page_number = item.get("page_number")
        if (
            isinstance(page_number, bool)
            or not isinstance(page_number, int)
            or page_number < 1
            or page_number > source_document.page_count
        ):
            raise ValueError("page number is out of range")
        segment_no = item.get("segment_no", 1)
        page_segment = (page_number, segment_no)
        if (
            isinstance(segment_no, bool)
            or not isinstance(segment_no, int)
            or segment_no < 1
            or page_segment in seen_page_segments
        ):
            raise ValueError("segment number must be a unique positive integer within its page")
        if item.get("review_status") != "confirmed":
            raise ValueError("every exported segment must be confirmed")
        keep_full_page = item.get("keep_full_page") is True
        source_page = source_document.load_page(page_number - 1)
        rect = None if keep_full_page else _export_rect_from_payload(
            item.get("rect"),
            source_page.rect.width,
            source_page.rect.height,
        )
        segments.append(PdfSegment(
            page_number=page_number,
            rect=rect,
            segment_no=segment_no,
            keep_full_page=keep_full_page,
        ))
        seen_page_segments.add(page_segment)
    return segments


def _parse_pdf_selection(
    selection: object,
    destination: Path,
    snapshot_directory: Path,
) -> _ParsedPdfSelection | dict[str, str]:
    if not isinstance(selection, dict) or not isinstance(selection.get("source_path"), str):
        raise ValueError("each selection needs a source PDF")
    source_path = selection["source_path"].strip()
    source = Path(source_path)
    if source.suffix.lower() != ".pdf" or not source.is_file():
        raise ValueError("source PDF does not exist")
    expected_sha256 = selection.get("source_sha256")
    if (
        not isinstance(expected_sha256, str)
        or not SOURCE_SHA256_PATTERN.fullmatch(expected_sha256.strip())
    ):
        raise ValueError("source SHA-256 is required")
    expected_sha256 = expected_sha256.strip().lower()
    try:
        source_resolved = source.resolve()
        destination_resolved = destination.resolve()
    except (OSError, RuntimeError, ValueError) as error:
        raise ValueError("source and output paths are invalid") from error
    if source_resolved == destination_resolved:
        raise ValueError("output must be a new path")
    raw_segments = selection.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        raise ValueError("each source needs at least one reviewed segment")

    copied = _snapshot_pdf_source(
        source,
        expected_sha256,
        snapshot_directory,
    )
    if isinstance(copied, dict):
        return copied
    limit_error, _total_pages = _source_limit_error(copied.path)
    if limit_error is not None:
        return limit_error

    source_document = pymupdf.open(str(copied.path))
    try:
        segments = _parse_pdf_segments(
            source_document,
            raw_segments,
        )
    finally:
        source_document.close()
    return _ParsedPdfSelection(
        source_path=source_path,
        snapshot_path=copied.path,
        segments=segments,
        source_sha256=copied.sha256,
    )


def _parse_pdf_selections(
    selections: list[object],
    destination: Path,
    snapshot_directory: Path,
) -> list[_ParsedPdfSelection] | dict[str, str]:
    parsed: list[_ParsedPdfSelection] = []
    for selection in selections:
        parsed_selection = _parse_pdf_selection(
            selection,
            destination,
            snapshot_directory,
        )
        if isinstance(parsed_selection, dict):
            return parsed_selection
        parsed.append(parsed_selection)
    return parsed


def _publish_exported_pdf(
    token: str,
    destination: Path,
    parsed: list[_ParsedPdfSelection],
) -> dict[str, object]:
    _reserve_output(token, destination, "pdf")
    # Build beside the final destination from immutable source snapshots.
    with tempfile.TemporaryDirectory(
        prefix=f".{destination.stem}-",
        dir=str(destination.parent),
    ) as temporary_dir:
        temporary_output = Path(temporary_dir) / destination.name
        export_merged_segments(
            temporary_output,
            [
                (selection.snapshot_path, selection.segments)
                for selection in parsed
            ],
        )
        expected_identity = _file_identity(temporary_output)
        _publish_new_file(temporary_output, destination)
    return _mark_output_created(token, destination, "pdf", expected_identity)


def _export_pdf_response(request: dict[str, object]) -> dict[str, object]:
    validated_token = _validated_export_token(request)
    if isinstance(validated_token, dict):
        return validated_token
    token = validated_token
    try:
        destination = _normalized_output_path(request.get("output_path"), ".pdf")
    except ExportOwnershipError as error:
        return _export_error(error)
    if isinstance(destination, dict):
        return destination
    selections = request.get("selections")
    if not isinstance(selections, list) or not selections:
        return _safe_error(ErrorCode.INVALID_SELECTIONS)
    try:
        with private_temporary_directory("source") as snapshot_dir:
            parsed = _parse_pdf_selections(
                selections,
                destination,
                snapshot_dir,
            )
            if isinstance(parsed, dict):
                return parsed
            published_identity = _publish_exported_pdf(token, destination, parsed)
        return {
            "status": "ok",
            "output_path": str(destination),
            "page_count": sum(len(selection.segments) for selection in parsed),
            "sha256": published_identity["sha256"],
        }
    except ExportOwnershipError as error:
        _discard_reservation(token, destination)
        return _export_error(error)
    except Exception as error:
        _discard_reservation(token, destination)
        # Keep local filesystem paths and third-party exception details out of
        # the JSONL boundary; the UI only needs a stable failure category.
        log_exception(
            LOGGER,
            40,
            operation="export_pdf",
            code=ErrorCode.PDF_EXPORT_FAILED.value,
            error=error,
            public_message=DEFAULT_ERROR_MESSAGES[ErrorCode.PDF_EXPORT_FAILED.value],
        )
        return _safe_error(ErrorCode.PDF_EXPORT_FAILED)


def _stage_and_publish_preview_pdf(
    preview: Path,
    destination: Path,
    preview_identity: dict[str, object],
) -> dict[str, object]:
    with tempfile.TemporaryDirectory(
        prefix=f".{destination.stem}-",
        dir=str(destination.parent),
    ) as temporary_dir:
        descriptor, raw_path = tempfile.mkstemp(
            prefix="staging-",
            suffix=".tmp",
            dir=temporary_dir,
        )
        os.close(descriptor)
        temporary_path = Path(raw_path)
        shutil.copyfile(preview, temporary_path)
        if _file_identity(preview) != preview_identity:
            raise ExportOwnershipError("ownership_lost", "PDF 预览已变化，请重新生成")
        copied_identity = _file_identity(temporary_path)
        if not hmac.compare_digest(
            str(copied_identity.get("sha256", "")),
            str(preview_identity.get("sha256", "")),
        ):
            raise ExportOwnershipError("export_failed", "PDF 预览复制校验失败")
        _publish_new_file(temporary_path, destination)
        return copied_identity


def _publish_preview_pdf_response(request: dict[str, object]) -> dict[str, object]:
    preview_token = _validated_named_export_token(request, "preview_token")
    final_token = _validated_named_export_token(request, "final_token")
    if isinstance(preview_token, dict):
        return preview_token
    if isinstance(final_token, dict):
        return final_token
    if hmac.compare_digest(preview_token, final_token):
        return _safe_error(
            ErrorCode.INVALID_EXPORT_TOKEN,
            "预览令牌与最终发布令牌必须不同",
        )

    preview = _normalized_existing_pdf_path(request.get("preview_path"))
    if isinstance(preview, dict):
        return preview
    try:
        destination = _normalized_output_path(request.get("output_path"), ".pdf")
    except ExportOwnershipError as error:
        return _export_error(error)
    if isinstance(destination, dict):
        return destination

    reserved = False
    try:
        preview_identity = _owned_created_output_identity(preview_token, preview, "pdf")
        _reserve_output(final_token, destination, "pdf")
        reserved = True
        expected_identity = _stage_and_publish_preview_pdf(preview, destination, preview_identity)
        identity = _mark_output_created(final_token, destination, "pdf", expected_identity)
        return {
            "status": "ok",
            "output_path": str(destination),
            "sha256": identity["sha256"],
        }
    except ExportOwnershipError as error:
        if reserved:
            _discard_reservation(final_token, destination)
        return _export_error(error)
    except OSError as error:
        if reserved:
            _discard_reservation(final_token, destination)
        log_exception(
            LOGGER,
            40,
            operation="publish_preview_pdf",
            code=ErrorCode.PDF_EXPORT_FAILED.value,
            error=error,
            public_message="PDF 预览发布失败",
        )
        return _safe_error(ErrorCode.PDF_EXPORT_FAILED, "PDF 预览发布失败")


V2_MAX_SEGMENTS = 50_000
V2_MAX_SOURCES = 10_000
V2_MAX_IDENTIFIER_LENGTH = 1_024
V2_MAX_PATH_LENGTH = 32_768
_V2_SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
_V2_UTC_ISO8601 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
_V2_CROP_MODES = {"candidate", "manual", "full_page"}
_V2_REVIEW_STATUSES = {
    "pending",
    "needs_review",
    "confirmed",
    "page_confirmed",
    "group_confirmed",
    "blocked",
}


class _InvalidV2Request(ValueError):
    """Internal marker for a malformed v2 request."""


class _V2ComputationVersionChanged(ValueError):
    """Internal marker for a stale analysis/review computation contract."""


def _v2_text(value: object, field: str, *, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\x00" in value:
        raise _InvalidV2Request(f"{field} is invalid")
    return value


def _v2_sha256(value: object, field: str) -> str:
    text = _v2_text(value, field, limit=64)
    if not _V2_SHA256_PATTERN.fullmatch(text):
        raise _InvalidV2Request(f"{field} is invalid")
    return text.lower()


def _v2_source_key(value: object, field: str = "source_key") -> str:
    text = _v2_text(value, field, limit=V2_MAX_PATH_LENGTH)
    return unicodedata.normalize("NFC", text.strip()).replace("\\", "/").lower()


def _v2_number(value: object, field: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _InvalidV2Request(f"{field} is invalid")
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError):
        raise _InvalidV2Request(f"{field} is invalid") from None
    if not math.isfinite(number) or (positive and number <= 0):
        raise _InvalidV2Request(f"{field} is invalid")
    return number


def _v2_positive_int(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise _InvalidV2Request(f"{field} is invalid")
    return value


def _v2_nonnegative_int(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _InvalidV2Request(f"{field} is invalid")
    return value


def _v2_rect(
    value: object,
    field: str,
    *,
    nullable: bool,
    ordered: bool = True,
    page_width: float | None = None,
    page_height: float | None = None,
) -> dict[str, float] | None:
    if value is None:
        if nullable:
            return None
        raise _InvalidV2Request(f"{field} is invalid")
    if not isinstance(value, dict):
        raise _InvalidV2Request(f"{field} is invalid")
    values = tuple(_v2_number(value.get(edge), f"{field}.{edge}") for edge in ("x0", "y0", "x1", "y1"))
    x0, y0, x1, y1 = values
    if ordered and not (0 <= x0 < x1 and 0 <= y0 < y1):
        raise _InvalidV2Request(f"{field} is invalid")
    if page_width is not None and page_height is not None and not (
        x1 <= page_width and y1 <= page_height
    ):
        raise _InvalidV2Request(f"{field} is invalid")
    return dict(zip(("x0", "y0", "x1", "y1"), values))


def _validated_v2_database_path(request: dict[str, object]) -> Path | dict[str, str]:
    raw_database_path = request.get("database_path")
    if not isinstance(raw_database_path, str) or not raw_database_path.strip():
        return _safe_error(ErrorCode.INVALID_DATABASE_PATH, "database_path is required")
    if len(raw_database_path) > V2_MAX_PATH_LENGTH or "\x00" in raw_database_path:
        return _safe_error(ErrorCode.INVALID_DATABASE_PATH)
    try:
        return Path(raw_database_path.strip())
    except (TypeError, ValueError, OSError):
        return _safe_error(ErrorCode.INVALID_DATABASE_PATH)


def _validated_v2_context(
    value: object,
    *,
    current_version: str,
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise _InvalidV2Request("context is invalid")
    version = value.get("version")
    if isinstance(version, bool) or version != 2:
        raise _InvalidV2Request("context is invalid")
    raw_sources = value.get("sources")
    if not isinstance(raw_sources, list) or not raw_sources or len(raw_sources) > V2_MAX_SOURCES:
        raise _InvalidV2Request("context is invalid")
    sources: list[dict[str, object]] = []
    source_keys: set[str] = set()
    for raw_source in raw_sources:
        if not isinstance(raw_source, dict):
            raise _InvalidV2Request("context is invalid")
        source_key = _v2_source_key(raw_source.get("source_key"))
        source_path = _v2_text(raw_source.get("source_path"), "source_path", limit=V2_MAX_PATH_LENGTH)
        if _v2_source_key(source_path, "source_path") != source_key:
            raise _InvalidV2Request("context is invalid")
        if source_key in source_keys:
            raise _InvalidV2Request("context is invalid")
        source_keys.add(source_key)
        sources.append({
            "source_key": source_key,
            "source_path": source_path,
            "source_sha256": _v2_sha256(raw_source.get("source_sha256"), "source_sha256"),
        })
    criteria_fingerprint = _v2_sha256(value.get("criteria_fingerprint"), "criteria_fingerprint")
    raw_computation_version = _v2_text(value.get("computation_version"), "computation_version", limit=256)
    if raw_computation_version != current_version:
        raise _V2ComputationVersionChanged("computation version changed")
    return {
        "version": 2,
        "sources": sources,
        "criteria_fingerprint": criteria_fingerprint,
        "computation_version": raw_computation_version,
    }


def _validated_v2_originals(value: object, context: dict[str, object]) -> list[dict[str, object]]:
    if not isinstance(value, list) or len(value) > V2_MAX_SEGMENTS:
        raise _InvalidV2Request("originals are invalid")
    raw_sources = context.get("sources")
    assert isinstance(raw_sources, list)
    source_keys = {str(source["source_key"]) for source in raw_sources if isinstance(source, dict)}
    originals: list[dict[str, object]] = []
    ids: set[str] = set()
    logical_keys: set[tuple[str, int, int]] = set()
    for raw_original in value:
        if not isinstance(raw_original, dict):
            raise _InvalidV2Request("originals are invalid")
        item = dict(raw_original)
        item_id = _v2_text(item.get("id"), "id", limit=V2_MAX_IDENTIFIER_LENGTH)
        if item_id in ids:
            raise _InvalidV2Request("originals are invalid")
        ids.add(item_id)
        source_key = _v2_source_key(item.get("source_key"))
        if source_key not in source_keys:
            raise _InvalidV2Request("originals are invalid")
        persistable = item.get("persistable")
        if not isinstance(persistable, bool):
            raise _InvalidV2Request("originals are invalid")
        if persistable:
            source_page = _v2_positive_int(item.get("source_page"), "source_page")
            segment_no = _v2_positive_int(item.get("segment_no"), "segment_no")
        else:
            # An invalid source/page can be retained for diagnostics, but it
            # must never be considered persistable by the v2 store.
            source_page = item.get("source_page")
            segment_no = _v2_positive_int(item.get("segment_no"), "segment_no")
            if isinstance(source_page, bool) or not isinstance(source_page, int):
                raise _InvalidV2Request("originals are invalid")
            if isinstance(segment_no, bool) or not isinstance(segment_no, int):
                raise _InvalidV2Request("originals are invalid")
        logical_key = (source_key, source_page, segment_no)
        if logical_key in logical_keys:
            raise _InvalidV2Request("originals are invalid")
        logical_keys.add(logical_key)
        analysis_signature = _v2_sha256(item.get("analysis_signature"), "analysis_signature")
        layout_fingerprint = _v2_text(item.get("layout_fingerprint"), "layout_fingerprint", limit=1_024)
        confidence = _v2_number(item.get("confidence"), "confidence")
        if not 0 <= confidence <= 1:
            raise _InvalidV2Request("originals are invalid")
        auto_full_page = item.get("auto_full_page")
        if not isinstance(auto_full_page, bool):
            raise _InvalidV2Request("originals are invalid")
        if persistable:
            page_width = _v2_number(item.get("page_width"), "page_width", positive=True)
            page_height = _v2_number(item.get("page_height"), "page_height", positive=True)
            match_rect = _v2_rect(item.get("match_rect"), "match_rect", nullable=False, page_width=page_width, page_height=page_height)
            candidate_rect = _v2_rect(item.get("candidate_rect"), "candidate_rect", nullable=True, page_width=page_width, page_height=page_height)
        else:
            page_width = _v2_number(item.get("page_width"), "page_width")
            page_height = _v2_number(item.get("page_height"), "page_height")
            if page_width < 0 or page_height < 0:
                raise _InvalidV2Request("originals are invalid")
            # Non-persistable diagnostics may retain finite geometry that is
            # out of page or not ordered.  The store must still reject any
            # attempt to save or confirm that item.
            match_rect = _v2_rect(item.get("match_rect"), "match_rect", nullable=True, ordered=False)
            candidate_rect = _v2_rect(item.get("candidate_rect"), "candidate_rect", nullable=True, ordered=False)
        item.update({
            "id": item_id,
            "source_key": source_key,
            "source_page": source_page,
            "segment_no": segment_no,
            "analysis_signature": analysis_signature,
            "persistable": persistable,
            "page_width": page_width,
            "page_height": page_height,
            "match_rect": match_rect,
            "candidate_rect": candidate_rect,
            "layout_fingerprint": layout_fingerprint,
            "confidence": confidence,
            "auto_full_page": auto_full_page,
        })
        originals.append(item)
    return originals


def _validated_v2_revision(value: object, field: str = "result_revision") -> str:
    return _v2_text(value, field, limit=128)


def _validated_v2_save_segments(
    value: object,
    *,
    context_key: str,
    result_revision: str,
) -> list[dict[str, object]]:
    if not isinstance(value, list) or len(value) > V2_MAX_SEGMENTS:
        raise _InvalidV2Request("segments are invalid")
    records: list[dict[str, object]] = []
    keys: set[tuple[str, int, int]] = set()
    ids: set[str] = set()
    for raw_record in value:
        if not isinstance(raw_record, dict):
            raise _InvalidV2Request("segments are invalid")
        record = dict(raw_record)
        record_context_key = _v2_text(record.get("context_key"), "context_key", limit=64)
        if record_context_key != context_key:
            raise _InvalidV2Request("segments are invalid")
        record_result_revision = _validated_v2_revision(record.get("result_revision"))
        if record_result_revision != result_revision:
            raise _InvalidV2Request("segments are invalid")
        source_key = _v2_source_key(record.get("source_key"))
        source_page = _v2_positive_int(record.get("source_page"), "source_page")
        segment_no = _v2_positive_int(record.get("segment_no"), "segment_no")
        record_id = _v2_text(record.get("id"), "id", limit=V2_MAX_IDENTIFIER_LENGTH)
        logical_key = (source_key, source_page, segment_no)
        if logical_key in keys or record_id in ids:
            raise _InvalidV2Request("segments are invalid")
        keys.add(logical_key)
        ids.add(record_id)
        record["id"] = record_id
        record["source_key"] = source_key
        record["source_page"] = source_page
        record["segment_no"] = segment_no
        record["record_revision"] = _v2_nonnegative_int(record.get("record_revision"), "record_revision")
        task_id = _v2_text(record.get("task_id"), "task_id", limit=V2_MAX_IDENTIFIER_LENGTH)
        source_path = _v2_text(record.get("source_path"), "source_path", limit=V2_MAX_PATH_LENGTH)
        # Logical identity survives a trusted batch relocation. The store
        # checks this access path against its authoritative context descriptor.
        _v2_source_key(source_path, "source_path")
        record["task_id"] = task_id
        record["source_sha256"] = _v2_sha256(record.get("source_sha256"), "source_sha256")
        record["analysis_signature"] = _v2_sha256(record.get("analysis_signature"), "analysis_signature")
        page_width = _v2_number(record.get("page_width"), "page_width", positive=True)
        page_height = _v2_number(record.get("page_height"), "page_height", positive=True)
        record["page_width"] = page_width
        record["page_height"] = page_height
        record["match_rect"] = _v2_rect(
            record.get("match_rect"),
            "match_rect",
            nullable=False,
            page_width=page_width,
            page_height=page_height,
        )
        record["candidate_rect"] = _v2_rect(
            record.get("candidate_rect"),
            "candidate_rect",
            nullable=True,
            page_width=page_width,
            page_height=page_height,
        )
        record["final_rect"] = _v2_rect(
            record.get("final_rect"),
            "final_rect",
            nullable=True,
            page_width=page_width,
            page_height=page_height,
        )
        record["layout_fingerprint"] = _v2_text(
            record.get("layout_fingerprint"),
            "layout_fingerprint",
            limit=1_024,
        )
        confidence = _v2_number(record.get("confidence"), "confidence")
        if not 0 <= confidence <= 1:
            raise _InvalidV2Request("segments are invalid")
        record["confidence"] = confidence
        crop_mode = record.get("crop_mode")
        review_status = record.get("review_status")
        if (
            not isinstance(crop_mode, str)
            or crop_mode not in _V2_CROP_MODES
            or not isinstance(review_status, str)
            or review_status not in _V2_REVIEW_STATUSES
        ):
            raise _InvalidV2Request("segments are invalid")
        record["manual_adjusted"] = record.get("manual_adjusted")
        if not isinstance(record["manual_adjusted"], bool):
            raise _InvalidV2Request("segments are invalid")
        reviewed_at = record.get("reviewed_at")
        if not isinstance(reviewed_at, str) or not _V2_UTC_ISO8601.fullmatch(reviewed_at):
            raise _InvalidV2Request("segments are invalid")
        try:
            parsed_reviewed_at = datetime.fromisoformat(reviewed_at[:-1] + "+00:00")
        except (TypeError, ValueError):
            raise _InvalidV2Request("segments are invalid") from None
        if parsed_reviewed_at.tzinfo is None or parsed_reviewed_at.utcoffset() != timedelta(0):
            raise _InvalidV2Request("segments are invalid")
        if record["final_rect"] is None:
            if review_status in {"confirmed", "page_confirmed", "group_confirmed"} and crop_mode != "full_page":
                raise _InvalidV2Request("segments are invalid")
        elif crop_mode != "full_page" and (
            record["final_rect"]["x1"] - record["final_rect"]["x0"] < MIN_EXPORT_RECT_SIZE
            or record["final_rect"]["y1"] - record["final_rect"]["y0"] < MIN_EXPORT_RECT_SIZE
        ):
            raise _InvalidV2Request("segments are invalid")
        if "persistable" in record and record["persistable"] is not True:
            raise _InvalidV2Request("segments are invalid")
        if "persistable" in record and not isinstance(record["persistable"], bool):
            raise _InvalidV2Request("segments are invalid")
        if "auto_full_page" in record and not isinstance(record["auto_full_page"], bool):
            raise _InvalidV2Request("segments are invalid")
        records.append(record)
    return records


def _validated_v2_prepare_result(
    value: object,
    *,
    context_key: str,
    result_revision: str,
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise _V2InvalidStoreResponse("prepare returned an invalid payload")
    if value.get("context_key") != context_key or value.get("result_revision") != result_revision:
        raise _V2InvalidStoreResponse("prepare returned a mismatched context")
    segments = value.get("segments")
    record_revisions = value.get("record_revisions")
    group_confirmed = value.get("group_confirmed")
    if not isinstance(segments, list) or not isinstance(record_revisions, list) or not isinstance(group_confirmed, bool):
        raise _V2InvalidStoreResponse("prepare returned an invalid payload")
    if len(segments) > V2_MAX_SEGMENTS or len(record_revisions) > V2_MAX_SEGMENTS:
        raise _V2InvalidStoreResponse("prepare returned an invalid payload")
    if not all(isinstance(item, dict) for item in segments + record_revisions):
        raise _V2InvalidStoreResponse("prepare returned an invalid payload")
    return dict(value)


def _validated_v2_save_result(
    value: object,
    *,
    context_key: str,
    result_revision: str,
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise _V2InvalidStoreResponse("save returned an invalid payload")
    if value.get("context_key") != context_key or value.get("result_revision") != result_revision:
        raise _V2InvalidStoreResponse("save returned a mismatched context")
    saved_count = value.get("saved_count")
    segments = value.get("segments")
    if isinstance(saved_count, bool) or not isinstance(saved_count, int) or saved_count < 0:
        raise _V2InvalidStoreResponse("save returned an invalid payload")
    if not isinstance(segments, list) or len(segments) > V2_MAX_SEGMENTS or not all(isinstance(item, dict) for item in segments):
        raise _V2InvalidStoreResponse("save returned an invalid payload")
    if saved_count != len(segments):
        raise _V2InvalidStoreResponse("save returned an invalid payload")
    return dict(value)


def _prepare_review_context_v2_response(request: dict[str, object]) -> dict[str, object]:
    database_path = _validated_v2_database_path(request)
    if isinstance(database_path, dict):
        return database_path
    try:
        current_version = current_computation_version(ENGINE_CONFIG)
        context = _validated_v2_context(request.get("context"), current_version=current_version)
        result_revision = _validated_v2_revision(request.get("result_revision"))
        originals = _validated_v2_originals(request.get("originals"), context)
    except ComputationInfoError:
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED)
    except _V2ComputationVersionChanged:
        return _safe_error(ErrorCode.COMPUTATION_VERSION_CHANGED)
    except _InvalidV2Request:
        return _safe_error(ErrorCode.INVALID_REVIEW_SEGMENTS)

    try:
        with ReviewStoreV2(database_path) as store:
            prepared = store.prepare(context, originals, result_revision=result_revision)
        context_key = prepared.get("context_key") if isinstance(prepared, dict) else None
        if not isinstance(context_key, str) or not _V2_SHA256_PATTERN.fullmatch(context_key):
            raise _V2InvalidStoreResponse("prepare returned an invalid context key")
        validated = _validated_v2_prepare_result(
            prepared,
            context_key=context_key,
            result_revision=result_revision,
        )
        return {"status": "ok", **validated}
    except _V2ComputationVersionChanged:
        return _safe_error(ErrorCode.COMPUTATION_VERSION_CHANGED)
    except ReviewRevisionConflict:
        return _safe_error(ErrorCode.REVIEW_REVISION_CONFLICT)
    except _V2InvalidStoreResponse:
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED)
    except _V2_STORAGE_CORRUPTION_ERRORS:
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED)
    except (OSError, sqlite3.Error):
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED)
    except _ReviewStoreErrorV2:
        return _safe_error(ErrorCode.INVALID_REVIEW_SEGMENTS)
    except Exception:
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED)


def _read_review_snapshot_v2_response(request: dict[str, object]) -> dict[str, object]:
    database_path = _validated_v2_database_path(request)
    if isinstance(database_path, dict):
        return database_path
    try:
        context_key = _v2_sha256(request.get("context_key"), "context_key")
        result_revision = _validated_v2_revision(request.get("result_revision"))
    except _InvalidV2Request:
        return _safe_error(ErrorCode.INVALID_REVIEW_SEGMENTS)
    try:
        snapshot = read_review_snapshot(database_path, context_key, result_revision)
        validated = _validated_v2_prepare_result(snapshot, context_key=context_key, result_revision=result_revision)
        return {"status": "ok", **validated}
    except ReviewRevisionConflict:
        return _safe_error(ErrorCode.REVIEW_REVISION_CONFLICT)
    except (_V2InvalidStoreResponse, _ReviewStoreErrorV2, OSError, sqlite3.Error):
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED)
    except Exception:
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED)


def _save_review_segments_v2_response(request: dict[str, object]) -> dict[str, object]:
    database_path = _validated_v2_database_path(request)
    if isinstance(database_path, dict):
        return database_path
    try:
        context_key = _v2_sha256(request.get("context_key"), "context_key")
        result_revision = _validated_v2_revision(request.get("result_revision"))
        confirm_group = request.get("confirm_group")
        if not isinstance(confirm_group, bool):
            raise _InvalidV2Request("confirm_group is invalid")
        records = _validated_v2_save_segments(
            request.get("segments"),
            context_key=context_key,
            result_revision=result_revision,
        )
    except _InvalidV2Request:
        return _safe_error(ErrorCode.INVALID_REVIEW_SEGMENTS)

    try:
        with ReviewStoreV2(database_path) as store:
            saved = store.save(
                context_key,
                result_revision,
                records,
                confirm_group=confirm_group,
            )
        validated = _validated_v2_save_result(
            saved,
            context_key=context_key,
            result_revision=result_revision,
        )
        return {"status": "ok", **validated}
    except _V2ComputationVersionChanged:
        return _safe_error(ErrorCode.COMPUTATION_VERSION_CHANGED)
    except ReviewRevisionConflict:
        return _safe_error(ErrorCode.REVIEW_REVISION_CONFLICT)
    except _V2InvalidStoreResponse:
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED)
    except _V2_STORAGE_CORRUPTION_ERRORS:
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED)
    except (OSError, sqlite3.Error):
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED)
    except _ReviewStoreErrorV2:
        return _safe_error(ErrorCode.INVALID_REVIEW_SEGMENTS)
    except Exception:
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED)


def _validated_review_request(request: dict[str, object]) -> tuple[Path, str] | dict[str, str]:
    """Validate persistence identifiers without exposing local app paths."""

    raw_database_path = request.get("database_path")
    task_id = request.get("task_id")
    if not isinstance(raw_database_path, str) or not raw_database_path.strip():
        return _safe_error(ErrorCode.INVALID_DATABASE_PATH, "database_path is required")
    if not isinstance(task_id, str) or not task_id.strip():
        return _safe_error(ErrorCode.INVALID_TASK_ID)
    try:
        database_path = Path(raw_database_path)
    except (TypeError, ValueError):
        return _safe_error(ErrorCode.INVALID_DATABASE_PATH)
    return database_path, task_id


def _save_review_segments_response(request: dict[str, object]) -> dict[str, object]:
    validated = _validated_review_request(request)
    if isinstance(validated, dict):
        return validated
    database_path, task_id = validated
    try:
        # Decode and validate the entire batch before ReviewStore opens its
        # write transaction.  An invalid later item therefore cannot leave a
        # partially persisted review state behind.
        records = records_from_payload(request.get("segments"), task_id=task_id)
        with ReviewStore(database_path) as store:
            saved = store.save(records)
        return {"status": "ok", "task_id": task_id, "saved_count": len(saved)}
    except ReviewStoreError:
        return _safe_error(ErrorCode.INVALID_REVIEW_SEGMENTS)
    except (OSError, sqlite3.Error):
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED, "review segments could not be saved")
    except Exception:
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED, "review segments could not be saved")


def _load_review_segments_response(request: dict[str, object]) -> dict[str, object]:
    validated = _validated_review_request(request)
    if isinstance(validated, dict):
        return validated
    database_path, task_id = validated
    try:
        with ReviewStore(database_path) as store:
            records = store.list_for_task(task_id)
        return {"status": "ok", "task_id": task_id, "segments": [record.to_dict() for record in records]}
    except ReviewStoreError:
        return _safe_error(ErrorCode.INVALID_REVIEW_SEGMENTS, "stored review segments are invalid")
    except (OSError, sqlite3.Error):
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED, "review segments could not be loaded")
    except Exception:
        return _safe_error(ErrorCode.REVIEW_STORE_FAILED, "review segments could not be loaded")


def _ocr_cache_unavailable(*, clear: bool, failed_entries: int = 0) -> dict[str, object]:
    """Build the cache management DTO without exposing implementation details."""

    response: dict[str, object] = {
        "status": "ok",
        "available": False,
        "entries": 0,
        "bytes": 0,
        "max_bytes": OCR_CACHE_MAX_BYTES,
        "retention_days": OCR_CACHE_RETENTION_DAYS,
    }
    if clear:
        response.update(removed_entries=0, failed_entries=max(0, failed_entries))
    return response


def _nonnegative_int(value: object) -> bool:
    return type(value) is int and value >= 0


def _normalize_ocr_cache_report(raw: object, *, clear: bool) -> dict[str, object]:
    """Keep cache reports an independent, path-free wire DTO.

    The cache module already fails closed, but this second boundary prevents a
    future implementation or an unexpected exception from returning paths,
    OCR text, or arbitrary diagnostic fields over JSONL.
    """

    if not isinstance(raw, dict):
        return _ocr_cache_unavailable(clear=clear, failed_entries=1 if clear else 0)
    if (
        raw.get("status") != "ok"
        or type(raw.get("available")) is not bool
        or not _nonnegative_int(raw.get("entries"))
        or not _nonnegative_int(raw.get("bytes"))
        or raw.get("max_bytes") != OCR_CACHE_MAX_BYTES
        or raw.get("retention_days") != OCR_CACHE_RETENTION_DAYS
    ):
        failed = raw.get("failed_entries") if clear else 0
        return _ocr_cache_unavailable(
            clear=clear,
            failed_entries=failed if _nonnegative_int(failed) else (1 if clear else 0),
        )

    available = bool(raw["available"])
    response: dict[str, object] = {
        "status": "ok",
        "available": available,
        "entries": raw["entries"] if available else 0,
        "bytes": raw["bytes"] if available else 0,
        "max_bytes": OCR_CACHE_MAX_BYTES,
        "retention_days": OCR_CACHE_RETENTION_DAYS,
    }
    if clear:
        removed = raw.get("removed_entries")
        failed = raw.get("failed_entries")
        response.update(
            removed_entries=removed if _nonnegative_int(removed) else 0,
            failed_entries=failed if _nonnegative_int(failed) else (1 if not available else 0),
        )
    return response


def _ocr_cache_response(request: dict[str, object], *, clear: bool) -> dict[str, object]:
    """Dispatch one of the fixed-parameter OCR cache management operations."""

    if set(request) != {"op"}:
        return _safe_error(ErrorCode.INVALID_REQUEST)
    try:
        raw = ocr_cache_clear() if clear else ocr_cache_info()
    except Exception:
        return _ocr_cache_unavailable(clear=clear, failed_entries=1 if clear else 0)
    return _normalize_ocr_cache_report(raw, clear=clear)


def handle_request(request: object) -> dict[str, object]:
    """Handle one JSON-line request."""

    if not isinstance(request, dict):
        return _safe_error(ErrorCode.INVALID_REQUEST)

    if isinstance(request.get("op"), str) and request["op"].startswith("batch_"):
        from engine.batch_api import handle_batch_request

        return handle_batch_request(request)

    if isinstance(request.get("op"), str) and request["op"].startswith("export_intent_"):
        from engine.export_api import handle_export_request

        return handle_export_request(request)

    if request.get("op") in {"engine_computation_info", "computation_info"}:
        try:
            return computation_info(ENGINE_CONFIG)
        except ComputationInfoError:
            # Source code or distribution metadata could not be identified;
            # never return a guessed version that might revive old results.
            return _safe_error(ErrorCode.REVIEW_STORE_FAILED)
        except Exception:
            return _safe_error(ErrorCode.REVIEW_STORE_FAILED)
    if request.get("op") == "health":
        return health_payload()
    if request.get("op") == "ocr_cache_info":
        return _ocr_cache_response(request, clear=False)
    if request.get("op") == "ocr_cache_clear":
        return _ocr_cache_response(request, clear=True)
    if request.get("op") == "search":
        return _search_response(request)
    if request.get("op") == "search_multi":
        return _search_multi_response(request)
    if request.get("op") == "render_page":
        return _render_page_response(request)
    if request.get("op") == "inspect_pdf":
        return _inspect_pdf_response(request)
    if request.get("op") == "analyze_page":
        return _analyze_page_response(request)
    if request.get("op") == "export_index":
        return _export_index_response(request)
    if request.get("op") == "export_pdf":
        return _export_pdf_response(request)
    if request.get("op") == "publish_preview_pdf":
        return _publish_preview_pdf_response(request)
    if request.get("op") == "cleanup_exports":
        return _cleanup_exports_response(request)
    if request.get("op") == "release_exports":
        return _release_exports_response(request)
    if request.get("op") == "save_review_segments":
        return _save_review_segments_response(request)
    if request.get("op") == "load_review_segments":
        return _load_review_segments_response(request)
    if request.get("op") == "prepare_review_context_v2":
        return _prepare_review_context_v2_response(request)
    if request.get("op") == "read_review_snapshot_v2":
        return _read_review_snapshot_v2_response(request)
    if request.get("op") == "save_review_segments_v2":
        return _save_review_segments_v2_response(request)
    if request.get("op") == "ocr_health":
        verify = request.get('verify', False)
        if type(verify) is not bool:
            return _safe_error(ErrorCode.INVALID_REQUEST)
        return {"status": "ok", **runtime_status(verify=verify)}

    return _safe_error(ErrorCode.UNSUPPORTED_OPERATION)


def _error_response(code: ErrorCode | str, message: str | None = None) -> dict[str, str]:
    return _safe_error(code, message)


def serve(input_stream: TextIO, output_stream: TextIO) -> int:
    """Serve newline-delimited JSON requests until stdin reaches EOF.

    The protocol intentionally writes only JSON responses to stdout so a host
    process can safely parse one response per non-empty request line.
    """

    for raw_line in input_stream:
        line = raw_line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            response = _error_response(ErrorCode.INVALID_JSON)
        else:
            response = handle_request(request)

        output_stream.write(json.dumps(response, ensure_ascii=False) + "\n")
        output_stream.flush()

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="PDF Search local processing engine")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--health", action="store_true", help="return a health payload")
    mode.add_argument("--serve", action="store_true", help="serve newline-delimited JSON requests")
    mode.add_argument("--batch-worker", action="store_true", help="run one persistent batch generation")
    parser.add_argument("--batch-database")
    parser.add_argument("--batch-job")
    parser.add_argument("--batch-generation", type=int)
    parser.add_argument("--batch-owner")
    args = parser.parse_args()

    if args.batch_worker:
        if not args.batch_database or not args.batch_job or not args.batch_owner or not args.batch_generation:
            parser.error("batch worker requires its assigned database and identity")
        from engine.batch_worker import run_worker

        try:
            return run_worker(args.batch_database, args.batch_job, args.batch_generation, args.batch_owner,
                              sys.stdin.fileno(), sys.stdout.buffer)
        except Exception:
            # No PDF paths, extracted text or raw exception is sent to IPC.
            print("batch worker stopped before completion", file=sys.stderr)
            return 1

    if args.health:
        print(json.dumps(health_payload(), ensure_ascii=False))
        return 0

    if args.serve:
        return serve(sys.stdin, sys.stdout)

    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
