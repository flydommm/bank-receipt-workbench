import { describe, expect, it } from 'vitest';

import {
  batchFeedbackReducer,
  createBatchFailure,
  formatBatchSourceStatus,
  formatBatchSummary,
  type BatchFeedback,
  type BatchFailure,
} from './batchFeedback';

const sources = [
  { name: 'same.pdf', sourcePath: 'D:/one/same.pdf' },
  { name: 'same.pdf', sourcePath: 'D:/two/same.pdf' },
];

function begin(runId = 1, sourceList = sources) {
  return batchFeedbackReducer(null, {
    type: 'begin',
    runId,
    sources: sourceList,
  })!;
}

function dispatch(
  state: BatchFeedback,
  action: Parameters<typeof batchFeedbackReducer>[1],
): BatchFeedback {
  return batchFeedbackReducer(state, action)!;
}

function failure(
  context: Pick<BatchFailure, 'stage' | 'sourcePath' | 'page'>,
  message: string,
  code: string | null = null,
): BatchFailure {
  return {
    ...context,
    code,
    message,
    detail: message,
  };
}

describe('batchFeedbackReducer lifecycle', () => {
  it('initializes every source as waiting and clear removes the feedback', () => {
    const initial = begin();

    expect(initial).toEqual({
      runId: 1,
      phase: 'running',
      stage: 'search',
      sources: [
        {
          sourcePath: 'D:/one/same.pdf',
          name: 'same.pdf',
          search: 'waiting',
          pages: {},
          segmentCount: null,
        },
        {
          sourcePath: 'D:/two/same.pdf',
          name: 'same.pdf',
          search: 'waiting',
          pages: {},
          segmentCount: null,
        },
      ],
      failures: [],
    });
    expect(batchFeedbackReducer(initial, { type: 'clear' })).toBeNull();
    expect(batchFeedbackReducer(null, { type: 'clear' })).toBeNull();
  });

  it('keeps physical import order and ignores stale, terminal, and unknown events', () => {
    const initial = begin();
    const oneDone = dispatch(initial, {
      type: 'search_finished',
      runId: 1,
      sourcePath: 'D:/two/same.pdf',
    });

    expect(formatBatchSummary(initial)).toContain('0 / 2');
    expect(formatBatchSummary(oneDone)).toContain('1 / 2');
    expect(oneDone.sources.map((source) => source.sourcePath)).toEqual([
      'D:/one/same.pdf',
      'D:/two/same.pdf',
    ]);
    expect(dispatch(oneDone, {
      type: 'search_started',
      runId: 0,
      sourcePath: 'D:/one/same.pdf',
    })).toBe(oneDone);
    expect(dispatch(oneDone, {
      type: 'search_finished',
      runId: 1,
      sourcePath: 'D:/missing.pdf',
    })).toBe(oneDone);

    const failed = dispatch(oneDone, { type: 'failed', runId: 1 });
    expect(dispatch(failed, {
      type: 'search_started',
      runId: 1,
      sourcePath: 'D:/one/same.pdf',
    })).toBe(failed);
    expect(dispatch(failed, {
      type: 'failed',
      runId: 1,
      failure: failure({ stage: 'search', sourcePath: null, page: null }, 'late'),
    })).toBe(failed);
    expect(failed.sources.map((source) => source.search)).toEqual(['waiting', 'succeeded']);
  });

  it('marks search busy only when the source actually starts and settles duplicate finishes once', () => {
    let state = begin(1, [sources[0]!]);
    state = dispatch(state, {
      type: 'search_started',
      runId: 1,
      sourcePath: sources[0]!.sourcePath,
    });
    expect(state.sources[0]!.search).toBe('running');

    const settled = dispatch(state, {
      type: 'search_finished',
      runId: 1,
      sourcePath: sources[0]!.sourcePath,
    });
    expect(settled.sources[0]!.search).toBe('succeeded');
    expect(dispatch(settled, {
      type: 'search_finished',
      runId: 1,
      sourcePath: sources[0]!.sourcePath,
      failure: failure({ stage: 'search', sourcePath: sources[0]!.sourcePath, page: null }, 'duplicate'),
    })).toBe(settled);
    expect(settled.failures).toHaveLength(0);
  });

  it('counts failed and succeeded searches while leaving unstarted sources waiting', () => {
    const fiveSources = Array.from({ length: 5 }, (_, index) => ({
      name: `source-${index + 1}.pdf`,
      sourcePath: `D:/source-${index + 1}.pdf`,
    }));
    let state = begin(7, fiveSources);

    for (const source of fiveSources.slice(0, 3)) {
      state = dispatch(state, {
        type: 'search_started',
        runId: 7,
        sourcePath: source.sourcePath,
      });
    }
    state = dispatch(state, {
      type: 'search_finished',
      runId: 7,
      sourcePath: fiveSources[0]!.sourcePath,
    });
    state = dispatch(state, {
      type: 'search_finished',
      runId: 7,
      sourcePath: fiveSources[1]!.sourcePath,
      failure: failure({ stage: 'search', sourcePath: fiveSources[1]!.sourcePath, page: null }, 'read failed'),
    });
    state = dispatch(state, {
      type: 'search_finished',
      runId: 7,
      sourcePath: fiveSources[2]!.sourcePath,
    });

    expect(formatBatchSummary(state)).toContain('3 / 5');
    expect(formatBatchSummary(state)).toContain('1 个失败');
    expect(state.sources.map((source) => source.search)).toEqual([
      'succeeded',
      'failed',
      'succeeded',
      'waiting',
      'waiting',
    ]);
  });
});

describe('batchFeedbackReducer analysis and completion', () => {
  it('deduplicates pages by source path and physical page while keeping same page from separate sources', () => {
    let state = begin();
    for (const source of sources) {
      state = dispatch(state, {
        type: 'search_finished',
        runId: 1,
        sourcePath: source.sourcePath,
      });
    }
    state = dispatch(state, {
      type: 'analysis_planned',
      runId: 1,
      pages: [
        { sourcePath: 'D:/two/same.pdf', page: 2 },
        { sourcePath: 'D:/one/same.pdf', page: 2 },
        { sourcePath: 'D:/two/same.pdf', page: 2 },
        { sourcePath: 'D:/missing.pdf', page: 9 },
      ],
    });

    expect(state.stage).toBe('analysis');
    expect(state.sources[0]!.pages).toEqual({ 2: 'waiting' });
    expect(state.sources[1]!.pages).toEqual({ 2: 'waiting' });

    state = dispatch(state, {
      type: 'page_started',
      runId: 1,
      sourcePath: 'D:/one/same.pdf',
      page: 2,
    });
    state = dispatch(state, {
      type: 'page_finished',
      runId: 1,
      sourcePath: 'D:/one/same.pdf',
      page: 2,
    });
    expect(state.sources[0]!.pages[2]).toBe('succeeded');
    expect(formatBatchSummary(state)).toContain('1 / 2');
    expect(formatBatchSourceStatus(state, state.sources[0]!)).toContain('1 / 1');
    expect(formatBatchSourceStatus(state, state.sources[1]!)).toContain('0 / 1');
  });

  it('allows a page to finish directly from waiting and never lets a duplicate start regress it', () => {
    let state = begin(2, [sources[0]!]);
    state = dispatch(state, {
      type: 'search_finished',
      runId: 2,
      sourcePath: sources[0]!.sourcePath,
    });
    state = dispatch(state, {
      type: 'analysis_planned',
      runId: 2,
      pages: [{ sourcePath: sources[0]!.sourcePath, page: 4 }],
    });
    state = dispatch(state, {
      type: 'page_finished',
      runId: 2,
      sourcePath: sources[0]!.sourcePath,
      page: 4,
    });
    expect(state.sources[0]!.pages[4]).toBe('succeeded');
    expect(dispatch(state, {
      type: 'page_started',
      runId: 2,
      sourcePath: sources[0]!.sourcePath,
      page: 4,
    })).toBe(state);
  });

  it('accepts zero-hit completion without an analysis plan and fills omitted source counts with zero', () => {
    let state = begin();
    for (const source of sources) {
      state = dispatch(state, {
        type: 'search_finished',
        runId: 1,
        sourcePath: source.sourcePath,
      });
    }
    state = dispatch(state, { type: 'finalizing', runId: 1 });
    expect(state.stage).toBe('finalizing');
    state = dispatch(state, {
      type: 'completed',
      runId: 1,
      counts: { 'D:/one/same.pdf': 3 },
    });

    expect(state.phase).toBe('succeeded');
    expect(state.sources.map((source) => source.segmentCount)).toEqual([3, 0]);
    expect(formatBatchSourceStatus(state, state.sources[1]!)).toContain('未找到符合条件的片段');
    expect(dispatch(state, {
      type: 'failed',
      runId: 1,
      failure: failure({ stage: 'finalizing', sourcePath: null, page: null }, 'too late'),
    })).toBe(state);
  });

  it('rejects completion when search, planned pages, or failure state is incomplete', () => {
    let state = begin(3, [sources[0]!]);
    expect(dispatch(state, { type: 'completed', runId: 3, counts: {} })).toBe(state);
    state = dispatch(state, {
      type: 'search_finished',
      runId: 3,
      sourcePath: sources[0]!.sourcePath,
    });
    state = dispatch(state, {
      type: 'analysis_planned',
      runId: 3,
      pages: [{ sourcePath: sources[0]!.sourcePath, page: 1 }],
    });
    expect(dispatch(state, { type: 'completed', runId: 3, counts: {} })).toBe(state);
    state = dispatch(state, {
      type: 'page_finished',
      runId: 3,
      sourcePath: sources[0]!.sourcePath,
      page: 1,
      failure: failure({ stage: 'analysis', sourcePath: sources[0]!.sourcePath, page: 1 }, 'page failed'),
    });
    expect(dispatch(state, { type: 'finalizing', runId: 3 })).toBe(state);
    const failed = dispatch(state, { type: 'failed', runId: 3 });
    expect(failed.phase).toBe('failed');
    expect(dispatch(failed, { type: 'completed', runId: 3, counts: {} })).toBe(failed);
  });
});

describe('batch failure ordering and formatting', () => {
  it('sorts failures by imported source, page, stage, and puts global failures last', () => {
    let state = begin();
    const inputFailures = [
      failure({ stage: 'finalizing', sourcePath: null, page: null }, 'global'),
      failure({ stage: 'analysis', sourcePath: 'D:/two/same.pdf', page: 1 }, 'two p1 analysis'),
      failure({ stage: 'search', sourcePath: 'D:/one/same.pdf', page: null }, 'one search'),
      failure({ stage: 'analysis', sourcePath: 'D:/one/same.pdf', page: 2 }, 'one p2 analysis'),
      failure({ stage: 'search', sourcePath: 'D:/one/same.pdf', page: null }, 'one search'),
      failure({ stage: 'analysis', sourcePath: 'D:/one/same.pdf', page: 1 }, 'one p1 analysis'),
      failure({ stage: 'analysis', sourcePath: 'D:/one/same.pdf', page: 1 }, 'one p1 analysis'),
    ];
    for (const item of inputFailures) {
      state = dispatch(state, {
        type: 'failed',
        runId: 1,
        failure: item,
      });
      if (state.phase === 'failed') break;
    }

    // A failed event is terminal, so seed the failures through step completions
    // and then add one global failure in a separate run.
    state = begin();
    state = dispatch(state, {
      type: 'search_finished',
      runId: 1,
      sourcePath: 'D:/one/same.pdf',
      failure: inputFailures[2],
    });
    state = dispatch(state, {
      type: 'search_finished',
      runId: 1,
      sourcePath: 'D:/two/same.pdf',
    });
    state = dispatch(state, {
      type: 'analysis_planned',
      runId: 1,
      pages: [
        { sourcePath: 'D:/one/same.pdf', page: 1 },
        { sourcePath: 'D:/one/same.pdf', page: 2 },
        { sourcePath: 'D:/two/same.pdf', page: 1 },
      ],
    });
    // The first source already failed, so page callbacks for it are ignored;
    // use a successful search in another run to exercise page ordering.
    state = begin(2);
    for (const source of sources) {
      state = dispatch(state, {
        type: 'search_finished',
        runId: 2,
        sourcePath: source.sourcePath,
      });
    }
    state = dispatch(state, {
      type: 'analysis_planned',
      runId: 2,
      pages: [
        { sourcePath: 'D:/one/same.pdf', page: 1 },
        { sourcePath: 'D:/one/same.pdf', page: 2 },
        { sourcePath: 'D:/two/same.pdf', page: 1 },
      ],
    });
    for (const item of [inputFailures[3], inputFailures[5], inputFailures[1]]) {
      const sourcePath = item.sourcePath!;
      const page = item.page!;
      state = dispatch(state, {
        type: 'page_finished',
        runId: 2,
        sourcePath,
        page,
        failure: item,
      });
    }
    state = dispatch(state, {
      type: 'failed',
      runId: 2,
      failure: inputFailures[0],
    });

    expect(state.failures.map((item) => item.message)).toEqual([
      'one p1 analysis',
      'one p2 analysis',
      'two p1 analysis',
      'global',
    ]);
  });

  it('uses actual stage totals and distinguishes unprocessed, incomplete, and zero-result files', () => {
    let state = begin(4, [sources[0]!, sources[1]!]);
    state = dispatch(state, {
      type: 'search_finished',
      runId: 4,
      sourcePath: sources[1]!.sourcePath,
    });
    state = dispatch(state, { type: 'failed', runId: 4 });

    expect(formatBatchSourceStatus(state, state.sources[0]!)).toContain('本轮未处理');
    expect(formatBatchSourceStatus(state, state.sources[1]!)).toContain('搜索完成');
    expect(formatBatchSourceStatus(state, state.sources[1]!)).toContain('整批未完成');

    let zero = begin(5, [sources[0]!]);
    zero = dispatch(zero, {
      type: 'search_finished',
      runId: 5,
      sourcePath: sources[0]!.sourcePath,
    });
    zero = dispatch(zero, { type: 'finalizing', runId: 5 });
    zero = dispatch(zero, { type: 'completed', runId: 5, counts: {} });
    expect(formatBatchSourceStatus(zero, zero.sources[0]!)).toContain('未找到符合条件的片段');

    let busy = begin(6, [sources[0]!]);
    busy = dispatch(busy, {
      type: 'search_started',
      runId: 6,
      sourcePath: sources[0]!.sourcePath,
    });
    expect(formatBatchSourceStatus(busy, busy.sources[0]!)).toContain('正在搜索');
    expect(formatBatchSourceStatus(busy, busy.sources[0]!)).not.toContain('OCR 页');
  });

  it('labels a failed finalizing stage as failed instead of still running', () => {
    let state = begin(8, [sources[0]!]);
    state = dispatch(state, {
      type: 'search_finished',
      runId: 8,
      sourcePath: sources[0]!.sourcePath,
    });
    state = dispatch(state, { type: 'finalizing', runId: 8 });
    state = dispatch(state, {
      type: 'failed',
      runId: 8,
      failure: failure({ stage: 'finalizing', sourcePath: null, page: null }, 'commit failed'),
    });

    expect(formatBatchSummary(state)).toContain('整理审核结果失败');
    expect(formatBatchSummary(state)).toContain('整批未完成');
    expect(formatBatchSummary(state)).not.toContain('正在整理审核结果 ·');
  });

  it('uses the explicit global failure stage when failure arrives before the stage event', () => {
    let state = begin(9, [sources[0]!]);
    state = dispatch(state, {
      type: 'search_finished',
      runId: 9,
      sourcePath: sources[0]!.sourcePath,
    });
    state = dispatch(state, {
      type: 'failed',
      runId: 9,
      failure: failure({ stage: 'finalizing', sourcePath: null, page: null }, 'metadata failed'),
    });

    expect(state.stage).toBe('finalizing');
    expect(formatBatchSummary(state)).toContain('整理审核结果失败');
  });
});

describe('createBatchFailure', () => {
  it('maps verified engine codes to a Chinese reason and actionable suggestion', () => {
    const result = createBatchFailure(
      { stage: 'search', sourcePath: 'D:/missing.pdf', page: null },
      Object.assign(new Error('PDF file does not exist'), { engineCode: 'file_not_found' }),
    );

    expect(result).toMatchObject({
      sourcePath: 'D:/missing.pdf',
      page: null,
      stage: 'search',
      code: 'file_not_found',
      detail: 'PDF file does not exist',
    });
    expect(result.message).toContain('文件');
    expect(result.message).toContain('路径');
  });

  it('keeps an unknown error message and raw detail without guessing page or limits', () => {
    const result = createBatchFailure(
      { stage: 'analysis', sourcePath: 'D:/one/same.pdf', page: null },
      new Error('engine said something unusual'),
    );

    expect(result).toEqual({
      sourcePath: 'D:/one/same.pdf',
      page: null,
      stage: 'analysis',
      code: null,
      message: 'engine said something unusual',
      detail: 'engine said something unusual',
    });
    expect(result.message).not.toContain('页');
    expect(result.message).not.toContain('上限');
  });

  it('does not expose arbitrary object bodies, nested cause, response, or non-string codes', () => {
    const result = createBatchFailure(
      { stage: 'finalizing', sourcePath: null, page: null },
      {
        message: 'public object body must stay hidden',
        code: { secret: 'nested code' },
        cause: { response: { body: 'sensitive response' } },
        response: { text: 'sensitive response text' },
      },
    );

    expect(result.code).toBeNull();
    expect(result.message).not.toContain('public object body');
    expect(result.message).not.toContain('sensitive');
    expect(result.detail).not.toContain('public object body');
    expect(result.detail).not.toContain('sensitive');
  });

  it('uses a string error as technical detail and accepts a trusted string code field', () => {
    expect(createBatchFailure(
      { stage: 'analysis', sourcePath: 'D:/one/same.pdf', page: 3 },
      'page is out of range',
    )).toMatchObject({
      code: null,
      message: 'page is out of range',
      detail: 'page is out of range',
      page: 3,
    });

    expect(createBatchFailure(
      { stage: 'analysis', sourcePath: 'D:/one/same.pdf', page: 3 },
      { code: 'page_out_of_range' },
    )).toMatchObject({
      code: 'page_out_of_range',
    });
  });
});

describe('batchFeedbackReducer verification and reused sources', () => {
  it('keeps search failure totals visible when an analysis-stage batch fails', () => {
    const fiveSources = Array.from({ length: 5 }, (_, index) => ({
      name: `source-${index + 1}.pdf`,
      sourcePath: `D:/source-${index + 1}.pdf`,
    }));
    let state = begin(26, fiveSources);

    for (const source of fiveSources.slice(0, 2)) {
      state = dispatch(state, {
        type: 'search_finished',
        runId: 26,
        sourcePath: source.sourcePath,
        failure: failure({ stage: 'search', sourcePath: source.sourcePath, page: null }, '搜索失败'),
      });
    }
    for (const source of fiveSources.slice(2)) {
      state = dispatch(state, {
        type: 'search_finished',
        runId: 26,
        sourcePath: source.sourcePath,
      });
    }

    state = dispatch(state, {
      type: 'analysis_planned',
      runId: 26,
      pages: [],
    });
    state = dispatch(state, { type: 'failed', runId: 26 });

    expect(formatBatchSummary(state)).toBe(
      '文件搜索：已处理 5 / 5 个文件，其中 2 个失败；回单边界分析：已处理 0 / 0 个命中页，其中 0 个失败 · 整批未完成',
    );
  });

  it('keeps 18 reused sources counted while two sources are retried, then verifies all 20', () => {
    const twentySources = Array.from({ length: 20 }, (_, index) => ({
      name: `source-${index + 1}.pdf`,
      sourcePath: `D:/source-${index + 1}.pdf`,
    }));
    let state = begin(20, twentySources);

    for (const source of twentySources.slice(0, 18)) {
      state = dispatch(state, {
        type: 'source_reused',
        runId: 20,
        sourcePath: source.sourcePath,
        pages: [1],
      });
    }

    expect(formatBatchSummary(state)).toContain('搜索：已处理 18 / 20 个文件');
    expect(state.sources.slice(0, 18).every((source) => (
      source.search === 'succeeded'
      && source.pages[1] === 'succeeded'
      && source.reused === true
    ))).toBe(true);

    for (const source of twentySources.slice(18)) {
      state = dispatch(state, {
        type: 'search_started',
        runId: 20,
        sourcePath: source.sourcePath,
      });
      state = dispatch(state, {
        type: 'search_finished',
        runId: 20,
        sourcePath: source.sourcePath,
      });
    }
    expect(formatBatchSummary(state)).toContain('搜索：已处理 20 / 20 个文件');

    state = dispatch(state, {
      type: 'analysis_planned',
      runId: 20,
      pages: twentySources.slice(18).map((source) => ({ sourcePath: source.sourcePath, page: 1 })),
    });
    for (const source of twentySources.slice(18)) {
      state = dispatch(state, {
        type: 'page_finished',
        runId: 20,
        sourcePath: source.sourcePath,
        page: 1,
      });
    }

    state = dispatch(state, { type: 'verifying', runId: 20 });
    expect(state.stage).toBe('verifying');
    expect(state.sources.every((source) => source.verification === 'waiting')).toBe(true);
    for (const source of twentySources) {
      state = dispatch(state, {
        type: 'verification_started',
        runId: 20,
        sourcePath: source.sourcePath,
      });
      state = dispatch(state, {
        type: 'verification_finished',
        runId: 20,
        sourcePath: source.sourcePath,
      });
    }

    expect(formatBatchSummary(state)).toContain('正在核验来源：已处理 20 / 20 个文件');
    state = dispatch(state, { type: 'finalizing', runId: 20 });
    state = dispatch(state, { type: 'completed', runId: 20, counts: {} });
    expect(state.phase).toBe('succeeded');
  });

  it('includes zero-hit sources in the full verification total', () => {
    const twentySources = Array.from({ length: 20 }, (_, index) => ({
      name: `zero-${index + 1}.pdf`,
      sourcePath: `D:/zero-${index + 1}.pdf`,
    }));
    let state = begin(21, twentySources);
    for (const source of twentySources) {
      state = dispatch(state, {
        type: 'search_finished',
        runId: 21,
        sourcePath: source.sourcePath,
      });
    }
    state = dispatch(state, { type: 'analysis_planned', runId: 21, pages: [] });
    state = dispatch(state, { type: 'verifying', runId: 21 });

    expect(formatBatchSummary(state)).toBe('正在核验来源：已处理 0 / 20 个文件');
    expect(state.sources.every((source) => source.pages && Object.keys(source.pages).length === 0)).toBe(true);

    for (const source of twentySources) {
      state = dispatch(state, {
        type: 'verification_finished',
        runId: 21,
        sourcePath: source.sourcePath,
      });
    }
    expect(formatBatchSummary(state)).toBe('正在核验来源：已处理 20 / 20 个文件');
  });

  it('blocks finalizing and completed until every verification succeeds', () => {
    let state = begin(22, [sources[0]!, sources[1]!]);
    for (const source of sources) {
      state = dispatch(state, {
        type: 'search_finished',
        runId: 22,
        sourcePath: source.sourcePath,
      });
    }
    state = dispatch(state, {
      type: 'analysis_planned',
      runId: 22,
      pages: [{ sourcePath: sources[0]!.sourcePath, page: 1 }],
    });
    state = dispatch(state, {
      type: 'page_finished',
      runId: 22,
      sourcePath: sources[0]!.sourcePath,
      page: 1,
    });
    state = dispatch(state, { type: 'verifying', runId: 22 });
    state = dispatch(state, {
      type: 'verification_finished',
      runId: 22,
      sourcePath: sources[0]!.sourcePath,
    });

    expect(dispatch(state, { type: 'finalizing', runId: 22 })).toBe(state);
    expect(dispatch(state, { type: 'completed', runId: 22, counts: {} })).toBe(state);
    expect(state.stage).toBe('verifying');

    state = dispatch(state, {
      type: 'verification_finished',
      runId: 22,
      sourcePath: sources[1]!.sourcePath,
    });
    state = dispatch(state, { type: 'finalizing', runId: 22 });
    expect(state.stage).toBe('finalizing');
    state = dispatch(state, { type: 'completed', runId: 22, counts: {} });
    expect(state.phase).toBe('succeeded');
  });

  it('ignores stale, duplicate, and unknown verification callbacks', () => {
    let state = begin(23, [sources[0]!]);
    state = dispatch(state, {
      type: 'search_finished',
      runId: 23,
      sourcePath: sources[0]!.sourcePath,
    });
    state = dispatch(state, { type: 'analysis_planned', runId: 23, pages: [] });
    state = dispatch(state, { type: 'verifying', runId: 23 });

    expect(dispatch(state, {
      type: 'verification_started',
      runId: 22,
      sourcePath: sources[0]!.sourcePath,
    })).toBe(state);
    expect(dispatch(state, {
      type: 'verification_started',
      runId: 23,
      sourcePath: 'D:/unknown.pdf',
    })).toBe(state);

    state = dispatch(state, {
      type: 'verification_started',
      runId: 23,
      sourcePath: sources[0]!.sourcePath,
    });
    expect(state.sources[0]!.verification).toBe('running');
    state = dispatch(state, {
      type: 'verification_finished',
      runId: 23,
      sourcePath: sources[0]!.sourcePath,
    });
    const finished = state;
    expect(dispatch(state, {
      type: 'verification_finished',
      runId: 23,
      sourcePath: sources[0]!.sourcePath,
    })).toBe(finished);
    expect(dispatch(state, {
      type: 'verification_finished',
      runId: 22,
      sourcePath: sources[0]!.sourcePath,
    })).toBe(finished);
  });

  it('records a verification failure and formats the failed source accurately', () => {
    let state = begin(24, [sources[0]!]);
    state = dispatch(state, {
      type: 'search_finished',
      runId: 24,
      sourcePath: sources[0]!.sourcePath,
    });
    state = dispatch(state, { type: 'analysis_planned', runId: 24, pages: [] });
    state = dispatch(state, { type: 'verifying', runId: 24 });
    const verificationFailure = failure(
      { stage: 'verifying', sourcePath: sources[0]!.sourcePath, page: null },
      'source changed',
    );
    state = dispatch(state, {
      type: 'verification_finished',
      runId: 24,
      sourcePath: sources[0]!.sourcePath,
      failure: verificationFailure,
    });

    expect(state.sources[0]!.verification).toBe('failed');
    expect(state.failures).toEqual([verificationFailure]);
    expect(dispatch(state, { type: 'finalizing', runId: 24 })).toBe(state);
    expect(dispatch(state, { type: 'completed', runId: 24, counts: {} })).toBe(state);

    state = dispatch(state, { type: 'failed', runId: 24, failure: verificationFailure });
    expect(formatBatchSummary(state)).toContain('正在核验来源：已处理 1 / 1 个文件');
    expect(formatBatchSummary(state)).toContain('整批未完成');
    expect(formatBatchSourceStatus(state, state.sources[0]!)).toContain('核验失败');
    expect(formatBatchSourceStatus(state, state.sources[0]!)).toContain('整批未完成');
  });

  it('does not reuse a failed source and accepts a zero-hit reused source', () => {
    let state = begin(25, [sources[0]!, sources[1]!]);
    state = dispatch(state, {
      type: 'search_finished',
      runId: 25,
      sourcePath: sources[0]!.sourcePath,
      failure: failure({ stage: 'search', sourcePath: sources[0]!.sourcePath, page: null }, 'search failed'),
    });
    const failedSource = state;
    expect(dispatch(state, {
      type: 'source_reused',
      runId: 25,
      sourcePath: sources[0]!.sourcePath,
      pages: [1],
    })).toBe(failedSource);

    state = dispatch(state, {
      type: 'source_reused',
      runId: 25,
      sourcePath: sources[1]!.sourcePath,
      pages: [],
    });
    expect(state.sources[1]!.search).toBe('succeeded');
    expect(state.sources[1]!.pages).toEqual({});
    expect(state.sources[1]!.reused).toBe(true);
    expect(formatBatchSourceStatus(state, state.sources[1]!)).toContain('已复用上次完整计算');
    expect(formatBatchSummary(state)).toContain('2 / 2');
  });
});
