import { invoke } from '@tauri-apps/api/core';
import { parseLayoutDefinition, type LayoutDefinition, type PageGeometry, type ReceiptSlot } from '../domain/receiptLayout';
import { parseReceiptBatchResponse, serializedReceiptBatchBytes } from '../domain/receiptBatch';
import { ReceiptBatchClientError, type ReceiptBatchInvoke } from './receiptBatchClient';

export type LayoutTemplate = {
  id: string; version: number; name: string | null; source_scope: string;
  page_geometry: PageGeometry; layout_fingerprint: string; slots: Array<{ slot_id: string; position_index: number; rect: { x0: number; y0: number; x1: number; y1: number } }>;
  evidence_summary: Record<string, unknown>; source_operation_id: string; active: boolean;
  created_at: string; updated_at: string;
  series_id?: string; bank_name?: string | null;
};
export type LayoutTemplatePage = { items: LayoutTemplate[]; total: number; next_offset: number | null };
export type LayoutTemplateListRequest = { active_only: boolean; offset: number; limit: number };

export function layoutTemplateName(template: LayoutTemplate): string {
  return template.name ?? `${template.slots.length}栏回单模板`;
}

export function layoutTemplateBankName(template: LayoutTemplate): string {
  return template.bank_name?.trim() || '未标注银行名称';
}

function sameGeometry(left: PageGeometry, right: PageGeometry): boolean {
  return left.width_pt === right.width_pt && left.height_pt === right.height_pt
    && left.rotation === right.rotation && left.user_unit === right.user_unit
    && (['x0', 'x1', 'y0', 'y1'] as const).every((key) => left.pdf_box[key] === right.pdf_box[key]);
}

/** Display labels never establish compatibility; retain the verified runtime scope. */
export function compatibleLayoutTemplate(template: LayoutTemplate, layout: LayoutDefinition): boolean {
  if (!template.active || !layout.issuer_id || !layout.family_id) return false;
  try {
    const saved = parseLayoutDefinition(template.evidence_summary.layout_definition);
    return saved.workspace_id === layout.workspace_id && saved.issuer_id === layout.issuer_id && saved.family_id === layout.family_id
      && saved.evidence_version === layout.evidence_version
      && sameGeometry(saved.page_geometry, layout.page_geometry) && sameGeometry(template.page_geometry, layout.page_geometry)
      && saved.slots.length === layout.slots.length && template.slots.length === layout.slots.length
      && layout.slots.every((slot, index) => saved.slots[index].slot_id === slot.slot_id
        && saved.slots[index].position_index === slot.position_index
        && template.slots[index].slot_id === slot.slot_id && template.slots[index].position_index === slot.position_index);
  } catch { return false; }
}

function invalid(): never { throw new ReceiptBatchClientError('template_invalid_response', '版式模板返回的数据不完整，请重新载入。'); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(); return value as Record<string, unknown>; }
function text(value: unknown, max = 32768): string { if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) return invalid(); return value; }
function hash(value: unknown): string { const result = text(value, 64); if (!/^[a-f0-9]{64}$/.test(result)) return invalid(); return result; }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid(); return value; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return invalid(); return value; }
function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(); return value; }
function geometry(value: unknown): PageGeometry { const data = object(value); const box = object(data.pdf_box); const rect = { x0: finite(box.x0), y0: finite(box.y0), x1: finite(box.x1), y1: finite(box.y1) }; if (rect.x0 >= rect.x1 || rect.y0 >= rect.y1) return invalid(); const rotation = data.rotation; if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) return invalid(); const userUnit = finite(data.user_unit); const width = finite(data.width_pt); const height = finite(data.height_pt); if (userUnit <= 0 || width <= 0 || height <= 0) return invalid(); return { pdf_box: rect, rotation, user_unit: userUnit, width_pt: width, height_pt: height } as PageGeometry; }
function slots(value: unknown, page: PageGeometry): LayoutTemplate['slots'] { if (!Array.isArray(value) || value.length < 1 || value.length > 1000) return invalid(); const seen = new Set<number>(); return value.map((entry) => { const data = object(entry); if (Object.keys(data).length !== 3 || typeof data.slot_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.slot_id) || typeof data.position_index !== 'number') return invalid(); const position = integer(data.position_index, 1, 1000); if (seen.has(position)) return invalid(); seen.add(position); const raw = object(data.rect); const rect = { x0: finite(raw.x0), y0: finite(raw.y0), x1: finite(raw.x1), y1: finite(raw.y1) }; if (rect.x0 < 0 || rect.y0 < 0 || rect.x0 >= rect.x1 || rect.y0 >= rect.y1 || rect.x1 > page.width_pt || rect.y1 > page.height_pt) return invalid(); return { slot_id: data.slot_id as string, position_index: position, rect }; }); }
function parse(value: unknown): LayoutTemplate { const data = object(value); const page = geometry(data.page_geometry); return { id: text(data.id, 256), version: integer(data.version, 1), name: data.name === null ? null : text(data.name, 256), source_scope: text(data.source_scope, 256), page_geometry: page, layout_fingerprint: hash(data.layout_fingerprint), slots: slots(data.slots, page), evidence_summary: object(data.evidence_summary), source_operation_id: text(data.source_operation_id, 256), active: boolean(data.active), created_at: text(data.created_at, 128), updated_at: text(data.updated_at, 128),
  ...('series_id' in data ? { series_id: text(data.series_id, 256) } : {}),
  ...('bank_name' in data ? { bank_name: data.bank_name === null ? null : text(data.bank_name, 80) } : {}) }; }

export class LayoutTemplateClient {
  constructor(private readonly transport: ReceiptBatchInvoke = invoke) {}
  private async call<T>(request: Record<string, unknown>): Promise<T> { serializedReceiptBatchBytes({ request }); const raw = await this.transport<unknown>('batch_command', { request }); serializedReceiptBatchBytes(raw); const response = parseReceiptBatchResponse(raw); if (response.status === 'error') throw new ReceiptBatchClientError(response.code, response.message); return response.data as T; }
  async save(template: { name?: string; source_scope: string; page_geometry: PageGeometry; layout_fingerprint: string; slots: LayoutTemplate['slots']; evidence_summary: Record<string, unknown>; source_operation_id: string }): Promise<LayoutTemplate> { return parse(await this.call({ op: 'batch_layout_template_save', template })); }
  async match(sourceScope: string, pageGeometry: PageGeometry, layoutFingerprint: string, slotDefinitions: LayoutTemplate['slots']): Promise<LayoutTemplate | null> { const value = await this.call<unknown>({ op: 'batch_layout_template_match', source_scope: sourceScope, page_geometry: pageGeometry, layout_fingerprint: layoutFingerprint, slots: slotDefinitions }); if (value === null) return null; return parse(value); }
  async deactivate(templateId: string, operationId?: string): Promise<boolean> { const value = object(await this.call({ op: 'batch_layout_template_deactivate', template_id: templateId, operation_id: operationId ?? null })); return boolean(value.deactivated); }
  async withdrawOperation(operationId: string, undoId: string): Promise<{ operation_id: string; undo_id: string; deactivated_count: number; created_at: string }> { const value = object(await this.call({ op: 'batch_layout_template_withdraw_operation', operation_id: operationId, undo_id: undoId })); return { operation_id: text(value.operation_id, 256), undo_id: text(value.undo_id, 256), deactivated_count: integer(value.deactivated_count), created_at: text(value.created_at, 128) }; }

  async list(input: LayoutTemplateListRequest, signal?: AbortSignal): Promise<LayoutTemplatePage> {
    const aborted = () => { if (signal?.aborted) throw new DOMException('模板载入已取消。', 'AbortError'); };
    aborted();
    const request = { op: 'batch_layout_template_list', active_only: boolean(input.active_only),
      offset: integer(input.offset), limit: integer(input.limit, 1, 50) };
    const value = object(await this.call(request));
    aborted();
    if (Object.keys(value).length !== 3 || !Array.isArray(value.items) || value.items.length > input.limit) invalid();
    const items = value.items.map(parse);
    const total = integer(value.total);
    const nextOffset = value.next_offset === null ? null : integer(value.next_offset);
    if (new Set(items.map((item) => item.id)).size !== items.length
      || (input.active_only && items.some((item) => !item.active))
      || (items.length > 0 && input.offset + items.length > total)
      || (nextOffset !== null && (nextOffset !== input.offset + items.length || items.length === 0))
      || ((input.offset + items.length < total) !== (nextOffset !== null))) invalid();
    return { items, total, next_offset: nextOffset };
  }

  async rename(templateId: string, name: string): Promise<LayoutTemplate> {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 256 || name.includes('\0')) {
      throw new ReceiptBatchClientError('template_invalid_name', '请输入 1 至 256 个字符的模板名称。');
    }
    const template = parse(await this.call({ op: 'batch_layout_template_rename', template_id: text(templateId, 256), name: name.trim() }));
    if (template.id !== templateId || template.name !== name.trim()) invalid();
    return template;
  }
}

export function layoutDefinitionSlots(layout: LayoutDefinition): LayoutTemplate['slots'] { return layout.slots.map((slot: ReceiptSlot) => ({ slot_id: slot.slot_id, position_index: slot.position_index, rect: { x0: layout.left_pt, x1: layout.page_geometry.width_pt - layout.right_pt, y0: slot.top_pt, y1: slot.top_pt + slot.height_pt } })); }
