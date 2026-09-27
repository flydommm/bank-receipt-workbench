import { useEffect, useMemo, useRef } from 'react';
import type { LayoutDefinition } from '../domain/receiptLayout';
import type { ReceiptLayoutPreview } from '../services/receiptLayoutClient';
import { SPECIAL_DOCUMENT_LABELS, isSpecialDocumentType } from '../domain/receiptBatch';
import './ReceiptRiskReview.css';

export type ReceiptRiskReviewProps = {
  risks: ReceiptLayoutPreview['risks'];
  affected?: ReceiptLayoutPreview['affected'];
  acknowledgedRiskIds: string[];
  onAcknowledgeMany: (ids: string[], checked: boolean) => void;
  sources?: { source_key: string; label: string }[];
  layoutDefinition?: ReceiptLayoutPreview['layout_definition'];
  disabled?: boolean;
};

type IndexedRisk = { risk: ReceiptLayoutPreview['risks'][number]; index: number };
type RiskGroup = {
  key: string;
  sourceKey: string;
  page: number;
  slotId: string | null;
  slotLabel: string;
  position: number | null;
  risks: IndexedRisk[];
  reasons: { label: string; count: number }[];
};

const diagnosticMessages: Record<string, string> = {
  historical_layout_applied: '已沿用历史边界，请核对当前回单是否完整',
  historical_template_ambiguous: '有多套适用模板，请选择模板后重新分析',
  uncertain_text: '存在识别置信度较低的文字',
  content_crosses_slot: '文字超出回单边界',
  content_crosses_boundary: '文字跨越回单边界',
  visual_crosses_slot: '图形或印章超出回单边界',
  occupancy_uncertain: '此栏是否为回单不明确',
  content_outside_slots: '存在未落入任何栏位的文字',
  content_outside_slot: '存在栏位边界外的文字',
  visual_outside_slots: '存在未落入任何栏位的图形',
  diagnostic_budget_exceeded: '页面检查达到上限，需人工确认',
  manual_exception_conflict: '本轮与此前单独调整的边界冲突',
  layout_requires_manual_slots: '页面版式需要人工确认栏位',
  unassigned_block: '有文字未归入任何回单',
  ambiguous_block: '有文字与多个回单相交',
  cross_boundary_block: '有文字跨越回单边界',
  low_confidence_exclude: '排除依据的识别置信度较低',
  excluded_decision_reset: '此片段原已排除；保存本轮后将转为待复核。如仍需排除，请保存后重新排除。',
};

function diagnosticValue(diagnostic: Record<string, unknown>, key: string): string | null {
  const value = diagnostic[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function riskSlotPosition(risk: ReceiptLayoutPreview['risks'][number], layout?: LayoutDefinition): number | null {
  const slotId = diagnosticValue(risk.diagnostic, 'slot_id');
  if (!slotId) return null;
  const slot = layout?.slots.find((item) => item.slot_id === slotId);
  return slot && Number.isSafeInteger(slot.position_index) ? slot.position_index : null;
}

function slotLabel(slotId: string | null, layout?: LayoutDefinition): { label: string; position: number | null } {
  if (!slotId) return { label: '页面整体检查', position: null };
  const slot = layout?.slots.find((item) => item.slot_id === slotId);
  if (slot && Number.isSafeInteger(slot.position_index)) return { label: `第 ${slot.position_index} 栏`, position: slot.position_index };
  return { label: layout ? '未知栏位' : `栏位 ${slotId}`, position: null };
}

function sourceLabel(sourceKey: string, sources?: ReceiptRiskReviewProps['sources']): string {
  const supplied = sources?.find((source) => source.source_key === sourceKey)?.label;
  if (supplied) return supplied;
  const normalized = sourceKey.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').pop() || sourceKey;
}

function reason(risk: ReceiptLayoutPreview['risks'][number]): string {
  const code = diagnosticValue(risk.diagnostic, 'code');
  if (code === 'special_document') {
    const type = diagnosticValue(risk.diagnostic, 'document_type');
    const label = isSpecialDocumentType(type) ? SPECIAL_DOCUMENT_LABELS[type] : '特殊单证';
    return `${label}，请核对整张凭证是否完整`;
  }
  const kind = diagnosticValue(risk.diagnostic, 'kind');
  const message = code ? diagnosticMessages[code] : undefined;
  if (message) {
    if (code === 'content_crosses_slot' && kind === 'title') return '回单标题超出栏位边界';
    if (code === 'content_crosses_slot' && kind === 'text') return '文字超出回单边界';
    return message;
  }
  return '此页存在需要检查的版式内容';
}

function sortedRisks(
  risks: ReceiptRiskReviewProps['risks'],
  layout?: ReceiptLayoutPreview['layout_definition'],
): IndexedRisk[] {
  return risks.map((risk, index) => ({ risk, index })).sort((a, b) =>
    a.risk.source_key.localeCompare(b.risk.source_key, 'zh-CN', { numeric: true, sensitivity: 'base' })
      || a.risk.page - b.risk.page
      || (riskSlotPosition(a.risk, layout) ?? 0) - (riskSlotPosition(b.risk, layout) ?? 0)
      || (diagnosticValue(a.risk.diagnostic, 'code') ?? '').localeCompare(diagnosticValue(b.risk.diagnostic, 'code') ?? '')
      || a.index - b.index);
}

function groupedRisks(risks: ReceiptRiskReviewProps['risks'], layout?: LayoutDefinition): RiskGroup[] {
  const groups = new Map<string, Omit<RiskGroup, 'slotLabel' | 'position' | 'reasons'>>();
  for (const indexed of sortedRisks(risks, layout)) {
    const { risk } = indexed;
    const slotId = diagnosticValue(risk.diagnostic, 'slot_id');
    const slotKnown = slotId !== null && (!layout || layout.slots.some((slot) => slot.slot_id === slotId));
    // Unknown ids may be stale or malformed. Keep each risk visible and independently checkable.
    const key = slotId === null
      ? JSON.stringify([risk.source_key, risk.page, null])
      : slotKnown
        ? JSON.stringify([risk.source_key, risk.page, slotId])
        : JSON.stringify([risk.source_key, risk.page, 'unknown', risk.risk_id]);
    let group = groups.get(key);
    if (!group) {
      group = { key, sourceKey: risk.source_key, page: risk.page, slotId, risks: [] };
      groups.set(key, group);
    }
    group.risks.push(indexed);
  }

  return [...groups.values()].map((group) => {
    const presentation = slotLabel(group.slotId, layout);
    const counts = new Map<string, number>();
    group.risks.forEach(({ risk }) => {
      const label = reason(risk);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    });
    return { ...group, slotLabel: presentation.label, position: presentation.position,
      reasons: [...counts].map(([label, count]) => ({ label, count })) };
  }).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey, 'zh-CN', { numeric: true, sensitivity: 'base' })
    || a.page - b.page || (a.position ?? 0) - (b.position ?? 0)
    || (a.slotId ?? '').localeCompare(b.slotId ?? '', 'zh-CN', { numeric: true, sensitivity: 'base' })
    || a.key.localeCompare(b.key));
}

function roundOutcome(group: RiskGroup, affectedBySlot: Map<string, ReceiptLayoutPreview['affected'][number]>): '本轮命中' | '未命中·版式核对' | '本轮移除' | '保留人工决定' | '本轮未列入变化·版式核对' | '排除将转待复核' | null {
  if (group.risks.some(({ risk }) => risk.diagnostic.code === 'excluded_decision_reset')) return '排除将转待复核';
  if (!group.slotId) return null;
  const target = affectedBySlot.get(JSON.stringify([group.sourceKey, group.page, group.slotId]));
  if (!target) return '本轮未列入变化·版式核对';
  if (target?.status === 'removed') return '本轮移除';
  if (target?.status === 'retained_manual') return '保留人工决定';
  if (target?.after_rect) return '本轮命中';
  return '未命中·版式核对';
}

/** Directly acknowledge the preview risks. Confirmation only changes this preview state; saving remains a separate action. */
export function ReceiptRiskReview({ risks, affected = [], acknowledgedRiskIds, onAcknowledgeMany, sources, layoutDefinition, disabled = false }: ReceiptRiskReviewProps) {
  const anchorIndex = useRef<number | null>(null);
  const shiftClick = useRef(false);
  const masterRef = useRef<HTMLInputElement>(null);
  const orderedGroups = useMemo(() => groupedRisks(risks, layoutDefinition), [risks, layoutDefinition]);
  const affectedBySlot = useMemo(() => new Map(affected.map((target) => [JSON.stringify([target.source_key, target.page, target.slot_id]), target])), [affected]);
  const validAcknowledged = new Set(acknowledgedRiskIds);
  const allRiskIds = orderedGroups.flatMap((group) => group.risks.map(({ risk }) => risk.risk_id));
  const acknowledgedCount = allRiskIds.filter((id) => validAcknowledged.has(id)).length;
  const checkedGroupCount = orderedGroups.filter((group) => group.risks.every(({ risk }) => validAcknowledged.has(risk.risk_id))).length;
  const allChecked = allRiskIds.length > 0 && acknowledgedCount === allRiskIds.length;
  const partiallyChecked = acknowledgedCount > 0 && !allChecked;

  useEffect(() => {
    anchorIndex.current = null;
    shiftClick.current = false;
  }, [risks]);

  useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = partiallyChecked;
  }, [partiallyChecked]);

  if (orderedGroups.length === 0) return null;

  const acknowledgeAt = (index: number, checked: boolean, shiftKey: boolean) => {
    const anchor = anchorIndex.current;
    if (shiftKey && anchor !== null && anchor >= 0 && anchor < orderedGroups.length) {
      const start = Math.min(anchor, index);
      const end = Math.max(anchor, index);
      onAcknowledgeMany(orderedGroups.slice(start, end + 1).flatMap((group) => group.risks.map(({ risk }) => risk.risk_id)), checked);
      return;
    }
    anchorIndex.current = index;
    onAcknowledgeMany(orderedGroups[index].risks.map(({ risk }) => risk.risk_id), checked);
  };

  const outcomeClass = (outcome: NonNullable<ReturnType<typeof roundOutcome>>) => `is-${outcome === '本轮命中' ? 'hit' : outcome === '本轮移除' ? 'removed' : outcome === '保留人工决定' ? 'retained' : 'miss'}`;

  return <section className="receipt-risk-review" aria-label="本轮风险核对">
    <div className="receipt-risk-review__toolbar">
      <label className="receipt-risk-review__master">
        <input ref={masterRef} type="checkbox" checked={allChecked} disabled={disabled}
          aria-label="全部标为已核对"
          onChange={(event) => {
            anchorIndex.current = null;
            onAcknowledgeMany(allRiskIds, event.currentTarget.checked);
          }} />
        <span>全部标为已核对</span>
      </label>
      <span className="receipt-risk-review__count" aria-live="polite">已核对 {checkedGroupCount} / {orderedGroups.length} 组</span>
    </div>
    <p className="receipt-risk-review__explanation">本轮变化 {affected.length} 处（含移出项）。下方也列出未变化栏位的风险；若原有排除决定会失效，将单独提示。勾选核对不会增加导出片段。</p>
    <ul className="receipt-risk-review__list">
      {orderedGroups.map((group, orderedIndex) => {
        const groupRiskIds = group.risks.map(({ risk }) => risk.risk_id);
        const checkedCount = groupRiskIds.filter((id) => validAcknowledged.has(id)).length;
        const acknowledged = checkedCount === groupRiskIds.length;
        const partiallyAcknowledged = checkedCount > 0 && !acknowledged;
        const outcome = roundOutcome(group, affectedBySlot);
        const label = `${sourceLabel(group.sourceKey, sources)}，第 ${group.page} 页，${group.slotLabel}，共 ${group.risks.length} 项版式风险，我已核对`;
        return <li key={group.key} className="receipt-risk-review__item">
          <label>
            <input type="checkbox" checked={acknowledged} ref={(element) => { if (element) element.indeterminate = partiallyAcknowledged; }} disabled={disabled} aria-label={label}
              onClickCapture={(event) => { shiftClick.current = event.shiftKey; }}
              onChange={(event) => {
                const shifted = shiftClick.current;
                shiftClick.current = false;
                acknowledgeAt(orderedIndex, event.currentTarget.checked, shifted);
              }} />
            <span className="receipt-risk-review__content">
              <span className="receipt-risk-review__meta">
                <strong>{sourceLabel(group.sourceKey, sources)}</strong>
                <span>第 {group.page} 页</span>
                <span>{group.slotLabel}</span>
                {outcome && <span className={`receipt-risk-review__outcome ${outcomeClass(outcome)}`}>{outcome}</span>}
                <span className={acknowledged ? 'is-acknowledged' : 'is-pending'}>{acknowledged ? '已核对' : partiallyAcknowledged ? '部分核对' : '待核对'}</span>
              </span>
              <span className="receipt-risk-review__reason-list">
                {group.reasons.map((entry) => <span className="receipt-risk-review__reason" key={entry.label}>
                  {entry.label}{entry.count > 1 && <b> × {entry.count} 项</b>}
                </span>)}
                <span className="receipt-risk-review__total">共 {group.risks.length} 项版式风险</span>
              </span>
            </span>
          </label>
        </li>;
      })}
    </ul>
  </section>;
}
