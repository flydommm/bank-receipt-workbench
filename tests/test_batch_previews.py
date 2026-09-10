"""Isolated synthetic files exercise task-scoped preview cleanup authority."""

from copy import deepcopy
import hashlib
import os
import shutil

import pytest

from engine import batch_previews as previews
from engine.batch_models import BatchModelError
from engine.batch_store import BatchConflict, BatchStore


@pytest.fixture
def registered(tmp_path, monkeypatch):
    root = tmp_path / "export-previews"
    root.mkdir()
    registry = tmp_path / "ownership"
    registry.mkdir()
    monkeypatch.setattr(previews.exports, "EXPORT_OWNERSHIP_DIR", registry)
    source = tmp_path / "original.pdf"
    source.write_bytes(b"synthetic original; must never change")
    with BatchStore(tmp_path / "batch.sqlite3") as store:
        job = store.create_job("preview-test", [{"name": "original.pdf", "source_path": str(source)}],
                               {"include": ["fee"], "includeMode": "all", "exclude": []}, "exact", "test")
        with store._transaction() as connection:
            connection.execute("UPDATE batch_jobs SET state = 'ready_for_review' WHERE id = ?", (job["id"],))
        token = "preview-owned-000001"
        previews.register_preview(store, job["id"], token, root)
        yield store, job["id"], token, root, source


def publish(token, root):
    path = root / f"{token}.pdf"
    previews.exports._reserve_output(token, path, "pdf")
    path.write_bytes(b"%PDF-1.4 synthetic owned preview")
    previews.exports._mark_output_created(token, path, "pdf", previews.exports._file_identity(path))
    return path


def test_deletes_only_registered_owned_preview_and_retries_after_task_is_gone(registered):
    store, job_id, token, root, original = registered
    before = hashlib.sha256(original.read_bytes()).hexdigest()
    path = publish(token, root)
    unregistered = root / "preview-other-00001.pdf"
    unregistered.write_bytes(b"untouched")
    snapshot = previews.snapshot_previews(store, job_id)
    assert snapshot[0]["state"] == "owned"
    with store._transaction() as connection:
        connection.execute("DELETE FROM batch_jobs WHERE id = ?", (job_id,))
    result = previews.cleanup_previews(store, snapshot)
    assert result["complete"] and result["items"][0]["outcome"] == "deleted"
    assert not path.exists() and unregistered.read_bytes() == b"untouched"
    assert previews.cleanup_previews(store, snapshot)["items"][0]["outcome"] == "already_released"
    assert hashlib.sha256(original.read_bytes()).hexdigest() == before


def test_missing_preview_is_checked_before_registration_release(registered):
    store, job_id, _, _, _ = registered
    snapshot = previews.snapshot_previews(store, job_id)
    assert snapshot[0]["state"] == "absent"
    assert previews.cleanup_previews(store, snapshot)["items"][0]["outcome"] == "absent"
    assert previews.snapshot_previews(store, job_id) == []


def test_foreign_file_created_after_absent_plan_is_retained(registered):
    store, job_id, token, root, _ = registered
    snapshot = previews.snapshot_previews(store, job_id)
    path = root / f"{token}.pdf"
    path.write_bytes(b"foreign original")
    assert not previews.cleanup_previews(store, snapshot)["complete"]
    assert path.read_bytes() == b"foreign original"


def test_replacement_after_plan_is_not_removed(registered):
    store, job_id, token, root, _ = registered
    path = publish(token, root)
    snapshot = previews.snapshot_previews(store, job_id)
    path.write_bytes(b"foreign replacement")
    result = previews.cleanup_previews(store, snapshot)
    assert not result["complete"] and result["residuals"][0]["outcome"] == "identity_mismatch"
    assert path.read_bytes() == b"foreign replacement"


@pytest.mark.skipif(os.name != "nt", reason="managed preview cleanup uses a Windows handle boundary")
def test_root_replacement_junction_race_cannot_move_owned_preview_outside(registered, monkeypatch, tmp_path):
    store, job_id, token, root, _ = registered
    path = publish(token, root)
    snapshot = previews.snapshot_previews(store, job_id)
    moved_root = tmp_path / "outside-cache" / "export-previews"
    moved_root.parent.mkdir()
    rename_errors = []
    junction_created = False
    unlink = previews.exports._unlink_owned_file

    def racing_unlink(candidate, identity, **kwargs):
        nonlocal junction_created
        try:
            root.rename(moved_root)
        except OSError as error:
            rename_errors.append(error)
        else:
            import _winapi

            _winapi.CreateJunction(str(moved_root), str(root))
            junction_created = True
        return unlink(candidate, identity, **kwargs)

    monkeypatch.setattr(previews.exports, "_unlink_owned_file", racing_unlink)
    try:
        result = previews.cleanup_previews(store, snapshot)
    finally:
        if junction_created:
            # A junction is a directory entry; rmdir removes only that entry
            # and never recursively traverses the target directory.
            os.rmdir(root)
        if moved_root.exists():
            shutil.rmtree(moved_root)

    assert rename_errors and isinstance(rename_errors[0], PermissionError)
    assert result["complete"] and result["items"][0]["outcome"] == "deleted"
    assert not path.exists()


@pytest.mark.skipif(os.name != "nt", reason="Windows junction boundary")
def test_ancestor_moved_and_replaced_by_junction_cannot_reanchor_registered_root(registered, tmp_path):
    import _winapi

    store, job_id, _, _, source = registered
    managed = tmp_path / "managed-cache"
    root = managed / "export-previews"
    root.mkdir(parents=True)
    token = "preview-ancestor-000001"
    previews.register_preview(store, job_id, token, root)
    publish(token, root)
    snapshot = previews.snapshot_previews(store, job_id)
    original = source.read_bytes()
    outside = tmp_path / "outside-cache"
    managed.rename(outside)
    _winapi.CreateJunction(str(outside), str(managed))
    try:
        result = previews.cleanup_previews(store, snapshot)
        assert not result["complete"]
        assert any(item["token"] == token and item["outcome"] == "unverified" for item in result["residuals"])
        assert (outside / "export-previews" / f"{token}.pdf").read_bytes() == b"%PDF-1.4 synthetic owned preview"
        assert store.connection.execute("SELECT 1 FROM batch_preview_owners WHERE token = ?", (token,)).fetchone()
        assert source.read_bytes() == original
    finally:
        os.rmdir(managed)  # Only remove this synthetic junction, never its target.


def test_replacing_root_with_another_ordinary_directory_is_residual(registered, tmp_path):
    store, job_id, token, root, _ = registered
    path = publish(token, root)
    snapshot = previews.snapshot_previews(store, job_id)
    original_root = tmp_path / "moved-original" / "export-previews"
    original_root.parent.mkdir()
    replacement_root = tmp_path / "replacement" / "export-previews"
    replacement_root.mkdir(parents=True)
    replacement_path = replacement_root / f"{token}.pdf"
    replacement_path.write_bytes(b"foreign root replacement")

    root.rename(original_root)
    replacement_root.rename(root)
    result = previews.cleanup_previews(store, snapshot)

    assert not result["complete"] and result["residuals"][0]["outcome"] == "unverified"
    assert path.read_bytes() == b"foreign root replacement"
    assert (original_root / f"{token}.pdf").read_bytes() == b"%PDF-1.4 synthetic owned preview"


def test_shared_root_deletes_only_the_selected_job_preview(registered):
    store, job_id, token, root, source = registered
    other_job = store.create_job(
        "preview-shared-root",
        [{"name": "original.pdf", "source_path": str(source)}],
        {"include": ["fee"], "includeMode": "all", "exclude": []},
        "exact",
        "test",
    )
    with store._transaction() as connection:
        connection.execute(
            "UPDATE batch_jobs SET state = 'ready_for_review' WHERE id = ?",
            (other_job["id"],),
        )
    other_token = "preview-shared-000002"
    previews.register_preview(store, other_job["id"], other_token, root)
    selected_path = publish(token, root)
    shared_path = publish(other_token, root)
    snapshot = previews.snapshot_previews(store, job_id)

    result = previews.cleanup_previews(store, snapshot)

    assert result["complete"] and result["items"][0]["outcome"] == "deleted"
    assert not selected_path.exists()
    assert shared_path.read_bytes() == b"%PDF-1.4 synthetic owned preview"
    assert previews.snapshot_previews(store, other_job["id"])[0]["state"] == "owned"


@pytest.mark.skipif(os.name != "nt", reason="final-path parent validation is Windows-specific")
def test_unlink_rejects_a_final_parent_mismatch(registered, tmp_path):
    store, job_id, token, root, _ = registered
    path = publish(token, root)
    snapshot = previews.snapshot_previews(store, job_id)
    other_root = tmp_path / "other-root"
    other_root.mkdir()

    outcome = previews.exports._unlink_owned_file(
        path,
        snapshot[0]["identity"],
        expected_parent=other_root,
    )

    assert outcome is previews.exports._UnlinkOutcome.IDENTITY_MISMATCH
    assert path.exists()


def test_root_and_cross_job_identity_cannot_be_substituted(registered, tmp_path):
    store, job_id, token, root, _ = registered
    path = publish(token, root)
    snapshot = previews.snapshot_previews(store, job_id)
    forged = deepcopy(snapshot)
    forged[0]["job_id"] = "another-task"
    assert previews.cleanup_previews(store, forged)["residuals"][0]["outcome"] == "owner_mismatch"
    alternate = tmp_path / "other" / "export-previews"
    alternate.mkdir(parents=True)
    forged[0]["job_id"] = job_id
    forged[0]["root"] = str(alternate)
    assert previews.cleanup_previews(store, forged)["residuals"][0]["outcome"] == "owner_mismatch"
    assert path.exists()


def test_unverified_registry_is_residual_until_trusted_identity_available(registered, monkeypatch):
    store, job_id, token, root, _ = registered
    publish(token, root)
    original = previews.exports._owned_created_output_identity
    def unavailable(*_args):
        raise previews.exports.ExportOwnershipError("ownership_unavailable", "test")
    monkeypatch.setattr(previews.exports, "_owned_created_output_identity", unavailable)
    snapshot = previews.snapshot_previews(store, job_id)
    assert snapshot[0]["state"] == "unverified"
    assert not previews.cleanup_previews(store, snapshot)["complete"]
    monkeypatch.setattr(previews.exports, "_owned_created_output_identity", original)
    assert previews.cleanup_previews(store, snapshot)["complete"]


def test_failed_unlink_remains_retryable(registered, monkeypatch):
    store, job_id, token, root, _ = registered
    path = publish(token, root)
    snapshot = previews.snapshot_previews(store, job_id)
    unlink = previews.exports._unlink_owned_file
    monkeypatch.setattr(
        previews.exports,
        "_unlink_owned_file",
        lambda *_, **__: previews.exports._UnlinkOutcome.RETRYABLE_FAILURE,
    )
    assert not previews.cleanup_previews(store, snapshot)["complete"]
    assert path.exists()
    monkeypatch.setattr(previews.exports, "_unlink_owned_file", unlink)
    assert previews.cleanup_previews(store, snapshot)["complete"]


def test_registration_rejects_reuse_unsafe_token_and_pending_cleanup(registered):
    store, job_id, token, root, _ = registered
    with pytest.raises(BatchConflict):
        previews.register_preview(store, job_id, token, root)
    with pytest.raises(BatchModelError):
        previews.register_preview(store, job_id, "../unsafe", root)
    with store._transaction() as connection:
        connection.execute("UPDATE batch_jobs SET deletion_pending = 1 WHERE id = ?", (job_id,))
    with pytest.raises(BatchConflict):
        previews.register_preview(store, job_id, "preview-another-00001", root)
