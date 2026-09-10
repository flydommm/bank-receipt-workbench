import { BatchClient, BatchClientError } from './batchClient';
import { createBatchEventState, mergeBatchEvent, type BatchEventState, type BatchJobSnapshot,
  type BatchJobSummary, type BatchCreateRequest, type BatchControlAction, type BatchResponse } from '../domain/batchTask';

export const activeBatchStates = new Set(['validating', 'running', 'pause_requested', 'finalizing', 'cancel_requested']);
export function batchIsActive(job: BatchJobSnapshot | null): boolean {
  return Boolean(job && activeBatchStates.has(job.state));
}

export type PersistentBatchState = {
  jobs: BatchJobSummary[];
  current: BatchJobSnapshot | null;
  nextOffset: number | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
};

type JobVersion = {
  updatedAt: number | null;
  generation: number;
  resultRevision: string | null;
};

function ok<T>(response: BatchResponse<T>): T {
  if (response.status === 'error') throw new BatchClientError(response.code, response.message);
  return response.data;
}

function jobVersion(job: Pick<BatchJobSnapshot, 'updated_at' | 'generation' | 'result_revision'>): JobVersion {
  const timestamp = Date.parse(job.updated_at);
  return {
    updatedAt: Number.isFinite(timestamp) ? timestamp : null,
    generation: job.generation,
    resultRevision: job.result_revision,
  };
}

/**
 * Compare fields that are ordered by the batch protocol. Result revisions
 * are opaque identifiers, so an equal timestamp/generation is treated as the
 * same version; the controller's authoritative marker then prevents an old
 * list response from replacing a freshly published snapshot.
 */
function compareJobVersions(left: JobVersion, right: JobVersion): number {
  if (left.updatedAt !== null && right.updatedAt !== null && left.updatedAt !== right.updatedAt) {
    return left.updatedAt - right.updatedAt;
  }
  if (left.generation !== right.generation) return left.generation - right.generation;
  return 0;
}

function summaryFromSnapshot(job: BatchJobSnapshot): BatchJobSummary {
  const source_summary: BatchJobSummary['source_summary'] = {
    total: job.sources.length,
    pending: 0,
    registered: 0,
    verified: 0,
    failed: 0,
    blocked: 0,
    declared_pages: 0,
  };
  for (const source of job.sources) {
    source_summary[source.state] += 1;
    if (source.page_count !== null) source_summary.declared_pages += source.page_count;
  }
  const { sources, ...base } = job;
  void sources;
  return { ...base, source_summary };
}

/** Owns UI request epochs; worker computation remains owned by the desktop host. */
export class PersistentBatchController {
  private state: PersistentBatchState = { jobs: [], current: null, nextOffset: null, loading: false, busy: false, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly authoritativeVersions = new Map<string, JobVersion>();
  /** Tombstones prevent an older host list or event from resurrecting deleted work. */
  private readonly forgottenJobIds = new Set<string>();
  private epoch = 0;
  private listEpoch = 0;
  private disposed = false;
  private currentAbort = new AbortController();
  private eventState: BatchEventState | null = null;
  private refreshing = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly client: BatchClient = new BatchClient()) {}

  getSnapshot = (): PersistentBatchState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<PersistentBatchState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private fail(error: unknown): void {
    if (error instanceof Error && error.name === 'AbortError') return;
    this.update({ error: error instanceof Error ? error.message : '任务操作未完成，请刷新后重试。' });
  }

  /** Listing on startup never selects or resumes a task. */
  start(): void {
    if (this.timer) return;
    this.disposed = false;
    void this.refreshList();
    this.timer = setInterval(() => {
      if (batchIsActive(this.state.current)) void this.refreshCurrent();
    }, 1000);
  }

  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    this.listEpoch += 1;
    this.currentAbort.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    // Subscribers own their unsubscribe handles. Keeping the set supports
    // React's development setup/cleanup/setup cycle without losing a live
    // useSyncExternalStore subscription.
  }

  async refreshList(more = false): Promise<void> {
    if (this.disposed || (more && (this.state.loading || this.state.nextOffset === null))) return;
    const token = ++this.listEpoch;
    const offset = more ? this.state.nextOffset! : 0;
    this.update({ loading: true });
    try {
      const page = ok(await this.client.list({ offset, limit: 50 }));
      if (token !== this.listEpoch || this.disposed) return;
      const jobs = more ? [...this.state.jobs] : [];
      for (const job of page.items) {
        if (this.forgottenJobIds.has(job.id)) continue;
        const index = jobs.findIndex((item) => item.id === job.id);
        const known = this.authoritativeVersions.get(job.id);
        const existing = index >= 0 ? jobs[index] : undefined;
        if (known && compareJobVersions(jobVersion(job), known) <= 0) {
          const newer = this.state.jobs.find((item) => item.id === job.id);
          if (newer) {
            if (index >= 0) jobs[index] = newer;
            else jobs.push(newer);
          }
          continue;
        }
        if (existing && compareJobVersions(jobVersion(job), jobVersion(existing)) < 0) continue;
        if (known) this.authoritativeVersions.set(job.id, jobVersion(job));
        if (index >= 0) jobs[index] = job;
        else jobs.push(job);
      }
      if (!more) {
        // Keep a published snapshot visible when a list request started from
        // an older host view and therefore omitted that job entirely.
        for (const existing of this.state.jobs) {
          if (!this.forgottenJobIds.has(existing.id) && this.authoritativeVersions.has(existing.id)
            && !jobs.some((item) => item.id === existing.id)) jobs.push(existing);
        }
      }
      this.update({ jobs, nextOffset: page.next_offset });
    } catch (error) {
      if (token === this.listEpoch) this.fail(error);
    } finally {
      if (token === this.listEpoch) this.update({ loading: false });
    }
  }

  private begin(): number {
    this.currentAbort.abort();
    this.currentAbort = new AbortController();
    this.refreshing = false;
    this.eventState = null;
    this.update({ busy: true, error: null });
    return ++this.epoch;
  }

  private publish(job: BatchJobSnapshot): void {
    if (this.forgottenJobIds.has(job.id)) return;
    if (job.generation > 0 && (!this.eventState || this.eventState.jobId !== job.id || this.eventState.generation !== job.generation)) {
      this.eventState = createBatchEventState(job.id, job.generation);
    }
    const version = jobVersion(job);
    const known = this.authoritativeVersions.get(job.id);
    const jobs = [...this.state.jobs];
    const index = jobs.findIndex((item) => item.id === job.id);
    const existing = index >= 0 ? jobs[index] : undefined;
    if ((!known || compareJobVersions(version, known) >= 0)
      && (!existing || compareJobVersions(version, jobVersion(existing)) >= 0)) {
      this.authoritativeVersions.set(job.id, version);
      const summary = summaryFromSnapshot(job);
      if (index >= 0) jobs[index] = summary;
      else jobs.push(summary);
    }
    this.update({ current: job, jobs });
  }

  clearSelection(): void {
    if (this.disposed || this.state.busy || batchIsActive(this.state.current)) return;
    this.begin();
    this.update({ current: null, busy: false });
  }

  async select(jobId: string): Promise<BatchJobSnapshot | undefined> {
    if (this.disposed || this.forgottenJobIds.has(jobId) || this.state.busy || batchIsActive(this.state.current)) return;
    const token = this.begin();
    try {
      const job = ok(await this.client.snapshot({ job_id: jobId }, this.currentAbort.signal));
      if (token !== this.epoch) return;
      this.publish(job);
      return job;
    } catch (error) { if (token === this.epoch) this.fail(error); }
    finally { if (token === this.epoch) this.update({ busy: false }); }
  }

  async create(input: Omit<BatchCreateRequest, 'op'>): Promise<BatchJobSnapshot | undefined> {
    if (this.disposed || this.state.busy || batchIsActive(this.state.current)) return;
    const token = this.begin();
    try {
      const job = ok(await this.client.create(input, this.currentAbort.signal));
      if (token !== this.epoch) return;
      // Publish the queued task before start: if launching fails it remains
      // visible and can be explicitly retried without losing the task ID.
      this.publish(job);
      const running = ok(await this.client.start({ job_id: job.id, generation: job.generation }, this.currentAbort.signal));
      if (token !== this.epoch) return;
      this.publish(running);
      return running;
    } catch (error) { if (token === this.epoch) this.fail(error); }
    finally {
      if (token === this.epoch) { this.update({ busy: false }); void this.refreshList(); }
    }
  }

  async resume(): Promise<void> {
    const job = this.state.current;
    if (this.disposed || !job || this.state.busy || batchIsActive(job)) return;
    await this.mutate(() => this.client.start({ job_id: job.id, generation: job.generation }, this.currentAbort.signal));
  }

  async relocate(sourceId: string, newPath: string): Promise<void> {
    const job = this.state.current;
    if (this.disposed || !job || this.state.busy || batchIsActive(job)) return;
    await this.mutate(() => this.client.relocate({ job_id: job.id, source_id: sourceId, new_path: newPath }, this.currentAbort.signal));
  }

  private async mutate(operation: () => Promise<BatchResponse<BatchJobSnapshot>>): Promise<void> {
    if (this.disposed) return;
    const token = this.begin();
    try {
      const job = ok(await operation());
      if (token === this.epoch) this.publish(job);
    } catch (error) { if (token === this.epoch) this.fail(error); }
    finally {
      if (token === this.epoch) { this.update({ busy: false }); void this.refreshList(); }
    }
  }

  async control(action: BatchControlAction): Promise<void> {
    const job = this.state.current;
    if (this.disposed || !job || this.state.busy) return;
    const token = this.begin();
    try {
      ok(await this.client.control({ job_id: job.id, generation: job.generation,
        command_id: crypto.randomUUID(), action }, this.currentAbort.signal));
      const next = ok(await this.client.snapshot({ job_id: job.id }, this.currentAbort.signal));
      if (token === this.epoch) this.publish(next);
    } catch (error) { if (token === this.epoch) this.fail(error); }
    finally {
      if (token === this.epoch) { this.update({ busy: false }); void this.refreshList(); }
    }
  }

  async refreshCurrent(): Promise<void> {
    const current = this.state.current;
    if (!current || this.state.busy || this.refreshing || this.disposed) return;
    const token = this.epoch;
    this.refreshing = true;
    try {
      const job = ok(await this.client.snapshot({ job_id: current.id }, this.currentAbort.signal));
      if (token === this.epoch && !this.state.busy) this.publish(job);
    } catch (error) { if (token === this.epoch) this.fail(error); }
    finally { if (token === this.epoch) this.refreshing = false; }
  }

  /**
   * Remove a task after the host confirms its task data is deleted.  This is
   * synchronous from the UI's point of view: all epochs and the current
   * request are invalidated before the state is published, while a tombstone
   * rejects any late list page that still contains the deleted task.
   */
  forgetDeleted(jobId: string): void {
    if (this.disposed) return;
    this.forgottenJobIds.add(jobId);
    this.listEpoch += 1;
    this.authoritativeVersions.delete(jobId);
    const jobs = this.state.jobs.filter((item) => item.id !== jobId);
    const deletingCurrent = this.state.current?.id === jobId;
    if (deletingCurrent) {
      this.epoch += 1;
      this.currentAbort.abort();
      this.currentAbort = new AbortController();
      this.eventState = null;
      this.refreshing = false;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      this.update({ jobs, current: null, loading: false, busy: false, error: null });
      return;
    }
    // A cleanup history refresh can report an older task while another task
    // is being started or polled.  Removing the unrelated list item must not
    // cancel that task's request, epoch, event coalescing, or busy lock.
    this.update({ jobs, loading: false });
  }

  /** Events schedule authoritative reads, never install partial result arrays. */
  onEvent = (payload: unknown): void => {
    if (!payload || typeof payload !== 'object' || !this.state.current || this.disposed) return;
    const value = payload as Record<string, unknown>;
    let immediate = false;
    if (value.kind === 'worker' && this.eventState) {
      const merged = mergeBatchEvent(this.eventState, value.event);
      if (!merged.accepted && ['stale_job', 'stale_generation', 'duplicate'].includes(merged.reason)) return;
      this.eventState = merged.state;
      immediate = Boolean(merged.accepted && merged.event.type === 'completed');
    } else if (value.kind === 'settled' && value.jobId === this.state.current.id
      && value.generation === this.state.current.generation) immediate = true;
    else return;
    if (this.refreshTimer) {
      if (!immediate) return;
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshCurrent();
    }, immediate ? 0 : 250);
  };
}
