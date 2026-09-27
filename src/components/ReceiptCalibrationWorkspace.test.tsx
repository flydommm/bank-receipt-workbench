// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode, useSyncExternalStore } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReceiptCalibrationNavigator, ReceiptCalibrationPane, ReceiptSourcePage } from './ReceiptCalibrationWorkspace';
import { localEngineAdapter, type EnginePagePreview } from './localEngineAdapter';
import { ReceiptCalibrationController, type ReceiptCalibrationState, type ReceiptReviewSession } from '../services/receiptCalibrationController';
import type { ReceiptLayoutClient, ReceiptLayoutPreparation, ReceiptLayoutPreview } from '../services/receiptLayoutClient';
import type { LayoutDefinition } from '../domain/receiptLayout';
import { LayoutTemplateClient, layoutDefinitionSlots, type LayoutTemplate } from '../services/layoutTemplateClient';

const sha = 'a'.repeat(64), rect = { x0: 0, y0: 300, x1: 600, y1: 590 };
const image = (page: number): EnginePagePreview => ({ status: 'ok', page, page_count: 60, source_sha256: sha,
  page_width: 600, page_height: 900, image_data: `data:image/png;base64,page${page}` });
const pageProps = { path: '/test.pdf', sha, pageCount: 60, width: 600, height: 900, rect, onChange: vi.fn() };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
function state(): ReceiptCalibrationState {
  const session = { prepared: { binding: { job: { sources: [{ source_key: '/test.pdf', access_path: '/test.pdf', name: '合成回单.pdf', sha256: sha, page_count: 60 }] } } },
    items: Array.from({ length: 51 }, (_, i) => ({ original: { id: `id-${i}`, source_key: '/test.pdf', source_page: i + 1, slot_id: 's1', position_index: 2,
      candidate_rect: rect, page_geometry: { width_pt: 600, height_pt: 900 }, needs_review: false }, record: null })) } as unknown as ReceiptReviewSession;
  return { phase: 'results', session, selectedId: 'id-0', selectedSlotId: null, draft: null, preparation: null, preview: null, previewIndex: 0,
    operation: null, writeAction: null, error: null, acknowledgedRiskIds: [], includeExceptionIds: [], rememberReference: false, templateName: '3栏回单模板',
    templateSaveMode: 'create', templateId: null, templateBankName: '', templateCandidates: [], templateCandidatesStatus: 'idle', templateCandidatesError: null,
    reviewFilter: 'all', reviewConfirming: false, reviewNotice: null };
}
function controller() { return new ReceiptCalibrationController({} as ReceiptLayoutClient, vi.fn()); }
function liveEditorLayout(identityless = false) {
  const pt = (value: number) => value * 72 / 25.4;
  const layout: LayoutDefinition = { schema_version: 1, layout_id: 'three', revision: 1, workspace_id: 'test',
    issuer_id: identityless ? null : 'test-bank', family_id: identityless ? null : 'test-family', evidence_version: 'test', uniform_height: false, left_pt: 0, right_pt: 0,
    page_geometry: { pdf_box: { x0: 0, y0: 0, x1: 600, y1: pt(297.04) }, rotation: 0, user_unit: 1, width_pt: 600, height_pt: pt(297.04) },
    slots: [0, 1, 2].map((i) => ({ slot_id: `s${i}`, position_index: i + 1, top_pt: pt([0, 100.01, 201.44][i]), height_pt: pt([96.49, 101.42, 95.25][i]) })) };
  return layout;
}
function liveEditor(protectedScope = false, identityless = false) {
  const pt = (value: number) => value * 72 / 25.4;
  const layout = liveEditorLayout(identityless);
  const session = state().session!;
  session.prepared.prepared = { result_revision: 'r', context_key: sha } as typeof session.prepared.prepared;
  session.prepared.binding.job.id = 'job';
  session.items.forEach((item) => { item.original.page_geometry = layout.page_geometry; });
  const preparation: ReceiptLayoutPreparation = { schema_version: 1, job_id: 'job', result_revision: 'r', sample_id: 'id-0', context_key: sha,
    selected_slot_id: 's0', preparation_fingerprint: sha, layout_definition: layout, scope_kind: 'current_pdf',
    // Includes page 60, which has no keyword hits; excludes the hit on page 51.
    pages: [...Array.from({ length: 50 }, (_, i) => ({ source_key: '/test.pdf', page: i + 1 })), { source_key: '/test.pdf', page: 60 }],
    page_count: 51, source_count: 1, excluded_page_counts: { unverified_layout: 7, different_document_type: 2 } };
  if (protectedScope) {
    Object.assign(preparation, { page_count: 1, pages: [preparation.pages[0]], editable_slot_ids: ['s0'], template_allowed: false });
    session.items[0].original.slot_id = 's0';
  }
  const client = { prepare: vi.fn().mockResolvedValue(preparation), preview: vi.fn().mockReturnValue(new Promise(() => undefined)) };
  const service = new ReceiptCalibrationController(client as unknown as ReceiptLayoutClient, vi.fn());
  service.bind(session);
  vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue({ ...image(1), page_height: layout.page_geometry.height_pt });
  function LivePane() {
    const current = useSyncExternalStore(service.subscribe, service.getSnapshot);
    return <ReceiptCalibrationPane state={current} controller={service} onBack={vi.fn()} onExport={vi.fn()} />;
  }
  render(<LivePane />);
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 第 1 页 · 第 2 栏' }));
  return { service, client, pt };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('source-bound calibration PDF view', () => {
  it('previews a template against the current results without offering edit or template-save actions', () => {
    const view = state(), service = controller();
    const layout = liveEditorLayout();
    view.phase = 'preview';
    view.preview = { schema_version: 1, job_id: 'job', result_revision: 'r', sample_id: 'id-0', operation_id: 'op',
      preview_fingerprint: sha, layout_definition: layout, can_save: true, saved: false, mode: 'template_apply',
      template_id: 'template-1', applied_slot_ids: ['s0'], excluded_page_counts: { manual_classification_scope: 1 },
      preserved_excluded_count: 1,
      page_count: 1, candidate_count: 1,
      affected: [{ source_key: '/test.pdf', page: 1, slot_id: 's0', id: 'id-0', previous_id: 'id-0',
        before_rect: rect, after_rect: rect, status: 'updated' }], risks: [], blockers: [],
      retained_record_ids: [], included_exception_ids: [], template_allowed: false } as ReceiptLayoutPreview;
    vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(image(1));
    const save = vi.spyOn(service, 'save').mockResolvedValue();
    render(<ReceiptCalibrationPane state={view} controller={service} onExport={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '预览模板应用范围：1 处' })).toBeTruthy();
    expect(screen.getByText(/可应用 1 页，保留 1 处已排除片段；另有 1 页未应用/)).toBeTruthy();
    expect(screen.getByText(/仅替换模板中已核对的第 1 栏边界/)).toBeTruthy();
    expect(screen.getByText('人工分类页面单独调整，与批量范围隔离：1 页未应用模板。')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: '保存为版式模板' })).toBeNull();
    expect(screen.queryByRole('button', { name: '返回调整' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '应用模板并复核 1 处' }));
    expect(save).toHaveBeenCalledOnce();
  });
  it('uses the protected single-slot editor, static preview and disables reusable template saving', async () => {
    const { service, client } = liveEditor(true);
    fireEvent.click(screen.getByRole('button', { name: '调整所选边界' }));
    await screen.findByRole('navigation', { name: '回单栏位' });
    await screen.findByRole('img', { name: '原始 PDF 第 1 页' });
    expect(screen.getByRole('heading', { name: '所选片段微调' })).toBeTruthy();
    expect(screen.getByText('本轮版式范围：1 份 PDF · 1 页 · 现有命中 1 处')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '裁剪区域' })).toBeNull();
    expect(screen.getByRole('button', { name: '选择第 2 栏边界' })).toHaveProperty('disabled', true);
    client.preview.mockResolvedValueOnce({
      schema_version: 1, job_id: 'job', result_revision: 'r', sample_id: 'id-0', operation_id: 'op',
      preview_fingerprint: sha, layout_definition: service.getSnapshot().draft!, can_save: true, saved: false,
      page_count: 1, candidate_count: 1, affected: [{ source_key: '/test.pdf', page: 1, slot_id: 's0', id: 'id-0', previous_id: 'id-0',
        before_rect: rect, after_rect: rect, status: 'updated' }], risks: [], blockers: [], retained_record_ids: [], included_exception_ids: [], template_allowed: false,
    });
    fireEvent.click(screen.getByRole('button', { name: '确认并预览本轮' }));
    const template = await screen.findByRole('checkbox', { name: /保存为版式模板/ });
    expect(template).toHaveProperty('disabled', true);
    expect(screen.getByText(/暂不保存为复用模板/)).toBeTruthy();
  });
  it('fits all three slots into the measured editing viewport, follows resize and restores fit after manual zoom', async () => {
    let resize: () => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(image(1));
    const view = render(<ReceiptSourcePage {...pageProps} page={1} editable selectedSlotId="s0" />);
    const viewport = view.container.querySelector('.receipt-source-page__scroll') as HTMLElement;
    let viewportHeight = 500;
    Object.defineProperties(viewport, { clientWidth: { get: () => 1000 }, clientHeight: { get: () => viewportHeight } });
    viewport.style.padding = '20px';
    act(() => resize());
    await screen.findByRole('region', { name: '裁剪区域' });
    const sheet = view.container.querySelector('.receipt-source-page__sheet') as HTMLElement;
    expect(parseFloat(sheet.style.width)).toBeCloseTo(460 * 600 / 900);
    expect(parseFloat(sheet.style.width) * 900 / 600).toBeLessThanOrEqual(460);
    expect(screen.getByRole('button', { name: '整页' }).getAttribute('aria-pressed')).toBe('true');
    viewportHeight = 440;
    act(() => resize());
    expect(parseFloat(sheet.style.width)).toBeCloseTo(400 * 600 / 900);
    fireEvent.click(screen.getByRole('button', { name: '放大回单预览' }));
    expect(sheet.style.width).toBe('53%');
    expect(screen.getByRole('button', { name: '整页' }).getAttribute('aria-pressed')).toBe('false');
    viewportHeight = 800;
    act(() => resize());
    expect(sheet.style.width).toBe('53%');
    fireEvent.click(screen.getByRole('button', { name: '缩小回单预览' }));
    expect(sheet.style.width).toBe('28%');
    fireEvent.click(screen.getByRole('button', { name: '整页' }));
    expect(parseFloat(sheet.style.width)).toBeCloseTo(760 * 600 / 900);
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
  it('brings a newly selected slot into a manually zoomed viewport without scrolling on every drag update', async () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(image(1));
    const view = render(<ReceiptSourcePage {...pageProps} page={1} editable selectedSlotId="s0" />);
    await screen.findByRole('region', { name: '裁剪区域' });
    const viewport = view.container.querySelector('.receipt-source-page__scroll') as HTMLElement;
    let targetTop = 30;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isCrop = this.classList.contains('crop-box');
      return { top: isCrop ? targetTop : 0, bottom: isCrop ? targetTop + 300 : 400,
        left: 0, right: isCrop ? 400 : 1000, width: isCrop ? 400 : 1000, height: isCrop ? 300 : 400,
        x: 0, y: isCrop ? targetTop : 0, toJSON: () => ({}) };
    });
    fireEvent.click(screen.getByRole('button', { name: '放大回单预览' }));
    viewport.scrollTop = 0;
    targetTop = 500;
    view.rerender(<ReceiptSourcePage {...pageProps} page={1} editable selectedSlotId="s2" rect={{ ...rect, y0: 600, y1: 890 }} />);
    expect(viewport.scrollTop).toBe(416);
    viewport.scrollTop = 0;
    view.rerender(<ReceiptSourcePage {...pageProps} page={1} editable selectedSlotId="s2" rect={{ ...rect, y0: 601, y1: 891 }} />);
    expect(viewport.scrollTop).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '整页' }));
    expect(viewport.scrollTop).toBe(0);
  });
  it('enters fit mode from results and keeps the page visible before a container can be measured', async () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(image(1));
    const view = render(<ReceiptSourcePage {...pageProps} page={1} />);
    await screen.findByRole('img');
    expect(screen.getByRole('button', { name: '整页' }).getAttribute('aria-pressed')).toBe('false');
    view.rerender(<ReceiptSourcePage {...pageProps} page={1} editable selectedSlotId="s0" />);
    expect(screen.getByRole('button', { name: '整页' }).getAttribute('aria-pressed')).toBe('true');
    expect((view.container.querySelector('.receipt-source-page__sheet') as HTMLElement).style.width).toBe('100%');
    expect(screen.getByRole('region', { name: '裁剪区域' })).toBeTruthy();
  });
  it('never displays an earlier page image while loading the new page', async () => {
    const first = deferred<EnginePagePreview>(), second = deferred<EnginePagePreview>();
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<ReceiptSourcePage {...pageProps} page={1} />);
    view.rerender(<ReceiptSourcePage {...pageProps} page={2} />);
    await act(async () => first.resolve(image(1)));
    expect(screen.queryByRole('img')).toBeNull();
    await act(async () => second.resolve(image(2)));
    expect(screen.getByRole('img', { name: '原始 PDF 第 2 页' }).getAttribute('src')).toContain('page2');
    view.rerender(<ReceiptSourcePage {...pageProps} page={3} />);
    expect(screen.queryByRole('img')).toBeNull();
  });
  it('reuses a running page when navigation returns before it completes', async () => {
    const first = deferred<EnginePagePreview>();
    const renderPage = vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(first.promise);
    const view = render(<ReceiptSourcePage {...pageProps} page={1} />);
    view.rerender(<ReceiptSourcePage {...pageProps} page={2} />);
    view.rerender(<ReceiptSourcePage {...pageProps} page={1} />);
    expect(renderPage).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(image(1)));
    expect(screen.getByRole('img', { name: '原始 PDF 第 1 页' })).toBeTruthy();
    expect(renderPage).toHaveBeenCalledTimes(1);
  });
  it('renders only the latest queued page and reuses the completed page after rapid navigation', async () => {
    const first = deferred<EnginePagePreview>(), last = deferred<EnginePagePreview>();
    const renderPage = vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const view = render(<ReceiptSourcePage {...pageProps} page={1} />);
    view.rerender(<ReceiptSourcePage {...pageProps} page={2} />);
    view.rerender(<ReceiptSourcePage {...pageProps} page={3} />);
    view.rerender(<ReceiptSourcePage {...pageProps} page={4} />);
    expect(renderPage.mock.calls.map((call) => call[1])).toEqual([1]);
    await act(async () => first.resolve(image(1)));
    expect(renderPage.mock.calls.map((call) => call[1])).toEqual([1, 4]);
    expect(screen.queryByRole('img')).toBeNull();
    await act(async () => last.resolve(image(4)));
    expect(screen.getByRole('img', { name: '原始 PDF 第 4 页' })).toBeTruthy();
    view.rerender(<ReceiptSourcePage {...pageProps} page={1} />);
    await screen.findByRole('img', { name: '原始 PDF 第 1 页' });
    expect(renderPage).toHaveBeenCalledTimes(2);
  });
  it('keeps a newly selected source hidden until its own page arrives', async () => {
    const first = deferred<EnginePagePreview>(), second = deferred<EnginePagePreview>();
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<ReceiptSourcePage {...pageProps} page={1} />);
    const nextSha = 'b'.repeat(64);
    view.rerender(<ReceiptSourcePage {...pageProps} path="/second.pdf" sha={nextSha} page={1} />);
    await act(async () => first.resolve(image(1)));
    expect(screen.queryByRole('img')).toBeNull();
    await act(async () => second.resolve({ ...image(1), source_sha256: nextSha, image_data: 'data:image/png;base64,second' }));
    expect(screen.getByRole('img').getAttribute('src')).toContain('second');
  });
  it('clears the page cache across unmount and survives strict effect remounting', async () => {
    const renderPage = vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(image(1));
    const view = render(<StrictMode><ReceiptSourcePage {...pageProps} page={1} /></StrictMode>);
    await screen.findByRole('img');
    const calls = renderPage.mock.calls.length;
    view.unmount();
    render(<ReceiptSourcePage {...pageProps} page={1} />);
    await screen.findByRole('img');
    expect(renderPage).toHaveBeenCalledTimes(calls + 1);
  });
  it.each(['sha', 'dimensions', 'page'])('rejects a mismatched %s preview before drawing a crop', async (reason) => {
    const value = image(1);
    if (reason === 'sha') value.source_sha256 = 'b'.repeat(64);
    if (reason === 'dimensions') value.page_height = 800;
    if (reason === 'page') value.page = 2;
    vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(value);
    render(<ReceiptSourcePage {...pageProps} page={1} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('页面尺寸或来源已变化'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByLabelText('本轮边界')).toBeNull();
  });
});

describe('step-based calibration workspace', () => {
  it('requires explicit target selection for updates and exposes failed candidate loading for retry', async () => {
    const list = vi.spyOn(LayoutTemplateClient.prototype, 'list').mockRejectedValueOnce(new Error('模板库暂时不可用'));
    const { service, client } = liveEditor();
    fireEvent.click(screen.getByRole('button', { name: '调整所选边界' }));
    await screen.findByRole('navigation', { name: '回单栏位' });
    const layout = service.getSnapshot().draft!;
    const template = { id: 'existing', name: '本行第二套', version: 2, bank_name: '示例银行', active: true,
      page_geometry: layout.page_geometry, slots: layoutDefinitionSlots(layout), evidence_summary: { layout_definition: layout },
      source_scope: 'scope', layout_fingerprint: sha, source_operation_id: 'previous',
      created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z' } satisfies LayoutTemplate;
    list.mockResolvedValueOnce({ items: [template], total: 1, next_offset: null });
    client.preview.mockResolvedValueOnce({ schema_version: 1, job_id: 'job', result_revision: 'r', sample_id: 'id-0', operation_id: 'op',
      preview_fingerprint: sha, layout_definition: layout, can_save: true,
      affected: [{ source_key: '/test.pdf', page: 1, slot_id: 's0', id: 'id-0', previous_id: 'id-0', before_rect: rect, after_rect: rect, status: 'updated' }],
      risks: [], blockers: [], retained_record_ids: [], included_exception_ids: [], candidate_count: 1, page_count: 51, saved: false });
    fireEvent.click(screen.getByRole('button', { name: '确认并预览本轮' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: '保存为版式模板' }));
    expect(screen.getByRole('radio', { name: '新建一套模板' })).toHaveProperty('checked', true);
    expect(screen.getByText('（保留同银行已有模板）').closest('label')?.contains(screen.getByRole('radio', { name: '新建一套模板' }))).toBe(true);
    expect(screen.getByText('（用于查找；是否适用仍以版式为准）').closest('label')?.contains(screen.getByLabelText('银行名称（选填）'))).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '更新已有模板' }));
    expect(screen.getByText('（只改所选模板的本轮栏位，其他栏位和模板保留）').closest('label')?.contains(screen.getByRole('radio', { name: '更新已有模板' }))).toBe(true);
    await screen.findByText('模板库暂时不可用');
    expect(screen.getByRole('radio', { name: '更新已有模板' })).toHaveProperty('checked', true);
    expect(screen.getByRole('button', { name: '保存本轮 1 处' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '重试载入兼容模板' }));
    const select = await screen.findByRole('combobox', { name: '要更新的模板' });
    expect(select).toHaveProperty('value', '');
    fireEvent.change(select, { target: { value: 'existing' } });
    expect(screen.getByLabelText('银行名称（选填）')).toHaveProperty('value', '示例银行');
    expect(screen.getByRole('button', { name: '保存本轮 1 处' })).toHaveProperty('disabled', false);
    expect(service.getSnapshot()).toMatchObject({ templateSaveMode: 'update', templateId: 'existing' });
  });
  it('opts out of templates by default and requires a name after opting in', async () => {
    const { service, client } = liveEditor();
    fireEvent.click(screen.getByRole('button', { name: '调整所选边界' }));
    await screen.findByRole('navigation', { name: '回单栏位' });
    const layout = service.getSnapshot().draft!;
    client.preview.mockResolvedValueOnce({ schema_version: 1, job_id: 'job', result_revision: 'r', sample_id: 'id-0', operation_id: 'op',
      preview_fingerprint: sha, layout_definition: layout, can_save: true,
      affected: [{ source_key: '/test.pdf', page: 1, slot_id: 's0', id: 'id-0', previous_id: 'id-0', before_rect: rect, after_rect: rect, status: 'updated' }],
      risks: [], blockers: [], retained_record_ids: [], included_exception_ids: [], candidate_count: 1, page_count: 51, saved: false });
    fireEvent.click(screen.getByRole('button', { name: '确认并预览本轮' }));
    const remember = await screen.findByRole('checkbox', { name: '保存为版式模板' }) as HTMLInputElement;
    expect(screen.getByRole('heading', { name: '检查本轮片段变化：1 处' })).toBeTruthy();
    expect(screen.getByText(/本轮可写入 1\/3 栏（第 1 栏）。第 2、3 栏尚未核对/)).toBeTruthy();
    expect(screen.getByText(/同银行、同凭证类型、同版式的多栏可共用一套模板/)).toBeTruthy();
    expect(remember.checked).toBe(false);
    expect(screen.queryByLabelText('模板名称')).toBeNull();
    fireEvent.click(remember);
    const name = screen.getByLabelText('模板名称') as HTMLInputElement;
    expect(name.value).toBe('3栏回单模板');
    fireEvent.change(name, { target: { value: ' ' } });
    expect((screen.getByRole('button', { name: '保存本轮 1 处' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: '我的版式' } });
    expect(service.getSnapshot().templateName).toBe('我的版式');
    expect((screen.getByRole('button', { name: '保存本轮 1 处' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(remember);
    expect(screen.queryByLabelText('模板名称')).toBeNull();
  });
  it('blocks template memory for an identity-ineligible round without blocking the round save', async () => {
    const { service, client } = liveEditor(false, true);
    fireEvent.click(screen.getByRole('button', { name: '调整所选边界' }));
    await screen.findByRole('navigation', { name: '回单栏位' });
    const layout = service.getSnapshot().draft!;
    client.preview.mockResolvedValueOnce({ schema_version: 1, job_id: 'job', result_revision: 'r', sample_id: 'id-0', operation_id: 'op',
      preview_fingerprint: sha, layout_definition: layout, can_save: true,
      affected: [{ source_key: '/test.pdf', page: 1, slot_id: 's0', id: 'id-0', previous_id: 'id-0', before_rect: rect, after_rect: rect, status: 'updated' }],
      risks: [], blockers: [], retained_record_ids: [], included_exception_ids: [], candidate_count: 1, page_count: 51, saved: false,
    });
    fireEvent.click(screen.getByRole('button', { name: '确认并预览本轮' }));
    const template = await screen.findByRole('checkbox', { name: '保存为版式模板' });
    expect(template).toHaveProperty('disabled', true);
    expect(screen.getByText('尚未识别此回单的复用版式，可先保存本次调整。')).toBeTruthy();
    const save = vi.spyOn(service, 'save').mockResolvedValue();
    const saveButton = screen.getByRole('button', { name: '保存本轮 1 处' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    expect(save).toHaveBeenCalledOnce();
  });

  it.each(['saved', 'failed', 'disabled'] as const)('shows the explicit template outcome %s', (referenceState) => {
    const view = state(), service = controller();
    view.phase = 'saved'; view.writeAction = 'save'; view.rememberReference = true;
    view.operation = { schema_version: 1, operation_id: 'op', job_id: 'job', result_revision: 'r', state: 'applied', saved_count: 1, reference_state: referenceState };
    const retry = vi.spyOn(service, 'retryTemplateSave').mockResolvedValue();
    render(<ReceiptCalibrationPane state={view} controller={service} onExport={vi.fn()} onBack={vi.fn()} />);
    if (referenceState === 'saved') expect(screen.getByText(/版式模板“3栏回单模板”已保存/)).toBeTruthy();
    else if (referenceState === 'disabled') expect(screen.getByText('本轮未保存为版式模板。')).toBeTruthy();
    else {
      expect(screen.getByRole('alert').textContent).toContain('本轮审核已保存');
      fireEvent.click(screen.getByRole('button', { name: '重试保存模板' }));
      expect(retry).toHaveBeenCalledOnce();
    }
  });
  it('shows the saved template identity returned by the server', () => {
    const view = state(); view.phase = 'saved'; view.writeAction = 'save'; view.rememberReference = true;
    view.operation = { schema_version: 1, operation_id: 'op', job_id: 'job', result_revision: 'r', state: 'applied',
      saved_count: 1, reference_state: 'saved', template_id: 'saved-version', template_name: '已保存的独立模板', template_version: 4 };
    render(<ReceiptCalibrationPane state={view} controller={controller()} onExport={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText(/版式模板“已保存的独立模板”已保存（版本 4）/)).toBeTruthy();
    expect(screen.queryByText(/版式模板“3栏回单模板”已保存/)).toBeNull();
  });
  it.each([
    ['shared_geometry_changed', '左右边距', false],
    ['template_geometry_conflict', '重叠或超出页面', false],
    ['operation_inactive', '停用、更新或撤销', false],
    ['invalid_reference', '校验未通过', false],
    ['storage_unavailable', '暂时无法写入', true],
    ['template_unavailable', '所选模板已停用或不可用', false],
    ['template_conflict', '所选模板已更新', false],
    ['template_incompatible', '与本轮版式不兼容', false],
    ['operation_conflict', '其他保存方式或目标模板', false],
  ] as const)('explains %s and offers retry only when it can help', (code, explanation, retryable) => {
    const view = state(), service = controller();
    view.phase = 'saved'; view.writeAction = 'save'; view.rememberReference = true;
    view.operation = { schema_version: 1, operation_id: 'op', job_id: 'job', result_revision: 'r', state: 'applied',
      saved_count: 1, reference_state: 'failed', reference_error_code: code };
    render(<ReceiptCalibrationPane state={view} controller={service} onExport={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('本轮审核已保存');
    expect(screen.getByRole('alert').textContent).toContain(explanation);
    expect(Boolean(screen.queryByRole('button', { name: '重试保存模板' }))).toBe(retryable);
  });
  it('filters special types and opens a specific candidate for independent adjustment', async () => {
    const view = state(), service = controller();
    const items = view.session!.items;
    items[1].page_notice = { code: 'special_document', document_type: 'loan_interest_notice' };
    items[2].page_notice = { code: 'special_document', document_type: 'electronic_tax_payment' };
    items[3].page_notice = { code: 'special_document', document_type: 'electronic_tax_payment' };
    items[3].original.source_page = items[2].original.source_page;
    items[3].original.position_index = 3;
    items[1].original.needs_review = true;
    service.bind(view.session);
    vi.spyOn(localEngineAdapter, 'renderPage').mockImplementation(async (_path, page) => image(page));
    const begin = vi.spyOn(service, 'begin').mockResolvedValue();
    function LiveWorkspace() {
      const current = useSyncExternalStore(service.subscribe, service.getSnapshot);
      return <ReceiptCalibrationPane state={current} controller={service} onBack={vi.fn()} onExport={vi.fn()} />;
    }
    render(<LiveWorkspace />);
    fireEvent.change(screen.getByLabelText('凭证类型'), { target: { value: 'loan_interest_notice' } });
    const list = screen.getByRole('region', { name: '片段查看与微调' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(within(list).getByRole('button', { name: '打开 第 2 页 · 第 2 栏' }));
    expect(service.getSnapshot().selectedId).toBe('id-1');
    fireEvent.click(screen.getByRole('button', { name: '调整所选边界' }));
    expect(begin).toHaveBeenCalledTimes(1);
    await screen.findByRole('img', { name: '原始 PDF 第 2 页' });
    fireEvent.click(screen.getByRole('button', { name: '返回总览' }));
    fireEvent.change(screen.getByLabelText('凭证类型'), { target: { value: 'electronic_tax_payment' } });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(2);
    fireEvent.click(within(list).getByRole('button', { name: '打开 第 3 页 · 第 3 栏' }));
    expect(service.getSnapshot().selectedId).toBe('id-3');
  });
  it.each([true, false])('wires batch risk acknowledgements to the current round and preserves can_save=%s', async (canSave) => {
    const { service, client } = liveEditor();
    fireEvent.click(screen.getByRole('button', { name: '调整所选边界' }));
    await screen.findByRole('navigation', { name: '回单栏位' });
    expect(screen.getByRole('separator', { name: '调整操作区高度' })).toBeTruthy();
    expect(screen.getByText('单证类型不同，需分别调整：2 页未纳入')).toBeTruthy();
    const layout = service.getSnapshot().draft!;
    client.preview.mockResolvedValueOnce({
      schema_version: 1, job_id: 'job', result_revision: 'r', sample_id: 'id-0', operation_id: 'op',
      preview_fingerprint: sha, layout_definition: layout, can_save: canSave,
      affected: [{ source_key: '/test.pdf', page: 1, slot_id: 's0', id: 'id-0', previous_id: 'id-0',
        before_rect: rect, after_rect: rect, status: 'updated' }],
      risks: [1, 2].map((page) => ({ risk_id: `risk-${page}`, source_key: '/test.pdf', page,
        diagnostic: { code: 'content_outside_slot', slot_id: 's0' } })),
      blockers: canSave ? [] : [{ code: 'unassigned_block' }, { code: 'special_document', document_type: 'loan_interest_notice' }],
      retained_record_ids: [], included_exception_ids: [], candidate_count: 1, page_count: 51, saved: false,
    });
    fireEvent.click(screen.getByRole('button', { name: '确认并预览本轮' }));
    const all = await screen.findByRole('checkbox', { name: '全部标为已核对' });
    expect(document.querySelector('.receipt-risk-review__explanation')?.textContent).toContain('本轮变化 1 处（含移出项）');
    expect(document.querySelector('.receipt-risk-review__explanation')?.textContent).toContain('未变化栏位的风险');
    expect(document.querySelector('.receipt-risk-review__explanation')?.textContent).toContain('勾选核对不会增加导出片段。');
    expect(screen.getByText('本轮命中')).toBeTruthy();
    expect(screen.getByText('本轮未列入变化·版式核对')).toBeTruthy();
    if (!canSave) expect(screen.getByText('贷款利息到期通知书，请核对整张凭证是否完整')).toBeTruthy();
    const save = vi.spyOn(service, 'save').mockResolvedValue();
    const saveButton = screen.getByRole('button', { name: '保存本轮 1 处' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    fireEvent.click(all);
    expect(new Set(service.getSnapshot().acknowledgedRiskIds)).toEqual(new Set(['risk-1', 'risk-2']));
    expect(save).not.toHaveBeenCalled();
    expect(saveButton.disabled).toBe(!canSave);
    fireEvent.click(all);
    expect(service.getSnapshot().acknowledgedRiskIds).toEqual([]);
    expect(saveButton.disabled).toBe(true);
    fireEvent.click(all);
    fireEvent.click(saveButton);
    expect(save).toHaveBeenCalledTimes(canSave ? 1 : 0);
  });
  it('edits all three slots on the same sample, keeps overflow editable, and previews the full corrected layout', async () => {
    const { service, client, pt } = liveEditor();
    fireEvent.click(screen.getByRole('button', { name: '调整所选边界' }));
    await screen.findByRole('navigation', { name: '回单栏位' });
    expect(screen.getByText('本轮版式范围：1 份 PDF · 51 页 · 现有命中 50 处')).toBeTruthy();
    expect(screen.getByText(/另有 1 处命中不在本轮范围内/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('回单高度（mm）'), { target: { value: '96.25' } });
    fireEvent.click(screen.getByLabelText('统一所有栏位高度'));
    expect(screen.getByRole('alert').textContent).toContain('0.65 mm');
    expect((screen.getByRole('button', { name: '确认并预览本轮' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: '选择第 3 栏边界' }));
    expect((screen.getByLabelText('回单高度（mm）') as HTMLInputElement).value).toBe('96.25');
    expect(service.getSnapshot().draft!.slots[2].height_pt).toBeCloseTo(pt(96.25));
    fireEvent.change(screen.getByLabelText('距页顶（mm）'), { target: { value: '200.79' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '选择第 2 栏边界' }));
    const box = screen.getByRole('region', { name: '裁剪区域' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(service.getSnapshot().draft!.slots[1].top_pt).toBeCloseTo(pt(100.01) + 1);
    expect(service.getSnapshot().selectedId).toBe('id-0');
    expect(service.getSnapshot().preparation!.selected_slot_id).toBe('s0');
    fireEvent.click(screen.getByRole('button', { name: '确认并预览本轮' }));
    expect(client.preview).toHaveBeenCalledTimes(1);
    expect(client.preview.mock.calls[0][2].slots.map((slot: { height_pt: number }) => slot.height_pt)).toEqual([pt(96.25), pt(96.25), pt(96.25)]);
    expect(client.preview.mock.calls[0][1].sample_id).toBe('id-0');
  });
  it.each([['ArrowDown', 'id-1'], ['ArrowRight', 'id-1'], ['ArrowUp', 'id-0'], ['ArrowLeft', 'id-0'], ['Home', 'id-0'], ['End', 'id-50']])('selects a candidate with %s and moves keyboard focus', (key, id) => {
    const view = state(), service = controller(); service.bind(view.session);
    const select = vi.spyOn(service, 'select');
    render(<ReceiptCalibrationNavigator state={view} controller={service} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /第 1 页 · 第 2 栏/ }), { key });
    expect(select).toHaveBeenCalledWith(id);
    expect(document.activeElement?.textContent).toContain(`第 ${Number(id.split('-')[1]) + 1} 页`);
  });
  it('filters pending receipts and confirms only explicitly selected candidates', () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(new Promise(() => undefined));
    const view = state(); view.reviewFilter = 'pending'; view.session!.items[0].original.needs_review = true;
    const service = controller(); service.bind(view.session);
    const confirm = vi.spyOn(service, 'reviewSelection').mockResolvedValue();
    render(<ReceiptCalibrationPane state={view} controller={service} onExport={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /第 2 页 · 第 2 栏/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 第 1 页 · 第 2 栏' }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认所选 1 处' }));
    expect(confirm).toHaveBeenCalledWith(['id-0'], 'confirm');
  });
  it('keeps optional fine-tuning alongside export when automatic results are good', () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(new Promise(() => undefined));
    render(<ReceiptCalibrationPane state={state()} controller={controller()} onExport={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('button', { name: '导出回单' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '调整所选边界' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 第 1 页 · 第 2 栏' }));
    expect(screen.getByRole('button', { name: '调整所选边界' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /保存本轮/ })).toBeNull();
  });
  it('hides export for mixed results and distinguishes pending count from selected state', () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(new Promise(() => undefined));
    const view = state();
    view.session!.items[0].original.needs_review = true;
    render(<ReceiptCalibrationPane state={view} controller={controller()} onExport={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '导出回单' })).toBeNull();
    const pending = screen.getByRole('button', { name: '待复核 1' });
    expect(pending.getAttribute('aria-pressed')).toBe('false');
    expect(pending.className).toContain('receipt-overview__filter-attention');
    expect(pending.className).not.toContain('primary');
  });
  it('hides export when every result is pending review', () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(new Promise(() => undefined));
    const view = state();
    view.session!.items.forEach((item) => { item.original.needs_review = true; });
    render(<ReceiptCalibrationPane state={view} controller={controller()} onExport={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '导出回单' })).toBeNull();
    const pending = screen.getByRole('button', { name: '待复核 51' });
    expect(pending.getAttribute('aria-pressed')).toBe('false');
    expect(pending.className).not.toContain('primary');
  });
  it('shows export after the last pending result is confirmed', () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(new Promise(() => undefined));
    const view = state();
    view.session!.items[0].original.needs_review = true;
    const service = controller();
    service.bind(view.session);
    function LivePane() {
      const current = useSyncExternalStore(service.subscribe, service.getSnapshot);
      return <ReceiptCalibrationPane state={current} controller={service} onExport={vi.fn()} onBack={vi.fn()} />;
    }
    render(<LivePane />);
    expect(screen.queryByRole('button', { name: '导出回单' })).toBeNull();
    view.session!.items[0].original.needs_review = false;
    act(() => service.bind(view.session));
    expect(screen.getByRole('button', { name: '导出回单' })).toBeTruthy();
  });
  it('keeps an excluded candidate in the full list and exposes only restore for the selected item', () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(new Promise(() => undefined));
    const view = state();
    view.session!.items[0]!.record = { review_status: 'excluded', record_revision: 1, final_rect: rect,
      crop_mode: 'candidate', manual_adjusted: false } as any;
    view.session!.items[0]!.record_revision = 1;
    const service = controller(); service.bind(view.session);
    const restore = vi.spyOn(service, 'reviewSelection').mockResolvedValue();
    render(<><ReceiptCalibrationPane state={view} controller={service} onExport={vi.fn()} onBack={vi.fn()} />
      <ReceiptCalibrationNavigator state={view} controller={service} /></>);
    expect(screen.getByRole('button', { name: '导出回单' })).toBeTruthy();
    expect(within(screen.getByLabelText('候选列表')).getByText('已排除')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开 第 1 页 · 第 2 栏' }));
    expect(screen.getByRole('button', { name: '恢复待复核' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '排除此片段' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '恢复待复核' }));
    expect(restore).toHaveBeenCalledWith(['id-0'], 'restore');
  });
  it('offers single-item exclusion and blocks export while another item remains pending', () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(new Promise(() => undefined));
    const view = state();
    view.session!.items[0]!.original.needs_review = true;
    const service = controller(); service.bind(view.session);
    const exclude = vi.spyOn(service, 'reviewSelection').mockResolvedValue();
    render(<ReceiptCalibrationPane state={view} controller={service} onBack={vi.fn()} onExport={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '导出回单' })).toBeNull();
    expect(screen.getByRole('button', { name: '待复核 1' }).className).not.toContain('primary');
    fireEvent.click(screen.getByRole('button', { name: '打开 第 1 页 · 第 2 栏' }));
    fireEvent.click(screen.getByRole('button', { name: '排除此片段' }));
    expect(exclude).toHaveBeenCalledWith(['id-0'], 'exclude');
  });
  it('hides export when every candidate is excluded instead of offering an empty export', () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(new Promise(() => undefined));
    const view = state();
    view.session!.items.forEach((item) => {
      item.record = { review_status: 'excluded', record_revision: 1, final_rect: rect,
        crop_mode: 'candidate', manual_adjusted: false } as any;
      item.record_revision = 1;
    });
    render(<ReceiptCalibrationPane state={view} controller={controller()} onBack={vi.fn()} onExport={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '导出回单' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开 第 1 页 · 第 2 栏' }));
    expect(screen.getByRole('button', { name: '恢复待复核' })).toBeTruthy();
  });
  it('withdraws the export generation entry when an open workspace receives a pending result', () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(new Promise(() => undefined));
    const view = state();
    const service = controller();
    service.bind(view.session);
    function LivePane() {
      const current = useSyncExternalStore(service.subscribe, service.getSnapshot);
      return <ReceiptCalibrationPane state={current} controller={service} onExport={vi.fn()} onBack={vi.fn()} />;
    }
    render(<LivePane />);
    fireEvent.click(screen.getByRole('button', { name: '导出回单' }));
    expect(screen.getByRole('button', { name: '选择目录并导出' })).toBeTruthy();
    const next = state().session!;
    next.items[0].original.needs_review = true;
    act(() => service.bind(next));
    expect(screen.queryByRole('button', { name: '选择目录并导出' })).toBeNull();
    expect(screen.getByRole('heading', { name: '检查与处理' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '导出回单' })).toBeNull();
    act(() => service.bind(state().session));
    expect(screen.getByRole('button', { name: '导出回单' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '选择目录并导出' })).toBeNull();
  });
  it.each(['job', 'binding context', 'prepared context', 'revision', 'phase', 'confirmation'])('withdraws an open export after %s changes and requires entering export again', (change) => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(new Promise(() => undefined));
    const current = state(), service = controller();
    current.session!.prepared.prepared = { result_revision: 'rev', context_key: 'context' } as any;
    const props = { controller: service, onExport: vi.fn(), onBack: vi.fn() };
    const view = render(<ReceiptCalibrationPane {...props} state={current} />);
    fireEvent.click(screen.getByRole('button', { name: '导出回单' }));
    expect(screen.getByRole('button', { name: '选择目录并导出' })).toBeTruthy();
    const next = structuredClone(current);
    if (change === 'job') next.session!.prepared.binding.job.id = 'another-job';
    if (change === 'binding context') next.session!.prepared.binding.contextKey = 'another-context';
    if (change === 'prepared context') next.session!.prepared.prepared.context_key = 'another-context';
    if (change === 'revision') next.session!.prepared.prepared.result_revision = 'another-revision';
    if (change === 'phase') next.phase = 'preparing';
    if (change === 'confirmation') next.reviewConfirming = true;
    view.rerender(<ReceiptCalibrationPane {...props} state={next} />);
    expect(screen.queryByRole('heading', { name: '导出设置' })).toBeNull();
    expect(screen.queryByRole('button', { name: '选择目录并导出' })).toBeNull();
    view.rerender(<ReceiptCalibrationPane {...props} state={current} />);
    expect(screen.getByRole('heading', { name: '检查与处理' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '选择目录并导出' })).toBeNull();
  });
  it('makes returning to results primary after saving and fine-tuning secondary', () => {
    const view = state();
    view.phase = 'saved';
    view.operation = { saved_count: 1 } as ReceiptCalibrationState['operation'];
    render(<ReceiptCalibrationPane state={view} controller={controller()} onExport={vi.fn()} onBack={vi.fn()} />);
    expect((screen.getByRole('button', { name: '完成微调，返回结果' }) as HTMLButtonElement).className).toContain('primary');
    expect((screen.getByRole('button', { name: '开始所选位置微调' }) as HTMLButtonElement).className).not.toContain('primary');
  });
  it.each(['saving', 'uncertain', 'saved'] as const)('shows undo-specific feedback in %s without the old round preview', async (phase) => {
    const renderPage = vi.spyOn(localEngineAdapter, 'renderPage').mockImplementation(async (_path, page) => image(page));
    const view = state();
    view.phase = phase; view.writeAction = 'undo';
    // Even if a stale preview is present, undo must show the session rather than saved draft targets.
    view.preview = { affected: [{ source_key: '/test.pdf', page: 51, slot_id: 's1', status: 'updated', after_rect: rect }],
      layout_definition: { slots: [{ slot_id: 's1', position_index: 2 }] } } as ReceiptCalibrationState['preview'];
    const service = controller(), recover = vi.spyOn(service, 'recover').mockResolvedValue();
    render(<><ReceiptCalibrationPane state={view} controller={service} onExport={vi.fn()} onBack={vi.fn()} />
      <ReceiptCalibrationNavigator state={view} controller={service} /></>);
    await screen.findByRole('img');
    expect(screen.queryByRole('button', { name: /^保存本轮/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: '本轮预览' })).toBeNull();
    expect(screen.getByRole('heading', { name: '回单候选' })).toBeTruthy();
    const rows = within(screen.getByLabelText('候选列表')).getAllByRole('button') as HTMLButtonElement[];
    expect(rows).toHaveLength(51);
    expect(rows.every((row) => row.disabled)).toBe(phase !== 'saved');
    if (phase === 'saved') {
      expect(screen.getByRole('heading', { name: '本轮已撤销' })).toBeTruthy();
      expect(screen.getByRole('status').textContent).toBe('已恢复本轮调整前的边界和复核状态。');
      expect((screen.getByRole('button', { name: '撤销本轮' }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole('button', { name: '完成微调，返回结果' }).className).toContain('primary');
    } else {
      expect(screen.queryByRole('heading', { name: '本轮已撤销' })).toBeNull();
      expect(screen.queryByRole('button', { name: /所选位置微调|返回结果/ })).toBeNull();
      expect(screen.getByRole('heading', { name: phase === 'saving' ? '正在撤销本轮' : '核实本轮撤销结果' })).toBeTruthy();
      if (phase === 'uncertain') {
        fireEvent.click(screen.getByRole('button', { name: '核实并完成撤销' }));
        expect(recover).toHaveBeenCalledTimes(1);
      }
    }
    expect(renderPage.mock.calls[0][1]).toBe(1);
  });
  it.each(['saving', 'uncertain', 'saved'] as const)('preserves normal save feedback in %s', (phase) => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(new Promise(() => undefined));
    const view = state();
    view.phase = phase; view.writeAction = 'save';
    view.operation = { saved_count: 51 } as ReceiptCalibrationState['operation'];
    render(<ReceiptCalibrationPane state={view} controller={controller()} onExport={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: phase === 'saving' ? '正在保存本轮' : phase === 'uncertain' ? '核实本轮保存结果' : '本轮已保存' })).toBeTruthy();
    if (phase === 'saved') expect(screen.getByText(/51 处已保存。/)).toBeTruthy();
    if (phase === 'uncertain') expect(screen.getByRole('button', { name: '核实并完成保存' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /撤销/ })).toBeNull();
  });
  it('renders all preview targets with real page and slot and lets the last target be selected', () => {
    const view = state(); view.phase = 'preview';
    view.preview = { affected: Array.from({ length: 51 }, (_, i) => ({ source_key: '/test.pdf', page: i + 1, slot_id: 's1', status: 'updated' })),
      layout_definition: { slots: [{ slot_id: 's1', position_index: 2 }] } } as ReceiptCalibrationState['preview'];
    const service = controller(), select = vi.spyOn(service, 'selectPreview');
    render(<ReceiptCalibrationNavigator state={view} controller={service} />);
    const panel = screen.getByRole('complementary', { name: '本轮全部片段' });
    expect(within(panel).getAllByRole('button')).toHaveLength(51);
    fireEvent.click(within(panel).getByRole('button', { name: /第 51 页 · 第 2 栏/ }));
    expect(select).toHaveBeenCalledWith(50);
  });
  it('shows no saved claim or next-round action after an uncertain write', () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockReturnValue(new Promise(() => undefined));
    const view = state(); view.phase = 'uncertain'; view.error = '保存结果需要核实';
    const service = controller(), recover = vi.spyOn(service, 'recover').mockResolvedValue();
    render(<ReceiptCalibrationPane state={view} controller={service} onExport={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByText('本轮已保存')).toBeNull();
    expect(screen.queryByRole('button', { name: /下一|所选位置/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '核实并完成保存' }));
    expect(recover).toHaveBeenCalledTimes(1);
  });
  it('preserves a saved full-page decision instead of showing the old cropped candidate', async () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(image(1));
    const view = state();
    view.session!.items[0].record = { final_rect: null, crop_mode: 'full_page', review_status: 'page_confirmed' } as NonNullable<ReceiptReviewSession['items'][number]['record']>;
    render(<ReceiptCalibrationPane state={view} controller={controller()} onExport={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 第 1 页 · 第 2 栏' }));
    await waitFor(() => expect(screen.getByLabelText('本轮边界')).toBeTruthy());
    const box = screen.getByLabelText('本轮边界');
    expect(box.style.top).toBe('0%'); expect(box.style.height).toBe('100%');
  });
});
