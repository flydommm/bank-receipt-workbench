"""Bounded, private persistence for frozen export intents.

The journal is intentionally a small file store rather than a general path
registry.  A native host supplies one already-created ``export-intents``
directory; this module only creates one fixed lock file and immutable JSON
anchor/generation files per intent.  Every operation is protected by the
operating-system lock and every path used for a journal is checked against the
directory/file identity that was observed by the operation.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from typing import Any, Iterator
from uuid import UUID


# These are module constants on purpose.  Tests and the native host can use a
# smaller limit in an isolated process without creating artificial 128 MiB
# fixtures.  Every ``*.json`` entry, including retained generations, counts
# towards the directory limits.  Crash-left private ``*.tmp`` files also
# consume the total byte budget; the fixed lock does not.
MAX_JOURNALS = 256
MAX_JOURNAL_BYTES = 128 * 1024 * 1024
MAX_TOTAL_JOURNAL_BYTES = 512 * 1024 * 1024
MAX_GENERATION = 1_000_000

JOURNAL_SCHEMA = 1
JOURNAL_LOCK_NAME = ".journal.lock"
JOURNAL_DIRECTORY_NAME = "export-intents"
_JOURNAL_STATES = frozenset({"created", "rendered", "publishing", "published", "closed"})
_UUID_JSON_SUFFIX = ".json"
_TEMP_SUFFIX = ".tmp"
_READ_CHUNK_BYTES = 1024 * 1024
_GENERATION_RE = re.compile(
    r"^(?P<intent>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"\.(?P<version>[1-9][0-9]{0,6})\.json$"
)


class ExportJournalError(RuntimeError):
    """Base class for stable journal failures."""


class ExportJournalValidationError(ExportJournalError, ValueError):
    """The supplied root, intent, or JSON record is invalid."""


class ExportJournalQuotaError(ExportJournalValidationError):
    """A journal operation would exceed a configured storage limit."""


class ExportJournalBusyError(ExportJournalError):
    """Another process currently owns the fixed journal lock."""


class ExportJournalExistsError(ExportJournalError, FileExistsError):
    """A create operation would overwrite an existing journal entry."""


class ExportJournalIntegrityError(ExportJournalError):
    """A root or journal file changed identity or is not a private file."""


class ExportJournalConflictError(ExportJournalError):
    """A journal changed after it was loaded by a ``JournalRecord``."""


# Friendly short aliases make callers less coupled to the implementation's
# exception naming while retaining one concrete type for each failure class.
JournalError = ExportJournalError
JournalBusyError = ExportJournalBusyError
JournalIntegrityError = ExportJournalIntegrityError
JournalConflictError = ExportJournalConflictError


@dataclass(frozen=True)
class _RootIdentity:
    device: int
    inode: int
    resolved_path: str


@dataclass(frozen=True)
class _FileIdentity:
    device: int
    inode: int
    size: int
    mtime_ns: int
    ctime_ns: int
    sha256: str

    @classmethod
    def from_stat(cls, info: os.stat_result, sha256: str) -> _FileIdentity:
        return cls(
            device=int(info.st_dev),
            inode=int(info.st_ino),
            size=int(info.st_size),
            mtime_ns=int(info.st_mtime_ns),
            ctime_ns=int(info.st_ctime_ns),
            sha256=sha256,
        )

    @classmethod
    def object_from_stat(cls, info: os.stat_result) -> tuple[int, int]:
        return int(info.st_dev), int(info.st_ino)

    def same_object(self, info: os.stat_result) -> bool:
        return self.object_from_stat(info) == (self.device, self.inode)

    def same_content_identity(self, info: os.stat_result) -> bool:
        return (
            self.same_object(info)
            and int(info.st_size) == self.size
            and int(info.st_mtime_ns) == self.mtime_ns
        )


def _same_file_identity(left: _FileIdentity, right: _FileIdentity) -> bool:
    """Compare identity fields stable across Windows path/handle stats."""

    return (
        left.device == right.device
        and left.inode == right.inode
        and left.size == right.size
        and left.mtime_ns == right.mtime_ns
        and left.sha256 == right.sha256
    )


def _error(message: str) -> ExportJournalError:
    """Build a path-free stable error without exposing OS detail."""

    return ExportJournalError(message)


def _validation_error(message: str) -> ExportJournalValidationError:
    return ExportJournalValidationError(message)


def _quota_error() -> ExportJournalQuotaError:
    return ExportJournalQuotaError("export journal quota exceeded")


def _integrity_error() -> ExportJournalIntegrityError:
    return ExportJournalIntegrityError("export journal identity is invalid")


def _conflict_error() -> ExportJournalConflictError:
    return ExportJournalConflictError("export journal record changed")


def _exists_error() -> ExportJournalExistsError:
    return ExportJournalExistsError("export journal record already exists")


def _reparse_point(info: os.stat_result) -> bool:
    attribute = int(getattr(info, "st_file_attributes", 0))
    return bool(attribute & 0x0400)  # FILE_ATTRIBUTE_REPARSE_POINT


def _stable_path(path: Path) -> str:
    """Return a comparison-safe resolved path without exposing it in errors."""

    try:
        value = os.fspath(path.resolve(strict=True))
    except (OSError, RuntimeError, ValueError):
        raise _integrity_error() from None
    if os.name == "nt":
        if value.startswith("\\\\?\\UNC\\"):
            value = "\\\\" + value[8:]
        elif value.startswith("\\\\?\\"):
            value = value[4:]
    return os.path.normcase(os.path.normpath(value))


def _ordinary_directory_info(path: Path) -> os.stat_result:
    try:
        info = path.lstat()
    except (OSError, ValueError):
        raise _integrity_error() from None
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or _reparse_point(info)
    ):
        raise _integrity_error()
    return info


def _capture_root_identity(root: Path) -> _RootIdentity:
    if not root.is_absolute() or root.name != JOURNAL_DIRECTORY_NAME:
        raise _validation_error("export journal root is invalid")
    try:
        info = _ordinary_directory_info(root)
    except ExportJournalIntegrityError:
        raise _validation_error("export journal root is invalid") from None
    try:
        resolved = _stable_path(root)
    except ExportJournalIntegrityError:
        raise _validation_error("export journal root is invalid") from None
    return _RootIdentity(int(info.st_dev), int(info.st_ino), resolved)


def _assert_root_identity(root: Path, expected: _RootIdentity) -> None:
    info = _ordinary_directory_info(root)
    if (int(info.st_dev), int(info.st_ino)) != (expected.device, expected.inode):
        raise _integrity_error()
    if _stable_path(root) != expected.resolved_path:
        raise _integrity_error()


def _ordinary_file_info(path: Path) -> os.stat_result:
    try:
        info = path.lstat()
    except (OSError, ValueError):
        raise _integrity_error() from None
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or _reparse_point(info)
    ):
        raise _integrity_error()
    return info


def _limits() -> tuple[int, int, int]:
    values = (MAX_JOURNALS, MAX_JOURNAL_BYTES, MAX_TOTAL_JOURNAL_BYTES)
    if any(type(value) is not int or value < 1 for value in values):
        raise _validation_error("export journal limits are invalid")
    return values


def _generation_limit() -> int:
    if type(MAX_GENERATION) is not int or MAX_GENERATION < 1:
        raise _validation_error("export journal generation limit is invalid")
    return MAX_GENERATION


def _canonical_json(value: object) -> bytes:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8", "strict")
    except (TypeError, ValueError, UnicodeError, OverflowError, RecursionError):
        raise _validation_error("export journal JSON is invalid") from None
    return encoded


def _canonical_clone(value: object) -> tuple[dict[str, Any], bytes]:
    encoded = _canonical_json(value)
    try:
        clone = json.loads(encoded.decode("utf-8"))
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise _validation_error("export journal JSON is invalid") from None
    if not isinstance(clone, dict):
        raise _validation_error("export journal record is invalid")
    return clone, encoded


def _validate_intent_id(value: object) -> str:
    if not isinstance(value, str):
        raise _validation_error("export journal intent id is invalid")
    try:
        canonical = str(UUID(value))
    except (ValueError, AttributeError):
        raise _validation_error("export journal intent id is invalid") from None
    if canonical != value:
        raise _validation_error("export journal intent id is invalid")
    return value


def _validate_text_identifier(value: object, message: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _validation_error(message)
    try:
        size = len(value.encode("utf-8", "strict"))
    except UnicodeError:
        raise _validation_error(message) from None
    if size > 1024:
        raise _validation_error(message)
    return value


def _prepare_data(value: object) -> tuple[dict[str, Any], bytes]:
    if not isinstance(value, dict):
        raise _validation_error("export journal record is invalid")

    # Check required fields before encoding so malformed Python values never
    # get silently coerced into a different record.
    if type(value.get("schema")) is not int or value.get("schema") != JOURNAL_SCHEMA:
        raise _validation_error("export journal schema is unsupported")
    intent_id = _validate_intent_id(value.get("intent_id"))
    _validate_text_identifier(value.get("job_id"), "export journal job id is invalid")
    created_at = value.get("created_at")
    if not isinstance(created_at, str) or not created_at.strip():
        raise _validation_error("export journal created time is invalid")
    state = value.get("state")
    if not isinstance(state, str) or state not in _JOURNAL_STATES:
        raise _validation_error("export journal state is invalid")

    clone, encoded = _canonical_clone(value)
    # JSON key conversion can only matter for a Python dict with non-string
    # keys.  Such a payload would not retain its required fields after JSON
    # round-tripping, so reject it rather than persisting an altered intent.
    if any(not isinstance(key, str) for key in value):
        raise _validation_error("export journal record is invalid")
    if clone.get("intent_id") != intent_id:
        raise _validation_error("export journal record is invalid")
    return clone, encoded


def _validate_loaded(value: object, intent_id: str) -> tuple[dict[str, Any], bytes]:
    clone, encoded = _prepare_data(value)
    if clone.get("intent_id") != intent_id:
        raise _integrity_error()
    return clone, encoded


def _same_stat(left: os.stat_result, right: os.stat_result) -> bool:
    # Windows reports a slightly different ctime for an lstat pathname and a
    # descriptor opened immediately afterwards.  Device/inode, size and
    # mtime are stable across that boundary; the persisted identity also
    # includes the complete SHA-256 bytes, so ctime is neither needed nor a
    # useful race detector here.
    return (
        int(left.st_dev) == int(right.st_dev)
        and int(left.st_ino) == int(right.st_ino)
        and int(left.st_size) == int(right.st_size)
        and int(left.st_mtime_ns) == int(right.st_mtime_ns)
    )


def _open_regular_for_read(path: Path, expected: os.stat_result) -> int:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except (OSError, ValueError):
        raise _integrity_error() from None
    try:
        actual = os.fstat(descriptor)
        if not _same_stat(expected, actual):
            raise _integrity_error()
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
    return descriptor


def _read_regular_bytes(
    path: Path,
    expected: os.stat_result | None = None,
) -> tuple[bytes, _FileIdentity]:
    """Read one bounded regular file while its descriptor is authoritative."""

    initial = _ordinary_file_info(path)
    if expected is not None and not _same_stat(expected, initial):
        raise _conflict_error()
    _, maximum, _ = _limits()
    descriptor = _open_regular_for_read(path, initial)
    raw = bytearray()
    try:
        opened = os.fstat(descriptor)
        if int(opened.st_size) > maximum:
            raise _quota_error()
        while len(raw) <= maximum:
            remaining = maximum + 1 - len(raw)
            chunk = os.read(descriptor, min(_READ_CHUNK_BYTES, remaining))
            if not chunk:
                break
            raw.extend(chunk)
            if len(raw) > maximum:
                raise _quota_error()
        finished = os.fstat(descriptor)
        if not _same_stat(opened, finished) or len(raw) != int(finished.st_size):
            raise _conflict_error()
    except ExportJournalError:
        raise
    except (OSError, ValueError):
        raise _error("export journal read failed") from None
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass

    try:
        final = path.lstat()
    except (OSError, ValueError):
        raise _conflict_error() from None
    if not _same_stat(finished, final):
        raise _conflict_error()
    digest = hashlib.sha256(raw).hexdigest()
    return bytes(raw), _FileIdentity.from_stat(final, digest)


def _read_journal_file(
    path: Path,
    intent_id: str,
    expected: os.stat_result | None = None,
) -> tuple[dict[str, Any], _FileIdentity]:
    """Read and validate one plain anchor JSON file."""

    raw, identity = _read_regular_bytes(path, expected)
    try:
        decoded = json.loads(bytes(raw).decode("utf-8", "strict"))
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise _validation_error("export journal JSON is invalid") from None
    clone, _ = _validate_loaded(decoded, intent_id)
    return clone, identity


def _generation_encoded(version: int, data: dict[str, Any]) -> bytes:
    if type(version) is not int or version < 1 or version > _generation_limit():
        raise _validation_error("export journal generation is invalid")
    return _canonical_json({"version": version, "data": data})


def _read_generation_file(
    path: Path,
    intent_id: str,
    version: int,
    expected: os.stat_result | None = None,
) -> tuple[dict[str, Any], _FileIdentity]:
    raw, identity = _read_regular_bytes(path, expected)
    try:
        decoded = json.loads(raw.decode("utf-8", "strict"))
    except (TypeError, ValueError, UnicodeError, RecursionError):
        # A corrupt highest generation must stop recovery; silently falling
        # back to an older publishing state could authorize the wrong action.
        raise _integrity_error() from None
    if (
        not isinstance(decoded, dict)
        or set(decoded) != {"version", "data"}
        or type(decoded.get("version")) is not int
        or decoded.get("version") != version
        or not isinstance(decoded.get("data"), dict)
    ):
        raise _integrity_error()
    try:
        clone, _ = _validate_loaded(decoded["data"], intent_id)
    except ExportJournalValidationError:
        raise _integrity_error() from None
    return clone, identity


def _read_record_file(
    path: Path,
    intent_id: str,
    version: int,
    expected: os.stat_result | None = None,
) -> tuple[dict[str, Any], _FileIdentity]:
    if version == 0:
        return _read_journal_file(path, intent_id, expected)
    return _read_generation_file(path, intent_id, version, expected)


@dataclass(frozen=True)
class _JournalEntry:
    path: Path
    info: os.stat_result
    intent_id: str
    version: int


def _parse_journal_name(name: str) -> tuple[str, int] | None:
    if not name.endswith(_UUID_JSON_SUFFIX):
        return None
    anchor = name[: -len(_UUID_JSON_SUFFIX)]
    try:
        return _validate_intent_id(anchor), 0
    except ExportJournalValidationError:
        match = _GENERATION_RE.fullmatch(name)
        if match is None:
            if "." in anchor:
                prefix = anchor.split(".", 1)[0]
                try:
                    _validate_intent_id(prefix)
                except ExportJournalValidationError:
                    # UUID-shaped prefixes with non-canonical case/format
                    # still belong to the private namespace and must fail
                    # closed rather than being silently ignored.
                    try:
                        UUID(prefix)
                    except (ValueError, AttributeError):
                        return None
                raise _integrity_error()
            try:
                UUID(anchor)
            except (ValueError, AttributeError):
                return None
            raise _integrity_error()
        identifier = match.group("intent")
        try:
            identifier = _validate_intent_id(identifier)
            version = int(match.group("version"))
        except (ExportJournalValidationError, ValueError):
            return None
        if version > _generation_limit():
            raise _integrity_error()
        return identifier, version


def _iter_json_files(root: Path) -> list[tuple[Path, os.stat_result]]:
    files: list[tuple[Path, os.stat_result]] = []
    try:
        with os.scandir(root) as iterator:
            names = [entry.name for entry in iterator if entry.name.lower().endswith(_UUID_JSON_SUFFIX)]
    except (OSError, ValueError):
        raise _integrity_error() from None
    for name in sorted(names):
        path = root / name
        info = _ordinary_file_info(path)
        files.append((path, info))
    return files


def _iter_temp_files(root: Path) -> list[tuple[Path, os.stat_result]]:
    """Return private temporary files so crash leftovers consume quota."""

    files: list[tuple[Path, os.stat_result]] = []
    try:
        with os.scandir(root) as iterator:
            names = [entry.name for entry in iterator if entry.name.lower().endswith(_TEMP_SUFFIX)]
    except (OSError, ValueError):
        raise _integrity_error() from None
    for name in sorted(names):
        path = root / name
        info = _ordinary_file_info(path)
        files.append((path, info))
    return files


def _iter_json_entries(root: Path) -> list[_JournalEntry]:
    entries: list[_JournalEntry] = []
    for path, info in _iter_json_files(root):
        parsed = _parse_journal_name(path.name)
        if parsed is None:
            continue
        intent_id, version = parsed
        entries.append(_JournalEntry(path, info, intent_id, version))
    return entries


def _latest_record(
    root: Path,
    intent_id: str,
) -> tuple[dict[str, Any], _FileIdentity, Path, int]:
    entries = [entry for entry in _iter_json_entries(root) if entry.intent_id == intent_id]
    anchors = [entry for entry in entries if entry.version == 0]
    if len(anchors) != 1:
        raise _integrity_error()
    anchor = anchors[0]
    # Always validate the immutable anchor.  It is the intent's existence
    # proof even after newer versions have been published.
    anchor_data, anchor_identity = _read_journal_file(anchor.path, intent_id, anchor.info)
    generations = sorted(
        (entry for entry in entries if entry.version > 0),
        key=lambda entry: entry.version,
    )
    if not generations:
        return anchor_data, anchor_identity, anchor.path, 0
    latest = generations[-1]
    data, identity = _read_generation_file(latest.path, intent_id, latest.version, latest.info)
    anchor_final, anchor_final_identity = _read_journal_file(anchor.path, intent_id, anchor.info)
    if anchor_final != anchor_data or not _same_file_identity(anchor_final_identity, anchor_identity):
        raise _conflict_error()
    immutable = ("schema", "intent_id", "job_id", "created_at")
    if any(data.get(field) != anchor_data.get(field) for field in immutable):
        raise _integrity_error()
    return data, identity, latest.path, latest.version


def _intent_entries(root: Path, intent_id: str) -> list[_JournalEntry]:
    entries = [entry for entry in _iter_json_entries(root) if entry.intent_id == intent_id]
    if not any(entry.version == 0 for entry in entries):
        raise _integrity_error()
    return sorted(entries, key=lambda entry: entry.version)


def _capture_generation_identities(
    entries: list[_JournalEntry],
    intent_id: str,
) -> dict[int, _FileIdentity]:
    """Capture old generation bytes/identity before publishing a new one."""

    captured: dict[int, _FileIdentity] = {}
    for entry in entries:
        if entry.version == 0:
            continue
        _, identity = _read_generation_file(
            entry.path,
            intent_id,
            entry.version,
            entry.info,
        )
        captured[entry.version] = identity
    return captured


def _check_quota(
    root: Path,
    new_size: int,
    *,
    replacing: Path | None = None,
    old_size: int = 0,
    new_intent: bool = False,
) -> None:
    max_count, maximum, total_maximum = _limits()
    if new_size < 0 or new_size > maximum:
        raise _quota_error()
    entries = _iter_json_entries(root)
    json_files = _iter_json_files(root)
    temp_files = _iter_temp_files(root)
    anchors = {entry.intent_id for entry in entries if entry.version == 0}
    # A process may have been killed after removing an intent anchor but
    # before removing its retained generations.  Such orphan files are not a
    # recoverable intent and are never selected by load/list, but their bytes
    # remain part of the bounded private directory until host cleanup handles
    # them explicitly.
    if any(int(info.st_size) > maximum for _, info in json_files):
        raise _quota_error()
    if any(int(info.st_size) > maximum for _, info in temp_files):
        raise _quota_error()
    current_total = sum(int(info.st_size) for _, info in (*json_files, *temp_files))
    replacing_count = 0
    if replacing is not None:
        for entry in entries:
            path, info = entry.path, entry.info
            try:
                same = os.path.normcase(os.path.abspath(path)) == os.path.normcase(os.path.abspath(replacing))
            except (OSError, ValueError):
                same = path == replacing
            if same:
                replacing_count = 1
                if int(info.st_size) != old_size:
                    raise _conflict_error()
                break
        if replacing_count != 1:
            raise _conflict_error()
    # A generation is an additional immutable JSON file.  Count logical
    # intents by their anchor, while every generation contributes bytes.
    new_count = len(anchors) + (1 if new_intent else 0)
    new_total = current_total - (old_size if replacing_count else 0) + new_size
    if len(anchors) > max_count or new_count > max_count or new_total > total_maximum:
        raise _quota_error()


def _write_temp(root: Path, encoded: bytes, intent_id: str) -> tuple[Path, tuple[int, int]]:
    temporary: Path | None = None
    descriptor = -1
    try:
        descriptor, raw_path = tempfile.mkstemp(
            prefix=f".{intent_id}.", suffix=".tmp", dir=os.fspath(root)
        )
        temporary = Path(raw_path)
        # Capture the object immediately after mkstemp.  If a later write
        # fails, cleanup may unlink only this inode, never a replacement that
        # happened to acquire the same temporary pathname.
        own_info = os.fstat(descriptor)
        object_identity = (int(own_info.st_dev), int(own_info.st_ino))
        os.set_inheritable(descriptor, False)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            descriptor = -1
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        info = _ordinary_file_info(temporary)
        if (int(info.st_dev), int(info.st_ino)) != object_identity:
            raise _integrity_error()
        return temporary, object_identity
    except ExportJournalError:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary is not None:
            _cleanup_temp(temporary, locals().get("object_identity"))
        raise
    except (OSError, ValueError, TypeError):
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary is not None:
            _cleanup_temp(temporary, locals().get("object_identity"))
        raise _error("export journal write failed") from None


def _cleanup_temp(path: Path, object_identity: tuple[int, int] | None) -> None:
    """Unlink only the temporary file this operation created."""

    if object_identity is None:
        return
    try:
        info = path.lstat()
    except (OSError, ValueError):
        return
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or _reparse_point(info)
        or (int(info.st_dev), int(info.st_ino)) != object_identity
    ):
        return
    try:
        path.unlink()
    except OSError:
        pass


def _publish_new(
    temporary: Path,
    destination: Path,
    *,
    expected_identity: tuple[int, int] | None = None,
    expected_encoded: bytes | None = None,
) -> None:
    """Publish a complete file without replacing a pre-existing entry."""

    try:
        if os.path.lexists(destination):
            raise FileExistsError
    except (OSError, ValueError):
        raise _exists_error() from None

    if os.name == "nt":
        try:
            # The native handle rename binds the final operation to the
            # verified temp inode and has no-replace semantics.  It also
            # closes the final pathname race that ordinary os.rename has.
            info = _ordinary_file_info(temporary)
            temporary_identity = (int(info.st_dev), int(info.st_ino))
            if expected_identity is not None and temporary_identity != expected_identity:
                raise _integrity_error()
            if expected_encoded is None:
                raise _validation_error("export journal write data is missing")
            _windows_rename_no_replace(
                temporary,
                destination,
                temporary_identity,
                expected_encoded,
            )
            return
        except ExportJournalError:
            raise
        except (OSError, ValueError):
            raise _error("export journal write failed") from None
    try:
        os.link(temporary, destination)
    except FileExistsError:
        raise _exists_error() from None
    except OSError:
        raise _error("export journal write failed") from None
    # The destination is already a complete published file.  Remove only the
    # temporary inode created by this operation; if its pathname was replaced
    # in the meantime, leave the foreign entry untouched.
    _cleanup_temp(temporary, expected_identity)


def _fsync_directory(root: Path) -> None:
    if os.name == "nt":
        return
    descriptor = -1
    try:
        descriptor = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        os.fsync(descriptor)
    except OSError:
        # The file itself was durably flushed; some filesystems do not permit
        # opening a directory for fsync.  Do not turn a successful atomic
        # publish into a path-leaking error.
        pass
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass


if os.name == "nt":

    @contextmanager
    def _hold_windows_directory(root: Path, identity: _RootIdentity) -> Iterator[None]:
        """Hold a no-reparse directory handle through the journal operation."""

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

        file_list_directory = 0x0001
        file_read_attributes = 0x0080
        synchronize = 0x00100000
        # Keep the native directory handle open for the entire operation so
        # its device/inode identity remains anchored.  Read/write sharing lets
        # this process create, replace and remove child files; withholding
        # FILE_SHARE_DELETE prevents another process from renaming or replacing
        # the directory itself while the lock is held.
        file_share_read = 0x00000001 | 0x00000002
        open_existing = 3
        open_reparse_point = 0x00200000
        backup_semantics = 0x02000000
        invalid_handle = ctypes.c_void_p(-1).value

        raw_handle = create_file(
            str(root),
            file_list_directory | file_read_attributes | synchronize,
            file_share_read,
            None,
            open_existing,
            open_reparse_point | backup_semantics,
            None,
        )
        if raw_handle == invalid_handle:
            raise _integrity_error()
        descriptor = -1
        try:
            descriptor = msvcrt.open_osfhandle(raw_handle, os.O_RDONLY | getattr(os, "O_BINARY", 0))
            raw_handle = None
            info = os.fstat(descriptor)
            if (
                not stat.S_ISDIR(info.st_mode)
                or _reparse_point(info)
                or (int(info.st_dev), int(info.st_ino)) != (identity.device, identity.inode)
                or _stable_path(root) != identity.resolved_path
            ):
                raise _integrity_error()
            try:
                yield
            finally:
                _assert_root_identity(root, identity)
        finally:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            elif raw_handle not in (None, invalid_handle):
                close_handle(raw_handle)

else:

    @contextmanager
    def _hold_windows_directory(root: Path, identity: _RootIdentity) -> Iterator[None]:
        # POSIX has no portable directory-handle lock boundary in the stdlib;
        # identity checks before and after each operation are the safe limit.
        _assert_root_identity(root, identity)
        try:
            yield
        finally:
            _assert_root_identity(root, identity)


if os.name == "nt":

    def _windows_open_descriptor(
        path: Path,
        desired_access: int,
        share_mode: int,
        *,
        writable: bool = False,
    ) -> int:
        """Open one regular-file handle with the requested sharing boundary."""

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
            raise OSError(ctypes.get_last_error(), "unable to open export journal file")
        descriptor = -1
        try:
            mode = (os.O_RDWR if writable else os.O_RDONLY) | getattr(os, "O_BINARY", 0)
            descriptor = msvcrt.open_osfhandle(raw_handle, mode)
            raw_handle = None
            return descriptor
        finally:
            if descriptor < 0 and raw_handle not in (None, invalid_handle):
                close_handle(raw_handle)


    def _windows_read_descriptor(
        descriptor: int,
    ) -> tuple[bytes, os.stat_result]:
        """Read a bounded regular-file handle and return bytes plus final stat."""

        _, maximum, _ = _limits()
        try:
            initial = os.fstat(descriptor)
            if (
                not stat.S_ISREG(initial.st_mode)
                or _reparse_point(initial)
                or int(initial.st_size) > maximum
            ):
                raise _integrity_error()
            os.lseek(descriptor, 0, os.SEEK_SET)
            raw = bytearray()
            while len(raw) <= maximum:
                remaining = maximum + 1 - len(raw)
                chunk = os.read(descriptor, min(_READ_CHUNK_BYTES, remaining))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > maximum:
                    raise _quota_error()
            finished = os.fstat(descriptor)
            if not _same_stat(initial, finished) or len(raw) != int(finished.st_size):
                raise _conflict_error()
            return bytes(raw), finished
        except ExportJournalError:
            raise
        except (OSError, ValueError):
            raise _error("export journal read failed") from None


    def _windows_set_delete_disposition(descriptor: int) -> None:
        """Mark the exact opened file handle for deletion."""

        import ctypes
        import msvcrt
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        set_file_information = kernel32.SetFileInformationByHandle
        set_file_information.argtypes = [
            wintypes.HANDLE,
            wintypes.INT,
            wintypes.LPVOID,
            wintypes.DWORD,
        ]
        set_file_information.restype = wintypes.BOOL

        class FileDispositionInfo(ctypes.Structure):
            _fields_ = [("delete_file", ctypes.c_ubyte)]

        disposition = FileDispositionInfo(1)
        if not set_file_information(
            msvcrt.get_osfhandle(descriptor),
            4,  # FileDispositionInfo
            ctypes.byref(disposition),
            ctypes.sizeof(disposition),
        ):
            raise OSError(ctypes.get_last_error(), "unable to delete export journal file")


    def _windows_rename_no_replace(
        temporary: Path,
        destination: Path,
        temporary_identity: tuple[int, int],
        encoded: bytes,
    ) -> None:
        """Atomically rename a verified temp handle without replacing a name."""

        import ctypes
        import msvcrt
        from ctypes import wintypes

        generic_read = 0x80000000
        delete = 0x00010000
        file_read_attributes = 0x00000080
        descriptor = -1
        try:
            # FILE_SHARE_NONE protects the temporary object until the native
            # rename consumes this exact handle.  A pathname replacement can
            # therefore neither change the bytes nor redirect the rename.
            descriptor = _windows_open_descriptor(
                temporary,
                generic_read | delete | file_read_attributes,
                0,
            )
            info = os.fstat(descriptor)
            if (
                not stat.S_ISREG(info.st_mode)
                or _reparse_point(info)
                or (int(info.st_dev), int(info.st_ino)) != temporary_identity
            ):
                raise _integrity_error()
            raw, finished = _windows_read_descriptor(descriptor)
            if (
                (int(finished.st_dev), int(finished.st_ino)) != temporary_identity
                or raw != encoded
            ):
                raise _integrity_error()

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            set_file_information = kernel32.SetFileInformationByHandle
            set_file_information.argtypes = [
                wintypes.HANDLE,
                wintypes.INT,
                wintypes.LPVOID,
                wintypes.DWORD,
            ]
            set_file_information.restype = wintypes.BOOL

            class FileRenameInfo(ctypes.Structure):
                _fields_ = [
                    ("replace_if_exists", ctypes.c_ubyte),
                    ("root_directory", wintypes.HANDLE),
                    ("file_name_length", wintypes.DWORD),
                    ("file_name", wintypes.WCHAR * 1),
                ]

            name = os.path.abspath(os.fspath(destination)).replace("/", "\\")
            name_bytes = name.encode("utf-16-le", "strict")
            name_offset = FileRenameInfo.file_name.offset
            # Keep a trailing UTF-16 NUL in the variable-length buffer.  The
            # kernel uses FileNameLength, while the terminator avoids a stray
            # code unit on providers that inspect the complete structure.
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
            if not set_file_information(
                msvcrt.get_osfhandle(descriptor),
                3,  # FileRenameInfo
                ctypes.byref(buffer),
                ctypes.sizeof(buffer),
            ):
                error_code = ctypes.get_last_error()
                if error_code in {80, 183}:  # ERROR_FILE_EXISTS / ALREADY_EXISTS
                    raise _exists_error()
                raise OSError(error_code, "unable to publish export journal file")
        except ExportJournalError:
            raise
        except (OSError, ValueError, TypeError, UnicodeError):
            raise _error("export journal write failed") from None
        finally:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass


    def _remove_windows_path(path: Path, identity: _FileIdentity) -> None:
        """Delete one exact file identity through a verified Windows handle."""

        generic_read = 0x80000000
        delete = 0x00010000
        file_read_attributes = 0x00000080
        descriptor = -1
        try:
            descriptor = _windows_open_descriptor(
                path,
                generic_read | delete | file_read_attributes,
                0,
            )
            info = os.fstat(descriptor)
            if not identity.same_content_identity(info):
                raise _conflict_error()
            raw, finished = _windows_read_descriptor(descriptor)
            if (
                not identity.same_content_identity(finished)
                or hashlib.sha256(raw).hexdigest() != identity.sha256
            ):
                raise _conflict_error()
            _windows_set_delete_disposition(descriptor)
        except ExportJournalError:
            raise
        except (OSError, ValueError, TypeError):
            raise _error("export journal record removal failed") from None
        finally:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass


    def _remove_windows_bound(record: JournalRecord) -> None:
        """Delete exactly the verified destination handle, never its pathname."""

        _remove_windows_path(record._path, record._identity)


else:

    # Keep these names available for type-checkers and tests on POSIX while
    # ensuring no Windows-only ctypes code is imported there.
    _windows_rename_no_replace = None  # type: ignore[assignment]
    _remove_windows_path = None  # type: ignore[assignment]
    _remove_windows_bound = None  # type: ignore[assignment]


def _remove_owned_path(path: Path, identity: _FileIdentity) -> None:
    """Remove one already-read generation without following replacements."""

    if os.name == "nt":
        _remove_windows_path(path, identity)
        return
    info = _ordinary_file_info(path)
    if not identity.same_content_identity(info):
        raise _conflict_error()
    try:
        path.unlink()
    except (OSError, ValueError):
        raise _error("export journal record removal failed") from None


def _cleanup_old_generations(
    root: Path,
    intent_id: str,
    keep_version: int,
    expected_identities: dict[int, _FileIdentity] | None = None,
) -> None:
    """Best-effort old-version cleanup after a newer version is committed."""

    try:
        entries = _intent_entries(root, intent_id)
    except ExportJournalError:
        return
    for entry in entries:
        if entry.version == 0 or entry.version == keep_version:
            continue
        try:
            _, identity = _read_generation_file(
                entry.path,
                intent_id,
                entry.version,
                entry.info,
            )
            if expected_identities is not None:
                expected = expected_identities.get(entry.version)
                if expected is None or not _same_file_identity(identity, expected):
                    raise _conflict_error()
            _remove_owned_path(entry.path, identity)
        except ExportJournalConflictError:
            # A replacement at this pathname is never ours to delete.  Keep
            # it visible to the caller while preserving the committed latest
            # generation.
            raise
        except ExportJournalIntegrityError:
            # A damaged/replaced old generation is not safe to classify as a
            # cleanup miss; report it while leaving the committed latest
            # generation available for recovery.
            raise
        except ExportJournalError:
            # The new generation is already durable.  Leave an old version in
            # place on cleanup failure so a later locked operation can retry;
            # never convert a cleanup conflict into deletion of a replacement.
            continue


if os.name == "nt":
    import msvcrt
else:  # pragma: no cover - selected by the host operating system
    import fcntl


def _open_lock(root: Path) -> int:
    lock_path = root / JOURNAL_LOCK_NAME
    flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0)
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    descriptor = -1
    try:
        if os.name == "nt":
            # CRT os.open cannot request a no-delete sharing boundary.  Create
            # the fixed file if needed, then reopen it through the native
            # helper so a pathname replacement cannot bypass msvcrt.locking.
            try:
                creator = os.open(
                    lock_path,
                    flags | os.O_CREAT | os.O_EXCL | no_follow,
                    0o600,
                )
            except FileExistsError:
                expected = _ordinary_file_info(lock_path)
            else:
                try:
                    expected = os.fstat(creator)
                finally:
                    os.close(creator)
            descriptor = _windows_open_descriptor(
                lock_path,
                0xC0000000,  # GENERIC_READ | GENERIC_WRITE
                0x00000003,  # FILE_SHARE_READ | FILE_SHARE_WRITE, no delete
                writable=True,
            )
            actual = os.fstat(descriptor)
            if not _same_stat(expected, actual):
                os.close(descriptor)
                descriptor = -1
                raise _integrity_error()
            os.set_inheritable(descriptor, False)
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            return descriptor
        try:
            descriptor = os.open(lock_path, flags | os.O_CREAT | os.O_EXCL | no_follow, 0o600)
        except FileExistsError:
            info = _ordinary_file_info(lock_path)
            descriptor = os.open(lock_path, flags | no_follow)
            actual = os.fstat(descriptor)
            if not _same_stat(info, actual):
                os.close(descriptor)
                raise _integrity_error()
        os.set_inheritable(descriptor, False)
        if os.name == "nt":
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptor
    except ExportJournalError:
        raise
    except OSError as error:
        try:
            os.close(descriptor)  # type: ignore[possibly-undefined]
        except (OSError, UnboundLocalError):
            pass
        if os.name == "nt":
            raise ExportJournalBusyError("export journal is busy") from None
        # EACCES/EAGAIN are the normal non-blocking contention results.  A
        # permission or filesystem error still gets a stable unavailable error.
        import errno

        if getattr(error, "errno", None) in (errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK):
            raise ExportJournalBusyError("export journal is busy") from None
        raise _error("export journal lock is unavailable") from None


def _close_lock(descriptor: int) -> None:
    try:
        if os.name == "nt":
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
    except OSError:
        pass
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass


@dataclass
class JournalRecord:
    """One validated intent held by an active :meth:`ExportJournal.locked`."""

    _journal: ExportJournal
    _intent_id: str
    _path: Path
    data: dict[str, Any]
    _identity: _FileIdentity
    _baseline: dict[str, Any]
    _version: int = 0
    _active: bool = True

    def save(self, data: dict[str, Any]) -> None:
        if not self._active:
            raise _error("export journal record is not locked")
        self._journal._save_record(self, data)

    def remove(self) -> None:
        if not self._active:
            raise _error("export journal record is not locked")
        self._journal._remove_record(self)


class ExportJournal:
    """A bounded JSON journal rooted at one host-owned private directory."""

    def __init__(self, root: Path) -> None:
        try:
            candidate = Path(root)
        except (TypeError, ValueError):
            raise _validation_error("export journal root is invalid") from None
        self.root = candidate
        self._identity = _capture_root_identity(candidate)

    @contextmanager
    def _operation(self) -> Iterator[None]:
        with _hold_windows_directory(self.root, self._identity):
            descriptor = _open_lock(self.root)
            try:
                _assert_root_identity(self.root, self._identity)
                yield
            finally:
                _close_lock(descriptor)

    def _journal_path(self, intent_id: object) -> tuple[str, Path]:
        identifier = _validate_intent_id(intent_id)
        return identifier, self.root / f"{identifier}{_UUID_JSON_SUFFIX}"

    def _generation_path(self, intent_id: object, version: int) -> tuple[str, Path]:
        identifier = _validate_intent_id(intent_id)
        if type(version) is not int or version < 1 or version > _generation_limit():
            raise _validation_error("export journal generation is invalid")
        return identifier, self.root / f"{identifier}.{version}{_UUID_JSON_SUFFIX}"

    def _record_path(self, intent_id: object, version: int) -> tuple[str, Path]:
        if version == 0:
            return self._journal_path(intent_id)
        return self._generation_path(intent_id, version)

    def _assert_record_path(self, record: JournalRecord) -> None:
        _, expected = self._record_path(record._intent_id, record._version)
        try:
            same = os.path.normcase(os.path.abspath(record._path)) == os.path.normcase(os.path.abspath(expected))
        except (OSError, TypeError, ValueError):
            same = False
        if not same:
            raise _integrity_error()

    def create(self, data: dict[str, Any]) -> None:
        prepared, encoded = _prepare_data(data)
        intent_id = _validate_intent_id(prepared["intent_id"])
        _, path = self._journal_path(intent_id)
        _, maximum, _ = _limits()
        if len(encoded) > maximum:
            raise _quota_error()

        with self._operation():
            _assert_root_identity(self.root, self._identity)
            try:
                if os.path.lexists(path):
                    raise FileExistsError
            except (OSError, ValueError):
                raise _exists_error() from None
            _check_quota(self.root, len(encoded), new_intent=True)
            temporary, object_identity = _write_temp(self.root, encoded, intent_id)
            try:
                _assert_root_identity(self.root, self._identity)
                _publish_new(
                    temporary,
                    path,
                    expected_identity=object_identity,
                    expected_encoded=encoded,
                )
                _assert_root_identity(self.root, self._identity)
                _fsync_directory(self.root)
            except BaseException:
                _cleanup_temp(temporary, object_identity)
                raise

    def load(self, intent_id: str) -> dict[str, Any]:
        """Load one record under the fixed lock and return an independent copy."""

        identifier, _ = self._journal_path(intent_id)
        with self._operation():
            data, _, _, _ = _latest_record(self.root, identifier)
            return json.loads(_canonical_json(data).decode("utf-8"))

    @contextmanager
    def locked(self, intent_id: str) -> Iterator[JournalRecord]:
        identifier, _ = self._journal_path(intent_id)
        with self._operation():
            data, identity, path, version = _latest_record(self.root, identifier)
            baseline = json.loads(_canonical_json(data).decode("utf-8"))
            record = JournalRecord(self, identifier, path, data, identity, baseline, version)
            try:
                yield record
            finally:
                record._active = False

    def list_metadata(self, job_id: str | None = None) -> list[dict[str, str]]:
        if job_id is not None:
            _validate_text_identifier(job_id, "export journal job id is invalid")
        result: list[dict[str, str]] = []
        with self._operation():
            entries = _iter_json_entries(self.root)
            identifiers = sorted({entry.intent_id for entry in entries if entry.version == 0})
            # Each latest record is loaded and released before the next one.
            # This avoids retaining scope/evidence payloads in metadata.
            for identifier in identifiers:
                data, _, _, _ = _latest_record(self.root, identifier)
                if job_id is None or data["job_id"] == job_id:
                    result.append({
                        "intent_id": identifier,
                        "job_id": data["job_id"],
                        "created_at": data["created_at"],
                        "state": data["state"],
                    })
        result.sort(key=lambda item: (item["created_at"], item["intent_id"]))
        return result

    def _save_record(self, record: JournalRecord, data: dict[str, Any]) -> None:
        _assert_root_identity(self.root, self._identity)
        self._assert_record_path(record)
        prepared, encoded = _prepare_data(data)
        immutable = ("schema", "intent_id", "job_id", "created_at")
        if any(prepared.get(field) != record._baseline.get(field) for field in immutable):
            raise _validation_error("export journal identity fields are immutable")
        _, maximum, _ = _limits()
        if len(encoded) > maximum:
            raise _quota_error()

        # Read and hash the current version before writing.  This catches both
        # an external replacement and an in-place edit made since locked().
        current, current_identity = _read_record_file(
            record._path,
            record._intent_id,
            record._version,
        )
        if current != record._baseline or not _same_file_identity(current_identity, record._identity):
            raise _conflict_error()
        entries = _intent_entries(self.root, record._intent_id)
        old_generation_identities = _capture_generation_identities(entries, record._intent_id)
        current_version = max(entry.version for entry in entries)
        if current_version != record._version:
            raise _conflict_error()
        next_version = current_version + 1
        if next_version > _generation_limit():
            raise _quota_error()
        generation_path = self._generation_path(record._intent_id, next_version)[1]
        generation_encoded = _generation_encoded(next_version, prepared)
        _check_quota(self.root, len(generation_encoded))
        temporary, object_identity = _write_temp(self.root, generation_encoded, record._intent_id)
        try:
            _assert_root_identity(self.root, self._identity)
            latest, latest_identity = _read_record_file(
                record._path,
                record._intent_id,
                record._version,
            )
            if latest != current or not _same_file_identity(latest_identity, current_identity):
                raise _conflict_error()
            _publish_new(
                temporary,
                generation_path,
                expected_identity=object_identity,
                expected_encoded=generation_encoded,
            )
            temporary = None  # type: ignore[assignment]
            _fsync_directory(self.root)
            updated, updated_identity = _read_generation_file(
                generation_path,
                record._intent_id,
                next_version,
            )
            _assert_root_identity(self.root, self._identity)
            _fsync_directory(self.root)
            record.data = updated
            record._identity = updated_identity
            record._path = generation_path
            record._version = next_version
            record._baseline = json.loads(_canonical_json(updated).decode("utf-8"))
            _cleanup_old_generations(
                self.root,
                record._intent_id,
                next_version,
                old_generation_identities,
            )
        finally:
            if temporary is not None:
                _cleanup_temp(temporary, object_identity)

    def _remove_record(self, record: JournalRecord) -> None:
        _assert_root_identity(self.root, self._identity)
        self._assert_record_path(record)
        current, current_identity = _read_record_file(
            record._path,
            record._intent_id,
            record._version,
        )
        if not _same_file_identity(current_identity, record._identity) or current != record._baseline:
            raise _conflict_error()
        if current["state"] not in {"closed", "published"}:
            raise _validation_error("export journal record is not closed")
        _assert_root_identity(self.root, self._identity)
        # Pre-read every version before deleting anything.  The anchor is
        # removed first, so a crash during cleanup leaves orphan generations
        # that fail closed instead of making an old anchor look current.
        entries = _intent_entries(self.root, record._intent_id)
        identities: list[tuple[Path, _FileIdentity]] = []
        for entry in entries:
            if entry.path == record._path and entry.version == record._version:
                identities.append((entry.path, current_identity))
            elif entry.version == 0:
                _, identity = _read_journal_file(
                    entry.path,
                    record._intent_id,
                    entry.info,
                )
                identities.append((entry.path, identity))
            else:
                _, identity = _read_generation_file(
                    entry.path,
                    record._intent_id,
                    entry.version,
                    entry.info,
                )
                identities.append((entry.path, identity))
        identities.sort(key=lambda item: 0 if item[0].name == f"{record._intent_id}{_UUID_JSON_SUFFIX}" else 1)
        for path, identity in identities:
            _remove_owned_path(path, identity)
        _assert_root_identity(self.root, self._identity)
        record._active = False


__all__ = [
    "ExportJournal",
    "JournalRecord",
    "ExportJournalError",
    "ExportJournalValidationError",
    "ExportJournalQuotaError",
    "ExportJournalBusyError",
    "ExportJournalExistsError",
    "ExportJournalIntegrityError",
    "ExportJournalConflictError",
    "JournalError",
    "JournalBusyError",
    "JournalIntegrityError",
    "JournalConflictError",
    "MAX_JOURNALS",
    "MAX_JOURNAL_BYTES",
    "MAX_TOTAL_JOURNAL_BYTES",
    "JOURNAL_SCHEMA",
    "JOURNAL_LOCK_NAME",
]
