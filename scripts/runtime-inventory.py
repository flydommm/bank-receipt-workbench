"""Record bundled versions and license metadata without build machine paths."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--edition', choices=['Core', 'Ocr'], required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--lock', type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
    native_runtime = manifest['msvc_runtime']
    for name, expected_hash in native_runtime['files'].items():
        actual_hash = hashlib.sha256((args.output.parent / name).read_bytes()).hexdigest()
        if actual_hash != expected_hash:
            raise ValueError(f'Bundled Visual C++ runtime checksum mismatch: {name}')
    packages = []
    for dist in importlib.metadata.distributions():
        license_files = [str(p).replace('\\', '/') for p in (dist.files or [])
                         if (p.name.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE'))
                             or '/licenses/' in str(p).replace('\\', '/').lower())
                         and p.suffix not in {'.py', '.pyc'}
                         and dist.locate_file(p).is_file()]
        packages.append({
            'name': dist.metadata['Name'], 'version': dist.version,
            'license': dist.metadata.get('License-Expression') or dist.metadata.get('License'),
            'license_files': license_files,
        })
    data = {
        'edition': args.edition, 'python_version': platform.python_version(),
        'python_distribution': manifest['python'],
        'msvc_runtime': native_runtime,
        'dependency_lock': args.lock.name,
        'dependency_lock_sha256': hashlib.sha256(args.lock.read_bytes()).hexdigest(),
        'packages': sorted(packages, key=lambda p: p['name'].lower()),
        'ocr_models_bundled': False,
    }
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
