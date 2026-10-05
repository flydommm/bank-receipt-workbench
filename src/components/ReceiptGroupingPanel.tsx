import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { SPECIAL_DOCUMENT_LABELS, isSpecialDocumentType, type ReceiptBatchReviewPageItem } from '../domain/receiptBatch';
import {
  FIELD_STATE_LABELS, GROUP_ROUTE_LABELS, GROUPING_SERVICE_LABELS, groupingIssueLabel,
  type FieldOverride, type GroupDefinition, type GroupEdit, type GroupingEdit,
  type GroupingItem, type Party, type PartyField, type ReceiptGroupingSnapshot,
} from '../domain/receiptGrouping';
import { ReceiptGroupingClient, groupingErrorMessage, type GroupingProgress } from '../services/receiptGroupingClient';
import { ReceiptGroupingColumns } from './ReceiptGroupingColumns';
import {
  canEditDirectCounterparty, consistentOwnSide, effectiveGroupingParty as effectiveParty, groupingCounterparty as counterpartyParty,
  groupingGuidance, groupingItemSummary, hasGroupingProfileConflict, ownConfirmationBlocked, type GroupingFieldTarget,
} from '../domain/receiptGroupingGuidance';
import './ReceiptGroupingPanel.css';
import { groupingIssueCollections, canConfigureFieldRule } from '../domain/receiptGroupingIssues';
import type { FieldRuleApplied } from '../domain/receiptFieldRules';
import { ReceiptFieldRuleClient } from '../services/receiptFieldRuleClient';
import { ReceiptFieldRuleEditor, type FieldRulePreviewContext } from './ReceiptFieldRuleEditor';
import { ReceiptGroupingRuleTools } from './ReceiptGroupingRuleTools';
import { ReceiptCounterpartyEditor } from './ReceiptCounterpartyEditor';
import { canCorrectCounterparty } from '../domain/receiptCounterpartyEdit';

export type ReceiptGroupingPanelProps = {
  jobId: string;
  resultRevision: string;
  reviewItems: ReceiptBatchReviewPageItem[];
  onSnapshotChange: (snapshot: ReceiptGroupingSnapshot | null) => void;
  onExportDraft?: (snapshot: ReceiptGroupingSnapshot) => void | Promise<void>;
  onSelectSegment?: (id: string) => void;
  onFilterSegments?: (ids: string[] | null) => void;
  disabled?: boolean;
  client?: ReceiptGroupingClient;
  active?: boolean;
  autoExtract?: boolean;
  onBack?: () => void;
  onBackToAnalysis?: () => void;
  onRemoveSources?: () => void;
  onExport?: () => void;
  canExport?: boolean;
  renderPreview?: (segmentId: string, context: FieldRulePreviewContext) => ReactNode;
  renderOverview?: (context: ReceiptGroupingOverviewContext) => ReactNode;
  onBusyChange?: (busy: boolean) => void;
  fieldRuleClient?: ReceiptFieldRuleClient;
  initialOutputDirectory?: string | null;
};

export type ReceiptGroupingOverviewContext = {
  segmentIds: string[];
  focusedId: string | null;
  onOpen: (id: string) => void;
  active: boolean;
  disabled: boolean;
  contextKey: string;
};

type Working = 'load' | 'refresh' | 'save' | 'draft';
type FilterKey = 'all' | `route:${GroupingItem['route']}` | string;
type DetailAction = 'counterparty' | 'field' | 'own' | 'group' | null;

const BATCH_LIMIT = 200;

const defaultClient = new ReceiptGroupingClient();
const defaultFieldRuleClient = new ReceiptFieldRuleClient();
const editableRoutes = new Set<GroupingItem['route']>(['named', 'blank', 'counterparty_pending']);
const routeFilters: Array<{ key: `route:${GroupingItem['route']}`; label: string; symbol: string; tone?: string }> = [
  { key: 'route:own_pending', label: '本方待确认', symbol: '!', tone: 'pending' },
  { key: 'route:counterparty_pending', label: '对手待确认', symbol: '◌', tone: 'pending' },
  { key: 'route:blank', label: '对方名称为空', symbol: '○' },
  { key: 'route:internal', label: '本公司内部往来', symbol: '↔' },
  { key: 'route:special', label: '特殊凭证', symbol: '◇', tone: 'special' },
  { key: 'route:excluded', label: '已排除', symbol: '×', tone: 'excluded' },
];

function sourceLabel(item: GroupingItem): string {
  const name = item.binding.source_key.replace(/\\/g, '/').split('/').pop() ?? item.binding.source_key;
  return `${name} · 第 ${item.binding.source_page} 页 · 第 ${item.binding.position_index} 栏`;
}

function sourceName(item: GroupingItem): string {
  return item.binding.source_key.replace(/\\/g, '/').split('/').pop() ?? item.binding.source_key;
}

function assertReviewBinding(snapshot: ReceiptGroupingSnapshot, reviewItems: ReceiptBatchReviewPageItem[]): void {
  const byId = new Map(reviewItems.map((item) => [item.original.id, item]));
  if (byId.size !== reviewItems.length || snapshot.items.length !== byId.size || snapshot.items.some((item) => {
    const review = byId.get(item.binding.segment_id);
    return !review || review.record_revision !== item.binding.review_record_revision
      || review.original.analysis_signature !== item.binding.analysis_signature
      || review.original.source_key !== item.binding.source_key || review.original.instance_id !== item.binding.instance_id;
  })) throw new Error('stale grouping binding');
}

function groupDisplayName(group: GroupDefinition): string {
  if (group.kind !== 'special') return group.display_name;
  if (isSpecialDocumentType(group.display_name)) return SPECIAL_DOCUMENT_LABELS[group.display_name];
  return Object.hasOwn(GROUPING_SERVICE_LABELS, group.display_name)
    ? GROUPING_SERVICE_LABELS[group.display_name as keyof typeof GROUPING_SERVICE_LABELS] : group.display_name;
}

function itemName(item: GroupingItem): string {
  if (item.own_decision.status !== 'confirmed') return GROUP_ROUTE_LABELS[item.route];
  if (item.route === 'special') return item.group ? groupDisplayName(item.group) : GROUP_ROUTE_LABELS.special;
  return counterpartyParty(item)?.name.value
    || item.group?.display_name
    || GROUP_ROUTE_LABELS[item.route];
}

function itemAccount(item: GroupingItem): string {
  if (item.own_decision.status !== 'confirmed') return '';
  return counterpartyParty(item)?.account.value || '';
}

function matchesFilter(item: GroupingItem, filter: FilterKey): boolean {
  if (filter === 'all') return true;
  if (filter === 'profile-conflicts') return hasGroupingProfileConflict(item);
  if (filter === 'route:blank') return item.route === 'blank' || (['special', 'counterparty_pending'].includes(item.route) && counterpartyParty(item)?.name.state === 'blank');
  if (filter.startsWith('route:')) return item.route === filter.slice(6);
  return item.group?.group_id === filter;
}

function canMoveToNamedGroup(item: GroupingItem): boolean {
  return editableRoutes.has(item.route) || (item.route === 'special' && (!item.document_type || item.document_type === 'ordinary')
    && (item.extracted?.service_type === 'bank_fee' || item.extracted?.service_type === 'deposit_interest')
    && counterpartyParty(item)?.name.state === 'blank');
}

function searchMatch(item: GroupingItem, search: string): boolean {
  if (!search.trim()) return true;
  const needle = search.trim().toLocaleLowerCase();
  return [itemName(item), itemAccount(item), item.counterparty?.bank.value ?? '', sourceName(item), GROUP_ROUTE_LABELS[item.route]]
    .some((value) => value.toLocaleLowerCase().includes(needle));
}

function isFormControlTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])'));
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input, select, textarea, button, summary, [contenteditable]:not([contenteditable="false"])'));
}

function sourceOrderFor(reviewItems: ReceiptBatchReviewPageItem[]): Map<string, number> {
  const order = new Map<string, number>();
  for (const item of reviewItems) {
    if (!order.has(item.original.source_key)) order.set(item.original.source_key, order.size);
  }
  return order;
}

function EvidenceDetails({ field, label }: { field: PartyField; label: string }) {
  return <details className="receipt-grouping-evidence"><summary>{label} · {FIELD_STATE_LABELS[field.state]}</summary>
    {field.evidence.length === 0 && field.diagnostics.length === 0 ? <p>当前字段没有结构化识别依据。</p> : <>
      {field.evidence.map((evidence, index) => <p key={`${label}-${index}`}>
        {evidence.label ?? '无匹配标签'} · {evidence.method === 'verified_region' ? '已核验区域' : evidence.method === 'label' ? '标签匹配' : '无可靠匹配'}
        {evidence.rect && ` · 范围 ${evidence.rect.x0.toFixed(1)}, ${evidence.rect.y0.toFixed(1)} – ${evidence.rect.x1.toFixed(1)}, ${evidence.rect.y1.toFixed(1)} pt`}
      </p>)}
      {field.diagnostics.map((diagnostic, index) => <p key={`${label}-diagnostic-${index}`}>诊断：{diagnostic}</p>)}
    </>}
  </details>;
}

function FieldTable({ party, label }: { party: Party | null; label: string }) {
  if (!party) return <p>{label}：尚未提取。</p>;
  return <table aria-label={`${label}有效字段`}><caption>{label}</caption><thead><tr><th>字段</th><th>原文</th><th>有效值</th><th>状态与依据</th></tr></thead><tbody>
    {(['name', 'account', 'bank'] as const).map((key) => <tr key={key}>
      <th>{({ name: '名称', account: '账号', bank: '开户行' })[key]}</th><td>{party[key].raw || '（空）'}</td><td>{party[key].value || '（空）'}</td>
      <td>{FIELD_STATE_LABELS[party[key].state]}<EvidenceDetails field={party[key]} label={({ name: '名称', account: '账号', bank: '开户行' })[key]} /></td>
    </tr>)}
  </tbody></table>;
}

function CompactParty({ party, label }: { party: Party | null; label: string }) {
  if (!party) return <div className="receipt-grouping-party-card"><strong>{label}</strong><span>尚未提取。</span></div>;
  const display = (field: PartyField) => field.state === 'ambiguous' ? '未识别清楚' : field.state === 'blank' ? '原件空白' : field.state !== 'present' || !field.value ? '尚未读到' : field.value;
  return <div className="receipt-grouping-party-card"><small>{label}</small><strong>{display(party.name)}</strong><span>账号：{display(party.account)}</span><span>开户行：{display(party.bank)}</span></div>;
}

function FieldEditor({ item, disabled, target, onSave, onCancel }: { item: GroupingItem; disabled: boolean; target: GroupingFieldTarget | null; onSave: (edits: GroupingEdit[]) => void; onCancel: () => void }) {
  const [side, setSide] = useState<FieldOverride['side'] | ''>(target ? target.side ?? '' : canEditDirectCounterparty(item) ? 'counterparty' : '');
  const [field, setField] = useState<FieldOverride['field']>(target?.field ?? 'name');
  const [value, setValue] = useState('');
  const [blank, setBlank] = useState(false);
  const [reason, setReason] = useState('');
  const current = item.field_overrides.find((entry) => entry.side === side && entry.field === field);
  useEffect(() => {
    const original = side ? (side === 'counterparty' ? item.counterparty?.[field] : item.extracted?.[side][field]) : undefined;
    setValue(current?.value ?? original?.value ?? ''); setBlank(current?.state === 'blank'); setReason('');
  }, [item, side, field, current]);
  const save = (clear = false) => {
    if (!side) return;
    const remaining = item.field_overrides.filter((entry) => !(entry.side === side && entry.field === field));
    const explanation = `用户对照原件${blank ? '确认' : '修正'}${({ payer: '付款方', payee: '收款方', counterparty: '交易对手' })[side]}${({ name: '名称', account: '账号', bank: '开户行' })[field]}${blank ? '为空' : ''}。${reason.trim() ? `备注：${reason.trim()}` : ''}`;
    const next = clear ? remaining : [...remaining, { side, field, value: blank ? '' : value.trim(), state: blank ? 'blank' as const : 'present' as const, reason: explanation }];
    onSave([{ segment_id: item.binding.segment_id, expected_basis_fingerprint: item.basis_fingerprint, field_overrides: next }]);
  };
  const compact = Boolean(target?.side);
  const fieldLabel = `${side ? { payer: '付款方', payee: '收款方', counterparty: '交易对手' }[side] : ''}${{ name: '名称', account: '账号', bank: '开户行' }[field]}`;
  const notes = <>
    <label className="receipt-grouping-check"><input type="checkbox" checked={blank} onChange={(event) => setBlank(event.target.checked)} />查看原件后确认该字段确实为空</label>
    <label>备注（选填）<input aria-label="字段修正备注" value={reason} maxLength={800} onChange={(event) => setReason(event.target.value)} /></label>
  </>;
  return <fieldset disabled={disabled || item.route === 'excluded'} className={`receipt-grouping-form${compact ? ' receipt-grouping-form--quick' : ''}`}><legend>只修正当前这一张{side ? ` · ${fieldLabel}` : ''}</legend>
    {!compact && <><p>仅修改右侧当前回单，不影响其他已勾选回单。请按原件填写；不确定时保留待确认。</p>
      <label>字段所属方<select aria-label="修正字段所属方" value={side} onChange={(event) => setSide(event.target.value as FieldOverride['side'] | '')}><option value="">请选择付款方或收款方</option><option value="payer">付款方</option><option value="payee">收款方</option>{canEditDirectCounterparty(item) && <option value="counterparty">交易对手</option>}</select></label>
      <label>字段<select aria-label="修正字段" value={field} onChange={(event) => setField(event.target.value as FieldOverride['field'])}><option value="name">名称</option><option value="account">账号</option><option value="bank">开户行</option></select></label>
    </>}
    <label className="receipt-grouping-field-value">{compact ? fieldLabel : '修正值'}<input aria-label="字段修正值" value={value} disabled={blank} maxLength={field === 'account' ? 128 : 256} onChange={(event) => setValue(event.target.value)} /></label>
    <div className="receipt-grouping-form-actions"><button type="button" className={compact ? 'primary' : undefined} disabled={!side || (!blank && !value.trim())} onClick={() => save()}>保存字段修正</button><button type="button" onClick={onCancel}>取消修正</button>{current && <button type="button" onClick={() => save(true)}>撤销此字段的人工修正</button>}</div>
    {compact ? <details className="receipt-grouping-field-notes"><summary>补充说明（选填）</summary>{notes}</details> : notes}
    {!compact && <p>保留提取原文。修正后会重新判断交易对手和分组，本批账户资料不变。</p>}
  </fieldset>;

}

function routeLabel(item: GroupingItem): string { return item.group ? groupDisplayName(item.group) : GROUP_ROUTE_LABELS[item.route]; }

function GroupingStatus({ item }: { item: GroupingItem }) {
  return <div className="receipt-grouping-status"><span className={`receipt-grouping-pill route-${item.route}`}>{GROUP_ROUTE_LABELS[item.route]}</span>
    {item.extraction_state !== 'ready' && <span className="receipt-grouping-pill warning">字段{item.extraction_state === 'failed' ? '提取失败' : '尚未就绪'}</span>}
    {item.boundary_status !== 'confirmed' && item.boundary_status !== 'page_confirmed' && item.boundary_status !== 'excluded' && <span className="receipt-grouping-pill warning">边界仍待审核</span>}
  </div>;
}

export function ReceiptGroupingPanel({
  jobId, resultRevision, reviewItems, onSnapshotChange, onExportDraft, onSelectSegment, onFilterSegments,
  disabled = false, client = defaultClient, active = true, autoExtract = true, onBack, onBackToAnalysis, onRemoveSources, onExport,
  canExport = true, renderPreview, renderOverview, onBusyChange, fieldRuleClient = defaultFieldRuleClient, initialOutputDirectory,
}: ReceiptGroupingPanelProps) {
  const [snapshot, setSnapshot] = useState<ReceiptGroupingSnapshot | null>(null);
  const [working, setWorking] = useState<Working | null>(null);
  const [progress, setProgress] = useState<GroupingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [renderLimit, setRenderLimit] = useState(BATCH_LIMIT);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [targetGroup, setTargetGroup] = useState('');
  const [newName, setNewName] = useState('');
  const [ownSide, setOwnSide] = useState<'payer' | 'payee' | 'single' | ''>('');
  const [ownChecked, setOwnChecked] = useState(false);
  const [bankChecked, setBankChecked] = useState(false);
  const [ownReason, setOwnReason] = useState('');
  const [detailAction, setDetailAction] = useState<DetailAction>(null);
  const counterpartyFormId = useId();
  const [counterpartySubmitState, setCounterpartySubmitState] = useState<{ contextKey: string; canSubmit: boolean } | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [fieldTarget, setFieldTarget] = useState<GroupingFieldTarget | null>(null);
  const [detailView, setDetailView] = useState<'overview' | 'single'>('single');
  const [issueFilter, setIssueFilter] = useState('all');
  const [ruleEditorId, setRuleEditorId] = useState<string | null>(null);
  const [ruleComputing, setRuleComputing] = useState(false);
  const [ruleToolsBusy, setRuleToolsBusy] = useState(false);
  const [lastRuleOperationId, setLastRuleOperationId] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const activeRef = useRef(active);
  const workingRef = useRef<Working | null>(null);
  const snapshotCallback = useRef(onSnapshotChange);
  const filterCallback = useRef(onFilterSegments);
  const busyCallback = useRef(onBusyChange);
  const reviewRef = useRef(reviewItems);
  const identityRef = useRef('');
  const previousReviewKey = useRef<string | null>(null);
  const loadedIdentity = useRef<string | null>(null);
  const scheduledIdentity = useRef<string | null>(null);
  const autoAttemptedIdentity = useRef<string | null>(null);
  const needsLoadAfterInactive = useRef(false);
  const seedFocus = useRef(true);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const actionFormRef = useRef<HTMLElement | null>(null);
  const detailScrollRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const pendingScrollId = useRef<string | null>(null);
  const pendingRowFocusId = useRef<string | null>(null);
  const previousVisibleKey = useRef<string | null>(null);

  activeRef.current = active; workingRef.current = working; snapshotCallback.current = onSnapshotChange;
  filterCallback.current = onFilterSegments; busyCallback.current = onBusyChange; reviewRef.current = reviewItems;

  const reviewKey = useMemo(() => JSON.stringify(reviewItems.map((item) => [item.original.id, item.original.analysis_signature, item.record_revision])), [reviewItems]);
  const identityKey = `${jobId}::${resultRevision}::${reviewKey}`;
  const busy = disabled || working !== null || ruleEditorId !== null || ruleComputing || ruleToolsBusy;

  const publish = (next: ReceiptGroupingSnapshot | null) => {
    if (next) {
      assertReviewBinding(next, reviewRef.current); setSnapshot(next); setRecoveryAvailable(false);
      if (seedFocus.current) { const initial = next.items.find((item) => item.route !== 'excluded') ?? next.items[0] ?? null; setFocusedId(initial?.binding.segment_id ?? null); seedFocus.current = false; }
    } else setSnapshot(null);
    snapshotCallback.current(next);
  };
  const cancelInFlight = (clearSnapshot = false) => {
    epoch.current += 1; operation.current?.abort(); operation.current = null; setWorking(null); setProgress(null);
    if (clearSnapshot) publish(null);
  };
  const begin = (kind: Working) => {
    operation.current?.abort(); const controller = new AbortController(); operation.current = controller; const version = ++epoch.current;
    setWorking(kind); setError(null); setRecoveryAvailable(false); return { controller, version };
  };
  const operationActive = (version: number, controller: AbortController) => activeRef.current && epoch.current === version && !controller.signal.aborted;
  const finish = (version: number) => { if (epoch.current === version) { operation.current = null; setWorking(null); } };
  const failureMessage = (cause: unknown) => `${groupingErrorMessage(cause)} 本机已保存的结果仍保留。`;

  const load = async ({ allowAuto = false }: { allowAuto?: boolean } = {}) => {
    if (!activeRef.current) return;
    const { controller, version } = begin('load'); publish(null);
    try {
      const header = await client.prepare(jobId, resultRevision, -1, controller.signal); if (!operationActive(version, controller)) return;
      const loaded = await client.loadAll(header, controller.signal); if (!operationActive(version, controller)) return;
      const preparePending = header.counts.extraction_pending > 0 || header.counts.stale > 0 || header.counts.own_pending > 0;
      const shouldAuto = allowAuto && autoExtract && preparePending && autoAttemptedIdentity.current !== identityKey;
      if (shouldAuto) {
        autoAttemptedIdentity.current = identityKey; setWorking('refresh');
        setProgress({ completed: 0, total: loaded.items.filter((item) => item.route !== 'excluded' && (item.extraction_state !== 'ready' || item.route === 'own_pending')).length, header: loaded.header });
        publish(null);
        const refreshed = await client.refreshAll(loaded, (nextProgress) => { if (operationActive(version, controller)) setProgress(nextProgress); }, controller.signal);
        if (operationActive(version, controller)) publish(refreshed);
      } else publish(loaded);
      if (operationActive(version, controller)) loadedIdentity.current = identityKey;
    } catch (cause) {
      if (operationActive(version, controller)) { publish(null); setError(failureMessage(cause)); setRecoveryAvailable(true); loadedIdentity.current = identityKey; }
    } finally { finish(version); }
  };

  const refresh = async () => {
    if (!snapshot || busy || !activeRef.current) return;
    const current = snapshot; const { controller, version } = begin('refresh'); snapshotCallback.current(null);
    try {
      const next = await client.refreshAll(current, (nextProgress) => { if (operationActive(version, controller)) setProgress(nextProgress); }, controller.signal);
      if (operationActive(version, controller)) publish(next);
    } catch (cause) {
      if (operationActive(version, controller)) { publish(null); setError(failureMessage(cause)); setRecoveryAvailable(true); }
    } finally { finish(version); }
  };

  const save = async (edits: GroupingEdit[], groupEdits: GroupEdit[] = []) => {
    if (!snapshot || busy || !activeRef.current) return;
    const current = snapshot; const { controller, version } = begin('save'); snapshotCallback.current(null);
    try {
      const saved = await client.save(current.header, edits, groupEdits, controller.signal); if (!operationActive(version, controller)) return;
      const next = await client.loadAll(saved.header, controller.signal);
      if (operationActive(version, controller)) { publish(next); setSelected(new Set()); setOwnChecked(false); setBankChecked(false); setOwnReason(''); setNewName(''); setTargetGroup(''); setDetailAction(null); }
    } catch (cause) {
      if (operationActive(version, controller)) { publish(null); setError(failureMessage(cause)); setRecoveryAvailable(true); }
    } finally { finish(version); }
  };

  const stop = () => { cancelInFlight(true); setRecoveryAvailable(true); setError('已停止后续操作；本机已保存的结果仍保留，可重新载入后继续。'); };

  useEffect(() => { busyCallback.current?.(working !== null || ruleEditorId !== null || ruleComputing || ruleToolsBusy); }, [working, ruleEditorId, ruleComputing, ruleToolsBusy]);

  useEffect(() => {
    if (previousReviewKey.current === null) previousReviewKey.current = reviewKey;
    if (identityRef.current === '') identityRef.current = identityKey;
    if (identityRef.current === identityKey) return;
    const reviewChanged = previousReviewKey.current !== reviewKey; identityRef.current = identityKey; previousReviewKey.current = reviewKey;
    loadedIdentity.current = null; scheduledIdentity.current = null; autoAttemptedIdentity.current = null; seedFocus.current = true;
    cancelInFlight(true); setFilter('all'); setSearch(''); setRenderLimit(BATCH_LIMIT); setSelected(new Set()); setFocusedId(null); setDetailAction(null); setDetailView('single');
    setReviewNotice(reviewChanged ? '分割或审核依据已变化，需要重新核对；人工决定请检查。' : null);
    setError(null);
    setIssueFilter('all'); setRuleEditorId(null); setLastRuleOperationId(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  useEffect(() => {
    if (!active) { if (workingRef.current !== null) { needsLoadAfterInactive.current = true; cancelInFlight(true); } return; }
    if (needsLoadAfterInactive.current) { needsLoadAfterInactive.current = false; loadedIdentity.current = null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!active || scheduledIdentity.current === identityKey || loadedIdentity.current === identityKey) return;
    scheduledIdentity.current = identityKey; let cancelled = false;
    Promise.resolve().then(() => { if (cancelled || !activeRef.current || loadedIdentity.current === identityKey) return; scheduledIdentity.current = null; void load({ allowAuto: true }); });
    return () => { cancelled = true; if (scheduledIdentity.current === identityKey) scheduledIdentity.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, identityKey, client]);

  useEffect(() => () => {
    epoch.current += 1; operation.current?.abort(); operation.current = null; snapshotCallback.current(null); filterCallback.current?.(null); busyCallback.current?.(false);
  }, []);

  useEffect(() => {
    if (!renderOverview) setDetailView('single');
  }, [renderOverview]);

  const all = snapshot?.items ?? [];
  const sourceOrder = useMemo(() => sourceOrderFor(reviewItems), [reviewItems]);
  const reviewItemOrder = useMemo(() => new Map(reviewItems.map((item, index) => [item.original.id, index])), [reviewItems]);
  const orderedAll = useMemo(() => [...all].sort((left, right) => {
    const leftSource = sourceOrder.get(left.binding.source_key) ?? Number.MAX_SAFE_INTEGER;
    const rightSource = sourceOrder.get(right.binding.source_key) ?? Number.MAX_SAFE_INTEGER;
    return leftSource - rightSource
      || left.binding.source_page - right.binding.source_page
      || left.binding.position_index - right.binding.position_index
      || (reviewItemOrder.get(left.binding.segment_id) ?? Number.MAX_SAFE_INTEGER)
        - (reviewItemOrder.get(right.binding.segment_id) ?? Number.MAX_SAFE_INTEGER)
      || left.binding.segment_id.localeCompare(right.binding.segment_id);
  }), [all, reviewItemOrder, sourceOrder]);
  const groups = useMemo(() => {
    const result = new Map<string, { definition: GroupDefinition; count: number }>();
    for (const item of all) if (item.group) { const old = result.get(item.group.group_id); result.set(item.group.group_id, { definition: item.group, count: (old?.count ?? 0) + 1 }); }
    return [...result.values()].sort((left, right) => groupDisplayName(left.definition).localeCompare(groupDisplayName(right.definition), 'zh-CN'));
  }, [all]);
  const issueCollections = useMemo(() => groupingIssueCollections(orderedAll.filter((item) => matchesFilter(item, filter)), snapshot?.header.own_account.bank_name ?? ''), [filter, orderedAll, snapshot?.header.own_account.bank_name]);
  const selectedIssue = issueCollections.find((item) => item.key === issueFilter);
  const selectedIssueIds = useMemo(() => selectedIssue ? new Set(selectedIssue.segmentIds) : null, [selectedIssue]);
  const visible = useMemo(() => orderedAll.filter((item) => matchesFilter(item, filter) && searchMatch(item, search) && (!selectedIssueIds || selectedIssueIds.has(item.binding.segment_id))), [filter, orderedAll, search, selectedIssueIds]);
  const rendered = visible.slice(0, renderLimit);
  const selectedItems = orderedAll.filter((item) => selected.has(item.binding.segment_id));
  const focused = orderedAll.find((item) => item.binding.segment_id === focusedId) ?? null;
  const rulePrototype = orderedAll.find((item) => item.binding.segment_id === ruleEditorId) ?? null;
  const actionItems = selectedItems.length > 0 ? selectedItems : focused ? [focused] : [];
  const ownScopeLabel = selectedItems.length > 0 ? `确认已勾选 ${selectedItems.length} 张` : '确认当前这一张';
  const ownBlocked = actionItems.some(ownConfirmationBlocked);
  const suggestedOwnSide = consistentOwnSide(actionItems);
  const focusedGuidance = focused ? groupingGuidance(focused) : null;
  const quickFieldEditor = detailAction === 'field' && Boolean(fieldTarget?.side) && Boolean(focusedGuidance);
  const canAssign = actionItems.length > 0 && actionItems.length <= BATCH_LIMIT && actionItems.every((item) => canMoveToNamedGroup(item) && item.own_decision.status === 'confirmed' && item.extraction_state === 'ready');
  const canCorrect = actionItems.length > 0 && actionItems.length <= BATCH_LIMIT && actionItems.every(canCorrectCounterparty);
  const needsExtraction = all.some((item) => item.route !== 'excluded' && (item.extraction_state !== 'ready' || item.route === 'own_pending'));
  const profileConflictCount = all.filter(hasGroupingProfileConflict).length;
  const filterGroup = groups.find((entry) => entry.definition.group_id === filter)?.definition;
  const activeFilterLabel = filter === 'all' ? '全部回单' : filter === 'profile-conflicts' ? '本批资料不一致' : filter.startsWith('route:') ? GROUP_ROUTE_LABELS[filter.slice(6) as GroupingItem['route']] : filterGroup ? groupDisplayName(filterGroup) : '当前分组';
  const actionContextKey = actionItems.map((item) => `${item.binding.segment_id}:${item.basis_fingerprint}`).sort().join('|');
  const updateCounterpartyCanSubmit = useCallback((canSubmit: boolean) => {
    setCounterpartySubmitState((current) => current?.contextKey === actionContextKey && current.canSubmit === canSubmit
      ? current : { contextKey: actionContextKey, canSubmit });
  }, [actionContextKey]);
  const canSubmitCounterparty = detailAction === 'counterparty' && counterpartySubmitState?.contextKey === actionContextKey
    && counterpartySubmitState.canSubmit;
  const visibleIds = useMemo(() => visible.map((item) => item.binding.segment_id), [visible]);
  const visibleKey = visibleIds.join('\u0000');
  const focusedIndex = focused ? visibleIds.indexOf(focused.binding.segment_id) : -1;
  const overviewContextKey = `${identityKey}:${filter}:${search.trim().toLocaleLowerCase()}`;

  useEffect(() => { setOwnChecked(false); setBankChecked(false); setOwnReason(''); setOwnSide(suggestedOwnSide); }, [actionContextKey, suggestedOwnSide]);
  useEffect(() => { if (issueFilter !== 'all' && !selectedIssue) setIssueFilter('all'); }, [issueFilter, selectedIssue]);
  useEffect(() => {
    setFieldTarget(null);
    setDetailAction((current) => current === 'field' || current === 'own' || (current === 'counterparty' && selected.size === 0) ? null : current);
    if (detailScrollRef.current) detailScrollRef.current.scrollTop = 0;
  }, [focusedId]);
  useEffect(() => {
    if (detailAction !== 'counterparty' || selectedItems.length === 0) return;
    if (selectedItems.some((item) => !visibleIds.includes(item.binding.segment_id))) {
      setSelected(new Set()); setDetailAction(null); return;
    }
    if (!focusedId || !selected.has(focusedId)) {
      setFocusedId(selectedItems[0].binding.segment_id);
    }
  }, [detailAction, actionContextKey, focusedId, visibleKey]);
  useEffect(() => {
    if (!detailAction || !actionFormRef.current) return;
    const form = actionFormRef.current;
    if (typeof form.scrollIntoView === 'function') form.scrollIntoView({ block: fieldTarget?.side && detailAction === 'field' ? 'nearest' : 'start' });
    form.querySelector<HTMLElement>(fieldTarget?.side && detailAction === 'field' ? 'input[aria-label="字段修正值"]' : 'input, select, textarea')?.focus({ preventScroll: true });
  }, [detailAction, fieldTarget, actionContextKey]);
  useEffect(() => {
    if (snapshot && filter !== 'all' && filter !== 'profile-conflicts' && !filter.startsWith('route:') && !groups.some(({ definition }) => definition.group_id === filter)) { setFilter('all'); setSelected(new Set()); return; }
    const ids = !snapshot || filter === 'all' && !search.trim() ? null : visible.map((item) => item.binding.segment_id); filterCallback.current?.(ids);
  }, [snapshot, filter, search, visible, groups]);
  useEffect(() => { setRenderLimit(BATCH_LIMIT); }, [filter, search]);
  useEffect(() => {
    if (previousVisibleKey.current === null) {
      previousVisibleKey.current = visibleKey;
      if (!focusedId && visibleIds.length > 0) setFocusedId(visibleIds[0]);
      return;
    }
    if (previousVisibleKey.current !== visibleKey) {
      previousVisibleKey.current = visibleKey;
      pendingScrollId.current = null;
      pendingRowFocusId.current = null;
      setFocusedId(visibleIds[0] ?? null);
      return;
    }
    if (focusedId !== null && !visibleIds.includes(focusedId)) setFocusedId(visibleIds[0] ?? null);
  }, [focusedId, visibleIds, visibleKey]);
  useEffect(() => {
    if (!focusedId || pendingScrollId.current !== focusedId) return;
    const row = rowRefs.current.get(focusedId);
    if (!row) return;
    row.scrollIntoView?.({ block: 'nearest' });
    pendingScrollId.current = null;
  }, [focusedId, rendered.length]);
  useEffect(() => {
    if (!focusedId || pendingRowFocusId.current !== focusedId) return;
    const row = rowRefs.current.get(focusedId);
    if (!row) return;
    row.focus({ preventScroll: true });
    pendingRowFocusId.current = null;
  }, [focusedId, rendered.length]);
  useEffect(() => {
    const node = sentinelRef.current; if (!node || renderLimit >= visible.length || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setRenderLimit((current) => Math.min(current + BATCH_LIMIT, visible.length)); }, { rootMargin: '240px' });
    observer.observe(node); return () => observer.disconnect();
  }, [renderLimit, visible.length]);

  const focusVisibleIndex = (index: number, openSingle = true, focusRow = false) => {
    if (busy) return;
    if (index < 0 || index >= visible.length) return;
    const item = visible[index];
    setFocusedId(item.binding.segment_id);
    if (openSingle) setDetailView('single');
    pendingScrollId.current = item.binding.segment_id;
    pendingRowFocusId.current = focusRow ? item.binding.segment_id : null;
    setRenderLimit((current) => Math.max(current, Math.min(visible.length, index + 1)));
  };
  const moveFocus = (direction: -1 | 1, openSingle = detailView === 'single', focusRow = false) => {
    const currentIndex = focusedId === null ? -1 : visibleIds.indexOf(focusedId);
    const targetIndex = currentIndex < 0 ? (direction > 0 ? 0 : visible.length - 1) : currentIndex + direction;
    focusVisibleIndex(targetIndex, openSingle, focusRow);
  };
  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLElement>, item: GroupingItem) => {
    if (isInteractiveTarget(event.target)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectItem(item);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(event.key === 'ArrowUp' ? -1 : 1, detailView === 'single', true);
    }
  };
  const handlePreviewKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isFormControlTarget(event.target)) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    moveFocus(event.key === 'ArrowUp' ? -1 : 1);
  };
  const selectItem = (item: GroupingItem) => { if (busy) return; setFocusedId(item.binding.segment_id); setDetailView('single'); };
  const toggleSelected = (item: GroupingItem, checked: boolean) => setSelected((prior) => {
    const next = new Set(prior);
    if (checked) {
      if (next.size >= BATCH_LIMIT) return next;
      next.add(item.binding.segment_id);
    } else next.delete(item.binding.segment_id);
    return next;
  });
  const changeFilter = (next: string) => { if (busy) return; setFilter(next as FilterKey); setIssueFilter('all'); setSelected(new Set()); setRenderLimit(BATCH_LIMIT); pendingRowFocusId.current = null; };
  const changeSearch = (next: string) => { if (busy) return; setSearch(next); setSelected(new Set()); setRenderLimit(BATCH_LIMIT); pendingRowFocusId.current = null; };
  const setRowRef = (id: string, node: HTMLElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  };
  const openOverviewItem = (id: string) => {
    const index = visibleIds.indexOf(id);
    if (index >= 0) focusVisibleIndex(index);
  };
  const editsFor = (assignment: GroupingEdit['assignment']) => actionItems.map((item) => ({ segment_id: item.binding.segment_id, expected_basis_fingerprint: item.basis_fingerprint, assignment }));
  const createGroup = () => { if (!newName.trim() || !canAssign) return; const groupId = `manual-${crypto.randomUUID()}`; void save(editsFor({ group_id: groupId, reason: '查看原件和字段依据后手工建立分组。' }), [{ action: 'create', group_id: groupId, kind: 'named', display_name: newName.trim() }]); };
  const confirmOwn = () => {
    if (!ownSide || ownBlocked || !ownChecked || !bankChecked || actionItems.length === 0 || actionItems.length > BATCH_LIMIT) return;
    const side = ownSide;
    const reason = `用户已对照原件确认本方为${{ payer: '付款方', payee: '收款方', single: '单方凭证' }[side]}，已核实凭证属于本批公司所选账户，回单出具银行与本批来源银行一致。${ownReason.trim() ? `备注：${ownReason.trim()}` : ''}`;
    void save(actionItems.map((item) => ({ segment_id: item.binding.segment_id, expected_basis_fingerprint: item.basis_fingerprint, own_confirmation: { side, confirms_selected_account: true, confirms_source_bank: true, reason } })));
  };
  const closeFieldEditor = () => { setDetailAction(null); setFieldTarget(null); };
  const openFieldEditor = (target: GroupingFieldTarget | null = null) => {
    setFieldTarget(target ?? { side: null, field: 'name' });
    setDetailAction('field');
  };
  const handleGuidanceAction = () => {
    if (!focusedGuidance || !focused) return;
    const action = focusedGuidance.action;
    if (action.kind === 'field' && action.side === 'counterparty' && action.field === 'name') setDetailAction('counterparty');
    else if (action.kind === 'field') openFieldEditor({ side: action.side, field: action.field });
    else if (action.kind === 'refresh') void refresh();
    else if (action.kind === 'source') { if (onSelectSegment) onSelectSegment(focused.binding.segment_id); else onBack?.(); }
    else { setSelected(new Set()); setDetailAction('own'); }
  };
  const exportDraft = async () => { if (!snapshot || !onExportDraft || busy) return; const { controller, version } = begin('draft'); try { await onExportDraft(snapshot); } catch (cause) { if (operationActive(version, controller)) setError(groupingErrorMessage(cause)); } finally { finish(version); } };
  const showStatusbar = Boolean(working || reviewNotice || error || recoveryAvailable || (snapshot && needsExtraction));
  const quickSelectCount = Math.min(BATCH_LIMIT, visible.length);
  const quickSelectChecked = quickSelectCount > 0 && visible.slice(0, quickSelectCount).every((item) => selected.has(item.binding.segment_id));
  const receiveRuleResult = async (result: FieldRuleApplied) => {
    setLastRuleOperationId(result.operation.status === 'applied' ? result.operation.operation_id : null);
    publish(null);
    try { const next = await client.loadAll(result.header); if (activeRef.current) publish(next); }
    catch (cause) { setError(failureMessage(cause)); setRecoveryAvailable(true); throw cause; }
    finally { setRuleEditorId(null); }
  };
  const previewControls = <div className="receipt-grouping-detail__controls" aria-label="回单预览切换">
    {renderOverview && <>
      <button type="button" aria-pressed={detailView === 'overview'} disabled={busy} onClick={() => setDetailView('overview')}>片段总览</button>
      <button type="button" aria-pressed={detailView === 'single'} disabled={busy} onClick={() => setDetailView('single')}>单张核对</button>
    </>}
    <button type="button" aria-label="上一张" disabled={busy || focusedIndex <= 0} onClick={() => focusVisibleIndex(focusedIndex - 1, detailView === 'single')}>上一张</button>
    <button type="button" aria-label="下一张" disabled={busy || focusedIndex < 0 || focusedIndex >= visible.length - 1} onClick={() => focusVisibleIndex(focusedIndex + 1, detailView === 'single')}>下一张</button>
    <span className="receipt-grouping-detail-index">{focusedIndex >= 0 ? focusedIndex + 1 : 0} / {visible.length}</span>
  </div>;

  return <section className={`receipt-grouping-panel${active ? '' : ' receipt-grouping-panel--inactive'}`} aria-label="交易对手核对与分组" aria-hidden={!active}>
    <header className="receipt-grouping-panel__heading"><div className="receipt-grouping-panel__title-block"><div className="receipt-grouping-panel__title"><h3>交易对手核对与分组</h3></div><nav className="receipt-grouping-panel__back-nav" aria-label="返回与来源管理">{onBack && <button type="button" disabled={busy} onClick={onBack}>返回分割审核</button>}{onBackToAnalysis && <button type="button" disabled={busy} onClick={onBackToAnalysis}>返回分析</button>}{onRemoveSources && <button type="button" disabled={busy} onClick={onRemoveSources}>清除来源</button>}</nav></div><div className="receipt-grouping-panel__heading-actions"><button type="button" aria-expanded={toolsOpen} aria-controls="receipt-grouping-extra-tools" disabled={!snapshot || busy} onClick={() => setToolsOpen((open) => !open)}>更多工具</button>{onExportDraft && <button type="button" disabled={busy || !snapshot} onClick={() => void exportDraft()}>导出核对草稿 Excel</button>}{onExport && <button type="button" className="primary" disabled={busy || !snapshot || !canExport} onClick={onExport}>检查并导出</button>}</div></header>
    <div className="receipt-grouping-panel__summary" aria-label="待确认与本批信息">{snapshot ? <><span><strong>本方按本批资料</strong> {snapshot.header.own_account.company_name} · {snapshot.header.own_account.bank_name} · {snapshot.header.own_account.account_number}</span><span>共 {snapshot.header.counts.total} 张（含已排除）</span>{snapshot.header.counts.own_pending > 0 && <span>旧版待更新 {snapshot.header.counts.own_pending}</span>}<span>交易对手待确认 {snapshot.header.counts.counterparty_pending}</span><span>待提取 {snapshot.header.counts.extraction_pending + snapshot.header.counts.stale}</span></> : <span>{working ? '正在载入交易对手核对数据…' : '尚未载入交易对手核对数据'}</span>}</div>
    {snapshot && profileConflictCount > 0 && <div className="receipt-grouping-profile-notice" aria-label="本批资料差异提示">
      <span>有 {profileConflictCount} 张回单的公司、账号或银行与本批资料不一致，请对照原件核对交易对手。</span>
      <button type="button" disabled={busy} onClick={() => changeFilter('profile-conflicts')}>查看这 {profileConflictCount} 张</button>
    </div>}
    {showStatusbar && <div className="receipt-grouping-panel__statusbar">{working && <p role="status">{working === 'load' ? '正在载入当前分组…' : working === 'save' ? '正在保存人工核对并核对版本…' : working === 'draft' ? '正在生成核对草稿…' : `正在提取字段：${progress?.completed ?? 0} / ${progress?.total ?? 0}`}</p>}{reviewNotice && <p role="alert">{reviewNotice}</p>}{error && <p role="alert">{error}</p>}<div className="receipt-grouping-panel__status-actions">{recoveryAvailable && !working && <button type="button" disabled={busy || !active} onClick={() => void load({ allowAuto: false })}>重新载入已保存结果</button>}{snapshot && needsExtraction && !working && <button type="button" disabled={busy || !active} onClick={() => void refresh()}>继续提取字段</button>}{working && working !== 'draft' && <button type="button" onClick={stop}>停止后续操作</button>}</div></div>}
    {snapshot && <section id="receipt-grouping-extra-tools" className="receipt-grouping-extra-tools" hidden={!toolsOpen} aria-label="更多工具">
      <p>交易对手名称可直接修改；收付款资料用于核对本方和账号，同版式批量识别用于逐张重新读取交易对手。</p>
      <div className="receipt-grouping-extra-tools__actions">
        {focused && <button type="button" disabled={busy || focused.route === 'excluded'} onClick={() => { setToolsOpen(false); openFieldEditor(); }}>核对收付款资料</button>}
        {canAssign && <button type="button" disabled={busy} onClick={() => { setToolsOpen(false); setDetailAction('group'); }}>{selectedItems.length > 1 ? '批量移组／拆组（' + selectedItems.length + '）' : '移组／拆组'}</button>}
        {focused && renderPreview && canConfigureFieldRule(focused) && <button type="button" disabled={busy} onClick={() => { setToolsOpen(false); setSelected(new Set()); setDetailAction(null); setRuleEditorId(focused.binding.segment_id); }}>同版式批量识别</button>}
      </div>
      <ReceiptGroupingRuleTools header={snapshot.header} client={fieldRuleClient} lastOperationId={lastRuleOperationId} disabled={disabled || working !== null || ruleEditorId !== null} initialOutputDirectory={initialOutputDirectory} onBusyChange={setRuleToolsBusy} onApplied={receiveRuleResult} />
    </section>}
    {snapshot && <ReceiptGroupingColumns
      left={<aside className="receipt-grouping-pane receipt-grouping-pane--directory" aria-label="分组目录"><div className="receipt-grouping-pane__header"><div><strong>分组目录</strong><small>{all.length} 张（含已排除）</small></div></div><label className="receipt-grouping-search">名称搜索<input aria-label="分组名称搜索" value={search} placeholder="搜索名称、账号或来源" onChange={(event) => changeSearch(event.target.value)} /></label><nav className="receipt-grouping-directory" aria-label="分组筛选"><button type="button" className={filter === 'all' ? 'is-current' : ''} aria-current={filter === 'all' ? 'true' : undefined} onClick={() => changeFilter('all')}><span>▦</span><strong>全部回单</strong><em>{all.length}</em></button><div className="receipt-grouping-directory__label">待确认与去向</div>{routeFilters.map((route) => { const count = all.filter((item) => matchesFilter(item, route.key)).length; if (route.key === 'route:own_pending' && count === 0) return null; return <button type="button" key={route.key} className={`${filter === route.key ? 'is-current ' : ''}${route.tone ?? ''}`} aria-current={filter === route.key ? 'true' : undefined} onClick={() => changeFilter(route.key)}><span>{route.symbol}</span><strong>{route.label}</strong><em>{count}</em></button>; })}{groups.length > 0 && <div className="receipt-grouping-directory__label">交易对手分组</div>}{groups.map(({ definition, count }) => <button type="button" key={definition.group_id} className={filter === definition.group_id ? 'is-current' : ''} aria-current={filter === definition.group_id ? 'true' : undefined} onClick={() => changeFilter(definition.group_id)}><span>•</span><strong title={groupDisplayName(definition)}>{groupDisplayName(definition)}</strong><em>{count}</em></button>)}</nav><p className="receipt-grouping-directory__note">同一交易对手按名称归组；本公司内部往来也按公司名称统一成组。账号和开户行保留在回单详情中。</p></aside>}
      center={<section className="receipt-grouping-pane receipt-grouping-pane--list" aria-label="连续回单列表"><header className="receipt-grouping-pane__header receipt-grouping-pane__header--list"><div><strong>{activeFilterLabel}</strong><small>{search.trim() ? `搜索结果 ${visible.length} 张` : `当前 ${visible.length} 张`}</small></div><span className="receipt-grouping-selection-count">已选 {selected.size} / {BATCH_LIMIT}（批量上限）</span></header>{['route:counterparty_pending', 'route:own_pending'].includes(filter) && issueCollections.length > 0 && <label className="receipt-grouping-issue-filter">按问题查看<select aria-label="待确认问题分类" disabled={busy} value={issueFilter} onChange={(event) => { setIssueFilter(event.target.value); setSelected(new Set()); setRenderLimit(BATCH_LIMIT); }}><option value="all">全部待确认问题</option>{issueCollections.map((collection) => <option key={collection.key} value={collection.key}>{collection.label} · {collection.segmentIds.length} 张</option>)}</select>{selectedIssue && !selectedIssue.hasLayout && <small>仅按原因集中显示；试读时会逐张检查是否适用。</small>}</label>}<div className="receipt-grouping-list__toolbar"><label className="receipt-grouping-check"><input type="checkbox" aria-label={`勾选前 ${quickSelectCount} 张（批量上限）`} checked={quickSelectChecked} disabled={busy || visible.length === 0} onChange={(event) => setSelected(event.target.checked ? new Set(visible.slice(0, quickSelectCount).map((item) => item.binding.segment_id)) : new Set())} />勾选前 {quickSelectCount} 张（批量上限）</label><span>点击回单只选中，详情在右栏查看</span></div><div className="receipt-grouping-list" onScroll={(event) => { const node = event.currentTarget; if (node.scrollHeight - node.scrollTop - node.clientHeight < 240) setRenderLimit((current) => Math.min(current + BATCH_LIMIT, visible.length)); }}>{rendered.map((item) => <article key={item.binding.segment_id} ref={(node) => setRowRef(item.binding.segment_id, node)} className={`receipt-grouping-row${focusedId === item.binding.segment_id ? ' is-focused' : ''}${selected.has(item.binding.segment_id) ? ' is-selected' : ''}`} role="button" tabIndex={0} aria-pressed={focusedId === item.binding.segment_id} onClick={() => selectItem(item)} onKeyDown={(event) => handleListKeyDown(event, item)}><input type="checkbox" aria-label={`选择 ${sourceLabel(item)}`} checked={selected.has(item.binding.segment_id)} disabled={busy || (!selected.has(item.binding.segment_id) && selected.size >= BATCH_LIMIT)} onClick={(event) => event.stopPropagation()} onChange={(event) => toggleSelected(item, event.target.checked)} /><div className="receipt-grouping-row__body"><div className="receipt-grouping-row__top"><strong>{itemName(item)}</strong><GroupingStatus item={item} /></div><div className="receipt-grouping-row__account">{groupingItemSummary(item)}</div><div className="receipt-grouping-row__source">{sourceLabel(item)}<span>{item.decision_method === 'manual' ? '人工决定' : item.decision_method === 'automatic' ? '自动判断' : '待判断'}</span></div></div></article>)}{visible.length === 0 && <p className="receipt-grouping-empty">当前目录没有符合条件的片段。</p>}<div ref={sentinelRef} className="receipt-grouping-list__end" aria-live="polite">{rendered.length < visible.length ? '向下滚动将连续载入更多回单…' : visible.length > 0 ? `已显示当前筛选的全部 ${visible.length} 张回单` : ''}</div></div><footer className="receipt-grouping-pane__footer">每次最多勾选 {BATCH_LIMIT} 张，可统一修改交易对手。</footer></section>}
      right={
        <aside className="receipt-grouping-pane receipt-grouping-pane--detail" aria-label="回单详情">
          {rulePrototype && renderPreview ? <div className="receipt-grouping-detail__scroll"><ReceiptFieldRuleEditor key={rulePrototype.binding.segment_id} snapshot={snapshot} prototype={rulePrototype} client={fieldRuleClient} renderPreview={renderPreview} onApplied={receiveRuleResult} onClose={() => { setRuleEditorId(null); setRuleComputing(false); }} onComputing={setRuleComputing} /></div> : !focused ? <div className="receipt-grouping-empty receipt-grouping-empty--detail"><strong>选择一张回单</strong><span>左侧选分组，中间勾选回单，再修改交易对手或导出。</span></div> : <>
            {(detailView === 'overview' || !renderPreview) && <header className="receipt-grouping-pane__header receipt-grouping-pane__header--detail">
              <div>
                <strong>{detailView === 'overview' && renderOverview ? '片段总览' : '单张核对'}</strong>
                <small>{activeFilterLabel} · 当前筛选 {visible.length} 张</small>
              </div>
              {previewControls}
            </header>}
            {detailView === 'overview' && renderOverview ? <div className="receipt-grouping-detail__overview" aria-label="片段总览" tabIndex={0} onKeyDown={handlePreviewKeyDown}>{renderOverview({ segmentIds: visibleIds, focusedId, onOpen: openOverviewItem, active, disabled: busy, contextKey: overviewContextKey })}</div> : <div ref={detailScrollRef} className="receipt-grouping-detail__scroll">
              {!renderPreview && <div className="receipt-grouping-detail__source"><strong>{sourceName(focused)}</strong><span>第 {focused.binding.source_page} 页 · 第 {focused.binding.position_index} 栏</span></div>}
              {focusedGuidance && <section className="receipt-grouping-guidance" aria-label="需要您处理">
                <div><small>需要您处理 · 当前这一张</small><strong>{focusedGuidance.reason}</strong><p>{focusedGuidance.instruction}</p></div>
                {!quickFieldEditor && !(focusedGuidance.action.kind === 'field' && focusedGuidance.action.side === 'counterparty' && focusedGuidance.action.field === 'name') && <button type="button" disabled={busy || (focusedGuidance.action.kind === 'source' && !onSelectSegment && !onBack)} onClick={handleGuidanceAction}>{focusedGuidance.action.label}</button>}
                {quickFieldEditor && <div className="receipt-grouping-guidance__editor" ref={(node) => { actionFormRef.current = node; }}>
                  <FieldEditor key={`${focused.binding.segment_id}:${focused.basis_fingerprint}:${fieldTarget?.side}:${fieldTarget?.field}`} item={focused} target={fieldTarget} disabled={busy} onSave={(edits) => void save(edits)} onCancel={closeFieldEditor} />
                </div>}
              </section>}
              {detailAction === 'counterparty' && <div className="receipt-grouping-counterparty-editor-host" ref={(node) => { actionFormRef.current = node; }}>
                <ReceiptCounterpartyEditor key={actionContextKey} items={actionItems} selected={selectedItems.length > 0} groups={groups.map(({ definition }) => definition)} disabled={busy} formId={counterpartyFormId} showActions={false} onCanSubmitChange={updateCounterpartyCanSubmit} onSave={save} onCancel={() => setDetailAction(null)} />
              </div>}
              {renderPreview ? <div className="receipt-grouping-detail__preview" tabIndex={0} aria-label="原件预览，可用上下键切换" onKeyDown={handlePreviewKeyDown}>{renderPreview(focused.binding.segment_id, { controls: previewControls })}</div> : <div className="receipt-grouping-detail__preview receipt-grouping-detail__preview--empty" tabIndex={0} aria-label="原件预览，可用上下键切换" onKeyDown={handlePreviewKeyDown}>父级未提供原件预览。</div>}
              <details className="receipt-grouping-detail__section receipt-grouping-recognition-details"><summary>查看识别资料（选看）</summary>
                <h4>{focused.route === 'special' ? '凭证分类' : '交易对手'}</h4>
                {focused.route === 'special' ? <div className="receipt-grouping-party-card"><strong>{routeLabel(focused)}</strong><span>按此类型归组，无需补填对方账号。</span></div>
                  : focused.own_decision.status !== 'confirmed' ? <div className="receipt-grouping-party-card receipt-grouping-party-card--pending"><span>确认本方后，将在这里显示交易对手资料。</span></div> : <CompactParty party={counterpartyParty(focused)} label="当前交易对手" />}
                {focused.route === 'internal' && <p className="receipt-grouping-muted">本公司内部往来按公司名称统一成组，账号和开户行不拆组。若识别有误，请修改交易对手名称后重新判断。</p>}
                <details className="receipt-grouping-party-details"><summary>查看收付款双方资料</summary><CompactParty party={effectiveParty(focused, "payer")} label="付款方" /><CompactParty party={effectiveParty(focused, "payee")} label="收款方" /></details>
              <details className="receipt-grouping-detail__evidence">
                <summary>技术详情（排查时查看）</summary>
                <div>
                  <div className="receipt-grouping-field-tables"><FieldTable party={effectiveParty(focused, "payer")} label="付款方" /><FieldTable party={effectiveParty(focused, "payee")} label="收款方" />{canEditDirectCounterparty(focused) && <FieldTable party={effectiveParty(focused, "counterparty")} label="交易对手" />}</div>
                  <p>本方：{focused.own_decision.status === "confirmed" ? "已确认" : "待确认"}；{focused.own_decision.method === "batch_profile" ? "按本批账户资料" : focused.own_decision.method === "manual" ? "人工核对" : focused.own_decision.method === "account_match" ? "完整账号匹配" : "尚无可靠判断"}。</p>
                  {focused.own_decision.reasons.map((code, index) => <p key={"own-" + code + "-" + index}>{groupingIssueLabel(code)}</p>)}
                  {focused.extracted?.diagnostics.map((diagnostic, index) => <p key={"extract-" + index}>提取诊断：{diagnostic}</p>)}
                  {focused.warnings.map((code, index) => <p key={"warning-" + code + "-" + index}>{groupingIssueLabel(code)}</p>)}
                  {focused.field_overrides.length > 0 && <ul aria-label="人工修正记录">{focused.field_overrides.map((entry) => <li key={entry.side + ":" + entry.field}>{({ payer: "付款方", payee: "收款方", counterparty: "对手" })[entry.side]} · {({ name: "名称", account: "账号", bank: "开户行" })[entry.field]}：{entry.state === "blank" ? "已确认空白" : entry.value}；依据：{entry.reason}</li>)}</ul>}
                </div>
              </details>
              </details>
              {detailAction === "field" && !quickFieldEditor && <details ref={(node) => { actionFormRef.current = node; }} className="receipt-grouping-detail__action-form" open><summary>修正当前片段字段</summary><FieldEditor key={`${focused.binding.segment_id}:${focused.basis_fingerprint}:${fieldTarget?.side ?? ""}:${fieldTarget?.field ?? ""}`} item={focused} target={fieldTarget} disabled={busy} onSave={(edits) => void save(edits)} onCancel={closeFieldEditor} /></details>}
              {detailAction === "own" && <details ref={(node) => { actionFormRef.current = node; }} className="receipt-grouping-detail__action-form" open>
                <summary>本方身份确认</summary>
                <fieldset disabled={busy} className="receipt-grouping-form"><legend>{ownScopeLabel}</legend>
                  <p>{selectedItems.length > 0 ? `将同时确认已勾选的 ${selectedItems.length} 张。请逐张核对，且本方须位于同一侧。` : '只确认右侧当前回单，不影响其他回单。'}</p>
                  {ownBlocked && <p role="alert" className="receipt-grouping-form__blocked">所选回单仍有识别冲突、未完成提取或已排除项。请先按“需要您处理”的提示处理；本方确认不能跳过这些问题。</p>}
                  <label>本方所在一侧<select aria-label="本方所在一侧" value={ownSide} onChange={(event) => setOwnSide(event.target.value as typeof ownSide)}>
                    <option value="">请选择本方所在一侧</option><option value="payer">付款方</option><option value="payee">收款方</option><option value="single">单方凭证，无完整收付款双方</option>
                  </select></label>
                  <label className="receipt-grouping-check"><input type="checkbox" checked={ownChecked} onChange={(event) => setOwnChecked(event.target.checked)} />我已核实，所选回单属于本批公司及所选账户</label>
                  {(ownSide === 'single' || actionItems.some((item) => item.own_decision.reasons.includes('own_account_missing'))) && <p>未读到完整账号时，也需核实这张凭证属于哪个账户；无法确定请保留待确认。</p>}
                  <label className="receipt-grouping-check"><input type="checkbox" checked={bankChecked} onChange={(event) => setBankChecked(event.target.checked)} />已核对回单出具银行，确认是本批来源银行</label>
                  <label>备注（选填）<input aria-label="本方确认备注" maxLength={800} value={ownReason} onChange={(event) => setOwnReason(event.target.value)} /></label>
                  <button type="button" disabled={actionItems.length === 0 || actionItems.length > BATCH_LIMIT || ownBlocked || !ownSide || !ownChecked || !bankChecked} onClick={confirmOwn}>保存本方确认</button>
                  <p>仅在核对无误后勾选并保存。系统会记录本次确认；名称或账号识别错误应先修正字段，属于其他公司或银行的回单应另批处理。</p>
                </fieldset>
              </details>}

              {detailAction === "group" && <details ref={(node) => { actionFormRef.current = node; }} className="receipt-grouping-detail__action-form" open><summary>高级归组与恢复默认</summary><p className="receipt-grouping-muted">这里只调整导出分组，不修改交易对手名称。需要统一修正名称时，请使用“修改交易对手”。</p><fieldset disabled={busy} className="receipt-grouping-form"><legend>{selectedItems.length > 0 ? "所选 " + selectedItems.length + " 张片段" : "当前片段"}的归组</legend><label>移入已有组<select aria-label="移入已有组" value={targetGroup} onChange={(event) => setTargetGroup(event.target.value)}><option value="">请选择目标组</option>{groups.filter(({ definition }) => definition.kind === "named").map(({ definition }) => <option key={definition.group_id} value={definition.group_id}>{definition.display_name}</option>)}</select></label><div className="receipt-grouping-form-actions"><button type="button" disabled={!canAssign || !targetGroup} onClick={() => void save(editsFor({ group_id: targetGroup, reason: "查看原件和字段依据后手工移入此组。" }))}>将所选片段移入此组</button><button type="button" disabled={!canAssign} onClick={() => void save(editsFor(null))}>恢复默认归组</button></div><label>新组／组名称<input aria-label="分组名称" maxLength={256} value={newName} onChange={(event) => setNewName(event.target.value)} /></label><div className="receipt-grouping-form-actions"><button type="button" disabled={!canAssign || !newName.trim()} onClick={createGroup}>将所选片段拆为新组</button><button type="button" disabled={!filterGroup || filterGroup.kind !== "named" || !newName.trim()} onClick={() => filterGroup && void save([], [{ action: "rename", group_id: filterGroup.group_id, display_name: newName.trim() }])}>重命名当前筛选组</button></div>{actionItems.length > BATCH_LIMIT && <p>每次批量保存最多 {BATCH_LIMIT} 张片段。</p>}{!canAssign && actionItems.length > 0 && <p>只有已提取的普通交易对手回单可移组。本公司内部往来按公司名称统一归组，需变更时请修正交易对手字段。</p>}</fieldset></details>}
            </div>}
            <footer className="receipt-grouping-detail__footer">
              <div className="receipt-grouping-route-result"><small>当前去向</small><strong>{routeLabel(focused)}</strong><span>{groupingItemSummary(focused)} · {focused.decision_method === "manual" ? "人工决定" : focused.decision_method === "automatic" ? "自动判断" : "待判断"}</span></div>
              {selectedItems.length > 0 && <p className="receipt-grouping-selection-context">批量操作对象：已选 {selectedItems.length} 张（批量上限 {BATCH_LIMIT} 张）</p>}
              <div className="receipt-grouping-detail__actions" role="group" aria-label="交易对手操作">
                {detailAction === 'counterparty' ? <>
                  <button type="button" disabled={busy} onClick={() => setDetailAction(null)}>取消修改</button>
                  <button type="submit" form={counterpartyFormId} className="primary" disabled={busy || !canCorrect || !canSubmitCounterparty}>{selectedItems.length > 0 ? `保存到所选 ${selectedItems.length} 张` : '保存当前 1 张'}</button>
                </> : <>
                  {onSelectSegment && <button type="button" disabled={busy} onClick={() => onSelectSegment(focused.binding.segment_id)}>回查分割审核定位</button>}
                  {!ownBlocked && (focused.route === 'own_pending' || selectedItems.some((item) => item.route === 'own_pending')) && <button type="button" disabled={busy} onClick={() => setDetailAction((current) => current === 'own' ? null : 'own')}>本方确认</button>}
                  <button type="button" className="primary" disabled={busy || !canCorrect} onClick={() => { setDetailView('single'); setDetailAction('counterparty'); }}>{selectedItems.length > 1 ? '批量修改交易对手（' + selectedItems.length + '）' : '修改交易对手'}</button>
                </>}
              </div>
              {!canCorrect && selectedItems.length > 0 && <p className="receipt-grouping-selection-context">所选回单包含未完成提取、资料冲突、已排除或特殊凭证，请先处理这些项目再批量修改。</p>}
            </footer>
          </>}
        </aside>
      }
    />}
    {active && !snapshot && working === null && <div className="receipt-grouping-loading"><strong>{recoveryAvailable ? '当前结果未载入' : '正在准备交易对手核对…'}</strong><span>{recoveryAvailable ? '请按上方提示处理后，重新载入已保存结果。' : '正在读取本批审核依据。'}</span></div>}
  </section>;
}
