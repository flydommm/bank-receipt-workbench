import { MIN_CROP_SIZE, type PdfRect } from './cropReview';
import {
  MAX_SEARCH_CRITERIA_CLAUSES, MAX_SEARCH_KEYWORD_CODE_POINTS,
  normalizeSearchCriteria, type SearchCriteria,
} from './searchCriteria';

// JSON names deliberately match Python. See docs/receipt-layout-contract.md.
export const RECEIPT_LAYOUT_SCHEMA_VERSION = 1 as const;
export const MAX_LAYOUT_SLOTS = 1000;
export type ProcessingMode = 'search' | 'split_all';
export type SelectionBasis = 'keyword' | 'occupied_slot' | 'manual_slot';
export type LayoutErrorCode = 'invalid_shape' | 'unsupported_version' | 'invalid_geometry'
  | 'invalid_layout' | 'invalid_instance' | 'invalid_selection' | 'invalid_processing'
  | 'unsupported_capability';

export class ReceiptLayoutError extends Error {
  constructor(public readonly code: LayoutErrorCode, public readonly path: string) {
    super(`${code}: ${path}`);
    this.name = 'ReceiptLayoutError';
  }
}

export type PageGeometry = {
  pdf_box: PdfRect; rotation: 0 | 90 | 180 | 270; user_unit: number;
  width_pt: number; height_pt: number;
};
export type ReceiptSlot = { slot_id: string; position_index: number; top_pt: number; height_pt: number };
export type LayoutDefinition = {
  schema_version: 1; layout_id: string; revision: number; workspace_id: string;
  issuer_id: string | null; family_id: string | null; evidence_version: string;
  page_geometry: PageGeometry; uniform_height: boolean; left_pt: number; right_pt: number;
  slots: ReceiptSlot[];
};
export type ReceiptInstance = {
  instance_id: string; source_sha256: string; page: number; layout_id: string;
  layout_revision: number; slot_id: string; position_index: number; rect: PdfRect;
  occupancy: 'occupied' | 'uncertain';
};
export type ReceiptCandidate = {
  instance_id: string; selection_basis: SelectionBasis;
  evidence: { query_id: string; rect: PdfRect }[]; needs_review: boolean;
};
export type ReceiptPageResult = {
  schema_version: 1; processing_mode: ProcessingMode; source_sha256: string; page: number;
  layout_definition: LayoutDefinition; instances: ReceiptInstance[];
  excluded_slots: { slot_id: string; reason: 'blank' | 'invalid' }[];
  candidates: ReceiptCandidate[];
};
export type ProcessingOptions = { processing_mode: 'search'; criteria: SearchCriteria }
  | { processing_mode: 'split_all'; criteria: null };
export type LayoutCapabilities = {
  contract_version: 1; processing_modes: ProcessingMode[]; layout_schema_versions: [1];
};

// P4 will validate and persist this binding at the backend transaction boundary.
// A frontend binding alone never authorizes saving or proves that a save occurred.
export type LayoutPreviewBinding = Readonly<{
  schema_version: 1; snapshot_id: string; operation_id: string; task_id: string; context_id: string;
  processing_mode: ProcessingMode; criteria_fingerprint: string | null;
  source_sha256s: readonly string[]; layout_hash: string; layout_revision: number;
  targets: readonly Readonly<{
    instance_id: string; source_sha256: string; page: number; slot_id: string;
    final_rect: Readonly<PdfRect>; review_revision: number;
    inclusion: 'automatic' | 'explicit_override'; accepted_risk_ids: readonly string[];
  }>[];
  excluded: readonly Readonly<{ instance_id: string; reason: string }>[];
}>;

function fail(code: LayoutErrorCode, path: string): never { throw new ReceiptLayoutError(code, path); }
function object(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_shape', path);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail('invalid_shape', path);
  return record;
}
function number(value: unknown, code: LayoutErrorCode, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code, path);
  return value;
}
function positiveInteger(value: unknown, code: LayoutErrorCode, path: string): number {
  const n = number(value, code, path);
  if (!Number.isSafeInteger(n) || n < 1) fail(code, path);
  return n;
}
function id(value: unknown, code: LayoutErrorCode, path: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) fail(code, path);
  return value;
}
function sha(value: unknown, code: LayoutErrorCode, path: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(code, path);
  return value;
}
function bool(value: unknown, code: LayoutErrorCode, path: string): boolean {
  if (typeof value !== 'boolean') fail(code, path);
  return value;
}
function array(value: unknown, max: number, code: LayoutErrorCode, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(code, path);
  return value;
}
function oneOf<const T extends string>(value: unknown, values: readonly T[], code: LayoutErrorCode, path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(code, path);
  return value as T;
}
function version(value: unknown, path: string): 1 {
  if (value !== 1) fail('unsupported_version', path);
  return 1;
}
export function near(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b)
    && Math.abs(a - b) <= 64 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}
function beyond(a: number, b: number): boolean { return a > b && !near(a, b); }
function rect(value: unknown, code: LayoutErrorCode, path: string): PdfRect {
  const obj = object(value, ['x0', 'y0', 'x1', 'y1'], path);
  const result = { x0: number(obj.x0, code, path), y0: number(obj.y0, code, path),
    x1: number(obj.x1, code, path), y1: number(obj.y1, code, path) };
  if (result.x1 <= result.x0 || result.y1 <= result.y0) fail(code, path);
  return result;
}
function sameRect(a: PdfRect, b: PdfRect): boolean {
  return near(a.x0, b.x0) && near(a.y0, b.y0) && near(a.x1, b.x1) && near(a.y1, b.y1);
}
function contains(outer: PdfRect, inner: PdfRect): boolean {
  return !beyond(outer.x0, inner.x0) && !beyond(outer.y0, inner.y0)
    && !beyond(inner.x1, outer.x1) && !beyond(inner.y1, outer.y1);
}
function intersects(a: PdfRect, b: PdfRect): boolean {
  return Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
}

export function parsePageGeometry(value: unknown, path = 'page_geometry'): PageGeometry {
  const o = object(value, ['pdf_box', 'rotation', 'user_unit', 'width_pt', 'height_pt'], path);
  const code = 'invalid_geometry';
  const box = rect(o.pdf_box, code, `${path}.pdf_box`);
  const rotation = number(o.rotation, code, `${path}.rotation`);
  if (![0, 90, 180, 270].includes(rotation)) fail(code, `${path}.rotation`);
  const unit = number(o.user_unit, code, `${path}.user_unit`);
  const width = number(o.width_pt, code, `${path}.width_pt`);
  const height = number(o.height_pt, code, `${path}.height_pt`);
  const w = (box.x1 - box.x0) * unit, h = (box.y1 - box.y0) * unit;
  if (unit <= 0 || width <= 0 || height <= 0 || w <= 0 || h <= 0 || !Number.isFinite(w) || !Number.isFinite(h)
    || !near(width, rotation % 180 ? h : w) || !near(height, rotation % 180 ? w : h)) fail(code, path);
  return { pdf_box: box, rotation: rotation as PageGeometry['rotation'], user_unit: unit, width_pt: width, height_pt: height };
}

export function parseLayoutDefinition(value: unknown, path = 'layout_definition'): LayoutDefinition {
  const o = object(value, ['schema_version', 'layout_id', 'revision', 'workspace_id', 'issuer_id',
    'family_id', 'evidence_version', 'page_geometry', 'uniform_height', 'left_pt', 'right_pt', 'slots'], path);
  version(o.schema_version, `${path}.schema_version`);
  const code = 'invalid_layout';
  const geometry = parsePageGeometry(o.page_geometry, `${path}.page_geometry`);
  const uniform = bool(o.uniform_height, code, `${path}.uniform_height`);
  const left = number(o.left_pt, code, `${path}.left_pt`), right = number(o.right_pt, code, `${path}.right_pt`);
  const minHeight = Math.min(MIN_CROP_SIZE, geometry.height_pt);
  const remainingWidth = (geometry.width_pt - right) - left;
  if (left < 0 || right < 0 || remainingWidth <= 0 || !Number.isFinite(remainingWidth)
    || (geometry.width_pt < MIN_CROP_SIZE && (left !== 0 || right !== 0))
    || beyond(Math.min(MIN_CROP_SIZE, geometry.width_pt), remainingWidth)) fail(code, path);
  const rawSlots = array(o.slots, Math.min(MAX_LAYOUT_SLOTS, Math.floor(geometry.height_pt / minHeight)), code, `${path}.slots`);
  if (!rawSlots.length) fail(code, `${path}.slots`);
  const ids = new Set<string>();
  const slots: ReceiptSlot[] = [];
  for (const [i, value] of rawSlots.entries()) {
    const slotPath = `${path}.slots[${i}]`;
    const s = object(value, ['slot_id', 'position_index', 'top_pt', 'height_pt'], slotPath);
    const slotId = id(s.slot_id, code, slotPath), position = positiveInteger(s.position_index, code, slotPath);
    const top = number(s.top_pt, code, slotPath), height = number(s.height_pt, code, slotPath);
    if (ids.has(slotId) || position !== i + 1 || top < 0 || height <= 0 || beyond(minHeight, height)
      || !Number.isFinite(top + height) || top + height <= top || beyond(top + height, geometry.height_pt)
      || (geometry.height_pt < MIN_CROP_SIZE && (top !== 0 || height !== geometry.height_pt))
      || (i > 0 && beyond(slots[i - 1].top_pt + slots[i - 1].height_pt, top))
      || (uniform && i > 0 && !near(slots[0].height_pt, height))) fail(code, slotPath);
    ids.add(slotId); slots.push({ slot_id: slotId, position_index: position, top_pt: top, height_pt: height });
  }
  return { schema_version: 1, layout_id: id(o.layout_id, code, path), revision: positiveInteger(o.revision, code, path),
    workspace_id: id(o.workspace_id, code, path), issuer_id: o.issuer_id === null ? null : id(o.issuer_id, code, path),
    family_id: o.family_id === null ? null : id(o.family_id, code, path), evidence_version: id(o.evidence_version, code, path),
    page_geometry: geometry, uniform_height: uniform, left_pt: left, right_pt: right, slots };
}

export function slotRect(layout: LayoutDefinition, slot: ReceiptSlot): PdfRect {
  return { x0: layout.left_pt, y0: slot.top_pt, x1: layout.page_geometry.width_pt - layout.right_pt, y1: slot.top_pt + slot.height_pt };
}
export function makeInstanceId(sourceSha256: string, page: number, layout: LayoutDefinition, slotId: string): string {
  sha(sourceSha256, 'invalid_instance', 'source_sha256'); positiveInteger(page, 'invalid_instance', 'page');
  id(layout.layout_id, 'invalid_instance', 'layout_id'); positiveInteger(layout.revision, 'invalid_instance', 'layout_revision');
  id(slotId, 'invalid_instance', 'slot_id');
  if (!layout.slots.some((slot) => slot.slot_id === slotId)) fail('invalid_instance', 'slot_id');
  return `receipt-v1:${sourceSha256}:${page}:${layout.layout_id}:${layout.revision}:${slotId}`;
}

export function parsePageResult(value: unknown, path = 'page_result'): ReceiptPageResult {
  const o = object(value, ['schema_version', 'processing_mode', 'source_sha256', 'page', 'layout_definition',
    'instances', 'excluded_slots', 'candidates'], path);
  version(o.schema_version, `${path}.schema_version`);
  const mode = oneOf(o.processing_mode, ['search', 'split_all'], 'invalid_processing', `${path}.processing_mode`);
  const source = sha(o.source_sha256, 'invalid_instance', path), page = positiveInteger(o.page, 'invalid_instance', path);
  const layout = parseLayoutDefinition(o.layout_definition, `${path}.layout_definition`);
  const slots = new Map(layout.slots.map((slot) => [slot.slot_id, slot]));
  const seenSlots = new Set<string>();
  const instances: ReceiptInstance[] = array(o.instances, slots.size, 'invalid_instance', path).map((value, i) => {
    const p = `${path}.instances[${i}]`, code = 'invalid_instance';
    const v = object(value, ['instance_id', 'source_sha256', 'page', 'layout_id', 'layout_revision', 'slot_id',
      'position_index', 'rect', 'occupancy'], p);
    const slotId = id(v.slot_id, code, p), slot = slots.get(slotId);
    if (!slot || seenSlots.has(slotId)) fail(code, p);
    seenSlots.add(slotId);
    const instanceId = makeInstanceId(source, page, layout, slotId);
    const box = rect(v.rect, code, `${p}.rect`);
    if (v.instance_id !== instanceId || v.source_sha256 !== source || v.page !== page || v.layout_id !== layout.layout_id
      || v.layout_revision !== layout.revision || v.position_index !== slot.position_index || !sameRect(box, slotRect(layout, slot))) fail(code, p);
    return { instance_id: instanceId, source_sha256: source, page, layout_id: layout.layout_id, layout_revision: layout.revision,
      slot_id: slotId, position_index: slot.position_index, rect: box, occupancy: oneOf(v.occupancy, ['occupied', 'uncertain'], code, p) };
  });
  const excluded = array(o.excluded_slots, slots.size, 'invalid_instance', path).map((value, i) => {
    const p = `${path}.excluded_slots[${i}]`, code = 'invalid_instance';
    const v = object(value, ['slot_id', 'reason'], p), slotId = id(v.slot_id, code, p);
    if (!slots.has(slotId) || seenSlots.has(slotId)) fail(code, p);
    seenSlots.add(slotId);
    return { slot_id: slotId, reason: oneOf(v.reason, ['blank', 'invalid'], code, p) };
  });
  if (seenSlots.size !== slots.size) fail('invalid_instance', `${path}.instances`);
  const instanceMap = new Map(instances.map((instance) => [instance.instance_id, instance]));
  const seenCandidates = new Set<string>();
  const paper = { x0: 0, y0: 0, x1: layout.page_geometry.width_pt, y1: layout.page_geometry.height_pt };
  let evidenceCount = 0;
  const candidates: ReceiptCandidate[] = array(o.candidates, instances.length, 'invalid_selection', path).map((value, i) => {
    const p = `${path}.candidates[${i}]`, code = 'invalid_selection';
    const v = object(value, ['instance_id', 'selection_basis', 'evidence', 'needs_review'], p);
    if (typeof v.instance_id !== 'string' || seenCandidates.has(v.instance_id)) fail(code, p);
    const instance = instanceMap.get(v.instance_id);
    if (!instance) fail(code, p);
    seenCandidates.add(instance.instance_id);
    const basis = oneOf(v.selection_basis, ['keyword', 'occupied_slot', 'manual_slot'], code, p);
    const review = bool(v.needs_review, code, p);
    const evidence = array(v.evidence, 10000 - evidenceCount, code, p).map((value, j) => {
      const ep = `${p}.evidence[${j}]`, e = object(value, ['query_id', 'rect'], ep);
      const r = rect(e.rect, code, ep);
      if (!contains(paper, r) || !intersects(instance.rect, r) || (!contains(instance.rect, r) && !review)) fail(code, ep);
      return { query_id: id(e.query_id, code, ep), rect: r };
    });
    evidenceCount += evidence.length;
    if ((mode === 'search' && basis !== 'keyword') || (mode === 'split_all' && basis === 'keyword')
      || (basis === 'keyword' ? !evidence.length : evidence.length > 0)
      || (instance.occupancy === 'uncertain' && basis !== 'manual_slot' && !review)) fail(code, p);
    return { instance_id: instance.instance_id, selection_basis: basis, evidence, needs_review: review };
  });
  if (mode === 'split_all' && candidates.length !== instances.length) fail('invalid_selection', `${path}.candidates`);
  return { schema_version: 1, processing_mode: mode, source_sha256: source, page, layout_definition: layout, instances, excluded_slots: excluded, candidates };
}

export function parseProcessingOptions(value: unknown): ProcessingOptions {
  const o = object(value, ['processing_mode', 'criteria'], 'processing_options'), code = 'invalid_processing';
  const mode = oneOf(o.processing_mode, ['search', 'split_all'], code, 'processing_mode');
  if (mode === 'split_all') {
    if (o.criteria !== null) fail(code, 'criteria');
    return { processing_mode: mode, criteria: null };
  }
  const c = object(o.criteria, ['include', 'includeMode', 'exclude'], 'criteria');
  const modeValue = oneOf(c.includeMode, ['all', 'any'], code, 'criteria.includeMode');
  const include = array(c.include, MAX_SEARCH_CRITERIA_CLAUSES, code, 'criteria.include');
  const exclude = array(c.exclude, MAX_SEARCH_CRITERIA_CLAUSES, code, 'criteria.exclude');
  if (include.length + exclude.length > MAX_SEARCH_CRITERIA_CLAUSES
    || [...include, ...exclude].some((x) => typeof x !== 'string' || !x.trim()
      || [...x].some((char) => { const n = char.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })
      || [...x.normalize('NFC').trim()].length > MAX_SEARCH_KEYWORD_CODE_POINTS)) fail(code, 'criteria');
  const criteria = normalizeSearchCriteria({ include, includeMode: modeValue, exclude });
  if (!criteria) fail(code, 'criteria');
  return { processing_mode: mode, criteria };
}

export function legacyProcessingMode(value: unknown): ProcessingMode {
  return value === undefined ? 'search' : oneOf(value, ['search', 'split_all'], 'invalid_processing', 'processing_mode');
}
export function parseCapabilities(value: unknown): LayoutCapabilities {
  const o = object(value, ['contract_version', 'processing_modes', 'layout_schema_versions'], 'capabilities');
  version(o.contract_version, 'capabilities.contract_version');
  const modes = array(o.processing_modes, 2, 'unsupported_capability', 'processing_modes')
    .map((mode) => oneOf(mode, ['search', 'split_all'], 'unsupported_capability', 'processing_modes'));
  if (!modes.length || new Set(modes).size !== modes.length) fail('unsupported_capability', 'processing_modes');
  const schemas = array(o.layout_schema_versions, 1, 'unsupported_capability', 'layout_schema_versions');
  if (schemas.length !== 1 || schemas[0] !== 1) fail('unsupported_capability', 'layout_schema_versions');
  return { contract_version: 1, processing_modes: modes, layout_schema_versions: [1] };
}
export function requireLayoutCapability(host: unknown, engine: unknown, mode: ProcessingMode): void {
  for (const endpoint of [host, engine]) {
    if (!parseCapabilities(endpoint).processing_modes.includes(mode)) fail('unsupported_capability', 'processing_mode');
  }
}

export function changedSlotIds(beforeValue: LayoutDefinition, afterValue: LayoutDefinition): string[] {
  const before = parseLayoutDefinition(beforeValue), after = parseLayoutDefinition(afterValue);
  const all = [...new Set([...before.slots, ...after.slots].map((s) => s.slot_id))];
  const a = before.page_geometry, b = after.page_geometry;
  const sharedChanged = before.layout_id !== after.layout_id || before.workspace_id !== after.workspace_id
    || before.issuer_id !== after.issuer_id || before.family_id !== after.family_id || before.evidence_version !== after.evidence_version
    || before.uniform_height !== after.uniform_height || !near(before.left_pt, after.left_pt) || !near(before.right_pt, after.right_pt)
    || !sameRect(a.pdf_box, b.pdf_box) || a.rotation !== b.rotation || !near(a.user_unit, b.user_unit)
    || !near(a.width_pt, b.width_pt) || !near(a.height_pt, b.height_pt) || before.slots.length !== after.slots.length
    || before.slots.some((s, i) => s.slot_id !== after.slots[i]?.slot_id)
    || (after.uniform_height && !near(before.slots[0].height_pt, after.slots[0].height_pt));
  if (sharedChanged) return all;
  return before.slots.filter((s, i) => !near(s.top_pt, after.slots[i].top_pt) || !near(s.height_pt, after.slots[i].height_pt)).map((s) => s.slot_id);
}
export function canIncludeTarget(humanAdjusted: boolean, explicitFullPage: boolean, includeOverride: boolean): boolean {
  bool(humanAdjusted, 'invalid_selection', 'human_adjusted');
  bool(explicitFullPage, 'invalid_selection', 'explicit_full_page');
  bool(includeOverride, 'invalid_selection', 'include_override');
  return includeOverride || (!humanAdjusted && !explicitFullPage);
}
