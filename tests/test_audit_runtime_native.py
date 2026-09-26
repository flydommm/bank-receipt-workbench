from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct
import sys
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "audit-runtime-native.py"


def load_auditor():
    spec = importlib.util.spec_from_file_location("audit_runtime_native", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def write_pe(
    path: Path,
    *,
    imports: tuple[str, ...] = (),
    delay_imports: tuple[str, ...] = (),
    bits: int = 64,
    machine: int | None = None,
) -> None:
    """Write a tiny PE image with import-name tables for parser tests."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if machine is None:
        machine = 0x8664 if bits == 64 else 0x014C

    pe_offset = 0x80
    raw_offset = 0x200
    section_size = 0x1000
    optional_size = 0xF0 if bits == 64 else 0xE0
    data = bytearray(raw_offset + section_size)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, pe_offset)
    data[pe_offset : pe_offset + 4] = b"PE\0\0"
    struct.pack_into(
        "<HHIIIHH",
        data,
        pe_offset + 4,
        machine,
        1,
        0,
        0,
        0,
        optional_size,
        0x2022,
    )

    optional = pe_offset + 24
    directory_offset = 112 if bits == 64 else 96
    number_of_directories_offset = 108 if bits == 64 else 92
    struct.pack_into("<H", data, optional, 0x20B if bits == 64 else 0x10B)
    if bits == 64:
        struct.pack_into("<Q", data, optional + 24, 0x140000000)
    else:
        struct.pack_into("<I", data, optional + 28, 0x400000)
    struct.pack_into("<I", data, optional + 60, raw_offset)
    struct.pack_into("<I", data, optional + number_of_directories_offset, 16)

    def put_rva(rva: int, payload: bytes) -> None:
        start = raw_offset + (rva - 0x1000)
        data[start : start + len(payload)] = payload

    if imports:
        import_rva = 0x1100
        name_rva = 0x1400
        descriptors = bytearray()
        for name in imports:
            encoded = name.encode("ascii") + b"\0"
            descriptors.extend(struct.pack("<IIIII", 0, 0, 0, name_rva, 0))
            put_rva(name_rva, encoded)
            name_rva += len(encoded)
        descriptors.extend(bytes(20))
        put_rva(import_rva, bytes(descriptors))
        struct.pack_into(
            "<II",
            data,
            optional + directory_offset + 8,
            import_rva,
            len(descriptors),
        )

    if delay_imports:
        delay_rva = 0x1200
        name_rva = 0x1600
        descriptors = bytearray()
        for name in delay_imports:
            encoded = name.encode("ascii") + b"\0"
            # dlattrRva is set, so the name field is an RVA (not a VA).
            descriptors.extend(struct.pack("<IIIIIIII", 1, name_rva, 0, 0, 0, 0, 0, 0))
            put_rva(name_rva, encoded)
            name_rva += len(encoded)
        descriptors.extend(bytes(32))
        put_rva(delay_rva, bytes(descriptors))
        struct.pack_into(
            "<II",
            data,
            optional + directory_offset + 13 * 8,
            delay_rva,
            len(descriptors),
        )

    section_header = optional + optional_size
    struct.pack_into(
        "<8sIIIIIIHHI",
        data,
        section_header,
        b".rdata\0\0",
        section_size,
        0x1000,
        section_size,
        raw_offset,
        0,
        0,
        0,
        0,
        0x40000040,
    )
    path.write_bytes(data)


def issue_pairs(report) -> list[tuple[str, str]]:
    return [(issue.relative_path, issue.message) for issue in report.issues]


def test_parser_reads_normal_and_delay_import_names(tmp_path: Path) -> None:
    auditor = load_auditor()
    binary = tmp_path / "runtime.dll"
    write_pe(binary, imports=("MSVCP140.dll",), delay_imports=("VCRUNTIME140_1.dll",))

    image = auditor.parse_pe(binary)

    assert image.imports == ("MSVCP140.dll",)
    assert image.delay_imports == ("VCRUNTIME140_1.dll",)
    assert image.bitness == 64


def test_missing_crt_is_reported_from_transitive_binary_even_if_on_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auditor = load_auditor()
    runtime = tmp_path / "runtime"
    external = tmp_path / "path-entry"
    write_pe(runtime / "python.exe", imports=("dependency.dll",))
    write_pe(runtime / "dependency.dll", imports=("MSVCP140.dll",))
    external.mkdir()
    (external / "MSVCP140.dll").write_bytes(b"not part of runtime")
    monkeypatch.setenv("PATH", str(external))

    report = auditor.audit_runtime(runtime)

    assert any(
        path == "dependency.dll" and "MSVCP140.dll" in message and "python.exe" in message
        for path, message in issue_pairs(report)
    )


def test_delay_import_crt_must_also_be_beside_python(tmp_path: Path) -> None:
    auditor = load_auditor()
    runtime = tmp_path / "runtime"
    write_pe(runtime / "python.exe", delay_imports=("VCRUNTIME140_1.dll",))

    report = auditor.audit_runtime(runtime)

    assert any(
        path == "python.exe" and "VCRUNTIME140_1.dll" in message and "delay" in message.lower()
        for path, message in issue_pairs(report)
    )


def test_wrong_bitness_and_invalid_pe_are_reported_with_relative_paths(tmp_path: Path) -> None:
    auditor = load_auditor()
    runtime = tmp_path / "runtime"
    write_pe(runtime / "python.exe")
    write_pe(runtime / "Lib" / "wrong.pyd", bits=32)
    malformed = bytearray(64)
    malformed[:2] = b"MZ"
    struct.pack_into("<I", malformed, 0x3C, 0x80)
    (runtime / "Lib" / "bad.dll").write_bytes(malformed)

    report = auditor.audit_runtime(runtime)
    issues = issue_pairs(report)

    assert any(path == "Lib/wrong.pyd" and "32-bit" in message for path, message in issues)
    assert any(path == "Lib/bad.dll" and "PE signature" in message for path, message in issues)


def test_x64_crt_in_python_directory_satisfies_package_requirement(tmp_path: Path) -> None:
    auditor = load_auditor()
    runtime = tmp_path / "runtime"
    write_pe(runtime / "python.exe", imports=("MSVCP140.dll",))
    write_pe(runtime / "MSVCP140.dll")

    report = auditor.audit_runtime(runtime)

    assert report.issues == ()


def test_crt_in_subdirectory_is_not_treated_as_python_directory_dependency(tmp_path: Path) -> None:
    auditor = load_auditor()
    runtime = tmp_path / "runtime"
    write_pe(runtime / "python.exe", imports=("MSVCP140.dll",))
    write_pe(runtime / "nested" / "MSVCP140.dll")

    report = auditor.audit_runtime(runtime)

    assert any(
        path == "python.exe" and "MSVCP140.dll" in message for path, message in issue_pairs(report)
    )


def test_required_crt_file_must_match_x64_runtime_bitness(tmp_path: Path) -> None:
    auditor = load_auditor()
    runtime = tmp_path / "runtime"
    write_pe(runtime / "python.exe", imports=("MSVCP140.dll",))
    write_pe(runtime / "MSVCP140.dll", bits=32)

    report = auditor.audit_runtime(runtime)

    assert any(
        path == "MSVCP140.dll" and "32-bit" in message for path, message in issue_pairs(report)
    )


def test_cross_arch_pip_launcher_templates_do_not_invalidate_x64_runtime(tmp_path: Path) -> None:
    auditor = load_auditor()
    runtime = tmp_path / "runtime"
    write_pe(runtime / "python.exe")
    write_pe(runtime / "Lib" / "site-packages" / "pip" / "t32.exe", bits=32)
    write_pe(runtime / "Lib" / "site-packages" / "pip" / "t64-arm.exe", bits=64, machine=0xAA64)

    report = auditor.audit_runtime(runtime)

    assert report.issues == ()


def test_verify_loaded_accepts_crt_loaded_from_runtime_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auditor = load_auditor()
    runtime = tmp_path / "runtime"
    write_pe(runtime / "python.exe")
    write_pe(runtime / "MSVCP140.dll")
    loaded_path = runtime / "MSVCP140.dll"
    payload = {
        "pymupdf": str(runtime / "Lib" / "site-packages" / "pymupdf" / "__init__.py"),
        "loaded_crt": {"MSVCP140.dll": str(loaded_path)},
    }
    completed = SimpleNamespace(
        returncode=0,
        stdout="__RUNTIME_NATIVE_AUDIT__" + json.dumps(payload),
        stderr="",
    )
    commands: list[list[str]] = []

    def fake_run(command: list[str], **_kwargs):
        commands.append(command)
        return completed

    monkeypatch.setattr(auditor.os, "name", "nt")
    monkeypatch.setattr(auditor.subprocess, "run", fake_run)

    issues = auditor.verify_loaded_crt_paths(runtime, ("MSVCP140.dll",))

    assert issues == ()
    assert commands[0][0] == str(runtime / "python.exe")
    assert "import pymupdf" in commands[0][commands[0].index("-c") + 1]


def test_verify_loaded_rejects_crt_loaded_from_outside_runtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auditor = load_auditor()
    runtime = tmp_path / "runtime"
    system = tmp_path / "system"
    write_pe(runtime / "python.exe")
    write_pe(system / "MSVCP140.dll")
    payload = {"loaded_crt": {"MSVCP140.dll": str(system / "MSVCP140.dll")}}
    completed = SimpleNamespace(
        returncode=0,
        stdout="__RUNTIME_NATIVE_AUDIT__" + json.dumps(payload),
        stderr="",
    )

    monkeypatch.setattr(auditor.os, "name", "nt")
    monkeypatch.setattr(auditor.subprocess, "run", lambda *_args, **_kwargs: completed)

    issues = auditor.verify_loaded_crt_paths(runtime, ("MSVCP140.dll",))

    assert len(issues) == 1
    assert "MSVCP140.dll" in issues[0].message
    assert "outside the private runtime" in issues[0].message
    assert str(system / "MSVCP140.dll") in issues[0].message


def test_verify_loaded_rejects_pymupdf_import_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auditor = load_auditor()
    runtime = tmp_path / "runtime"
    write_pe(runtime / "python.exe")
    completed = SimpleNamespace(
        returncode=1,
        stdout="",
        stderr="ImportError: DLL load failed while importing pymupdf",
    )

    monkeypatch.setattr(auditor.os, "name", "nt")
    monkeypatch.setattr(auditor.subprocess, "run", lambda *_args, **_kwargs: completed)

    issues = auditor.verify_loaded_crt_paths(runtime, ("MSVCP140.dll",))

    assert len(issues) == 1
    assert "could not import pymupdf" in issues[0].message
    assert "ImportError: DLL load failed" in issues[0].message


def test_cli_reports_successful_loaded_crt_verification(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    auditor = load_auditor()
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    monkeypatch.setattr(
        auditor,
        "audit_runtime",
        lambda _root: auditor.AuditReport(65, (), ("MSVCP140.dll",)),
    )
    monkeypatch.setattr(auditor, "verify_loaded_crt_paths", lambda *_args: ())

    exit_code = auditor.main(["--runtime", str(runtime), "--verify-loaded"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Loaded CRT verification passed" in output
    assert "MSVCP140.dll" not in output
