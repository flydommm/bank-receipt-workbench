import {
  executionContextKey,
  FAILURE_RETENTION_LIMIT_BYTES,
  freezeBatchExecutionContext,
  type BatchExecutionContext,
  type BatchExecutionSource,
} from '../domain/batchExecution';

export type BatchPhase = 'search' | 'analysis' | 'verifying';

export type BatchAnalysisCallbacks<Search, Analysis> = {
  search: (
    source: BatchExecutionSource,
    index: number,
    context: BatchExecutionContext,
    isCurrent: () => boolean,
  ) => Promise<Search>;
  analyze: (
    source: BatchExecutionSource,
    index: number,
    search: Search,
    context: BatchExecutionContext,
    isCurrent: () => boolean,
  ) => Promise<Analysis>;
  verify: (
    source: BatchExecutionSource,
    index: number,
    search: Search,
    context: BatchExecutionContext,
    isCurrent: () => boolean,
  ) => Promise<void>;
  isFatal: (error: unknown) => boolean;
  onPhase?: (phase: BatchPhase) => void | Promise<void>;
  onReused?: (
    source: BatchExecutionSource,
    index: number,
    search: Search,
    analysis: Analysis,
  ) => void | Promise<void>;
  concurrency?: number;
  retentionLimitBytes?: number;
};

export type BatchAnalysisRunnerOptions = {
  concurrency?: number;
  retentionLimitBytes?: number;
};

export type BatchFailure = {
  sourcePath: string;
  index: number;
  stage: 'search' | 'analysis';
  error: unknown;
};

export type BatchCompletedResult<Search, Analysis> = {
  source: BatchExecutionSource;
  index: number;
  search: Search;
  analysis: Analysis;
};

export type BatchRunCompleted<Search, Analysis> = {
  status: 'completed';
  results: readonly BatchCompletedResult<Search, Analysis>[];
};

export type BatchRunFailed = {
  status: 'failed';
  failures: readonly BatchFailure[];
  retryable: boolean;
  retainedBytes: number;
  reason: 'ordinary_failure' | 'cache_limit';
};

export type BatchRunOutcome<Search, Analysis> =
  | BatchRunCompleted<Search, Analysis>
  | BatchRunFailed;

export type BatchRunOptions = {
  retryFailed?: boolean;
  isCurrent?: () => boolean;
};

export class BatchRunBusyError extends Error {
  constructor() {
    super('批量分析正在运行。');
    this.name = 'BatchRunBusyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BatchRunSupersededError extends Error {
  constructor() {
    super('批量分析结果已过期。');
    this.name = 'BatchRunSupersededError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type RunToken = { generation: number };

type CachedSourceResult<Search, Analysis> = BatchCompletedResult<Search, Analysis>;

type CacheState<Search, Analysis> = {
  contextKey: string;
  completed: readonly CachedSourceResult<Search, Analysis>[];
  failedIndices: readonly number[];
};

type SearchOutcome<Search, Analysis> =
  | { kind: 'success'; search: Search; analysis?: Analysis; reused: boolean }
  | { kind: 'failed'; stage: 'search'; error: unknown };

type AnalysisOutcome<Analysis> =
  | { kind: 'success'; analysis: Analysis }
  | { kind: 'failed'; stage: 'analysis'; error: unknown };

/** Internal signal that lets concurrent workers preserve the original fatal error. */
class FatalRunSignal {
  constructor(readonly cause: unknown) {}
}

/** A verify failure is global and must win over stale sibling workers. */
class VerifyRunSignal {
  constructor(readonly cause: unknown) {}
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new Error('批量分析结果不可复制。');
  }
}

function normalizeConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(3, Math.floor(value ?? 3)));
}

function normalizeRetentionLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return FAILURE_RETENTION_LIMIT_BYTES;
  return Math.max(0, Math.floor(value));
}

function serializedUtf8Bytes<Search, Analysis>(item: CachedSourceResult<Search, Analysis>): number {
  try {
    const serialized = JSON.stringify({ search: item.search, analysis: item.analysis });
    if (serialized === undefined) return 0;
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Runs one batch in two global phases and retains only complete source results
 * after an ordinary failure. It intentionally has no UI or persistence code.
 */
export class BatchAnalysisRunner<Search, Analysis> {
  private readonly callbacks: BatchAnalysisCallbacks<Search, Analysis>;
  private readonly concurrency: number;
  private readonly retentionLimitBytes: number;
  private generation = 0;
  private activeRun: RunToken | null = null;
  private cache: CacheState<Search, Analysis> | null = null;

  constructor(
    callbacks: BatchAnalysisCallbacks<Search, Analysis>,
    options?: BatchAnalysisRunnerOptions,
  ) {
    this.callbacks = callbacks;
    this.concurrency = normalizeConcurrency(options?.concurrency ?? callbacks.concurrency);
    this.retentionLimitBytes = normalizeRetentionLimit(
      options?.retentionLimitBytes ?? callbacks.retentionLimitBytes,
    );
  }

  canRetry(context: BatchExecutionContext): boolean {
    let key: string;
    try {
      key = executionContextKey(context);
    } catch {
      return false;
    }
    return this.cache !== null && this.cache.contextKey === key;
  }

  retrySourceCount(context: BatchExecutionContext): number {
    if (!this.canRetry(context)) return 0;
    return this.cache?.failedIndices.length ?? 0;
  }

  clear(): void {
    this.generation += 1;
    this.cache = null;
    this.activeRun = null;
  }

  async run(
    input: BatchExecutionContext,
    options: BatchRunOptions = {},
  ): Promise<BatchRunOutcome<Search, Analysis>> {
    if (this.activeRun !== null) throw new BatchRunBusyError();

    const normalizedContext = freezeBatchExecutionContext(input);
    const key = executionContextKey(normalizedContext);
    const shouldRetry = options.retryFailed === true
      && this.cache !== null
      && this.cache.contextKey === key;
    const reusableCache = shouldRetry ? this.cache : null;
    if (!shouldRetry) this.cache = null;

    this.generation += 1;
    const token: RunToken = { generation: this.generation };
    this.activeRun = token;
    const isCurrent = options.isCurrent ?? (() => true);

    try {
      return await this.execute(
        normalizedContext,
        key,
        reusableCache,
        token,
        isCurrent,
      );
    } catch (error) {
      if (error instanceof FatalRunSignal) {
        this.invalidateIfActive(token);
        throw error.cause;
      }
      if (error instanceof VerifyRunSignal) {
        this.invalidateIfActive(token);
        throw error.cause;
      }
      if (error instanceof BatchRunSupersededError) throw error;
      this.invalidateIfActive(token);
      throw error;
    } finally {
      if (this.activeRun === token) this.activeRun = null;
    }
  }

  private async execute(
    context: BatchExecutionContext,
    contextKey: string,
    reusableCache: CacheState<Search, Analysis> | null,
    token: RunToken,
    externalIsCurrent: () => boolean,
  ): Promise<BatchRunOutcome<Search, Analysis>> {
    const guard = (): boolean => {
      if (token.generation !== this.generation || this.activeRun !== token) return false;
      try {
        return externalIsCurrent() === true;
      } catch {
        return false;
      }
    };

    await this.notifyPhase('search', token, externalIsCurrent);
    const reusableByIndex = new Map(
      reusableCache?.completed.map((item) => [item.index, item] as const) ?? [],
    );
    const searchOutcomes = await this.runSearchPhase(
      context,
      reusableByIndex,
      token,
      externalIsCurrent,
      guard,
    );

    await this.notifyPhase('analysis', token, externalIsCurrent);
    const analyses = await this.runAnalysisPhase(
      context,
      searchOutcomes,
      token,
      externalIsCurrent,
      guard,
    );

    const failures: BatchFailure[] = [];
    const complete: CachedSourceResult<Search, Analysis>[] = [];
    for (let index = 0; index < context.sources.length; index += 1) {
      const source = context.sources[index]!;
      const searched = searchOutcomes[index]!;
      if (searched.kind === 'failed') {
        failures.push({ sourcePath: source.sourcePath, index, stage: searched.stage, error: searched.error });
        continue;
      }
      if (searched.reused) {
        complete.push({ source, index, search: searched.search, analysis: searched.analysis as Analysis });
        continue;
      }
      const analyzed = analyses.get(index);
      if (!analyzed || analyzed.kind === 'failed') {
        const error = analyzed?.error ?? new Error('来源分析未返回结果。');
        failures.push({ sourcePath: source.sourcePath, index, stage: 'analysis', error });
        continue;
      }
      complete.push({ source, index, search: searched.search, analysis: analyzed.analysis });
    }

    this.ensureCurrent(token, externalIsCurrent);
    failures.sort((left, right) => left.index - right.index || left.stage.localeCompare(right.stage));
    if (failures.length > 0) {
      return this.finishFailure(contextKey, complete, failures, token, externalIsCurrent);
    }

    await this.verifyAll(context, complete, token, externalIsCurrent, guard);
    this.ensureCurrent(token, externalIsCurrent);
    this.cache = null;
    return deepFreeze({
      status: 'completed' as const,
      results: complete.map((item) => deepFreeze({
        source: item.source,
        index: item.index,
        search: cloneValue(item.search),
        analysis: cloneValue(item.analysis),
      })),
    });
  }

  private async runSearchPhase(
    context: BatchExecutionContext,
    reusableByIndex: Map<number, CachedSourceResult<Search, Analysis>>,
    token: RunToken,
    externalIsCurrent: () => boolean,
    guard: () => boolean,
  ): Promise<SearchOutcome<Search, Analysis>[]> {
    return runConcurrent(context.sources.length, this.concurrency, async (index) => {
      const source = context.sources[index]!;
      const reused = reusableByIndex.get(index);
      if (reused) {
        this.ensureCurrent(token, externalIsCurrent);
        try {
          await this.callbacks.onReused?.(
            source,
            index,
            cloneValue(reused.search),
            cloneValue(reused.analysis),
          );
        } catch (error) {
          this.abortUnexpected(token, externalIsCurrent, error);
        }
        this.ensureCurrent(token, externalIsCurrent);
        return {
          kind: 'success' as const,
          search: cloneValue(reused.search),
          analysis: cloneValue(reused.analysis),
          reused: true,
        };
      }

      this.ensureCurrent(token, externalIsCurrent);
      let rawSearch: Search;
      try {
        rawSearch = await this.callbacks.search(source, index, context, guard);
      } catch (error) {
        return this.captureSearchError(error, token, externalIsCurrent);
      }
      this.ensureCurrent(token, externalIsCurrent);
      let search: Search;
      try {
        search = deepFreeze(cloneValue(rawSearch!));
      } catch (error) {
        this.abortUnexpected(token, externalIsCurrent, error);
      }
      this.ensureCurrent(token, externalIsCurrent);
      return { kind: 'success' as const, search: search!, reused: false };
    });
  }

  private async runAnalysisPhase(
    context: BatchExecutionContext,
    searches: readonly SearchOutcome<Search, Analysis>[],
    token: RunToken,
    externalIsCurrent: () => boolean,
    guard: () => boolean,
  ): Promise<Map<number, AnalysisOutcome<Analysis>>> {
    const indexes = searches
      .map((outcome, index) => outcome.kind === 'success' && !outcome.reused ? index : -1)
      .filter((index) => index >= 0);
    const outcomes = await runConcurrent(indexes.length, this.concurrency, async (slot) => {
      const index = indexes[slot]!;
      const source = context.sources[index]!;
      const searched = searches[index]!;
      if (searched.kind !== 'success') {
        throw new Error('内部搜索阶段结果无效。');
      }
      this.ensureCurrent(token, externalIsCurrent);
      let analyzeInput: Search;
      try {
        analyzeInput = cloneValue(searched.search);
      } catch (error) {
        this.abortUnexpected(token, externalIsCurrent, error);
      }
      this.ensureCurrent(token, externalIsCurrent);
      let rawAnalysis: Analysis;
      try {
        rawAnalysis = await this.callbacks.analyze(source, index, analyzeInput!, context, guard);
      } catch (error) {
        return this.captureAnalysisError(error, token, externalIsCurrent);
      }
      this.ensureCurrent(token, externalIsCurrent);
      let analysis: Analysis;
      try {
        analysis = deepFreeze(cloneValue(rawAnalysis!));
      } catch (error) {
        this.abortUnexpected(token, externalIsCurrent, error);
      }
      this.ensureCurrent(token, externalIsCurrent);
      return { kind: 'success' as const, analysis: analysis! };
    });
    return new Map(indexes.map((index, slot) => [index, outcomes[slot]!]));
  }

  private async verifyAll(
    context: BatchExecutionContext,
    complete: readonly CachedSourceResult<Search, Analysis>[],
    token: RunToken,
    externalIsCurrent: () => boolean,
    guard: () => boolean,
  ): Promise<void> {
    const completeByIndex = new Map(complete.map((item) => [item.index, item] as const));
    await this.notifyPhase('verifying', token, externalIsCurrent);
    await runConcurrent(context.sources.length, this.concurrency, async (index) => {
      const source = context.sources[index]!;
      const item = completeByIndex.get(index);
      if (!item) throw new Error('内部核验结果无效。');
      this.ensureCurrent(token, externalIsCurrent);
      try {
        await this.callbacks.verify(source, index, cloneValue(item.search), context, guard);
        this.ensureCurrent(token, externalIsCurrent);
      } catch (error) {
        if (error instanceof BatchRunSupersededError) throw error;
        this.ensureCurrent(token, externalIsCurrent);
        this.invalidateIfActive(token);
        throw new VerifyRunSignal(error);
      }
    });
  }

  private finishFailure(
    contextKey: string,
    complete: readonly CachedSourceResult<Search, Analysis>[],
    failures: readonly BatchFailure[],
    token: RunToken,
    externalIsCurrent: () => boolean,
  ): BatchRunFailed {
    this.ensureCurrent(token, externalIsCurrent);
    const cached = complete.map((item) => deepFreeze({
      source: cloneValue(item.source),
      index: item.index,
      search: cloneValue(item.search),
      analysis: cloneValue(item.analysis),
    }));
    const retainedBytes = cached.reduce(
      (total, item) => total + serializedUtf8Bytes(item),
      0,
    );
    if (!Number.isFinite(retainedBytes) || retainedBytes > this.retentionLimitBytes) {
      this.invalidateIfActive(token);
      return deepFreeze({
        status: 'failed' as const,
        failures: [...failures],
        retryable: false,
        retainedBytes: 0,
        reason: 'cache_limit' as const,
      });
    }

    this.cache = deepFreeze({
      contextKey,
      completed: cached,
      failedIndices: failures.map((failure) => failure.index),
    });
    return deepFreeze({
      status: 'failed' as const,
      failures: [...failures],
      retryable: true,
      retainedBytes,
      reason: 'ordinary_failure' as const,
    });
  }

  private captureSearchError(
    error: unknown,
    token: RunToken,
    externalIsCurrent: () => boolean,
  ): SearchOutcome<Search, Analysis> {
    if (error instanceof BatchRunSupersededError) throw error;
    this.ensureCurrent(token, externalIsCurrent);
    if (this.isFatal(error)) {
      this.invalidateIfActive(token);
      throw new FatalRunSignal(error);
    }
    return { kind: 'failed', stage: 'search', error };
  }

  private captureAnalysisError(
    error: unknown,
    token: RunToken,
    externalIsCurrent: () => boolean,
  ): AnalysisOutcome<Analysis> {
    if (error instanceof BatchRunSupersededError) throw error;
    this.ensureCurrent(token, externalIsCurrent);
    if (this.isFatal(error)) {
      this.invalidateIfActive(token);
      throw new FatalRunSignal(error);
    }
    return { kind: 'failed', stage: 'analysis', error };
  }

  private async notifyPhase(
    phase: BatchPhase,
    token: RunToken,
    externalIsCurrent: () => boolean,
  ): Promise<void> {
    this.ensureCurrent(token, externalIsCurrent);
    try {
      await this.callbacks.onPhase?.(phase);
    } catch (error) {
      this.abortUnexpected(token, externalIsCurrent, error);
    }
    this.ensureCurrent(token, externalIsCurrent);
  }

  private abortUnexpected(
    token: RunToken,
    externalIsCurrent: () => boolean,
    error: unknown,
  ): never {
    if (error instanceof BatchRunSupersededError) throw error;
    this.ensureCurrent(token, externalIsCurrent);
    this.invalidateIfActive(token);
    throw error;
  }

  private isFatal(error: unknown): boolean {
    return this.callbacks.isFatal(error);
  }

  private ensureCurrent(token: RunToken, externalIsCurrent: () => boolean): void {
    if (token.generation !== this.generation || this.activeRun !== token) {
      throw new BatchRunSupersededError();
    }
    let current: boolean;
    try {
      current = externalIsCurrent();
    } catch (error) {
      this.invalidateIfActive(token);
      throw error;
    }
    if (!current) {
      this.invalidateIfActive(token);
      throw new BatchRunSupersededError();
    }
  }

  private invalidateIfActive(token: RunToken): void {
    if (this.activeRun !== token) return;
    this.generation += 1;
    this.cache = null;
    this.activeRun = null;
  }
}

async function runConcurrent<T>(
  count: number,
  concurrency: number,
  worker: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const noError = Symbol('no-error');
  let firstError: unknown = noError;
  let fatalError: FatalRunSignal | null = null;
  let verifyError: VerifyRunSignal | null = null;

  const consume = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count || firstError !== noError) return;
      try {
        results[index] = await worker(index);
      } catch (error) {
        if (error instanceof FatalRunSignal) fatalError ??= error;
        if (error instanceof VerifyRunSignal) verifyError ??= error;
        if (firstError === noError) firstError = error;
        return;
      }
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, count));
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
  if (fatalError !== null) throw fatalError;
  if (verifyError !== null) throw verifyError;
  if (firstError !== noError) throw firstError;
  return results;
}
