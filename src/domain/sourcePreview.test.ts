import { describe, expect, it } from 'vitest';

import {
  appendUniqueSources,
  analysisButtonLabel,
  analysisStateReducer,
  buildSourceDocuments,
  choosePreferredSegment,
  normalizeSourcePath,
  parsePageDraft,
  removeSourceIdentities,
  sourceDocumentKey,
  type AnalysisState,
  type NavigableSegment,
  type SearchSource,
  type SourceSearchResponse,
} from './sourcePreview';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const sources: SearchSource[] = [
  { name: 'a.pdf', sourcePath: 'D:\\input\\a.pdf' },
  { name: 'b.pdf', sourcePath: 'D:\\input\\b.pdf' },
];

const responses: SourceSearchResponse[] = [
  {
    sourcePath: 'D:\\input\\a.pdf',
    result: {
      page_count: 3,
      source_sha256: SHA_A,
      matches: [{ source_path: 'D:\\input\\a.pdf', source_sha256: SHA_A }],
    },
  },
  {
    sourcePath: 'D:\\input\\b.pdf',
    result: {
      page_count: 7,
      source_sha256: SHA_B,
      matches: [],
    },
  },
];

describe('buildSourceDocuments', () => {
  it('builds metadata for hit and zero-hit source documents atomically', () => {
    expect(buildSourceDocuments(sources, responses)).toEqual([
      {
        key: sourceDocumentKey('D:\\input\\a.pdf', SHA_A),
        name: 'a.pdf',
        sourcePath: 'D:\\input\\a.pdf',
        sourceSha256: SHA_A,
        pageCount: 3,
        integrityStatus: 'valid',
      },
      {
        key: sourceDocumentKey('D:\\input\\b.pdf', SHA_B),
        name: 'b.pdf',
        sourcePath: 'D:\\input\\b.pdf',
        sourceSha256: SHA_B,
        pageCount: 7,
        integrityStatus: 'valid',
      },
    ]);
  });

  it('rejects the whole metadata batch when response count differs', () => {
    expect(() => buildSourceDocuments(sources, responses.slice(0, 1))).toThrow(
      '来源数量与搜索响应数量不一致。',
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects non-positive or fractional page counts',
    (pageCount) => {
      const invalidResponses = responses.map((response, index) => (
        index === 0
          ? { ...response, result: { ...response.result, page_count: pageCount } }
          : response
      ));

      expect(() => buildSourceDocuments(sources, invalidResponses)).toThrow(
        '搜索响应的 PDF 页数无效。',
      );
    },
  );

  it('rejects unsafe page counts', () => {
    const invalidResponses = responses.map((response, index) => (
      index === 0
        ? {
            ...response,
            result: {
              ...response.result,
              page_count: Number.MAX_SAFE_INTEGER + 1,
            },
          }
        : response
    ));

    expect(() => buildSourceDocuments(sources, invalidResponses)).toThrow(
      '搜索响应的 PDF 页数无效。',
    );
  });

  it.each(['', 'not-a-sha256', 'a'.repeat(63), 'g'.repeat(64)])(
    'rejects malformed source SHA-256',
    (sourceSha256) => {
      const invalidResponses = responses.map((response, index) => (
        index === 0
          ? { ...response, result: { ...response.result, source_sha256: sourceSha256 } }
          : response
      ));

      expect(() => buildSourceDocuments(sources, invalidResponses)).toThrow(
        '搜索响应的源 PDF SHA-256 无效。',
      );
    },
  );

  it('rejects a response paired with another source path', () => {
    const invalidResponses = [
      { ...responses[0], sourcePath: 'D:\\input\\b.pdf' },
      responses[1],
    ];

    expect(() => buildSourceDocuments(sources, invalidResponses)).toThrow(
      '搜索响应与请求来源不一致。',
    );
  });

  it.each([
    {
      matches: [{ source_path: 'D:\\input\\other.pdf', source_sha256: SHA_A }],
    },
    {
      matches: [{ source_path: 'D:\\input\\a.pdf', source_sha256: SHA_B }],
    },
  ])('rejects match path or hash that disagrees with its parent response', ({ matches }) => {
    const invalidResponses = [
      { ...responses[0], result: { ...responses[0].result, matches } },
      responses[1],
    ];

    expect(() => buildSourceDocuments(sources, invalidResponses)).toThrow(
      '命中结果与所属来源元数据不一致。',
    );
  });

  it.each([
    { matches: [{ source_path: 123 }] },
    { matches: [{ source_sha256: null }] },
    { matches: [null] },
    { matches: [42] },
    { matches: [[]] },
  ])('rejects malformed match entries as a business validation error', ({ matches }) => {
    const invalidResponses = [
      {
        ...responses[0],
        result: { ...responses[0].result, matches },
      },
      responses[1],
    ] as unknown as SourceSearchResponse[];

    expect(() => buildSourceDocuments(sources, invalidResponses)).toThrow(
      '命中结果与所属来源元数据不一致。',
    );
  });

  it('rejects an invalid later source response as a whole batch', () => {
    const invalidResponses = [
      responses[0],
      {
        ...responses[1],
        result: { ...responses[1].result, page_count: 2.5 },
      },
    ];

    expect(() => buildSourceDocuments(sources, invalidResponses)).toThrow(
      '搜索响应的 PDF 页数无效。',
    );
  });

  it('rejects duplicate source paths using normalized comparison', () => {
    const duplicateSources = [
      sources[0],
      { ...sources[1], sourcePath: 'd:/INPUT/A.PDF' },
    ];

    expect(() => buildSourceDocuments(duplicateSources, responses)).toThrow(
      '来源路径重复，无法建立文档元数据。',
    );
  });

  it('normalizes source paths lexically and derives stable document keys', () => {
    expect(normalizeSourcePath('  D:\\输入\\A.PDF  ')).toBe('d:/输入/a.pdf');
    expect(sourceDocumentKey('D:\\input\\A.pdf', SHA_A.toUpperCase())).toBe(
      `d:/input/a.pdf\u0000${SHA_A}`,
    );
  });
});

describe('source list helpers', () => {
  const sourceA: SearchSource = { name: 'a.pdf', sourcePath: 'D:\\input\\a.pdf' };
  const sourceB: SearchSource = { name: 'b.pdf', sourcePath: 'D:\\input\\b.pdf' };
  const sourceC: SearchSource = { name: 'c.pdf', sourcePath: 'D:\\input\\c.pdf' };

  it('deduplicates appended sources by normalized path while preserving first occurrence', () => {
    expect(appendUniqueSources(
      [sourceA],
      [
        { ...sourceA, name: 'copy.pdf', sourcePath: 'd:/INPUT/A.PDF' },
        sourceB,
        { ...sourceB, name: 'second-copy.pdf', sourcePath: 'D:\\input\\b.pdf' },
      ],
    )).toEqual([sourceA, sourceB]);
  });

  it('removes normalized identities and falls back to the first remaining source', () => {
    expect(removeSourceIdentities(
      [sourceA, sourceB, sourceC],
      new Set(['d:/INPUT/B.PDF']),
    )).toEqual({
      files: [sourceA, sourceC],
      nextActivePath: sourceA.sourcePath,
    });
  });

  it('returns no active path after removing every source', () => {
    expect(removeSourceIdentities([sourceA], new Set([sourceA.sourcePath]))).toEqual({
      files: [],
      nextActivePath: null,
    });
  });
});

function segment(overrides: Partial<NavigableSegment> = {}): NavigableSegment {
  return {
    id: 'segment-1',
    sourcePath: 'D:\\input\\a.pdf',
    sourcePage: 3,
    reviewStatus: 'confirmed',
    ...overrides,
  };
}

describe('choosePreferredSegment', () => {
  it('chooses the first unresolved segment on a physical page', () => {
    const segments = [
      segment({ id: 'confirmed-1' }),
      segment({ id: 'needs-review', reviewStatus: 'needs_review' }),
      segment({ id: 'pending', reviewStatus: 'pending' }),
    ];

    expect(choosePreferredSegment(segments, 'd:/INPUT/a.pdf', 3)).toBe('needs-review');
  });

  it('keeps the current segment when a physical page has no hit', () => {
    expect(choosePreferredSegment([segment({ id: 'current' })], 'D:\\input\\a.pdf', 4)).toBeNull();
  });

  it('falls back to the first segment when all page hits are confirmed', () => {
    expect(choosePreferredSegment([
      segment({ id: 'first' }),
      segment({ id: 'second' }),
    ], 'D:\\input\\a.pdf', 3)).toBe('first');
  });
});

describe('parsePageDraft', () => {
  it('accepts only an integer page inside the document range', () => {
    expect(parsePageDraft(' 3 ', 7)).toEqual({ ok: true, page: 3 });
    expect(parsePageDraft('0', 7)).toEqual({ ok: false, message: '请输入 1–7 的页码' });
    expect(parsePageDraft('8', 7)).toEqual({ ok: false, message: '请输入 1–7 的页码' });
    expect(parsePageDraft('1.5', 7)).toEqual({ ok: false, message: '请输入 1–7 的页码' });
    expect(parsePageDraft('3e2', 7)).toEqual({ ok: false, message: '请输入 1–7 的页码' });
    expect(parsePageDraft('', 7)).toEqual({ ok: false, message: '请输入 1–7 的页码' });
  });

  it('rejects unsafe page numbers and page counts', () => {
    const unsafePage = String(Number.MAX_SAFE_INTEGER + 1);
    expect(parsePageDraft(unsafePage, Number.MAX_SAFE_INTEGER + 1)).toEqual({
      ok: false,
      message: '请输入 1–9007199254740992 的页码',
    });
    expect(parsePageDraft('1', Number.MAX_SAFE_INTEGER + 1)).toEqual({
      ok: false,
      message: '请输入 1–9007199254740992 的页码',
    });
  });
});

describe('analysisStateReducer', () => {
  it('transitions through idle running completed and dirty', () => {
    const idle: AnalysisState = { phase: 'idle' };
    const running = analysisStateReducer(idle, { type: 'run_started' });
    expect(running).toEqual({ phase: 'running', step: 'search', failurePhase: 'idle' });
    expect(analysisStateReducer(running, { type: 'page_analysis_started' })).toEqual({
      phase: 'running',
      step: 'pages',
      failurePhase: 'idle',
    });

    const completed = analysisStateReducer(running, { type: 'run_succeeded' });
    expect(completed).toEqual({ phase: 'completed' });
    expect(analysisStateReducer(completed, { type: 'criteria_changed' })).toEqual({ phase: 'dirty' });
    expect(analysisStateReducer({ phase: 'dirty' }, { type: 'sources_replaced' })).toEqual({ phase: 'idle' });
    expect(analysisButtonLabel({ phase: 'idle' })).toBe('开始分析');
    expect(analysisButtonLabel({ phase: 'running', step: 'search', failurePhase: 'idle' })).toBe('分析中…');
    expect(analysisButtonLabel({ phase: 'completed' })).toBe('重新分析');
  });

  it('restores idle after a first-run failure and dirty after a rerun failure', () => {
    const firstRun = analysisStateReducer(
      analysisStateReducer({ phase: 'idle' }, { type: 'run_started' }),
      { type: 'run_failed', error: 'first failure' },
    );
    expect(firstRun).toEqual({ phase: 'idle', error: 'first failure' });

    const rerun = analysisStateReducer(
      analysisStateReducer({ phase: 'completed' }, { type: 'run_started' }),
      { type: 'run_failed', error: 'rerun failure' },
    );
    expect(rerun).toEqual({ phase: 'dirty', error: 'rerun failure' });
  });

  it('restores the completed phase after abandoning a failed rerun', () => {
    const failedRerun = analysisStateReducer(
      analysisStateReducer({ phase: 'completed' }, { type: 'run_started' }),
      { type: 'run_failed', error: 'rerun failure' },
    );

    expect(failedRerun).toEqual({ phase: 'dirty', error: 'rerun failure' });
    expect(analysisStateReducer(failedRerun, { type: 'previous_results_restored' }))
      .toEqual({ phase: 'completed' });
    expect(analysisStateReducer({ phase: 'idle' }, { type: 'previous_results_restored' }))
      .toEqual({ phase: 'idle' });
  });

  it('keeps dirty state for a rerun that is started twice before failing', () => {
    const rerun = analysisStateReducer({ phase: 'completed' }, { type: 'run_started' });
    const restarted = analysisStateReducer(rerun, { type: 'run_started' });
    expect(restarted).toEqual({ phase: 'running', step: 'search', failurePhase: 'dirty' });
    expect(analysisStateReducer(restarted, { type: 'run_failed', error: 'rerun failure' })).toEqual({
      phase: 'dirty',
      error: 'rerun failure',
    });
  });

  it('ignores delayed success after criteria changed or sources were replaced', () => {
    const dirty = analysisStateReducer({ phase: 'completed' }, { type: 'criteria_changed' });
    expect(dirty).toEqual({ phase: 'dirty' });
    expect(analysisStateReducer(dirty, { type: 'run_succeeded' })).toBe(dirty);

    const idle = analysisStateReducer(dirty, { type: 'sources_replaced' });
    expect(idle).toEqual({ phase: 'idle' });
    expect(analysisStateReducer(idle, { type: 'run_succeeded' })).toBe(idle);
  });

  it('ignores page and failure events outside a running analysis', () => {
    const completed: AnalysisState = { phase: 'completed' };
    expect(analysisStateReducer(completed, { type: 'page_analysis_started' })).toBe(completed);
    expect(analysisStateReducer(completed, { type: 'run_failed', error: 'ignored' })).toBe(completed);
  });
});
