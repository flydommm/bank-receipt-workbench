"""The release cache must be checked against source and contain no build paths."""
from __future__ import annotations

import importlib.util
import marshal
import os
from pathlib import Path, PureWindowsPath
import struct
import subprocess
import sys


PROJECT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT / "scripts" / "prepare-pymupdf-bytecode.py"


def make_runtime(root: Path) -> tuple[Path, dict[str, Path]]:
    site_packages = root / "Lib" / "site-packages"
    pymupdf = site_packages / "pymupdf"
    fitz = site_packages / "fitz"
    pymupdf.mkdir(parents=True)
    fitz.mkdir(parents=True)
    sources = {
        "init": pymupdf / "__init__.py",
        "mupdf": pymupdf / "mupdf.py",
        "utils": pymupdf / "z_utils.py",
        "fitz": fitz / "__init__.py",
    }
    sources["init"].write_text("from .mupdf import VALUE\n", encoding="utf-8")
    sources["mupdf"].write_text("VALUE = 'before'\n", encoding="utf-8")
    sources["utils"].write_text("def value():\n    return 7\n", encoding="utf-8")
    sources["fitz"].write_text("from pymupdf import VALUE\n", encoding="utf-8")
    return root, sources


def run_tool(root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--python-root", str(root), *arguments],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )


def code_filenames(code):
    yield code.co_filename
    for value in code.co_consts:
        if hasattr(value, "co_code") and hasattr(value, "co_consts"):
            yield from code_filenames(value)


def test_generates_repeatable_checked_hash_caches_without_absolute_filenames(tmp_path):
    root, sources = make_runtime(tmp_path / "private-python")

    prepared = run_tool(root, "--strict-cache-set")
    assert prepared.returncode == 0, prepared.stderr
    first = {
        name: Path(importlib.util.cache_from_source(str(source))).read_bytes()
        for name, source in sources.items()
    }

    assert run_tool(root, "--verify-only", "--strict-cache-set").returncode == 0
    assert run_tool(root, "--strict-cache-set").returncode == 0
    second = {
        name: Path(importlib.util.cache_from_source(str(source))).read_bytes()
        for name, source in sources.items()
    }
    assert first == second

    for name, source in sources.items():
        cache = first[name]
        assert cache[:4] == importlib.util.MAGIC_NUMBER
        assert struct.unpack("<I", cache[4:8])[0] == 0b11
        assert cache[8:16] == importlib.util.source_hash(source.read_bytes())
        code = marshal.loads(cache[16:])
        names = list(code_filenames(code))
        expected = source.relative_to(root / "Lib" / "site-packages").as_posix()
        assert names and set(names) == {expected}
        assert all(not Path(filename).is_absolute() for filename in names)
        assert all(not PureWindowsPath(filename).is_absolute() for filename in names)
        assert str(root).encode() not in cache


def test_stale_source_hash_is_rejected_and_interpreter_uses_changed_source(tmp_path):
    root, sources = make_runtime(tmp_path / "private-python")
    prepared = run_tool(root, "--strict-cache-set")
    assert prepared.returncode == 0, prepared.stderr

    sources["mupdf"].write_text("VALUE = 'after'\n", encoding="utf-8")
    verified = run_tool(root, "--verify-only")
    assert verified.returncode != 0
    assert "stale" in verified.stderr

    site_packages = root / "Lib" / "site-packages"
    command = (
        "import sys; "
        f"sys.path.insert(0, {str(site_packages)!r}); "
        "import pymupdf; print(pymupdf.VALUE)"
    )
    imported = subprocess.run(
        [sys.executable, "-B", "-I", "-c", command],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert imported.returncode == 0, imported.stderr
    assert imported.stdout.strip() == "after"


def test_verify_rejects_unchecked_hash_markers_missing_cache_and_extra_cache(tmp_path):
    root, sources = make_runtime(tmp_path / "private-python")
    prepared = run_tool(root, "--strict-cache-set")
    assert prepared.returncode == 0, prepared.stderr
    cache = Path(importlib.util.cache_from_source(str(sources["mupdf"])))

    unchecked = bytearray(cache.read_bytes())
    unchecked[4:8] = struct.pack("<I", 0b01)
    cache.write_bytes(unchecked)
    result = run_tool(root, "--verify-only")
    assert result.returncode != 0
    assert "checked-hash" in result.stderr

    assert run_tool(root, "--strict-cache-set").returncode == 0
    cache.unlink()
    missing = run_tool(root, "--verify-only")
    assert missing.returncode != 0
    assert "missing or linked" in missing.stderr

    assert run_tool(root, "--strict-cache-set").returncode == 0
    (root / "Lib" / "unexpected.pyc").write_bytes(b"extra")
    extra = run_tool(root, "--verify-only", "--strict-cache-set")
    assert extra.returncode != 0
    assert "uncontrolled Python bytecode" in extra.stderr


def test_compile_failure_does_not_replace_any_existing_cache(tmp_path):
    root, sources = make_runtime(tmp_path / "private-python")
    prepared = run_tool(root, "--strict-cache-set")
    assert prepared.returncode == 0, prepared.stderr
    cache_paths = {name: Path(importlib.util.cache_from_source(str(source)))
                   for name, source in sources.items()}
    before = {name: path.read_bytes() for name, path in cache_paths.items()}

    sources["mupdf"].write_text("VALUE = 'updated'\n", encoding="utf-8")
    sources["utils"].write_text("def broken(:\n", encoding="utf-8")
    failed = run_tool(root, "--strict-cache-set")
    assert failed.returncode != 0
    assert "no cache changes were committed" in failed.stderr
    assert {name: path.read_bytes() for name, path in cache_paths.items()} == before


def test_rejects_site_packages_under_a_linked_lib_directory(tmp_path):
    root = tmp_path / "private-python"
    root.mkdir()
    external_lib = tmp_path / "external-lib"
    site_packages = external_lib / "site-packages"
    (site_packages / "pymupdf").mkdir(parents=True)
    (site_packages / "pymupdf" / "__init__.py").write_text("VALUE = 1\n", encoding="utf-8")
    try:
        os.symlink(external_lib, root / "Lib", target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        import pytest
        pytest.skip(f"directory symlinks unavailable: {exc}")

    result = run_tool(root)
    assert result.returncode != 0
    assert "link or junction" in result.stderr
