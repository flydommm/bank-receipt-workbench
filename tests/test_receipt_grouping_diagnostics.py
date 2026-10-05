import json
from pathlib import Path

import pytest

from engine.receipt_grouping_diagnostics import build_summary, _directory
from engine.receipt_grouping_models import GroupingValidationError


def test_allowlist_ignores_sensitive_values_even_in_metadata():
    secret = '敏感哨兵-账号009988-金额77-日期20251231'
    field = {'raw': secret, 'value': secret, 'normalized': secret, 'state': 'present',
             'evidence': [{'label': secret, 'rect': secret}], 'candidates': [{'value': secret}], 'diagnostics': [secret]}
    party = dict(name=field, account=field, bank=field)
    item = {'source_path': secret, 'source_sha256': secret, 'file_name': secret, 'group': {'name': secret},
            '_manual': {'note': secret}, 'error': secret, 'rule_name': secret,
            'extracted': {'payer': party, 'payee': party, 'own_observed': party, 'counterparty_observed': party,
                          'layout_signature': secret, 'unknown': secret,
                          'issues': [{'code': 'missing_field', 'message': secret}, {'code': secret}],
                          'reader_dependencies': [{'reader_id': 'legacy_labels', 'version': '1'},
                                                  {'reader_id': secret, 'version': secret},
                                                  {'reader_id': 'direct_counterparty', 'version': secret}]}}
    report = build_summary([item], 'a' * 32)
    serialized = json.dumps(report, ensure_ascii=False)
    assert secret not in serialized
    assert report['issues'] == [{'code': 'missing_field', 'count': 1}]
    assert report['layouts'] == [{'layout_id': 'layout-1', 'count': 1}]
    assert report['reader_dependencies'] == [{'reader_id': 'legacy_labels', 'version': '1'}]
    assert set(report) == {'schema_version', 'report_id', 'app_version', 'total', 'issues', 'field_states', 'layouts', 'reader_dependencies'}


@pytest.mark.parametrize('path', ['', '.', '../escape', '\x00bad'])
def test_output_requires_existing_absolute_non_link_directory(path):
    with pytest.raises(GroupingValidationError):
        _directory(path)


def test_output_refuses_missing_directory(tmp_path):
    with pytest.raises(GroupingValidationError):
        _directory(str(tmp_path / 'missing'))
    assert _directory(str(tmp_path)) == tmp_path.resolve()
