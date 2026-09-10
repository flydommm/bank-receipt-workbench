// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// @ts-expect-error The test runtime exposes Node crypto without @types/node.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App, { buildExportPayloadForReviewSegments, buildReviewMatchPairs, previewValidationError, reviewTaskIdFor } from './App';
import {
  LocalEngineError,
  localEngineAdapter,
  type EngineOriginalReview,
  type EnginePreparedReview,
  type EngineReviewContext,
  type EngineReviewSegment,
  type EngineReviewSegmentV2,
  type EngineSavedReviewV2,
  type OcrCacheClearResult,
  type OcrCacheInfo,
} from './components/localEngineAdapter';
import type { ReviewSegment } from './domain/cropReview';
import type { SearchCriteria } from './domain/searchCriteria';
import { APP_SETTINGS_STORAGE_KEY, DEFAULT_APP_SETTINGS } from './domain/appSettings';
import { SEARCH_CONDITION_HISTORY_STORAGE_KEY } from './domain/searchConditionHistory';

const KEYWORD_HISTORY_STORAGE_KEY = 'pdf-search.keyword-history.v1';

const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;
const IMAGE = 'data:image/png;base64,AA==';
const SOURCE_SHA256 = 'a'.repeat(64);
const CHANGED_SOURCE_SHA256 = 'b'.repeat(64);
const SECOND_SOURCE_SHA256 = 'c'.repeat(64);
const THIRD_SOURCE_SHA256 = 'd'.repeat(64);

function installLocalStorageShim(): void {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
}

function match(page: number, x0 = 40, y0 = 80) {
  return {
    page,
    matched_text: '手续费',
    matched_field: '摘要',
    confidence: 0.96,
    needs_review: false,
    x0,
    y0,
    x1: x0 + 80,
    y1: y0 + 24,
  };
}

function preview(path: string, page: number, imageData = `data:image/png;base64,PAGE${page}`) {
  return {
    status: 'ok' as const,
    page,
    page_count: 20,
    page_width: PAGE_WIDTH,
    page_height: PAGE_HEIGHT,
    image_data: imageData,
    path,
  };
}

function pickerResult(files: string[], directory: string | null = null) {
  return { files, directory };
}

type MockSearchMetadata = {
  page_count: number;
  source_sha256: string;
};

async function latestSuccessfulMockSearchMetadata(path: string): Promise<MockSearchMetadata | null> {
  // The picker inspects a document before the first search.  Once a search has
  // completed, use its authoritative metadata for the runner's final inspect
  // pass so existing tests can continue to choose their own page counts/SHA.
  // `mock.results` is checked for a settled return value: an in-flight or
  // rejected search cannot be used to prove source integrity.
  for (const mock of [vi.mocked(localEngineAdapter.searchMulti), vi.mocked(localEngineAdapter.search)]) {
    for (let index = mock.mock.calls.length - 1; index >= 0; index -= 1) {
      if (mock.mock.calls[index]?.[0] !== path) continue;
      const result = mock.mock.results[index] as { type?: string; value?: unknown } | undefined;
      if (!result || result.type !== 'return') continue;
      try {
        const value = await result.value as {
          status?: unknown;
          page_count?: unknown;
          source_sha256?: unknown;
        };
        if (
          value?.status === 'ok'
          && Number.isInteger(value.page_count)
          && Number(value.page_count) > 0
          && typeof value.source_sha256 === 'string'
          && value.source_sha256.trim().length > 0
        ) {
          return {
            page_count: Number(value.page_count),
            source_sha256: value.source_sha256,
          };
        }
      } catch {
        // Failed search calls are intentionally ignored by the metadata helper.
      }
    }
  }
  return null;
}

function sourceChangedError(message = '源文件已变化，请重新分析') {
  return new LocalEngineError('ENGINE_REQUEST_REJECTED', message, { engineCode: 'source_changed' });
}

function analysis(page: number, matches: Array<{ x0: number; y0: number; x1: number; y1: number }>, y0: number) {
  return {
    status: 'ok' as const,
    page,
    page_width: PAGE_WIDTH,
    page_height: PAGE_HEIGHT,
    selections: matches.map((item) => ({
      match_rect: item,
      rect: { x0: 0, y0, x1: PAGE_WIDTH, y1: y0 + 220 },
      confidence: 0.96,
      slot: 'receipt',
      evidence: ['geometry'],
      needs_review: false,
  })),
  };
}

function multiMatch(
  page: number,
  queryId: string,
  role: 'include' | 'exclude',
  matchedText: string,
  x0: number,
  y0: number,
) {
  return {
    page,
    matched_text: matchedText,
    matched_field: '摘要',
    confidence: 0.96,
    needs_review: false,
    x0,
    y0,
    x1: x0 + 80,
    y1: y0 + 24,
    query_id: queryId,
    role,
  };
}

function multiSelection(
  matchRect: { x0: number; y0: number; x1: number; y1: number },
  candidateIndex: number,
  y0: number,
) {
  return {
    match_rect: matchRect,
    // Compound runs must use candidate_rect instead of the legacy `rect`.
    // Keep these deliberately different so the orchestration test catches
    // accidental full-page/legacy selection reuse.
    rect: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: PAGE_HEIGHT },
    candidate_index: candidateIndex,
    candidate_rect: { x0: 0, y0, x1: PAGE_WIDTH, y1: y0 + 220 },
    confidence: 0.96,
    slot: 'receipt',
    evidence: ['geometry'],
    needs_review: false,
  };
}

async function reviewContextKey(context: EngineReviewContext): Promise<string> {
  const canonical = JSON.stringify({
    computation_version: context.computation_version,
    criteria_fingerprint: context.criteria_fingerprint,
    sources: context.sources.map(({ source_key, source_sha256 }) => ({ source_key, source_sha256 })),
    version: 2,
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function preparedReview(
  contextKey: string,
  resultRevision: string,
  originals: EngineOriginalReview[],
  segments: EngineReviewSegmentV2[] = [],
  groupConfirmed = false,
): EnginePreparedReview {
  const recordRevisionByKey = new Map(
    segments.map((record) => [
      `${record.source_key}\u0000${record.source_page}\u0000${record.segment_no}`,
      record.record_revision,
    ]),
  );
  return {
    status: 'ok',
    context_key: contextKey,
    result_revision: resultRevision,
    segments,
    record_revisions: originals.map((original) => ({
      id: original.id,
      source_key: original.source_key,
      source_page: original.source_page,
      segment_no: original.segment_no,
      record_revision: recordRevisionByKey.get(`${original.source_key}\u0000${original.source_page}\u0000${original.segment_no}`) ?? 0,
    })),
    group_confirmed: groupConfirmed,
  };
}

function reviewRecordFromOriginal(
  context: EngineReviewContext,
  original: EngineOriginalReview,
  contextKey: string,
  resultRevision: string,
  reviewStatus: EngineReviewSegmentV2['review_status'] = 'group_confirmed',
): EngineReviewSegmentV2 {
  const source = context.sources.find((item) => item.source_key === original.source_key);
  if (!source || !original.match_rect) throw new Error(`missing source or match rect ${original.source_key}`);
  return {
    id: original.id,
    task_id: 'v2-task',
    source_path: source.source_path,
    source_sha256: source.source_sha256,
    source_page: original.source_page,
    segment_no: original.segment_no,
    match_rect: original.match_rect,
    candidate_rect: original.candidate_rect,
    final_rect: original.auto_full_page ? null : original.candidate_rect,
    layout_fingerprint: original.layout_fingerprint,
    confidence: original.confidence,
    crop_mode: original.auto_full_page ? 'full_page' : 'candidate',
    review_status: reviewStatus,
    manual_adjusted: false,
    reviewed_at: '2026-09-08T00:00:00.000Z',
    context_key: contextKey,
    source_key: original.source_key,
    analysis_signature: original.analysis_signature,
    result_revision: resultRevision,
    record_revision: 1,
    page_width: original.page_width,
    page_height: original.page_height,
  };
}

function acknowledgeReviewSave(
  contextKey: string,
  resultRevision: string,
  segments: EngineReviewSegmentV2[],
): EngineSavedReviewV2 {
  return {
    status: 'ok',
    context_key: contextKey,
    result_revision: resultRevision,
    saved_count: segments.length,
    segments: structuredClone(segments).map((segment) => ({
      ...segment,
      record_revision: segment.record_revision + 1,
    })),
  };
}

async function startAnalysis(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: '开始分析' }));
}

async function choosePdf(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getAllByRole('button', { name: '选择 PDF' })[0]!);
}

async function addPdf(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getAllByRole('button', { name: '添加 PDF' })[0]!);
}

async function runCriteriaSearch(
  criteria: SearchCriteria,
): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await choosePdf(user);

  const includeValues = criteria.include.length > 0 ? criteria.include : [''];
  const firstInclude = screen.getByRole('textbox', { name: '包含关键词 1' });
  await user.clear(firstInclude);
  await user.type(firstInclude, includeValues[0] ?? '');
  for (let index = 1; index < includeValues.length; index += 1) {
    await user.click(screen.getByRole('button', { name: '添加包含关键词' }));
    const input = screen.getByRole('textbox', { name: `包含关键词 ${index + 1}` });
    await user.type(input, includeValues[index] ?? '');
  }
  await user.click(screen.getByRole('radio', {
    name: criteria.includeMode === 'any' ? '任一满足' : '全部满足',
  }));

  for (const keyword of criteria.exclude) {
    await user.click(screen.getByRole('button', { name: '添加排除关键词' }));
    const index = screen.getAllByRole('textbox', { name: /排除关键词/ }).length;
    await user.type(screen.getByRole('textbox', { name: `排除关键词 ${index}` }), keyword);
  }

  await user.click(screen.getByRole('button', { name: '开始分析' }));
  const searchPanel = screen.getByRole('region', { name: '搜索条件' });
  await waitFor(() => {
    expect(within(searchPanel).queryByRole('textbox', { name: '包含关键词 1' })).toBeNull();
  });
  expect(within(searchPanel).getByRole('button', { name: '修改搜索条件' })).toBeTruthy();
  return user;
}

async function loadResults(user: ReturnType<typeof userEvent.setup>) {
  await choosePdf(user);
  await startAnalysis(user);
  expect(await waitFor(() => reviewRow(/第 4 页 \/ 片段 1/))).toBeTruthy();
}

async function openSearchEditor(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.queryByRole('textbox', { name: '包含关键词 1' });
  if (input) return input as HTMLInputElement;
  const searchPanel = screen.getByRole('region', { name: '搜索条件' });
  await user.click(within(searchPanel).getByRole('button', { name: '修改搜索条件' }));
  return within(searchPanel).getByRole('textbox', { name: '包含关键词 1' }) as HTMLInputElement;
}

async function validatePreviewForPage(user: ReturnType<typeof userEvent.setup>, page: number) {
  await user.click(screen.getByRole('button', { name: new RegExp(`第 ${page} 页 \/ 片段 1`) }));
  await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
}

async function optIntoXlsxExport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('checkbox', { name: '同时导出审核索引 XLSX（可选）' }));
}

function reviewRow(name: RegExp | string): HTMLElement {
  return within(screen.getByRole('region', { name: '审核导航' })).getByRole('button', { name });
}

function expectReviewPhaseActions(): void {
  expect(screen.getByRole('button', { name: '保留整页' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '确认当前片段' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '确认整组' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();
}

function confirmedPreviewAction(): HTMLButtonElement {
  expect(screen.queryByRole('button', { name: '保留整页' })).toBeNull();
  expect(screen.queryByRole('button', { name: '确认当前片段' })).toBeNull();
  expect(screen.queryByRole('button', { name: /确认整组/ })).toBeNull();
  return screen.getByRole('button', { name: /生成 PDF 导出预览/ }) as HTMLButtonElement;
}

const VIEW_SOURCE_A = '/docs/account-a/receipt.pdf';
const VIEW_SOURCE_B = '/docs/account-b/receipt.pdf';
const VIEW_SOURCE_EMPTY = '/docs/empty.pdf';

function configureResultViewSources(secondConfidence = 0.92): void {
  vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult([
    VIEW_SOURCE_A, VIEW_SOURCE_B, VIEW_SOURCE_EMPTY,
  ]));
  const shaFor = (path: string) => path === VIEW_SOURCE_A
    ? SOURCE_SHA256 : path === VIEW_SOURCE_B ? SECOND_SOURCE_SHA256 : THIRD_SOURCE_SHA256;
  vi.mocked(localEngineAdapter.inspectPdf).mockImplementation(async (path) => ({
    status: 'ok', page_count: 20, source_sha256: shaFor(path),
  }));
  vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => ({
    status: 'ok', page_count: 20, source_sha256: shaFor(path),
    matches: path === VIEW_SOURCE_EMPTY ? [] : [match(path === VIEW_SOURCE_A ? 4 : 12)],
  }));
  vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, matches) => {
    const result = analysis(page, matches, page === 4 ? 0 : 280);
    return { ...result, selections: result.selections.map(item => ({
      ...item, confidence: path === VIEW_SOURCE_A ? 0.98 : secondConfidence,
    })) };
  });
}

describe('App orchestration', () => {
  beforeEach(() => {
    installLocalStorageShim();
    vi.stubGlobal('crypto', webcrypto);
    window.localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
    window.localStorage.removeItem(SEARCH_CONDITION_HISTORY_STORAGE_KEY);
    vi.spyOn(localEngineAdapter, 'health').mockResolvedValue({
      status: 'ok',
      engine: 'test-engine',
      version: 'test',
    });
    vi.spyOn(localEngineAdapter, 'ocrHealth').mockResolvedValue({
      status: 'ok',
      available: true,
      engine: 'paddleocr',
      message: 'ok',
      readiness: 'installed',
    });
    vi.spyOn(localEngineAdapter, 'ocrCacheInfo').mockResolvedValue({
      status: 'ok',
      available: true,
      entries: 0,
      bytes: 0,
      max_bytes: 268_435_456,
      retention_days: 30,
    } satisfies OcrCacheInfo);
    vi.spyOn(localEngineAdapter, 'ocrCacheClear').mockResolvedValue({
      status: 'ok',
      available: true,
      entries: 0,
      bytes: 0,
      max_bytes: 268_435_456,
      retention_days: 30,
      removed_entries: 0,
      failed_entries: 0,
    } satisfies OcrCacheClearResult);
    vi.spyOn(localEngineAdapter, 'pickPdfFiles').mockResolvedValue(pickerResult(['/docs/source.pdf']));
    vi.spyOn(localEngineAdapter, 'pickPdfFolder').mockResolvedValue(pickerResult([]));
    vi.spyOn(localEngineAdapter, 'inspectPdf').mockImplementation(async (path) => {
      const metadata = await latestSuccessfulMockSearchMetadata(path);
      return {
        status: 'ok',
        ...(metadata ?? { page_count: 20, source_sha256: SOURCE_SHA256 }),
      };
    });
    vi.spyOn(localEngineAdapter, 'pickDirectory').mockResolvedValue(null);
    vi.spyOn(localEngineAdapter, 'validateDirectory').mockResolvedValue(true);
    vi.spyOn(localEngineAdapter, 'search').mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4), match(12)],
    });
    vi.spyOn(localEngineAdapter, 'searchMulti').mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [],
    });
    vi.spyOn(localEngineAdapter, 'renderPage').mockImplementation(async (path, page) => ({
      ...preview(path, page),
      page_count: path.startsWith('/cache/') ? 2 : 20,
    }));
    vi.spyOn(localEngineAdapter, 'analyzePage').mockImplementation(async (path, page, matches) => analysis(page, matches, page === 4 ? 0 : 280));
    vi.spyOn(localEngineAdapter, 'computationInfo').mockResolvedValue({
      status: 'ok',
      computation_version: 'm2-test',
    });
    vi.spyOn(localEngineAdapter, 'prepareReviewContext').mockImplementation(async (context, originals, resultRevision) => {
      const contextKey = await reviewContextKey(context);
      return preparedReview(contextKey, resultRevision, originals);
    });
    vi.spyOn(localEngineAdapter, 'loadReviewSegments').mockImplementation(async (taskId) => ({
      status: 'ok',
      task_id: taskId,
      segments: [],
    }));
    vi.spyOn(localEngineAdapter, 'saveReviewSegmentsV2').mockImplementation(async (contextKey, resultRevision, segments) => (
      acknowledgeReviewSave(contextKey, resultRevision, segments)
    ));
    vi.spyOn(localEngineAdapter, 'exportIndex').mockImplementation(async (outputPath, rows) => ({
      status: 'ok',
      output_path: outputPath,
      row_count: rows.length,
    }));
    vi.spyOn(localEngineAdapter, 'exportPdf').mockImplementation(async (outputPath) => ({
      status: 'ok',
      output_path: outputPath,
      page_count: 2,
      sha256: 'b'.repeat(64),
    }));
    vi.spyOn(localEngineAdapter, 'createExportPreviewPath').mockResolvedValue('/cache/preview-token.pdf');
    vi.spyOn(localEngineAdapter, 'pickOutputFolder').mockResolvedValue('/chosen');
    vi.spyOn(localEngineAdapter, 'publishPreviewPdf').mockImplementation(async (_previewPath, outputPath) => ({
      status: 'ok',
      output_path: outputPath,
      sha256: 'b'.repeat(64),
    }));
    vi.spyOn(localEngineAdapter, 'cleanupExports').mockResolvedValue({ status: 'ok', cleaned_count: 1 });
    vi.spyOn(localEngineAdapter, 'releaseExports').mockResolvedValue({ status: 'ok', released_count: 1 });
    vi.spyOn(localEngineAdapter, 'openOutputFolder').mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
    window.localStorage.removeItem(SEARCH_CONDITION_HISTORY_STORAGE_KEY);
    window.localStorage.removeItem(KEYWORD_HISTORY_STORAGE_KEY);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('M4 saves two manual decisions and undoes both with fresh source checks and consecutive CAS revisions', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 4);
    await user.click(screen.getByRole('button', { name: '保留整页' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '确认当前片段' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '确认当前片段' }));
    await waitFor(() => expect((screen.getByRole('button', { name: /撤销上一步/ }) as HTMLButtonElement).disabled).toBe(false));
    const inspections = vi.mocked(localEngineAdapter.inspectPdf).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /撤销上一步/ }));
    await waitFor(() => expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length).toBe(3));
    await waitFor(() => expect((screen.getByRole('button', { name: /撤销上一步/ }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: /撤销上一步/ }));
    await waitFor(() => expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length).toBe(4));
    await waitFor(() => expect((screen.getByRole('button', { name: /撤销上一步/ }) as HTMLButtonElement).disabled).toBe(true));
    const records = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.map((call) => call[2][0]!);
    expect(records.map((record) => record.record_revision)).toEqual([0, 1, 2, 3]);
    expect(records[2]).toMatchObject({ crop_mode: 'full_page', review_status: 'needs_review' });
    expect(records[3]).toMatchObject({ crop_mode: 'candidate', manual_adjusted: false });
    expect(records[3]!.final_rect).toEqual(records[3]!.candidate_rect);
    expect(localEngineAdapter.inspectPdf).toHaveBeenCalledTimes(inspections + 2);
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();
  });

  it('M4 restores the immutable automatic candidate without running another search', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 4);
    await user.click(screen.getByRole('button', { name: '保留整页' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '恢复自动候选' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '恢复自动候选' }));
    await waitFor(() => expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length).toBe(2));
    const restored = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls[1]![2][0]!;
    expect(restored).toMatchObject({ crop_mode: 'candidate', review_status: 'needs_review', manual_adjusted: false });
    expect(restored.final_rect).toEqual(restored.candidate_rect);
    expect(localEngineAdapter.search).toHaveBeenCalledTimes(1);
  });

  it('M4 retains a failed edit and retries its original CAS before adding undo history', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 4);
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockRejectedValueOnce(new Error('模拟磁盘失败'));
    await user.click(screen.getByRole('button', { name: '保留整页' }));
    const retry = await screen.findByRole('button', { name: '重试保存' });
    expect((screen.getByRole('button', { name: /撤销上一步/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试保存' })).toBeNull());
    expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.map((call) => call[2][0]!.record_revision)).toEqual([0, 0]);
    expect((screen.getByRole('button', { name: /撤销上一步/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('M4 discards only through a readonly reload and does not guess that a failed write succeeded', async () => {
    const user = userEvent.setup();
    const read = vi.spyOn(localEngineAdapter, 'readReviewSnapshot').mockImplementation(async (context, originals, revision) =>
      preparedReview(await reviewContextKey(context), revision, originals));
    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 4);
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockRejectedValueOnce(new Error('模拟保存失败'));
    await user.click(screen.getByRole('button', { name: '保留整页' }));
    await user.click(await screen.findByRole('button', { name: '放弃未保存修改' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '放弃未保存修改' })).toBeNull());
    expect(read).toHaveBeenCalledTimes(1);
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(1);
    expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: /撤销上一步/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('裁剪区域')).toBeTruthy();
  });

  it('M4 undoes group confirmation as one atomic batch without reviving export readiness', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 4);
    await validatePreviewForPage(user, 12);
    await waitFor(() => expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '确认整组' }));
    await screen.findByRole('button', { name: /生成 PDF 导出预览/ });
    await user.click(screen.getByRole('button', { name: /撤销上一步/ }));
    await screen.findByRole('button', { name: '确认整组' });
    const calls = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![2]).toHaveLength(2);
    expect(calls[0]![3]).toBe(true);
    expect(calls[1]![2].map((record) => record.record_revision)).toEqual([1, 1]);
    expect(calls[1]![3]).toBe(false);
    expect(calls[1]![2].every((record) => record.review_status !== 'group_confirmed')).toBe(true);
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();
  });

  it('M4 reveals hidden unresolved records only on request and navigates the current visible order', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, matches) => {
      const result = analysis(page, matches, page === 4 ? 0 : 280);
      return { ...result, selections: result.selections.map((item) => ({ ...item, confidence: page === 4 ? 0.7 : 0.8 })) };
    });
    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 4);
    await validatePreviewForPage(user, 12);
    await user.selectOptions(screen.getByRole('combobox', { name: '结果排序' }), 'confidence_desc');
    await user.click(within(screen.getByRole('region', { name: '审核导航' })).getByRole('button', { name: /已阻塞/ }));
    expect(screen.queryByRole('button', { name: /第 4 页 \/ 片段 1/ })).toBeNull();
    const reveal = await screen.findByRole('button', { name: '查看全部待复核' });
    await user.click(reveal);
    expect(reviewRow(/第 12 页 \/ 片段 1/).getAttribute('aria-current')).toBe('true');
    await user.click(screen.getByRole('button', { name: '下一项待复核' }));
    expect(reviewRow(/第 4 页 \/ 片段 1/).getAttribute('aria-current')).toBe('true');
    expect((screen.getByRole('combobox', { name: '结果排序' }) as HTMLSelectElement).value).toBe('confidence_desc');
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('moves new task to sources and opens help without changing the current search draft', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByRole('heading', { name: '银行回单工作台', level: 1 })).toBeTruthy();
    const sourcePanel = screen.getByRole('complementary', { name: '当前文件' });
    expect(within(sourcePanel).getByRole('button', { name: '＋ 新建任务' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '＋ 新建任务' })).toHaveLength(1);
    await choosePdf(user);
    const keyword = screen.getByRole('textbox', { name: '包含关键词 1' }) as HTMLInputElement;
    await user.clear(keyword);
    await user.type(keyword, '缴税');
    const help = screen.getByRole('button', { name: '帮助与反馈' });
    const pickerCount = vi.mocked(localEngineAdapter.pickPdfFiles).mock.calls.length;
    await user.click(help);
    expect(screen.getByRole('dialog', { name: '帮助与反馈' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: '使用指南' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '帮助与反馈' })).toBeNull();
    expect(document.activeElement).toBe(help);
    expect(keyword.value).toBe('缴税');
    expect(screen.getByRole('complementary', { name: '当前文件' }).textContent).toContain('source.pdf');
    expect(localEngineAdapter.search).not.toHaveBeenCalled();
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    expect(localEngineAdapter.pickPdfFiles).toHaveBeenCalledTimes(pickerCount);
  });

  it('keeps selected results and saved review state when reading help with keyboard tabs', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 12);
    const searchCount = vi.mocked(localEngineAdapter.search).mock.calls.length;
    const saveCount = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length;
    await user.click(screen.getByRole('button', { name: '帮助与反馈' }));
    await user.click(screen.getByRole('tab', { name: '功能介绍' }));
    await user.keyboard('{ArrowRight}{End}{Escape}');
    expect(reviewRow(/第 12 页 \/ 片段 1/).getAttribute('aria-current')).toBe('true');
    expect(localEngineAdapter.search).toHaveBeenCalledTimes(searchCount);
    expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(saveCount);
  });

  it('keeps help available during analysis without interrupting the current run', async () => {
    const user = userEvent.setup();
    let completeSearch!: (value: Awaited<ReturnType<typeof localEngineAdapter.search>>) => void;
    vi.mocked(localEngineAdapter.search).mockReturnValueOnce(new Promise((resolve) => { completeSearch = resolve; }));
    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(localEngineAdapter.search).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('button', { name: '选择 PDF' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '帮助与反馈' }));
    expect(screen.getByRole('dialog', { name: '帮助与反馈' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await act(async () => { completeSearch({ status: 'ok', page_count: 20, source_sha256: SOURCE_SHA256, matches: [] }); });
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    expect(localEngineAdapter.search).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('complementary', { name: '当前文件' }).textContent).toContain('source.pdf');
  });

  it('opens settings, keeps the current search draft, and returns focus to the entry button', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      defaultMatchMode: 'fuzzy',
      defaultIncludeMode: 'any',
    }));
    render(<App />);

    const settingsButton = screen.getByRole('button', { name: '设置' }) as HTMLButtonElement;
    expect(settingsButton.disabled).toBe(false);
    expect(settingsButton.getAttribute('aria-haspopup')).toBe('dialog');

    await choosePdf(user);
    const searchPanel = screen.getByRole('region', { name: '搜索条件' });
    expect((within(searchPanel).getByRole('radio', { name: '模糊匹配' }) as HTMLInputElement).checked).toBe(true);
    expect((within(searchPanel).getByRole('radio', { name: '任一满足' }) as HTMLInputElement).checked).toBe(true);

    await user.click(settingsButton);
    const dialog = screen.getByRole('dialog', { name: '设置' });
    expect((within(dialog).getByRole('radio', { name: '模糊匹配' }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(dialog).getByRole('radio', { name: '精确匹配' }));
    await user.click(within(dialog).getByRole('button', { name: '关闭设置' }));

    expect(document.activeElement).toBe(settingsButton);
    expect((within(searchPanel).getByRole('radio', { name: '模糊匹配' }) as HTMLInputElement).checked).toBe(true);
    expect((within(searchPanel).getByRole('radio', { name: '任一满足' }) as HTMLInputElement).checked).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      defaultMatchMode: 'exact',
      defaultIncludeMode: 'any',
    });
  });

  it('previews the first source page before analysis begins', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    render(<App />);
    await addPdf(user);
    expect(await screen.findByRole('img', { name: 'source.pdf 第 1 页' })).toBeTruthy();
    expect(screen.getByText('20 页 · 文档已读取')).toBeTruthy();
    expect(screen.getByRole('button', { name: '下一页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始分析' })).toBeTruthy();
    expect(vi.mocked(localEngineAdapter.inspectPdf)).toHaveBeenCalledWith('/docs/source.pdf');
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('records distinct keyword history on submitted searches and keeps it after reopening', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({ status: 'ok', page_count: 20, source_sha256: SOURCE_SHA256, matches: [] });
    const view = render(<App />);
    await choosePdf(user);
    const keyword = screen.getByRole('textbox', { name: '包含关键词 1' });
    await user.clear(keyword);
    await user.type(keyword, '手续费');
    expect(JSON.parse(window.localStorage.getItem(KEYWORD_HISTORY_STORAGE_KEY) ?? '{}').include ?? []).toEqual([]);
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    expect(JSON.parse(window.localStorage.getItem(KEYWORD_HISTORY_STORAGE_KEY) ?? '{}').include).toEqual(['手续费']);
    const nextKeyword = await openSearchEditor(user);
    await user.clear(nextKeyword);
    await user.type(nextKeyword, '退款');
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    expect(JSON.parse(window.localStorage.getItem(KEYWORD_HISTORY_STORAGE_KEY) ?? '{}').include).toEqual(['退款', '手续费']);

    view.unmount();
    vi.mocked(localEngineAdapter.search).mockClear();
    render(<App />);
    await user.click(screen.getByRole('textbox', { name: '包含关键词 1' }));
    expect(screen.getByRole('button', { name: '使用历史关键词 退款' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '使用历史关键词 手续费' }));
    expect((screen.getByRole('textbox', { name: '包含关键词 1' }) as HTMLInputElement).value).toBe('手续费');
    expect(localEngineAdapter.search).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '保存条件' })).toBeNull();
  });

  it('selects keyword history with Enter without searching or changing other conditions', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(KEYWORD_HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, include: ['手续费', '退款'], exclude: ['内部'] }));
    render(<App />);
    await choosePdf(user);
    await user.click(screen.getByRole('radio', { name: '模糊匹配' }));
    await user.click(screen.getByRole('radio', { name: '任一满足' }));
    await user.click(screen.getByRole('button', { name: '添加包含关键词' }));
    await user.type(screen.getByRole('textbox', { name: '包含关键词 2' }), '其他');
    await user.click(screen.getByRole('button', { name: '添加排除关键词' }));
    await user.click(screen.getByRole('textbox', { name: '排除关键词 1' }));
    await user.click(screen.getByRole('button', { name: '使用历史关键词 内部' }));
    const first = screen.getByRole('textbox', { name: '包含关键词 1' });
    await user.click(first);
    await user.keyboard('{ArrowDown}{Enter}');
    expect((first as HTMLInputElement).value).toBe('手续费');
    expect((screen.getByRole('textbox', { name: '包含关键词 2' }) as HTMLInputElement).value).toBe('其他');
    expect((screen.getByRole('textbox', { name: '排除关键词 1' }) as HTMLInputElement).value).toBe('内部');
    expect((screen.getByRole('radio', { name: '模糊匹配' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: '任一满足' }) as HTMLInputElement).checked).toBe(true);
    expect(localEngineAdapter.search).not.toHaveBeenCalled();
    expect(localEngineAdapter.searchMulti).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(KEYWORD_HISTORY_STORAGE_KEY) ?? '{}').include).toEqual(['手续费', '退款']);
  });

  it('migrates keyword history and keeps deleted and cleared legacy words removed after reopening', async () => {
    const user = userEvent.setup();
    const legacy = JSON.stringify({ version: 1, items: [{ id: 'legacy', name: '旧条件', savedAt: '2026-09-07T00:00:00.000Z', criteria: { include: ['手续费', '退款'], exclude: ['内部'], includeMode: 'any' }, matchMode: 'fuzzy' }] });
    window.localStorage.setItem(SEARCH_CONDITION_HISTORY_STORAGE_KEY, legacy);
    let view = render(<App />);
    await user.click(screen.getByRole('textbox', { name: '包含关键词 1' }));
    await user.click(screen.getByRole('button', { name: '删除历史关键词 手续费' }));
    expect(JSON.parse(window.localStorage.getItem(KEYWORD_HISTORY_STORAGE_KEY) ?? '{}').include).toEqual(['退款']);
    view.unmount();
    view = render(<App />);
    await user.click(screen.getByRole('textbox', { name: '包含关键词 1' }));
    expect(screen.queryByRole('button', { name: '使用历史关键词 手续费' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '清空历史' }));
    view.unmount();
    render(<App />);
    await user.click(screen.getByRole('textbox', { name: '包含关键词 1' }));
    expect(screen.queryByRole('button', { name: '使用历史关键词 退款' })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(KEYWORD_HISTORY_STORAGE_KEY) ?? '{}')).toMatchObject({ include: [], exclude: ['内部'] });
    expect(window.localStorage.getItem(SEARCH_CONDITION_HISTORY_STORAGE_KEY)).toBe(legacy);
    expect(localEngineAdapter.search).not.toHaveBeenCalled();
  });

  it('prepares a v2 review context even when the search returns zero hits', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [],
    });
    render(<App />);

    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getByText(/未找到符合条件的回单/)).toBeTruthy());

    expect(localEngineAdapter.computationInfo).toHaveBeenCalledTimes(1);
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(1);
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, computation_version: 'm2-test' }),
      [],
      expect.any(String),
    );
    expect(localEngineAdapter.loadReviewSegments).not.toHaveBeenCalled();
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('keeps the previous result when v2 preparation fails and does not publish the new condition', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);

    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '新条件' } });
    vi.mocked(localEngineAdapter.search).mockResolvedValueOnce({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(9)],
    });
    vi.mocked(localEngineAdapter.prepareReviewContext).mockRejectedValueOnce(
      new LocalEngineError('ENGINE_REQUEST_REJECTED', '审核上下文准备失败。'),
    );

    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await waitFor(() => expect(screen.getByText('审核上下文准备失败。')).toBeTruthy());

    expect(screen.getByRole('button', { name: /第 4 页 \/ 片段 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /第 12 页 \/ 片段 1/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /第 9 页 \/ 片段 1/ })).toBeNull();
    expect(screen.getByRole('button', { name: '恢复上次条件' })).toBeTruthy();
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('does not record keyword history from an unsubmitted draft or invalid analysis start', async () => {
    const user = userEvent.setup();
    render(<App />);
    const input = screen.getByRole('textbox', { name: '包含关键词 1' });
    await user.type(input, '未提交草稿');
    await user.keyboard('{Enter}');
    expect(localEngineAdapter.search).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(KEYWORD_HISTORY_STORAGE_KEY) ?? '{}').include ?? []).toEqual([]);
  });

  it.each([
    { label: 'too many clauses', keywords: Array.from({ length: 33 }, (_, index) => `条件${index}`) },
    { label: 'a too-long keyword', keywords: ['正常词', '字'.repeat(513)] },
  ])('does not record keyword history rejected for $label', async ({ keywords }) => {
    const user = userEvent.setup();
    render(<App />);
    await choosePdf(user);
    const panel = within(screen.getByRole('region', { name: '搜索条件' }));
    const addKeyword = panel.getByRole('button', { name: '添加包含关键词' });
    for (const [index, keyword] of keywords.entries()) {
      if (index > 0) fireEvent.click(addKeyword);
      fireEvent.change(panel.getByLabelText(`包含关键词 ${index + 1}`), { target: { value: keyword } });
    }
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    expect((await panel.findByRole('alert')).textContent).toContain('不能超过');
    expect(localEngineAdapter.search).not.toHaveBeenCalled();
    expect(localEngineAdapter.searchMulti).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(KEYWORD_HISTORY_STORAGE_KEY) ?? '{}').include ?? []).toEqual([]);
  });

  it('restores settings defaults without blocking the task', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '设置' }));
    const dialog = screen.getByRole('dialog', { name: '设置' });
    await user.click(within(dialog).getByRole('radio', { name: '模糊匹配' }));
    await user.click(within(dialog).getByRole('radio', { name: '任一满足' }));
    await user.click(within(dialog).getByRole('checkbox', { name: '同时导出审核索引 XLSX' }));
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'PDF 预览缩放' }), '150');
    await user.click(within(dialog).getByRole('button', { name: '恢复默认设置' }));

    expect((within(dialog).getByRole('radio', { name: '精确匹配' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('radio', { name: '全部满足' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('checkbox', { name: '同时导出审核索引 XLSX' }) as HTMLInputElement).checked).toBe(false);
    expect((within(dialog).getByRole('combobox', { name: 'PDF 预览缩放' }) as HTMLSelectElement).value).toBe('100');
    expect(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it('persists confirmed input and output directories selected from settings', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
      lastOutputDirectory: '/output/old',
    }));
    vi.mocked(localEngineAdapter.pickDirectory)
      .mockResolvedValueOnce('/input/new')
      .mockResolvedValueOnce('/output/new');
    render(<App />);

    const dialog = await (async () => {
      await user.click(screen.getByRole('button', { name: '设置' }));
      return screen.getByRole('dialog', { name: '设置' });
    })();

    await user.click(within(dialog).getByRole('button', { name: '浏览输入目录' }));
    expect(localEngineAdapter.pickDirectory).toHaveBeenNthCalledWith(1, '/input/old');
    await waitFor(() => expect((within(dialog).getByLabelText('输入目录') as HTMLInputElement).value).toBe('/input/new'));
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/new',
      lastOutputDirectory: '/output/old',
    });

    await user.click(within(dialog).getByRole('button', { name: '浏览输出目录' }));
    expect(localEngineAdapter.pickDirectory).toHaveBeenNthCalledWith(2, '/output/old');
    await waitFor(() => expect((within(dialog).getByLabelText('输出目录') as HTMLInputElement).value).toBe('/output/new'));
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/new',
      lastOutputDirectory: '/output/new',
    });
    expect(localEngineAdapter.pickPdfFiles).not.toHaveBeenCalled();
    expect(localEngineAdapter.pickPdfFolder).not.toHaveBeenCalled();
    expect(localEngineAdapter.pickOutputFolder).not.toHaveBeenCalled();
    expect(localEngineAdapter.search).not.toHaveBeenCalled();
    expect(localEngineAdapter.searchMulti).not.toHaveBeenCalled();
    expect(localEngineAdapter.exportIndex).not.toHaveBeenCalled();
    expect(localEngineAdapter.publishPreviewPdf).not.toHaveBeenCalled();
  });

  it('validates and persists manually edited directories, including clearing an empty value', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
      lastOutputDirectory: '/output/old',
    }));
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    const dialog = screen.getByRole('dialog', { name: '设置' });
    const inputDirectory = within(dialog).getByRole('textbox', { name: '输入目录' }) as HTMLInputElement;

    await user.clear(inputDirectory);
    await user.type(inputDirectory, '/input/manual');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(localEngineAdapter.validateDirectory).toHaveBeenCalledWith('/input/manual'));
    await waitFor(() => expect(inputDirectory.value).toBe('/input/manual'));
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/manual',
      lastOutputDirectory: '/output/old',
    });

    const outputDirectory = within(screen.getByRole('dialog', { name: '设置' })).getByRole('textbox', { name: '输出目录' }) as HTMLInputElement;
    await user.clear(outputDirectory);
    fireEvent.blur(outputDirectory);
    await waitFor(() => expect(outputDirectory.value).toBe(''));
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/manual',
      lastOutputDirectory: null,
    });
    expect(localEngineAdapter.validateDirectory).toHaveBeenCalledTimes(1);
  });

  it('normalizes a valid directory draft with surrounding whitespace', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
    }));
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    const inputDirectory = screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement;
    fireEvent.change(inputDirectory, { target: { value: '  /input/old  ' } });
    fireEvent.keyDown(inputDirectory, { key: 'Enter' });

    await waitFor(() => expect(localEngineAdapter.validateDirectory).toHaveBeenCalledWith('/input/old'));
    await waitFor(() => expect(inputDirectory.value).toBe('/input/old'));
  });

  it('restores the previous directory draft when manual validation fails or throws', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
    }));
    vi.mocked(localEngineAdapter.validateDirectory)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('validation failed'));
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    let inputDirectory = screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement;
    await user.clear(inputDirectory);
    await user.type(inputDirectory, '/input/missing');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('目录无效'));
    inputDirectory = screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement;
    expect(inputDirectory.value).toBe('/input/old');
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/old',
    });

    await user.clear(inputDirectory);
    await user.type(inputDirectory, '/input/error');
    fireEvent.blur(inputDirectory);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('validation failed'));
    expect((screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement).value).toBe('/input/old');
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/old',
    });
  });

  it('ignores stale validation results when a newer edit for the same directory wins', async () => {
    const user = userEvent.setup();
    let resolveFirst: (valid: boolean) => void = () => undefined;
    let resolveSecond: (valid: boolean) => void = () => undefined;
    const firstValidation = new Promise<boolean>((resolve) => {
      resolveFirst = resolve;
    });
    const secondValidation = new Promise<boolean>((resolve) => {
      resolveSecond = resolve;
    });
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
    }));
    vi.mocked(localEngineAdapter.validateDirectory)
      .mockImplementationOnce(() => firstValidation)
      .mockImplementationOnce(() => secondValidation);
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    const inputDirectory = screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement;
    await user.clear(inputDirectory);
    await user.type(inputDirectory, '/input/first');
    await user.keyboard('{Enter}');
    await user.clear(inputDirectory);
    await user.type(inputDirectory, '/input/newest');
    await user.keyboard('{Enter}');

    resolveSecond(true);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/newest',
    }));
    resolveFirst(false);
    await waitFor(() => {
      expect((screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement).value).toBe('/input/newest');
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('does not apply a pending validation result after settings are closed', async () => {
    const user = userEvent.setup();
    let resolveValidation: (valid: boolean) => void = () => undefined;
    const validation = new Promise<boolean>((resolve) => {
      resolveValidation = resolve;
    });
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
    }));
    vi.mocked(localEngineAdapter.validateDirectory).mockReturnValueOnce(validation);
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    const inputDirectory = screen.getByRole('textbox', { name: '输入目录' });
    await user.clear(inputDirectory);
    await user.type(inputDirectory, '/input/closed');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: '关闭设置' }));

    resolveValidation(true);
    await Promise.resolve();
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/old',
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears directory errors when settings are closed and reopened', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
    }));
    vi.mocked(localEngineAdapter.validateDirectory).mockResolvedValueOnce(false);
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    const inputDirectory = screen.getByRole('textbox', { name: '输入目录' });
    await user.clear(inputDirectory);
    await user.type(inputDirectory, '/input/missing');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('目录无效'));

    await user.click(screen.getByRole('button', { name: '关闭设置' }));
    expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement).value).toBe('/input/old');
  });

  it('resets uncommitted directory drafts when settings are closed', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
      lastOutputDirectory: '/output/old',
    }));
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.change(screen.getByRole('textbox', { name: '输入目录' }), {
      target: { value: '/input/uncommitted' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '输出目录' }), {
      target: { value: '/output/uncommitted' },
    });
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }));

    await user.click(screen.getByRole('button', { name: '设置' }));
    expect((screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement).value).toBe('/input/old');
    expect((screen.getByRole('textbox', { name: '输出目录' }) as HTMLInputElement).value).toBe('/output/old');
  });

  it('resets directory commit deduplication when settings are closed and reopened', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
    }));
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: '输入目录' }), { key: 'Enter' });
    await waitFor(() => expect(localEngineAdapter.validateDirectory).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '关闭设置' }));
    await user.click(screen.getByRole('button', { name: '设置' }));

    fireEvent.keyDown(screen.getByRole('textbox', { name: '输入目录' }), { key: 'Enter' });
    await waitFor(() => expect(localEngineAdapter.validateDirectory).toHaveBeenCalledTimes(2));
  });

  it('resets only the failed directory draft and preserves an uncommitted draft in the other field', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
      lastOutputDirectory: '/output/old',
    }));
    vi.mocked(localEngineAdapter.validateDirectory).mockResolvedValueOnce(false);
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    const inputDirectory = screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement;
    const outputDirectory = screen.getByRole('textbox', { name: '输出目录' }) as HTMLInputElement;
    fireEvent.change(outputDirectory, { target: { value: '/output/unsaved' } });
    await user.clear(inputDirectory);
    await user.type(inputDirectory, '/input/missing');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('目录无效'));
    expect((screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement).value).toBe('/input/old');
    expect((screen.getByRole('textbox', { name: '输出目录' }) as HTMLInputElement).value).toBe('/output/unsaved');
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/old',
      lastOutputDirectory: '/output/old',
    });
  });

  it('uses the current directory drafts as browser picker starting locations', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
      lastOutputDirectory: '/output/old',
    }));
    vi.mocked(localEngineAdapter.pickDirectory)
      .mockResolvedValueOnce('/input/selected')
      .mockResolvedValueOnce('/output/selected');
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    let dialog = screen.getByRole('dialog', { name: '设置' });
    const inputDirectory = within(dialog).getByRole('textbox', { name: '输入目录' });
    await user.clear(inputDirectory);
    await user.type(inputDirectory, '/input/draft');
    await user.click(within(dialog).getByRole('button', { name: '浏览输入目录' }));
    await waitFor(() => expect(localEngineAdapter.pickDirectory).toHaveBeenNthCalledWith(1, '/input/draft'));
    await waitFor(() => expect((screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement).value).toBe('/input/selected'));

    dialog = screen.getByRole('dialog', { name: '设置' });
    const outputDirectory = within(dialog).getByRole('textbox', { name: '输出目录' });
    await user.clear(outputDirectory);
    await user.type(outputDirectory, '/output/draft');
    await user.click(within(dialog).getByRole('button', { name: '浏览输出目录' }));
    await waitFor(() => expect(localEngineAdapter.pickDirectory).toHaveBeenNthCalledWith(2, '/output/draft'));
    await waitFor(() => expect((screen.getByRole('textbox', { name: '输出目录' }) as HTMLInputElement).value).toBe('/output/selected'));
    expect(localEngineAdapter.validateDirectory).toHaveBeenCalledWith('/input/draft');
    expect(localEngineAdapter.validateDirectory).toHaveBeenCalledWith('/output/draft');
  });

  it('revalidates a directory returned by the settings picker before persisting it', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
    }));
    vi.mocked(localEngineAdapter.pickDirectory).mockResolvedValueOnce('/input/unverified');
    vi.mocked(localEngineAdapter.validateDirectory).mockResolvedValueOnce(false);
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('button', { name: '浏览输入目录' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('目录无效'));
    expect((screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement).value).toBe('/input/old');
    expect(localEngineAdapter.validateDirectory).toHaveBeenCalledWith('/input/unverified');
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/old',
    });
  });

  it('keeps settings directories unchanged when directory selection is cancelled or fails', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      lastInputDirectory: '/input/old',
      lastOutputDirectory: '/output/old',
    }));
    vi.mocked(localEngineAdapter.pickDirectory)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('   ')
      .mockRejectedValueOnce(new Error('picker failed'));
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    const dialog = screen.getByRole('dialog', { name: '设置' });

    await user.click(within(dialog).getByRole('button', { name: '浏览输入目录' }));
    expect((within(dialog).getByLabelText('输入目录') as HTMLInputElement).value).toBe('/input/old');
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/old',
      lastOutputDirectory: '/output/old',
    });

    await user.click(within(dialog).getByRole('button', { name: '浏览输出目录' }));
    expect((within(dialog).getByLabelText('输出目录') as HTMLInputElement).value).toBe('/output/old');
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/old',
      lastOutputDirectory: '/output/old',
    });

    await user.click(within(dialog).getByRole('button', { name: '浏览输出目录' }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('picker failed'));
    expect((within(dialog).getByLabelText('输出目录') as HTMLInputElement).value).toBe('/output/old');
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/old',
      lastOutputDirectory: '/output/old',
    });
  });

  it('disables both settings directory buttons while a directory picker is open', async () => {
    const user = userEvent.setup();
    let resolveDirectory: (directory: string | null) => void = () => undefined;
    vi.mocked(localEngineAdapter.pickDirectory).mockReturnValueOnce(new Promise((resolve) => {
      resolveDirectory = resolve;
    }));
    render(<App />);

    await user.click(screen.getByRole('button', { name: '设置' }));
    const dialog = screen.getByRole('dialog', { name: '设置' });
    const inputButton = within(dialog).getByRole('button', { name: '浏览输入目录' }) as HTMLButtonElement;
    const outputButton = within(dialog).getByRole('button', { name: '浏览输出目录' }) as HTMLButtonElement;

    await user.click(inputButton);
    expect(inputButton.disabled).toBe(true);
    expect(outputButton.disabled).toBe(true);
    expect(within(dialog).getByRole('status', { name: '目录选择状态' }).textContent).toBe('正在选择目录…');

    resolveDirectory('/input/new');
    await waitFor(() => expect(inputButton.disabled).toBe(false));
    expect(outputButton.disabled).toBe(false);
  });

  it('remembers confirmed input picker directories and keeps cancellation unchanged', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.pickPdfFiles)
      .mockResolvedValueOnce(pickerResult(['/docs/source.pdf'], '/input/first'))
      .mockResolvedValueOnce(pickerResult([], '/input/cancelled'))
      .mockResolvedValueOnce(pickerResult(['/docs/next.pdf'], '/input/second'));
    render(<App />);

    await choosePdf(user);
    expect(localEngineAdapter.pickPdfFiles).toHaveBeenNthCalledWith(1, null);
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/first',
    });

    await choosePdf(user);
    expect(localEngineAdapter.pickPdfFiles).toHaveBeenNthCalledWith(2, '/input/first');
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/first',
    });

    await choosePdf(user);
    expect(localEngineAdapter.pickPdfFiles).toHaveBeenNthCalledWith(3, '/input/first');
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      lastInputDirectory: '/input/second',
    });
  });

  it('shows a non-blocking warning for damaged settings and uses defaults', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, '{damaged');
    render(<App />);
    await user.click(screen.getByRole('button', { name: '设置' }));
    const dialog = screen.getByRole('dialog', { name: '设置' });
    expect(within(dialog).getByRole('status').textContent).toContain('配置内容损坏，已使用默认配置。');
    expect((within(dialog).getByRole('radio', { name: '精确匹配' }) as HTMLInputElement).checked).toBe(true);
  });

  it('applies stored defaults while requiring trusted task records for new bundle export', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      defaultMatchMode: 'fuzzy',
      defaultIncludeMode: 'any',
      defaultIncludeXlsx: true,
      defaultPreviewZoom: 125,
    }));
    vi.mocked(localEngineAdapter.searchMulti).mockResolvedValueOnce({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [
        multiMatch(4, 'include-0', 'include', '手续费', 40, 80),
        multiMatch(12, 'include-0', 'include', '手续费', 40, 80),
      ],
    });
    vi.mocked(localEngineAdapter.analyzePage)
      .mockResolvedValueOnce({
        status: 'ok',
        page: 4,
        page_width: PAGE_WIDTH,
        page_height: PAGE_HEIGHT,
        selections: [multiSelection({ x0: 40, y0: 80, x1: 120, y1: 104 }, 0, 0)],
      })
      .mockResolvedValueOnce({
        status: 'ok',
        page: 12,
        page_width: PAGE_WIDTH,
        page_height: PAGE_HEIGHT,
        selections: [multiSelection({ x0: 40, y0: 80, x1: 120, y1: 104 }, 0, 280)],
      });
    render(<App />);

    await choosePdf(user);
    const searchPanel = screen.getByRole('region', { name: '搜索条件' });
    expect((within(searchPanel).getByRole('radio', { name: '模糊匹配' }) as HTMLInputElement).checked).toBe(true);
    expect((within(searchPanel).getByRole('radio', { name: '任一满足' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByText('125%').length).toBeGreaterThan(0);

    await startAnalysis(user);
    await waitFor(() => expect(screen.getByText('第 4 页 / 片段 1')).toBeTruthy());
    await validatePreviewForPage(user, 12);
    await user.click(screen.getByRole('button', { name: '确认整组' }));
    await waitFor(() => expect(confirmedPreviewAction().disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '生成 PDF 导出预览' }));
    const dialog = await screen.findByRole('dialog', { name: '导出设置' });
    expect(within(dialog).getByText('当前结果缺少完整的持久任务记录，请重新分析后导出。')).toBeTruthy();
    expect((within(dialog).getByRole('checkbox', { name: '同时导出审核索引 XLSX' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('button', { name: '确认范围并生成预览' }) as HTMLButtonElement).disabled).toBe(true);
    expect(localEngineAdapter.exportPdf).not.toHaveBeenCalled();

  });


  it('analyzes each source-page once and selects each per-hit candidate', async () => {
    const user = userEvent.setup();
    render(<App />);

    await loadResults(user);
    expect(screen.getByText('第 12 页 / 片段 1')).toBeTruthy();

    const analyze = vi.mocked(localEngineAdapter.analyzePage);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['/docs/source.pdf', 4],
      ['/docs/source.pdf', 12],
    ]);
    expect(analyze.mock.calls[0]?.[2]).toEqual([{ x0: 40, y0: 80, x1: 120, y1: 104 }]);
    expect(analyze.mock.calls[1]?.[2]).toEqual([{ x0: 40, y0: 80, x1: 120, y1: 104 }]);

    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('0%');
    expect(screen.getByText('当前片段：第 4 页 / 片段 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: /第 4 页 \/ 片段 1/ }).getAttribute('data-selected')).toBe('true');
    await user.click(screen.getByText('第 12 页 / 片段 1'));
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('35%');
    await user.click(screen.getByText('第 4 页 / 片段 1'));
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('0%');
    expect(vi.mocked(localEngineAdapter.renderPage)).toHaveBeenCalledWith('/docs/source.pdf', 4, SOURCE_SHA256);
  });

  it('returns one review row when two include terms hit the same receipt', async () => {
    render(<App />);
    vi.mocked(localEngineAdapter.searchMulti).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [
        multiMatch(4, 'include-0', 'include', '示例实业', 40, 80),
        multiMatch(4, 'include-1', 'include', '华夏银行', 180, 100),
      ],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockResolvedValue({
      status: 'ok',
      page: 4,
      page_width: PAGE_WIDTH,
      page_height: PAGE_HEIGHT,
      selections: [
        multiSelection({ x0: 40, y0: 80, x1: 120, y1: 104 }, 0, 0),
        multiSelection({ x0: 180, y0: 100, x1: 260, y1: 124 }, 0, 0),
      ],
    });

    await runCriteriaSearch({ include: ['示例实业', '华夏银行'], includeMode: 'all', exclude: [] });

    expect(await screen.findAllByRole('button', { name: /第 4 页 \/ 片段/ })).toHaveLength(1);
    expect(screen.getByText('示例实业、华夏银行')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect(parseFloat((screen.getByLabelText('裁剪区域') as HTMLElement).style.height)).toBeCloseTo(27.5, 5);
    expect(localEngineAdapter.search).not.toHaveBeenCalled();
    expect(localEngineAdapter.searchMulti).toHaveBeenCalledWith(
      '/docs/source.pdf',
      [
        { id: 'include-0', keyword: '示例实业', role: 'include' },
        { id: 'include-1', keyword: '华夏银行', role: 'include' },
      ],
      true,
    );
  });

  it('orders compound receipt candidates by candidate index before assigning segment numbers', async () => {
    render(<App />);
    vi.mocked(localEngineAdapter.searchMulti).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [
        multiMatch(4, 'include-0', 'include', '示例实业（候选1）', 40, 360),
        multiMatch(4, 'include-1', 'include', '华夏银行（候选1）', 180, 380),
        multiMatch(4, 'include-0', 'include', '示例实业（候选0）', 40, 80),
        multiMatch(4, 'include-1', 'include', '华夏银行（候选0）', 180, 100),
      ],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockResolvedValue({
      status: 'ok',
      page: 4,
      page_width: PAGE_WIDTH,
      page_height: PAGE_HEIGHT,
      selections: [
        multiSelection({ x0: 40, y0: 360, x1: 120, y1: 384 }, 1, 280),
        multiSelection({ x0: 180, y0: 380, x1: 260, y1: 404 }, 1, 280),
        multiSelection({ x0: 40, y0: 80, x1: 120, y1: 104 }, 0, 0),
        multiSelection({ x0: 180, y0: 100, x1: 260, y1: 124 }, 0, 0),
      ],
    });

    await runCriteriaSearch({ include: ['示例实业', '华夏银行'], includeMode: 'all', exclude: [] });

    const rows = within(screen.getByRole('region', { name: '审核导航' }))
      .getAllByRole('button', { name: /第 4 页 \/ 片段/ });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('aria-label')).toContain('片段 1');
    expect(rows[0]?.getAttribute('aria-label')).toContain('关键词：示例实业、华夏银行');
    expect(rows[0]?.getAttribute('aria-label')).toContain('示例实业（候选0）');
    expect(rows[1]?.getAttribute('aria-label')).toContain('片段 2');
    expect(rows[1]?.getAttribute('aria-label')).toContain('关键词：示例实业、华夏银行');
    expect(rows[1]?.getAttribute('aria-label')).toContain('示例实业（候选1）');
  });

  it('does not merge include terms from adjacent candidates', async () => {
    render(<App />);
    vi.mocked(localEngineAdapter.searchMulti).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [
        multiMatch(4, 'include-0', 'include', '示例实业', 40, 80),
        multiMatch(4, 'include-1', 'include', '华夏银行', 40, 360),
      ],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockResolvedValue({
      status: 'ok',
      page: 4,
      page_width: PAGE_WIDTH,
      page_height: PAGE_HEIGHT,
      selections: [
        multiSelection({ x0: 40, y0: 80, x1: 120, y1: 104 }, 0, 0),
        multiSelection({ x0: 40, y0: 360, x1: 120, y1: 384 }, 1, 280),
      ],
    });

    await runCriteriaSearch({ include: ['示例实业', '华夏银行'], includeMode: 'all', exclude: [] });

    expect(screen.queryByRole('button', { name: /第 4 页 \/ 片段/ })).toBeNull();
    expect(screen.getAllByText(/未找到符合条件的回单/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/全部已有自动裁剪候选/)).toBeNull();
  });

  it('excludes a same-candidate receipt when any exclusion term hits', async () => {
    render(<App />);
    vi.mocked(localEngineAdapter.searchMulti).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [
        multiMatch(4, 'include-0', 'include', '示例实业', 40, 80),
        multiMatch(4, 'include-1', 'include', '华夏银行', 180, 100),
        multiMatch(4, 'exclude-0', 'exclude', '退款', 280, 120),
      ],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockResolvedValue({
      status: 'ok',
      page: 4,
      page_width: PAGE_WIDTH,
      page_height: PAGE_HEIGHT,
      selections: [
        multiSelection({ x0: 40, y0: 80, x1: 120, y1: 104 }, 0, 0),
        multiSelection({ x0: 180, y0: 100, x1: 260, y1: 124 }, 0, 0),
        multiSelection({ x0: 280, y0: 120, x1: 360, y1: 144 }, 0, 0),
      ],
    });

    await runCriteriaSearch({ include: ['示例实业', '华夏银行'], includeMode: 'all', exclude: ['退款'] });

    expect(screen.queryByRole('button', { name: /第 4 页 \/ 片段/ })).toBeNull();
    expect(screen.getAllByText(/未找到符合条件的回单/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/全部已有自动裁剪候选/)).toBeNull();
  });

  it('shows a legacy crop suggestion only after explicit restore and saves it through v2', async () => {
    const user = userEvent.setup();
    const taskId = reviewTaskIdFor([{ name: 'source.pdf', relativePath: 'source.pdf', size: 0, path: '/docs/source.pdf' }], '手续费', 'exact')!;
    const load = vi.spyOn(localEngineAdapter, 'loadReviewSegments').mockResolvedValue({
      status: 'ok',
      task_id: taskId,
      segments: [{
        id: 'old-id',
        task_id: taskId,
        source_path: '/docs/source.pdf',
        source_sha256: SOURCE_SHA256,
        source_page: 4,
        segment_no: 1,
        match_rect: { x0: 40, y0: 80, x1: 120, y1: 104 },
        candidate_rect: { x0: 0, y0: 5, x1: PAGE_WIDTH, y1: 220 },
        final_rect: { x0: 0, y0: 10, x1: PAGE_WIDTH, y1: 215 },
        layout_fingerprint: 'persisted-layout',
        confidence: 0.96,
        crop_mode: 'manual',
        review_status: 'confirmed',
        manual_adjusted: true,
        reviewed_at: '2026-09-01T06:20:00.000Z',
      }],
    });
    const save = vi.mocked(localEngineAdapter.saveReviewSegmentsV2);

    render(<App />);
    await loadResults(user);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('0%');
    expect(load).toHaveBeenCalledWith(taskId);
    expect(screen.getByRole('button', { name: '恢复历史裁剪建议' })).toBeTruthy();
    expect(save).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '恢复历史裁剪建议' }));
    await waitFor(() => expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('1.25%'));
    expect(screen.getByText('当前状态：需复核')).toBeTruthy();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(save.mock.calls[0]?.[1]).toBeTypeOf('string');
    expect(save.mock.calls[0]?.[2][0]).toMatchObject({
      source_sha256: SOURCE_SHA256,
      candidate_rect: { y0: 0 },
      final_rect: { y0: 10 },
      review_status: 'needs_review',
    });

    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]?.[2][0]).toMatchObject({
      source_sha256: SOURCE_SHA256,
      candidate_rect: { y0: 0 },
      final_rect: { y0: 11 },
    });
  });

  it('does not restore a review record whose source SHA changed', async () => {
    const user = userEvent.setup();
    const taskId = reviewTaskIdFor([{ name: 'source.pdf', relativePath: 'source.pdf', size: 0, path: '/docs/source.pdf' }], '手续费', 'exact')!;
    vi.spyOn(localEngineAdapter, 'loadReviewSegments').mockResolvedValue({
      status: 'ok',
      task_id: taskId,
      segments: [{
        id: 'old-id',
        task_id: taskId,
        source_path: '/docs/source.pdf',
        source_sha256: CHANGED_SOURCE_SHA256,
        source_page: 4,
        segment_no: 1,
        match_rect: { x0: 40, y0: 80, x1: 120, y1: 104 },
        candidate_rect: { x0: 0, y0: 80, x1: PAGE_WIDTH, y1: 300 },
        final_rect: { x0: 0, y0: 80, x1: PAGE_WIDTH, y1: 300 },
        layout_fingerprint: 'stale-layout',
        confidence: 0.96,
        crop_mode: 'manual',
        review_status: 'confirmed',
        manual_adjusted: true,
        reviewed_at: '2026-09-01T06:20:00.000Z',
      }],
    });

    render(<App />);
    await loadResults(user);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('0%');
    expect(screen.queryByRole('button', { name: '恢复历史裁剪建议' })).toBeNull();
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('derives a stable de-identified task id from the normalized source set', () => {
    const first = [
      { name: 'A.pdf', relativePath: 'A.pdf', size: 0, path: 'C:\\Docs\\A.pdf' },
      { name: 'B.pdf', relativePath: 'B.pdf', size: 0, path: 'C:\\Docs\\B.pdf' },
    ];
    const second = [...first].reverse();
    const id = reviewTaskIdFor(first, ' 手续费 ', 'exact');

    expect(id).toBe(reviewTaskIdFor(second, '手续费', 'exact'));
    expect(id).not.toContain('手续费');
    expect(id).not.toContain('C:');
    expect(id).not.toContain('Docs');
    expect(id).not.toBe(reviewTaskIdFor(first, '金额', 'exact'));
  });

  it('does not report current crop as saved when the local adapter is unavailable', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockRejectedValue(
      new LocalEngineError('TAURI_UNAVAILABLE', '本地引擎需要在 Tauri 桌面应用中运行。'),
    );

    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 4);
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });

    await waitFor(() => expect(screen.getByText('本地引擎不可用，审核记录未保存。')).toBeTruthy());
    expect(screen.queryByText(/裁剪已保存到当前审核任务/)).toBeNull();
  });

  it('surfaces an adapter rejection instead of claiming a successful save', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockRejectedValue(
      new LocalEngineError('ENGINE_REQUEST_REJECTED', '审核数据库写入被拒绝。'),
    );

    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 4);
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });

    await waitFor(() => expect(screen.getByText('审核记录保存失败：审核数据库写入被拒绝。')).toBeTruthy());
    expect(screen.queryByText(/裁剪已保存到当前审核任务/)).toBeNull();
  });

  it('rolls back group confirmation and keeps export gated when persistence fails', async () => {
    const user = userEvent.setup();

    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 12);
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockRejectedValueOnce(
      new LocalEngineError('ENGINE_REQUEST_REJECTED', '审核数据库写入被拒绝。'),
    );
    await user.click(screen.getByRole('button', { name: '确认整组' }));

    await waitFor(() => expect(screen.getByText('审核记录保存失败：审核数据库写入被拒绝。')).toBeTruthy());
    expect(screen.queryByText('已整组确认，可继续导出。')).toBeNull();
    expect(screen.queryByRole('button', { name: /选择目录并导出/ })).toBeNull();
    expectReviewPhaseActions();
  });

  it('keeps group confirmation and export gated until the group save succeeds', async () => {
    const user = userEvent.setup();
    let releaseSave: (() => void) | undefined;
    const pendingSave = new Promise<EngineSavedReviewV2>((resolve) => {
      releaseSave = () => {
        const [contextKey, resultRevision, segments] = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.at(-1)!;
        resolve(acknowledgeReviewSave(contextKey, resultRevision, segments));
      };
    });
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockReturnValue(pendingSave);

    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 12);
    await user.click(screen.getByRole('button', { name: '确认整组' }));

    await waitFor(() => expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1));
    const saving = screen.getByRole('button', { name: '保存中…' }) as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    expect(saving.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('已整组确认，可继续导出。')).toBeNull();
    const sort = screen.getByRole('combobox', { name: '结果排序' }) as HTMLSelectElement;
    expect(sort.disabled).toBe(true);
    fireEvent.change(sort, { target: { value: 'confidence_desc' } });
    expect(sort.value).toBe('original');

    releaseSave?.();
    await waitFor(() => expect(confirmedPreviewAction().disabled).toBe(false));
  });

  it('rejects unavailable source hashes as one atomic failed analysis', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: undefined as unknown as string,
      matches: [match(4)],
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getByText('本地搜索失败：搜索响应的源 PDF SHA-256 无效。')).toBeTruthy());
    expect(screen.queryByText('第 4 页 / 片段 1')).toBeNull();
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('lets an in-flight save finish for the old task without updating the new task notice', async () => {
    const user = userEvent.setup();
    let releaseFirstSave: (() => void) | undefined;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockImplementation(async (contextKey, resultRevision, segments) => {
      if (segments[0]?.source_page === 4) {
        await firstSave;
      }
      return acknowledgeReviewSave(contextKey, resultRevision, segments);
    });
    vi.mocked(localEngineAdapter.pickPdfFiles)
      .mockResolvedValueOnce(pickerResult(['/docs/source.pdf']))
      .mockResolvedValueOnce(pickerResult(['/docs/next.pdf']));
    vi.mocked(localEngineAdapter.search)
      .mockResolvedValueOnce({
        status: 'ok',
        page_count: 20,
        source_sha256: SOURCE_SHA256,
        matches: [match(4), match(12)],
      })
      .mockResolvedValueOnce({
        status: 'ok',
        page_count: 20,
        source_sha256: SOURCE_SHA256,
        matches: [match(9)],
      });

    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 4);
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await waitFor(() => expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: '＋ 新建任务' }));
    await waitFor(() => expect(localEngineAdapter.pickPdfFiles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('next.pdf')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await waitFor(() => expect(localEngineAdapter.search).toHaveBeenCalledTimes(2));
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /next\.pdf.*第 9 页 \/ 片段 1/ })).toBeNull();
    releaseFirstSave?.();
    await waitFor(() => expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(reviewRow(/next\.pdf.*第 9 页 \/ 片段 1/)).toBeTruthy());
    expect(screen.queryByText('第 4 页 / 片段 1 已确认。')).toBeNull();
  });

  it('does not report a page save as successful after its source changes in flight', async () => {
    const user = userEvent.setup();
    let releaseSave: (() => void) | undefined;
    let rejectPage12: ((reason?: unknown) => void) | undefined;
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockImplementation((contextKey, resultRevision, segments) => new Promise((resolve) => {
      releaseSave = () => resolve(acknowledgeReviewSave(contextKey, resultRevision, segments));
    }));
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => {
      if (page === 12) {
        return new Promise((_resolve, reject) => {
          rejectPage12 = reject;
        });
      }
      return { ...preview(path, page), page_count: 20 };
    });

    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 4);
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await waitFor(() => expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1));

    await user.click(screen.getByText('第 12 页 / 片段 1'));
    await waitFor(() => expect(rejectPage12).toBeTypeOf('function'));
    rejectPage12?.(sourceChangedError('源文件已变化，请重新分析'));
    await waitFor(() => expect(screen.getAllByText('源文件已变化，请重新分析').length).toBeGreaterThan(0));

    releaseSave?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/裁剪已保存到当前审核任务/)).toBeNull();
  });

  it('does not restore v1 group confirmation or unlock export automatically', async () => {
    const user = userEvent.setup();
    // The task id is intentionally opaque; obtain it from the load call after
    // the current task has been created, then return matching data.
    vi.spyOn(localEngineAdapter, 'loadReviewSegments').mockImplementation(async (taskId) => ({
      status: 'ok',
      task_id: taskId,
      segments: [
        {
          id: 'group-1', task_id: taskId, source_path: '/docs/source.pdf', source_sha256: SOURCE_SHA256, source_page: 4, segment_no: 1,
          match_rect: { x0: 40, y0: 80, x1: 120, y1: 104 }, candidate_rect: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 220 }, final_rect: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 220 },
          layout_fingerprint: 'group-1', confidence: 0.96, crop_mode: 'manual', review_status: 'group_confirmed', manual_adjusted: true, reviewed_at: '2026-09-01T06:20:00.000Z',
        },
        {
          id: 'group-2', task_id: taskId, source_path: '/docs/source.pdf', source_sha256: SOURCE_SHA256, source_page: 12, segment_no: 1,
          match_rect: { x0: 40, y0: 80, x1: 120, y1: 104 }, candidate_rect: { x0: 0, y0: 280, x1: PAGE_WIDTH, y1: 500 }, final_rect: { x0: 0, y0: 280, x1: PAGE_WIDTH, y1: 500 },
          layout_fingerprint: 'group-2', confidence: 0.96, crop_mode: 'manual', review_status: 'group_confirmed', manual_adjusted: true, reviewed_at: '2026-09-01T06:20:00.000Z',
        },
      ],
    }));

    render(<App />);
    await loadResults(user);
    await user.click(screen.getByText('第 12 页 / 片段 1'));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect(screen.queryByText('已确认 2 / 2')).toBeNull();
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();
    expect(screen.getByRole('button', { name: '确认整组' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '恢复历史裁剪建议' })).toBeTruthy();
  });

  it('restores a complete and compatible v2 group confirmation', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.prepareReviewContext).mockImplementation(async (context, originals, resultRevision) => {
      const contextKey = await reviewContextKey(context);
      const records = originals.map((original) => reviewRecordFromOriginal(context, original, contextKey, resultRevision));
      return preparedReview(contextKey, resultRevision, originals, records, true);
    });

    render(<App />);
    await loadResults(user);
    await user.click(screen.getByText('第 12 页 / 片段 1'));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    await waitFor(() => expect(confirmedPreviewAction().disabled).toBe(false));
    expect(screen.getByText('已确认 2 / 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '恢复历史裁剪建议' })).toBeNull();
  });

  it('does not restore group confirmation for mixed v1 page and group records', async () => {
    const user = userEvent.setup();
    vi.spyOn(localEngineAdapter, 'loadReviewSegments').mockImplementation(async (taskId) => ({
      status: 'ok',
      task_id: taskId,
      segments: [
        {
          id: 'group-1', task_id: taskId, source_path: '/docs/source.pdf', source_sha256: SOURCE_SHA256, source_page: 4, segment_no: 1,
          match_rect: { x0: 40, y0: 80, x1: 120, y1: 104 }, candidate_rect: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 220 }, final_rect: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 220 },
          layout_fingerprint: 'group-1', confidence: 0.96, crop_mode: 'manual', review_status: 'group_confirmed', manual_adjusted: true, reviewed_at: '2026-09-01T06:20:00.000Z',
        },
        {
          id: 'page-2', task_id: taskId, source_path: '/docs/source.pdf', source_sha256: SOURCE_SHA256, source_page: 12, segment_no: 1,
          match_rect: { x0: 40, y0: 80, x1: 120, y1: 104 }, candidate_rect: { x0: 0, y0: 280, x1: PAGE_WIDTH, y1: 500 }, final_rect: { x0: 0, y0: 280, x1: PAGE_WIDTH, y1: 500 },
          layout_fingerprint: 'page-2', confidence: 0.96, crop_mode: 'manual', review_status: 'page_confirmed', manual_adjusted: true, reviewed_at: '2026-09-01T06:20:00.000Z',
        },
      ],
    }));

    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 12);
    await waitFor(() => expect(screen.queryByText(/已整组确认，可继续导出/)).toBeNull());
    expect(screen.queryByText('已确认 2 / 2')).toBeNull();
    expect(screen.getByRole('button', { name: '确认整组' })).toBeTruthy();
  });

  it('keeps group confirmation false for a mixed v2 prepare response', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.prepareReviewContext).mockImplementation(async (context, originals, resultRevision) => {
      const contextKey = await reviewContextKey(context);
      const records = originals.map((original, index) => reviewRecordFromOriginal(
        context,
        original,
        contextKey,
        resultRevision,
        index === 0 ? 'group_confirmed' : 'page_confirmed',
      ));
      return preparedReview(contextKey, resultRevision, originals, records, false);
    });

    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 12);
    await waitFor(() => expect(screen.queryByText('已确认 2 / 2')).toBeNull());
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();
    expect(screen.getByRole('button', { name: '确认整组' })).toBeTruthy();
  });

  it('keeps the newest page preview when selections change quickly', async () => {
    const user = userEvent.setup();
    let resolveFirst: ((value: ReturnType<typeof preview>) => void) | undefined;
    let resolveSecond: ((value: ReturnType<typeof preview>) => void) | undefined;
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page) => new Promise((resolve) => {
      if (page === 4) resolveFirst = resolve;
      if (page === 12) resolveSecond = resolve;
    }));

    render(<App />);
    await loadResults(user);
    await user.click(screen.getByText('第 12 页 / 片段 1'));
    resolveSecond?.(preview('/docs/source.pdf', 12));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    resolveFirst?.(preview('/docs/source.pdf', 4));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect((screen.getByAltText('PDF 页面预览') as HTMLImageElement).src).toContain('PAGE12');
    expect(screen.getByText('第 12 页 / 片段 1')).toBeTruthy();
  });

  it('deduplicates an in-flight physical-page preview and drops the cache after settle', async () => {
    const user = userEvent.setup();
    let resolvePage4: ((value: ReturnType<typeof preview>) => void) | undefined;
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page) => {
      if (page === 4) {
        return new Promise((resolve) => {
          resolvePage4 = resolve;
        });
      }
      return Promise.resolve(preview(path, page));
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 12 页 / 片段 1');
    await waitFor(() => expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.filter((call) => call[1] === 4)).toHaveLength(1));

    resolvePage4?.(preview('/docs/source.pdf', 4));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());

    await user.click(screen.getByText('第 12 页 / 片段 1'));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    await user.click(screen.getByText('第 4 页 / 片段 1'));
    await waitFor(() => expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.filter((call) => call[1] === 4)).toHaveLength(2));
    resolvePage4?.(preview('/docs/source.pdf', 4));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
  });

  it('maps threshold, null-rectangle, and low-confidence analysis states', async () => {
    const user = userEvent.setup();
    const matches = [match(4), match(12), match(16)];
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches,
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => ({
      status: 'ok',
      page,
      page_width: PAGE_WIDTH,
      page_height: PAGE_HEIGHT,
      selections: pageMatches.map((item) => ({
        match_rect: item,
        rect: page === 16 ? null : { x0: 0, y0: page === 12 ? 280 : 0, x1: PAGE_WIDTH, y1: page === 12 ? 500 : 220 },
        confidence: page === 4 ? 0.9 : page === 12 ? 0.7 : 0.69,
        slot: page === 16 ? null : 'receipt',
        evidence: page === 16 ? [] : ['geometry'],
        needs_review: page !== 4,
      })),
    }));

    render(<App />);
    await loadResults(user);
    expect(screen.getByRole('button', { name: /第 4 页.*已确认.*置信度90%/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /第 12 页.*需复核.*置信度70%/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /第 16 页.*已阻塞.*置信度69%/ })).toBeTruthy();
  });

  it('analyzes multiple hits on one page once and preserves match order', async () => {
    const user = userEvent.setup();
    const first = match(4, 20, 40);
    const second = match(4, 220, 140);
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [first, second],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockResolvedValue({
      status: 'ok',
      page: 4,
      page_width: PAGE_WIDTH,
      page_height: PAGE_HEIGHT,
      selections: [
        { match_rect: first, rect: { x0: 0, y0: 20, x1: 600, y1: 240 }, confidence: 0.95, slot: 'first', evidence: ['a'], needs_review: false },
        { match_rect: second, rect: { x0: 0, y0: 300, x1: 600, y1: 520 }, confidence: 0.95, slot: 'second', evidence: ['b'], needs_review: false },
      ],
    });

    render(<App />);
    await loadResults(user);
    expect(screen.getByText('第 4 页 / 片段 2')).toBeTruthy();
    expect(vi.mocked(localEngineAdapter.analyzePage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localEngineAdapter.analyzePage).mock.calls[0]?.[2]).toEqual([
      { x0: first.x0, y0: first.y0, x1: first.x1, y1: first.y1 },
      { x0: second.x0, y0: second.y0, x1: second.x1, y1: second.y1 },
    ]);
    await user.click(screen.getByText('第 4 页 / 片段 2'));
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('37.5%');
  });

  it('keeps same-page candidates pending after a transient preview failure and retries them', async () => {
    const user = userEvent.setup();
    const first = match(4, 20, 40);
    const second = match(4, 220, 140);
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [first, second],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockResolvedValue({
      status: 'ok',
      page: 4,
      page_width: PAGE_WIDTH,
      page_height: PAGE_HEIGHT,
      selections: [first, second].map((item, index) => ({
        match_rect: item,
        rect: { x0: 0, y0: index * 280, x1: PAGE_WIDTH, y1: index * 280 + 220 },
        confidence: 0.96,
        slot: index === 0 ? 'first' : 'second',
        evidence: ['geometry'],
        needs_review: false,
      })),
    });
    let previewCalls = 0;
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => {
      if (page === 4 && previewCalls++ === 0) throw new Error('temporary preview outage');
      return preview(path, page);
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 4 页 / 片段 2');
    await waitFor(() => expect(screen.getByText('temporary preview outage')).toBeTruthy());

    const rowsBeforeRetry = screen.getAllByRole('button', { name: /第 4 页 \/ 片段/ });
    expect(rowsBeforeRetry).toHaveLength(2);
    expect(rowsBeforeRetry.every((row) => !row.getAttribute('aria-label')?.includes('已阻塞'))).toBe(true);
    expect(screen.queryByText('无法获取真实页面尺寸，不能确认或裁剪')).toBeNull();

    await user.click(rowsBeforeRetry[1]!);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    const rowsAfterRetry = screen.getAllByRole('button', { name: /第 4 页 \/ 片段/ });
    expect(rowsAfterRetry.every((row) => !row.getAttribute('aria-label')?.includes('已阻塞'))).toBe(true);
  });

  it('keeps same-page hits from different PDFs in separate analysis groups', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(['/docs/a.pdf', '/docs/b.pdf']));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => ({
      status: 'ok',
      page_count: 20,
      source_sha256: path.endsWith('a.pdf') ? SECOND_SOURCE_SHA256 : THIRD_SOURCE_SHA256,
      matches: [match(4)],
    }));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => analysis(page, pageMatches, path.endsWith('a.pdf') ? 0 : 280));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    expect(await screen.findAllByText('第 4 页 / 片段 1')).toHaveLength(2);
    expect(vi.mocked(localEngineAdapter.analyzePage)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(localEngineAdapter.analyzePage).mock.calls.map((call) => call[0])).toEqual(['/docs/a.pdf', '/docs/b.pdf']);
  });

  it('updates only the selected segment and supports the full-page two-step confirmation', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    await user.click(screen.getByText('第 12 页 / 片段 1'));
    const editorBox = screen.getByLabelText('裁剪区域');
    await user.click(editorBox);
    await user.keyboard('{ArrowDown}');
    await user.click(screen.getByText('第 4 页 / 片段 1'));
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('0%');

    await user.click(screen.getByText('第 4 页 / 片段 1'));
    await user.click(screen.getByRole('button', { name: '保留整页' }));
    expect(screen.getByRole('button', { name: /第 4 页.*需复核/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '确认整组' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    await user.click(screen.getAllByRole('button', { name: '确认当前片段' })[0]);
    expect(screen.getByRole('button', { name: /第 4 页.*已确认/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '确认整组' }).some((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
    void editorBox;
  });

  it('rejects failed page analysis as one atomic failed analysis', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.analyzePage).mockRejectedValue(new Error('analysis unavailable'));
    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getAllByText(/1 个 PDF 未完成分析/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/第 4 页 \/ 片段/)).toBeNull();
    expect(screen.queryByText(/第 12 页 \/ 片段/)).toBeNull();
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();
    expect(screen.queryByText('已整组确认')).toBeNull();
  });

  it('does not commit partial geometry after failed page analysis and recovers on retry', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.analyzePage).mockRejectedValue(new Error('analysis unavailable'));
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4)],
    });
    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getAllByText(/1 个 PDF 未完成分析/).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByLabelText('裁剪区域')).toBeNull());
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();

    vi.mocked(localEngineAdapter.analyzePage).mockResolvedValue(analysis(4, [match(4)], 0));
    await user.click(screen.getByRole('button', { name: '重新分析整批' }));
    await screen.findByText('第 4 页 / 片段 1');
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect((screen.getByRole('button', { name: '保留整页' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: '保留整页' }));
    expect(screen.getByRole('button', { name: /第 4 页.*需复核/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认当前片段' }));
    expect(screen.getByRole('button', { name: /第 4 页.*已确认/ })).toBeTruthy();
  });

  it('limits concurrent page analysis while preserving all hit output', async () => {
    const user = userEvent.setup();
    const paths = Array.from({ length: 7 }, (_value, index) => `/docs/source-${index + 1}.pdf`);
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      const page = paths.indexOf(path) + 1;
      return {
        status: 'ok',
        page_count: 20,
        source_sha256: [SOURCE_SHA256, SECOND_SOURCE_SHA256, THIRD_SOURCE_SHA256][(page - 1) % 3]!,
        matches: [match(page)],
      };
    });
    let active = 0;
    let maximum = 0;
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => window.setTimeout(resolve, 5));
      active -= 1;
      return analysis(page, pageMatches, 0);
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getByText('第 7 页 / 片段 1')).toBeTruthy());
    expect(maximum).toBeLessThanOrEqual(3);
    expect(vi.mocked(localEngineAdapter.analyzePage)).toHaveBeenCalledTimes(paths.length);
    expect(within(screen.getByRole('region', { name: '审核导航' })).getAllByText(/第 \d+ 页 \/ 片段 1/)).toHaveLength(paths.length);
  });













  it('retains every matched full-page review record before bundle planning deduplicates physical pages', async () => {
    const user = userEvent.setup();
    const matches = [match(1, 40, 80), match(1, 40, 340), match(1, 40, 600)];
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches,
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => ({
      status: 'ok',
      page,
      page_width: PAGE_WIDTH,
      page_height: PAGE_HEIGHT,
      page_fully_matched: true,
      selections: pageMatches.map((item, index) => ({
        match_rect: item,
        rect: { x0: 0, y0: 80 + index * 260, x1: PAGE_WIDTH, y1: 220 + index * 260 },
        confidence: 0.96,
        slot: ['top', 'middle', 'bottom'][index] ?? 'receipt',
        evidence: ['geometry'],
        needs_review: false,
      })),
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getByText('第 1 页 / 片段 3')).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('0%');
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.height).toBe('100%');

    const renderCallsBeforeSamePageSelection = vi.mocked(localEngineAdapter.renderPage).mock.calls.length;
    await user.click(screen.getByText('第 1 页 / 片段 2'));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.length).toBe(renderCallsBeforeSamePageSelection);
    await user.click(screen.getByText('第 1 页 / 片段 3'));
    await waitFor(() => expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '确认整组' }));
    await waitFor(() => expect(confirmedPreviewAction().disabled).toBe(false));
    const saved = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.at(-1)![2];
    expect(saved).toHaveLength(3);
    expect(saved.every((row) => row.crop_mode === 'full_page' && row.review_status === 'group_confirmed')).toBe(true);

  });

  it('keeps large export payload pairing linear and deduplicates full pages in input order', () => {
    const segments = Array.from({ length: 240 }, (_value, index): ReviewSegment => {
      const sourcePage = Math.floor(index / 3) + 1;
      const segmentNo = index % 3 + 1;
      return {
        id: `large-segment-${index + 1}`,
        sourcePath: '/docs/large.pdf',
        sourceSha256: SOURCE_SHA256,
        sourcePage,
        segmentNo,
        matchRect: { x0: 20, y0: 20, x1: 100, y1: 44 },
        candidateRect: null,
        finalRect: null,
        pageWidth: PAGE_WIDTH,
        pageHeight: PAGE_HEIGHT,
        confidence: 0.96,
        slot: 'receipt',
        snapPoints: [],
        layoutFingerprint: `large-${index}`,
        mode: 'full_page',
        reviewStatus: 'confirmed',
        manualAdjusted: false,
      };
    });
    const matches = segments.map((segment, index) => ({
      source_path: segment.sourcePath,
      source_sha256: segment.sourceSha256,
      page: segment.sourcePage,
      matched_text: `matched-${index + 1}`,
      matched_field: `field-${index + 1}`,
      confidence: segment.confidence,
      x0: segment.matchRect.x0,
      y0: segment.matchRect.y0,
      x1: segment.matchRect.x1,
      y1: segment.matchRect.y1,
    }));

    const payload = buildExportPayloadForReviewSegments(segments, matches, '手续费');

    expect(payload.rowSeed).toHaveLength(240);
    expect(payload.rowSeed[137]).toMatchObject({
      source_page: segments[137]?.sourcePage,
      segment_no: segments[137]?.segmentNo,
      matched_field: 'field-138',
      matched_text: 'matched-138',
    });
    expect(payload.selections).toHaveLength(1);
    expect(payload.selections[0]?.segments).toHaveLength(80);
    expect(payload.selections[0]?.segments.map((segment) => segment.page_number)).toEqual(
      Array.from({ length: 80 }, (_value, index) => index + 1),
    );
  });

  it('exports compound evidence and final crop coordinates for each receipt row', () => {
    const candidateSegment: ReviewSegment = {
      id: 'compound-candidate',
      sourcePath: '/docs/compound.pdf',
      sourceSha256: SOURCE_SHA256,
      sourcePage: 4,
      segmentNo: 1,
      matchRect: { x0: 40, y0: 80, x1: 120, y1: 104 },
      candidateRect: { x0: 0, y0: 20, x1: PAGE_WIDTH, y1: 320 },
      finalRect: { x0: 4, y0: 24, x1: 590, y1: 312 },
      pageWidth: PAGE_WIDTH,
      pageHeight: PAGE_HEIGHT,
      confidence: 0.98,
      slot: 'receipt',
      snapPoints: [],
      layoutFingerprint: 'compound-candidate-layout',
      mode: 'candidate',
      reviewStatus: 'confirmed',
      manualAdjusted: false,
    };
    const fullPageSegment: ReviewSegment = {
      ...candidateSegment,
      id: 'compound-full-page',
      sourcePage: 5,
      segmentNo: 1,
      matchRect: { x0: 60, y0: 420, x1: 140, y1: 444 },
      candidateRect: null,
      finalRect: null,
      layoutFingerprint: 'compound-full-page-layout',
      mode: 'full_page',
    };
    const evidence = (page: number, queryId: string, role: 'include' | 'exclude', matchedText: string) => ({
      ...match(page),
      source_path: '/docs/compound.pdf',
      source_sha256: SOURCE_SHA256,
      query_id: queryId,
      role,
      matched_field: role === 'include' ? '交易对手' : '摘要',
      matched_text: matchedText,
    });
    const criteria: SearchCriteria = {
      include: ['示例实业', '华夏银行'],
      includeMode: 'all',
      exclude: ['退款'],
    };
    const candidateEvidence = [
      evidence(4, 'include-0', 'include', '交易对手：示例实业'),
      evidence(4, 'include-1', 'include', '开户行：华夏银行'),
    ];
    const fullPageEvidence = [
      evidence(5, 'include-0', 'include', '交易对手：示例实业'),
      evidence(5, 'exclude-0', 'exclude', '摘要：退款'),
    ];

    const payload = buildExportPayloadForReviewSegments(
      [candidateSegment, fullPageSegment],
      [
        candidateEvidence[0]!,
        fullPageEvidence[0]!,
      ],
      '包含全部：示例实业、华夏银行；排除任一：退款',
      {
        [candidateSegment.id]: candidateEvidence,
        [fullPageSegment.id]: fullPageEvidence,
      },
      criteria,
    );

    expect(payload.rowSeed).toHaveLength(2);
    expect(payload.rowSeed[0]).toMatchObject({
      matched_keywords: '示例实业、华夏银行',
      matched_text: '交易对手：示例实业、开户行：华夏银行',
      crop_x0: 4,
      crop_y0: 24,
      crop_x1: 590,
      crop_y1: 312,
    });
    expect(payload.rowSeed[0]?.matched_keywords).not.toContain('退款');
    expect(payload.rowSeed[1]).toMatchObject({
      matched_keywords: '示例实业',
      matched_text: '交易对手：示例实业',
      crop_x0: 0,
      crop_y0: 0,
      crop_x1: PAGE_WIDTH,
      crop_y1: PAGE_HEIGHT,
    });
  });

  it('does not invent unmatched compound keywords when evidence lacks query IDs', () => {
    const segment: ReviewSegment = {
      id: 'compound-without-query-id',
      sourcePath: '/docs/compound.pdf',
      sourceSha256: SOURCE_SHA256,
      sourcePage: 4,
      segmentNo: 1,
      matchRect: { x0: 40, y0: 80, x1: 120, y1: 104 },
      candidateRect: { x0: 0, y0: 20, x1: PAGE_WIDTH, y1: 320 },
      finalRect: { x0: 0, y0: 20, x1: PAGE_WIDTH, y1: 320 },
      pageWidth: PAGE_WIDTH,
      pageHeight: PAGE_HEIGHT,
      confidence: 0.98,
      slot: 'receipt',
      snapPoints: [],
      layoutFingerprint: 'compound-without-query-id-layout',
      mode: 'candidate',
      reviewStatus: 'confirmed',
      manualAdjusted: false,
    };
    const evidence = {
      ...match(4),
      source_path: segment.sourcePath,
      source_sha256: SOURCE_SHA256,
      role: 'include' as const,
      matched_text: '交易对手：示例实业',
    };

    const payload = buildExportPayloadForReviewSegments(
      [segment],
      [evidence],
      '包含任一：示例实业、华夏银行',
      { [segment.id]: [evidence] },
      { include: ['示例实业', '华夏银行'], includeMode: 'any', exclude: [] },
    );

    expect(payload.rowSeed[0]?.matched_keywords).toBe('');
    expect(payload.rowSeed[0]?.matched_keywords).not.toContain('华夏银行');
  });

  it('pairs navigator matches by source page identity instead of array position', () => {
    const segment = (sourcePage: number): ReviewSegment => ({
      id: `segment-${sourcePage}`,
      sourcePath: '/docs/source.pdf',
      sourceSha256: SOURCE_SHA256,
      sourcePage,
      segmentNo: 1,
      matchRect: { x0: 40, y0: 80, x1: 120, y1: 104 },
      candidateRect: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: PAGE_HEIGHT },
      finalRect: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: PAGE_HEIGHT },
      pageWidth: PAGE_WIDTH,
      pageHeight: PAGE_HEIGHT,
      confidence: 0.96,
      slot: 'receipt',
      snapPoints: [],
      layoutFingerprint: `segment-${sourcePage}`,
      mode: 'candidate',
      reviewStatus: 'confirmed',
      manualAdjusted: false,
    });
    const page4 = { ...match(4), source_path: '/docs/source.pdf', source_sha256: SOURCE_SHA256, matched_text: 'page-4' };
    const page12 = { ...match(12), source_path: '/docs/source.pdf', source_sha256: SOURCE_SHA256, matched_text: 'page-12' };

    const result = buildReviewMatchPairs([page12, page4], [segment(4), segment(12)]);

    expect(result.error).toBeNull();
    expect(result.pairs.map(({ segment: item }) => item.sourcePage)).toEqual([4, 12]);
    expect(result.pairs.map(({ hit }) => hit.matched_text)).toEqual(['page-4', 'page-12']);

    const firstSamePage = segment(1);
    const secondSamePage = {
      ...segment(1),
      id: 'segment-1-2',
      segmentNo: 2,
      matchRect: { x0: 200, y0: 80, x1: 280, y1: 104 },
    };
    const firstHit = { ...match(1, 40, 80), source_path: '/docs/source.pdf', source_sha256: SOURCE_SHA256, matched_text: 'first' };
    const secondHit = { ...match(1, 200, 80), source_path: '/docs/source.pdf', source_sha256: SOURCE_SHA256, matched_text: 'second' };
    const reordered = buildReviewMatchPairs([secondHit, firstHit], [firstSamePage, secondSamePage]);
    expect(reordered.pairs).toEqual([]);
    expect(reordered.error).toContain('定位区域不一致');
  });







  it('preserves committed results while editing draft criteria and freezes review actions', async () => {
    const user = userEvent.setup();

    render(<App />);
    await loadResults(user);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    const page4Button = screen.getByRole('button', { name: /第 4 页 \/ 片段 1/ }) as HTMLButtonElement;
    const crop = screen.getByLabelText('裁剪区域') as HTMLElement;
    const cropStyle = crop.getAttribute('style');
    const previousButton = screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement;
    const zoomInButton = screen.getByRole('button', { name: '放大' }) as HTMLButtonElement;
    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '示例实业' } });

    expect(screen.getByRole('button', { name: /第 4 页 \/ 片段 1/ })).toBe(page4Button);
    expect(page4Button.getAttribute('aria-current')).toBe('true');
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).getAttribute('style')).toBe(cropStyle);
    expect(page4Button.disabled).toBe(false);
    expect(previousButton.disabled).toBe(false);
    expect(zoomInButton.disabled).toBe(false);
    expect((screen.getByRole('button', { name: '确认当前片段' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('collapses a successful search into one compact summary', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);

    expect(screen.queryByRole('textbox', { name: '包含关键词 1' })).toBeNull();
    expect(screen.getByRole('button', { name: '修改搜索条件' })).toBeTruthy();
    expect(screen.getByText('包含全部：手续费')).toBeTruthy();
    expect(screen.queryByText('SEARCH & REVIEW')).toBeNull();
    expect(screen.getAllByText('包含全部：手续费')).toHaveLength(1);
    expect(screen.queryByText('REVIEW NAVIGATOR')).toBeNull();
    expect(screen.queryByText(/^全部 2$/)).toBeNull();
  });

  it('keeps previous results navigable but frozen while editing and restores them on cancel', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    const selected = reviewRow(/第 4 页 \/ 片段 1/) as HTMLButtonElement;

    const searchPanel = screen.getByRole('region', { name: '搜索条件' });
    await user.click(within(searchPanel).getByRole('button', { name: '修改搜索条件' }));
    const input = within(searchPanel).getByRole('textbox', { name: '包含关键词 1' });
    await user.clear(input);
    await user.type(input, '示例实业');

    expect(screen.getByText('上次结果')).toBeTruthy();
    expect(selected.disabled).toBe(false);
    expect((screen.getByRole('button', { name: '确认当前片段' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(within(searchPanel).getByRole('button', { name: '取消修改' }));
    expect(screen.queryByRole('textbox', { name: '包含关键词 1' })).toBeNull();
    expect(screen.queryByText('上次结果')).toBeNull();
    expect(screen.getByText('包含全部：手续费')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('offers recovery after a failed rerun without discarding the old result', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    vi.mocked(localEngineAdapter.search).mockRejectedValueOnce(new Error('rerun unavailable'));

    const searchPanel = screen.getByRole('region', { name: '搜索条件' });
    await user.click(within(searchPanel).getByRole('button', { name: '修改搜索条件' }));
    await user.click(within(searchPanel).getByRole('button', { name: '应用并重新分析' }));

    expect((await screen.findAllByText(/1 个 PDF 未完成分析/)).length).toBeGreaterThan(0);
    expect(reviewRow(/第 4 页 \/ 片段 1/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '恢复上次条件' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '恢复上次条件' }));
    expect(screen.queryByRole('textbox', { name: '包含关键词 1' })).toBeNull();
    expect(screen.getByText('包含全部：手续费')).toBeTruthy();
  });

  it('shows source-aware guidance instead of review filters before the first applied search', () => {
    render(<App />);
    expect(screen.getByText('请先选择 PDF 或文件夹，再开始分析。')).toBeTruthy();
    expect(screen.queryByRole('group', { name: '审核筛选' })).toBeNull();
    expect((screen.getByRole('button', { name: '开始分析' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers search editing beside a committed zero-hit result', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValueOnce({
      status: 'ok', page_count: 20, source_sha256: SOURCE_SHA256, matches: [],
    });
    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    const navigator = await screen.findByRole('region', { name: '审核导航' });
    const searchPanel = screen.getByRole('region', { name: '搜索条件' });
    expect(within(navigator).getByText('未找到符合条件的回单')).toBeTruthy();
    expect(within(searchPanel).getByRole('button', { name: '修改搜索条件' })).toBeTruthy();
    await user.click(within(navigator).getByRole('button', { name: '修改搜索条件' }));
    const input = within(searchPanel).getByRole('textbox', { name: '包含关键词 1' });
    await user.clear(input);
    await user.type(input, '保留这个草稿');
    expect(within(navigator).queryByRole('button', { name: '修改搜索条件' })).toBeNull();
    expect((input as HTMLInputElement).value).toBe('保留这个草稿');
  });

  it('ignores a duplicate captured submit handler while a same-task rerun is active', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());

    let resolveOlder: ((result: {
      status: 'ok';
      page_count: number;
      source_sha256: string;
      matches: ReturnType<typeof match>[];
    }) => void) | undefined;
    const older = new Promise<{
      status: 'ok';
      page_count: number;
      source_sha256: string;
      matches: ReturnType<typeof match>[];
    }>((resolve) => {
      resolveOlder = resolve;
    });
    vi.mocked(localEngineAdapter.search)
      .mockImplementationOnce(() => older)
      .mockResolvedValueOnce({
        status: 'ok',
        page_count: 20,
        source_sha256: SOURCE_SHA256,
        matches: [match(9)],
      });

    try {
      const input = await openSearchEditor(user);
      await user.clear(input);
      await user.type(input, '同一任务草稿');
      const form = input.closest('form');
      expect(form).toBeTruthy();
      const reactPropsKey = Object.keys(form as HTMLFormElement).find((key) => key.startsWith('__reactProps$'));
      const reactProps = reactPropsKey ? (form as HTMLFormElement & Record<string, { onSubmit?: (event: { preventDefault: () => void }) => void }>)[reactPropsKey] : undefined;
      expect(reactProps?.onSubmit).toBeTypeOf('function');
      const event = { preventDefault: () => undefined };
      act(() => {
        reactProps!.onSubmit!(event);
      });
      await waitFor(() => expect(vi.mocked(localEngineAdapter.search).mock.calls.length).toBeGreaterThanOrEqual(2));
      // Reuse a handler captured before React disabled the form. The synchronous
      // guard must reject it even though its captured UI props still allow submit.
      act(() => {
        reactProps!.onSubmit!(event);
      });
      expect(localEngineAdapter.search).toHaveBeenCalledTimes(2);
      await act(async () => {
        resolveOlder?.({
          status: 'ok',
          page_count: 20,
          source_sha256: SOURCE_SHA256,
          matches: [match(12)],
        });
        await older;
      });

      // Page 12 was already present in the previous committed result. Wait for
      // the rerun itself to finish before using the summary as the next edit
      // entry point; v2 preparation is asynchronous after the search response.
      await waitFor(() => {
        const modify = screen.getByRole('button', { name: '修改搜索条件' });
        expect((modify as HTMLButtonElement).disabled).toBe(false);
      });
      await waitFor(() => {
        expect(reviewRow(/第 12 页 \/ 片段 1/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /第 4 页 \/ 片段 1/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /第 9 页 \/ 片段 1/ })).toBeNull();
      });
      const finalInput = await openSearchEditor(user);
      expect(finalInput).toBeTruthy();
      await waitFor(() => expect(screen.getByRole('button', { name: '应用并重新分析' })).toBeTruthy());
      await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
      expect(await screen.findByRole('button', { name: /第 9 页 \/ 片段 1/ })).toBeTruthy();
      expect(localEngineAdapter.search).toHaveBeenCalledTimes(3);
    } finally {
      await act(async () => {
        resolveOlder?.({
          status: 'ok',
          page_count: 20,
          source_sha256: SOURCE_SHA256,
          matches: [match(12)],
        });
        await older;
      });
    }
  });

  it('keeps committed results after an ordinary rerun failure and replaces them on retry success', async () => {
    const user = userEvent.setup();

    render(<App />);
    await loadResults(user);
    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '示例实业' } });
    vi.mocked(localEngineAdapter.search).mockRejectedValueOnce(new Error('rerun unavailable'));

    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));

    expect((await screen.findAllByText(/1 个 PDF 未完成分析/)).length).toBeGreaterThan(0);
    expect((screen.getByRole('textbox', { name: '包含关键词 1' }) as HTMLInputElement).value).toBe('示例实业');
    expect(screen.getByRole('button', { name: /第 4 页 \/ 片段 1/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);

    vi.mocked(localEngineAdapter.search).mockResolvedValueOnce({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(9)],
    });
    await user.click(screen.getByRole('button', { name: '重新分析整批' }));
    expect(await screen.findByRole('button', { name: /第 9 页 \/ 片段 1/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /第 4 页 \/ 片段 1/ })).toBeNull();
  });

  it('atomically commits zero-hit reruns and removes the previous review result', async () => {
    const user = userEvent.setup();

    render(<App />);
    await loadResults(user);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '无命中词' } });
    vi.mocked(localEngineAdapter.search).mockResolvedValueOnce({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [],
    });

    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));

    expect(await screen.findByText('未找到符合条件的回单')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /第 4 页 \/ 片段 1/ })).toBeNull();
    expect(screen.queryByLabelText('裁剪区域')).toBeNull();
    expect(screen.queryByRole('button', { name: '打开结果目录' })).toBeNull();
    expect(screen.getByRole('region', { name: '当前审核操作' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('attributes a rerun source_changed rejection to the source that failed', async () => {
    const user = userEvent.setup();
    let rerunning = false;
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValueOnce(pickerResult([
      '/docs/a.pdf',
      '/docs/b.pdf',
    ]));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      if (rerunning && path === '/docs/b.pdf') throw sourceChangedError('第二来源已变化，请重新分析');
      const first = path === '/docs/a.pdf';
      return {
        status: 'ok' as const,
        page_count: 20,
        source_sha256: first ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
        matches: [match(first ? 4 : 12)],
      };
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => ({
      ...preview(path, page),
      page_count: 20,
      source_sha256: path === '/docs/a.pdf' ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: /a\.pdf，.*第 4 页 \/ 片段 1/ });
    await screen.findByRole('button', { name: /b\.pdf，.*第 12 页 \/ 片段 1/ });

    rerunning = true;
    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '第二来源重跑' } });
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await screen.findAllByText('第二来源已变化，请重新分析');

    const sourceList = screen.getByRole('list', { name: '当前来源文件' });
    expect(within(sourceList).getByRole('button', { name: /^a\.pdf/ }).textContent).toContain('文档已读取');
    expect(within(sourceList).getByRole('button', { name: /^b\.pdf/ }).textContent).toContain('源文件已变化');
    expect(screen.getByRole('button', { name: /a\.pdf，.*第 4 页 \/ 片段 1/ }).getAttribute('aria-label')).not.toContain('已阻塞');
    expect(screen.getByRole('button', { name: /b\.pdf，.*第 12 页 \/ 片段 1/ }).getAttribute('aria-label')).toContain('已阻塞');
  });

  it('blocks every source when a search chunk reports concurrent source_changed failures', async () => {
    const user = userEvent.setup();
    let rerunning = false;
    let rejectRerunA: ((reason?: unknown) => void) | undefined;
    let rejectRerunB: ((reason?: unknown) => void) | undefined;
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValueOnce(pickerResult([
      '/docs/a.pdf',
      '/docs/b.pdf',
    ]));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      const first = path === '/docs/a.pdf';
      if (rerunning) {
        return new Promise((_resolve, reject) => {
          if (first) rejectRerunA = reject;
          else rejectRerunB = reject;
        });
      }
      return {
        status: 'ok' as const,
        page_count: 20,
        source_sha256: first ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
        matches: [match(first ? 4 : 12)],
      };
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page, sourceSha256) => ({
      ...preview(path, page),
      page_count: 20,
      source_sha256: sourceSha256,
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: /a\.pdf，.*第 4 页 \/ 片段 1/ });
    await screen.findByRole('button', { name: /b\.pdf，.*第 12 页 \/ 片段 1/ });

    rerunning = true;
    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '两个来源同时变化' } });
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await waitFor(() => {
      expect(rejectRerunA).toBeTypeOf('function');
      expect(rejectRerunB).toBeTypeOf('function');
    });

    await act(async () => {
      rejectRerunA?.(sourceChangedError('A 来源已变化，请重新分析'));
      rejectRerunB?.(sourceChangedError('B 来源已变化，请重新分析'));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getAllByText('A 来源已变化，请重新分析')).toBeTruthy());
    expect(screen.getAllByText('源文件已变化，请重新分析')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /a\.pdf，.*第 4 页 \/ 片段 1.*已阻塞/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /b\.pdf，.*第 12 页 \/ 片段 1.*已阻塞/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('prioritizes source_changed over an ordinary failure in one search chunk', async () => {
    const user = userEvent.setup();
    let rerunning = false;
    let rejectRerunA: ((reason?: unknown) => void) | undefined;
    let rejectRerunB: ((reason?: unknown) => void) | undefined;
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValueOnce(pickerResult([
      '/docs/a.pdf',
      '/docs/b.pdf',
    ]));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      const first = path === '/docs/a.pdf';
      if (rerunning) {
        return new Promise((_resolve, reject) => {
          if (first) rejectRerunA = reject;
          else rejectRerunB = reject;
        });
      }
      return {
        status: 'ok' as const,
        page_count: 20,
        source_sha256: first ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
        matches: [match(first ? 4 : 12)],
      };
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page, sourceSha256) => ({
      ...preview(path, page),
      page_count: 20,
      source_sha256: sourceSha256,
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: /a\.pdf，.*第 4 页 \/ 片段 1/ });
    await screen.findByRole('button', { name: /b\.pdf，.*第 12 页 \/ 片段 1/ });

    rerunning = true;
    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '混合批次来源变化' } });
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await waitFor(() => {
      expect(rejectRerunA).toBeTypeOf('function');
      expect(rejectRerunB).toBeTypeOf('function');
    });

    await act(async () => {
      rejectRerunB?.(new Error('B 来源搜索失败'));
      rejectRerunA?.(sourceChangedError('A 来源已变化，请重新分析'));
      await Promise.resolve();
    });

    expect(await screen.findAllByText('A 来源已变化，请重新分析')).toBeTruthy();
    const sourceList = screen.getByRole('list', { name: '当前来源文件' });
    expect(within(sourceList).getByRole('button', { name: /^a\.pdf/ }).textContent).toContain('源文件已变化');
    expect(within(sourceList).getByRole('button', { name: /^b\.pdf/ }).textContent).toContain('文档已读取');
    expect(screen.getByRole('button', { name: /a\.pdf，.*第 4 页 \/ 片段 1/ }).getAttribute('aria-label')).toContain('已阻塞');
    expect(screen.getByRole('button', { name: /b\.pdf，.*第 12 页 \/ 片段 1/ }).getAttribute('aria-label')).not.toContain('已阻塞');
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '重新分析整批' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps committed results when a source changes during rerun preparation', async () => {
    const user = userEvent.setup();
    let rerunning = false;
    let rejectBPreview: ((reason?: unknown) => void) | undefined;
    let releaseRerunAnalysis: ((value: ReturnType<typeof analysis>) => void) | undefined;
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValueOnce(pickerResult([
      '/docs/a.pdf',
      '/docs/b.pdf',
    ]));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      const first = path === '/docs/a.pdf';
      if (rerunning) {
        return {
          status: 'ok' as const,
          page_count: 20,
          source_sha256: first ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
          matches: first ? [match(9)] : [],
        };
      }
      return {
        status: 'ok' as const,
        page_count: 20,
        source_sha256: first ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
        matches: [match(first ? 4 : 12)],
      };
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => {
      if (rerunning && path === '/docs/a.pdf') {
        return new Promise((resolve) => {
          releaseRerunAnalysis = resolve;
        });
      }
      return analysis(page, pageMatches, page === 4 ? 0 : 280);
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page) => {
      if (path === '/docs/b.pdf') {
        return new Promise((_resolve, reject) => {
          rejectBPreview = reject;
        });
      }
      return Promise.resolve({ ...preview(path, page), page_count: 20 });
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: /a\.pdf，.*第 4 页 \/ 片段 1/ });
    await screen.findByRole('button', { name: /b\.pdf，.*第 12 页 \/ 片段 1/ });
    await waitFor(() => expect(rejectBPreview).toBeTypeOf('function'));

    rerunning = true;
    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '重跑期间变化' } });
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await waitFor(() => expect(releaseRerunAnalysis).toBeTypeOf('function'));

    await act(async () => {
      rejectBPreview?.(sourceChangedError('B 来源在重跑期间变化'));
      await Promise.resolve();
    });
    await act(async () => {
      releaseRerunAnalysis?.(analysis(9, [match(9)], 280));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole('button', { name: /b\.pdf，.*第 12 页 \/ 片段 1.*已阻塞/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: /a\.pdf，.*第 4 页 \/ 片段 1/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /第 9 页 \/ 片段 1/ })).toBeNull();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();
    expect((screen.getByRole('button', { name: '重新分析整批' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('retains committed results and exits running after a global zero-hit integrity race', async () => {
    const user = userEvent.setup();
    let rerunning = false;
    let rejectBPreview: ((reason?: unknown) => void) | undefined;
    let resolveRerunBSearch: ((value: {
      status: 'ok';
      page_count: number;
      source_sha256: string;
      matches: never[];
    }) => void) | undefined;
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValueOnce(pickerResult([
      '/docs/a.pdf',
      '/docs/b.pdf',
    ]));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      const first = path === '/docs/a.pdf';
      if (rerunning && !first) {
        return new Promise((resolve) => {
          resolveRerunBSearch = resolve;
        });
      }
      return {
        status: 'ok' as const,
        page_count: 20,
        source_sha256: first ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
        matches: rerunning ? [] : [match(first ? 4 : 12)],
      };
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page) => {
      if (path === '/docs/b.pdf') {
        return new Promise((_resolve, reject) => {
          rejectBPreview = reject;
        });
      }
      return Promise.resolve({ ...preview(path, page), page_count: 20 });
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: /a\.pdf，.*第 4 页 \/ 片段 1/ });
    await screen.findByRole('button', { name: /b\.pdf，.*第 12 页 \/ 片段 1/ });
    await waitFor(() => expect(rejectBPreview).toBeTypeOf('function'));

    rerunning = true;
    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '全量零命中' } });
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await waitFor(() => expect(resolveRerunBSearch).toBeTypeOf('function'));

    await act(async () => {
      rejectBPreview?.(sourceChangedError('B 来源在零命中重跑期间变化'));
      await Promise.resolve();
    });
    await act(async () => {
      resolveRerunBSearch?.({
        status: 'ok',
        page_count: 20,
        source_sha256: THIRD_SOURCE_SHA256,
        matches: [],
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText('源文件已变化，请重新分析')).toBeTruthy());
    expect(screen.getByRole('button', { name: /a\.pdf，.*第 4 页 \/ 片段 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /b\.pdf，.*第 12 页 \/ 片段 1.*已阻塞/ })).toBeTruthy();
    expect(screen.queryByText('未找到符合条件的回单')).toBeNull();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();
    expect(screen.getByRole('button', { name: '重新分析整批' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '重新分析整批' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('rerenders the source preview after consecutive zero-hit commits', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 2,
      source_sha256: SOURCE_SHA256,
      matches: [],
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => ({
      ...preview(path, page),
      page_count: 2,
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    await screen.findByAltText('source.pdf 第 1 页');
    const renderCountAfterFirstCommit = vi.mocked(localEngineAdapter.renderPage).mock.calls.length;

    await openSearchEditor(user);
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    await waitFor(() => expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.length).toBeGreaterThan(renderCountAfterFirstCommit));
    expect(await screen.findByAltText('source.pdf 第 1 页')).toBeTruthy();
  });

  it('recovers a queued zero-hit preview after a failed rerun advances the preview epoch', async () => {
    const user = userEvent.setup();
    let searchCalls = 0;
    const releasePreview = new Map<number, () => void>();
    const pendingPreviewReleases: Array<() => void> = [];
    vi.mocked(localEngineAdapter.search).mockImplementation(async () => {
      if (searchCalls++ > 0) throw new Error('rerun unavailable');
      return {
        status: 'ok' as const,
        page_count: 4,
        source_sha256: SOURCE_SHA256,
        matches: [],
      };
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page, sourceSha256) => {
      if (page <= 3) {
        return new Promise((resolve) => {
          const release = () => resolve({
            ...preview(path, page),
            page_count: 4,
            source_sha256: sourceSha256,
          });
          pendingPreviewReleases.push(release);
          releasePreview.set(page, release);
        });
      }
      return Promise.resolve({ ...preview(path, page), page_count: 4, source_sha256: sourceSha256 });
    });

    try {
      render(<App />);
      await choosePdf(user);
      await startAnalysis(user);
      await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });

      // Fill each engine slot explicitly before asking for a queued fourth page.
      await waitFor(() => expect(releasePreview.has(1)).toBe(true));
      const pageInput = screen.getByRole('textbox', { name: '当前 PDF 页码' });
      for (const page of [2, 3, 4]) {
        await user.clear(pageInput);
        await user.type(pageInput, `${page}{Enter}`);
        if (page <= 3) await waitFor(() => expect(releasePreview.has(page)).toBe(true));
      }
      await waitFor(() => expect(releasePreview.size, JSON.stringify({
        pages: [...releasePreview.keys()],
        calls: vi.mocked(localEngineAdapter.renderPage).mock.calls.map((call) => call[1]),
      })).toBe(3));

      await openSearchEditor(user);
      await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
      await act(async () => {
        pendingPreviewReleases.forEach((resolve) => resolve());
        await Promise.resolve();
      });

      expect((await screen.findAllByText(/1 个 PDF 未完成分析/)).length).toBeGreaterThan(0);
      expect(await screen.findByAltText('source.pdf 第 4 页')).toBeTruthy();
      expect(screen.queryByText('正在渲染…')).toBeNull();
    } finally {
      // Never leave mock requests occupying the module-wide engine semaphore.
      cleanup();
      await act(async () => {
        pendingPreviewReleases.forEach((resolve) => resolve());
        await Promise.resolve();
      });
    }
  });

  it('blocks old results when a rerun reports source_changed without saving them', async () => {
    const user = userEvent.setup();

    render(<App />);
    await loadResults(user);
    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '示例实业' } });
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockClear();
    vi.mocked(localEngineAdapter.search).mockRejectedValueOnce(sourceChangedError());

    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));

    expect((await screen.findAllByText('源文件已变化，请重新分析')).length).toBeGreaterThan(0);
    const page4Button = screen.getByRole('button', { name: /第 4 页 \/ 片段 1/ }) as HTMLButtonElement;
    expect(page4Button.getAttribute('aria-current')).toBe('true');
    expect(page4Button.textContent).toContain('已阻塞');
    expect((screen.getByRole('button', { name: '确认当前片段' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('ignores a late older rerun after a newer source task commits', async () => {
    const user = userEvent.setup();
    type SearchResponse = {
      status: 'ok';
      page_count: number;
      source_sha256: string;
      matches: ReturnType<typeof match>[];
    };
    let resolveOlderSearch: ((result: SearchResponse) => void) | undefined;
    const older = new Promise<SearchResponse>((resolve) => {
      resolveOlderSearch = resolve;
    });

    render(<App />);
    await loadResults(user);
    vi.mocked(localEngineAdapter.search).mockImplementationOnce(() => older);

    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: 'B' } });
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await user.click(screen.getByRole('button', { name: /第 12 页 \/ 片段 1/ }));
    expect(screen.getByRole('button', { name: /第 12 页 \/ 片段 1/ }).getAttribute('aria-current')).toBe('true');
    expect((screen.getByRole('button', { name: '确认当前片段' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValueOnce(pickerResult(['/docs/c.pdf']));
    await user.click(screen.getByRole('button', { name: '＋ 新建任务' }));
    await waitFor(() => expect(screen.getByText('c.pdf')).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: '包含关键词 1' }), { target: { value: 'C' } });
    vi.mocked(localEngineAdapter.search).mockResolvedValueOnce({
      status: 'ok',
      page_count: 20,
      source_sha256: SECOND_SOURCE_SHA256,
      matches: [match(9)],
    });
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    expect(await screen.findByRole('button', { name: /第 9 页 \/ 片段 1/ })).toBeTruthy();

    const currentFeedback = screen.getByRole('region', { name: '本轮分析' }).textContent;
    await act(async () => {
      resolveOlderSearch?.({
        status: 'ok',
        page_count: 20,
        source_sha256: SOURCE_SHA256,
        matches: [match(12)],
      });
      await older;
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /第 12 页 \/ 片段 1/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /第 4 页 \/ 片段 1/ })).toBeNull();
      expect(screen.getByRole('button', { name: /c\.pdf，.*第 9 页 \/ 片段 1/ })).toBeTruthy();
    });
    expect(screen.getByRole('region', { name: '本轮分析' }).textContent).toBe(currentFeedback);
    expect(screen.queryByRole('list', { name: '上一轮分析失败明细' })).toBeNull();
  });



  it('rejects missing source SHA before committing any review result', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: undefined as unknown as string,
      matches: [match(4), match(12)],
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getByText('本地搜索失败：搜索响应的源 PDF SHA-256 无效。')).toBeTruthy());
    expect(screen.queryByText(/第 4 页 \/ 片段/)).toBeNull();
    expect(localEngineAdapter.exportIndex).not.toHaveBeenCalled();
  });

  it('keeps invalid hits blocked and never sends invalid pages or rectangles to analysis', async () => {
    const user = userEvent.setup();
    const reverse = { ...match(2, 80, 80), x0: 80, x1: 40 };
    const outside = { ...match(2, 500, 80), x1: 700 };
    const valid = match(2, 40, 120);
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 5,
      source_sha256: SOURCE_SHA256,
      matches: [match(0), reverse, outside, valid],
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => ({
      ...preview(path, page),
      page_count: 5,
    }));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => analysis(page, pageMatches, 0));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getAllByText(/命中数据无效/).length).toBeGreaterThan(0));
    expect(vi.mocked(localEngineAdapter.analyzePage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localEngineAdapter.analyzePage).mock.calls[0]?.[1]).toBe(2);
    expect(vi.mocked(localEngineAdapter.analyzePage).mock.calls[0]?.[2]).toEqual([
      { x0: outside.x0, y0: outside.y0, x1: outside.x1, y1: outside.y1 },
      { x0: valid.x0, y0: valid.y0, x1: valid.x1, y1: valid.y1 },
    ]);
    expect(screen.getAllByText(/命中数据无效/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /已阻塞/ })).toHaveLength(1);
    expect(screen.getByText('命中结果缺少有效的来源路径或页码，无法安全配对。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /第 0 页/ })).toBeNull();
    expect((screen.getByRole('button', { name: '保留整页' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('button', { name: '确认整组' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it('rejects a preview response for the wrong page without changing the selected page state', async () => {
    const user = userEvent.setup();
    let page4PreviewCount = 0;
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => {
      if (page === 4 && page4PreviewCount++ === 1) {
        return {
          ...preview(path, page),
          page: 12,
          image_data: `data:image/png;base64,WRONG${page}`,
        };
      }
      return preview(path, page);
    });

    render(<App />);
    await loadResults(user);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '保留整页' }));
    await user.click(screen.getByRole('button', { name: '确认当前片段' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /第 4 页.*已确认.*人工调整/ })).toBeTruthy());
    await user.click(screen.getByText('第 12 页 / 片段 1'));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '确认整组' }));
    expect(confirmedPreviewAction().disabled).toBe(false);
    await user.click(screen.getByText('第 4 页 / 片段 1'));
    await waitFor(() => expect(screen.getAllByText('页面预览页码不匹配，已拒绝显示。').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByLabelText('裁剪区域')).toBeNull());
    expect(screen.queryByRole('img', { name: /source\.pdf 第 \d+ 页/ })).toBeNull();
    expect(screen.getByRole('button', { name: /第 4 页.*已确认.*人工调整.*预览校验失败/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: '保留整页' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认当前片段' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryAllByText('已整组确认，可继续导出。')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();

    const page4RenderCallsBeforeRetry = vi.mocked(localEngineAdapter.renderPage).mock.calls.filter((call) => call[1] === 4).length;
    await user.click(screen.getByRole('button', { name: '重试页面预览' }));
    await waitFor(() => expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.filter((call) => call[1] === 4).length).toBeGreaterThan(page4RenderCallsBeforeRetry));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect(screen.getByRole('button', { name: /第 4 页.*已确认.*人工调整/ })).toBeTruthy();
  });

  it('gates group confirmation and export until every preview is validated', async () => {
    const user = userEvent.setup();
    let resolvePreview: ((value: ReturnType<typeof preview>) => void) | undefined;
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4)],
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(() => new Promise((resolve) => {
      resolvePreview = resolve;
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 4 页 / 片段 1');
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();

    resolvePreview?.(preview('/docs/source.pdf', 4));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: '确认整组' }));
    expect((screen.getByRole('button', { name: /生成 PDF 导出预览/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('auto-validates every hit page so group confirmation does not require page-by-page clicks', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    await waitFor(() => expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false));
    expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([4, 12]));
    await user.click(screen.getByRole('button', { name: '确认整组' }));
    await waitFor(() => expect(confirmedPreviewAction().disabled).toBe(false));
    expect((screen.getByRole('button', { name: /生成 PDF 导出预览/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('blocks a confirmed segment when preview dimensions differ from analysis dimensions', async () => {
    const user = userEvent.setup();
    let page4PreviewCount = 0;
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => {
      if (page === 4 && page4PreviewCount++ > 0) {
        return { ...preview(path, page), page_width: 640, image_data: 'data:image/png;base64,MISMATCH' };
      }
      return preview(path, page);
    });

    render(<App />);
    await loadResults(user);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    await validatePreviewForPage(user, 12);
    await user.click(screen.getByRole('button', { name: '确认整组' }));
    expect(confirmedPreviewAction().disabled).toBe(false);
    await user.click(screen.getByText('第 12 页 / 片段 1'));
    await user.click(screen.getByText('第 4 页 / 片段 1'));
    await waitFor(() => expect(screen.getAllByText('页面尺寸与分析结果不一致，已阻止确认。').length).toBeGreaterThan(0));
    expect(screen.queryByLabelText('裁剪区域')).toBeNull();
    expect(screen.getByAltText('source.pdf 第 4 页')).toBeTruthy();
    expect(screen.getByRole('button', { name: /第 4 页.*已阻塞/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryAllByText('已整组确认，可继续导出。')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();
  });

  it('rejects a preview whose page count cannot contain the requested page', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => ({
      ...preview(path, page),
      page_count: page === 12 ? 5 : 20,
    }));

    render(<App />);
    await loadResults(user);
    await user.click(screen.getByText('第 12 页 / 片段 1'));
    await waitFor(() => expect(screen.getAllByText('页面预览页数与搜索结果不一致，已阻止确认。').length).toBeGreaterThan(0));
    expect(screen.queryByLabelText('裁剪区域')).toBeNull();
    expect(screen.getByRole('button', { name: /第 12 页.*已阻塞/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('rejects a preview page count that differs from the search response', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => ({
      ...preview(path, page),
      page_count: 19,
    }));

    render(<App />);
    await loadResults(user);
    await waitFor(() => expect(screen.getAllByText('页面预览页数与搜索结果不一致，已阻止确认。').length).toBeGreaterThan(0));
    expect(screen.queryByLabelText('裁剪区域')).toBeNull();
    expect(screen.getByRole('button', { name: /第 4 页.*已阻塞/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders a selected queued hit before blocked background pages finish', async () => {
    const user = userEvent.setup();
    const releases: Array<() => void> = [];
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok', page_count: 20, source_sha256: SOURCE_SHA256,
      matches: Array.from({ length: 10 }, (_, index) => match(index + 1)),
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page) => {
      if (page === 1 || page === 10) return Promise.resolve(preview(path, page));
      return new Promise((resolve) => releases.push(() => resolve(preview(path, page))));
    });
    try {
      render(<App />);
      await choosePdf(user);
      await startAnalysis(user);
      await screen.findByText('第 10 页 / 片段 1');
      await waitFor(() => expect(releases.length).toBeGreaterThanOrEqual(2));
      await user.click(screen.getByText('第 10 页 / 片段 1'));
      // No background request is released: the visible page must use its
      // reserved slot, promoting the already queued promise without a duplicate.
      await waitFor(() => expect(screen.getByAltText('PDF 页面预览').getAttribute('src')).toBe('data:image/png;base64,PAGE10'));
      expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.filter((call) => call[1] === 10)).toHaveLength(1);
      expect(screen.queryByText('正在渲染第 10 页…')).toBeNull();
    } finally {
      cleanup();
      await act(async () => { releases.forEach((release) => release()); });
    }
  });

  async function openBatchFixture(user: ReturnType<typeof userEvent.setup>, crossSource=false) {
    const shaFor=(path:string)=>path==='/docs/second.pdf'?SECOND_SOURCE_SHA256:SOURCE_SHA256;
    if(crossSource)vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(['/docs/source.pdf','/docs/second.pdf']));
    vi.mocked(localEngineAdapter.search).mockImplementation(async(path)=>({status:'ok',page_count:20,source_sha256:shaFor(path),
      matches:crossSource?(path==='/docs/second.pdf'?[match(12),match(15)]:[match(4)]):[match(4),match(12),match(15)]}));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path,page,matches) => ({...analysis(page,matches,0),
      selections:analysis(page,matches,0).selections.map((item) => ({...item,confidence:0.8,needs_review:true}))}));
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path,page) => ({...preview(path,page),source_sha256:shaFor(path)}));
    vi.spyOn(localEngineAdapter,'describeCropPage').mockImplementation(async (_path,page,sha) => ({status:'ok',page,page_count:20,
      source_sha256:sha,page_width:600,page_height:800,crop_template:{status:'ready',fingerprint:'b'.repeat(64),
        receipts:[{anchor_y:20,bounds:{x0:0,y0:0,x1:600,y1:800},title_key:'c'.repeat(64)}]}}));
    render(<App />); await loadResults(user); await validatePreviewForPage(user,4);
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'),{key:'ArrowDown'});
    await waitFor(() => expect((screen.getByRole('button',{name:'应用到同类片段'}) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button',{name:'应用到同类片段'}));
    return await screen.findByRole('dialog',{name:'应用到同类片段'});
  }

  it('batch crop saves two targets atomically and one undo restores both without undoing the sample', async () => {
    const user=userEvent.setup(); const dialog=await openBatchFixture(user);
    await user.click(await within(dialog).findByRole('checkbox',{name:/已检查预览/}));
    const apply=within(dialog).getByRole('button',{name:/应用.*2.*片段/});
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    await user.click(apply);
    await waitFor(() => expect(screen.queryByRole('dialog',{name:'应用到同类片段'})).toBeNull());
    const writes=vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls;
    expect(writes).toHaveLength(2); expect(writes[1]![2]).toHaveLength(2);
    expect(writes[1]![2].every((item)=>item.final_rect?.y0===1&&item.manual_adjusted)).toBe(true);
    await user.click(screen.getByRole('button',{name:'撤销上一步'}));
    await waitFor(()=>expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls).toHaveLength(3));
    const restored=vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls[2]![2];
    expect(restored).toHaveLength(2); expect(restored.every((item)=>item.final_rect?.y0===0&&!item.manual_adjusted)).toBe(true);
    expect(parseFloat(screen.getByLabelText('裁剪区域').style.top)).toBeCloseTo(0.125);
  });

  it('batch crop cancel discards late metadata and never saves a batch', async () => {
    const user=userEvent.setup(); const dialog=await openBatchFixture(user);
    const release: (() => void)[] = [];
    vi.mocked(localEngineAdapter.describeCropPage).mockImplementation((_path,page,sha)=>new Promise((resolve)=>{
      release.push(()=>resolve({status:'ok',page,page_count:20,source_sha256:sha,page_width:600,page_height:800,
        crop_template:{status:'unavailable',reason:'no_titles'}}));
    }));
    await user.selectOptions(within(dialog).getByRole('combobox',{name:'应用范围'}),'filtered');
    await waitFor(()=>expect(release).toHaveLength(2));
    await user.click(within(dialog).getByRole('button',{name:'取消'}));
    // Real engine requests always settle. Release both in-flight mocks so a
    // cancelled test cannot occupy the shared process scheduler indefinitely.
    await act(async()=>{ for (const resolve of release) resolve(); });
    expect(release).toHaveLength(2);
    expect(screen.queryByRole('dialog',{name:'应用到同类片段'})).toBeNull();
    expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls).toHaveLength(1);
  });

  it('batch crop failed save keeps target decisions unchanged and retries the original transaction', async () => {
    const user=userEvent.setup(); const dialog=await openBatchFixture(user);
    await user.click(await within(dialog).findByRole('checkbox',{name:/已检查预览/}));
    const apply=within(dialog).getByRole('button',{name:/应用.*2.*片段/});
    await waitFor(()=>expect((apply as HTMLButtonElement).disabled).toBe(false));
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockRejectedValueOnce(new Error('磁盘写入失败'));
    await user.click(apply); const retry=await screen.findByRole('button',{name:'重试保存'});
    expect(reviewRow(/第 12 页/).textContent).toContain('需复核');
    await user.click(retry);
    await waitFor(()=>expect(screen.queryByRole('button',{name:'重试保存'})).toBeNull());
    const writes=vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls;
    expect(writes).toHaveLength(3);
    const decisions=(rows:EngineReviewSegmentV2[])=>rows.map(item=>({...item,reviewed_at:null}));
    expect(decisions(writes[2]![2])).toEqual(decisions(writes[1]![2]));
    expect(reviewRow(/第 12 页/).textContent).toContain('已确认');
  });

  it('batch crop refuses a changed source at the final identity check before any target save', async () => {
    const user=userEvent.setup();const dialog=await openBatchFixture(user);
    await user.click(await within(dialog).findByRole('checkbox',{name:/已检查预览/}));
    const apply=within(dialog).getByRole('button',{name:/应用.*2.*片段/});
    await waitFor(()=>expect((apply as HTMLButtonElement).disabled).toBe(false));
    vi.mocked(localEngineAdapter.inspectPdf).mockResolvedValue({status:'ok',page_count:20,source_sha256:CHANGED_SOURCE_SHA256});
    await user.click(apply);
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'应用到同类片段'})).toBeNull());
    expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls).toHaveLength(1);
    expect(screen.queryByRole('button',{name:'重试保存'})).toBeNull();
  });

  it('batch crop retries revalidate the sample source even when all targets belong to another PDF',async()=>{
    const user=userEvent.setup();const dialog=await openBatchFixture(user,true);
    await user.selectOptions(within(dialog).getByRole('combobox',{name:'应用范围'}),'filtered');
    await user.click(await within(dialog).findByRole('checkbox',{name:/已检查预览/}));
    const apply=within(dialog).getByRole('button',{name:/应用.*2.*片段/});
    await waitFor(()=>expect((apply as HTMLButtonElement).disabled).toBe(false));
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockRejectedValueOnce(new Error('磁盘失败'));
    await user.click(apply);const retry=await screen.findByRole('button',{name:'重试保存'});
    vi.mocked(localEngineAdapter.inspectPdf).mockImplementation(async(path)=>({status:'ok',page_count:20,
      source_sha256:path==='/docs/source.pdf'?CHANGED_SOURCE_SHA256:SECOND_SOURCE_SHA256}));
    await user.click(retry);
    await waitFor(()=>expect(screen.queryByRole('button',{name:'重试保存'})).toBeNull());
    expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls).toHaveLength(2);
  });

  it('batch crop metadata source_changed invalidates the plan using the source document identity',async()=>{
    const user=userEvent.setup();const dialog=await openBatchFixture(user);
    vi.mocked(localEngineAdapter.describeCropPage).mockRejectedValue(sourceChangedError());
    await user.selectOptions(within(dialog).getByRole('combobox',{name:'应用范围'}),'filtered');
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'应用到同类片段'})).toBeNull());
    expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls).toHaveLength(1);
    expect((screen.getByRole('button',{name:'确认整组'}) as HTMLButtonElement).disabled).toBe(true);
  });

  it('batch crop scope changes create a fresh preview instead of inheriting a cancelled cache owner',async()=>{
    const user=userEvent.setup();const dialog=await openBatchFixture(user);
    const apply=await within(dialog).findByRole('button',{name:/应用.*2.*片段/});
    await user.click(within(dialog).getByRole('checkbox',{name:/已检查预览/}));
    await waitFor(()=>expect((apply as HTMLButtonElement).disabled).toBe(false));
    const release:(()=>void)[]=[];
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path,page)=>new Promise(resolve=>release.push(()=>resolve({...preview(path,page),source_sha256:SOURCE_SHA256}))));
    const scope=within(dialog).getByRole('combobox',{name:'应用范围'});
    await user.selectOptions(scope,'filtered');await waitFor(()=>expect(release).toHaveLength(1));
    await user.selectOptions(scope,'source');await waitFor(()=>expect(release).toHaveLength(2));
    await act(async()=>release[0]!());
    expect((within(dialog).getByRole('button',{name:/应用.*2.*片段/}) as HTMLButtonElement).disabled).toBe(true);
    await act(async()=>release[1]!());
    await user.click(within(dialog).getByRole('checkbox',{name:/已检查预览/}));
    await waitFor(()=>expect((within(dialog).getByRole('button',{name:/应用.*2.*片段/}) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(dialog).getByRole('button',{name:'取消'}));
    expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls).toHaveLength(1);
  });

  it('marks the source changed when a background preview page count differs', async () => {
    const user = userEvent.setup();
    const firstOtherPage = match(12, 40, 80);
    const secondOtherPage = match(12, 220, 140);
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4), firstOtherPage, secondOtherPage],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => analysis(page, pageMatches, page === 12 ? 280 : 0));
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => ({
      ...preview(path, page),
      page_count: page === 12 ? 19 : 20,
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 12 页 / 片段 2');
    await waitFor(() => expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.map((call) => call[1])).toContain(12));
    await user.click(screen.getByText('第 12 页 / 片段 1'));
    await waitFor(() => expect(screen.getAllByText('页面预览页数与搜索结果不一致，已阻止确认。').length).toBeGreaterThan(0));

    const pageRows = screen.getAllByRole('button', { name: /第 12 页 \/ 片段/ });
    expect(pageRows).toHaveLength(2);
    expect(screen.getAllByText('源文件已变化，请重新分析').length).toBeGreaterThan(0);
    expect(pageRows.every((row) => row.getAttribute('aria-label')?.includes('已阻塞'))).toBe(true);
    expect(screen.getByText(/未解决 3 个片段/, { selector: '.review-action-card-summary' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks every source reported changed by the same background validation batch', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValueOnce(pickerResult([
      '/docs/source.pdf',
      '/docs/second.pdf',
    ]));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => ({
      status: 'ok' as const,
      page_count: 20,
      source_sha256: path === '/docs/source.pdf' ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
      matches: path === '/docs/source.pdf' ? [match(4)] : [match(12)],
    }));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => analysis(page, pageMatches, page === 4 ? 0 : 280));
    const resolveChangedPreview = new Map<string, () => void>();
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page) => new Promise((resolve) => {
      resolveChangedPreview.set(path, () => resolve({
        ...preview(path, page),
        source_sha256: CHANGED_SOURCE_SHA256,
      }));
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: /source\.pdf，.*第 4 页 \/ 片段 1/ });
    await screen.findByRole('button', { name: /second\.pdf，.*第 12 页 \/ 片段 1/ });
    await waitFor(() => expect(resolveChangedPreview.size).toBe(2));

    await act(async () => {
      resolveChangedPreview.get('/docs/source.pdf')?.();
      resolveChangedPreview.get('/docs/second.pdf')?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /second\.pdf，.*第 12 页 \/ 片段 1.*已阻塞/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: /source\.pdf，.*第 4 页 \/ 片段 1.*已阻塞/ })).toBeTruthy();
  });

  it('clears pending page preview loading when a new search result commits', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(12)],
    });
    const pendingPreviews: Array<{
      path: string;
      page: number;
      resolve: (value: ReturnType<typeof preview>) => void;
    }> = [];
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page) => new Promise((resolve) => {
      pendingPreviews.push({ path, page, resolve });
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: /第 12 页 \/ 片段 1/ });
    expect(await screen.findByText('正在渲染第 12 页…')).toBeTruthy();
    await waitFor(() => expect(pendingPreviews.length).toBeGreaterThan(0));

    await openSearchEditor(user);
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await screen.findByRole('button', { name: '修改搜索条件' });
    await waitFor(() => expect(pendingPreviews.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText('正在渲染第 12 页…')).toBeNull();

    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page) => Promise.resolve(preview(path, page)));
    await act(async () => {
      for (const pending of pendingPreviews) pending.resolve(preview(pending.path, pending.page));
      await Promise.resolve();
    });
  });

  it('keeps a confirmed background page unresolved after a transient preview failure and restores the group after retry', async () => {
    const user = userEvent.setup();
    const firstOtherPage = match(12, 40, 80);
    const secondOtherPage = match(12, 220, 140);
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4), firstOtherPage, secondOtherPage],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => analysis(page, pageMatches, page === 12 ? 280 : 0));
    let page12Calls = 0;
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => {
      if (page === 12 && page12Calls++ === 0) throw new Error('background preview outage');
      return preview(path, page);
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 12 页 / 片段 2');
    await waitFor(() => expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.map((call) => call[1])).toContain(12));
    await waitFor(() => expect(screen.getAllByText('预览待重试').length).toBeGreaterThan(0));

    expect(screen.getByText(/未解决 2 个片段/, { selector: '.review-action-card-summary' })).toBeTruthy();
    expect(screen.queryByText('全部片段已有合法候选，可选择导出范围。')).toBeNull();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);

    const failedRow = screen.getByRole('button', { name: /第 12 页.*片段 1.*预览待重试/ });
    expect(failedRow.getAttribute('aria-label')).toContain('background preview outage');
    await user.click(failedRow);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    await waitFor(() => expect(screen.queryByText(/未解决数量：/)).toBeNull());
    expect(screen.getByText('全部片段已有合法候选，可选择导出范围。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the engine concurrency limit while query editing is locked', async () => {
    const user = userEvent.setup();
    const paths = Array.from({ length: 4 }, (_value, index) => `/docs/semaphore-${index + 1}.pdf`);
    const pendingAnalyses: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    let analyzeCalls = 0;
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path, keyword) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return {
        status: 'ok',
        page_count: 20,
        source_sha256: keyword === '手续费' ? SECOND_SOURCE_SHA256 : THIRD_SOURCE_SHA256,
        matches: [match(keyword === '手续费' ? 4 : 12)],
      };
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => {
      analyzeCalls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      return new Promise((resolve) => {
        pendingAnalyses.push(() => {
          active -= 1;
          resolve(analysis(page, pageMatches, 0));
        });
      });
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(analyzeCalls).toBe(3));
    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '日期' } });
    expect((criteriaInput as HTMLInputElement).value).toBe('手续费');
    expect((screen.getByRole('button', { name: '正在分析…' }) as HTMLButtonElement).disabled).toBe(true);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      pendingAnalyses.splice(0).forEach((resolve) => resolve());
      if (screen.queryAllByText('第 4 页 / 片段 1').length === paths.length) break;
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }
    await waitFor(() => expect(screen.getAllByText('第 4 页 / 片段 1')).toHaveLength(paths.length), { timeout: 2500 });
    expect(maximum).toBeLessThanOrEqual(3);
  });

  it('re-enables actions after the locked run finishes', async () => {
    const user = userEvent.setup();
    let analyzeCalls = 0;
    let releaseOld: (() => void) | undefined;
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path, keyword) => ({
      status: 'ok',
      page_count: 20,
      source_sha256: keyword === '手续费' ? SECOND_SOURCE_SHA256 : THIRD_SOURCE_SHA256,
      matches: [match(keyword === '手续费' ? 4 : 12)],
    }));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => {
      analyzeCalls += 1;
      if (analyzeCalls === 1) {
        return new Promise((resolve) => {
          releaseOld = () => resolve(analysis(page, pageMatches, 0));
        });
      }
      return analysis(page, pageMatches, 0);
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(analyzeCalls).toBe(1));
    const criteriaInput = screen.getByRole('textbox', { name: '包含关键词 1' });
    fireEvent.change(criteriaInput, { target: { value: '日期' } });
    expect((criteriaInput as HTMLInputElement).value).toBe('手续费');
    expect((screen.getByRole('button', { name: '正在分析…' }) as HTMLButtonElement).disabled).toBe(true);
    releaseOld?.();
    await waitFor(() => expect(screen.getByText('第 4 页 / 片段 1')).toBeTruthy(), { timeout: 2000 });
    const committedModify = screen.getByRole('button', { name: '修改搜索条件' }) as HTMLButtonElement;
    expect(committedModify.disabled).toBe(false);
  });

  it('M1 feedback retains both failed filenames and retries the whole batch with the current draft', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/one/same.pdf', '/docs/two/same.pdf', '/docs/three.pdf', '/docs/four.pdf', '/docs/five.pdf'];
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      if (path === paths[0]) throw new Error('first file unavailable');
      if (path === paths[1]) throw new Error('second file unavailable');
      return { status: 'ok', page_count: 20, source_sha256: SOURCE_SHA256, matches: [] };
    });
    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getByRole('button', { name: '重新分析整批' })).toBeTruthy());
    expect(localEngineAdapter.search).toHaveBeenCalledTimes(5);
    const feedback = screen.getByRole('region', { name: '本轮分析' });
    expect(feedback.textContent).toContain('5 / 5');
    expect(feedback.textContent).toContain('0 / 0');
    expect(screen.queryByText('本轮未处理')).toBeNull();
    expect(screen.getAllByText(/搜索完成/)).toHaveLength(3);
    const failures = screen.getByRole('list', { name: '上一轮分析失败明细' });
    const items = within(failures).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain(paths[0]);
    expect(items[1]!.textContent).toContain(paths[1]);
    expect(failures.textContent).not.toMatch(/第 \d+ 页/);
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();

    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok', page_count: 20, source_sha256: SOURCE_SHA256, matches: [],
    });
    const input = screen.getByRole('textbox', { name: '包含关键词 1' });
    await user.clear(input);
    await user.type(input, '利息');
    expect(screen.getByRole('list', { name: '上一轮分析失败明细' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '重新分析整批' }));
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    expect(localEngineAdapter.search).toHaveBeenCalledTimes(10);
    expect(vi.mocked(localEngineAdapter.search).mock.calls.slice(-5).map(([path, keyword]) => [path, keyword]))
      .toEqual(paths.map((path) => [path, '利息']));
    expect(screen.queryByRole('list', { name: '上一轮分析失败明细' })).toBeNull();
    expect(screen.getAllByText('未找到符合条件的片段')).toHaveLength(5);
  });

  it('M1 feedback counts real semaphore completions and does not start a duplicate run', async () => {
    const user = userEvent.setup();
    const paths = Array.from({ length: 5 }, (_, index) => `/docs/progress-${index}.pdf`);
    const pending = new Map<string, () => void>();
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation((path) => new Promise((resolve) => {
      pending.set(path, () => resolve({ status: 'ok', page_count: 20, source_sha256: SOURCE_SHA256, matches: [] }));
    }));
    render(<App />);
    await choosePdf(user);
    try {
      await startAnalysis(user);
      expect(localEngineAdapter.search).toHaveBeenCalledTimes(3);
      expect(screen.getByRole('region', { name: '本轮分析' }).textContent).toContain('0 / 5');
      expect(screen.getAllByText('正在搜索')).toHaveLength(3);
      expect(screen.getAllByText('等待搜索')).toHaveLength(2);
      fireEvent.submit(screen.getByRole('button', { name: '正在分析…' }).closest('form')!);
      expect(localEngineAdapter.search).toHaveBeenCalledTimes(3);
      await act(async () => pending.get(paths[0]!)!());
      expect(localEngineAdapter.search).toHaveBeenCalledTimes(4);
      expect(screen.getByRole('region', { name: '本轮分析' }).textContent).toContain('1 / 5');
      expect(screen.getAllByText('等待搜索')).toHaveLength(1);
    } finally {
      for (let index = 0; index < 6; index += 1) {
        await act(async () => { for (const resolve of pending.values()) resolve(); });
      }
    }
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    expect(localEngineAdapter.search).toHaveBeenCalledTimes(5);
  });

  it('M1 feedback identifies physical pages across sources and clears after restoring previous results', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/one/same.pdf', '/docs/two/same.pdf'];
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok', page_count: 20, source_sha256: SOURCE_SHA256, matches: [match(4)],
    });
    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: '修改搜索条件' });
    expect(screen.getAllByText('第 4 页 / 片段 1')).toHaveLength(2);
    await openSearchEditor(user);
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path) => {
      throw new Error(path === paths[0] ? 'page one failed' : 'page two failed');
    });
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await screen.findByRole('button', { name: '重新分析整批' });
    const failures = screen.getByRole('list', { name: '上一轮分析失败明细' });
    expect(within(failures).getAllByRole('listitem')).toHaveLength(2);
    expect(within(failures).getAllByText(/第 4 页/)).toHaveLength(2);
    expect(failures.textContent).toContain(paths[0]);
    expect(failures.textContent).toContain(paths[1]);
    expect(screen.getByRole('region', { name: '本轮分析' }).textContent).toContain('2 / 2');
    expect(screen.getAllByText('第 4 页 / 片段 1')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '恢复上次条件' }));
    expect(screen.queryByRole('region', { name: '本轮分析' })).toBeNull();
    expect(screen.queryByRole('list', { name: '上一轮分析失败明细' })).toBeNull();
    expect(screen.getAllByText('第 4 页 / 片段 1')).toHaveLength(2);
  });

  it('M1 feedback preserves both source-change and ordinary page failures in the same batch', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/changed.pdf', '/docs/unavailable.pdf'];
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok', page_count: 20, source_sha256: SOURCE_SHA256, matches: [match(4)],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path) => {
      if (path === paths[0]) throw sourceChangedError();
      throw new Error('ordinary page error');
    });
    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: '重新分析整批' });
    const failures = screen.getByRole('list', { name: '上一轮分析失败明细' });
    const items = within(failures).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain(paths[0]);
    expect(items[0]!.textContent).toContain('源文件');
    expect(items[1]!.textContent).toContain('ordinary page error');
    expect(screen.getByRole('region', { name: '本轮分析' }).textContent).toContain('2 / 2');
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('M1 feedback reports metadata assembly errors as batch errors without an invented page', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok', page_count: 0, source_sha256: SOURCE_SHA256, matches: [],
    });
    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: '重新分析整批' });
    const failures = screen.getByRole('list', { name: '上一轮分析失败明细' });
    expect(within(failures).getAllByRole('listitem')).toHaveLength(1);
    expect(failures.textContent).toContain('整批任务');
    expect(failures.textContent).toContain('整理审核结果');
    expect(failures.textContent).not.toMatch(/第 \d+ 页/);
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();
  });

  it('M1 feedback keeps a separate finalization error even when a page already failed', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.searchMulti).mockResolvedValue({
      status: 'ok', page_count: 20, source_sha256: SOURCE_SHA256,
      matches: [multiMatch(4, 'include-0', 'include', '手续费', 40, 80), multiMatch(12, 'include-0', 'include', '手续费', 40, 80)],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, pageMatches) => {
      if (page === 4) throw new Error('first page analysis failed');
      // A valid legacy analysis response cannot supply compound candidate identity.
      return analysis(page, pageMatches, 0);
    });
    render(<App />);
    await choosePdf(user);
    await user.click(screen.getByRole('radio', { name: '任一满足' }));
    await startAnalysis(user);
    await screen.findByRole('button', { name: '重新分析整批' });
    const failures = screen.getByRole('list', { name: '上一轮分析失败明细' });
    const items = within(failures).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('第 4 页');
    expect(items[1]!.textContent).toContain('整批任务');
    expect(items[1]!.textContent).toContain('整理审核结果');
    expect(items[1]!.textContent).toContain('缺少候选回单元数据');
    expect(screen.getByRole('region', { name: '本轮分析' }).textContent).toContain('整理审核结果失败');
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();
  });

  it('continues every source, withholds partial results, and retries only the two failed sources before verifying all twenty', async () => {
    const user = userEvent.setup();
    const paths = Array.from({ length: 20 }, (_value, index) => `/docs/retry-batch-${String(index + 1).padStart(2, '0')}.pdf`);
    const zeroHitIndex = 17;
    const searchFailureIndex = 18;
    const analysisFailureIndex = 19;
    const shaFor = (index: number) => String(index + 1).padStart(2, '0').repeat(32);
    const pageFor = (index: number) => index + 1;
    const searchEvents: string[] = [];
    const analysisEvents: string[] = [];
    const phaseEvents: string[] = [];
    const inspectCalls: string[] = [];
    let firstRun = true;

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.inspectPdf).mockImplementation(async (path) => {
      inspectCalls.push(path);
      const index = paths.indexOf(path);
      return { status: 'ok', page_count: 20, source_sha256: shaFor(index < 0 ? 0 : index) };
    });
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      const index = paths.indexOf(path);
      searchEvents.push(`search:${index}`);
      phaseEvents.push(`search:${index}`);
      if (firstRun && index === searchFailureIndex) throw new Error('search failure for source 19');
      return {
        status: 'ok',
        page_count: 20,
        source_sha256: shaFor(index),
        matches: index === zeroHitIndex ? [] : [match(pageFor(index))],
      };
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => {
      const index = paths.indexOf(path);
      analysisEvents.push(`analyze:${index}`);
      phaseEvents.push(`analyze:${index}`);
      if (firstRun && index === analysisFailureIndex) throw new Error('analysis failure for source 20');
      return analysis(page, pageMatches, 0);
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);

    await screen.findByRole('button', { name: '重试失败文件（2）' });
    expect(searchEvents).toHaveLength(20);
    expect(new Set(searchEvents)).toEqual(new Set(paths.map((_path, index) => `search:${index}`)));
    expect(analysisEvents).toHaveLength(18);
    expect(analysisEvents).toContain(`analyze:${analysisFailureIndex}`);
    const firstAnalysisEvent = phaseEvents.findIndex((event) => event.startsWith('analyze:'));
    expect(firstAnalysisEvent).toBeGreaterThan(0);
    expect(phaseEvents.slice(0, firstAnalysisEvent).every((event) => event.startsWith('search:'))).toBe(true);
    // Browser tests do not run the desktop-only pre-analysis metadata pass;
    // failed runs stop before the runner's all-source verification phase.
    expect(inspectCalls).toHaveLength(0);
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();

    const failures = screen.getByRole('list', { name: '上一轮分析失败明细' });
    const failureText = failures.textContent ?? '';
    expect(within(failures).getAllByRole('listitem')).toHaveLength(2);
    expect(failureText).toContain(paths[searchFailureIndex]!);
    expect(failureText).toContain(paths[analysisFailureIndex]!);
    expect(failureText).not.toContain(paths[zeroHitIndex]!);

    firstRun = false;
    await user.click(screen.getByRole('button', { name: '重试失败文件（2）' }));
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });

    expect(searchEvents).toHaveLength(22);
    expect(searchEvents.slice(-2)).toEqual([
      `search:${searchFailureIndex}`,
      `search:${analysisFailureIndex}`,
    ]);
    expect(analysisEvents).toHaveLength(20);
    expect(analysisEvents.slice(-2)).toEqual([
      `analyze:${searchFailureIndex}`,
      `analyze:${analysisFailureIndex}`,
    ]);
    expect(inspectCalls).toHaveLength(paths.length);
    expect(inspectCalls.slice(-paths.length).sort()).toEqual([...paths].sort());
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '重试失败文件（2）' })).toBeNull();

    const rows = within(screen.getByRole('region', { name: '审核导航' }))
      .getAllByRole('button', { name: /第 \d+ 页 \/ 片段 1/ });
    expect(rows).toHaveLength(19);
    expect(rows.map((row) => Number(row.textContent?.match(/第 (\d+) 页/)?.[1]))).toEqual([
      ...Array.from({ length: 17 }, (_value, index) => index + 1),
      19,
      20,
    ]);
  });

  it('keeps stable IDs and original order for two paths sharing one SHA across a failed retry', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/same-sha/first.pdf', '/docs/same-sha/second.pdf', '/docs/third.pdf'];
    const sharedSha = 'e'.repeat(64);
    const shaFor = (path: string) => path === paths[2] ? THIRD_SOURCE_SHA256 : sharedSha;
    let failThirdSource = false;

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.inspectPdf).mockImplementation(async (path) => ({
      status: 'ok', page_count: 20, source_sha256: shaFor(path),
    }));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => ({
      status: 'ok',
      page_count: 20,
      source_sha256: shaFor(path),
      matches: [match(path === paths[0] ? 4 : path === paths[1] ? 8 : 12)],
    }));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => {
      if (failThirdSource && path === paths[2]) throw new Error('third source analysis failed');
      return analysis(page, pageMatches, 0);
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(1);
    const baseline = vi.mocked(localEngineAdapter.prepareReviewContext).mock.calls[0]?.[1]
      .map(({ id, source_key, source_page, segment_no }) => ({ id, source_key, source_page, segment_no }));
    expect(baseline).toHaveLength(3);
    expect(new Set((baseline ?? []).map((record) => record.id)).size).toBe(3);
    expect((baseline ?? []).map((record) => record.source_key)).toEqual([
      expect.stringContaining('/docs/same-sha/first.pdf'),
      expect.stringContaining('/docs/same-sha/second.pdf'),
      expect.stringContaining('/docs/third.pdf'),
    ]);

    failThirdSource = true;
    await openSearchEditor(user);
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await screen.findByRole('button', { name: '重试失败文件（1）' });
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeTruthy();

    failThirdSource = false;
    await user.click(screen.getByRole('button', { name: '重试失败文件（1）' }));
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    expect(localEngineAdapter.search).toHaveBeenCalledTimes(7);
    expect(vi.mocked(localEngineAdapter.search).mock.calls.slice(-1)[0]?.[0]).toBe(paths[2]);
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(2);
    const retried = vi.mocked(localEngineAdapter.prepareReviewContext).mock.calls[1]?.[1]
      .map(({ id, source_key, source_page, segment_no }) => ({ id, source_key, source_page, segment_no }));
    expect(retried).toEqual(baseline);
    expect(within(screen.getByRole('region', { name: '审核导航' }))
      .getAllByRole('button', { name: /第 \d+ 页 \/ 片段 1/ })).toHaveLength(3);
  });

  it('rejects the whole retry when final inspection finds a changed cached source and clears retry cache', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/integrity-a.pdf', '/docs/integrity-b.pdf', '/docs/integrity-c.pdf'];
    let failSourceCSearch = true;
    const inspectCalls: string[] = [];
    const shaFor = (path: string) => path === paths[0] ? SOURCE_SHA256
      : path === paths[1] ? SECOND_SOURCE_SHA256 : THIRD_SOURCE_SHA256;

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      if (failSourceCSearch && path === paths[2]) throw new Error('source C search failed');
      return {
        status: 'ok', page_count: 20, source_sha256: shaFor(path), matches: [match(path === paths[0] ? 4 : path === paths[1] ? 8 : 12)],
      };
    });
    vi.mocked(localEngineAdapter.inspectPdf).mockImplementation(async (path) => {
      inspectCalls.push(path);
      return {
        status: 'ok',
        page_count: 20,
        source_sha256: path === paths[0] ? CHANGED_SOURCE_SHA256 : shaFor(path),
      };
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: '重试失败文件（1）' });
    expect(localEngineAdapter.prepareReviewContext).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();

    failSourceCSearch = false;
    await user.click(screen.getByRole('button', { name: '重试失败文件（1）' }));
    await waitFor(() => expect(screen.getAllByText(/源 PDF.*变化/).length).toBeGreaterThan(0));
    expect(localEngineAdapter.search).toHaveBeenCalledTimes(4);
    expect(vi.mocked(localEngineAdapter.search).mock.calls.slice(-1)[0]?.[0]).toBe(paths[2]);
    expect(inspectCalls).toHaveLength(paths.length);
    expect(new Set(inspectCalls)).toEqual(new Set(paths));
    expect(localEngineAdapter.prepareReviewContext).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '重试失败文件（1）' })).toBeNull();
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();
    expect(screen.queryByText(/第 (4|8|12) 页 \/ 片段 1/)).toBeNull();
  });

  it('retains complete source cache after a second failure and can retry that failure again', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/cache-a.pdf', '/docs/cache-b.pdf', '/docs/cache-c.pdf'];
    let failSourceB = true;
    const searchCalls: string[] = [];

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      searchCalls.push(path);
      if (failSourceB && path === paths[1]) throw new Error('source B remains unavailable');
      return {
        status: 'ok', page_count: 20,
        source_sha256: path === paths[0] ? SOURCE_SHA256 : path === paths[1] ? SECOND_SOURCE_SHA256 : THIRD_SOURCE_SHA256,
        matches: [match(path === paths[0] ? 4 : path === paths[1] ? 8 : 12)],
      };
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, pageMatches) => (
      analysis(page, pageMatches, 0)
    ));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: '重试失败文件（1）' });
    expect(searchCalls).toEqual(paths);

    await user.click(screen.getByRole('button', { name: '重试失败文件（1）' }));
    await screen.findByRole('button', { name: '重试失败文件（1）' });
    expect(searchCalls).toHaveLength(4);
    expect(searchCalls.slice(-1)).toEqual([paths[1]]);
    expect(screen.getAllByText(/成功文件的计算结果仅在本次会话暂存/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();

    failSourceB = false;
    await user.click(screen.getByRole('button', { name: '重试失败文件（1）' }));
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    expect(searchCalls).toHaveLength(5);
    expect(searchCalls.slice(-1)).toEqual([paths[1]]);
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole('region', { name: '审核导航' }))
      .getAllByRole('button', { name: /第 \d+ 页 \/ 片段 1/ })).toHaveLength(3);
  });

  it('clears retry cache when search criteria change and reprocesses every source', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/criteria-a.pdf', '/docs/criteria-b.pdf', '/docs/criteria-c.pdf'];
    let failSourceB = true;
    const searchCalls: Array<[string, string]> = [];

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path, keyword) => {
      searchCalls.push([path, keyword]);
      if (failSourceB && path === paths[1]) throw new Error('criteria batch source B failed');
      return {
        status: 'ok', page_count: 20, source_sha256: path === paths[0] ? SOURCE_SHA256 : path === paths[1] ? SECOND_SOURCE_SHA256 : THIRD_SOURCE_SHA256,
        matches: [match(keyword === '利息' ? 12 : 4)],
      };
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, pageMatches) => (
      analysis(page, pageMatches, 0)
    ));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: '重试失败文件（1）' });
    expect(searchCalls).toHaveLength(3);

    const criteriaInput = screen.getByRole('textbox', { name: '包含关键词 1' });
    await user.clear(criteriaInput);
    await user.type(criteriaInput, '利息');
    expect(screen.queryByRole('button', { name: '重试失败文件（1）' })).toBeNull();
    failSourceB = false;
    await user.click(screen.getByRole('button', { name: '重新分析整批' }));
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });

    expect(searchCalls).toHaveLength(6);
    expect(searchCalls.slice(-3)).toEqual(paths.map((path) => [path, '利息']));
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '重试失败文件（1）' })).toBeNull();
    expect(within(screen.getByRole('region', { name: '审核导航' }))
      .getAllByRole('button', { name: /第 12 页 \/ 片段 1/ })).toHaveLength(3);
  });

  it('does not reuse failed-run cache when the computation version changes', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/version-a.pdf', '/docs/version-b.pdf', '/docs/version-c.pdf'];
    let failSourceB = true;
    const searchCalls: string[] = [];
    vi.mocked(localEngineAdapter.computationInfo)
      .mockResolvedValueOnce({ status: 'ok', computation_version: 'm2-version-one' })
      .mockResolvedValue({ status: 'ok', computation_version: 'm2-version-two' });

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      searchCalls.push(path);
      if (failSourceB && path === paths[1]) throw new Error('version batch source B failed');
      return {
        status: 'ok', page_count: 20, source_sha256: path === paths[0] ? SOURCE_SHA256 : path === paths[1] ? SECOND_SOURCE_SHA256 : THIRD_SOURCE_SHA256,
        matches: [match(path === paths[0] ? 4 : path === paths[1] ? 8 : 12)],
      };
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, pageMatches) => (
      analysis(page, pageMatches, 0)
    ));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: '重试失败文件（1）' });
    expect(searchCalls).toHaveLength(3);

    failSourceB = false;
    await user.click(screen.getByRole('button', { name: '重试失败文件（1）' }));
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });

    expect(localEngineAdapter.computationInfo).toHaveBeenCalledTimes(2);
    expect(searchCalls).toHaveLength(6);
    expect(searchCalls.slice(-3)).toEqual(paths);
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole('region', { name: '审核导航' }))
      .getAllByRole('button', { name: /第 \d+ 页 \/ 片段 1/ })).toHaveLength(3);
  });

  it('clears retry cache when final batch preparation fails and offers no partial retry', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/prepare-a.pdf', '/docs/prepare-b.pdf'];
    let failSourceB = true;

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      if (failSourceB && path === paths[1]) throw new Error('prepare batch source B failed');
      return {
        status: 'ok', page_count: 20,
        source_sha256: path === paths[0] ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
        matches: [match(path === paths[0] ? 4 : 8)],
      };
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, pageMatches) => (
      analysis(page, pageMatches, 0)
    ));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: '重试失败文件（1）' });
    failSourceB = false;
    vi.mocked(localEngineAdapter.prepareReviewContext).mockRejectedValueOnce(
      new LocalEngineError('ENGINE_REQUEST_REJECTED', '批量审核上下文准备失败。'),
    );

    await user.click(screen.getByRole('button', { name: '重试失败文件（1）' }));
    await waitFor(() => expect(screen.getAllByText(/批量审核上下文准备失败/).length).toBeGreaterThan(0));
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '重试失败文件（1）' })).toBeNull();
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();
    expect(screen.queryByText(/第 (4|8) 页 \/ 片段 1/)).toBeNull();
  });

  it('blocks every source when delayed final verification reports both sources changed', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/verify-a.pdf', '/docs/verify-b.pdf'];
    const shas = [SOURCE_SHA256, SECOND_SOURCE_SHA256];
    let rerunning = false;
    const inspectCalls: string[] = [];
    let rejectVerifyA: ((reason?: unknown) => void) | undefined;
    let rejectVerifyB: ((reason?: unknown) => void) | undefined;

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      const index = paths.indexOf(path);
      return {
        status: 'ok', page_count: 20, source_sha256: shas[index]!,
        matches: [match(index === 0 ? 4 : 12)],
      };
    });
    vi.mocked(localEngineAdapter.inspectPdf).mockImplementation(async (path) => {
      inspectCalls.push(path);
      if (!rerunning) {
        return { status: 'ok', page_count: 20, source_sha256: shas[paths.indexOf(path)]! };
      }
      return new Promise((_resolve, reject) => {
        if (path === paths[0]) rejectVerifyA = reject;
        else rejectVerifyB = reject;
      });
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, pageMatches) => (
      analysis(page, pageMatches, 0)
    ));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: '修改搜索条件' });

    rerunning = true;
    await openSearchEditor(user);
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await waitFor(() => {
      expect(rejectVerifyA).toBeTypeOf('function');
      expect(rejectVerifyB).toBeTypeOf('function');
    });
    await act(async () => {
      rejectVerifyA?.(sourceChangedError('A 核验期间源文件已变化，请重新分析'));
      await Promise.resolve();
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await act(async () => {
      rejectVerifyB?.(sourceChangedError('B 核验期间源文件已变化，请重新分析'));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getAllByText(/A 核验期间源文件已变化/).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText(/B 核验期间源文件已变化/).length).toBeGreaterThan(0));
    expect(inspectCalls).toEqual([...paths, ...paths]);
    const sourceList = screen.getByRole('list', { name: '当前来源文件' });
    expect(within(sourceList).getByRole('button', { name: /^verify-a\.pdf/ }).textContent).toContain('源文件已变化');
    expect(within(sourceList).getByRole('button', { name: /^verify-b\.pdf/ }).textContent).toContain('源文件已变化');
    expect(reviewRow(/verify-a\.pdf，.*第 4 页 \/ 片段 1/).getAttribute('aria-label')).toContain('已阻塞');
    expect(reviewRow(/verify-b\.pdf，.*第 12 页 \/ 片段 1/).getAttribute('aria-label')).toContain('已阻塞');
    expect(screen.queryByRole('button', { name: /重试失败文件/ })).toBeNull();
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(1);
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('preserves a late second source analysis failure after the first source fails immediately', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/analyze-a.pdf', '/docs/analyze-b.pdf'];
    let rerunning = false;
    let rejectAnalysisB: ((reason?: unknown) => void) | undefined;
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => ({
      status: 'ok', page_count: 20,
      source_sha256: path === paths[0] ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
      matches: [match(path === paths[0] ? 4 : 12)],
    }));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => {
      if (rerunning && path === paths[0]) throw sourceChangedError('A 分析期间源文件已变化，请重新分析');
      if (rerunning && path === paths[1]) {
        return new Promise((_resolve, reject) => { rejectAnalysisB = reject; });
      }
      return analysis(page, pageMatches, 0);
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: /analyze-a\.pdf，.*第 4 页 \/ 片段 1/ });
    await screen.findByRole('button', { name: /analyze-b\.pdf，.*第 12 页 \/ 片段 1/ });

    rerunning = true;
    await openSearchEditor(user);
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    try {
      await waitFor(() => expect(rejectAnalysisB).toBeTypeOf('function'));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await act(async () => {
        rejectAnalysisB?.(sourceChangedError('B 分析期间源文件已变化，请重新分析'));
        await Promise.resolve();
      });

      await waitFor(() => expect(screen.getAllByText(/A 分析期间源文件已变化/).length).toBeGreaterThan(0));
      await waitFor(() => expect(screen.getAllByText(/B 分析期间源文件已变化/).length).toBeGreaterThan(0));
      const failures = screen.getByRole('list', { name: '上一轮分析失败明细' });
      const items = within(failures).getAllByRole('listitem');
      expect(items).toHaveLength(2);
      expect(failures.textContent).toContain(paths[0]);
      expect(failures.textContent).toContain(paths[1]);
      expect(reviewRow(/analyze-a\.pdf，.*第 4 页 \/ 片段 1/).getAttribute('aria-label')).toContain('已阻塞');
      expect(reviewRow(/analyze-b\.pdf，.*第 12 页 \/ 片段 1/).getAttribute('aria-label')).toContain('已阻塞');
      expect(screen.queryByRole('button', { name: /重试失败文件/ })).toBeNull();
      expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    } finally {
      rejectAnalysisB?.(sourceChangedError('B 分析期间源文件已变化，请重新分析'));
      await Promise.resolve();
    }
  });

  it('keeps multi-condition originals and representative source order stable across retry and full rerun', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/multi-retry-a.pdf', '/docs/multi-retry-b.pdf'];
    const shas = [SOURCE_SHA256, SECOND_SOURCE_SHA256];
    let failSourceB = true;
    const multiMatches = (index: number) => [
      multiMatch(index === 0 ? 4 : 12, 'include-0', 'include', '示例实业', 40, 80),
      multiMatch(index === 0 ? 4 : 12, 'include-1', 'include', '华夏银行', 180, 100),
    ];

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.searchMulti).mockImplementation(async (path) => {
      const index = paths.indexOf(path);
      if (failSourceB && index === 1) throw new Error('多条件第二来源首轮搜索失败');
      return {
        status: 'ok',
        page_count: 20,
        source_sha256: shas[index]!,
        matches: multiMatches(index),
      };
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, pageMatches) => ({
      status: 'ok',
      page,
      page_width: PAGE_WIDTH,
      page_height: PAGE_HEIGHT,
      selections: pageMatches.map((rect) => multiSelection(rect, 0, 0)),
    }));

    render(<App />);
    await choosePdf(user);
    const searchPanel = screen.getByRole('region', { name: '搜索条件' });
    const firstInclude = within(searchPanel).getByRole('textbox', { name: '包含关键词 1' });
    await user.clear(firstInclude);
    await user.type(firstInclude, '示例实业');
    await user.click(within(searchPanel).getByRole('button', { name: '添加包含关键词' }));
    await user.type(within(searchPanel).getByRole('textbox', { name: '包含关键词 2' }), '华夏银行');
    await user.click(within(searchPanel).getByRole('button', { name: '添加排除关键词' }));
    await user.type(within(searchPanel).getByRole('textbox', { name: '排除关键词 1' }), '退款');
    await user.click(within(searchPanel).getByRole('radio', { name: '全部满足' }));
    await user.click(within(searchPanel).getByRole('button', { name: '开始分析' }));
    await screen.findByRole('button', { name: '重试失败文件（1）' });
    expect(localEngineAdapter.prepareReviewContext).not.toHaveBeenCalled();

    failSourceB = false;
    await user.click(screen.getByRole('button', { name: '重试失败文件（1）' }));
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(1);

    const prepare = vi.mocked(localEngineAdapter.prepareReviewContext);
    const retryCall = prepare.mock.calls[0];
    if (!retryCall) throw new Error('retry prepare call missing');
    const retryContext = retryCall[0];
    const retryOriginals = retryCall[1];
    const stableOriginals = (originals: readonly EngineOriginalReview[]) => originals.map((original) => ({
      id: original.id,
      source_key: original.source_key,
      source_page: original.source_page,
      segment_no: original.segment_no,
      analysis_signature: original.analysis_signature,
      persistable: original.persistable,
      page_width: original.page_width,
      page_height: original.page_height,
      match_rect: original.match_rect,
      candidate_rect: original.candidate_rect,
      layout_fingerprint: original.layout_fingerprint,
      confidence: original.confidence,
      auto_full_page: original.auto_full_page,
    }));
    expect(retryContext.sources.map(({ source_key, source_path, source_sha256 }) => ({
      source_key, source_path, source_sha256,
    }))).toEqual([
      { source_key: paths[0], source_path: paths[0], source_sha256: SOURCE_SHA256 },
      { source_key: paths[1], source_path: paths[1], source_sha256: SECOND_SOURCE_SHA256 },
    ]);
    expect(retryOriginals).toHaveLength(2);
    expect(stableOriginals(retryOriginals).map(({ id, source_key, source_page, segment_no }) => ({
      id, source_key, source_page, segment_no,
    }))).toEqual([
      { id: expect.any(String), source_key: paths[0], source_page: 4, segment_no: 1 },
      { id: expect.any(String), source_key: paths[1], source_page: 12, segment_no: 1 },
    ]);
    expect(retryOriginals[0]?.candidate_rect).toEqual({ x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 220 });
    expect(retryOriginals[1]?.candidate_rect).toEqual({ x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 220 });

    await openSearchEditor(user);
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    expect(prepare).toHaveBeenCalledTimes(2);
    const fullCall = prepare.mock.calls[1];
    if (!fullCall) throw new Error('full rerun prepare call missing');
    const fullContext = fullCall[0];
    const fullOriginals = fullCall[1];
    expect(fullContext.sources).toEqual(retryContext.sources);
    expect(fullContext.criteria_fingerprint).toBe(retryContext.criteria_fingerprint);
    expect(stableOriginals(fullOriginals)).toEqual(stableOriginals(retryOriginals));
    expect(vi.mocked(localEngineAdapter.searchMulti).mock.calls.slice(-2).map(([path]) => path)).toEqual(paths);

    const rows = within(screen.getByRole('region', { name: '审核导航' }))
      .getAllByRole('button', { name: /第 (4|12) 页 \/ 片段 1/ });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('aria-label')).toContain('multi-retry-a.pdf');
    expect(rows[1]?.getAttribute('aria-label')).toContain('multi-retry-b.pdf');
  });

  it('does not re-enter a retry run when the failed-source button is clicked twice', async () => {
    const user = userEvent.setup();
    const paths = ['/docs/retry-click-a.pdf', '/docs/retry-click-b.pdf'];
    let failSourceB = true;
    let retrySearchPending = false;
    let releaseRetrySearch: (() => void) | undefined;
    const resultFor = (path: string) => ({
      status: 'ok' as const,
      page_count: 20,
      source_sha256: path === paths[0] ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
      matches: [match(path === paths[0] ? 4 : 8)],
    });

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => {
      if (failSourceB && path === paths[1]) throw new Error('retry click source B failed');
      if (retrySearchPending && path === paths[1]) {
        return new Promise((resolve) => {
          releaseRetrySearch = () => resolve(resultFor(path));
        });
      }
      return resultFor(path);
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, pageMatches) => (
      analysis(page, pageMatches, 0)
    ));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByRole('button', { name: '重试失败文件（1）' });

    failSourceB = false;
    retrySearchPending = true;
    const retryButton = screen.getByRole('button', { name: '重试失败文件（1）' });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    await waitFor(() => expect(localEngineAdapter.search).toHaveBeenCalledTimes(3));
    expect(vi.mocked(localEngineAdapter.search).mock.calls.filter(([path]) => path === paths[1])).toHaveLength(2);

    releaseRetrySearch?.();
    await within(screen.getByRole('region', { name: '搜索条件' })).findByRole('button', { name: '修改搜索条件' });
    expect(localEngineAdapter.search).toHaveBeenCalledTimes(3);
    expect(localEngineAdapter.prepareReviewContext).toHaveBeenCalledTimes(1);
  });

  it('starts a new batch only after explicit analysis', async () => {
    const user = userEvent.setup();
    const paths = Array.from({ length: 5 }, (_value, index) => `/docs/query-${index + 1}.pdf`);
    const resolvers: Array<() => void> = [];
    let searchCallCount = 0;
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(paths));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path, keyword) => {
      searchCallCount += 1;
      if (keyword === '手续费' && searchCallCount <= 4) {
        await new Promise<void>((resolve) => resolvers.push(resolve));
      }
      return {
        status: 'ok',
        page_count: 20,
        source_sha256: keyword === '手续费' ? SECOND_SOURCE_SHA256 : THIRD_SOURCE_SHA256,
        matches: keyword === '手续费' ? [match(4)] : [match(12)],
      };
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => analysis(page, pageMatches, 0));

    try {
      render(<App />);
      await choosePdf(user);
      await startAnalysis(user);
      await waitFor(() => expect(searchCallCount).toBe(3));
      const criteriaInput = screen.getByRole('textbox', { name: '包含关键词 1' });
      fireEvent.change(criteriaInput, { target: { value: '日期' } });
      expect((criteriaInput as HTMLInputElement).value).toBe('手续费');
      expect((screen.getByRole('button', { name: '正在分析…' }) as HTMLButtonElement).disabled).toBe(true);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        resolvers.splice(0).forEach((resolve) => resolve());
        if (screen.queryAllByText('第 4 页 / 片段 1').length === paths.length) break;
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      await waitFor(() => expect(screen.getAllByText('第 4 页 / 片段 1')).toHaveLength(paths.length), { timeout: 1500 });
      expect(screen.queryByText('第 12 页 / 片段 1')).toBeNull();
      expect(vi.mocked(localEngineAdapter.analyzePage).mock.calls.every((call) => call[1] === 4)).toBe(true);

      const committedInput = await openSearchEditor(user);
      fireEvent.change(committedInput, { target: { value: '日期' } });
      expect((committedInput as HTMLInputElement).value).toBe('日期');
      await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
      await waitFor(() => expect(screen.getAllByText('第 12 页 / 片段 1')).toHaveLength(paths.length), { timeout: 1500 });
      expect(screen.queryByText('第 4 页 / 片段 1')).toBeNull();
      expect(vi.mocked(localEngineAdapter.analyzePage).mock.calls.slice(-paths.length).every((call) => call[1] === 12)).toBe(true);
    } finally {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const pending = resolvers.splice(0);
        if (pending.length === 0) break;
        await act(async () => {
          pending.forEach((resolve) => resolve());
        });
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
  });

  it('expires queued page previews before a newer search can use the engine', async () => {
    const user = userEvent.setup();
    const oldPages = Array.from({ length: 8 }, (_value, index) => index + 1);
    const newPage = 99;
    const oldPreviewResolvers: Array<() => void> = [];
    const renderCalls: number[] = [];
    vi.mocked(localEngineAdapter.search).mockImplementation(async (_path, keyword) => ({
      status: 'ok',
      page_count: 120,
      source_sha256: keyword === '手续费' ? SECOND_SOURCE_SHA256 : THIRD_SOURCE_SHA256,
      matches: (keyword === '手续费' ? oldPages : [newPage]).map((page) => match(page)),
    }));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, pageMatches) => analysis(page, pageMatches, 0));
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page, sourceSha256) => {
      renderCalls.push(page);
      if (oldPages.includes(page)) {
        return new Promise((resolve) => {
          oldPreviewResolvers.push(() => resolve({
            ...preview(path, page),
            page_count: 120,
            source_sha256: sourceSha256,
          }));
        });
      }
      return Promise.resolve({ ...preview(path, page), page_count: 120, source_sha256: sourceSha256 });
    });

    try {
      render(<App />);
      await choosePdf(user);
      await startAnalysis(user);
      await screen.findByText('第 8 页 / 片段 1');
      await waitFor(() => expect(renderCalls.filter((page) => oldPages.includes(page)).length).toBeGreaterThanOrEqual(3));
      const startedOldPages = new Set(renderCalls);
      expect([...startedOldPages].every((page) => oldPages.includes(page))).toBe(true);

      const criteriaInput = await openSearchEditor(user);
      fireEvent.change(criteriaInput, { target: { value: '日期' } });
      await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
      for (let attempt = 0; attempt < 8 && !renderCalls.includes(newPage); attempt += 1) {
        oldPreviewResolvers.forEach((resolve) => resolve());
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      await screen.findByText(`第 ${newPage} 页 / 片段 1`);
      await waitFor(() => expect(renderCalls).toContain(newPage));
      expect(renderCalls.filter((page) => page >= 4 && page <= 8)).toHaveLength(0);
    } finally {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const pending = oldPreviewResolvers.splice(0);
        if (pending.length === 0) break;
        await act(async () => {
          pending.forEach((resolve) => resolve());
        });
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
  });

  it('keeps keyword editing responsive and waits for explicit analysis', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    const search = vi.mocked(localEngineAdapter.search);
    const callsBeforeEdit = search.mock.calls.length;

    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '示例实业' } });
    await new Promise((resolve) => setTimeout(resolve, 380));
    expect(search.mock.calls.length).toBe(callsBeforeEdit);

    expect((screen.getByRole('button', { name: '应用并重新分析' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('waits for explicit Enter and completes a zero-hit analysis with source metadata', async () => {
    const user = userEvent.setup();
    let resolveSearch: ((value: {
      status: 'ok';
      page_count: number;
      source_sha256: string;
      matches: never[];
    }) => void) | undefined;
    vi.mocked(localEngineAdapter.search).mockImplementation(() => new Promise((resolve) => {
      resolveSearch = resolve;
    }));

    render(<App />);
    await choosePdf(user);
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => ({
      ...preview(path, page),
      page_count: 1,
    }));
    expect(localEngineAdapter.search).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '开始分析' })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('textbox', { name: '包含关键词 1' }), { key: 'Enter' });
    expect(await screen.findByRole('button', { name: '正在分析…' })).toBeTruthy();
    expect(localEngineAdapter.search).toHaveBeenCalledTimes(1);
    resolveSearch?.({
      status: 'ok',
      page_count: 1,
      source_sha256: SOURCE_SHA256,
      matches: [],
    });

    const searchPanel = screen.getByRole('region', { name: '搜索条件' });
    const navigator = await screen.findByRole('region', { name: '审核导航' });
    expect(await within(searchPanel).findByRole('button', { name: '修改搜索条件' })).toBeTruthy();
    expect(await screen.findByText('1 页 · 文档已读取')).toBeTruthy();
    expect(within(navigator).getByText('未找到符合条件的回单')).toBeTruthy();
    expect(within(navigator).getByRole('button', { name: '修改搜索条件' })).toBeTruthy();
    expect(screen.queryByText(/0 个审核片段，全部已有自动裁剪候选/)).toBeNull();
    expect(localEngineAdapter.analyzePage).not.toHaveBeenCalled();
  });

  it('previews every physical page of a zero-hit source without changing review records', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(['/docs/a.pdf', '/docs/b.pdf']));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => ({
      status: 'ok',
      page_count: path.endsWith('a.pdf') ? 2 : 3,
      source_sha256: path.endsWith('a.pdf') ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
      matches: path.endsWith('a.pdf') ? [match(1)] : [],
    }));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, matches) => analysis(page, matches, 0));
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => ({
      ...preview(path, page, `data:image/png;base64,${path.endsWith('b.pdf') ? 'B' : 'A'}${page}`),
      page_count: path.endsWith('a.pdf') ? 2 : 3,
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getAllByText('第 1 页 / 片段 1').length).toBeGreaterThan(0));

    await user.click(within(screen.getByRole('list', { name: '当前来源文件' })).getByRole('button', { name: /^b\.pdf/ }));
    await waitFor(() => expect(localEngineAdapter.renderPage).toHaveBeenCalledWith('/docs/b.pdf', 1, SECOND_SOURCE_SHA256));
    expect(screen.getByAltText('b.pdf 第 1 页')).toBeTruthy();
    expect(screen.getByRole('button', { name: /第 1 页 \/ 片段 1/ }).getAttribute('aria-current')).toBe('true');
    const pageInput = screen.getByRole('textbox', { name: '当前 PDF 页码' });
    await user.clear(pageInput);
    await user.type(pageInput, '2{Enter}');

    await waitFor(() => expect(localEngineAdapter.renderPage).toHaveBeenCalledWith('/docs/b.pdf', 2, SECOND_SOURCE_SHA256));
    expect(screen.getByAltText('b.pdf 第 2 页')).toBeTruthy();
    expect((screen.getByRole('button', { name: '保留整页' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认当前片段' }) as HTMLButtonElement).disabled).toBe(true);
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(localEngineAdapter.renderPage).toHaveBeenCalledWith('/docs/b.pdf', 3, SECOND_SOURCE_SHA256));
    expect(screen.getByAltText('b.pdf 第 3 页')).toBeTruthy();
    expect((screen.getByRole('button', { name: '保留整页' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认当前片段' }) as HTMLButtonElement).disabled).toBe(true);
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('marks a zero-hit source changed even when its page preview resolves after switching sources', async () => {
    const user = userEvent.setup();
    let rejectBPreview: ((reason?: unknown) => void) | undefined;
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(['/docs/a.pdf', '/docs/b.pdf']));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => ({
      status: 'ok',
      page_count: 2,
      source_sha256: path.endsWith('a.pdf') ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
      matches: path.endsWith('a.pdf') ? [match(1)] : [],
    }));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, matches) => analysis(page, matches, 0));
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page) => {
      if (path.endsWith('b.pdf')) {
        return new Promise((_resolve, reject) => {
          rejectBPreview = reject;
        });
      }
      return Promise.resolve({ ...preview(path, page), page_count: 2 });
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 1 页 / 片段 1');

    await user.click(within(screen.getByRole('list', { name: '当前来源文件' })).getByRole('button', { name: /^b\.pdf/ }));
    await waitFor(() => expect(localEngineAdapter.renderPage).toHaveBeenCalledWith('/docs/b.pdf', 1, SECOND_SOURCE_SHA256));
    await user.click(reviewRow(/^a\.pdf/));
    rejectBPreview?.(sourceChangedError());

    await waitFor(() => expect(screen.getAllByText('源文件已变化，请重新分析').length).toBeGreaterThan(0));
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('ignores a duplicate source_changed from a second in-flight request for an already changed document', async () => {
    const user = userEvent.setup();
    const rejectBByPage = new Map<number, Array<(reason?: unknown) => void>>();
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(['/docs/a.pdf', '/docs/b.pdf']));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => ({
      status: 'ok',
      page_count: 3,
      source_sha256: path.endsWith('a.pdf') ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
      matches: path.endsWith('a.pdf') ? [match(1)] : [match(1), match(2), match(3)],
    }));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, matches) => analysis(page, matches, 0));
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page) => {
      if (path.endsWith('b.pdf')) {
        return new Promise((_resolve, reject) => {
          const rejects = rejectBByPage.get(page) ?? [];
          rejects.push(reject);
          rejectBByPage.set(page, rejects);
        });
      }
      return Promise.resolve({ ...preview(path, page), page_count: 3 });
    });

    try {
      render(<App />);
      await choosePdf(user);
      await startAnalysis(user);
      await waitFor(() => expect(screen.getAllByText('第 1 页 / 片段 1').length).toBeGreaterThan(0));
      await waitFor(() => {
        expect(rejectBByPage.get(1)?.[0]).toBeTypeOf('function');
        expect(rejectBByPage.get(2)?.[0]).toBeTypeOf('function');
      });
      // Only two slots belong to background validation. Explicitly view the
      // third page to retain this test's three in-flight integrity events.
      await user.click(screen.getByText('第 3 页 / 片段 1'));
      await waitFor(() => expect(rejectBByPage.get(3)?.[0]).toBeTypeOf('function'));

      // Deliver both rejections before yielding to React. This models two
      // background page requests reporting the same source change in one tick;
      // the second event must be completely inert.
      rejectBByPage.get(1)?.[0]?.(sourceChangedError('第一次检测到源文件变化'));
      rejectBByPage.get(2)?.[0]?.(sourceChangedError('第二次同 tick 源变化'));
      await waitFor(() => expect(screen.getAllByText('第一次检测到源文件变化').length).toBeGreaterThan(0));
      expect(screen.queryByText('第二次同 tick 源变化')).toBeNull();

      await user.click(reviewRow(/^a\.pdf/));
      await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
      await user.click(screen.getByRole('button', { name: '保留整页' }));
      await waitFor(() => expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalled());
      const saveCallsBeforeLateEvent = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length;

      rejectBByPage.get(3)?.[0]?.(sourceChangedError('第二次迟到源变化'));
      await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
      expect(screen.queryByText('第二次迟到源变化')).toBeNull();
      expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length).toBe(saveCallsBeforeLateEvent);
    } finally {
      for (const rejects of rejectBByPage.values()) {
        await act(async () => {
          rejects.forEach((reject) => reject(sourceChangedError('清理挂起预览')));
        });
      }
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });

  it('ignores a stale source_changed preview after the same path is reanalyzed with a new SHA', async () => {
    const user = userEvent.setup();
    let searchCount = 0;
    let deferOldPreview = false;
    let rejectOldPreview: ((reason?: unknown) => void) | undefined;
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValueOnce(pickerResult(['/docs/source.pdf']));
    vi.mocked(localEngineAdapter.search).mockImplementation(async () => ({
      status: 'ok',
      page_count: 20,
      source_sha256: searchCount++ === 0 ? SOURCE_SHA256 : CHANGED_SOURCE_SHA256,
      matches: [match(4)],
    }));
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page, sourceSha256) => {
      if (deferOldPreview && sourceSha256 === SOURCE_SHA256 && page === 12) {
        return new Promise((_resolve, reject) => {
          rejectOldPreview = reject;
        });
      }
      return Promise.resolve({
        ...preview(path, page),
        source_sha256: sourceSha256,
      });
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());

    deferOldPreview = true;
    const pageInput = screen.getByLabelText('当前 PDF 页码');
    await user.clear(pageInput);
    await user.type(pageInput, '12{Enter}');
    await waitFor(() => expect(rejectOldPreview).toBeTypeOf('function'));

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValueOnce(pickerResult(['/docs/source.pdf']));
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getByText('20 页 · 文档已读取')).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    await waitFor(() => expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false));

    rejectOldPreview?.(sourceChangedError());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText('20 页 · 文档已读取')).toBeTruthy();
    expect(screen.queryByText('源文件已变化，请重新分析')).toBeNull();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('ignores an old preview rejection after a same-path SHA commit', async () => {
    const user = userEvent.setup();
    let searchCount = 0;
    let rejectOldPreview: ((reason?: unknown) => void) | undefined;
    let lateEventSent = false;
    vi.mocked(localEngineAdapter.search).mockImplementation(async () => {
      if (searchCount++ === 0) {
        return {
          status: 'ok',
          page_count: 20,
          source_sha256: SOURCE_SHA256,
          matches: [match(4)],
        };
      }
      return {
        status: 'ok',
        page_count: 20,
        source_sha256: CHANGED_SOURCE_SHA256,
        matches: [match(4)],
      };
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page, sourceSha256) => {
      if (sourceSha256 === SOURCE_SHA256 && page === 4) {
        return new Promise((_resolve, reject) => {
          rejectOldPreview = reject;
        });
      }
      return Promise.resolve({
        ...preview(path, page),
        page_count: 20,
        source_sha256: sourceSha256,
      });
    });

    try {
      render(<App />);
      await choosePdf(user);
      await startAnalysis(user);
      await waitFor(() => expect(rejectOldPreview).toBeTypeOf('function'));

      const criteriaInput = await openSearchEditor(user);
      fireEvent.change(criteriaInput, { target: { value: '日期' } });
      await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
      await waitFor(() => expect(screen.getByText('20 页 · 文档已读取')).toBeTruthy());
      // Wait for the replacement context to commit and begin its new-SHA
      // visible preview before delivering the old request's rejection. The
      // v2 digest/prepare chain can outlive the search response itself.
      await waitFor(() => expect(localEngineAdapter.renderPage).toHaveBeenCalledWith(
        '/docs/source.pdf',
        4,
        CHANGED_SOURCE_SHA256,
      ));
      window.setTimeout(() => {
        lateEventSent = true;
        rejectOldPreview?.(sourceChangedError('旧预览迟到'));
      }, 0);
      await waitFor(() => expect(lateEventSent).toBe(true));
      await waitFor(() => expect(screen.queryByText('旧预览迟到')).toBeNull());
      await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
      expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false);
      expect(within(screen.getByRole('region', { name: '搜索条件' })).getByRole('button', { name: '修改搜索条件' })).toBeTruthy();
    } finally {
      rejectOldPreview?.(sourceChangedError('清理挂起旧预览'));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });

  it('reports missing source geometry without dereferencing an absent geometry record', () => {
    const segment = {
      id: 'missing-geometry',
      sourcePath: '/docs/source.pdf',
      sourceSha256: SOURCE_SHA256,
      sourcePage: 4,
      segmentNo: 1,
      matchRect: { x0: 40, y0: 80, x1: 120, y1: 104 },
      candidateRect: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 220 },
      finalRect: null,
      pageWidth: PAGE_WIDTH,
      pageHeight: PAGE_HEIGHT,
      confidence: 0.96,
      slot: 'receipt',
      snapPoints: [],
      layoutFingerprint: 'geometry',
      mode: 'candidate' as const,
      reviewStatus: 'confirmed' as const,
      manualAdjusted: false,
    } satisfies ReviewSegment;

    expect(() => previewValidationError(preview('/docs/source.pdf', 4), segment, undefined)).not.toThrow();
    expect(previewValidationError(preview('/docs/source.pdf', 4), segment, undefined)).toBe('geometry');
  });

  it('blocks a source immediately when a background page changes before a sibling preview settles', async () => {
    const user = userEvent.setup();
    let resolveSibling: ((value: ReturnType<typeof preview>) => void) | undefined;
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4), match(12)],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, matches) => analysis(page, matches, page === 4 ? 0 : 280));
    vi.mocked(localEngineAdapter.renderPage).mockImplementation((path, page) => {
      if (page === 4) {
        return new Promise((resolve) => {
          resolveSibling = resolve;
        });
      }
      return Promise.reject(sourceChangedError());
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 12 页 / 片段 1');

    await waitFor(() => expect(screen.getAllByText('源文件已变化，请重新分析').length).toBeGreaterThan(0), { timeout: 600 });
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    resolveSibling?.(preview('/docs/source.pdf', 4));
  });

  it('releases a pending group save when a stale page request reports source_changed', async () => {
    const user = userEvent.setup();
    let saveGroup: (() => void) | undefined;
    let deferPage4Retry = false;
    let rejectPage4: ((error: unknown) => void) | undefined;
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => {
      if (deferPage4Retry && page === 4) {
        return new Promise((_, reject) => {
          rejectPage4 = reject;
        });
      }
      return preview(path, page);
    });
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockImplementation((contextKey, resultRevision, segments) => new Promise((resolve) => {
      saveGroup = () => resolve(acknowledgeReviewSave(contextKey, resultRevision, segments));
    }));

    render(<App />);
    await loadResults(user);
    deferPage4Retry = true;
    const page12Row = screen.getByRole('button', { name: /第 12 页 \/ 片段 1/ });
    await user.click(page12Row);
    await waitFor(() => expect((screen.getByLabelText('当前 PDF 页码') as HTMLInputElement).value).toBe('12'));
    const page4Row = screen.getByRole('button', { name: /第 4 页 \/ 片段 1/ });
    await user.click(page4Row);
    await waitFor(() => expect(rejectPage4).toBeTypeOf('function'));
    // Switch away while the page-4 request is still pending so the group can
    // be confirmed from the ready page-12 view. The stale page-4 failure must
    // still release that pending save when it reports source_changed.
    await user.click(page12Row);
    await waitFor(() => expect((screen.getByLabelText('当前 PDF 页码') as HTMLInputElement).value).toBe('12'));
    await waitFor(() => expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.some((call) => call[1] === 12)).toBe(true));

    await waitFor(() => expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '确认整组' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存中…' }).getAttribute('aria-busy')).toBe('true'));

    rejectPage4?.(sourceChangedError());
    await waitFor(() => expect(screen.getAllByText('源文件已变化，请重新分析').length).toBeGreaterThan(0));
    const releasedGroupAction = screen.getByRole('button', { name: '确认整组' });
    expect(releasedGroupAction.getAttribute('aria-busy')).not.toBe('true');
    expect((releasedGroupAction as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('正在保存整组审核…')).toBeNull();
    saveGroup?.();
  });

  it('fails closed while the selected page is being revalidated', async () => {
    const user = userEvent.setup();
    let delayPage4 = false;
    let releasePage4: ((value: ReturnType<typeof preview>) => void) | undefined;
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => {
      if (delayPage4 && page === 4) {
        return new Promise((resolve) => {
          releasePage4 = resolve;
        });
      }
      return preview(path, page);
    });

    render(<App />);
    await loadResults(user);
    const page12Row = screen.getByRole('button', { name: /第 12 页 \/ 片段 1/ });
    await user.click(page12Row);
    await waitFor(() => expect((screen.getByLabelText('当前 PDF 页码') as HTMLInputElement).value).toBe('12'));

    delayPage4 = true;
    await user.click(screen.getByRole('button', { name: /第 4 页 \/ 片段 1/ }));
    await waitFor(() => expect(screen.getByText('正在渲染第 4 页…')).toBeTruthy());

    expect((screen.getByRole('button', { name: '保留整页' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认当前片段' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '保存当前裁剪' })).toBeNull();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();

    releasePage4?.(preview('/docs/source.pdf', 4));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
  });

  it('does not render a page for a non-integer page input', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    const pageInput = screen.getByLabelText('当前 PDF 页码') as HTMLInputElement;
    const renderCallsBeforeInvalidInput = vi.mocked(localEngineAdapter.renderPage).mock.calls.length;

    await user.clear(pageInput);
    await user.type(pageInput, '4.5{Enter}');
    await waitFor(() => expect(screen.getByText('请输入 1–20 的页码')).toBeTruthy());

    expect(pageInput.value).toBe('4');
    expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.length).toBe(renderCallsBeforeInvalidInput);
  });

  it('gates the group when a zero-hit source changes while preserving an unaffected source edit', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(['/docs/a.pdf', '/docs/b.pdf']));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => ({
      status: 'ok',
      page_count: 2,
      source_sha256: path.endsWith('a.pdf') ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
      matches: path.endsWith('a.pdf') ? [match(1)] : [],
    }));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, matches) => analysis(page, matches, 0));
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => {
      if (path.endsWith('b.pdf')) throw sourceChangedError();
      return { ...preview(path, page), page_count: 2 };
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 1 页 / 片段 1');
    await waitFor(() => expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '确认整组' }));
    await waitFor(() => expect(confirmedPreviewAction().disabled).toBe(false));
    expect((screen.getByRole('button', { name: /生成 PDF 导出预览/ }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(within(screen.getByRole('list', { name: '当前来源文件' })).getByRole('button', { name: /^b\.pdf/ }));
    await waitFor(() => expect(screen.getAllByText('源文件已变化，请重新分析').length).toBeGreaterThan(0));
    expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.filter((call) => call[0] === '/docs/b.pdf')).toHaveLength(1);
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();

    await user.click(reviewRow(/^a\.pdf/));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    const savesBeforeEdit = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length;
    await user.click(screen.getByRole('button', { name: '保留整页' }));
    await waitFor(() => expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(savesBeforeEdit + 1));
    expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.at(-1)?.[2][0]).toMatchObject({
      source_path: '/docs/a.pdf',
      source_sha256: SOURCE_SHA256,
    });

    await user.click(screen.getByRole('button', { name: '确认当前片段' }));
    await waitFor(() => expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(savesBeforeEdit + 2));
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
  });


  it('commits page drafts on Enter and blur, restores them on Escape, and rejects invalid ranges', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    await screen.findByAltText('PDF 页面预览');

    const pageInput = screen.getByRole('textbox', { name: '当前 PDF 页码' }) as HTMLInputElement;
    await user.clear(pageInput);
    await user.type(pageInput, '3');
    fireEvent.blur(pageInput);
    await waitFor(() => expect(screen.getByAltText('source.pdf 第 3 页')).toBeTruthy());
    expect(pageInput.value).toBe('3');
    expect(screen.getByText('第 4 页 / 片段 1')).toBeTruthy();
    expect((screen.getByRole('button', { name: '保留整页' }) as HTMLButtonElement).disabled).toBe(true);

    await user.clear(pageInput);
    await user.type(pageInput, '99{Enter}');
    expect(pageInput.value).toBe('3');
    expect(screen.getByText('请输入 1–20 的页码')).toBeTruthy();

    await user.clear(pageInput);
    await user.type(pageInput, '2');
    await user.keyboard('{Escape}');
    expect(pageInput.value).toBe('3');
    expect(screen.getByAltText('source.pdf 第 3 页')).toBeTruthy();
  });

  it('synchronizes source and physical page when selecting a segment across PDFs', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(['/docs/a.pdf', '/docs/b.pdf']));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => ({
      status: 'ok',
      page_count: 4,
      source_sha256: path.endsWith('a.pdf') ? SOURCE_SHA256 : SECOND_SOURCE_SHA256,
      matches: [match(path.endsWith('a.pdf') ? 2 : 3)],
    }));
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, matches) => analysis(page, matches, 0));
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => ({
      ...preview(path, page),
      page_count: 4,
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 2 页 / 片段 1');
    await screen.findByText('第 3 页 / 片段 1');

    await user.click(screen.getByText('第 3 页 / 片段 1'));
    await waitFor(() => expect((screen.getByRole('textbox', { name: '当前 PDF 页码' }) as HTMLInputElement).value).toBe('3'));
    expect(reviewRow(/^b\.pdf/).getAttribute('aria-current')).toBe('true');
    expect(screen.getByLabelText('裁剪区域')).toBeTruthy();
    expect(localEngineAdapter.renderPage).toHaveBeenCalledWith('/docs/b.pdf', 3, SECOND_SOURCE_SHA256);

    await user.click(screen.getByText('第 2 页 / 片段 1'));
    await waitFor(() => expect((screen.getByRole('textbox', { name: '当前 PDF 页码' }) as HTMLInputElement).value).toBe('2'));
    expect(reviewRow(/^a\.pdf/).getAttribute('aria-current')).toBe('true');
    expect(screen.getByLabelText('裁剪区域')).toBeTruthy();
  });

  it('marks a source changed on a current-page SHA mismatch and never retries the changed source', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4)],
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => ({
      ...preview(path, page),
      source_sha256: CHANGED_SOURCE_SHA256,
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 4 页 / 片段 1');
    await waitFor(() => expect(screen.getAllByText('源文件已变化，请重新分析').length).toBeGreaterThan(0));
    const renderCallCount = vi.mocked(localEngineAdapter.renderPage).mock.calls.length;

    const pageInput = screen.getByRole('textbox', { name: '当前 PDF 页码' });
    await user.clear(pageInput);
    await user.type(pageInput, '5{Enter}');
    await waitFor(() => expect((pageInput as HTMLInputElement).value).toBe('5'));
    expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.length).toBe(renderCallCount);
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('marks a source changed when the current-page preview page count differs', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4)],
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => ({
      ...preview(path, page),
      page_count: 19,
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 4 页 / 片段 1');
    await waitFor(() => expect(screen.getAllByText('源文件已变化，请重新分析').length).toBeGreaterThan(0));
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('routes source_changed thrown by analyzePage through the source-level gate', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4)],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockRejectedValue(sourceChangedError('分析期间源文件已变化，请重新分析'));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getAllByText('分析期间源文件已变化，请重新分析')).toBeTruthy());
    expect(screen.getAllByText(/源文件已变化，请重新分析/).length).toBeGreaterThan(0);
    expect(screen.queryByText('第 4 页 / 片段 1')).toBeNull();
    expect(localEngineAdapter.renderPage).not.toHaveBeenCalled();
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();
  });

  it('routes source_changed from fallback page validation through the source-level gate', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4)],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockRejectedValue(new Error('analysis unavailable'));
    vi.mocked(localEngineAdapter.renderPage).mockRejectedValue(
      sourceChangedError('回退页面校验期间源文件已变化，请重新分析'),
    );

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);

    await waitFor(() => expect(screen.getByText('回退页面校验期间源文件已变化，请重新分析')).toBeTruthy());
    expect(screen.getAllByText(/源文件已变化，请重新分析/).length).toBeGreaterThan(0);
    expect(screen.queryByText('第 4 页 / 片段 1')).toBeNull();
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();
    expect(vi.mocked(localEngineAdapter.renderPage).mock.calls).toContainEqual([
      '/docs/source.pdf',
      4,
      SOURCE_SHA256,
    ]);
  });

  it('marks the source changed when fallback page metadata reports a different count', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4)],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockRejectedValue(new Error('analysis unavailable'));
    vi.mocked(localEngineAdapter.renderPage).mockResolvedValue({
      ...preview('/docs/source.pdf', 4),
      page_count: 19,
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);

    await waitFor(() => expect(screen.getByText('页面预览页数与搜索结果不一致，已阻止确认。')).toBeTruthy());
    expect(screen.getAllByText(/源文件已变化，请重新分析/).length).toBeGreaterThan(0);
    expect(screen.queryByText('第 4 页 / 片段 1')).toBeNull();
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();
  });

  it('routes an analysis response with a different source SHA through the source-level gate', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4)],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockResolvedValue({
      ...analysis(4, [match(4)], 0),
      source_sha256: CHANGED_SOURCE_SHA256,
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);

    await waitFor(() => expect(screen.getAllByText('源 PDF 已变化，请重新分析文件。')).toBeTruthy());
    expect(screen.getAllByText(/源文件已变化，请重新分析/).length).toBeGreaterThan(0);
    expect(screen.queryByText('第 4 页 / 片段 1')).toBeNull();
    expect(localEngineAdapter.renderPage).not.toHaveBeenCalled();
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '当前审核操作' })).toBeNull();
  });

  it('handles source_changed from a background page and does not issue a render loop', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4), match(12)],
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => {
      if (page === 12) throw sourceChangedError();
      return preview(path, page);
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 12 页 / 片段 1');
    await waitFor(() => expect(screen.getAllByText('源文件已变化，请重新分析').length).toBeGreaterThan(0));
    expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.filter((call) => call[1] === 12)).toHaveLength(1);
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);

    const pageInput = screen.getByRole('textbox', { name: '当前 PDF 页码' });
    await user.clear(pageInput);
    await user.type(pageInput, '13{Enter}');
    await waitFor(() => expect((pageInput as HTMLInputElement).value).toBe('13'));
    expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.filter((call) => call[1] === 12)).toHaveLength(1);
  });

  it('restores a changed source only after a successful reanalysis with a new SHA', async () => {
    const user = userEvent.setup();
    let sourceChanged = true;
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [match(4)],
    });
    vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page) => {
      if (sourceChanged) throw sourceChangedError();
      return { ...preview(path, page), source_sha256: CHANGED_SOURCE_SHA256 };
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await screen.findByText('第 4 页 / 片段 1');
    await waitFor(() => expect(screen.getAllByText('源文件已变化，请重新分析').length).toBeGreaterThan(0));

    sourceChanged = false;
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: CHANGED_SOURCE_SHA256,
      matches: [match(4)],
    });
    await user.click(screen.getByRole('button', { name: '重新分析整批' }));
    await waitFor(() => expect(screen.getByText('20 页 · 文档已读取')).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect(screen.queryByText('源文件已变化，请重新分析')).toBeNull();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps committed results after a completed analysis rerun fails', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);
    await openSearchEditor(user);
    vi.mocked(localEngineAdapter.search).mockRejectedValueOnce(new Error('rerun unavailable'));

    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));

    expect((await screen.findAllByText(/1 个 PDF 未完成分析/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '重新分析整批' })).toBeTruthy();
    expect(screen.getByText('20 页 · 文档已读取')).toBeTruthy();
    expect(screen.getByRole('button', { name: /第 4 页 \/ 片段 1/ })).toBeTruthy();
  });

  it('commits no source metadata when one response in a multi-source batch is invalid', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult(['/docs/a.pdf', '/docs/b.pdf']));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => ({
      status: 'ok',
      page_count: path.endsWith('a.pdf') ? 3 : 7,
      source_sha256: path.endsWith('a.pdf') ? SOURCE_SHA256 : '',
      matches: path.endsWith('a.pdf') ? [match(1)] : [],
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);

    expect(await screen.findByText('本地搜索失败：搜索响应的源 PDF SHA-256 无效。')).toBeTruthy();
    expect(screen.getAllByText('页数待分析')).toHaveLength(2);
    expect(screen.queryByText(/文档已读取/)).toBeNull();
    expect(screen.queryByText('第 1 页 / 片段 1')).toBeNull();
  });

  it('keeps the current task untouched when native and browser file selection are cancelled', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await loadResults(user);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValueOnce(pickerResult([]));
    await choosePdf(user);
    expect(await screen.findByText('已取消选择，当前任务保持不变。')).toBeTruthy();
    expect(screen.getByText('第 4 页 / 片段 1')).toBeTruthy();
    expect(screen.getByText('20 页 · 文档已读取')).toBeTruthy();
    expect(screen.getByLabelText('裁剪区域')).toBeTruthy();

    vi.mocked(localEngineAdapter.pickPdfFiles).mockRejectedValueOnce(new Error('native picker unavailable'));
    await choosePdf(user);
    const fileInput = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[0];
    expect(fileInput).toBeTruthy();
    fireEvent.change(fileInput!, { target: { files: [] } });
    expect(await screen.findByText('已取消选择，当前任务保持不变。')).toBeTruthy();
    expect(screen.getByText('第 4 页 / 片段 1')).toBeTruthy();
    expect(screen.getByText('20 页 · 文档已读取')).toBeTruthy();
    expect(screen.getByLabelText('裁剪区域')).toBeTruthy();
  });

  it('appends sources, deduplicates normalized paths, and resets analysis on source changes', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loadResults(user);

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValueOnce(pickerResult([
      '/docs/source.pdf',
      'C:\\docs\\NEW.pdf',
      'c:/docs/new.pdf',
    ]));
    await addPdf(user);

    expect(await screen.findByText('NEW.pdf')).toBeTruthy();
    expect(screen.getByText('source.pdf')).toBeTruthy();
    expect(screen.getAllByText('页数待分析')).toHaveLength(2);
    expect(await screen.findByText(/已去除 1 个重复路径/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始分析' })).toBeTruthy();
    expect(screen.queryByText('第 4 页 / 片段 1')).toBeNull();

    await user.click(screen.getByRole('button', { name: '移除全部文件' }));
    expect(screen.getByText('尚未选择文件')).toBeTruthy();
    expect((screen.getByRole('button', { name: '开始分析' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/文档已读取/)).toBeNull();
  });

  it('appends browser-selected PDFs after a native picker fallback', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await choosePdf(user);

    vi.mocked(localEngineAdapter.pickPdfFiles).mockRejectedValueOnce(new Error('native picker unavailable'));
    await addPdf(user);
    const fileInput = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[0];
    expect(fileInput).toBeTruthy();
    const added = new File(['pdf'], 'second.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput!, { target: { files: [added] } });

    expect(await screen.findByText('source.pdf')).toBeTruthy();
    expect(await screen.findByText('second.pdf')).toBeTruthy();
    expect(screen.getAllByText('页数待分析')).toHaveLength(2);
    expect(screen.queryByText('第 4 页 / 片段 1')).toBeNull();
  });

  it('follows the second same-page candidate after switching keywords', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockImplementation(async (_path, keyword) => {
      const secondY = keyword === '手续费' ? 400 : 520;
      const matchedText = keyword === '手续费' ? '手续费' : '金额';
      return {
        status: 'ok',
        page_count: 20,
        source_sha256: SOURCE_SHA256,
        matches: [
          { ...match(1, 40, 80), matched_text: matchedText },
          { ...match(1, 40, secondY), matched_text: matchedText },
        ],
      };
    });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, matches) => ({
      status: 'ok',
      page,
      page_width: PAGE_WIDTH,
      page_height: PAGE_HEIGHT,
      selections: matches.map((item, index) => ({
        match_rect: item,
        rect: {
          x0: 0,
          y0: index === 0 ? 0 : item.y0,
          x1: PAGE_WIDTH,
          y1: (index === 0 ? 0 : item.y0) + 200,
        },
        confidence: 0.96,
        slot: index === 0 ? 'top' : 'middle',
        evidence: ['geometry'],
        needs_review: false,
      })),
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getByText('第 1 页 / 片段 2')).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());

    const initialHits = screen.getAllByRole('button', { name: /第 1 页 \/ 片段/ });
    expect(initialHits).toHaveLength(2);
    await user.click(initialHits[0]);
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('0%');
    await user.click(initialHits[1]);
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('50%');

    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '金额' } });
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    // The previous result has the same page/segment labels and remains visible
    // during analysis. Wait for the new applied condition before selecting it.
    await screen.findByLabelText(/已应用搜索条件：.*金额/);
    const updatedHits = screen.getAllByRole('button', { name: /第 1 页 \/ 片段/ });
    expect(updatedHits).toHaveLength(2);
    await user.click(updatedHits[1]);
    await waitFor(() => expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('65%'));
  });

  it('clears a previous full-page decision before switching back to a cropped match', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.search).mockImplementation(async (_path, keyword) => keyword === '演示农业'
      ? {
        status: 'ok',
        page_count: 20,
        source_sha256: SOURCE_SHA256,
        matches: [match(1, 40, 120), match(1, 40, 520)],
      }
      : {
        status: 'ok',
        page_count: 20,
        source_sha256: SOURCE_SHA256,
        matches: [{ ...match(1, 40, 520), matched_text: '示例实业' }],
      });
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (_path, page, matches) => ({
      status: 'ok',
      page,
      page_width: PAGE_WIDTH,
      page_height: PAGE_HEIGHT,
      page_fully_matched: matches.length === 2,
      selections: matches.map((item, index) => ({
        match_rect: item,
        rect: matches.length === 2
          ? { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: PAGE_HEIGHT }
          : { x0: 0, y0: 400, x1: PAGE_WIDTH, y1: 720 },
        confidence: 0.98,
        slot: index === 0 ? 'top' : 'bottom',
        evidence: ['geometry'],
        needs_review: false,
      })),
    }));

    render(<App />);
    await choosePdf(user);
    fireEvent.change(screen.getByRole('textbox', { name: '包含关键词 1' }), { target: { value: '演示农业' } });
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await waitFor(() => expect(screen.getByText('第 1 页 / 片段 2')).toBeTruthy());
    await waitFor(() => expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.height).toBe('100%'));

    const criteriaInput = await openSearchEditor(user);
    fireEvent.change(criteriaInput, { target: { value: '示例实业' } });
    await user.click(screen.getByRole('button', { name: '应用并重新分析' }));
    await waitFor(() => expect(screen.getByText('第 1 页 / 片段 1')).toBeTruthy());
    await waitFor(() => expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('50%'));
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.height).not.toBe('100%');
  });

  it('keeps full-page review decisions when every receipt on a page matches', async () => {
    const user = userEvent.setup();
    const first = match(1, 40, 120);
    const second = match(1, 40, 520);
    vi.mocked(localEngineAdapter.search).mockResolvedValue({
      status: 'ok',
      page_count: 20,
      source_sha256: SOURCE_SHA256,
      matches: [first, second],
    });
    vi.mocked(localEngineAdapter.analyzePage).mockResolvedValue({
      status: 'ok',
      page: 1,
      page_width: PAGE_WIDTH,
      page_height: PAGE_HEIGHT,
      page_fully_matched: true,
      selections: [first, second].map((item, index) => ({
        match_rect: item,
        rect: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: PAGE_HEIGHT },
        confidence: 0.98,
        slot: index === 0 ? 'top' : 'bottom',
        evidence: ['page_fully_matched'],
        needs_review: false,
      })),
    });

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getByText('第 1 页 / 片段 2')).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.top).toBe('0%');
    expect((screen.getByLabelText('裁剪区域') as HTMLElement).style.height).toBe('100%');

    const fullPageConfirm = screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement;
    await waitFor(() => expect(fullPageConfirm.disabled).toBe(false));
    await user.click(fullPageConfirm);
    await waitFor(() => expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalled());
    await waitFor(() => expect(confirmedPreviewAction().disabled).toBe(false));
    const saved = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.at(-1)![2];
    expect(saved).toHaveLength(2);
    expect(saved.every((row) => row.crop_mode === 'full_page' && row.review_status === 'group_confirmed')).toBe(true);

  });

  it('uses the right navigator as the only review list and keeps the real editor central', async () => {
    const user = userEvent.setup();
    render(<App />);

    await loadResults(user);
    expect(screen.getByRole('region', { name: '审核导航' })).toBeTruthy();
    expect(screen.queryByText('裁剪片段复核')).toBeNull();
    expect(screen.queryByText('暂无缩略图')).toBeNull();
    expect(screen.getByText('真实 PDF 预览')).toBeTruthy();
    expect(screen.getByLabelText('审核片段')).toBeTruthy();
  });

  it('renders two named vertical workspace separators around the central editor', () => {
    render(<App />);

    const separators = screen.getAllByRole('separator');
    expect(separators).toHaveLength(2);
    expect(separators.every((separator) => separator.getAttribute('aria-orientation') === 'vertical')).toBe(true);
    expect(screen.getByRole('separator', { name: '调整左栏宽度' })).toBeTruthy();
    expect(screen.getByRole('separator', { name: '调整右栏宽度' })).toBeTruthy();
  });

  it('keeps one set of source and search controls around the central preview', async () => {
    const user = userEvent.setup();
    render(<App />);

    await loadResults(user);

    const sourcePanel = screen.getByRole('complementary', { name: '当前文件' });
    const preview = screen.getByRole('region', { name: '源 PDF 预览' });
    const searchPanel = screen.getByRole('region', { name: '搜索条件' });
    const reviewNavigator = screen.getByRole('region', { name: '审核导航' });
    const previewColumn = preview.closest('.preview-column');
    const resultsColumn = reviewNavigator.closest('.results-column');

    expect(screen.queryByText('CURRENT TASK')).toBeNull();
    expect(screen.queryByText('本次审核')).toBeNull();
    expect(screen.queryByText(/命中结果 · 本地引擎/)).toBeNull();
    expect(screen.queryByText(/关键词定位/)).toBeNull();
    expect(screen.queryByRole('button', { name: '保存当前裁剪' })).toBeNull();
    expect(screen.queryByRole('button', { name: '清除结果' })).toBeNull();
    expect(within(searchPanel).getAllByRole('button', { name: '修改搜索条件' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '选择 PDF' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '选择文件夹' })).toHaveLength(1);
    expect(sourcePanel.contains(preview)).toBe(false);
    expect(previewColumn?.querySelector('.review-action-card')).toBeTruthy();
    expect(resultsColumn?.querySelector('.review-action-card')).toBeNull();
    expect(resultsColumn?.querySelector('.review-navigator')).toBeTruthy();
  });

  it('keeps startup OCR at installed-pending-verification and supports an explicit successful check', async () => {
    const user = userEvent.setup();
    let resolveVerification!: (value: {
      status: 'ok';
      available: boolean;
      engine: 'paddleocr';
      message: string;
      readiness: 'ready';
    }) => void;
    const verification = new Promise<{
      status: 'ok';
      available: boolean;
      engine: 'paddleocr';
      message: string;
      readiness: 'ready';
    }>((resolve) => { resolveVerification = resolve; });
    vi.mocked(localEngineAdapter.ocrHealth).mockImplementation((verify = false) => verify
      ? verification
      : Promise.resolve({
        status: 'ok', available: true, engine: 'paddleocr',
        message: 'OCR 运行库已安装，尚未执行识别验证。', readiness: 'installed' as const,
      }));

    render(<App />);
    await waitFor(() => expect(screen.getByText(/OCR 已安装，待验证/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '帮助与反馈' }));
    const dialog = screen.getByRole('dialog', { name: '帮助与反馈' });
    expect(within(dialog).getByRole('status').textContent).toContain('OCR 已安装，待验证');
    const check = screen.getByRole('button', { name: '检测 OCR' }) as HTMLButtonElement;
    await user.click(check);
    expect(vi.mocked(localEngineAdapter.ocrHealth)).toHaveBeenLastCalledWith(true);
    expect(check.disabled).toBe(true);
    resolveVerification({
      status: 'ok', available: true, engine: 'paddleocr',
      message: 'OCR 已通过脱敏样本验证。', readiness: 'ready',
    });
    await waitFor(() => expect(within(dialog).getByRole('status').textContent).toContain('OCR 已验证可用'));
    expect((screen.getByRole('button', { name: '检测 OCR' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('wires Help Center OCR cache controls to fixed adapter calls without exposing paths', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.ocrCacheInfo).mockResolvedValueOnce({
      status: 'ok', available: true, entries: 2, bytes: 2_048,
      max_bytes: 268_435_456, retention_days: 30,
    });
    vi.mocked(localEngineAdapter.ocrCacheClear).mockResolvedValueOnce({
      status: 'ok', available: true, entries: 0, bytes: 0,
      max_bytes: 268_435_456, retention_days: 30,
      removed_entries: 2, failed_entries: 0,
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: '帮助与反馈' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '帮助与反馈' }));
    const dialog = screen.getByRole('dialog', { name: '帮助与反馈' });
    const read = within(dialog).getByRole('button', { name: '查看占用' }) as HTMLButtonElement;
    await waitFor(() => expect(read.disabled).toBe(false));
    await user.click(read);
    await waitFor(() => expect(within(dialog).getByText(/2 条 · 2.0 KB/)).toBeTruthy());
    expect(localEngineAdapter.ocrCacheInfo).toHaveBeenCalledWith();

    await user.click(within(dialog).getByRole('button', { name: '清除识别缓存' }));
    await waitFor(() => expect(within(dialog).getByText('已清除 2 条识别缓存。下次识别将重新生成缓存。')).toBeTruthy());
    expect(localEngineAdapter.ocrCacheClear).toHaveBeenCalledWith();
    expect(within(dialog).queryByText(/缓存路径|OCR 文字/)).toBeNull();
  });

  it('shows a safe OCR verification failure in the top status and feedback preview', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.ocrHealth).mockImplementation(async (verify = false) => verify
      ? {
        status: 'ok', available: true, engine: 'paddleocr',
        message: 'OCR 识别失败。', readiness: 'failed' as const, code: 'ocr_inference_failed' as const,
      }
      : {
        status: 'ok', available: true, engine: 'paddleocr',
        message: 'OCR 运行库已安装，尚未执行识别验证。', readiness: 'installed' as const,
      });

    render(<App />);
    await waitFor(() => expect(screen.getByText(/OCR 已安装，待验证/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '帮助与反馈' }));
    await user.click(screen.getByRole('button', { name: '检测 OCR' }));
    const dialog = screen.getByRole('dialog', { name: '帮助与反馈' });
    await waitFor(() => expect(within(dialog).getByRole('status').textContent).toContain('OCR 验证失败'));
    await user.click(screen.getByRole('tab', { name: /使用反馈/ }));
    await user.type(screen.getByRole('textbox', { name: /问题描述/ }), 'OCR 检测失败。');
    await user.click(screen.getByRole('button', { name: '生成反馈预览' }));
    expect((screen.getByRole('textbox', { name: '反馈预览' }) as HTMLTextAreaElement).value)
      .toContain('OCR 状态：验证失败');
    expect((screen.getByRole('textbox', { name: '反馈预览' }) as HTMLTextAreaElement).value)
      .not.toContain('OCR 识别失败。');
  });

  it('shows all selected sources and disambiguates duplicate names in review rows', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue(pickerResult([
      '/docs/account-a/receipt.pdf',
      '/docs/account-b/receipt.pdf',
      '/docs/account-c/other.pdf',
      '/docs/account-d/fourth.pdf',
      '/docs/account-e/fifth.pdf',
    ]));
    vi.mocked(localEngineAdapter.search).mockImplementation(async (path) => ({
      status: 'ok',
      page_count: 20,
      source_sha256: path.includes('account-a')
        ? SOURCE_SHA256
        : path.includes('account-b')
          ? SECOND_SOURCE_SHA256
          : path.includes('account-c')
            ? THIRD_SOURCE_SHA256
            : 'e'.repeat(64),
      matches: [match(1)],
    }));

    render(<App />);
    await choosePdf(user);
    await startAnalysis(user);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /第 1 页 \/ 片段 1/ })).toHaveLength(5));

    const sourceRows = screen.getByRole('list', { name: '当前来源文件' });
    expect(sourceRows.querySelectorAll('.source-row')).toHaveLength(5);
    const navigator = screen.getByRole('region', { name: '审核导航' });
    expect(navigator.querySelectorAll('.review-navigator-row')).toHaveLength(5);
    expect(screen.getByRole('button', { name: /account-a[\\/]receipt\.pdf/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /account-b[\\/]receipt\.pdf/ })).toBeTruthy();
    expect(navigator.textContent).toContain('receipt.pdf');
  });

  it('filters and sorts result views without changing the current PDF or running another search', async () => {
    const user = userEvent.setup();
    configureResultViewSources();
    render(<App />);
    await loadResults(user);
    await user.click(reviewRow(/account-a.*第 4 页/));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域')).toBeTruthy());
    const searchCount = vi.mocked(localEngineAdapter.search).mock.calls.length;
    const sourceFilter = screen.getByRole('combobox', { name: '来源 PDF' });
    const sort = screen.getByRole('combobox', { name: '结果排序' });

    expect(within(sourceFilter).getByRole('option', { name: /account-a.*receipt.pdf/ })).toBeTruthy();
    expect(within(sourceFilter).getByRole('option', { name: /account-b.*receipt.pdf/ })).toBeTruthy();
    await user.selectOptions(sort, 'confidence_asc');
    expect(screen.getByRole('list', { name: '审核片段' }).firstElementChild?.textContent).toContain('第 12 页');
    expect(reviewRow(/account-a.*第 4 页/).getAttribute('aria-current')).toBe('true');

    await user.selectOptions(sourceFilter, VIEW_SOURCE_B);
    expect(screen.getByText('当前预览片段不在筛选结果中')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '当前 PDF 页码' }) as HTMLInputElement).value).toBe('4');
    expect(screen.getByText('当前显示 1 / 总计 2 个片段')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '定位当前片段' }));
    expect((sourceFilter as HTMLSelectElement).value).toBe('');
    expect((sort as HTMLSelectElement).value).toBe('confidence_asc');
    expect(reviewRow(/account-a.*第 4 页/).getAttribute('aria-current')).toBe('true');

    await user.selectOptions(sourceFilter, VIEW_SOURCE_EMPTY);
    expect(screen.getByText('当前筛选下没有命中片段')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '重置筛选' }));
    expect((sourceFilter as HTMLSelectElement).value).toBe('');
    expect((sort as HTMLSelectElement).value).toBe('confidence_asc');
    expect(localEngineAdapter.search).toHaveBeenCalledTimes(searchCount);
  });

  it('keeps result view settings while editing a draft and resets them at a submitted analysis', async () => {
    const user = userEvent.setup();
    configureResultViewSources();
    render(<App />);
    await loadResults(user);
    const sourceFilter = screen.getByRole('combobox', { name: '来源 PDF' });
    const sort = screen.getByRole('combobox', { name: '结果排序' });
    await user.selectOptions(sourceFilter, VIEW_SOURCE_B);
    await user.selectOptions(sort, 'confidence_desc');
    const input = await openSearchEditor(user);
    fireEvent.change(input, { target: { value: '退款' } });
    expect((sourceFilter as HTMLSelectElement).value).toBe(VIEW_SOURCE_B);
    expect((sort as HTMLSelectElement).value).toBe('confidence_desc');
    await user.click(within(screen.getByRole('region', { name: '搜索条件' })).getByRole('button', { name: '应用并重新分析' }));
    await waitFor(() => expect((screen.getByRole('combobox', { name: '结果排序' }) as HTMLSelectElement).value).toBe('original'));
    expect((screen.getByRole('combobox', { name: '来源 PDF' }) as HTMLSelectElement).value).toBe('');
  });

  it('reveals the original source from page navigation without resetting result sorting', async () => {
    const user = userEvent.setup();
    configureResultViewSources(0.8);
    render(<App />);
    await loadResults(user);
    await user.click(reviewRow(/account-a.*第 4 页/));
    await user.selectOptions(screen.getByRole('combobox', { name: '来源 PDF' }), VIEW_SOURCE_B);
    await user.selectOptions(screen.getByRole('combobox', { name: '结果排序' }), 'confidence_asc');
    await user.click(screen.getByRole('button', { name: /^需复核/ }));
    const pageInput = screen.getByRole('textbox', { name: '当前 PDF 页码' });
    fireEvent.change(pageInput, { target: { value: '4' } });
    fireEvent.keyDown(pageInput, { key: 'Enter' });
    await waitFor(() => expect(reviewRow(/account-a.*第 4 页/).getAttribute('aria-current')).toBe('true'));
    expect((screen.getByRole('combobox', { name: '来源 PDF' }) as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('combobox', { name: '结果排序' }) as HTMLSelectElement).value).toBe('confidence_asc');
    expect(screen.getByRole('button', { name: /^全部/ }).getAttribute('aria-pressed')).toBe('true');
  });


  it('does not let source filtering bypass a hidden unresolved receipt', async () => {
    const user = userEvent.setup();
    configureResultViewSources(0.8);
    render(<App />);
    await loadResults(user);
    await user.selectOptions(screen.getByRole('combobox', { name: '来源 PDF' }), VIEW_SOURCE_A);
    expect(screen.getByText('当前显示 1 / 总计 2 个片段')).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '生成 PDF 导出预览' })).toBeNull();
    expect(localEngineAdapter.exportPdf).not.toHaveBeenCalled();
  });

  it('keeps an in-flight crop save tied to its original receipt while the result view changes', async () => {
    const user = userEvent.setup();
    configureResultViewSources();
    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 4);
    let finishSave: (() => void) | undefined;
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockImplementationOnce((contextKey, resultRevision, segments) => new Promise(resolve => {
      finishSave = () => resolve(acknowledgeReviewSave(contextKey, resultRevision, segments));
    }));
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await waitFor(() => expect(finishSave).toBeTypeOf('function'));
    const savedSegments = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.at(-1)![2];
    expect(savedSegments).toHaveLength(1);
    expect(savedSegments[0]?.source_path).toBe(VIEW_SOURCE_A);
    await user.selectOptions(screen.getByRole('combobox', { name: '来源 PDF' }), VIEW_SOURCE_B);
    await user.selectOptions(screen.getByRole('combobox', { name: '结果排序' }), 'confidence_asc');
    await act(async () => { finishSave?.(); });
    expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.at(-1)![2]).toEqual(savedSegments);
    await user.click(screen.getByRole('button', { name: '定位当前片段' }));
    expect(reviewRow(/account-a.*第 4 页/).getAttribute('aria-label')).toContain('人工调整');
    expect(reviewRow(/account-b.*第 12 页/).getAttribute('aria-label')).not.toContain('人工调整');
  });

  it('locks a second crop until the first save finishes while keeping each decision tied to its receipt', async () => {
    const user = userEvent.setup();
    let releaseFirstSave: (() => void) | undefined;
    let firstSave = true;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockImplementation(async (contextKey, resultRevision, segments) => {
      if (firstSave) {
        firstSave = false;
        await firstGate;
      }
      return acknowledgeReviewSave(contextKey, resultRevision, segments);
    });

    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 4);
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await waitFor(() => expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1));

    await validatePreviewForPage(user, 12);
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await Promise.resolve();
    expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1);

    releaseFirstSave?.();
    await waitFor(() => expect((screen.getByRole('button', { name: '保留整页' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await waitFor(() => expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(2));
    const firstCall = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls[0]!;
    const secondCall = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls[1]!;
    expect(secondCall[0]).toBe(firstCall[0]);
    expect(secondCall[1]).toBe(firstCall[1]);
    expect(firstCall[2][0]?.source_page).toBe(4);
    expect(secondCall[2][0]?.source_page).toBe(12);
  });

  it('keeps a same-segment follow-up locked until confirmation is saved, then records the full-page decision', async () => {
    const user = userEvent.setup();
    configureResultViewSources(0.8);
    let releaseFirstSave: (() => void) | undefined;
    let saveNumber = 0;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockImplementation(async (contextKey, resultRevision, segments) => {
      saveNumber += 1;
      if (saveNumber === 1) await firstGate;
      return acknowledgeReviewSave(contextKey, resultRevision, segments);
    });

    render(<App />);
    await loadResults(user);
    await validatePreviewForPage(user, 12);
    const save = vi.mocked(localEngineAdapter.saveReviewSegmentsV2);
    const confirmCurrent = screen.getByRole('button', { name: '确认当前片段' }) as HTMLButtonElement;
    expect(confirmCurrent.disabled).toBe(false);

    await user.click(confirmCurrent);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[2][0]).toMatchObject({
      source_page: 12,
      review_status: 'page_confirmed',
    });

    const fullPageNotice = '已选择保留整页；请再次点击“确认当前片段”完成确认。';
    expect((screen.getByRole('button', { name: '保留整页' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '保留整页' }));
    expect(save).toHaveBeenCalledTimes(1);

    releaseFirstSave?.();
    await waitFor(() => expect((screen.getByRole('button', { name: '保留整页' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '保留整页' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTitle(fullPageNotice)).toBeTruthy());
    expect(screen.getByText('当前状态：需复核')).toBeTruthy();
    expect(save.mock.calls[1]?.[2][0]).toMatchObject({
      source_page: 12,
      final_rect: null,
      crop_mode: 'full_page',
      review_status: 'needs_review',
    });
  });

  it('reveals a filtered-out segment and returns the controlled filter to all', async () => {
    const user = userEvent.setup();
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, matches) => {
      const result = analysis(page, matches, page === 4 ? 0 : 280);
      return page === 12
        ? { ...result, selections: result.selections.map((selection) => ({ ...selection, confidence: 0.8 })) }
        : result;
    });
    render(<App />);
    await loadResults(user);

    await user.click(screen.getByRole('button', { name: /^需复核/ }));
    expect(screen.getByRole('button', { name: /^需复核/ }).getAttribute('aria-pressed')).toBe('true');
    const pageInput = screen.getByRole('textbox', { name: '当前 PDF 页码' });
    fireEvent.change(pageInput, { target: { value: '4' } });
    fireEvent.keyDown(pageInput, { key: 'Enter' });

    await waitFor(() => expect(screen.getByRole('button', { name: /^全部/ }).getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByRole('button', { name: /第 4 页 \/ 片段 1/ }).getAttribute('aria-current')).toBe('true');
  });
});
