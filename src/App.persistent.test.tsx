// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// @ts-expect-error The test runtime exposes Node crypto without @types/node.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import {
  localEngineAdapter,
  type EngineOriginalReview,
  type EnginePreparedReview,
  type EngineReviewContext,
  type EngineReviewSegmentV2,
} from './components/localEngineAdapter';
import type {
  BatchJobSnapshot,
  BatchJobSummary,
  BatchResultItem,
  BatchResponse,
  BatchSourceSnapshot,
} from './domain/batchTask';
import { BatchClient } from './services/batchClient';
import type { BatchCleanup } from './domain/batchCleanup';
import { APP_SETTINGS_STORAGE_KEY, DEFAULT_APP_SETTINGS } from './domain/appSettings';
import { ExportBundleClient, ExportBundleError, type ExportBundlePreview, type ExportBundleReceipt,
  type ExportScopeRequest } from './services/exportBundleClient';

type BatchEvent = { payload: unknown };
type EventListener = (event: BatchEvent) => void;

const eventHarness = vi.hoisted(() => ({
  listener: null as EventListener | null,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, callback: EventListener) => {
    eventHarness.listener = callback;
    return () => {
      if (eventHarness.listener === callback) eventHarness.listener = null;
    };
  }),
}));

const SOURCE_PATH = '/docs/persistent-original.pdf';
const ACCESS_PATH = '/docs/persistent-current.pdf';
const EMPTY_SOURCE_PATH = '/docs/persistent-empty.pdf';
const EMPTY_ACCESS_PATH = '/docs/persistent-empty-current.pdf';
const SOURCE_KEY = SOURCE_PATH;
const EMPTY_SOURCE_KEY = EMPTY_SOURCE_PATH;
const SOURCE_SHA = 'a'.repeat(64);
const EMPTY_SHA = 'b'.repeat(64);
const JOB_ID = 'persistent-job-1';
const RESULT_REVISION = 'persistent-result-revision-1';
const CRITERIA_FINGERPRINT = 'e'.repeat(64);
const COMPUTATION_VERSION = 'persistent-engine-v1';
const MATCH_RECT = { x0: 20, y0: 40, x1: 120, y1: 64 };
const CANDIDATE_RECT = { x0: 0, y0: 0, x1: 560, y1: 300 };

const criteria = {
  include: ['手续费'],
  includeMode: 'all' as const,
  exclude: [],
};

function pageSummary(succeeded: number, failed = 0) {
  return { pending: 0, processing: 0, succeeded, failed };
}

function source(
  sourceId: string,
  position: number,
  sourceKey: string,
  initialPath: string,
  accessPath: string,
  name: string,
  sha256: string,
  pageCount: number,
): BatchSourceSnapshot {
  return {
    source_id: sourceId,
    position,
    source_key: sourceKey,
    initial_path: initialPath,
    access_path: accessPath,
    name,
    sha256,
    size_bytes: 1_024,
    page_count: pageCount,
    state: 'verified',
    error: null,
    budget: {
      processed_pages: pageCount,
      text_characters: 256,
      fuzzy_work: 0,
      matches: sourceId === 'source-1' ? 1 : 0,
      matched_text_characters: sourceId === 'source-1' ? 3 : 0,
    },
    verified_generation: 1,
    page_summary: pageSummary(pageCount),
  };
}

const SOURCES = [
  source('source-1', 0, SOURCE_KEY, SOURCE_PATH, ACCESS_PATH, 'persistent-original.pdf', SOURCE_SHA, 2),
  source('source-2', 1, EMPTY_SOURCE_KEY, EMPTY_SOURCE_PATH, EMPTY_ACCESS_PATH, 'persistent-empty.pdf', EMPTY_SHA, 2),
];

function jobSnapshot(
  state: BatchJobSnapshot['state'],
  generation = 1,
  sources: BatchSourceSnapshot[] = SOURCES,
): BatchJobSnapshot {
  return {
    id: JOB_ID,
    name: '持久任务：手续费',
    generation,
    state,
    resume_target: null,
    criteria,
    criteria_fingerprint: CRITERIA_FINGERPRINT,
    match_mode: 'exact',
    computation_version: COMPUTATION_VERSION,
    result_revision: state === 'ready_for_review' ? RESULT_REVISION : null,
    owner: null,
    error: null,
    created_at: '2026-09-08T01:00:00.000Z',
    updated_at: '2026-09-08T01:00:00.000Z',
    deletion_pending: false,
    page_summary: pageSummary(sources.reduce((sum, item) => sum + (item.page_count ?? 0), 0)),
    total_pages: sources.reduce((sum, item) => sum + (item.page_count ?? 0), 0),
    sources,
  };
}

function summary(job: BatchJobSnapshot): BatchJobSummary {
  const { sources, ...rest } = job;
  return {
    ...rest,
    source_summary: {
      total: sources.length,
      pending: 0,
      registered: 0,
      verified: sources.length,
      failed: 0,
      blocked: 0,
      declared_pages: job.total_pages,
    },
  };
}

function resultItem(): BatchResultItem {
  return {
    segment: {
      id: 'segment-1',
      source_key: SOURCE_KEY,
      source_path: SOURCE_PATH,
      source_sha256: SOURCE_SHA,
      source_page: 1,
      segment_no: 1,
      match_rect: MATCH_RECT,
      candidate_rect: CANDIDATE_RECT,
      final_rect: CANDIDATE_RECT,
      page_width: 600,
      page_height: 800,
      confidence: 0.96,
      slot: 'receipt',
      snap_points: [40, 64],
      layout_fingerprint: 'layout-1',
      crop_mode: 'candidate',
      review_status: 'needs_review',
      manual_adjusted: false,
    },
    evidence: [{
      page: 1,
      matched_text: '手续费',
      matched_field: '摘要',
      confidence: 0.96,
      x0: MATCH_RECT.x0,
      y0: MATCH_RECT.y0,
      x1: MATCH_RECT.x1,
      y1: MATCH_RECT.y1,
      needs_review: false,
      query_id: 'include-0',
      role: 'include',
    }],
    original: {
      id: 'segment-1',
      source_key: SOURCE_KEY,
      source_page: 1,
      segment_no: 1,
      analysis_signature: 'd'.repeat(64),
      persistable: true,
      page_width: 600,
      page_height: 800,
      match_rect: MATCH_RECT,
      candidate_rect: CANDIDATE_RECT,
      layout_fingerprint: 'layout-1',
      confidence: 0.96,
      auto_full_page: false,
    },
  };
}

function reviewContext(): EngineReviewContext {
  return {
    version: 2,
    sources: SOURCES.map((item) => ({
      source_key: item.source_key,
      source_path: item.access_path,
      source_sha256: item.sha256!,
    })),
    criteria_fingerprint: CRITERIA_FINGERPRINT,
    computation_version: COMPUTATION_VERSION,
  };
}

function reviewOriginal(): EngineOriginalReview {
  const item = resultItem().original;
  return {
    id: item.id,
    source_key: item.source_key,
    source_page: item.source_page,
    segment_no: item.segment_no,
    analysis_signature: item.analysis_signature,
    persistable: item.persistable,
    page_width: item.page_width,
    page_height: item.page_height,
    match_rect: item.match_rect,
    candidate_rect: item.candidate_rect,
    layout_fingerprint: item.layout_fingerprint,
    confidence: item.confidence,
    auto_full_page: item.auto_full_page,
  };
}

function preparedReview(contextKey: string): EnginePreparedReview {
  return {
    status: 'ok',
    context_key: contextKey,
    result_revision: RESULT_REVISION,
    segments: [],
    record_revisions: [{
      id: 'segment-1',
      source_key: SOURCE_KEY,
      source_page: 1,
      segment_no: 1,
      record_revision: 0,
    }],
    group_confirmed: false,
  };
}

async function contextKey(context: EngineReviewContext): Promise<string> {
  const canonical = JSON.stringify({
    computation_version: context.computation_version,
    criteria_fingerprint: context.criteria_fingerprint,
    sources: context.sources.map(({ source_key, source_sha256 }) => ({ source_key, source_sha256 })),
    version: 2,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function originalContext(): Promise<{ original: { context: EngineReviewContext; originals: EngineOriginalReview[]; resultRevision: string }; prepared: EnginePreparedReview }> {
  const context = reviewContext();
  const key = await contextKey(context);
  return {
    original: { context, originals: [reviewOriginal()], resultRevision: RESULT_REVISION },
    prepared: preparedReview(key),
  };
}

function ok<T>(data: T): BatchResponse<T> {
  return { status: 'ok', data };
}

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

function installEngineMocks(): void {
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(localEngineAdapter, 'health').mockResolvedValue({ status: 'ok', engine: 'test-engine', version: 'test' });
  vi.spyOn(localEngineAdapter, 'ocrHealth').mockResolvedValue({ status: 'ok', available: true, engine: 'paddleocr', message: 'ok', readiness: 'installed' });
  vi.spyOn(localEngineAdapter, 'pickPdfFiles').mockResolvedValue({ files: [ACCESS_PATH], directory: '/docs' });
  vi.spyOn(localEngineAdapter, 'inspectPdf').mockResolvedValue({ status: 'ok', page_count: 2, source_sha256: SOURCE_SHA });
  vi.spyOn(localEngineAdapter, 'renderPage').mockImplementation(async (_path, page, sha256) => ({
    status: 'ok', page, page_count: 2, page_width: 600, page_height: 800,
    source_sha256: sha256, image_data: 'data:image/png;base64,AA==',
  }));
  // A persistent task must never silently fall back to the legacy local search
  // or review preparation path.  These spies make that regression explicit.
  vi.spyOn(localEngineAdapter, 'search').mockRejectedValue(new Error('legacy search must not run'));
  vi.spyOn(localEngineAdapter, 'searchMulti').mockRejectedValue(new Error('legacy multi-search must not run'));
  vi.spyOn(localEngineAdapter, 'analyzePage').mockRejectedValue(new Error('legacy page analysis must not run'));
  vi.spyOn(localEngineAdapter, 'prepareReviewContext').mockRejectedValue(new Error('legacy review preparation must not run'));
  vi.spyOn(ExportBundleClient.prototype, 'status').mockImplementation(async (jobId) => ({ job_id: jobId, publication: null, residuals: [] }));
}

function installExportCase(confirmed = true) {
  const ready = jobSnapshot('ready_for_review');
  const items = [resultItem(), structuredClone(resultItem())];
  if (confirmed) items.forEach((item) => { item.segment.review_status = 'confirmed'; });
  const second = items[1]!;
  Object.assign(second.segment, { id: 'segment-2', source_key: EMPTY_SOURCE_KEY,
    source_path: EMPTY_SOURCE_PATH, source_sha256: EMPTY_SHA });
  Object.assign(second.original, { id: 'segment-2', source_key: EMPTY_SOURCE_KEY });
  const spies = getPersistentSpies(() => ready, () => [summary(ready)]);
  spies.loadAllResults.mockResolvedValue(items);
  const stored = new Map<string, EngineReviewSegmentV2>();
  const prepared = async () => {
    const response = await originalContext();
    response.original.originals = items.map((item) => structuredClone(item.original));
    response.prepared.segments = [...stored.values()].map((row) => structuredClone(row));
    response.prepared.record_revisions = items.map(({ original }) => ({
      id: original.id, source_key: original.source_key, source_page: original.source_page, segment_no: original.segment_no,
      record_revision: stored.get(original.id)?.record_revision ?? 0,
      ...(stored.has(original.id) ? { task_id: JOB_ID } : {}),
    }));
    return response;
  };
  spies.prepareReview.mockImplementation(prepared);
  const save = vi.spyOn(localEngineAdapter, 'saveReviewSegmentsV2').mockImplementation(async (key, revision, records) => {
    for (const row of records) if (row.record_revision !== (stored.get(row.id)?.record_revision ?? 0)) throw new Error('CAS conflict');
    const saved = records.map((row) => ({ ...structuredClone(row), record_revision: row.record_revision + 1 }));
    saved.forEach((row) => stored.set(row.id, row));
    return { status: 'ok', context_key: key, result_revision: revision, saved_count: saved.length, segments: saved };
  });
  vi.spyOn(localEngineAdapter, 'readReviewSnapshot').mockImplementation(async () => (await prepared()).prepared);
  vi.mocked(localEngineAdapter.inspectPdf).mockImplementation(async (path) => ({ status: 'ok', page_count: 2,
    source_sha256: path === EMPTY_ACCESS_PATH ? EMPTY_SHA : SOURCE_SHA }));
  let sequence = 0;
  const previews = new Map<string, ExportBundlePreview>();
  const makePreview = (request: ExportScopeRequest): ExportBundlePreview => {
    sequence += 1;
    const ids = request.selected_segment_ids;
    const selected = items.filter((item) => ids.includes(item.segment.id));
    const sourceKeys = [...new Set(selected.map((item) => item.segment.source_key))];
    const outputBase = request.output_name ?? '全部匹配结果';
    const pdfs: Array<{ id: string; name: string; source: string | null; count: number }> = [];
    if (request.output_mode !== 'by_source') pdfs.push({ id: 'merged', name: `${outputBase}.pdf`, source: null, count: ids.length });
    if (request.output_mode !== 'merged') sourceKeys.forEach((source, index) => pdfs.push({ id: `source-${index + 1}`,
      name: `${outputBase}_${String(index + 1).padStart(3, '0')}__source__匹配结果.pdf`, source, count: selected.filter((item) => item.segment.source_key === source).length }));
    const files = pdfs.map((file, index) => {
      const token = `${String(index + sequence * 10).padStart(8, '0')}-1234-1234-1234-123456789012`;
      return { file_id: file.id, name: file.name, source_key: file.source, page_count: file.count, preview_token: token,
        preview_path: `C:/cache/export-previews/${token}.pdf`, sha256: String(index + 1).repeat(64), size_bytes: 1000 + index };
    });
    const preview: ExportBundlePreview = { intent_id: `${String(sequence).padStart(8, '0')}-1234-1234-1234-123456789012`, state: 'rendered',
      job_id: JOB_ID, result_revision: RESULT_REVISION, scope_kind: request.scope_kind, selected_segment_ids: [...ids],
      source_fingerprint: SOURCE_SHA, review_revision: EMPTY_SHA, output_mode: request.output_mode, include_xlsx: request.include_xlsx,
      summary: { total_segments: items.length, selected_count: ids.length, selected_source_count: sourceKeys.length,
        omitted_count: items.length - ids.length,
        omitted_unresolved_count: items.filter((item) => !ids.includes(item.segment.id) && !['confirmed', 'group_confirmed', 'page_confirmed'].includes(stored.get(item.segment.id)?.review_status ?? 'needs_review')).length,
        expected_pages: ids.length }, files,
      merged_pages: request.output_mode === 'by_source' ? 0 : ids.length,
      source_pages: request.output_mode === 'merged' ? 0 : ids.length, total_pages: files.reduce((total, file) => total + file.page_count, 0),
      ...(request.output_name === undefined ? {} : { output_name: request.output_name }) };
    previews.set(preview.intent_id, preview);
    return preview;
  };
  const makeReceipt = (preview: ExportBundlePreview, parent = 'D:/out'): ExportBundleReceipt => {
    const directory = `${parent}/PDF查找_20260908_100000_${preview.intent_id.slice(0, 8)}`;
    const files: ExportBundleReceipt['files'] = preview.files.map((file) => ({ name: file.name, path: `${directory}/${file.name}`,
      kind: 'pdf', sha256: file.sha256, size_bytes: file.size_bytes, page_count: file.page_count }));
    if (preview.include_xlsx) files.push({ name: '匹配索引.xlsx', path: `${directory}/匹配索引.xlsx`, kind: 'xlsx', sha256: SOURCE_SHA, size_bytes: 500 });
    files.push({ name: '导出清单.json', path: `${directory}/导出清单.json`, kind: 'json', sha256: EMPTY_SHA, size_bytes: 900 });
    return { intent_id: preview.intent_id, state: 'published', directory, files, summary: preview.summary,
      merged_pages: preview.merged_pages, source_pages: preview.source_pages, total_pages: preview.total_pages,
      row_count: preview.include_xlsx ? preview.summary.selected_count : 0,
      ...(preview.output_name !== undefined && preview.output_mode !== 'by_source' ? { merged_name: `${preview.output_name}.pdf` } : {}) };
  };
  vi.mocked(localEngineAdapter.renderPage).mockImplementation(async (path, page, sha) => {
    const file = [...previews.values()].flatMap((item) => item.files).find((item) => item.preview_path === path);
    return { status: 'ok', page, page_count: file?.page_count ?? 2, page_width: 600, page_height: 800,
      source_sha256: sha, image_data: 'data:image/png;base64,AA==' };
  });
  const create = vi.spyOn(ExportBundleClient.prototype, 'create').mockImplementation(async (request) => makePreview(request));
  const publish = vi.spyOn(ExportBundleClient.prototype, 'publish').mockImplementation(async (preview, directory) => makeReceipt(preview, directory));
  const close = vi.spyOn(ExportBundleClient.prototype, 'close').mockResolvedValue();
  const picker = vi.spyOn(localEngineAdapter, 'pickOutputFolder').mockResolvedValue('D:/out');
  vi.spyOn(localEngineAdapter, 'openOutputFolder').mockResolvedValue();
  const legacyPdf = vi.spyOn(localEngineAdapter, 'exportPdf').mockRejectedValue(new Error('legacy export must not run'));
  const legacyIndex = vi.spyOn(localEngineAdapter, 'exportIndex').mockRejectedValue(new Error('legacy index must not run'));
  const legacyPublish = vi.spyOn(localEngineAdapter, 'publishPreviewPdf').mockRejectedValue(new Error('legacy publish must not run'));
  return { ready, items, stored, save, create, publish, close, picker, makePreview, makeReceipt, legacyPdf, legacyIndex, legacyPublish };
}

async function openExportTask(user: ReturnType<typeof userEvent.setup>, confirmAll = true) {
  const view = render(<App />);
  await openHistoryAndSelectReady(user);
  await screen.findByLabelText('裁剪区域');
  if (confirmAll) {
    await waitFor(() => expect((screen.getByRole('button', { name: '确认整组' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '确认整组' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '生成 PDF 导出预览' }) as HTMLButtonElement).disabled).toBe(false));
  }
  return view;
}

async function openScope(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^(生成 PDF 导出预览|选择导出范围)$/ }));
  return screen.findByRole('dialog', { name: '导出设置' });
}

async function generateScope(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '确认范围并生成预览' }));
  await screen.findByRole('img', { name: '最终 PDF 第 1 页预览' });
}

function enablePersistentRuntime(): void {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke: vi.fn() },
  });
}

function getPersistentSpies(current: () => BatchJobSnapshot, listJobs: () => BatchJobSummary[]) {
  const list = vi.spyOn(BatchClient.prototype, 'list').mockImplementation(async () => ok({
    items: listJobs(), offset: 0, limit: 50, total: listJobs().length, next_offset: null,
  }));
  const snapshot = vi.spyOn(BatchClient.prototype, 'snapshot').mockImplementation(async () => ok(current()));
  const loadAllResults = vi.spyOn(BatchClient.prototype, 'loadAllResults').mockResolvedValue([resultItem()]);
  const prepareReview = vi.spyOn(BatchClient.prototype, 'prepareReview').mockImplementation(async () => originalContext());
  const create = vi.spyOn(BatchClient.prototype, 'create').mockResolvedValue(ok(jobSnapshot('queued')));
  const start = vi.spyOn(BatchClient.prototype, 'start').mockResolvedValue(ok(jobSnapshot('running')));
  const control = vi.spyOn(BatchClient.prototype, 'control').mockResolvedValue({
    status: 'ok', data: {
      status: 'ok', job_id: JOB_ID, generation: 1, command_id: 'command-1', action: 'pause', state: 'paused',
    },
  });
  return { list, snapshot, loadAllResults, prepareReview, create, start, control };
}

async function openHistoryAndSelectReady(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: '历史任务' }));
  const row = await screen.findByRole('button', { name: /选择任务 持久任务：手续费/ });
  await user.click(row);
}

describe('App persistent batch orchestration', () => {
  it.each([true, false])('OCR probe respects whether task failure predates the check: %s', async (failureBeforeProbe) => {
    let current = jobSnapshot(failureBeforeProbe ? 'blocked' : 'running');
    if (failureBeforeProbe) current.error = { code: 'ocr_inference_failed', stage: 'page' };
    getPersistentSpies(() => current, () => [summary(current)]);
    let finishProbe!: (value: Awaited<ReturnType<typeof localEngineAdapter.ocrHealth>>) => void;
    vi.mocked(localEngineAdapter.ocrHealth).mockImplementation((verify = false) => verify
      ? new Promise(resolve => { finishProbe = resolve; })
      : Promise.resolve({ status: 'ok', available: true, engine: 'paddleocr', readiness: 'installed', message: '待验证' }));
    const user = userEvent.setup();
    render(<App/>);
    await waitFor(() => expect(screen.getByText(/本地引擎已连接/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '历史任务' }));
    await user.click(await screen.findByRole('button', { name: `选择任务 ${current.name}` }));
    await screen.findByRole('complementary', { name: '当前任务' });
    if (failureBeforeProbe) expect(screen.getByText(/本地引擎已连接/).textContent).toContain('OCR 验证失败');
    await user.click(screen.getByRole('button', { name: '帮助与反馈' }));
    await user.click(screen.getByRole('button', { name: '检测 OCR' }));
    if (!failureBeforeProbe) {
      current = { ...current, state: 'blocked', error: { code: 'ocr_inference_failed', stage: 'page' } };
      await act(async () => { eventHarness.listener?.({ payload: { kind: 'settled', jobId: JOB_ID, generation: 1 } }); });
      await waitFor(() => expect(screen.getByText(/本地引擎已连接 · OCR/).textContent).toContain('OCR 验证失败'));
    }
    await act(async () => { finishProbe({ status: 'ok', available: true, engine: 'paddleocr', readiness: 'ready', message: '测试文字验证通过' }); });
    await waitFor(() => expect(screen.getByText(/本地引擎已连接 · OCR/).textContent)
      .toContain(failureBeforeProbe ? 'OCR 已验证可用' : 'OCR 验证失败'));
  });

  beforeEach(() => {
    eventHarness.listener = null;
    enablePersistentRuntime();
    installLocalStorageShim();
    installEngineMocks();
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    eventHarness.listener = null;
  });

  it('M5 keeps ordinary filters separate and explicitly captures only the visible resolved source', async () => {
    const harness = installExportCase(false); const user = userEvent.setup();
    await openExportTask(user, false);
    await user.click(screen.getByRole('button', { name: '确认当前片段' }));
    await waitFor(() => expect(harness.save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole('button', { name: '选择导出范围' }) as HTMLButtonElement).disabled).toBe(false));
    await user.selectOptions(screen.getByRole('combobox', { name: '来源 PDF' }), SOURCE_KEY);
    const dialog = await openScope(user);
    expect((within(dialog).getByRole('radio', { name: '全部结果' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('button', { name: '确认范围并生成预览' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(/当前选中范围有 1 项未解决/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '将当前列表设为导出范围' }));
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'PDF 输出模式' }), 'both');
    await user.click(within(dialog).getByRole('checkbox', { name: '同时导出审核索引 XLSX' }));
    await generateScope(user);
    expect(harness.create).toHaveBeenCalledWith(expect.objectContaining({ scope_kind: 'list', selected_segment_ids: ['segment-1'],
      expected_records: [{ id: 'segment-1', record_revision: 2 }], output_mode: 'both', include_xlsx: true }));
    expect(harness.save.mock.calls.at(-1)?.[2].map((row) => row.id)).toEqual(['segment-1']);
    expect(harness.save.mock.calls.at(-1)?.[3]).toBe(false);
    expect(harness.stored.has('segment-2')).toBe(false);
    expect(screen.getByText(/本次导出 1 \/ 2 个片段.*未选中 1 个（未解决 1 个）/)).toBeTruthy();
    const files = screen.getByRole('combobox', { name: '预览文件' });
    expect(within(files).getAllByRole('option')).toHaveLength(2);
    await user.selectOptions(files, 'source-1');
    await screen.findByRole('img', { name: '最终 PDF 第 1 页预览' });
    expect(vi.mocked(localEngineAdapter.renderPage).mock.calls.at(-1)?.[2]).toBe('2'.repeat(64));
    const frozen = screen.getByRole('checkbox', { name: '同时导出审核索引 XLSX（可选）' }) as HTMLInputElement;
    expect(frozen.disabled).toBe(true); expect(frozen.checked).toBe(true);
    await user.click(screen.getByRole('button', { name: '返回调整' }));
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('combobox', { name: '来源 PDF' }) as HTMLSelectElement).value).toBe(SOURCE_KEY);
    expect(screen.getByRole('button', { name: '确认整组' })).toBeTruthy();
    expect(screen.queryByText('已确认 2 / 2')).toBeNull();
    expect(harness.legacyPdf).not.toHaveBeenCalled(); expect(harness.legacyIndex).not.toHaveBeenCalled();
  });

  it('M5 source checkboxes select only that source without changing the full task', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    await openExportTask(user);
    const dialog = await openScope(user);
    await user.click(within(dialog).getByRole('radio', { name: '选定来源 PDF' }));
    await user.click(within(dialog).getByRole('checkbox', { name: /persistent-empty.pdf/ }));
    await generateScope(user);
    expect(harness.create.mock.calls[0]?.[0]).toMatchObject({ scope_kind: 'sources', selected_segment_ids: ['segment-1'] });
    expect(harness.stored.get('segment-2')?.record_revision).toBe(1);
  });

  it('M5 defaults to all results in original order regardless of visible source and confidence sorting', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    await openExportTask(user);
    await user.selectOptions(screen.getByRole('combobox', { name: '来源 PDF' }), EMPTY_SOURCE_KEY);
    await user.selectOptions(screen.getByRole('combobox', { name: '结果排序' }), 'confidence_desc');
    const dialog = await openScope(user);
    expect((within(dialog).getByRole('combobox', { name: 'PDF 输出模式' }) as HTMLSelectElement).value).toBe('merged');
    expect((within(dialog).getByRole('checkbox', { name: '同时导出审核索引 XLSX' }) as HTMLInputElement).checked).toBe(false);
    await generateScope(user);
    expect(harness.create.mock.calls[0]?.[0]).toMatchObject({ scope_kind: 'all', selected_segment_ids: ['segment-1', 'segment-2'], include_xlsx: false });
    expect(harness.picker).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '选择目录并导出 PDF' }));
    await waitFor(() => expect(harness.publish).toHaveBeenCalledTimes(1));
    await screen.findByText(/导出成功：1 份 PDF，共 2 页/);
    expect(harness.legacyPublish).not.toHaveBeenCalled();
  });

  it('M6 freezes the edited export name and carries it into preview and publication', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    await openExportTask(user);
    const dialog = await openScope(user);
    const name = within(dialog).getByRole('textbox', { name: '导出文件名' }) as HTMLInputElement;
    expect(name.value).toBe('手续费_匹配结果');
    await user.clear(name);
    await user.type(name, '定制报告.pdf');
    await generateScope(user);
    expect(harness.create.mock.calls[0]?.[0]).toMatchObject({ output_name: '定制报告' });
    expect(screen.getByRole('option', { name: /定制报告\.pdf/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '选择目录并导出 PDF' }));
    await screen.findByText(/导出成功：1 份 PDF，共 2 页/);
    expect(harness.publish.mock.calls[0]?.[0].files[0]?.name).toBe('定制报告.pdf');
  });

  it('M5 keeps modal focus contained, closes with Escape and never generates implicitly', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    await openExportTask(user);
    const entry = screen.getByRole('button', { name: '生成 PDF 导出预览' });
    const dialog = await openScope(user);
    const first = within(dialog).getByRole('radio', { name: '全部结果' });
    first.focus(); await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '确认范围并生成预览' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '导出设置' })).toBeNull();
    expect(document.activeElement).toBe(entry);
    expect(harness.create).not.toHaveBeenCalled();
  });

  it('M5 never creates an intent after scope CAS save fails and offers the established recovery tools', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    await openExportTask(user);
    harness.save.mockRejectedValueOnce(new Error('CAS conflict'));
    await openScope(user);
    await user.click(screen.getByRole('button', { name: '确认范围并生成预览' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导出设置' })).toBeNull());
    expect(harness.create).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '重试保存' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '重试保存' }));
    await waitFor(() => expect(harness.save).toHaveBeenCalledTimes(3));
    expect(harness.create).not.toHaveBeenCalled();
  });

  it('M6 leaves settings available for retry after preview generation fails', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    await openExportTask(user);
    harness.create.mockRejectedValueOnce(new Error('synthetic preview failure'));
    await openScope(user);
    await user.click(screen.getByRole('button', { name: '确认范围并生成预览' }));
    await screen.findByText(/生成预览失败：synthetic preview failure/);
    await waitFor(() => expect((screen.getByRole('button', { name: '确认范围并生成预览' }) as HTMLButtonElement).disabled).toBe(false));
    await generateScope(user);
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it('M6 retains previews and the last directory on cancellation, then publishes the identical frozen bundle', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_APP_SETTINGS, lastOutputDirectory: 'D:/previous' }));
    await openExportTask(user); await openScope(user); await generateScope(user);
    harness.picker.mockResolvedValueOnce(null).mockResolvedValueOnce('D:/next');
    await user.click(screen.getByRole('button', { name: '选择目录并导出 PDF' }));
    expect(harness.publish).not.toHaveBeenCalled(); expect(harness.close).not.toHaveBeenCalled();
    expect(harness.picker).toHaveBeenLastCalledWith('D:/previous');
    expect(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).toContain('D:/previous');
    expect(screen.getByRole('img', { name: '最终 PDF 第 1 页预览' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '选择目录并导出 PDF' }));
    await screen.findByText(/导出成功：1 份 PDF/);
    expect(harness.publish.mock.calls[0]?.[1]).toBe('D:/next');
    expect(harness.picker).toHaveBeenLastCalledWith('D:/previous');
    expect(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).toContain('D:/next');
    expect(harness.close).toHaveBeenCalledWith(harness.publish.mock.calls[0]?.[0].intent_id);
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it('M6 freezes edits while publishing and can export both modes without visiting every preview file', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    await openExportTask(user); const dialog = await openScope(user);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'PDF 输出模式' }), 'both');
    await user.click(within(dialog).getByRole('checkbox', { name: '同时导出审核索引 XLSX' }));
    await generateScope(user);
    let done!: (receipt: ExportBundleReceipt) => void;
    harness.publish.mockImplementationOnce(async () => new Promise((resolve) => { done = resolve; }));
    await user.click(screen.getByRole('button', { name: '选择目录并导出 XLSX 与 PDF' }));
    await waitFor(() => expect(harness.publish).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('button', { name: '＋ 新建任务' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '修改搜索条件' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '返回调整' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('combobox', { name: '预览文件' }) as HTMLSelectElement).disabled).toBe(true);
    await act(async () => done(harness.makeReceipt(harness.publish.mock.calls[0]![0])));
    await screen.findByText(/导出成功：3 份 PDF，共 4 页，2 条索引/);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it('M6 recovers a published receipt after a lost reply without producing another copy or deleting outputs', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    await openExportTask(user); await openScope(user); await generateScope(user);
    harness.publish.mockImplementationOnce(async (preview) => {
      vi.mocked(ExportBundleClient.prototype.status).mockResolvedValue({ job_id: JOB_ID, publication: harness.makeReceipt(preview), residuals: [] });
      throw new Error('reply lost');
    });
    await user.click(screen.getByRole('button', { name: '选择目录并导出 PDF' }));
    await screen.findByText(/已找回上次导出结果：1 份 PDF/);
    expect(harness.publish).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.legacyPublish).not.toHaveBeenCalled();
  });

  it('M6 keeps failed publication previews and shows concrete retained files for retry', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    await openExportTask(user); await openScope(user); await generateScope(user);
    harness.publish.mockRejectedValueOnce(new ExportBundleError('export_failed', 'synthetic failure', [
      { path: 'D:/out/.pending/file.pdf', reason: '文件被替换，已保留' },
    ]));
    await user.click(screen.getByRole('button', { name: '选择目录并导出 PDF' }));
    await screen.findByText(/D:\/out\/\.pending\/file.pdf（文件被替换，已保留）/);
    expect(harness.close).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: '最终 PDF 第 1 页预览' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '选择目录并导出 PDF' }));
    await screen.findByText(/导出成功：1 份 PDF/);
  });

  it('M6 closes every file through its intent when an in-flight preview settles after unmount', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    const view = await openExportTask(user); await openScope(user);
    let finish!: () => void;
    harness.create.mockImplementationOnce((request) => new Promise((resolve) => { finish = () => resolve(harness.makePreview(request)); }));
    await user.click(screen.getByRole('button', { name: '确认范围并生成预览' }));
    await waitFor(() => expect(harness.create).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => finish());
    await waitFor(() => expect(harness.close).toHaveBeenCalledTimes(1));
    expect(harness.picker).not.toHaveBeenCalled();
  });

  it('M6 warns about private preview cleanup failures while preserving the delivered result', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    await openExportTask(user); await openScope(user); await generateScope(user);
    harness.close.mockRejectedValueOnce(new Error('cleanup denied'));
    await user.click(screen.getByRole('button', { name: '选择目录并导出 PDF' }));
    await screen.findByText(/整套结果已成功生成.*临时预览清理尚未完成/);
    await user.click(screen.getByRole('button', { name: '查看详情' }));
    expect(screen.getByRole('button', { name: '打开结果目录' })).toBeTruthy();
  });

  it('M6 starts fresh export options after return and reports cleanup failure without hiding the review', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    await openExportTask(user); const dialog = await openScope(user);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'PDF 输出模式' }), 'by_source');
    await user.click(within(dialog).getByRole('checkbox', { name: '同时导出审核索引 XLSX' }));
    await generateScope(user);
    expect(harness.create.mock.calls[0]?.[0].output_mode).toBe('by_source');
    expect(within(screen.getByRole('combobox', { name: '预览文件' })).getAllByRole('option')).toHaveLength(2);
    harness.close.mockRejectedValueOnce(new Error('cleanup denied'));
    await user.click(screen.getByRole('button', { name: '返回调整' }));
    await screen.findByText(/已返回裁剪审核；临时 PDF 预览清理失败/);
    const reopened = await openScope(user);
    expect((within(reopened).getByRole('checkbox', { name: '同时导出审核索引 XLSX' }) as HTMLInputElement).checked).toBe(false);
    expect((within(reopened).getByRole('combobox', { name: 'PDF 输出模式' }) as HTMLSelectElement).value).toBe('merged');
  });

  it('M6 clears the previous result when starting another task', async () => {
    const harness = installExportCase(); const user = userEvent.setup();
    await openExportTask(user); await openScope(user); await generateScope(user);
    await user.click(screen.getByRole('button', { name: '选择目录并导出 PDF' }));
    await screen.findByText(/导出成功：1 份 PDF/);
    await user.click(screen.getByRole('button', { name: '查看详情' }));
    expect(screen.getByRole('button', { name: '打开结果目录' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '＋ 新建任务' }));
    expect(screen.queryByRole('button', { name: '打开结果目录' })).toBeNull();
    expect(harness.publish).toHaveBeenCalledTimes(1);
  });

  it('M4 does not recreate undo history when a late save settles while reloading the same task and result revision', async () => {
    const ready = jobSnapshot('ready_for_review');
    const spies = getPersistentSpies(() => ready, () => [summary(ready)]);
    let stored: EngineReviewSegmentV2 | null = null;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const save = vi.spyOn(localEngineAdapter, 'saveReviewSegmentsV2').mockImplementation(async (contextKey, revision, records) => {
      await gate;
      stored = { ...structuredClone(records[0]!), record_revision: records[0]!.record_revision + 1 };
      return { status: 'ok', context_key: contextKey, result_revision: revision, saved_count: 1, segments: [stored] };
    });
    spies.prepareReview.mockImplementation(async () => {
      const response = await originalContext();
      if (stored) {
        response.prepared.segments = [structuredClone(stored)];
        response.prepared.record_revisions[0] = { ...response.prepared.record_revisions[0]!,
          task_id: stored.task_id, record_revision: stored.record_revision };
      }
      return response;
    });
    const user = userEvent.setup();
    render(<App />);
    await openHistoryAndSelectReady(user);
    await waitFor(() => expect((screen.getByRole('button', { name: '保留整页' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '保留整页' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await openHistoryAndSelectReady(user);
    expect(spies.prepareReview).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await waitFor(() => expect(spies.prepareReview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('当前状态：需复核')).toBeTruthy());
    expect((screen.getByRole('button', { name: '撤销上一步' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('最近 0 / 20 步')).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('shows a server cleanup plan, retains review by default, and removes the deleted task workbench', async () => {
    const ready = jobSnapshot('ready_for_review');
    let deleted = false;
    getPersistentSpies(() => ready, () => deleted ? [] : [summary(ready)]);
    const plan: BatchCleanup = {
      cleanup_id: 'cleanup-1', job_id: JOB_ID, job_name: ready.name, source_count: 2,
      page_result_count: 4, review_record_count: 1, review_exclusive: true, preview_count: 0,
      delete_review: null, task_data_state: 'pending', review_state: 'pending', preview_state: 'pending',
      outcome: 'pending', created_at: ready.created_at, updated_at: ready.updated_at, notice_codes: [],
    };
    const completed: BatchCleanup = { ...plan, delete_review: false, task_data_state: 'deleted',
      review_state: 'retained', preview_state: 'absent', outcome: 'completed', notice_codes: ['review_retained'] };
    const planning = vi.spyOn(BatchClient.prototype, 'planCleanup').mockResolvedValue(ok(plan));
    const execution = vi.spyOn(BatchClient.prototype, 'executeCleanup').mockImplementation(async () => {
      deleted = true;
      return ok(completed);
    });
    vi.spyOn(BatchClient.prototype, 'listCleanups').mockImplementation(async () => ok({
      items: [deleted ? completed : plan], next_offset: null,
    }));
    vi.spyOn(BatchClient.prototype, 'storageUsage').mockResolvedValue(ok({
      database_bytes: 4096, wal_bytes: 0, shm_bytes: 0, total_bytes: 4096,
      quota_bytes: 2 ** 31, within_quota: true, available: true,
    }));
    const user = userEvent.setup();
    render(<App />);
    await openHistoryAndSelectReady(user);
    await screen.findByRole('button', { name: /第 1 页 \/ 片段 1/ });
    await user.click(screen.getByRole('button', { name: '历史任务' }));
    await user.click(await screen.findByRole('button', { name: '删除任务' }));
    await waitFor(() => expect(planning).toHaveBeenCalledWith(JOB_ID));
    const checkbox = await screen.findByRole('checkbox', { name: '同时删除该任务独占的审核记录' });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(execution).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确认删除任务' }));
    await waitFor(() => expect(execution).toHaveBeenCalledWith('cleanup-1', false));
    await waitFor(() => expect(screen.queryByRole('button', { name: /第 1 页 \/ 片段 1/ })).toBeNull());
    await waitFor(() => expect(screen.queryByRole('button', { name: /选择任务 持久任务：手续费/ })).toBeNull());
    expect(screen.getByText('人工审核记录已保留。')).toBeTruthy();
  });

  it('can retry a cleanup interrupted immediately after the durable start marker', async () => {
    getPersistentSpies(() => jobSnapshot('ready_for_review'), () => []);
    const interrupted: BatchCleanup = {
      cleanup_id: 'cleanup-interrupted', job_id: JOB_ID, job_name: '中断的清理', source_count: 2,
      page_result_count: 4, review_record_count: 1, review_exclusive: true, preview_count: 0,
      delete_review: true, task_data_state: 'pending', review_state: 'pending', preview_state: 'pending',
      outcome: 'pending', created_at: '2026-09-08T01:00:00Z', updated_at: '2026-09-08T01:00:00Z', notice_codes: [],
    };
    vi.spyOn(BatchClient.prototype, 'listCleanups').mockResolvedValue(ok({ items: [interrupted], next_offset: null }));
    vi.spyOn(BatchClient.prototype, 'storageUsage').mockResolvedValue(ok({
      database_bytes: null, wal_bytes: 0, shm_bytes: 0, total_bytes: null,
      quota_bytes: 2 ** 31, within_quota: null, available: false,
    }));
    const execution = vi.spyOn(BatchClient.prototype, 'executeCleanup').mockResolvedValue(ok({
      ...interrupted, task_data_state: 'deleted', review_state: 'deleted', preview_state: 'absent', outcome: 'completed',
    }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '历史任务' }));
    await user.click(await screen.findByRole('button', { name: '清理与空间' }));
    await user.click(await screen.findByRole('button', { name: '重试清理 中断的清理' }));
    await waitFor(() => expect(execution).toHaveBeenCalledWith('cleanup-interrupted', true));
  });

  it('startup lists tasks only; loading a ready task maps all sources, prepares trusted review, and validates real preview', async () => {
    const ready = jobSnapshot('ready_for_review');
    const spies = getPersistentSpies(() => ready, () => [summary(ready)]);
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(spies.list).toHaveBeenCalled());
    expect(spies.start).not.toHaveBeenCalled();
    await openHistoryAndSelectReady(user);

    await waitFor(() => expect(spies.loadAllResults).toHaveBeenCalledWith(JOB_ID, RESULT_REVISION, expect.any(AbortSignal)));
    await waitFor(() => expect(spies.prepareReview).toHaveBeenCalled());
    expect(localEngineAdapter.search).not.toHaveBeenCalled();
    expect(localEngineAdapter.searchMulti).not.toHaveBeenCalled();
    expect(localEngineAdapter.analyzePage).not.toHaveBeenCalled();
    expect(localEngineAdapter.prepareReviewContext).not.toHaveBeenCalled();

    // The second source has zero hits but remains part of the restored source
    // set; the first source is rendered through the actual preview effect.
    await waitFor(() => expect(screen.getByRole('combobox', { name: '来源 PDF' })).toBeTruthy());
    await waitFor(() => expect(localEngineAdapter.renderPage).toHaveBeenCalledWith(ACCESS_PATH, 1, SOURCE_SHA));
    await waitFor(() => expect(screen.getByRole('button', { name: /第 1 页 \/ 片段 1/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: /第 1 页 \/ 片段 1/ }).getAttribute('aria-label')).toContain('手续费');
  });

  it('shows only the new source while creating and running, and opens old tasks only on explicit history access', async () => {
    const old = { ...jobSnapshot('ready_for_review'), id: 'old-bank-job', name: '旧的华夏银行历史任务' };
    const current = jobSnapshot('running', 1, SOURCES.slice(0, 1));
    const spies = getPersistentSpies(() => current, () => [summary(old), summary(current)]);
    let finishCreate!: (value: BatchResponse<BatchJobSnapshot>) => void;
    spies.create.mockImplementation(() => new Promise((resolve) => { finishCreate = resolve; }));
    spies.start.mockResolvedValue(ok(current));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText(/本地引擎已连接/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '选择 PDF' }));
    await waitFor(() => expect(screen.getByText('2 页 · 文档已读取')).toBeTruthy());
    await user.type(screen.getByRole('textbox', { name: '包含关键词 1' }), '手续费');
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await waitFor(() => expect(spies.create).toHaveBeenCalledTimes(1));
    let panel = screen.getByRole('complementary', { name: '当前任务' });
    expect(within(panel).getByText('persistent-current.pdf')).toBeTruthy();
    expect(within(panel).queryByText(old.name)).toBeNull();
    expect(spies.create.mock.calls[0]?.[0].sources).toEqual([{ source_path: ACCESS_PATH, name: 'persistent-current.pdf' }]);
    await act(async () => { finishCreate(ok({ ...current, state: 'queued' })); });
    await screen.findByRole('button', { name: '暂停任务' });
    panel = screen.getByRole('complementary', { name: '当前任务' });
    expect(within(panel).queryByRole('button', { name: /选择任务/ })).toBeNull();
    expect(within(panel).getByRole('heading', { name: '本次来源' })).toBeTruthy();

    await user.click(within(panel).getByRole('button', { name: '任务历史' }));
    const history = screen.getByRole('complementary', { name: '任务历史' });
    const oldRow = within(history).getByRole('button', { name: `选择任务 ${old.name}` }) as HTMLButtonElement;
    expect(oldRow.disabled).toBe(true);
    await user.click(oldRow);
    expect(spies.loadAllResults).not.toHaveBeenCalled();
    expect(spies.control).not.toHaveBeenCalled();
    expect(spies.start).toHaveBeenCalledTimes(1);
    await user.click(within(history).getByRole('button', { name: '返回当前任务' }));
    expect(screen.queryByText(old.name)).toBeNull();
    await user.click(screen.getByRole('button', { name: '关闭当前任务' }));
    await user.click(screen.getByRole('button', { name: '当前任务' }));
    expect(screen.getByRole('button', { name: '暂停任务' }).closest('.task-history-action-bar')).toBeTruthy();
    expect(screen.queryByText(old.name)).toBeNull();
  });

  it('does not present an old selected task as the new task when creation fails, and retains it in history', async () => {
    const old = { ...jobSnapshot('paused', 1, SOURCES.slice(0, 1)), name: '旧的已暂停任务' };
    const spies = getPersistentSpies(() => old, () => [summary(old)]);
    spies.create.mockResolvedValue({ status: 'error', code: 'CREATE_FAILED', message: '创建失败测试' });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText(/本地引擎已连接/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '历史任务' }));
    await user.click(await screen.findByRole('button', { name: `选择任务 ${old.name}` }));
    await screen.findByRole('complementary', { name: '当前任务' });
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await waitFor(() => expect(spies.create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/创建失败测试/)).toBeTruthy());
    const panel = screen.getByRole('complementary', { name: '当前任务' });
    expect(within(panel).queryByText(old.name)).toBeNull();
    expect(within(panel).queryByRole('button', { name: '继续任务' })).toBeNull();
    expect(within(panel).getByText('persistent-original.pdf')).toBeTruthy();
    expect(spies.start).not.toHaveBeenCalled();
    await user.click(within(panel).getByRole('button', { name: '任务历史' }));
    expect(await screen.findByRole('button', { name: `选择任务 ${old.name}` })).toBeTruthy();
    expect(spies.control).not.toHaveBeenCalled();
  });

  it('creates a task, pauses it, resumes with a new generation, and loads the completed snapshot while keeping keyword history', async () => {
    let phase: BatchJobSnapshot['state'] = 'running';
    let generation = 1;
    const runningJob = () => jobSnapshot(phase, generation, SOURCES.slice(0, 1));
    const spies = getPersistentSpies(runningJob, () => [summary(runningJob())]);
    spies.create.mockResolvedValue(ok(jobSnapshot('queued', 1, SOURCES.slice(0, 1))));
    spies.start.mockImplementation(async ({ generation: requestedGeneration }) => {
      generation = phase === 'paused' ? requestedGeneration + 1 : requestedGeneration;
      phase = 'running';
      return ok(jobSnapshot('running', generation, SOURCES.slice(0, 1)));
    });
    spies.control.mockImplementation(async ({ action }) => {
      if (action === 'pause') phase = 'paused';
      return ok({
        status: 'ok', job_id: JOB_ID, generation, command_id: 'command-1', action, state: phase,
      });
    });
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(screen.getByText(/本地引擎已连接/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '选择 PDF' }));
    await waitFor(() => expect(screen.getByText('2 页 · 文档已读取')).toBeTruthy());
    const keyword = screen.getByRole('textbox', { name: '包含关键词 1' });
    await user.clear(keyword);
    await user.type(keyword, '手续费');
    await user.click(screen.getByRole('button', { name: '开始分析' }));

    await waitFor(() => expect(spies.create).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: '暂停任务' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '暂停任务' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '继续任务' })).toBeTruthy());
    expect(spies.control).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pause', generation: 1 }),
      expect.any(AbortSignal),
    );

    await user.click(screen.getByRole('button', { name: '继续任务' }));
    await waitFor(() => expect(spies.start).toHaveBeenCalledWith(expect.objectContaining({ job_id: JOB_ID, generation: 1 }), expect.any(AbortSignal)));
    expect(generation).toBe(2);
    phase = 'ready_for_review';
    // A settled event schedules an authoritative snapshot read.  No result
    // array is installed directly from the event payload.
    await act(async () => {
      eventHarness.listener?.({ payload: { kind: 'settled', jobId: JOB_ID, generation: 2 } });
      await Promise.resolve();
    });
    await waitFor(() => expect(spies.snapshot).toHaveBeenCalled());
    await waitFor(() => expect(spies.loadAllResults).toHaveBeenCalled());
    expect(JSON.parse(window.localStorage.getItem('pdf-search.keyword-history.v1') ?? '{}')).toMatchObject({
      include: expect.arrayContaining(['手续费']),
    });
  });

  it('keeps a ready task reloadable after prepare failure and does not publish partial results', async () => {
    const ready = jobSnapshot('ready_for_review');
    const spies = getPersistentSpies(() => ready, () => [summary(ready)]);
    spies.prepareReview.mockRejectedValueOnce(new Error('trusted prepare failed'));
    const user = userEvent.setup();
    render(<App />);

    await openHistoryAndSelectReady(user);
    await waitFor(() => expect(screen.getAllByRole('alert').some((item) => (
      item.textContent?.includes('审核结果载入失败：trusted prepare failed') ?? false
    ))).toBe(true));
    expect(screen.queryByRole('region', { name: '审核导航' })).toBeNull();
    expect(screen.queryByRole('button', { name: /第 1 页 \/ 片段 1/ })).toBeNull();
    expect(spies.loadAllResults).toHaveBeenCalledTimes(1);

    spies.prepareReview.mockImplementation(async () => originalContext());
    await user.click(screen.getByRole('button', { name: '载入审核' }));
    await waitFor(() => expect(spies.prepareReview).toHaveBeenCalledTimes(2));
    // The retry is allowed to succeed, but still cannot rely on legacy
    // preparation or an event-provided partial result list.
    expect(localEngineAdapter.prepareReviewContext).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: /第 1 页 \/ 片段 1/ })).toBeTruthy());
  });
});
