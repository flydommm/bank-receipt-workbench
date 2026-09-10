"""Check publishable files without echoing potentially sensitive values.

Run inside the public preparation checkout. This is a release guard, not a
guarantee that all personal information or credentials have been identified.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    'private_key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'github_token': re.compile(r'\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b'),
    'api_token': re.compile(r'(?<![\w-])sk-(?:proj-)?[A-Za-z0-9_-]{30,}\b'),
    'aws_access_id': re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'personal_windows_path': re.compile(r'[A-Za-z]:[/\\]Users[/\\](?!Public\b|Default\b)[^\s\x22\x27]+', re.I),
}
PRIVATE_EXTENSIONS = {'.pdf', '.xlsx', '.xls', '.csv', '.db', '.sqlite', '.sqlite3', '.pfx', '.p12', '.pem', '.key'}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--deny-terms-file', type=Path, help='Optional ignored local JSON array; never commit private terms.')
    args = parser.parse_args()
    command = ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z']
    output = subprocess.run(command, cwd=ROOT, check=True, capture_output=True).stdout
    paths = sorted(set(p.decode('utf-8') for p in output.split(b'\0') if p))
    deny_terms = json.loads(args.deny_terms_file.read_text(encoding='utf-8')) if args.deny_terms_file else []
    findings = []
    for name in paths:
        path = ROOT / name
        if path.is_symlink():
            findings.append({'file': name, 'rule': 'symlink'}); continue
        if not path.is_file():
            continue
        if path.suffix.lower() in PRIVATE_EXTENSIONS or path.name == '.env' or path.name.startswith('.env.') and path.name != '.env.example':
            findings.append({'file': name, 'rule': 'private_file_type'})
        data = path.read_bytes()
        if b'\0' in data:
            if name not in {'src-tauri/icons/icon.ico', 'src-tauri/icons/icon.png'}:
                findings.append({'file': name, 'rule': 'unexpected_binary'})
            continue
        try:
            content = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            findings.append({'file': name, 'rule': 'unreviewed_encoding'}); continue
        for line_no, line in enumerate(content.splitlines(), 1):
            for rule, pattern in PATTERNS.items():
                if pattern.search(line): findings.append({'file': name, 'line': line_no, 'rule': rule})
            if any(term and term in line for term in deny_terms):
                findings.append({'file': name, 'line': line_no, 'rule': 'private_term'})
    print(json.dumps({'files_checked': len(paths), 'findings': findings}, ensure_ascii=False, indent=2))
    raise SystemExit(1 if findings else 0)


if __name__ == '__main__':
    main()
