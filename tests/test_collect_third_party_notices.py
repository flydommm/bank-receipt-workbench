from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "collect-third-party-notices.py"


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def write_package(root: Path, name: str, package: dict[str, object], license_text: str) -> None:
    package_root = root / "node_modules" / Path(*name.split("/"))
    write_json(package_root / "package.json", package)
    (package_root / "LICENSE").write_text(license_text, encoding="utf-8")


class CollectThirdPartyNoticesTests(unittest.TestCase):
    def run_collector(self, project_root: Path, metadata: Path, output_dir: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--project-root",
                str(project_root),
                "--cargo-metadata",
                str(metadata),
                "--output-dir",
                str(output_dir),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_collects_recursive_production_packages_and_cargo_text(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            project_root = Path(temporary)
            write_json(
                project_root / "package.json",
                {
                    "name": "synthetic-app",
                    "dependencies": {
                        "react": "^1.0.0",
                        "react-dom": "^1.0.0",
                        "@tauri-apps/api": "^1.0.0",
                    },
                },
            )
            write_package(project_root, "react", {"name": "react", "version": "1.0.0", "license": "MIT"}, "react\n")
            write_package(
                project_root,
                "react-dom",
                {"name": "react-dom", "version": "1.0.0", "license": "MIT", "dependencies": {"scheduler": "^1.0.0"}},
                "react-dom\n",
            )
            write_package(
                project_root,
                "react-dom/node_modules/scheduler",
                {"name": "scheduler", "version": "1.0.0", "license": "MIT"},
                "scheduler\n",
            )
            write_package(
                project_root,
                "@tauri-apps/api",
                {"name": "@tauri-apps/api", "version": "1.0.0", "license": "Apache-2.0 OR MIT"},
                "tauri api\n",
            )

            cargo_root = project_root / "synthetic-cargo" / "fake-crate-1.2.3"
            (cargo_root / "Cargo.toml").parent.mkdir(parents=True, exist_ok=True)
            (cargo_root / "Cargo.toml").write_text("[package]\nname = \"fake-crate\"\n", encoding="utf-8")
            (cargo_root / "LICENSE-MIT").write_text("fake cargo\n", encoding="utf-8")
            metadata = project_root / "cargo-metadata.json"
            write_json(
                metadata,
                {
                    "workspace_members": ["root"],
                    "packages": [
                        {
                            "id": "root",
                            "name": "synthetic-app",
                            "version": "0.1.0",
                            "source": None,
                            "manifest_path": str(project_root / "src-tauri" / "Cargo.toml"),
                        },
                        {
                            "id": "fake",
                            "name": "fake-crate",
                            "version": "1.2.3",
                            "license": "MIT",
                            "license_file": None,
                            "source": "registry+https://github.com/rust-lang/crates.io-index",
                            "manifest_path": str(cargo_root / "Cargo.toml"),
                            "repository": "https://example.invalid/fake-crate",
                        },
                    ],
                },
            )

            with tempfile.TemporaryDirectory() as output:
                result = self.run_collector(project_root, metadata, Path(output))
                self.assertEqual(result.returncode, 0, result.stderr)
                inventory_text = (Path(output) / "third-party-inventory.json").read_text(encoding="utf-8")
                inventory = json.loads(inventory_text)
                self.assertEqual(inventory["component_count"], 5)
                self.assertEqual(inventory["license_text_count"], 5)
                self.assertEqual(inventory["missing_components"], [])
                names = {item["name"] for item in inventory["components"]}
                self.assertEqual(names, {"react", "react-dom", "scheduler", "@tauri-apps/api", "fake-crate"})
                cargo = next(item for item in inventory["components"] if item["name"] == "fake-crate")
                self.assertEqual(cargo["source_url"], "https://crates.io/api/v1/crates/fake-crate/1.2.3/download")
                aggregate = (Path(output) / "THIRD_PARTY_LICENSES.txt").read_bytes()
                self.assertIn(b"react-dom", aggregate)
                self.assertIn(b"fake cargo", aggregate)
                self.assertNotIn(str(project_root).encode(), inventory_text.encode())
                self.assertNotIn(str(project_root).encode(), aggregate)

    def test_fallback_requires_matching_version_and_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            project_root = Path(temporary)
            write_json(
                project_root / "package.json",
                {"name": "synthetic-app", "dependencies": {"fallback-package": "1.0.0"}},
            )
            write_package(
                project_root,
                "fallback-package",
                {"name": "fallback-package", "version": "1.0.0", "license": "MIT"},
                "",
            )
            (project_root / "node_modules" / "fallback-package" / "LICENSE").unlink()
            fallback_root = project_root / "third-party" / "licenses" / "fallback-package"
            (fallback_root / "LICENSE").parent.mkdir(parents=True, exist_ok=True)
            (fallback_root / "LICENSE").write_text("fallback license\n", encoding="utf-8")
            write_json(
                fallback_root / "source.json",
                {"name": "fallback-package", "version": "9.9.9", "files": [{"filename": "LICENSE"}]},
            )
            metadata = project_root / "cargo-metadata.json"
            write_json(metadata, {"workspace_members": [], "packages": []})

            with tempfile.TemporaryDirectory() as output:
                result = self.run_collector(project_root, metadata, Path(output))
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertEqual(result.stderr.strip().splitlines(), ["fallback-package"])
                inventory_text = (Path(output) / "third-party-inventory.json").read_text(encoding="utf-8")
                inventory = json.loads(inventory_text)
                self.assertEqual(inventory["missing_components"], ["fallback-package"])
                component = inventory["components"][0]
                self.assertIn("fallback_metadata_version", component["missing"])
                self.assertNotIn(str(project_root), inventory_text)

                manifest = json.loads((fallback_root / "source.json").read_text())
                manifest["version"] = "1.0.0"
                write_json(fallback_root / "source.json", manifest)
                result = self.run_collector(project_root, metadata, Path(output))
                self.assertEqual(result.returncode, 2, "a missing hash must not bypass validation")

                manifest["files"][0]["sha256"] = "0" * 64
                write_json(fallback_root / "source.json", manifest)
                result = self.run_collector(project_root, metadata, Path(output))
                self.assertEqual(result.returncode, 2, "a mismatched hash must block release")

                manifest["files"][0]["sha256"] = hashlib.sha256((fallback_root / "LICENSE").read_bytes()).hexdigest()
                write_json(fallback_root / "source.json", manifest)
                result = self.run_collector(project_root, metadata, Path(output))
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
