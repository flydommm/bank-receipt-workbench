"""Receipt exclusion audit cannot downgrade after preview scope compaction."""

from copy import deepcopy
import json

import pytest

from engine import export_publish
from engine.export_bundle import ExportBundleService
from engine.export_journal import ExportJournal, ExportJournalIntegrityError, ExportJournalValidationError
from engine.export_scope import _digest
from tests.test_export_journal import _record
from tests.test_export_publish import rendered_bundle
from tests.test_receipt_export_exclusions import excluded_task
from tests.test_receipt_export_bundle import bundle, register
from tests.test_receipt_export_scope import isolated_temp, receipt_export_task
from tests.test_batch_processor_receipt import receipt_calls


@pytest.fixture
def journal(tmp_path):
    root = tmp_path / "export-intents"
    root.mkdir()
    return ExportJournal(root)


def test_receipt_intent_requires_explicit_schema_at_creation(journal):
    entry = _record()
    entry["scope"]["schema"] = 2
    with pytest.raises(ExportJournalValidationError):
        journal.create(entry)
    entry["receipt_schema"] = 2
    journal.create(entry)
    assert journal.load(entry["intent_id"])["receipt_schema"] == 2


@pytest.mark.parametrize("mutation", ["remove", "downgrade"])
def test_receipt_schema_is_immutable_on_save_and_reopen(journal, mutation):
    entry = _record()
    entry["scope"]["schema"] = 2
    entry["receipt_schema"] = 2
    journal.create(entry)
    with journal.locked(entry["intent_id"]) as record:
        record.data["state"] = "published"
        record.data.pop("scope")
        record.save(record.data)
        tampered = deepcopy(record.data)
        if mutation == "remove":
            tampered.pop("receipt_schema")
        else:
            tampered["receipt_schema"] = 1
        with pytest.raises(ExportJournalValidationError):
            record.save(tampered)
        generation_path = record._path
    # Simulate damaged persisted compact JSON, bypassing the save API. The
    # immutable anchor must catch it again after constructing a new service.
    payload = json.loads(generation_path.read_text(encoding="utf-8"))
    payload["data"] = tampered
    generation_path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ExportJournalIntegrityError):
        ExportJournal(journal.root).load(entry["intent_id"])


def test_legacy_journal_without_receipt_schema_still_loads_and_saves(journal):
    entry = _record()
    journal.create(entry)
    with journal.locked(entry["intent_id"]) as record:
        record.data["state"] = "published"
        record.data.pop("scope")
        record.save(record.data)
    assert "receipt_schema" not in ExportJournal(journal.root).load(entry["intent_id"])


@pytest.mark.parametrize("mutation", ["remove_audit", "remove_contract", "downgrade"])
def test_closed_receipt_cannot_remove_entire_exclusion_contract(receipt_export_task, monkeypatch, mutation):
    task, request, _edits = excluded_task(receipt_export_task)
    service = bundle(task, monkeypatch)
    created = service.create(request)
    assert created["receipt_schema"] == 2
    register(service, created)
    assert service.render(created["intent_id"])["receipt_schema"] == 2
    destination = task[0].parent / "published"
    destination.mkdir()
    published = export_publish.publish_bundle(service, created["intent_id"], destination)
    assert published["receipt_schema"] == 2
    service.close(created["intent_id"])
    with service.journal.locked(created["intent_id"]) as record:
        assert "scope" not in record.data and record.data["receipt_schema"] == 2
        record.data["receipt"].pop("excluded")
        record.data["receipt"].pop("excluded_digest")
        record.data["receipt"]["summary"].pop("excluded_count")
        if mutation == "remove_contract":
            record.data["receipt"].pop("receipt_schema")
        elif mutation == "downgrade":
            record.data["receipt"]["receipt_schema"] = 1
        record.save(record.data)
    reopened = ExportBundleService(task[0], task[1], service.journal.root, service.preview_root)
    status = export_publish.status_bundle(reopened, task[2]["id"])
    assert status["publication"] is None and status["residuals"]
    with pytest.raises(export_publish.ExportPublishError):
        export_publish.publish_bundle(reopened, created["intent_id"], destination)


def _interrupt_after_rename(service, intent_id, destination, monkeypatch):
    rename = export_publish._rename_directory_no_replace

    class Interrupted(BaseException):
        pass

    def interrupted_rename(source, target):
        rename(source, target)
        raise Interrupted()

    with monkeypatch.context() as patch:
        patch.setattr(export_publish, "_rename_directory_no_replace", interrupted_rename)
        with pytest.raises(Interrupted):
            export_publish.publish_bundle(service, intent_id, destination)


@pytest.mark.parametrize("mutation", ["remove_contract", "audit_changed", "file_hash", "total_pages"])
def test_receipt_recovery_validates_expected_receipt_before_promotion(receipt_export_task, monkeypatch, mutation):
    task, request, _edits = excluded_task(receipt_export_task)
    service = bundle(task, monkeypatch)
    created = service.create(request)
    register(service, created)
    service.render(created["intent_id"])
    destination = task[0].parent / "published"
    destination.mkdir()
    _interrupt_after_rename(service, created["intent_id"], destination, monkeypatch)
    with service.journal.locked(created["intent_id"]) as record:
        assert record.data["state"] == "publishing"
        expected = record.data["attempt"]["expected_receipt"]
        if mutation == "remove_contract":
            for field in ("receipt_schema", "excluded", "excluded_digest"):
                expected.pop(field)
            expected["summary"].pop("excluded_count")
        elif mutation == "audit_changed":
            expected["excluded"][0]["reviewed_at"] = "2026-09-20T23:59:59.000Z"
            expected["excluded_digest"] = _digest(expected["excluded"])
        elif mutation == "file_hash":
            expected["files"][0]["sha256"] = "0" * 64
        else:
            expected["total_pages"] += 1
        record.save(record.data)
    reopened = ExportBundleService(task[0], task[1], service.journal.root, service.preview_root)
    with pytest.raises(export_publish.ExportPublishError):
        export_publish.publish_bundle(reopened, created["intent_id"], destination)
    assert reopened.journal.load(created["intent_id"])["state"] == "publishing"
    assert export_publish.status_bundle(reopened, task[2]["id"])["publication"] is None


def test_038_receipt_manifest_and_rename_recovery_keep_legacy_contract(rendered_bundle, monkeypatch):
    service, destination = rendered_bundle
    intent_id = next(iter(service.journal.entries))
    scope = service.journal.entries[intent_id]["scope"]
    scope.update(schema=2, processing_options={"processing_mode": "split_all", "criteria": None}, include_xlsx=False)
    # Reproduce the 0.1.38 persisted wire shape. Source/page receipt schema 2
    # predates the exclusion publication contract and has no receipt_schema.
    current_manifest, current_receipt = export_publish._build_manifest, export_publish._receipt

    def legacy_output(builder, entry, *args):
        bridge = deepcopy(entry)
        bridge["receipt_schema"] = 2
        bridge["scope"].update(excluded=[], excluded_digest=_digest([]))
        bridge["scope"]["summary"]["excluded_count"] = 0
        value = builder(bridge, *args)
        value.pop("receipt_schema", None)
        target = value["scope"] if "scope" in value else value
        target.pop("excluded", None)
        target.pop("excluded_digest", None)
        target["summary"].pop("excluded_count", None)
        return value

    with monkeypatch.context() as patch:
        patch.setattr(export_publish, "_build_manifest", lambda entry, attempt: legacy_output(current_manifest, entry, attempt))
        patch.setattr(export_publish, "_receipt", lambda entry, attempt, final: legacy_output(current_receipt, entry, attempt, final))
        _interrupt_after_rename(service, intent_id, destination, patch)
    entry = service.journal.entries[intent_id]
    assert entry["state"] == "publishing" and "receipt_schema" not in entry
    expected = deepcopy(entry["attempt"]["expected_receipt"])
    recovered = export_publish.publish_bundle(service, intent_id, destination / "unused")
    assert recovered == expected
    assert "excluded" not in recovered and "receipt_schema" not in recovered
    assert service.journal.entries[intent_id]["state"] == "published"
    assert export_publish.status_bundle(service, "job-export")["publication"] == recovered
