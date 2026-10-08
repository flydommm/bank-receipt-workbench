// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// @ts-expect-error The test runtime exposes Node crypto without @types/node.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import {
  localEngineAdapter,
  type EngineMatch,
  type EngineOriginalReview,
  type EnginePreparedReview,
  type EngineReviewContext,
  type EngineReviewSegmentV2,
  type EngineSavedReviewV2,
} from './components/localEngineAdapter';
import type { CropTemplatePage } from './domain/batchCrop';
import type { PdfRect } from './domain/cropReview';

const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;
const DEFAULT_PAGE_COUNT = 5;
let PAGE_COUNT = DEFAULT_PAGE_COUNT;
const IMAGE = 'data:image/png;base64,AA==';

const SOURCE_A1 = '/guided/demo-bank-a-1.pdf';
const SOURCE_A2 = '/guided/demo-bank-a-2.pdf';
const SOURCE_B = '/guided/demo-bank-b.pdf';
const SHA_A1 = '1'.repeat(64);
const SHA_A2 = '2'.repeat(64);
const SHA_B = '3'.repeat(64);
const BANK_A = 'a'.repeat(64);
const BANK_B = 'b'.repeat(64);
const TEMPLATE_A = 'c'.repeat(64);
const TEMPLATE_B = 'd'.repeat(64);

type SourceSpec = {
  path: string;
  sha: string;
  bankKey: string;
  bankName: string;
  templateKey: string;
};

type MatchSpec = SourceSpec & {
  page: number;
  anchorY: number;
  matchRect: PdfRect;
  bounds: PdfRect;
};

const SOURCES: SourceSpec[] = [
  { path: SOURCE_A1, sha: SHA_A1, bankKey: BANK_A, bankName: '演示银行甲', templateKey: TEMPLATE_A },
  { path: SOURCE_A2, sha: SHA_A2, bankKey: BANK_A, bankName: '演示银行甲', templateKey: TEMPLATE_A },
  { path: SOURCE_B, sha: SHA_B, bankKey: BANK_B, bankName: '演示银行乙', templateKey: TEMPLATE_B },
];

// The first position is deliberately shared by two PDFs from the same bank.
// A second position and another bank make the workflow's round and bank gates
// observable without using business data from a real institution.
const BASE_MATCHES: MatchSpec[] = [
  { ...SOURCES[0]!, page: 1, anchorY: 100, matchRect: { x0: 60, y0: 80, x1: 160, y1: 104 }, bounds: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 300 } },
  { ...SOURCES[1]!, page: 1, anchorY: 100, matchRect: { x0: 60, y0: 80, x1: 160, y1: 104 }, bounds: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 300 } },
  { ...SOURCES[0]!, page: 2, anchorY: 400, matchRect: { x0: 60, y0: 380, x1: 160, y1: 404 }, bounds: { x0: 0, y0: 300, x1: PAGE_WIDTH, y1: 600 } },
  { ...SOURCES[2]!, page: 1, anchorY: 100, matchRect: { x0: 60, y0: 80, x1: 160, y1: 104 }, bounds: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 300 } },
];

let MATCHES: MatchSpec[] = BASE_MATCHES;

function useLargeSameBankFixture(pageCount: number): void {
  PAGE_COUNT = pageCount;
  MATCHES = Array.from({ length: pageCount }, (_, index) => ({
    ...SOURCES[0]!,
    page: index + 1,
    anchorY: 100,
    matchRect: { x0: 60, y0: 80, x1: 160, y1: 104 },
    bounds: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 300 },
  }));
}

const sourceByPath = (path: string): SourceSpec => SOURCES.find((source) => source.path === path) ?? SOURCES[0]!;
const matchFor = (path: string, page: number): MatchSpec | undefined => MATCHES.find((item) => item.path === path && item.page === page);

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

function matchResult(item: MatchSpec): EngineMatch {
  return {
    source_path: item.path,
    source_sha256: item.sha,
    page: item.page,
    matched_text: '演示关键词',
    matched_field: '摘要',
    confidence: 0.98,
    needs_review: false,
    ...item.matchRect,
  };
}

function pageAnalysis(path: string, page: number, matches: PdfRect[]) {
  return {
    status: 'ok' as const,
    page,
    page_width: PAGE_WIDTH,
    page_height: PAGE_HEIGHT,
    source_sha256: sourceByPath(path).sha,
    selections: matches.map((matchRect) => {
      const item = matchFor(path, page);
      const bounds = item?.bounds ?? { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 300 };
      const rect = { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: bounds.y1 - 80 };
      return {
        match_rect: matchRect,
        rect,
        candidate_rect: rect,
        candidate_index: 0,
        confidence: 0.98,
        slot: 'receipt',
        evidence: ['synthetic-layout'],
        needs_review: false,
      };
    }),
  };
}

function cropPage(path: string, page: number): CropTemplatePage {
  const source = sourceByPath(path);
  const item = matchFor(path, page);
  const bounds = item?.bounds ?? { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: 300 };
  return {
    status: 'ok',
    page,
    page_count: PAGE_COUNT,
    page_width: PAGE_WIDTH,
    page_height: PAGE_HEIGHT,
    source_sha256: source.sha,
    crop_template: {
      status: 'ready',
      fingerprint: `layout-${source.bankKey}-${page}`,
      receipts: [{
        anchor_y: item?.anchorY ?? 100,
        bounds,
        title_key: 'guided-demo-receipt',
        issuer_bank_key: source.bankKey,
        issuer_bank_name: source.bankName,
        template_fingerprint: source.templateKey,
      }],
    },
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
): EnginePreparedReview {
  return {
    status: 'ok',
    context_key: contextKey,
    result_revision: resultRevision,
    segments: [],
    record_revisions: originals.map((original) => ({
      id: original.id,
      source_key: original.source_key,
      source_page: original.source_page,
      segment_no: original.segment_no,
      record_revision: 0,
    })),
    group_confirmed: false,
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

async function analyzeFixture(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getAllByRole('button', { name: '选择 PDF' })[0]!);
  await user.click(screen.getByRole('button', { name: '开始分析' }));
  await waitFor(() => expect(screen.getByRole('region', { name: '审核导航' })).toBeTruthy());
  const firstPageCount = MATCHES.filter((item) => item.page === 1).length;
  await waitFor(() => expect(screen.getAllByRole('button', { name: /第 1 页 \/ 片段 1/ }).length).toBe(firstPageCount));
}

async function enterGuided(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: '进入微调' }));
  const panel = await screen.findByRole('region', { name: '微调与确认' });
  await waitFor(() => expect(panel.getAttribute('data-phase')).toBe('editing'));
  return panel;
}

async function selectReviewRow(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
  sourcePath?: string,
): Promise<HTMLElement> {
  const row = screen.getByRole('button', { name });
  await user.click(row);
  await waitFor(() => expect(row.getAttribute('aria-current')).toBe('true'));
  if (sourcePath) {
    await waitFor(() => expect(document.querySelector('.source-document-name')?.getAttribute('title')).toBe(sourcePath));
  }
  return row;
}

function guidedPanel(): HTMLElement {
  return screen.getByRole('region', { name: '微调与确认' });
}

function guidedRows(): HTMLElement[] {
  return within(screen.getByRole('region', { name: '审核导航' })).getAllByRole('button');
}

const LARGE_CANDIDATE_COUNT = 80;

async function expectLargePreviewPage(
  user: ReturnType<typeof userEvent.setup>,
  page: number,
  expectedStyle: string | null,
): Promise<void> {
  const row = screen.getByRole('button', { name: new RegExp(`第 ${page} 页 \\/ 片段 1，`) });
  await user.click(row);
  await waitFor(() => expect(row.getAttribute('aria-current')).toBe('true'));
  await waitFor(() => expect((screen.getByLabelText('当前 PDF 页码') as HTMLInputElement).value).toBe(String(page)));
  await waitFor(() => expect(screen.getByLabelText('裁剪区域').getAttribute('style')).toBe(expectedStyle));
}

async function completeLargeRound(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => expect(guidedRows()).toHaveLength(LARGE_CANDIDATE_COUNT));
  expect(screen.getByRole('button', { name: `确认并预览本轮 ${LARGE_CANDIDATE_COUNT} 处` })).toBeTruthy();

  const crop = await screen.findByLabelText('裁剪区域');
  const originalStyle = crop.getAttribute('style');
  fireEvent.keyDown(crop, { key: 'ArrowDown' });
  const adjustedStyle = screen.getByLabelText('裁剪区域').getAttribute('style');
  expect(adjustedStyle).not.toBe(originalStyle);

  await user.click(screen.getByRole('button', { name: `确认并预览本轮 ${LARGE_CANDIDATE_COUNT} 处` }));
  await screen.findByRole('button', { name: `保存本轮 ${LARGE_CANDIDATE_COUNT} 处` });
  expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  expect(guidedRows()).toHaveLength(LARGE_CANDIDATE_COUNT);
  expect(guidedRows().every((row) => row.textContent?.includes('预览待保存'))).toBe(true);

  await expectLargePreviewPage(user, 5, adjustedStyle);
  await expectLargePreviewPage(user, LARGE_CANDIDATE_COUNT, adjustedStyle);
  expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: `保存本轮 ${LARGE_CANDIDATE_COUNT} 处` }));
  await screen.findByRole('button', { name: '检查本银行完成情况' });
  expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1);
  const firstSave = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls[0]!;
  expect(firstSave[2]).toHaveLength(LARGE_CANDIDATE_COUNT);
  expect(firstSave[2].map((segment) => segment.source_page)).toEqual(
    Array.from({ length: LARGE_CANDIDATE_COUNT }, (_, index) => index + 1),
  );
  expect(new Set(firstSave[2].map((segment) => segment.source_path))).toEqual(new Set([SOURCE_A1]));
  expect(firstSave[2].every((segment) => segment.review_status === 'page_confirmed')).toBe(true);

  // The complete-bank check is the next-round transition for a one-position
  // bank. It must leave the saved round undoable as one operation.
  await user.click(screen.getByRole('button', { name: '检查本银行完成情况' }));
  await screen.findByRole('button', { name: '完成本次微调' });
  const beforeUndo = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length;
  await user.click(screen.getByRole('button', { name: '撤销本轮' }));
  await waitFor(() => expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length).toBe(beforeUndo + 1));
  await waitFor(() => expect(guidedPanel().getAttribute('data-phase')).toBe('editing'));
  expect(guidedRows()).toHaveLength(LARGE_CANDIDATE_COUNT);
}

describe('App guided review workflow', () => {
  beforeEach(() => {
    installLocalStorageShim();
    vi.stubGlobal('crypto', webcrypto);
    vi.spyOn(localEngineAdapter, 'health').mockResolvedValue({ status: 'ok', engine: 'guided-test', version: '1' });
    vi.spyOn(localEngineAdapter, 'ocrHealth').mockResolvedValue({
      status: 'ok', available: true, engine: 'paddleocr', message: 'ok', readiness: 'installed',
    });
    vi.spyOn(localEngineAdapter, 'ocrCacheInfo').mockResolvedValue({
      status: 'ok', available: true, entries: 0, bytes: 0, max_bytes: 268_435_456, retention_days: 30,
    });
    vi.spyOn(localEngineAdapter, 'ocrCacheClear').mockResolvedValue({
      status: 'ok', available: true, entries: 0, bytes: 0, max_bytes: 268_435_456,
      retention_days: 30, removed_entries: 0, failed_entries: 0,
    });
    vi.spyOn(localEngineAdapter, 'pickPdfFiles').mockResolvedValue({ files: SOURCES.map((source) => source.path), directory: null });
    vi.spyOn(localEngineAdapter, 'pickPdfFolder').mockResolvedValue({ files: [], directory: null });
    vi.spyOn(localEngineAdapter, 'pickDirectory').mockResolvedValue(null);
    vi.spyOn(localEngineAdapter, 'validateDirectory').mockResolvedValue(true);
    vi.spyOn(localEngineAdapter, 'inspectPdf').mockImplementation(async (path) => {
      const source = sourceByPath(path);
      return { status: 'ok', page_count: PAGE_COUNT, source_sha256: source.sha };
    });
    vi.spyOn(localEngineAdapter, 'search').mockImplementation(async (path) => {
      const source = sourceByPath(path);
      return {
        status: 'ok', page_count: PAGE_COUNT, source_sha256: source.sha,
        matches: MATCHES.filter((item) => item.path === path).map(matchResult),
      };
    });
    vi.spyOn(localEngineAdapter, 'searchMulti').mockImplementation(async (path) => {
      const source = sourceByPath(path);
      return {
        status: 'ok', page_count: PAGE_COUNT, source_sha256: source.sha,
        matches: MATCHES.filter((item) => item.path === path).map((item) => ({
          ...matchResult(item), query_id: 'include-0', role: 'include' as const,
        })),
      };
    });
    vi.spyOn(localEngineAdapter, 'renderPage').mockImplementation(async (path, page) => ({
      status: 'ok', page, page_count: PAGE_COUNT, page_width: PAGE_WIDTH, page_height: PAGE_HEIGHT,
      source_sha256: sourceByPath(path).sha, image_data: IMAGE,
    }));
    vi.spyOn(localEngineAdapter, 'analyzePage').mockImplementation(async (path, page, matches) => pageAnalysis(path, page, matches));
    vi.spyOn(localEngineAdapter, 'describeCropPage').mockImplementation(async (path, page) => cropPage(path, page));
    vi.spyOn(localEngineAdapter, 'inspectPages').mockImplementation(async (path, pages, sha, includeTemplate) => ({
      status: 'ok', page_count: PAGE_COUNT, source_sha256: sha,
      pages: await Promise.all(pages.map(async (page) => includeTemplate
        ? localEngineAdapter.describeCropPage(path, page, sha)
        : { status: 'ok' as const, page, page_count: PAGE_COUNT, page_width: PAGE_WIDTH,
          page_height: PAGE_HEIGHT, source_sha256: sha })),
    }));
    vi.spyOn(localEngineAdapter, 'computationInfo').mockResolvedValue({ status: 'ok', computation_version: 'guided-test-v1' });
    vi.spyOn(localEngineAdapter, 'prepareReviewContext').mockImplementation(async (context, originals, resultRevision) => (
      preparedReview(await reviewContextKey(context), resultRevision, originals)
    ));
    vi.spyOn(localEngineAdapter, 'readReviewSnapshot').mockImplementation(async (context, originals, resultRevision) => (
      preparedReview(await reviewContextKey(context), resultRevision, originals)
    ));
    vi.spyOn(localEngineAdapter, 'loadReviewSegments').mockImplementation(async (taskId) => ({ status: 'ok', task_id: taskId, segments: [] }));
    vi.spyOn(localEngineAdapter, 'saveReviewSegmentsV2').mockImplementation(async (contextKey, resultRevision, segments) => (
      acknowledgeReviewSave(contextKey, resultRevision, segments)
    ));
    vi.spyOn(localEngineAdapter, 'exportIndex').mockResolvedValue({ status: 'ok', output_path: '/guided/index.xlsx', row_count: 0 });
    vi.spyOn(localEngineAdapter, 'exportPdf').mockResolvedValue({ status: 'ok', output_path: '/guided/result.pdf', page_count: 1, sha256: SHA_A1 });
    vi.spyOn(localEngineAdapter, 'createExportPreviewPath').mockResolvedValue('/guided/preview.pdf');
    vi.spyOn(localEngineAdapter, 'pickOutputFolder').mockResolvedValue('/guided');
    vi.spyOn(localEngineAdapter, 'publishPreviewPdf').mockResolvedValue({ status: 'ok', output_path: '/guided/result.pdf', sha256: SHA_A1 });
    vi.spyOn(localEngineAdapter, 'cleanupExports').mockResolvedValue({ status: 'ok', cleaned_count: 1 });
    vi.spyOn(localEngineAdapter, 'releaseExports').mockResolvedValue({ status: 'ok', released_count: 1 });
    vi.spyOn(localEngineAdapter, 'openOutputFolder').mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    PAGE_COUNT = DEFAULT_PAGE_COUNT;
    MATCHES = BASE_MATCHES;
  });

  it.each([
    {
      label: '同银行的非默认位置',
      row: /demo-bank-a-1\.pdf.*第 2 页 \/ 片段 1/,
      sourcePath: SOURCE_A1,
      bank: '演示银行甲',
      position: /第 2 页 \/ 片段 1/,
    },
    {
      label: '另一个银行的候选',
      row: /demo-bank-b\.pdf.*第 1 页 \/ 片段 1/,
      sourcePath: SOURCE_B,
      bank: '演示银行乙',
      position: /demo-bank-b\.pdf.*第 1 页 \/ 片段 1/,
    },
  ])('从$label进入微调时保留所选样本和位置', async ({ row, sourcePath, bank, position }) => {
    const user = userEvent.setup();
    render(<App />);
    await analyzeFixture(user);
    const selected = await selectReviewRow(user, row, sourcePath);

    await enterGuided(user);

    expect(guidedPanel().textContent).toContain(bank);
    expect(guidedPanel().textContent).toMatch(position);
    const roundRows = guidedRows();
    expect(roundRows).toHaveLength(1);
    expect(roundRows[0]?.getAttribute('aria-current')).toBe('true');
    expect(roundRows[0]?.getAttribute('aria-label')).toMatch(position);
    expect(selected.getAttribute('aria-current')).toBe('true');
  }, 30000);

  it('进入微调时按右侧选中样本定位，即使预览已手动翻到其他页', async () => {
    const user = userEvent.setup();
    render(<App />);
    await analyzeFixture(user);
    await selectReviewRow(user, /demo-bank-a-1\.pdf.*第 2 页 \/ 片段 1/, SOURCE_A1);
    await waitFor(() => expect((screen.getByLabelText('当前 PDF 页码') as HTMLInputElement).value).toBe('2'));

    // Page 3 has no hit, so manual navigation leaves the selected row intact
    // while the visible preview no longer has a segment to edit.
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect((screen.getByLabelText('当前 PDF 页码') as HTMLInputElement).value).toBe('3'));
    const navigator = within(screen.getByRole('region', { name: '审核导航' }));
    expect(navigator.getByRole('button', { name: /demo-bank-a-1\.pdf.*第 2 页 \/ 片段 1/ }).getAttribute('aria-current')).toBe('true');

    await user.click(screen.getByRole('button', { name: '进入微调' }));
    const panel = await screen.findByRole('region', { name: '微调与确认' });
    await waitFor(() => expect(panel.getAttribute('data-phase')).toBe('editing'));
    expect(guidedPanel().textContent).toContain('演示银行甲');
    expect(guidedPanel().textContent).toMatch(/第 2 页 \/ 片段 1/);
    expect(guidedRows()).toHaveLength(1);
    expect(guidedRows()[0]?.getAttribute('aria-label')).toMatch(/第 2 页 \/ 片段 1/);
    await waitFor(() => expect((screen.getByLabelText('当前 PDF 页码') as HTMLInputElement).value).toBe('2'));
  });

  it('在准备中保留旧候选且禁止编辑，旧准备返回不会替换重新选择的位置', async () => {
    const user = userEvent.setup();
    let resolveOldPreparation!: (page: CropTemplatePage) => void;
    const oldPreparation = new Promise<CropTemplatePage>((resolve) => { resolveOldPreparation = resolve; });
    let describeCalls = 0;
    vi.mocked(localEngineAdapter.describeCropPage).mockImplementation(async (path, page) => {
      describeCalls += 1;
      if (describeCalls === 1) return oldPreparation;
      return cropPage(path, page);
    });

    render(<App />);
    await analyzeFixture(user);
    await selectReviewRow(user, /demo-bank-b\.pdf.*第 1 页 \/ 片段 1/, SOURCE_B);
    await user.click(screen.getByRole('button', { name: '进入微调' }));
    const panel = await screen.findByRole('region', { name: '微调与确认' });
    await waitFor(() => expect(panel.getAttribute('data-phase')).toBe('preparing'));

    const preparingNavigator = within(screen.getByRole('region', { name: '审核导航' }));
    const preparingRow = preparingNavigator.getByRole('button', { name: /demo-bank-b\.pdf.*第 1 页 \/ 片段 1/ });
    expect(preparingRow.getAttribute('aria-current')).toBe('true');
    expect((preparingRow as HTMLButtonElement).disabled).toBe(true);
    expect(guidedRows()).toHaveLength(1);
    expect(preparingRow.getAttribute('aria-label')).toMatch(/demo-bank-b\.pdf.*第 1 页 \/ 片段 1/);
    expect(screen.queryByText(/本轮 0 处/)).toBeNull();
    expect(screen.queryByText('暂无命中片段')).toBeNull();
    expect(screen.getByLabelText('裁剪区域').getAttribute('aria-disabled')).toBe('true');

    await user.click(screen.getByRole('button', { name: '退出微调' }));
    await waitFor(() => expect(panel.getAttribute('data-phase')).toBe('entry'));
    await selectReviewRow(user, /demo-bank-a-1\.pdf.*第 2 页 \/ 片段 1/, SOURCE_A1);
    await user.click(screen.getByRole('button', { name: '进入微调' }));
    await waitFor(() => expect(panel.getAttribute('data-phase')).toBe('editing'));

    expect(guidedPanel().textContent).toContain('演示银行甲');
    expect(guidedPanel().textContent).toMatch(/第 2 页 \/ 片段 1/);
    expect(guidedRows()).toHaveLength(1);
    expect(within(screen.getByRole('region', { name: '审核导航' }))
      .getByRole('button', { name: /demo-bank-a-1\.pdf.*第 2 页 \/ 片段 1/ })
      .getAttribute('aria-current')).toBe('true');

    resolveOldPreparation(cropPage(SOURCE_A1, 1));
    await waitFor(() => expect(panel.getAttribute('data-phase')).toBe('editing'));
    expect(guidedPanel().textContent).toMatch(/第 2 页 \/ 片段 1/);
    expect(guidedRows()[0]?.getAttribute('aria-label')).toMatch(/第 2 页 \/ 片段 1/);
  });

  it('样本版式越界导致真实准备失败后可换位置重进，且失败轮次不写入', async () => {
    const user = userEvent.setup();
    render(<App />);
    await analyzeFixture(user);
    await enterGuided(user);
    expect(guidedRows()).toHaveLength(2);
    expect(guidedPanel().textContent).toContain('demo-bank-a-1.pdf');

    // Move the south handle into the next receipt's protected area while
    // staying inside the PDF page. The actual prepareBatchCrop validation must
    // reject this sample before any durable save is attempted.
    const southHandle = screen.getByRole('button', { name: '调整南边界' });
    for (let index = 0; index < 24; index += 1) {
      fireEvent.keyDown(southHandle, { key: 'ArrowDown', shiftKey: true });
    }
    await user.click(screen.getByRole('button', { name: /^确认并预览本轮/ }));
    await waitFor(() => expect(guidedPanel().textContent).toMatch(/样本最终裁剪超出凭证保护边界/));
    expect(guidedPanel().getAttribute('data-phase')).toBe('editing');
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '取消当前调整' }));
    await user.click(screen.getByRole('button', { name: '退出微调' }));
    await waitFor(() => expect(screen.getByRole('region', { name: '结果检查' }).getAttribute('data-phase')).toBe('entry'));

    await selectReviewRow(user, /demo-bank-a-1\.pdf.*第 2 页 \/ 片段 1/, SOURCE_A1);
    await enterGuided(user);
    expect(guidedPanel().textContent).toContain('第 2 页 / 片段 1');
    expect(guidedRows()).toHaveLength(1);
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('groups same-bank candidates across PDFs and explicitly continues another position after confirming the current scope', async () => {
    const user = userEvent.setup();
    render(<App />);
    await analyzeFixture(user);
    await enterGuided(user);

    const rows = guidedRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => /第 1 页 \/ 片段 1/.test(row.getAttribute('aria-label') ?? row.textContent ?? ''))).toBe(true);
    expect(screen.getByRole('button', { name: /确认并预览本轮 2 处/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /第 2 页 \/ 片段 1/ })).toBeNull();

    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await user.click(screen.getByRole('button', { name: /^确认并预览本轮/ }));
    await screen.findByRole('button', { name: '保存本轮 2 处' });
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    const previewRows = guidedRows();
    expect(previewRows).toHaveLength(2);
    expect(previewRows.every((row) => row.textContent?.includes('预览待保存'))).toBe(true);
    const firstPreviewStyle = screen.getByLabelText('裁剪区域').getAttribute('style');
    await user.click(previewRows[1]!);
    await waitFor(() => expect(document.querySelector('.source-document-name')?.getAttribute('title')).toBe(SOURCE_A2));
    expect(screen.getByLabelText('裁剪区域').getAttribute('style')).toBe(firstPreviewStyle);
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '保存本轮 2 处' }));
    await screen.findByRole('button', { name: '检查本银行完成情况' });
    const firstRoundSave = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.at(-1)!;
    expect(firstRoundSave[2]).toHaveLength(2);
    expect(new Set(firstRoundSave[2].map((segment) => segment.source_path))).toEqual(new Set([SOURCE_A1, SOURCE_A2]));
    expect(firstRoundSave[2].every((segment) => segment.source_path !== SOURCE_B)).toBe(true);

    expect(firstRoundSave[2].every((segment) => segment.review_status === 'page_confirmed')).toBe(true);
    expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '开始下一位置微调' })).toBeNull();
    expect(guidedPanel().textContent).toContain('演示银行甲');
    expect(within(screen.getByRole('region', { name: '审核导航' })).queryByRole('button', { name: /第 2 页 \/ 片段 1/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '需要微调的位置' })).toBeNull();
    const templateReads = vi.mocked(localEngineAdapter.inspectPages).mock.calls.filter((call) => call[3]).length;
    await user.click(screen.getByRole('button', { name: '继续微调本银行其他位置' }));
    const position = await screen.findByRole('combobox', { name: '需要微调的位置' });
    expect(within(position).getAllByRole('option')).toHaveLength(1);
    expect(position.textContent).toContain('页面中部');
    expect(vi.mocked(localEngineAdapter.inspectPages).mock.calls.filter((call) => call[3])).toHaveLength(templateReads);
    await user.click(screen.getByRole('button', { name: '开始所选位置微调' }));
    await waitFor(() => expect(guidedPanel().getAttribute('data-phase')).toBe('editing'));
    expect(guidedPanel().textContent).toContain('第2轮·调整中');
    expect(guidedPanel().textContent).toContain('第 2 页 / 片段 1');
    expect(guidedPanel().textContent).toContain('本银行已确认 2 / 3 处');
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await user.click(screen.getByRole('button', { name: /^确认并预览本轮/ }));
    await screen.findByRole('button', { name: '保存本轮 1 处' });
    await user.click(screen.getByRole('button', { name: '保存本轮 1 处' }));
    await screen.findByRole('button', { name: '检查本银行完成情况' });
    expect(guidedPanel().textContent).toContain('本银行已确认 3 / 3 处');
    expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.flatMap((call) => call[2])
      .every((segment) => segment.source_path !== SOURCE_B)).toBe(true);
    await user.click(screen.getByRole('button', { name: '继续微调本银行其他位置' }));
    await waitFor(() => expect(guidedPanel().textContent).toContain('没有可加入的同银行位置'));
    expect(screen.queryByRole('button', { name: '开始所选位置微调' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '返回本轮完成状态' }));
    await user.click(screen.getByRole('button', { name: '检查本银行完成情况' }));
    await user.click(screen.getByRole('button', { name: '完成本次微调' }));
    await screen.findByRole('button', { name: '导出审核结果' });
  });

  it('finishes one bank before entering the next bank and never batches across bank identities', async () => {
    const user = userEvent.setup();
    // Only unresolved positions belong to subsequent rounds. Correct automatic
    // results outside the selected peer group no longer require re-review.
    vi.mocked(localEngineAdapter.analyzePage).mockImplementation(async (path, page, matches) => {
      const result = pageAnalysis(path, page, matches);
      return { ...result, selections: result.selections.map((item) => ({ ...item, confidence: .85, needs_review: true })) };
    });
    render(<App />);
    await analyzeFixture(user);
    await enterGuided(user);

    await user.click(screen.getByRole('button', { name: /确认并预览本轮 2 处/ }));
    await user.click(await screen.findByRole('button', { name: '保存本轮 2 处' }));
    await screen.findByRole('button', { name: '开始下一位置微调' });
    await user.click(screen.getByRole('button', { name: '开始下一位置微调' }));
    await user.click(screen.getByRole('button', { name: /确认并预览本轮 1 处/ }));
    await user.click(await screen.findByRole('button', { name: '保存本轮 1 处' }));
    await screen.findByRole('button', { name: '检查本银行完成情况' });
    expect(screen.queryByRole('button', { name: '开始下一位置微调' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '检查本银行完成情况' }));
    await screen.findByRole('button', { name: '完成本银行，进入下一银行' });

    await user.click(screen.getByRole('button', { name: '完成本银行，进入下一银行' }));
    await waitFor(() => expect(guidedPanel().textContent).toContain('演示银行乙'));
    expect(within(screen.getByRole('region', { name: '审核导航' })).getAllByRole('button')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /确认并预览本轮 1 处/ }));
    await user.click(await screen.findByRole('button', { name: '保存本轮 1 处' }));
    await screen.findByRole('button', { name: '检查本银行完成情况' });
    expect(screen.queryByRole('button', { name: '开始下一位置微调' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '检查本银行完成情况' }));
    await screen.findByRole('button', { name: '完成本次微调' });
    await user.click(screen.getByRole('button', { name: '完成本次微调' }));
    await screen.findByRole('button', { name: '导出审核结果' });

    const savedPaths = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls
      .flatMap((call) => call[2].map((segment) => segment.source_path));
    expect(savedPaths).toContain(SOURCE_A1);
    expect(savedPaths).toContain(SOURCE_A2);
    expect(savedPaths).toContain(SOURCE_B);
    const batchCalls = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.filter((call) => call[2].length > 1);
    expect(batchCalls.every((call) => new Set(call[2].map((segment) => sourceByPath(segment.source_path).bankKey)).size === 1)).toBe(true);
  });

  it('does not write a round when a source SHA changes before the final save check', async () => {
    const user = userEvent.setup();
    render(<App />);
    await analyzeFixture(user);
    await enterGuided(user);
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await user.click(screen.getByRole('button', { name: /^确认并预览本轮/ }));
    await screen.findByRole('button', { name: '保存本轮 2 处' });
    const saveCount = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length;
    vi.mocked(localEngineAdapter.inspectPdf).mockImplementation(async (path) => {
      const source = sourceByPath(path);
      return { status: 'ok', page_count: PAGE_COUNT, source_sha256: path === SOURCE_A1 ? 'f'.repeat(64) : source.sha };
    });

    await user.click(screen.getByRole('button', { name: '保存本轮 2 处' }));
    const resultCheck = await screen.findByRole('region', { name: '结果检查' });
    expect(resultCheck.getAttribute('data-phase')).toBe('entry');
    expect(await screen.findByText('错误：原始 PDF 已变化，不能恢复旧审核决定。', { selector: '[role="alert"]' })).toBeTruthy();
    expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length).toBe(saveCount);
  });

  it('locks source, search, and current-round navigation while a round save is in flight', async () => {
    const user = userEvent.setup();
    let releaseSave!: () => void;
    const pending = new Promise<EngineSavedReviewV2>((resolve) => { releaseSave = () => {
      const [contextKey, resultRevision, segments] = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.at(-1)!;
      resolve(acknowledgeReviewSave(contextKey, resultRevision, segments));
    }; });
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockReturnValue(pending);

    render(<App />);
    await analyzeFixture(user);
    await enterGuided(user);
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await user.click(screen.getByRole('button', { name: /^确认并预览本轮/ }));
    await user.click(await screen.findByRole('button', { name: '保存本轮 2 处' }));
    await waitFor(() => expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalled());
    expect(guidedPanel().getAttribute('data-busy')).toBe('true');
    expect((screen.getAllByRole('button', { name: '选择 PDF' })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '修改搜索条件' }) as HTMLButtonElement).disabled).toBe(true);
    expect(guidedRows().every((row) => (row as HTMLButtonElement).disabled)).toBe(true);

    releaseSave();
    await screen.findByRole('button', { name: '检查本银行完成情况' });
  });

  it('keeps multiple keyboard adjustments local and saves the final rectangle once', async () => {
    const user = userEvent.setup();
    render(<App />);
    await analyzeFixture(user);
    await enterGuided(user);
    const crop = screen.getByLabelText('裁剪区域');
    fireEvent.keyDown(crop, { key: 'ArrowDown' });
    fireEvent.keyDown(crop, { key: 'ArrowDown' });
    fireEvent.keyDown(crop, { key: 'ArrowDown' });
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^确认并预览本轮/ }));
    await screen.findByRole('button', { name: '保存本轮 2 处' });
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '保存本轮 2 处' }));
    await screen.findByRole('button', { name: '检查本银行完成情况' });
    expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls[0]![2];
    expect(saved).toHaveLength(2);
    expect(saved.map((segment) => segment.final_rect)).toEqual([
      { x0: 0, y0: 3, x1: PAGE_WIDTH, y1: 223 },
      { x0: 0, y0: 3, x1: PAGE_WIDTH, y1: 223 },
    ]);
  });

  it('cancels a draft without writing and returns to the explicit confirmation action', async () => {
    const user = userEvent.setup();
    render(<App />);
    await analyzeFixture(user);
    await enterGuided(user);
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await user.click(screen.getByRole('button', { name: '取消当前调整' }));
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /确认并预览本轮 2 处/ })).toBeTruthy();
    expect(guidedPanel().getAttribute('data-phase')).toBe('editing');
  });

  it('previews peers before saving and returns to the original sample with its draft intact', async () => {
    const user = userEvent.setup();
    render(<App />);
    await analyzeFixture(user);
    await enterGuided(user);
    const originalStyle = screen.getByLabelText('裁剪区域').getAttribute('style');
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    const draftStyle = screen.getByLabelText('裁剪区域').getAttribute('style');
    expect(draftStyle).not.toBe(originalStyle);
    await user.click(screen.getByRole('button', { name: '确认并预览本轮 2 处' }));
    await screen.findByRole('button', { name: '保存本轮 2 处' });
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    await user.click(guidedRows()[1]!);
    await waitFor(() => expect(document.querySelector('.source-document-name')?.getAttribute('title')).toBe(SOURCE_A2));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域').getAttribute('style')).toBe(draftStyle));
    expect((screen.getByRole('button', { name: '调整南边界' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: '返回调整' }));
    await waitFor(() => expect(document.querySelector('.source-document-name')?.getAttribute('title')).toBe(SOURCE_A1));
    await waitFor(() => expect(screen.getByLabelText('裁剪区域').getAttribute('style')).toBe(draftStyle));
    expect(guidedPanel().getAttribute('data-phase')).toBe('editing');
    expect(screen.getByRole('button', { name: '取消当前调整' })).toBeTruthy();
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '取消当前调整' }));
    expect(screen.getByLabelText('裁剪区域').getAttribute('style')).toBe(originalStyle);
    await user.click(screen.getByRole('button', { name: '退出微调' }));
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    await selectReviewRow(user, /demo-bank-a-2\.pdf.*第 1 页 \/ 片段 1/, SOURCE_A2);
    await waitFor(() => expect(screen.getByLabelText('裁剪区域').getAttribute('style')).toBe(originalStyle));
  });

  it('keeps a round unsaved when layout verification fails and retries after it recovers', async () => {
    const user = userEvent.setup();
    // Keep the descriptor object used by the first round so the test can
    // invalidate the cached layout after guided preparation. This exercises
    // the actual final layout check in prepareBatchCrop without mocking the
    // workflow hook or bypassing the round target set.
    const baseSamplePage = cropPage(SOURCE_A1, 1);
    let failLayoutRead = false;
    if (baseSamplePage.crop_template.status !== 'ready') throw new Error('invalid fixture');
    const baseReceipt = baseSamplePage.crop_template.receipts[0]!;
    const samplePage: CropTemplatePage = {
      ...baseSamplePage,
      crop_template: { ...baseSamplePage.crop_template, receipts: [{ ...baseReceipt,
        get bounds() {
          if (failLayoutRead) throw new Error('演示版式暂不可用');
          return baseReceipt.bounds;
        },
      }] },
    };
    vi.mocked(localEngineAdapter.describeCropPage).mockImplementation(async (path, page) => {
      return path === SOURCE_A1 && page === 1 ? samplePage : cropPage(path, page);
    });

    render(<App />);
    await analyzeFixture(user);
    await enterGuided(user);
    failLayoutRead = true;
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await user.click(screen.getByRole('button', { name: /^确认并预览本轮/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(guidedPanel().textContent).toMatch(/版式|核实|检查/);
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();

    failLayoutRead = false;
    await user.click(screen.getByRole('button', { name: /^确认并预览本轮/ }));
    await screen.findByRole('button', { name: '保存本轮 2 处' });
    expect(localEngineAdapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '保存本轮 2 处' }));
    await screen.findByRole('button', { name: '检查本银行完成情况' });
    expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1);
  });

  it('retries a failed round save with the same fixed target set', async () => {
    const user = userEvent.setup();
    render(<App />);
    await analyzeFixture(user);
    await enterGuided(user);
    vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mockRejectedValueOnce(new Error('guided disk failure'));
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await user.click(screen.getByRole('button', { name: /^确认并预览本轮/ }));
    await user.click(await screen.findByRole('button', { name: '保存本轮 2 处' }));
    await screen.findByRole('button', { name: '重试本轮保存' });
    expect(guidedPanel().getAttribute('data-phase')).toBe('review');
    await user.click(screen.getByRole('button', { name: '重试本轮保存' }));
    await screen.findByRole('button', { name: '检查本银行完成情况' });
    expect(localEngineAdapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls;
    expect(calls[0]![2].map((segment) => segment.id)).toEqual(calls[1]![2].map((segment) => segment.id));
  });

  it('undoes a confirmed same-bank round as one operation and synchronizes both PDFs again', async () => {
    const user = userEvent.setup();
    render(<App />);
    await analyzeFixture(user);
    await enterGuided(user);
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await user.click(screen.getByRole('button', { name: /^确认并预览本轮/ }));
    await user.click(await screen.findByRole('button', { name: '保存本轮 2 处' }));
    await screen.findByRole('button', { name: '检查本银行完成情况' });

    const beforeUndo = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length;
    await user.click(screen.getByRole('button', { name: '撤销本轮' }));
    await waitFor(() => expect(vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls.length).toBe(beforeUndo + 1));
    await waitFor(() => expect(guidedPanel().getAttribute('data-phase')).toBe('editing'));
    fireEvent.keyDown(screen.getByLabelText('裁剪区域'), { key: 'ArrowDown' });
    await user.click(screen.getByRole('button', { name: /^确认并预览本轮/ }));
    await screen.findByRole('button', { name: '保存本轮 2 处' });
    await user.click(screen.getByRole('button', { name: '保存本轮 2 处' }));
    await screen.findByRole('button', { name: '检查本银行完成情况' });

    const calls = vi.mocked(localEngineAdapter.saveReviewSegmentsV2).mock.calls;
    expect(calls[beforeUndo]![2]).toHaveLength(2);
    expect(calls.at(-1)![2]).toHaveLength(2);
    expect(new Set(calls.at(-1)![2].map((segment) => segment.source_path))).toEqual(new Set([SOURCE_A1, SOURCE_A2]));
  });

  // These 80-row cases exercise real DOM rows; the cold path covers the full
  // round, while the warm path isolates descriptor-cache reuse.
  it('keeps all 80 same-bank same-layout candidates in an asynchronous cross-page round', { timeout: 10_000 }, async () => {
    useLargeSameBankFixture(LARGE_CANDIDATE_COUNT);
    const user = userEvent.setup();
    const inspectPages = vi.mocked(localEngineAdapter.inspectPages);
    const defaultInspect = inspectPages.getMockImplementation();
    if (!defaultInspect) throw new Error('inspection fixture is not installed');
    let templateCallCount = 0;
    let releaseDescriptor!: () => void;
    const descriptorGate = new Promise<void>((resolve) => { releaseDescriptor = resolve; });
    inspectPages.mockImplementation(async (path, pages, sha, includeTemplate) => {
      if (includeTemplate && templateCallCount++ === 0) await descriptorGate;
      return defaultInspect(path, pages, sha, includeTemplate);
    });

    render(<App />);
    await analyzeFixture(user);
    await user.click(screen.getByRole('button', { name: '进入微调' }));
    const panel = await screen.findByRole('region', { name: '微调与确认' });
    await waitFor(() => expect(panel.getAttribute('data-phase')).toBe('preparing'));
    await waitFor(() => expect(templateCallCount).toBeGreaterThan(0));
    expect(guidedRows()).toHaveLength(1);
    releaseDescriptor();
    await waitFor(() => expect(panel.getAttribute('data-phase')).toBe('editing'));

    const descriptorPages = inspectPages.mock.calls
      .filter((call) => call[3])
      .flatMap((call) => call[1]);
    expect(new Set(descriptorPages)).toEqual(new Set(
      Array.from({ length: LARGE_CANDIDATE_COUNT }, (_, index) => index + 1),
    ));
    await completeLargeRound(user);
  });

  it('returns cached descriptors immediately for all 80 candidates after reopening the round', { timeout: 10_000 }, async () => {
    useLargeSameBankFixture(LARGE_CANDIDATE_COUNT);
    const user = userEvent.setup();
    render(<App />);
    await analyzeFixture(user);
    await enterGuided(user);
    const inspectPages = vi.mocked(localEngineAdapter.inspectPages);
    const describeCropPage = vi.mocked(localEngineAdapter.describeCropPage);
    const templateCallsAfterFirstEnter = inspectPages.mock.calls
      .filter((call) => call[3]).length;
    const describeCallsAfterFirstEnter = describeCropPage.mock.calls.length;
    expect(templateCallsAfterFirstEnter).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: '退出微调' }));
    await waitFor(() => expect(screen.getByRole('region', { name: '结果检查' }).getAttribute('data-phase')).toBe('entry'));
    await user.click(screen.getByRole('button', { name: '进入微调' }));
    await waitFor(() => expect(screen.getByRole('region', { name: '微调与确认' }).getAttribute('data-phase')).toBe('editing'));
    const reopenedRows = guidedRows();
    expect(reopenedRows).toHaveLength(LARGE_CANDIDATE_COUNT);
    expect(reopenedRows.map((row) => row.getAttribute('aria-label') ?? '')).toEqual(
      Array.from({ length: LARGE_CANDIDATE_COUNT }, (_, index) => (
        expect.stringMatching(new RegExp(`demo-bank-a-1\\.pdf.*第 ${index + 1} 页 \\/ 片段 1`))
      )),
    );
    expect(inspectPages.mock.calls.filter((call) => call[3])).toHaveLength(templateCallsAfterFirstEnter);
    expect(describeCropPage.mock.calls).toHaveLength(describeCallsAfterFirstEnter);
  });
});
