import type { GroupingHeader, RecognitionIssueCode } from './receiptGrouping';
import { RECOGNITION_ISSUE_CODES, parseGroupingHeader } from './receiptGrouping';

export type NormalizedFieldRect = { x0: number; y0: number; x1: number; y1: number };
export type FieldRuleRole = 'counterparty' | 'own' | 'payer' | 'payee';
export type FieldRuleField = 'name' | 'account' | 'bank';
export type FieldRuleRegion = { role: FieldRuleRole; field: FieldRuleField; rect: NormalizedFieldRect };
export type FieldRuleMode = 'direct' | 'sides' | 'auto';
export type FieldRuleDefinition = { prototype_segment_id: string; mode: FieldRuleMode; fields: FieldRuleRegion[]; include_resolved: boolean };
export type FieldRuleOperation = { operation_id: string; status: 'preparing' | 'ready' | 'applied' | 'cancelled' | 'undone'; total: number; completed: number; eligible: number; skipped: number; changed: number; unresolved: number; can_save_rule: boolean; rule_id: string | null };
export type FieldRuleDifference = { segment_id: string; before_name: string; after_name: string; before_route: string; after_route: string; status: 'changed' | 'unchanged' | 'pending' | 'skipped'; reason: string };
export type FieldRulePage = { operation: FieldRuleOperation; items: FieldRuleDifference[]; next_offset: number | null };
export type LocalFieldRule = { rule_id: string; revision: number; name: string; bank_name: string; mode: FieldRuleMode; active: boolean };
export type FieldRuleApplied = { header: GroupingHeader; operation: FieldRuleOperation };
export type FieldSelectionContext = { current: { role: FieldRuleRole; field: FieldRuleField } | null; regions: FieldRuleRegion[]; mode?: FieldRuleMode; disabled?: boolean; onSelect: (rect: NormalizedFieldRect) => void };
export type GroupingDiagnostics = { schema_version: 1; report_id: string; app_version: string; total: number;
  issues: Array<{ code: RecognitionIssueCode; count: number }>;
  field_states: Array<{ field: FieldRuleField; role: FieldRuleRole | 'unknown'; state: 'present' | 'blank' | 'missing' | 'ambiguous'; count: number }>;
  layouts: Array<{ layout_id: string; count: number }>; reader_dependencies: Array<{ reader_id: string; version: string }> };
export type DiagnosticExport = { output_directory: string; files: Array<{ name: string; path: string; bytes: number; sha256: string }> };

export const FIELD_ROLE_LABELS: Record<FieldRuleRole, string> = { counterparty: '交易对方', own: '本方', payer: '付款方', payee: '收款方' };
export const FIELD_LABELS: Record<FieldRuleField, string> = { name: '名称', account: '账号', bank: '开户行' };
const AUTO_FIELD_LABELS: Record<'counterparty' | 'own', Record<FieldRuleField, string>> = {
  counterparty: { name: '名称位置一', account: '位置一账号', bank: '位置一开户行' },
  own: { name: '名称位置二', account: '位置二账号', bank: '位置二开户行' },
};
export const fieldRegionLabel = (field: Pick<FieldRuleRegion, 'role' | 'field'>, mode?: FieldRuleMode) => (
  mode === 'auto' && (field.role === 'counterparty' || field.role === 'own')
    ? AUTO_FIELD_LABELS[field.role][field.field]
    : `${FIELD_ROLE_LABELS[field.role]}${FIELD_LABELS[field.field]}`
);
export const invalidFieldRule = (): never => { throw new Error('读取规则返回的数据不完整，请重新载入后重试。'); };
export function ruleObject(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidFieldRule();
  const result = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(result, key)) || Object.keys(result).some((key) => !required.includes(key) && !optional.includes(key))) return invalidFieldRule();
  return result;
}
export function ruleText(value: unknown, max = 256, empty = false): string { return typeof value === 'string' && value.length <= max && !value.includes('\0') && (empty || value.trim()) ? value : invalidFieldRule(); }
export function ruleInteger(value: unknown, max = 50_000): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : invalidFieldRule(); }
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : invalidFieldRule(); }
function choice<T extends string>(value: unknown, options: readonly T[]): T { return typeof value === 'string' && options.includes(value as T) ? value as T : invalidFieldRule(); }
function array<T>(value: unknown, parse: (value: unknown) => T, max: number): T[] { return Array.isArray(value) && value.length <= max ? value.map(parse) : invalidFieldRule(); }
export function parseNormalizedFieldRect(value: unknown): NormalizedFieldRect {
  const r = ruleObject(value, ['x0', 'y0', 'x1', 'y1']);
  if (Object.values(r).some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) return invalidFieldRule();
  const result = r as NormalizedFieldRect;
  if (result.x1 <= result.x0 || result.y1 <= result.y0) return invalidFieldRule();
  return { x0: result.x0, y0: result.y0, x1: result.x1, y1: result.y1 };
}
export function parseFieldRuleDefinition(value: unknown): FieldRuleDefinition {
  const d = ruleObject(value, ['prototype_segment_id', 'mode', 'fields', 'include_resolved']);
  const mode = choice(d.mode, ['direct', 'sides', 'auto']);
  const fields = array(d.fields, (value) => { const f = ruleObject(value, ['role', 'field', 'rect']); return { role: choice(f.role, ['counterparty', 'own', 'payer', 'payee']), field: choice(f.field, ['name', 'account', 'bank']), rect: parseNormalizedFieldRect(f.rect) }; }, 6);
  const allowedRoles = mode === 'sides' ? ['payer', 'payee'] : ['counterparty', 'own'];
  const requiredNames = mode === 'sides' ? ['payer', 'payee'] : ['counterparty'];
  if (!fields.length || new Set(fields.map((f) => `${f.role}:${f.field}`)).size !== fields.length || fields.some((f) => !allowedRoles.includes(f.role))) return invalidFieldRule();
  if (!requiredNames.every((role) => fields.some((field) => field.role === role && field.field === 'name'))) return invalidFieldRule();
  const id = ruleText(d.prototype_segment_id, 64); if (!/^[a-f0-9]{64}$/.test(id)) return invalidFieldRule();
  return { prototype_segment_id: id, mode, fields, include_resolved: bool(d.include_resolved) };
}
export function parseFieldRuleOperation(value: unknown): FieldRuleOperation {
  const d = ruleObject(value, ['operation_id', 'status', 'total', 'completed', 'eligible', 'skipped', 'changed', 'unresolved', 'can_save_rule', 'rule_id']);
  const total = ruleInteger(d.total);
  return { operation_id: ruleText(d.operation_id, 128), status: choice(d.status, ['preparing', 'ready', 'applied', 'cancelled', 'undone']), total,
    completed: ruleInteger(d.completed, total), eligible: ruleInteger(d.eligible, total), skipped: ruleInteger(d.skipped, total), changed: ruleInteger(d.changed, total), unresolved: ruleInteger(d.unresolved, total), can_save_rule: bool(d.can_save_rule), rule_id: d.rule_id === null ? null : ruleText(d.rule_id, 128) };
}
export function parseFieldRulePage(value: unknown, offset: number, limit: number): FieldRulePage {
  const d = ruleObject(value, ['operation', 'items', 'next_offset']); const operation = parseFieldRuleOperation(d.operation);
  const items = array(d.items, (value) => { const row = ruleObject(value, ['segment_id', 'before_name', 'after_name', 'before_route', 'after_route', 'status', 'reason']); return { segment_id: ruleText(row.segment_id, 64), before_name: ruleText(row.before_name, 4096, true), after_name: ruleText(row.after_name, 4096, true), before_route: ruleText(row.before_route), after_route: ruleText(row.after_route), status: choice(row.status, ['changed', 'unchanged', 'pending', 'skipped']), reason: ruleText(row.reason, 1000, true) }; }, limit);
  if (new Set(items.map((item) => item.segment_id)).size !== items.length) return invalidFieldRule();
  const next = d.next_offset === null ? null : ruleInteger(d.next_offset, operation.total);
  if (next !== null && (next !== offset + items.length || next <= offset)) return invalidFieldRule();
  return { operation, items, next_offset: next };
}
export function parseLocalFieldRule(value: unknown): LocalFieldRule {
  const d = ruleObject(value, ['rule_id', 'revision', 'name', 'bank_name', 'mode', 'active']); const revision = ruleInteger(d.revision, Number.MAX_SAFE_INTEGER);
  if (!revision) return invalidFieldRule();
  return { rule_id: ruleText(d.rule_id, 128), revision, name: ruleText(d.name), bank_name: ruleText(d.bank_name), mode: choice(d.mode, ['direct', 'sides', 'auto']), active: bool(d.active) };
}
export function parseFieldRuleApplied(value: unknown): FieldRuleApplied { const d = ruleObject(value, ['header', 'operation']); return { header: parseGroupingHeader(d.header), operation: parseFieldRuleOperation(d.operation) }; }
export function parseGroupingDiagnostics(value: unknown): GroupingDiagnostics {
  const d = ruleObject(value, ['schema_version', 'report_id', 'app_version', 'total', 'issues', 'field_states', 'layouts', 'reader_dependencies']);
  if (d.schema_version !== 1 || !/^[a-f0-9]{32}$/.test(ruleText(d.report_id, 32))) return invalidFieldRule();
  const total = ruleInteger(d.total);
  return { schema_version: 1, report_id: d.report_id as string, app_version: ruleText(d.app_version, 64), total,
    issues: array(d.issues, (value) => { const row = ruleObject(value, ['code', 'count']); return { code: choice(row.code, RECOGNITION_ISSUE_CODES), count: ruleInteger(row.count, total * 64) }; }, 64),
    field_states: array(d.field_states, (value) => { const row = ruleObject(value, ['field', 'role', 'state', 'count']); return { field: choice(row.field, ['name', 'account', 'bank']), role: choice(row.role, ['own', 'counterparty', 'payer', 'payee', 'unknown']), state: choice(row.state, ['present', 'blank', 'missing', 'ambiguous']), count: ruleInteger(row.count, total * 4) }; }, 100),
    layouts: array(d.layouts, (value) => { const row = ruleObject(value, ['layout_id', 'count']); const id = ruleText(row.layout_id, 64); if (!/^layout-\d+$/.test(id)) return invalidFieldRule(); return { layout_id: id, count: ruleInteger(row.count, total) }; }, 50_000),
    reader_dependencies: array(d.reader_dependencies, (value) => { const row = ruleObject(value, ['reader_id', 'version']); return { reader_id: ruleText(row.reader_id, 128), version: ruleText(row.version, 128) }; }, 1000) };
}

/** SVG may be zoomed or letterboxed. Use its screen transform, never panel width. */
export function normalizeFieldSelection(start: { x: number; y: number }, end: { x: number; y: number }, bounds: NormalizedFieldRect): NormalizedFieldRect | null {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const width = bounds.x1 - bounds.x0, height = bounds.y1 - bounds.y0;
  if (width <= 0 || height <= 0) return null;
  const x0 = clamp((Math.min(start.x, end.x) - bounds.x0) / width), x1 = clamp((Math.max(start.x, end.x) - bounds.x0) / width);
  const y0 = clamp((Math.min(start.y, end.y) - bounds.y0) / height), y1 = clamp((Math.max(start.y, end.y) - bounds.y0) / height);
  return x1 - x0 >= 0.003 && y1 - y0 >= 0.003 ? { x0, y0, x1, y1 } : null;
}

export function clientPointInSvg(clientX: number, clientY: number, matrix: { a: number; b: number; c: number; d: number; e: number; f: number }): { x: number; y: number } | null {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  const x = clientX - matrix.e, y = clientY - matrix.f;
  return { x: (matrix.d * x - matrix.c * y) / determinant, y: (-matrix.b * x + matrix.a * y) / determinant };
}
