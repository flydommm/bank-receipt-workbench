"""Regression coverage for the optional ``include_manifest`` export contract."""

from copy import deepcopy
import json
from pathlib import Path

import pytest

from engine import export_publish
from engine.export_journal import ExportJournal, ExportJournalError, ExportJournalIntegrityError
from engine.export_scope import ExportScopeError, validate_scope_request
from engine.review_store_v2 import ReviewStoreV2
from tests.test_batch_processor_receipt import receipt_calls
from tests.test_receipt_export_bundle import bundle, register
from tests.test_receipt_export_scope import isolated_temp, receipt_export_task


MISSING = object()


def _request(task, *, include_manifest=MISSING, include_xlsx=True):
    request = deepcopy(task[6])
    request["include_xlsx"] = include_xlsx
    if include_manifest is not MISSING:
        request["include_manifest"] = include_manifest
    return request


def _assert_option(payload, option):
    expected_present = option is not MISSING
    assert ("include_manifest" in payload) is expected_present
    if expected_present:
        assert payload["include_manifest"] is option


@pytest.mark.parametrize(
    "include_manifest",
    [pytest.param(False, id="false"), pytest.param(True, id="true"), pytest.param(MISSING, id="missing")],
)
@pytest.mark.parametrize("include_xlsx", [False, True], ids=["no-xlsx", "xlsx"])
def test_manifest_option_real_create_render_publish_close_status(
    receipt_export_task, monkeypatch, include_manifest, include_xlsx,
):
    """Exercise every option combination through the complete receipt flow."""

    task = receipt_export_task()
    service = bundle(task, monkeypatch)
    request = _request(task, include_manifest=include_manifest, include_xlsx=include_xlsx)

    created = service.create(request)
    intent = service.journal.load(created["intent_id"])
    _assert_option(created, include_manifest)
    _assert_option(intent, include_manifest)
    _assert_option(intent["scope"], include_manifest)
    register(service, created)

    preview = service.render(created["intent_id"])
    _assert_option(preview, include_manifest)

    output = task[0].parent / "published"
    output.mkdir()
    receipt = export_publish.publish_bundle(service, created["intent_id"], output)
    _assert_option(receipt, include_manifest)
    final = Path(receipt["directory"])
    assert final.is_dir()
    assert final.name.startswith("PDF查找_")

    expected_manifest = include_manifest is not False
    assert (final / "导出清单.json").is_file() is expected_manifest
    assert [file["kind"] for file in receipt["files"]].count("json") == int(expected_manifest)
    assert [file["kind"] for file in receipt["files"]].count("xlsx") == int(include_xlsx)
    if expected_manifest:
        assert (final / "导出清单.json").read_text(encoding="utf-8")
    if include_xlsx:
        assert (final / "匹配索引.xlsx").is_file()
    else:
        assert not (final / "匹配索引.xlsx").exists()

    service.close(created["intent_id"])
    status = export_publish.status_bundle(service, task[2]["id"])
    assert status["publication"] == receipt
    assert status["residuals"] == []


def test_false_manifest_rename_crash_recovers_without_second_directory(receipt_export_task, monkeypatch):
    task = receipt_export_task()
    service = bundle(task, monkeypatch)
    request = _request(task, include_manifest=False, include_xlsx=False)
    created = service.create(request)
    register(service, created)
    service.render(created["intent_id"])

    output = task[0].parent / "crash-output"
    output.mkdir()
    original = export_publish._rename_directory_no_replace

    class Crash(BaseException):
        pass

    def crash_after_rename(source, destination):
        original(source, destination)
        raise Crash("synthetic process interruption")

    monkeypatch.setattr(export_publish, "_rename_directory_no_replace", crash_after_rename)
    with pytest.raises(Crash):
        export_publish.publish_bundle(service, created["intent_id"], output)
    monkeypatch.setattr(export_publish, "_rename_directory_no_replace", original)

    first_dirs = sorted(path for path in output.iterdir() if path.is_dir() and not path.name.startswith("."))
    assert len(first_dirs) == 1
    assert not (first_dirs[0] / "导出清单.json").exists()

    recovered = export_publish.publish_bundle(service, created["intent_id"], output / "does-not-exist")
    second_dirs = sorted(path for path in output.iterdir() if path.is_dir() and not path.name.startswith("."))
    assert second_dirs == first_dirs
    assert recovered["directory"] == str(first_dirs[0])
    assert recovered["include_manifest"] is False
    assert export_publish.status_bundle(service, task[2]["id"])["publication"] == recovered


def test_false_manifest_final_scope_guard_rejects_review_change_after_copy(receipt_export_task, monkeypatch):
    task = receipt_export_task()
    service = bundle(task, monkeypatch)
    request = _request(task, include_manifest=False, include_xlsx=False)
    created = service.create(request)
    register(service, created)
    service.render(created["intent_id"])

    original_copy = export_publish._copy_owned_preview
    changed = False

    def copy_then_change_review(*args, **kwargs):
        nonlocal changed
        result = original_copy(*args, **kwargs)
        if not changed:
            edit = deepcopy(task[5][0])
            edit["record_revision"] = 1
            edit.update(crop_mode="manual", manual_adjusted=True)
            edit["final_rect"]["y1"] -= 2
            with ReviewStoreV2(task[1]) as reviews:
                saved = reviews.save(edit["context_key"], task[2]["result_revision"], [edit])
            assert saved["saved_count"] == 1
            changed = True
        return result

    monkeypatch.setattr(export_publish, "_copy_owned_preview", copy_then_change_review)
    output = task[0].parent / "stale-output"
    output.mkdir()
    with pytest.raises(ExportScopeError) as caught:
        export_publish.publish_bundle(service, created["intent_id"], output)

    assert changed
    assert caught.value.code == "export_scope_stale"
    assert not [path for path in output.iterdir() if path.is_dir() and not path.name.startswith(".")]
    assert not list(output.glob("导出清单.json"))


@pytest.mark.parametrize(
    ("include_manifest", "mutation"),
    [
        pytest.param(False, "change-true", id="false-change-true"),
        pytest.param(False, "add-json", id="false-add-json"),
        pytest.param(MISSING, "remove-json", id="missing-remove-json"),
        pytest.param(MISSING, "add-false", id="missing-add-false"),
        pytest.param(True, "change-false", id="true-change-false"),
        pytest.param(True, "remove-json", id="true-remove-json"),
    ],
)
def test_compact_receipt_tampering_is_rejected(receipt_export_task, monkeypatch, include_manifest, mutation):
    task = receipt_export_task()
    service = bundle(task, monkeypatch)
    request = _request(task, include_manifest=include_manifest, include_xlsx=False)
    created = service.create(request)
    register(service, created)
    service.render(created["intent_id"])
    output = task[0].parent / "compact-output"
    output.mkdir()
    receipt = export_publish.publish_bundle(service, created["intent_id"], output)
    service.close(created["intent_id"])

    with service.journal.locked(created["intent_id"]) as record:
        changed = deepcopy(record.data)
        changed_receipt = changed["receipt"]
        if mutation in {"add-false", "change-false"}:
            changed_receipt["include_manifest"] = False
        elif mutation == "change-true":
            changed_receipt["include_manifest"] = True
        elif mutation == "add-json":
            changed_receipt["files"].append({
                "name": "导出清单.json", "kind": "json", "sha256": "0" * 64, "size_bytes": 1,
                "path": str(Path(receipt["directory"]) / "导出清单.json"),
            })
        elif mutation == "remove-json":
            changed_receipt["files"] = [
                item for item in changed_receipt["files"] if item["kind"] != "json"
            ]
        else:  # pragma: no cover - parameterized values are exhaustive
            raise AssertionError(mutation)
        record.save(changed)

    with pytest.raises(export_publish.ExportPublishError):
        export_publish.publish_bundle(service, created["intent_id"], output)
    status = export_publish.status_bundle(service, task[2]["id"])
    assert status["publication"] is None
    assert status["residuals"]


def test_direct_generation_manifest_contract_tampering_fails_on_reopen(receipt_export_task, monkeypatch):
    task = receipt_export_task()
    service = bundle(task, monkeypatch)
    created = service.create(_request(task, include_manifest=True, include_xlsx=False))

    # Produce a real latest-generation envelope before simulating a direct
    # on-disk mutation that bypasses JournalRecord.save().
    with service.journal.locked(created["intent_id"]) as record:
        changed = deepcopy(record.data)
        changed["state"] = "rendered"
        record.save(changed)
    generation = service.journal.root / f"{created['intent_id']}.1.json"
    envelope = json.loads(generation.read_text(encoding="utf-8"))
    envelope["data"]["include_manifest"] = False
    generation.write_text(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    reopened = ExportJournal(service.journal.root)
    with pytest.raises(ExportJournalIntegrityError):
        reopened.load(created["intent_id"])


@pytest.mark.parametrize("mutation", ["delete", "change"])
def test_top_level_journal_manifest_contract_is_immutable(receipt_export_task, monkeypatch, mutation):
    task = receipt_export_task()
    service = bundle(task, monkeypatch)
    created = service.create(_request(task, include_manifest=True, include_xlsx=False))

    with service.journal.locked(created["intent_id"]) as record:
        changed = deepcopy(record.data)
        if mutation == "delete":
            del changed["include_manifest"]
        else:
            changed["include_manifest"] = False
        with pytest.raises(ExportJournalError):
            record.save(changed)

    persisted = service.journal.load(created["intent_id"])
    assert persisted["include_manifest"] is True
    assert persisted["scope"]["include_manifest"] is True


@pytest.mark.parametrize("bad", [None, 0, 1, "true", [], {}], ids=["none", "zero", "one", "text", "list", "object"])
def test_scope_manifest_option_requires_exact_boolean(receipt_export_task, bad):
    task = receipt_export_task()
    request = _request(task, include_manifest=bad, include_xlsx=False)
    with pytest.raises(ExportScopeError):
        validate_scope_request(request)


def test_output_name_is_a_safe_bounded_directory_prefix(receipt_export_task, monkeypatch):
    task = receipt_export_task()
    service = bundle(task, monkeypatch)
    output_name = "x" * 120
    request = _request(task, include_manifest=False, include_xlsx=False)
    request["output_name"] = output_name
    created = service.create(request)
    register(service, created)
    service.render(created["intent_id"])

    output = task[0].parent / "named-output"
    output.mkdir()
    receipt = export_publish.publish_bundle(service, created["intent_id"], output)
    directory = Path(receipt["directory"])
    assert directory.parent == output
    assert directory.name.startswith(output_name + "_")
    assert len(directory.name.encode("utf-16-le")) // 2 <= 240
    assert "/" not in directory.name and "\\" not in directory.name
    assert not (directory / "导出清单.json").exists()
