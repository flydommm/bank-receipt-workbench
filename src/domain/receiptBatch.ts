/**
 * Strict webview contracts for the persistent receipt batch protocol.
 *
 * Receipt jobs use the schema-2 page snapshot and schema-3 review models.  A
 * legacy batch job can still occur in a mixed task list; the parser exposes
 * it with `page_result_schema: 1` and `processing_options: null` while keeping
 * the legacy criteria object intact.  This module is deliberately separate
 * from `batchTask.ts`: the old parser must continue to reject the receipt
 * codec and its match_rect/segment_no model.
 */

import {
  BATCH_JOB_STATES,
  BATCH_MAX_CRITERIA_CLAUSES,
  BATCH_MAX_IDENTIFIER_BYTES,
  BATCH_MAX_KEYWORD_CODEPOINTS,
  BATCH_MAX_NAME_BYTES,
  BATCH_MAX_PAGE_COUNT,
  BATCH_MAX_PATH_BYTES,
  BATCH_MAX_RESULT_ITEMS,
  BATCH_MAX_RESULT_PAGE_ITEMS,
  BATCH_MAX_SOURCES,
  BATCH_SOURCE_STATES,
  type BatchBudget,
  type BatchControlAction,
  type BatchCriteria,
  type BatchJobState,
  type BatchMatchMode,
  type BatchPageSummary,
  type BatchSourceSnapshot,
  type BatchSourceState,
  type BatchSourceSummary,
  type JsonValue,
} from './batchTask';
import { parseProcessingOptions, type ProcessingOptions } from './receiptLayout';
import {
  computeReceiptProcessingFingerprint,
  parseReceiptSnapshotItem,
  validateReceiptContext,
  validateReceiptEdit,
  validateReceiptOriginals,
  validateReceiptRecord,
  type ReceiptReviewContext,
  type ReceiptReviewEdit,
  type ReceiptReviewOriginal,
  type ReceiptReviewRecord,
  type ReceiptSnapshotItem,
} from './receiptReview';
import { normalizeSourcePath } from './sourcePreview';

export type { ReceiptSnapshotItem } from './receiptReview';

export const RECEIPT_BATCH_PAGE_RESULT_SCHEMA = 2 as const;
export const RECEIPT_BATCH_REVIEW_SCHEMA_VERSION = 1 as const;
export const RECEIPT_BATCH_MAX_LIST_ITEMS = 50;
export const RECEIPT_BATCH_MAX_JSON_BYTES = 4 * 1024 * 1024;
export const RECEIPT_BATCH_MAX_RESULT_ITEMS = BATCH_MAX_RESULT_ITEMS;
export const RECEIPT_BATCH_MAX_PAGE_ITEMS = BATCH_MAX_RESULT_PAGE_ITEMS;
const RECEIPT_BATCH_MAX_TOTAL = RECEIPT_BATCH_MAX_RESULT_ITEMS;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 250_000;
const MAX_JSON_VALUE_BYTES = 64 * 1024;

const JOB_FIELDS = [
  'id', 'name', 'generation', 'state', 'resume_target', 'criteria', 'criteria_fingerprint', 'match_mode',
  'computation_version', 'result_revision', 'owner', 'error', 'created_at', 'updated_at', 'deletion_pending',
  'page_summary', 'total_pages',
] as const;
const SOURCE_FIELDS = [
  'source_id', 'position', 'source_key', 'initial_path', 'access_path', 'name', 'sha256',
  'size_bytes', 'page_count', 'state', 'error', 'budget', 'verified_generation', 'page_summary',
] as const;
const SOURCE_SUMMARY_FIELDS = ['total', 'pending', 'registered', 'verified', 'failed', 'blocked', 'declared_pages'] as const;
const PAGE_SUMMARY_FIELDS = ['pending', 'processing', 'succeeded', 'failed'] as const;
const BUDGET_FIELDS = ['processed_pages', 'text_characters', 'fuzzy_work', 'matches', 'matched_text_characters'] as const;

type JsonObject = Record<string, unknown>;

export class ReceiptBatchValidationError extends Error {
  constructor(public readonly path: string, message = `回单批任务数据无效：${path}`) {
    super(message);
    this.name = 'ReceiptBatchValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(path: string, message?: string): never {
  throw new ReceiptBatchValidationError(path, message);
}

function isRecord(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: JsonObject, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
    && keys.every((key) => fields.includes(key));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function utf8Bytes(value: string): number {
  if (hasUnpairedSurrogate(value)) fail('json', '文本必须是有效 Unicode');
  return new TextEncoder().encode(value).byteLength;
}

function text(value: unknown, path: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || utf8Bytes(value) > maximumBytes) {
    return fail(path);
  }
  return value;
}

function safeInteger(value: unknown, path: string, minimum = 0, maximum = MAX_SAFE): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return fail(path);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(path);
  return value;
}

function sha(value: unknown, path: string): string {
  const result = text(value, path, 64).toLowerCase();
  if (!SHA256.test(result)) return fail(path);
  return result;
}

function cloneJson<T>(value: T, path: string): T {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || utf8Bytes(encoded) > RECEIPT_BATCH_MAX_JSON_BYTES) return fail(path);
    return JSON.parse(encoded) as T;
  } catch (error) {
    if (error instanceof ReceiptBatchValidationError) throw error;
    return fail(path);
  }
}

function isJsonValue(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }): value is JsonValue {
  if (depth > 16 || budget.nodes++ > 4_096) return false;
  if (value === null) { budget.bytes += 4; return budget.bytes <= MAX_JSON_VALUE_BYTES; }
  if (typeof value === 'string') {
    if (value.includes('\0') || hasUnpairedSurrogate(value)) return false;
    budget.bytes += utf8Bytes(value) + 2;
    return budget.bytes <= MAX_JSON_VALUE_BYTES;
  }
  if (typeof value === 'boolean') { budget.bytes += 5; return budget.bytes <= MAX_JSON_VALUE_BYTES; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    budget.bytes += String(value).length;
    return budget.bytes <= MAX_JSON_VALUE_BYTES;
  }
  if (Array.isArray(value)) return value.length <= 4_096 && value.every((child) => isJsonValue(child, depth + 1, budget));
  if (!isRecord(value) || Object.keys(value).length > 4_096) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key.includes('\0') || !isJsonValue(key, depth + 1, budget) || !isJsonValue(child, depth + 1, budget)) return false;
  }
  return true;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return left === right;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if ((left as unknown[]).length !== (right as unknown[]).length) return false;
    return (left as unknown[]).every((item, index) => sameJson(item, (right as unknown[])[index]));
  }
  const l = left as JsonObject;
  const r = right as JsonObject;
  const lKeys = Object.keys(l).sort();
  const rKeys = Object.keys(r).sort();
  return lKeys.length === rKeys.length && lKeys.every((key, index) => key === rKeys[index] && sameJson(l[key], r[key]));
}

function boundedJson(value: unknown, depth = 0, count = { value: 0 }): boolean {
  if (depth > MAX_JSON_DEPTH || count.value++ > MAX_JSON_NODES) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value) || !boundedJson(value[index], depth + 1, count)) return false;
    }
    return true;
  }
  return isRecord(value) && Object.entries(value).every(([key, item]) => (
    !key.includes('\0') && !hasUnpairedSurrogate(key) && boundedJson(item, depth + 1, count)
  ));
}

function validateCriteria(value: unknown, path: string): BatchCriteria {
  if (!isRecord(value) || !exactKeys(value, ['include', 'includeMode', 'exclude'])
    || !Array.isArray(value.include) || !Array.isArray(value.exclude)
    || (value.includeMode !== 'all' && value.includeMode !== 'any')) return fail(path);
  if (value.include.length > BATCH_MAX_CRITERIA_CLAUSES || value.exclude.length > BATCH_MAX_CRITERIA_CLAUSES
    || value.include.length + value.exclude.length > BATCH_MAX_CRITERIA_CLAUSES) return fail(path);
  const normalize = (items: unknown[], itemPath: string): string[] => {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of items.entries()) {
      if (typeof raw !== 'string' || hasUnpairedSurrogate(raw)) return fail(`${itemPath}[${index}]`);
      const keyword = raw.trim().normalize('NFC');
      if (!keyword || seen.has(keyword)) continue;
      if (Array.from(keyword).length > BATCH_MAX_KEYWORD_CODEPOINTS) return fail(`${itemPath}[${index}]`);
      seen.add(keyword);
      result.push(keyword);
    }
    return result;
  };
  const include = normalize(value.include, `${path}.include`);
  const exclude = normalize(value.exclude, `${path}.exclude`);
  if (include.length === 0) return fail(path);
  return { include, includeMode: value.includeMode, exclude };
}

function validatePageSummary(value: unknown, path: string): BatchPageSummary {
  if (!isRecord(value) || !exactKeys(value, PAGE_SUMMARY_FIELDS)) return fail(path);
  const result = Object.fromEntries(PAGE_SUMMARY_FIELDS.map((field) => [field, safeInteger(value[field], `${path}.${field}`)])) as BatchPageSummary;
  return result;
}

function validateBudget(value: unknown, path: string): BatchBudget {
  if (!isRecord(value) || !exactKeys(value, BUDGET_FIELDS)) return fail(path);
  const limits = { processed_pages: 5_000, text_characters: 64_000_000, fuzzy_work: 64_000_000,
    matches: 10_000, matched_text_characters: 8_000_000 } as const;
  const result = {} as BatchBudget;
  for (const field of BUDGET_FIELDS) {
    result[field] = safeInteger(value[field], `${path}.${field}`, 0, limits[field]);
  }
  return result;
}

function validateSource(value: unknown, expectedPosition: number): BatchSourceSnapshot {
  if (!isRecord(value) || !exactKeys(value, SOURCE_FIELDS)) return fail(`sources[${expectedPosition}]`);
  const sourcePath = text(value.source_key, `sources[${expectedPosition}].source_key`, BATCH_MAX_PATH_BYTES);
  const initialPath = text(value.initial_path, `sources[${expectedPosition}].initial_path`, BATCH_MAX_PATH_BYTES);
  const accessPath = text(value.access_path, `sources[${expectedPosition}].access_path`, BATCH_MAX_PATH_BYTES);
  const error = value.error === null ? null : cloneJson(value.error, `sources[${expectedPosition}].error`);
  if (error !== null && !isJsonValue(error)) return fail(`sources[${expectedPosition}].error`);
  const source = {
    source_id: text(value.source_id, `sources[${expectedPosition}].source_id`, BATCH_MAX_IDENTIFIER_BYTES),
    position: safeInteger(value.position, `sources[${expectedPosition}].position`),
    source_key: sourcePath,
    initial_path: initialPath,
    access_path: accessPath,
    name: text(value.name, `sources[${expectedPosition}].name`, BATCH_MAX_NAME_BYTES),
    sha256: value.sha256 === null ? null : sha(value.sha256, `sources[${expectedPosition}].sha256`),
    size_bytes: value.size_bytes === null ? null : safeInteger(value.size_bytes, `sources[${expectedPosition}].size_bytes`),
    page_count: value.page_count === null ? null : safeInteger(value.page_count, `sources[${expectedPosition}].page_count`, 1, BATCH_MAX_PAGE_COUNT),
    state: value.state as BatchSourceState,
    error: error as JsonValue | null,
    budget: validateBudget(value.budget, `sources[${expectedPosition}].budget`),
    verified_generation: value.verified_generation === null ? null : safeInteger(value.verified_generation, `sources[${expectedPosition}].verified_generation`),
    page_summary: validatePageSummary(value.page_summary, `sources[${expectedPosition}].page_summary`),
  };
  if (source.position !== expectedPosition || source.source_key !== normalizeSourcePath(source.initial_path)
    || !BATCH_SOURCE_STATES.includes(source.state)
    || !isJsonValue(source.budget) || !isJsonValue(source.page_summary)) return fail(`sources[${expectedPosition}]`);
  if (source.page_count !== null
    && source.page_summary.pending + source.page_summary.processing + source.page_summary.succeeded + source.page_summary.failed !== source.page_count) {
    return fail(`sources[${expectedPosition}].page_summary`);
  }
  return source;
}

function validateSourceSummary(value: unknown): BatchSourceSummary {
  if (!isRecord(value) || !exactKeys(value, SOURCE_SUMMARY_FIELDS)) return fail('source_summary');
  const result = Object.fromEntries(SOURCE_SUMMARY_FIELDS.map((field) => [field, safeInteger(value[field], `source_summary.${field}`)])) as BatchSourceSummary;
  if (result.pending + result.registered + result.verified + result.failed + result.blocked !== result.total) return fail('source_summary');
  return result;
}

export type ReceiptBatchJobSnapshot = {
  id: string;
  name: string;
  generation: number;
  state: BatchJobState;
  resume_target: string | null;
  criteria: BatchCriteria | null;
  page_result_schema: 1 | 2;
  processing_options: ProcessingOptions | null;
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

export type ReceiptBatchJobSummary = Omit<ReceiptBatchJobSnapshot, 'sources'> & {
  source_summary: BatchSourceSummary;
};

export type ReceiptBatchListResult = {
  items: ReceiptBatchJobSummary[];
  offset: number;
  limit: number;
  total: number;
  next_offset: number | null;
};

function parseJob(value: unknown, includeSources: boolean): ReceiptBatchJobSnapshot | ReceiptBatchJobSummary {
  const hasSchema = isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'page_result_schema');
  const fields = [
    ...JOB_FIELDS,
    ...(hasSchema ? ['page_result_schema', 'processing_options'] : []),
    ...(includeSources ? ['sources'] : ['source_summary']),
  ];
  if (!isRecord(value) || !exactKeys(value, fields)) return fail('job');
  const id = text(value.id, 'job.id', BATCH_MAX_IDENTIFIER_BYTES);
  const name = text(value.name, 'job.name', BATCH_MAX_NAME_BYTES);
  const generation = safeInteger(value.generation, 'job.generation');
  if (!BATCH_JOB_STATES.includes(value.state as BatchJobState)) return fail('job.state');
  const state = value.state as BatchJobState;
  const resumeTarget = value.resume_target === null ? null : text(value.resume_target, 'job.resume_target', BATCH_MAX_IDENTIFIER_BYTES);
  const criteria = value.criteria === null ? null : validateCriteria(value.criteria, 'job.criteria');
  const criteriaFingerprint = sha(value.criteria_fingerprint, 'job.criteria_fingerprint');
  if (value.match_mode !== 'exact' && value.match_mode !== 'fuzzy') return fail('job.match_mode');
  const matchMode = value.match_mode as BatchMatchMode;
  const computationVersion = text(value.computation_version, 'job.computation_version', 256);
  const resultRevision = value.result_revision === null ? null : text(value.result_revision, 'job.result_revision', BATCH_MAX_IDENTIFIER_BYTES);
  const owner = value.owner === null ? null : text(value.owner, 'job.owner', BATCH_MAX_IDENTIFIER_BYTES);
  const error = value.error === null ? null : cloneJson(value.error, 'job.error');
  if (error !== null && !isJsonValue(error)) return fail('job.error');
  const createdAt = text(value.created_at, 'job.created_at', 128);
  const updatedAt = text(value.updated_at, 'job.updated_at', 128);
  if (typeof value.deletion_pending !== 'boolean') return fail('job.deletion_pending');
  const pageSummary = validatePageSummary(value.page_summary, 'job.page_summary');
  const totalPages = safeInteger(value.total_pages, 'job.total_pages');
  if (pageSummary.pending + pageSummary.processing + pageSummary.succeeded + pageSummary.failed !== totalPages) return fail('job.page_summary');

  let pageResultSchema: 1 | 2 = 1;
  let processingOptions: ProcessingOptions | null = null;
  if (hasSchema) {
    if (value.page_result_schema !== RECEIPT_BATCH_PAGE_RESULT_SCHEMA) return fail('job.page_result_schema');
    pageResultSchema = 2;
    try {
      processingOptions = parseProcessingOptions(value.processing_options);
    } catch {
      return fail('job.processing_options');
    }
    if (processingOptions.processing_mode === 'split_all') {
      if (criteria !== null) return fail('job.criteria');
    } else if (criteria === null || !sameJson(criteria, processingOptions.criteria)) {
      return fail('job.criteria');
    }
  } else if (criteria === null) {
    return fail('job.criteria');
  }

  if (includeSources) {
    if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > BATCH_MAX_SOURCES) return fail('job.sources');
    const sources = value.sources.map((source, index) => validateSource(source, index));
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const source of sources) {
      if (ids.has(source.source_id) || keys.has(source.source_key)) return fail('job.sources');
      ids.add(source.source_id); keys.add(source.source_key);
    }
    return {
      id, name, generation, state, resume_target: resumeTarget, criteria, page_result_schema: pageResultSchema,
      processing_options: processingOptions, criteria_fingerprint: criteriaFingerprint, match_mode: matchMode,
      computation_version: computationVersion, result_revision: resultRevision, owner, error, created_at: createdAt,
      updated_at: updatedAt, deletion_pending: value.deletion_pending, page_summary: pageSummary, total_pages: totalPages,
      sources,
    };
  }
  return {
    id, name, generation, state, resume_target: resumeTarget, criteria, page_result_schema: pageResultSchema,
    processing_options: processingOptions, criteria_fingerprint: criteriaFingerprint, match_mode: matchMode,
    computation_version: computationVersion, result_revision: resultRevision, owner, error, created_at: createdAt,
    updated_at: updatedAt, deletion_pending: value.deletion_pending, page_summary: pageSummary, total_pages: totalPages,
    source_summary: validateSourceSummary(value.source_summary),
  };
}

export async function parseReceiptBatchJobSnapshot(value: unknown): Promise<ReceiptBatchJobSnapshot> {
  const parsed = parseJob(value, true) as ReceiptBatchJobSnapshot;
  if (parsed.page_result_schema === 2) {
    const expected = await computeReceiptProcessingFingerprint(parsed.processing_options, parsed.match_mode);
    if (expected !== parsed.criteria_fingerprint) return fail('job.criteria_fingerprint');
  }
  return parsed;
}

export async function parseReceiptBatchJobSummary(value: unknown): Promise<ReceiptBatchJobSummary> {
  const parsed = parseJob(value, false) as ReceiptBatchJobSummary;
  if (parsed.page_result_schema === 2) {
    const expected = await computeReceiptProcessingFingerprint(parsed.processing_options, parsed.match_mode);
    if (expected !== parsed.criteria_fingerprint) return fail('job.criteria_fingerprint');
  }
  return parsed;
}

export async function parseReceiptBatchList(value: unknown): Promise<ReceiptBatchListResult> {
  if (!isRecord(value) || !exactKeys(value, ['items', 'offset', 'limit', 'total', 'next_offset'])
    || !Array.isArray(value.items) || value.items.length > RECEIPT_BATCH_MAX_LIST_ITEMS) return fail('list');
  const offset = safeInteger(value.offset, 'list.offset');
  const limit = safeInteger(value.limit, 'list.limit', 1, RECEIPT_BATCH_MAX_LIST_ITEMS);
  const total = safeInteger(value.total, 'list.total');
  const nextOffset = value.next_offset === null ? null : safeInteger(value.next_offset, 'list.next_offset');
  const items = await Promise.all(value.items.map((item) => parseReceiptBatchJobSummary(item)));
  if (nextOffset !== null && nextOffset !== offset + items.length) return fail('list.next_offset');
  if ((items.length > 0 && offset + items.length > total)
    || ((offset + items.length < total) !== (nextOffset !== null))) return fail('list');
  return { items, offset, limit, total, next_offset: nextOffset };
}

export type ReceiptBatchCreateRequest = {
  op: 'batch_create_receipts';
  name: string;
  sources: { source_path: string; name: string }[];
  processing_options: ProcessingOptions;
  match_mode: BatchMatchMode;
  /** Absent/null selects compatible saved templates automatically. */
  layout_template_id?: string | null;
};
export type ReceiptBatchStartRequest = { op: 'batch_start'; job_id: string; generation: number };
export type ReceiptBatchSnapshotRequest = { op: 'batch_snapshot'; job_id: string };
export type ReceiptBatchListRequest = { op: 'batch_list'; offset: number; limit: number };
export type ReceiptBatchControlRequest = {
  op: 'batch_control'; job_id: string; generation: number; command_id: string; action: BatchControlAction;
};
export type ReceiptBatchResultsPageRequest = {
  op: 'batch_results_page'; job_id: string; result_revision: string; offset: number; limit: number;
};
export type ReceiptBatchRelocateRequest = { op: 'batch_relocate'; job_id: string; source_id: string; new_path: string };
export type ReceiptBatchPrepareReviewRequest = { op: 'batch_prepare_review'; job_id: string; result_revision: string };
export type ReceiptBatchReviewPageRequest = {
  op: 'batch_receipt_review_page'; job_id: string; result_revision: string; offset: number; limit: number;
};
export type ReceiptBatchSaveReviewRequest = {
  op: 'batch_save_receipt_review'; job_id: string; result_revision: string; edits: ReceiptReviewEdit[];
};

export type ReceiptBatchRequest = ReceiptBatchCreateRequest | ReceiptBatchStartRequest | ReceiptBatchSnapshotRequest
  | ReceiptBatchListRequest | ReceiptBatchControlRequest | ReceiptBatchResultsPageRequest | ReceiptBatchRelocateRequest
  | ReceiptBatchPrepareReviewRequest | ReceiptBatchReviewPageRequest | ReceiptBatchSaveReviewRequest;

function requestPath(value: unknown, path: string): string {
  const result = text(value, path, BATCH_MAX_PATH_BYTES);
  const normalized = normalizeSourcePath(result);
  if (!(normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized))) return fail(path);
  return result;
}

export function validateReceiptBatchRequest(value: unknown): ReceiptBatchRequest {
  if (!isRecord(value) || typeof value.op !== 'string') return fail('request');
  switch (value.op) {
    case 'batch_create_receipts': {
      const requiredKeys = ['op', 'name', 'sources', 'processing_options', 'match_mode'];
      const hasTemplate = Object.hasOwn(value, 'layout_template_id');
      if (!exactKeys(value, hasTemplate ? [...requiredKeys, 'layout_template_id'] : requiredKeys) || !Array.isArray(value.sources)
        || value.sources.length === 0 || value.sources.length > BATCH_MAX_SOURCES) return fail('request');
      const sources = value.sources.map((raw, index) => {
        if (!isRecord(raw) || !exactKeys(raw, ['source_path', 'name'])) return fail(`request.sources[${index}]`);
        return { source_path: requestPath(raw.source_path, `request.sources[${index}].source_path`),
          name: text(raw.name, `request.sources[${index}].name`, BATCH_MAX_NAME_BYTES) };
      });
      const keys = new Set(sources.map((source) => normalizeSourcePath(source.source_path)));
      if (keys.size !== sources.length) return fail('request.sources');
      let options: ProcessingOptions;
      try { options = parseProcessingOptions(value.processing_options); } catch { return fail('request.processing_options'); }
      if (value.match_mode !== 'exact' && value.match_mode !== 'fuzzy') return fail('request.match_mode');
      if (hasTemplate && value.layout_template_id !== null
        && (typeof value.layout_template_id !== 'string' || !value.layout_template_id.trim()
          || value.layout_template_id.length > 256 || value.layout_template_id.includes('\0'))) return fail('request.layout_template_id');
      return { op: value.op, name: text(value.name, 'request.name', BATCH_MAX_NAME_BYTES), sources,
        processing_options: options, match_mode: value.match_mode,
        ...(hasTemplate ? { layout_template_id: value.layout_template_id as string | null } : {}) };
    }
    case 'batch_start':
      if (!exactKeys(value, ['op', 'job_id', 'generation'])) return fail('request');
      return { op: value.op, job_id: text(value.job_id, 'request.job_id', BATCH_MAX_IDENTIFIER_BYTES),
        generation: safeInteger(value.generation, 'request.generation') };
    case 'batch_snapshot':
      if (!exactKeys(value, ['op', 'job_id'])) return fail('request');
      return { op: value.op, job_id: text(value.job_id, 'request.job_id', BATCH_MAX_IDENTIFIER_BYTES) };
    case 'batch_list':
      if (!exactKeys(value, ['op', 'offset', 'limit'])) return fail('request');
      return { op: value.op, offset: safeInteger(value.offset, 'request.offset'),
        limit: safeInteger(value.limit, 'request.limit', 1, RECEIPT_BATCH_MAX_LIST_ITEMS) };
    case 'batch_control':
      if (!exactKeys(value, ['op', 'job_id', 'generation', 'command_id', 'action'])
        || !['pause', 'cancel', 'archive'].includes(value.action as string)) return fail('request');
      return { op: value.op, job_id: text(value.job_id, 'request.job_id', BATCH_MAX_IDENTIFIER_BYTES),
        generation: safeInteger(value.generation, 'request.generation'), command_id: text(value.command_id, 'request.command_id', BATCH_MAX_IDENTIFIER_BYTES),
        action: value.action as BatchControlAction };
    case 'batch_results_page':
    case 'batch_receipt_review_page':
      if (!exactKeys(value, ['op', 'job_id', 'result_revision', 'offset', 'limit'])) return fail('request');
      return { op: value.op, job_id: text(value.job_id, 'request.job_id', BATCH_MAX_IDENTIFIER_BYTES),
        result_revision: text(value.result_revision, 'request.result_revision', BATCH_MAX_IDENTIFIER_BYTES),
        offset: safeInteger(value.offset, 'request.offset'), limit: safeInteger(value.limit, 'request.limit', 1, RECEIPT_BATCH_MAX_PAGE_ITEMS) } as ReceiptBatchResultsPageRequest | ReceiptBatchReviewPageRequest;
    case 'batch_prepare_review':
      if (!exactKeys(value, ['op', 'job_id', 'result_revision'])) return fail('request');
      return { op: value.op, job_id: text(value.job_id, 'request.job_id', BATCH_MAX_IDENTIFIER_BYTES),
        result_revision: text(value.result_revision, 'request.result_revision', BATCH_MAX_IDENTIFIER_BYTES) };
    case 'batch_save_receipt_review': {
      if (!exactKeys(value, ['op', 'job_id', 'result_revision', 'edits']) || !Array.isArray(value.edits)
        || value.edits.length > RECEIPT_BATCH_MAX_RESULT_ITEMS) return fail('request');
      const edits = value.edits.map((edit) => validateReceiptEdit(edit));
      return { op: value.op, job_id: text(value.job_id, 'request.job_id', BATCH_MAX_IDENTIFIER_BYTES),
        result_revision: text(value.result_revision, 'request.result_revision', BATCH_MAX_IDENTIFIER_BYTES), edits };
    }
    case 'batch_relocate':
      if (!exactKeys(value, ['op', 'job_id', 'source_id', 'new_path'])) return fail('request');
      return { op: value.op, job_id: text(value.job_id, 'request.job_id', BATCH_MAX_IDENTIFIER_BYTES),
        source_id: text(value.source_id, 'request.source_id', BATCH_MAX_IDENTIFIER_BYTES), new_path: requestPath(value.new_path, 'request.new_path') };
    default:
      return fail('request.op');
  }
}

export type ReceiptBatchResultsPage = {
  schema: typeof RECEIPT_BATCH_PAGE_RESULT_SCHEMA;
  result_revision: string;
  offset: number;
  limit: number;
  total: number;
  next_offset: number | null;
  items: ReceiptSnapshotItem[];
};

export type ReceiptBatchReviewBinding = {
  job: ReceiptBatchJobSnapshot;
  context: ReceiptReviewContext;
  contextKey: string;
};

export type ReceiptBatchPrepared = {
  status: 'ok';
  schema_version: typeof RECEIPT_BATCH_REVIEW_SCHEMA_VERSION;
  context_key: string;
  result_revision: string;
  total: number;
};

export type ReceiptBatchPreparedReview = {
  templateChoiceIds?: string[];
  context: ReceiptReviewContext;
  prepared: ReceiptBatchPrepared;
  binding: ReceiptBatchReviewBinding;
};

function sourceByKey(job: ReceiptBatchJobSnapshot): Map<string, BatchSourceSnapshot> {
  return new Map(job.sources.map((source) => [source.source_key, source]));
}

function sourceShaByKey(job: ReceiptBatchJobSnapshot): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of job.sources) {
    if (source.sha256 === null) return fail(`job.sources.${source.source_key}.sha256`);
    result[source.source_key] = source.sha256;
  }
  return result;
}

function assertJobReceipt(job: ReceiptBatchJobSnapshot, path = 'job'): void {
  if (job.page_result_schema !== 2 || job.processing_options === null) return fail(path, '任务不是回单 schema-2 结果任务');
  if (job.sources.some((source) => source.sha256 === null || source.page_count === null)) return fail(`${path}.sources`);
}

export async function validateReceiptBatchContext(
  job: ReceiptBatchJobSnapshot,
  value: unknown,
): Promise<ReceiptBatchReviewBinding> {
  assertJobReceipt(job);
  const checked = await validateReceiptContext(value, { trustedAliases: true });
  const context = checked.context;
  if (context.sources.length !== job.sources.length) return fail('context.sources');
  for (const [index, source] of job.sources.entries()) {
    const declared = context.sources[index];
    if (!declared || declared.source_key !== source.source_key || source.sha256 === null
      || declared.source_sha256 !== source.sha256
      || normalizeSourcePath(declared.source_path) !== normalizeSourcePath(source.access_path)) {
      return fail(`context.sources[${index}]`, '上下文来源与任务来源不一致');
    }
  }
  if (!sameJson(context.processing_options, job.processing_options)
    || context.match_mode !== job.match_mode || context.criteria_fingerprint !== job.criteria_fingerprint
    || context.computation_version !== job.computation_version) {
    return fail('context', '上下文处理参数与任务不一致');
  }
  return { job, context, contextKey: checked.contextKey };
}

async function shaCanonical(value: unknown, path: string): Promise<string> {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return fail(path);
  }
  if (encoded === undefined || utf8Bytes(encoded) > RECEIPT_BATCH_MAX_JSON_BYTES) return fail(path);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fail(path, 'Web Crypto SHA-256 不可用');
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(encoded));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return fail(path, 'Web Crypto SHA-256 失败');
  }
}

async function assertOriginalBinding(
  originalValue: unknown,
  binding: ReceiptBatchReviewBinding,
  path: string,
): Promise<ReceiptReviewOriginal> {
  const checked = validateReceiptOriginals([originalValue], sourceShaByKey(binding.job), binding.context)[0];
  const source = sourceByKey(binding.job).get(checked.source_key);
  if (!source || source.page_count === null || checked.source_page > source.page_count) return fail(path);
  const expectedId = await shaCanonical([binding.job.id, source.source_id, checked.instance_id], `${path}.id`);
  if (checked.id !== expectedId) return fail(`${path}.id`, '片段身份没有绑定到当前任务');
  return checked;
}

function assertPageCursor(offset: number, items: number, total: number, nextOffset: number | null, path: string): void {
  const end = offset + items;
  if (offset > total || (total === 0 && items !== 0)
    || (end < total && nextOffset !== end) || (end >= total && (end !== total || nextOffset !== null))) return fail(path);
}

async function assertSnapshotItemBinding(
  item: ReceiptSnapshotItem,
  binding: ReceiptBatchReviewBinding | ReceiptBatchJobSnapshot,
): Promise<void> {
  const job = 'job' in binding ? binding.job : binding;
  const source = sourceByKey(job).get(item.original.source_key);
  if (!source || source.sha256 === null || source.page_count === null
    || item.segment.source_sha256 !== source.sha256
    || normalizeSourcePath(item.segment.source_path) !== normalizeSourcePath(source.access_path)
    || item.original.source_page > source.page_count) return fail('results_page.items');
  const mode = ('context' in binding ? binding.context.processing_options : job.processing_options)?.processing_mode;
  if (!mode) return fail('results_page.items');
  if ((mode === 'search' && item.original.selection_basis !== 'keyword')
    || (mode === 'split_all' && item.original.selection_basis === 'keyword')) return fail('results_page.items');
  const reviewJob = 'context' in binding ? binding.job : binding;
  const expectedId = await shaCanonical([reviewJob.id, source.source_id, item.original.instance_id], 'results_page.items.original.id');
  if (item.original.id !== expectedId || item.segment.id !== expectedId) return fail('results_page.items.original.id');
}

function resultBinding(
  value: ReceiptBatchReviewBinding | ReceiptBatchJobSnapshot | undefined,
): ReceiptBatchReviewBinding | ReceiptBatchJobSnapshot | undefined {
  if (!value) return undefined;
  if ('context' in value && 'contextKey' in value) return value;
  if ('page_result_schema' in value && 'sources' in value) return value;
  return fail('binding', '结果页需要已验证的回单任务');
}

export async function parseReceiptBatchResultsPage(
  value: unknown,
  bindingOrRevision?: ReceiptBatchReviewBinding | ReceiptBatchJobSnapshot | string,
  expectedRevision?: string,
): Promise<ReceiptBatchResultsPage> {
  const binding = typeof bindingOrRevision === 'string' ? undefined : resultBinding(bindingOrRevision);
  const revision = typeof bindingOrRevision === 'string' ? bindingOrRevision : expectedRevision;
  if (!isRecord(value) || !exactKeys(value, ['schema', 'result_revision', 'offset', 'limit', 'total', 'next_offset', 'items'])
    || value.schema !== RECEIPT_BATCH_PAGE_RESULT_SCHEMA || typeof value.result_revision !== 'string'
    || (revision !== undefined && value.result_revision !== revision) || !Array.isArray(value.items)
    || value.items.length > (typeof value.limit === 'number' && Number.isSafeInteger(value.limit) ? value.limit : -1)) return fail('results_page');
  serializedReceiptBatchBytes(value);
  const resultRevision = text(value.result_revision, 'results_page.result_revision', BATCH_MAX_IDENTIFIER_BYTES);
  const offset = safeInteger(value.offset, 'results_page.offset');
  const limit = safeInteger(value.limit, 'results_page.limit', 1, RECEIPT_BATCH_MAX_PAGE_ITEMS);
  const total = safeInteger(value.total, 'results_page.total', 0, RECEIPT_BATCH_MAX_RESULT_ITEMS);
  const nextOffset = value.next_offset === null ? null : safeInteger(value.next_offset, 'results_page.next_offset');
  const items = value.items.map((item) => parseReceiptSnapshotItem(item));
  assertPageCursor(offset, items.length, total, nextOffset, 'results_page');
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.segment.id)) return fail('results_page.items', '结果页片段重复');
    ids.add(item.segment.id);
    if (binding) await assertSnapshotItemBinding(item, binding);
  }
  return { schema: RECEIPT_BATCH_PAGE_RESULT_SCHEMA, result_revision: resultRevision, offset, limit, total,
    next_offset: nextOffset, items };
}

export const SPECIAL_DOCUMENT_LABELS = {
  other_special: '其他特殊单证',
  loan_settlement_notice: '贷款清算通知书',
  loan_interest_notice: '贷款利息到期通知书',
  electronic_tax_payment: '电子缴税付款凭证',
} as const;
export const isSpecialDocumentType = (value: unknown): value is keyof typeof SPECIAL_DOCUMENT_LABELS =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(SPECIAL_DOCUMENT_LABELS, value);
export type ReceiptPageNotice = { code: 'special_document'; document_type: keyof typeof SPECIAL_DOCUMENT_LABELS };
export type ReceiptExclusionNotice = { code: 'suspected_invalid_slot' };

export type ReceiptBatchReviewPageItem = {
  original: ReceiptReviewOriginal;
  record_revision: number;
  record: ReceiptReviewRecord | null;
  page_notice?: ReceiptPageNotice;
  exclusion_notice?: ReceiptExclusionNotice;
};

export type ReceiptBatchReviewPage = {
  schema_version: typeof RECEIPT_BATCH_REVIEW_SCHEMA_VERSION;
  context_key: string;
  result_revision: string;
  offset: number;
  limit: number;
  total: number;
  next_offset: number | null;
  items: ReceiptBatchReviewPageItem[];
};

export async function parseReceiptBatchPreparedReview(
  value: unknown,
  job: ReceiptBatchJobSnapshot,
): Promise<ReceiptBatchPreparedReview> {
  if (!isRecord(value) || !exactKeys(value, ['context', 'prepared', ...('template_choice_ids' in value ? ['template_choice_ids'] : [])]) || !isRecord(value.prepared)) return fail('prepared');
  let templateChoiceIds: string[] | undefined;
  if ('template_choice_ids' in value) {
    if (!Array.isArray(value.template_choice_ids) || value.template_choice_ids.length < 2 || value.template_choice_ids.length > 256) return fail('template_choice_ids');
    templateChoiceIds = value.template_choice_ids.map((id) => text(id, 'template_choice_ids', 256));
    if (new Set(templateChoiceIds).size !== templateChoiceIds.length) return fail('template_choice_ids');
  }
  const binding = await validateReceiptBatchContext(job, value.context);
  const raw = value.prepared;
  if (!exactKeys(raw, ['status', 'schema_version', 'context_key', 'result_revision', 'total'])
    || raw.status !== 'ok' || raw.schema_version !== RECEIPT_BATCH_REVIEW_SCHEMA_VERSION) return fail('prepared');
  const contextKey = sha(raw.context_key, 'prepared.context_key');
  const resultRevision = text(raw.result_revision, 'prepared.result_revision', BATCH_MAX_IDENTIFIER_BYTES);
  const total = safeInteger(raw.total, 'prepared.total', 0, RECEIPT_BATCH_MAX_RESULT_ITEMS);
  if (contextKey !== binding.contextKey || resultRevision !== job.result_revision) return fail('prepared', '审核上下文已过期');
  if (!job.result_revision) return fail('job.result_revision');
  const prepared: ReceiptBatchPrepared = { status: 'ok', schema_version: 1, context_key: contextKey,
    result_revision: resultRevision, total };
  return { context: binding.context, prepared, binding: { ...binding, contextKey }, ...(templateChoiceIds ? { templateChoiceIds } : {}) };
}

export async function parseReceiptBatchReviewPage(
  value: unknown,
  binding: ReceiptBatchReviewBinding,
): Promise<ReceiptBatchReviewPage> {
  assertJobReceipt(binding.job);
  if (!isRecord(value) || !exactKeys(value, ['schema_version', 'context_key', 'result_revision', 'offset', 'limit', 'total', 'next_offset', 'items'])
    || value.schema_version !== RECEIPT_BATCH_REVIEW_SCHEMA_VERSION || !Array.isArray(value.items)) return fail('review_page');
  serializedReceiptBatchBytes(value);
  const contextKey = sha(value.context_key, 'review_page.context_key');
  const resultRevision = text(value.result_revision, 'review_page.result_revision', BATCH_MAX_IDENTIFIER_BYTES);
  if (contextKey !== binding.contextKey || resultRevision !== binding.job.result_revision) return fail('review_page', '审核上下文已过期');
  const offset = safeInteger(value.offset, 'review_page.offset');
  const limit = safeInteger(value.limit, 'review_page.limit', 1, RECEIPT_BATCH_MAX_PAGE_ITEMS);
  const total = safeInteger(value.total, 'review_page.total', 0, RECEIPT_BATCH_MAX_TOTAL);
  const nextOffset = value.next_offset === null ? null : safeInteger(value.next_offset, 'review_page.next_offset');
  if (value.items.length > limit) return fail('review_page.items');
  const ids = new Set<string>();
  const items: ReceiptBatchReviewPageItem[] = [];
  const sources = sourceByKey(binding.job);
  for (const [index, raw] of value.items.entries()) {
    const path = `review_page.items[${index}]`;
    if (!isRecord(raw) || !exactKeys(raw, ['original', 'record_revision', 'record',
      ...('page_notice' in raw ? ['page_notice'] : []), ...('exclusion_notice' in raw ? ['exclusion_notice'] : [])])) return fail(path);
    let pageNotice: ReceiptPageNotice | undefined;
    if ('page_notice' in raw) {
      const notice = raw.page_notice;
      if (!isRecord(notice) || !exactKeys(notice, ['code', 'document_type']) || notice.code !== 'special_document'
        || !isSpecialDocumentType(notice.document_type)) return fail(`${path}.page_notice`);
      pageNotice = { code: 'special_document', document_type: notice.document_type as ReceiptPageNotice['document_type'] };
    }
    let exclusionNotice: ReceiptExclusionNotice | undefined;
    if ('exclusion_notice' in raw) {
      const notice = raw.exclusion_notice;
      if (!isRecord(notice) || !exactKeys(notice, ['code']) || notice.code !== 'suspected_invalid_slot'
        || pageNotice) return fail(`${path}.exclusion_notice`);
      exclusionNotice = { code: 'suspected_invalid_slot' };
    }
    const original = await assertOriginalBinding(raw.original, binding, `${path}.original`);
    if (ids.has(original.id)) return fail(path, '审核页包含重复片段');
    ids.add(original.id);
    const recordRevision = safeInteger(raw.record_revision, `${path}.record_revision`);
    let record: ReceiptReviewRecord | null = null;
    if (raw.record !== null) {
      record = validateReceiptRecord(raw.record);
      const source = sources.get(original.source_key);
      if (!source || source.sha256 === null || source.page_count === null || record.context_key !== contextKey || record.result_revision !== resultRevision
        || record.record_revision < 1 || record.record_revision !== recordRevision || !sameJson(record.original, original)
        || record.source_sha256 !== source.sha256
        || (binding.context.processing_options.processing_mode === 'search' && record.original.selection_basis !== 'keyword')
        || (binding.context.processing_options.processing_mode === 'split_all' && record.original.selection_basis === 'keyword')
        || record.original.source_page > source.page_count
        || normalizeSourcePath(record.source_path) !== normalizeSourcePath(source.access_path)) return fail(path, '审核记录绑定不一致');
      if (record.document_type !== undefined
        && (pageNotice?.document_type ?? 'ordinary') !== record.document_type) return fail(path, '凭证类型与人工分类不一致');
    }
    items.push({ original, record_revision: recordRevision, record, ...(pageNotice ? { page_notice: pageNotice } : {}),
      ...(exclusionNotice ? { exclusion_notice: exclusionNotice } : {}) });
  }
  assertPageCursor(offset, items.length, total, nextOffset, 'review_page');
  return { schema_version: 1, context_key: contextKey, result_revision: resultRevision, offset, limit, total,
    next_offset: nextOffset, items };
}

export type ReceiptBatchControlResult = {
  status: 'ok' | 'already_completed' | 'already_archived';
  job_id: string;
  generation: number;
  command_id: string;
  action: BatchControlAction;
  state: BatchJobState;
};

export function parseReceiptBatchControlResult(value: unknown): ReceiptBatchControlResult {
  if (!isRecord(value) || !exactKeys(value, ['status', 'job_id', 'generation', 'command_id', 'action', 'state'])
    || !['ok', 'already_completed', 'already_archived'].includes(value.status as string)
    || !['pause', 'cancel', 'archive'].includes(value.action as string)
    || !BATCH_JOB_STATES.includes(value.state as BatchJobState)) return fail('control_result');
  return {
    status: value.status as ReceiptBatchControlResult['status'],
    job_id: text(value.job_id, 'control_result.job_id', BATCH_MAX_IDENTIFIER_BYTES),
    generation: safeInteger(value.generation, 'control_result.generation'),
    command_id: text(value.command_id, 'control_result.command_id', BATCH_MAX_IDENTIFIER_BYTES),
    action: value.action as BatchControlAction,
    state: value.state as BatchJobState,
  };
}

async function assertEditBinding(editValue: unknown, binding: ReceiptBatchReviewBinding): Promise<ReceiptReviewEdit> {
  const edit = validateReceiptEdit(editValue);
  if (edit.context_key !== binding.contextKey || edit.result_revision !== binding.job.result_revision) return fail('edits', '编辑上下文已过期');
  const source = sourceByKey(binding.job).get(edit.source_key);
  if (!source || source.sha256 === null || !source.page_count) return fail('edits');
  const expectedId = await shaCanonical([binding.job.id, source.source_id, edit.instance_id], 'edits.id');
  if (edit.id !== expectedId) return fail('edits.id');
  // The manifest itself is read from the review page.  The immutable fields
  // can still be checked here when an edit is supplied through a caller that
  // has already attached its original; the server remains authoritative.
  return edit;
}

export async function validateReceiptBatchEdits(
  editsValue: unknown,
  binding: ReceiptBatchReviewBinding,
): Promise<ReceiptReviewEdit[]> {
  if (!Array.isArray(editsValue) || editsValue.length > RECEIPT_BATCH_MAX_RESULT_ITEMS) return fail('edits');
  const edits: ReceiptReviewEdit[] = [];
  const ids = new Set<string>();
  const logical = new Set<string>();
  for (const raw of editsValue) {
    const edit = await assertEditBinding(raw, binding);
    if (ids.has(edit.id) || logical.has(`${edit.source_key}\u0000${edit.instance_id}`)) return fail('edits', '编辑片段重复');
    ids.add(edit.id); logical.add(`${edit.source_key}\u0000${edit.instance_id}`);
    edits.push(edit);
  }
  return edits;
}

export type ReceiptBatchSaveReviewResult = {
  schema_version: typeof RECEIPT_BATCH_REVIEW_SCHEMA_VERSION;
  context_key: string;
  result_revision: string;
  saved_count: number;
  segments: ReceiptReviewRecord[];
};

export async function parseReceiptBatchSaveResult(
  value: unknown,
  binding: ReceiptBatchReviewBinding,
): Promise<ReceiptBatchSaveReviewResult> {
  assertJobReceipt(binding.job);
  if (!isRecord(value) || !exactKeys(value, ['schema_version', 'context_key', 'result_revision', 'saved_count', 'segments'])
    || value.schema_version !== RECEIPT_BATCH_REVIEW_SCHEMA_VERSION || !Array.isArray(value.segments)) return fail('save_result');
  const contextKey = sha(value.context_key, 'save_result.context_key');
  const resultRevision = text(value.result_revision, 'save_result.result_revision', BATCH_MAX_IDENTIFIER_BYTES);
  const savedCount = safeInteger(value.saved_count, 'save_result.saved_count', 0, RECEIPT_BATCH_MAX_RESULT_ITEMS);
  if (contextKey !== binding.contextKey || resultRevision !== binding.job.result_revision || value.segments.length !== savedCount) {
    return fail('save_result', '保存结果绑定不一致');
  }
  const sources = sourceByKey(binding.job);
  const ids = new Set<string>();
  const segments: ReceiptReviewRecord[] = [];
  for (const [index, raw] of value.segments.entries()) {
    const path = `save_result.segments[${index}]`;
    const record = validateReceiptRecord(raw);
    if (record.record_revision < 1 || record.context_key !== contextKey || record.result_revision !== resultRevision
      || ids.has(record.original.id)) return fail(path, '保存记录绑定不一致');
    const source = sources.get(record.original.source_key);
    if (!source || source.sha256 === null || record.source_sha256 !== source.sha256
      || source.page_count === null || record.original.source_page > source.page_count
      || (binding.context.processing_options.processing_mode === 'search' && record.original.selection_basis !== 'keyword')
      || (binding.context.processing_options.processing_mode === 'split_all' && record.original.selection_basis === 'keyword')
      || normalizeSourcePath(record.source_path) !== normalizeSourcePath(source.access_path)) return fail(path);
    const expectedId = await shaCanonical([binding.job.id, source.source_id, record.original.instance_id], `${path}.original.id`);
    if (record.original.id !== expectedId) return fail(`${path}.original.id`);
    ids.add(record.original.id); segments.push(record);
  }
  return { schema_version: 1, context_key: contextKey, result_revision: resultRevision,
    saved_count: savedCount, segments };
}

export type ReceiptBatchResponse<T> =
  | { status: 'ok'; data: T }
  | { status: 'error'; code: string; message: string };

export function parseReceiptBatchResponse(value: unknown): ReceiptBatchResponse<unknown> {
  if (!isRecord(value) || typeof value.status !== 'string') return fail('response');
  if (value.status === 'error') {
    if (!exactKeys(value, ['status', 'code', 'message'])) return fail('response');
    return { status: 'error', code: text(value.code, 'response.code', BATCH_MAX_IDENTIFIER_BYTES),
      message: text(value.message, 'response.message', 65_536) };
  }
  if (value.status !== 'ok' || !exactKeys(value, ['status', 'data'])) return fail('response');
  return { status: 'ok', data: value.data };
}

export function serializedReceiptBatchBytes(value: unknown): number {
  if (!boundedJson(value)) return fail('json');
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return fail('json'); }
  if (encoded === undefined) return fail('json');
  const size = utf8Bytes(encoded);
  if (size > RECEIPT_BATCH_MAX_JSON_BYTES) return fail('request', '回单批任务请求超过 4 MiB 限制');
  return size;
}
