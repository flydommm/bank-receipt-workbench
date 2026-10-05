"""Release manifests must include the XLSX reader used outside developer installs."""
from pathlib import Path
import json
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def test_core_and_ocr_release_locks_include_the_xlsx_runtime_dependency_closure():
    requirements = (ROOT / "engine/requirements-core.txt").read_text(encoding="utf-8")
    for package, version in (("openpyxl", "3.1.5"), ("et_xmlfile", "2.0.0")):
        assert f"{package}=={version}" in requirements.splitlines()
        for edition in ("core", "ocr"):
            lock = (ROOT / f"engine/requirements-{edition}-win-x64.lock").read_text(encoding="utf-8")
            assert re.search(rf"^{package}=={re.escape(version)} --hash=sha256:[a-f0-9]{{64}}$", lock, re.M)


def test_private_runtime_smoke_runs_with_isolated_python():
    result = subprocess.run(
        [sys.executable, "-B", "-I", str(ROOT / "scripts/verify-account-import-runtime.py")],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "Private runtime XLSX account import passed." in result.stdout


def test_runtime_inventory_records_xlsx_wheel_licence_files(tmp_path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"msvc_runtime": {"files": {}}, "python": {}}), encoding="utf-8")
    output = tmp_path / "runtime-info.json"
    result = subprocess.run(
        [sys.executable, "-B", "-I", str(ROOT / "scripts/runtime-inventory.py"),
         "--output", str(output), "--edition", "Core", "--manifest", str(manifest),
         "--lock", str(ROOT / "engine/requirements-core-win-x64.lock")],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    packages = {item["name"].lower(): item for item in json.loads(output.read_text(encoding="utf-8"))["packages"]}
    for name in ("openpyxl", "et_xmlfile"):
        assert any(path.endswith("LICENCE.rst") for path in packages[name]["license_files"])
