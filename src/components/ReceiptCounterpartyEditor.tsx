import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { GroupDefinition, GroupingEdit, GroupingItem } from '../domain/receiptGrouping';
import { buildCounterpartyEdits, canCorrectCounterparty, isCounterpartyNameValid } from '../domain/receiptCounterpartyEdit';
import { groupingCounterparty } from '../domain/receiptGroupingGuidance';
import './ReceiptCounterpartyEditor.css';

export type ReceiptCounterpartyEditorProps = {
  items: GroupingItem[];
  groups: GroupDefinition[];
  disabled: boolean;
  selected?: boolean;
  formId?: string;
  showActions?: boolean;
  onCanSubmitChange?: (canSubmit: boolean) => void;
  onSave: (edits: GroupingEdit[]) => void | Promise<void>;
  onCancel: () => void;
};

export function ReceiptCounterpartyEditor(props: ReceiptCounterpartyEditorProps) {
  // Changing the selection or its saved evidence must start a fresh correction.
  const key = props.items.map((item) => `${item.binding.segment_id}:${item.basis_fingerprint}`).join('|');
  return <CounterpartyForm key={key} {...props} />;
}

function CounterpartyForm({ items, groups, disabled, selected = false, formId, showActions = true, onCanSubmitChange, onSave, onCancel }: ReceiptCounterpartyEditorProps) {
  const inputId = useId();
  const [name, setName] = useState(() => items.length === 1 ? groupingCounterparty(items[0])?.name.value ?? '' : '');
  const [search, setSearch] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [blank, setBlank] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const namedGroups = groups.filter((group) => group.kind === 'named' && isCounterpartyNameValid(group.display_name));
  const sameNameCounts = new Map<string, number>();
  const sameNameIndexes = new Map<string, number>();
  for (const group of namedGroups) {
    const index = (sameNameCounts.get(group.display_name) ?? 0) + 1;
    sameNameCounts.set(group.display_name, index);
    sameNameIndexes.set(group.group_id, index);
  }
  const selectedGroup = namedGroups.find((group) => group.group_id === selectedGroupId);
  const visibleGroups = namedGroups.filter((group) => group.group_id === selectedGroupId
    || group.display_name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const eligible = items.length >= 1 && items.length <= 200 && items.every(canCorrectCounterparty)
    && new Set(items.map((item) => item.binding.segment_id)).size === items.length;
  const valid = eligible && (blank || isCounterpartyNameValid(name)) && (!selectedGroupId || Boolean(selectedGroup));
  const canSubmit = valid && !disabled && !submitting;
  useEffect(() => {
    onCanSubmitChange?.(canSubmit);
    return () => onCanSubmitChange?.(false);
  }, [canSubmit, onCanSubmitChange]);
  const scope = items.length === 1 && !selected ? '当前 1 张回单' : `所选 ${items.length} 张回单`;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const edits = buildCounterpartyEdits(items, blank ? { kind: 'blank' }
        : selectedGroup ? { kind: 'group', group: selectedGroup } : { kind: 'name', name });
      setError(null); await onSave(edits);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '请检查交易对手名称后重试。'); }
    finally { submittingRef.current = false; setSubmitting(false); }
  };
  return <form id={formId} className="receipt-counterparty-editor" aria-label="修改交易对手" onSubmit={submit}>
    <header><strong>修改交易对手</strong><span>{scope}</span></header>
    <p>请对照原件填写名称，或选择已有交易对手。{items.length > 1 && '本次修改将应用到全部所选回单。'}</p>
    {!eligible && <p role="alert">{items.length < 1 || items.length > 200 ? '每次请选择 1 至 200 张回单。' : '所选回单中有不可修改的项目，请先处理本方资料或字段提取问题。'}</p>}
    <fieldset disabled={disabled || submitting || !eligible}>
      <label htmlFor={inputId}>交易对手名称</label>
      <input id={inputId} value={selectedGroup?.display_name ?? name} maxLength={256} disabled={blank} autoFocus
        onChange={(event) => { setName(event.target.value); setSelectedGroupId(''); setError(null); }} />
      {!blank && name.trim() && !isCounterpartyNameValid(name) && <p role="alert">名称不能只有空格或标点。</p>}
      <details className="receipt-counterparty-editor__existing">
        <summary>选择已有交易对手</summary>
        <label>搜索已有交易对手<input value={search} disabled={blank} onChange={(event) => setSearch(event.target.value)} /></label>
        <label>已有交易对手分组<select value={selectedGroupId} disabled={blank} onChange={(event) => {
          const id = event.target.value; setSelectedGroupId(id); setError(null);
          const group = namedGroups.find((entry) => entry.group_id === id);
          if (group) setName(group.display_name);
        }}><option value="">请选择已有分组</option>{visibleGroups.map((group) => {
          const qualifier = (sameNameCounts.get(group.display_name) ?? 0) > 1
            ? ` · ${group.manual ? '人工' : '自动'}分组 · 同名组 ${sameNameIndexes.get(group.group_id)}` : '';
          return <option key={group.group_id} value={group.group_id}>{group.display_name}{qualifier}</option>;
        })}</select></label>
        {visibleGroups.length === 0 && <p>未找到符合条件的已有分组，可直接填写名称。</p>}
      </details>
      {selectedGroup && !blank && <p className="receipt-counterparty-editor__selected">已选择已有分组：{selectedGroup.display_name}</p>}
      <label className="receipt-counterparty-editor__blank"><input type="checkbox" checked={blank} onChange={(event) => {
        setBlank(event.target.checked); setSelectedGroupId(''); setError(null);
      }} />原件确实没有交易对手名称</label>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {showActions && <div className="receipt-counterparty-editor__actions">
      <button type="submit" className="primary" disabled={!canSubmit}>{items.length === 1 ? '保存交易对手' : `应用到所选 ${items.length} 张`}</button>
      <button type="button" disabled={disabled || submitting} onClick={onCancel}>取消修改</button>
    </div>}
  </form>;
}
