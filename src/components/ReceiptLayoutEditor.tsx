import { useMemo, useState, type ReactElement } from 'react';
import {
  slotRect,
  type LayoutDefinition,
  ReceiptLayoutError,
} from '../domain/receiptLayout';
import { validateLayoutDraft } from '../domain/receiptLayoutDraft';
import './ReceiptLayoutEditor.css';

const POINTS_PER_MILLIMETRE = 72 / 25.4;
const MILLIMETRES_PER_POINT = 25.4 / 72;
const DISPLAY_DECIMAL_PLACES = 2;

export type ReceiptLayoutEditorProps = {
  layout: LayoutDefinition;
  /** Layout at the start of the current adjustment round. */
  baselineLayout?: LayoutDefinition;
  /** Number of pages in the current adjustment scope, used for impact guidance. */
  scopePageCount?: number;
  selectedSlotId?: string | null;
  dirty: boolean;
  busy?: boolean;
  editableSlotIds?: readonly string[];
  error?: string | null;
  onSelectSlot?: (slotId: string) => void;
  onChange: (layout: LayoutDefinition) => void;
  onPreview: () => void;
  onCancel: () => void;
};

type DraftField = 'top' | 'height' | 'left' | 'right';
type DraftValue = { value: string; revision: number; slotId?: string };

function nextRevision(layout: LayoutDefinition): number {
  return layout.revision + 1;
}

function formatMillimetres(points: number): string {
  const millimetres = points * MILLIMETRES_PER_POINT;
  if (!Number.isFinite(millimetres)) return '';
  const rounded = millimetres.toFixed(DISPLAY_DECIMAL_PLACES);
  return Number(rounded) === 0 ? '0' : String(Number(rounded));
}

function parseMillimetres(raw: string, label: string): { value: number; error: null } | { value: null; error: string } {
  if (!raw.trim()) return { value: null, error: `${label}不能为空，请输入毫米数。` };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { value: null, error: `${label}必须是有效的毫米数。` };
  return { value, error: null };
}

function convertMillimetres(value: number, label: string): { value: number; error: null } | { value: null; error: string } {
  const points = value * POINTS_PER_MILLIMETRE;
  if (!Number.isFinite(points)) return { value: null, error: `${label}超出可处理范围，请输入较小的毫米数。` };
  return { value: points, error: null };
}

function parserErrorMessage(error: unknown): string {
  if (error instanceof ReceiptLayoutError) {
    switch (error.code) {
      case 'invalid_geometry': return '页面尺寸无效，请检查页面宽度和页面高度。';
      case 'invalid_layout': return '版式无效，请检查栏位位置、高度和左右边距。';
      default: return '版式数据无效，请检查栏位设置。';
    }
  }
  return '版式校验失败，请检查栏位设置。';
}

function changeErrorMessage(error: unknown, context: string): string {
  if (error instanceof ReceiptLayoutError) return `${context}失败：${parserErrorMessage(error)}`;
  if (error instanceof Error && error.message) return `${context}失败：${error.message}`;
  return `${context}失败，请检查输入。`;
}

function slotDetails(slot: LayoutDefinition['slots'][number]): ReactElement {
  return (
    <>
      <span>{`第 ${slot.position_index} 栏`}</span>
      <small className="receipt-layout-editor__slot-details">{`距页顶 ${formatMillimetres(slot.top_pt)} · 高度 ${formatMillimetres(slot.height_pt)} mm`}</small>
    </>
  );
}

export function ReceiptLayoutEditor({
  layout,
  baselineLayout,
  scopePageCount,
  selectedSlotId,
  dirty,
  busy = false,
  editableSlotIds,
  error = null,
  onSelectSlot,
  onChange,
  onPreview,
  onCancel,
}: ReceiptLayoutEditorProps) {
  const [localFailure, setLocalFailure] = useState<{ message: string; revision: number; slotId: string | null } | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<DraftField, DraftValue>>>({});
  const [copiedFrame, setCopiedFrame] = useState<{ height: number; position: number } | null>(null);
  const [uniformPrompt, setUniformPrompt] = useState<{ slotId: string; position: number } | null>(null);
  const selected = layout.slots.find((slot) => slot.slot_id === selectedSlotId) ?? layout.slots[0];
  const selectedRect = selected ? slotRect(layout, selected) : null;
  const uniform = layout.uniform_height;
  const protectedScope = editableSlotIds !== undefined;
  const selectedLocked = !selected || protectedScope && !editableSlotIds.includes(selected.slot_id);
  const layoutError = useMemo(() => validateLayoutDraft(layout).error, [layout]);
  const localError = localFailure?.revision === layout.revision && localFailure.slotId === (selected?.slot_id ?? null) ? localFailure.message : null;
  const activeError = localError ?? error ?? layoutError;
  const canPreview = !busy && !activeError;

  const synchronizedHeightChanges = useMemo(() => {
    if (!baselineLayout || !selected) return false;
    const baselineById = new Map(baselineLayout.slots.map((slot) => [slot.slot_id, slot]));
    return layout.slots.some((slot) => {
      if (slot.slot_id === selected.slot_id) return false;
      const baseline = baselineById.get(slot.slot_id);
      return baseline !== undefined && Math.abs(slot.height_pt - baseline.height_pt) > 0.000001;
    });
  }, [baselineLayout, layout.slots, selected]);

  const impactSlotCount = uniform ? layout.slots.length : selected ? 1 : 0;
  const impactSummary = selected && impactSlotCount > 0
    ? scopePageCount !== undefined
      ? `调整高度时预计影响 ${scopePageCount * impactSlotCount} 处（${scopePageCount} 页 × ${impactSlotCount} 栏）`
      : `调整高度时预计影响 ${impactSlotCount} 栏`
    : null;

  const summary = useMemo(() => {
    return `页面宽度 ${formatMillimetres(layout.page_geometry.width_pt)} mm · 页面高度 ${formatMillimetres(layout.page_geometry.height_pt)} mm · ${layout.slots.length} 栏`;
  }, [layout]);

  function setLocalError(message: string | null): void {
    setLocalFailure(message === null ? null : { message, revision: layout.revision, slotId: selected?.slot_id ?? null });
  }

  function rememberDraft(field: DraftField, value: string, slotId?: string): void {
    setDrafts((previous) => ({ ...previous, [field]: { value, revision: layout.revision, slotId } }));
  }

  function displayValue(field: DraftField, points: number, slotId?: string): string {
    const draft = drafts[field];
    return draft && draft.revision === layout.revision && draft.slotId === slotId
      ? draft.value
      : formatMillimetres(points);
  }

  function commitCandidate(candidate: LayoutDefinition, context = '版式更新'): void {
    setLocalError(null);
    try {
      // Keep temporary overlap/overflow visible so another slot can be moved
      // before validating the whole page for preview.
      onChange(candidate);
    } catch (caught) {
      setLocalError(changeErrorMessage(caught, context));
    }
  }

  function commitMillimetreField(raw: string, label: string, field: DraftField, build: (points: number) => LayoutDefinition, slotId?: string): void {
    rememberDraft(field, raw, slotId);
    const parsed = parseMillimetres(raw, label);
    if (parsed.error !== null) {
      setLocalError(parsed.error);
      return;
    }
    if (parsed.value === null) {
      setLocalError(`${label}必须是有效的毫米数。`);
      return;
    }
    const converted = convertMillimetres(parsed.value, label);
    if (converted.error !== null) {
      setLocalError(converted.error);
      return;
    }
    if (converted.value === null) {
      setLocalError(`${label}必须是有效的毫米数。`);
      return;
    }
    commitCandidate(build(converted.value), `${label}更新`);
  }

  function changeTop(raw: string): void {
    if (!selected || selectedLocked || busy) return;
    commitMillimetreField(raw, '距页顶', 'top', (points) => ({
      ...layout,
      revision: nextRevision(layout),
      slots: layout.slots.map((slot) => slot.slot_id === selected.slot_id ? { ...slot, top_pt: points } : slot),
    }), selected.slot_id);
  }

  function changeHeight(raw: string): void {
    if (!selected || selectedLocked || busy) return;
    if (raw.trim() && Number(raw) <= 0) {
      rememberDraft('height', raw, selected.slot_id);
      setLocalError('回单高度必须大于 0。');
      return;
    }
    commitMillimetreField(raw, '回单高度', 'height', (points) => ({
      ...layout,
      revision: nextRevision(layout),
      slots: layout.slots.map((slot) => uniform || slot.slot_id === selected.slot_id
        ? { ...slot, height_pt: points }
        : slot),
    }), selected.slot_id);
  }

  function changeMargin(field: 'left_pt' | 'right_pt', label: string, raw: string): void {
    if (busy || protectedScope) return;
    const otherMargin = field === 'left_pt' ? layout.right_pt : layout.left_pt;
    if (raw.trim() && (Number(raw) < 0 || Number(raw) * POINTS_PER_MILLIMETRE + otherMargin >= layout.page_geometry.width_pt)) {
      rememberDraft(field === 'left_pt' ? 'left' : 'right', raw);
      setLocalError('左右边距必须在页面内，并保留回单宽度。');
      return;
    }
    commitMillimetreField(raw, label, field === 'left_pt' ? 'left' : 'right', (points) => ({
      ...layout,
      revision: nextRevision(layout),
      [field]: points,
    }));
  }

  function changeUniform(enabled: boolean): void {
    if (busy || protectedScope) return;
    if (!enabled && uniform && synchronizedHeightChanges && selected) {
      setUniformPrompt({ slotId: selected.slot_id, position: selected.position_index });
      return;
    }
    const slots = enabled && selected
      ? layout.slots.map((slot) => ({ ...slot, height_pt: selected.height_pt }))
      : layout.slots;
    commitCandidate({ ...layout, revision: nextRevision(layout), uniform_height: enabled, slots }, '统一所有栏位高度更新');
  }

  function keepCurrentSlotOnly(): void {
    if (!uniformPrompt || !baselineLayout) return;
    const baselineById = new Map(baselineLayout.slots.map((slot) => [slot.slot_id, slot]));
    const slots = layout.slots.map((slot) => {
      if (slot.slot_id === uniformPrompt.slotId) return slot;
      const baseline = baselineById.get(slot.slot_id);
      return baseline ? { ...slot, height_pt: baseline.height_pt } : slot;
    });
    setUniformPrompt(null);
    commitCandidate({ ...layout, revision: nextRevision(layout), uniform_height: false, slots }, '恢复其他栏位');
  }

  function keepAllSlotChanges(): void {
    setUniformPrompt(null);
    commitCandidate({ ...layout, revision: nextRevision(layout), uniform_height: false }, '取消统一高度');
  }

  function preview(): void {
    if (busy) return;
    const currentError = validateLayoutDraft(layout).error;
    if (currentError) {
      setLocalError(currentError);
      return;
    }
    onPreview();
  }

  return (
    <section className="receipt-layout-editor" aria-labelledby="receipt-layout-editor-title" data-dirty={dirty ? 'true' : 'false'}>
      <header className="receipt-layout-editor__header">
        <h2 id="receipt-layout-editor-title">{protectedScope ? '所选片段微调' : '整页栏位微调'}</h2>
        {onSelectSlot && <nav aria-label="回单栏位" className="receipt-layout-editor__slots">
          {layout.slots.map((slot) => (
            <button
              type="button"
              key={slot.slot_id}
              className={slot.slot_id === selected?.slot_id ? 'is-selected' : ''}
              title={`距页顶 ${formatMillimetres(slot.top_pt)} mm · 高度 ${formatMillimetres(slot.height_pt)} mm`}
              aria-pressed={slot.slot_id === selected?.slot_id}
              onClick={() => onSelectSlot(slot.slot_id)}
              disabled={busy || protectedScope && !editableSlotIds.includes(slot.slot_id)}
            >
              {slotDetails(slot)}
            </button>
          ))}
        </nav>}
      </header>
      <div className="receipt-layout-editor__body">
        <div className="receipt-layout-editor__controls">
          <label>距页顶（mm）
            <input
              id="receipt-layout-editor-top"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={selected ? displayValue('top', selected.top_pt, selected.slot_id) : ''}
              disabled={busy || selectedLocked}
              aria-invalid={Boolean(activeError) || undefined}
              onChange={(event) => changeTop(event.currentTarget.value)}
            />
          </label>
          <label>回单高度（mm）
            <input
              id="receipt-layout-editor-height"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={selected ? displayValue('height', selected.height_pt, selected.slot_id) : ''}
              disabled={busy || selectedLocked}
              aria-invalid={Boolean(activeError) || undefined}
              onChange={(event) => changeHeight(event.currentTarget.value)}
            />
          </label>
          {onSelectSlot && layout.slots.length > 1 && !protectedScope && <div className="receipt-layout-editor__copy" role="group" aria-label="复制框尺寸">
            <button type="button" disabled={busy || !selected || Boolean(localError)}
              onClick={() => selected && setCopiedFrame({ height: selected.height_pt, position: selected.position_index })}>复制当前框尺寸</button>
            <button type="button" disabled={busy || !selected || !copiedFrame || Boolean(localError)} onClick={() => {
              if (!selected || !copiedFrame || busy) return;
              commitCandidate({ ...layout, revision: nextRevision(layout), uniform_height: false,
                slots: layout.slots.map((slot) => slot.slot_id === selected.slot_id ? { ...slot, height_pt: copiedFrame.height } : slot) });
            }}>{copiedFrame ? `粘贴第 ${copiedFrame.position} 栏尺寸` : '粘贴框尺寸'}</button>
          </div>}
          <label className="receipt-layout-editor__checkbox">
            <input
              id="receipt-layout-editor-uniform"
              type="checkbox"
              checked={uniform}
              disabled={busy || protectedScope}
              onChange={(event) => changeUniform(event.currentTarget.checked)}
            />
            <span>统一所有栏位高度</span>
          </label>
          {impactSummary && <p className="receipt-layout-editor__impact" role="status">{uniform
            ? `${impactSummary}；当前调整会同步所有栏位。`
            : `${impactSummary}；其他栏位保持不变。`}</p>}
          <p className="receipt-layout-editor__rect" aria-live="polite">
            {selectedRect
              ? `当前框：${formatMillimetres(selectedRect.x0)}, ${formatMillimetres(selectedRect.y0)} – ${formatMillimetres(selectedRect.x1)}, ${formatMillimetres(selectedRect.y1)} mm`
              : '请选择栏位'}
          </p>
          <details className="receipt-layout-editor__advanced">
            <summary>页面尺寸与左右边距</summary>
            <p className="receipt-layout-editor__summary">{summary}</p>
            <p className="receipt-layout-editor__summary">{layout.slots.map((slot) => `第 ${slot.position_index} 栏：距页顶 ${formatMillimetres(slot.top_pt)}，高度 ${formatMillimetres(slot.height_pt)}，下边界 ${formatMillimetres(slot.top_pt + slot.height_pt)} mm`).join('；')}</p>
            <div className="receipt-layout-editor__advanced-fields">
              <label>左边距（mm）
                <input
                  id="receipt-layout-editor-left"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={displayValue('left', layout.left_pt)}
                  disabled={busy || protectedScope}
                  aria-invalid={Boolean(activeError) || undefined}
                  onChange={(event) => changeMargin('left_pt', '左边距', event.currentTarget.value)}
                />
              </label>
              <label>右边距（mm）
                <input
                  id="receipt-layout-editor-right"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={displayValue('right', layout.right_pt)}
                  disabled={busy || protectedScope}
                  aria-invalid={Boolean(activeError) || undefined}
                  onChange={(event) => changeMargin('right_pt', '右边距', event.currentTarget.value)}
                />
              </label>
            </div>
          </details>
        </div>
        {activeError && <p className="receipt-layout-editor__error" role="alert">{activeError}</p>}
      </div>
      {uniformPrompt && <div className="receipt-layout-editor__prompt-backdrop" role="presentation">
        <section className="receipt-layout-editor__prompt" role="dialog" aria-modal="true" aria-labelledby="receipt-layout-editor-uniform-prompt-title">
          <h3 id="receipt-layout-editor-uniform-prompt-title">已同步修改多个栏位</h3>
          <p>第 {uniformPrompt.position} 栏的高度修改已经同步到其他栏位。取消统一高度后，如何处理已经同步的修改？</p>
          <div className="receipt-layout-editor__prompt-actions">
            <button type="button" className="primary" onClick={keepCurrentSlotOnly}>仅保留当前栏，恢复其他栏位</button>
            <button type="button" className="secondary" onClick={keepAllSlotChanges}>保留已同步的多栏修改，仅关闭后续联动</button>
            <button type="button" className="secondary" onClick={() => setUniformPrompt(null)}>返回</button>
          </div>
        </section>
      </div>}
      <footer className="receipt-layout-editor__actions">
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>返回</button>
        <button
          type="button"
          className="primary"
          disabled={!canPreview}
          onClick={preview}
          aria-busy={busy || undefined}
        >
          {busy ? '正在重算本轮页面…' : '确认并预览本轮'}
        </button>
      </footer>
    </section>
  );
}
