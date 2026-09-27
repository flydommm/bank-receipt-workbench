// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// @ts-expect-error The test runtime exposes Node crypto without @types/node.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { localEngineAdapter } from './components/localEngineAdapter';
import { BatchClient } from './services/batchClient';
import { ExportBundleClient } from './services/exportBundleClient';
import { ReceiptBatchClient } from './services/receiptBatchClient';
import { ReceiptLayoutClient, type ReceiptLayoutPreview } from './services/receiptLayoutClient';
import { LayoutTemplateClient, type LayoutTemplate } from './services/layoutTemplateClient';
import { APP_SETTINGS_STORAGE_KEY, DEFAULT_APP_SETTINGS } from './domain/appSettings';
import type { LayoutDefinition } from './domain/receiptLayout';
import type { ReceiptBatchJobSnapshot, ReceiptBatchPreparedReview, ReceiptBatchReviewPageItem } from './domain/receiptBatch';
import type { ReceiptReviewContext } from './domain/receiptReview';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

const sourceA = '/docs/huaxia.pdf';
const sourceB = '/docs/baosheng.pdf';
const sourceHash = (path: string) => (path === sourceB ? 'b' : 'a').repeat(64);
const pageGeometry = { pdf_box: { x0: 0, y0: 0, x1: 600, y1: 900 }, rotation: 0, user_unit: 1, width_pt: 600, height_pt: 900 } as const;
const candidateRect = { x0: 0, y0: 10, x1: 600, y1: 290 };
const layoutDefinition: LayoutDefinition = {
  schema_version: 1, layout_id: 'first-layout', revision: 1, workspace_id: 'test-workspace',
  issuer_id: 'synthetic-bank', family_id: 'three-slot', evidence_version: 'v1', page_geometry: pageGeometry,
  uniform_height: false, left_pt: 0, right_pt: 0,
  slots: [{ slot_id: 'first-slot', position_index: 1, top_pt: 10, height_pt: 280 }],
};
const fingerprint = 'e'.repeat(64);
const ok = <T,>(data: T) => ({ status: 'ok' as const, data });
const emptyList = { items: [], offset: 0, limit: 50, total: 0, next_offset: null };

function originals(job: ReceiptBatchJobSnapshot): ReceiptBatchReviewPageItem[] {
  return [1, 2].map((page) => ({ original: {
    id: `${job.id}-${page}`, source_key: job.sources[0].source_key, source_page: page,
    instance_id: `${job.id}-instance-${page}`, slot_id: 'first-slot', position_index: 1,
    layout_id: 'first-layout', layout_revision: 1, layout_signature: 'd'.repeat(64),
    page_geometry: pageGeometry, candidate_rect: candidateRect, occupancy: 'occupied',
    selection_basis: job.processing_options?.processing_mode === 'split_all' ? 'occupied_slot' : 'keyword',
    needs_review: false, analysis_signature: 'f'.repeat(64),
  }, record: null, record_revision: 0 }));
}

function prepare(job: ReceiptBatchJobSnapshot): ReceiptBatchPreparedReview {
  const context: ReceiptReviewContext = { version: 3,
    sources: job.sources.map((source) => ({ source_key: source.source_key, source_path: source.access_path, source_sha256: source.sha256! })),
    processing_options: job.processing_options!, match_mode: job.match_mode,
    criteria_fingerprint: job.criteria_fingerprint, computation_version: job.computation_version };
  return { context, binding: { job, context, contextKey: fingerprint },
    prepared: { status: 'ok', schema_version: 1, context_key: fingerprint, result_revision: job.result_revision!, total: 2 } };
}

function installClients() {
  const jobs = new Map<string, ReceiptBatchJobSnapshot>();
  vi.spyOn(BatchClient.prototype, 'list').mockResolvedValue(ok(emptyList));
  vi.spyOn(ReceiptBatchClient.prototype, 'list').mockResolvedValue(ok(emptyList));
  const legacyCreate = vi.spyOn(BatchClient.prototype, 'create').mockRejectedValue(new Error('A new desktop analysis must not create a schema-1 job'));
  const legacyPrepare = vi.spyOn(BatchClient.prototype, 'prepareReview').mockRejectedValue(new Error('Receipt results require context schema 3'));
  const create = vi.spyOn(ReceiptBatchClient.prototype, 'create').mockImplementation(async (input) => {
    const id = `receipt-job-${jobs.size + 1}`;
    const job: ReceiptBatchJobSnapshot = { id, name: input.name, generation: 1, state: 'queued', resume_target: null,
      criteria: input.processing_options.criteria, page_result_schema: 2, processing_options: input.processing_options,
      criteria_fingerprint: fingerprint, match_mode: input.match_mode, computation_version: 'synthetic-v1',
      result_revision: null, owner: null, error: null, created_at: '2026-09-16T01:00:00.000Z', updated_at: '2026-09-16T01:00:00.000Z',
      deletion_pending: false, page_summary: { pending: 2, processing: 0, succeeded: 0, failed: 0 }, total_pages: 2,
      sources: input.sources.map((source, position) => ({ source_id: `${id}-source-${position}`, source_key: source.source_path,
        position, initial_path: source.source_path, access_path: source.source_path, name: source.name,
        sha256: sourceHash(source.source_path), size_bytes: 1024, page_count: 2, state: 'verified', error: null,
        budget: { processed_pages: 2, text_characters: 32, fuzzy_work: 0, matches: 2, matched_text_characters: 6 },
        verified_generation: 1, page_summary: { pending: 0, processing: 0, succeeded: 2, failed: 0 } })) };
    jobs.set(id, job);
    return ok(job);
  });
  vi.spyOn(ReceiptBatchClient.prototype, 'start').mockImplementation(async ({ job_id }) => {
    const job = { ...jobs.get(job_id)!, state: 'ready_for_review' as const, result_revision: `${job_id}-revision`,
      page_summary: { pending: 0, processing: 0, succeeded: 2, failed: 0 } };
    jobs.set(job_id, job);
    return ok(job);
  });
  vi.spyOn(ReceiptBatchClient.prototype, 'snapshot').mockImplementation(async ({ job_id }) => ok(jobs.get(job_id)!));
  const prepared = vi.spyOn(ReceiptBatchClient.prototype, 'prepareReview').mockImplementation(async (job) => prepare(job));
  const loaded = vi.spyOn(ReceiptBatchClient.prototype, 'loadAllReviewPages').mockImplementation(async (binding) => originals(binding.binding.job));
  const calibration = vi.spyOn(ReceiptLayoutClient.prototype, 'prepare').mockImplementation(async (binding, sampleId) => ({
    schema_version: 1, job_id: binding.binding.job.id, result_revision: binding.prepared.result_revision,
    sample_id: sampleId, context_key: fingerprint, selected_slot_id: 'first-slot', preparation_fingerprint: fingerprint,
    layout_definition: layoutDefinition,
    scope_kind: 'verified_layout', pages: [{ source_key: binding.binding.job.sources[0].source_key, page: 1 }, { source_key: binding.binding.job.sources[0].source_key, page: 2 }],
    page_count: 2, source_count: 1, excluded_page_counts: {},
  }));
  return { create, legacyCreate, legacyPrepare, prepared, loaded, calibration, jobs };
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: vi.fn() } });
  const storage = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key), clear: () => storage.clear(),
  } });
  vi.spyOn(localEngineAdapter, 'health').mockResolvedValue({ status: 'ok', engine: 'test-engine', version: 'test' });
  vi.spyOn(localEngineAdapter, 'ocrHealth').mockResolvedValue({ status: 'ok', available: false, engine: 'paddleocr', readiness: 'unavailable', message: 'Core edition' });
  vi.spyOn(localEngineAdapter, 'pickPdfFiles').mockResolvedValue({ files: [sourceA], directory: '/docs' });
  vi.spyOn(localEngineAdapter, 'inspectPdf').mockImplementation(async (path) => ({ status: 'ok', page_count: 2, source_sha256: sourceHash(path) }));
  vi.spyOn(localEngineAdapter, 'renderPage').mockImplementation(async (_path, page, sha) => ({ status: 'ok', page,
    page_count: 2, page_width: 600, page_height: 900, source_sha256: sha, image_data: 'data:image/png;base64,AA==' }));
  vi.spyOn(localEngineAdapter, 'search').mockRejectedValue(new Error('Legacy search must not run'));
  vi.spyOn(localEngineAdapter, 'searchMulti').mockRejectedValue(new Error('Legacy multi-search must not run'));
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function upload(user: ReturnType<typeof userEvent.setup>, mode: 'search' | 'split_all' | null = 'search') {
  await waitFor(() => expect(screen.getByText(/本地引擎已连接/)).toBeTruthy());
  await user.click(screen.getByText('文件操作'));
  await user.click(screen.getByRole('button', { name: '选择 PDF' }));
  await screen.findByText('2 页 · 文档已读取');
  if (mode) await user.click(screen.getByRole('radio', { name: mode === 'search' ? '查找提取回单' : '分割全部回单' }));
}

function topbarWorkflow(): HTMLElement {
  const title = screen.getByRole('heading', { name: '银行回单工作台', level: 1 });
  const header = title.closest('header');
  if (!header) throw new Error('应用标题未位于顶部栏');
  return within(header).getByRole('navigation', { name: '回单处理步骤' });
}

describe('desktop receipt workflow entry routing', () => {
  const template: LayoutTemplate = {
    id: 'saved-template', version: 2, name: '华夏普通回单', source_scope: 'synthetic-bank-scope',
    page_geometry: pageGeometry, layout_fingerprint: fingerprint,
    slots: [{ slot_id: 'first-slot', position_index: 1, rect: candidateRect }],
    evidence_summary: { confirmed_slot_ids: ['first-slot'] }, source_operation_id: 'checked-operation',
    active: true, created_at: '2026-09-21T00:00:00Z', updated_at: '2026-09-21T00:00:00Z',
  };

  it('places the workflow stage beside the app title and keeps sidebar headings concise', () => {
    installClients();
    render(<App />);
    expect(topbarWorkflow().textContent).toContain('导入预览');
    const title = screen.getByRole('heading', { name: '银行回单工作台', level: 1 });
    const titleRow = title.closest('.brand-title-row');
    expect(titleRow).toBeTruthy();
    expect(within(titleRow as HTMLElement).getByRole('navigation', { name: '回单处理步骤' })).toBe(topbarWorkflow());
    const sources = screen.getByRole('complementary', { name: '当前文件' });
    expect(within(sources).getByRole('heading', { name: '文件操作', level: 2 })).toBeTruthy();
    expect(within(sources).queryByRole('navigation', { name: '回单处理步骤' })).toBeNull();
    const analysis = screen.getByRole('region', { name: /分析与分割|分割与分析/ });
    expect(within(analysis).queryByText('银行回单')).toBeNull();
  });

  it('defaults a newly added PDF to split-all without changing the explicit mode later', async () => {
    installClients();
    const user = userEvent.setup();
    render(<App />);
    await upload(user, null);
    expect((screen.getByRole('radio', { name: '分割全部回单' }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole('radio', { name: '查找提取回单' }));
    expect((screen.getByRole('radio', { name: '查找提取回单' }) as HTMLInputElement).checked).toBe(true);
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue({ files: [sourceB], directory: '/docs' });
    await user.click(screen.getByRole('button', { name: '添加 PDF' }));
    expect((screen.getByRole('radio', { name: '查找提取回单' }) as HTMLInputElement).checked).toBe(true);
  });

  it('opens templates instead of loading historical tasks and preserves the current sources on return', async () => {
    installClients();
    const list = vi.spyOn(LayoutTemplateClient.prototype, 'list').mockResolvedValue({ items: [], total: 0, next_offset: null });
    const user = userEvent.setup(); render(<App />); await upload(user);
    expect(screen.queryByRole('button', { name: '历史任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '当前任务' })).toBeNull();
    expect(BatchClient.prototype.list).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '我的模板' }));
    await screen.findByText('暂无可用版式模板');
    expect(list).toHaveBeenCalledWith({ active_only: true, offset: 0, limit: 10 }, expect.any(AbortSignal));
    await user.click(screen.getByRole('button', { name: '返回分析' }));
    expect(screen.getByText('2 页 · 文档已读取')).toBeTruthy();
    expect(screen.getByText('版式模板：自动匹配')).toBeTruthy();
  });

  it('freezes the manually selected template into analysis and resets old results when returning to automatic matching', async () => {
    const client = installClients();
    vi.spyOn(LayoutTemplateClient.prototype, 'list').mockResolvedValue({ items: [template], total: 1, next_offset: null });
    const user = userEvent.setup(); render(<App />); await upload(user);
    await user.click(screen.getByRole('button', { name: '我的模板' }));
    await user.click(await screen.findByRole('button', { name: '选用此模板' }));
    expect(screen.getByText('已选模板：华夏普通回单 · v2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    expect(client.create.mock.calls[0][0].layout_template_id).toBe(template.id);
    await user.click(screen.getByRole('button', { name: '返回分析' }));
    await user.click(screen.getByRole('button', { name: '改为自动匹配' }));
    expect(screen.queryByRole('button', { name: '查看任务结果' })).toBeNull();
    expect(screen.getByText('2 页 · 文档已读取')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    expect(client.create.mock.calls[1][0].layout_template_id).toBeUndefined();
  });

  it('updates the selected name and stops using a deactivated template without deleting PDF sources', async () => {
    installClients();
    const list = vi.spyOn(LayoutTemplateClient.prototype, 'list').mockResolvedValue({ items: [template], total: 1, next_offset: null });
    vi.spyOn(LayoutTemplateClient.prototype, 'rename').mockResolvedValue({ ...template, name: '核对后的华夏模板' });
    vi.spyOn(LayoutTemplateClient.prototype, 'deactivate').mockResolvedValue(true);
    const user = userEvent.setup(); render(<App />); await upload(user);
    await user.click(screen.getByRole('button', { name: '我的模板' }));
    await user.click(await screen.findByRole('button', { name: '选用此模板' }));
    await user.click(screen.getByRole('button', { name: '我的模板' }));
    const name = await screen.findByRole('textbox', { name: '模板名称' });
    await user.clear(name); await user.type(name, '核对后的华夏模板');
    list.mockResolvedValue({ items: [{ ...template, name: '核对后的华夏模板' }], total: 1, next_offset: null });
    await user.click(screen.getByRole('button', { name: '保存名称' }));
    await screen.findByText('模板名称已更新。');
    await user.click(screen.getByRole('button', { name: '返回分析' }));
    expect(screen.getByText('已选模板：核对后的华夏模板 · v2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '我的模板' }));
    await user.click(await screen.findByRole('button', { name: '停用此模板' }));
    await screen.findByText('版式模板：自动匹配');
    expect(screen.getByText('2 页 · 文档已读取')).toBeTruthy();
  });

  it('offers explicit template selection after ambiguity and analyses again with only that choice', async () => {
    const client = installClients();
    client.prepared.mockImplementation(async (job) => ({ ...prepare(job), templateChoiceIds: ['saved-template', 'second-template'] }));
    vi.spyOn(LayoutTemplateClient.prototype, 'list').mockResolvedValue({ items: [template, { ...template, id: 'second-template', name: '紧凑版' }], total: 2, next_offset: null });
    const user = userEvent.setup(); render(<App />); await upload(user);
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await user.click(await screen.findByRole('button', { name: '选择版式模板' }));
    await user.click(await screen.findByRole('button', { name: '选用此模板' }));
    expect(screen.getByText('已选模板：华夏普通回单 · v2')).toBeTruthy();
    expect(screen.getByText('2 页 · 文档已读取')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    expect(client.create.mock.calls[1][0].layout_template_id).toBe('saved-template');
  });

  it('returns from review templates without losing results and previews a template against the current review', async () => {
    const client = installClients(), user = userEvent.setup();
    const list = vi.spyOn(LayoutTemplateClient.prototype, 'list').mockResolvedValue({ items: [template], total: 1, next_offset: null });
    let finishPreview!: (value: ReceiptLayoutPreview) => void;
    const preview = vi.spyOn(ReceiptLayoutClient.prototype, 'templateApplyPreview')
      .mockReturnValue(new Promise((resolve) => { finishPreview = resolve; }));
    const cancel = vi.spyOn(ReceiptLayoutClient.prototype, 'cancel').mockResolvedValue();
    render(<App />); await upload(user);
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await user.click(await screen.findByRole('button', { name: '我的模板 · 预览应用' }));
    await screen.findByRole('button', { name: '预览应用到当前结果' });
    expect((screen.getByRole('button', { name: '返回审核' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '刷新列表' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '预览应用到当前结果' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('textbox', { name: '模板名称' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停用此模板' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '刷新列表' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: '预览应用到当前结果' });
    await user.click(screen.getByRole('button', { name: '返回审核' }));
    const overview = await screen.findByRole('region', { name: '回单检查总览' });
    expect(within(overview).getAllByRole('checkbox', { name: /^选择 第 \d+ 页 · 第 1 栏$/ })).toHaveLength(2);
    expect(client.loaded).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '我的模板 · 预览应用' }));
    await user.click(await screen.findByRole('button', { name: '预览应用到当前结果' }));
    await screen.findByRole('heading', { name: '正在生成模板应用预览' });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({
      prepared: expect.objectContaining({ result_revision: 'receipt-job-1-revision' }),
    }), template.id, expect.any(AbortSignal));
    expect(screen.queryByRole('button', { name: '我的模板 · 预览应用' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '我的模板 · 预览应用', hidden: true }));
    expect(screen.queryByRole('region', { name: '版式模板管理' })).toBeNull();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '选择 PDF' })).toBeNull();
    expect(client.create).toHaveBeenCalledTimes(1);
    const result: ReceiptLayoutPreview = {
      schema_version: 1, job_id: 'receipt-job-1', result_revision: 'receipt-job-1-revision',
      sample_id: 'receipt-job-1-1', operation_id: 'template-operation', preview_fingerprint: fingerprint,
      layout_definition: layoutDefinition, can_save: true, saved: false, page_count: 2, candidate_count: 2,
      affected: [1, 2].map((page) => ({ source_key: sourceA, page, slot_id: 'first-slot',
        previous_id: `receipt-job-1-${page}`, id: `updated-${page}`, before_rect: candidateRect,
        after_rect: { ...candidateRect, y0: 12 }, status: 'updated' })),
      risks: [], blockers: [], retained_record_ids: [], included_exception_ids: [],
      mode: 'template_apply', template_id: template.id, applied_slot_ids: ['first-slot'], template_allowed: false,
    };
    await act(async () => { finishPreview(result); });
    await screen.findByRole('heading', { name: '预览模板应用范围：2 处' });
    await user.click(screen.getByRole('button', { name: '取消应用' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    expect(cancel).toHaveBeenCalledWith(result);
    expect(client.calibration).not.toHaveBeenCalled();
    expect(client.loaded).toHaveBeenCalledTimes(1);
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it('keeps review template entry locked while an ordinary receipt confirmation is being saved', async () => {
    const client = installClients(), user = userEvent.setup();
    client.loaded.mockImplementation(async (binding) => originals(binding.binding.job).map((item) => ({
      ...item, original: { ...item.original, needs_review: true },
    })));
    let rejectSave!: (reason: Error) => void;
    vi.spyOn(ReceiptBatchClient.prototype, 'saveReview').mockReturnValue(new Promise((_resolve, reject) => { rejectSave = reject; }));
    render(<App />); await upload(user);
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    await user.click(screen.getByRole('checkbox', { name: '选择 第 1 页 · 第 1 栏' }));
    await user.click(screen.getByRole('button', { name: '确认所选 1 处' }));
    expect((screen.getByRole('button', { name: '我的模板 · 预览应用' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '我的模板 · 预览应用' }));
    expect(screen.queryByRole('region', { name: '版式模板管理' })).toBeNull();
    await act(async () => { rejectSave(new Error('test write failure')); });
    await waitFor(() => expect((screen.getByRole('button', { name: '我的模板 · 预览应用' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('keeps live page counts visible in one status while the keyword form is hidden and then enters results', async () => {
    const client = installClients(), user = userEvent.setup();
    vi.mocked(ReceiptBatchClient.prototype.start).mockImplementation(async ({ job_id }) => {
      const job = { ...client.jobs.get(job_id)!, state: 'running' as const,
        page_summary: { pending: 1, processing: 1, succeeded: 0, failed: 0 } };
      client.jobs.set(job_id, job);
      return ok(job);
    });
    render(<App />); await upload(user);
    expect(topbarWorkflow().textContent).toContain('导入预览');
    await user.type(screen.getByRole('textbox', { name: '包含关键词 1' }), '手续费');
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await screen.findByText('分析中 · 0/2 页');
    expect((screen.getByRole('button', { name: '我的模板' }) as HTMLButtonElement).disabled).toBe(true);
    expect(topbarWorkflow().textContent).toContain('分析处理');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '包含关键词 1' })).toBeNull();
    const job = client.jobs.get('receipt-job-1')!;
    client.jobs.set(job.id, { ...job, page_summary: { pending: 0, processing: 1, succeeded: 1, failed: 0 } });
    await screen.findByText('分析中 · 1/2 页');
    client.jobs.set(job.id, { ...job, state: 'ready_for_review', result_revision: 'done',
      page_summary: { pending: 0, processing: 0, succeeded: 2, failed: 0 } });
    await screen.findByRole('region', { name: '回单检查总览' });
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it.each(['button', 'Enter'] as const)('starts schema 2 through the ordinary keyword %s entry and automatically loads schema 3 review', async (entry) => {
    const client = installClients(), user = userEvent.setup(); render(<App />); await upload(user);
    const input = screen.getByRole('textbox', { name: '包含关键词 1' });
    await user.clear(input); await user.type(input, '手续费');
    if (entry === 'Enter') await user.type(input, '{Enter}');
    else await user.click(screen.getByRole('button', { name: '开始分析' }));
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    expect(client.create.mock.calls[0][0]).toMatchObject({ sources: [{ source_path: sourceA }],
      processing_options: { processing_mode: 'search', criteria: { include: ['手续费'] } }, match_mode: 'exact' });
    const navigator = await screen.findByRole('region', { name: '回单检查总览' });
    expect(within(navigator).getAllByRole('checkbox', { name: /^选择 第 \d+ 页 · 第 1 栏$/ })).toHaveLength(2);
    expect(client.loaded.mock.calls[0][0].context.version).toBe(3);
    expect(client.legacyCreate).not.toHaveBeenCalled(); expect(client.legacyPrepare).not.toHaveBeenCalled();
    expect(screen.queryByText('本次微调已完成')).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: '选择 第 1 页 · 第 1 栏' }));
    await user.click(screen.getByRole('button', { name: '调整所选边界' }));
    await waitFor(() => expect(client.calibration).toHaveBeenCalledTimes(1));
    expect(client.calibration.mock.calls[0][0].context.version).toBe(3);
  });

  it('exposes only one new-analysis action in keyword mode', async () => {
    installClients(); const user = userEvent.setup(); render(<App />); await upload(user);
    expect(screen.getByRole('button', { name: '开始分析' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '开始回单分析' })).toBeNull();
  });

  it('splits all receipts without requiring or submitting a keyword', async () => {
    const client = installClients(), user = userEvent.setup(); render(<App />); await upload(user);
    await user.click(screen.getByRole('radio', { name: '分割全部回单' }));
    await user.click(screen.getByRole('button', { name: '开始回单分析' }));
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    expect(client.create.mock.calls[0][0].processing_options).toEqual({ processing_mode: 'split_all', criteria: null });
    await screen.findByRole('region', { name: '回单检查总览' });
    expect(client.loaded.mock.calls[0][0].context.processing_options.processing_mode).toBe('split_all');
    expect(client.legacyCreate).not.toHaveBeenCalled();
  });

  it('starts a fresh analysis after changing processing mode while retaining the source preview and keyword draft', async () => {
    const client = installClients(), user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />); await upload(user);
    await user.clear(screen.getByRole('textbox', { name: '包含关键词 1' }));
    await user.type(screen.getByRole('textbox', { name: '包含关键词 1' }), '手续费');
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    await user.click(screen.getByRole('button', { name: '返回分析' }));

    await user.click(screen.getByRole('radio', { name: '分割全部回单' }));
    expect(screen.queryByRole('button', { name: '查看任务结果' })).toBeNull();
    expect(screen.queryByText('分析完成')).toBeNull();
    expect(screen.getByText('2 页 · 文档已读取')).toBeTruthy();
    await screen.findByRole('region', { name: '原页总览' });
    await user.click(screen.getByRole('button', { name: '开始回单分析' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(client.create.mock.calls[1][0]).toMatchObject({ sources: [{ source_path: sourceA }],
      processing_options: { processing_mode: 'split_all', criteria: null } });
    expect(client.jobs.get('receipt-job-1')?.state).toBe('ready_for_review');

    await user.click(screen.getByRole('button', { name: '返回分析' }));
    await user.click(screen.getByRole('radio', { name: '查找提取回单' }));
    expect(screen.getByRole('textbox', { name: '包含关键词 1' }).getAttribute('value')).toBe('手续费');
    expect(screen.queryByRole('button', { name: '查看任务结果' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    expect(client.create.mock.calls[2][0].processing_options).toMatchObject({
      processing_mode: 'search', criteria: { include: ['手续费'] },
    });
  });

  it.each(['search', 'split_all'] as const)('keeps export out of the %s workflow while any receipt needs review', async (mode) => {
    const client = installClients(), user = userEvent.setup();
    client.loaded.mockImplementation(async (binding) => originals(binding.binding.job).map((item, index) => ({
      ...item, original: { ...item.original, needs_review: index === 0 },
    })));
    const exportCreate = vi.spyOn(ExportBundleClient.prototype, 'create');
    render(<App />); await upload(user);
    if (mode === 'split_all') {
      await user.click(screen.getByRole('radio', { name: '分割全部回单' }));
      await user.click(screen.getByRole('button', { name: '开始回单分析' }));
    } else {
      await user.click(screen.getByRole('button', { name: '开始分析' }));
    }
    await screen.findByRole('region', { name: '回单检查总览' });
    expect(screen.queryByRole('button', { name: '导出回单' })).toBeNull();
    expect(screen.queryByRole('button', { name: '选择目录并导出' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '待复核 1' }));
    await user.click(screen.getByRole('checkbox', { name: '选择 第 1 页 · 第 1 栏' }));
    expect(screen.getByRole('button', { name: '确认所选 1 处' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '导出回单' })).toBeNull();
    expect(exportCreate).not.toHaveBeenCalled();
  });

  it('restores verified source metadata when analysis supersedes the initial PDF inspection', async () => {
    installClients(); const user = userEvent.setup();
    let finishInspection!: (value: Awaited<ReturnType<typeof localEngineAdapter.inspectPdf>>) => void;
    vi.mocked(localEngineAdapter.inspectPdf).mockReturnValueOnce(new Promise((resolve) => { finishInspection = resolve; }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/本地引擎已连接/)).toBeTruthy());
    await user.click(screen.getByText('文件操作'));
    await user.click(screen.getByRole('button', { name: '选择 PDF' }));
    await user.click(screen.getByRole('radio', { name: '查找提取回单' }));
    await user.clear(screen.getByRole('textbox', { name: '包含关键词 1' }));
    await user.type(screen.getByRole('textbox', { name: '包含关键词 1' }), '手续费');
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    await user.click(screen.getByRole('button', { name: '返回分析' }));

    await screen.findByText('2 页 · 文档已读取');
    await screen.findByRole('region', { name: '原页总览' });
    await user.click(screen.getByRole('radio', { name: '分割全部回单' }));
    const files = screen.getByRole('complementary', { name: '当前文件' });
    await user.click(within(files).getByRole('button', { name: /^huaxia.pdf/ }));
    await screen.findByRole('region', { name: '原页总览' });
    await act(async () => { finishInspection({ status: 'ok', page_count: 200, source_sha256: 'c'.repeat(64) }); });
    expect(screen.queryByText('200 页 · 文档已读取')).toBeNull();
    expect(screen.getByText('2 页 · 文档已读取')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '开始回单分析' }));
    await screen.findByRole('region', { name: '回单检查总览' });
  });

  it('keeps the current results and mode when the user cancels a processing mode change', async () => {
    const client = installClients(), user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<App />); await upload(user);
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    await user.click(screen.getByRole('button', { name: '返回分析' }));
    await user.click(screen.getByRole('radio', { name: '分割全部回单' }));
    expect((screen.getByRole('radio', { name: '查找提取回单' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('2 页 · 文档已读取')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '查看任务结果' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.loaded.mock.calls.at(-1)?.[0].binding.job.id).toBe('receipt-job-1');
  });

  it('replaces both the task binding and the visible review when a different source is analysed', async () => {
    const client = installClients(), user = userEvent.setup(); render(<App />); await upload(user);
    await user.type(screen.getByRole('textbox', { name: '包含关键词 1' }), '手续费');
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    await user.click(screen.getByRole('button', { name: '返回分析' }));
    await screen.findByRole('region', { name: '原页总览' });
    const files = screen.getByRole('complementary', { name: '当前文件' });
    fireEvent.click(within(files).getByRole('button', { name: '移除全部文件' }));
    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue({ files: [sourceB], directory: '/docs' });
    fireEvent.click(within(files).getByRole('button', { name: '选择 PDF' }));
    await screen.findByText('2 页 · 文档已读取');
    const input = screen.getByRole('textbox', { name: '包含关键词 1' });
    await user.clear(input); await user.type(input, 'KW-A');
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    const navigator = await screen.findByRole('region', { name: '回单检查总览' });
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(client.create.mock.calls[1][0]).toMatchObject({ sources: [{ source_path: sourceB }],
      processing_options: { processing_mode: 'search', criteria: { include: ['KW-A'] } } });
    expect(within(navigator).queryByText('huaxia.pdf')).toBeNull();
    expect(within(within(navigator).getByRole('region', { name: '片段查看与微调' })).getAllByText('baosheng.pdf')).toHaveLength(2);
    expect(client.loaded.mock.calls.at(-1)?.[0].binding.job.id).toBe('receipt-job-2');
  });

  it('removes current sources directly after export and starts a fresh source without deleting the previous task', async () => {
    const client = installClients(), user = userEvent.setup();
    const configuredOutputDirectory = '/configured/output';
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_APP_SETTINGS,
      lastOutputDirectory: configuredOutputDirectory }));
    const summary = { total_segments: 2, selected_count: 2, selected_source_count: 1,
      omitted_count: 0, omitted_unresolved_count: 0, expected_pages: 2 };
    vi.spyOn(ExportBundleClient.prototype, 'create').mockImplementation(async (request) => ({
      ...request, intent_id: 'export-intent', state: 'rendered', source_fingerprint: fingerprint,
      review_revision: fingerprint, summary, merged_pages: 2, source_pages: 0, total_pages: 2,
      files: [{ file_id: 'merged', name: 'result.pdf', source_key: null, page_count: 2,
        preview_token: 'preview-token', preview_path: '/preview.pdf', sha256: fingerprint, size_bytes: 1024 }],
    }));
    const pickOutputFolder = vi.spyOn(localEngineAdapter, 'pickOutputFolder').mockResolvedValue('/exports');
    vi.spyOn(ExportBundleClient.prototype, 'publish').mockResolvedValue({
      intent_id: 'export-intent', state: 'published', directory: '/exports', summary,
      merged_pages: 2, source_pages: 0, total_pages: 2, row_count: 2,
      files: [{ name: 'result.pdf', path: '/exports/result.pdf', kind: 'pdf', sha256: fingerprint, size_bytes: 1024, page_count: 2 }],
    });
    const close = vi.spyOn(ExportBundleClient.prototype, 'close').mockResolvedValue();
    render(<App />); await upload(user);
    await user.type(screen.getByRole('textbox', { name: '包含关键词 1' }), '手续费');
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    await screen.findByRole('region', { name: '回单检查总览' });
    expect(topbarWorkflow().textContent).toContain('分析处理');
    await user.click(screen.getByRole('button', { name: '导出回单' }));
    await screen.findByRole('heading', { name: '导出设置' });
    expect(topbarWorkflow().textContent).toContain('导出结果');
    await user.click(screen.getByRole('button', { name: '选择目录并导出' }));
    await screen.findByText('已生成 1 个文件，共 2 页。');
    expect(pickOutputFolder).toHaveBeenCalledWith(configuredOutputDirectory);
    expect(JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}').lastOutputDirectory).toBe('/exports');
    await user.click(screen.getByRole('button', { name: '移除本次来源' }));

    await screen.findByText('0 份 PDF · 未添加');
    expect(topbarWorkflow().textContent).toContain('导入预览');
    expect(screen.queryByRole('heading', { name: '最终导出预览' })).toBeNull();
    expect(screen.queryByRole('region', { name: '回单检查总览' })).toBeNull();
    const files = screen.getByRole('complementary', { name: '当前文件' });
    expect(within(files).queryByText('huaxia.pdf')).toBeNull();
    expect(client.jobs.get('receipt-job-1')?.state).toBe('ready_for_review');
    await waitFor(() => expect(close).toHaveBeenCalledWith('export-intent'));

    vi.mocked(localEngineAdapter.pickPdfFiles).mockResolvedValue({ files: [sourceB], directory: '/docs' });
    await user.click(within(files).getByRole('button', { name: '选择 PDF' }));
    await screen.findByText('2 页 · 文档已读取');
    const input = screen.getByRole('textbox', { name: '包含关键词 1' });
    await user.clear(input); await user.type(input, 'KW-A');
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    const navigator = await screen.findByRole('region', { name: '回单检查总览' });
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(client.create.mock.calls[1][0]).toMatchObject({ sources: [{ source_path: sourceB }],
      processing_options: { criteria: { include: ['KW-A'] } } });
    expect(within(navigator).queryByText('huaxia.pdf')).toBeNull();
    expect(within(within(navigator).getByRole('region', { name: '片段查看与微调' })).getAllByText('baosheng.pdf')).toHaveLength(2);
    expect(client.jobs.has('receipt-job-1')).toBe(true);
  });
});
