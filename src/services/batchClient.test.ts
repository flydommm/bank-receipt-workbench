import { describe, expect, it, vi } from 'vitest';

import { BatchClient, BatchClientError } from './batchClient';
import type { BatchJobSnapshot, BatchResultItem } from '../domain/batchTask';
import type { BatchCleanup, BatchStorageUsage } from '../domain/batchCleanup';

const sha = 'a'.repeat(64);
const sourceKey = '/documents/receipt.pdf';
const rect = { x0: 20, y0: 30, x1: 120, y1: 130 };
const candidate = { x0: 0, y0: 0, x1: 600, y1: 400 };

function item(id: string): BatchResultItem {
  const original = {
    id, source_key: sourceKey, source_page: 1, segment_no: 1, analysis_signature: 'b'.repeat(64),
    persistable: true, page_width: 600, page_height: 800, match_rect: rect, candidate_rect: candidate,
    layout_fingerprint: 'geometry:600x800:0,0,600,400', confidence: 0.95, auto_full_page: false,
  };
  return {
    original,
    segment: {
      id, source_key: sourceKey, source_path: sourceKey, source_sha256: sha, source_page: 1, segment_no: 1,
      match_rect: rect, candidate_rect: candidate, final_rect: candidate, page_width: 600, page_height: 800,
      confidence: 0.95, slot: null, snap_points: [0, 400, 800], layout_fingerprint: original.layout_fingerprint,
      crop_mode: 'candidate', review_status: 'confirmed', manual_adjusted: false,
    },
    evidence: [{ page: 1, matched_text: 'fee', matched_field: null, confidence: 0.95,
      x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 }],
  };
}

function page(items: BatchResultItem[], offset: number, total: number, next_offset: number | null) {
  return { result_revision: 'rev-1', offset, limit: 200, total, next_offset, items };
}

async function readyReview() {
  const pages = { pending: 0, processing: 0, succeeded: 1, failed: 0 };
  const job: BatchJobSnapshot = {
    id: 'job-1', name: 'test', generation: 1, state: 'ready_for_review', resume_target: null,
    criteria: { include: ['fee'], includeMode: 'all', exclude: [] }, criteria_fingerprint: sha,
    match_mode: 'exact', computation_version: 'test', result_revision: 'rev-1', owner: null, error: null,
    created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z', deletion_pending: false,
    page_summary: pages, total_pages: 1, sources: [{ source_id: 'source-1', position: 0, source_key: sourceKey,
      initial_path: sourceKey, access_path: '/relocated/receipt.pdf', name: 'receipt', sha256: sha, size_bytes: 1234,
      page_count: 1, state: 'verified', error: null, verified_generation: 1, page_summary: pages,
      budget: { processed_pages: 1, text_characters: 3, fuzzy_work: 0, matches: 1, matched_text_characters: 3 } }],
  };
  const context = { version: 2 as const, sources: [{ source_key: sourceKey, source_path: job.sources[0]!.access_path, source_sha256: sha }],
    computation_version: 'test', criteria_fingerprint: sha };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
    computation_version: 'test', criteria_fingerprint: sha, sources: [{ source_key: sourceKey, source_sha256: sha }], version: 2,
  })));
  const contextKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const data = { context, prepared: { status: 'ok', context_key: contextKey, result_revision: 'rev-1', segments: [],
    group_confirmed: false, record_revisions: [{ id: 'one', source_key: sourceKey, source_page: 1, segment_no: 1, record_revision: 0 }] } };
  return { job, data };
}

describe('trusted batch review preparation', () => {
  it('adopts logical source identity after relocation without submitting a UI manifest', async () => {
    const { job, data } = await readyReview();
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data });
    const result = await new BatchClient(invoke).prepareReview(job, [item('one')]);
    expect(result.original.originals[0]?.source_key).toBe(sourceKey);
    expect(result.original.context.sources[0]?.source_path).toBe('/relocated/receipt.pdf');
    expect(invoke).toHaveBeenCalledWith('batch_command', { request: { op: 'batch_prepare_review', job_id: 'job-1', result_revision: 'rev-1' } });
  });

  it('loads the immutable review snapshot after the task has been archived', async () => {
    const { job, data } = await readyReview();
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data });

    const result = await new BatchClient(invoke).prepareReview({ ...job, state: 'archived' }, [item('one')]);

    expect(result.prepared.result_revision).toBe('rev-1');
    expect(invoke).toHaveBeenCalledWith('batch_command', { request: {
      op: 'batch_prepare_review', job_id: 'job-1', result_revision: 'rev-1',
    } });
  });

  it.each(['path', 'sha', 'criteria', 'version', 'revision', 'count'])('rejects a changed %s binding', async (changed) => {
    const { job, data } = await readyReview();
    if (changed === 'path') data.context.sources[0]!.source_path = '/arbitrary.pdf';
    if (changed === 'sha') data.context.sources[0]!.source_sha256 = 'f'.repeat(64);
    if (changed === 'criteria') data.context.criteria_fingerprint = 'f'.repeat(64);
    if (changed === 'version') data.context.computation_version = 'different';
    if (changed === 'revision') data.prepared.result_revision = 'rev-2';
    if (changed === 'count') data.prepared.record_revisions = [];
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data });
    await expect(new BatchClient(invoke).prepareReview(job, [item('one')])).rejects.toThrow();
  });

  it('does not prepare an unfinished task or an already aborted request', async () => {
    const { job } = await readyReview();
    const invoke = vi.fn();
    await expect(new BatchClient(invoke).prepareReview({ ...job, state: 'paused' }, [item('one')])).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(new BatchClient(invoke).prepareReview(job, [item('one')], abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stops adopting when cancellation arrives during asynchronous context validation', async () => {
    const { job, data } = await readyReview();
    const abort = new AbortController();
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((...args: Parameters<SubtleCrypto['digest']>) =>
      digest(...args).then((result) => {
        abort.abort();
        return result;
      }));

    try {
      await expect(new BatchClient(invoke).prepareReview(job, [item('one')], abort.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      digestSpy.mockRestore();
    }
  });
});

describe('BatchClient request boundary', () => {
  it('injects no owner or database path and uses the Tauri batch command', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'error', code: 'batch_conflict', message: '状态已变化' });
    const client = new BatchClient(invoke);

    await expect(client.snapshot({ job_id: 'job-1' })).resolves.toEqual({
      status: 'error', code: 'batch_conflict', message: '状态已变化',
    });
    expect(invoke).toHaveBeenCalledWith('batch_command', { request: { op: 'batch_snapshot', job_id: 'job-1' } });
    expect(JSON.stringify(invoke.mock.calls[0])).not.toContain('database_path');
    expect(JSON.stringify(invoke.mock.calls[0])).not.toContain('owner');
  });

  it('does not invoke Tauri when the request is already aborted', async () => {
    const invoke = vi.fn();
    const client = new BatchClient(invoke);
    const controller = new AbortController();
    controller.abort();

    await expect(client.snapshot({ job_id: 'job-1' }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('consumes a rejection when an injected invoke aborts synchronously', async () => {
    const controller = new AbortController();
    const invoke = vi.fn(() => {
      controller.abort();
      return Promise.reject(new Error('late invoke failure'));
    });
    const client = new BatchClient(invoke);

    await expect(client.snapshot({ job_id: 'job-1' }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports AbortError when an injected invoke throws after aborting', async () => {
    const controller = new AbortController();
    const invoke = vi.fn(() => {
      controller.abort();
      throw new Error('synchronous invoke failure');
    });
    const client = new BatchClient(invoke);

    await expect(client.snapshot({ job_id: 'job-1' }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('BatchClient result pagination', () => {
  it('loads all pages while retaining typed snake_case items', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', data: page([item('one')], 0, 2, 1) })
      .mockResolvedValueOnce({ status: 'ok', data: page([item('two')], 1, 2, null) });
    const client = new BatchClient(invoke);

    await expect(client.loadAllResults('job-1', 'rev-1')).resolves.toMatchObject([
      { segment: { id: 'one' } }, { segment: { id: 'two' } },
    ]);
    expect(invoke).toHaveBeenNthCalledWith(2, 'batch_command', {
      request: { op: 'batch_results_page', job_id: 'job-1', result_revision: 'rev-1', offset: 1, limit: 200 },
    });
  });

  it.each([
    ['revision changed', [
      { status: 'ok', data: page([item('one')], 0, 2, 1) },
      { status: 'ok', data: { ...page([item('two')], 1, 2, null), result_revision: 'rev-2' } },
    ]],
    ['duplicate id', [
      { status: 'ok', data: page([item('one')], 0, 2, 1) },
      { status: 'ok', data: page([item('one')], 1, 2, null) },
    ]],
    ['skipped offset', [
      { status: 'ok', data: { ...page([item('one')], 0, 2, 2), next_offset: 2 } },
    ]],
  ])('rejects %s pagination corruption', async (_name, responses) => {
    const invoke = vi.fn();
    for (const response of responses) invoke.mockResolvedValueOnce(response);
    const client = new BatchClient(invoke);

    await expect(client.loadAllResults('job-1', 'rev-1')).rejects.toBeInstanceOf(Error);
  });

  it('stops waiting when the caller aborts an in-flight page', async () => {
    let resolvePage!: (value: unknown) => void;
    const pending = new Promise((resolve) => { resolvePage = resolve; });
    const invoke = vi.fn().mockReturnValue(pending);
    const client = new BatchClient(invoke);
    const controller = new AbortController();
    const loading = client.loadAllResults('job-1', 'rev-1', controller.signal);
    controller.abort();

    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    resolvePage({ status: 'ok', data: page([], 0, 0, null) });
  });
});

describe('BatchClient errors', () => {
  it('turns a server error into a typed error for aggregate loading', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'error', code: 'batch_conflict', message: '版本已变化' });
    const client = new BatchClient(invoke);

    await expect(client.loadAllResults('job-1', 'rev-1')).rejects.toEqual(
      expect.objectContaining({ name: 'BatchClientError', code: 'batch_conflict', message: '版本已变化' }),
    );
    expect(new BatchClientError('x', 'y')).toBeInstanceOf(Error);
  });
});

function cleanupResponse(overrides: Partial<BatchCleanup> = {}) {
  const data: BatchCleanup = {
    cleanup_id: 'cleanup-1',
    job_id: 'job-1',
    job_name: '合同检索',
    source_count: 1,
    page_result_count: 2,
    review_record_count: 1,
    review_exclusive: true,
    preview_count: 1,
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
  return { status: 'ok' as const, data };
}

function usageResponse(overrides: Partial<BatchStorageUsage> = {}) {
  return {
    status: 'ok' as const,
    data: {
      database_bytes: 10,
      wal_bytes: 2,
      shm_bytes: 3,
      total_bytes: 15,
      quota_bytes: 100,
      within_quota: true,
      available: true,
      ...overrides,
    } satisfies BatchStorageUsage,
  };
}

describe('BatchClient cleanup and storage operations', () => {
  it('sends only server-owned cleanup plan and execution fields', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(cleanupResponse())
      .mockResolvedValueOnce(cleanupResponse({ cleanup_id: 'cleanup-1', delete_review: true, outcome: 'completed',
        task_data_state: 'deleted', review_state: 'deleted', preview_state: 'cleaned' }));
    const client = new BatchClient(invoke);

    await expect(client.planCleanup('job-1')).resolves.toMatchObject({ status: 'ok', data: { cleanup_id: 'cleanup-1' } });
    await expect(client.executeCleanup('cleanup-1', true)).resolves.toMatchObject({
      status: 'ok', data: { delete_review: true },
    });
    expect(invoke).toHaveBeenNthCalledWith(1, 'batch_command', {
      request: { op: 'batch_cleanup_plan', job_id: 'job-1' },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'batch_command', {
      request: { op: 'batch_cleanup_execute', cleanup_id: 'cleanup-1', delete_review: true },
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('path');
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('identity');
  });

  it('parses cleanup history and nullable storage responses', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', data: { items: [cleanupResponse().data], next_offset: null } })
      .mockResolvedValueOnce(usageResponse({ database_bytes: null, total_bytes: null, within_quota: null, available: false }));
    const client = new BatchClient(invoke);

    await expect(client.listCleanups()).resolves.toMatchObject({ data: { items: [{ cleanup_id: 'cleanup-1' }] } });
    await expect(client.storageUsage()).resolves.toMatchObject({ data: { database_bytes: null, total_bytes: null } });
    expect(invoke).toHaveBeenNthCalledWith(1, 'batch_command', {
      request: { op: 'batch_cleanup_list', offset: 0, limit: 20 },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'batch_command', {
      request: { op: 'batch_storage_usage' },
    });
  });

  it('parses storage maintenance and rejects invalid cleanup list limits before IPC', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data: { outcome: 'completed', usage: usageResponse().data } });
    const client = new BatchClient(invoke);

    await expect(client.maintainStorage()).resolves.toMatchObject({ data: { outcome: 'completed' } });
    await expect(client.listCleanups(0, 21)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('batch_command', { request: { op: 'batch_storage_maintain' } });
  });
});
