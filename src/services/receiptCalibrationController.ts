import { RECEIPT_BATCH_MAX_JSON_BYTES, RECEIPT_BATCH_MAX_PAGE_ITEMS, type ReceiptBatchPreparedReview, type ReceiptBatchReviewPageItem } from '../domain/receiptBatch';
import { parseLayoutDefinition, slotRect, type LayoutDefinition } from '../domain/receiptLayout';
import { validateLayoutDraft } from '../domain/receiptLayoutDraft';
import type { PdfRect } from '../domain/cropReview';
import { isReceiptDocumentType, type ReceiptDocumentType, type ReceiptReviewEdit } from '../domain/receiptReview';
import { ReceiptBatchClient } from './receiptBatchClient';
import { canRetryTemplateSave, ReceiptLayoutClient, templateReferenceAllowed, withinEditableLayout, type ReceiptLayoutOperation, type ReceiptLayoutPreparation, type ReceiptLayoutPreview, type TemplateSaveMode } from './receiptLayoutClient';
import { compatibleLayoutTemplate, LayoutTemplateClient, layoutTemplateName, type LayoutTemplate } from './layoutTemplateClient';

export type ReceiptReviewSession = { prepared: ReceiptBatchPreparedReview; items: ReceiptBatchReviewPageItem[] };
export type ReceiptCalibrationPhase = 'results' | 'preparing' | 'editing' | 'previewing' | 'preview' | 'saving' | 'uncertain' | 'saved';
export type ReceiptReviewFilter = 'all' | 'pending' | 'special' | 'excluded';
export type ReceiptReviewAction = 'confirm' | 'exclude' | 'restore' | 'classify';
type Classification = { documentType: ReceiptDocumentType; boundaryConfirmed: boolean };
export type ReceiptCalibrationState = {
  session: ReceiptReviewSession | null; phase: ReceiptCalibrationPhase; selectedId: string | null; selectedSlotId: string | null;
  preparation: ReceiptLayoutPreparation | null; draft: LayoutDefinition | null;
  preview: ReceiptLayoutPreview | null; previewIndex: number; operation: ReceiptLayoutOperation | null;
  writeAction: 'save' | 'undo' | null;
  reviewAction?: ReceiptReviewAction | null;
  error: string | null; acknowledgedRiskIds: string[]; includeExceptionIds: string[]; rememberReference: boolean; templateName: string;
  templateSaveMode: TemplateSaveMode; templateId: string | null; templateBankName: string;
  templateCandidates: LayoutTemplate[]; templateCandidatesStatus: 'idle' | 'loading' | 'ready' | 'error'; templateCandidatesError: string | null;
  reviewFilter: ReceiptReviewFilter; reviewConfirming: boolean; reviewNotice: string | null;
};
const initial = (): ReceiptCalibrationState => ({ session: null, phase: 'results', selectedId: null, selectedSlotId: null,
  preparation: null, draft: null, preview: null, previewIndex: 0, operation: null, writeAction: null, error: null,
  acknowledgedRiskIds: [], includeExceptionIds: [], rememberReference: false, templateName: '',
  templateSaveMode: 'create', templateId: null, templateBankName: '', templateCandidates: [], templateCandidatesStatus: 'idle', templateCandidatesError: null,
  reviewFilter: 'all', reviewConfirming: false, reviewAction: null, reviewNotice: null });
export const needsReceiptReview = (item: ReceiptBatchReviewPageItem) => item.record
  ? !['confirmed', 'page_confirmed', 'excluded'].includes(item.record.review_status) : item.original.needs_review;
export const isReceiptExcluded = (item: ReceiptBatchReviewPageItem) => item.record?.review_status === 'excluded';
export const matchesReceiptFilter = (item: ReceiptBatchReviewPageItem, filter: ReceiptReviewFilter) =>
  filter === 'pending' ? needsReceiptReview(item) : filter === 'special' ? Boolean(item.page_notice)
    : filter === 'excluded' ? isReceiptExcluded(item) : true;
function samePdfRect(left: PdfRect | null, right: PdfRect | null) {
  if (left === null || right === null) return left === right;
  return left.x0 === right.x0 && left.y0 === right.y0 && left.x1 === right.x1 && left.y1 === right.y1;
}
function singleReviewMatches(item: ReceiptBatchReviewPageItem, edit: ReceiptReviewEdit) {
  const record = item.record;
  return Boolean(record && item.original.id === edit.id
    && item.original.source_key === edit.source_key
    && item.original.instance_id === edit.instance_id
    && item.original.analysis_signature === edit.analysis_signature
    && record.review_status === edit.review_status
    && record.crop_mode === edit.crop_mode
    && record.manual_adjusted === edit.manual_adjusted
    && record.document_type === edit.document_type
    && samePdfRect(record.final_rect, edit.final_rect));
}
function reviewEdit(session: ReceiptReviewSession, item: ReceiptBatchReviewPageItem, action: ReceiptReviewAction, classification?: Classification): ReceiptReviewEdit {
  const { original, record, record_revision } = item;
  const cropMode = record?.crop_mode ?? 'candidate';
  // Acknowledging an automatically detected type does not turn it into a manual override.
  const documentType = classification
    ? record?.document_type === undefined && classification.documentType === (item.page_notice?.document_type ?? 'ordinary')
      ? undefined : classification.documentType
    : record?.document_type;
  return {
    schema_version: 1, context_key: session.prepared.prepared.context_key,
    result_revision: session.prepared.prepared.result_revision, id: original.id, source_key: original.source_key,
    instance_id: original.instance_id, analysis_signature: original.analysis_signature, record_revision,
    final_rect: record ? record.final_rect : original.candidate_rect, crop_mode: cropMode,
    review_status: action === 'exclude' ? 'excluded' : action === 'restore' ? 'needs_review'
      : action === 'classify' && record?.review_status === 'blocked' ? 'blocked'
        : action === 'classify' && !classification?.boundaryConfirmed ? 'needs_review'
      : cropMode === 'full_page' ? 'page_confirmed' : 'confirmed',
    manual_adjusted: record?.manual_adjusted ?? false, reviewed_at: new Date().toISOString(),
    ...(documentType !== undefined ? { document_type: documentType } : {}),
  };
}
function sameReviewBinding(left: ReceiptReviewSession, right: ReceiptReviewSession) {
  return left.prepared.binding.job.id === right.prepared.binding.job.id
    && left.prepared.binding.job.result_revision === right.prepared.binding.job.result_revision
    && left.prepared.binding.contextKey === right.prepared.binding.contextKey
    && left.prepared.prepared.result_revision === right.prepared.prepared.result_revision
    && left.prepared.prepared.context_key === right.prepared.prepared.context_key;
}
function sameReviewItem(before: ReceiptBatchReviewPageItem, current: ReceiptBatchReviewPageItem, allowTypeChange = false) {
  const left = before.original, right = current.original;
  const leftPage = left.page_geometry, rightPage = right.page_geometry;
  return left.id === right.id && left.source_key === right.source_key && left.instance_id === right.instance_id
    && left.analysis_signature === right.analysis_signature && left.source_page === right.source_page
    && left.slot_id === right.slot_id && left.position_index === right.position_index
    && left.layout_id === right.layout_id && left.layout_revision === right.layout_revision && left.layout_signature === right.layout_signature
    && samePdfRect(leftPage.pdf_box, rightPage.pdf_box) && leftPage.rotation === rightPage.rotation
    && leftPage.user_unit === rightPage.user_unit && leftPage.width_pt === rightPage.width_pt && leftPage.height_pt === rightPage.height_pt
    && samePdfRect(before.record ? before.record.final_rect : left.candidate_rect,
      current.record ? current.record.final_rect : right.candidate_rect)
    && (before.record?.crop_mode ?? 'candidate') === (current.record?.crop_mode ?? 'candidate')
    && (before.record?.manual_adjusted ?? false) === (current.record?.manual_adjusted ?? false)
    && (allowTypeChange || before.record?.document_type === current.record?.document_type
      && before.page_notice?.document_type === current.page_notice?.document_type);
}
/** Bound both the request and the returned full records; keep room for response envelopes. */
function reviewChunks(session: ReceiptReviewSession, edits: ReceiptReviewEdit[], items: Map<string, ReceiptBatchReviewPageItem>) {
  const chunks: ReceiptReviewEdit[][] = [];
  const encoder = new TextEncoder();
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  const sources = new Map(session.prepared.binding.job.sources.map((source) => [source.source_key, source]));
  const budget = RECEIPT_BATCH_MAX_JSON_BYTES / 2;
  let chunk: ReceiptReviewEdit[] = [], requestBytes = 0, responseBytes = 0;
  for (const edit of edits) {
    const source = sources.get(edit.source_key);
    const requestSize = size(edit) + 1;
    const responseSize = size({ ...edit, original: items.get(edit.id)!.original,
      source_path: source?.access_path, source_sha256: source?.sha256 }) + 1;
    if (requestSize > budget || responseSize > budget) throw new Error('所选片段数据过大，无法在安全请求大小内保存，请单独核查该片段。');
    if (chunk.length && (chunk.length >= RECEIPT_BATCH_MAX_PAGE_ITEMS
      || requestBytes + requestSize > budget || responseBytes + responseSize > budget)) {
      chunks.push(chunk); chunk = []; requestBytes = 0; responseBytes = 0;
    }
    chunk.push(edit); requestBytes += requestSize; responseBytes += responseSize;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}
/** Confirm existing rectangles in one source/page geometry/position; never copy a frame. */
export function pendingReceiptGroup(session: ReceiptReviewSession, selectedId: string | null) {
  const selected = session.items.find((item) => item.original.id === selectedId);
  if (!selected) return [];
  const sample = selected.original;
  return session.items.filter((item) => needsReceiptReview(item) && item.record?.review_status !== 'blocked'
    && item.original.source_key === sample.source_key
    && JSON.stringify(item.original.page_geometry) === JSON.stringify(sample.page_geometry)
    && item.page_notice?.document_type === selected.page_notice?.document_type
    && (!selected.page_notice || item.original.layout_id === sample.layout_id)
    && item.original.position_index === sample.position_index);
}
const message = (error: unknown) => error instanceof Error ? error.message : '版式操作未完成，请重试。';
export const calibrationBusy = (phase: ReceiptCalibrationPhase) => ['preparing', 'previewing', 'saving'].includes(phase);

/** One round owns immutable write tokens. A lost response never means "not applied". */
export class ReceiptCalibrationController {
  private state = initial();
  private listeners = new Set<() => void>();
  private epoch = 0;
  private abort = new AbortController();
  private templateLoadEpoch = 0;
  constructor(private readonly client = new ReceiptLayoutClient(),
    private readonly reload: (jobId: string, revision: string) => Promise<ReceiptReviewSession>,
    private readonly batchClient = new ReceiptBatchClient(), private readonly templateClient = new LayoutTemplateClient()) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<ReceiptCalibrationState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  bind(session: ReceiptReviewSession | null) {
    const old = this.state;
    this.abort.abort(); this.abort = new AbortController(); this.epoch++;
    // Only unsaved previews may be discarded. A pending write stays in the durable journal.
    if (old.preview && !['saving', 'uncertain', 'saved'].includes(old.phase)) void this.client.cancel(old.preview).catch(() => undefined);
    this.state = { ...initial(), session, selectedId: session?.items[0]?.original.id ?? null };
    this.listeners.forEach((listener) => listener());
  }
  select(id: string) {
    if (this.state.reviewConfirming || !['results', 'saved'].includes(this.state.phase) || !this.state.session?.items.some((item) => item.original.id === id)) return;
    this.set({ selectedId: id });
  }
  setReviewFilter(reviewFilter: ReceiptReviewFilter) {
    if (this.state.reviewConfirming || !['results', 'saved'].includes(this.state.phase)) return;
    const items = this.state.session?.items.filter((item) => matchesReceiptFilter(item, reviewFilter)) ?? [];
    const selectedId = items.some((item) => item.original.id === this.state.selectedId)
      ? this.state.selectedId : items[0]?.original.id ?? null;
    this.set({ reviewFilter, selectedId, reviewNotice: null });
  }
  async confirmPending(ids: string[]) {
    const { session, selectedId, phase } = this.state;
    if (!session || this.state.reviewConfirming || phase !== 'results' || !ids.length) return;
    const allowed = new Set(pendingReceiptGroup(session, selectedId).map((item) => item.original.id));
    if (new Set(ids).size !== ids.length || ids.some((id) => !allowed.has(id))) return;
    await this.reviewSelection(ids, 'confirm');
  }
  async excludeSelected() {
    const selected = this.state.session?.items.find((item) => item.original.id === this.state.selectedId);
    if (selected && !isReceiptExcluded(selected)) await this.reviewSelection([selected.original.id], 'exclude');
  }
  async restoreExcluded() {
    const selected = this.state.session?.items.find((item) => item.original.id === this.state.selectedId);
    if (selected && isReceiptExcluded(selected)) await this.reviewSelection([selected.original.id], 'restore');
  }
  async classifySelection(ids: string[], documentType: ReceiptDocumentType, boundaryConfirmed = false) {
    if (!isReceiptDocumentType(documentType) || typeof boundaryConfirmed !== 'boolean') return;
    await this.reviewSelection(ids, 'classify', { documentType, boundaryConfirmed });
  }
  /** Only the explicit selection is reviewed. Every rectangle remains owned by its original item. */
  async reviewSelection(ids: string[], action: ReceiptReviewAction, classification?: Classification): Promise<void> {
    const { session, phase } = this.state;
    if (!session || this.state.reviewConfirming || phase !== 'results') return;
    const label = action === 'classify' ? '设置凭证类型' : action === 'confirm' ? '确认' : action === 'exclude' ? '排除' : '恢复';
    if (action === 'classify' && (!classification || !isReceiptDocumentType(classification.documentType)
      || typeof classification.boundaryConfirmed !== 'boolean')) return;
    if (!['confirm', 'exclude', 'restore', 'classify'].includes(action) || !Array.isArray(ids) || !ids.length
      || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !id.trim())) {
      this.set({ error: '请选择非空且不重复的片段 ID 后重试。', reviewNotice: null }); return;
    }
    const displayed = new Map(session.items.map((item) => [item.original.id, item]));
    if (displayed.size !== session.items.length || ids.some((id) => !displayed.has(id))) {
      this.set({ error: '所选片段不属于当前审核结果，或结果包含重复 ID，请重新载入。', reviewNotice: null }); return;
    }
    // Freeze exactly what the user saw, including each individual crop and original binding.
    const targets = ids.map((id) => structuredClone(displayed.get(id)!));
    const forbidden = (item: ReceiptBatchReviewPageItem) => action === 'classify'
      ? item.record?.review_status === 'excluded' || classification?.boundaryConfirmed === true && item.record?.review_status === 'blocked'
      : action === 'confirm'
      ? ['blocked', 'excluded'].includes(item.record?.review_status ?? '')
      : action === 'restore' && !['excluded', 'needs_review'].includes(item.record?.review_status ?? '');
    if (targets.some(forbidden)) {
      this.set({ error: action === 'confirm' || action === 'classify' ? '所选片段含阻止确认或已排除项，请先核查或恢复后再确认。'
        : '只能恢复已排除片段；已恢复为待复核的片段可安全重试。', reviewNotice: null }); return;
    }
    const expected = new Map(targets.map((item) => [item.original.id, reviewEdit(session, item, action, classification)]));
    const sources = new Map(session.prepared.binding.job.sources.map((source) => [source.source_key, source]));
    let latestSources = sources;
    const epoch = ++this.epoch;
    this.set({ reviewConfirming: true, reviewAction: action, error: null, reviewNotice: null });
    let latest: ReceiptReviewSession | null = null;
    const currentItems = (fresh: ReceiptReviewSession) => {
      if (!sameReviewBinding(session, fresh)) throw new Error('审核任务、结果版本或上下文已变化，请重新载入。');
      const items = new Map(fresh.items.map((item) => [item.original.id, item]));
      if (items.size !== fresh.items.length) throw new Error('最新审核结果包含重复片段 ID，请重新载入。');
      latest = fresh;
      latestSources = new Map(fresh.prepared.binding.job.sources.map((source) => [source.source_key, source]));
      return items;
    };
    const unchanged = (target: ReceiptBatchReviewPageItem, current: ReceiptBatchReviewPageItem, allowTypeChange = false) => {
      const source = sources.get(target.original.source_key);
      const freshSource = latestSources.get(current.original.source_key);
      return Boolean(source && freshSource && source.source_id === freshSource.source_id
        && source.sha256 === freshSource.sha256 && sameReviewItem(target, current, allowTypeChange));
    };
    const matches = (items: Map<string, ReceiptBatchReviewPageItem>, target: ReceiptBatchReviewPageItem) => {
      const current = items.get(target.original.id);
      const edit = expected.get(target.original.id)!;
      const effectiveType = edit.document_type ?? target.page_notice?.document_type ?? 'ordinary';
      return Boolean(current && unchanged(target, current, true) && singleReviewMatches(current, edit)
        && (current.page_notice?.document_type ?? 'ordinary') === effectiveType);
    };
    const reloadCurrent = () => this.reload(session.prepared.binding.job.id, session.prepared.prepared.result_revision);
    try {
      const fresh = await reloadCurrent();
      if (epoch !== this.epoch) return;
      const items = currentItems(fresh);
      const edits: ReceiptReviewEdit[] = [];
      for (const target of targets) {
        const current = items.get(target.original.id);
        if (!current) throw new Error('所选片段已不在审核结果中，请重新载入。');
        if (forbidden(current)) throw new Error(action === 'confirm' || action === 'classify' ? '最新结果含阻止确认或已排除项，请重新核查。'
          : '所选片段已不再处于可恢复状态，请重新核查。');
        if (matches(items, target)) continue;
        if (!unchanged(target, current)) throw new Error('所选片段的来源、分析、边界或凭证类型已变化；已更新列表，请重新核对后再操作。');
        if (action === 'restore' && !isReceiptExcluded(current)) throw new Error('只能将已排除片段恢复为待复核。');
        if (action !== 'exclude' && target.record?.review_status !== current.record?.review_status) {
          throw new Error('所选片段的审核状态已变化；已更新列表，请重新核对后再操作。');
        }
        const edit = reviewEdit(fresh, current, action, classification);
        expected.set(edit.id, edit);
        edits.push(edit);
      }
      const chunks = reviewChunks(fresh, edits, items);
      for (const chunk of chunks) {
        const response = await this.batchClient.saveReview(fresh.prepared, chunk);
        if (epoch !== this.epoch) return;
        if (response.status === 'error') throw new Error(response.message);
        if (response.data.saved_count !== chunk.length) throw new Error('保存数量不一致，请重新核实结果。');
        // Validate this acknowledgement locally; a full reload rehashes every source file.
        // Unsent chunks retain the original record revisions, so concurrent changes still fail safely.
        const records = response.data.segments;
        if (records !== undefined) {
          if (!Array.isArray(records) || records.length !== chunk.length) throw new Error('保存返回记录数量不一致，请重新核实结果。');
          const returned = new Map(records.map((record) => [record.original.id,
            { original: record.original, record, record_revision: record.record_revision }]));
          if (returned.size !== chunk.length || chunk.some((edit) => {
            const item = returned.get(edit.id), record = item?.record;
            return !item || !record || !sameReviewItem(items.get(edit.id)!, item, true) || !singleReviewMatches(item, edit)
              || record.context_key !== edit.context_key || record.result_revision !== edit.result_revision
              || record.record_revision <= edit.record_revision || record.source_sha256 !== sources.get(edit.source_key)?.sha256;
          })) throw new Error('保存返回记录的绑定或审核决定不一致，请重新核实结果。');
        }
      }
      if (chunks.length) {
        const updated = await reloadCurrent();
        if (epoch !== this.epoch) return;
        const persisted = currentItems(updated);
        if (targets.some((target) => !matches(persisted, target))) {
          throw new Error('权威结果未确认本次审核决定，请重新核对后重试。');
        }
      }
      this.applyReviewSelection(latest!, targets.length, action, classification);
    } catch (error) {
      if (epoch !== this.epoch) return;
      let verifiedCount: number | null = null;
      try {
        // A rejected/lost response can still have committed all or part of the requested selection.
        const recovered = await reloadCurrent();
        if (epoch !== this.epoch) return;
        const persisted = currentItems(recovered);
        verifiedCount = targets.filter((target) => matches(persisted, target)).length;
        if (verifiedCount === targets.length) {
          this.applyReviewSelection(recovered, targets.length, action, classification); return;
        }
      } catch {
        // Keep the write/read error and report uncertainty instead of inferring an unsaved result.
      }
      if (epoch !== this.epoch) return;
      const progress = verifiedCount === null ? '保存结果尚未核实。'
        : `已核实 ${verifiedCount}/${targets.length} 处完成，剩余 ${targets.length - verifiedCount} 处未完成。`;
      this.set({ ...(latest ? { session: latest } : {}), reviewConfirming: false, reviewAction: null, reviewNotice: null,
        error: `批量${label}未完成：${message(error)} ${progress} 重试会先读取已保存结果，仅处理所选片段。` });
    }
  }
  private applyReviewSelection(session: ReceiptReviewSession, count: number, action: ReceiptReviewAction, classification?: Classification) {
    const visible = session.items.filter((item) => matchesReceiptFilter(item, this.state.reviewFilter));
    const selectedId = visible.some((item) => item.original.id === this.state.selectedId)
      ? this.state.selectedId : visible[0]?.original.id ?? null;
    this.set({ session, selectedId, reviewConfirming: false, reviewAction: null, error: null,
      reviewNotice: action === 'classify' ? `已设置 ${count} 处凭证类型，${classification?.boundaryConfirmed ? '类型与边界已确认。' : '尚未确认边界，请继续核对或调整。'}`
        : action === 'confirm' ? `本批 ${count} 处已确认。`
        : action === 'exclude' ? (count === 1 ? '已排除此片段。' : `本批 ${count} 处已排除。`)
          : count === 1 ? '已恢复待复核，请重新核对。' : `本批 ${count} 处已恢复待复核，请重新核对。` });
  }
  selectPreview(index: number) {
    if (this.state.phase !== 'preview' || !Number.isSafeInteger(index) || index < 0 || index >= (this.state.preview?.affected.length ?? 0)) return;
    this.set({ previewIndex: index });
  }
  selectSlot(id: string) {
    if (this.state.phase !== 'editing' || !this.state.draft?.slots.some((slot) => slot.slot_id === id)) return;
    if (this.state.preparation?.editable_slot_ids && !this.state.preparation.editable_slot_ids.includes(id)) return;
    this.set({ selectedSlotId: id });
  }
  async begin() {
    const { session, selectedId, phase } = this.state;
    if (!session || !selectedId || this.state.reviewConfirming || !['results', 'saved'].includes(phase)) return;
    const epoch = ++this.epoch;
    this.abort.abort(); this.abort = new AbortController();
    this.set({ phase: 'preparing', preparation: null, draft: null, selectedSlotId: null, preview: null, operation: null, writeAction: null,
      error: null, previewIndex: 0, acknowledgedRiskIds: [], includeExceptionIds: [], rememberReference: false, templateName: '',
      templateSaveMode: 'create', templateId: null, templateBankName: '', templateCandidates: [], templateCandidatesStatus: 'idle', templateCandidatesError: null });
    try {
      const preparation = await this.client.prepare(session.prepared, selectedId, this.abort.signal);
      if (epoch !== this.epoch) return;
      this.set({ phase: 'editing', preparation, selectedSlotId: preparation.selected_slot_id,
        draft: parseLayoutDefinition(preparation.layout_definition), templateName: `${preparation.layout_definition.slots.length}栏回单模板` });
    } catch (error) { if (epoch === this.epoch) this.set({ phase: 'results', error: message(error) }); }
  }
  async applyTemplate(templateId: string) {
    const { session, phase } = this.state;
    if (!session || this.state.reviewConfirming || !['results', 'saved'].includes(phase)) return;
    const epoch = ++this.epoch;
    this.abort.abort(); this.abort = new AbortController();
    this.templateLoadEpoch++;
    this.set({ phase: 'previewing', preparation: null, draft: null, selectedSlotId: null,
      preview: null, operation: null, writeAction: null, error: null, previewIndex: 0,
      acknowledgedRiskIds: [], includeExceptionIds: [], rememberReference: false, templateName: '',
      templateSaveMode: 'create', templateId: null, templateBankName: '',
      templateCandidates: [], templateCandidatesStatus: 'idle', templateCandidatesError: null });
    try {
      const preview = await this.client.templateApplyPreview(session.prepared, templateId, this.abort.signal);
      if (epoch !== this.epoch) return;
      if (!session.items.some((item) => item.original.id === preview.sample_id)) {
        await this.client.cancel(preview);
        throw new Error('模板预览与当前结果不一致，请重新载入分析结果。');
      }
      this.set({ phase: 'preview', selectedId: preview.sample_id, preview,
        previewIndex: Math.max(0, preview.affected.findIndex((item) => item.previous_id === preview.sample_id)) });
    } catch (error) { if (epoch === this.epoch) this.set({ phase: 'results', error: message(error) }); }
  }
  change(layout: LayoutDefinition) {
    const { draft } = this.state;
    if (this.state.phase !== 'editing' || !draft) return;
    if (this.state.preparation?.editable_slot_ids && (!layout || !Array.isArray(layout.slots)
      || !withinEditableLayout(this.state.preparation, layout))) {
      this.set({ error: '人工分类页面仅可调整所选栏位，其他栏位、统一高度和公共左右边距已锁定。' }); return;
    }
    // Copy only editable fields. Page geometry, identity, slot order and revision belong to this round.
    if (!layout || !Array.isArray(layout.slots) || layout.slots.length !== draft.slots.length
      || layout.slots.some((slot, index) => !slot || slot.slot_id !== draft.slots[index].slot_id
        || slot.position_index !== draft.slots[index].position_index)) {
      this.set({ error: '本轮栏位不能增加、删除或重排，请返回后重新选择版式。' }); return;
    }
    const width = draft.page_geometry.width_pt - layout.left_pt - layout.right_pt;
    if (![layout.left_pt, layout.right_pt, width].every(Number.isFinite) || width <= 0
      || typeof layout.uniform_height !== 'boolean'
      || layout.slots.some((slot) => !Number.isFinite(slot.top_pt) || !Number.isFinite(slot.height_pt)
        || slot.height_pt <= 0 || !Number.isFinite(slot.top_pt + slot.height_pt)
        || slot.top_pt + slot.height_pt <= slot.top_pt)
      || !Number.isSafeInteger(draft.revision + 1)) {
      this.set({ error: '请输入有限数字，回单宽度和高度必须大于 0。' }); return;
    }
    this.set({ draft: { ...draft, revision: draft.revision + 1,
      left_pt: layout.left_pt, right_pt: layout.right_pt, uniform_height: layout.uniform_height,
      slots: draft.slots.map((slot, index) => ({ ...slot,
        top_pt: layout.slots[index].top_pt, height_pt: layout.slots[index].height_pt })) }, error: null });
  }
  changeRect(rect: PdfRect) {
    const { draft, preparation } = this.state;
    if (!draft || !preparation || this.state.phase !== 'editing') return;
    const id = this.state.selectedSlotId ?? preparation.selected_slot_id;
    const selectedSlot = draft.slots.find((slot) => slot.slot_id === id);
    if (!selectedSlot) return;
    const before = slotRect(draft, selectedSlot);
    const height = rect.y1 - rect.y0;
    const heightChanged = Math.abs(height - (before.y1 - before.y0)) > 0.000001;
    this.change({ ...draft, left_pt: rect.x0, right_pt: draft.page_geometry.width_pt - rect.x1,
      slots: draft.slots.map((slot) => ({ ...slot, top_pt: slot.slot_id === id ? rect.y0 : slot.top_pt,
        height_pt: slot.slot_id === id || draft.uniform_height && heightChanged ? height : slot.height_pt })) });
  }
  async generatePreview() {
    const { session, preparation, draft, includeExceptionIds } = this.state;
    if (this.state.phase !== 'editing' || !session || !preparation || !draft) return;
    const validated = validateLayoutDraft(draft);
    if (validated.error !== null) { this.set({ error: validated.error }); return; }
    const epoch = this.epoch;
    this.set({ phase: 'previewing', error: null, acknowledgedRiskIds: [] });
    try {
      const preview = await this.client.preview(session.prepared, preparation, validated.layout, includeExceptionIds, this.abort.signal);
      if (epoch !== this.epoch) return;
      this.set({ phase: 'preview', preview, previewIndex: Math.max(0, preview.affected.findIndex((item) => item.previous_id === preparation.sample_id)),
        // A revised round may become ineligible for a reusable template. Do
        // not carry a checked option into that round, while preserving the
        // ordinary current-round save path.
        rememberReference: templateReferenceAllowed(preview) ? this.state.rememberReference : false });
      if (this.state.rememberReference && this.state.templateSaveMode === 'update' && this.state.templateCandidatesStatus === 'idle') {
        void this.loadTemplateCandidates();
      }
    } catch (error) { if (epoch === this.epoch) this.set({ phase: 'editing', error: message(error) }); }
  }
  acknowledgeMany(riskIds: string[], checked: boolean) {
    const preview = this.state.preview;
    if (this.state.phase !== 'preview' || !preview || !Array.isArray(riskIds) || typeof checked !== 'boolean') return;
    const allowed = new Set(preview.risks.map((risk) => risk.risk_id));
    const requested = new Set(riskIds.filter((id): id is string => typeof id === 'string' && allowed.has(id)));
    const acknowledged = new Set(this.state.acknowledgedRiskIds.filter((id) => allowed.has(id)));
    for (const id of requested) {
      if (checked) acknowledged.add(id);
      else acknowledged.delete(id);
    }
    this.set({ acknowledgedRiskIds: [...acknowledged] });
  }
  acknowledge(riskId: string, checked: boolean) {
    this.acknowledgeMany([riskId], checked);
  }
  setRememberReference(value: boolean) {
    if (this.state.phase !== 'preview' || typeof value !== 'boolean') return;
    if (value && (!this.state.preview || !this.state.preparation
      || !templateReferenceAllowed(this.state.preview) || !templateReferenceAllowed(this.state.preparation))) return;
    this.set({ rememberReference: value });
    if (value && this.state.templateSaveMode === 'update' && this.state.templateCandidatesStatus === 'idle') void this.loadTemplateCandidates();
  }
  setTemplateName(value: string) {
    if (this.state.phase !== 'preview' || typeof value !== 'string') return;
    this.set({ templateName: value });
  }
  setTemplateBankName(value: string) {
    if (this.state.phase !== 'preview' || typeof value !== 'string') return;
    this.set({ templateBankName: value });
  }
  async setTemplateSaveMode(value: TemplateSaveMode) {
    if (this.state.phase !== 'preview' || !this.state.rememberReference || !['create', 'update'].includes(value)) return;
    this.templateLoadEpoch++;
    this.set({ templateSaveMode: value, templateId: null, templateCandidates: [], templateCandidatesStatus: 'idle', templateCandidatesError: null, error: null });
    if (value === 'update') await this.loadTemplateCandidates();
  }
  selectTemplate(id: string) {
    if (this.state.phase !== 'preview' || this.state.templateSaveMode !== 'update'
      || this.state.templateCandidatesStatus !== 'ready' || !this.state.preview) return;
    if (!id) { this.set({ templateId: null }); return; }
    const template = this.state.templateCandidates.find((item) => item.id === id);
    if (!template || !compatibleLayoutTemplate(template, this.state.preview.layout_definition)) return;
    this.set({ templateId: template.id, templateName: layoutTemplateName(template), templateBankName: template.bank_name ?? '', error: null });
  }
  async loadTemplateCandidates() {
    const { preview } = this.state;
    if (this.state.phase !== 'preview' || !this.state.rememberReference || this.state.templateSaveMode !== 'update' || !preview) return;
    const epoch = this.epoch, request = ++this.templateLoadEpoch;
    const current = () => epoch === this.epoch && request === this.templateLoadEpoch
      && this.state.phase === 'preview' && this.state.templateSaveMode === 'update';
    this.set({ templateCandidatesStatus: 'loading', templateCandidatesError: null, templateCandidates: [], templateId: null });
    try {
      const candidates: LayoutTemplate[] = [], seen = new Set<string>();
      let offset = 0;
      for (;;) {
        const page = await this.templateClient.list({ active_only: true, offset, limit: 50 }, this.abort.signal);
        if (!current()) return;
        for (const template of page.items) {
          if (seen.has(template.id)) throw new Error('模板列表已变化，请重新载入。');
          seen.add(template.id);
          if (compatibleLayoutTemplate(template, preview.layout_definition)) candidates.push(template);
        }
        if (page.next_offset === null) break;
        if (page.next_offset <= offset || page.next_offset > 100_000) throw new Error('模板列表过大或已变化，请重新载入。');
        offset = page.next_offset;
      }
      this.set({ templateCandidates: candidates, templateCandidatesStatus: 'ready' });
    } catch (error) {
      if (current()) this.set({ templateCandidatesStatus: 'error', templateCandidatesError: message(error) });
    }
  }
  async revise(includeExceptions = false) {
    const { preview } = this.state;
    if (this.state.phase !== 'preview' || !preview) return;
    if (preview.mode === 'template_apply') {
      await this.leave();
      return;
    }
    const epoch = this.epoch;
    this.templateLoadEpoch++;
    if (this.state.templateCandidatesStatus === 'loading') this.set({ templateCandidatesStatus: 'idle' });
    this.set({ phase: 'previewing', error: null });
    try {
      await this.client.cancel(preview);
      if (epoch !== this.epoch) return;
      this.set({ phase: 'editing', preview: null, acknowledgedRiskIds: [],
        includeExceptionIds: includeExceptions ? [...new Set([...this.state.includeExceptionIds, ...preview.retained_record_ids])] : this.state.includeExceptionIds });
    } catch (error) { if (epoch === this.epoch) this.set({ phase: 'preview', error: message(error) }); }
  }
  async save() {
    const { preview, acknowledgedRiskIds } = this.state;
    if (this.state.phase !== 'preview' || !preview?.can_save || preview.risks.some((risk) => !acknowledgedRiskIds.includes(risk.risk_id))) return;
    if (this.state.rememberReference && (!templateReferenceAllowed(preview)
      || !this.state.preparation || !templateReferenceAllowed(this.state.preparation))) return;
    const name = this.state.templateName.trim();
    if (this.state.rememberReference && (!name || name.length > 256 || name.includes('\0'))) {
      this.set({ error: '请输入 1 至 256 个字符的模板名称。' }); return;
    }
    if (this.state.rememberReference && (this.state.templateBankName.trim().length > 80 || this.state.templateBankName.includes('\0'))) {
      this.set({ error: '银行名称最多 80 个字符。' }); return;
    }
    if (this.state.rememberReference && this.state.templateSaveMode === 'update'
      && (this.state.templateCandidatesStatus !== 'ready'
        || !this.state.templateCandidates.some((item) => item.id === this.state.templateId && compatibleLayoutTemplate(item, preview.layout_definition)))) {
      this.set({ error: '请载入并选择要更新的兼容模板。' }); return;
    }
    await this.persist(false);
  }
  async retryTemplateSave() {
    if (this.state.phase !== 'saved' || this.state.writeAction !== 'save' || !this.state.rememberReference
      || !this.state.preview || !templateReferenceAllowed(this.state.preview) || !canRetryTemplateSave(this.state.operation)) return;
    await this.persist(false);
  }
  async recover() {
    if (this.state.phase !== 'uncertain') return;
    if (this.state.writeAction === 'undo') await this.persistUndo();
    else await this.persist(true);
  }
  async undo() {
    const { operation, session } = this.state;
    if (this.state.phase !== 'saved' || !operation || !session) return;
    // The journal requires the same undo ID when a response or subsequent reload is lost.
    await this.persistUndo({ ...operation, undo_id: crypto.randomUUID() });
  }
  private async persistUndo(operation = this.state.operation) {
    const { session, selectedId } = this.state;
    if (!operation?.undo_id || !session) return;
    const epoch = ++this.epoch;
    this.set({ phase: 'saving', writeAction: 'undo', operation, preview: null, error: null });
    try {
      const result = await this.client.undo(operation, operation.undo_id);
      if (epoch !== this.epoch) return;
      if (result.state !== 'undone') throw new Error('本轮撤销尚未完成，请稍后重试。');
      const restored = await this.reload(result.job_id, result.result_revision);
      if (epoch !== this.epoch) return;
      const selected = restored.items.find((item) => item.original.id === selectedId);
      this.set({ phase: 'saved', session: restored, selectedId: selected?.original.id ?? restored.items[0]?.original.id ?? null,
        operation: null, error: null });
    } catch (error) {
      if (epoch === this.epoch) this.set({ phase: 'uncertain', error: `撤销结果需要核实：${message(error)} 请核实本轮，不要重复创建新一轮。` });
    }
  }
  private async persist(recover: boolean) {
    const { preview, acknowledgedRiskIds, rememberReference, templateName, templateSaveMode, templateId, templateBankName } = this.state;
    if (!preview) return;
    const epoch = this.epoch;
    this.set({ phase: 'saving', writeAction: 'save', error: null });
    try {
      const name = rememberReference ? templateName.trim() : null;
      const save = () => this.client.save(preview, acknowledgedRiskIds, rememberReference, name,
        templateSaveMode, templateId, rememberReference ? templateBankName.trim() || null : null);
      let operation = recover ? await this.client.status(preview) : await save();
      if (epoch !== this.epoch) return;
      if (recover && operation.state === 'preview') {
        // A confirmed preview has no committed write to replay. Let the user
        // replace a stale/unavailable target without changing a committed intent.
        this.set({ phase: 'preview', writeAction: null, operation: null,
          error: '已确认本轮尚未保存，请重新确认保存方式与目标模板后保存。' });
        if (rememberReference && templateSaveMode === 'update') await this.loadTemplateCandidates();
        return;
      }
      // The journal status has no template outcome. Replay the same operation
      // when saving a template, so a lost response cannot hide a failed template write.
      if (recover && (operation.state === 'committed' || rememberReference && operation.state === 'applied')) {
        operation = await save();
      }
      if (epoch !== this.epoch) return;
      if (operation.state !== 'applied') throw new Error('本轮保存尚未完成，请核实保存结果。');
      this.set({ operation });
      const session = await this.reload(operation.job_id, operation.result_revision);
      if (epoch !== this.epoch) return;
      const sample = this.state.session?.items.find((item) => item.original.id === this.state.selectedId)?.original;
      const selected = session.items.find((item) => sample && item.original.source_key === sample.source_key
        && item.original.source_page === sample.source_page && item.original.slot_id === sample.slot_id);
      const applyingTemplate = preview.mode === 'template_apply';
      const pending = applyingTemplate ? session.items.filter((item) => needsReceiptReview(item)) : [];
      this.set({ phase: 'saved', session, reviewFilter: applyingTemplate ? 'pending' : this.state.reviewFilter,
        selectedId: applyingTemplate ? pending[0]?.original.id ?? null
          : selected?.original.id ?? session.items[0]?.original.id ?? null });
    } catch (error) {
      if (epoch === this.epoch) this.set({ phase: 'uncertain', error: `保存结果需要核实：${message(error)} 请核实本轮，不要重复创建新一轮。` });
    }
  }
  async leave() {
    if (this.state.reviewConfirming || ['saving', 'uncertain'].includes(this.state.phase)) return;
    const session = this.state.session, selectedId = this.state.selectedId;
    const applyingTemplate = this.state.preview?.mode === 'template_apply' && this.state.phase === 'saved';
    this.bind(session);
    if (applyingTemplate) this.set({ reviewFilter: 'pending',
      selectedId: session?.items.find((item) => needsReceiptReview(item))?.original.id ?? null });
    else this.set({ selectedId });
  }
}
