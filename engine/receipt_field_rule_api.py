"""Host-owned field-rule operations over SHA-bound reviewed PDF fragments."""
from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path

from .receipt_field_rule_application import FieldRuleApplication, expected_basis, protected
from .receipt_grouping_api import _integer, _public_header, _public_parties, _source_heading, _string, _trusted_inputs
from .receipt_grouping_models import GroupingConflict, GroupingNotFound, GroupingSourceChanged, GroupingValidationError
from .receipt_grouping_store import GroupingStore


COMMON = {'job_id', 'result_revision', 'expected_grouping_revision', 'expected_review_fingerprint'}
FIELDS = {
    'batch_receipt_field_rule_prepare': COMMON | {'prototype_segment_id', 'mode', 'fields', 'include_resolved'},
    'batch_receipt_field_rule_step': {'job_id', 'operation_id', 'offset', 'limit'},
    'batch_receipt_field_rule_page': {'job_id', 'operation_id', 'offset', 'limit'},
    'batch_receipt_field_rule_apply': COMMON | {'operation_id', 'save_rule', 'rule_name'},
    'batch_receipt_field_rule_cancel': {'job_id', 'operation_id'},
    'batch_receipt_field_rule_undo': COMMON | {'operation_id'},
    'batch_receipt_field_rule_list': {'active_only'},
    'batch_receipt_field_rule_deactivate': {'rule_id', 'expected_revision'},
    'batch_receipt_grouping_diagnostics': COMMON,
    'batch_receipt_grouping_diagnostics_export': COMMON | {'report_id', 'directory'},
}

READ_FAILURES = {
    'source_bank_mismatch': '来源银行不同，已跳过',
    'batch_only': '这条规则仅限原批次，已跳过',
    'labels_unavailable': '没有读到稳定的字段标签，已跳过',
    'layout_mismatch': '字段版式不同，已跳过',
}


def _check_request(op, data):
    if op not in FIELDS or set(data) != FIELDS[op]:
        raise GroupingValidationError('字段读取请求无效')


def _check_header(grouping, data):
    header = grouping.header(_string(data['job_id'], '任务编号', limit=1024))
    if header['result_revision'] != data['result_revision'] or header['grouping_revision'] != _integer(data['expected_grouping_revision'], '分组版本') or header['review_fingerprint'] != data['expected_review_fingerprint']:
        raise GroupingConflict('分组结果已变化，请重新载入')
    grouping.export_snapshot(data['job_id'], expected_grouping_revision=header['grouping_revision'], expected_review_fingerprint=header['review_fingerprint'], require_complete=False)
    return header


def _read_sources(snapshot, raw_items, ids, callback):
    from .batch_pdf import open_batch_source
    from .pdf_parser import visible_page
    by_id = {item['id']: item for item in raw_items}
    if not set(ids) <= by_id.keys():
        raise GroupingConflict('试读片段不在当前审核结果中')
    results = {}
    for source in snapshot['job']['sources']:
        selected = [by_id[sid] for sid in ids if by_id[sid]['source_key'] == source['source_key']]
        if not selected:
            continue
        with open_batch_source(source['access_path'], source['sha256']) as opened:
            if opened.size_bytes != source['size_bytes'] or opened.page_count != source['page_count']:
                raise GroupingSourceChanged('来源文件已变化')
            for item in selected:
                page = visible_page(opened._document.load_page(item['source_page'] - 1))
                results[item['id']] = callback(page, item['final_rect'], item)
    return results


@contextmanager
def _hold_publish(store, grouping, snapshot, raw_items, database, *, verify_sources=True):
    # Same boundary used by review saves; never publish against a stale crop.
    from .batch_review import _validated_review_binding
    from .batch_pdf import open_batch_source
    with store.hold_review_binding(snapshot['job']):
        for source in snapshot['job']['sources'] if verify_sources else []:
            with open_batch_source(source['access_path'], source['sha256']) as opened:
                if opened.size_bytes != source['size_bytes'] or opened.page_count != source['page_count']:
                    raise GroupingSourceChanged('来源文件已变化')
        with grouping.transaction():
            _, latest = _validated_review_binding(store, snapshot, database)
            if {i['id']: i['record_revision'] for i in raw_items} != {i['id']: i['record_revision'] for i in latest['record_revisions']}:
                raise GroupingConflict('审核结果已变化，请重新试读')
            yield


def public_rule(rule):
    definition = rule.get('definition', {})
    return {'rule_id': rule['rule_id'], 'revision': rule.get('version', rule.get('revision', 1)),
            'name': rule['name'], 'bank_name': rule.get('bank_name', definition.get('bank_name', '')),
            'mode': rule.get('mode', definition.get('mode', 'direct')), 'active': bool(rule['active'])}


def dispatch_field_rules(store, op, request, database):
    data = {k: v for k, v in request.items() if k not in {'op', 'database_path', 'grouping_database_path'}}
    _check_request(op, data)
    if not Path(database).is_file():
        raise GroupingNotFound('请先进入交易对手分组')
    from .receipt_field_rule_store import FieldRuleStore
    from .receipt_field_rule_reader import compile_rule, read_rule
    with GroupingStore(database, initialize=False) as grouping:
        rules = FieldRuleStore(grouping.connection)
        rules.initialize()
        application = FieldRuleApplication(grouping)
        if op == 'batch_receipt_field_rule_list':
            if type(data['active_only']) is not bool:
                raise GroupingValidationError('规则筛选无效')
            items = rules.list(active_only=data['active_only'])
            if len(items) > 1000:
                raise GroupingValidationError('本机规则数量超过当前列表上限，请先整理规则')
            return {'items': [public_rule(rule) for rule in items]}
        if op == 'batch_receipt_field_rule_deactivate':
            with grouping.transaction():
                return public_rule(rules.deactivate(_string(data['rule_id'], '规则编号', limit=128), _integer(data['expected_revision'], '规则版本', minimum=1)))
        job_id = _string(data['job_id'], '任务编号', limit=1024)
        if op.endswith('_cancel'):
            return application.cancel(application.get(job_id, data['operation_id']))
        if op.endswith('_page'):
            operation = application.get(job_id, data['operation_id'])
            if operation['status'] in {'preparing', 'ready'}:
                application.check_current(operation)
            return application.page(operation, data['offset'], data['limit'])
        if op.endswith('_step'):
            operation = application.get(job_id, data['operation_id'])
            basis = json.loads(operation['basis_json'])
            snapshot, raw_items, review_fp = _trusted_inputs(store, job_id, basis['result_revision'], database)
            if review_fp != basis['review_fingerprint']:
                raise GroupingConflict('审核结果已变化，请重新试读')
            rows = application.next_items(operation, data['offset'], data['limit'])
            if not rows:
                return application.public(operation)
            definition = json.loads(operation['definition_json'])
            previous_fields = {row['segment_id']: json.loads(row['before_json']).get('extracted') or {} for row in rows}
            own_account = grouping.header(job_id).get('own_account') or {}
            ids = [row['segment_id'] for row in rows if not protected(json.loads(row['before_json']))]
            def read(page, rect, item):
                heading = _source_heading(page, rect)
                bank = heading['bank_name'] or definition['bank_name']
                baseline = previous_fields[item['id']]
                if definition['mode'] == 'auto':
                    from copy import deepcopy
                    from .receipt_parties import extract_receipt_parties
                    # An unextracted fragment still needs current own-side
                    # evidence. Fill gaps only; keep existing readable fields.
                    fresh = extract_receipt_parties(page, rect)
                    baseline = deepcopy(baseline)
                    for role in ('payer', 'payee', 'own_observed', 'counterparty_observed'):
                        for field, value in (fresh.get(role) or {}).items():
                            if (baseline.get(role) or {}).get(field, {}).get('state', 'missing') == 'missing':
                                if not isinstance(baseline.get(role), dict):
                                    baseline[role] = {}
                                baseline[role][field] = value
                result = read_rule(page, rect, definition, bank_name=bank, allow_batch_only=True,
                                   own_account=own_account, base_parties=baseline)
                if result['matched'] and result.get('resolved', True):
                    from .receipt_field_readers import field_layout_signature
                    from .receipt_field_rule_models import rule_digest
                    from .receipt_field_rule_reader import merge_rule_reading
                    result['parties'] = merge_rule_reading(baseline, result['parties'], definition, automatic=False,
                                                         resolved_fields=result.get('resolved_fields'))
                    signature = field_layout_signature(page, rect)
                    result['parties']['layout_signature'] = signature['fingerprint'] if signature['reliable'] else None
                    result = {**result, 'raw': {'parties': _public_parties(result['parties']),
                              'source_bank': heading, 'extraction_state': 'ready',
                              'field_rule_basis': {'definition_digest': rule_digest(definition), 'version': 1}}}
                else:
                    result = {**result, 'reason': READ_FAILURES.get(result['reason'], '无法匹配这张回单，已跳过')}
                return result
            readings = _read_sources(snapshot, raw_items, ids, read)
            with _hold_publish(store, grouping, snapshot, raw_items, database, verify_sources=False):
                return application.finish_step(operation, rows, readings)
        operation = application.get(job_id, data['operation_id']) if op.endswith(('_apply', '_undo')) else None
        if op.endswith('_apply') and operation['status'] == 'applied':
            # A lost response may be retried using the original revision. Only
            # the identical operation against its still-current result qualifies.
            basis = json.loads(operation['basis_json'])
            if (data['result_revision'] != basis['result_revision'] or
                    data['expected_review_fingerprint'] != basis['review_fingerprint'] or
                    _integer(data['expected_grouping_revision'], '分组版本') not in {basis['grouping_revision'], operation['applied_revision']}):
                raise GroupingConflict('试读版本已变化')
            header = _check_header(grouping, {**data, 'expected_grouping_revision': operation['applied_revision']})
        elif op.endswith('_undo') and operation['status'] == 'undone':
            basis = json.loads(operation['basis_json'])
            if (data['result_revision'] != basis['result_revision'] or
                    data['expected_review_fingerprint'] != basis['review_fingerprint'] or
                    _integer(data['expected_grouping_revision'], '分组版本') not in {operation['applied_revision'], operation['undone_revision']}):
                raise GroupingConflict('撤销版本已变化')
            header = _check_header(grouping, {**data, 'expected_grouping_revision': operation['undone_revision']})
        else:
            header = _check_header(grouping, data)
        snapshot, raw_items, review_fp = _trusted_inputs(store, job_id, data['result_revision'], database)
        if review_fp != header['review_fingerprint']:
            raise GroupingConflict('审核结果已变化，请重新试读')
        if op == 'batch_receipt_field_rule_prepare':
            prototype_id = _string(data['prototype_segment_id'], '示例回单编号', limit=2048)
            prototype = next((i for i in raw_items if i['id'] == prototype_id), None)
            if prototype is None or prototype['review_status'] == 'excluded' or prototype.get('document_type'):
                raise GroupingValidationError('请选择保留的普通回单设置字段')
            def compile_sample(page, rect, item):
                heading = _source_heading(page, rect)
                definition = compile_rule(page, rect, mode=data['mode'], fields=data['fields'], bank_name=heading['bank_name'] or header['own_account']['bank_name'])
                if not heading['bank_name']:
                    definition['batch_only'] = True
                return definition
            definition = _read_sources(snapshot, raw_items, [prototype_id], compile_sample)[prototype_id]
            with _hold_publish(store, grouping, snapshot, raw_items, database):
                return application.prepare(header, definition, data['include_resolved'])
        if op in {'batch_receipt_grouping_diagnostics', 'batch_receipt_grouping_diagnostics_export'}:
            from .receipt_grouping_diagnostics import preview_diagnostics, export_diagnostics
            with _hold_publish(store, grouping, snapshot, raw_items, database):
                header = _check_header(grouping, data)
                if op.endswith('_export'):
                    return export_diagnostics(grouping, header, data['report_id'], data['directory'])
                return preview_diagnostics(grouping, header)
        with _hold_publish(store, grouping, snapshot, raw_items, database):
            if op.endswith('_apply'):
                if expected_basis(header) != json.loads(operation['basis_json']) and operation['status'] != 'applied':
                    raise GroupingConflict('试读版本已变化')
                result = application.apply(operation, data['save_rule'], data['rule_name'])
            elif op.endswith('_undo'):
                result = application.undo(operation)
            else:
                raise GroupingValidationError('字段读取操作无效')
            return {**result, 'header': _public_header(result['header'])}
