"""Allowlisted local diagnostics. No raw strings, paths, hashes or images."""
from __future__ import annotations

from collections import Counter
import hashlib
import json
from pathlib import Path
import re
from uuid import uuid4

from .receipt_field_rule_application import expected_basis
from .receipt_grouping_models import GroupingConflict, GroupingValidationError, canonical_json, now_utc

ISSUE_CODES = frozenset({'no_text', 'invalid_text', 'missing_field', 'conflicting_field', 'incomplete_account',
                        'role_unresolved', 'unsupported_layout', 'source_conflict', 'rule_incompatible', 'region_out_of_bounds'})
ROLES = frozenset({'payer', 'payee', 'own', 'counterparty', 'unknown'})
STATES = frozenset({'present', 'blank', 'missing', 'ambiguous'})
FIELDS = frozenset({'name', 'account', 'bank'})
MAX_REPORT_BYTES = 128 * 1024


def _initialize(grouping):
    grouping.connection.execute('''CREATE TABLE IF NOT EXISTS receipt_grouping_diagnostic_reports (
        report_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, basis_json TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL)''')


def build_summary(items, report_id):
    issues, field_states, layouts = Counter(), Counter(), Counter()
    # Dependency IDs/versions come from program constants, never arbitrary raw diagnostics.
    from .receipt_field_readers import READER_VERSIONS
    allowed_dependencies = {**READER_VERSIONS, 'local-field-rule': '1'}
    dependencies = set()
    for item in items:
        extracted = item.get('extracted') or {}
        for dependency in extracted.get('reader_dependencies', []):
            if isinstance(dependency, dict) and allowed_dependencies.get(dependency.get('reader_id')) == dependency.get('version'):
                dependencies.add((dependency['reader_id'], dependency['version']))
        parser_issues = extracted.get('issues') if isinstance(extracted.get('issues'), list) else []
        for issue in parser_issues:
            if isinstance(issue, dict) and issue.get('code') in ISSUE_CODES:
                issues[issue['code']] += 1
        # Identity conflicts are derived from the batch profile, not parser
        # field issues. Count the controlled category without leaking either
        # profile values or the original receipt's strings.
        own_reasons = (item.get('own_decision') or {}).get('reasons', [])
        if (isinstance(own_reasons, list)
                and any(reason in {'source_bank_mismatch', 'own_company_mismatch', 'own_account_mismatch',
                                   'both_sides_match_our_account', 'own_side_conflict'}
                        for reason in own_reasons if isinstance(reason, str))
                and not any(isinstance(issue, dict) and issue.get('code') == 'source_conflict'
                            for issue in parser_issues)):
            issues['source_conflict'] += 1
        for role, key in (('payer','payer'), ('payee','payee'), ('own','own_observed'), ('counterparty','counterparty_observed')):
            party = extracted.get(key)
            if not isinstance(party, dict):
                continue
            for field in FIELDS:
                state = (party.get(field) or {}).get('state')
                if state in STATES:
                    field_states[(field, role, state)] += 1
        # Only a temporary report ordinal is emitted, never this original key.
        signature = extracted.get('layout_signature')
        layouts[signature if isinstance(signature, str) else 'unknown'] += 1
    return {'schema_version': 1, 'report_id': report_id, 'app_version': '0.1.62', 'total': len(items),
            'issues': [{'code': code, 'count': count} for code, count in sorted(issues.items())],
            'field_states': [{'field': field, 'role': role, 'state': state, 'count': count}
                             for (field, role, state), count in sorted(field_states.items())],
            'layouts': [{'layout_id': f'layout-{index + 1}', 'count': count} for index, count in enumerate(layouts.values())],
            'reader_dependencies': [{'reader_id': reader, 'version': version} for reader, version in sorted(dependencies)]}


def preview_diagnostics(grouping, header):
    _initialize(grouping)
    report_id = uuid4().hex
    summary = build_summary(grouping._load_items(grouping.connection, header['job_id']), report_id)
    payload = canonical_json(summary)
    if len(payload.encode('utf-8')) > MAX_REPORT_BYTES:
        raise GroupingValidationError('诊断摘要超过大小限制')
    grouping.connection.execute('INSERT INTO receipt_grouping_diagnostic_reports(report_id,job_id,basis_json,payload_json,created_at) VALUES (?,?,?,?,?)',
        (report_id, header['job_id'], canonical_json(expected_basis(header)), payload, now_utc()))
    return summary


def _directory(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 32768 or '\x00' in value:
        raise GroupingValidationError('请选择诊断输出目录')
    path = Path(value)
    if not path.is_absolute() or not path.is_dir():
        raise GroupingValidationError('诊断输出目录不可用')
    for part in (path, *path.parents):
        stat = part.lstat()
        if part.is_symlink() or getattr(stat, 'st_file_attributes', 0) & 0x400:
            raise GroupingValidationError('诊断输出目录不能是链接')
    return path.resolve(strict=True)


def export_diagnostics(grouping, header, report_id, directory):
    _initialize(grouping)
    if not isinstance(report_id, str) or re.fullmatch('[0-9a-f]{32}', report_id) is None:
        raise GroupingValidationError('诊断预览编号无效')
    row = grouping.connection.execute('SELECT * FROM receipt_grouping_diagnostic_reports WHERE report_id=? AND job_id=?', (report_id, header['job_id'])).fetchone()
    if row is None or json.loads(row['basis_json']) != expected_basis(header):
        raise GroupingConflict('诊断内容已变化，请重新预览')
    # Read back the exact preview; data is assembled solely by build_summary.
    payload = (json.dumps(json.loads(row['payload_json']), ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if len(payload) > MAX_REPORT_BYTES:
        raise GroupingValidationError('诊断摘要超过大小限制')
    parent = _directory(directory)
    target = parent / ('回单识别诊断_' + uuid4().hex[:12])
    target.mkdir(exist_ok=False)
    output = target / '识别诊断摘要.json'
    with output.open('xb') as stream:
        stream.write(payload)
    actual = output.read_bytes()
    if actual != payload:
        raise GroupingValidationError('诊断摘要写出后核对失败')
    return {'output_directory': str(target), 'files': [{'name': output.name, 'path': str(output),
             'bytes': len(actual), 'sha256': hashlib.sha256(actual).hexdigest()}]}
