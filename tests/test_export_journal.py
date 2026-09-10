"""Focused tests for the private bounded export intent journal."""

from __future__ import annotations

from copy import deepcopy
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import time
from uuid import uuid4

import pytest

import engine.export_journal as journal_module
from engine.export_journal import (
    ExportJournal,
    ExportJournalBusyError,
    ExportJournalConflictError,
    ExportJournalError,
    ExportJournalIntegrityError,
    ExportJournalQuotaError,
)


_REPOSITORY = Path(__file__).parents[1]


@pytest.fixture
def root(tmp_path: Path) -> Path:
    value = tmp_path / "export-intents"
    value.mkdir()
    return value


def _record(*, intent_id: str | None = None, job_id: str = "job-1", state: str = "created") -> dict[str, object]:
    return {
        "schema": 1,
        "intent_id": intent_id or str(uuid4()),
        "job_id": job_id,
        "created_at": "2026-09-08T08:00:00.000000Z",
        "state": state,
        "scope": {"selected_segment_ids": ["a", "b"], "evidence": "private"},
        "payload_path": "C:/outside/never-delete.pdf",
    }


def test_root_must_be_existing_absolute_plain_export_intents_directory(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        ExportJournal(tmp_path / "missing" / "export-intents")
    with pytest.raises(ValueError):
        ExportJournal(Path("relative") / "export-intents")
    wrong = tmp_path / "other"
    wrong.mkdir()
    with pytest.raises(ValueError):
        ExportJournal(wrong)
    plain_file = tmp_path / "file"
    plain_file.write_text("x", encoding="utf-8")
    with pytest.raises(ValueError):
        ExportJournal(plain_file)

    link = tmp_path / "export-intents"
    try:
        link.symlink_to(wrong, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("directory symlinks are unavailable on this Windows setup")
    with pytest.raises(ValueError):
        ExportJournal(link)


def test_create_locked_load_save_and_remove_keep_unknown_json_and_lock_file(root: Path) -> None:
    journal = ExportJournal(root)
    record = _record()
    journal.create(record)
    intent_id = str(record["intent_id"])
    path = root / f"{intent_id}.json"
    assert path.exists()
    assert (root / ".journal.lock").exists()

    loaded = journal.load(intent_id)
    assert loaded["scope"] == record["scope"]
    assert loaded["payload_path"] == record["payload_path"]
    with pytest.raises(FileExistsError):
        journal.create(record)

    with journal.locked(intent_id) as locked:
        assert locked.data["state"] == "created"
        locked.data["state"] = "rendered"
        locked.data["extra"] = {"kept": True}
        locked.save(locked.data)
        assert locked.data["state"] == "rendered"
        with pytest.raises(ValueError):
            locked.remove()

    with journal.locked(intent_id) as locked:
        updated = deepcopy(locked.data)
        updated["state"] = "closed"
        locked.save(updated)
        locked.remove()
        assert not path.exists()
    assert (root / ".journal.lock").exists()


def test_list_metadata_is_sorted_filtered_and_does_not_return_scope(root: Path) -> None:
    journal = ExportJournal(root)
    first = _record(job_id="job-a")
    first["created_at"] = "2026-01-02T00:00:00Z"
    second = _record(job_id="job-b")
    second["created_at"] = "2026-01-01T00:00:00Z"
    third = _record(job_id="job-a", state="published")
    third["created_at"] = "2026-01-03T00:00:00Z"
    for item in (first, second, third):
        journal.create(item)

    metadata = journal.list_metadata()
    assert [item["intent_id"] for item in metadata] == [
        str(second["intent_id"]), str(first["intent_id"]), str(third["intent_id"])
    ]
    assert all(set(item) == {"intent_id", "job_id", "created_at", "state"} for item in metadata)
    assert [item["job_id"] for item in journal.list_metadata("job-a")] == ["job-a", "job-a"]
    assert journal.list_metadata("missing") == []


def test_validation_rejects_unknown_schema_bad_uuid_and_bad_required_fields(root: Path) -> None:
    journal = ExportJournal(root)
    cases = [
        {**_record(), "schema": 2},
        {**_record(), "schema": True},
        {**_record(), "intent_id": "not-a-uuid"},
        {**_record(), "intent_id": str(uuid4()).upper()},
        {**_record(), "job_id": ""},
        {**_record(), "job_id": "x" * 1025},
        {**_record(), "created_at": ""},
        {**_record(), "state": "unknown"},
        {**_record(), "state": True},
        {"schema": 1},
    ]
    for value in cases:
        with pytest.raises(ValueError):
            journal.create(value)


def test_save_preserves_immutable_identity_fields_and_accepts_unknown_fields(root: Path) -> None:
    journal = ExportJournal(root)
    original = _record()
    journal.create(original)
    intent_id = str(original["intent_id"])
    with journal.locked(intent_id) as locked:
        for field, replacement in (
            ("schema", 2),
            ("intent_id", str(uuid4())),
            ("job_id", "other"),
            ("created_at", "2027-01-01T00:00:00Z"),
        ):
            changed = deepcopy(locked.data)
            changed[field] = replacement
            with pytest.raises(ValueError):
                locked.save(changed)
        changed = deepcopy(locked.data)
        changed["state"] = "rendered"
        changed["future_field"] = {"value": 1}
        locked.save(changed)
    assert journal.load(intent_id)["future_field"] == {"value": 1}


def test_quotas_are_checked_without_deleting_old_journals(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(journal_module, "MAX_JOURNALS", 2)
    monkeypatch.setattr(journal_module, "MAX_JOURNAL_BYTES", 600)
    monkeypatch.setattr(journal_module, "MAX_TOTAL_JOURNAL_BYTES", 1_000)
    journal = ExportJournal(root)
    first = _record()
    second = _record()
    journal.create(first)
    journal.create(second)
    old_paths = {path: path.read_bytes() for path in root.glob("*.json")}
    with pytest.raises(ExportJournalQuotaError):
        journal.create(_record())
    assert {path: path.read_bytes() for path in root.glob("*.json")} == old_paths

    # A killed writer can leave a private temporary behind.  It is excluded
    # from intent enumeration but still consumes the directory byte budget.
    monkeypatch.setattr(journal_module, "MAX_JOURNALS", 3)
    orphan_temp = root / f".{uuid4()}.orphan.tmp"
    orphan_temp.write_bytes(b"t" * 500)
    with pytest.raises(ExportJournalQuotaError):
        journal.create(_record())
    assert orphan_temp.exists()

    # A small limit lets us exercise save growth without manufacturing a huge
    # 128 MiB document.  The old document remains intact after rejection.
    monkeypatch.setattr(journal_module, "MAX_JOURNALS", 3)
    monkeypatch.setattr(journal_module, "MAX_TOTAL_JOURNAL_BYTES", 1_000)
    intent_id = str(first["intent_id"])
    path = root / f"{intent_id}.json"
    before = path.read_bytes()
    with journal.locked(intent_id) as locked:
        oversized = deepcopy(locked.data)
        oversized["large"] = "x" * 2_000
        with pytest.raises(ExportJournalQuotaError):
            locked.save(oversized)
    assert path.read_bytes() == before


def test_root_and_journal_replacement_or_symlink_are_rejected(tmp_path: Path, root: Path) -> None:
    journal = ExportJournal(root)
    item = _record()
    journal.create(item)
    intent_id = str(item["intent_id"])
    path = root / f"{intent_id}.json"

    replacement = root / "replacement.json"
    replacement.write_bytes(path.read_bytes())
    with journal.locked(intent_id) as locked:
        path.unlink()
        replacement.rename(path)
        with pytest.raises((ExportJournalIntegrityError, ExportJournalConflictError, ExportJournalError)):
            changed = deepcopy(locked.data)
            changed["state"] = "rendered"
            locked.save(changed)

    # Recreate a valid root at the same pathname after the journal captured
    # its identity.  Existing instances must fail closed and never use it.
    old_root = tmp_path / "old-export-intents"
    root.rename(old_root)
    root.mkdir()
    with pytest.raises(ExportJournalError):
        journal.list_metadata()


def test_remove_never_follows_payload_path_or_deletes_external_file(root: Path, tmp_path: Path) -> None:
    external = tmp_path / "payload.txt"
    external.write_text("keep", encoding="utf-8")
    journal = ExportJournal(root)
    item = _record(state="published")
    item["payload_path"] = str(external)
    journal.create(item)
    intent_id = str(item["intent_id"])
    with journal.locked(intent_id) as locked:
        locked.remove()
    assert external.read_text(encoding="utf-8") == "keep"


def test_atomic_save_failure_keeps_original_document(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    journal = ExportJournal(root)
    item = _record()
    journal.create(item)
    intent_id = str(item["intent_id"])
    path = root / f"{intent_id}.json"
    before = path.read_bytes()

    def fail_publish(*args: object, **kwargs: object) -> None:
        raise ExportJournalError("synthetic failure")

    # Both platforms publish a new immutable generation through this single
    # no-replace boundary.  Failing it must leave the old anchor/version
    # untouched and remove only our completed temporary file.
    monkeypatch.setattr(journal_module, "_publish_new", fail_publish)
    with journal.locked(intent_id) as locked:
        changed = deepcopy(locked.data)
        changed["state"] = "rendered"
        with pytest.raises(ExportJournalError):
            locked.save(changed)
    assert path.read_bytes() == before
    assert journal.load(intent_id)["state"] == "created"
    assert not list(root.glob(".*.tmp"))


@pytest.mark.skipif(os.name != "nt", reason="requires Windows handle sharing")
def test_save_destination_handle_blocks_final_foreign_replace(
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    journal = ExportJournal(root)
    item = _record()
    journal.create(item)
    intent_id = str(item["intent_id"])
    path = root / f"{intent_id}.json"
    before = path.read_bytes()
    next_path = root / f"{intent_id}.1.json"
    sentinel = root / "foreign-sentinel.txt"
    sentinel.write_bytes(b"foreign-save-sentinel")
    original_publish = journal_module._windows_rename_no_replace
    attempted = {"value": False}

    def race_publish(*args: object, **kwargs: object) -> None:
        attempted["value"] = True
        os.replace(sentinel, next_path)
        original_publish(*args, **kwargs)

    with journal.locked(intent_id) as locked:
        changed = deepcopy(locked.data)
        changed["state"] = "rendered"
        monkeypatch.setattr(journal_module, "_windows_rename_no_replace", race_publish)
        with pytest.raises(ExportJournalError):
            locked.save(changed)

    assert attempted == {"value": True}
    assert next_path.read_bytes() == b"foreign-save-sentinel"
    assert path.read_bytes() == before
    with pytest.raises(ExportJournalError):
        journal.load(intent_id)


def test_save_publishes_immutable_generation_and_keeps_anchor(root: Path) -> None:
    journal = ExportJournal(root)
    item = _record()
    journal.create(item)
    intent_id = str(item["intent_id"])
    anchor = root / f"{intent_id}.json"
    anchor_before = anchor.read_bytes()

    with journal.locked(intent_id) as locked:
        changed = deepcopy(locked.data)
        changed["state"] = "rendered"
        locked.save(changed)

    generation = root / f"{intent_id}.1.json"
    assert anchor.read_bytes() == anchor_before
    assert generation.exists()
    assert journal.load(intent_id)["state"] == "rendered"


def test_corrupt_latest_generation_does_not_fallback_to_anchor(root: Path) -> None:
    journal = ExportJournal(root)
    item = _record()
    journal.create(item)
    intent_id = str(item["intent_id"])
    with journal.locked(intent_id) as locked:
        changed = deepcopy(locked.data)
        changed["state"] = "publishing"
        locked.save(changed)
    (root / f"{intent_id}.1.json").write_bytes(b"{corrupt")

    with pytest.raises(ExportJournalError):
        journal.load(intent_id)


def test_published_generation_survives_interrupted_old_cleanup(
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    journal = ExportJournal(root)
    item = _record()
    journal.create(item)
    intent_id = str(item["intent_id"])
    with journal.locked(intent_id) as locked:
        changed = deepcopy(locked.data)
        changed["state"] = "rendered"
        locked.save(changed)

    def interrupt_cleanup(*args: object, **kwargs: object) -> None:
        raise RuntimeError("synthetic cleanup interruption")

    monkeypatch.setattr(journal_module, "_cleanup_old_generations", interrupt_cleanup)
    with journal.locked(intent_id) as locked:
        changed = deepcopy(locked.data)
        changed["state"] = "publishing"
        with pytest.raises(RuntimeError):
            locked.save(changed)

    assert (root / f"{intent_id}.1.json").exists()
    assert (root / f"{intent_id}.2.json").exists()
    assert ExportJournal(root).load(intent_id)["state"] == "publishing"


def test_old_generation_foreign_replacement_is_retained_after_commit(
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    journal = ExportJournal(root)
    item = _record()
    journal.create(item)
    intent_id = str(item["intent_id"])
    with journal.locked(intent_id) as locked:
        changed = deepcopy(locked.data)
        changed["state"] = "rendered"
        locked.save(changed)
    old_path = root / f"{intent_id}.1.json"
    foreign = root / "foreign-sentinel"
    foreign_data = deepcopy(changed)
    foreign_data["extra"] = "foreign"
    foreign.write_bytes(journal_module._generation_encoded(1, foreign_data))
    original_cleanup = journal_module._cleanup_old_generations

    def race_cleanup(*args: object, **kwargs: object) -> None:
        os.replace(foreign, old_path)
        original_cleanup(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(journal_module, "_cleanup_old_generations", race_cleanup)
    with journal.locked(intent_id) as locked:
        changed = deepcopy(locked.data)
        changed["state"] = "publishing"
        with pytest.raises(ExportJournalConflictError):
            locked.save(changed)

    assert old_path.read_bytes() == journal_module._generation_encoded(1, foreign_data)
    assert journal.load(intent_id)["state"] == "publishing"


def test_interrupted_remove_orphan_does_not_block_other_intents(
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    journal = ExportJournal(root)
    removed = _record(state="published")
    healthy = _record(state="created")
    journal.create(removed)
    removed_id = str(removed["intent_id"])
    journal.create(healthy)
    healthy_id = str(healthy["intent_id"])
    with journal.locked(removed_id) as locked:
        changed = deepcopy(locked.data)
        changed["state"] = "published"
        locked.save(changed)
    anchor = root / f"{removed_id}.json"
    generation = root / f"{removed_id}.1.json"
    original_remove = journal_module._remove_owned_path
    calls = {"count": 0}

    def interrupt_after_anchor(path: Path, identity: object) -> None:
        calls["count"] += 1
        original_remove(path, identity)  # type: ignore[arg-type]
        if calls["count"] == 1:
            raise RuntimeError("synthetic remove interruption")

    monkeypatch.setattr(journal_module, "_remove_owned_path", interrupt_after_anchor)
    with pytest.raises(RuntimeError):
        with journal.locked(removed_id) as locked:
            locked.remove()

    assert not anchor.exists()
    assert generation.exists()
    assert [row["intent_id"] for row in journal.list_metadata()] == [healthy_id]
    assert journal.load(healthy_id)["state"] == "created"
    journal.create(_record(state="created"))


@pytest.mark.skipif(os.name != "nt", reason="requires Windows process handles")
@pytest.mark.parametrize("phase", ["before_publish", "after_publish"])
def test_killed_save_recovers_complete_version(root: Path, phase: str) -> None:
    journal = ExportJournal(root)
    item = _record()
    journal.create(item)
    intent_id = str(item["intent_id"])
    if phase == "after_publish":
        with journal.locked(intent_id) as locked:
            changed = deepcopy(locked.data)
            changed["state"] = "rendered"
            locked.save(changed)

    helper = textwrap.dedent(
        """
        import sys
        import time
        from copy import deepcopy
        from pathlib import Path
        import engine.export_journal as module

        journal = module.ExportJournal(Path(sys.argv[1]))
        intent_id = sys.argv[2]
        phase = sys.argv[3]
        if phase == "before_publish":
            original = module._windows_rename_no_replace
            def hold(*args, **kwargs):
                print("before-publish", flush=True)
                time.sleep(30)
                return original(*args, **kwargs)
            module._windows_rename_no_replace = hold
        else:
            def hold_cleanup(*args, **kwargs):
                print("after-publish", flush=True)
                time.sleep(30)
            module._cleanup_old_generations = hold_cleanup
        with journal.locked(intent_id) as record:
            changed = deepcopy(record.data)
            changed["state"] = "rendered" if phase == "before_publish" else "publishing"
            record.save(changed)
        """
    )
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    child = subprocess.Popen(
        [sys.executable, "-E", "-s", "-X", "utf8", "-c", helper, str(root), intent_id, phase],
        cwd=_REPOSITORY,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=creationflags,
    )
    try:
        assert child.stdout is not None
        assert child.stdout.readline().strip() == ("before-publish" if phase == "before_publish" else "after-publish")
        child.kill()
        child.wait(timeout=10)
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=10)
        if child.stdout is not None:
            child.stdout.close()
        if child.stderr is not None:
            child.stderr.close()

    recovered = ExportJournal(root).load(intent_id)
    assert recovered["state"] == ("created" if phase == "before_publish" else "publishing")
    if phase == "after_publish":
        assert (root / f"{intent_id}.1.json").exists()
        assert (root / f"{intent_id}.2.json").exists()


@pytest.mark.skipif(os.name != "nt", reason="requires Windows handle sharing")
def test_remove_destination_handle_blocks_final_foreign_replace(
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    journal = ExportJournal(root)
    item = _record(state="published")
    journal.create(item)
    intent_id = str(item["intent_id"])
    path = root / f"{intent_id}.json"
    sentinel = root / "foreign-sentinel.txt"
    sentinel.write_bytes(b"foreign-remove-sentinel")
    original_delete = journal_module._windows_set_delete_disposition
    attempted = {"value": False, "blocked": False}

    def race_delete(descriptor: int) -> None:
        attempted["value"] = True
        try:
            os.replace(sentinel, path)
        except OSError:
            attempted["blocked"] = True
        original_delete(descriptor)

    monkeypatch.setattr(journal_module, "_windows_set_delete_disposition", race_delete)
    with journal.locked(intent_id) as locked:
        locked.remove()

    assert attempted == {"value": True, "blocked": True}
    assert sentinel.read_bytes() == b"foreign-remove-sentinel"
    assert not path.exists()


def test_lock_is_nonblocking_and_released_when_process_exits(root: Path) -> None:
    journal = ExportJournal(root)
    item = _record()
    journal.create(item)
    intent_id = str(item["intent_id"])
    helper = textwrap.dedent(
        """
        import sys
        import time
        from pathlib import Path
        from engine.export_journal import ExportJournal, ExportJournalBusyError

        journal = ExportJournal(Path(sys.argv[1]))
        try:
            with journal.locked(sys.argv[2]):
                print("acquired", flush=True)
                time.sleep(float(sys.argv[3]))
        except ExportJournalBusyError:
            print("busy", flush=True)
            raise SystemExit(3)
        """
    )
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    # Windows venv python.exe is a redirector: killing it can leave the real
    # interpreter holding the lock. This test must terminate the lock owner.
    interpreter = getattr(sys, "_base_executable", sys.executable) if os.name == "nt" else sys.executable
    holder = subprocess.Popen(
        [interpreter, "-E", "-s", "-X", "utf8", "-c", helper, str(root), intent_id, "30"],
        cwd=_REPOSITORY,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=creationflags,
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "acquired"
        started = time.monotonic()
        with pytest.raises(ExportJournalBusyError):
            with journal.locked(intent_id):
                pass
        assert time.monotonic() - started < 2
        holder.kill()
        holder.wait(timeout=10)
        with journal.locked(intent_id):
            pass
    finally:
        if holder.poll() is None:
            holder.kill()
        holder.wait(timeout=10)
        if holder.stdout is not None:
            holder.stdout.close()
        if holder.stderr is not None:
            holder.stderr.close()
