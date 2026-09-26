import { describe, expect, it, vi } from 'vitest';
import { ReceiptCalibrationController, pendingReceiptGroup, type ReceiptReviewSession } from './receiptCalibrationController';
import type { ReceiptLayoutClient, ReceiptLayoutPreparation, ReceiptLayoutPreview, ReceiptLayoutUndo } from './receiptLayoutClient';
import type { LayoutDefinition } from '../domain/receiptLayout';
import type { ReceiptBatchClient } from './receiptBatchClient';
import type { ReceiptReviewEdit, ReceiptReviewRecord } from '../domain/receiptReview';
import { layoutDefinitionSlots, type LayoutTemplateClient, type LayoutTemplate } from './layoutTemplateClient';

const hash = 'a'.repeat(64);
const layout: LayoutDefinition = { schema_version: 1, layout_id: 'layout', revision: 1, workspace_id: 'workspace', issuer_id: 'bank', family_id: 'three', evidence_version: 'v1',
  page_geometry: { pdf_box: { x0: 0, y0: 0, x1: 600, y1: 900 }, rotation: 0, user_unit: 1, width_pt: 600, height_pt: 900 },
  uniform_height: false, left_pt: 0, right_pt: 0, slots: [0, 1, 2].map((i) => ({ slot_id: `slot-${i}`, position_index: i + 1, top_pt: i * 300, height_pt: 290 })) };
export function calibrationSession(revision = 'r'): ReceiptReviewSession {
  return { prepared: { prepared: { result_revision: revision, context_key: hash }, binding: { job: { id: 'job', result_revision: revision,
    sources: [{ source_key: '/a.pdf', access_path: '/a.pdf', sha256: hash, page_count: 51, name: '合成回单.pdf' }] } } },
  items: Array.from({ length: 51 }, (_, i) => ({ original: { id: `${revision}-${i}`, source_key: '/a.pdf', source_page: i + 1, slot_id: 'slot-1', position_index: 2,
    page_geometry: layout.page_geometry, candidate_rect: { x0: 0, y0: 300, x1: 600, y1: 590 }, needs_review: true }, record: null, record_revision: 0 })) } as unknown as ReceiptReviewSession;
}
const prepare: ReceiptLayoutPreparation = { schema_version: 1, job_id: 'job', result_revision: 'r', sample_id: 'r-2', context_key: hash,
  selected_slot_id: 'slot-1', preparation_fingerprint: hash, layout_definition: layout, scope_kind: 'verified_layout',
  pages: Array.from({ length: 51 }, (_, i) => ({ source_key: '/a.pdf', page: i + 1 })), page_count: 51, source_count: 1, excluded_page_counts: {} };
const result = (): ReceiptLayoutPreview => ({ schema_version: 1, job_id: 'job', result_revision: 'r', sample_id: 'r-2', operation_id: 'op', preview_fingerprint: hash,
  layout_definition: layout, can_save: true, saved: false, page_count: 51, candidate_count: 51,
  affected: Array.from({ length: 51 }, (_, i) => ({ source_key: '/a.pdf', page: i + 1, slot_id: 'slot-1', id: `new-${i}`, previous_id: `r-${i}`,
    before_rect: { x0: 0, y0: 300, x1: 600, y1: 590 }, after_rect: { x0: 0, y0: 302, x1: 600, y1: 590 }, status: 'updated' })),
  risks: [], blockers: [], retained_record_ids: [], included_exception_ids: [] });
const templateResult = (): ReceiptLayoutPreview => ({ ...result(), mode: 'template_apply', template_id: 'saved-template',
  applied_slot_ids: ['slot-1'], excluded_page_counts: { prior_review_scope: 1 }, template_allowed: false });
const applied = { schema_version: 1, job_id: 'job', operation_id: 'op', state: 'applied', result_revision: 'next', saved_count: 51 };
const undone = (undoId: string): ReceiptLayoutUndo => ({ schema_version: 1, job_id: 'job', operation_id: 'op',
  undo_id: undoId, state: 'undone', result_revision: 'restored', saved_count: 0, restored_count: 51, template_withdrawal: null });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
function persistEdits(session: ReceiptReviewSession, edits: ReceiptReviewEdit[]) {
  for (const edit of edits) {
    const item = session.items.find((item) => item.original.id === edit.id)!;
    item.record_revision = edit.record_revision + 1;
    item.record = { schema_version: 1, context_key: edit.context_key, result_revision: edit.result_revision,
      record_revision: item.record_revision, original: item.original, source_path: item.original.source_key,
      source_sha256: hash, final_rect: edit.final_rect, crop_mode: edit.crop_mode, review_status: edit.review_status,
      manual_adjusted: edit.manual_adjusted, reviewed_at: edit.reviewed_at,
      ...(edit.document_type !== undefined ? { document_type: edit.document_type } : {}) };
    if (edit.document_type !== undefined) item.page_notice = edit.document_type === 'ordinary' ? undefined
      : { code: 'special_document', document_type: edit.document_type };
  }
}
function selectionSetup(session = calibrationSession()) {
  const stored = structuredClone(session);
  const reload = vi.fn(async () => structuredClone(stored));
  const batch = { saveReview: vi.fn(async (_prepared: unknown, edits: ReceiptReviewEdit[]): Promise<{
    status: 'ok'; data: { saved_count: number; segments?: ReceiptReviewRecord[] };
  }> => {
    persistEdits(stored, edits);
    return { status: 'ok', data: { saved_count: edits.length,
      segments: edits.map((edit) => structuredClone(stored.items.find((item) => item.original.id === edit.id)!.record!)) } };
  }) };
  const controller = new ReceiptCalibrationController({} as ReceiptLayoutClient, reload, batch as unknown as ReceiptBatchClient);
  controller.bind(session);
  return { controller, stored, batch, reload };
}
function setRecord(session: ReceiptReviewSession, index: number, status: ReceiptReviewRecord['review_status'],
  overrides: Partial<ReceiptReviewRecord> = {}) {
  const item = session.items[index];
  item.record = { schema_version: 1, context_key: hash, result_revision: 'r', record_revision: 3,
    original: item.original, source_path: item.original.source_key, source_sha256: hash,
    final_rect: item.original.candidate_rect, crop_mode: 'candidate', review_status: status,
    manual_adjusted: false, reviewed_at: '2026-09-23T12:00:00.000Z', ...overrides };
  item.record_revision = item.record.record_revision;
}
function setup(templates?: LayoutTemplateClient) {
  const client = { prepare: vi.fn().mockResolvedValue(prepare), preview: vi.fn().mockResolvedValue(result()),
    templateApplyPreview: vi.fn().mockResolvedValue(templateResult()),
    save: vi.fn().mockResolvedValue(applied), status: vi.fn().mockResolvedValue(applied), cancel: vi.fn().mockResolvedValue(undefined),
    undo: vi.fn().mockImplementation(async (_operation, undoId: string) => undone(undoId)) };
  const reload = vi.fn().mockResolvedValue(calibrationSession('next'));
  const controller = new ReceiptCalibrationController(client as unknown as ReceiptLayoutClient, reload, undefined, templates);
  controller.bind(calibrationSession()); controller.select('r-2');
  return { controller, client, reload };
}

describe('complete calibration round', () => {
  it('previews a template against the existing result, then opens its changed candidates for review', async () => {
    const { controller, client, reload } = setup();
    await controller.applyTemplate('saved-template');
    expect(client.prepare).not.toHaveBeenCalled();
    expect(client.templateApplyPreview).toHaveBeenCalledWith(expect.objectContaining({ prepared: expect.objectContaining({ result_revision: 'r' }) }),
      'saved-template', expect.any(AbortSignal));
    expect(controller.getSnapshot()).toMatchObject({ phase: 'preview', selectedId: 'r-2', previewIndex: 2,
      preparation: null, draft: null, rememberReference: false, preview: { mode: 'template_apply', template_id: 'saved-template' } });
    controller.setRememberReference(true);
    expect(controller.getSnapshot().rememberReference).toBe(false);
    await controller.save();
    expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ mode: 'template_apply' }), [], false, null, 'create', null, null);
    expect(reload).toHaveBeenCalledWith('job', 'next');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'saved', reviewFilter: 'pending', selectedId: 'next-0' });
    await controller.leave();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'results', reviewFilter: 'pending', selectedId: 'next-0' });
  });

  it('discards an unsaved template preview and never enters an editing draft', async () => {
    const { controller, client } = setup();
    await controller.applyTemplate('saved-template');
    await controller.revise();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'results', preview: null, preparation: null, draft: null });
    expect(client.cancel).toHaveBeenCalledWith(expect.objectContaining({ mode: 'template_apply' }));
  });

  it('ignores a stale template preview after switching tasks', async () => {
    const { controller, client } = setup();
    const late = deferred<ReceiptLayoutPreview>();
    client.templateApplyPreview.mockReturnValueOnce(late.promise);
    const pending = controller.applyTemplate('saved-template');
    controller.bind(calibrationSession('new-task'));
    late.resolve(templateResult()); await pending;
    expect(controller.getSnapshot()).toMatchObject({ phase: 'results', preview: null, selectedId: 'new-task-0' });
  });

  it('returns to results without a write when template matching fails', async () => {
    const { controller, client } = setup();
    client.templateApplyPreview.mockRejectedValueOnce(new Error('没有可匹配的普通回单'));
    await controller.applyTemplate('saved-template');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'results', preview: null, error: '没有可匹配的普通回单' });
    expect(client.save).not.toHaveBeenCalled();
  });

  it('requires a selected compatible update target and freezes it across recovery', async () => {
    const template = { id: 'saved', version: 3, name: '已有模板', bank_name: '示例银行', active: true,
      page_geometry: layout.page_geometry, slots: layoutDefinitionSlots(layout),
      evidence_summary: { layout_definition: layout }, source_scope: 'scope', layout_fingerprint: hash,
      source_operation_id: 'previous', created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z' } satisfies LayoutTemplate;
    const list = vi.fn().mockResolvedValueOnce({ items: [{ ...template, id: 'wrong-bank', evidence_summary: { layout_definition: { ...layout, issuer_id: 'other' } } }], total: 2, next_offset: 1 })
      .mockResolvedValueOnce({ items: [template], total: 2, next_offset: null });
    const { controller, client } = setup({ list } as unknown as LayoutTemplateClient);
    await controller.begin(); await controller.generatePreview(); controller.setRememberReference(true);
    expect(controller.getSnapshot().templateSaveMode).toBe('create');
    await controller.setTemplateSaveMode('update');
    expect(list.mock.calls.map(([input]) => input.offset)).toEqual([0, 1]);
    expect(controller.getSnapshot().templateCandidates.map((item) => item.id)).toEqual(['saved']);
    await controller.save(); expect(client.save).not.toHaveBeenCalled();
    controller.selectTemplate('wrong-bank'); expect(controller.getSnapshot().templateId).toBeNull();
    controller.selectTemplate('saved');
    client.save.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ ...applied, reference_state: 'saved' });
    await controller.save();
    await controller.setTemplateSaveMode('create'); controller.setTemplateBankName('变化银行'); controller.selectTemplate('wrong-bank');
    await controller.recover();
    expect(client.save.mock.calls[0].slice(2)).toEqual([true, '已有模板', 'update', 'saved', '示例银行']);
    expect(client.save.mock.calls[1]).toEqual(client.save.mock.calls[0]);
  });
  it('retains update intent after candidate loading fails and allows an explicit retry', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('模板库暂时不可用')).mockResolvedValueOnce({ items: [], total: 0, next_offset: null });
    const { controller, client } = setup({ list } as unknown as LayoutTemplateClient);
    await controller.begin(); await controller.generatePreview(); controller.setRememberReference(true);
    await controller.setTemplateSaveMode('update');
    expect(controller.getSnapshot()).toMatchObject({ templateSaveMode: 'update', templateCandidatesStatus: 'error', templateCandidatesError: '模板库暂时不可用' });
    await controller.save(); expect(client.save).not.toHaveBeenCalled();
    await controller.loadTemplateCandidates();
    expect(controller.getSnapshot()).toMatchObject({ templateSaveMode: 'update', templateCandidatesStatus: 'ready', templateCandidates: [] });
  });
  it('discards an old candidate read when returning to edit and reloads candidates for the next preview', async () => {
    const pending = deferred<{ items: LayoutTemplate[]; total: number; next_offset: null }>();
    const list = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ items: [], total: 0, next_offset: null });
    const { controller } = setup({ list } as unknown as LayoutTemplateClient);
    await controller.begin(); await controller.generatePreview(); controller.setRememberReference(true);
    const loading = controller.setTemplateSaveMode('update');
    await controller.revise(); await controller.generatePreview();
    expect(list).toHaveBeenCalledTimes(2);
    pending.resolve({ items: [], total: 0, next_offset: null }); await loading;
    expect(controller.getSnapshot()).toMatchObject({ phase: 'preview', templateSaveMode: 'update', templateCandidatesStatus: 'ready' });
  });
  it('unlocks an uncommitted update after recovery confirms preview state and requires a new target choice', async () => {
    const template = { id: 'old', version: 1, name: '已有模板', bank_name: '示例银行', active: true,
      page_geometry: layout.page_geometry, slots: layoutDefinitionSlots(layout), evidence_summary: { layout_definition: layout },
      source_scope: 'scope', layout_fingerprint: hash, source_operation_id: 'previous',
      created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z' } satisfies LayoutTemplate;
    const list = vi.fn().mockResolvedValueOnce({ items: [template], total: 1, next_offset: null })
      .mockResolvedValueOnce({ items: [{ ...template, id: 'latest', version: 2 }], total: 1, next_offset: null });
    const { controller, client } = setup({ list } as unknown as LayoutTemplateClient);
    await controller.begin(); await controller.generatePreview(); controller.setRememberReference(true);
    await controller.setTemplateSaveMode('update'); controller.selectTemplate('old');
    client.save.mockRejectedValueOnce(new Error('所选模板已更新'));
    client.status.mockResolvedValueOnce({ ...applied, state: 'preview', result_revision: 'r', saved_count: 0 });
    await controller.save(); expect(controller.getSnapshot().phase).toBe('uncertain');
    await controller.recover();
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'preview', writeAction: null, templateId: null, templateCandidatesStatus: 'ready' });
    expect(controller.getSnapshot().templateCandidates.map((item) => item.id)).toEqual(['latest']);
    controller.selectTemplate('latest'); await controller.save();
    expect(client.save.mock.calls[1][5]).toBe('latest');
    expect(controller.getSnapshot().phase).toBe('saved');
  });
  it('classifies only selected fragments, resetting approval and preserving all geometry', async () => {
    const session = calibrationSession();
    setRecord(session, 0, 'confirmed');
    const { controller, batch, stored } = selectionSetup(session);
    await controller.classifySelection(['r-0', 'r-2'], 'other_special');
    expect(controller.getSnapshot().error).toBeNull();
    expect(batch.saveReview.mock.calls[0][1]).toEqual(['r-0', 'r-2'].map((id) => expect.objectContaining({
      id, document_type: 'other_special', review_status: 'needs_review', crop_mode: 'candidate', manual_adjusted: false,
      final_rect: session.items[0].original.candidate_rect,
    })));
    expect(stored.items[1].record).toBeNull();
    expect(controller.getSnapshot().session?.items[0].page_notice?.document_type).toBe('other_special');
  });
  it('acknowledges the automatic special type without creating a manual override', async () => {
    const session = calibrationSession();
    session.items[0].page_notice = { code: 'special_document', document_type: 'loan_interest_notice' };
    const { controller, batch } = selectionSetup(session);
    await controller.classifySelection(['r-0'], 'loan_interest_notice', true);
    expect(controller.getSnapshot().error).toBeNull();
    expect(batch.saveReview.mock.calls[0][1][0]).toMatchObject({ review_status: 'confirmed' });
    expect(batch.saveReview.mock.calls[0][1][0]).not.toHaveProperty('document_type');
  });
  it('confirms an already full-page crop without converting fragment geometry into full-page crops', async () => {
    const session = calibrationSession();
    setRecord(session, 0, 'needs_review', { crop_mode: 'full_page', final_rect: null });
    const { controller, batch } = selectionSetup(session);
    await controller.classifySelection(['r-0', 'r-1'], 'other_special', true);
    expect(controller.getSnapshot().error).toBeNull();
    expect(batch.saveReview.mock.calls[0][1]).toEqual([
      expect.objectContaining({ id: 'r-0', crop_mode: 'full_page', final_rect: null, review_status: 'page_confirmed' }),
      expect.objectContaining({ id: 'r-1', crop_mode: 'candidate', final_rect: session.items[1].original.candidate_rect, review_status: 'confirmed' }),
    ]);
  });
  it('does not mistake a saved approval with the wrong classification for success', async () => {
    const { controller, batch, stored } = selectionSetup();
    batch.saveReview.mockImplementationOnce(async (_prepared, edits) => {
      persistEdits(stored, edits.map((edit) => ({ ...edit, document_type: 'loan_interest_notice' })));
      throw new Error('response lost');
    });
    await controller.classifySelection(['r-0'], 'other_special', true);
    expect(controller.getSnapshot().reviewNotice).toBeNull();
    expect(controller.getSnapshot().error).toContain('0/1');
  });
  it('keeps manual classification through confirm, exclude and restore, and allows returning to ordinary', async () => {
    const { controller, stored, batch } = selectionSetup();
    await controller.classifySelection(['r-0'], 'other_special');
    await controller.reviewSelection(['r-0'], 'confirm');
    await controller.reviewSelection(['r-0'], 'exclude');
    await controller.reviewSelection(['r-0'], 'restore');
    expect(batch.saveReview.mock.calls.map((call) => call[1][0].document_type)).toEqual(Array(4).fill('other_special'));
    expect(stored.items[0].record?.review_status).toBe('needs_review');
    await controller.classifySelection(['r-0'], 'ordinary');
    expect(controller.getSnapshot().error).toBeNull();
    expect(stored.items[0].record?.document_type).toBe('ordinary');
    expect(stored.items[0].page_notice).toBeUndefined();
    expect(stored.items[0].record?.review_status).toBe('needs_review');
  });
  it('classifies blocked fragments without unlocking them and refuses excluded or invalid classifications', async () => {
    const session = calibrationSession(); setRecord(session, 0, 'blocked'); setRecord(session, 1, 'excluded');
    const { controller, stored, batch } = selectionSetup(session);
    await controller.classifySelection(['r-0'], 'other_special');
    expect(stored.items[0].record).toMatchObject({ document_type: 'other_special', review_status: 'blocked' });
    await controller.classifySelection(['r-0'], 'other_special', true);
    await controller.classifySelection(['r-1'], 'other_special');
    await controller.classifySelection(['r-2'], 'invalid' as never);
    await controller.reviewSelection(['r-0'], 'confirm');
    expect(batch.saveReview).toHaveBeenCalledTimes(1);
  });
  it('recovers a lost classification response by comparing persisted type as well as approval', async () => {
    const { controller, batch, stored } = selectionSetup();
    batch.saveReview.mockImplementationOnce(async (_prepared, edits) => { persistEdits(stored, edits); throw new Error('response lost'); });
    await controller.classifySelection(['r-0'], 'other_special', true);
    expect(controller.getSnapshot().error).toBeNull();
    expect(controller.getSnapshot().session?.items[0].record).toMatchObject({ document_type: 'other_special', review_status: 'confirmed' });
    await controller.classifySelection(['r-0'], 'other_special', true);
    expect(batch.saveReview).toHaveBeenCalledTimes(1);
  });
  it('rejects a concurrent change of type before a stale selection can write', async () => {
    const { controller, batch, stored } = selectionSetup();
    persistEdits(stored, [{ ...({} as ReceiptReviewEdit), id: 'r-0', document_type: 'other_special', review_status: 'needs_review',
      record_revision: 0, final_rect: stored.items[0].original.candidate_rect, crop_mode: 'candidate', manual_adjusted: false }]);
    await controller.classifySelection(['r-0'], 'loan_interest_notice');
    expect(batch.saveReview).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).not.toBeNull();
  });
  it('restricts a protected draft to its single slot and refuses template saving', async () => {
    const { controller, client } = setup();
    client.prepare.mockResolvedValue({ ...prepare, page_count: 1, pages: [prepare.pages[2]], editable_slot_ids: ['slot-1'], template_allowed: false });
    await controller.begin();
    controller.selectSlot('slot-0');
    expect(controller.getSnapshot().selectedSlotId).toBe('slot-1');
    const change = structuredClone(layout); change.slots[1].height_pt = 285;
    controller.change(change);
    expect(controller.getSnapshot().draft?.slots[1].height_pt).toBe(285);
    controller.change({ ...change, left_pt: 5 });
    controller.change({ ...change, uniform_height: true });
    const other = structuredClone(change); other.slots[0].height_pt = 280; controller.change(other);
    expect(controller.getSnapshot().draft).toEqual({ ...change, revision: 2 });
    controller.setRememberReference(true);
    expect(controller.getSnapshot().rememberReference).toBe(false);
  });
  it('filters special documents while isolating bulk confirmation by document type', async () => {
    const session = calibrationSession();
    session.items[1].page_notice = { code: 'special_document', document_type: 'loan_interest_notice' };
    session.items[2].page_notice = { code: 'special_document', document_type: 'electronic_tax_payment' };
    session.items[3].page_notice = { code: 'special_document', document_type: 'loan_interest_notice' };
    session.items[4].page_notice = { code: 'special_document', document_type: 'loan_interest_notice' };
    session.items[4].original.layout_id = 'a-distinct-layout';
    const client = { prepare: vi.fn().mockResolvedValue(prepare) };
    const controller = new ReceiptCalibrationController(client as unknown as ReceiptLayoutClient, vi.fn());
    controller.bind(session);
    controller.setReviewFilter('special');
    expect(controller.getSnapshot().selectedId).toBe('r-1');
    expect(pendingReceiptGroup(session, 'r-1').map((item) => item.original.id)).toEqual(['r-1', 'r-3']);
    expect(pendingReceiptGroup(session, 'r-2').map((item) => item.original.id)).toEqual(['r-2']);
    expect(pendingReceiptGroup(session, 'r-0').map((item) => item.original.id)).not.toContain('r-1');
    await controller.begin();
    expect(client.prepare.mock.calls[0][1]).toBe('r-1');
  });
  it('groups pending confirmation across other-slot differences without copying frames or crossing sources and page sizes', () => {
    const session = calibrationSession();
    session.items[1].original.layout_signature = 'different-other-slot-layout';
    session.items[1].original.candidate_rect = { ...session.items[1].original.candidate_rect, y1: 588 };
    session.items[2].original.source_key = '/other.pdf';
    session.items[3].original.page_geometry = { ...layout.page_geometry, height_pt: 800 };
    session.items[4].original.position_index = 1;
    const ids = pendingReceiptGroup(session, 'r-0').map((item) => item.original.id);
    expect(ids).toContain('r-1');
    expect(ids).not.toContain('r-2'); expect(ids).not.toContain('r-3'); expect(ids).not.toContain('r-4');
    expect(session.items[1].original.candidate_rect.y1).toBe(588);
  });
  it('confirms only the explicit pending layout position and reloads persisted records', async () => {
    const session = calibrationSession();
    session.items[1].original.position_index = 3;
    const saved = structuredClone(session);
    saved.items[0].record = { review_status: 'confirmed', record_revision: 1,
      final_rect: session.items[0].original.candidate_rect, crop_mode: 'candidate', manual_adjusted: false } as any;
    saved.items[0].record_revision = 1;
    const reload = vi.fn().mockResolvedValueOnce(session).mockResolvedValueOnce(saved);
    const batch = { saveReview: vi.fn().mockResolvedValue({ status: 'ok', data: { saved_count: 1 } }) };
    const controller = new ReceiptCalibrationController({} as ReceiptLayoutClient, reload, batch as unknown as ReceiptBatchClient);
    controller.bind(session); controller.setReviewFilter('pending');
    await controller.confirmPending(['r-0', 'r-1']);
    expect(batch.saveReview).not.toHaveBeenCalled();
    await Promise.all([controller.confirmPending(['r-0']), controller.confirmPending(['r-0'])]);
    expect(batch.saveReview).toHaveBeenCalledTimes(1);
    expect(batch.saveReview.mock.calls[0][1]).toEqual([expect.objectContaining({ id: 'r-0', crop_mode: 'candidate', review_status: 'confirmed', manual_adjusted: false, final_rect: session.items[0].original.candidate_rect })]);
    expect(controller.getSnapshot()).toMatchObject({ reviewConfirming: false, reviewFilter: 'pending', reviewNotice: '本批 1 处已确认。', selectedId: 'r-1' });
  });
  it('reads current confirmation before retrying a lost response and does not write it twice', async () => {
    const session = calibrationSession(), saved = structuredClone(session);
    saved.items[0].record = { review_status: 'confirmed', record_revision: 1,
      final_rect: session.items[0].original.candidate_rect, crop_mode: 'candidate', manual_adjusted: false } as any;
    saved.items[0].record_revision = 1;
    const reload = vi.fn().mockResolvedValueOnce(session).mockResolvedValue(saved);
    const batch = { saveReview: vi.fn().mockRejectedValue(new Error('response lost')) };
    const controller = new ReceiptCalibrationController({} as ReceiptLayoutClient, reload, batch as unknown as ReceiptBatchClient);
    controller.bind(session);
    await controller.confirmPending(['r-0']);
    expect(controller.getSnapshot().error).toBeNull();
    await controller.confirmPending(['r-0']);
    expect(batch.saveReview).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().session?.items[0].record?.review_status).toBe('confirmed');
  });
  it('excludes and restores only the selected item while preserving its saved geometry', async () => {
    const session = calibrationSession();
    const fresh = structuredClone(session);
    const excluded = structuredClone(session);
    const restored = structuredClone(session);
    const savedRecord = (status: 'excluded' | 'needs_review', revision: number) => ({
      schema_version: 1, context_key: hash, result_revision: 'r', record_revision: revision,
      source_path: '/a.pdf', source_sha256: hash, original: session.items[0]!.original,
      final_rect: session.items[0]!.original.candidate_rect, crop_mode: 'candidate', review_status: status,
      manual_adjusted: false, reviewed_at: '2026-09-20T12:00:00.000Z',
    });
    excluded.items[0]!.record = savedRecord('excluded', 1) as any; excluded.items[0]!.record_revision = 1;
    restored.items[0]!.record = savedRecord('needs_review', 2) as any; restored.items[0]!.record_revision = 2;
    const reload = vi.fn().mockResolvedValueOnce(fresh).mockResolvedValueOnce(excluded)
      .mockResolvedValueOnce(excluded).mockResolvedValueOnce(restored);
    const batch = { saveReview: vi.fn().mockResolvedValue({ status: 'ok', data: { saved_count: 1 } }) };
    const controller = new ReceiptCalibrationController({} as ReceiptLayoutClient, reload, batch as unknown as ReceiptBatchClient);
    controller.bind(session); controller.select('r-0');
    await controller.excludeSelected();
    expect(batch.saveReview.mock.calls[0][1]).toEqual([expect.objectContaining({ id: 'r-0', review_status: 'excluded',
      final_rect: session.items[0]!.original.candidate_rect, crop_mode: 'candidate', manual_adjusted: false })]);
    expect(controller.getSnapshot().session?.items[0]?.record?.review_status).toBe('excluded');
    expect(controller.getSnapshot().reviewNotice).toBe('已排除此片段。');
    await controller.restoreExcluded();
    expect(batch.saveReview).toHaveBeenCalledTimes(2);
    expect(batch.saveReview.mock.calls[1][1]).toEqual([expect.objectContaining({ id: 'r-0', review_status: 'needs_review',
      final_rect: session.items[0]!.original.candidate_rect, crop_mode: 'candidate', manual_adjusted: false })]);
    expect(controller.getSnapshot().session?.items[0]?.record?.review_status).toBe('needs_review');
    expect(controller.getSnapshot().reviewNotice).toBe('已恢复待复核，请重新核对。');
    expect(controller.getSnapshot().session?.items[1]?.record).toBeNull();
  });
  it('accepts an authoritative exclusion when the backend reorders rectangle keys', async () => {
    const session = calibrationSession();
    session.items[0]!.original.candidate_rect = { x0: 0, x1: 600, y0: 300, y1: 590 };
    const fresh = structuredClone(session);
    const persisted = structuredClone(session);
    persisted.items[0]!.record = {
      review_status: 'excluded', record_revision: 1,
      final_rect: { x0: 0, y0: 300, x1: 600, y1: 590 }, crop_mode: 'candidate', manual_adjusted: false,
    } as any;
    persisted.items[0]!.record_revision = 1;
    const reload = vi.fn().mockResolvedValueOnce(fresh).mockResolvedValue(persisted);
    const batch = { saveReview: vi.fn().mockResolvedValue({ status: 'ok', data: { saved_count: 1 } }) };
    const controller = new ReceiptCalibrationController({} as ReceiptLayoutClient, reload, batch as unknown as ReceiptBatchClient);
    controller.bind(session); controller.select('r-0'); await controller.excludeSelected();
    expect(batch.saveReview).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().reviewNotice).toBe('已排除此片段。');
    expect(controller.getSnapshot().error).toBeNull();
  });
  it('rejects an authoritative exclusion when a rectangle coordinate changes', async () => {
    const session = calibrationSession();
    const fresh = structuredClone(session);
    const changed = structuredClone(session);
    changed.items[0]!.record = {
      review_status: 'excluded', record_revision: 1,
      final_rect: { x0: 1, y0: 300, x1: 600, y1: 590 }, crop_mode: 'candidate', manual_adjusted: false,
    } as any;
    changed.items[0]!.record_revision = 1;
    const reload = vi.fn().mockResolvedValueOnce(fresh).mockResolvedValue(changed);
    const batch = { saveReview: vi.fn().mockResolvedValue({ status: 'ok', data: { saved_count: 1 } }) };
    const controller = new ReceiptCalibrationController({} as ReceiptLayoutClient, reload, batch as unknown as ReceiptBatchClient);
    controller.bind(session); controller.select('r-0'); await controller.excludeSelected();
    expect(batch.saveReview).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().reviewNotice).toBeNull();
    expect(controller.getSnapshot().error).toContain('权威结果未确认');
  });
  it('recognizes a written exclusion after a lost response without writing it twice', async () => {
    const session = calibrationSession(); const written = structuredClone(session);
    written.items[0]!.record = { review_status: 'excluded', record_revision: 1, final_rect: session.items[0]!.original.candidate_rect,
      crop_mode: 'candidate', manual_adjusted: false } as any; written.items[0]!.record_revision = 1;
    const reload = vi.fn().mockResolvedValueOnce(session).mockResolvedValueOnce(written);
    const batch = { saveReview: vi.fn().mockRejectedValue(new Error('response lost')) };
    const controller = new ReceiptCalibrationController({} as ReceiptLayoutClient, reload, batch as unknown as ReceiptBatchClient);
    controller.bind(session); controller.select('r-0'); await controller.excludeSelected();
    expect(batch.saveReview).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().session?.items[0]?.record?.review_status).toBe('excluded');
    expect(controller.getSnapshot().error).toBeNull();
  });
  it('re-reads a target already written before retrying an initial read failure', async () => {
    const session = calibrationSession(); const written = structuredClone(session);
    written.items[0]!.record = { review_status: 'excluded', record_revision: 1, final_rect: session.items[0]!.original.candidate_rect,
      crop_mode: 'candidate', manual_adjusted: false } as any; written.items[0]!.record_revision = 1;
    const reload = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce(written);
    const batch = { saveReview: vi.fn() };
    const controller = new ReceiptCalibrationController({} as ReceiptLayoutClient, reload, batch as unknown as ReceiptBatchClient);
    controller.bind(session); controller.select('r-0'); await controller.excludeSelected();
    expect(batch.saveReview).not.toHaveBeenCalled();
    expect(controller.getSnapshot().reviewNotice).toBe('已排除此片段。');
  });
  it('does not announce exclusion when the authoritative reload keeps another status or geometry', async () => {
    const session = calibrationSession(); const unchanged = structuredClone(session);
    unchanged.items[0]!.record = { review_status: 'needs_review', record_revision: 1,
      final_rect: { x0: 1, y0: 301, x1: 600, y1: 590 }, crop_mode: 'candidate', manual_adjusted: false } as any;
    const reload = vi.fn().mockResolvedValueOnce(session).mockResolvedValue(unchanged);
    const batch = { saveReview: vi.fn().mockResolvedValue({ status: 'ok', data: { saved_count: 1 } }) };
    const controller = new ReceiptCalibrationController({} as ReceiptLayoutClient, reload, batch as unknown as ReceiptBatchClient);
    controller.bind(session); controller.select('r-0'); await controller.excludeSelected();
    expect(controller.getSnapshot().reviewNotice).toBeNull();
    expect(controller.getSnapshot().error).toContain('权威结果未确认');
  });
  it('keeps the chosen middle sample, previews all 51 then saves once and reloads the next revision', async () => {
    const { controller, client, reload } = setup();
    await controller.begin();
    expect(client.prepare.mock.calls[0][1]).toBe('r-2');
    expect(controller.getSnapshot().selectedId).toBe('r-2');
    controller.changeRect({ x0: 0, y0: 302, x1: 600, y1: 590 });
    controller.changeRect({ x0: 0, y0: 303, x1: 600, y1: 591 });
    await controller.save(); // Editing has no write entry point.
    expect(client.save).not.toHaveBeenCalled(); expect(client.preview).not.toHaveBeenCalled();
    await controller.generatePreview();
    expect(controller.getSnapshot().preview?.affected).toHaveLength(51);
    controller.selectPreview(50);
    expect(controller.getSnapshot().previewIndex).toBe(50);
    await Promise.all([controller.save(), controller.save()]);
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith('job', 'next');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'saved', selectedId: 'next-2', operation: { saved_count: 51 } });
    controller.select('next-3'); await controller.begin();
    expect(client.prepare.mock.calls[1][1]).toBe('next-3');
  });
  it('does not overwrite a new session when old preparation completes late', async () => {
    const { controller, client } = setup(), late = deferred<ReceiptLayoutPreparation>();
    client.prepare.mockReturnValue(late.promise);
    const pending = controller.begin();
    controller.bind(calibrationSession('new-job-result'));
    late.resolve(prepare); await pending;
    expect(controller.getSnapshot()).toMatchObject({ phase: 'results', preparation: null, selectedId: 'new-job-result-0' });
  });
  it('keeps the draft and does not save when preview fails', async () => {
    const { controller, client } = setup();
    await controller.begin(); controller.changeRect({ x0: 0, y0: 302, x1: 600, y1: 590 });
    client.preview.mockRejectedValue(new Error('source changed'));
    await controller.generatePreview();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'editing', error: 'source changed' });
    expect(controller.getSnapshot().draft?.slots[1].top_pt).toBe(302);
    expect(client.save).not.toHaveBeenCalled();
  });
  it('keeps the history preference with the round and forwards an explicit opt-out', async () => {
    const { controller, client } = setup();
    await controller.begin(); await controller.generatePreview();
    controller.setRememberReference(false);
    expect(controller.getSnapshot().rememberReference).toBe(false);
    await controller.save();
    expect(client.save.mock.calls[0][2]).toBe(false);
  });
  it('defaults each new round to no template and validates an explicitly requested name', async () => {
    const { controller, client } = setup();
    expect(controller.getSnapshot().rememberReference).toBe(false);
    await controller.begin(); await controller.generatePreview();
    expect(controller.getSnapshot()).toMatchObject({ rememberReference: false, templateName: '3栏回单模板' });
    controller.setRememberReference(true);
    for (const name of ['', '   ', 'a'.repeat(257), 'a\0b']) {
      controller.setTemplateName(name); await controller.save();
      expect(controller.getSnapshot().phase).toBe('preview');
      expect(controller.getSnapshot().error).toContain('模板名称');
    }
    expect(client.save).not.toHaveBeenCalled();
    controller.setTemplateName('  常用模板  '); await controller.save();
    expect(client.save.mock.calls[0].slice(2)).toEqual([true, '常用模板', 'create', null, null]);
    await controller.begin();
    expect(controller.getSnapshot()).toMatchObject({ rememberReference: false, templateName: '3栏回单模板' });
  });
  it('keeps template preference and name frozen while recovering an applied operation', async () => {
    const { controller, client } = setup();
    await controller.begin(); await controller.generatePreview();
    controller.setRememberReference(true); controller.setTemplateName('原始名称');
    client.save.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ ...applied, reference_state: 'saved' });
    await controller.save();
    controller.setRememberReference(false); controller.setTemplateName('后来的名称');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'uncertain', rememberReference: true, templateName: '原始名称' });
    await controller.recover();
    expect(client.save).toHaveBeenCalledTimes(2);
    expect(client.save.mock.calls[0]).toEqual(client.save.mock.calls[1]);
    expect(controller.getSnapshot().operation?.reference_state).toBe('saved');
  });
  it('retries only the same failed template operation without a new calibration round', async () => {
    const { controller, client } = setup();
    client.save.mockResolvedValueOnce({ ...applied, reference_state: 'failed' }).mockResolvedValueOnce({ ...applied, reference_state: 'saved' });
    await controller.begin(); await controller.generatePreview();
    controller.setRememberReference(true); await controller.save();
    expect(controller.getSnapshot().phase).toBe('saved');
    await Promise.all([controller.retryTemplateSave(), controller.retryTemplateSave()]);
    expect(client.save).toHaveBeenCalledTimes(2);
    expect(client.save.mock.calls[0]).toEqual(client.save.mock.calls[1]);
    expect(client.preview).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().operation?.reference_state).toBe('saved');
  });
  it.each(['shared_geometry_changed', 'template_geometry_conflict', 'operation_inactive', 'identity_unavailable', 'invalid_reference'] as const)('does not resubmit deterministic template failure %s', async (code) => {
    const { controller, client } = setup();
    client.save.mockResolvedValueOnce({ ...applied, reference_state: 'failed', reference_error_code: code });
    await controller.begin(); await controller.generatePreview();
    controller.setRememberReference(true); await controller.save();
    await controller.retryTemplateSave();
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().operation?.reference_error_code).toBe(code);
  });
  it('preserves an uncertain write token, locks leaving, and recovers without another save', async () => {
    const { controller, client } = setup();
    await controller.begin(); await controller.generatePreview();
    client.save.mockRejectedValueOnce(new Error('lost response'));
    await controller.save(); await controller.leave(); controller.change(layout);
    expect(controller.getSnapshot().phase).toBe('uncertain');
    await controller.recover();
    expect(client.status).toHaveBeenCalledWith(expect.objectContaining({ operation_id: 'op' }));
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe('saved');
  });
  it('replays the same committed operation to finish review projection and then reloads', async () => {
    const { controller, client, reload } = setup();
    await controller.begin(); await controller.generatePreview();
    client.save.mockRejectedValueOnce(new Error('projection temporarily unavailable'));
    client.status.mockResolvedValue({ ...applied, state: 'committed', saved_count: 0 });
    await controller.save(); await controller.recover();
    expect(client.save).toHaveBeenCalledTimes(2);
    expect(client.save.mock.calls[0]).toEqual(client.save.mock.calls[1]);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('does not announce completion if saved result reload failed', async () => {
    const { controller, client, reload } = setup();
    await controller.begin(); await controller.generatePreview();
    reload.mockRejectedValueOnce(new Error('read failed'));
    await controller.save();
    expect(controller.getSnapshot().phase).toBe('uncertain');
    expect(controller.getSnapshot().session?.prepared.prepared.result_revision).toBe('r');
    await controller.recover();
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe('saved');
  });
  it('keeps undo pending until the restored session is loaded, then prevents a second undo', async () => {
    const { controller, client, reload } = setup();
    await controller.begin(); await controller.generatePreview(); await controller.save();
    const pendingUndo = deferred<ReceiptLayoutUndo>(), pendingReload = deferred<ReceiptReviewSession>();
    client.undo.mockReturnValueOnce(pendingUndo.promise);
    reload.mockReturnValueOnce(pendingReload.promise);
    const announcedUndo = vi.fn();
    controller.subscribe(() => {
      const state = controller.getSnapshot();
      if (state.phase === 'saved' && state.writeAction === 'undo') announcedUndo();
    });
    const pending = controller.undo();
    const operation = controller.getSnapshot().operation!;
    expect(controller.getSnapshot()).toMatchObject({ phase: 'saving', writeAction: 'undo', preview: null });
    expect(operation.undo_id).toEqual(expect.any(String));
    await controller.begin(); await controller.leave(); await controller.undo();
    expect(client.prepare).toHaveBeenCalledTimes(1);
    expect(client.undo).toHaveBeenCalledTimes(1);
    pendingUndo.resolve(undone(operation.undo_id!));
    await vi.waitFor(() => expect(reload).toHaveBeenLastCalledWith('job', 'restored'));
    expect(controller.getSnapshot()).toMatchObject({ phase: 'saving', writeAction: 'undo', operation });
    expect(controller.getSnapshot().session?.prepared.prepared.result_revision).toBe('next');
    expect(announcedUndo).not.toHaveBeenCalled();
    pendingReload.resolve(calibrationSession('restored')); await pending;
    expect(announcedUndo).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'saved', writeAction: 'undo', operation: null, preview: null });
    expect(controller.getSnapshot().session?.prepared.prepared.result_revision).toBe('restored');
    await controller.undo();
    expect(client.undo).toHaveBeenCalledTimes(1);
    await controller.begin();
    expect(controller.getSnapshot().writeAction).toBeNull();
    await controller.generatePreview(); await controller.save();
    expect(controller.getSnapshot().writeAction).toBe('save');
  });
  it.each(['response lost', 'undo pending', 'reload failed'])('recovers %s by replaying the same undo instead of saving', async (failure) => {
    const { controller, client, reload } = setup();
    await controller.begin(); await controller.generatePreview(); await controller.save();
    if (failure === 'response lost') client.undo.mockRejectedValueOnce(new Error('response lost'));
    if (failure === 'undo pending') client.undo.mockImplementationOnce(async (_operation, undoId: string) => ({ ...undone(undoId), state: 'undo_pending' }));
    if (failure === 'reload failed') reload.mockRejectedValueOnce(new Error('read failed'));
    await controller.undo();
    const operation = controller.getSnapshot().operation!;
    expect(controller.getSnapshot()).toMatchObject({ phase: 'uncertain', writeAction: 'undo', preview: null });
    expect(controller.getSnapshot().error).toContain('撤销结果需要核实');
    expect(operation).toMatchObject({ operation_id: 'op', undo_id: expect.any(String) });
    await controller.leave(); await controller.begin(); await controller.save();
    expect(controller.getSnapshot().phase).toBe('uncertain');
    expect(client.prepare).toHaveBeenCalledTimes(1);
    reload.mockResolvedValueOnce(calibrationSession('restored'));
    await Promise.all([controller.recover(), controller.recover()]);
    expect(client.undo).toHaveBeenCalledTimes(2);
    expect(client.undo.mock.calls[0]).toEqual(client.undo.mock.calls[1]);
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(client.status).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'saved', writeAction: 'undo', operation: null });
    expect(controller.getSnapshot().session?.prepared.prepared.result_revision).toBe('restored');
  });
  it.each(['undo', 'reload'])('ignores a late %s response after binding another session', async (stage) => {
    const { controller, client, reload } = setup();
    await controller.begin(); await controller.generatePreview(); await controller.save();
    const pendingUndo = deferred<ReceiptLayoutUndo>(), pendingReload = deferred<ReceiptReviewSession>();
    if (stage === 'undo') client.undo.mockReturnValueOnce(pendingUndo.promise);
    else reload.mockReturnValueOnce(pendingReload.promise);
    const pending = controller.undo();
    const operation = controller.getSnapshot().operation!;
    if (stage === 'reload') await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    controller.bind(calibrationSession('new-session'));
    if (stage === 'undo') pendingUndo.resolve(undone(operation.undo_id!));
    else pendingReload.resolve(calibrationSession('restored'));
    await pending;
    expect(controller.getSnapshot()).toMatchObject({ phase: 'results', writeAction: null, operation: null, selectedId: 'new-session-0' });
    expect(controller.getSnapshot().session?.prepared.prepared.result_revision).toBe('new-session');
    expect(reload).toHaveBeenCalledTimes(stage === 'undo' ? 1 : 2);
  });
  it('requires each risk to be acknowledged and refreshes acknowledgements after revision', async () => {
    const { controller, client } = setup();
    const preview = result(); preview.risks = [{ risk_id: 'risk', source_key: '/a.pdf', page: 1, diagnostic: { code: 'content_outside_slot' } }];
    client.preview.mockResolvedValue(preview);
    await controller.begin(); await controller.generatePreview(); await controller.save();
    expect(client.save).not.toHaveBeenCalled();
    controller.acknowledge('unknown', true); expect(controller.getSnapshot().acknowledgedRiskIds).toEqual([]);
    controller.acknowledge('risk', true); await controller.revise();
    expect(client.cancel).toHaveBeenCalledTimes(1); expect(controller.getSnapshot().acknowledgedRiskIds).toEqual([]);
  });
  it('acknowledges and clears a validated batch only during the current preview without saving', async () => {
    const { controller, client } = setup();
    const preview = result(); preview.risks = [1, 2, 3].map((page) => ({ risk_id: `risk-${page}`, source_key: '/a.pdf', page, diagnostic: { code: 'content_outside_slots' } }));

    controller.acknowledgeMany(['risk-1'], true);
    expect(controller.getSnapshot().acknowledgedRiskIds).toEqual([]);
    await controller.begin();
    controller.acknowledgeMany(['risk-1'], true);
    expect(controller.getSnapshot().acknowledgedRiskIds).toEqual([]);
    client.preview.mockResolvedValue(preview);
    await controller.generatePreview();

    controller.acknowledgeMany(['risk-1', 'unknown', 'risk-1', 'risk-3'], true);
    expect(controller.getSnapshot().acknowledgedRiskIds).toEqual(['risk-1', 'risk-3']);
    controller.acknowledge('risk-2', true);
    expect(controller.getSnapshot().acknowledgedRiskIds).toEqual(['risk-1', 'risk-3', 'risk-2']);
    controller.acknowledgeMany(['risk-2', 'unknown'], false);
    expect(controller.getSnapshot().acknowledgedRiskIds).toEqual(['risk-1', 'risk-3']);
    await controller.save();
    expect(client.save).not.toHaveBeenCalled();

    controller.acknowledgeMany(['risk-1', 'risk-2', 'risk-3'], true);
    expect(controller.getSnapshot().acknowledgedRiskIds).toHaveLength(3);
    expect(client.save).not.toHaveBeenCalled();
    await controller.revise();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'editing', acknowledgedRiskIds: [] });
    expect(client.save).not.toHaveBeenCalled();
  });
  it('only includes existing manual exceptions after an explicit revision request', async () => {
    const { controller, client } = setup(); const preview = result(); preview.retained_record_ids = ['manual-1'];
    client.preview.mockResolvedValue(preview);
    await controller.begin(); await controller.generatePreview(); await controller.revise(true); await controller.generatePreview();
    expect(client.preview.mock.calls[0][3]).toEqual([]);
    expect(client.preview.mock.calls[1][3]).toEqual(['manual-1']);
  });
  it('retains an overlapping draft for correction but rejects preview of the whole layout', async () => {
    const { controller, client } = setup(); await controller.begin();
    controller.changeRect({ x0: 0, y0: 280, x1: 600, y1: 595 });
    expect(controller.getSnapshot().error).toBeNull();
    expect(controller.getSnapshot().draft?.slots[1]).toMatchObject({ top_pt: 280, height_pt: 315 });
    await controller.generatePreview();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'editing' });
    expect(controller.getSnapshot().error).toContain('两栏重叠约 3.53 mm');
    expect(controller.getSnapshot().error).toContain('距页顶 98.78 mm，上一栏底边 102.31 mm');
    expect(client.preview).not.toHaveBeenCalled();
    controller.changeRect({ x0: 0, y0: 300, x1: 600, y1: 595 });
    expect(controller.getSnapshot().error).toBeNull();
    await controller.generatePreview();
    expect(client.preview).toHaveBeenCalledTimes(1);
  });
  it('changes the editable slot without changing the sample or immutable preparation', async () => {
    const { controller, client } = setup();
    const originalPreparation = structuredClone(prepare);
    controller.selectSlot('slot-2');
    expect(controller.getSnapshot().selectedSlotId).toBeNull();
    await controller.begin();
    expect(controller.getSnapshot().selectedSlotId).toBe('slot-1');
    controller.selectSlot('missing');
    expect(controller.getSnapshot().selectedSlotId).toBe('slot-1');
    controller.selectSlot('slot-2');
    controller.changeRect({ x0: 0, y0: 605, x1: 600, y1: 895 });
    expect(controller.getSnapshot().draft?.slots[2].top_pt).toBe(605);
    expect(controller.getSnapshot().draft?.slots[1]).toEqual(layout.slots[1]);
    controller.selectSlot('slot-1');
    controller.changeRect({ x0: 0, y0: 304, x1: 600, y1: 594 });
    expect(controller.getSnapshot().draft?.slots[1].top_pt).toBe(304);
    expect(controller.getSnapshot()).toMatchObject({ selectedId: 'r-2', selectedSlotId: 'slot-1', preparation: originalPreparation });
    expect(prepare).toEqual(originalPreparation);
    expect(client.prepare).toHaveBeenCalledTimes(1);
    await controller.generatePreview();
    controller.selectSlot('slot-0');
    expect(controller.getSnapshot().selectedSlotId).toBe('slot-1');
    expect(client.preview.mock.calls[0][1]).toEqual(originalPreparation);
  });
  it('keeps uniform 96.25 mm height while an overflowing third slot is moved back onto the page', async () => {
    const { controller, client } = setup();
    const pt = (mm: number) => mm * 72 / 25.4;
    const pageLayout: LayoutDefinition = { ...structuredClone(layout),
      page_geometry: { pdf_box: { x0: 0, y0: 0, x1: pt(209.9), y1: pt(297.04) }, rotation: 0, user_unit: 1, width_pt: pt(209.9), height_pt: pt(297.04) },
      slots: layout.slots.map((slot, i) => ({ ...slot, top_pt: pt([0, 100.01, 201.44][i]), height_pt: pt([96.25, 96.25, 95][i]) })) };
    client.prepare.mockResolvedValue({ ...prepare, layout_definition: pageLayout, selected_slot_id: 'slot-0' });
    await controller.begin();
    controller.change({ ...pageLayout, uniform_height: true, slots: pageLayout.slots.map((slot) => ({ ...slot, height_pt: pt(96.25) })) });
    const overflowing = controller.getSnapshot().draft!;
    expect(overflowing.uniform_height).toBe(true);
    expect(overflowing.slots.map((slot) => slot.top_pt)).toEqual(pageLayout.slots.map((slot) => slot.top_pt));
    expect(overflowing.slots.every((slot) => slot.height_pt === pt(96.25))).toBe(true);
    expect(controller.getSnapshot().error).toBeNull();
    await controller.generatePreview();
    expect(controller.getSnapshot().phase).toBe('editing');
    expect(controller.getSnapshot().error).toContain('第 3 栏距页顶 201.44 + 高度 96.25 = 底边 297.69 mm');
    expect(controller.getSnapshot().error).toContain('页面高度 297.04 mm 约 0.65 mm');
    expect(client.preview).not.toHaveBeenCalled();
    await controller.save();
    expect(client.save).not.toHaveBeenCalled();
    controller.selectSlot('slot-2');
    controller.change({ ...overflowing, slots: overflowing.slots.map((slot) => slot.slot_id === 'slot-2' ? { ...slot, top_pt: pt(200.79) } : slot) });
    expect(controller.getSnapshot().error).toBeNull();
    expect(controller.getSnapshot().draft?.slots[0]).toEqual(overflowing.slots[0]);
    expect(controller.getSnapshot().draft?.slots[1]).toEqual(overflowing.slots[1]);
    expect(controller.getSnapshot().draft?.uniform_height).toBe(true);
    await controller.generatePreview();
    expect(controller.getSnapshot().phase).toBe('preview');
    expect(client.preview).toHaveBeenCalledTimes(1);
    expect(client.preview.mock.calls[0][2].slots[2]).toMatchObject({ top_pt: pt(200.79), height_pt: pt(96.25) });
  });
  it('increments draft revisions across numeric and mouse edits, synchronizes uniform heights and discards on cancel', async () => {
    const { controller, client } = setup(); await controller.begin();
    controller.change({ ...layout, uniform_height: true });
    expect(controller.getSnapshot().draft?.revision).toBe(2);
    controller.selectSlot('slot-2');
    controller.changeRect({ x0: 0, y0: 604, x1: 600, y1: 889 });
    expect(controller.getSnapshot().draft?.revision).toBe(3);
    expect(controller.getSnapshot().draft?.slots.map((slot) => slot.height_pt)).toEqual([285, 285, 285]);
    const numeric = controller.getSnapshot().draft!;
    controller.change({ ...numeric, revision: 999, slots: numeric.slots.map((slot) => slot.slot_id === 'slot-2' ? { ...slot, top_pt: 606 } : slot) });
    expect(controller.getSnapshot().draft?.revision).toBe(4);
    expect(controller.getSnapshot().preparation?.layout_definition).toEqual(layout);
    await controller.leave();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'results', selectedId: 'r-2', selectedSlotId: null, draft: null, preparation: null });
    expect(client.preview).not.toHaveBeenCalled(); expect(client.save).not.toHaveBeenCalled();
  });
  it('preserves trusted layout identity and rejects malformed numeric or slot edits', async () => {
    const { controller } = setup(); await controller.begin();
    controller.change({ ...layout, layout_id: 'other', workspace_id: 'other', issuer_id: 'other', evidence_version: 'other',
      page_geometry: { ...layout.page_geometry, width_pt: 9000 }, left_pt: 5 });
    expect(controller.getSnapshot().draft).toMatchObject({ layout_id: layout.layout_id, workspace_id: layout.workspace_id,
      issuer_id: layout.issuer_id, evidence_version: layout.evidence_version, page_geometry: layout.page_geometry, left_pt: 5 });
    const valid = controller.getSnapshot().draft!;
    for (const invalid of [
      { ...valid, left_pt: Number.NaN },
      { ...valid, right_pt: 600 },
      { ...valid, slots: valid.slots.map((slot) => ({ ...slot, height_pt: 0 })) },
      { ...valid, slots: valid.slots.map((slot) => ({ ...slot, top_pt: Number.POSITIVE_INFINITY })) },
      { ...valid, slots: valid.slots.slice(1) },
      { ...valid, slots: [...valid.slots].reverse() },
    ]) {
      controller.change(invalid);
      expect(controller.getSnapshot().draft).toEqual(valid);
      expect(controller.getSnapshot().error).not.toBeNull();
    }
  });
});


describe('explicit bulk review selection', () => {
  it('confirms each original crop across sources, document types and page geometries', async () => {
    const session = calibrationSession();
    session.items[1].original.source_key = '/other.pdf';
    session.prepared.binding.job.sources.push({ ...session.prepared.binding.job.sources[0], source_key: '/other.pdf', access_path: '/other.pdf' });
    session.items[1].original.candidate_rect = { x0: 12, y0: 40, x1: 510, y1: 260 };
    session.items[1].page_notice = { code: 'special_document', document_type: 'electronic_tax_payment' };
    session.items[1].original.page_geometry = { ...layout.page_geometry, height_pt: 850 };
    setRecord(session, 1, 'needs_review', { final_rect: { x0: 14, y0: 44, x1: 512, y1: 264 }, manual_adjusted: true });
    setRecord(session, 2, 'needs_review', { final_rect: null, crop_mode: 'full_page', manual_adjusted: true });
    const { controller, batch, stored } = selectionSetup(session);
    await controller.reviewSelection(['r-0', 'r-1', 'r-2'], 'confirm');
    expect(batch.saveReview.mock.calls[0][1]).toEqual([
      expect.objectContaining({ id: 'r-0', final_rect: session.items[0].original.candidate_rect, record_revision: 0, review_status: 'confirmed' }),
      expect.objectContaining({ id: 'r-1', source_key: '/other.pdf', final_rect: session.items[1].record!.final_rect,
        record_revision: 3, manual_adjusted: true, review_status: 'confirmed' }),
      expect.objectContaining({ id: 'r-2', final_rect: null, crop_mode: 'full_page', record_revision: 3,
        manual_adjusted: true, review_status: 'page_confirmed' }),
    ]);
    expect(controller.getSnapshot()).toMatchObject({ error: null, reviewNotice: '本批 3 处已确认。' });
    expect(stored.items[3].record).toBeNull();
  });
  it.each(['blocked', 'excluded'] as const)('rejects selection containing %s before any write', async (status) => {
    const session = calibrationSession(); setRecord(session, 1, status);
    const { controller, reload, batch } = selectionSetup(session);
    await controller.reviewSelection(['r-0', 'r-1'], 'confirm');
    expect(batch.saveReview).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toContain('阻止确认或已排除');
  });
  it('rejects a newly blocked selection after reloading and keeps the authoritative list', async () => {
    const { controller, stored, batch } = selectionSetup(); setRecord(stored, 1, 'blocked');
    await controller.reviewSelection(['r-0', 'r-1'], 'confirm');
    expect(batch.saveReview).not.toHaveBeenCalled();
    expect(controller.getSnapshot().session?.items[1].record?.review_status).toBe('blocked');
    expect(controller.getSnapshot().error).toContain('最新结果含阻止确认');
  });
  it('excludes and restores multiple selected records while preserving individual crop state', async () => {
    const session = calibrationSession();
    setRecord(session, 1, 'confirmed', { final_rect: { x0: 5, y0: 10, x1: 450, y1: 280 }, manual_adjusted: true });
    const { controller, stored, batch } = selectionSetup(session);
    await controller.reviewSelection(['r-0', 'r-1'], 'exclude');
    expect(controller.getSnapshot().reviewNotice).toBe('本批 2 处已排除。');
    controller.setReviewFilter('excluded');
    expect(controller.getSnapshot().selectedId).toBe('r-0');
    await controller.reviewSelection(['r-0', 'r-1'], 'restore');
    expect(batch.saveReview.mock.calls[1][1]).toEqual([
      expect.objectContaining({ id: 'r-0', review_status: 'needs_review', record_revision: 1 }),
      expect.objectContaining({ id: 'r-1', review_status: 'needs_review', record_revision: 4,
        final_rect: session.items[1].record!.final_rect, crop_mode: 'candidate', manual_adjusted: true }),
    ]);
    expect(controller.getSnapshot()).toMatchObject({ error: null, reviewNotice: '本批 2 处已恢复待复核，请重新核对。', selectedId: null });
    expect(stored.items[2].record).toBeNull();
    await controller.reviewSelection(['r-0', 'r-1'], 'restore');
    expect(batch.saveReview).toHaveBeenCalledTimes(2);
  });
  it.each([null, 'confirmed', 'blocked', 'page_confirmed'] as const)('does not restore a record in %s state', async (status) => {
    const session = calibrationSession(); if (status) setRecord(session, 0, status);
    const { controller, batch } = selectionSetup(session);
    await controller.reviewSelection(['r-0'], 'restore');
    expect(batch.saveReview).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toContain('只能恢复已排除片段');
  });
  it.each([[], ['r-0', 'r-0'], ['r-0', 'unknown'], ['']].map((ids) => ({ ids })))('rejects empty, repeated or foreign IDs $ids', async ({ ids }) => {
    const { controller, reload, batch } = selectionSetup();
    await controller.reviewSelection(ids, 'exclude');
    expect(batch.saveReview).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toBeTruthy();
  });
  it('locks concurrent review actions and rejects writes outside results', async () => {
    const { controller, reload, batch, stored } = selectionSetup();
    const reading = deferred<ReceiptReviewSession>(); reload.mockReturnValueOnce(reading.promise);
    const pending = controller.reviewSelection(['r-0'], 'exclude');
    await controller.reviewSelection(['r-1'], 'confirm'); controller.select('r-1');
    expect(controller.getSnapshot()).toMatchObject({ selectedId: 'r-0', reviewConfirming: true, reviewAction: 'exclude' });
    reading.resolve(structuredClone(stored)); await pending;
    expect(batch.saveReview).toHaveBeenCalledTimes(1);
    const editing = setup(); await editing.controller.begin();
    await editing.controller.reviewSelection(['r-0'], 'exclude');
    expect(editing.controller.getSnapshot()).toMatchObject({ phase: 'editing', reviewConfirming: false });
  });
  it('uses fresh record revisions when the displayed crop and decision remain unchanged', async () => {
    const session = calibrationSession(); setRecord(session, 0, 'needs_review');
    const { controller, batch, stored } = selectionSetup(session);
    setRecord(stored, 0, 'needs_review', { record_revision: 8 });
    await controller.reviewSelection(['r-0'], 'confirm');
    expect(batch.saveReview.mock.calls[0][1][0].record_revision).toBe(8);
    expect(controller.getSnapshot().error).toBeNull();
  });
  it.each(['candidate', 'final', 'crop', 'manual', 'source', 'instance', 'analysis', 'source_hash'] as const)(
    'refuses to confirm unseen %s changes and lets the user inspect refreshed data', async (change) => {
      const session = calibrationSession(); if (change !== 'candidate') setRecord(session, 0, 'needs_review');
      const { controller, stored, batch } = selectionSetup(session);
      const item = stored.items[0];
      if (change === 'candidate') item.original.candidate_rect.x0 = 7;
      if (change === 'final') item.record!.final_rect = { ...item.record!.final_rect!, x0: 7 };
      if (change === 'crop') { item.record!.crop_mode = 'full_page'; item.record!.final_rect = null; }
      if (change === 'manual') item.record!.manual_adjusted = true;
      if (change === 'source') item.original.source_key = '/other.pdf';
      if (change === 'instance') item.original.instance_id = 'another-instance';
      if (change === 'analysis') item.original.analysis_signature = 'another-analysis';
      if (change === 'source_hash') stored.prepared.binding.job.sources[0].sha256 = 'b'.repeat(64);
      await controller.reviewSelection(['r-0'], 'confirm');
      expect(batch.saveReview).not.toHaveBeenCalled();
      expect(controller.getSnapshot().reviewNotice).toBeNull();
      expect(controller.getSnapshot().error).toContain('来源、分析、边界或凭证类型已变化');
      expect(controller.getSnapshot().session).toEqual(stored);
    });
  it.each(['job', 'revision', 'context'] as const)('rejects a refreshed %s binding without adopting another session', async (change) => {
    const { controller, stored, batch } = selectionSetup();
    if (change === 'job') stored.prepared.binding.job.id = 'other';
    if (change === 'revision') stored.prepared.prepared.result_revision = 'other';
    if (change === 'context') stored.prepared.prepared.context_key = 'b'.repeat(64);
    await controller.reviewSelection(['r-0'], 'exclude');
    expect(batch.saveReview).not.toHaveBeenCalled();
    expect(controller.getSnapshot().session?.prepared.prepared.context_key).toBe(hash);
    expect(controller.getSnapshot().session?.prepared.prepared.result_revision).toBe('r');
    expect(controller.getSnapshot().session?.prepared.binding.job.id).toBe('job');
    expect(controller.getSnapshot().error).toContain('结果版本或上下文已变化');
  });
  it('recovers all selected confirmations after response loss and does not rewrite a retry', async () => {
    const { controller, stored, batch } = selectionSetup();
    batch.saveReview.mockImplementationOnce(async (_prepared, edits) => {
      persistEdits(stored, edits); throw new Error('response lost');
    });
    await controller.reviewSelection(['r-0', 'r-1'], 'confirm');
    expect(controller.getSnapshot()).toMatchObject({ error: null, reviewNotice: '本批 2 处已确认。' });
    await controller.reviewSelection(['r-0', 'r-1'], 'confirm');
    expect(batch.saveReview).toHaveBeenCalledTimes(1);
  });
  it('reports partial writes and retries only the unfinished part of the explicit selection', async () => {
    const { controller, stored, batch } = selectionSetup();
    batch.saveReview.mockImplementationOnce(async (_prepared, edits) => {
      persistEdits(stored, edits.slice(0, 1)); throw new Error('partial save');
    });
    await controller.reviewSelection(['r-0', 'r-1'], 'exclude');
    expect(controller.getSnapshot()).toMatchObject({ reviewNotice: null, reviewConfirming: false });
    expect(controller.getSnapshot().error).toContain('已核实 1/2 处完成，剩余 1 处未完成');
    expect(controller.getSnapshot().session?.items[0].record?.review_status).toBe('excluded');
    await controller.reviewSelection(['r-0', 'r-1'], 'exclude');
    expect(batch.saveReview.mock.calls[1][1].map((edit) => edit.id)).toEqual(['r-1']);
    expect(controller.getSnapshot()).toMatchObject({ error: null, reviewNotice: '本批 2 处已排除。' });
    expect(stored.items[2].record).toBeNull();
  });
  it('never relies on a successful saved count when the authoritative records do not match', async () => {
    const { controller, batch } = selectionSetup();
    batch.saveReview.mockResolvedValueOnce({ status: 'ok', data: { saved_count: 2 } });
    await controller.reviewSelection(['r-0', 'r-1'], 'confirm');
    expect(controller.getSnapshot().reviewNotice).toBeNull();
    expect(controller.getSnapshot().error).toContain('权威结果未确认');
    expect(controller.getSnapshot().error).toContain('0/2');
  });
  it('recovers a mismatched saved count only when every authoritative target matches', async () => {
    const { controller, stored, batch } = selectionSetup();
    batch.saveReview.mockImplementationOnce(async (_prepared, edits) => {
      persistEdits(stored, edits); return { status: 'ok', data: { saved_count: 1 } };
    });
    await controller.reviewSelection(['r-0', 'r-1'], 'exclude');
    expect(controller.getSnapshot()).toMatchObject({ error: null, reviewNotice: '本批 2 处已排除。' });
  });
  it('rejects a disappeared target without modifying the remaining selected item', async () => {
    const { controller, stored, batch } = selectionSetup(); stored.items.splice(1, 1);
    await controller.reviewSelection(['r-0', 'r-1'], 'exclude');
    expect(batch.saveReview).not.toHaveBeenCalled();
    expect(controller.getSnapshot().reviewNotice).toBeNull();
    expect(controller.getSnapshot().error).toContain('已不在审核结果中');
  });
  it('does not restore a newly excluded record based on an already-restored stale display', async () => {
    const session = calibrationSession(); setRecord(session, 0, 'needs_review');
    const { controller, stored, batch } = selectionSetup(session); setRecord(stored, 0, 'excluded', { record_revision: 4 });
    await controller.reviewSelection(['r-0'], 'restore');
    expect(batch.saveReview).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toContain('审核状态已变化');
  });
  it('reports uncertainty if both the write response and recovery read are unavailable', async () => {
    const { controller, batch, reload } = selectionSetup();
    batch.saveReview.mockRejectedValueOnce(new Error('response lost'));
    reload.mockResolvedValueOnce(calibrationSession()).mockRejectedValueOnce(new Error('read failed'));
    await controller.reviewSelection(['r-0', 'r-1'], 'exclude');
    expect(controller.getSnapshot().reviewNotice).toBeNull();
    expect(controller.getSnapshot().error).toContain('保存结果尚未核实');
    expect(controller.getSnapshot().error).toContain('response lost');
  });
  it.each(['read', 'write', 'verify'] as const)('does not mutate a newly bound task after an old %s completes', async (stage) => {
    const { controller, reload, batch, stored } = selectionSetup();
    const pause = deferred<ReceiptReviewSession>();
    const writing = deferred<{ status: 'ok'; data: { saved_count: number } }>();
    if (stage === 'read') reload.mockReturnValueOnce(pause.promise);
    if (stage === 'verify') reload.mockResolvedValueOnce(structuredClone(stored)).mockReturnValueOnce(pause.promise);
    if (stage === 'write') batch.saveReview.mockReturnValueOnce(writing.promise);
    const pending = controller.reviewSelection(['r-0'], 'exclude');
    if (stage !== 'read') await vi.waitFor(() => expect(batch.saveReview).toHaveBeenCalledTimes(1));
    if (stage === 'verify') await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    controller.bind(calibrationSession('new'));
    pause.resolve(structuredClone(stored)); writing.resolve({ status: 'ok', data: { saved_count: 1 } }); await pending;
    expect(controller.getSnapshot()).toMatchObject({ selectedId: 'new-0', reviewNotice: null, error: null, reviewConfirming: false });
    if (stage === 'read') expect(batch.saveReview).not.toHaveBeenCalled();
    if (stage === 'write') expect(reload).toHaveBeenCalledTimes(1);
  });
  it('stops after a failed chunk, reports saved items, and resumes only unfinished IDs', async () => {
    const session = calibrationSession();
    session.items = Array.from({ length: 405 }, (_, index) => ({ ...structuredClone(session.items[0]),
      original: { ...structuredClone(session.items[0].original), id: `r-${index}`, source_page: index + 1 } }));
    const { controller, stored, batch, reload } = selectionSetup(session);
    batch.saveReview.mockImplementationOnce(async (_prepared, edits) => {
      persistEdits(stored, edits); return { status: 'ok', data: { saved_count: edits.length } };
    }).mockRejectedValueOnce(new Error('second chunk failed'));
    const ids = session.items.map((item) => item.original.id);
    await controller.reviewSelection(ids, 'confirm');
    expect(batch.saveReview).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().error).toContain('已核实 200/405 处完成，剩余 205 处未完成');
    expect(controller.getSnapshot().reviewNotice).toBeNull();
    await controller.reviewSelection(ids, 'confirm');
    expect(batch.saveReview).toHaveBeenCalledTimes(4);
    expect(reload).toHaveBeenCalledTimes(4);
    expect(batch.saveReview.mock.calls[2][1][0].id).toBe('r-200');
    expect(batch.saveReview.mock.calls[3][1].map((edit) => edit.id)).toEqual(['r-400', 'r-401', 'r-402', 'r-403', 'r-404']);
    expect(controller.getSnapshot()).toMatchObject({ error: null, reviewNotice: '本批 405 处已确认。' });
  });
  it('confirms 1000 items with only one initial and one final authoritative reload', async () => {
    const session = calibrationSession();
    session.items = Array.from({ length: 1000 }, (_, index) => ({ ...structuredClone(session.items[0]),
      original: { ...structuredClone(session.items[0].original), id: `r-${index}`, source_page: index + 1 } }));
    const { controller, stored, batch, reload } = selectionSetup(session);
    batch.saveReview.mockImplementation(async (_prepared, edits) => {
      expect(reload).toHaveBeenCalledTimes(1);
      persistEdits(stored, edits);
      return { status: 'ok', data: { saved_count: edits.length,
        segments: edits.map((edit) => structuredClone(stored.items.find((item) => item.original.id === edit.id)!.record!)) } };
    });
    await controller.reviewSelection(session.items.map((item) => item.original.id), 'confirm');
    expect(batch.saveReview).toHaveBeenCalledTimes(5);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({ error: null, reviewNotice: '本批 1000 处已确认。' });
  });
  it.each(['binding', 'status'] as const)('stops later chunks on an inconsistent %s acknowledgement and reloads partial results', async (change) => {
    const session = calibrationSession();
    session.items = Array.from({ length: 401 }, (_, index) => ({ ...structuredClone(session.items[0]),
      original: { ...structuredClone(session.items[0].original), id: `r-${index}`, source_page: index + 1 } }));
    const { controller, stored, batch, reload } = selectionSetup(session);
    batch.saveReview.mockImplementationOnce(async (_prepared, edits) => {
      persistEdits(stored, edits);
      const segments = edits.map((edit) => structuredClone(stored.items.find((item) => item.original.id === edit.id)!.record!));
      if (change === 'binding') segments[0].original.analysis_signature = 'changed-analysis';
      if (change === 'status') segments[0].review_status = 'excluded';
      return { status: 'ok', data: { saved_count: edits.length, segments } };
    });
    await controller.reviewSelection(session.items.map((item) => item.original.id), 'confirm');
    expect(batch.saveReview).toHaveBeenCalledTimes(1); expect(reload).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().reviewNotice).toBeNull();
    expect(controller.getSnapshot().error).toContain('保存返回记录的绑定或审核决定不一致');
    expect(controller.getSnapshot().error).toContain('已核实 200/401 处完成，剩余 201 处未完成');
  });
  it('also batches by UTF-8 response size for long source paths', async () => {
    const session = calibrationSession(); const path = `/${'长'.repeat(8000)}.pdf`;
    session.prepared.binding.job.sources[0].source_key = path; session.prepared.binding.job.sources[0].access_path = path;
    session.items.forEach((item) => { item.original.source_key = path; });
    const { controller, batch } = selectionSetup(session);
    await controller.reviewSelection(session.items.map((item) => item.original.id), 'exclude');
    expect(batch.saveReview.mock.calls.length).toBeGreaterThan(1);
    for (const [, edits] of batch.saveReview.mock.calls) {
      expect(new TextEncoder().encode(JSON.stringify(edits)).byteLength).toBeLessThan(2 * 1024 * 1024);
    }
    expect(controller.getSnapshot()).toMatchObject({ error: null, reviewNotice: '本批 51 处已排除。' });
  });
});
