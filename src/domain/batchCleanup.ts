/**
 * Runtime checked contracts for server-owned task cleanup and storage
 * operations.  The webview receives counts and states only; it never submits
 * file paths, source identities, or a client-built deletion manifest.
 */

import { BatchTaskValidationError } from './batchTask';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_IDENTIFIER_BYTES = 1_024;
const MAX_NAME_BYTES = 1_024;
const MAX_TIMESTAMP_BYTES = 128;
const MAX_NOTICE_BYTES = 256;
const MAX_NOTICE_COUNT = 64;
const MAX_CLEANUP_LIST_ITEMS = 20;
const TERMINAL_REVIEW_STATES = ['deleted', 'retained', 'absent'] as const;
const TERMINAL_PREVIEW_STATES = ['cleaned', 'absent'] as const;

export const BATCH_CLEANUP_NOTICE_CODES = [
  'review_retained',
  'review_changed',
  'review_residual',
  'preview_residual',
] as const;
export type BatchCleanupNoticeCode = typeof BATCH_CLEANUP_NOTICE_CODES[number];

export const BATCH_CLEANUP_TASK_DATA_STATES = ['pending', 'deleted'] as const;
export type BatchCleanupTaskDataState = typeof BATCH_CLEANUP_TASK_DATA_STATES[number];

export const BATCH_CLEANUP_REVIEW_STATES = ['pending', 'deleted', 'retained', 'absent', 'residual'] as const;
export type BatchCleanupReviewState = typeof BATCH_CLEANUP_REVIEW_STATES[number];

export const BATCH_CLEANUP_PREVIEW_STATES = ['pending', 'cleaned', 'absent', 'residual'] as const;
export type BatchCleanupPreviewState = typeof BATCH_CLEANUP_PREVIEW_STATES[number];

export const BATCH_CLEANUP_OUTCOMES = ['pending', 'completed'] as const;
export type BatchCleanupOutcome = typeof BATCH_CLEANUP_OUTCOMES[number];

/** A cleanup record and its server-calculated deletion scope. */
export type BatchCleanup = {
  cleanup_id: string;
  job_id: string;
  job_name: string;
  source_count: number;
  page_result_count: number;
  review_record_count: number;
  review_exclusive: boolean;
  preview_count: number;
  delete_review: boolean | null;
  task_data_state: BatchCleanupTaskDataState;
  review_state: BatchCleanupReviewState;
  preview_state: BatchCleanupPreviewState;
  outcome: BatchCleanupOutcome;
  created_at: string;
  updated_at: string;
  /** Unknown future notice codes are retained as opaque strings and rendered generically. */
  notice_codes: string[];
};

export type BatchCleanupListResult = {
  items: BatchCleanup[];
  next_offset: number | null;
};
export type BatchCleanupList = BatchCleanupListResult;

export type BatchStorageUsage = {
  database_bytes: number | null;
  wal_bytes: number | null;
  shm_bytes: number | null;
  total_bytes: number | null;
  quota_bytes: number;
  within_quota: boolean | null;
  available: boolean;
};

export type BatchStorageMaintenance = {
  outcome: 'completed' | 'failed';
  usage: BatchStorageUsage;
};
export type BatchStorageMaintainResult = BatchStorageMaintenance;

export type BatchCleanupRequest =
  | { op: 'batch_cleanup_plan'; job_id: string }
  | { op: 'batch_cleanup_execute'; cleanup_id: string; delete_review: boolean }
  | { op: 'batch_cleanup_list'; offset: number; limit: number }
  | { op: 'batch_storage_usage' }
  | { op: 'batch_storage_maintain' };

function fail(message: string): never {
  throw new BatchTaskValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key));
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function text(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && bytes(value) <= maxBytes;
}

function safeInteger(value: unknown, minimum = 0, maximum = MAX_SAFE): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

function nullableBytes(value: unknown): value is number | null {
  return value === null || safeInteger(value);
}

function validTimestamp(value: unknown): value is string {
  return text(value, MAX_TIMESTAMP_BYTES) && Number.isFinite(Date.parse(value));
}

function parseNoticeCodes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_NOTICE_COUNT
    || !value.every((code) => text(code, MAX_NOTICE_BYTES))) return fail('清理提示无效。');
  return [...value];
}

export function parseBatchCleanup(value: unknown): BatchCleanup {
  const fields = [
    'cleanup_id', 'job_id', 'job_name', 'source_count', 'page_result_count', 'review_record_count',
    'review_exclusive', 'preview_count', 'delete_review', 'task_data_state', 'review_state', 'preview_state',
    'outcome', 'created_at', 'updated_at', 'notice_codes',
  ] as const;
  if (!isRecord(value) || !exactKeys(value, fields)
    || !text(value.cleanup_id, MAX_IDENTIFIER_BYTES) || !text(value.job_id, MAX_IDENTIFIER_BYTES)
    || !text(value.job_name, MAX_NAME_BYTES) || !safeInteger(value.source_count)
    || !safeInteger(value.page_result_count) || !safeInteger(value.review_record_count)
    || typeof value.review_exclusive !== 'boolean' || !safeInteger(value.preview_count)
    || !nullableBoolean(value.delete_review) || !oneOf(value.task_data_state, BATCH_CLEANUP_TASK_DATA_STATES)
    || !oneOf(value.review_state, BATCH_CLEANUP_REVIEW_STATES)
    || !oneOf(value.preview_state, BATCH_CLEANUP_PREVIEW_STATES)
    || !oneOf(value.outcome, BATCH_CLEANUP_OUTCOMES) || !validTimestamp(value.created_at)
    || !validTimestamp(value.updated_at)) {
    return fail('任务清理记录无效。');
  }

  const reviewTerminal = TERMINAL_REVIEW_STATES.includes(value.review_state as typeof TERMINAL_REVIEW_STATES[number]);
  const previewTerminal = TERMINAL_PREVIEW_STATES.includes(value.preview_state as typeof TERMINAL_PREVIEW_STATES[number]);
  if (value.delete_review === null
    && (value.task_data_state !== 'pending' || value.review_state !== 'pending'
      || value.preview_state !== 'pending' || value.outcome !== 'pending')) {
    return fail('未执行的清理计划状态不一致。');
  }
  if (value.outcome === 'completed'
    && (value.delete_review === null || value.task_data_state !== 'deleted' || !reviewTerminal || !previewTerminal)) {
    return fail('已完成的清理记录状态不一致。');
  }

  return {
    cleanup_id: value.cleanup_id,
    job_id: value.job_id,
    job_name: value.job_name,
    source_count: value.source_count,
    page_result_count: value.page_result_count,
    review_record_count: value.review_record_count,
    review_exclusive: value.review_exclusive,
    preview_count: value.preview_count,
    delete_review: value.delete_review,
    task_data_state: value.task_data_state,
    review_state: value.review_state,
    preview_state: value.preview_state,
    outcome: value.outcome,
    created_at: value.created_at,
    updated_at: value.updated_at,
    notice_codes: parseNoticeCodes(value.notice_codes),
  };
}

export function parseBatchCleanupList(value: unknown, expectedOffset?: number): BatchCleanupListResult {
  if (!isRecord(value) || !exactKeys(value, ['items', 'next_offset'])
    || !Array.isArray(value.items) || value.items.length > MAX_CLEANUP_LIST_ITEMS
    || (value.next_offset !== null && !safeInteger(value.next_offset))) {
    return fail('任务清理列表无效。');
  }
  const items = value.items.map(parseBatchCleanup);
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.cleanup_id)) return fail('任务清理列表包含重复记录。');
    ids.add(item.cleanup_id);
  }
  if (expectedOffset !== undefined && value.next_offset !== null && value.next_offset <= expectedOffset) {
    return fail('任务清理列表游标未前进。');
  }
  return { items, next_offset: value.next_offset };
}

export function parseBatchStorageUsage(value: unknown): BatchStorageUsage {
  const fields = [
    'database_bytes', 'wal_bytes', 'shm_bytes', 'total_bytes', 'quota_bytes', 'within_quota', 'available',
  ] as const;
  if (!isRecord(value) || !exactKeys(value, fields)
    || !nullableBytes(value.database_bytes) || !nullableBytes(value.wal_bytes) || !nullableBytes(value.shm_bytes)
    || !nullableBytes(value.total_bytes) || !safeInteger(value.quota_bytes)
    || !nullableBoolean(value.within_quota) || typeof value.available !== 'boolean') {
    return fail('任务存储占用无效。');
  }
  const allBytesAvailable = value.database_bytes !== null && value.wal_bytes !== null && value.shm_bytes !== null;
  if (value.available !== allBytesAvailable) return fail('任务存储可用状态不一致。');
  if (value.database_bytes !== null && value.wal_bytes !== null && value.shm_bytes !== null) {
    const total = value.database_bytes + value.wal_bytes + value.shm_bytes;
    if (!Number.isSafeInteger(total) || value.total_bytes !== total
      || value.within_quota !== (total <= value.quota_bytes)) {
      return fail('任务存储统计不一致。');
    }
  } else if (value.total_bytes !== null || value.within_quota !== null) {
    return fail('不可用的任务存储统计不一致。');
  }
  return {
    database_bytes: value.database_bytes,
    wal_bytes: value.wal_bytes,
    shm_bytes: value.shm_bytes,
    total_bytes: value.total_bytes,
    quota_bytes: value.quota_bytes,
    within_quota: value.within_quota,
    available: value.available,
  };
}

export function parseBatchStorageMaintenance(value: unknown): BatchStorageMaintenance {
  if (!isRecord(value) || !exactKeys(value, ['outcome', 'usage'])
    || !oneOf(value.outcome, ['completed', 'failed'] as const)) {
    return fail('任务存储维护结果无效。');
  }
  return { outcome: value.outcome, usage: parseBatchStorageUsage(value.usage) };
}

export function validateBatchCleanupRequest(value: unknown): BatchCleanupRequest {
  if (!isRecord(value) || typeof value.op !== 'string') return fail('清理请求无效。');
  switch (value.op) {
    case 'batch_cleanup_plan':
      if (!exactKeys(value, ['op', 'job_id']) || !text(value.job_id, MAX_IDENTIFIER_BYTES)) return fail('清理计划请求无效。');
      return { op: value.op, job_id: value.job_id };
    case 'batch_cleanup_execute':
      if (!exactKeys(value, ['op', 'cleanup_id', 'delete_review'])
        || !text(value.cleanup_id, MAX_IDENTIFIER_BYTES) || typeof value.delete_review !== 'boolean') {
        return fail('清理执行请求无效。');
      }
      return { op: value.op, cleanup_id: value.cleanup_id, delete_review: value.delete_review };
    case 'batch_cleanup_list':
      if (!exactKeys(value, ['op', 'offset', 'limit']) || !safeInteger(value.offset)
        || !safeInteger(value.limit, 1, MAX_CLEANUP_LIST_ITEMS)) return fail('清理列表请求无效。');
      return { op: value.op, offset: value.offset, limit: value.limit };
    case 'batch_storage_usage':
    case 'batch_storage_maintain':
      if (!exactKeys(value, ['op'])) return fail('存储请求无效。');
      return { op: value.op };
    default:
      return fail('清理请求无效。');
  }
}
