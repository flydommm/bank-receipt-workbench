export type EngineTaskPriority = 'foreground' | 'normal' | 'background';

type QueuedEngineTask = {
  task: () => Promise<unknown>;
  isCurrent: () => boolean;
  priority: EngineTaskPriority;
  state: 'queued' | 'running' | 'settled';
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type TaskOutcome =
  | { ok: true; value: unknown }
  | { ok: false; reason: unknown };

function normalizedLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizedBackgroundLimit(value: number, limit: number): number {
  if (!Number.isFinite(value)) return limit;
  return Math.max(0, Math.min(limit, Math.floor(value)));
}

/**
 * Schedules engine requests by visibility and keeps background work from
 * consuming every available engine slot.
 */
export class EngineProcessScheduler {
  private readonly limit: number;
  private readonly backgroundLimit: number;
  private readonly createStaleError: () => Error;
  private readonly foregroundQueue: QueuedEngineTask[] = [];
  private readonly normalQueue: QueuedEngineTask[] = [];
  private readonly backgroundQueue: QueuedEngineTask[] = [];
  private readonly entriesByPromise = new Map<Promise<unknown>, QueuedEngineTask>();
  private active = 0;
  private activeBackground = 0;
  private draining = false;

  constructor(
    limit: number,
    createStaleError: () => Error,
    backgroundLimit = Math.max(1, limit - 1),
  ) {
    this.limit = normalizedLimit(limit, 1);
    this.backgroundLimit = normalizedBackgroundLimit(backgroundLimit, this.limit);
    this.createStaleError = createStaleError;
  }

  run<T>(
    task: () => Promise<T>,
    isCurrent: () => boolean,
    priority: EngineTaskPriority = 'normal',
  ): Promise<T> {
    let initiallyCurrent: boolean;
    try {
      initiallyCurrent = isCurrent();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!initiallyCurrent) return Promise.reject(this.staleError());

    let resolveTask!: (value: T | PromiseLike<T>) => void;
    let rejectTask!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const entry: QueuedEngineTask = {
      task: task as () => Promise<unknown>,
      isCurrent,
      priority,
      state: 'queued',
      promise: promise as Promise<unknown>,
      resolve: (value) => resolveTask(value as T),
      reject: rejectTask,
    };
    this.entriesByPromise.set(entry.promise, entry);
    this.queueFor(priority).push(entry);
    this.drain();
    return promise;
  }

  promote(promise: Promise<unknown>): void {
    const entry = this.entriesByPromise.get(promise);
    if (!entry || entry.state !== 'queued' || entry.priority === 'foreground') return;

    const queue = this.queueFor(entry.priority);
    const index = queue.indexOf(entry);
    if (index < 0) return;
    queue.splice(index, 1);
    entry.priority = 'foreground';
    this.foregroundQueue.push(entry);
    this.drain();
  }

  private queueFor(priority: EngineTaskPriority): QueuedEngineTask[] {
    if (priority === 'foreground') return this.foregroundQueue;
    if (priority === 'normal') return this.normalQueue;
    return this.backgroundQueue;
  }

  private dequeueNext(): QueuedEngineTask | undefined {
    if (this.foregroundQueue.length > 0) return this.foregroundQueue.shift();
    if (this.normalQueue.length > 0) return this.normalQueue.shift();
    if (this.activeBackground >= this.backgroundLimit) return undefined;
    return this.backgroundQueue.shift();
  }

  private staleError(): Error {
    try {
      return this.createStaleError();
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  private rejectQueued(entry: QueuedEngineTask, reason: unknown): void {
    entry.state = 'settled';
    this.entriesByPromise.delete(entry.promise);
    entry.reject(reason);
  }

  private start(entry: QueuedEngineTask): void {
    let current: boolean;
    try {
      current = entry.isCurrent();
    } catch (error) {
      this.finish(entry, { ok: false, reason: error });
      return;
    }
    if (!current) {
      this.finish(entry, { ok: false, reason: this.staleError() });
      return;
    }

    let taskResult: Promise<unknown>;
    try {
      taskResult = entry.task();
    } catch (error) {
      this.finish(entry, { ok: false, reason: error });
      return;
    }
    Promise.resolve(taskResult).then(
      (value) => this.finish(entry, { ok: true, value }),
      (reason) => this.finish(entry, { ok: false, reason }),
    );
  }

  private finish(entry: QueuedEngineTask, outcome: TaskOutcome): void {
    if (entry.state !== 'running') return;
    entry.state = 'settled';
    this.entriesByPromise.delete(entry.promise);
    this.active -= 1;
    if (entry.priority === 'background') this.activeBackground -= 1;
    if (outcome.ok) entry.resolve(outcome.value);
    else entry.reject(outcome.reason);
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.active < this.limit) {
        const entry = this.dequeueNext();
        if (!entry) return;

        let current: boolean;
        try {
          current = entry.isCurrent();
        } catch (error) {
          this.rejectQueued(entry, error);
          continue;
        }
        if (!current) {
          this.rejectQueued(entry, this.staleError());
          continue;
        }

        entry.state = 'running';
        this.active += 1;
        if (entry.priority === 'background') this.activeBackground += 1;
        void Promise.resolve().then(() => this.start(entry));
      }
    } finally {
      this.draining = false;
    }
  }
}
