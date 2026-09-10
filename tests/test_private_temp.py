from __future__ import annotations

import os
from pathlib import Path

import pytest

from engine import private_temp


def test_private_storage_root_uses_configured_private_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "managed-private"
    monkeypatch.setenv(private_temp.PRIVATE_TEMP_ENV, str(root))

    resolved = private_temp.private_storage_root()

    assert resolved == root.resolve()
    assert resolved.is_dir()


def test_private_temporary_directory_is_scoped_and_removed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "managed-private"
    monkeypatch.setenv(private_temp.PRIVATE_TEMP_ENV, str(root))

    with private_temp.private_temporary_directory("source") as directory:
        assert directory.parent == root.resolve()
        (directory / "bank.pdf").write_bytes(b"sensitive")
        assert directory.exists()

    assert root.exists()
    assert list(root.iterdir()) == []


def test_private_temporary_directory_removes_abandoned_dead_process_jobs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "managed-private"
    root.mkdir()
    abandoned = root / "job-424242-source-deadbeef"
    abandoned.mkdir()
    (abandoned / "bank.pdf").write_bytes(b"sensitive")
    active = root / f"job-{os.getpid()}-source-active"
    active.mkdir()
    (active / "keep.pdf").write_bytes(b"active")
    monkeypatch.setenv(private_temp.PRIVATE_TEMP_ENV, str(root))
    monkeypatch.setattr(
        private_temp,
        "_process_is_running",
        lambda pid: pid == os.getpid(),
    )

    with private_temp.private_temporary_directory("source"):
        assert not abandoned.exists()
        assert active.exists()

    assert active.exists()


def test_abandoned_cleanup_refuses_reparse_like_entries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "managed-private"
    root.mkdir()
    protected = root / "job-424242-source-protected"
    protected.mkdir()
    marker = protected / "bank.pdf"
    marker.write_bytes(b"sensitive")
    monkeypatch.setattr(private_temp, "_process_is_running", lambda _pid: False)
    monkeypatch.setattr(
        private_temp,
        "_is_reparse_or_symlink",
        lambda path: path == protected,
    )

    private_temp._cleanup_abandoned_jobs(root)

    assert marker.read_bytes() == b"sensitive"
