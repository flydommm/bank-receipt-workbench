"""Bounded tests for the frozen export bundle publication boundary."""

from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path
from uuid import uuid4
import zipfile

import pytest
import pymupdf

from engine import export_publish
from engine import export_directory
from engine.export_journal import ExportJournal
from engine.exporter import DEFAULT_HEADERS


class _FakeRecord:
    def __init__(self, journal: "_FakeJournal", intent_id: str) -> None:
        self._journal = journal
        self._intent_id = intent_id
        self.data = deepcopy(journal.entries[intent_id])

    def save(self, entry: dict[str, object]) -> None:
        self.data = deepcopy(entry)
        self._journal.entries[self._intent_id] = deepcopy(entry)

    def remove(self) -> None:
        self._journal.entries.pop(self._intent_id, None)


class _FakeJournal:
    def __init__(self, entry: dict[str, object]) -> None:
        self.entries = {str(entry["intent_id"]): deepcopy(entry)}

    @contextmanager
    def locked(self, intent_id: str):
        if intent_id not in self.entries:
            raise FileNotFoundError(intent_id)
        yield _FakeRecord(self, intent_id)

    def list_metadata(self):
        return [
            {
                "intent_id": entry["intent_id"],
                "job_id": entry["job_id"],
                "state": entry["state"],
                "created_at": entry["created_at"],
            }
            for entry in self.entries.values()
        ]


class _FakeBatchStore:
    def __init__(self, _path: Path) -> None:
        self.connection = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


@pytest.fixture
def rendered_bundle(tmp_path, monkeypatch):
    preview = tmp_path / "preview.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=300, height=400)
        page.insert_text((20, 40), "synthetic export")
        document.save(preview)
    preview_identity = export_publish._file_identity(preview)
    intent_id = str(uuid4())
    source_sha = "a" * 64
    scope = {
        "job_id": "job-export",
        "result_revision": "result-1",
        "scope_kind": "list",
        "selected_segment_ids": ["segment-1"],
        "expected_records": [{"id": "segment-1", "record_revision": 1}],
        "output_mode": "both",
        "include_xlsx": True,
        "source_fingerprint": "source-fingerprint",
        "review_revision": "review-revision",
        "sources": [{
            "source_key": "source-1",
            "name": "synthetic.pdf",
            "source_path": str(tmp_path / "original.pdf"),
            "source_sha256": source_sha,
        }],
        "summary": {
            "total_segments": 1,
            "selected_count": 1,
            "selected_source_count": 1,
            "omitted_count": 0,
            "omitted_unresolved_count": 0,
            "expected_pages": 1,
        },
    }
    plan = {
        "files": [{
            "file_id": "merged",
            "name": "全部匹配结果.pdf",
            "source_key": None,
            "page_count": 1,
            "pages": [],
        }],
        "index_rows": [{header: ("synthetic.pdf" if header == "source_file" else "") for header in DEFAULT_HEADERS}],
        "mappings": [{
            "segment_id": "segment-1",
            "source_file": "synthetic.pdf",
            "source_page": 1,
            "segment_no": 1,
            "output_file": "全部匹配结果.pdf",
            "output_page": 1,
        }],
        "merged_pages": 1,
        "source_pages": 0,
        "total_pages": 1,
    }
    entry = {
        "schema": 1,
        "intent_id": intent_id,
        "job_id": "job-export",
        "created_at": "2026-09-08T12:00:00+00:00",
        "state": "rendered",
        "scope": scope,
        "plan": plan,
        "files": [{
            "file_id": "merged",
            "name": "全部匹配结果.pdf",
            "source_key": None,
            "page_count": 1,
            "preview_token": str(uuid4()),
            "preview_path": str(preview),
            "sha256": preview_identity["sha256"],
            "size_bytes": preview_identity["size"],
            "identity": preview_identity,
        }],
        "preview_root": str(tmp_path),
        "preview_identity": {"device": 1, "inode": 1, "resolved_path": str(tmp_path)},
        "attempt": None,
        "receipt": None,
    }

    class _Service:
        batch_database = tmp_path / "batch.sqlite3"
        review_database = tmp_path / "review.sqlite3"
        preview_root = tmp_path

        def __init__(self):
            self.journal = _FakeJournal(entry)

        def _validate_entry(self, value, *, require_scope=True):
            assert value["state"] == "rendered"

    @contextmanager
    def _hold(_store, _review, request, *, expected_snapshot=None):
        assert request == expected_snapshot
        yield expected_snapshot

    monkeypatch.setattr(export_publish, "BatchStore", _FakeBatchStore)
    monkeypatch.setattr(export_publish, "_scope_request", lambda snapshot: snapshot)
    monkeypatch.setattr(export_publish, "hold_export_scope", _hold)
    monkeypatch.setattr(export_publish, "_owned_preview_identity", lambda _token, path: export_publish._file_identity(path))
    return _Service(), tmp_path


def test_publish_bundle_public_api_is_available() -> None:
    assert callable(export_publish.publish_bundle)
    assert callable(export_publish.status_bundle)


def test_publish_writes_three_outputs_and_reuses_published_receipt(rendered_bundle) -> None:
    service, root = rendered_bundle
    receipt = export_publish.publish_bundle(service, service.journal.entries[next(iter(service.journal.entries))]["intent_id"], root)
    assert receipt["state"] == "published"
    final = Path(receipt["directory"])
    assert final.is_dir()
    assert {item.name for item in final.iterdir()} == {"全部匹配结果.pdf", "匹配索引.xlsx", "导出清单.json"}
    pdf = final / "全部匹配结果.pdf"
    assert sha256(pdf.read_bytes()).hexdigest() == next(item for item in receipt["files"] if item["kind"] == "pdf")["sha256"]
    manifest = json.loads((final / "导出清单.json").read_text(encoding="utf-8"))
    assert manifest["intent_id"] == receipt["intent_id"]
    assert "source_path" not in json.dumps(manifest, ensure_ascii=False)
    with zipfile.ZipFile(final / "匹配索引.xlsx") as archive:
        workbook = archive.read("xl/workbook.xml").decode("utf-8")
        assert workbook.count("sheet name=") == 3

    before = sorted(path.name for path in root.iterdir() if path.is_dir() and not path.name.startswith("."))
    again = export_publish.publish_bundle(service, receipt["intent_id"], root / "does-not-exist")
    after = sorted(path.name for path in root.iterdir() if path.is_dir() and not path.name.startswith("."))
    assert again == receipt
    assert after == before


def test_publish_round_trip_persists_attempt_with_real_journal(rendered_bundle) -> None:
    service, root = rendered_bundle
    intent_id = next(iter(service.journal.entries))
    journal_root = root / "export-intents"
    journal_root.mkdir()
    real_journal = ExportJournal(journal_root)
    real_journal.create(service.journal.entries[intent_id])
    service.journal = real_journal

    receipt = export_publish.publish_bundle(service, intent_id, root)
    loaded = real_journal.load(intent_id)
    assert loaded["state"] == "published"
    assert loaded["receipt"] == receipt
    assert export_publish.status_bundle(service, "job-export")["publication"] == receipt


def test_xlsx_failure_removes_only_owned_temporary_files(rendered_bundle, monkeypatch) -> None:
    service, root = rendered_bundle

    def fail(*_args, **_kwargs):
        raise OSError("synthetic xlsx failure")

    monkeypatch.setattr(export_publish.exporter, "export_bundle_index", fail)
    with pytest.raises(export_publish.ExportPublishError):
        export_publish.publish_bundle(service, next(iter(service.journal.entries)), root)
    entry = service.journal.entries[next(iter(service.journal.entries))]
    assert entry["state"] == "rendered"
    assert not [path for path in root.iterdir() if path.name.startswith(".")]
    assert not [path for path in root.iterdir() if path.name.startswith("PDF查找_")]


def test_rename_crash_is_recovered_without_a_second_directory(rendered_bundle, monkeypatch) -> None:
    service, root = rendered_bundle
    original = export_publish._rename_directory_no_replace

    class Crash(BaseException):
        pass

    def crash_after_rename(source, destination):
        original(source, destination)
        raise Crash("synthetic process interruption")

    monkeypatch.setattr(export_publish, "_rename_directory_no_replace", crash_after_rename)
    intent_id = next(iter(service.journal.entries))
    with pytest.raises(Crash):
        export_publish.publish_bundle(service, intent_id, root)
    monkeypatch.setattr(export_publish, "_rename_directory_no_replace", original)

    first_dirs = sorted(path for path in root.iterdir() if path.is_dir() and not path.name.startswith("."))
    recovered = export_publish.publish_bundle(service, intent_id, root / "does-not-exist")
    second_dirs = sorted(path for path in root.iterdir() if path.is_dir() and not path.name.startswith("."))
    assert recovered["state"] == "published"
    assert second_dirs == first_dirs
    status = export_publish.status_bundle(service, "job-export")
    assert status["publication"] == recovered
    assert status["residuals"] == []


def test_real_journal_recovers_after_rename_interrupt(rendered_bundle, monkeypatch) -> None:
    service, root = rendered_bundle
    intent_id = next(iter(service.journal.entries))
    journal_root = root / "export-intents"
    journal_root.mkdir()
    real_journal = ExportJournal(journal_root)
    real_journal.create(service.journal.entries[intent_id])
    service.journal = real_journal
    original = export_publish._rename_directory_no_replace

    class Crash(BaseException):
        pass

    def crash_after_rename(source, destination):
        original(source, destination)
        raise Crash("synthetic process interruption")

    monkeypatch.setattr(export_publish, "_rename_directory_no_replace", crash_after_rename)
    with pytest.raises(Crash):
        export_publish.publish_bundle(service, intent_id, root)
    assert real_journal.load(intent_id)["state"] == "publishing"
    monkeypatch.setattr(export_publish, "_rename_directory_no_replace", original)

    recovered = export_publish.publish_bundle(service, intent_id, root / "does-not-exist")
    assert recovered["state"] == "published"
    assert real_journal.load(intent_id)["receipt"] == recovered


def test_status_keeps_residuals_from_closed_retry_alongside_newer_publication(rendered_bundle) -> None:
    service, root = rendered_bundle
    intent_id = next(iter(service.journal.entries))
    receipt = export_publish.publish_bundle(service, intent_id, root)

    current_residual = root / ".residual-current"
    historical_residual = root / ".residual-history"
    current_residual.write_text("current", encoding="utf-8")
    historical_residual.write_text("history", encoding="utf-8")
    previous = deepcopy(service.journal.entries[intent_id])
    previous["intent_id"] = str(uuid4())
    previous["created_at"] = "2026-09-08T12:01:00+00:00"
    previous["state"] = "closed"
    previous["receipt"] = None
    previous["attempt"] = {
        "temporary_path": str(current_residual),
        "final_path": str(root / ".missing-final"),
        "residuals": [{"path": str(current_residual), "reason": "current residual"}],
    }
    previous["residual_attempts"] = [{
        "temporary_path": str(historical_residual),
        "residuals": [{"path": str(historical_residual), "reason": "historical residual"}],
    }]
    service.journal.entries[previous["intent_id"]] = previous

    status = export_publish.status_bundle(service, "job-export")
    assert status["publication"] == receipt
    assert {item["path"] for item in status["residuals"]} == {
        str(current_residual),
        str(historical_residual),
    }


def test_xlsx_exclusive_stream_preserves_foreign_hardlink(tmp_path: Path) -> None:
    outside = tmp_path / "outside-sentinel.txt"
    target = tmp_path / "匹配索引.xlsx"
    original = b"foreign sentinel"
    outside.write_bytes(original)
    os.link(outside, target)

    with pytest.raises(export_publish.ExportPublishError):
        export_publish._write_xlsx(target, {"index_rows": [], "mappings": []}, {})

    assert outside.read_bytes() == original
    assert target.read_bytes() == original


@pytest.mark.skipif(os.name != "nt", reason="requires Windows handle rename")
def test_handle_rename_rejects_source_replacement(monkeypatch, tmp_path: Path) -> None:
    parent = tmp_path / "parent"
    parent.mkdir()
    source = parent / "temporary"
    source.mkdir()
    destination = parent / "published"
    moved = parent / "moved-owned"
    foreign = parent / "foreign"
    source_identity = export_directory.directory_identity(source)
    parent_identity = export_directory.directory_identity(parent)
    original_open = export_directory._open_windows_handle
    triggered = False

    def replace_source(path, desired_access, share, **kwargs):
        nonlocal triggered
        if Path(path) == source and not triggered:
            source.rename(moved)
            foreign.mkdir()
            (foreign / "foreign.txt").write_text("keep", encoding="utf-8")
            foreign.rename(source)
            triggered = True
        return original_open(path, desired_access, share, **kwargs)

    monkeypatch.setattr(export_directory, "_open_windows_handle", replace_source)
    with pytest.raises(export_directory.ExportDirectoryError):
        export_directory.rename_directory_no_replace(source, destination, source_identity, parent_identity)

    assert not destination.exists()
    assert moved.is_dir()
    assert (source / "foreign.txt").read_text(encoding="utf-8") == "keep"


@pytest.mark.skipif(os.name != "nt", reason="requires Windows handle deletion")
def test_handle_remove_rejects_target_replacement(monkeypatch, tmp_path: Path) -> None:
    parent = tmp_path / "parent"
    parent.mkdir()
    target = parent / "temporary"
    target.mkdir()
    moved = parent / "moved-owned"
    foreign = parent / "foreign"
    target_identity = export_directory.directory_identity(target)
    parent_identity = export_directory.directory_identity(parent)
    original_open = export_directory._open_windows_handle
    triggered = False

    def replace_target(path, desired_access, share, **kwargs):
        nonlocal triggered
        if Path(path) == target and not triggered:
            target.rename(moved)
            foreign.mkdir()
            (foreign / "foreign.txt").write_text("keep", encoding="utf-8")
            foreign.rename(target)
            triggered = True
        return original_open(path, desired_access, share, **kwargs)

    monkeypatch.setattr(export_directory, "_open_windows_handle", replace_target)
    with pytest.raises(export_directory.ExportDirectoryError):
        export_directory.remove_directory_owned(target, target_identity, parent_identity)

    assert moved.is_dir()
    assert (target / "foreign.txt").read_text(encoding="utf-8") == "keep"


def test_status_error_residual_uses_absolute_journal_path(tmp_path: Path) -> None:
    intent_id = str(uuid4())
    journal_root = tmp_path / "export-intents"
    journal_root.mkdir()

    class BrokenJournal:
        root = journal_root

        def list_metadata(self):
            return [{"intent_id": intent_id, "job_id": "job-error", "state": "publishing", "created_at": "2026-09-08T12:00:00+00:00"}]

        @contextmanager
        def locked(self, _intent_id):
            raise RuntimeError("synthetic journal failure")

    class Service:
        journal = BrokenJournal()

    status = export_publish.status_bundle(Service(), "job-error")
    assert status["publication"] is None
    assert status["residuals"] == [{
        "path": str(journal_root / f"{intent_id}.json"),
        "reason": "publication recovery is unavailable",
    }]
