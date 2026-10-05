"""Private, bounded rule trials; computing never publishes grouping changes."""
from __future__ import annotations

from copy import deepcopy
import json
from uuid import uuid4

from .receipt_grouping_models import GroupingConflict, GroupingNotFound, GroupingValidationError, canonical_json, now_utc
from .receipt_grouping_store import _require_current_grouping_version, _sync_persisted_group_labels, stamp_extraction_dependencies
from .receipt_field_rule_models import validate_rule


SCHEMA = (
    """CREATE TABLE IF NOT EXISTS receipt_field_rule_operations (
        operation_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL,
        basis_json TEXT NOT NULL, definition_json TEXT NOT NULL, total INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0, applied_revision INTEGER, undone_revision INTEGER, rule_id TEXT, apply_intent_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS receipt_field_rule_operation_items (
        operation_id TEXT NOT NULL, ordinal INTEGER NOT NULL, segment_id TEXT NOT NULL,
        before_json TEXT NOT NULL, after_json TEXT, summary_json TEXT,
        PRIMARY KEY(operation_id, ordinal), UNIQUE(operation_id, segment_id))""",
    "CREATE INDEX IF NOT EXISTS idx_field_operations_job ON receipt_field_rule_operations(job_id, created_at)",
)


def expected_basis(header):
    return {**{key: header[key] for key in ('job_id', 'result_revision', 'grouping_revision', 'review_fingerprint', 'basis_fingerprint')},
            'own_account_fingerprint': (header.get('own_account') or {}).get('fingerprint')}


def _task_basis(task):
    return {key: task[key] for key in ('job_id', 'result_revision', 'grouping_revision', 'review_fingerprint',
                                      'basis_fingerprint', 'own_account_fingerprint')}


def _name(item):
    party = item.get('counterparty') or {}
    name = party.get('name') or {}
    return str(name.get('value') or name.get('normalized') or '')[:256]


def protected(item):
    return bool(item.get('_manual')) or item.get('route') in {'excluded', 'special'}


class FieldRuleApplication:
    def __init__(self, grouping):
        self.grouping = grouping
        self.connection = grouping.connection
        for statement in SCHEMA:
            self.connection.execute(statement)
        columns = {row[1] for row in self.connection.execute('PRAGMA table_info(receipt_field_rule_operations)')}
        if 'apply_intent_json' not in columns:
            self.connection.execute('ALTER TABLE receipt_field_rule_operations ADD COLUMN apply_intent_json TEXT')
        if 'undone_revision' not in columns:
            self.connection.execute('ALTER TABLE receipt_field_rule_operations ADD COLUMN undone_revision INTEGER')

    def get(self, job_id, operation_id):
        if not isinstance(operation_id, str) or len(operation_id) != 32:
            raise GroupingValidationError('读取操作编号无效')
        row = self.connection.execute('SELECT * FROM receipt_field_rule_operations WHERE operation_id=? AND job_id=?',
                                      (operation_id, job_id)).fetchone()
        if row is None:
            raise GroupingNotFound('读取操作不存在')
        return dict(row)

    def check_current(self, operation):
        task = self.grouping._task(self.connection, operation['job_id'])
        _require_current_grouping_version(task)
        basis = _task_basis(task)
        if basis != json.loads(operation['basis_json']):
            raise GroupingConflict('回单或分组已变化，请重新试读')
        return basis

    def public(self, operation):
        rows = self.connection.execute('SELECT summary_json FROM receipt_field_rule_operation_items WHERE operation_id=? AND summary_json IS NOT NULL',
                                       (operation['operation_id'],)).fetchall()
        summaries = [json.loads(row[0]) for row in rows]
        definition = json.loads(operation['definition_json'])
        return {'operation_id': operation['operation_id'], 'status': operation['status'],
                'total': operation['total'], 'completed': operation['completed'],
                'eligible': sum(row['status'] != 'skipped' for row in summaries),
                'skipped': sum(row['status'] == 'skipped' for row in summaries),
                'changed': sum(row['status'] == 'changed' for row in summaries),
                'unresolved': sum(row['status'] == 'pending' for row in summaries),
                'can_save_rule': not bool(definition.get('batch_only', True)),
                'rule_id': operation['rule_id']}

    def prepare(self, header, definition, include_resolved=False):
        if type(include_resolved) is not bool:
            raise GroupingValidationError('重读范围无效')
        definition = validate_rule(definition)
        job = header['job_id']
        with self.grouping.transaction():
            task = self.grouping._task(self.connection, job)
            _require_current_grouping_version(task)
            if _task_basis(task) != expected_basis(header):
                raise GroupingConflict('分组已变化，请重新试读')
            active = self.connection.execute("SELECT count(*) FROM receipt_field_rule_operations WHERE job_id=? AND status IN ('preparing','ready')", (job,)).fetchone()[0]
            if active >= 8:
                # Unapplied trials are disposable computations, never published decisions.
                self.connection.execute("UPDATE receipt_field_rule_operations SET status='cancelled' WHERE job_id=? AND status IN ('preparing','ready')", (job,))
            items = self.grouping._load_items(self.connection, job)
            selected = [i for i in items if i['route'] not in {'excluded', 'special'} and
                        (include_resolved or i['route'] in {'counterparty_pending', 'own_pending'} or i['extraction_state'] != 'ready')]
            if not selected:
                raise GroupingValidationError('当前没有可试读的回单')
            operation_id, now = uuid4().hex, now_utc()
            self.connection.execute('INSERT INTO receipt_field_rule_operations(operation_id,job_id,status,basis_json,definition_json,total,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
                                    (operation_id, job, 'preparing', canonical_json(expected_basis(header)), canonical_json(definition), len(selected), now, now))
            self.connection.executemany('INSERT INTO receipt_field_rule_operation_items(operation_id,ordinal,segment_id,before_json) VALUES (?,?,?,?)',
                [(operation_id, index, item['binding']['segment_id'], canonical_json(item)) for index, item in enumerate(selected)])
            return self.public(self.get(job, operation_id))

    def next_items(self, operation, offset, limit):
        self.check_current(operation)
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 50:
            raise GroupingValidationError('试读数量无效')
        if operation['status'] not in {'preparing', 'ready'}:
            raise GroupingConflict('读取操作已结束')
        if offset < operation['completed']:
            return []  # Idempotent retry after a lost response.
        if offset != operation['completed']:
            raise GroupingConflict('试读进度已变化')
        return [dict(row) for row in self.connection.execute('SELECT * FROM receipt_field_rule_operation_items WHERE operation_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?',
                    (operation['operation_id'], offset, limit)).fetchall()]

    def finish_step(self, operation, rows, readings):
        with self.grouping.transaction():
            current = self.get(operation['job_id'], operation['operation_id'])
            self.check_current(current)
            if current['status'] not in {'preparing', 'ready'}:
                raise GroupingConflict('读取操作已取消')
            if current['completed'] != operation['completed']:
                return self.public(current)
            expected_rows = self.next_items(current, current['completed'], 50)
            if not isinstance(rows, list) or not rows or len(rows) > 50 or rows != expected_rows[:len(rows)]:
                raise GroupingValidationError('试读片段或进度与当前任务不一致')
            if not isinstance(readings, dict) or not set(readings) <= {row['segment_id'] for row in rows}:
                raise GroupingValidationError('试读结果不属于本次片段')
            task = self.grouping._task(self.connection, operation['job_id'])
            profile = self.grouping._profile(task)
            groups = self.grouping._load_groups(self.connection, operation['job_id'])
            for row in rows:
                before = json.loads(row['before_json'])
                reading = readings.get(row['segment_id'])
                after = None
                status, reason = 'skipped', '已有人工处理，保持原结果'
                if not protected(before):
                    if reading is not None and reading.get('matched') and reading.get('resolved') is False:
                        status, reason = 'pending', '无法确定本方与对方位置，保持原结果'
                    elif reading is None or not reading.get('matched'):
                        reason = str((reading or {}).get('reason') or '不符合此读取版式')[:256]
                    else:
                        raw = reading.get('raw')
                        if (not isinstance(raw, dict) or 'parties' not in raw or
                                not set(raw) <= {'parties', 'source_bank', 'extraction_state', 'field_rule_basis', 'extractor_version'}):
                            raise GroupingValidationError('字段读取不能修改来源、边界或审核决定')
                        candidate = deepcopy(before)
                        candidate['_raw'] = stamp_extraction_dependencies({**candidate['_raw'], **raw})
                        after = self.grouping._rebuild_item(operation['job_id'], candidate, profile, task, groups)
                        if (after['binding'] != before['binding'] or after['document_type'] != before['document_type']
                                or after['boundary_status'] != before['boundary_status'] or after['_manual'] != before['_manual']):
                            raise GroupingValidationError('字段读取不能修改来源、边界或人工审核决定')
                        if after['route'] in {'counterparty_pending', 'own_pending'}:
                            status, reason = 'pending', '仍需核对，保持原结果'
                        elif after['route'] in {'excluded', 'special'}:
                            raise GroupingValidationError('字段读取不能改变凭证类型或排除决定')
                        elif after['basis_fingerprint'] == before['basis_fingerprint']:
                            status, reason = 'unchanged', '读取结果未改变'
                        else:
                            status, reason = 'changed', '可应用新读取结果'
                summary = {'segment_id': row['segment_id'], 'before_name': _name(before),
                           'after_name': _name(after or before), 'before_route': before['route'],
                           'after_route': (after or before)['route'], 'status': status, 'reason': reason}
                self.connection.execute('UPDATE receipt_field_rule_operation_items SET after_json=?,summary_json=? WHERE operation_id=? AND ordinal=?',
                    (canonical_json(after) if after is not None else None, canonical_json(summary), operation['operation_id'], row['ordinal']))
            completed = current['completed'] + len(rows)
            self.connection.execute('UPDATE receipt_field_rule_operations SET completed=?,status=?,updated_at=? WHERE operation_id=?',
                (completed, 'ready' if completed == current['total'] else 'preparing', now_utc(), operation['operation_id']))
            return self.public(self.get(operation['job_id'], operation['operation_id']))

    def page(self, operation, offset, limit):
        if type(offset) is not int or not 0 <= offset <= operation['total'] or type(limit) is not int or not 1 <= limit <= 200:
            raise GroupingValidationError('试读分页无效')
        rows = self.connection.execute('SELECT summary_json FROM receipt_field_rule_operation_items WHERE operation_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?',
                                       (operation['operation_id'], offset, limit)).fetchall()
        summaries = [json.loads(row[0]) for row in rows if row[0] is not None]
        end = offset + len(summaries)
        return {'operation': self.public(operation), 'items': summaries,
                'next_offset': end if end < operation['completed'] else None}

    def cancel(self, operation):
        with self.grouping.transaction():
            current = self.get(operation['job_id'], operation['operation_id'])
            if current['status'] in {'preparing', 'ready'}:
                self.connection.execute("UPDATE receipt_field_rule_operations SET status='cancelled',updated_at=? WHERE operation_id=?", (now_utc(), operation['operation_id']))
            return self.public(self.get(operation['job_id'], operation['operation_id']))

    def _publish(self, job, current_items, replacements, expected_revision, reason):
        now = now_utc()
        old = [item for item in current_items if item['binding']['segment_id'] in replacements]
        if not old:
            return expected_revision
        revision = expected_revision + 1
        self.grouping._record_history(self.connection, job, revision, old, reason)
        groups = self.grouping._load_groups(self.connection, job)
        combined = [replacements.get(item['binding']['segment_id'], item) for item in current_items]
        _sync_persisted_group_labels(combined, groups)
        for item in combined:
            if item['binding']['segment_id'] in replacements:
                self.connection.execute('DELETE FROM receipt_grouping_items WHERE job_id=? AND segment_id=?', (job, item['binding']['segment_id']))
                self.grouping._insert_item(self.connection, job, item, now)
        self.connection.execute('DELETE FROM receipt_grouping_groups WHERE job_id=?', (job,))
        self.grouping._write_groups(self.connection, job, combined, now)
        complete = all(item['route'] in {'excluded', 'named', 'internal', 'blank', 'special'} for item in combined)
        self.connection.execute('UPDATE receipt_grouping_tasks SET grouping_revision=?,status=?,updated_at=? WHERE job_id=? AND grouping_revision=?',
                                (revision, 'ready' if complete else 'needs_confirmation', now, job, expected_revision))
        if self.connection.execute('SELECT changes()').fetchone()[0] != 1:
            raise GroupingConflict('分组结果已变化')
        return revision

    def apply(self, operation, save_rule=False, rule_name=''):
        from .receipt_field_rule_store import FieldRuleStore
        if type(save_rule) is not bool or not isinstance(rule_name, str) or len(rule_name) > 80:
            raise GroupingValidationError('保存规则选项无效')
        intent = canonical_json({'save_rule': save_rule, 'rule_name': rule_name.strip() if save_rule else ''})
        with self.grouping.transaction():
            current = self.get(operation['job_id'], operation['operation_id'])
            header = self.grouping.header(operation['job_id'])
            if current['status'] == 'applied' and header['grouping_revision'] == current['applied_revision']:
                _require_current_grouping_version(self.grouping._task(self.connection, operation['job_id']))
                basis = json.loads(current['basis_json'])
                if any(value != basis[key] for key, value in expected_basis(header).items() if key != 'grouping_revision'):
                    raise GroupingConflict('回单或分组依据已变化，请重新载入')
                if current['apply_intent_json'] != intent:
                    raise GroupingConflict('本次应用已完成，不能更改原保存选项')
                return {'header': header, 'operation': self.public(current)}
            self.check_current(current)
            if current['status'] != 'ready':
                raise GroupingConflict('请先完成试读')
            rows = self.connection.execute('SELECT before_json,after_json,summary_json FROM receipt_field_rule_operation_items WHERE operation_id=?', (operation['operation_id'],)).fetchall()
            if len(rows) != current['total'] or current['completed'] != current['total'] or any(row['summary_json'] is None for row in rows):
                raise GroupingConflict('试读尚未全部完成')
            replacements = {}
            successful = 0
            for row in rows:
                summary = json.loads(row['summary_json'])
                if summary['status'] in {'changed', 'unchanged'}:
                    successful += 1
                if summary['status'] == 'changed':
                    replacements[summary['segment_id']] = json.loads(row['after_json'])
            rule_id = None
            if save_rule:
                if not successful:
                    raise GroupingValidationError('没有通过试读的结果，不能保存复用规则')
                definition = json.loads(current['definition_json'])
                saved = FieldRuleStore(self.connection).create(definition, name=rule_name, operation_id=operation['operation_id'])
                rule_id = saved['rule_id']
            items = self.grouping._load_items(self.connection, operation['job_id'])
            revision = self._publish(operation['job_id'], items, replacements, header['grouping_revision'], 'field_rule_apply')
            self.connection.execute("UPDATE receipt_field_rule_operations SET status='applied',applied_revision=?,rule_id=?,apply_intent_json=?,updated_at=? WHERE operation_id=?",
                                    (revision, rule_id, intent, now_utc(), operation['operation_id']))
            return {'header': self.grouping.header(operation['job_id']), 'operation': self.public(self.get(operation['job_id'], operation['operation_id']))}

    def undo(self, operation):
        with self.grouping.transaction():
            current = self.get(operation['job_id'], operation['operation_id'])
            _require_current_grouping_version(self.grouping._task(self.connection, operation['job_id']))
            header = self.grouping.header(operation['job_id'])
            basis = json.loads(current['basis_json'])
            if current['status'] == 'undone':
                if (header['grouping_revision'] != current['undone_revision'] or
                        any(expected_basis(header)[key] != basis[key] for key in ('review_fingerprint', 'result_revision', 'basis_fingerprint', 'own_account_fingerprint'))):
                    raise GroupingConflict('撤销后已有其他修改，请重新载入分组')
                return {'header': header, 'operation': self.public(current)}
            if (current['status'] != 'applied' or header['grouping_revision'] != current['applied_revision']
                    or any(expected_basis(header)[key] != basis[key] for key in ('review_fingerprint', 'result_revision', 'basis_fingerprint', 'own_account_fingerprint'))):
                raise GroupingConflict('应用后已有其他修改，不能直接撤销')
            rows = self.connection.execute('SELECT before_json,summary_json FROM receipt_field_rule_operation_items WHERE operation_id=?', (operation['operation_id'],)).fetchall()
            replacements = {json.loads(row['summary_json'])['segment_id']: json.loads(row['before_json']) for row in rows if json.loads(row['summary_json'])['status'] == 'changed'}
            revision = self._publish(operation['job_id'], self.grouping._load_items(self.connection, operation['job_id']), replacements, header['grouping_revision'], 'field_rule_undo')
            self.connection.execute("UPDATE receipt_field_rule_operations SET status='undone',undone_revision=?,updated_at=? WHERE operation_id=?", (revision, now_utc(), operation['operation_id']))
            return {'header': self.grouping.header(operation['job_id']), 'operation': self.public(self.get(operation['job_id'], operation['operation_id']))}
