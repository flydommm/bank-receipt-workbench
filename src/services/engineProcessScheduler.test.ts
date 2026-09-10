import { describe, expect, it } from 'vitest';
import { EngineProcessScheduler } from './engineProcessScheduler';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const current = (): boolean => true;

function schedulerFor(limit: number, backgroundLimit?: number): EngineProcessScheduler {
  return new EngineProcessScheduler(limit, () => new Error('stale'), backgroundLimit);
}

describe('EngineProcessScheduler', () => {
  it('starts a foreground request while 881 background requests remain queued', async () => {
    const scheduler = schedulerFor(3);
    const gates = Array.from({ length: 881 }, () => deferred<void>());
    let startedBackground = 0;
    let startedForeground = false;
    const backgroundRequests = gates.map((gate, index) => scheduler.run(async () => {
      startedBackground += 1;
      await gate.promise;
      return index;
    }, current, 'background'));

    const foregroundRequest = scheduler.run(async () => {
      startedForeground = true;
      return 'visible';
    }, current, 'foreground');

    await Promise.resolve();
    expect(startedForeground).toBe(true);
    expect(startedBackground).toBe(2);
    await expect(foregroundRequest).resolves.toBe('visible');

    gates.forEach((gate) => gate.resolve());
    await Promise.all([...backgroundRequests, foregroundRequest]);
  });

  it('promotes one queued background promise without running it twice', async () => {
    const scheduler = schedulerFor(1);
    const blockerGate = deferred<void>();
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const order: string[] = [];
    let secondRuns = 0;

    const blocker = scheduler.run(async () => {
      order.push('blocker');
      await blockerGate.promise;
      return 'blocker';
    }, current, 'normal');
    const first = scheduler.run(async () => {
      order.push('first');
      await firstGate.promise;
      return 'first';
    }, current, 'background');
    const second = scheduler.run(async () => {
      order.push('second');
      secondRuns += 1;
      await secondGate.promise;
      return 'second';
    }, current, 'background');

    scheduler.promote(second);
    blockerGate.resolve();
    await blocker;
    await Promise.resolve();

    expect(order).toEqual(['blocker', 'second']);
    expect(secondRuns).toBe(1);

    secondGate.resolve();
    firstGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
  });

  it('keeps background concurrency at two while total concurrency reaches three', async () => {
    const scheduler = schedulerFor(3, 2);
    const gates = Array.from({ length: 7 }, () => deferred<void>());
    let active = 0;
    let activeBackground = 0;
    let maxActive = 0;
    let maxActiveBackground = 0;
    const run = (index: number, priority: 'normal' | 'background') => scheduler.run(async () => {
      active += 1;
      if (priority === 'background') activeBackground += 1;
      maxActive = Math.max(maxActive, active);
      maxActiveBackground = Math.max(maxActiveBackground, activeBackground);
      await gates[index]!.promise;
      active -= 1;
      if (priority === 'background') activeBackground -= 1;
      return index;
    }, current, priority);

    const requests = [
      ...Array.from({ length: 6 }, (_, index) => run(index, 'background')),
      run(6, 'normal'),
    ];

    await Promise.resolve();
    expect(maxActive).toBe(3);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActiveBackground).toBe(2);

    gates.forEach((gate) => gate.resolve());
    await expect(Promise.all(requests)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('rejects a queued request that becomes stale and lets the next request run', async () => {
    const scheduler = schedulerFor(1);
    const blockerGate = deferred<void>();
    let queuedCurrent = true;
    let staleTaskRuns = 0;
    let nextTaskRuns = 0;

    const blocker = scheduler.run(async () => {
      await blockerGate.promise;
      return 'blocker';
    }, current);
    const stale = scheduler.run(async () => {
      staleTaskRuns += 1;
      return 'stale';
    }, () => queuedCurrent);
    const next = scheduler.run(async () => {
      nextTaskRuns += 1;
      return 'next';
    }, current);

    queuedCurrent = false;
    blockerGate.resolve();
    await expect(blocker).resolves.toBe('blocker');
    await expect(stale).rejects.toThrow('stale');
    await expect(next).resolves.toBe('next');
    expect(staleTaskRuns).toBe(0);
    expect(nextTaskRuns).toBe(1);
  });

  it('rejects before queueing when the initial current check is stale', async () => {
    const scheduler = schedulerFor(1);
    let taskRuns = 0;
    const request = scheduler.run(async () => {
      taskRuns += 1;
      return 'unexpected';
    }, () => false);

    await expect(request).rejects.toThrow('stale');
    expect(taskRuns).toBe(0);
  });

  it('checks current again immediately before invoking a task', async () => {
    const scheduler = schedulerFor(1);
    let checks = 0;
    let taskRuns = 0;
    const request = scheduler.run(async () => {
      taskRuns += 1;
      return 'unexpected';
    }, () => {
      checks += 1;
      return checks < 3;
    });

    await expect(request).rejects.toThrow('stale');
    expect(checks).toBe(3);
    expect(taskRuns).toBe(0);
  });

  it('rechecks current after run returns and before the execution microtask', async () => {
    const scheduler = schedulerFor(1);
    let isCurrent = true;
    let taskRuns = 0;
    const request = scheduler.run(async () => {
      taskRuns += 1;
      return 'unexpected';
    }, () => isCurrent);

    isCurrent = false;
    await expect(request).rejects.toThrow('stale');
    expect(taskRuns).toBe(0);
  });

  it('releases its slot after synchronous throws and asynchronous rejections', async () => {
    const scheduler = schedulerFor(1);
    const syncFailure = new Error('sync failure');
    const syncRequest = scheduler.run<never>(() => {
      throw syncFailure;
    }, current);
    const afterSync = scheduler.run(async () => 'after sync', current);

    await expect(syncRequest).rejects.toBe(syncFailure);
    await expect(afterSync).resolves.toBe('after sync');

    const asyncFailure = new Error('async failure');
    const asyncRequest = scheduler.run<never>(async () => {
      throw asyncFailure;
    }, current);
    const afterAsync = scheduler.run(async () => 'after async', current);

    await expect(asyncRequest).rejects.toBe(asyncFailure);
    await expect(afterAsync).resolves.toBe('after async');
  });

  it('runs foreground before normal before background, preserving FIFO within a priority', async () => {
    const scheduler = schedulerFor(1);
    const blockerGate = deferred<void>();
    const order: string[] = [];
    const blocker = scheduler.run(async () => {
      order.push('blocker');
      await blockerGate.promise;
    }, current);
    const background = scheduler.run(async () => {
      order.push('background');
    }, current, 'background');
    const normalA = scheduler.run(async () => {
      order.push('normal-a');
    }, current, 'normal');
    const normalB = scheduler.run(async () => {
      order.push('normal-b');
    }, current, 'normal');
    const foreground = scheduler.run(async () => {
      order.push('foreground');
    }, current, 'foreground');

    blockerGate.resolve();
    await Promise.all([blocker, foreground, normalA, normalB, background]);
    expect(order).toEqual(['blocker', 'foreground', 'normal-a', 'normal-b', 'background']);
  });

  it('keeps ordinary requests FIFO', async () => {
    const scheduler = schedulerFor(1);
    const blockerGate = deferred<void>();
    const order: string[] = [];
    const blocker = scheduler.run(async () => {
      await blockerGate.promise;
    }, current);
    const requests = ['a', 'b', 'c'].map((label) => scheduler.run(async () => {
      order.push(label);
      return label;
    }, current));

    blockerGate.resolve();
    await Promise.all([blocker, ...requests]);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
