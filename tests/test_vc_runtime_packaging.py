"""Build-time CRT inputs must be complete and verified before runtime mutation."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


POWERSHELL = shutil.which('powershell.exe')
pytestmark = pytest.mark.skipif(not POWERSHELL, reason='Windows packaging script')
PROJECT = Path(__file__).resolve().parents[1]


def setup_packaging(tmp_path):
    scripts = tmp_path / 'scripts'
    scripts.mkdir()
    script = scripts / 'prepare-vc-runtime.ps1'
    shutil.copyfile(PROJECT / 'scripts' / script.name, script)
    notices = tmp_path / 'third-party'
    notices.mkdir()
    (notices / 'MSVC_RUNTIME_NOTICE.txt').write_text('CRT notice', encoding='utf-8')
    redist = tmp_path / 'redist'
    redist.mkdir()
    files = {'msvcp140.dll': b'fixture cpp', 'vcruntime140.dll': b'fixture crt'}
    for name, data in files.items():
        (redist / name).write_bytes(data)
    manifest = {'msvc_runtime': {
        'version': 'test', 'architecture': 'x64',
        'notice_file': 'MSVC_RUNTIME_NOTICE.txt',
        'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
    }}
    (scripts / 'runtime-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    runtime = tmp_path / 'runtime'
    runtime.mkdir()
    (runtime / 'python.exe').write_bytes(b'not executed')
    (runtime / 'msvcp140.dll').write_bytes(b'original runtime')
    return script, redist, runtime


def run_packaging(script, redist, runtime):
    # Windows PowerShell must discover its own modules, even when pytest was
    # started from PowerShell 7 with that host's inherited PSModulePath.
    environment = {key: value for key, value in os.environ.items()
                   if key.casefold() != 'psmodulepath'}
    return subprocess.run([
        POWERSHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script),
        '-PythonRoot', str(runtime), '-RedistDirectory', str(redist),
    ], capture_output=True, text=True, timeout=30, env=environment)


@pytest.mark.parametrize('fault', ['corrupt', 'missing'])
def test_rejects_incomplete_crt_before_overwriting_any_runtime_file(tmp_path, fault):
    script, redist, runtime = setup_packaging(tmp_path)
    if fault == 'corrupt':
        (redist / 'vcruntime140.dll').write_bytes(b'unexpected binary')
    else:
        (redist / 'vcruntime140.dll').unlink()
    result = run_packaging(script, redist, runtime)
    assert result.returncode != 0
    assert 'vcruntime140.dll' in result.stderr
    assert (runtime / 'msvcp140.dll').read_bytes() == b'original runtime'
    assert not (runtime / 'MSVC_RUNTIME_NOTICE.txt').exists()


def test_copies_verified_crt_and_notice_without_mutating_source(tmp_path):
    script, redist, runtime = setup_packaging(tmp_path)
    source_bytes = {path.name: path.read_bytes() for path in redist.iterdir()}
    result = run_packaging(script, redist, runtime)
    assert result.returncode == 0, result.stderr
    for name, data in source_bytes.items():
        assert (runtime / name).read_bytes() == data
        assert (redist / name).read_bytes() == data
    assert (runtime / 'MSVC_RUNTIME_NOTICE.txt').read_text() == 'CRT notice'
