"""Real host commands and synthetic PDF; never private receipt data."""
import json

import pymupdf
import pytest

from test_receipt_grouping_integration import grouping_task, call, prepare_and_page
from engine.batch_api import handle_batch_request
from engine.batch_store import BatchStore
from engine.receipt_grouping_api import _trusted_inputs


def common(header):
    return dict(job_id=header['job_id'], result_revision=header['result_revision'],
                expected_grouping_revision=header['grouping_revision'],
                expected_review_fingerprint=header['review_fingerprint'])


def begin(task):
    header, page = prepare_and_page(task)
    with BatchStore(task[0]) as store:
        _, raw, _ = _trusted_inputs(store, header['job_id'], header['result_revision'], task[1])
    prototype = min(raw, key=lambda r: r['final_rect']['y0'])
    item = next(i for i in page['items'] if i['binding']['segment_id'] == prototype['id'])
    crop = prototype['final_rect']
    with pymupdf.open(task[3]) as document:
        pdf_page = document[0]
        fields = []
        for role, field, value in [('payer', 'name', '合成本公司'), ('payer', 'account', '000012345678'),
                                   ('payee', 'name', '合成供应商甲')]:
            box = next(r for r in pdf_page.search_for(value) if crop['y0'] <= r.y0 and r.y1 <= crop['y1'])
            fields.append({'role': role, 'field': field, 'rect': {
                'x0': (box.x0 - .5 - crop['x0']) / (crop['x1'] - crop['x0']),
                'x1': (box.x1 + 4 - crop['x0']) / (crop['x1'] - crop['x0']),
                'y0': (box.y0 - .5 - crop['y0']) / (crop['y1'] - crop['y0']),
                'y1': (box.y1 + .5 - crop['y0']) / (crop['y1'] - crop['y0']),
            }})
    operation = call(task, 'batch_receipt_field_rule_prepare', **common(header),
                     prototype_segment_id=item['binding']['segment_id'], mode='sides', fields=fields, include_resolved=False)
    return header, page, operation, fields


def finish(task, header, operation):
    while operation['status'] == 'preparing':
        operation = call(task, 'batch_receipt_field_rule_step', job_id=header['job_id'],
                         operation_id=operation['operation_id'], offset=operation['completed'], limit=50)
    return operation


def test_host_trial_apply_retry_undo_and_reuse(grouping_task):
    task = grouping_task
    header, page, operation, fields = begin(task)
    operation = finish(task, header, operation)
    differences = call(task, 'batch_receipt_field_rule_page', job_id=header['job_id'], operation_id=operation['operation_id'], offset=0, limit=200)
    assert operation['changed'] > 0, differences
    assert operation['can_save_rule']
    # Trial is private; public grouping revision and routes remain untouched.
    before_apply = call(task, 'batch_receipt_grouping_page', **common(header), offset=0, limit=200)
    assert before_apply['items'] == page['items']
    args = {**common(header), 'operation_id': operation['operation_id'], 'save_rule': True, 'rule_name': '合成规则'}
    applied = call(task, 'batch_receipt_field_rule_apply', **args)
    assert applied['header']['grouping_revision'] == header['grouping_revision'] + 1
    assert call(task, 'batch_receipt_field_rule_apply', **args) == applied
    rules = call(task, 'batch_receipt_field_rule_list', active_only=True)['items']
    assert len(rules) == 1
    after = call(task, 'batch_receipt_grouping_page', **common(applied['header']), offset=0, limit=200)
    names = {item['group']['display_name'] for item in after['items'] if item['route'] == 'named'}
    assert '合成供应商甲' in names
    undone = call(task, 'batch_receipt_field_rule_undo', **common(applied['header']), operation_id=operation['operation_id'])
    assert call(task, 'batch_receipt_field_rule_undo', **common(applied['header']), operation_id=operation['operation_id']) == undone
    restored = call(task, 'batch_receipt_grouping_page', **common(undone['header']), offset=0, limit=200)
    assert restored['items'] == page['items']
    # Undo restores this batch; the saved rule remains explicitly manageable.
    assert len(call(task, 'batch_receipt_field_rule_list', active_only=True)['items']) == 1
    refreshed = call(task, 'batch_receipt_grouping_refresh', **common(undone['header']),
                     segment_ids=[i['binding']['segment_id'] for i in page['items']])
    assert any({'reader_id': 'local-field-rule', 'version': '1'} in i['extracted'].get('reader_dependencies', [])
               for i in refreshed['items'])
    rule = rules[0]
    disabled = call(task, 'batch_receipt_field_rule_deactivate', rule_id=rule['rule_id'], expected_revision=rule['revision'])
    assert not disabled['active']


def test_cancel_has_no_public_effect_and_review_change_rejects_apply(grouping_task):
    task = grouping_task
    header, page, operation, _ = begin(task)
    call(task, 'batch_receipt_field_rule_cancel', job_id=header['job_id'], operation_id=operation['operation_id'])
    assert call(task, 'batch_receipt_grouping_page', **common(header), offset=0, limit=200)['items'] == page['items']
    header, page, operation, _ = begin(task)
    operation = finish(task, header, operation)
    # A mismatched review version must not publish trial data.
    rejected = handle_batch_request({'op': 'batch_receipt_field_rule_apply', 'database_path': str(task[0]),
        'grouping_database_path': str(task[1]), **{**common(header), 'expected_review_fingerprint': 'wrong'},
        'operation_id': operation['operation_id'], 'save_rule': False, 'rule_name': ''})
    assert rejected['status'] == 'error'
    assert call(task, 'batch_receipt_grouping_page', **common(header), offset=0, limit=200)['items'] == page['items']


def test_diagnostics_preview_export_is_exact_and_no_original_text(grouping_task, tmp_path):
    task = grouping_task
    header, _ = prepare_and_page(task)
    preview = call(task, 'batch_receipt_grouping_diagnostics', **common(header))
    exported = call(task, 'batch_receipt_grouping_diagnostics_export', **common(header), report_id=preview['report_id'], directory=str(tmp_path))
    from pathlib import Path
    payload = Path(exported['files'][0]['path']).read_text(encoding='utf-8')
    assert json.loads(payload) == preview
    for private in ('合成本公司', '000012345678', str(task[3]), 'synthetic.pdf', 'source_sha256'):
        assert private not in payload
    assert exported['files'][0]['bytes'] == len(payload.encode('utf-8'))


def test_new_host_commands_reject_extra_evidence(grouping_task):
    task = grouping_task
    header, _ = prepare_and_page(task)
    for key in ('parties', 'extracted', 'source_path', 'raw', 'definition'):
        request = {'op': 'batch_receipt_grouping_diagnostics', 'database_path': str(task[0]),
                   'grouping_database_path': str(task[1]), **common(header), key: 'forbidden'}
        assert handle_batch_request(request)['status'] == 'error'


def test_diagnostics_export_rechecks_grouping_under_publication_lock(grouping_task, tmp_path, monkeypatch):
    from engine import receipt_field_rule_api as api
    from engine.receipt_grouping_store import GroupingStore
    task = grouping_task
    header, _ = prepare_and_page(task)
    preview = call(task, 'batch_receipt_grouping_diagnostics', **common(header))
    original_check = api._check_header
    checks = 0

    def change_after_first_check(grouping, data):
        nonlocal checks
        result = original_check(grouping, data)
        checks += 1
        if checks == 1:
            with GroupingStore(task[1], initialize=False) as other:
                with other.transaction():
                    other.connection.execute('UPDATE receipt_grouping_tasks SET grouping_revision=grouping_revision+1 WHERE job_id=?', (header['job_id'],))
        return result

    monkeypatch.setattr(api, '_check_header', change_after_first_check)
    result = handle_batch_request({'op': 'batch_receipt_grouping_diagnostics_export', 'database_path': str(task[0]),
        'grouping_database_path': str(task[1]), **common(header), 'report_id': preview['report_id'], 'directory': str(tmp_path)})
    assert result['status'] == 'error' and result['code'] == 'grouping_conflict'
    assert not list(tmp_path.glob('回单识别诊断_*'))
