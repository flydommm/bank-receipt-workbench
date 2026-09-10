import { describe, expect, it } from 'vitest';

import {
  parseBatchCleanup,
  parseBatchCleanupList,
  parseBatchStorageMaintenance,
  parseBatchStorageUsage,
  validateBatchCleanupRequest,
} from './batchCleanup';

function cleanup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cleanup_id: 'cleanup-1',
    job_id: 'job-1',
    job_name: '合同检索',
    source_count: 2,
    page_result_count: 12,
    review_record_count: 3,
    review_exclusive: true,
    preview_count: 2,
    delete_review: null,
    task_data_state: 'pending',
    review_state: 'pending',
    preview_state: 'pending',
    outcome: 'pending',
    created_at: '2026-09-08T00:00:00Z',
    updated_at: '2026-09-08T00:00:00Z',
    notice_codes: [],
    ...overrides,
  };
}

function usage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    database_bytes: 1024,
    wal_bytes: 64,
    shm_bytes: 128,
    total_bytes: 1216,
    quota_bytes: 1024 * 1024,
    within_quota: true,
    available: true,
    ...overrides,
  };
}

describe('batch cleanup runtime contracts', () => {
  it('parses the server cleanup DTO and keeps unknown notice codes safe', () => {
    const value = parseBatchCleanup(cleanup({ notice_codes: ['future_notice'] }));
    expect(value).toMatchObject({ cleanup_id: 'cleanup-1', notice_codes: ['future_notice'] });
  });

  it('rejects unknown fields and invalid state values', () => {
    expect(() => parseBatchCleanup(cleanup({ extra: true }))).toThrow();
    expect(() => parseBatchCleanup(cleanup({ outcome: 'done' }))).toThrow();
    expect(() => parseBatchCleanup(cleanup({ review_exclusive: 'yes' }))).toThrow();
    expect(() => parseBatchCleanup(cleanup({ delete_review: 'yes' }))).toThrow();
    expect(() => parseBatchCleanup(cleanup({ created_at: 'when' }))).toThrow();
    expect(() => parseBatchCleanup(cleanup({ delete_review: false, outcome: 'completed', task_data_state: 'deleted',
      review_state: 'retained', preview_state: 'pending' }))).toThrow();
    expect(() => parseBatchCleanup(cleanup({ delete_review: null, review_state: 'retained' }))).toThrow();
  });

  it('parses a bounded cleanup list and rejects a malformed cursor', () => {
    expect(parseBatchCleanupList({ items: [cleanup()], next_offset: 1 })).toMatchObject({ next_offset: 1 });
    expect(() => parseBatchCleanupList({ items: [cleanup()], next_offset: '2' })).toThrow();
    expect(() => parseBatchCleanupList({ items: [], next_offset: -1 })).toThrow();
    expect(() => parseBatchCleanupList({ items: [cleanup(), cleanup()], next_offset: null })).toThrow();
    expect(() => parseBatchCleanupList({ items: [cleanup()], next_offset: 3 }, 3)).toThrow();
  });

  it('keeps nullable storage values nullable', () => {
    expect(parseBatchStorageUsage(usage({ database_bytes: null, total_bytes: null, within_quota: null, available: false }))).toMatchObject({
      database_bytes: null,
      total_bytes: null,
    });
    expect(() => parseBatchStorageUsage({ ...usage(), quota_bytes: null })).toThrow();
    expect(() => parseBatchStorageUsage({ ...usage(), available: 1 })).toThrow();
    expect(() => parseBatchStorageUsage({ ...usage(), total_bytes: 99 })).toThrow();
    expect(() => parseBatchStorageUsage({ ...usage(), available: false })).toThrow();
  });

  it('validates cleanup requests without accepting paths or identities', () => {
    expect(validateBatchCleanupRequest({ op: 'batch_cleanup_plan', job_id: 'job-1' })).toEqual({
      op: 'batch_cleanup_plan', job_id: 'job-1',
    });
    expect(validateBatchCleanupRequest({ op: 'batch_cleanup_execute', cleanup_id: 'cleanup-1', delete_review: false }))
      .toMatchObject({ op: 'batch_cleanup_execute', cleanup_id: 'cleanup-1', delete_review: false });
    expect(validateBatchCleanupRequest({ op: 'batch_cleanup_list', offset: 0, limit: 20 })).toMatchObject({ limit: 20 });
    expect(() => validateBatchCleanupRequest({ op: 'batch_cleanup_list', offset: 0, limit: 21 })).toThrow();
    expect(() => validateBatchCleanupRequest({ op: 'batch_cleanup_plan', job_id: 'job-1', path: 'C:\\secret.pdf' }))
      .toThrow();
  });

  it('parses maintenance outcomes through the same usage contract', () => {
    expect(parseBatchStorageMaintenance({ outcome: 'completed', usage: usage() })).toMatchObject({ outcome: 'completed' });
    expect(parseBatchStorageMaintenance({ outcome: 'failed', usage: usage() })).toMatchObject({
      outcome: 'failed', usage: { available: true },
    });
    expect(() => parseBatchStorageMaintenance({ outcome: 'unknown', usage: usage() })).toThrow();
  });
});
