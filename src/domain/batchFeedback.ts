export type BatchStage = 'search' | 'analysis' | 'verifying' | 'finalizing';

export type BatchStepStatus = 'waiting' | 'running' | 'succeeded' | 'failed';

export type BatchFailure = {
  sourcePath: string | null;
  page: number | null;
  stage: BatchStage;
  code: string | null;
  message: string;
  detail: string;
};

export type BatchSourceFeedback = {
  sourcePath: string;
  name: string;
  search: BatchStepStatus;
  pages: Record<number, BatchStepStatus>;
  segmentCount: number | null;
  verification?: BatchStepStatus;
  reused?: boolean;
};

export type BatchFeedback = {
  runId: number;
  phase: 'running' | 'failed' | 'succeeded';
  stage: BatchStage;
  sources: BatchSourceFeedback[];
  failures: BatchFailure[];
};

export type BatchProgressEvent =
  | { type: 'search_started'; sourcePath: string }
  | { type: 'search_finished'; sourcePath: string; failure?: BatchFailure }
  | { type: 'analysis_planned'; pages: { sourcePath: string; page: number }[] }
  | { type: 'page_started'; sourcePath: string; page: number }
  | { type: 'page_finished'; sourcePath: string; page: number; failure?: BatchFailure }
  | { type: 'verifying' }
  | { type: 'verification_started'; sourcePath: string }
  | { type: 'verification_finished'; sourcePath: string; failure?: BatchFailure }
  | { type: 'source_reused'; sourcePath: string; pages: number[] }
  | { type: 'finalizing' }
  | { type: 'completed'; counts: Record<string, number> }
  | { type: 'failed'; failure?: BatchFailure };

export type BatchFeedbackAction =
  | { type: 'clear' }
  | { type: 'begin'; runId: number; sources: { name: string; sourcePath: string }[] }
  | (BatchProgressEvent & { runId: number });

export type BatchObserver = (event: BatchProgressEvent) => void;

const STAGE_ORDER: Record<BatchStage, number> = {
  search: 0,
  analysis: 1,
  verifying: 2,
  finalizing: 3,
};

type KnownFailureMessage = {
  message: string;
};

/**
 * These are the stable engine codes declared by engine/error_codes.py, plus
 * the adapter's own stable LocalEngineError categories.  Keep this mapping
 * local to the feedback model so the model does not depend on the adapter or
 * expose Python implementation details to the UI.
 */
const KNOWN_FAILURE_MESSAGES: Readonly<Record<string, KnownFailureMessage>> = {
  invalid_json: { message: '本地引擎请求格式无效，请重试。' },
  invalid_request: { message: '本地引擎请求参数无效，请检查当前条件后重试。' },
  unsupported_operation: { message: '本地引擎不支持当前操作，请重试。' },
  invalid_path: { message: '文件路径无效，请重新选择 PDF 文件后重试。' },
  empty_keyword: { message: '搜索关键词不能为空，请填写关键词后重试。' },
  invalid_queries: { message: '搜索条件无效，请检查关键词后重试。' },
  empty_include_queries: { message: '至少需要一个包含关键词，请补充关键词后重试。' },
  unsupported_file: { message: '文件类型不受支持，请选择 PDF 文件后重试。' },
  file_not_found: { message: '文件读取失败，请确认 PDF 路径仍然有效后重试。' },
  invalid_page: { message: '请求页码无效，请重新分析文件后重试。' },
  page_out_of_range: { message: '请求页码超出文件范围，请重新分析文件后重试。' },
  page_limit_exceeded: { message: 'PDF 页数超过允许上限，请减少页数后重试。' },
  file_too_large: { message: 'PDF 文件超过允许大小，请选择较小的文件后重试。' },
  file_limit_exceeded: { message: '来源文件数量超过允许上限，请减少文件后重试。' },
  ocr_unavailable: { message: '当前 PDF 需要 OCR，但 OCR 运行时不可用，请检查本地 OCR 环境后重试。' },
  search_failed: { message: 'PDF 搜索失败，请检查文件后重试。' },
  render_failed: { message: 'PDF 页面渲染失败，请重试或检查文件。' },
  invalid_match_rect: { message: '页面命中区域无效，请重新分析文件后重试。' },
  invalid_matches: { message: '页面命中数据无效，请重新分析文件后重试。' },
  analyze_failed: { message: 'PDF 页面分析失败，请重试。' },
  source_changed: { message: '源 PDF 在处理期间发生变化，请重新选择未修改的文件后重试。' },
  invalid_database_path: { message: '审核数据库路径无效，请重试。' },
  invalid_task_id: { message: '审核任务标识无效，请重新分析后重试。' },
  invalid_review_segments: { message: '审核片段数据无效，请重新分析后重试。' },
  review_store_failed: { message: '审核记录处理失败，请重试。' },
  review_revision_conflict: { message: '审核记录已被其他操作更新，请重新分析后再保存。' },
  computation_version_changed: { message: '本地分析引擎已更新，请重新分析后再保存审核。' },
  invalid_config: { message: '本地引擎配置无效，请检查配置后重试。' },

  TAURI_UNAVAILABLE: { message: '本地处理环境不可用，请在桌面应用中重试。' },
  ENGINE_HEALTH_FAILED: { message: '本地引擎调用失败，请确认本地引擎可用后重试。' },
  ENGINE_INVALID_RESPONSE: { message: '本地引擎返回了无效结果，请重试。' },
  ENGINE_INVALID_REQUEST: { message: '本地引擎请求参数无效，请检查当前条件后重试。' },
  ENGINE_ANALYZE_FAILED: { message: '本地 PDF 页面分析调用失败，请重试。' },
  ENGINE_REQUEST_REJECTED: { message: '本地引擎拒绝了本次请求，请根据错误详情修正后重试。' },
};

function isFinitePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function sourceIndex(sources: BatchSourceFeedback[], sourcePath: string | null): number {
  if (sourcePath === null) return Number.MAX_SAFE_INTEGER;
  const index = sources.findIndex((source) => source.sourcePath === sourcePath);
  return index >= 0 ? index : sources.length;
}

function failureKey(failure: BatchFailure): string {
  // A failure's detail is intentionally excluded: the same contextual cause
  // can have different low-level wording while still being one UI item.
  return [
    failure.sourcePath ?? '<global>',
    failure.page === null ? '<none>' : String(failure.page),
    failure.stage,
    failure.code ?? '<none>',
    failure.message,
  ].join('\u0000');
}

function sortFailures(
  failures: readonly BatchFailure[],
  sources: BatchSourceFeedback[],
): BatchFailure[] {
  const unique: BatchFailure[] = [];
  const seen = new Set<string>();
  for (const failure of failures) {
    const key = failureKey(failure);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(failure);
  }

  return unique
    .map((failure, index) => ({ failure, index }))
    .sort((left, right) => {
      const leftSource = sourceIndex(sources, left.failure.sourcePath);
      const rightSource = sourceIndex(sources, right.failure.sourcePath);
      if (leftSource !== rightSource) return leftSource - rightSource;

      // Unknown non-global paths have no import position. Keep them grouped
      // after known sources, in their original order, before global failures.
      if (leftSource === sources.length && left.failure.sourcePath !== null && right.failure.sourcePath !== null) {
        return left.index - right.index;
      }

      const leftPage = left.failure.page === null ? -1 : left.failure.page;
      const rightPage = right.failure.page === null ? -1 : right.failure.page;
      if (leftPage !== rightPage) return leftPage - rightPage;

      const leftStage = STAGE_ORDER[left.failure.stage];
      const rightStage = STAGE_ORDER[right.failure.stage];
      if (leftStage !== rightStage) return leftStage - rightStage;
      return left.index - right.index;
    })
    .map(({ failure }) => failure);
}

function withFailure(
  state: BatchFeedback,
  failure: BatchFailure | undefined,
): BatchFeedback {
  if (!failure) {
    return { ...state, phase: 'failed' };
  }

  return {
    ...state,
    phase: 'failed',
    stage: failure.stage,
    failures: sortFailures([...state.failures, failure], state.sources),
  };
}

function copySource(source: BatchSourceFeedback): BatchSourceFeedback {
  return { ...source, pages: { ...source.pages } };
}

function findSourceIndex(state: BatchFeedback, sourcePath: string): number {
  return state.sources.findIndex((source) => source.sourcePath === sourcePath);
}

function allSearchesSucceeded(state: BatchFeedback): boolean {
  return state.sources.every((source) => source.search === 'succeeded');
}

function allPagesSucceeded(state: BatchFeedback): boolean {
  return state.sources.every((source) => Object.values(source.pages).every((status) => status === 'succeeded'));
}

function verificationStarted(state: BatchFeedback): boolean {
  return state.sources.some((source) => source.verification !== undefined);
}

function allVerificationsSucceeded(state: BatchFeedback): boolean {
  return state.sources.every((source) => source.verification === 'succeeded');
}

function plannedPageCount(state: BatchFeedback): number {
  return state.sources.reduce((total, source) => total + Object.keys(source.pages).length, 0);
}

function isReadyForCompletion(state: BatchFeedback): boolean {
  return (
    allSearchesSucceeded(state)
    && allPagesSucceeded(state)
    && (!verificationStarted(state) || allVerificationsSucceeded(state))
    && state.failures.length === 0
  );
}

function searchDoneCount(state: BatchFeedback): number {
  return state.sources.filter((source) => source.search === 'succeeded' || source.search === 'failed').length;
}

function searchFailureCount(state: BatchFeedback): number {
  return state.sources.filter((source) => source.search === 'failed').length;
}

function pageDoneCount(state: BatchFeedback): number {
  return state.sources.reduce(
    (total, source) => total + Object.values(source.pages)
      .filter((status) => status === 'succeeded' || status === 'failed').length,
    0,
  );
}

function pageFailureCount(state: BatchFeedback): number {
  return state.sources.reduce(
    (total, source) => total + Object.values(source.pages).filter((status) => status === 'failed').length,
    0,
  );
}

function verificationDoneCount(state: BatchFeedback): number {
  return state.sources.filter((source) => source.verification === 'succeeded' || source.verification === 'failed').length;
}

function verificationFailureCount(state: BatchFeedback): number {
  return state.sources.filter((source) => source.verification === 'failed').length;
}

function safeSegmentCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export function batchFeedbackReducer(
  state: BatchFeedback | null,
  action: BatchFeedbackAction,
): BatchFeedback | null {
  if (action.type === 'clear') return null;

  if (action.type === 'begin') {
    return {
      runId: action.runId,
      phase: 'running',
      stage: 'search',
      sources: action.sources.map(({ name, sourcePath }) => ({
        sourcePath,
        name,
        search: 'waiting',
        pages: {},
        segmentCount: null,
      })),
      failures: [],
    };
  }

  if (!state || state.phase !== 'running' || action.runId !== state.runId) return state;

  switch (action.type) {
    case 'search_started': {
      if (state.stage !== 'search') return state;
      const index = findSourceIndex(state, action.sourcePath);
      if (index < 0 || state.sources[index]!.search !== 'waiting') return state;

      const nextSources = state.sources.map(copySource);
      nextSources[index] = { ...nextSources[index]!, search: 'running' };
      return { ...state, sources: nextSources };
    }

    case 'search_finished': {
      if (state.stage !== 'search') return state;
      const index = findSourceIndex(state, action.sourcePath);
      if (index < 0) return state;
      const source = state.sources[index]!;
      if (source.search !== 'waiting' && source.search !== 'running') return state;

      const nextSources = state.sources.map(copySource);
      nextSources[index] = {
        ...nextSources[index]!,
        search: action.failure ? 'failed' : 'succeeded',
      };
      return {
        ...state,
        sources: nextSources,
        failures: action.failure
          ? sortFailures([...state.failures, action.failure], nextSources)
          : state.failures,
      };
    }

    case 'analysis_planned': {
      if (state.stage !== 'search' && state.stage !== 'analysis') return state;

      // An explicit empty plan is useful for a zero-hit run. A non-empty plan
      // with no known pages is ignored so unknown callbacks cannot advance the
      // state machine.
      if (action.pages.length === 0) {
        return state.stage === 'analysis' ? state : { ...state, stage: 'analysis' };
      }

      const planned = new Set<string>();
      const validPages: { sourcePath: string; page: number }[] = [];
      for (const item of action.pages) {
        if (!isRecord(item) || typeof item.sourcePath !== 'string' || !isFinitePositiveInteger(item.page)) continue;
        const index = findSourceIndex(state, item.sourcePath);
        if (index < 0) continue;
        const key = `${item.sourcePath}\u0000${item.page}`;
        if (planned.has(key)) continue;
        planned.add(key);
        validPages.push({ sourcePath: item.sourcePath, page: item.page });
      }
      if (validPages.length === 0) return state;

      let changed = state.stage !== 'analysis';
      const nextSources = state.sources.map(copySource);
      for (const item of validPages) {
        const index = findSourceIndex(state, item.sourcePath);
        if (index < 0) continue;
        const source = nextSources[index]!;
        if (Object.prototype.hasOwnProperty.call(source.pages, item.page)) continue;
        source.pages[item.page] = 'waiting';
        changed = true;
      }
      return changed ? { ...state, stage: 'analysis', sources: nextSources } : state;
    }

    case 'source_reused': {
      if (state.stage !== 'search') return state;
      const index = findSourceIndex(state, action.sourcePath);
      if (index < 0 || state.sources[index]!.search !== 'waiting') return state;

      const validPages = Array.isArray(action.pages)
        ? action.pages.filter(isFinitePositiveInteger)
        : [];
      const nextSources = state.sources.map(copySource);
      const nextSource = nextSources[index]!;
      nextSource.search = 'succeeded';
      nextSource.reused = true;
      for (const page of validPages) nextSource.pages[page] = 'succeeded';
      return { ...state, sources: nextSources };
    }

    case 'page_started': {
      if (state.stage !== 'analysis' || !isFinitePositiveInteger(action.page)) return state;
      const index = findSourceIndex(state, action.sourcePath);
      if (index < 0) return state;
      const source = state.sources[index]!;
      if (!Object.prototype.hasOwnProperty.call(source.pages, action.page)
        || source.pages[action.page] !== 'waiting') return state;

      const nextSources = state.sources.map(copySource);
      nextSources[index]!.pages[action.page] = 'running';
      return { ...state, sources: nextSources };
    }

    case 'page_finished': {
      if (state.stage !== 'analysis' || !isFinitePositiveInteger(action.page)) return state;
      const index = findSourceIndex(state, action.sourcePath);
      if (index < 0) return state;
      const source = state.sources[index]!;
      const currentStatus = source.pages[action.page];
      if (currentStatus !== 'waiting' && currentStatus !== 'running') return state;

      const nextSources = state.sources.map(copySource);
      nextSources[index]!.pages[action.page] = action.failure ? 'failed' : 'succeeded';
      return {
        ...state,
        sources: nextSources,
        failures: action.failure
          ? sortFailures([...state.failures, action.failure], nextSources)
          : state.failures,
      };
    }

    case 'verifying': {
      if (
        state.stage !== 'analysis'
        || !allSearchesSucceeded(state)
        || !allPagesSucceeded(state)
        || state.failures.length > 0
      ) return state;

      const nextSources = state.sources.map((source) => ({
        ...copySource(source),
        verification: 'waiting' as const,
      }));
      return { ...state, stage: 'verifying', sources: nextSources };
    }

    case 'verification_started': {
      if (state.stage !== 'verifying') return state;
      const index = findSourceIndex(state, action.sourcePath);
      if (index < 0 || state.sources[index]!.verification !== 'waiting') return state;

      const nextSources = state.sources.map(copySource);
      nextSources[index] = { ...nextSources[index]!, verification: 'running' };
      return { ...state, sources: nextSources };
    }

    case 'verification_finished': {
      if (state.stage !== 'verifying') return state;
      const index = findSourceIndex(state, action.sourcePath);
      if (index < 0) return state;
      const currentStatus = state.sources[index]!.verification;
      if (currentStatus !== 'waiting' && currentStatus !== 'running') return state;

      const nextSources = state.sources.map(copySource);
      nextSources[index] = {
        ...nextSources[index]!,
        verification: action.failure ? 'failed' : 'succeeded',
      };
      return {
        ...state,
        sources: nextSources,
        failures: action.failure
          ? sortFailures([...state.failures, action.failure], nextSources)
          : state.failures,
      };
    }

    case 'finalizing':
      if (
        state.stage === 'finalizing'
        || !allSearchesSucceeded(state)
        || !allPagesSucceeded(state)
        || state.failures.length > 0
        || (verificationStarted(state) && !allVerificationsSucceeded(state))
      ) {
        return state;
      }
      return { ...state, stage: 'finalizing' };

    case 'completed': {
      if (!isReadyForCompletion(state)) return state;
      if (verificationStarted(state) && state.stage !== 'finalizing') return state;
      // A planned page set must pass through finalizing. A zero-hit search may
      // complete without an analysis plan, as there is no page work to wait for.
      if (plannedPageCount(state) > 0 && state.stage !== 'finalizing') return state;

      const nextSources = state.sources.map((source) => ({
        ...source,
        pages: { ...source.pages },
        segmentCount: safeSegmentCount(action.counts[source.sourcePath]),
      }));
      return {
        ...state,
        phase: 'succeeded',
        stage: 'finalizing',
        sources: nextSources,
      };
    }

    case 'failed':
      return withFailure(state, action.failure);

    default:
      return state;
  }
}

export function formatBatchSummary(state: BatchFeedback): string {
  if (state.phase === 'succeeded') {
    const totalSegments = state.sources.reduce((total, source) => total + (source.segmentCount ?? 0), 0);
    return totalSegments === 0
      ? '本轮分析完成：共 0 个片段（未找到符合条件的片段）'
      : `本轮分析完成：共 ${totalSegments} 个片段`;
  }

  if (state.stage === 'finalizing') {
    return state.phase === 'failed'
      ? '整理审核结果失败 · 整批未完成'
      : '正在整理审核结果';
  }

  if (state.stage === 'analysis') {
    const done = pageDoneCount(state);
    const total = state.sources.reduce((count, source) => count + Object.keys(source.pages).length, 0);
    const failed = pageFailureCount(state);
    const suffix = state.phase === 'failed' ? ' · 整批未完成' : '';
    const analysisSummary = `回单边界分析：已处理 ${done} / ${total} 个命中页，其中 ${failed} 个失败${suffix}`;
    if (state.phase === 'failed') {
      const searchDone = searchDoneCount(state);
      const searchTotal = state.sources.length;
      const searchFailed = searchFailureCount(state);
      return `文件搜索：已处理 ${searchDone} / ${searchTotal} 个文件，其中 ${searchFailed} 个失败；${analysisSummary}`;
    }
    return analysisSummary;
  }

  if (state.stage === 'verifying') {
    const done = verificationDoneCount(state);
    const total = state.sources.length;
    const failed = verificationFailureCount(state);
    const failureSummary = failed > 0 ? `，其中 ${failed} 个失败` : '';
    const suffix = state.phase === 'failed' ? ' · 整批未完成' : '';
    return `正在核验来源：已处理 ${done} / ${total} 个文件${failureSummary}${suffix}`;
  }

  const done = searchDoneCount(state);
  const total = state.sources.length;
  const failed = searchFailureCount(state);
  const suffix = state.phase === 'failed' ? ' · 整批未完成' : '';
  return `搜索：已处理 ${done} / ${total} 个文件，其中 ${failed} 个失败${suffix}`;
}

function formatPageProgress(source: BatchSourceFeedback): string {
  const statuses = Object.values(source.pages);
  const done = statuses.filter((status) => status === 'succeeded' || status === 'failed').length;
  const total = statuses.length;
  const failed = statuses.filter((status) => status === 'failed').length;
  return `边界分析：已处理 ${done} / ${total} 个命中页${failed > 0 ? `，其中 ${failed} 个失败` : ''}`;
}

function appendIncomplete(state: BatchFeedback, status: string): string {
  return state.phase === 'failed' ? `${status} · 整批未完成` : status;
}

function appendReuse(source: BatchSourceFeedback, state: BatchFeedback, status: string): string {
  if (source.reused !== true || state.phase === 'succeeded') return status;
  return `${status} · 已复用上次完整计算`;
}

export function formatBatchSourceStatus(
  state: BatchFeedback,
  source: BatchSourceFeedback,
): string {
  if (source.search === 'waiting') {
    return appendIncomplete(state, state.phase === 'failed' ? '本轮未处理' : '等待搜索');
  }

  if (source.search === 'running') {
    return appendIncomplete(state, '正在搜索');
  }

  if (source.search === 'failed') {
    return appendIncomplete(state, '搜索失败');
  }

  if (source.verification !== undefined && state.stage === 'verifying') {
    if (source.verification === 'waiting') {
      return appendIncomplete(state, appendReuse(source, state, '等待核验'));
    }

    if (source.verification === 'running') {
      return appendIncomplete(state, appendReuse(source, state, '正在核验'));
    }

    if (source.verification === 'failed') {
      return appendIncomplete(state, appendReuse(source, state, '核验失败'));
    }

    if (source.verification === 'succeeded') {
      if (state.phase === 'succeeded' && source.segmentCount !== null) {
        return source.segmentCount === 0
          ? '未找到符合条件的片段'
          : `已生成 ${source.segmentCount} 个片段`;
      }
      return appendIncomplete(state, appendReuse(source, state, '核验完成'));
    }
  }

  if (state.phase === 'succeeded' && source.segmentCount !== null) {
    return source.segmentCount === 0
      ? '未找到符合条件的片段'
      : `已生成 ${source.segmentCount} 个片段`;
  }

  const pageTotal = Object.keys(source.pages).length;
  if (state.phase === 'failed') {
    if (pageTotal > 0 && state.stage === 'analysis') {
      return appendIncomplete(state, appendReuse(source, state, formatPageProgress(source)));
    }
    return appendIncomplete(state, appendReuse(source, state, '搜索完成'));
  }

  if (state.stage === 'analysis' && pageTotal > 0) return appendReuse(source, state, formatPageProgress(source));
  if (state.stage === 'finalizing') return '正在整理审核结果';
  if (source.reused === true) return appendReuse(source, state, '已复用上次完整计算');
  return '搜索完成';
}

function readErrorDetails(error: unknown): { code: string | null; detail: string } {
  if (typeof error === 'string') return { code: null, detail: error };
  if (!isRecord(error)) return { code: null, detail: '' };

  let code: string | null = null;
  const engineCode = error.engineCode;
  if (typeof engineCode === 'string' && engineCode.length > 0) {
    code = engineCode;
  } else {
    const errorCode = error.code;
    if (typeof errorCode === 'string' && errorCode.length > 0) code = errorCode;
  }

  // Only Error.message is a user-supplied technical detail. In particular,
  // do not read message from arbitrary response-shaped objects.
  if (error instanceof Error) {
    return {
      code,
      detail: typeof error.message === 'string' ? error.message : '',
    };
  }
  return { code, detail: '' };
}

export function createBatchFailure(
  context: Pick<BatchFailure, 'stage' | 'sourcePath' | 'page'>,
  error: unknown,
): BatchFailure {
  const { code, detail } = readErrorDetails(error);
  const known = code ? KNOWN_FAILURE_MESSAGES[code] : undefined;
  return {
    sourcePath: context.sourcePath,
    page: context.page,
    stage: context.stage,
    code,
    message: known?.message ?? (detail || '未知错误'),
    detail,
  };
}
