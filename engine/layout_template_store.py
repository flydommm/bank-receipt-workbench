"""Independent, versioned storage for reusable layout geometry."""
from __future__ import annotations
import json, math, sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4
import re
from hashlib import sha256
from .receipt_layout_models import parse_page_geometry, near

class LayoutTemplateError(ValueError):
    def __init__(self, message: str, *, code: str = "invalid_reference"):
        super().__init__(message)
        self.code = code
_SHA256 = re.compile(r'^[a-f0-9]{64}$')
_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
def _now(): return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
def _canon(v): return json.dumps(v, sort_keys=True, separators=(',',':'))
def _req(v,n,limit=4096):
    if not isinstance(v,str) or not v.strip() or '\0' in v or len(v)>limit: raise LayoutTemplateError(f'invalid {n}')
    return v.strip()

def _fingerprint(v):
    if not isinstance(v, str) or _SHA256.fullmatch(v) is None:
        raise LayoutTemplateError('invalid layout_fingerprint')
    return v
def _geom(g):
    try:
        return parse_page_geometry(g)
    except (TypeError, ValueError, KeyError, OverflowError):
        raise LayoutTemplateError('invalid page_geometry') from None
def _slots(s, geometry=None):
    if not isinstance(s,list) or not 1 <= len(s) <= 1000: raise LayoutTemplateError('invalid slots')
    geometry = geometry or _geom({'pdf_box': {'x0': 0, 'y0': 0, 'x1': 1, 'y1': 1}, 'rotation': 0, 'user_unit': 1, 'width_pt': 1, 'height_pt': 1})
    seen=set(); result=[]
    for x in s:
        if not isinstance(x,dict) or set(x) != {'slot_id','position_index','rect'}: raise LayoutTemplateError('invalid slot')
        if not isinstance(x['slot_id'], str) or _ID.fullmatch(x['slot_id']) is None or type(x['position_index']) is not int or x['position_index'] < 1 or x['position_index'] > 1000 or x['position_index'] in seen: raise LayoutTemplateError('invalid slot')
        seen.add(x['position_index']); r=x['rect']
        def finite(value):
            if isinstance(value, bool) or not isinstance(value, (int, float)): return False
            try: return math.isfinite(float(value))
            except (OverflowError, ValueError): return False
        if not isinstance(r,dict) or set(r) != {'x0','y0','x1','y1'} or any(not finite(r.get(k)) for k in ('x0','y0','x1','y1')): raise LayoutTemplateError('invalid slot')
        if r['x0'] >= r['x1'] or r['y0'] >= r['y1'] or r['x0'] < 0 or r['y0'] < 0 or r['x1'] > geometry['width_pt'] or r['y1'] > geometry['height_pt']: raise LayoutTemplateError('slot outside page')
        result.append({'slot_id':x['slot_id'],'position_index':x['position_index'],'rect':{k:float(r[k]) for k in ('x0','y0','x1','y1')}})
    result.sort(key=lambda x:x['position_index'])
    for i,a in enumerate(result):
        for b in result[i+1:]:
            if min(a['rect']['x1'],b['rect']['x1']) > max(a['rect']['x0'],b['rect']['x0']) and min(a['rect']['y1'],b['rect']['y1']) > max(a['rect']['y0'],b['rect']['y0']): raise LayoutTemplateError('slots overlap')
    return result


_TEMPLATE_FIELDS = {
    'id', 'name', 'source_scope', 'layout_fingerprint', 'page_geometry',
    'slots', 'evidence_summary', 'source_operation_id', 'operation_id',
    'save_mode', 'update_template_id', 'bank_name',
}
_PRIVATE_EVIDENCE_KEYS = {
    'text', 'full_text', 'content', 'body', 'values', 'pdf', 'pdf_data',
    'image_data', 'ocr_text', 'raw_text', 'matched_text',
}
_REFERENCE_EVIDENCE_FIELDS = {
    'slot_count', 'confirmed_slot_ids', 'reference_schema', 'layout_definition',
    'shared_parameters', 'page_width_pt', 'page_height_pt', 'confirmed_slot_sources',
}


def _project_reference_evidence(value):
    """Schema-2 references expose only their defined geometry/identity data."""
    if not isinstance(value, dict) or value.get('reference_schema') != 2:
        return value
    from .receipt_layout_calibration import validate_complete_layout
    result = {key: value[key] for key in _REFERENCE_EVIDENCE_FIELDS if key in value}
    layout = validate_complete_layout(result['layout_definition'])
    result.update(layout_definition=layout, slot_count=len(layout['slots']),
                  page_width_pt=layout['page_geometry']['width_pt'],
                  page_height_pt=layout['page_geometry']['height_pt'])
    shared = result.get('shared_parameters')
    if isinstance(shared, dict):
        result['shared_parameters'] = {key: shared[key] for key in ('left_pt', 'right_pt', 'uniform_height') if key in shared}
    return result


def _validate_evidence(value: object, path: str = 'evidence_summary') -> dict[str, object]:
    """Keep evidence metadata small and free of business document payloads."""
    if not isinstance(value, dict):
        raise LayoutTemplateError('invalid evidence_summary')

    def walk(item: object, item_path: str) -> None:
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str) or key.lower() in _PRIVATE_EVIDENCE_KEYS:
                    raise LayoutTemplateError('invalid evidence_summary')
                walk(child, f'{item_path}.{key}')
        elif isinstance(item, list):
            if len(item) > 1000:
                raise LayoutTemplateError('invalid evidence_summary')
            for index, child in enumerate(item):
                walk(child, f'{item_path}[{index}]')
        elif isinstance(item, str):
            if len(item) > 256:
                raise LayoutTemplateError('invalid evidence_summary')
        elif isinstance(item, float):
            if not math.isfinite(item):
                raise LayoutTemplateError('invalid evidence_summary')
        elif item is None or isinstance(item, (bool, int)):
            return
        else:
            raise LayoutTemplateError('invalid evidence_summary')

    walk(value, path)
    if len(_canon(value).encode('utf-8')) > 32 * 1024:
        raise LayoutTemplateError('invalid evidence_summary')
    return value

def _legacy_series(scope, fingerprint):
    return 'legacy-' + sha256(_canon([scope, fingerprint]).encode('utf-8')).hexdigest()


def _save_selection(save_mode, template_id):
    if save_mode not in ('create', 'update'):
        raise LayoutTemplateError('invalid save_mode')
    if save_mode == 'create':
        if template_id is not None:
            raise LayoutTemplateError('new template cannot have an update target')
        return None
    return _req(template_id, 'update_template_id', 256)


def _update_target(connection, template_id, scope, fingerprint, geometry, *, reference=False, workspace_id='default'):
    row = connection.execute('SELECT * FROM layout_templates WHERE id=?', (template_id,)).fetchone()
    if row is None:
        raise LayoutTemplateError('update template is unavailable', code='template_unavailable')
    target = LayoutTemplateStore._row(row)
    # Work on both migrated databases and read-only pre-series databases.
    columns = {item[1] for item in connection.execute('PRAGMA table_info(layout_templates)')}
    if 'series_id' in columns:
        latest = connection.execute('SELECT id FROM layout_templates WHERE series_id=? ORDER BY version DESC,rowid DESC LIMIT 1',
                                    (target['series_id'],)).fetchone()
    else:
        latest = connection.execute('SELECT id FROM layout_templates WHERE source_scope=? AND layout_fingerprint=? ORDER BY version DESC,rowid DESC LIMIT 1',
                                    (target['source_scope'], target['layout_fingerprint'])).fetchone()
    if not target['active'] or latest is None or latest[0] != template_id:
        raise LayoutTemplateError('update template changed or is inactive', code='template_conflict')
    if (target['source_scope'] != scope or target['layout_fingerprint'] != fingerprint
            or target['page_geometry'] != geometry):
        raise LayoutTemplateError('update template layout is incompatible', code='template_incompatible')
    if reference:
        target = next(reusable_templates(connection, template_id=template_id, workspace_id=workspace_id), None)
        if target is None:
            raise LayoutTemplateError('update template is unavailable', code='template_unavailable')
    return target


def _legacy_retry_matches(connection, row, request):
    """Prove an old registration equivalent without changing its audit row.

    Pre-series releases did not retain save intent. Only a default create can
    acknowledge their existing result; an explicit update cannot be inferred.
    Composed references whose original request cannot be recovered fail closed.
    """
    if (request['save_mode'] != 'create' or request['update_template_id'] is not None
            or any(row[key] is not None for key in ('request_digest', 'save_mode', 'update_template_id'))):
        return False
    try:
        saved = LayoutTemplateStore._row(row)
        if saved['series_id'] != _legacy_series(saved['source_scope'], saved['layout_fingerprint']):
            return False
        latest = connection.execute('SELECT id FROM layout_templates WHERE series_id=? ORDER BY version DESC,rowid DESC LIMIT 1',
                                    (saved['series_id'],)).fetchone()
        if latest is None or latest[0] != saved['id']:
            return False
        if request['id'] is not None and request['id'] != saved['id']:
            return False
        if (request['scope'] != saved['source_scope'] or request['fingerprint'] != saved['layout_fingerprint']
                or request['geometry'] != saved['page_geometry'] or request['slots'] != saved['slots']
                or request['bank_name'] != saved['bank_name']
                or (request['name'] is not None and request['name'] != saved['name'])):
            return False
        expected = dict(request['evidence'])
        actual = dict(_validate_evidence(saved['evidence_summary']))
        if expected.get('reference_schema') == 2:
            from .receipt_layout_reference import historical_reference
            if historical_reference(saved, workspace_id=expected['layout_definition']['workspace_id']) is None:
                return False
            if next(reusable_templates(connection, template_id=saved['id'],
                                       workspace_id=expected['layout_definition']['workspace_id']), None) is None:
                return False
            for evidence in (expected, actual):
                confirmed = evidence['confirmed_slot_ids']
                if (not isinstance(confirmed, list) or any(not isinstance(value, str) for value in confirmed)
                        or len(set(confirmed)) != len(confirmed)):
                    return False
                evidence['confirmed_slot_ids'] = sorted(confirmed)
                # Older snapshots omitted the provenance map; the only safe
                # missing value is that every confirmed slot came from this op.
                evidence.setdefault('confirmed_slot_sources', {slot: saved['source_operation_id'] for slot in confirmed})
        return expected == actual
    except (ValueError, TypeError, KeyError, OverflowError, AttributeError):
        return False


class LayoutTemplateStore:
    VERSION=2
    def __init__(self, db_path:str|Path):
        self.db_path=str(db_path)
        with sqlite3.connect(self.db_path) as c:
            c.execute('BEGIN IMMEDIATE')
            c.execute('CREATE TABLE IF NOT EXISTS layout_templates (id TEXT PRIMARY KEY, version INTEGER NOT NULL, name TEXT, source_scope TEXT NOT NULL, page_geometry_json TEXT NOT NULL, layout_fingerprint TEXT NOT NULL, slots_json TEXT NOT NULL, evidence_json TEXT NOT NULL, source_operation_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)')
            columns = {row[1] for row in c.execute('PRAGMA table_info(layout_templates)')}
            for column in ('series_id', 'bank_name', 'save_mode', 'update_template_id', 'request_digest'):
                if column not in columns:
                    c.execute(f'ALTER TABLE layout_templates ADD COLUMN {column} TEXT')
            for scope, fingerprint in c.execute('SELECT DISTINCT source_scope,layout_fingerprint FROM layout_templates WHERE series_id IS NULL').fetchall():
                c.execute('UPDATE layout_templates SET series_id=? WHERE source_scope=? AND layout_fingerprint=? AND series_id IS NULL',
                          (_legacy_series(scope, fingerprint), scope, fingerprint))
            c.execute('CREATE TABLE IF NOT EXISTS layout_template_withdrawals (operation_id TEXT PRIMARY KEY, undo_id TEXT NOT NULL, created_at TEXT NOT NULL)')
            c.execute('CREATE INDEX IF NOT EXISTS idx_layout_templates_match ON layout_templates(source_scope,layout_fingerprint,active)')
            c.execute('CREATE INDEX IF NOT EXISTS idx_layout_templates_series ON layout_templates(series_id,version)')
    @staticmethod
    def _row(r):
        d=dict(r)
        d['series_id'] = d.get('series_id') or _legacy_series(d['source_scope'], d['layout_fingerprint'])
        d.setdefault('bank_name', None)
        for key in ('save_mode', 'update_template_id', 'request_digest', 'row_order', 'series_key'):
            d.pop(key, None)
        d['page_geometry']=json.loads(d.pop('page_geometry_json')); d['slots']=json.loads(d.pop('slots_json')); d['evidence_summary']=_project_reference_evidence(json.loads(d.pop('evidence_json'))); d['active']=bool(d['active']); return d
    def save(self, template:dict[str,Any]|None=None, **kw):
        t={**(template or {}),**kw}
        if any(key not in _TEMPLATE_FIELDS for key in t):
            raise LayoutTemplateError('invalid template fields')
        scope=_req(t.get('source_scope'),'source_scope',256); fp=_fingerprint(t.get('layout_fingerprint')); geom=_geom(t.get('page_geometry')); slots=_slots(t.get('slots'), geom); op=_req(t.get('source_operation_id',t.get('operation_id')),'source_operation_id',256); ev=_validate_evidence(_project_reference_evidence(t.get('evidence_summary',{})))
        name=t.get('name')
        if name is not None:
            name=_req(name, 'name', 256)
        bank_name = t.get('bank_name')
        if bank_name is not None:
            bank_name = _req(bank_name, 'bank_name', 80)
        save_mode = t.get('save_mode', 'create')
        target_id = _save_selection(save_mode, t.get('update_template_id'))
        ident=t.get('id')
        if ident is not None:
            ident=_req(ident, 'id', 256)
        if ev.get('reference_schema') == 2:
            # Schema-2 rows are cross-file geometry references.  Persisting a
            # row without a positive issuer/family identity would make it
            # active in storage but invisible to reusable_templates(), so a
            # review could report a successful template save that cannot be
            # selected later.
            layout = ev.get('layout_definition')
            if (not isinstance(layout, dict) or not layout.get('issuer_id')
                    or not layout.get('family_id')):
                raise LayoutTemplateError('reference layout identity is unavailable', code='identity_unavailable')
        request = {'scope': scope, 'fingerprint': fp, 'geometry': geom, 'slots': slots,
            'evidence': ev, 'name': name, 'bank_name': bank_name, 'save_mode': save_mode,
            'update_template_id': target_id, 'id': ident}
        request_digest = sha256(_canon(request).encode('utf-8')).hexdigest()
        now=_now(); ident=ident or str(uuid4())
        with sqlite3.connect(self.db_path) as c:
            c.row_factory = sqlite3.Row
            c.execute('BEGIN IMMEDIATE')
            if c.execute('SELECT 1 FROM layout_template_withdrawals WHERE operation_id=?', (op,)).fetchone() is not None:
                raise LayoutTemplateError('source operation is withdrawn', code='operation_inactive')
            existing = c.execute('SELECT * FROM layout_templates WHERE source_operation_id=? ORDER BY version DESC LIMIT 1', (op,)).fetchone()
            if existing is not None:
                if not existing['active']:
                    raise LayoutTemplateError('source operation is withdrawn or superseded', code='operation_inactive')
                if existing['request_digest'] != request_digest and not _legacy_retry_matches(c, existing, request):
                    raise LayoutTemplateError('source operation has a different template request', code='operation_conflict')
                return self._row(existing)
            previous = None
            if save_mode == 'update':
                previous = _update_target(c, target_id, scope, fp, geom, reference=ev.get('reference_schema') == 2,
                                          workspace_id=ev.get('layout_definition', {}).get('workspace_id', 'default'))
                if name is None:
                    name = previous['name']
                if bank_name is None:
                    bank_name = previous['bank_name']
            series_id = previous['series_id'] if previous else str(uuid4())
            if ev.get('reference_schema') == 2:
                from .receipt_layout_reference import merge_reference_evidence
                ev, slots = merge_reference_evidence(ev, op, previous)
                _validate_evidence(ev)
                _slots(slots, geom)
            ver = previous['version'] + 1 if previous else 1
            c.execute('UPDATE layout_templates SET active=0,updated_at=? WHERE series_id=? AND active=1', (now, series_id))
            c.execute('''INSERT INTO layout_templates
                (id,version,name,source_scope,page_geometry_json,layout_fingerprint,slots_json,evidence_json,
                 source_operation_id,active,created_at,updated_at,series_id,bank_name,save_mode,update_template_id,request_digest)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                (ident,ver,name,scope,_canon(geom),fp,_canon(slots),_canon(ev),op,1,now,now,
                 series_id,bank_name,save_mode,target_id,request_digest))
        return self.get(ident)
    def get(self, ident):
        with sqlite3.connect(self.db_path) as c:
            c.row_factory=sqlite3.Row; r=c.execute('SELECT * FROM layout_templates WHERE id=?',(ident,)).fetchone()
        return self._row(r) if r else None
    def list(self, source_scope=None, active_only=True):
        q='SELECT * FROM layout_templates'; a=[]; cond=[]
        if source_scope is not None: cond.append('source_scope=?'); a.append(source_scope)
        if active_only: cond.append('active=1')
        if cond:q+=' WHERE '+' AND '.join(cond)
        q+=' ORDER BY version DESC, rowid DESC'
        with sqlite3.connect(self.db_path) as c:
            c.row_factory=sqlite3.Row; return [self._row(r) for r in c.execute(q,a)]
    def match(self, source_scope, page_geometry, layout_fingerprint, slots=None):
        geom = _geom(page_geometry); layout_fingerprint = _fingerprint(layout_fingerprint); source_scope = _req(source_scope, 'source_scope', 256)
        # A reference is safe to reuse only when the caller supplies the
        # complete slot geometry.  Omitting slots would silently broaden a
        # match to every position in a page, which can mix incompatible
        # single/multi-column layouts.
        if slots is None:
            raise LayoutTemplateError('slots are required for matching')
        expected_slots = _slots(slots, geom)
        matches = [t for t in self.list(source_scope)
                   if t['layout_fingerprint']==layout_fingerprint and t['page_geometry']==geom and t['slots']==expected_slots]
        return matches[0] if len(matches) == 1 else None

    def match_reference(self, source_scope, page_geometry, layout_fingerprint, slots):
        """Return the only active geometry reference for a stable slot layout.

        Reference matching intentionally compares slot identity/order while
        allowing the stored rectangles to differ: the rectangles are the
        user's calibrated result and are applied to a newly read document
        only after the page geometry and layout identity have been verified.
        The strict :meth:`match` method remains available for exact replay.
        """
        geom = _geom(page_geometry)
        layout_fingerprint = _fingerprint(layout_fingerprint)
        source_scope = _req(source_scope, 'source_scope', 256)
        expected = _slots(slots, geom)
        shape = [(item['slot_id'], item['position_index']) for item in expected]
        matches = []
        for template in self.list(source_scope):
            if template['layout_fingerprint'] != layout_fingerprint or template['page_geometry'] != geom:
                continue
            if [(item['slot_id'], item['position_index']) for item in template['slots']] == shape:
                matches.append(template)
        return matches[0] if len(matches) == 1 else None
    def deactivate(self, template_id, operation_id=None):
        with sqlite3.connect(self.db_path) as c:
            c.execute('BEGIN IMMEDIATE')
            series = c.execute('SELECT series_id FROM layout_templates WHERE id=?', (template_id,)).fetchone()
            if series is None:
                return False
            return c.execute('UPDATE layout_templates SET active=0,updated_at=? WHERE series_id=? AND active=1', (_now(), series[0])).rowcount > 0

    def rename(self, template_id, name):
        name = _req(name, 'name', 256)
        with sqlite3.connect(self.db_path) as c:
            c.execute('BEGIN IMMEDIATE')
            series = c.execute('SELECT series_id FROM layout_templates WHERE id=?', (template_id,)).fetchone()
            if series is None:
                raise LayoutTemplateError('template not found')
            c.execute('UPDATE layout_templates SET name=?,updated_at=? WHERE series_id=?', (name, _now(), series[0]))
        return self.get(template_id)

    def list_page(self, active_only=True, offset=0, limit=50, *, withdrawn_operations=()):
        if type(active_only) is not bool or type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 50:
            raise LayoutTemplateError('invalid template pagination')
        items, total = [], 0
        with sqlite3.connect(self.db_path) as c:
            c.row_factory = sqlite3.Row
            for template in reusable_templates(c, active_only=active_only, withdrawn_operations=withdrawn_operations):
                if offset <= total < offset + limit:
                    items.append(template)
                total += 1
        return {'items': items, 'total': total, 'next_offset': offset + len(items) if offset + len(items) < total else None}

    def withdraw_source_operation(self, operation_id, undo_id=None):
        """Withdraw every template produced by one review operation.

        The record is idempotent and lives beside, but independently from,
        review decisions.  A later save using the withdrawn operation is
        rejected, while historical rows remain available for audit.
        """
        operation_id = _req(operation_id, 'operation_id', 256)
        undo_id = _req(undo_id or str(uuid4()), 'undo_id', 256)
        now = _now()
        with sqlite3.connect(self.db_path) as c:
            c.execute('BEGIN IMMEDIATE')
            c.execute('INSERT OR IGNORE INTO layout_template_withdrawals(operation_id,undo_id,created_at) VALUES (?,?,?)',
                      (operation_id, undo_id, now))
            changed = c.execute('UPDATE layout_templates SET active=0,updated_at=? WHERE source_operation_id=? AND active=1',
                                (now, operation_id)).rowcount
            # A composed reference must not retain geometry contributed by an
            # undone round. No predecessor is reactivated implicitly.
            for ident, evidence in c.execute('SELECT id,evidence_json FROM layout_templates WHERE active=1').fetchall():
                try:
                    sources = json.loads(evidence).get('confirmed_slot_sources', {})
                    if operation_id in sources.values():
                        changed += c.execute('UPDATE layout_templates SET active=0,updated_at=? WHERE id=?', (now, ident)).rowcount
                except (ValueError, TypeError, AttributeError):
                    continue
            row = c.execute('SELECT operation_id,undo_id,created_at FROM layout_template_withdrawals WHERE operation_id=?',
                            (operation_id,)).fetchone()
        return {'operation_id': row[0], 'undo_id': row[1], 'created_at': row[2], 'deactivated_count': changed}

    def is_source_operation_withdrawn(self, operation_id):
        operation_id = _req(operation_id, 'operation_id', 256)
        with sqlite3.connect(self.db_path) as c:
            return c.execute('SELECT 1 FROM layout_template_withdrawals WHERE operation_id=?', (operation_id,)).fetchone() is not None


def reusable_templates(connection, *, active_only=True, template_id=None, withdrawn_operations=(),
                       family=None, workspace_id='default'):
    """Stream complete, valid family references without modifying legacy rows."""
    from .receipt_layout_reference import historical_reference, compose_legacy_reference
    withdrawn = {row[0] for row in connection.execute('SELECT operation_id FROM layout_template_withdrawals')} if connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='layout_template_withdrawals'").fetchone() else set()
    withdrawn.update(withdrawn_operations)
    # A read-only pre-upgrade database has one series per old matching family.
    # New databases may have many independent series for the same family.
    columns = {row[1] for row in connection.execute('PRAGMA table_info(layout_templates)')}
    series = "COALESCE(series_id, source_scope || ':' || layout_fingerprint)" if 'series_id' in columns else "source_scope || ':' || layout_fingerprint"
    query = f"""WITH records AS (SELECT rowid AS row_order, *, {series} AS series_key FROM layout_templates)
        SELECT t.* FROM records t JOIN (
            SELECT series_key,MAX(row_order) AS newest FROM records GROUP BY series_key
        ) families USING (series_key)"""
    conditions, args = [], []
    if template_id is not None:
        conditions.append('t.series_key IN (SELECT series_key FROM records WHERE id=?)')
        args.append(template_id)
    if family is not None:
        conditions.append('t.source_scope=? AND t.layout_fingerprint=?')
        args.extend(family)
    if conditions:
        query += ' WHERE ' + ' AND '.join(conditions)
    query += ' ORDER BY families.newest DESC, t.version, t.row_order'
    pending, latest, pending_family = None, None, None

    def visible(template):
        return template is not None and (not active_only or template['active']) and (template_id is None or template['id'] == template_id)

    for row in connection.execute(query, args):
        try:
            if any(not isinstance(row[key], str) or len(row[key].encode('utf-8')) > 64 * 1024 for key in ('page_geometry_json', 'slots_json', 'evidence_json')):
                continue
            template = LayoutTemplateStore._row(row)
            _req(template['id'], 'id', 256)
            if type(template['version']) is not int or template['version'] < 1:
                continue
            if template['name'] is not None:
                _req(template['name'], 'name', 256)
            _req(template['series_id'], 'series_id', 256)
            if template['bank_name'] is not None:
                _req(template['bank_name'], 'bank_name', 80)
            _validate_evidence(template['evidence_summary'])
            if historical_reference({**template, 'active': True}, workspace_id=workspace_id) is None:
                continue
            operations = {template['source_operation_id'], *template['evidence_summary'].get('confirmed_slot_sources', {}).values()}
            if operations & withdrawn:
                template['active'] = False
            current_family = template['series_id']
            if current_family != pending_family:
                result = pending or latest
                if visible(result):
                    yield result
                pending, latest, pending_family = None, None, current_family
            latest = template
            if template['active']:
                pending = compose_legacy_reference(pending, template)
            else:
                # An inactive/withdrawn head must not expose an earlier active
                # legacy version as though the user had reactivated it.
                pending = None
        except (ValueError, TypeError, KeyError, OverflowError, AttributeError):
            continue
    result = pending or latest
    if visible(result):
        yield result
