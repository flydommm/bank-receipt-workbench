// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReceiptBatchReviewPageItem } from '../domain/receiptBatch';
import type { ReceiptReviewOriginal, ReceiptReviewRecord } from '../domain/receiptReview';
import { ReceiptCalibrationController, type ReceiptCalibrationState, type ReceiptReviewSession } from '../services/receiptCalibrationController';
import type { EnginePagePreview } from './localEngineAdapter';
import { buildReceiptOverviewCards, ReceiptOverview, type ReceiptOverviewCard } from './ReceiptOverview';

const { load, dispose } = vi.hoisted(() => ({ load: vi.fn(), dispose: vi.fn() }));
vi.mock('../services/pdfThumbnailCache', () => ({
  PdfThumbnailCache: class {
    load = load;
    dispose = dispose;
  },
}));

const sha = 'a'.repeat(64);
const otherSha = 'b'.repeat(64);
const contextKey = 'c'.repeat(64);
const candidateRect = { x0: 0, y0: 300, x1: 600, y1: 590 };
const pageRect = { x0: 0, y0: 0, x1: 600, y1: 900 };
const pageGeometry = {
  pdf_box: pageRect,
  rotation: 0 as const,
  user_unit: 1,
  width_pt: 600,
  height_pt: 900,
};

function preview(page: number, sourceSha = sha, pageCount = 5000): EnginePagePreview {
  return {
    status: 'ok', page, page_count: pageCount, page_width: 600, page_height: 900,
    source_sha256: sourceSha, image_data: `data:image/png;base64,synthetic-${page}`,
  };
}

function source(sourceKey = '/a.pdf', name = '合成回单.pdf', pageCount = 2, sourceSha = sha) {
  return { source_key: sourceKey, access_path: sourceKey, name, sha256: sourceSha, page_count: pageCount };
}

function original(id: string, page: number, sourceKey = '/a.pdf', overrides: Partial<ReceiptReviewOriginal> = {}): ReceiptReviewOriginal {
  return {
    id, source_key: sourceKey, source_page: page, instance_id: `instance-${id}`, slot_id: 'slot-1', position_index: 1,
    layout_id: 'layout', layout_revision: 1, layout_signature: 'layout-signature', page_geometry: pageGeometry,
    candidate_rect: candidateRect, occupancy: 'occupied', selection_basis: 'keyword', needs_review: true,
    analysis_signature: `analysis-${id}`, ...overrides,
  };
}

function record(item: ReceiptBatchReviewPageItem, status: ReceiptReviewRecord['review_status'], overrides: Partial<ReceiptReviewRecord> = {}): ReceiptReviewRecord {
  return {
    schema_version: 1, context_key: contextKey, result_revision: 'revision', record_revision: 1,
    source_path: item.original.source_key, source_sha256: item.original.source_key === '/b.pdf' ? otherSha : sha,
    original: item.original, final_rect: item.original.candidate_rect, crop_mode: 'candidate', review_status: status,
    manual_adjusted: false, reviewed_at: '2026-09-23T00:00:00.000Z', ...overrides,
  } as ReceiptReviewRecord;
}

function item(id: string, page: number, sourceKey = '/a.pdf', overrides: Partial<ReceiptBatchReviewPageItem> = {}): ReceiptBatchReviewPageItem {
  return { original: original(id, page, sourceKey), record_revision: 0, record: null, ...overrides };
}

function session(items: ReceiptBatchReviewPageItem[], options: {
  id?: string;
  revision?: string;
  context?: string;
  sources?: ReturnType<typeof source>[];
} = {}): ReceiptReviewSession {
  const id = options.id ?? 'job';
  const revision = options.revision ?? 'revision';
  const context = options.context ?? contextKey;
  const sources = options.sources ?? [source('/a.pdf', '合成回单.pdf', Math.max(2, ...items.map((entry) => entry.original.source_page)))];
  return {
    prepared: {
      prepared: { result_revision: revision, context_key: context },
      binding: { job: { id, result_revision: revision, sources }, contextKey: context },
    },
    items,
  } as unknown as ReceiptReviewSession;
}

function state(sessionValue: ReceiptReviewSession, overrides: Partial<ReceiptCalibrationState> = {}): ReceiptCalibrationState {
  return {
    phase: 'results', session: sessionValue, selectedId: sessionValue.items[0]?.original.id ?? null, selectedSlotId: null,
    preparation: null, draft: null, preview: null, previewIndex: 0, operation: null, writeAction: null,
    error: null, acknowledgedRiskIds: [], includeExceptionIds: [], rememberReference: false, templateName: '3栏回单模板',
    templateSaveMode: 'create', templateId: null, templateBankName: '', templateCandidates: [], templateCandidatesStatus: 'idle', templateCandidatesError: null,
    reviewFilter: 'all', reviewConfirming: false, reviewAction: null, reviewNotice: null, ...overrides,
  };
}

function controller() {
  return {
    select: vi.fn(),
    reviewSelection: vi.fn().mockResolvedValue(undefined),
    classifySelection: vi.fn().mockResolvedValue(undefined),
    setReviewFilter: vi.fn(),
    begin: vi.fn(),
  } as unknown as ReceiptCalibrationController;
}

function renderOverview(sessionValue: ReceiptReviewSession, controllerValue = controller(), stateOverrides: Partial<ReceiptCalibrationState> = {}, renderPage = vi.fn((card: ReceiptOverviewCard) => (
  <div data-testid="rendered-page">{card.id}:{card.rect?.x0}:{card.rect?.y0}:{card.rect?.x1}:{card.rect?.y1}</div>
))) {
  const currentState = state(sessionValue, stateOverrides);
  const view = render(<ReceiptOverview state={currentState} controller={controllerValue} canExport={false}
    onExport={vi.fn()} onBack={vi.fn()} renderPage={renderPage} />);
  return { ...view, controller: controllerValue, renderPage, currentState };
}

beforeEach(() => {
  load.mockReset();
  dispose.mockReset();
  load.mockImplementation(async (request: { page: number; sha: string; pageCount: number }) => preview(request.page, request.sha, request.pageCount));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReceiptOverview', () => {
  it('limits thumbnail selections to a group and opens a requested source without changing review records', async () => {
    const currentSession = session([item('first', 1), item('second', 2)]);
    const service = controller();
    const props = { state: state(currentSession), controller: service, canExport: false,
      onExport: vi.fn(), onBack: vi.fn(), renderPage: vi.fn(() => <div>合成原件预览</div>) };
    const view = render(<ReceiptOverview {...props} groupingFilterIds={['second']} />);
    expect(screen.getByRole('checkbox', { name: '全选当前筛选结果（1 处）' })).toBeTruthy();
    expect(view.container.querySelector('[data-card-id="first"]')).toBeNull();
    expect(view.container.querySelector('[data-card-id="second"]')).toBeTruthy();
    view.rerender(<ReceiptOverview {...props} groupingFilterIds={null} requestedSegment={{ id: 'first', sequence: 1 }} />);
    await screen.findByRole('dialog');
    expect(screen.getByText('合成原件预览')).toBeTruthy();
    expect(service.reviewSelection).not.toHaveBeenCalled();
    expect(service.classifySelection).not.toHaveBeenCalled();
  });
  it('shows the review order without making template saving a prerequisite for every receipt', () => {
    renderOverview(session([item('id-1', 1)]));
    expect(screen.getByRole('note').textContent).toContain('排除无效 → 核对特殊单证 → 必要时调整边界或模板 → 完成复核 → 检查并导出');
  });

  it('offers current-result template preview only after special and suspected items are handled', () => {
    const ordinary = item('ordinary', 1);
    const special = { ...item('special', 2), page_notice: { code: 'special_document' as const, document_type: 'loan_interest_notice' as const } };
    const suspect = { ...item('suspect', 3), exclusion_notice: { code: 'suspected_invalid_slot' as const } };
    const records = session([ordinary, special, suspect]);
    const openTemplates = vi.fn();
    const props = { state: state(records), controller: controller(), canExport: false,
      onExport: vi.fn(), onBack: vi.fn(), onOpenTemplates: openTemplates, renderPage: vi.fn() };
    const rendered = render(<ReceiptOverview {...props} />);
    expect(screen.queryByRole('button', { name: '我的模板 · 预览应用' })).toBeNull();
    records.items[1].record = record(special, 'confirmed');
    records.items[2].record = record(suspect, 'excluded');
    rendered.rerender(<ReceiptOverview {...props} state={state(records)} />);
    fireEvent.click(screen.getByRole('button', { name: '我的模板 · 预览应用' }));
    expect(openTemplates).toHaveBeenCalledOnce();
  });
  it('keeps suspected filtering and the template entry scoped to the selected PDF', () => {
    const ordinary = item('ordinary-a', 1);
    const suspectB = { ...item('suspect-b', 1, '/b.pdf'), exclusion_notice: { code: 'suspected_invalid_slot' as const } };
    const records = session([ordinary, suspectB], { sources: [source(), source('/b.pdf', '其他银行.pdf')] });
    render(<ReceiptOverview state={state(records)} controller={controller()} canExport={false}
      onExport={vi.fn()} onBack={vi.fn()} onOpenTemplates={vi.fn()} renderPage={vi.fn()} />);
    expect(screen.getByRole('button', { name: '疑似需排除 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /合成回单\.pdf.*2 页/ }));
    expect(screen.queryByRole('button', { name: /疑似需排除/ })).toBeNull();
    expect(screen.getByRole('button', { name: '我的模板 · 预览应用' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /其他银行\.pdf.*2 页/ }));
    expect(screen.getByRole('button', { name: '疑似需排除 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '我的模板 · 预览应用' })).toBeNull();
  });
  it('keeps status, special type, and suggested exclusion visually distinct', async () => {
    const suspected = { ...item('suspected', 1), exclusion_notice: { code: 'suspected_invalid_slot' as const } };
    const special = { ...item('special', 2), page_notice: { code: 'special_document' as const, document_type: 'loan_interest_notice' as const } };
    const uncertain = item('uncertain', 3);
    uncertain.original.occupancy = 'uncertain';
    const currentSession = session([suspected, special, uncertain]);
    const view = renderOverview(currentSession);
    expect(view.container.querySelector('[data-card-id="suspected"]')?.className).toContain('attention-suspected');
    expect(view.container.querySelector('[data-card-id="special"]')?.className).toContain('attention-special');
    expect(view.container.querySelector('[data-card-id="uncertain"]')?.className).not.toContain('attention-suspected');
    expect(screen.getByText('疑似无效·待核对')).toBeTruthy();
    expect(screen.getByText('特殊单证')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '原页总览' }));
    await waitFor(() => expect(view.container.querySelectorAll('.pdf-thumbnail-overlay.attention-suspected')).toHaveLength(1));
    expect(view.container.querySelectorAll('.pdf-thumbnail-overlay.attention-special')).toHaveLength(1);
  });

  it('projects ordinary fragment status and boundaries consistently in both overview modes', () => {
    const automatic = item('automatic', 1, '/a.pdf', { original: original('automatic', 1, '/a.pdf', { needs_review: false }) });
    const pending = item('pending', 1);
    const confirmed = item('confirmed', 1);
    confirmed.record = record(confirmed, 'confirmed');
    const currentSession = session([automatic, pending, confirmed], { sources: [source('/a.pdf', '三种状态.pdf', 1)] });
    const originalReferences = currentSession.items.map((entry) => ({ original: entry.original, record: entry.record }));

    const receiptCards = buildReceiptOverviewCards(currentSession, currentSession.items, 'receipts', 'all', true);
    expect(receiptCards.map((card) => [card.id, card.tone, card.badge])).toEqual([
      ['automatic', 'automatic', '自动候选'],
      ['pending', 'pending', '待复核'],
      ['confirmed', 'confirmed', '已确认'],
    ]);
    for (const card of receiptCards) {
      expect(card.rect).toBeTruthy();
      expect(card.overlays).toHaveLength(1);
      expect(card.overlays?.[0]).toMatchObject({ rect: card.rect, tone: card.tone, attention: card.attention, badge: card.badge });
      expect(card.overlays?.[0]?.label).toContain(card.label);
    }

    const pageCard = buildReceiptOverviewCards(currentSession, currentSession.items, 'pages', 'all', true)[0];
    expect(pageCard.tone).toBeUndefined();
    expect(pageCard.badge).toBe('3 / 3 处');
    expect(pageCard.ids).toEqual(['automatic', 'pending', 'confirmed']);
    expect(pageCard.overlays?.map((overlay) => [overlay.tone, overlay.attention, overlay.badge])).toEqual([
      ['automatic', undefined, '自动候选'],
      ['pending', undefined, '待复核'],
      ['confirmed', undefined, '已确认'],
    ]);
    expect(pageCard.overlays?.map((overlay) => overlay.label)).toEqual(receiptCards.map((card) => card.overlays?.[0]?.label));
    expect(currentSession.items.map((entry) => ({ original: entry.original, record: entry.record }))).toEqual(originalReferences);
  });

  it('keeps blocked, suspected, special, excluded, and restored statuses explicit', () => {
    const suspected = { ...item('suspected', 1), exclusion_notice: { code: 'suspected_invalid_slot' as const } };
    const blocked = item('blocked', 2);
    blocked.record = record(blocked, 'blocked');
    const special = { ...item('special', 3), page_notice: { code: 'special_document' as const, document_type: 'loan_interest_notice' as const } };
    const excluded = { ...item('excluded', 4), exclusion_notice: { code: 'suspected_invalid_slot' as const } };
    excluded.record = record(excluded, 'excluded');
    const currentSession = session([suspected, blocked, special, excluded], { sources: [source('/a.pdf', '状态流转.pdf', 4)] });

    const cards = () => buildReceiptOverviewCards(currentSession, currentSession.items, 'receipts', 'all', true);
    expect(cards().map((card) => [card.id, card.tone, card.attention, card.badge])).toEqual([
      ['suspected', 'pending', 'suspected', '待核对'],
      ['blocked', 'pending', undefined, '需调整'],
      ['special', 'pending', 'special', '待复核'],
      ['excluded', 'excluded', undefined, '已排除'],
    ]);

    suspected.record = record(suspected, 'confirmed');
    expect(cards().find((card) => card.id === 'suspected')).toMatchObject({ tone: 'confirmed', attention: undefined, badge: '已确认' });
    suspected.record = record(suspected, 'excluded');
    expect(cards().find((card) => card.id === 'suspected')).toMatchObject({ tone: 'excluded', attention: undefined, badge: '已排除' });
    suspected.record = record(suspected, 'needs_review');
    expect(cards().find((card) => card.id === 'suspected')).toMatchObject({ tone: 'pending', attention: 'suspected', badge: '待核对' });

    special.record = record(special, 'confirmed');
    expect(cards().find((card) => card.id === 'special')).toMatchObject({ tone: 'confirmed', attention: 'special', badge: '已确认' });
    special.record = record(special, 'excluded');
    expect(cards().find((card) => card.id === 'special')).toMatchObject({ tone: 'excluded', attention: undefined, badge: '已排除' });
  });

  it('keeps excluded fragments visually marked without suggesting they still await review', async () => {
    const excluded = { ...item('excluded', 1), exclusion_notice: { code: 'suspected_invalid_slot' as const } };
    excluded.record = record(excluded, 'excluded');
    const excludedSpecial = { ...item('excluded-special', 1), page_notice: {
      code: 'special_document' as const, document_type: 'loan_interest_notice' as const,
    } };
    excludedSpecial.record = record(excludedSpecial, 'excluded');
    const confirmedSpecial = { ...item('confirmed-special', 2), page_notice: {
      code: 'special_document' as const, document_type: 'loan_interest_notice' as const,
    } };
    confirmedSpecial.record = record(confirmedSpecial, 'confirmed');
    const currentSession = session([excluded, excludedSpecial, confirmedSpecial]);
    const view = renderOverview(currentSession);
    for (const id of ['excluded', 'excluded-special']) {
      expect(view.container.querySelector(`[data-card-id="${id}"]`)?.className).toContain('tone-excluded');
      expect(view.container.querySelector(`[data-card-id="${id}"]`)?.className).not.toContain('attention-');
    }
    expect(view.container.querySelector('[data-card-id="confirmed-special"]')?.className).toContain('attention-special');
    expect(screen.queryByText('疑似无效·待核对')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '原页总览' }));
    await waitFor(() => expect(view.container.querySelectorAll('.pdf-thumbnail-overlay.tone-excluded')).toHaveLength(2));
    expect(view.container.querySelectorAll('.pdf-thumbnail-overlay.attention-special')).toHaveLength(1);
  });

  it('isolates suggested invalid fragments for deliberate bulk exclusion', () => {
    const suspected = { ...item('suspected', 1), exclusion_notice: { code: 'suspected_invalid_slot' as const } };
    const ordinary = item('ordinary', 2);
    const special = { ...item('special', 3), page_notice: { code: 'special_document' as const, document_type: 'loan_interest_notice' as const } };
    const currentSession = session([suspected, ordinary, special]);
    const service = controller();
    const view = renderOverview(currentSession, service);
    expect(screen.getByRole('button', { name: '待复核 3' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '疑似需排除 1' }));
    expect(service.setReviewFilter).toHaveBeenCalledWith('pending');
    view.rerender(<ReceiptOverview state={state(currentSession, { reviewFilter: 'pending' })} controller={service}
      canExport={false} onExport={vi.fn()} onBack={vi.fn()} renderPage={view.renderPage} />);
    expect(screen.getByRole('button', { name: '疑似需排除 1' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('checkbox', { name: '全选当前筛选结果（1 处）' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开 第 2 页 · 第 1 栏' })).toBeNull();
    expect(service.reviewSelection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前筛选结果（1 处）' }));
    fireEvent.click(screen.getByRole('button', { name: '排除所选疑似无效 1 处' }));
    expect(service.reviewSelection).toHaveBeenCalledWith(['suspected'], 'exclude');
  });

  it('classifies the explicitly selected fragments and requires a separate boundary acknowledgement', () => {
    const service = controller();
    renderOverview(session([item('a', 1), item('b', 2), item('c', 3)]), service);
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前筛选结果（3 处）' }));
    fireEvent.click(screen.getByRole('button', { name: '设置凭证类型' }));
    expect(screen.getByText('设置凭证类型 · 所选 3 处')).toBeTruthy();
    expect(screen.getByLabelText('类型与边界均已核对')).toHaveProperty('checked', false);
    fireEvent.change(screen.getByLabelText('所选凭证类型'), { target: { value: 'other_special' } });
    fireEvent.click(screen.getByRole('button', { name: '保存类型，保留待复核' }));
    expect(service.classifySelection).toHaveBeenCalledWith(['a', 'b', 'c'], 'other_special', false);
    fireEvent.click(screen.getByLabelText('类型与边界均已核对'));
    fireEvent.change(screen.getByLabelText('所选凭证类型'), { target: { value: 'loan_interest_notice' } });
    expect(screen.getByLabelText('类型与边界均已核对')).toHaveProperty('checked', false);
    fireEvent.click(screen.getByLabelText('类型与边界均已核对'));
    fireEvent.click(screen.getByRole('button', { name: '保存类型并确认边界' }));
    expect(service.classifySelection).toHaveBeenLastCalledWith(['a', 'b', 'c'], 'loan_interest_notice', true);
  });
  it('offers classification in details but cannot use it to approve a blocked boundary', () => {
    const blocked = item('blocked', 1); blocked.record = record(blocked, 'blocked');
    const service = controller();
    renderOverview(session([blocked]), service);
    fireEvent.click(screen.getByRole('button', { name: '打开 第 1 页 · 第 1 栏' }));
    fireEvent.click(screen.getByRole('button', { name: '设置凭证类型' }));
    expect(screen.getByLabelText('类型与边界均已核对')).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('所选凭证类型'), { target: { value: 'other_special' } });
    fireEvent.click(screen.getByRole('button', { name: '保存类型，保持需调整' }));
    expect(service.classifySelection).toHaveBeenCalledWith(['blocked'], 'other_special', false);
  });
  it('closes a type draft when the active filter changes instead of reusing its selection', () => {
    const service = controller();
    renderOverview(session([item('a', 1), item('b', 2)]), service);
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前筛选结果（2 处）' }));
    fireEvent.click(screen.getByRole('button', { name: '设置凭证类型' }));
    fireEvent.change(screen.getByLabelText('凭证类型'), { target: { value: 'special' } });
    expect(screen.queryByRole('region', { name: '设置所选凭证类型' })).toBeNull();
    expect(service.classifySelection).not.toHaveBeenCalled();
  });
  it('opens pending special documents as an explicit scoped review, without ordinary or confirmed items', () => {
    const settlement = { ...item('settlement', 2), page_notice: { code: 'special_document' as const, document_type: 'loan_settlement_notice' as const } };
    const interest = { ...item('interest', 3), page_notice: { code: 'special_document' as const, document_type: 'loan_interest_notice' as const } };
    const tax = { ...item('tax', 4), page_notice: { code: 'special_document' as const, document_type: 'electronic_tax_payment' as const } };
    const confirmed = { ...item('confirmed-special', 5), page_notice: interest.page_notice,
      record: record(item('confirmed-special', 5), 'confirmed') };
    const currentSession = session([item('ordinary', 1), settlement, interest, tax, confirmed]);
    const service = controller();
    const view = renderOverview(currentSession, service);
    fireEvent.click(screen.getByRole('button', { name: '核对特殊单证 3 处' }));
    expect(service.setReviewFilter).toHaveBeenCalledWith('pending');
    view.rerender(<ReceiptOverview state={state(currentSession, { reviewFilter: 'pending' })} controller={service}
      canExport={false} onExport={vi.fn()} onBack={vi.fn()} renderPage={view.renderPage} />);
    expect(screen.getByLabelText('凭证类型')).toHaveProperty('value', 'special');
    expect(screen.queryByRole('button', { name: '打开 第 1 页 · 第 1 栏' })).toBeNull();
    expect(screen.queryByRole('button', { name: '打开 第 5 页 · 第 1 栏' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前筛选结果（3 处）' }));
    fireEvent.click(screen.getByRole('button', { name: '确认所选特殊单证 3 处' }));
    expect(service.reviewSelection).toHaveBeenCalledWith(['settlement', 'interest', 'tax'], 'confirm');
  });

  it.each([
    ['loan_settlement_notice', '贷款清算通知书'],
    ['loan_interest_notice', '贷款利息到期通知书'],
    ['electronic_tax_payment', '电子缴税付款凭证'],
  ] as const)('makes confirming %s explicit and retains the separate adjustment action', (document_type, label) => {
    const special = { ...item('special', 1), page_notice: { code: 'special_document' as const, document_type } };
    const service = controller();
    renderOverview(session([special]), service);
    fireEvent.click(screen.getByRole('button', { name: '打开 第 1 页 · 第 1 栏' }));
    expect(screen.getByText(`${label} · 待复核：请检查抬头、正文、印章与底部是否完整。`)).toBeTruthy();
    expect(screen.getByText(/确认只认可当前边界，不改变凭证类型/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '调整所选边界' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认此片段' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '确认此特殊单证' }));
    expect(service.reviewSelection).toHaveBeenCalledWith(['special'], 'confirm');
  });

  it('keeps a bounded DOM for 5000 fragments, selects offscreen IDs, and writes only on confirmation', async () => {
    const items = Array.from({ length: 5000 }, (_, index) => item(`id-${index}`, index + 1));
    const currentSession = session(items, { sources: [source('/a.pdf', '5000页回单.pdf', 5000)] });
    const service = controller();
    const { container } = renderOverview(currentSession, service);

    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(container.querySelectorAll('[data-card-id]').length).toBeLessThan(40);
    expect(screen.queryByRole('button', { name: '打开 第 5000 页 · 第 1 栏' })).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: /全选当前筛选结果/ }));
    expect(service.reviewSelection).not.toHaveBeenCalled();
    expect(screen.getByText('已选 5000 处')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '确认所选 5000 处' }));
    await waitFor(() => expect(service.reviewSelection).toHaveBeenCalledWith(items.map((entry) => entry.original.id), 'confirm'));
  });

  it.each(['source', 'type', 'status', 'view'] as const)('clears selection when the %s scope changes', (change) => {
    const items = [
      item('a-1', 1),
      { ...item('a-special', 2), page_notice: { code: 'special_document' as const, document_type: 'loan_interest_notice' as const } },
      item('b-1', 1, '/b.pdf'),
    ];
    const currentSession = session(items, { sources: [source('/a.pdf', '第一份.pdf', 2), source('/b.pdf', '第二份.pdf', 1, otherSha)] });
    const service = controller();
    const view = renderOverview(currentSession, service);

    fireEvent.click(screen.getAllByRole('checkbox', { name: '选择 第 1 页 · 第 1 栏' })[0]);
    expect(screen.getByText('已选 1 处')).toBeTruthy();

    if (change === 'source') {
      fireEvent.click(screen.getByRole('button', { name: /第二份\.pdf/ }));
    } else if (change === 'type') {
      fireEvent.change(screen.getByLabelText('凭证类型'), { target: { value: 'loan_interest_notice' } });
    } else if (change === 'status') {
      fireEvent.click(screen.getByRole('button', { name: /待复核/ }));
      view.rerender(<ReceiptOverview state={state(currentSession, { reviewFilter: 'pending' })} controller={service} canExport={false}
        onExport={vi.fn()} onBack={vi.fn()} renderPage={view.renderPage} />);
    } else {
      fireEvent.click(screen.getByRole('button', { name: '原页总览' }));
    }

    expect(screen.queryByText('已选 1 处')).toBeNull();
  });

  it('reports action counts from mixed pending, confirmed, blocked, and excluded selection', () => {
    const pending = item('pending', 1);
    const confirmed = item('confirmed', 2, '/a.pdf', { record: record(item('confirmed', 2), 'confirmed') });
    const blocked = item('blocked', 3, '/a.pdf', { record: record(item('blocked', 3), 'blocked') });
    const excluded = item('excluded', 4, '/a.pdf', { record: record(item('excluded', 4), 'excluded') });
    const currentSession = session([pending, confirmed, blocked, excluded], { sources: [source('/a.pdf', '混合状态.pdf', 4)] });
    const service = controller();
    renderOverview(currentSession, service);

    fireEvent.click(screen.getByRole('checkbox', { name: /全选当前筛选结果/ }));
    expect(screen.getByRole('button', { name: '确认所选 1 处' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '排除所选 3 处' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '恢复所选 1 处为待复核' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '确认所选 1 处' }));
    expect(service.reviewSelection).toHaveBeenLastCalledWith(['pending'], 'confirm');
    fireEvent.click(screen.getByRole('button', { name: '排除所选 3 处' }));
    expect(service.reviewSelection).toHaveBeenLastCalledWith(['pending', 'confirmed', 'blocked'], 'exclude');
    fireEvent.click(screen.getByRole('button', { name: '恢复所选 1 处为待复核' }));
    expect(service.reviewSelection).toHaveBeenLastCalledWith(['excluded'], 'restore');
  });

  it('includes empty source pages, makes them non-selectable, and page selection contains only filtered IDs', () => {
    const pending = item('pending', 1);
    const confirmedSamePage = item('confirmed-same-page', 1, '/a.pdf', { record: record(item('confirmed-same-page', 1), 'confirmed') });
    const confirmedOtherPage = item('confirmed-other-page', 2, '/a.pdf', { record: record(item('confirmed-other-page', 2), 'confirmed') });
    const currentSession = session([pending, confirmedSamePage, confirmedOtherPage], { sources: [source('/a.pdf', '三页回单.pdf', 3)] });
    const service = controller();
    const view = renderOverview(currentSession, service);

    fireEvent.click(screen.getByRole('button', { name: '原页总览' }));
    expect(screen.getByRole('button', { name: '打开 第 3 页' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: '选择 第 3 页' })).toBeNull();
    expect(screen.getByText('无候选片段')).toBeTruthy();

    const pendingState = state(currentSession, { reviewFilter: 'pending' });
    view.rerender(<ReceiptOverview state={pendingState} controller={service} canExport={false}
      onExport={vi.fn()} onBack={vi.fn()} renderPage={view.renderPage} />);
    expect(screen.getByText('1 / 2 处')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 第 1 页' }));
    expect(screen.getByText('已选 1 处')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认所选 1 处' }));
    expect(service.reviewSelection).toHaveBeenCalledWith(['pending'], 'confirm');
  });

  it('uses a saved final rectangle and saved full-page decision over the original candidate rectangle', () => {
    const manual = item('manual', 1);
    manual.record = record(manual, 'confirmed', { crop_mode: 'manual', final_rect: { x0: 20, y0: 330, x1: 580, y1: 560 } });
    const fullPage = item('full-page', 2);
    fullPage.record = record(fullPage, 'page_confirmed', { crop_mode: 'full_page', final_rect: null });
    const currentSession = session([manual, fullPage], { sources: [source('/a.pdf', '已保存边界.pdf', 2)] });

    const cards = buildReceiptOverviewCards(currentSession, currentSession.items, 'receipts', 'all', true);
    expect(cards.find((card) => card.id === 'manual')?.rect).toEqual({ x0: 20, y0: 330, x1: 580, y1: 560 });
    expect(cards.find((card) => card.id === 'full-page')?.rect).toEqual(pageRect);
  });

  it('keeps selection through same-context partial failure, shows the error, and clears it after success', async () => {
    const currentSession = session([item('id-1', 1)], { sources: [source('/a.pdf', '回单.pdf', 1)] });
    const service = controller();
    const view = renderOverview(currentSession, service);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 第 1 页 · 第 1 栏' }));

    view.rerender(<ReceiptOverview state={state(currentSession, { error: '批量确认未完成：网络错误' })} controller={service} canExport={false}
      onExport={vi.fn()} onBack={vi.fn()} renderPage={view.renderPage} />);
    expect(screen.getByRole('alert').textContent).toContain('网络错误');
    expect(screen.getByText('已选 1 处')).toBeTruthy();

    view.rerender(<ReceiptOverview state={state(currentSession, { reviewNotice: '本批 1 处已确认。' })} controller={service} canExport={false}
      onExport={vi.fn()} onBack={vi.fn()} renderPage={view.renderPage} />);
    await waitFor(() => expect(screen.queryByText('已选 1 处')).toBeNull());
    expect(screen.getByRole('status').textContent).toContain('本批 1 处已确认');
  });

  it.each(['job', 'revision', 'source SHA'] as const)('clears selection when the review %s changes', (change) => {
    const currentSession = session([item('id-1', 1)], { sources: [source('/a.pdf', '回单.pdf', 1)] });
    const service = controller();
    const view = renderOverview(currentSession, service);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 第 1 页 · 第 1 栏' }));

    const changed = structuredClone(currentSession);
    if (change === 'job') changed.prepared.binding.job.id = 'other-job';
    if (change === 'revision') changed.prepared.prepared.result_revision = 'other-revision';
    if (change === 'source SHA') changed.prepared.binding.job.sources[0].sha256 = otherSha;
    view.rerender(<ReceiptOverview state={state(changed)} controller={service} canExport={false}
      onExport={vi.fn()} onBack={vi.fn()} renderPage={view.renderPage} />);
    expect(screen.queryByText('已选 1 处')).toBeNull();
  });

  it('opens detail, navigates, and returns without changing scope or auto-confirming selection', async () => {
    const currentSession = session([item('id-1', 1), item('id-2', 2)], { sources: [source('/a.pdf', '回单.pdf', 2)] });
    const service = controller();
    const renderPage = vi.fn((card: ReceiptOverviewCard) => <div data-testid="rendered-page">{card.id}</div>);
    const view = renderOverview(currentSession, service, {}, renderPage);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 第 1 页 · 第 1 栏' }));
    fireEvent.click(screen.getByRole('button', { name: '打开 第 1 页 · 第 1 栏' }));
    expect(screen.getByRole('dialog', { name: '片段详情' })).toBeTruthy();
    expect(screen.getByTestId('rendered-page').textContent).toBe('id-1');
    expect(service.reviewSelection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '下一项' }));
    expect(screen.getByTestId('rendered-page').textContent).toBe('id-2');
    expect(service.reviewSelection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回总览' }));
    expect(screen.getByText('已选 1 处')).toBeTruthy();
    expect(service.reviewSelection).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-card-id="id-1"]')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '打开 第 1 页 · 第 1 栏' })));
  });

  it('uses the same thumbnail size control and percentage baseline as source preview', () => {
    const currentSession = session([item('id-1', 1)], { sources: [source('/a.pdf', '回单.pdf', 1)] });
    renderOverview(currentSession);
    const group = screen.getByRole('group', { name: '缩略图大小' });
    const increase = screen.getByRole('button', { name: '放大缩略图' });
    expect(group.textContent).toContain('100%');
    fireEvent.click(increase);
    expect(group.textContent).toContain('108%');
  });

  it('offers boundary adjustment for one selected confirmed fragment', () => {
    const confirmed = item('confirmed', 1);
    confirmed.record = record(confirmed, 'confirmed');
    const currentSession = session([confirmed], { sources: [source('/a.pdf', '已确认.pdf', 1)] });
    const service = controller();
    renderOverview(currentSession, service);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 第 1 页 · 第 1 栏' }));
    fireEvent.click(screen.getByRole('button', { name: '调整所选边界' }));
    expect(service.select).toHaveBeenCalledWith('confirmed');
    expect(service.begin).toHaveBeenCalledOnce();
  });

  it('offers an explicit switch back to all results when pending review is empty', () => {
    const confirmed = item('confirmed', 1);
    confirmed.record = record(confirmed, 'confirmed');
    const currentSession = session([confirmed], { sources: [source('/a.pdf', '已确认.pdf', 1)] });
    const service = controller();
    renderOverview(currentSession, service, { reviewFilter: 'pending' });
    expect(screen.getByRole('button', { name: '切换到全部，继续调整已确认片段' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '切换到全部，继续调整已确认片段' }));
    expect(service.setReviewFilter).toHaveBeenCalledWith('all');
  });

  it('labels the export action as exporting receipts', () => {
    const currentSession = session([item('id-1', 1)], { sources: [source('/a.pdf', '回单.pdf', 1)] });
    render(<ReceiptOverview state={state(currentSession)} controller={controller()} canExport onExport={vi.fn()} onBack={vi.fn()}
      renderPage={vi.fn(() => <div />)} />);
    expect(screen.getByRole('button', { name: '导出回单' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '预览并导出' })).toBeNull();
  });
});
