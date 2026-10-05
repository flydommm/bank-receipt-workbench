import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GroupingHeader, GroupingItem, ReceiptGroupingSnapshot } from '../domain/receiptGrouping';
import { fieldRegionLabel, type FieldRuleApplied, type FieldRuleDifference, type FieldRuleRegion, type FieldRuleOperation, type FieldSelectionContext } from '../domain/receiptFieldRules';
import { ReceiptFieldRuleClient } from '../services/receiptFieldRuleClient';
import { summarizeFieldRuleResults } from '../domain/receiptFieldRuleResults';
import './ReceiptFieldRuleEditor.css';

export type FieldRulePreviewContext = { controls: ReactNode; fieldSelection?: FieldSelectionContext };
type Props = {
  snapshot: ReceiptGroupingSnapshot; prototype: GroupingItem; client: ReceiptFieldRuleClient;
  renderPreview: (id: string, context: FieldRulePreviewContext) => ReactNode;
  onApplied: (result: FieldRuleApplied) => Promise<void>; onClose: () => void; onComputing: (busy: boolean) => void;
};
const PAGE_SIZE = 10;
const statusLabel = { changed: '可更新', unchanged: '保持原状', pending: '仍待确认', skipped: '已跳过' };
type ResultFilter = 'all' | 'success' | 'pending' | 'skipped';
const positionLabel = (field: Pick<FieldRuleRegion, 'role' | 'field'>) => fieldRegionLabel(field, 'auto');
const resultName = (row: FieldRuleDifference) => row.status === 'pending' ? '尚未确认'
  : row.status === 'skipped' ? '未重新读取' : row.after_name || (row.after_route === 'blank' ? '对方名称为空' : '尚未读清');
const resultKey = (row: FieldRuleDifference) => JSON.stringify([row.after_name, row.after_route]);

/** Trial results are staged by the engine. Only the final apply publishes them. */
export function ReceiptFieldRuleEditor({ snapshot, prototype, client, renderPreview, onApplied, onClose, onComputing }: Props) {
  const [fields, setFields] = useState<FieldRuleRegion[]>([]);
  const [current, setCurrent] = useState<Pick<FieldRuleRegion, 'role' | 'field'>>({ role: 'counterparty', field: 'name' });
  const [includeResolved, setIncludeResolved] = useState(false);
  const [operation, setOperation] = useState<FieldRuleOperation | null>(null);
  const [rows, setRows] = useState<FieldRuleDifference[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<ResultFilter>('all');
  const [nameFilter, setNameFilter] = useState('');
  const [previewId, setPreviewId] = useState(prototype.binding.segment_id);
  const [saveRule, setSaveRule] = useState(false);
  const [ruleName, setRuleName] = useState(() => `${snapshot.header.own_account.bank_name} · 交易对手读取位置`.slice(0, 80));
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true), working = useRef(false), stopRequested = useRef(false), operationRef = useRef<FieldRuleOperation | null>(null);
  const basis = useRef<GroupingHeader>(snapshot.header);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onComputing); callback.current = onComputing;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; stopRequested.current = true; callback.current(false);
      const active = operationRef.current;
      if (active && ['preparing', 'ready'].includes(active.status)) void client.cancel(basis.current.job_id, active.operation_id).catch(() => undefined);
    };
  }, [client]);
  const setWorking = (value: boolean) => { working.current = value; if (mounted.current) { setBusy(value); callback.current(value); } };
  const remember = (value: FieldRuleOperation) => { operationRef.current = value; if (mounted.current) setOperation(value); };
  const showError = (cause: unknown) => { if (mounted.current) setError(cause instanceof Error ? cause.message : '操作未完成，请重试。'); };
  const canTrial = fields.some((field) => field.role === 'counterparty' && field.field === 'name');
  const trial = async () => {
    if (!canTrial || working.current) return;
    setWorking(true); setError(null); setRows(null); setSaveRule(false); setStopping(false); stopRequested.current = false;
    try {
      const previous = operationRef.current;
      if (previous && ['ready', 'preparing'].includes(previous.status)) await client.cancel(basis.current.job_id, previous.operation_id);
      let next = await client.prepare(basis.current, { prototype_segment_id: prototype.binding.segment_id, mode: 'auto', fields, include_resolved: includeResolved }); remember(next);
      while (next.status === 'preparing' && !stopRequested.current) {
        const before = next.completed; next = await client.step(basis.current.job_id, next); remember(next);
        if (next.status === 'preparing' && next.completed <= before) throw new Error('试读进度没有前进，请停止后重试。');
      }
      if (next.status !== 'ready' && !stopRequested.current) throw new Error('试读未完成，请重新设置读取位置后重试。');
      const all: FieldRuleDifference[] = [];
      const seen = new Set<string>();
      let nextOffset: number | null = 0;
      while (nextOffset !== null && !stopRequested.current && mounted.current) {
        const page = await client.page(basis.current.job_id, next.operation_id, nextOffset, 200);
        if (page.operation.status !== 'ready' || page.operation.total !== next.total || page.items.some((row) => seen.has(row.segment_id))) throw new Error('试读结果已变化，请重新试读。');
        page.items.forEach((row) => seen.add(row.segment_id)); all.push(...page.items);
        if (page.next_offset !== null && page.next_offset <= nextOffset) throw new Error('试读结果未完整载入，请重试。');
        nextOffset = page.next_offset;
      }
      if (stopRequested.current || !mounted.current) { remember(await client.cancel(basis.current.job_id, next.operation_id)); return; }
      if (all.length !== next.total) throw new Error('试读结果未完整载入，请返回调整后重试。');
      setRows(all); setOffset(0); setFilter('all'); setNameFilter(''); setPreviewId(prototype.binding.segment_id);
    } catch (cause) { showError(cause); }
    finally { setWorking(false); if (mounted.current) setStopping(false); }
  };
  const cancel = async () => {
    stopRequested.current = true;
    if (working.current) { setStopping(true); return; }
    setWorking(true); setError(null);
    try { if (operationRef.current && ['ready', 'preparing'].includes(operationRef.current.status)) remember(await client.cancel(basis.current.job_id, operationRef.current.operation_id)); onClose(); }
    catch (cause) { showError(cause); } finally { setWorking(false); }
  };
  const backToPositions = async () => {
    if (!operation || working.current) return;
    setWorking(true); setError(null);
    try { remember(await client.cancel(basis.current.job_id, operation.operation_id)); setRows(null); setPreviewId(prototype.binding.segment_id); }
    catch (cause) { showError(cause); } finally { setWorking(false); }
  };
  const apply = async () => {
    if (!rows || !operation || operation.status !== 'ready' || working.current || saveRule && (!operation.can_save_rule || !ruleName.trim())) return;
    setApplying(true); setWorking(true); setError(null);
    try { const result = await client.apply(basis.current, operation.operation_id, saveRule, saveRule ? ruleName.trim() : ''); remember(result.operation); await onApplied(result); }
    catch (cause) { showError(cause); } finally { setWorking(false); if (mounted.current) setApplying(false); }
  };
  const editing = !operation || ['cancelled', 'undone'].includes(operation.status);
  const itemsById = useMemo(() => new Map(snapshot.items.map((item) => [item.binding.segment_id, item])), [snapshot.items]);
  const nameGroups = useMemo(() => summarizeFieldRuleResults(rows ?? []).success
    .map((group) => ({ ...group, name: resultName(group.rows[0]) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')), [rows]);
  const canReuseRule = Boolean(operation?.can_save_rule && nameGroups.length);
  const filtered = useMemo(() => (rows ?? []).filter((row) => {
    if (filter === 'pending' || filter === 'skipped') return row.status === filter;
    if (filter === 'success' && !['changed', 'unchanged'].includes(row.status)) return false;
    return !nameFilter || ['changed', 'unchanged'].includes(row.status) && resultKey(row) === nameFilter;
  }), [rows, filter, nameFilter]);
  useEffect(() => {
    if (filtered.length && !filtered.some((row) => row.segment_id === previewId)) setPreviewId(filtered[0].segment_id);
  }, [filtered, previewId]);
  const visibleRows = filtered.slice(offset, offset + PAGE_SIZE);
  const chooseFilter = (value: ResultFilter) => { setFilter(value); setNameFilter(''); setOffset(0); };
  const showOriginal = (id: string) => { setPreviewId(id); previewRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); };
  const labelForId = (id: string) => { const item = itemsById.get(id); return item ? `第 ${item.binding.source_page} 页 · 第 ${item.binding.position_index} 栏` : '查看原件'; };

  return <section className="receipt-field-rule-editor" aria-label="同版式批量识别">
    <header><div><strong>同版式批量识别</strong><p>框选名称位置 → 核对试读结果 → 应用并选择复用</p></div><button type="button" disabled={stopping || applying} onClick={() => void cancel()}>{applying ? '正在应用…' : busy ? stopping ? '正在停止…' : '停止试读' : '关闭设置'}</button></header>
    {error && <p role="alert">{error}</p>}
    {editing && <div className="receipt-field-rule-editor__setup">
      <strong>1. 在这张原件上框出交易对手名称</strong>
      <p>只框名称文字。系统结合本方资料逐张判断，不需要选择收付款方向。</p>
      <div className="receipt-field-rule-editor__fields"><button type="button" aria-pressed={current.role === 'counterparty' && current.field === 'name'} disabled={busy} onClick={() => setCurrent({ role: 'counterparty', field: 'name' })}>框选名称位置一</button><strong>当前框选：{positionLabel(current)}</strong></div>
      <details className="receipt-field-rule-editor__extra"><summary>需要补充另一处名称或账号</summary><p>同版式中双方位置会变化时，补框另一个名称；双方同名时，再补框对应账号。无法确定的回单仍待核对。</p><label>补充位置<select aria-label="补充读取位置" value={`${current.role}:${current.field}`} disabled={busy} onChange={(event) => { const [role, field] = event.target.value.split(':') as [FieldRuleRegion['role'], FieldRuleRegion['field']]; setCurrent({ role, field }); }}>{(['counterparty', 'own'] as const).flatMap((role) => (['name', 'account'] as const).map((field) => <option key={`${role}:${field}`} value={`${role}:${field}`}>{positionLabel({ role, field })}</option>))}</select></label></details>
      <div className="receipt-field-rule-editor__regions">{fields.map((field) => <span key={`${field.role}:${field.field}`}>{positionLabel(field)}已框选 <button type="button" disabled={busy} aria-label={`重选${positionLabel(field)}`} onClick={() => { setCurrent({ role: field.role, field: field.field }); setFields((values) => values.filter((entry) => entry.role !== field.role || entry.field !== field.field)); }}>重选</button></span>)}</div>
      <label>试读范围<select aria-label="试读范围" value={includeResolved ? 'all' : 'pending'} disabled={busy} onChange={(event) => setIncludeResolved(event.target.value === 'all')}><option value="pending">本批待确认回单</option><option value="all">本批待确认及自动识别结果</option></select></label>
      <p className="receipt-field-rule-editor__hint">逐张检查同版式；跳过人工修正、已排除和特殊凭证。原件确实没有名称的手续费或结息，可直接用“修改交易对手”确认空白或分别命名。</p>
      <button type="button" className="primary" disabled={busy || !canTrial} onClick={() => void trial()}>试读同版式回单</button>
    </div>}
    {operation && <p role="status">{operation.status === 'preparing' ? `正在逐张试读 ${operation.completed} / ${operation.total}` : operation.status === 'cancelled' ? '试读已停止，原分组未改变。' : busy && !rows && !applying ? '正在汇总整批试读结果…' : `本次范围 ${operation.total} 张 · 可更新 ${operation.changed} 张 · 仍待确认 ${operation.unresolved} 张 · 跳过 ${operation.skipped} 张`}</p>}
    {!editing && operation?.status === 'ready' && <>
      {rows && <div className="receipt-field-rule-editor__results">
        <strong>2. 按名称核对，点回单查看原件</strong>
        <p>范围：{includeResolved ? '待确认及自动识别结果' : '待确认回单'}。每张读取自己的名称，未读清的保持原结果；下方筛选仅用于核对，不改变应用范围。</p>
        <div className="receipt-field-rule-editor__filters" role="group" aria-label="试读结果筛选">{([['all', '全部', rows.length], ['success', '已读清', rows.filter((row) => ['changed', 'unchanged'].includes(row.status)).length], ['pending', '待确认', operation.unresolved], ['skipped', '已跳过', operation.skipped]] as const).map(([value, label, count]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => chooseFilter(value)}>{label} {count}</button>)}</div>
        <label>名称汇总<select aria-label="按交易对手名称核对" value={nameFilter} onChange={(event) => { setNameFilter(event.target.value); setFilter(event.target.value ? 'success' : 'all'); setOffset(0); }}><option value="">全部名称（{nameGroups.length} 组）</option>{nameGroups.map((group) => <option key={group.key} value={group.key}>{group.name} · {group.count} 张</option>)}</select></label>
      </div>}
      {!rows && !busy && <button type="button" onClick={() => void backToPositions()}>返回调整后重新试读</button>}
    </>}
    <div ref={previewRef} className="receipt-field-rule-editor__preview"><div className="receipt-field-rule-editor__preview-caption">{editing ? '代表回单' : '当前核对原件'} · {labelForId(previewId)}</div>{renderPreview(previewId, { controls: null, fieldSelection: editing ? { mode: 'auto', current, regions: fields, disabled: busy, onSelect: (rect) => setFields((values) => [...values.filter((field) => field.role !== current.role || field.field !== current.field), { ...current, rect }]) } : undefined })}</div>
    {rows && <div className="receipt-field-rule-editor__differences"><table aria-label="逐张试读差异"><thead><tr><th>回单</th><th>原名称</th><th>本张读到的名称</th><th>处理结果</th></tr></thead><tbody>{visibleRows.map((row) => <tr key={row.segment_id} className={previewId === row.segment_id ? 'is-previewing' : ''}><td><button type="button" disabled={busy} onClick={() => showOriginal(row.segment_id)}>{labelForId(row.segment_id)}</button></td><td>{row.before_name || (row.before_route === 'blank' ? '对方名称为空' : '尚未读到')}</td><td>{resultName(row)}</td><td>{statusLabel[row.status]}<small>{row.reason}</small></td></tr>)}</tbody></table>{visibleRows.length === 0 && <p>没有符合筛选条件的记录。</p>}<div className="receipt-field-rule-editor__pages"><span>第 {Math.floor(offset / PAGE_SIZE) + 1} 页 · 筛选 {filtered.length} 张</span><button type="button" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页结果</button><button type="button" disabled={busy || offset + PAGE_SIZE >= filtered.length} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页结果</button></div></div>}
    {rows && operation?.status === 'ready' && <div className="receipt-field-rule-editor__confirm">
      <strong>3. 确认应用</strong>
      <label className="receipt-grouping-check"><input type="checkbox" checked={saveRule} disabled={busy || !canReuseRule} onChange={(event) => setSaveRule(event.target.checked)} />下次同版式自动使用</label>
      {saveRule && <><label>规则名称<input aria-label="本机读取规则名称" value={ruleName} maxLength={80} disabled={busy} onChange={(event) => setRuleName(event.target.value)} /></label><p>只保存读取位置；下一批会重新读取每张名称，不会套用本次名称。</p></>}
      {!operation.can_save_rule && <p>这张回单缺少稳定的定位标签，本次可应用，暂不能保存自动复用。</p>}
      {operation.can_save_rule && !nameGroups.length && <p>本次尚无读清的结果，请调整名称位置后重新试读，再保存复用。</p>}
      <div className="receipt-field-rule-editor__apply"><button type="button" disabled={busy} onClick={() => void backToPositions()}>返回调整位置</button><button type="button" className="primary" disabled={busy || saveRule && !ruleName.trim() || !operation.changed && !saveRule} onClick={() => void apply()}>{applying ? '正在应用…' : `确认应用 ${operation.changed} 张${saveRule ? '并保存规则' : ''}`}</button></div>
    </div>}
  </section>;
}
