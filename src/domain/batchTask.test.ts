import { describe, expect, it } from 'vitest';

import {
  createBatchEventState,
  mergeBatchEvent,
  parseBatchJobSnapshot,
  parseBatchList,
  parseBatchResultsPage,
  validateBatchRequest,
  type BatchResultItem,
} from './batchTask';

const sha = 'a'.repeat(64);
const sourceKey = '/documents/receipt.pdf';
const rect = { x0: 20, y0: 30, x1: 120, y1: 130 };
const candidate = { x0: 0, y0: 0, x1: 600, y1: 400 };

function budget(processedPages = 1) {
  return {
    processed_pages: processedPages,
    text_characters: 100,
    fuzzy_work: 0,
    matches: 1,
    matched_text_characters: 5,
  };
}

function item(id = 'job:aaa:1:1'): BatchResultItem {
  const original = {
    id,
    source_key: sourceKey,
    source_page: 1,
    segment_no: 1,
    analysis_signature: 'b'.repeat(64),
    persistable: true,
    page_width: 600,
    page_height: 800,
    match_rect: rect,
    candidate_rect: candidate,
    layout_fingerprint: 'geometry:600x800:0,0,600,400',
    confidence: 0.95,
    auto_full_page: false,
  };
  return {
    original,
    segment: {
      id,
      source_key: sourceKey,
      source_path: sourceKey,
      source_sha256: sha,
      source_page: 1,
      segment_no: 1,
      match_rect: rect,
      candidate_rect: candidate,
      final_rect: candidate,
      page_width: 600,
      page_height: 800,
      confidence: 0.95,
      slot: null,
      snap_points: [0, 400, 800],
      layout_fingerprint: original.layout_fingerprint,
      crop_mode: 'candidate',
      review_status: 'confirmed',
      manual_adjusted: false,
    },
    evidence: [{
      page: 1,
      matched_text: 'fee',
      matched_field: '摘要',
      confidence: 0.95,
      x0: rect.x0,
      y0: rect.y0,
      x1: rect.x1,
      y1: rect.y1,
    }],
  };
}

function snapshot() {
  return {
    id: 'job-1',
    name: '批量任务',
    generation: 1,
    state: 'ready_for_review',
    resume_target: null,
    criteria: { include: ['fee'], includeMode: 'all', exclude: [] },
    criteria_fingerprint: sha,
    match_mode: 'exact',
    computation_version: 'analysis-result-v3-page-checkpoints',
    result_revision: 'rev-1',
    owner: null,
    error: null,
    created_at: '2026-09-08T00:00:00Z',
    updated_at: '2026-09-08T00:00:01Z',
    deletion_pending: false,
    page_summary: { pending: 0, processing: 0, succeeded: 1, failed: 0 },
    total_pages: 1,
    sources: [{
      source_id: 'source-1',
      position: 0,
      source_key: sourceKey,
      initial_path: sourceKey,
      access_path: sourceKey,
      name: 'receipt.pdf',
      sha256: sha,
      size_bytes: 1234,
      page_count: 1,
      state: 'verified',
      error: null,
      budget: budget(),
      verified_generation: 1,
      page_summary: { pending: 0, processing: 0, succeeded: 1, failed: 0 },
    }],
  };
}

function resultPage(
  items: BatchResultItem[],
  offset = 0,
  total = items.length,
  nextOffset: number | null = null,
) {
  return {
    result_revision: 'rev-1',
    offset,
    limit: 200,
    total,
    next_offset: nextOffset,
    items,
  };
}

describe('batch task DTO contracts', () => {
  it('accepts a complete snapshot and preserves the snake_case source model', () => {
    const parsed = parseBatchJobSnapshot(snapshot());

    expect(parsed.sources[0]!.source_key).toBe(sourceKey);
    expect(parsed.sources[0]!.budget.processed_pages).toBe(1);
    expect(parsed.criteria.includeMode).toBe('all');
  });

  it('accepts Python-normalized criteria when a term appears in both roles', () => {
    const persisted = {
      ...snapshot(),
      criteria: { include: ['缴税'], includeMode: 'all' as const, exclude: ['缴税'] },
    };

    expect(parseBatchJobSnapshot(persisted).criteria).toEqual({
      include: ['缴税'], includeMode: 'all', exclude: ['缴税'],
    });
  });

  it('accepts a large persisted criteria object within the per-keyword contract', () => {
    const longKeywords = Array.from({ length: 32 }, (_, index) => (
      String.fromCodePoint(0x4e00 + index) + '😀'.repeat(511)
    ));
    const persisted = {
      ...snapshot(),
      criteria: { include: longKeywords, includeMode: 'all' as const, exclude: [] },
    };

    expect(parseBatchJobSnapshot(persisted).criteria.include).toEqual(longKeywords);
  });

  it('normalizes keywords by Unicode codepoint and deduplicates each role independently', () => {
    const longChinese = '中'.repeat(512);
    const normalized = validateBatchRequest({
      op: 'batch_create',
      name: 'x',
      sources: [{ source_path: 'D:/receipt.pdf', name: 'receipt.pdf' }],
      criteria: {
        include: [' e\u0301 ', 'é', '😀'.repeat(512), longChinese],
        includeMode: 'all',
        exclude: [' e\u0301 ', '😀'.repeat(512), longChinese],
      },
      match_mode: 'exact',
    });

    expect(normalized).toMatchObject({
      criteria: {
        include: ['é', '😀'.repeat(512), longChinese],
        exclude: ['é', '😀'.repeat(512), longChinese],
      },
    });
    expect(() => validateBatchRequest({
      op: 'batch_create', name: 'x', sources: [{ source_path: 'D:/receipt.pdf', name: 'receipt.pdf' }],
      criteria: { include: ['😀'.repeat(513)], includeMode: 'all', exclude: [] }, match_mode: 'exact',
    })).toThrow();
  });

  it('rejects incomplete, unknown, and inconsistent DTO fields', () => {
    expect(() => parseBatchJobSnapshot({ ...snapshot(), unexpected: true })).toThrow();
    expect(() => parseBatchJobSnapshot({ ...snapshot(), total_pages: 2 })).toThrow();

    const invalidGeometry = item();
    invalidGeometry.segment.match_rect = { x0: 20, y0: 30, x1: 700, y1: 130 };
    expect(() => parseBatchResultsPage(resultPage([invalidGeometry]))).toThrow();

    expect(() => validateBatchRequest({
      op: 'batch_snapshot', job_id: 'job-1', database_path: 'private.sqlite3',
    })).toThrow();
    expect(() => validateBatchRequest({
      op: 'batch_create', name: 'x', sources: [
        { source_path: 'D:/same.pdf', name: 'a' },
        { source_path: 'd:/same.pdf', name: 'b' },
      ], criteria: { include: ['fee'], includeMode: 'all', exclude: [] }, match_mode: 'exact',
    })).toThrow();
  });

  it('requires complete result page cursors and validates evidence geometry', () => {
    const parsed = parseBatchResultsPage(resultPage([item()], 0, 1));
    expect(parsed.items[0]!.original.source_key).toBe(sourceKey);
    expect(() => parseBatchResultsPage(resultPage([item()], 0, 2, 2))).toThrow();
    expect(() => parseBatchResultsPage(resultPage([], 0, 1, null))).toThrow();
  });

  it('accepts an empty list page beyond the current total after cleanup', () => {
    expect(parseBatchList({
      items: [], offset: 50, limit: 50, total: 3, next_offset: null,
    })).toEqual({ items: [], offset: 50, limit: 50, total: 3, next_offset: null });
  });
});

describe('batch worker event merge', () => {
  it('accepts only the current job generation in strict sequence order', () => {
    let state = createBatchEventState('job-1', 2);
    const accepted = mergeBatchEvent(state, {
      protocol: 2, jobId: 'job-1', generation: 2, seq: 1, type: 'snapshot', payload: {},
    });
    expect(accepted.accepted).toBe(true);
    state = accepted.state;

    expect(mergeBatchEvent(state, {
      protocol: 2, jobId: 'old-job', generation: 2, seq: 2, type: 'progress', payload: { phase: 'heartbeat' },
    })).toMatchObject({ accepted: false, reason: 'stale_job' });
    expect(mergeBatchEvent(state, {
      protocol: 2, jobId: 'job-1', generation: 1, seq: 2, type: 'progress', payload: { phase: 'heartbeat' },
    })).toMatchObject({ accepted: false, reason: 'stale_generation' });
    expect(mergeBatchEvent(state, {
      protocol: 2, jobId: 'job-1', generation: 2, seq: 1, type: 'progress', payload: { phase: 'heartbeat' },
    })).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(mergeBatchEvent(state, {
      protocol: 2, jobId: 'job-1', generation: 2, seq: 4, type: 'progress', payload: { phase: 'heartbeat' },
    })).toMatchObject({ accepted: false, reason: 'out_of_order' });
  });

  it('marks the stream as requiring a snapshot when sequence metadata is missing', () => {
    const state = createBatchEventState('job-1', 1);
    const result = mergeBatchEvent(state, {
      protocol: 2, jobId: 'job-1', generation: 1, type: 'progress', payload: { phase: 'heartbeat' },
    });

    expect(result).toMatchObject({ accepted: false, reason: 'snapshot_required', state: { snapshotRequired: true } });
    expect(mergeBatchEvent(result.state, {
      protocol: 2, jobId: 'job-1', generation: 1, seq: 1, type: 'snapshot', payload: {},
    })).toMatchObject({ accepted: false, reason: 'snapshot_required' });
  });

  it('rejects events after the safe sequence number is exhausted', () => {
    const state = { ...createBatchEventState('job-1', 1), nextSeq: Number.MAX_SAFE_INTEGER };
    const accepted = mergeBatchEvent(state, {
      protocol: 2, jobId: 'job-1', generation: 1, seq: Number.MAX_SAFE_INTEGER,
      type: 'progress', payload: { phase: 'heartbeat' },
    });
    expect(accepted).toMatchObject({ accepted: true, state: { sequenceExhausted: true, nextSeq: Number.MAX_SAFE_INTEGER } });

    expect(mergeBatchEvent(accepted.state, {
      protocol: 2, jobId: 'job-1', generation: 1, seq: Number.MAX_SAFE_INTEGER,
      type: 'progress', payload: { phase: 'heartbeat' },
    })).toMatchObject({ accepted: false, reason: 'duplicate' });
  });
});
