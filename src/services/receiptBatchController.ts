import {
  ReceiptBatchClient,
  ReceiptBatchClientError,
} from './receiptBatchClient';
import type {
  ReceiptBatchJobSnapshot,
  ReceiptBatchListResult,
} from '../domain/receiptBatch';
import type { ProcessingOptions } from '../domain/receiptLayout';
import type { BatchControlAction, BatchMatchMode } from '../domain/batchTask';

export type ReceiptBatchState = {
  job: ReceiptBatchJobSnapshot | null;
  busy: boolean;
  error: string | null;
  phase: 'idle' | 'creating' | 'running' | 'ready' | 'failed' | 'cancelled';
};

const ACTIVE_STATES = new Set(['queued', 'validating', 'running', 'pause_requested', 'finalizing', 'cancel_requested']);

export function receiptBatchIsActive(job: ReceiptBatchJobSnapshot | null): boolean {
  return Boolean(job && ACTIVE_STATES.has(job.state));
}

function terminalPhase(job: ReceiptBatchJobSnapshot): ReceiptBatchState['phase'] {
  if (job.state === 'cancelled') return 'cancelled';
  if (job.state === 'ready_for_review' || job.state === 'archived') return 'ready';
  if (job.state === 'blocked' || job.state === 'partial_failed' || job.state === 'interrupted') return 'failed';
  return receiptBatchIsActive(job) ? 'running' : 'idle';
}

/**
 * Owns the schema-2 task lifecycle independently from the legacy batch
 * controller.  This lets the desktop opt into receipt jobs while existing
 * schema-1 history remains readable through its original controller.
 */
export class ReceiptBatchController {
  private state: ReceiptBatchState = { job: null, busy: false, error: null, phase: 'idle' };
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private abort = new AbortController();
  private commandBusy = false;

  constructor(readonly client: ReceiptBatchClient = new ReceiptBatchClient()) {}

  getSnapshot = (): ReceiptBatchState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<ReceiptBatchState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private invalidate(): number {
    this.epoch += 1;
    this.abort.abort();
    this.abort = new AbortController();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.epoch;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.listeners.clear();
  }

  clear(): void {
    if (this.disposed) return;
    this.invalidate();
    this.state = { job: null, busy: false, error: null, phase: 'idle' };
    this.commandBusy = false;
    this.listeners.forEach((listener) => listener());
  }

  async createAndStart(input: {
    name: string;
    sources: { source_path: string; name: string }[];
    processing_options: ProcessingOptions;
    match_mode: BatchMatchMode;
    layout_template_id?: string | null;
  }): Promise<ReceiptBatchJobSnapshot | null> {
    if (this.disposed || this.state.busy) return null;
    const epoch = this.invalidate();
    this.update({ busy: true, error: null, phase: 'creating' });
    try {
      const created = await this.client.create(input, this.abort.signal);
      if (epoch !== this.epoch || this.disposed) return null;
      if (created.status === 'error') throw new ReceiptBatchClientError(created.code, created.message);
      this.update({ job: created.data, phase: 'running' });
      const started = await this.client.start({ job_id: created.data.id, generation: created.data.generation }, this.abort.signal);
      if (epoch !== this.epoch || this.disposed) return null;
      if (started.status === 'error') throw new ReceiptBatchClientError(started.code, started.message);
      this.update({ job: started.data, phase: terminalPhase(started.data), busy: receiptBatchIsActive(started.data) });
      if (receiptBatchIsActive(started.data)) this.schedulePoll(epoch, started.data.id);
      return started.data;
    } catch (error) {
      if (epoch !== this.epoch || this.disposed || (error instanceof Error && error.name === 'AbortError')) return null;
      this.update({ busy: false, phase: 'failed', error: error instanceof Error ? error.message : '回单任务创建失败。' });
      return null;
    }
  }

  private schedulePoll(epoch: number, jobId: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll(epoch, jobId);
    }, 500);
  }

  private async poll(epoch: number, jobId: string): Promise<void> {
    if (epoch !== this.epoch || this.disposed) return;
    try {
      const response = await this.client.snapshot({ job_id: jobId }, this.abort.signal);
      if (epoch !== this.epoch || this.disposed) return;
      if (response.status === 'error') throw new ReceiptBatchClientError(response.code, response.message);
      const job = response.data;
      const active = receiptBatchIsActive(job);
      this.update({ job, busy: active, phase: terminalPhase(job) });
      if (active) this.schedulePoll(epoch, job.id);
    } catch (error) {
      if (epoch !== this.epoch || this.disposed || (error instanceof Error && error.name === 'AbortError')) return;
      this.update({ busy: false, phase: 'failed', error: error instanceof Error ? error.message : '回单任务状态读取失败。' });
    }
  }

  async control(action: BatchControlAction): Promise<void> {
    const job = this.state.job;
    if (this.disposed || !job || this.commandBusy) return;
    this.commandBusy = true;
    const epoch = this.invalidate();
    this.update({ busy: true, error: null });
    try {
      const response = await this.client.control({ job_id: job.id, generation: job.generation, command_id: crypto.randomUUID(), action }, this.abort.signal);
      if (epoch !== this.epoch || this.disposed) return;
      if (response.status === 'error') throw new ReceiptBatchClientError(response.code, response.message);
      const next = await this.client.snapshot({ job_id: job.id }, this.abort.signal);
      if (epoch !== this.epoch || this.disposed) return;
      if (next.status === 'error') throw new ReceiptBatchClientError(next.code, next.message);
      this.update({ job: next.data, busy: receiptBatchIsActive(next.data), phase: terminalPhase(next.data) });
      if (receiptBatchIsActive(next.data)) this.schedulePoll(epoch, next.data.id);
    } catch (error) {
      if (epoch !== this.epoch || this.disposed || (error instanceof Error && error.name === 'AbortError')) return;
      this.update({ busy: false, phase: 'failed', error: error instanceof Error ? error.message : '回单任务控制失败。' });
    } finally { this.commandBusy = false; }
  }

  /** Load one explicitly selected task without inheriting a prior snapshot. */
  async select(jobId: string): Promise<ReceiptBatchJobSnapshot | null> {
    if (this.disposed || this.commandBusy || !jobId.trim()) return null;
    const epoch = this.invalidate();
    this.commandBusy = true;
    try {
      const response = await this.client.snapshot({ job_id: jobId }, this.abort.signal);
      if (epoch !== this.epoch || this.disposed) return null;
      if (response.status === 'error') throw new ReceiptBatchClientError(response.code, response.message);
      const job = response.data;
      this.update({ job, busy: receiptBatchIsActive(job), phase: terminalPhase(job), error: null });
      if (receiptBatchIsActive(job)) this.schedulePoll(epoch, job.id);
      return job;
    } catch (error) {
      if (epoch !== this.epoch && !(error instanceof Error && error.name === 'AbortError')) return null;
      if (!(error instanceof Error && error.name === 'AbortError')) this.update({ error: error instanceof Error ? error.message : '任务载入失败。', phase: 'failed', busy: false });
      return null;
    } finally { this.commandBusy = false; }
  }

  /** Resume a paused/queued receipt task through the schema-2 start command. */
  async resume(): Promise<ReceiptBatchJobSnapshot | null> {
    const job = this.state.job;
    if (this.disposed || !job || this.commandBusy || receiptBatchIsActive(job)) return null;
    const epoch = this.invalidate();
    this.commandBusy = true;
    this.update({ busy: true, error: null, phase: 'running' });
    try {
      const response = await this.client.start({ job_id: job.id, generation: job.generation }, this.abort.signal);
      if (epoch !== this.epoch || this.disposed) return null;
      if (response.status === 'error') throw new ReceiptBatchClientError(response.code, response.message);
      const next = response.data;
      this.update({ job: next, busy: receiptBatchIsActive(next), phase: terminalPhase(next) });
      if (receiptBatchIsActive(next)) this.schedulePoll(epoch, next.id);
      return next;
    } catch (error) {
      if (epoch === this.epoch && !(error instanceof Error && error.name === 'AbortError')) this.update({ busy: false, phase: 'failed', error: error instanceof Error ? error.message : '任务继续失败。' });
      return null;
    } finally { this.commandBusy = false; }
  }

  /** Refresh after a calibration revision without reopening or restarting the task. */
  async refresh(jobId: string): Promise<ReceiptBatchJobSnapshot | null> {
    if (this.disposed || this.state.job?.id !== jobId) return null;
    const epoch = this.epoch;
    const response = await this.client.snapshot({ job_id: jobId }, this.abort.signal);
    if (epoch !== this.epoch || this.disposed || this.state.job?.id !== jobId) return null;
    if (response.status === 'error') throw new ReceiptBatchClientError(response.code, response.message);
    this.update({ job: response.data, phase: terminalPhase(response.data), error: null });
    return response.data;
  }

  /** Schema-2 list access is explicit so legacy task history is never mixed. */
  async list(offset = 0, limit = 50): Promise<ReceiptBatchListResult | null> {
    const response = await this.client.list({ offset, limit });
    if (response.status === 'error') throw new ReceiptBatchClientError(response.code, response.message);
    return response.data;
  }
}
