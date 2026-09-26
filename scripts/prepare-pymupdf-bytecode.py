"""Create safe, checked-hash import caches for the bundled PyMuPDF sources."""
from __future__ import annotations

import argparse
import importlib.util
import marshal
import os
from pathlib import Path, PureWindowsPath
import py_compile
import struct
import sys
import tempfile
from types import CodeType


class BytecodeError(RuntimeError):
    pass


def _is_link_or_junction(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", None)
    return path.is_symlink() or bool(is_junction and is_junction())


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _assert_no_links_to(path: Path, stop: Path) -> None:
    current = path
    while _is_within(current, stop):
        if current.exists() and _is_link_or_junction(current):
            raise BytecodeError("PyMuPDF package or bytecode path contains a link or junction.")
        if current == stop:
            return
        current = current.parent
    raise BytecodeError("PyMuPDF package path escaped the private runtime.")


def _package_sources(python_root: Path) -> list[tuple[Path, Path, str]]:
    site_packages = python_root / "Lib" / "site-packages"
    if not site_packages.is_dir() or _is_link_or_junction(site_packages):
        raise BytecodeError("Private Python site-packages directory is missing or linked.")
    _assert_no_links_to(site_packages, python_root)
    resolved_root = python_root.resolve(strict=True)
    resolved_site_packages = site_packages.resolve(strict=True)
    if not _is_within(resolved_site_packages, resolved_root):
        raise BytecodeError("Private Python site-packages resolves outside the runtime root.")

    packages: list[Path] = []
    for name in ("pymupdf", "fitz"):
        package = site_packages / name
        if not package.exists():
            if name == "pymupdf":
                raise BytecodeError("The locked PyMuPDF package is missing.")
            continue
        if not package.is_dir() or _is_link_or_junction(package):
            raise BytecodeError(f"PyMuPDF package path is not an ordinary directory: {name}.")
        if not (package / "__init__.py").is_file():
            raise BytecodeError(f"PyMuPDF package entry point is missing: {name}.")
        packages.append(package)

    targets: list[tuple[Path, Path, str]] = []
    for package in packages:
        for source in sorted(package.rglob("*.py")):
            if _is_link_or_junction(source):
                raise BytecodeError("PyMuPDF source tree contains a linked Python file.")
            if not source.is_file():
                continue
            _assert_no_links_to(source, package)
            resolved_source = source.resolve(strict=True)
            if not _is_within(resolved_source, resolved_site_packages):
                raise BytecodeError("PyMuPDF source resolves outside the private package directory.")
            relative = source.relative_to(site_packages)
            destination = Path(importlib.util.cache_from_source(str(source)))
            _assert_no_links_to(destination.parent, package)
            if not _is_within(destination.resolve(strict=False), resolved_site_packages):
                raise BytecodeError("PyMuPDF bytecode destination resolves outside site-packages.")
            # Use a stable package-relative filename so the cache never records
            # the build machine or eventual install directory in co_filename.
            dfile = relative.as_posix()
            targets.append((source, destination, dfile))

    if not targets:
        raise BytecodeError("No PyMuPDF Python sources were found.")
    return targets


def _assert_strict_cache_set(runtime_root: Path, targets: list[tuple[Path, Path, str]]) -> None:
    expected = {destination.resolve(strict=True) for _, destination, _ in targets}
    actual_files = list(runtime_root.rglob("*.pyc"))
    if any(_is_link_or_junction(path) for path in actual_files):
        raise BytecodeError("Runtime contains a linked Python bytecode cache.")
    actual = {path.resolve(strict=True) for path in actual_files}
    if actual != expected or len(actual_files) != len(expected):
        raise BytecodeError("Runtime contains missing or uncontrolled Python bytecode caches.")


def _code_filenames(code: CodeType):
    yield code.co_filename
    for constant in code.co_consts:
        if isinstance(constant, CodeType):
            yield from _code_filenames(constant)


def _validate_cache(source: Path, cache: Path, expected_filename: str) -> None:
    try:
        source_bytes = source.read_bytes()
        cache_bytes = cache.read_bytes()
    except OSError as exc:
        raise BytecodeError("PyMuPDF source or bytecode cache cannot be read.") from exc
    if len(cache_bytes) < 16 or cache_bytes[:4] != importlib.util.MAGIC_NUMBER:
        raise BytecodeError("PyMuPDF bytecode cache has an invalid Python magic header.")
    flags = struct.unpack("<I", cache_bytes[4:8])[0]
    if flags != 0b11:
        raise BytecodeError("PyMuPDF bytecode cache is not checked-hash invalidated.")
    if cache_bytes[8:16] != importlib.util.source_hash(source_bytes):
        raise BytecodeError(f"PyMuPDF bytecode cache is stale for {expected_filename}.")
    try:
        code = marshal.loads(cache_bytes[16:])
    except (EOFError, ValueError, TypeError) as exc:
        raise BytecodeError("PyMuPDF bytecode cache cannot be decoded.") from exc
    if not isinstance(code, CodeType):
        raise BytecodeError("PyMuPDF bytecode cache does not contain a code object.")
    filenames = list(_code_filenames(code))
    if not filenames or any(filename != expected_filename for filename in filenames):
        raise BytecodeError(f"PyMuPDF bytecode contains an unexpected source filename for {expected_filename}.")
    if any(Path(filename).is_absolute() or PureWindowsPath(filename).is_absolute() for filename in filenames):
        raise BytecodeError("PyMuPDF bytecode contains an absolute source filename.")


def _prepare(python_root: Path, *, strict_cache_set: bool) -> int:
    targets = _package_sources(python_root)
    runtime_root = python_root.resolve(strict=True)
    staged: list[tuple[Path, Path, str, Path]] = []
    original_bytes: dict[Path, bytes | None] = {}
    installed: list[Path] = []
    try:
        with tempfile.TemporaryDirectory(prefix=".pymupdf-bytecode-", dir=runtime_root) as temp_name:
            staging_root = Path(temp_name)
            for index, (source, destination, dfile) in enumerate(targets):
                stage_cache = staging_root / f"{index:04d}.pyc"
                py_compile.compile(
                    str(source),
                    cfile=str(stage_cache),
                    dfile=dfile,
                    doraise=True,
                    optimize=0,
                    invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH,
                )
                _validate_cache(source, stage_cache, dfile)
                staged.append((source, destination, dfile, stage_cache))

            # Compile and validate the complete package before changing any
            # import-visible cache. Roll back every replacement on a write error.
            for _, destination, _, _ in staged:
                if _is_link_or_junction(destination) or _is_link_or_junction(destination.parent):
                    raise BytecodeError("PyMuPDF bytecode destination is linked.")
                original_bytes[destination] = destination.read_bytes() if destination.is_file() else None

            try:
                for _, destination, _, stage_cache in staged:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if original_bytes[destination] == stage_cache.read_bytes():
                        continue
                    os.replace(stage_cache, destination)
                    installed.append(destination)

                for source, destination, dfile, _ in staged:
                    _validate_cache(source, destination, dfile)
            except Exception:
                for destination in reversed(installed):
                    previous = original_bytes[destination]
                    if previous is None:
                        destination.unlink(missing_ok=True)
                    else:
                        restore = staging_root / ("restore-" + destination.name)
                        restore.write_bytes(previous)
                        os.replace(restore, destination)
                raise

        if strict_cache_set:
            _assert_strict_cache_set(runtime_root, targets)
        return len(staged)
    except py_compile.PyCompileError as exc:
        raise BytecodeError("PyMuPDF source could not be compiled; no cache changes were committed.") from exc


def _verify(python_root: Path, *, strict_cache_set: bool) -> int:
    targets = _package_sources(python_root)
    runtime_root = python_root.resolve(strict=True)
    for source, destination, dfile in targets:
        if not destination.is_file() or _is_link_or_junction(destination):
            raise BytecodeError(f"PyMuPDF bytecode cache is missing or linked for {dfile}.")
        _validate_cache(source, destination, dfile)
    if strict_cache_set:
        _assert_strict_cache_set(runtime_root, targets)
    return len(targets)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-root", type=Path, required=True, help="Bundled Python root containing Lib/site-packages")
    parser.add_argument("--verify-only", action="store_true", help="Validate existing caches without changing files")
    parser.add_argument("--strict-cache-set", action="store_true", help="Reject any .pyc outside PyMuPDF and fitz")
    args = parser.parse_args()

    if args.python_root.is_symlink() or (getattr(args.python_root, "is_junction", None) and args.python_root.is_junction()):
        print("PyMuPDF bytecode preparation failed: Python root is linked.", file=sys.stderr)
        return 1
    try:
        python_root = args.python_root.resolve(strict=True)
        if not python_root.is_dir():
            raise BytecodeError("Private Python root is not a directory.")
        count = (_verify if args.verify_only else _prepare)(python_root, strict_cache_set=args.strict_cache_set)
    except (BytecodeError, OSError, ValueError) as exc:
        print(f"PyMuPDF bytecode preparation failed: {exc}", file=sys.stderr)
        return 1
    print(f"PyMuPDF bytecode {'verified' if args.verify_only else 'prepared'}: {count} source files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
