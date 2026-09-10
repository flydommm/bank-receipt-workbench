/**
 * Runtime-checked domain contracts for the persistent batch task protocol.
 *
 * This module intentionally has no Tauri or React dependency.  It validates
 * data at the webview boundary and keeps the Python snake_case result model
 * intact until a later UI adapter chooses a presentation shape.
 */

import { normalizeSourcePath } from './sourcePreview';

export const BATCH_MAX_SOURCES = 10_000;
export const BATCH_MAX_RESULT_ITEMS = 50_000;
export const BATCH_MAX_RESULT_PAGE_ITEMS = 200;
export const BATCH_MAX_IDENTIFIER_BYTES = 1_024;
export const BATCH_MAX_PATH_BYTES = 32_768;
export const BATCH_MAX_NAME_BYTES = 1_024;
export const BATCH_MAX_KEYWORD_CODEPOINTS = 512;
export const BATCH_MAX_CRITERIA_CLAUSES = 32;
export const BATCH_MAX_PAGE_COUNT = 5_000;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const SHA256 = /^[a-f0-9]{64}$/i;
const BUDGET_LIMITS = {
  processed_pages: 5_000,
  text_characters: 64_000_000,
  fuzzy_work: 64_000_000,
  matches: 10_000,
  matched_text_characters: 8_000_000,
} as const;

export const BATCH_JOB_STATES = [
  'queued', 'validating', 'running', 'pause_requested', 'paused',
  'partial_failed', 'finalizing', 'ready_for_review', 'blocked',
  'cancel_requested', 'cancelled', 'interrupted', 'archived',
] as const;
export type BatchJobState = typeof BATCH_JOB_STATES[number];

export const BATCH_SOURCE_STATES = ['pending', 'registered', 'verified', 'failed', 'blocked'] as const;
export type BatchSourceState = typeof BATCH_SOURCE_STATES[number];

export const BATCH_PAGE_STATES = ['pending', 'processing', 'succeeded', 'failed'] as const;
export type BatchPageState = typeof BATCH_PAGE_STATES[number];

export type BatchMatchMode = 'exact' | 'fuzzy';
export type BatchIncludeMode = 'all' | 'any';

export type BatchCriteria = {
  include: string[];
  includeMode: BatchIncludeMode;
  exclude: string[];
};

export type BatchCreateSource = {
  source_path: string;
  name: string;
};

export type BatchBudget = {
  processed_pages: number;
  text_characters: number;
  fuzzy_work: number;
  matches: number;
  matched_text_characters: number;
};

export type BatchPageSummary = {
  pending: number;
  processing: number;
  succeeded: number;
  failed: number;
};

export type BatchSourceSummary = {
  total: number;
  pending: number;
  registered: number;
  verified: number;
  failed: number;
  blocked: number;
  declared_pages: number;
};

export type BatchSourceSnapshot = {
  source_id: string;
  position: number;
  source_key: string;
  initial_path: string;
  access_path: string;
  name: string;
  sha256: string | null;
  size_bytes: number | null;
  page_count: number | null;
  state: BatchSourceState;
  error: JsonValue | null;
  budget: BatchBudget;
  verified_generation: number | null;
  page_summary: BatchPageSummary;
};

export type BatchJobSnapshot = {
  id: string;
  name: string;
  generation: number;
  state: BatchJobState;
  resume_target: string | null;
  criteria: BatchCriteria;
  criteria_fingerprint: string;
  match_mode: BatchMatchMode;
  computation_version: string;
  result_revision: string | null;
  owner: string | null;
  error: JsonValue | null;
  created_at: string;
  updated_at: string;
  deletion_pending: boolean;
  page_summary: BatchPageSummary;
  total_pages: number;
  sources: BatchSourceSnapshot[];
};

export type BatchJobSummary = Omit<BatchJobSnapshot, 'sources'> & {
  source_summary: BatchSourceSummary;
};

export type BatchListResult = {
  items: BatchJobSummary[];
  offset: number;
  limit: number;
  total: number;
  next_offset: number | null;
};

export type BatchRect = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type BatchSnapshotSegment = {
  id: string;
  source_key: string;
  source_path: string;
  source_sha256: string;
  source_page: number;
  segment_no: number;
  match_rect: BatchRect;
  candidate_rect: BatchRect | null;
  final_rect: BatchRect | null;
  page_width: number;
  page_height: number;
  confidence: number;
  slot: string | null;
  snap_points: number[];
  layout_fingerprint: string;
  crop_mode: 'candidate' | 'full_page';
  review_status: 'blocked' | 'needs_review' | 'confirmed';
  manual_adjusted: false;
};

export type BatchSnapshotEvidence = {
  page: number;
  matched_text: string;
  matched_field: string | null;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  needs_review?: boolean;
  query_id?: string;
  role?: 'include' | 'exclude';
};

export type BatchSnapshotOriginal = {
  id: string;
  source_key: string;
  source_page: number;
  segment_no: number;
  analysis_signature: string;
  persistable: boolean;
  page_width: number;
  page_height: number;
  match_rect: BatchRect | null;
  candidate_rect: BatchRect | null;
  layout_fingerprint: string;
  confidence: number;
  auto_full_page: boolean;
};

export type BatchResultItem = {
  segment: BatchSnapshotSegment;
  evidence: BatchSnapshotEvidence[];
  original: BatchSnapshotOriginal;
};

export type BatchResultsPage = {
  result_revision: string;
  offset: number;
  limit: number;
  total: number;
  next_offset: number | null;
  items: BatchResultItem[];
};

export type BatchControlAction = 'pause' | 'cancel' | 'archive';
export type BatchControlResult = {
  status: 'ok' | 'already_completed' | 'already_archived';
  job_id: string;
  generation: number;
  command_id: string;
  action: BatchControlAction;
  state: BatchJobState;
};

export type BatchRelocateResult = BatchJobSnapshot;

export type BatchCreateRequest = {
  op: 'batch_create';
  name: string;
  sources: BatchCreateSource[];
  criteria: BatchCriteria;
  match_mode: BatchMatchMode;
};
export type BatchStartRequest = { op: 'batch_start'; job_id: string; generation: number };
export type BatchSnapshotRequest = { op: 'batch_snapshot'; job_id: string };
export type BatchListRequest = { op: 'batch_list'; offset: number; limit: number };
export type BatchControlRequest = {
  op: 'batch_control';
  job_id: string;
  generation: number;
  command_id: string;
  action: BatchControlAction;
};
export type BatchResultsPageRequest = {
  op: 'batch_results_page';
  job_id: string;
  result_revision: string;
  offset: number;
  limit: number;
};
export type BatchRelocateRequest = {
  op: 'batch_relocate';
  job_id: string;
  source_id: string;
  new_path: string;
};

export type BatchRequest =
  | BatchCreateRequest
  | BatchStartRequest
  | BatchSnapshotRequest
  | BatchListRequest
  | BatchControlRequest
  | BatchResultsPageRequest
  | BatchRelocateRequest;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type BatchWorkerEventType = 'snapshot' | 'progress' | 'page_failed' | 'state_changed' | 'completed';
export type BatchWorkerEvent = {
  protocol: 2;
  jobId: string;
  generation: number;
  seq: number;
  type: BatchWorkerEventType;
  payload: Record<string, JsonValue>;
};

export type BatchEventState = {
  jobId: string;
  generation: number;
  nextSeq: number;
  sequenceExhausted: boolean;
  lastEvent: BatchWorkerEvent | null;
  snapshotRequired: boolean;
  terminal: boolean;
};

export type BatchEventRejectReason =
  | 'invalid'
  | 'stale_job'
  | 'stale_generation'
  | 'snapshot_required'
  | 'duplicate'
  | 'out_of_order'
  | 'completed';

export type BatchEventMergeResult =
  | { accepted: true; state: BatchEventState; event: BatchWorkerEvent }
  | { accepted: false; state: BatchEventState; reason: BatchEventRejectReason };

export class BatchTaskValidationError extends Error {
  constructor(message = '批任务数据无效。') {
    super(message);
    this.name = 'BatchTaskValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(message: string): never {
  throw new BatchTaskValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).length === required.length + Object.keys(value).filter((key) => optional.includes(key)).length
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function text(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && utf8Bytes(value) <= maxBytes;
}

function safeInteger(value: unknown, minimum = 0, maximum = MAX_SAFE): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function jsonValue(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }): value is JsonValue {
  if (depth > 16 || budget.nodes++ > 4_096) return false;
  if (value === null) { budget.bytes += 4; return budget.bytes <= 64 * 1024; }
  if (typeof value === 'string') {
    if (value.includes('\0')) return false;
    budget.bytes += utf8Bytes(value) + 2;
    return budget.bytes <= 64 * 1024;
  }
  if (typeof value === 'boolean') { budget.bytes += 5; return budget.bytes <= 64 * 1024; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    budget.bytes += String(value).length;
    return budget.bytes <= 64 * 1024;
  }
  if (Array.isArray(value)) {
    if (value.length > 4_096) return false;
    return value.every((child) => jsonValue(child, depth + 1, budget));
  }
  if (!isRecord(value) || Object.keys(value).length > 4_096) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key.includes('\0') || !jsonValue(key, depth + 1, budget) || !jsonValue(child, depth + 1, budget)) return false;
  }
  return true;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function cloneJson<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return fail('批任务数据不可复制。');
  }
}

function validateCriteria(value: unknown): BatchCriteria {
  if (!isRecord(value) || !exactKeys(value, ['include', 'includeMode', 'exclude'])
    || !Array.isArray(value.include) || !Array.isArray(value.exclude)
    || !oneOf(value.includeMode, ['all', 'any'] as const)) {
    return fail('搜索条件无效。');
  }
  const normalizeKeywords = (incoming: unknown[]): string[] => {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const raw of incoming) {
      // Match the existing searchCriteria normalizer and Python's
      // normalize_criteria: malformed entries are ignored, while each list
      // is independently NFC-normalized, trimmed, and deduplicated.
      if (typeof raw !== 'string') continue;
      const keyword = raw.trim().normalize('NFC');
      if (!keyword || seen.has(keyword)) continue;
      if (Array.from(keyword).length > BATCH_MAX_KEYWORD_CODEPOINTS) return fail('搜索关键词过长。');
      seen.add(keyword);
      result.push(keyword);
    }
    return result;
  };
  const include = normalizeKeywords(value.include);
  const exclude = normalizeKeywords(value.exclude);
  if (include.length === 0 || include.length + exclude.length > BATCH_MAX_CRITERIA_CLAUSES) {
    return fail('搜索条件无效。');
  }
  return {
    include,
    includeMode: value.includeMode,
    exclude,
  };
}

function validateRect(value: unknown, width?: number, height?: number): BatchRect {
  if (!isRecord(value) || !exactKeys(value, ['x0', 'y0', 'x1', 'y1'])
    || !finiteNumber(value.x0) || !finiteNumber(value.y0) || !finiteNumber(value.x1) || !finiteNumber(value.y1)
    || value.x0 < 0 || value.y0 < 0 || value.x0 >= value.x1 || value.y0 >= value.y1
    || (width !== undefined && value.x1 > width) || (height !== undefined && value.y1 > height)) {
    return fail('图形范围无效。');
  }
  return { x0: value.x0, y0: value.y0, x1: value.x1, y1: value.y1 };
}

function optionalRect(value: unknown, width?: number, height?: number): BatchRect | null {
  return value === null ? null : validateRect(value, width, height);
}

function validateBudget(value: unknown): BatchBudget {
  const fields = Object.keys(BUDGET_LIMITS) as (keyof typeof BUDGET_LIMITS)[];
  if (!isRecord(value) || !exactKeys(value, fields)
    || fields.some((field) => !safeInteger(value[field], 0, BUDGET_LIMITS[field]))) {
    return fail('任务预算无效。');
  }
  return Object.fromEntries(fields.map((field) => [field, value[field]])) as BatchBudget;
}

function validatePageSummary(value: unknown): BatchPageSummary {
  const fields = ['pending', 'processing', 'succeeded', 'failed'] as const;
  if (!isRecord(value) || !exactKeys(value, fields) || fields.some((field) => !safeInteger(value[field]))) {
    return fail('页统计无效。');
  }
  return Object.fromEntries(fields.map((field) => [field, value[field]])) as BatchPageSummary;
}

function validateSourceSummary(value: unknown): BatchSourceSummary {
  const fields = ['total', 'pending', 'registered', 'verified', 'failed', 'blocked', 'declared_pages'] as const;
  if (!isRecord(value) || !exactKeys(value, fields) || fields.some((field) => !safeInteger(value[field]))) {
    return fail('来源统计无效。');
  }
  const result = Object.fromEntries(fields.map((field) => [field, value[field]])) as BatchSourceSummary;
  if (result.pending + result.registered + result.verified + result.failed + result.blocked !== result.total) {
    return fail('来源统计不一致。');
  }
  return result;
}

function validateSource(value: unknown, expectedPosition?: number): BatchSourceSnapshot {
  const fields = [
    'source_id', 'position', 'source_key', 'initial_path', 'access_path', 'name', 'sha256',
    'size_bytes', 'page_count', 'state', 'error', 'budget', 'verified_generation', 'page_summary',
  ] as const;
  if (!isRecord(value) || !exactKeys(value, fields)
    || !text(value.source_id, BATCH_MAX_IDENTIFIER_BYTES) || !safeInteger(value.position)
    || (expectedPosition !== undefined && value.position !== expectedPosition)
    || !text(value.source_key, BATCH_MAX_PATH_BYTES) || !text(value.initial_path, BATCH_MAX_PATH_BYTES)
    || !text(value.access_path, BATCH_MAX_PATH_BYTES) || !text(value.name, BATCH_MAX_NAME_BYTES)
    || !oneOf(value.state, BATCH_SOURCE_STATES)
    || (value.sha256 !== null && (!text(value.sha256, 128) || !SHA256.test(value.sha256)))
    || (value.size_bytes !== null && !safeInteger(value.size_bytes))
    || (value.page_count !== null && !safeInteger(value.page_count, 1, BATCH_MAX_PAGE_COUNT))
    || (value.verified_generation !== null && !safeInteger(value.verified_generation))
    || (value.error !== null && !jsonValue(value.error))
    || !jsonValue(value.budget) || !jsonValue(value.page_summary)) {
    return fail('任务来源无效。');
  }
  const budget = validateBudget(value.budget);
  const pageSummary = validatePageSummary(value.page_summary);
  if (value.source_key !== normalizeSourcePath(value.initial_path)) return fail('来源逻辑身份不一致。');
  if (value.page_count !== null
    && pageSummary.pending + pageSummary.processing + pageSummary.succeeded + pageSummary.failed !== value.page_count) {
    return fail('来源页数统计不一致。');
  }
  return {
    source_id: value.source_id,
    position: value.position,
    source_key: value.source_key,
    initial_path: value.initial_path,
    access_path: value.access_path,
    name: value.name,
    sha256: value.sha256 === null ? null : value.sha256.toLowerCase(),
    size_bytes: value.size_bytes,
    page_count: value.page_count,
    state: value.state,
    error: value.error === null ? null : cloneJson(value.error),
    budget,
    verified_generation: value.verified_generation,
    page_summary: pageSummary,
  };
}

function validateJob(value: unknown, includeSources: true): BatchJobSnapshot;
function validateJob(value: unknown, includeSources: false): BatchJobSummary;
function validateJob(value: unknown, includeSources: boolean): BatchJobSnapshot | BatchJobSummary {
  const base = [
    'id', 'name', 'generation', 'state', 'resume_target', 'criteria', 'criteria_fingerprint', 'match_mode',
    'computation_version', 'result_revision', 'owner', 'error', 'created_at', 'updated_at', 'deletion_pending',
    'page_summary', 'total_pages',
  ] as const;
  const required = includeSources ? [...base, 'sources'] : [...base, 'source_summary'];
  if (!isRecord(value) || !exactKeys(value, required)
    || !text(value.id, BATCH_MAX_IDENTIFIER_BYTES) || !text(value.name, BATCH_MAX_NAME_BYTES)
    || !safeInteger(value.generation) || !oneOf(value.state, BATCH_JOB_STATES)
    || (value.resume_target !== null && !text(value.resume_target, BATCH_MAX_IDENTIFIER_BYTES))
    || !text(value.criteria_fingerprint, 128) || !SHA256.test(value.criteria_fingerprint)
    || !oneOf(value.match_mode, ['exact', 'fuzzy'] as const) || !text(value.computation_version, 256)
    || (value.result_revision !== null && !text(value.result_revision, BATCH_MAX_IDENTIFIER_BYTES))
    || (value.owner !== null && !text(value.owner, BATCH_MAX_IDENTIFIER_BYTES))
    || (value.error !== null && !jsonValue(value.error)) || !text(value.created_at, 128) || !text(value.updated_at, 128)
    || typeof value.deletion_pending !== 'boolean' || !jsonValue(value.page_summary) || !safeInteger(value.total_pages)
    || (includeSources ? !Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > BATCH_MAX_SOURCES : !jsonValue(value.source_summary))) {
    return fail('任务快照无效。');
  }
  const criteria = validateCriteria(value.criteria);
  const pageSummary = validatePageSummary(value.page_summary);
  if (pageSummary.pending + pageSummary.processing + pageSummary.succeeded + pageSummary.failed !== value.total_pages) {
    return fail('任务页统计不一致。');
  }
  if (!includeSources) {
    const sourceSummary = validateSourceSummary(value.source_summary);
    return {
      id: value.id, name: value.name, generation: value.generation, state: value.state,
      resume_target: value.resume_target, criteria, criteria_fingerprint: value.criteria_fingerprint.toLowerCase(),
      match_mode: value.match_mode, computation_version: value.computation_version,
      result_revision: value.result_revision, owner: value.owner, error: value.error === null ? null : cloneJson(value.error),
      created_at: value.created_at, updated_at: value.updated_at, deletion_pending: value.deletion_pending,
      page_summary: pageSummary, total_pages: value.total_pages, source_summary: sourceSummary,
    };
  }
  const rawSources = value.sources;
  if (!Array.isArray(rawSources)) return fail('任务来源无效。');
  const sources = rawSources.map((source, index) => validateSource(source, index));
  const sourceIds = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.source_id) || sourceKeys.has(source.source_key)) return fail('任务来源重复。');
    sourceIds.add(source.source_id);
    sourceKeys.add(source.source_key);
  }
  return {
    id: value.id, name: value.name, generation: value.generation, state: value.state,
    resume_target: value.resume_target, criteria, criteria_fingerprint: value.criteria_fingerprint.toLowerCase(),
    match_mode: value.match_mode, computation_version: value.computation_version,
    result_revision: value.result_revision, owner: value.owner, error: value.error === null ? null : cloneJson(value.error),
    created_at: value.created_at, updated_at: value.updated_at, deletion_pending: value.deletion_pending,
    page_summary: pageSummary, total_pages: value.total_pages, sources,
  };
}

export function parseBatchJobSnapshot(value: unknown): BatchJobSnapshot {
  return validateJob(value, true);
}

export function parseBatchJobSummary(value: unknown): BatchJobSummary {
  return validateJob(value, false);
}

export function parseBatchList(value: unknown): BatchListResult {
  if (!isRecord(value) || !exactKeys(value, ['items', 'offset', 'limit', 'total', 'next_offset'])
    || !Array.isArray(value.items) || value.items.length > 50 || !safeInteger(value.offset)
    || !safeInteger(value.limit, 1, 50) || !safeInteger(value.total)
    || (value.next_offset !== null && !safeInteger(value.next_offset))) {
    return fail('任务列表无效。');
  }
  const items = value.items.map(parseBatchJobSummary);
  if (value.next_offset !== null && value.next_offset !== value.offset + items.length) return fail('任务列表游标无效。');
  // A stale page cursor may be beyond the current total after jobs are
  // removed.  The store returns an empty terminal page in that case; retain
  // strict bounds for non-empty pages and for pages that still claim data.
  if ((items.length > 0 && value.offset + items.length > value.total)
    || (value.offset + items.length < value.total) !== (value.next_offset !== null)) {
    return fail('任务列表统计不一致。');
  }
  return { items, offset: value.offset, limit: value.limit, total: value.total, next_offset: value.next_offset };
}

export function parseBatchResultsPage(value: unknown, expectedRevision?: string): BatchResultsPage {
  if (!isRecord(value) || !exactKeys(value, ['result_revision', 'offset', 'limit', 'total', 'next_offset', 'items'])
    || !text(value.result_revision, BATCH_MAX_IDENTIFIER_BYTES)
    || (expectedRevision !== undefined && value.result_revision !== expectedRevision)
    || !safeInteger(value.offset) || !safeInteger(value.limit, 1, BATCH_MAX_RESULT_PAGE_ITEMS)
    || !safeInteger(value.total, 0, BATCH_MAX_RESULT_ITEMS) || !Array.isArray(value.items)
    || value.items.length > value.limit || (value.next_offset !== null && !safeInteger(value.next_offset))) {
    return fail('结果页无效。');
  }
  const items = value.items.map(parseBatchResultItem);
  const end = value.offset + items.length;
  if (value.offset > value.total || (value.total === 0 && items.length !== 0)
    || (end < value.total && value.next_offset !== end)
    || (end >= value.total && (end !== value.total || value.next_offset !== null))) {
    return fail('结果页游标不一致。');
  }
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.segment.id)) return fail('结果页包含重复片段。');
    ids.add(item.segment.id);
  }
  return { result_revision: value.result_revision, offset: value.offset, limit: value.limit, total: value.total,
    next_offset: value.next_offset, items };
}

export function parseBatchResultItem(value: unknown): BatchResultItem {
  if (!isRecord(value) || !exactKeys(value, ['segment', 'evidence', 'original'])
    || !isRecord(value.segment) || !Array.isArray(value.evidence) || !isRecord(value.original)) {
    return fail('结果片段无效。');
  }
  const original = validateOriginal(value.original);
  const segment = validateSegment(value.segment, original);
  const evidence = validateEvidence(value.evidence, segment);
  return { segment, evidence, original };
}

function validateOriginal(value: Record<string, unknown>): BatchSnapshotOriginal {
  const fields = [
    'id', 'source_key', 'source_page', 'segment_no', 'analysis_signature', 'persistable', 'page_width', 'page_height',
    'match_rect', 'candidate_rect', 'layout_fingerprint', 'confidence', 'auto_full_page',
  ] as const;
  if (!exactKeys(value, fields) || !text(value.id, BATCH_MAX_IDENTIFIER_BYTES)
    || !text(value.source_key, BATCH_MAX_PATH_BYTES) || !safeInteger(value.source_page, 1)
    || !safeInteger(value.segment_no, 1) || !text(value.analysis_signature, 128) || !SHA256.test(value.analysis_signature)
    || typeof value.persistable !== 'boolean' || !finiteNumber(value.page_width) || value.page_width <= 0
    || !finiteNumber(value.page_height) || value.page_height <= 0 || !text(value.layout_fingerprint, BATCH_MAX_IDENTIFIER_BYTES)
    || !finiteNumber(value.confidence) || value.confidence < 0 || value.confidence > 1
    || typeof value.auto_full_page !== 'boolean') {
    return fail('原始片段无效。');
  }
  const matchRect = optionalRect(value.match_rect, value.page_width, value.page_height);
  const candidateRect = optionalRect(value.candidate_rect, value.page_width, value.page_height);
  if (value.persistable && matchRect === null) return fail('原始片段范围无效。');
  return {
    id: value.id, source_key: value.source_key, source_page: value.source_page, segment_no: value.segment_no,
    analysis_signature: value.analysis_signature.toLowerCase(), persistable: value.persistable,
    page_width: value.page_width, page_height: value.page_height, match_rect: matchRect, candidate_rect: candidateRect,
    layout_fingerprint: value.layout_fingerprint, confidence: value.confidence, auto_full_page: value.auto_full_page,
  };
}

function validateSegment(value: Record<string, unknown>, original: BatchSnapshotOriginal): BatchSnapshotSegment {
  const fields = [
    'id', 'source_key', 'source_path', 'source_sha256', 'source_page', 'segment_no', 'match_rect', 'candidate_rect',
    'final_rect', 'page_width', 'page_height', 'confidence', 'slot', 'snap_points', 'layout_fingerprint', 'crop_mode',
    'review_status', 'manual_adjusted',
  ] as const;
  if (!exactKeys(value, fields) || !text(value.id, BATCH_MAX_IDENTIFIER_BYTES)
    || !text(value.source_key, BATCH_MAX_PATH_BYTES) || !text(value.source_path, BATCH_MAX_PATH_BYTES)
    || !text(value.source_sha256, 128) || !SHA256.test(value.source_sha256) || !safeInteger(value.source_page, 1)
    || !safeInteger(value.segment_no, 1) || !finiteNumber(value.page_width) || value.page_width <= 0
    || !finiteNumber(value.page_height) || value.page_height <= 0 || !finiteNumber(value.confidence)
    || value.confidence < 0 || value.confidence > 1 || (value.slot !== null && !text(value.slot, 1_024))
    || !Array.isArray(value.snap_points) || value.snap_points.length > 4_096
    || !value.snap_points.every((point) => finiteNumber(point) && point >= 0 && point <= (value.page_height as number))
    || !text(value.layout_fingerprint, BATCH_MAX_IDENTIFIER_BYTES)
    || !oneOf(value.crop_mode, ['candidate', 'full_page'] as const)
    || !oneOf(value.review_status, ['blocked', 'needs_review', 'confirmed'] as const)
    || value.manual_adjusted !== false
    || value.id !== original.id || value.source_key !== original.source_key || value.source_page !== original.source_page
    || value.segment_no !== original.segment_no || value.page_width !== original.page_width
    || value.page_height !== original.page_height || value.confidence !== original.confidence
    || value.layout_fingerprint !== original.layout_fingerprint || value.source_key.length === 0) {
    return fail('结果片段身份或字段无效。');
  }
  const pageWidth = value.page_width as number;
  const pageHeight = value.page_height as number;
  const matchRect = validateRect(value.match_rect, pageWidth, pageHeight);
  const candidateRect = optionalRect(value.candidate_rect, pageWidth, pageHeight);
  const finalRect = optionalRect(value.final_rect, pageWidth, pageHeight);
  if (JSON.stringify(matchRect) !== JSON.stringify(original.match_rect)
    || JSON.stringify(candidateRect) !== JSON.stringify(original.candidate_rect)
    || (value.crop_mode === 'full_page') !== original.auto_full_page
    || (value.crop_mode === 'full_page' ? finalRect !== null : JSON.stringify(finalRect) !== JSON.stringify(candidateRect))) {
    return fail('结果片段几何不一致。');
  }
  return {
    id: value.id, source_key: value.source_key, source_path: value.source_path, source_sha256: value.source_sha256.toLowerCase(),
    source_page: value.source_page, segment_no: value.segment_no, match_rect: matchRect, candidate_rect: candidateRect,
    final_rect: finalRect, page_width: value.page_width, page_height: value.page_height, confidence: value.confidence,
    slot: value.slot, snap_points: [...value.snap_points] as number[], layout_fingerprint: value.layout_fingerprint,
    crop_mode: value.crop_mode, review_status: value.review_status, manual_adjusted: false,
  };
}

function validateEvidence(value: unknown[], segment: BatchSnapshotSegment): BatchSnapshotEvidence[] {
  const required = ['page', 'matched_text', 'matched_field', 'confidence', 'x0', 'y0', 'x1', 'y1'] as const;
  const optional = ['needs_review', 'query_id', 'role'] as const;
  if (value.length === 0 || value.length > BUDGET_LIMITS.matches) return fail('结果证据无效。');
  let representative = false;
  const evidence = value.map((incoming) => {
    if (!isRecord(incoming) || !exactKeys(incoming, required, optional)
      || !safeInteger(incoming.page, 1) || incoming.page !== segment.source_page
      || !text(incoming.matched_text, 65_536) || (incoming.matched_field !== null && !text(incoming.matched_field, 1_024))
      || !finiteNumber(incoming.confidence) || incoming.confidence < 0 || incoming.confidence > 1
      || !finiteNumber(incoming.x0) || !finiteNumber(incoming.y0) || !finiteNumber(incoming.x1) || !finiteNumber(incoming.y1)
      || incoming.x0 < 0 || incoming.y0 < 0 || incoming.x0 >= incoming.x1 || incoming.y0 >= incoming.y1
      || ('needs_review' in incoming && typeof incoming.needs_review !== 'boolean')
      || (('query_id' in incoming) !== ('role' in incoming))
      || ('query_id' in incoming && (!text(incoming.query_id, BATCH_MAX_IDENTIFIER_BYTES) || !oneOf(incoming.role, ['include', 'exclude'] as const)))) {
      return fail('结果证据无效。');
    }
    if (incoming.x0 === segment.match_rect.x0 && incoming.y0 === segment.match_rect.y0
      && incoming.x1 === segment.match_rect.x1 && incoming.y1 === segment.match_rect.y1) representative = true;
    return {
      page: incoming.page, matched_text: incoming.matched_text, matched_field: incoming.matched_field,
      confidence: incoming.confidence, x0: incoming.x0, y0: incoming.y0, x1: incoming.x1, y1: incoming.y1,
      ...(incoming.needs_review === undefined ? {} : { needs_review: incoming.needs_review }),
      ...(incoming.query_id === undefined ? {} : { query_id: incoming.query_id, role: incoming.role }),
    } as BatchSnapshotEvidence;
  });
  if (!representative) return fail('结果证据与片段范围不一致。');
  return evidence;
}

export function parseBatchControlResult(value: unknown): BatchControlResult {
  const fields = ['status', 'job_id', 'generation', 'command_id', 'action', 'state'] as const;
  if (!isRecord(value) || !exactKeys(value, fields) || !oneOf(value.status, ['ok', 'already_completed', 'already_archived'] as const)
    || !text(value.job_id, BATCH_MAX_IDENTIFIER_BYTES) || !safeInteger(value.generation)
    || !text(value.command_id, BATCH_MAX_IDENTIFIER_BYTES) || !oneOf(value.action, ['pause', 'cancel', 'archive'] as const)
    || !oneOf(value.state, BATCH_JOB_STATES)) return fail('任务控制响应无效。');
  return { status: value.status, job_id: value.job_id, generation: value.generation, command_id: value.command_id,
    action: value.action, state: value.state };
}

export function parseBatchResponse<T>(value: unknown, parseData: (data: unknown) => T): BatchResponse<T> {
  if (!isRecord(value) || typeof value.status !== 'string') return fail('任务响应无效。');
  if (value.status === 'error') {
    if (!exactKeys(value, ['status', 'code', 'message']) || !text(value.code, BATCH_MAX_IDENTIFIER_BYTES)
      || !text(value.message, 65_536)) return fail('任务错误响应无效。');
    return { status: 'error', code: value.code, message: value.message };
  }
  if (value.status !== 'ok' || !exactKeys(value, ['status', 'data'])) return fail('任务成功响应无效。');
  return { status: 'ok', data: parseData(value.data) };
}

export type BatchResponse<T> =
  | { status: 'ok'; data: T }
  | { status: 'error'; code: string; message: string };

export function validateBatchRequest(request: unknown): BatchRequest {
  if (!isRecord(request) || typeof request.op !== 'string') return fail('任务请求无效。');
  switch (request.op) {
    case 'batch_create': {
      if (!exactKeys(request, ['op', 'name', 'sources', 'criteria', 'match_mode']) || !text(request.name, BATCH_MAX_NAME_BYTES)
        || !Array.isArray(request.sources) || request.sources.length === 0 || request.sources.length > BATCH_MAX_SOURCES)
        return fail('任务创建请求无效。');
      const sources = request.sources.map((source) => {
        if (!isRecord(source) || !exactKeys(source, ['source_path', 'name'])
          || !text(source.source_path, BATCH_MAX_PATH_BYTES) || !text(source.name, BATCH_MAX_NAME_BYTES)) return fail('任务来源请求无效。');
        return { source_path: source.source_path, name: source.name };
      });
      const keys = new Set(sources.map((source) => normalizeSourcePath(source.source_path)));
      if (keys.size !== sources.length) return fail('任务来源路径重复。');
      return { op: 'batch_create', name: request.name, sources, criteria: validateCriteria(request.criteria),
        match_mode: oneOf(request.match_mode, ['exact', 'fuzzy'] as const) ? request.match_mode : fail('匹配模式无效。') };
    }
    case 'batch_start':
      if (!exactKeys(request, ['op', 'job_id', 'generation']) || !text(request.job_id, BATCH_MAX_IDENTIFIER_BYTES)
        || !safeInteger(request.generation, 0, MAX_SAFE - 2)) return fail('任务启动请求无效。');
      return { op: 'batch_start', job_id: request.job_id, generation: request.generation };
    case 'batch_snapshot':
      if (!exactKeys(request, ['op', 'job_id']) || !text(request.job_id, BATCH_MAX_IDENTIFIER_BYTES)) return fail('任务查询请求无效。');
      return { op: 'batch_snapshot', job_id: request.job_id };
    case 'batch_list':
      if (!exactKeys(request, ['op', 'offset', 'limit']) || !safeInteger(request.offset)
        || !safeInteger(request.limit, 1, 50)) return fail('任务列表请求无效。');
      return { op: 'batch_list', offset: request.offset, limit: request.limit };
    case 'batch_control':
      if (!exactKeys(request, ['op', 'job_id', 'generation', 'command_id', 'action']) || !text(request.job_id, BATCH_MAX_IDENTIFIER_BYTES)
        || !safeInteger(request.generation) || !text(request.command_id, BATCH_MAX_IDENTIFIER_BYTES)
        || !oneOf(request.action, ['pause', 'cancel', 'archive'] as const)) return fail('任务控制请求无效。');
      return { op: 'batch_control', job_id: request.job_id, generation: request.generation,
        command_id: request.command_id, action: request.action };
    case 'batch_results_page':
      if (!exactKeys(request, ['op', 'job_id', 'result_revision', 'offset', 'limit']) || !text(request.job_id, BATCH_MAX_IDENTIFIER_BYTES)
        || !text(request.result_revision, BATCH_MAX_IDENTIFIER_BYTES) || !safeInteger(request.offset)
        || !safeInteger(request.limit, 1, BATCH_MAX_RESULT_PAGE_ITEMS)) return fail('结果页请求无效。');
      return { op: 'batch_results_page', job_id: request.job_id, result_revision: request.result_revision,
        offset: request.offset, limit: request.limit };
    case 'batch_relocate':
      if (!exactKeys(request, ['op', 'job_id', 'source_id', 'new_path']) || !text(request.job_id, BATCH_MAX_IDENTIFIER_BYTES)
        || !text(request.source_id, BATCH_MAX_IDENTIFIER_BYTES) || !text(request.new_path, BATCH_MAX_PATH_BYTES)) return fail('来源迁移请求无效。');
      return { op: 'batch_relocate', job_id: request.job_id, source_id: request.source_id, new_path: request.new_path };
    default:
      return fail('不支持的任务操作。');
  }
}

export function createBatchEventState(jobId: string, generation: number): BatchEventState {
  if (!text(jobId, BATCH_MAX_IDENTIFIER_BYTES) || !safeInteger(generation, 1)) return fail('任务事件身份无效。');
  return { jobId, generation, nextSeq: 1, sequenceExhausted: false, lastEvent: null, snapshotRequired: false, terminal: false };
}

export function parseBatchWorkerEvent(value: unknown): BatchWorkerEvent {
  if (!isRecord(value) || !exactKeys(value, ['protocol', 'jobId', 'generation', 'seq', 'type', 'payload'])
    || value.protocol !== 2 || !text(value.jobId, BATCH_MAX_IDENTIFIER_BYTES) || !safeInteger(value.generation, 1)
    || !safeInteger(value.seq, 1) || !oneOf(value.type, ['snapshot', 'progress', 'page_failed', 'state_changed', 'completed'] as const)
    || !isRecord(value.payload) || !jsonValue(value.payload)) return fail('任务事件无效。');
  if (value.type === 'progress') {
    const phase = value.payload.phase;
    if (!oneOf(phase, ['heartbeat', 'page_settled', 'unit_start', 'unit_end'] as const)) return fail('任务进度事件无效。');
  }
  if (value.type === 'completed'
    && !oneOf(value.payload.state, ['ready_for_review', 'paused', 'partial_failed', 'blocked', 'cancel_requested', 'cancelled', 'interrupted'] as const)) {
    return fail('任务完成事件无效。');
  }
  return {
    protocol: 2, jobId: value.jobId, generation: value.generation, seq: value.seq, type: value.type,
    payload: cloneJson(value.payload) as Record<string, JsonValue>,
  };
}

export function mergeBatchEvent(state: BatchEventState, incoming: unknown): BatchEventMergeResult {
  if (!isRecord(incoming)) {
    return { accepted: false, state, reason: 'invalid' };
  }
  if (incoming.jobId !== undefined && incoming.jobId !== state.jobId) {
    return { accepted: false, state, reason: 'stale_job' };
  }
  if (incoming.generation !== undefined && incoming.generation !== state.generation) {
    return { accepted: false, state, reason: 'stale_generation' };
  }
  if (!Object.prototype.hasOwnProperty.call(incoming, 'seq')) {
    return { accepted: false, state: { ...state, snapshotRequired: true }, reason: 'snapshot_required' };
  }
  let event: BatchWorkerEvent;
  try {
    event = parseBatchWorkerEvent(incoming);
  } catch {
    return { accepted: false, state, reason: 'invalid' };
  }
  if (event.jobId !== state.jobId) return { accepted: false, state, reason: 'stale_job' };
  if (event.generation !== state.generation) return { accepted: false, state, reason: 'stale_generation' };
  if (state.snapshotRequired) return { accepted: false, state, reason: 'snapshot_required' };
  if (state.terminal) return { accepted: false, state, reason: 'completed' };
  if (state.sequenceExhausted) return { accepted: false, state, reason: 'duplicate' };
  if (event.seq < state.nextSeq) return { accepted: false, state, reason: 'duplicate' };
  if (event.seq > state.nextSeq) return { accepted: false, state, reason: 'out_of_order' };
  const sequenceExhausted = event.seq === MAX_SAFE;
  const nextSeq = sequenceExhausted ? MAX_SAFE : event.seq + 1;
  const nextState = { ...state, nextSeq, sequenceExhausted, lastEvent: event, terminal: event.type === 'completed' };
  return { accepted: true, state: nextState, event };
}
