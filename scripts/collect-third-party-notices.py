#!/usr/bin/env python3
"""Collect local third-party license texts for a Windows release review.

The collector deliberately reads only local package metadata and source files.
It never downloads a package, follows a registry URL, or runs a package
manager.  The output is useful as a release input inventory; it is not a
complete binary SBOM.
"""

from __future__ import annotations

import argparse
from collections import deque
from dataclasses import dataclass, field
import hashlib
import json
from pathlib import Path
import sys
from typing import Any, Iterable
from urllib.parse import quote, urlsplit, urlunsplit


# Include the common British spelling and COPYRIGHT notices.  Some crates put
# attribution text in COPYRIGHT.md beside the actual license files.
LICENSE_PREFIXES = ("license", "licence", "notice", "copying", "copyright")
EXCLUDED_PARTS = {".git", "__pycache__", "node_modules"}
REGISTRY_INDEX_MARKERS = ("crates.io-index", "index.crates.io")


class CollectionError(RuntimeError):
    """Raised for invalid collector input, without exposing local paths."""


@dataclass
class LicenseText:
    original_relative_filename: str
    data: bytes
    origin: str
    source_url: str | None

    def public_record(self) -> dict[str, Any]:
        return {
            "original_relative_filename": self.original_relative_filename,
            "origin": self.origin,
            "bytes": len(self.data),
            "text_sha256": hashlib.sha256(self.data).hexdigest(),
            "source_url": self.source_url,
        }


@dataclass
class Component:
    component_type: str
    name: str
    version: str | None
    license_expression: str | None
    source_url: str | None
    license_files: list[LicenseText] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    upstream_commit: str | None = None

    def public_record(self) -> dict[str, Any]:
        return {
            "component_type": self.component_type,
            "name": self.name,
            "version": self.version,
            "license_expression": self.license_expression,
            "source_url": self.source_url,
            "upstream_commit": self.upstream_commit,
            "license_files": [f.public_record() for f in self.license_files],
            "missing": sorted(set(self.missing)),
        }


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise CollectionError("metadata could not be read") from exc
    if not isinstance(value, dict):
        raise CollectionError("metadata is not an object")
    return value


def _safe_url(value: Any) -> str | None:
    """Return only public HTTP(S) URLs, without credentials or local paths."""

    if isinstance(value, dict):
        value = value.get("url")
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if raw.startswith("git+"):
        raw = raw[4:]
    parsed = urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    if parsed.username or parsed.password:
        return None
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, parsed.fragment))


def _license_expression(value: dict[str, Any]) -> str | None:
    raw = value.get("license")
    if isinstance(raw, dict):
        raw = raw.get("type") or raw.get("expression")
    if isinstance(raw, list):
        parts: list[str] = []
        for item in raw:
            if isinstance(item, dict):
                item = item.get("type") or item.get("expression")
            if isinstance(item, str) and item.strip():
                parts.append(item.strip())
        raw = " OR ".join(parts)
    if not isinstance(raw, str) or not raw.strip():
        raw = value.get("license_expression")
    if not isinstance(raw, str) or not raw.strip():
        legacy = value.get("licenses")
        if isinstance(legacy, list):
            parts = []
            for item in legacy:
                if isinstance(item, dict):
                    item = item.get("type") or item.get("expression")
                if isinstance(item, str) and item.strip():
                    parts.append(item.strip())
            raw = " OR ".join(parts)
    if not isinstance(raw, str):
        return None
    expression = raw.strip()
    if not expression or expression.casefold() in {"unknown", "unlicensed"}:
        return None
    if expression.casefold().startswith("see license"):
        return None
    return expression


def _is_license_filename(name: str) -> bool:
    folded = name.casefold()
    return folded.startswith(LICENSE_PREFIXES)


def _safe_relative_name(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = Path(value)
    if candidate.anchor or candidate.drive or any(part in {"", ".", ".."} for part in candidate.parts):
        return None
    return candidate.as_posix()


def _file_source_url(metadata: Any, default: str | None) -> str | None:
    if isinstance(metadata, dict):
        return _safe_url(metadata.get("source_url") or metadata.get("source") or metadata.get("url")) or default
    return default


def _find_license_files(
    root: Path,
    *,
    origin: str,
    default_source_url: str | None,
    explicit_files: Iterable[Any] = (),
) -> tuple[list[LicenseText], bool]:
    """Read license-like files and report whether a candidate was unreadable."""

    if not root.is_dir():
        return [], False
    candidates: dict[str, Path] = {}
    for raw_name in explicit_files:
        relative = _safe_relative_name(raw_name)
        if relative is None:
            continue
        path = root / Path(relative)
        try:
            if path.is_file() and not path.is_symlink():
                candidates[relative] = path
        except OSError:
            continue
    try:
        paths = root.rglob("*")
        for path in paths:
            try:
                relative = path.relative_to(root)
                if any(part.casefold() in EXCLUDED_PARTS for part in relative.parts[:-1]):
                    continue
                if path.is_file() and not path.is_symlink() and _is_license_filename(path.name):
                    candidates[relative.as_posix()] = path
            except (OSError, ValueError):
                continue
    except OSError:
        return [], True

    files: list[LicenseText] = []
    unreadable = False
    for relative, path in sorted(candidates.items(), key=lambda item: item[0].casefold()):
        try:
            data = path.read_bytes()
        except (OSError, ValueError):
            unreadable = True
            continue
        if not data.strip():
            unreadable = True
            continue
        files.append(LicenseText(relative, data, origin, default_source_url))
    return files, unreadable


def _load_fallback(
    project_root: Path,
    name: str,
    version: str | None,
    default_source_url: str | None,
) -> tuple[list[LicenseText], list[str], str | None]:
    """Load project-provided text for a package absent from its cache."""

    fallback_root = project_root / "third-party" / "licenses" / Path(*name.split("/"))
    if not fallback_root.is_dir():
        return [], [], None

    reasons: list[str] = []
    source_metadata: dict[str, Any] | None = None
    metadata_path = fallback_root / "source.json"
    if not metadata_path.is_file():
        reasons.append("fallback_metadata")
    else:
        try:
            source_metadata = _read_json(metadata_path)
        except CollectionError:
            reasons.append("fallback_metadata")
        else:
            if str(source_metadata.get("name")) != name or str(source_metadata.get("version")) != str(version):
                reasons.append("fallback_metadata_version")
            if not isinstance(source_metadata.get("files"), list):
                reasons.append("fallback_file_manifest")

    files, unreadable = _find_license_files(
        fallback_root,
        origin="project-fallback",
        default_source_url=default_source_url,
    )
    if unreadable:
        reasons.append("license_text_unreadable")

    manifest_files: dict[str, dict[str, Any]] = {}
    if source_metadata is not None and isinstance(source_metadata.get("files"), list):
        for item in source_metadata["files"]:
            if not isinstance(item, dict):
                reasons.append("fallback_file_manifest")
                continue
            relative = _safe_relative_name(item.get("filename"))
            if relative is None or relative in manifest_files:
                reasons.append("fallback_file_manifest")
                continue
            manifest_files[relative] = item

    actual_files = {item.original_relative_filename: item for item in files}
    for relative, item in manifest_files.items():
        if relative not in actual_files:
            reasons.append("fallback_file_missing")
            continue
        expected_hash = item.get("sha256")
        actual_hash = hashlib.sha256(actual_files[relative].data).hexdigest()
        if not isinstance(expected_hash, str) or expected_hash.casefold() != actual_hash:
            reasons.append("fallback_file_hash")
        actual_files[relative].source_url = _file_source_url(item, default_source_url)
    if manifest_files and set(actual_files) - set(manifest_files):
        reasons.append("fallback_file_manifest")

    upstream_commit = None
    if source_metadata is not None and isinstance(source_metadata.get("upstream_commit"), str):
        upstream_commit = source_metadata["upstream_commit"]
    return files, reasons, upstream_commit


def _package_source_url(package: dict[str, Any], *, kind: str) -> str | None:
    name = str(package.get("name") or "")
    version = str(package.get("version") or "")
    source = package.get("source")
    if kind == "cargo":
        if isinstance(source, str) and source.startswith("registry+"):
            registry_url = source[len("registry+") :]
            if any(marker in registry_url for marker in REGISTRY_INDEX_MARKERS):
                if name and version:
                    return f"https://crates.io/api/v1/crates/{quote(name, safe='')}/{quote(version, safe='')}/download"
            return _safe_url(registry_url)
        if isinstance(source, str) and source.startswith("git+"):
            return _safe_url(source[4:])
        return _safe_url(package.get("repository"))
    repository = _safe_url(package.get("repository"))
    if repository:
        return repository
    if name and version:
        package_name = quote(name, safe="@/")
        basename = quote(name.rsplit("/", 1)[-1], safe="")
        return f"https://registry.npmjs.org/{package_name}/-/{basename}-{quote(version, safe='')}.tgz"
    return None


def _package_root(manifest_path: Any, project_root: Path) -> Path | None:
    if not isinstance(manifest_path, str) or not manifest_path:
        return None
    path = Path(manifest_path)
    if not path.is_absolute():
        path = project_root / path
    return path.parent


def _component_from_package(
    package: dict[str, Any],
    *,
    component_type: str,
    project_root: Path,
    package_root: Path | None,
    explicit_files: Iterable[Any] = (),
) -> Component:
    name = str(package.get("name") or "unknown-component")
    version_value = package.get("version")
    version = str(version_value) if version_value is not None else None
    expression = _license_expression(package)
    source_url = _package_source_url(package, kind=component_type)
    missing: list[str] = []
    if expression is None:
        missing.append("license_expression")
    if source_url is None:
        missing.append("source_url")

    files: list[LicenseText] = []
    unreadable = False
    if package_root is not None:
        files, unreadable = _find_license_files(
            package_root,
            origin="package",
            default_source_url=source_url,
            explicit_files=explicit_files,
        )
    if unreadable:
        missing.append("license_text_unreadable")

    upstream_commit = None
    if not files:
        fallback_files, fallback_missing, upstream_commit = _load_fallback(
            project_root, name, version, source_url
        )
        files = fallback_files
        missing.extend(fallback_missing)
    if not files:
        missing.append("license_text")

    return Component(
        component_type=component_type,
        name=name,
        version=version,
        license_expression=expression,
        source_url=source_url,
        license_files=files,
        missing=sorted(set(missing)),
        upstream_commit=upstream_commit,
    )


def _resolve_node_package(package_name: str, start: Path, project_root: Path) -> tuple[Path, Path] | None:
    package_path = Path(*package_name.split("/"))
    current = start
    while True:
        candidate = current / "node_modules" / package_path
        package_json = candidate / "package.json"
        if package_json.is_file():
            return package_json, candidate
        if current == project_root or current.parent == current:
            break
        current = current.parent
    return None


def _dependency_names(package_data: dict[str, Any], field_name: str) -> Iterable[str]:
    values = package_data.get(field_name)
    if not isinstance(values, dict):
        return ()
    return (name for name in values if isinstance(name, str) and name)


def _collect_frontend(project_root: Path) -> list[Component]:
    root_package_path = project_root / "package.json"
    root_package = _read_json(root_package_path)
    dependencies = root_package.get("dependencies")
    if not isinstance(dependencies, dict):
        raise CollectionError("production dependencies are missing")

    queue: deque[tuple[str, Path, bool]] = deque(
        (name, project_root, True) for name in dependencies if isinstance(name, str) and name
    )
    components: list[Component] = []
    seen: set[tuple[str, str, str]] = set()
    while queue:
        requested_name, parent_root, required = queue.popleft()
        resolved = _resolve_node_package(requested_name, parent_root, project_root)
        if resolved is None:
            if required:
                components.append(
                    Component(
                        component_type="npm",
                        name=requested_name,
                        version=None,
                        license_expression=None,
                        source_url=None,
                        missing=["package_metadata", "license_expression", "source_url", "license_text"],
                    )
                )
            continue
        package_json_path, package_root = resolved
        package_data = _read_json(package_json_path)
        actual_name = package_data.get("name")
        name = str(actual_name) if isinstance(actual_name, str) and actual_name else requested_name
        version = str(package_data.get("version") or "")
        identity = (name, version, package_root.as_posix())
        if identity in seen:
            continue
        seen.add(identity)
        component = _component_from_package(
            package_data,
            component_type="npm",
            project_root=project_root,
            package_root=package_root,
            explicit_files=(package_data.get("licenseFile"),),
        )
        if name != requested_name:
            component.missing.append("package_name_mismatch")
        components.append(component)

        for field_name, child_required in (("dependencies", True), ("optionalDependencies", False), ("peerDependencies", True)):
            for child_name in _dependency_names(package_data, field_name):
                queue.append((child_name, package_root, child_required))
    return components


def _collect_cargo(project_root: Path, metadata_path: Path) -> list[Component]:
    metadata = _read_json(metadata_path)
    packages = metadata.get("packages")
    if not isinstance(packages, list):
        raise CollectionError("cargo metadata packages are missing")
    workspace_members = {
        item for item in metadata.get("workspace_members", []) if isinstance(item, str)
    }
    components: list[Component] = []
    for package in packages:
        if not isinstance(package, dict):
            continue
        package_id = package.get("id")
        if isinstance(package_id, str) and package_id in workspace_members:
            continue
        # A source-less package under the workspace is the application itself.
        if package.get("source") is None:
            manifest_root = _package_root(package.get("manifest_path"), project_root)
            if manifest_root is not None:
                try:
                    if manifest_root.resolve().is_relative_to(project_root.resolve()):
                        continue
                except (OSError, ValueError, AttributeError):
                    pass
        component = _component_from_package(
            package,
            component_type="cargo",
            project_root=project_root,
            package_root=_package_root(package.get("manifest_path"), project_root),
            explicit_files=(package.get("license_file"),),
        )
        components.append(component)
    return components


def _aggregate(components: Iterable[Component]) -> bytes:
    output = bytearray()
    output.extend(b"Third-party license texts\n")
    output.extend(b"Generated from local package metadata; no network access was used.\n")
    output.extend(b"This is a release license inventory, not a complete binary SBOM.\n\n")
    for component in sorted(components, key=lambda item: (item.component_type, item.name.casefold(), item.version or "")):
        header = (
            f"===== {component.component_type}: {component.name}@{component.version or 'unknown'} =====\n"
            f"License expression: {component.license_expression or 'MISSING'}\n"
            f"Source URL: {component.source_url or 'MISSING'}\n"
        )
        if component.upstream_commit:
            header += f"Upstream commit: {component.upstream_commit}\n"
        output.extend(header.encode("utf-8"))
        if component.missing:
            output.extend(("Missing: " + ", ".join(sorted(set(component.missing))) + "\n").encode("utf-8"))
        if not component.license_files:
            output.extend(b"[MISSING LICENSE TEXT]\n")
        for license_file in component.license_files:
            file_header = (
                f"--- {license_file.original_relative_filename} "
                f"sha256={hashlib.sha256(license_file.data).hexdigest()} ---\n"
            )
            output.extend(file_header.encode("utf-8"))
            output.extend(license_file.data)
            if not license_file.data.endswith(b"\n"):
                output.extend(b"\n")
        output.extend(b"\n")
    return bytes(output)


def _write_outputs(output_dir: Path, components: list[Component]) -> None:
    records = [component.public_record() for component in sorted(components, key=lambda item: (item.component_type, item.name.casefold(), item.version or ""))]
    missing_components = sorted({component.name for component in components if component.missing})
    inventory = {
        "schema_version": 1,
        "generated_without_network": True,
        "release_blocked": bool(missing_components),
        "component_count": len(records),
        "license_text_count": sum(len(component.license_files) for component in components),
        "missing_components": missing_components,
        "components": records,
    }
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "third-party-inventory.json").write_text(
            json.dumps(inventory, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (output_dir / "THIRD_PARTY_LICENSES.txt").write_bytes(_aggregate(components))
    except (OSError, UnicodeError) as exc:
        raise CollectionError("output could not be written") from exc


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cargo-metadata", type=Path, required=True, help="local cargo metadata JSON")
    parser.add_argument("--output-dir", type=Path, required=True, help="directory for the two generated outputs")
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="project root containing package.json and third-party/licenses",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        project_root = args.project_root.resolve()
        cargo_metadata = args.cargo_metadata
        if not cargo_metadata.is_absolute():
            cargo_metadata = project_root / cargo_metadata
        components = _collect_frontend(project_root) + _collect_cargo(project_root, cargo_metadata)
        _write_outputs(args.output_dir, components)
    except CollectionError:
        print("third-party license collection input is invalid", file=sys.stderr)
        return 1
    except (OSError, UnicodeError, ValueError):
        print("third-party license collection failed", file=sys.stderr)
        return 1

    missing_names = sorted({component.name for component in components if component.missing})
    if missing_names:
        # Keep refusal output to component names only.  The JSON inventory has
        # sanitized relative filenames and is the place for detailed reasons.
        for name in missing_names:
            print(name, file=sys.stderr)
        return 2
    print(f"collected {len(components)} third-party components")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
