from __future__ import annotations

import os
from pathlib import Path

import pytest

from engine.export_directory import ExportDirectoryError, directory_identity, writable_directory


def test_directory_identity_requires_an_existing_ordinary_absolute_directory(tmp_path: Path) -> None:
    root = tmp_path / "chosen"
    root.mkdir()
    identity = directory_identity(root)

    assert identity["device"] >= 0
    assert identity["inode"] >= 0
    assert identity["resolved_path"]

    with pytest.raises(ExportDirectoryError):
        directory_identity(tmp_path / "missing")


def test_writable_directory_protects_children_and_releases_guard(tmp_path: Path) -> None:
    root = tmp_path / "chosen"
    root.mkdir()
    identity = directory_identity(root)
    temporary = root / ".temporary"
    final = root / "published"

    if os.name != "nt":
        with pytest.raises(ExportDirectoryError, match="unsupported"):
            with writable_directory(root, identity):
                pass
        return

    with writable_directory(root, identity) as protected:
        assert protected == root
        temporary.mkdir()
        (temporary / "file.txt").write_text("ok", encoding="utf-8")
        temporary.rename(final)
        # The selected parent itself remains pinned by the no-delete-sharing
        # handle while child creation and same-parent rename are allowed.
        with pytest.raises(OSError):
            root.rename(tmp_path / "replaced")

    assert final.is_dir()
    assert [item.name for item in root.iterdir()] == ["published"]


def test_writable_directory_rejects_a_different_identity(tmp_path: Path) -> None:
    root = tmp_path / "chosen"
    root.mkdir()
    identity = directory_identity(root)
    other = tmp_path / "other"
    other.mkdir()

    changed = dict(identity)
    changed["inode"] = int(identity["inode"]) + 1
    with pytest.raises(ExportDirectoryError, match="identity"):
        with writable_directory(other, changed):
            pass
