// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { SearchCriteria } from '../domain/searchCriteria';
import { freezeBatchExecutionContext, type BatchExecutionContext } from '../domain/batchExecution';
import {
  BatchAnalysisRunner,
  BatchRunBusyError,
  BatchRunSupersededError,
  type BatchAnalysisCallbacks,
} from './batchAnalysisRunner';

type Search = { sourcePath: string; hits: string[] };
type Analysis = { pages: number; marker: string };

const criteria: SearchCriteria = { include: ['invoice'], includeMode: 'all', exclude: [] };

function makeContext(count = 4, suffix = ''): BatchExecutionContext {
  return freezeBatchExecutionContext({
    sources: Array.from({ length: count }, (_, index) => ({
      sourcePath: `D:\\batch\\source-${index}${suffix}.pdf`,
      name: `source-${index}${suffix}.pdf`,
    })),
    criteria,
    matchMode: 'exact',
    computationVersion: 'm2-test-v1',
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function callbacksFor(
  hooks: Partial<{
    search: (source: BatchExecutionContext['sources'][number], index: number, context: BatchExecutionContext, isCurrent: () => boolean) => Promise<Search>;
    analyze: (source: BatchExecutionContext['sources'][number], index: number, search: Search, context: BatchExecutionContext, isCurrent: () => boolean) => Promise<Analysis>;
    verify: (source: BatchExecutionContext['sources'][number], index: number, search: Search, context: BatchExecutionContext, isCurrent: () => boolean) => Promise<void>;
  }> = {},
): BatchAnalysisCallbacks<Search, Analysis> {
  return {
    search: hooks.search ?? (async (source, index) => ({ sourcePath: source.sourcePath, hits: index % 2 === 0 ? [`hit-${index}`] : [] })),
    analyze: hooks.analyze ?? (async (_source, index) => ({ pages: index + 1, marker: `analysis-${index}` })),
    verify: hooks.verify ?? (async () => undefined),
    isFatal: () => false,
  };
}

describe('BatchAnalysisRunner', () => {
  it('runs global search then analysis phases, preserving source order and verifying zero-hit sources', async () => {
    const context = makeContext(4);
    const events: string[] = [];
    const verify = vi.fn(async (_source: BatchExecutionContext['sources'][number], index: number) => {
      events.push(`verify:${index}`);
    });
    const callbacks = callbacksFor({
      search: async (source, index) => {
        events.push(`search:${index}`);
        return { sourcePath: source.sourcePath, hits: index === 1 ? [] : [`hit-${index}`] };
      },
      analyze: async (_source, index) => {
        events.push(`analysis:${index}`);
        return { pages: index + 1, marker: `analysis-${index}` };
      },
      verify,
    });
    const runner = new BatchAnalysisRunner(callbacks, { concurrency: 3 });

    const result = await runner.run(context, { isCurrent: () => true });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('expected completed');
    expect(result.results.map((item) => item.index)).toEqual([0, 1, 2, 3]);
    expect(result.results.map((item) => item.source.sourcePath)).toEqual(context.sources.map((source) => source.sourcePath));
    expect(events.filter((event) => event.startsWith('analysis:')).every((event) => events.indexOf(event) > events.indexOf('search:3'))).toBe(true);
    expect(verify).toHaveBeenCalledTimes(4);
    expect(verify.mock.calls.map((call) => call[1])).toEqual([0, 1, 2, 3]);
  });

  it('continues ordinary failures and retries only failed sources while verifying every source', async () => {
    const context = makeContext(20);
    const failed = new Set([3, 14]);
    const searchCalls: number[] = [];
    const analyzeCalls: number[] = [];
    const verifyCalls: number[] = [];
    const callbacks = callbacksFor({
      search: async (source, index) => {
        searchCalls.push(index);
        if (failed.has(index)) throw new Error(`search-${index}`);
        return { sourcePath: source.sourcePath, hits: [`hit-${index}`] };
      },
      analyze: async (_source, index) => {
        analyzeCalls.push(index);
        return { pages: 1, marker: `analysis-${index}` };
      },
      verify: async (_source, index) => {
        verifyCalls.push(index);
      },
    });
    const runner = new BatchAnalysisRunner(callbacks);

    const first = await runner.run(context, { isCurrent: () => true });
    expect(first).toMatchObject({ status: 'failed', reason: 'ordinary_failure', retryable: true });
    if (first.status !== 'failed') throw new Error('expected failed');
    expect(first.failures.map((failure) => [failure.index, failure.stage])).toEqual([[3, 'search'], [14, 'search']]);

    failed.clear();
    searchCalls.length = 0;
    analyzeCalls.length = 0;
    verifyCalls.length = 0;
    const second = await runner.run(context, { retryFailed: true, isCurrent: () => true });
    expect(second.status).toBe('completed');
    expect(searchCalls.sort((a, b) => a - b)).toEqual([3, 14]);
    expect(analyzeCalls.sort((a, b) => a - b)).toEqual([3, 14]);
    expect(verifyCalls.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it('drops a source whose analysis fails and recomputes both stages for that source on retry', async () => {
    const context = makeContext(3);
    let failAnalysis = true;
    const searchCalls: number[] = [];
    const analysisCalls: number[] = [];
    const callbacks = callbacksFor({
      search: async (source, index) => {
        searchCalls.push(index);
        return { sourcePath: source.sourcePath, hits: [`hit-${index}`] };
      },
      analyze: async (_source, index) => {
        analysisCalls.push(index);
        if (failAnalysis && index === 2) throw new Error('analysis-2');
        return { pages: 1, marker: `analysis-${index}` };
      },
    });
    const runner = new BatchAnalysisRunner(callbacks);

    const first = await runner.run(context, { isCurrent: () => true });
    expect(first).toMatchObject({ status: 'failed', reason: 'ordinary_failure', retryable: true });
    if (first.status !== 'failed') throw new Error('expected failed');
    expect(first.failures).toEqual([
      expect.objectContaining({ index: 2, stage: 'analysis', error: expect.any(Error) }),
    ]);

    failAnalysis = false;
    searchCalls.length = 0;
    analysisCalls.length = 0;
    const second = await runner.run(context, { retryFailed: true, isCurrent: () => true });
    expect(second.status).toBe('completed');
    expect(searchCalls).toEqual([2]);
    expect(analysisCalls).toEqual([2]);
  });

  it('snapshots search and analysis responses before exposing them to later callbacks', async () => {
    const context = makeContext(2);
    const secondSearch = deferred<Search>();
    let rawSearch: Search | undefined;
    let retry = false;
    const reusedSearches: Search[] = [];
    const search = vi.fn<BatchAnalysisCallbacks<Search, Analysis>['search']>(async (source, index) => {
      if (index === 0) {
        rawSearch = { sourcePath: source.sourcePath, hits: ['initial'] };
        return rawSearch;
      }
      if (!retry) return secondSearch.promise;
      return { sourcePath: source.sourcePath, hits: ['retried'] };
    });
    const analyze = vi.fn<BatchAnalysisCallbacks<Search, Analysis>['analyze']>(async (_source, index, searchInput) => {
      if (index === 0) searchInput.hits.push('mutated-by-analyze');
      return { pages: 1, marker: `analysis-${index}` };
    });
    const runner = new BatchAnalysisRunner({
      ...callbacksFor({ search, analyze }),
      onReused: async (_source, _index, searchInput) => {
        reusedSearches.push(searchInput);
      },
    });
    const first = runner.run(context, { isCurrent: () => true });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rawSearch!.hits.push('mutated-while-other-source-waited');
    secondSearch.reject(new Error('ordinary-search-failure'));
    await expect(first).resolves.toMatchObject({ status: 'failed', reason: 'ordinary_failure' });

    retry = true;
    const second = await runner.run(context, { retryFailed: true, isCurrent: () => true });
    expect(second.status).toBe('completed');
    expect(reusedSearches).toHaveLength(1);
    expect(reusedSearches[0]!.hits).toEqual(['initial']);
    expect(analyze.mock.calls[0]?.[2].hits).toEqual(['initial', 'mutated-by-analyze']);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it('treats a callback response that cannot be snapshotted as a global failure', async () => {
    const context = makeContext(1);
    const callbacks = callbacksFor({
      search: async () => ({
        sourcePath: 'uncloneable',
        hits: [],
        callback: (() => undefined) as unknown as string,
      } as Search),
    });
    const runner = new BatchAnalysisRunner(callbacks);
    await expect(runner.run(context, { isCurrent: () => true })).rejects.toThrow('批量分析结果不可复制');
    expect(runner.canRetry(context)).toBe(false);
  });

  it('retains successful sources after a second retry failure and exposes retry count', async () => {
    const context = makeContext(3);
    const failed = new Set([1]);
    const callbacks = callbacksFor({
      search: async (source, index) => {
        if (failed.has(index)) throw new Error(`search-${index}`);
        return { sourcePath: source.sourcePath, hits: [`hit-${index}`] };
      },
    });
    const runner = new BatchAnalysisRunner(callbacks);

    const first = await runner.run(context, { isCurrent: () => true });
    expect(first.status).toBe('failed');
    expect(runner.canRetry(context)).toBe(true);
    expect(runner.retrySourceCount(context)).toBe(1);
    const second = await runner.run(context, { retryFailed: true, isCurrent: () => true });
    expect(second).toMatchObject({ status: 'failed', reason: 'ordinary_failure', retryable: true });
    if (second.status !== 'failed') throw new Error('expected failed');
    expect(second.retainedBytes).toBeGreaterThan(0);
    expect(runner.retrySourceCount(context)).toBe(1);
    expect(runner.canRetry(context)).toBe(true);
  });

  it('does not reuse cache for a changed context, including source order, criteria, and version', async () => {
    const context = makeContext(2);
    const search = vi.fn(async (source: BatchExecutionContext['sources'][number], index: number) => {
      if (index === 1) throw new Error('first failure');
      return { sourcePath: source.sourcePath, hits: ['hit'] };
    });
    const runner = new BatchAnalysisRunner(callbacksFor({ search }));
    await runner.run(context, { isCurrent: () => true });
    expect(runner.canRetry(context)).toBe(true);
    expect(runner.canRetry(makeContext(2, '-changed'))).toBe(false);
    expect(runner.retrySourceCount(makeContext(2, '-changed'))).toBe(0);

    await runner.run(makeContext(2, '-changed'), { retryFailed: true, isCurrent: () => true });
    expect(search).toHaveBeenCalledTimes(4);
  });

  it('calls onReused for cached sources in search phase and keeps result data isolated from callers', async () => {
    const context = makeContext(2);
    const reused: number[] = [];
    const search = vi.fn(async (source: BatchExecutionContext['sources'][number], index: number) => {
      if (index === 1) throw new Error('retry me');
      return { sourcePath: source.sourcePath, hits: ['cached'] };
    });
    const onReused = vi.fn(async (_source, index, reusedSearch: Search) => {
      reused.push(index);
      reusedSearch.hits.push('callback mutation');
    });
    const runner = new BatchAnalysisRunner({ ...callbacksFor({ search }), onReused });
    const first = await runner.run(context, { isCurrent: () => true });
    expect(first.status).toBe('failed');
    if (first.status !== 'failed') throw new Error('expected failed');
    const cachedResult = runner;
    const second = await runner.run(context, { retryFailed: true, isCurrent: () => true });
    expect(second.status).toBe('failed');
    expect(reused).toEqual([0]);
    expect(search).toHaveBeenCalledTimes(3);
    expect(cachedResult.retrySourceCount(context)).toBe(1);
  });

  it('enforces concurrency at most three across independent phase callbacks', async () => {
    const context = makeContext(12);
    let activeSearch = 0;
    let maxSearch = 0;
    let activeAnalysis = 0;
    let maxAnalysis = 0;
    const callbacks = callbacksFor({
      search: async (source) => {
        activeSearch += 1;
        maxSearch = Math.max(maxSearch, activeSearch);
        await Promise.resolve();
        activeSearch -= 1;
        return { sourcePath: source.sourcePath, hits: [] };
      },
      analyze: async () => {
        activeAnalysis += 1;
        maxAnalysis = Math.max(maxAnalysis, activeAnalysis);
        await Promise.resolve();
        activeAnalysis -= 1;
        return { pages: 0, marker: 'none' };
      },
    });
    const runner = new BatchAnalysisRunner(callbacks, { concurrency: 99 });
    await runner.run(context, { isCurrent: () => true });
    expect(maxSearch).toBeLessThanOrEqual(3);
    expect(maxAnalysis).toBeLessThanOrEqual(3);
  });

  it('rejects duplicate runs without contaminating the first run', async () => {
    const context = makeContext(1);
    const gate = deferred<Search>();
    const search = vi.fn(() => gate.promise);
    const runner = new BatchAnalysisRunner(callbacksFor({ search }));
    const first = runner.run(context, { isCurrent: () => true });
    await expect(runner.run(context, { isCurrent: () => true })).rejects.toBeInstanceOf(BatchRunBusyError);
    gate.resolve({ sourcePath: context.sources[0]!.sourcePath, hits: [] });
    await expect(first).resolves.toMatchObject({ status: 'completed' });
  });

  it('clear supersedes a late response and permits a new run', async () => {
    const context = makeContext(1);
    const firstGate = deferred<Search>();
    const secondGate = deferred<Search>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const search = vi.fn<BatchAnalysisCallbacks<Search, Analysis>['search']>()
      .mockImplementationOnce(async () => {
        firstStarted.resolve();
        return firstGate.promise;
      })
      .mockImplementationOnce(async () => {
        secondStarted.resolve();
        return secondGate.promise;
      });
    const runner = new BatchAnalysisRunner(callbacksFor({ search }));
    const first = runner.run(context, { isCurrent: () => true });
    await firstStarted.promise;
    runner.clear();
    const second = runner.run(context, { isCurrent: () => true });
    await secondStarted.promise;
    firstGate.resolve({ sourcePath: context.sources[0]!.sourcePath, hits: ['late'] });
    await expect(first).rejects.toBeInstanceOf(BatchRunSupersededError);
    await expect(runner.run(context, { isCurrent: () => true })).rejects.toBeInstanceOf(BatchRunBusyError);
    secondGate.resolve({ sourcePath: context.sources[0]!.sourcePath, hits: ['fresh'] });
    await expect(second).resolves.toMatchObject({
      status: 'completed',
      results: [{ search: { hits: ['fresh'] } }],
    });
  });

  it('supersedes when external lifecycle becomes stale before a callback starts or after it returns', async () => {
    const context = makeContext(1);
    let current = false;
    const search = vi.fn<BatchAnalysisCallbacks<Search, Analysis>['search']>(async () => ({ sourcePath: 'late', hits: [] }));
    const runner = new BatchAnalysisRunner(callbacksFor({ search }));
    await expect(runner.run(context, { isCurrent: () => current })).rejects.toBeInstanceOf(BatchRunSupersededError);
    expect(search).not.toHaveBeenCalled();

    current = true;
    const gate = deferred<Search>();
    search.mockReturnValueOnce(gate.promise);
    const late = runner.run(context, { isCurrent: () => current });
    current = false;
    gate.resolve({ sourcePath: 'late', hits: [] });
    await expect(late).rejects.toBeInstanceOf(BatchRunSupersededError);
  });

  it('passes a boolean-only guard to callbacks after clear or external staleness', async () => {
    const context = makeContext(1);
    const firstGate = deferred<Search>();
    const secondGate = deferred<Search>();
    let current = true;
    let heldGuard: (() => boolean) | undefined;
    const search = vi.fn<BatchAnalysisCallbacks<Search, Analysis>['search']>(async (_source, _index, _context, guard) => {
      heldGuard = guard;
      return firstGate.promise;
    });
    const runner = new BatchAnalysisRunner(callbacksFor({ search }));
    const first = runner.run(context, { isCurrent: () => current });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(heldGuard).toBeTypeOf('function');
    expect(heldGuard!()).toBe(true);

    current = false;
    expect(() => heldGuard!()).not.toThrow();
    expect(heldGuard!()).toBe(false);
    firstGate.resolve({ sourcePath: context.sources[0]!.sourcePath, hits: [] });
    await expect(first).rejects.toBeInstanceOf(BatchRunSupersededError);

    current = true;
    search.mockImplementationOnce(async (_source, _index, _context, guard) => {
      heldGuard = guard;
      return secondGate.promise;
    });
    const second = runner.run(context, { isCurrent: () => current });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    runner.clear();
    expect(() => heldGuard!()).not.toThrow();
    expect(heldGuard!()).toBe(false);
    secondGate.resolve({ sourcePath: context.sources[0]!.sourcePath, hits: [] });
    await expect(second).rejects.toBeInstanceOf(BatchRunSupersededError);
  });

  it('throws fatal errors and global verification errors after clearing cache', async () => {
    const context = makeContext(2);
    const fatal = new Error('source_changed');
    const callbacks = callbacksFor({
      search: async (_source, index) => {
        if (index === 1) throw fatal;
        return { sourcePath: `source-${index}`, hits: [] };
      },
    });
    callbacks.isFatal = (error) => error === fatal;
    const runner = new BatchAnalysisRunner(callbacks);
    await expect(runner.run(context, { isCurrent: () => true })).rejects.toBe(fatal);
    expect(runner.canRetry(context)).toBe(false);

    const verifyFailure = new Error('global verify failed');
    const verifyingRunner = new BatchAnalysisRunner(callbacksFor({
      verify: async (_source, index) => {
        if (index === 0) throw verifyFailure;
      },
    }));
    await expect(verifyingRunner.run(context, { isCurrent: () => true })).rejects.toBe(verifyFailure);
    expect(verifyingRunner.canRetry(context)).toBe(false);
  });

  it('clears a retained ordinary-failure cache when a later verification is fatal', async () => {
    const context = makeContext(2);
    let failSearch = true;
    const fatal = new Error('source_changed');
    const callbacks = callbacksFor({
      search: async (source, index) => {
        if (failSearch && index === 1) throw new Error('ordinary');
        return { sourcePath: source.sourcePath, hits: [] };
      },
      verify: async (_source, index) => {
        if (!failSearch && index === 0) throw fatal;
      },
    });
    callbacks.isFatal = (error) => error === fatal;
    const runner = new BatchAnalysisRunner(callbacks);
    await expect(runner.run(context, { isCurrent: () => true })).resolves.toMatchObject({ status: 'failed' });
    failSearch = false;
    await expect(runner.run(context, { retryFailed: true, isCurrent: () => true })).rejects.toBe(fatal);
    expect(runner.canRetry(context)).toBe(false);
  });

  it('invalidates sibling verify guards immediately while preserving the original verify error', async () => {
    const context = makeContext(2);
    const fatal = new Error('source_changed');
    const allowFatal = deferred<void>();
    const siblingStarted = deferred<void>();
    const siblingGate = deferred<void>();
    let siblingGuard: (() => boolean) | undefined;
    const callbacks = callbacksFor({
      verify: async (_source, index, _search, _context, guard) => {
        if (index === 0) {
          await allowFatal.promise;
          throw fatal;
        }
        siblingGuard = guard;
        siblingStarted.resolve();
        await siblingGate.promise;
      },
    });
    callbacks.isFatal = (error) => error === fatal;
    const runner = new BatchAnalysisRunner(callbacks, { concurrency: 2 });
    const run = runner.run(context, { isCurrent: () => true });
    await siblingStarted.promise;
    allowFatal.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(() => siblingGuard!()).not.toThrow();
    expect(siblingGuard!()).toBe(false);
    siblingGate.resolve();
    await expect(run).rejects.toBe(fatal);
  });

  it('falls back after retention overflow while allowing the next full run to complete', async () => {
    const context = makeContext(2);
    let shouldFail = true;
    const callbacks = callbacksFor({
      search: async (source, index) => {
        if (shouldFail && index === 1) throw new Error('ordinary');
        return { sourcePath: source.sourcePath, hits: ['x'.repeat(40)] };
      },
    });
    const runner = new BatchAnalysisRunner(callbacks, { retentionLimitBytes: 1 });
    const failed = await runner.run(context, { isCurrent: () => true });
    expect(failed).toMatchObject({ status: 'failed', reason: 'cache_limit', retryable: false, retainedBytes: 0 });
    shouldFail = false;
    const completed = await runner.run(context, { retryFailed: true, isCurrent: () => true });
    expect(completed.status).toBe('completed');
  });

  it('supports all-failed retry without pretending there is retained cache', async () => {
    const context = makeContext(2);
    let fail = true;
    const search = vi.fn(async (source, index) => {
      if (fail) throw new Error(`failure-${index}`);
      return { sourcePath: source.sourcePath, hits: [] };
    });
    const runner = new BatchAnalysisRunner(callbacksFor({ search }));
    const first = await runner.run(context, { isCurrent: () => true });
    expect(first).toMatchObject({ status: 'failed', reason: 'ordinary_failure', retainedBytes: 0, retryable: true });
    expect(runner.retrySourceCount(context)).toBe(2);
    fail = false;
    const second = await runner.run(context, { retryFailed: true, isCurrent: () => true });
    expect(second.status).toBe('completed');
    expect(search).toHaveBeenCalledTimes(4);
  });
});
