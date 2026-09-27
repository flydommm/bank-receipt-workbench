import { invoke } from '@tauri-apps/api/core';
import { parseReceiptBatchResponse, serializedReceiptBatchBytes, type ReceiptBatchPreparedReview } from '../domain/receiptBatch';
import { parseLayoutDefinition, type LayoutDefinition } from '../domain/receiptLayout';
import type { PdfRect } from '../domain/cropReview';
import { ReceiptBatchClientError, type ReceiptBatchInvoke } from './receiptBatchClient';

export type ReceiptLayoutPreparation = {
  schema_version: 1; job_id: string; result_revision: string; context_key: string; sample_id: string;
  selected_slot_id: string; preparation_fingerprint: string; layout_definition: LayoutDefinition;
  scope_kind: 'verified_layout' | 'current_pdf'; pages: { source_key: string; page: number }[];
  source_count: number; page_count: number; excluded_page_counts: Record<string, number>;
  editable_slot_ids?: string[]; template_allowed?: false;
};
export type ReceiptLayoutTarget = {
  source_key: string; page: number; slot_id: string; previous_id: string | null; id: string | null;
  before_rect: PdfRect | null; after_rect: PdfRect | null;
  status: 'updated' | 'added' | 'removed' | 'retained_manual';
};
export type ReceiptLayoutRisk = {
  risk_id: string; source_key: string; page: number; diagnostic: Record<string, unknown>;
};
export type ReceiptLayoutPreview = {
  schema_version: 1; job_id: string; result_revision: string; sample_id: string; operation_id: string;
  preview_fingerprint: string; layout_definition: LayoutDefinition; can_save: boolean;
  affected: ReceiptLayoutTarget[]; risks: ReceiptLayoutRisk[]; blockers: Record<string, unknown>[];
  retained_record_ids: string[]; included_exception_ids: string[]; candidate_count: number; page_count: number; saved: false;
  template_allowed?: false;
  mode?: 'template_apply'; template_id?: string; applied_slot_ids?: string[];
  excluded_page_counts?: Record<string, number>; preserved_excluded_count?: number;
};
/**
 * Cross-file template reuse needs both the explicit server permission and a
 * stable issuer/family identity. A round can still be saved when this is
 * false; only the optional reusable-template write is unavailable.
 */
export function templateReferenceAllowed(value: Pick<ReceiptLayoutPreparation | ReceiptLayoutPreview, 'layout_definition' | 'template_allowed'>
  & { mode?: ReceiptLayoutPreview['mode'] }): boolean {
  return value.mode !== 'template_apply' && value.template_allowed !== false
    && Boolean(value.layout_definition.issuer_id && value.layout_definition.family_id);
}
export type ReceiptLayoutOperation = {
  schema_version: 1; operation_id: string; job_id: string; result_revision: string;
  state: 'preview' | 'committed' | 'applied' | 'cancelled' | 'undone' | 'undo_pending'; saved_count: number;
  undo_id?: string; reference_state?: 'saved' | 'disabled' | 'failed';
  reference_error_code?: TemplateSaveErrorCode;
  template_id?: string; template_name?: string; template_version?: number;
};
export type TemplateSaveMode = 'create' | 'update';
const templateSaveErrorMessages = {
  shared_geometry_changed: '左右边距影响所有栏位，请重新调整并核对全部栏位后保存模板。',
  template_geometry_conflict: '与已保存栏位合并后，框位重叠或超出页面，请重新调整并预览。',
  operation_inactive: '本轮对应的模板已停用、更新或撤销，或审核、分类已变化，请开始新一轮微调后保存。',
  identity_unavailable: '当前版式身份尚未核实，不能保存跨文件版式模板；本轮审核已保存。',
  storage_unavailable: '暂时无法写入模板库，可以重试保存模板。',
  invalid_reference: '模板数据校验未通过，请重新调整并预览；若再次失败，请通过帮助与反馈报告。',
  template_unavailable: '所选模板已停用或不可用，请开始新一轮微调后重新选择。',
  template_conflict: '所选模板已更新，请开始新一轮微调并选择最新版本。',
  template_incompatible: '所选模板与本轮版式不兼容，请开始新一轮微调后重新选择。',
  operation_conflict: '本轮曾使用其他保存方式或目标模板，请开始新一轮微调后保存。',
} as const;
type TemplateSaveErrorCode = keyof typeof templateSaveErrorMessages;
export const canRetryTemplateSave = (operation: ReceiptLayoutOperation | null) =>
  operation?.reference_state === 'failed'
  && (operation.reference_error_code === undefined || operation.reference_error_code === 'storage_unavailable');
export const templateSaveFailureMessage = (operation: ReceiptLayoutOperation) =>
  `本轮审核已保存，但版式模板未保存成功。${operation.reference_error_code
    ? templateSaveErrorMessages[operation.reference_error_code] : '可以重试保存模板。'}`;
export type ReceiptLayoutUndo = {
  schema_version: 1; operation_id: string; job_id: string; undo_id: string;
  result_revision: string; state: 'undone' | 'undo_pending'; saved_count: 0;
  restored_count: number; template_withdrawal: Record<string, unknown> | null;
};

function invalid(): never { throw new ReceiptBatchClientError('calibration_invalid_response', '版式操作返回的数据不完整，请重新载入结果。'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).length !== fields.length || fields.some((field) => !(field in record))) return invalid();
  return record;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32768 || value.includes('\0')) return invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return invalid();
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 50_000) return invalid();
  return value;
}
function ids(value: unknown): string[] {
  const result = array(value).map(text);
  if (new Set(result).size !== result.length) return invalid();
  return result;
}
function rect(value: unknown): PdfRect | null {
  if (value === null) return null;
  const box = exact(value, ['x0', 'y0', 'x1', 'y1']);
  if (Object.values(box).some((item) => typeof item !== 'number' || !Number.isFinite(item))) return invalid();
  const result = box as PdfRect;
  if (result.x0 < 0 || result.y0 < 0 || result.x0 >= result.x1 || result.y0 >= result.y1) return invalid();
  return result;
}
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('版式操作已取消。', 'AbortError');
}
function pageBinding(binding: ReceiptBatchPreparedReview, sourceKey: unknown, page: unknown): void {
  const source = binding.binding.job.sources.find((candidate) => candidate.source_key === sourceKey);
  if (!source || count(page) < 1 || count(page) > (source.page_count ?? 0)) invalid();
}
export function withinEditableLayout(preparation: ReceiptLayoutPreparation, draft: LayoutDefinition): boolean {
  const allowed = preparation.editable_slot_ids;
  if (!allowed) return true;
  const base = preparation.layout_definition;
  return draft.uniform_height === false && draft.left_pt === base.left_pt && draft.right_pt === base.right_pt
    && draft.slots.length === base.slots.length && draft.slots.every((slot, index) => {
      const previous = base.slots[index];
      return slot.slot_id === previous.slot_id && slot.position_index === previous.position_index
        && (allowed.includes(slot.slot_id) || slot.top_pt === previous.top_pt && slot.height_pt === previous.height_pt);
    });
}

export class ReceiptLayoutClient {
  constructor(private readonly transport: ReceiptBatchInvoke = invoke) {}

  private async call(request: Record<string, unknown>): Promise<unknown> {
    serializedReceiptBatchBytes({ request });
    let raw: unknown;
    try {
      raw = await this.transport<unknown>('batch_command', { request });
    } catch (error) {
      // Native Result<String> rejections are not Error instances. Only map
      // known host messages; other native details may contain private paths.
      if (error === 'local engine operation timed out') {
        const detail = request.op === 'batch_receipt_template_apply_preview'
          ? '模板应用预览超时，当前分析结果未变，可以重试。'
          : request.op === 'batch_receipt_calibration_preview'
            ? '大批页面版式预览超时，调整草稿已保留，可以重试。' : '本地版式操作超时，请重试。';
        throw new ReceiptBatchClientError('calibration_timeout', detail);
      }
      if (error instanceof Error) throw error;
      throw new ReceiptBatchClientError('calibration_host_failed', '版式操作未完成，请重试。');
    }
    serializedReceiptBatchBytes(raw);
    const response = parseReceiptBatchResponse(raw);
    if (response.status === 'error') throw new ReceiptBatchClientError(response.code, response.message);
    return response.data;
  }

  async prepare(binding: ReceiptBatchPreparedReview, sampleId: string, signal?: AbortSignal): Promise<ReceiptLayoutPreparation> {
    aborted(signal);
    const raw = object(await this.call({ op: 'batch_receipt_calibration_prepare', job_id: binding.binding.job.id,
      result_revision: binding.prepared.result_revision, sample_id: text(sampleId) }));
    const value = exact(raw, [
      'schema_version', 'job_id', 'result_revision', 'context_key', 'sample_id', 'selected_slot_id',
      'preparation_fingerprint', 'layout_definition', 'scope_kind', 'pages', 'source_count', 'page_count', 'excluded_page_counts',
      ...('editable_slot_ids' in raw ? ['editable_slot_ids'] : []), ...('template_allowed' in raw ? ['template_allowed'] : []),
    ]);
    aborted(signal);
    if (value.schema_version !== 1 || value.job_id !== binding.binding.job.id || value.result_revision !== binding.prepared.result_revision
      || value.context_key !== binding.prepared.context_key || value.sample_id !== sampleId
      || !['verified_layout', 'current_pdf'].includes(text(value.scope_kind))) invalid();
    const layout = parseLayoutDefinition(value.layout_definition);
    if (!layout.slots.some((slot) => slot.slot_id === value.selected_slot_id)) invalid();
    const pages = array(value.pages).map((item) => {
      const page = exact(item, ['source_key', 'page']);
      pageBinding(binding, page.source_key, page.page);
      return { source_key: text(page.source_key), page: count(page.page) };
    });
    if (new Set(pages.map((page) => JSON.stringify(page))).size !== pages.length || pages.length !== count(value.page_count)
      || new Set(pages.map((page) => page.source_key)).size !== count(value.source_count)) invalid();
    const excluded = Object.fromEntries(Object.entries(object(value.excluded_page_counts)).map(([key, number]) => [key, count(number)]));
    if ('editable_slot_ids' in value) {
      const allowed = ids(value.editable_slot_ids);
      if (value.template_allowed !== false || allowed.length !== 1 || allowed[0] !== value.selected_slot_id
        || pages.length !== 1 || value.source_count !== 1 || layout.uniform_height) invalid();
    }
    // A complete page can be valid for this round while lacking the stable
    // issuer/family identity required by a reusable cross-file template. The
    // backend reports that case with template_allowed=false but without the
    // protected single-slot metadata above.
    if ('template_allowed' in value && value.template_allowed !== false) invalid();
    // A known-identity response that omits editable_slot_ids is the older
    // malformed protected-page shape; keep rejecting it. The flag without
    // those ids is valid only when the layout identity itself is incomplete.
    if (value.template_allowed === false && !('editable_slot_ids' in value)
      && layout.issuer_id !== null && layout.family_id !== null) invalid();
    return { ...value, preparation_fingerprint: digest(value.preparation_fingerprint), layout_definition: layout,
      pages, excluded_page_counts: excluded } as ReceiptLayoutPreparation;
  }

  async preview(binding: ReceiptBatchPreparedReview, preparation: ReceiptLayoutPreparation, layout: LayoutDefinition,
    includeExceptionIds: string[] = [], signal?: AbortSignal): Promise<ReceiptLayoutPreview> {
    aborted(signal);
    // Draft keystrokes need not consume persisted application revisions.
    const draft = parseLayoutDefinition({ ...layout, revision: preparation.layout_definition.revision + 1 });
    if (!withinEditableLayout(preparation, draft)) throw new ReceiptBatchClientError('calibration_protected_scope', '人工分类页面仅可调整所选栏位，其他栏位和公共边距已锁定。');
    const raw = object(await this.call({ op: 'batch_receipt_calibration_preview', job_id: preparation.job_id,
      result_revision: preparation.result_revision, sample_id: preparation.sample_id,
      preparation_fingerprint: preparation.preparation_fingerprint, layout_definition: draft,
      include_exception_ids: ids(includeExceptionIds) }));
    const value = exact(raw, [
      'schema_version', 'job_id', 'result_revision', 'sample_id', 'operation_id', 'preview_fingerprint', 'layout_definition',
      'can_save', 'affected', 'risks', 'blockers', 'retained_record_ids', 'included_exception_ids', 'candidate_count', 'page_count', 'saved',
      ...('template_allowed' in raw ? ['template_allowed'] : []),
    ]);
    if (value.schema_version !== 1 || value.saved !== false || value.job_id !== preparation.job_id
      || value.result_revision !== preparation.result_revision || value.sample_id !== preparation.sample_id
      || typeof value.can_save !== 'boolean' || count(value.page_count) !== preparation.page_count) invalid();
    if (('template_allowed' in value && value.template_allowed !== false)
      || value.template_allowed !== preparation.template_allowed) invalid();
    const allowedPages = new Set(preparation.pages.map((page) => `${page.source_key}\0${page.page}`));
    const inScope = (sourceKey: unknown, page: unknown) => {
      pageBinding(binding, sourceKey, page);
      if (!allowedPages.has(`${sourceKey}\0${page}`)) invalid();
    };
    const affected = array(value.affected).map((item) => {
      const target = exact(item, ['source_key', 'page', 'slot_id', 'previous_id', 'id', 'before_rect', 'after_rect', 'status']);
      inScope(target.source_key, target.page);
      text(target.slot_id);
      if (preparation.editable_slot_ids && !preparation.editable_slot_ids.includes(target.slot_id as string)) invalid();
      if (!['updated', 'added', 'removed', 'retained_manual'].includes(text(target.status))) invalid();
      if (target.id !== null) digest(target.id);
      if (target.previous_id !== null) digest(target.previous_id);
      return { ...target, before_rect: rect(target.before_rect), after_rect: rect(target.after_rect) } as ReceiptLayoutTarget;
    });
    if (new Set(affected.map((item) => `${item.source_key}\0${item.page}\0${item.slot_id}`)).size !== affected.length) invalid();
    const risks = array(value.risks).map((item) => {
      const risk = exact(item, ['risk_id', 'source_key', 'page', 'diagnostic']);
      inScope(risk.source_key, risk.page);
      return { ...risk, risk_id: digest(risk.risk_id), diagnostic: object(risk.diagnostic) } as ReceiptLayoutRisk;
    });
    const blockers = array(value.blockers).map(object);
    if (value.can_save && (blockers.length > 0 || affected.length === 0)) invalid();
    const result = { ...value, operation_id: text(value.operation_id), preview_fingerprint: digest(value.preview_fingerprint),
      layout_definition: parseLayoutDefinition(value.layout_definition), affected, risks, blockers,
      retained_record_ids: ids(value.retained_record_ids), included_exception_ids: ids(value.included_exception_ids),
      candidate_count: count(value.candidate_count) } as ReceiptLayoutPreview;
    if (!withinEditableLayout(preparation, result.layout_definition)) invalid();
    if (signal?.aborted) {
      await this.cancel(result);
      aborted(signal);
    }
    return result;
  }

  /** Preview a saved template against the current, already analysed result. */
  async templateApplyPreview(binding: ReceiptBatchPreparedReview, templateId: string,
    signal?: AbortSignal): Promise<ReceiptLayoutPreview> {
    aborted(signal);
    if (typeof templateId !== 'string' || !templateId.trim() || templateId.trim().length > 256 || templateId.includes('\0')) {
      throw new ReceiptBatchClientError('calibration_invalid_request', '请选择有效的版式模板。');
    }
    const requestedId = templateId.trim();
    const raw = object(await this.call({ op: 'batch_receipt_template_apply_preview',
      job_id: binding.binding.job.id, result_revision: binding.prepared.result_revision, template_id: requestedId }));
    const value = exact(raw, [
      'schema_version', 'job_id', 'result_revision', 'sample_id', 'operation_id', 'preview_fingerprint', 'layout_definition',
      'can_save', 'affected', 'risks', 'blockers', 'retained_record_ids', 'included_exception_ids', 'candidate_count',
      'page_count', 'saved', 'mode', 'template_id', 'applied_slot_ids', 'excluded_page_counts', 'preserved_excluded_count', 'template_allowed',
    ]);
    if (value.schema_version !== 1 || value.job_id !== binding.binding.job.id
      || value.result_revision !== binding.prepared.result_revision || value.saved !== false
      || value.mode !== 'template_apply' || value.template_id !== requestedId || value.template_allowed !== false
      || typeof value.can_save !== 'boolean' || count(value.page_count) < 1) invalid();
    const layout = parseLayoutDefinition(value.layout_definition);
    const appliedSlotIds = ids(value.applied_slot_ids);
    const slots = new Set(layout.slots.map((slot) => slot.slot_id));
    if (!appliedSlotIds.length || appliedSlotIds.some((id) => !slots.has(id))) invalid();
    const excluded = Object.fromEntries(Object.entries(object(value.excluded_page_counts)).map(([key, amount]) => {
      if (!key || key.length > 256 || key.includes('\0')) invalid();
      return [key, count(amount)];
    }));
    const affected = array(value.affected).map((item) => {
      const target = exact(item, ['source_key', 'page', 'slot_id', 'previous_id', 'id', 'before_rect', 'after_rect', 'status']);
      pageBinding(binding, target.source_key, target.page);
      if (!slots.has(text(target.slot_id))
        || !['updated', 'added', 'removed', 'retained_manual'].includes(text(target.status))) invalid();
      if (target.id !== null) digest(target.id);
      if (target.previous_id !== null) digest(target.previous_id);
      return { ...target, before_rect: rect(target.before_rect), after_rect: rect(target.after_rect) } as ReceiptLayoutTarget;
    });
    if (new Set(affected.map((item) => `${item.source_key}\0${item.page}\0${item.slot_id}`)).size !== affected.length) invalid();
    const risks = array(value.risks).map((item) => {
      const risk = exact(item, ['risk_id', 'source_key', 'page', 'diagnostic']);
      pageBinding(binding, risk.source_key, risk.page);
      return { ...risk, risk_id: digest(risk.risk_id), diagnostic: object(risk.diagnostic) } as ReceiptLayoutRisk;
    });
    const blockers = array(value.blockers).map(object);
    if (value.can_save && (blockers.length > 0 || affected.length === 0)) invalid();
    const result: ReceiptLayoutPreview = {
      schema_version: 1, job_id: binding.binding.job.id, result_revision: binding.prepared.result_revision,
      sample_id: digest(value.sample_id), operation_id: text(value.operation_id),
      preview_fingerprint: digest(value.preview_fingerprint), layout_definition: layout,
      can_save: value.can_save as boolean, affected, risks, blockers,
      retained_record_ids: ids(value.retained_record_ids), included_exception_ids: ids(value.included_exception_ids),
      candidate_count: count(value.candidate_count), page_count: count(value.page_count), saved: false,
      mode: 'template_apply', template_id: requestedId, applied_slot_ids: appliedSlotIds,
      excluded_page_counts: excluded, preserved_excluded_count: count(value.preserved_excluded_count), template_allowed: false,
    };
    if (signal?.aborted) {
      await this.cancel(result);
      aborted(signal);
    }
    return result;
  }

  private operation(value: unknown, preview: Pick<ReceiptLayoutPreview, 'job_id' | 'operation_id'>, status = false): ReceiptLayoutOperation {
    const base = object(value);
    const undoState = status && (base.state === 'undone' || base.state === 'undo_pending');
    const referenceState = !status && 'reference_state' in base;
    const referenceError = !status && 'reference_error_code' in base;
    const templateFields = ['template_id', 'template_name', 'template_version'].filter((key) => key in base);
    const parsed = exact(value, ['schema_version', 'job_id', 'operation_id', 'result_revision', 'state', 'saved_count',
      ...(status ? ['preview_fingerprint'] : []), ...(undoState ? ['undo_id'] : []), ...(referenceState ? ['reference_state'] : []),
      ...(referenceError ? ['reference_error_code'] : []), ...templateFields]);
    if (parsed.schema_version !== 1 || parsed.job_id !== preview.job_id || parsed.operation_id !== preview.operation_id
      || !['preview', 'committed', 'applied', 'cancelled', 'undone', 'undo_pending'].includes(text(parsed.state))) invalid();
    text(parsed.result_revision); count(parsed.saved_count);
    if (status) digest(parsed.preview_fingerprint);
    if (undoState) text(parsed.undo_id);
    if (referenceState && !['saved', 'disabled', 'failed'].includes(text(parsed.reference_state))) invalid();
    if (referenceError && (parsed.reference_state !== 'failed'
      || !Object.hasOwn(templateSaveErrorMessages, text(parsed.reference_error_code)))) invalid();
    if (templateFields.length) {
      if (status || parsed.reference_state !== 'saved' || templateFields.length !== 3
        || text(parsed.template_id).length > 256 || text(parsed.template_name).length > 256
        || count(parsed.template_version) < 1) invalid();
    }
    return parsed as ReceiptLayoutOperation;
  }

  async save(preview: ReceiptLayoutPreview, acknowledgedRiskIds: string[], rememberReference = false, templateName: string | null = null,
    saveMode: TemplateSaveMode = 'create', templateId: string | null = null, bankName: string | null = null): Promise<ReceiptLayoutOperation> {
    if (!templateReferenceAllowed(preview) && rememberReference) throw new ReceiptBatchClientError('calibration_protected_scope', '当前版式不具备可复用模板资格。');
    if (typeof rememberReference !== 'boolean') throw new ReceiptBatchClientError('calibration_invalid_request', '版式模板选项无效。');
    if (rememberReference && (typeof templateName !== 'string' || !templateName.trim() || templateName.trim().length > 256 || templateName.includes('\0'))) {
      throw new ReceiptBatchClientError('calibration_invalid_request', '请输入 1 至 256 个字符的模板名称。');
    }
    if (saveMode !== 'create' && saveMode !== 'update') throw new ReceiptBatchClientError('calibration_invalid_request', '模板保存方式无效。');
    if (rememberReference && saveMode === 'update' && (typeof templateId !== 'string' || !templateId.trim() || templateId.length > 256 || templateId.includes('\0'))) {
      throw new ReceiptBatchClientError('calibration_invalid_request', '请选择要更新的兼容模板。');
    }
    if (saveMode === 'create' && templateId !== null) throw new ReceiptBatchClientError('calibration_invalid_request', '新建模板不能指定更新目标。');
    if (bankName !== null && (typeof bankName !== 'string' || bankName.trim().length > 80 || bankName.includes('\0'))) {
      throw new ReceiptBatchClientError('calibration_invalid_request', '银行名称最多 80 个字符。');
    }
    if (!preview.can_save) throw new ReceiptBatchClientError('calibration_blocked', '本轮仍有需要处理的版式问题。');
    // Do not abort a write and mistake an unknown outcome for a failed save.
    return this.operation(await this.call({ op: 'batch_receipt_calibration_save', job_id: preview.job_id,
      operation_id: preview.operation_id, preview_fingerprint: preview.preview_fingerprint,
      acknowledged_risk_ids: ids(acknowledgedRiskIds), remember_reference: rememberReference,
      template_name: rememberReference ? templateName!.trim() : null,
      template_save_mode: rememberReference ? saveMode : 'create', template_id: rememberReference ? templateId : null,
      template_bank_name: rememberReference ? bankName?.trim() || null : null }), preview);
  }

  async status(preview: Pick<ReceiptLayoutPreview, 'job_id' | 'operation_id'>): Promise<ReceiptLayoutOperation> {
    return this.operation(await this.call({ op: 'batch_receipt_calibration_status', job_id: preview.job_id,
      operation_id: preview.operation_id }), preview, true);
  }

  async cancel(preview: Pick<ReceiptLayoutPreview, 'job_id' | 'operation_id'>): Promise<void> {
    const result = exact(await this.call({ op: 'batch_receipt_calibration_cancel', job_id: preview.job_id,
      operation_id: preview.operation_id }), ['cancelled']);
    if (result.cancelled !== true) invalid();
  }

  async undo(operation: Pick<ReceiptLayoutOperation, 'job_id' | 'operation_id'>, undoId: string = crypto.randomUUID()): Promise<ReceiptLayoutUndo> {
    const value = exact(await this.call({ op: 'batch_receipt_calibration_undo', job_id: operation.job_id,
      operation_id: operation.operation_id, undo_id: text(undoId) }),
      ['schema_version', 'operation_id', 'job_id', 'undo_id', 'result_revision', 'state', 'saved_count', 'restored_count', 'template_withdrawal']);
    if (value.schema_version !== 1 || value.operation_id !== operation.operation_id || value.job_id !== operation.job_id
      || !['undone', 'undo_pending'].includes(text(value.state)) || value.saved_count !== 0
      || !Number.isSafeInteger(value.restored_count) || (value.restored_count as number) < 0) invalid();
    return { ...value, operation_id: text(value.operation_id), job_id: text(value.job_id), undo_id: text(value.undo_id),
      result_revision: text(value.result_revision), state: text(value.state) as ReceiptLayoutUndo['state'],
      restored_count: value.restored_count as number,
      template_withdrawal: value.template_withdrawal === null ? null : object(value.template_withdrawal) } as ReceiptLayoutUndo;
  }
}
