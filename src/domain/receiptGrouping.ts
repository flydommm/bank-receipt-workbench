/** Local grouping contracts. Source geometry and extracted evidence are never editable requests. */
export type AccountInput = { company_name: string; bank_name: string; branch_name: string; account_number: string };
export type CompanyAccount = AccountInput & { account_id: string; account_revision: number; active: boolean; created_at: string; updated_at: string };
export type AccountSelection = { kind: 'saved'; account_id: string; account_revision: number } | { kind: 'inline'; account: AccountInput };
export type OwnAccountSnapshot = AccountInput & { own_account_revision: number; account_id: string | null; account_revision: number | null; fingerprint: string; selected_at: string };
export type GroupingHeader = { schema_version: 1; job_id: string; result_revision: string | null; grouping_revision: number; own_account: OwnAccountSnapshot; review_fingerprint: string | null;
  counts: { total: number; excluded: number; extraction_pending: number; own_pending: number; counterparty_pending: number; assigned: number; stale: number } };
export type SegmentBinding = { segment_id: string; fragment_key: string; source_key: string; source_sha256: string; source_page: number; position_index: number; slot_id: string; instance_id: string; analysis_signature: string; review_record_revision: number };
export type FieldEvidence = { rect: { x0: number; y0: number; x1: number; y1: number } | null; label: string | null; method: 'label' | 'verified_region' | 'none' };
export type FieldCandidate = { raw: string; value: string; state: 'present' | 'blank' | 'missing' | 'ambiguous'; evidence: FieldEvidence[] };
export type PartyField = { raw: string; value: string; state: 'present' | 'blank' | 'missing' | 'ambiguous'; evidence: FieldEvidence[]; diagnostics: string[]; candidates?: FieldCandidate[] };
export type Party = { name: PartyField; account: PartyField; bank: PartyField };
export const RECOGNITION_ISSUE_CODES = ['no_text', 'invalid_text', 'missing_field', 'conflicting_field', 'incomplete_account', 'role_unresolved', 'unsupported_layout', 'source_conflict', 'rule_incompatible', 'region_out_of_bounds'] as const;
export type RecognitionIssueCode = typeof RECOGNITION_ISSUE_CODES[number];
export type RecognitionIssue = { code: RecognitionIssueCode; field: 'name' | 'account' | 'bank' | null; role: 'payer' | 'payee' | 'own' | 'counterparty' | 'unknown'; message: string };
export type ReaderDependency = { reader_id: string; version: string };
export type ExtractedParties = { payer: Party; payee: Party; diagnostics: string[]; extractor_version: string; own_observed?: Party | null; counterparty_observed?: Party | null; issues?: RecognitionIssue[]; reader_dependencies?: ReaderDependency[]; layout_signature?: string | null; service_type?: 'bank_fee' | 'deposit_interest' | null };
export type FieldOverride = { side: 'payer' | 'payee' | 'counterparty'; field: 'name' | 'account' | 'bank'; value: string; state: 'present' | 'blank'; reason: string };
export type OwnDecision = { status: 'confirmed' | 'pending'; method: 'account_match' | 'manual' | 'batch_profile' | 'none'; side: 'payer' | 'payee' | 'single' | null; source_bank_status: 'matched' | 'manual' | 'unknown' | 'mismatch'; reasons: string[] };
export type GroupKind = 'named' | 'internal' | 'blank' | 'special' | 'counterparty_pending';
export type GroupDefinition = { group_id: string; kind: GroupKind; display_name: string; key: string | null; manual: boolean };
export type GroupingItem = { binding: SegmentBinding; extraction_fingerprint: string; basis_fingerprint: string; extraction_state: 'pending' | 'ready' | 'stale' | 'failed'; extracted: ExtractedParties | null; field_overrides: FieldOverride[]; own_decision: OwnDecision; counterparty: Party | null; route: 'excluded' | 'own_pending' | GroupKind; group: GroupDefinition | null; decision_method: 'automatic' | 'manual' | 'none'; warnings: string[]; boundary_status: string; document_type: string | null };
export type ReceiptGroupingSnapshot = { header: GroupingHeader; items: GroupingItem[] };
export type GroupingPage = ReceiptGroupingSnapshot & { offset: number; total: number; next_offset: number | null };
export type CompanyAccountPage = { items: CompanyAccount[]; total: number; next_offset: number | null };
export type GroupingEdit = { segment_id: string; expected_basis_fingerprint: string; field_overrides?: FieldOverride[] | null; own_confirmation?: { side: 'payer' | 'payee' | 'single'; confirms_selected_account: true; confirms_source_bank: true; reason: string } | null; assignment?: { group_id: string; reason: string } | null };
export type GroupEdit = { action: 'create'; group_id: string; kind: 'named' | 'internal'; display_name: string } | { action: 'rename'; group_id: string; display_name: string };
export type GroupingExpected = { job_id: string; result_revision: string; expected_grouping_revision: number; expected_review_fingerprint: string };
export type GroupingRequest =
  | { op: 'batch_counterparty_account_list'; active_only: boolean; offset: number; limit: number }
  | { op: 'batch_counterparty_account_save'; account_id: string | null; expected_account_revision: number; account: AccountInput; active: boolean }
  | { op: 'batch_receipt_grouping_set_account'; job_id: string; expected_grouping_revision: number; account_selection: AccountSelection }
  | { op: 'batch_receipt_grouping_prepare'; job_id: string; result_revision: string; expected_grouping_revision: number }
  | (GroupingExpected & { op: 'batch_receipt_grouping_refresh'; segment_ids: string[] })
  | (GroupingExpected & { op: 'batch_receipt_grouping_page'; offset: number; limit: number })
  | (GroupingExpected & { op: 'batch_receipt_grouping_save'; edits: GroupingEdit[]; group_edits: GroupEdit[] });

export class ReceiptGroupingValidationError extends Error {
  readonly code = 'grouping_invalid';
  constructor() { super('账户或分组数据不完整，请重新载入后重试。'); this.name = 'ReceiptGroupingValidationError'; }
}
const fail = (): never => { throw new ReceiptGroupingValidationError(); };
type Obj = Record<string, unknown>;
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data = value as Obj;
  if (required.some((key) => !Object.hasOwn(data, key)) || Object.keys(data).some((key) => !required.includes(key) && !optional.includes(key))) return fail();
  return data;
}
function text(value: unknown, max = 256, empty = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) return fail();
  return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail(); return value;
}
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : fail(); }
function choice<T extends string>(value: unknown, options: readonly T[]): T { return typeof value === 'string' && options.includes(value as T) ? value as T : fail(); }
function hash(value: unknown): string { const result = text(value, 64); return /^[a-f0-9]{64}$/.test(result) ? result : fail(); }
function date(value: unknown): string { const result = text(value, 40); return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(result) && Number.isFinite(Date.parse(result)) ? result : fail(); }
function array<T>(value: unknown, parse: (entry: unknown) => T, max: number, min = 0): T[] { if (!Array.isArray(value) || value.length < min || value.length > max) return fail(); return value.map(parse); }
function unique<T>(items: T[], key: (item: T) => string): T[] { return new Set(items.map(key)).size === items.length ? items : fail(); }
const strings = (value: unknown) => array(value, (entry) => text(entry, 1000), 200);
const accountKeys = ['company_name', 'bank_name', 'branch_name', 'account_number'] as const;
function accountFields(data: Obj): AccountInput {
  const account = text(data.account_number, 128).replace(/[０-９]/g, (value) => String.fromCharCode(value.charCodeAt(0) - 0xFEE0)).replace(/\s/g, '');
  if (!/^[0-9]{1,128}$/.test(account)) return fail();
  return { company_name: text(data.company_name), bank_name: text(data.bank_name), branch_name: text(data.branch_name, 256, true), account_number: account };
}
export function parseAccountInput(value: unknown): AccountInput { return accountFields(object(value, accountKeys)); }
export function parseCompanyAccount(value: unknown): CompanyAccount {
  const data = object(value, [...accountKeys, 'account_id', 'account_revision', 'active', 'created_at', 'updated_at']);
  return { ...accountFields(data), account_id: text(data.account_id), account_revision: integer(data.account_revision, 1), active: bool(data.active), created_at: date(data.created_at), updated_at: date(data.updated_at) };
}
export function parseAccountSelection(value: unknown): AccountSelection {
  const data = object(value, ['kind'], ['account_id', 'account_revision', 'account']);
  if (data.kind === 'saved') { object(data, ['kind', 'account_id', 'account_revision']); return { kind: 'saved', account_id: text(data.account_id), account_revision: integer(data.account_revision, 1) }; }
  if (data.kind === 'inline') { object(data, ['kind', 'account']); return { kind: 'inline', account: parseAccountInput(data.account) }; }
  return fail();
}
export function parseGroupingHeader(value: unknown): GroupingHeader {
  const data = object(value, ['schema_version', 'job_id', 'result_revision', 'grouping_revision', 'own_account', 'review_fingerprint', 'counts']);
  if (data.schema_version !== 1) return fail();
  const own = object(data.own_account, [...accountKeys, 'own_account_revision', 'account_id', 'account_revision', 'fingerprint', 'selected_at']);
  if ((own.account_id === null) !== (own.account_revision === null)) return fail();
  const ownAccount: OwnAccountSnapshot = { ...accountFields(own), own_account_revision: integer(own.own_account_revision, 1), account_id: own.account_id === null ? null : text(own.account_id), account_revision: own.account_revision === null ? null : integer(own.account_revision, 1), fingerprint: hash(own.fingerprint), selected_at: date(own.selected_at) };
  const counts = object(data.counts, ['total', 'excluded', 'extraction_pending', 'own_pending', 'counterparty_pending', 'assigned', 'stale']);
  const total = integer(counts.total, 0, 50_000);
  return { schema_version: 1, job_id: text(data.job_id, 1024), result_revision: data.result_revision === null ? null : text(data.result_revision, 1024), grouping_revision: integer(data.grouping_revision), own_account: ownAccount, review_fingerprint: data.review_fingerprint === null ? null : hash(data.review_fingerprint), counts: { total, excluded: integer(counts.excluded, 0, total), extraction_pending: integer(counts.extraction_pending, 0, total), own_pending: integer(counts.own_pending, 0, total), counterparty_pending: integer(counts.counterparty_pending, 0, total), assigned: integer(counts.assigned, 0, total), stale: integer(counts.stale, 0, total) } };
}
function evidence(value: unknown): FieldEvidence {
  const data = object(value, ['rect', 'label', 'method']); let rect: FieldEvidence['rect'] = null;
  if (data.rect !== null) {
    const raw = object(data.rect, ['x0', 'y0', 'x1', 'y1']);
    const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fail();
    rect = { x0: finite(raw.x0), y0: finite(raw.y0), x1: finite(raw.x1), y1: finite(raw.y1) };
    if (rect.x0 >= rect.x1 || rect.y0 >= rect.y1) return fail();
  }
  return { rect, label: data.label === null ? null : text(data.label, 256), method: choice(data.method, ['label', 'verified_region', 'none']) };
}
export function parsePartyField(value: unknown): PartyField {
  const data = object(value, ['raw', 'value', 'state', 'evidence', 'diagnostics'], ['candidates']);
  const state = choice(data.state, ['present', 'blank', 'missing', 'ambiguous']); const fieldValue = text(data.value, 4096, true);
  if ((state === 'present' && !fieldValue.trim()) || (state === 'blank' && fieldValue !== '')) return fail();
  return { raw: text(data.raw, 4096, true), value: fieldValue, state, evidence: array(data.evidence, evidence, 64), diagnostics: strings(data.diagnostics), ...(data.candidates === undefined ? {} : { candidates: array(data.candidates, (entry) => { const c = object(entry, ['raw', 'value', 'state', 'evidence']); return { raw: text(c.raw, 4096, true), value: text(c.value, 4096, true), state: choice(c.state, ['present', 'blank', 'missing', 'ambiguous']), evidence: array(c.evidence, evidence, 64) }; }, 16) }) };
}
function party(value: unknown): Party { const data = object(value, ['name', 'account', 'bank']); return { name: parsePartyField(data.name), account: parsePartyField(data.account), bank: parsePartyField(data.bank) }; }
function override(value: unknown): FieldOverride {
  const data = object(value, ['side', 'field', 'value', 'state', 'reason']); const state = choice(data.state, ['present', 'blank']);
  const field = choice(data.field, ['name', 'account', 'bank']); const result = text(data.value, field === 'account' ? 128 : 256, true);
  if ((state === 'present' && !result.trim()) || (state === 'blank' && result !== '')) return fail();
  return { side: choice(data.side, ['payer', 'payee', 'counterparty']), field, value: result, state, reason: text(data.reason, 1000) };
}
function overrides(value: unknown): FieldOverride[] { return unique(array(value, override, 9), (entry) => `${entry.side}:${entry.field}`); }
function group(value: unknown): GroupDefinition {
  const data = object(value, ['group_id', 'kind', 'display_name', 'key', 'manual']);
  return { group_id: text(data.group_id), kind: choice(data.kind, ['named', 'internal', 'blank', 'special', 'counterparty_pending']), display_name: text(data.display_name), key: data.key === null ? null : text(data.key, 2048), manual: bool(data.manual) };
}
export function parseGroupingItem(value: unknown): GroupingItem {
  const data = object(value, ['binding', 'extraction_fingerprint', 'basis_fingerprint', 'extraction_state', 'extracted', 'field_overrides', 'own_decision', 'counterparty', 'route', 'group', 'decision_method', 'warnings', 'boundary_status', 'document_type']);
  const b = object(data.binding, ['segment_id', 'fragment_key', 'source_key', 'source_sha256', 'source_page', 'position_index', 'slot_id', 'instance_id', 'analysis_signature', 'review_record_revision']);
  const binding: SegmentBinding = { segment_id: hash(b.segment_id), fragment_key: hash(b.fragment_key), source_key: text(b.source_key, 32768), source_sha256: hash(b.source_sha256), source_page: integer(b.source_page, 1), position_index: integer(b.position_index, 1, 1000), slot_id: text(b.slot_id, 128), instance_id: text(b.instance_id, 256), analysis_signature: hash(b.analysis_signature), review_record_revision: integer(b.review_record_revision) };
  let extracted: ExtractedParties | null = null;
  if (data.extracted !== null) {
    const e = object(data.extracted, ['payer', 'payee', 'diagnostics', 'extractor_version'], ['own_observed', 'counterparty_observed', 'issues', 'reader_dependencies', 'layout_signature', 'service_type']);
    extracted = { payer: party(e.payer), payee: party(e.payee), diagnostics: strings(e.diagnostics), extractor_version: text(e.extractor_version) };
    for (const key of ['own_observed', 'counterparty_observed'] as const) if (e[key] !== undefined) extracted[key] = e[key] === null ? null : party(e[key]);
    if (e.layout_signature !== undefined) extracted.layout_signature = e.layout_signature === null ? null : hash(e.layout_signature);
    if (e.service_type !== undefined) extracted.service_type = e.service_type === null ? null : choice(e.service_type, ['bank_fee', 'deposit_interest'] as const);
    if (e.issues !== undefined) extracted.issues = array(e.issues, (entry) => { const issue = object(entry, ['code', 'field', 'role', 'message']); return { code: choice(issue.code, RECOGNITION_ISSUE_CODES), field: issue.field === null ? null : choice<'name' | 'account' | 'bank'>(issue.field, ['name', 'account', 'bank']), role: choice(issue.role, ['payer', 'payee', 'own', 'counterparty', 'unknown']), message: text(issue.message, 1000) }; }, 64);
    if (e.reader_dependencies !== undefined) extracted.reader_dependencies = array(e.reader_dependencies, (entry) => { const dependency = object(entry, ['reader_id', 'version']); return { reader_id: text(dependency.reader_id, 128), version: text(dependency.version, 128) }; }, 16);
  }
  const own = object(data.own_decision, ['status', 'method', 'side', 'source_bank_status', 'reasons']);
  const ownDecision: OwnDecision = { status: choice(own.status, ['confirmed', 'pending']), method: choice(own.method, ['account_match', 'manual', 'batch_profile', 'none']), side: own.side === null ? null : choice<NonNullable<OwnDecision['side']>>(own.side, ['payer', 'payee', 'single']), source_bank_status: choice(own.source_bank_status, ['matched', 'manual', 'unknown', 'mismatch']), reasons: strings(own.reasons) };
  if (ownDecision.status === 'confirmed' && ownDecision.method !== 'batch_profile'
    && (ownDecision.side === null || ownDecision.method === 'none' || ['unknown', 'mismatch'].includes(ownDecision.source_bank_status))) return fail();
  if (ownDecision.method === 'batch_profile' && ownDecision.status !== 'confirmed') return fail();
  const route = choice(data.route, ['excluded', 'own_pending', 'named', 'internal', 'blank', 'special', 'counterparty_pending']);
  const definition = data.group === null ? null : group(data.group);
  if (route === 'excluded' || route === 'own_pending') { if (definition !== null) return fail(); }
  else if (definition === null || definition.kind !== route || ownDecision.status !== 'confirmed') return fail();
  const state = choice(data.extraction_state, ['pending', 'ready', 'stale', 'failed']); if (state === 'ready' && extracted === null) return fail();
  return { binding, extraction_fingerprint: hash(data.extraction_fingerprint), basis_fingerprint: hash(data.basis_fingerprint), extraction_state: state, extracted, field_overrides: overrides(data.field_overrides), own_decision: ownDecision, counterparty: data.counterparty === null ? null : party(data.counterparty), route, group: definition, decision_method: choice(data.decision_method, ['automatic', 'manual', 'none']), warnings: strings(data.warnings), boundary_status: choice(data.boundary_status, ['pending', 'needs_review', 'confirmed', 'page_confirmed', 'blocked', 'excluded']), document_type: data.document_type === null ? null : text(data.document_type) };
}
function nextOffset(value: unknown, offset: number, length: number, total: number): number | null {
  const next = value === null ? null : integer(value);
  if (offset > total || offset + length > total || (next !== null && (next !== offset + length || length === 0)) || ((offset + length < total) !== (next !== null))) return fail(); return next;
}
export function parseCompanyAccountPage(value: unknown, offset: number, limit: number, activeOnly: boolean): CompanyAccountPage {
  const data = object(value, ['items', 'total', 'next_offset']); const items = unique(array(data.items, parseCompanyAccount, limit), (entry) => entry.account_id); const total = integer(data.total);
  if (activeOnly && items.some((item) => !item.active)) return fail();
  return { items, total, next_offset: nextOffset(data.next_offset, offset, items.length, total) };
}
export function parseGroupingSnapshot(value: unknown, limit = 200): ReceiptGroupingSnapshot {
  const data = object(value, ['header', 'items']);
  return { header: parseGroupingHeader(data.header), items: unique(array(data.items, parseGroupingItem, limit), (item) => item.binding.segment_id) };
}
export function parseGroupingPage(value: unknown, expectedOffset: number, limit: number): GroupingPage {
  const data = object(value, ['header', 'items', 'offset', 'total', 'next_offset']); const offset = integer(data.offset); const total = integer(data.total, 0, 50_000);
  const snapshot = parseGroupingSnapshot({ header: data.header, items: data.items }, limit);
  if (offset !== expectedOffset || total !== snapshot.header.counts.total) return fail();
  return { ...snapshot, offset, total, next_offset: nextOffset(data.next_offset, offset, snapshot.items.length, total) };
}
function edit(value: unknown): GroupingEdit {
  const data = object(value, ['segment_id', 'expected_basis_fingerprint'], ['field_overrides', 'own_confirmation', 'assignment']);
  if (Object.keys(data).length === 2) return fail();
  const result: GroupingEdit = { segment_id: hash(data.segment_id), expected_basis_fingerprint: hash(data.expected_basis_fingerprint) };
  if ('field_overrides' in data) result.field_overrides = data.field_overrides === null ? null : overrides(data.field_overrides);
  if ('own_confirmation' in data) {
    if (data.own_confirmation === null) result.own_confirmation = null;
    else { const own = object(data.own_confirmation, ['side', 'confirms_selected_account', 'confirms_source_bank', 'reason']); if (own.confirms_selected_account !== true || own.confirms_source_bank !== true) return fail(); result.own_confirmation = { side: choice(own.side, ['payer', 'payee', 'single']), confirms_selected_account: true, confirms_source_bank: true, reason: text(own.reason, 1000) }; }
  }
  if ('assignment' in data) { if (data.assignment === null) result.assignment = null; else { const a = object(data.assignment, ['group_id', 'reason']); result.assignment = { group_id: text(a.group_id), reason: text(a.reason, 1000) }; } }
  return result;
}
function groupEdit(value: unknown): GroupEdit {
  const data = object(value, ['action', 'group_id', 'display_name'], ['kind']); const groupId = text(data.group_id); const displayName = text(data.display_name);
  if (data.action === 'create') { object(data, ['action', 'group_id', 'display_name', 'kind']); if (!/^manual-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(groupId)) return fail(); return { action: 'create', group_id: groupId, display_name: displayName, kind: choice(data.kind, ['named', 'internal']) }; }
  if (data.action === 'rename') { object(data, ['action', 'group_id', 'display_name']); return { action: 'rename', group_id: groupId, display_name: displayName }; } return fail();
}
export function validateGroupingRequest(value: unknown): GroupingRequest {
  const raw = value as Obj; if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  switch (raw.op) {
    case 'batch_counterparty_account_list': { const d = object(raw, ['op', 'active_only', 'offset', 'limit']); return { op: raw.op, active_only: bool(d.active_only), offset: integer(d.offset), limit: integer(d.limit, 1, 50) }; }
    case 'batch_counterparty_account_save': { const d = object(raw, ['op', 'account_id', 'expected_account_revision', 'account', 'active']); const id = d.account_id === null ? null : text(d.account_id); const revision = integer(d.expected_account_revision); if ((id === null) !== (revision === 0)) return fail(); return { op: raw.op, account_id: id, expected_account_revision: revision, account: parseAccountInput(d.account), active: bool(d.active) }; }
    case 'batch_receipt_grouping_set_account': { const d = object(raw, ['op', 'job_id', 'expected_grouping_revision', 'account_selection']); return { op: raw.op, job_id: text(d.job_id, 1024), expected_grouping_revision: integer(d.expected_grouping_revision), account_selection: parseAccountSelection(d.account_selection) }; }
    case 'batch_receipt_grouping_prepare': { const d = object(raw, ['op', 'job_id', 'result_revision', 'expected_grouping_revision']); return { op: raw.op, job_id: text(d.job_id, 1024), result_revision: text(d.result_revision, 1024), expected_grouping_revision: integer(d.expected_grouping_revision, -1) }; }
    case 'batch_receipt_grouping_refresh': case 'batch_receipt_grouping_page': case 'batch_receipt_grouping_save': {
      const fields = ['op', 'job_id', 'result_revision', 'expected_grouping_revision', 'expected_review_fingerprint'];
      const extra = raw.op === 'batch_receipt_grouping_refresh' ? ['segment_ids'] : raw.op === 'batch_receipt_grouping_page' ? ['offset', 'limit'] : ['edits', 'group_edits'];
      const d = object(raw, [...fields, ...extra]); const expected: GroupingExpected = { job_id: text(d.job_id, 1024), result_revision: text(d.result_revision, 1024), expected_grouping_revision: integer(d.expected_grouping_revision), expected_review_fingerprint: hash(d.expected_review_fingerprint) };
      if (raw.op === 'batch_receipt_grouping_refresh') return { op: raw.op, ...expected, segment_ids: unique(array(d.segment_ids, hash, 50, 1), (id) => id) };
      if (raw.op === 'batch_receipt_grouping_page') return { op: raw.op, ...expected, offset: integer(d.offset), limit: integer(d.limit, 1, 200) };
      const edits = unique(array(d.edits, edit, 200), (entry) => entry.segment_id); const groupEdits = unique(array(d.group_edits, groupEdit, 200), (entry) => entry.group_id);
      if (edits.length + groupEdits.length === 0) return fail(); return { op: raw.op, ...expected, edits, group_edits: groupEdits };
    }
    default: return fail();
  }
}
export function groupingExpected(header: GroupingHeader): GroupingExpected {
  if (header.result_revision === null || header.review_fingerprint === null) return fail();
  return { job_id: header.job_id, result_revision: header.result_revision, expected_grouping_revision: header.grouping_revision, expected_review_fingerprint: header.review_fingerprint };
}
export const GROUP_ROUTE_LABELS: Record<GroupingItem['route'], string> = { excluded: '已排除', own_pending: '本方待确认', named: '交易对手', internal: '本公司内部往来', blank: '对方名称为空', special: '特殊凭证', counterparty_pending: '对手待确认' };
export const FIELD_STATE_LABELS: Record<PartyField['state'], string> = { present: '已提取', blank: '原件空白', missing: '未能提取', ambiguous: '存在冲突' };
export const GROUPING_SERVICE_LABELS = { bank_fee: '银行收费凭证', deposit_interest: '存款结息凭证' } as const;
const issueLabels: Record<string, string> = {
  batch_identity_conflict: '本批资料与回单识别结果需要核对，交易对手暂未确定',
  legacy_internal_assignment_recomputed: '原内部账户分组已按本公司名称重新整理',
  own_company_mismatch: '本方公司名称与本批不一致，请核对来源', own_company_ambiguous: '本方公司名称存在冲突，请查看原件', own_side_conflict: '人工指定的本方与完整账号证据冲突', both_sides_match_our_account: '付款方和收款方都出现本方账号，暂不能确定交易对手',
  source_bank_unknown: '来源银行尚未确认', source_bank_mismatch: '来源银行与本批不一致', own_account_missing: '缺少完整本方账号', own_account_mismatch: '本方账号与本批不一致', own_account_ambiguous: '本方所在一侧不明确', counterparty_name_missing: '对手名称尚未可靠提取', counterparty_name_ambiguous: '对手名称有冲突', internal_account_incomplete: '内部对手银行或账号不完整', same_name_multiple_accounts: '同名涉及多个账号，请核对是否需要拆分', stale_basis: '依据已经变化，请重新核对', unsupported_layout: '当前版式尚未覆盖，请查看原件后人工核对',
};
export function groupingIssueLabel(code: string): string { return issueLabels[code] ?? '此项需要查看原件核对'; }
