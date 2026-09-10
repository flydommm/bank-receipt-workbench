"""Publish a rendered export bundle as one no-replace directory.

The export intent and the private PDF previews are owned by ``ExportBundleService``.
This module only handles the second, deliberately narrow, phase: copy those
already-rendered bytes, optionally create the audit workbook and manifest, and
atomically publish the containing directory.  Every cleanup operation is
identity based and direct-child only.
"""

from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime
from contextvars import ContextVar
import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Any, Iterator, TYPE_CHECKING
from uuid import UUID, uuid4

from . import exporter
from .batch_store import BatchStore
from .export_directory import (
    ExportDirectoryError,
    directory_identity,
    remove_directory_owned,
    rename_directory_no_replace as _rename_directory_handle,
    writable_directory,
)
from .export_scope import ExportScopeError, hold_export_scope

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from .export_bundle import ExportBundleService


MAX_RESIDUAL_ATTEMPTS = 16
_CHUNK_SIZE = 1024 * 1024
_WINDOWS_REPARSE_POINT = 0x0400
_rename_expectations: ContextVar[tuple[object, object] | None] = ContextVar(
    "export_publish_rename_expectations",
    default=None,
)


class ExportPublishError(ExportScopeError):
    """A publication failure carrying the exact paths left for retry."""

    def __init__(
        self,
        message: str,
        residuals: list[dict[str, str]] | None = None,
        code: str = "export_publish_failed",
    ) -> None:
        self.residuals = _normalise_residuals(residuals or [])
        detail = message
        if self.residuals:
            detail = f"{message}；残留路径：" + "；".join(
                f"{item['path']}（{item['reason']}）" for item in self.residuals
            )
        super().__init__(detail, code)


def _normalise_residuals(value: object) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    if not isinstance(value, list):
        return result
    seen: set[tuple[str, str]] = set()
    for item in value:
        if isinstance(item, dict) and isinstance(item.get("path"), str) and isinstance(item.get("reason"), str):
            pair = (item["path"], item["reason"])
        elif isinstance(item, (tuple, list)) and len(item) == 2 and all(isinstance(part, str) for part in item):
            pair = (item[0], item[1])
        else:
            continue
        if pair not in seen:
            seen.add(pair)
            result.append({"path": pair[0], "reason": pair[1]})
    return result


def _residual(path: Path | str, reason: str) -> dict[str, str]:
    return {"path": str(path), "reason": reason}


def _valid_uuid(value: object, label: str = "export intent token") -> str:
    if not isinstance(value, str):
        raise ExportScopeError(f"{label} is invalid")
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError):
        raise ExportScopeError(f"{label} is invalid") from None
    if str(parsed) != value:
        raise ExportScopeError(f"{label} is invalid")
    return value


def _stable_path(value: Path) -> str:
    return os.path.normcase(os.path.normpath(str(value)))


def _is_reparse(info: os.stat_result) -> bool:
    return bool(int(getattr(info, "st_file_attributes", 0)) & _WINDOWS_REPARSE_POINT)


def _directory_identity(value: Path | str, *, label: str = "export directory") -> tuple[Path, dict[str, int | str]]:
    """Validate an existing ordinary absolute directory and return its identity."""
    try:
        path = value if isinstance(value, Path) else Path(value) if isinstance(value, str) else None
        if path is None:
            raise ExportDirectoryError(f"{label} is invalid")
        identity = directory_identity(path)
        return path.resolve(strict=True), identity
    except ExportDirectoryError as error:
        raise ExportPublishError(str(error)) from error
    except (OSError, RuntimeError, ValueError) as error:
        raise ExportPublishError(f"{label} is unavailable") from error


def _same_directory_inode(actual: object, expected: object, *, require_path: bool = True) -> bool:
    if not isinstance(actual, dict) or not isinstance(expected, dict):
        return False
    try:
        if int(actual["device"]) != int(expected["device"]) or int(actual["inode"]) != int(expected["inode"]):
            return False
        if require_path:
            return _stable_path(Path(str(actual["resolved_path"]))) == _stable_path(Path(str(expected["resolved_path"])))
        return True
    except (KeyError, TypeError, ValueError):
        return False


@contextmanager
def _locked_parent(parent: Path, expected_identity: dict[str, int | str]) -> Iterator[None]:
    """Hold and recheck the selected parent directory across publication."""
    try:
        with writable_directory(parent, expected_identity):
            yield
    except ExportDirectoryError as error:
        raise ExportPublishError(
            str(error),
            [_residual(parent, "parent directory cannot be safely protected")],
        ) from error


def _file_identity_from_stat(info: os.stat_result, digest: str) -> dict[str, object]:
    return {
        "st_dev": int(info.st_dev),
        "st_ino": int(info.st_ino),
        "size": int(info.st_size),
        "mtime_ns": int(info.st_mtime_ns),
        "sha256": digest,
    }


def _stat_matches_identity(info: os.stat_result, identity: object) -> bool:
    if not isinstance(identity, dict):
        return False
    try:
        return (
            int(info.st_dev) == int(identity["st_dev"])
            and int(info.st_ino) == int(identity["st_ino"])
            and int(info.st_size) == int(identity["size"])
            and int(info.st_mtime_ns) == int(identity["mtime_ns"])
        )
    except (KeyError, TypeError, ValueError):
        return False


def _identity_equal(actual: object, expected: object) -> bool:
    if not isinstance(actual, dict) or not isinstance(expected, dict):
        return False
    return all(actual.get(key) == expected.get(key) for key in ("st_dev", "st_ino", "size", "mtime_ns", "sha256"))


def _hash_open_file(handle: Any) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = handle.read(_CHUNK_SIZE)
        if not chunk:
            break
        digest.update(chunk)
        total += len(chunk)
    return digest.hexdigest(), total


def _file_identity(path: Path) -> dict[str, object]:
    """Read one regular file and return its complete identity."""

    try:
        link = path.lstat()
        if stat.S_ISLNK(link.st_mode) or not stat.S_ISREG(link.st_mode) or _is_reparse(link):
            raise OSError("file is not an ordinary file")
        with path.open("rb") as handle:
            before = os.fstat(handle.fileno())
            digest, total = _hash_open_file(handle)
            after = os.fstat(handle.fileno())
        if (int(before.st_dev), int(before.st_ino), int(before.st_size), int(before.st_mtime_ns)) != (
            int(after.st_dev), int(after.st_ino), int(after.st_size), int(after.st_mtime_ns)
        ) or total != int(after.st_size):
            raise OSError("file changed while hashing")
        return _file_identity_from_stat(after, digest)
    except (OSError, ValueError):
        raise


def _owned_preview_identity(token: str, path: Path) -> dict[str, object]:
    """Resolve a preview through the core ownership registry."""

    from . import engine as core

    result = core._owned_created_output_identity(token, path, "pdf")
    if not isinstance(result, dict):
        raise ExportPublishError("PDF preview identity is unavailable")
    return dict(result)


def _copy_owned_preview(token: str, source_path: Path, destination: Path, expected: object) -> dict[str, object]:
    """Copy/hash a preview using one source handle and an exclusive target."""

    if not isinstance(expected, dict) or not isinstance(expected.get("sha256"), str):
        raise ExportPublishError("PDF preview identity is unavailable")
    try:
        link = source_path.lstat()
        if stat.S_ISLNK(link.st_mode) or not stat.S_ISREG(link.st_mode) or _is_reparse(link):
            raise ExportPublishError("PDF preview is not an ordinary file")
        with source_path.open("rb") as source:
            source_before = os.fstat(source.fileno())
            if not _stat_matches_identity(source_before, expected):
                raise ExportPublishError("PDF preview identity changed")
            digest = hashlib.sha256()
            total = 0
            with destination.open("xb") as target:
                while True:
                    chunk = source.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    target.write(chunk)
                    digest.update(chunk)
                    total += len(chunk)
                target.flush()
                os.fsync(target.fileno())
                target_stat = os.fstat(target.fileno())
            source_after = os.fstat(source.fileno())
        digest_text = digest.hexdigest()
        if (
            digest_text != expected["sha256"]
            or total != int(expected.get("size", total))
            or not _stat_matches_identity(source_after, expected)
            or int(target_stat.st_size) != total
        ):
            raise ExportPublishError("PDF preview changed while copying")
        # The pathname must still resolve through the same host-owned token
        # after the copy.  This catches a replacement that happened after the
        # source handle was opened.
        current = _owned_preview_identity(token, source_path)
        if not _identity_equal(current, expected):
            raise ExportPublishError("PDF preview identity changed")
        link_after = destination.lstat()
        if stat.S_ISLNK(link_after.st_mode) or not stat.S_ISREG(link_after.st_mode) or _is_reparse(link_after):
            raise ExportPublishError("published temporary file is not ordinary")
        return _file_identity_from_stat(target_stat, digest_text)
    except FileExistsError as error:
        raise ExportPublishError("temporary output file already exists", [_residual(destination, "output exists")]) from error
    except ExportPublishError:
        raise
    except (OSError, ValueError) as error:
        raise ExportPublishError("PDF preview copy failed") from error


def _safe_leaf(value: object) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ExportPublishError("output filename is invalid")
    if len(value.encode("utf-16-le", "surrogatepass")) // 2 > 240:
        raise ExportPublishError("output filename is invalid")
    path = Path(value)
    if (path.name != value or value in {".", ".."} or "/" in value or "\\" in value
            or any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in value)
            or any(character in value for character in '<>:"|?*')
            or value.endswith((".", " "))
            or value.split(".", 1)[0].casefold() in {"con", "prn", "aux", "nul", *(f"com{index}" for index in range(1, 10)), *(f"lpt{index}" for index in range(1, 10))}):
        raise ExportPublishError("output filename is invalid")
    return value


def _scope_request(snapshot: dict[str, Any]) -> dict[str, Any]:
    from .export_bundle import scope_request

    return scope_request(snapshot)


def _scope_rows(scope: dict[str, Any]) -> list[dict[str, object]]:
    summary = scope.get("summary") if isinstance(scope.get("summary"), dict) else {}
    rows: list[dict[str, object]] = [
        {"item": "scope_kind", "value": scope.get("scope_kind")},
        {"item": "output_mode", "value": scope.get("output_mode")},
        {"item": "output_name", "value": scope.get("output_name")},
        {"item": "include_xlsx", "value": scope.get("include_xlsx")},
        {"item": "result_revision", "value": scope.get("result_revision")},
        {"item": "review_revision", "value": scope.get("review_revision")},
        {"item": "source_fingerprint", "value": scope.get("source_fingerprint")},
    ]
    for key in (
        "total_segments",
        "selected_count",
        "selected_source_count",
        "omitted_count",
        "omitted_unresolved_count",
        "expected_pages",
    ):
        rows.append({"item": key, "value": summary.get(key)})
    return rows


def _manifest_file(record: dict[str, object]) -> dict[str, object]:
    item: dict[str, object] = {
        "name": record["name"],
        "kind": record["kind"],
        "sha256": record["identity"]["sha256"],  # type: ignore[index]
        "size_bytes": record["identity"]["size"],  # type: ignore[index]
    }
    if record.get("kind") == "pdf":
        item["page_count"] = record.get("page_count")
    return item


def _manifest_source_name(value: object) -> object:
    """Keep logical display names while stripping accidental source paths."""

    if not isinstance(value, str):
        return value
    if "/" in value or "\\" in value:
        return value.replace("\\", "/").rsplit("/", 1)[-1]
    return value


def _build_manifest(entry: dict[str, Any], attempt: dict[str, Any]) -> dict[str, object]:
    scope = entry.get("scope")
    plan = entry.get("plan")
    if not isinstance(scope, dict) or not isinstance(plan, dict):
        raise ExportPublishError("frozen export intent is unavailable")
    source_items = scope.get("sources") if isinstance(scope.get("sources"), list) else []
    sources: list[dict[str, object]] = []
    for source in source_items:
        if isinstance(source, dict):
            display_name = source.get("name")
            if not isinstance(display_name, str) or not display_name.strip():
                display_name = source.get("source_path")
            sources.append({
                "source_key": source.get("source_key"),
                "name": _manifest_source_name(display_name),
                "sha256": source.get("source_sha256"),
            })
    mappings: list[dict[str, object]] = []
    for mapping in plan.get("mappings", []):
        if isinstance(mapping, dict):
            mappings.append({
                key: mapping.get(key)
                for key in ("segment_id", "source_file", "source_page", "segment_no", "output_file", "output_page")
            })
            mappings[-1]["source_file"] = _manifest_source_name(mappings[-1].get("source_file"))
    output_files = [
        _manifest_file(record)
        for record in attempt.get("files", [])
        if isinstance(record, dict) and record.get("kind") in {"pdf", "xlsx"} and record.get("state") == "created"
    ]
    summary = deepcopy(scope.get("summary", {}))
    if not isinstance(summary, dict):
        summary = {}
    return {
        "version": 1,
        "intent_id": entry.get("intent_id"),
        "job_id": entry.get("job_id"),
        "result_revision": scope.get("result_revision"),
        "review_revision": scope.get("review_revision"),
        "scope": {
            "kind": scope.get("scope_kind"),
            "selected_segment_ids": list(scope.get("selected_segment_ids", [])),
            "summary": summary,
            "output_mode": scope.get("output_mode"),
            "include_xlsx": scope.get("include_xlsx"),
            **({"output_name": scope["output_name"]} if "output_name" in scope else {}),
        },
        "sources": sources,
        "files": output_files,
        "plan": {"mappings": mappings},
    }


def _receipt(entry: dict[str, Any], attempt: dict[str, Any], final_directory: Path) -> dict[str, object]:
    scope = entry["scope"]
    plan = entry["plan"]
    files: list[dict[str, object]] = []
    for record in attempt.get("files", []):
        if not isinstance(record, dict) or record.get("state") != "created":
            raise ExportPublishError("publication file set is incomplete")
        identity = record.get("identity")
        if not isinstance(identity, dict):
            raise ExportPublishError("publication file identity is incomplete")
        item: dict[str, object] = {
            "name": record.get("name"),
            "path": str(final_directory / str(record.get("name"))),
            "kind": record.get("kind"),
            "sha256": identity.get("sha256"),
            "size_bytes": identity.get("size"),
        }
        if record.get("kind") == "pdf":
            item["page_count"] = record.get("page_count")
        files.append(item)
    summary = deepcopy(scope.get("summary", {}))
    if not isinstance(summary, dict):
        summary = {}
    return {
        "intent_id": entry["intent_id"],
        "state": "published",
        "directory": str(final_directory),
        "files": files,
        "summary": summary,
        "merged_pages": plan.get("merged_pages", 0),
        "source_pages": plan.get("source_pages", 0),
        "total_pages": plan.get("total_pages", 0),
        "row_count": summary.get("selected_count", 0) if scope.get("include_xlsx") else 0,
        **({
            "merged_name": next(
                (file.get("name") for file in plan.get("files", [])
                 if isinstance(file, dict) and file.get("file_id") == "merged"),
                None,
            ),
        } if any(isinstance(file, dict) and file.get("file_id") == "merged" for file in plan.get("files", [])) else {}),
    }


def _validated_receipt(entry: dict[str, Any]) -> dict[str, object]:
    """Validate the compact receipt without reopening source/review state."""

    value = entry.get("receipt")
    if not isinstance(value, dict):
        raise ExportPublishError("published receipt is unavailable")
    if value.get("intent_id") != entry.get("intent_id") or value.get("state") != "published":
        raise ExportPublishError("published receipt identity is invalid")
    directory_raw = value.get("directory")
    files = value.get("files")
    if not isinstance(directory_raw, str) or not Path(directory_raw).is_absolute() or not isinstance(files, list):
        raise ExportPublishError("published receipt is invalid")
    names: set[str] = set()
    declared_merged_name = value.get("merged_name")
    if declared_merged_name is not None:
        try:
            _safe_leaf(declared_merged_name)
        except (ExportPublishError, TypeError):
            raise ExportPublishError("published receipt merged filename is invalid") from None
        if not isinstance(declared_merged_name, str) or not declared_merged_name.lower().endswith(".pdf"):
            raise ExportPublishError("published receipt merged filename is invalid")
    pdf_count = 0
    xlsx_count = 0
    json_count = 0
    for item in files:
        if not isinstance(item, dict) or item.get("kind") not in {"pdf", "xlsx", "json"}:
            raise ExportPublishError("published receipt file set is invalid")
        name = item.get("name")
        path = item.get("path")
        if not isinstance(name, str) or not isinstance(path, str):
            raise ExportPublishError("published receipt file set is invalid")
        try:
            _safe_leaf(name)
        except ExportPublishError:
            raise ExportPublishError("published receipt file set is invalid") from None
        if name in names or Path(path) != Path(directory_raw) / name:
            raise ExportPublishError("published receipt file set is invalid")
        names.add(name)
        if not isinstance(item.get("sha256"), str) or type(item.get("size_bytes")) is not int or item["size_bytes"] < 0:
            raise ExportPublishError("published receipt file identity is invalid")
        kind = item["kind"]
        if kind == "pdf":
            pdf_count += 1
            if not name.lower().endswith(".pdf") or type(item.get("page_count")) is not int or item["page_count"] < 1:
                raise ExportPublishError("published PDF receipt is invalid")
        elif kind == "xlsx":
            xlsx_count += 1
            if name != "匹配索引.xlsx" or "page_count" in item:
                raise ExportPublishError("published XLSX receipt is invalid")
        else:
            json_count += 1
            if name != "导出清单.json" or "page_count" in item:
                raise ExportPublishError("published manifest receipt is invalid")
    if pdf_count < 1 or xlsx_count > 1 or json_count != 1:
        raise ExportPublishError("published receipt file set is incomplete")
    for key in ("summary", "merged_pages", "source_pages", "total_pages", "row_count"):
        if key not in value:
            raise ExportPublishError("published receipt is incomplete")
    if not isinstance(value.get("summary"), dict):
        raise ExportPublishError("published receipt summary is invalid")
    if any(type(value[key]) is not int or value[key] < 0 for key in ("merged_pages", "source_pages", "total_pages", "row_count")):
        raise ExportPublishError("published receipt totals are invalid")
    pdf_files = [item for item in files if isinstance(item, dict) and item.get("kind") == "pdf"]
    inferred_merged_name = declared_merged_name
    if inferred_merged_name is None and any(item.get("name") == "全部匹配结果.pdf" for item in pdf_files):
        inferred_merged_name = "全部匹配结果.pdf"
    merged_files = [item for item in pdf_files if item.get("name") == inferred_merged_name] if inferred_merged_name else []
    if declared_merged_name is not None and len(merged_files) != 1:
        raise ExportPublishError("published receipt merged filename is missing")
    merged_pages = sum(item.get("page_count", 0) for item in merged_files)
    source_pages = sum(item.get("page_count", 0) for item in pdf_files if item not in merged_files)
    if merged_pages != value["merged_pages"] or source_pages != value["source_pages"]:
        raise ExportPublishError("published receipt page totals are invalid")
    return deepcopy(value)


def _allocate_names(parent: Path) -> tuple[Path, Path]:
    stamp = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S")
    for _ in range(64):
        short = uuid4().hex[:8]
        final = parent / f"PDF查找_{stamp}_{short}"
        temporary = parent / f".PDF查找_{stamp}_{short}_{uuid4().hex[:12]}"
        if not os.path.lexists(final) and not os.path.lexists(temporary):
            return final, temporary
    raise ExportPublishError("unable to allocate a unique export directory")


def _reserve_file(attempt: dict[str, Any], temporary: Path, name: str, kind: str, page_count: int | None = None) -> dict[str, object]:
    name = _safe_leaf(name)
    path = temporary / name
    if os.path.lexists(path):
        raise ExportPublishError("temporary output file already exists", [_residual(path, "output exists")])
    record: dict[str, object] = {"name": name, "kind": kind, "state": "reserved", "path": str(path)}
    if page_count is not None:
        record["page_count"] = page_count
    attempt.setdefault("files", []).append(record)
    return record


def _create_temp_directory(parent: Path, temporary: Path) -> dict[str, int | str]:
    try:
        temporary.mkdir(mode=0o700, parents=False, exist_ok=False)
        _path, identity = _directory_identity(temporary, label="temporary export directory")
        return identity
    except FileExistsError as error:
        raise ExportPublishError("temporary export directory already exists", [_residual(temporary, "output exists")]) from error
    except (OSError, RuntimeError, ValueError) as error:
        raise ExportPublishError("temporary export directory cannot be created") from error


def _write_xlsx(path: Path, plan: dict[str, Any], scope: dict[str, Any]) -> dict[str, object]:
    output = None
    before = None

    def capture_partial_identity() -> dict[str, object] | None:
        if output is None or output.closed or before is None:
            return None
        try:
            output.flush()
            current = os.fstat(output.fileno())
            if (int(current.st_dev), int(current.st_ino)) != (int(before.st_dev), int(before.st_ino)):
                return None
            output.seek(0)
            digest, total = _hash_open_file(output)
            after = os.fstat(output.fileno())
            if (
                (int(current.st_dev), int(current.st_ino)) != (int(after.st_dev), int(after.st_ino))
                or total != int(after.st_size)
            ):
                return None
            return _file_identity_from_stat(after, digest)
        except (OSError, ValueError):
            return None

    try:
        # Open the destination exactly once with CREATE_NEW semantics, then
        # give that same owned stream to the XLSX writer.  Passing ``path``
        # would let a writer that opens ``ZipFile(path, 'w')`` truncate a
        # foreign hardlink/file created after _reserve_file returned.
        output = path.open("x+b")
        before = os.fstat(output.fileno())
        result = exporter.export_bundle_index(
            output,
            plan.get("index_rows", []),
            plan.get("mappings", []),
            _scope_rows(scope),
        )
        if result is not None and result is not output:
            try:
                returned_path = Path(result)
            except (TypeError, ValueError):
                raise ExportPublishError("XLSX writer returned an unexpected stream") from None
            if returned_path != path:
                raise ExportPublishError("XLSX writer returned an unexpected path")
        output.flush()
        os.fsync(output.fileno())
        hashed = os.fstat(output.fileno())
        output.seek(0)
        digest, total = _hash_open_file(output)
        after = os.fstat(output.fileno())
        if (
            (int(hashed.st_dev), int(hashed.st_ino), int(hashed.st_size), int(hashed.st_mtime_ns))
            != (int(after.st_dev), int(after.st_ino), int(after.st_size), int(after.st_mtime_ns))
            or total != int(after.st_size)
        ):
            raise ExportPublishError("XLSX output changed while hashing")
        return _file_identity_from_stat(after, digest)
    except FileExistsError as error:
        raise ExportPublishError("temporary output file already exists", [_residual(path, "output exists")]) from error
    except ExportPublishError as error:
        partial = capture_partial_identity()
        if partial is not None:
            setattr(error, "owned_identity", partial)
        raise
    except (OSError, ValueError, TypeError, RuntimeError) as error:
        failure = ExportPublishError("XLSX export failed")
        partial = capture_partial_identity()
        if partial is not None:
            setattr(failure, "owned_identity", partial)
        raise failure from error
    finally:
        if output is not None:
            output.close()


def _write_json_exclusive(path: Path, payload: dict[str, object]) -> dict[str, object]:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    descriptor = -1
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if os.name == "nt":
            flags |= getattr(os, "O_BINARY", 0)
        descriptor = os.open(path, flags, 0o600)
        offset = 0
        while offset < len(raw):
            offset += os.write(descriptor, raw[offset:])
        os.fsync(descriptor)
        info = os.fstat(descriptor)
        return _file_identity_from_stat(info, hashlib.sha256(raw).hexdigest())
    except FileExistsError as error:
        raise ExportPublishError("temporary output file already exists", [_residual(path, "output exists")]) from error
    except (OSError, ValueError, TypeError) as error:
        raise ExportPublishError("manifest write failed") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _verify_attempt_files(attempt: dict[str, Any], directory: Path, *, full_hash: bool = True) -> list[dict[str, str]]:
    residuals: list[dict[str, str]] = []
    records = attempt.get("files")
    if not isinstance(records, list):
        return [_residual(directory, "publication file registry is invalid")]
    expected_names: set[str] = set()
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("name"), str):
            residuals.append(_residual(directory, "publication file registry is invalid"))
            continue
        name = record["name"]
        try:
            _safe_leaf(name)
        except ExportPublishError:
            residuals.append(_residual(directory / name, "invalid output filename"))
            continue
        expected_names.add(name)
        path = directory / name
        if record.get("state") != "created" or not isinstance(record.get("identity"), dict):
            if os.path.lexists(path):
                residuals.append(_residual(path, "reserved output has no captured identity"))
            else:
                residuals.append(_residual(path, "registered output is missing"))
            continue
        try:
            current = _file_identity(path) if full_hash else _stat_identity(path)
        except (OSError, ValueError):
            residuals.append(_residual(path, "output is missing or not an ordinary file"))
            continue
        expected = record["identity"]
        if full_hash:
            matches = _identity_equal(current, expected)
        else:
            matches = _stat_matches_identity_from_dict(current, expected)
        if not matches:
            residuals.append(_residual(path, "output identity or SHA changed"))
    try:
        actual_names = {item.name for item in directory.iterdir()}
    except (OSError, ValueError):
        return residuals + [_residual(directory, "temporary directory cannot be inspected")]
    for name in sorted(actual_names - expected_names):
        residuals.append(_residual(directory / name, "unregistered file must be preserved"))
    return _normalise_residuals(residuals)


def _stat_identity(path: Path) -> dict[str, object]:
    link = path.lstat()
    if stat.S_ISLNK(link.st_mode) or not stat.S_ISREG(link.st_mode) or _is_reparse(link):
        raise OSError("not an ordinary file")
    return {
        "st_dev": int(link.st_dev),
        "st_ino": int(link.st_ino),
        "size": int(link.st_size),
        "mtime_ns": int(link.st_mtime_ns),
    }


def _stat_matches_identity_from_dict(actual: dict[str, object], expected: object) -> bool:
    if not isinstance(expected, dict):
        return False
    return all(actual.get(key) == expected.get(key) for key in ("st_dev", "st_ino", "size", "mtime_ns"))


def _cleanup_attempt(attempt: dict[str, Any]) -> list[dict[str, str]]:
    temporary_raw = attempt.get("temporary_path")
    if not isinstance(temporary_raw, str):
        return [_residual("<unknown temporary directory>", "temporary path is unavailable")]
    temporary = Path(temporary_raw)
    expected_temp = attempt.get("temporary_identity")
    residuals: list[dict[str, str]] = []
    exists = os.path.lexists(temporary)
    if not exists:
        if expected_temp is not None:
            return [_residual(temporary, "temporary directory disappeared before cleanup")]
        return []
    if expected_temp is None:
        # A planned path was never recorded as ours.  An existing directory at
        # that path could have been created by another actor after the journal
        # save; without an identity we must leave it untouched.
        return [_residual(temporary, "temporary directory identity was never captured")]
    try:
        _path, current_temp = _directory_identity(temporary, label="temporary export directory")
    except ExportPublishError:
        return [_residual(temporary, "temporary directory identity is not trusted")]
    if expected_temp is not None and not _same_directory_inode(current_temp, expected_temp, require_path=False):
        return [_residual(temporary, "temporary directory identity changed")]

    records = attempt.get("files", [])
    expected_names: set[str] = set()
    if isinstance(records, list):
        for record in records:
            if not isinstance(record, dict) or not isinstance(record.get("name"), str):
                residuals.append(_residual(temporary, "publication file registry is invalid"))
                continue
            name = record["name"]
            try:
                _safe_leaf(name)
            except ExportPublishError:
                residuals.append(_residual(temporary / name, "invalid output filename"))
                continue
            expected_names.add(name)
            path = temporary / name
            if not os.path.lexists(path):
                continue
            identity = record.get("identity") if record.get("state") == "created" else None
            if not isinstance(identity, dict):
                residuals.append(_residual(path, "unregistered or reserved file must be preserved"))
                continue
            try:
                current = _file_identity(path)
            except (OSError, ValueError):
                residuals.append(_residual(path, "output identity cannot be verified"))
                continue
            if not _identity_equal(current, identity):
                residuals.append(_residual(path, "output identity or SHA changed; file preserved"))
                continue
            try:
                from . import engine as core

                outcome = core._unlink_owned_file(
                    path,
                    identity,
                    expected_parent=temporary if os.name == "nt" else None,
                )
                outcome_value = getattr(outcome, "value", outcome)
                if outcome is not True and str(outcome_value).lower() not in {"deleted", "_unlinkoutcome.deleted"}:
                    residuals.append(_residual(path, "owned file could not be deleted"))
            except (OSError, ValueError, RuntimeError):
                residuals.append(_residual(path, "owned file deletion failed"))
    else:
        residuals.append(_residual(temporary, "publication file registry is invalid"))

    try:
        remaining = list(temporary.iterdir())
    except OSError:
        residuals.append(_residual(temporary, "temporary directory cannot be inspected"))
        return _normalise_residuals(residuals)
    for child in remaining:
        if child.name not in expected_names or child.exists() or os.path.lexists(child):
            # All remaining entries are deliberately retained, including
            # files that were never registered or were externally replaced.
            if not any(item["path"] == str(child) for item in residuals):
                residuals.append(_residual(child, "unregistered or preserved residual"))
    if not residuals:
        parent_raw = attempt.get("parent_path")
        parent_identity = attempt.get("parent_identity")
        if not isinstance(parent_raw, str) or not isinstance(parent_identity, dict):
            residuals.append(_residual(temporary, "publication parent identity is unavailable"))
            return _normalise_residuals(residuals)
        try:
            # Remove the exact directory handle whose identity was checked;
            # a pathname rmdir here could delete a foreign directory swapped
            # into this name after the final child inspection.
            remove_directory_owned(temporary, expected_temp, parent_identity)
        except (ExportDirectoryError, OSError, ValueError, TypeError):
            residuals.append(_residual(temporary, "temporary directory is not empty or cannot be removed"))
    return _normalise_residuals(residuals)


def _rename_directory_no_replace(source: Path, destination: Path) -> None:
    """Rename one captured temporary directory without replacing a target."""

    expectations = _rename_expectations.get()
    try:
        if expectations is None:
            # Keep this private compatibility wrapper callable by focused
            # tests and old callers.  The publication path always supplies
            # journal-captured identities through the ContextVar below.
            _source_path, source_identity = _directory_identity(source, label="temporary export directory")
            _parent_path, parent_identity = _directory_identity(source.parent, label="publication parent")
        else:
            source_identity, parent_identity = expectations
        _rename_directory_handle(source, destination, source_identity, parent_identity)
    except FileExistsError as error:
        raise ExportPublishError(
            "final export directory already exists",
            [_residual(destination, "output exists")],
        ) from error
    except ExportPublishError:
        raise
    except ExportDirectoryError as error:
        raise ExportPublishError(str(error)) from error
    except (OSError, ValueError, TypeError, UnicodeError) as error:
        raise ExportPublishError("atomic no-replace directory rename failed") from error


def _final_attempt_paths(attempt: dict[str, Any]) -> tuple[Path, Path]:
    final_raw = attempt.get("final_path")
    temporary_raw = attempt.get("temporary_path")
    if not isinstance(final_raw, str) or not isinstance(temporary_raw, str):
        raise ExportPublishError("publication attempt paths are invalid")
    return Path(final_raw), Path(temporary_raw)


def _verify_temporary_directory(attempt: dict[str, Any], temporary: Path) -> list[dict[str, str]]:
    """Verify the directory entry itself before inspecting any child path."""

    expected = attempt.get("temporary_identity")
    if not isinstance(expected, dict):
        return [_residual(temporary, "temporary directory identity is unavailable")]
    try:
        _path, actual = _directory_identity(temporary, label="temporary export directory")
    except ExportPublishError:
        return [_residual(temporary, "temporary directory identity is invalid")]
    if not _same_directory_inode(actual, expected, require_path=False):
        return [_residual(temporary, "temporary directory identity changed")]
    return []


def _verify_final_attempt(entry: dict[str, Any], attempt: dict[str, Any]) -> tuple[Path, dict[str, object], dict[str, object]]:
    final, temporary = _final_attempt_paths(attempt)
    parent_raw = attempt.get("parent_path")
    if not isinstance(parent_raw, str):
        raise ExportPublishError("publication parent identity is unavailable", [_residual(final, "parent path is invalid")])
    parent = Path(parent_raw)
    if final.parent != parent or temporary.parent != parent:
        raise ExportPublishError("published directory escaped its selected parent", [_residual(final, "final directory parent mismatch")])
    if attempt.get("final_name") not in (None, final.name) or attempt.get("temporary_name") not in (None, temporary.name):
        raise ExportPublishError("published directory names do not match the recorded attempt", [_residual(final, "directory name mismatch")])
    if not os.path.lexists(final):
        raise FileNotFoundError(final)
    try:
        _path, final_identity = _directory_identity(final, label="final export directory")
    except ExportPublishError:
        raise ExportPublishError("final export directory cannot be trusted", [_residual(final, "final directory identity is invalid")])
    expected_temp = attempt.get("temporary_identity")
    if not _same_directory_inode(final_identity, expected_temp, require_path=False):
        raise ExportPublishError("final export directory does not match the recorded temporary directory", [_residual(final, "foreign final directory preserved")])
    residuals = _verify_attempt_files(attempt, final)
    if residuals:
        raise ExportPublishError("final export directory contents do not match the recorded attempt", residuals)
    manifest_path = final / "导出清单.json"
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ExportPublishError("final export manifest cannot be read", [_residual(manifest_path, "manifest is invalid")]) from None
    # The first complete verification precedes this read.  Recheck the
    # manifest identity afterwards so a concurrent replacement cannot turn a
    # valid first hash into a different payload that is accepted for recovery.
    manifest_record = next(
        (
            item
            for item in attempt.get("files", [])
            if isinstance(item, dict) and item.get("name") == "导出清单.json" and item.get("kind") == "json"
        ),
        None,
    )
    try:
        manifest_identity = _file_identity(manifest_path)
    except (OSError, ValueError):
        raise ExportPublishError("final export manifest cannot be read", [_residual(manifest_path, "manifest identity changed")]) from None
    if not isinstance(manifest_record, dict) or not _identity_equal(manifest_identity, manifest_record.get("identity")):
        raise ExportPublishError("final export manifest identity changed", [_residual(manifest_path, "manifest identity changed")])
    expected_manifest = _build_manifest(entry, attempt)
    if payload != expected_manifest or payload.get("intent_id") != entry.get("intent_id"):
        raise ExportPublishError("final export manifest does not match the intent", [_residual(manifest_path, "manifest intent mismatch")])
    expected_receipt = attempt.get("expected_receipt")
    if not isinstance(expected_receipt, dict):
        raise ExportPublishError("publication receipt is unavailable", [_residual(final, "expected receipt is missing")])
    receipt = deepcopy(expected_receipt)
    if receipt.get("directory") != str(final) or receipt.get("intent_id") != entry.get("intent_id"):
        raise ExportPublishError("publication receipt does not match the final directory", [_residual(final, "receipt mismatch")])
    # The source path is intentionally unused after the rename.  Keeping this
    # variable in the return tuple makes the caller's recovery branch explicit.
    _ = temporary
    return final, final_identity, receipt


def _recover_published_locked(record: Any, entry: dict[str, Any]) -> dict[str, object] | None:
    """Promote a publishing record when its rename completed before a crash."""

    attempt = entry.get("attempt")
    if not isinstance(attempt, dict):
        return None
    final_raw = attempt.get("final_path")
    if not isinstance(final_raw, str):
        return None
    final = Path(final_raw)
    if not os.path.lexists(final):
        return None
    final_path, final_identity, receipt = _verify_final_attempt(entry, attempt)
    attempt["final_identity"] = final_identity
    if isinstance(attempt.get("temporary_identity"), dict):
        # The object moved atomically; retain its original device/inode while
        # updating the resolved path to the now-published directory.
        attempt["temporary_identity"] = deepcopy(final_identity)
    attempt["state"] = "renamed"
    entry["state"] = "published"
    entry["receipt"] = receipt
    record.save(entry)
    return deepcopy(receipt)


def _reset_after_clean_attempt(record: Any, entry: dict[str, Any]) -> None:
    entry["state"] = "rendered"
    entry["attempt"] = None
    entry.pop("residuals", None)
    record.save(entry)


def _append_residual_attempt(entry: dict[str, Any], attempt: dict[str, Any], residuals: list[dict[str, str]]) -> None:
    history = entry.get("residual_attempts")
    if history is None:
        history = []
        entry["residual_attempts"] = history
    if not isinstance(history, list):
        raise ExportPublishError("publication attempt history is invalid", residuals)
    if len(history) >= MAX_RESIDUAL_ATTEMPTS:
        raise ExportPublishError("publication residual attempt limit reached", residuals, "export_capacity_exceeded")
    history.append({
        "attempt_id": attempt.get("attempt_id"),
        "temporary_path": attempt.get("temporary_path"),
        "final_path": attempt.get("final_path"),
        "residuals": deepcopy(residuals),
    })


def _recover_before_rename(record: Any, entry: dict[str, Any]) -> None:
    """Clean a proven pre-rename attempt so a later call may retry."""

    attempt = entry.get("attempt")
    if not isinstance(attempt, dict):
        _reset_after_clean_attempt(record, entry)
        return
    final_raw = attempt.get("final_path")
    if isinstance(final_raw, str) and os.path.lexists(final_raw):
        # A foreign/rewritten final directory was deliberately kept by the
        # recovery check.  Do not remove anything from either location.
        raise ExportPublishError("final export directory cannot be proven to belong to this attempt", [_residual(final_raw, "foreign final directory preserved")])
    residuals = _cleanup_attempt(attempt)
    if residuals:
        if not attempt.get("history_recorded"):
            attempt["residuals"] = residuals
            record.save(entry)
        raise ExportPublishError("previous publication attempt has residuals", residuals)
    previous_residuals = _normalise_residuals(attempt.get("residuals", []))
    if previous_residuals and not attempt.get("history_recorded"):
        # Preserve the completed cleanup attempt before replacing its live
        # slot.  This bounded history is the audit trail for a residual that
        # was later resolved by an explicit retry.
        _append_residual_attempt(entry, attempt, previous_residuals)
        attempt["history_recorded"] = True
    _reset_after_clean_attempt(record, entry)


def _start_attempt(record: Any, entry: dict[str, Any], parent: Path, parent_identity: dict[str, int | str]) -> dict[str, Any]:
    final, temporary = _allocate_names(parent)
    attempt: dict[str, Any] = {
        "version": 1,
        "attempt_id": str(uuid4()),
        "parent_path": str(parent),
        "parent_identity": deepcopy(parent_identity),
        "final_path": str(final),
        "final_name": final.name,
        "temporary_path": str(temporary),
        "temporary_name": temporary.name,
        "temporary_identity": None,
        "final_identity": None,
        "state": "planned",
        "files": [],
        "expected_receipt": None,
        "residuals": [],
    }
    entry["state"] = "publishing"
    entry["attempt"] = attempt
    record.save(entry)  # planned path is durable before mkdir
    try:
        # Anchor the selected parent while creating the first private child;
        # a pre/post pathname identity check alone would allow a junction to
        # be installed between the journal save and mkdir.
        with writable_directory(parent, parent_identity):
            temporary_identity = _create_temp_directory(parent, temporary)
        attempt["temporary_identity"] = temporary_identity
        attempt["state"] = "building"
        record.save(entry)
    except ExportDirectoryError as error:
        raise ExportPublishError(
            str(error),
            [_residual(parent, "parent directory cannot be safely protected")],
        ) from error
    except BaseException:
        # Preserve the planned journal entry.  A later invocation can prove
        # whether the temporary directory exists before attempting cleanup.
        raise
    return attempt


def _build_attempt_outputs(record: Any, entry: dict[str, Any], attempt: dict[str, Any]) -> None:
    plan = entry.get("plan")
    descriptors = entry.get("files")
    scope = entry.get("scope")
    if not isinstance(plan, dict) or not isinstance(scope, dict) or not isinstance(descriptors, list):
        raise ExportPublishError("frozen export intent is unavailable")
    temporary = Path(str(attempt["temporary_path"]))
    planned_files = plan.get("files")
    if not isinstance(planned_files, list) or len(planned_files) != len(descriptors):
        raise ExportPublishError("frozen output file set is invalid")

    for descriptor, planned in zip(descriptors, planned_files, strict=True):
        if not isinstance(descriptor, dict) or not isinstance(planned, dict):
            raise ExportPublishError("frozen output file set is invalid")
        page_count = planned.get("page_count")
        if type(page_count) is not int or page_count < 1:
            raise ExportPublishError("frozen output page count is invalid")
        output = _reserve_file(attempt, temporary, planned.get("name"), "pdf", page_count)
        record.save(entry)
        try:
            token = descriptor.get("preview_token")
            preview_raw = descriptor.get("preview_path")
            if not isinstance(token, str) or not isinstance(preview_raw, str):
                raise ExportPublishError("PDF preview descriptor is invalid")
            preview_path = Path(preview_raw)
            expected = _owned_preview_identity(token, preview_path)
            if (
                descriptor.get("sha256") != expected.get("sha256")
                or descriptor.get("size_bytes") != expected.get("size")
                or (
                    descriptor.get("identity") is not None
                    and not _identity_equal(descriptor.get("identity"), expected)
                )
            ):
                raise ExportPublishError("PDF preview descriptor identity changed")
            identity = _copy_owned_preview(token, preview_path, Path(str(output["path"])), expected)
        except ExportPublishError:
            raise
        except (OSError, ValueError, RuntimeError) as error:
            raise ExportPublishError("PDF preview copy failed") from error
        output["state"] = "created"
        output["identity"] = identity
        record.save(entry)

    if bool(scope.get("include_xlsx")):
        output = _reserve_file(attempt, temporary, "匹配索引.xlsx", "xlsx")
        record.save(entry)
        try:
            identity = _write_xlsx(Path(str(output["path"])), plan, scope)
        except ExportPublishError as error:
            # A writer can fail after CREATE_NEW has produced a partial ZIP.
            # Record the identity captured from that same exclusive handle so
            # cleanup may remove only our partial file; a pathname replacement
            # will fail the identity check and remain visible as residual.
            partial = getattr(error, "owned_identity", None)
            if isinstance(partial, dict):
                output["state"] = "created"
                output["identity"] = partial
                record.save(entry)
            raise
        output["state"] = "created"
        output["identity"] = identity
        record.save(entry)

    manifest_output = _reserve_file(attempt, temporary, "导出清单.json", "json")
    record.save(entry)
    identity = _write_json_exclusive(Path(str(manifest_output["path"])), _build_manifest(entry, attempt))
    manifest_output["state"] = "created"
    manifest_output["identity"] = identity
    record.save(entry)

    attempt["expected_receipt"] = _receipt(entry, attempt, Path(str(attempt["final_path"])))
    attempt["state"] = "ready"
    record.save(entry)  # complete attempt + receipt precede rename


def _finalise_attempt(service: "ExportBundleService", record: Any, entry: dict[str, Any], attempt: dict[str, Any]) -> dict[str, object]:
    final, temporary = _final_attempt_paths(attempt)
    parent_raw = attempt.get("parent_path")
    parent_identity = attempt.get("parent_identity")
    if not isinstance(parent_raw, str) or not isinstance(parent_identity, dict):
        raise ExportPublishError("publication parent identity is unavailable")
    parent = Path(parent_raw)
    if temporary.parent != parent or final.parent != parent:
        raise ExportPublishError("publication paths escaped their parent")

    renamed = False
    try:
        residuals = _verify_temporary_directory(attempt, temporary)
        if not residuals:
            residuals = _verify_attempt_files(attempt, temporary)
        if residuals:
            raise ExportPublishError("temporary export contents do not match the recorded attempt", residuals)
        with BatchStore(service.batch_database) as store:
            with hold_export_scope(
                store,
                service.review_database,
                _scope_request(entry["scope"]),
                expected_snapshot=entry["scope"],
            ):
                with _locked_parent(parent, parent_identity):
                    if os.path.lexists(final):
                        raise ExportPublishError("final export directory already exists", [_residual(final, "output exists")])
                    # A lightweight identity check is enough inside the short
                    # lock; the full copy/hash work was completed above.
                    inside_residuals = _verify_temporary_directory(attempt, temporary)
                    if not inside_residuals:
                        inside_residuals = _verify_attempt_files(attempt, temporary, full_hash=False)
                    if inside_residuals:
                        raise ExportPublishError("temporary export contents changed before rename", inside_residuals)
                    rename_token = _rename_expectations.set((attempt.get("temporary_identity"), parent_identity))
                    try:
                        _rename_directory_no_replace(temporary, final)
                    finally:
                        _rename_expectations.reset(rename_token)
                    renamed = True
        # Verify the renamed directory before recording published.  A crash at
        # any point before record.save leaves a recoverable publishing entry.
        _final_path, final_identity, receipt = _verify_final_attempt(entry, attempt)
        attempt["final_identity"] = final_identity
        if isinstance(attempt.get("temporary_identity"), dict):
            attempt["temporary_identity"] = deepcopy(final_identity)
        attempt["state"] = "renamed"
        entry["state"] = "published"
        entry["receipt"] = receipt
        record.save(entry)
        return deepcopy(receipt)
    except Exception as error:
        if renamed:
            # The directory is now outside cleanup authority.  Keep the
            # publishing record and let status/retry prove its final identity.
            raise
        cleanup_residuals = _cleanup_attempt(attempt)
        if cleanup_residuals:
            existing = error.residuals if isinstance(error, ExportPublishError) else []
            residuals = _normalise_residuals(existing + cleanup_residuals)
            attempt["residuals"] = residuals
            record.save(entry)
            raise ExportPublishError("export publication failed before rename", residuals) from error
        _reset_after_clean_attempt(record, entry)
        raise
    except BaseException:
        # Crash simulation and process termination must leave the attempt
        # journal untouched for the next invocation to inspect.
        raise


def _publish_locked(service: "ExportBundleService", record: Any, entry: dict[str, Any], directory: object) -> dict[str, object]:
    if not isinstance(entry, dict):
        raise ExportScopeError("export intent journal is invalid")
    state = entry.get("state")
    if state == "published":
        return _validated_receipt(entry)
    if state == "publishing":
        recovered = _recover_published_locked(record, entry)
        if recovered is not None:
            return recovered
        _recover_before_rename(record, entry)
        state = entry.get("state")
    if state != "rendered":
        raise ExportScopeError("only a rendered export intent can be published")

    # A recovery/close coordinator may leave a rendered descriptor carrying a
    # prior attempt.  Resolve that durable attempt before allocating a new
    # slot so its residual paths cannot be silently overwritten.
    if isinstance(entry.get("attempt"), dict):
        _recover_before_rename(record, entry)

    service._validate_entry(entry)
    parent, parent_identity = _directory_identity(directory)
    attempt = _start_attempt(record, entry, parent, parent_identity)
    try:
        temporary = Path(str(attempt["temporary_path"]))
        temporary_identity = attempt.get("temporary_identity")
        if not isinstance(temporary_identity, dict):
            raise ExportPublishError("temporary export directory identity is unavailable")
        # Keep both pathname components anchored while the expensive file
        # copies and XLSX writer run.  The temporary-directory handle is
        # released before the final rename (a delete-sharing directory handle
        # would itself prevent that rename); the final boundary rechecks its
        # captured identity immediately before moving it.
        with writable_directory(parent, parent_identity):
            with writable_directory(temporary, temporary_identity):
                _build_attempt_outputs(record, entry, attempt)
    except Exception as error:
        residuals = _cleanup_attempt(attempt)
        if residuals:
            attempt["residuals"] = residuals
            record.save(entry)
            existing = error.residuals if isinstance(error, ExportPublishError) else []
            raise ExportPublishError("export publication failed before rename", _normalise_residuals(existing + residuals)) from error
        _reset_after_clean_attempt(record, entry)
        raise
    except BaseException:
        # Leave the durable attempt unchanged for crash recovery.
        raise
    return _finalise_attempt(service, record, entry, attempt)


def publish_bundle(service: "ExportBundleService", intent_id: str, directory: str | Path) -> dict[str, object]:
    """Publish one rendered intent or recover its already-renamed result."""

    token = _valid_uuid(intent_id)
    try:
        with service.journal.locked(token) as record:
            return _publish_locked(service, record, record.data, directory)
    except ExportScopeError:
        raise
    except (FileNotFoundError, KeyError, OSError, RuntimeError, ValueError, TypeError) as error:
        raise ExportScopeError("export intent journal is unavailable") from error


def _metadata_created_at(row: object) -> str:
    if isinstance(row, dict) and isinstance(row.get("created_at"), str):
        return row["created_at"]
    return ""


def _status_residuals(entry: dict[str, Any]) -> list[dict[str, str]]:
    attempt = entry.get("attempt")
    if isinstance(attempt, dict):
        stored = _normalise_residuals(attempt.get("residuals", []))
        if stored:
            return stored
        final = attempt.get("final_path")
        temporary = attempt.get("temporary_path")
        if isinstance(final, str) and os.path.lexists(final):
            return [_residual(final, "final directory needs publication recovery")]
        if isinstance(temporary, str):
            return [_residual(temporary, "publication attempt is pending recovery")]
    return []


def _existing_residuals(items: object) -> list[dict[str, str]]:
    """Keep only residual paths that still occupy a filesystem entry."""

    result: list[dict[str, str]] = []
    for item in _normalise_residuals(items):
        try:
            present = os.path.lexists(item["path"])
        except (OSError, ValueError, TypeError):
            present = False
        if present:
            result.append(item)
    return result


def _journal_record_path(service: "ExportBundleService", intent_id: str) -> Path:
    """Return an absolute journal path for status errors without leaking a token."""

    try:
        root = getattr(service.journal, "root")
        root_path = Path(root)
        if not root_path.is_absolute():
            root_path = root_path.resolve()
        filename = f"{Path(intent_id).name}.json"
        return root_path / filename
    except (AttributeError, OSError, RuntimeError, TypeError, ValueError):
        return Path(os.path.abspath(f"{Path(intent_id).name}.json"))


def _historical_residuals(entry: dict[str, Any]) -> list[dict[str, str]]:
    """Report unresolved paths from attempts retained after a retry/close."""

    result: list[dict[str, str]] = []
    # ``residual_attempts`` is the current schema.  Accept the descriptive
    # ``previous_attempts`` spelling as well so a compacted journal from an
    # earlier worker cannot hide a still-present user-directory residual.
    for key in ("residual_attempts", "previous_attempts"):
        history = entry.get(key)
        if not isinstance(history, list):
            continue
        for item in history:
            if not isinstance(item, dict):
                continue
            direct = item if isinstance(item.get("path"), str) and isinstance(item.get("reason"), str) else None
            result.extend(_existing_residuals([direct] if direct is not None else item.get("residuals", [])))
            # Older records may have retained only the attempt paths.  Infer
            # a residual only when the path still exists; resolved old paths
            # must not keep surfacing forever in status responses.
            if not item.get("residuals"):
                for field in ("final_path", "temporary_path"):
                    value = item.get(field)
                    if isinstance(value, str):
                        result.extend(_existing_residuals([_residual(value, "previous publication attempt residual")]))
    return _normalise_residuals(result)


def status_bundle(service: "ExportBundleService", job_id: str) -> dict[str, object]:
    """Return the latest publication or residual attempt for a job."""

    if not isinstance(job_id, str) or not job_id.strip():
        raise ExportScopeError("published task identifier is required")
    try:
        metadata = service.journal.list_metadata()
    except (OSError, RuntimeError, ValueError, TypeError) as error:
        raise ExportScopeError("export intent journal is unavailable") from error
    candidates = [row for row in metadata if isinstance(row, dict) and row.get("job_id") == job_id]
    candidates.sort(key=_metadata_created_at, reverse=True)
    publication: dict[str, object] | None = None
    residuals: list[dict[str, str]] = []
    for candidate in candidates:
        intent = candidate.get("intent_id")
        if not isinstance(intent, str):
            continue
        entry_for_status: dict[str, Any] | None = None
        try:
            token = _valid_uuid(intent)
            with service.journal.locked(token) as record:
                entry = record.data
                if not isinstance(entry, dict) or entry.get("job_id") != job_id:
                    continue
                entry_for_status = entry
                state = entry.get("state")
                if state == "published":
                    if publication is None:
                        publication = _validated_receipt(entry)
                elif state == "publishing":
                    recovered = _recover_published_locked(record, entry)
                    if recovered is not None:
                        if publication is None:
                            publication = recovered
                    else:
                        residuals.extend(_status_residuals(entry))
                else:
                    residuals.extend(_existing_residuals(_status_residuals(entry)))
                # A newer successful publication does not erase unresolved
                # paths left by an older retry of the same job.
                residuals.extend(_historical_residuals(entry))
        except ExportPublishError as error:
            residuals.extend(error.residuals or [_residual(_journal_record_path(service, intent), "publication recovery failed")])
            if entry_for_status is not None:
                residuals.extend(_status_residuals(entry_for_status))
                residuals.extend(_historical_residuals(entry_for_status))
        except (ExportScopeError, FileNotFoundError, OSError, RuntimeError, ValueError, TypeError, KeyError):
            residuals.append(_residual(_journal_record_path(service, intent), "publication recovery is unavailable"))
            if entry_for_status is not None:
                residuals.extend(_status_residuals(entry_for_status))
                residuals.extend(_historical_residuals(entry_for_status))
    return {"job_id": job_id, "publication": publication, "residuals": _normalise_residuals(residuals)}
