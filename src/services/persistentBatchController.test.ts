import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchClient } from './batchClient';
import { PersistentBatchController } from './persistentBatchController';
import type { BatchJobSnapshot, BatchJobSummary } from '../domain/batchTask';

function job(id = 'job-1', state: BatchJobSnapshot['state'] = 'paused', generation = 1): BatchJobSnapshot {
  return { id, name: 'test', state, generation, resume_target: null, criteria: { include: ['fee'], includeMode: 'all', exclude: [] },
    criteria_fingerprint: 'a'.repeat(64), match_mode: 'exact', computation_version: 'test', result_revision: null,
    owner: null, error: null, created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z', deletion_pending: false,
    page_summary: { pending: 2, processing: 0, succeeded: 1, failed: 0 }, total_pages: 3, sources: [] };
}

function source(state: BatchJobSnapshot['sources'][number]['state'], pageCount: number | null) {
  return {
    source_id: `${state}-source`, position: 0, source_key: '/docs/source.pdf',
    initial_path: '/docs/source.pdf', access_path: '/docs/source.pdf', name: 'source.pdf',
    sha256: 'a'.repeat(64), size_bytes: 100, page_count: pageCount, state, error: null,
    budget: { processed_pages: 0, text_characters: 0, fuzzy_work: 0, matches: 0, matched_text_characters: 0 },
    verified_generation: 1,
    page_summary: { pending: pageCount ?? 0, processing: 0, succeeded: 0, failed: 0 },
  } as BatchJobSnapshot['sources'][number];
}
const response = <T>(data: T) => ({ status: 'ok' as const, data });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const client = new BatchClient(vi.fn());
  vi.spyOn(client, 'list').mockResolvedValue(response({ items: [], offset: 0, limit: 50, total: 0, next_offset: null }));
  const controller = new PersistentBatchController(client);
  controllers.push(controller);
  return { client, controller };
}
const controllers: PersistentBatchController[] = [];
afterEach(() => { controllers.splice(0).forEach((controller) => controller.dispose()); vi.useRealTimers(); });

describe('persistent task UI ownership', () => {
  it('keeps the host history order when refreshing a selected same-version snapshot', async () => {
    const { controller, client } = fixture();
    const second = job('second');
    const first = job('first');
    const summaries = [second, first].map(({ sources, ...base }) => ({ ...base, source_summary: {
      total: sources.length, pending: 0, registered: 0, verified: 0, failed: 0, blocked: 0, declared_pages: 0,
    } }));
    vi.mocked(client.list).mockResolvedValue(response({ items: summaries, total: 2, offset: 0, limit: 50, next_offset: null }));
    vi.spyOn(client, 'snapshot').mockResolvedValue(response(second));
    await controller.refreshList();
    await controller.select('second');
    await controller.refreshList();
    expect(controller.getSnapshot().jobs.map((item) => item.id)).toEqual(['second', 'first']);
  });

  it('only lists history on startup, never automatically resumes or selects', async () => {
    vi.useFakeTimers();
    const { controller, client } = fixture();
    const start = vi.spyOn(client, 'start');
    const snapshot = vi.spyOn(client, 'snapshot');
    controller.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.list).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().current).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('discards a late selection response after disposal', async () => {
    const { controller, client } = fixture();
    const pending = deferred<ReturnType<typeof response<BatchJobSnapshot>>>();
    vi.spyOn(client, 'snapshot').mockReturnValue(pending.promise);
    const selected = controller.select('old');
    controller.dispose();
    pending.resolve(response(job('old')));
    await selected;
    expect(controller.getSnapshot().current).toBeNull();
  });

  it('publishes a created queued task even if launch fails', async () => {
    const { controller, client } = fixture();
    vi.spyOn(client, 'create').mockResolvedValue(response(job('new', 'queued', 0)));
    vi.spyOn(client, 'start').mockRejectedValue(new Error('worker failed'));
    await controller.create({ name: 'new', sources: [{ source_path: '/test.pdf', name: 'test' }],
      criteria: { include: ['fee'], includeMode: 'all', exclude: [] }, match_mode: 'exact' });
    expect(controller.getSnapshot()).toMatchObject({ current: { id: 'new', state: 'queued' }, busy: false, error: 'worker failed' });
    expect(client.start).toHaveBeenCalledWith({ job_id: 'new', generation: 0 }, expect.any(AbortSignal));
  });

  it('does not let a late old snapshot overwrite the resumed generation', async () => {
    const { controller, client } = fixture();
    const snapshot = vi.spyOn(client, 'snapshot').mockResolvedValueOnce(response(job()));
    await controller.select('job-1');
    const old = deferred<ReturnType<typeof response<BatchJobSnapshot>>>();
    snapshot.mockReturnValueOnce(old.promise);
    const refreshing = controller.refreshCurrent();
    vi.spyOn(client, 'start').mockResolvedValue(response(job('job-1', 'validating', 2)));
    await controller.resume();
    old.resolve(response(job('job-1', 'paused', 1)));
    await refreshing;
    expect(controller.getSnapshot().current).toMatchObject({ generation: 2, state: 'validating' });
  });

  it('publishes source summaries from the snapshot and keeps them over a stale list response', async () => {
    const { controller, client } = fixture();
    const fresh = job('job-1', 'paused', 2);
    fresh.sources = [source('verified', 4), source('failed', 2)];
    vi.spyOn(client, 'snapshot').mockResolvedValue(response(fresh));
    await controller.select('job-1');

    const published = controller.getSnapshot().jobs[0];
    expect(published?.source_summary).toEqual({
      total: 2, pending: 0, registered: 0, verified: 1, failed: 1, blocked: 0, declared_pages: 6,
    });

    const { sources: _sources, ...base } = fresh;
    const stale = {
      ...base,
      source_summary: { total: 2, pending: 2, registered: 0, verified: 0, failed: 0, blocked: 0, declared_pages: 0 },
    } as BatchJobSummary;
    vi.mocked(client.list).mockResolvedValue(response({ items: [stale], offset: 0, limit: 50, total: 1, next_offset: null }));
    await controller.refreshList();

    expect(controller.getSnapshot().jobs[0]?.source_summary).toEqual(published?.source_summary);
    void _sources;
  });

  it('keeps the current active job selected and sends pause to its exact generation', async () => {
    const { controller, client } = fixture();
    const snapshot = vi.spyOn(client, 'snapshot').mockResolvedValueOnce(response(job('job-1', 'running', 3)))
      .mockResolvedValueOnce(response(job('job-1', 'pause_requested', 3)));
    await controller.select('job-1');
    await controller.select('other');
    controller.clearSelection();
    expect(snapshot).toHaveBeenCalledTimes(1);
    vi.spyOn(client, 'control').mockResolvedValue(response({ status: 'ok', job_id: 'job-1', generation: 3,
      command_id: 'command', action: 'pause', state: 'pause_requested' }));
    await controller.control('pause');
    expect(client.control).toHaveBeenCalledWith(expect.objectContaining({ job_id: 'job-1', generation: 3, action: 'pause' }), expect.any(AbortSignal));
    expect(controller.getSnapshot().current?.state).toBe('pause_requested');
  });

  it('does not send mutation IPC after disposal', async () => {
    const { controller, client } = fixture();
    vi.spyOn(client, 'snapshot').mockResolvedValue(response(job('job-1', 'paused', 1)));
    await controller.select('job-1');
    const start = vi.spyOn(client, 'start');
    const relocate = vi.spyOn(client, 'relocate');
    const control = vi.spyOn(client, 'control');

    controller.dispose();
    await controller.resume();
    await controller.relocate('source-1', '/new/source.pdf');
    await controller.control('pause');

    expect(start).not.toHaveBeenCalled();
    expect(relocate).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
  });

  it('coalesces progress but refreshes terminal events immediately and ignores stale generations', async () => {
    vi.useFakeTimers();
    const { controller, client } = fixture();
    const snapshot = vi.spyOn(client, 'snapshot').mockResolvedValue(response(job('job-1', 'running', 2)));
    await controller.select('job-1');
    const event = (seq: number, generation = 2, type = 'progress') => ({ kind: 'worker', event: {
      protocol: 2, jobId: 'job-1', generation, seq, type,
      payload: type === 'progress' ? { phase: 'heartbeat' } : { state: 'ready_for_review' },
    } });
    controller.onEvent(event(1, 1));
    await vi.advanceTimersByTimeAsync(300);
    expect(snapshot).toHaveBeenCalledTimes(1);
    controller.onEvent(event(1));
    controller.onEvent(event(2));
    await vi.advanceTimersByTimeAsync(249);
    expect(snapshot).toHaveBeenCalledTimes(1);
    controller.onEvent(event(3, 2, 'completed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('recovers missing event sequences from snapshots instead of installing event data', async () => {
    vi.useFakeTimers();
    const { controller, client } = fixture();
    const snapshot = vi.spyOn(client, 'snapshot').mockResolvedValue(response(job('job-1', 'running', 2)));
    await controller.select('job-1');
    controller.onEvent({ kind: 'worker', event: { protocol: 2, jobId: 'job-1', generation: 2,
      seq: 30, type: 'progress', payload: { phase: 'heartbeat', state: 'ready_for_review' } } });
    await vi.advanceTimersByTimeAsync(250);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().current?.state).toBe('running');
  });

  it('does not allow an older list response to replace a refreshed list', async () => {
    const { controller, client } = fixture();
    const first = deferred<Awaited<ReturnType<BatchClient['list']>>>();
    vi.mocked(client.list).mockReturnValueOnce(first.promise).mockResolvedValueOnce(response({
      items: [{ ...job('new') } as unknown as BatchJobSummary], total: 1, offset: 0, limit: 50, next_offset: null,
    }));
    const old = controller.refreshList();
    await controller.refreshList();
    first.resolve(response({ items: [], total: 0, offset: 0, limit: 50, next_offset: null }));
    await old;
    expect(controller.getSnapshot().jobs[0]?.id).toBe('new');
  });

  it('removes a deleted job and ignores an in-flight old list response', async () => {
    const { controller, client } = fixture();
    const deleted = job('deleted');
    const { sources: _sources, ...base } = deleted;
    const summary = {
      ...base,
      source_summary: { total: 0, pending: 0, registered: 0, verified: 0, failed: 0, blocked: 0, declared_pages: 0 },
    } as BatchJobSummary;
    vi.mocked(client.list).mockResolvedValueOnce(response({ items: [summary], total: 1, offset: 0, limit: 50, next_offset: null }));
    await controller.refreshList();
    vi.spyOn(client, 'snapshot').mockResolvedValue(response(deleted));
    await controller.select('deleted');
    expect(controller.getSnapshot().current?.id).toBe('deleted');

    const old = deferred<Awaited<ReturnType<BatchClient['list']>>>();
    vi.mocked(client.list).mockReturnValueOnce(old.promise);
    const refreshing = controller.refreshList();
    controller.forgetDeleted('deleted');
    expect(controller.getSnapshot()).toMatchObject({ current: null, jobs: [], loading: false, busy: false });

    old.resolve(response({ items: [summary], total: 1, offset: 0, limit: 50, next_offset: null }));
    await refreshing;
    expect(controller.getSnapshot().jobs).toEqual([]);
    expect(controller.getSnapshot().current).toBeNull();
  });

  it('does not interrupt another task while forgetting a stale history item', async () => {
    vi.useFakeTimers();
    const { controller, client } = fixture();
    const other = job('other', 'paused', 1);
    const forgotten = job('forgotten', 'paused', 1);
    const summaries = [other, forgotten].map(({ sources, ...base }) => ({ ...base, source_summary: {
      total: sources.length, pending: 0, registered: 0, verified: 0, failed: 0, blocked: 0, declared_pages: 0,
    } }));
    vi.mocked(client.list).mockResolvedValue(response({ items: summaries, total: 2, offset: 0, limit: 50, next_offset: null }));
    await controller.refreshList();
    vi.spyOn(client, 'snapshot').mockResolvedValue(response(other));
    await controller.select('other');

    const started = deferred<ReturnType<typeof response<BatchJobSnapshot>>>();
    const start = vi.spyOn(client, 'start').mockReturnValue(started.promise);
    const resuming = controller.resume();
    const startSignal = start.mock.calls[0]?.[1] as AbortSignal;
    controller.forgetDeleted('forgotten');
    expect(startSignal.aborted).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ current: { id: 'other' }, busy: true });
    started.resolve(response(job('other', 'validating', 2)));
    await resuming;
    expect(controller.getSnapshot()).toMatchObject({ current: { id: 'other', generation: 2 }, busy: false });

    const polled = deferred<ReturnType<typeof response<BatchJobSnapshot>>>();
    vi.mocked(client.snapshot).mockReturnValueOnce(polled.promise);
    const polling = controller.refreshCurrent();
    controller.forgetDeleted('forgotten');
    polled.resolve(response(job('other', 'paused', 2)));
    await polling;
    expect(controller.getSnapshot().current).toMatchObject({ id: 'other', state: 'paused' });

    vi.mocked(client.snapshot).mockResolvedValue(response(job('other', 'paused', 2)));
    controller.onEvent({ kind: 'worker', event: { protocol: 2, jobId: 'other', generation: 2,
      seq: 1, type: 'progress', payload: { phase: 'heartbeat' } } });
    controller.forgetDeleted('forgotten');
    await vi.advanceTimersByTimeAsync(250);
    expect(client.snapshot).toHaveBeenCalled();
    expect(controller.getSnapshot().current?.id).toBe('other');
  });

  it('does not mutate after disposal when a deleted task is forgotten', async () => {
    const { controller } = fixture();
    const before = controller.getSnapshot();
    controller.dispose();
    controller.forgetDeleted('deleted');
    expect(controller.getSnapshot()).toBe(before);
  });

  it('can restart subscription polling after the React effect cleanup cycle', async () => {
    vi.useFakeTimers();
    const { controller, client } = fixture();
    const notified = vi.fn();
    const unsubscribe = controller.subscribe(notified);
    controller.start();
    controller.dispose();
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(notified).toHaveBeenCalled();
    expect(controller.getSnapshot().loading).toBe(false);
    unsubscribe();
  });
});
