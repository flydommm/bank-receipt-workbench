"""Host-owned frozen export intents and managed multi-file PDF previews."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import os
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from . import engine as core
from . import export_journal as journal_module
from .batch_previews import _locked_preview_root, _path, _registered, _root_identity, release_absent_preview
from .batch_store import BatchStore
from .export_journal import ExportJournal
from .export_directory import writable_directory
from .export_plan import build_output_plan
from .export_scope import ExportScopeError, _digest, capture_export_scope, hold_export_scope, validate_scope_request

MAX_BUNDLE_FILES = 501
MAX_RETAINED_RECEIPTS = 128


def _owner(store: BatchStore, token: str) -> dict[str, Any] | None:
    # Allocation can fail before the host has registered its first preview.
    # Only this exact absent table means there was no registration; other
    # database errors must still propagate.
    if store.connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_preview_owners'").fetchone() is None:
        return None
    return _registered(store, token)


def _uuid(value: object) -> str:
    if not isinstance(value, str):
        raise ExportScopeError("export intent token is invalid")
    try:
        if str(UUID(value)) != value:
            raise ValueError
    except ValueError:
        raise ExportScopeError("export intent token is invalid") from None
    return value


def scope_request(snapshot: dict[str, Any]) -> dict[str, Any]:
    keys = ("job_id", "result_revision", "scope_kind", "selected_segment_ids", "expected_records", "output_mode", "include_xlsx")
    request = {key: snapshot[key] for key in keys}
    if "output_name" in snapshot:
        request["output_name"] = snapshot["output_name"]
    return validate_scope_request(request)


def _plan(snapshot: dict[str, Any], processed_at: str) -> dict[str, Any]:
    return build_output_plan(snapshot["sources"], snapshot["records"], snapshot["evidence_by_id"],
                             snapshot["criteria"], snapshot["output_mode"], processed_at,
                             snapshot.get("output_name"))


def _journal_storage_bytes(root: Path) -> int:
    """Return current private journal JSON/temp bytes, including crash debris."""

    files = journal_module._iter_json_files(root) + journal_module._iter_temp_files(root)
    return sum(int(info.st_size) for _, info in files)


class ExportBundleService:
    """Paths are supplied by the native host, never accepted from the webview."""

    def __init__(self, batch_database: Path, review_database: Path, journal_root: Path, preview_root: Path) -> None:
        self.batch_database = Path(batch_database)
        self.review_database = Path(review_database)
        self.preview_root = Path(preview_root)
        self.journal = ExportJournal(Path(journal_root))
        self.preview_identity = _root_identity(self.preview_root)

    def _can_retire_published_receipt(self, entry: dict[str, Any]) -> bool:
        """Check every ownership and file condition before aging a receipt."""

        if (entry.get("state") != "published" or "scope" in entry or "plan" in entry
                or entry.get("previous_attempts") or entry.get("residual_attempts")):
            return False
        files = entry.get("files")
        if not isinstance(files, list) or not files:
            return False
        try:
            with BatchStore(self.batch_database) as store:
                for file in files:
                    if not isinstance(file, dict):
                        return False
                    token = file.get("preview_token")
                    preview_path = file.get("preview_path")
                    if (not isinstance(token, str) or not isinstance(preview_path, str)
                            or _owner(store, token) is not None or os.path.lexists(preview_path)):
                        return False
        except Exception:
            # An ownership lookup that cannot be completed is not proof of
            # absence, so leave the receipt available for a later retry.
            return False
        return True

    def _retire_published_receipts(self, metadata: list[dict[str, str]]) -> list[dict[str, str]]:
        """Age safe published receipts until count and reserved space targets hold."""

        max_receipts = MAX_RETAINED_RECEIPTS
        if type(max_receipts) is not int or max_receipts < 0:
            max_receipts = 0
        maximum = journal_module.MAX_JOURNAL_BYTES
        total_maximum = journal_module.MAX_TOTAL_JOURNAL_BYTES
        if (type(maximum) is not int or maximum < 1
                or type(total_maximum) is not int or total_maximum < 1):
            return metadata
        reserved = 3 * maximum
        target_bytes = max(0, total_maximum - reserved)
        receipts = [row for row in metadata if row["state"] == "published"]
        if not receipts:
            return metadata

        storage_bytes = _journal_storage_bytes(self.journal.root)
        ordered = sorted(receipts, key=lambda row: (row["created_at"], row["intent_id"]))
        newest_id = ordered[-1]["intent_id"]
        # Count pressure naturally ages the oldest entries first.  For space
        # pressure, defer the newest successful receipt until every older
        # eligible receipt has been considered.
        candidates = [row for row in ordered if row["intent_id"] != newest_id]
        candidates.extend(row for row in ordered if row["intent_id"] == newest_id)
        for candidate in candidates:
            if len(receipts) <= max_receipts and storage_bytes <= target_bytes:
                break
            try:
                with self.journal.locked(candidate["intent_id"]) as record:
                    if not self._can_retire_published_receipt(record.data):
                        continue
                    record.remove()
            except Exception:
                # Retirement is an optimization.  Leave an unsafe or
                # concurrently changed receipt for the journal quota path.
                continue
            receipts = [row for row in receipts if row["intent_id"] != candidate["intent_id"]]
            metadata = [row for row in metadata if row["intent_id"] != candidate["intent_id"]]
            storage_bytes = _journal_storage_bytes(self.journal.root)
        return metadata

    def create(self, request: object) -> dict[str, Any]:
        validated = validate_scope_request(request)
        with BatchStore(self.batch_database) as store:
            snapshot = capture_export_scope(store, self.review_database, validated)
        created_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        plan = _plan(snapshot, created_at)
        if not 1 <= len(plan["files"]) <= MAX_BUNDLE_FILES:
            raise ExportScopeError("export file count exceeds the supported limit", "export_capacity_exceeded")
        metadata = self.journal.list_metadata()
        for closed in [row for row in metadata if row["state"] == "closed"]:
            with self.journal.locked(closed["intent_id"]) as record:
                if record.data["state"] != "closed":
                    continue
                # Keep a closed descriptor until the native host has released
                # all batch owners. A lost close reply can then be retried.
                with BatchStore(self.batch_database) as store:
                    if (not record.data.get("attempt") and not record.data.get("previous_attempts")
                            and not record.data.get("residual_attempts")
                            and all(_owner(store, file["preview_token"]) is None for file in record.data["files"])):
                        record.remove()
        metadata = self.journal.list_metadata()
        if sum(row["state"] not in {"closed", "published"} for row in metadata) >= 128:
            raise ExportScopeError("retained export previews require cleanup", "export_capacity_exceeded")
        metadata = self._retire_published_receipts(metadata)
        files = []
        for file in plan["files"]:
            token = str(uuid4())
            files.append({"file_id": file["file_id"], "name": file["name"], "source_key": file["source_key"],
                          "page_count": file["page_count"], "preview_token": token,
                          "preview_path": str(self.preview_root / f"{token}.pdf")})
        entry = {"schema": 1, "intent_id": str(uuid4()), "job_id": snapshot["job_id"], "created_at": created_at,
                 "state": "created", "scope": snapshot, "plan": plan, "files": files,
                 "preview_root": str(self.preview_root), "preview_identity": self.preview_identity,
                 "attempt": None, "receipt": None}
        self.journal.create(entry)
        return self._public_preview(entry)

    def _validate_entry(self, entry: dict[str, Any], *, require_scope: bool = True) -> None:
        _uuid(entry["intent_id"])
        if entry["preview_root"] != str(self.preview_root) or entry["preview_identity"] != self.preview_identity:
            raise ExportScopeError("managed preview directory identity changed")
        files = entry["files"]
        if not isinstance(files, list) or not 1 <= len(files) <= MAX_BUNDLE_FILES:
            raise ExportScopeError("export preview file set is invalid")
        tokens = set()
        file_ids = set()
        for file in files:
            token = _uuid(file["preview_token"])
            if (token in tokens or file["file_id"] in file_ids
                    or file["preview_path"] != str(self.preview_root / f"{token}.pdf")):
                raise ExportScopeError("export preview registration is invalid")
            tokens.add(token)
            file_ids.add(file["file_id"])
        if require_scope:
            snapshot = entry["scope"]
            payload = {key: value for key, value in snapshot.items() if key != "snapshot_digest"}
            if (snapshot["snapshot_digest"] != _digest(payload) or snapshot["job_id"] != entry["job_id"]
                    or entry["plan"] != _plan(snapshot, entry["created_at"])):
                raise ExportScopeError("frozen export intent is invalid")
            if len(files) != len(entry["plan"]["files"]):
                raise ExportScopeError("export preview file set is incomplete")
            for file, planned in zip(files, entry["plan"]["files"], strict=True):
                if any(file[key] != planned[key] for key in ("file_id", "name", "source_key", "page_count")):
                    raise ExportScopeError("export preview file set does not match frozen plan")

    @staticmethod
    def _public_preview(entry: dict[str, Any]) -> dict[str, Any]:
        snapshot = entry["scope"]
        return deepcopy({"intent_id": entry["intent_id"], "state": entry["state"],
                         **{key: snapshot[key] for key in ("job_id", "result_revision", "scope_kind", "selected_segment_ids",
                                                           "source_fingerprint", "review_revision", "output_mode", "include_xlsx", "summary")},
                         **({"output_name": snapshot["output_name"]} if "output_name" in snapshot else {}),
                         "files": [{key: file[key] for key in ("file_id", "name", "source_key", "page_count",
                                                               "preview_token", "preview_path", "sha256", "size_bytes") if key in file}
                                   for file in entry["files"]],
                         **{key: entry["plan"][key] for key in ("merged_pages", "source_pages", "total_pages")}})

    def render(self, intent_id: str) -> dict[str, Any]:
        with self.journal.locked(_uuid(intent_id)) as record:
            entry = record.data
            if entry["state"] != "created":
                raise ExportScopeError("export intent has already been consumed or closed")
            self._validate_entry(entry)
            with BatchStore(self.batch_database) as store:
                for file in entry["files"]:
                    try:
                        registered = _registered(store, file["preview_token"])
                        if (registered is None or registered["job_id"] != entry["job_id"]
                                or _path(registered) != Path(file["preview_path"])):
                            raise ExportScopeError("host preview registration is missing")
                    except ExportScopeError:
                        raise
                    except Exception:
                        raise ExportScopeError("host preview registration is unavailable") from None
                with hold_export_scope(store, self.review_database, scope_request(entry["scope"]),
                                       expected_snapshot=entry["scope"]):
                    pass
                with writable_directory(self.preview_root, self.preview_identity):
                    for file, planned in zip(entry["files"], entry["plan"]["files"], strict=True):
                        selections: dict[str, dict[str, Any]] = {}
                        for page in planned["pages"]:
                            selection = selections.setdefault(page["source_key"], {
                                "source_path": page["source_path"], "source_sha256": page["source_sha256"], "segments": []})
                            selection["segments"].append({"page_number": page["source_page"], "segment_no": page["segment_no"],
                                                           "rect": page["rect"], "keep_full_page": page["keep_full_page"],
                                                           "review_status": "confirmed"})
                        result = core._export_pdf_response({"op": "export_pdf", "output_path": file["preview_path"],
                                                            "export_token": file["preview_token"], "selections": list(selections.values())})
                        if result.get("status") != "ok":
                            raise ExportScopeError("PDF export preview generation failed", "pdf_export_failed")
                        identity = core._owned_created_output_identity(file["preview_token"], Path(file["preview_path"]), "pdf")
                        if (result["output_path"] != file["preview_path"] or result["page_count"] != file["page_count"]
                                or result["sha256"] != identity["sha256"]):
                            raise ExportScopeError("PDF preview does not match frozen output plan")
                        file.update(sha256=identity["sha256"], size_bytes=identity["size"], identity=identity)
                        record.save(entry)
                with hold_export_scope(store, self.review_database, scope_request(entry["scope"]),
                                       expected_snapshot=entry["scope"]):
                    entry["state"] = "rendered"
                    record.save(entry)
            return self._public_preview(entry)

    def describe(self, intent_id: str) -> dict[str, Any]:
        """Native cleanup may retrieve descriptors even after scope invalidation."""
        with self.journal.locked(_uuid(intent_id)) as record:
            self._validate_entry(record.data, require_scope=False)
            return {"intent_id": intent_id, "job_id": record.data["job_id"], "state": record.data["state"],
                    "files": deepcopy(record.data["files"])}

    def close(self, intent_id: str) -> dict[str, Any]:
        with self.journal.locked(_uuid(intent_id)) as record:
            entry = record.data
            if entry["state"] == "publishing":
                # Only publication recovery may decide whether rename happened.
                raise ExportScopeError("export publication needs recovery before closing", "export_recovery_required")
            self._validate_entry(entry, require_scope=False)
            with _locked_preview_root(self.preview_root, self.preview_identity):
                for file in entry["files"]:
                    result = core._cleanup_exports_response({"export_token": file["preview_token"]})
                    if result.get("status") != "ok" or os.path.lexists(file["preview_path"]):
                        raise ExportScopeError("managed export preview cleanup failed", "cleanup_failed")
            if entry["state"] == "published":
                # Preserve compact success/recovery evidence, never ownership
                # of the user's final output directory.
                if "scope" in entry or "plan" in entry:
                    entry.pop("scope", None)
                    entry.pop("plan", None)
                    record.save(entry)
            elif entry["state"] != "closed":
                entry["state"] = "closed"
                entry.pop("scope", None)
                entry.pop("plan", None)
                record.save(entry)
            return {"intent_id": intent_id, "state": "closed"}

    def reconcile(self, active_tokens: object) -> dict[str, Any]:
        """Native-only recovery under its serialized preview lifecycle lock.

        A new host starts with no active tokens. Its previous allocations may
        be closed after verifying ownership, while publishing journals retain
        all evidence needed to decide whether the final rename committed.
        """
        if not isinstance(active_tokens, list) or len(active_tokens) > 100_000:
            raise ExportScopeError("active preview ownership is invalid")
        active = {_uuid(token) for token in active_tokens}
        if len(active) != len(active_tokens):
            raise ExportScopeError("active preview ownership contains duplicates")
        residuals = []
        for item in self.journal.list_metadata():
            if item["state"] == "publishing":
                continue
            try:
                entry = self.describe(item["intent_id"])
                if any(file["preview_token"] in active for file in entry["files"]):
                    continue
                self.close(item["intent_id"])
                with BatchStore(self.batch_database) as store:
                    for file in entry["files"]:
                        release_absent_preview(store, file["preview_token"])
                    with self.journal.locked(item["intent_id"]) as record:
                        if (record.data["state"] == "closed" and not record.data.get("attempt")
                                and not record.data.get("previous_attempts") and not record.data.get("residual_attempts")
                                and all(_owner(store, file["preview_token"]) is None for file in entry["files"])):
                            record.remove()
            except Exception:
                # No deletion authority is inferred from a journal failure.
                # Give a concrete, bounded location for the retained state.
                residuals.append({"path": str(self.preview_root), "reason": "旧导出预览暂未清理，已保留文件及归属记录"})
        return {"residuals": [dict(pair) for pair in dict.fromkeys(tuple(row.items()) for row in residuals)]}
