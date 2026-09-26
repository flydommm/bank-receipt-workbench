#!/usr/bin/env python3
"""Audit a private Windows Python runtime's native CRT dependencies.

The audit reads PE files directly and never consults PATH to resolve imported
DLLs. CRT-family DLLs referenced by any bundled executable, DLL or extension
module must be ordinary x64 files beside python.exe.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys
from typing import Iterable, Sequence


NATIVE_EXTENSIONS = {".exe", ".dll", ".pyd"}
CRT_DLL_PATTERN = re.compile(r"^(?:MSVCP|VCRUNTIME|CONCRT|VCOMP).*\.DLL$", re.IGNORECASE)
PE_MACHINE_NAMES = {
    0x014C: "x86",
    0x01C0: "ARM",
    0x01C4: "ARMv7",
    0x8664: "x64",
    0xAA64: "ARM64",
}
AMD64_MACHINE = 0x8664
PE32_MAGIC = 0x010B
PE32_PLUS_MAGIC = 0x020B
IMAGE_DIRECTORY_ENTRY_IMPORT = 1
IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT = 13
FILE_ATTRIBUTE_REPARSE_POINT = 0x0400
MAX_IMPORT_DIRECTORY_SIZE = 16 * 1024 * 1024
MAX_IMPORT_NAME_BYTES = 4096


class PEFormatError(ValueError):
    """Raised when a PE file is truncated or internally inconsistent."""


@dataclass(frozen=True)
class PEImage:
    machine: int
    bitness: int
    imports: tuple[str, ...]
    delay_imports: tuple[str, ...]


@dataclass(frozen=True)
class AuditIssue:
    relative_path: str
    message: str


@dataclass(frozen=True)
class AuditReport:
    files_scanned: int
    issues: tuple[AuditIssue, ...]
    crt_imports: tuple[str, ...]


def _checked_slice(data: bytes, offset: int, size: int, what: str) -> bytes:
    if offset < 0 or size < 0 or offset + size > len(data):
        raise PEFormatError(f"truncated {what}")
    return data[offset : offset + size]


def _read_u16(data: bytes, offset: int, what: str) -> int:
    return struct.unpack("<H", _checked_slice(data, offset, 2, what))[0]


def _read_u32(data: bytes, offset: int, what: str) -> int:
    return struct.unpack("<I", _checked_slice(data, offset, 4, what))[0]


def _read_c_string_at_rva(
    data: bytes,
    rva: int,
    sections: Sequence[tuple[int, int, int, int]],
    size_of_headers: int,
) -> str:
    raw = bytearray()
    for offset in range(MAX_IMPORT_NAME_BYTES):
        file_offset = _rva_to_offset(rva + offset, 1, sections, size_of_headers, len(data))
        value = data[file_offset]
        if value == 0:
            try:
                return raw.decode("ascii")
            except UnicodeDecodeError as error:
                raise PEFormatError("imported DLL name is not ASCII") from error
        raw.append(value)
    raise PEFormatError("imported DLL name is not terminated")


def _rva_to_offset(
    rva: int,
    size: int,
    sections: Sequence[tuple[int, int, int, int]],
    size_of_headers: int,
    file_size: int,
) -> int:
    if rva < 0 or size < 0 or rva + size > 0x1_0000_0000:
        raise PEFormatError("invalid RVA range")
    if rva < size_of_headers:
        if rva + size > size_of_headers or rva + size > file_size:
            raise PEFormatError("RVA points beyond the PE headers")
        return rva

    for virtual_address, virtual_size, raw_offset, raw_size in sections:
        span = max(virtual_size, raw_size)
        if virtual_address <= rva < virtual_address + span:
            delta = rva - virtual_address
            if delta + size > raw_size:
                raise PEFormatError("RVA points to data not present in the file")
            offset = raw_offset + delta
            if offset + size > file_size:
                raise PEFormatError("section data is truncated")
            return offset
    raise PEFormatError(f"RVA 0x{rva:x} is outside PE sections")


def _parse_import_directory(
    data: bytes,
    directory_rva: int,
    directory_size: int,
    sections: Sequence[tuple[int, int, int, int]],
    size_of_headers: int,
    *,
    delay: bool,
    image_base: int,
) -> tuple[str, ...]:
    if directory_rva == 0 and directory_size == 0:
        return ()
    if directory_rva == 0 or directory_size == 0:
        raise PEFormatError("import directory has an incomplete RVA/size pair")
    if directory_size < (32 if delay else 20) or directory_size > MAX_IMPORT_DIRECTORY_SIZE:
        raise PEFormatError("import directory has an invalid size")

    descriptor_size = 32 if delay else 20
    entry_count = directory_size // descriptor_size
    if entry_count > 65536:
        raise PEFormatError("import directory contains too many descriptors")

    names: list[str] = []
    terminated = False
    for index in range(entry_count):
        descriptor_rva = directory_rva + index * descriptor_size
        descriptor_offset = _rva_to_offset(
            descriptor_rva,
            descriptor_size,
            sections,
            size_of_headers,
            len(data),
        )
        descriptor = data[descriptor_offset : descriptor_offset + descriptor_size]
        if not any(descriptor):
            terminated = True
            break

        if delay:
            attributes, name_value = struct.unpack_from("<II", descriptor)
            if attributes & ~1:
                raise PEFormatError("delay import has unsupported descriptor attributes")
            if attributes & 1:
                name_rva = name_value
            else:
                if name_value < image_base:
                    raise PEFormatError("delay import name VA is below the image base")
                name_rva = name_value - image_base
        else:
            name_rva = struct.unpack_from("<I", descriptor, 12)[0]

        if name_rva == 0:
            raise PEFormatError("import descriptor has no DLL name")
        name = _read_c_string_at_rva(data, name_rva, sections, size_of_headers)
        if not name or Path(name).name != name:
            raise PEFormatError("imported DLL name is empty or contains a path")
        names.append(name)

    if not terminated:
        kind = "delay import" if delay else "import"
        raise PEFormatError(f"{kind} descriptor table has no null terminator")
    return tuple(names)


def parse_pe(path: Path) -> PEImage:
    """Parse the PE machine, bitness, and normal/delay imported DLL names."""
    source = Path(path)
    try:
        data = source.read_bytes()
    except OSError as error:
        raise PEFormatError(f"cannot read PE file: {error}") from error

    if len(data) < 64 or data[:2] != b"MZ":
        raise PEFormatError("missing DOS MZ header")
    pe_offset = _read_u32(data, 0x3C, "DOS header")
    if _checked_slice(data, pe_offset, 4, "PE signature") != b"PE\0\0":
        raise PEFormatError("missing PE signature")

    coff_offset = pe_offset + 4
    machine, section_count = struct.unpack(
        "<HH", _checked_slice(data, coff_offset, 4, "COFF header")
    )
    optional_size = _read_u16(data, coff_offset + 16, "COFF header")
    if section_count > 96:
        raise PEFormatError("PE has an unreasonable number of sections")
    optional_offset = coff_offset + 20
    optional = _checked_slice(data, optional_offset, optional_size, "optional header")
    if len(optional) < 64:
        raise PEFormatError("optional header is too short")

    magic = struct.unpack_from("<H", optional, 0)[0]
    if magic == PE32_MAGIC:
        bitness = 32
        number_of_directories_offset = 92
        directory_offset = 96
        image_base = struct.unpack_from("<I", optional, 28)[0]
    elif magic == PE32_PLUS_MAGIC:
        bitness = 64
        number_of_directories_offset = 108
        directory_offset = 112
        if len(optional) < 32:
            raise PEFormatError("PE32+ optional header is too short")
        image_base = struct.unpack_from("<Q", optional, 24)[0]
    else:
        raise PEFormatError(f"unknown optional header magic 0x{magic:04x}")

    if machine == AMD64_MACHINE and bitness != 64:
        raise PEFormatError("AMD64 machine uses a non-PE32+ optional header")
    if machine == 0x014C and bitness != 32:
        raise PEFormatError("x86 machine uses a non-PE32 optional header")

    if len(optional) < number_of_directories_offset + 4:
        raise PEFormatError("optional header has no data-directory count")
    size_of_headers = struct.unpack_from("<I", optional, 60)[0]
    directory_count = struct.unpack_from("<I", optional, number_of_directories_offset)[0]
    available_directories = max(0, (len(optional) - directory_offset) // 8)
    if directory_count > available_directories:
        raise PEFormatError("optional header data directories are truncated")

    section_table_offset = optional_offset + optional_size
    sections: list[tuple[int, int, int, int]] = []
    for index in range(section_count):
        section_offset = section_table_offset + index * 40
        header = _checked_slice(data, section_offset, 40, "section table")
        virtual_size, virtual_address, raw_size, raw_offset = struct.unpack_from("<IIII", header, 8)
        sections.append((virtual_address, virtual_size, raw_offset, raw_size))

    def directory(index: int) -> tuple[int, int]:
        if directory_count <= index:
            return 0, 0
        return struct.unpack_from("<II", optional, directory_offset + index * 8)

    import_rva, import_size = directory(IMAGE_DIRECTORY_ENTRY_IMPORT)
    delay_rva, delay_size = directory(IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT)
    imports = _parse_import_directory(
        data,
        import_rva,
        import_size,
        sections,
        size_of_headers,
        delay=False,
        image_base=image_base,
    )
    delay_imports = _parse_import_directory(
        data,
        delay_rva,
        delay_size,
        sections,
        size_of_headers,
        delay=True,
        image_base=image_base,
    )
    return PEImage(machine, bitness, imports, delay_imports)


def _machine_label(machine: int, bitness: int) -> str:
    return f"{PE_MACHINE_NAMES.get(machine, f'machine 0x{machine:04x}')}, {bitness}-bit"


def _is_reparse_point(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except OSError:
        return False
    attributes = getattr(metadata, "st_file_attributes", 0)
    return path.is_symlink() or bool(attributes & FILE_ATTRIBUTE_REPARSE_POINT)


def _is_ordinary_file(path: Path) -> bool:
    if _is_reparse_point(path):
        return False
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except OSError:
        return False


def _find_direct_child_case_insensitive(directory: Path, name: str) -> Path | None:
    try:
        matches = [entry for entry in directory.iterdir() if entry.name.casefold() == name.casefold()]
    except OSError:
        return None
    if len(matches) == 1:
        return matches[0]
    return None


def _relative_path(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.name


def audit_runtime(runtime_root: Path) -> AuditReport:
    """Audit all bundled PE executables and extensions without using PATH."""
    root_input = Path(runtime_root)
    if not root_input.is_dir() or _is_reparse_point(root_input):
        raise ValueError("runtime root must be an existing ordinary directory")
    root = root_input.resolve(strict=True)

    issues: list[AuditIssue] = []
    try:
        native_files = sorted(
            (
                path
                for path in root.rglob("*")
                if path.suffix.casefold() in NATIVE_EXTENSIONS
            ),
            key=lambda path: path.relative_to(root).as_posix().casefold(),
        )
    except OSError as error:
        raise ValueError(f"could not enumerate runtime files: {error}") from error

    python_path = _find_direct_child_case_insensitive(root, "python.exe")
    python_image: PEImage | None = None
    if python_path is None or not _is_ordinary_file(python_path):
        issues.append(AuditIssue("python.exe", "runtime root must contain an ordinary python.exe"))
    else:
        try:
            python_image = parse_pe(python_path)
        except PEFormatError as error:
            issues.append(AuditIssue(_relative_path(root, python_path), str(error)))

    expected_machine: int | None = None
    if python_image is not None:
        expected_machine = python_image.machine
        if python_image.machine != AMD64_MACHINE or python_image.bitness != 64:
            issues.append(
                AuditIssue(
                    _relative_path(root, python_path),
                    "python.exe must be an x64 AMD64 (PE32+) executable; found "
                    + _machine_label(python_image.machine, python_image.bitness),
                )
            )

    crt_imports: set[str] = set()
    for binary in native_files:
        relative = _relative_path(root, binary)
        if not _is_ordinary_file(binary):
            issues.append(AuditIssue(relative, "native runtime entry is not an ordinary file"))
            continue
        try:
            image = parse_pe(binary)
        except PEFormatError as error:
            issues.append(AuditIssue(relative, str(error)))
            continue

        must_match_python_architecture = (
            binary.suffix.casefold() == ".pyd" or CRT_DLL_PATTERN.fullmatch(binary.name) is not None
        )
        if must_match_python_architecture and expected_machine is not None and (
            image.machine != expected_machine or image.bitness != python_image.bitness
        ):
            issues.append(
                AuditIssue(
                    relative,
                    f"PE architecture {_machine_label(image.machine, image.bitness)} does not match "
                    f"python.exe {_machine_label(expected_machine, python_image.bitness)}",
                )
            )

        for kind, names in (("normal import", image.imports), ("delay import", image.delay_imports)):
            for name in names:
                if not CRT_DLL_PATTERN.fullmatch(name):
                    continue
                crt_imports.add(name)
                bundled_crt = _find_direct_child_case_insensitive(root, name)
                if bundled_crt is None or not _is_ordinary_file(bundled_crt):
                    issues.append(
                        AuditIssue(
                            relative,
                            f"{kind} requires {name}, but no ordinary file with that name exists "
                            "beside python.exe; PATH and system DLLs do not satisfy the runtime package",
                        )
                    )

    return AuditReport(
        files_scanned=len(native_files),
        issues=tuple(issues),
        crt_imports=tuple(sorted(crt_imports, key=str.casefold)),
    )


_VERIFY_LOADED_SCRIPT = r'''
import ctypes
import json
from pathlib import Path
import sys

try:
    import pymupdf
except Exception as error:
    raise SystemExit(f"import pymupdf failed: {type(error).__name__}: {error}")

if sys.platform != "win32":
    raise SystemExit("loaded CRT verification requires Windows")

from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
get_module_handle = kernel32.GetModuleHandleW
get_module_handle.argtypes = [wintypes.LPCWSTR]
get_module_handle.restype = wintypes.HMODULE
get_module_filename = kernel32.GetModuleFileNameW
get_module_filename.argtypes = [wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
get_module_filename.restype = wintypes.DWORD

names = json.loads(sys.argv[1])
loaded = {}
for name in names:
    handle = get_module_handle(name)
    if not handle:
        continue
    buffer = ctypes.create_unicode_buffer(32768)
    length = get_module_filename(handle, buffer, len(buffer))
    if length == 0 or length >= len(buffer):
        raise ctypes.WinError(ctypes.get_last_error())
    loaded[name] = buffer.value

print("__RUNTIME_NATIVE_AUDIT__" + json.dumps({
    "pymupdf": str(Path(pymupdf.__file__).resolve()),
    "loaded_crt": loaded,
}, ensure_ascii=False))
'''


def _is_within_directory(path: Path, directory: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(directory.resolve(strict=True))
        return True
    except (OSError, ValueError):
        return False


def verify_loaded_crt_paths(runtime_root: Path, crt_names: Iterable[str]) -> tuple[AuditIssue, ...]:
    """Import PyMuPDF in the private interpreter and inspect loaded CRT paths."""
    if os.name != "nt":
        return (AuditIssue("python.exe", "--verify-loaded is only supported on Windows"),)

    root = Path(runtime_root).resolve(strict=True)
    python_path = _find_direct_child_case_insensitive(root, "python.exe")
    if python_path is None or not _is_ordinary_file(python_path):
        return (AuditIssue("python.exe", "cannot verify loaded DLLs: ordinary python.exe is missing"),)

    names = sorted(set(crt_names), key=str.casefold)
    if not names:
        return (AuditIssue("python.exe", "cannot verify loaded DLLs: no CRT imports were found"),)

    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.upper().startswith("PYTHON") and key.upper() != "PATH"
    }
    environment["PATH"] = str(root)
    try:
        completed = subprocess.run(
            [
                str(python_path),
                "-E",
                "-s",
                "-B",
                "-X",
                "utf8",
                "-c",
                _VERIFY_LOADED_SCRIPT,
                json.dumps(names),
            ],
            cwd=root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return (AuditIssue("python.exe", f"loaded CRT verification could not run: {error}"),)

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip().replace("\r", " ").replace("\n", " ")
        return (
            AuditIssue(
                "python.exe",
                "private runtime could not import pymupdf or inspect loaded CRT modules"
                + (f" (exit {completed.returncode}): {detail[:1200]}" if detail else ""),
            ),
        )

    marker = "__RUNTIME_NATIVE_AUDIT__"
    payload: dict[str, object] | None = None
    for line in completed.stdout.splitlines():
        if line.startswith(marker):
            try:
                payload = json.loads(line[len(marker) :])
            except json.JSONDecodeError:
                payload = None
    if not isinstance(payload, dict) or not isinstance(payload.get("loaded_crt"), dict):
        return (AuditIssue("python.exe", "private runtime returned invalid loaded-CRT data"),)

    loaded_crt = payload["loaded_crt"]
    if not loaded_crt:
        return (
            AuditIssue(
                "python.exe",
                "pymupdf imported, but none of its statically referenced CRT DLL names were loaded",
            ),
        )

    issues: list[AuditIssue] = []
    for name, raw_path in loaded_crt.items():
        if not isinstance(name, str) or not isinstance(raw_path, str):
            issues.append(AuditIssue("python.exe", "private runtime returned an invalid CRT path entry"))
            continue
        module_path = Path(raw_path)
        if not _is_within_directory(module_path, root):
            issues.append(
                AuditIssue(
                    "python.exe",
                    f"loaded {name} from outside the private runtime: {raw_path}",
                )
            )
    return tuple(issues)


def _print_report(report: AuditReport, runtime_root: Path) -> None:
    if report.issues:
        print(f"Runtime native audit failed with {len(report.issues)} issue(s):")
        for issue in report.issues:
            print(f"  {issue.relative_path}: {issue.message}")
        return
    print(
        f"Runtime native audit passed: {report.files_scanned} PE file(s), x64; "
        f"{len(report.crt_imports)} CRT import name(s) have ordinary files beside python.exe in {runtime_root}."
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True, help="root directory containing python.exe")
    parser.add_argument(
        "--verify-loaded",
        action="store_true",
        help="import pymupdf in this runtime and verify loaded CRT modules come from the runtime root",
    )
    args = parser.parse_args(argv)

    try:
        report = audit_runtime(args.runtime)
    except (OSError, ValueError) as error:
        print(f"Runtime native audit could not run: {error}", file=sys.stderr)
        return 2

    issues = list(report.issues)
    if args.verify_loaded:
        issues.extend(verify_loaded_crt_paths(args.runtime, report.crt_imports))
    final_report = AuditReport(report.files_scanned, tuple(issues), report.crt_imports)
    _print_report(final_report, args.runtime)
    if args.verify_loaded and not final_report.issues:
        print("Loaded CRT verification passed: pymupdf imported and loaded CRTs came from the runtime root.")
    return 1 if final_report.issues else 0


if __name__ == "__main__":
    raise SystemExit(main())
