import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SPECIAL_DOCUMENT_LABELS, type ReceiptBatchReviewPageItem } from '../domain/receiptBatch';
import { isReceiptExcluded, matchesReceiptFilter, needsReceiptReview, type ReceiptCalibrationController, type ReceiptCalibrationState, type ReceiptReviewSession } from '../services/receiptCalibrationController';
import { PdfThumbnailGrid, type PdfThumbnailAttention, type PdfThumbnailCard, type PdfThumbnailTone } from './PdfThumbnailGrid';
import ThumbnailSizeControl, { THUMBNAIL_SIZE_DEFAULT } from './ThumbnailSizeControl';
import { ReceiptDocumentTypePanel } from './ReceiptDocumentTypePanel';
import './ReceiptOverview.css';

export type ReceiptOverviewCard = PdfThumbnailCard & { ids: string[] };
type View = 'receipts' | 'pages';
type DocumentType = 'all' | 'ordinary' | 'special' | keyof typeof SPECIAL_DOCUMENT_LABELS;
type Props = {
  state: ReceiptCalibrationState;
  controller: ReceiptCalibrationController;
  canExport: boolean;
  primaryActionLabel?: string;
  onExport: () => void;
  onBack: () => void;
  onOpenTemplates?: () => void;
  renderPage: (card: ReceiptOverviewCard) => ReactNode;
  active?: boolean;
  groupingFilterIds?: string[] | null;
  requestedSegment?: { id: string; sequence: number } | null;
};
const pageKey = (source: string, page: number) => JSON.stringify([source, page]);
const typeMatches = (item: ReceiptBatchReviewPageItem, type: DocumentType) => type === 'all'
  || (type === 'ordinary' ? !item.page_notice : type === 'special' ? Boolean(item.page_notice) : item.page_notice?.document_type === type);
const isSuspectedInvalid = (item: ReceiptBatchReviewPageItem) => Boolean(item.exclusion_notice)
  && !item.page_notice && needsReceiptReview(item);
export const receiptStatusLabel = (item: ReceiptBatchReviewPageItem) => isReceiptExcluded(item) ? '已排除'
  : item.record?.review_status === 'blocked' ? '需调整'
    : isSuspectedInvalid(item) ? '待核对'
      : needsReceiptReview(item) ? '待复核' : item.record ? '已确认' : '自动候选';
const tone = (item: ReceiptBatchReviewPageItem): PdfThumbnailTone => isReceiptExcluded(item) ? 'excluded'
  : needsReceiptReview(item) ? 'pending' : item.record ? 'confirmed' : 'automatic';
const attention = (item: ReceiptBatchReviewPageItem): PdfThumbnailAttention | undefined => isReceiptExcluded(item) ? undefined : item.page_notice ? 'special'
  : isSuspectedInvalid(item) ? 'suspected' as const : undefined;
const effectiveRect = (item: ReceiptBatchReviewPageItem) => item.record ? item.record.final_rect ?? {
  x0: 0, y0: 0, x1: item.original.page_geometry.width_pt, y1: item.original.page_geometry.height_pt,
} : item.original.candidate_rect;
const receiptOverlayLabel = (item: ReceiptBatchReviewPageItem, badge: string) => {
  const position = `第 ${item.original.source_page} 页 · 第 ${item.original.position_index} 栏`;
  const kind = item.page_notice ? SPECIAL_DOCUMENT_LABELS[item.page_notice.document_type]
    : isSuspectedInvalid(item) ? '疑似无效' : '普通回单';
  return `${position} · ${kind} · ${badge}`;
};
const receiptProjection = (item: ReceiptBatchReviewPageItem) => {
  const badge = receiptStatusLabel(item);
  return { tone: tone(item), attention: attention(item), badge, label: receiptOverlayLabel(item, badge) };
};

/** Page selection expands only to the matching candidates, never to unseen keyword misses. */
export function buildReceiptOverviewCards(session: ReceiptReviewSession, items: ReceiptBatchReviewPageItem[], view: View,
  sourceFilter: string, includeEmptyPages: boolean): ReceiptOverviewCard[] {
  const sources = session.prepared.binding.job.sources;
  const sourcesByKey = new Map(sources.map((source) => [source.source_key, source]));
  if (view === 'receipts') return items.flatMap((item) => {
    const source = sourcesByKey.get(item.original.source_key);
    if (!source?.sha256 || !source.page_count) return [];
    const rect = effectiveRect(item), projection = receiptProjection(item);
    const { label: overlayLabel, ...status } = projection;
    return [{ id: item.original.id, ids: [item.original.id], path: source.access_path, sha: source.sha256,
      page: item.original.source_page, pageCount: source.page_count, sourceLabel: source.name,
      label: `第 ${item.original.source_page} 页 · 第 ${item.original.position_index} 栏`,
      width: item.original.page_geometry.width_pt, height: item.original.page_geometry.height_pt,
      rect, ...status, overlays: [{ rect, ...status, label: overlayLabel }],
      description: item.page_notice ? SPECIAL_DOCUMENT_LABELS[item.page_notice.document_type]
        : isSuspectedInvalid(item) ? '疑似无效栏位，请查看原件后决定是否排除' : undefined,
    }];
  });
  const matchingByPage = new Map<string, ReceiptBatchReviewPageItem[]>();
  const allByPage = new Map<string, ReceiptBatchReviewPageItem[]>();
  for (const item of session.items) {
    const key = pageKey(item.original.source_key, item.original.source_page);
    const entries = allByPage.get(key) ?? []; entries.push(item); allByPage.set(key, entries);
  }
  for (const item of items) {
    const key = pageKey(item.original.source_key, item.original.source_page);
    const entries = matchingByPage.get(key) ?? []; entries.push(item); matchingByPage.set(key, entries);
  }
  const cards: ReceiptOverviewCard[] = [];
  for (const source of sources) {
    if (sourceFilter !== 'all' && sourceFilter !== source.source_key || !source.sha256 || !source.page_count) continue;
    for (let page = 1; page <= source.page_count; page++) {
      const key = pageKey(source.source_key, page), matches = matchingByPage.get(key) ?? [], all = allByPage.get(key) ?? [];
      if (!includeEmptyPages && !matches.length) continue;
      const geometry = all[0]?.original.page_geometry;
      cards.push({ id: key, ids: matches.map((item) => item.original.id), path: source.access_path, sha: source.sha256,
        page, pageCount: source.page_count, label: `第 ${page} 页`, sourceLabel: source.name,
        width: geometry?.width_pt, height: geometry?.height_pt, selectable: matches.length > 0,
        badge: all.length ? `${matches.length} / ${all.length} 处` : '无候选片段',
        description: all.some((item) => item.page_notice) ? '含特殊单证' : undefined,
        overlays: all.map((item) => ({ rect: effectiveRect(item), ...receiptProjection(item) })),
      });
    }
  }
  return cards;
}

export function ReceiptOverview({ state, controller, canExport, primaryActionLabel = '导出回单', onExport, onBack, onOpenTemplates, renderPage, active = true, groupingFilterIds, requestedSegment }: Props) {
  const session = state.session!;
  const [view, setView] = useState<View>('receipts');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState<DocumentType>('all');
  const [suspectedOnly, setSuspectedOnly] = useState(false);
  const [size, setSize] = useState(THUMBNAIL_SIZE_DEFAULT);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selection, setSelection] = useState<{ session: ReceiptReviewSession; scope: string; ids: Set<string> } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailItemId, setDetailItemId] = useState<string | null>(null);
  const [typeEditor, setTypeEditor] = useState<{ ids: string[]; contextKey: string; scope: string } | null>(null);
  const anchor = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null), gridRef = useRef<HTMLDivElement>(null);
  const returnFocusCard = useRef<string | null>(null);
  const busy = state.reviewConfirming;
  const scope = JSON.stringify([view, sourceFilter, typeFilter, state.reviewFilter, suspectedOnly, groupingFilterIds]);
  const sessionKey = (value: ReceiptReviewSession) => JSON.stringify([value.prepared.binding.job.id, value.prepared.binding.contextKey,
    value.prepared.prepared?.context_key, value.prepared.prepared?.result_revision,
    value.prepared.binding.job.sources.map((source) => [source.source_key, source.sha256])]);
  const contextKey = sessionKey(session);
  const groupingIds = useMemo(() => groupingFilterIds ? new Set(groupingFilterIds) : null, [groupingFilterIds]);
  const openedRequest = useRef<object | null>(null);
  const filtered = useMemo(() => session.items.filter((item) => (sourceFilter === 'all' || item.original.source_key === sourceFilter)
    && typeMatches(item, typeFilter) && matchesReceiptFilter(item, state.reviewFilter)
    && (!groupingIds || groupingIds.has(item.original.id))
    && (!suspectedOnly || isSuspectedInvalid(item))),
    [session, sourceFilter, typeFilter, state.reviewFilter, suspectedOnly, groupingIds]);
  const cards = useMemo(() => buildReceiptOverviewCards(session, filtered, view, sourceFilter,
    state.reviewFilter === 'all' && typeFilter === 'all' && !groupingIds), [session, filtered, view, sourceFilter, state.reviewFilter, typeFilter, groupingIds]);
  const checked = selection && sessionKey(selection.session) === contextKey && selection.scope === scope ? selection.ids : new Set<string>();
  const selected = filtered.filter((item) => checked.has(item.original.id));
  const selectedCards = new Set(cards.filter((card) => card.ids.length && card.ids.every((id) => checked.has(id))).map((card) => card.id));
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const detail = detailId ? cardById.get(detailId) : undefined;
  const detailItems = detail ? session.items.filter((item) => detail.ids.includes(item.original.id)) : [];
  const activeDetailItem = detailItems.find((item) => item.original.id === detailItemId) ?? detailItems[0];
  const pending = session.items.filter(needsReceiptReview).length;
  const excluded = session.items.filter(isReceiptExcluded).length;
  const suspectedCount = session.items.filter((item) => isSuspectedInvalid(item)
    && (sourceFilter === 'all' || item.original.source_key === sourceFilter)).length;
  const adjustableConfirmed = session.items.filter((item) => !needsReceiptReview(item) && !isReceiptExcluded(item)).length;
  const specialCount = session.items.filter((item) => item.page_notice).length;
  const pendingSpecialCount = session.items.filter((item) => item.page_notice && needsReceiptReview(item)
    && (sourceFilter === 'all' || item.original.source_key === sourceFilter)).length;
  const ordinaryCount = session.items.filter((item) => !item.page_notice && !isReceiptExcluded(item)
    && (sourceFilter === 'all' || item.original.source_key === sourceFilter)).length;
  const confirmable = selected.filter((item) => needsReceiptReview(item) && item.record?.review_status !== 'blocked');
  const confirmingOnlySpecial = confirmable.length > 0 && confirmable.every((item) => item.page_notice);
  const typeEditorItems = typeEditor?.contextKey === contextKey && typeEditor.scope === scope
    ? typeEditor.ids.map((id) => filtered.find((item) => item.original.id === id)).filter((item): item is ReceiptBatchReviewPageItem => Boolean(item)) : [];
  const excludable = selected.filter((item) => !isReceiptExcluded(item));
  const restorable = selected.filter(isReceiptExcluded);
  const allChecked = filtered.length > 0 && selected.length === filtered.length;
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = selected.length > 0 && !allChecked; }, [selected.length, allChecked]);
  useEffect(() => { anchor.current = null; setDetailId(null); setSelection(null); setTypeEditor(null); }, [scope, contextKey]);
  useEffect(() => { if (!active) { setDetailId(null); setSelection(null); setTypeEditor(null); } }, [active]);
  useEffect(() => { if (suspectedOnly && suspectedCount === 0) setSuspectedOnly(false); }, [suspectedOnly, suspectedCount]);
  useEffect(() => { if (detailId && !detail) setDetailId(null); }, [detailId, detail]);
  useEffect(() => {
    if (!requestedSegment || openedRequest.current === requestedSegment || !active
        || !session.items.some((item) => item.original.id === requestedSegment.id)) return;
    if (view !== 'receipts' || sourceFilter !== 'all' || typeFilter !== 'all' || suspectedOnly || state.reviewFilter !== 'all') {
      setView('receipts'); setSourceFilter('all'); setTypeFilter('all'); setSuspectedOnly(false);
      controller.setReviewFilter('all'); return;
    }
    if (!cardById.has(requestedSegment.id)) return;
    openedRequest.current = requestedSegment;
    setDetailId(requestedSegment.id); setDetailItemId(requestedSegment.id);
  }, [requestedSegment, scope, contextKey, active, session, controller]);
  useEffect(() => { if (state.reviewNotice && !state.error) { setSelection(null); setTypeEditor(null); } }, [state.reviewNotice, state.error]);
  useEffect(() => {
    if (!detailId) return;
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [detailId]);
  function closeDetail() {
    if (busy) return;
    setDetailId(null);
    setTypeEditor(null);
    requestAnimationFrame(() => {
      const card = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-card-id]') ?? [])
        .find((element) => element.dataset.cardId === returnFocusCard.current);
      card?.querySelector<HTMLButtonElement>('.pdf-thumbnail-open')?.focus({ preventScroll: true });
    });
  }
  function open(card: PdfThumbnailCard) {
    if (busy) return;
    if (!detail) returnFocusCard.current = card.id;
    const entry = cardById.get(card.id);
    if (!entry) return;
    setDetailId(card.id); setDetailItemId(entry.ids[0] ?? null);
    setTypeEditor(null);
    if (entry.ids[0]) controller.select(entry.ids[0]);
  }
  function toggle(id: string, value: boolean, extend: boolean) {
    if (busy) return;
    setTypeEditor(null);
    const index = cards.findIndex((card) => card.id === id);
    if (index < 0) return;
    const anchorIndex = anchor.current ? cards.findIndex((card) => card.id === anchor.current) : -1;
    const range = extend && anchorIndex >= 0 ? cards.slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1) : [cards[index]];
    const ids = new Set(checked);
    for (const card of range) for (const key of card.ids) { if (value) ids.add(key); else ids.delete(key); }
    anchor.current = id; setSelection({ session, scope, ids });
  }
  function update(items: ReceiptBatchReviewPageItem[], action: 'confirm' | 'exclude' | 'restore') {
    if (!busy && items.length) void controller.reviewSelection(items.map((item) => item.original.id), action);
  }
  function adjust(item: ReceiptBatchReviewPageItem) {
    if (busy || isReceiptExcluded(item)) return;
    controller.select(item.original.id); void controller.begin();
  }
  const sourceNames = new Map(session.prepared.binding.job.sources.map((source) => [source.source_key, source.name]));
  const showTypeEditor = (items: ReceiptBatchReviewPageItem[]) => setTypeEditor({ ids: items.map((item) => item.original.id), contextKey, scope });
  const typePanel = typeEditorItems.length > 0 && typeEditorItems.length === typeEditor?.ids.length
    ? <ReceiptDocumentTypePanel key={JSON.stringify(typeEditor)} items={typeEditorItems} busy={busy}
      onSave={(type, confirmed) => void controller.classifySelection(typeEditorItems.map((item) => item.original.id), type, confirmed)}
      onCancel={() => setTypeEditor(null)} /> : null;
  return <section className="receipt-overview" aria-label="回单检查总览">
    <header className="receipt-overview__heading">
      <div><h2>检查与处理</h2><p>全部 {session.items.length} 处<span>待复核 {pending} 处</span><span>已排除 {excluded} 处</span></p></div>
      <p className="receipt-overview__workflow" role="note">建议顺序：排除无效 → 核对特殊单证 → 必要时调整边界或模板 → 完成复核{primaryActionLabel === '进入交易对手分组' ? ' → 核对交易对手 → 检查并导出' : ' → 检查并导出'}</p>
      <div className="receipt-overview__heading-actions"><button type="button" disabled={busy} onClick={onBack}>返回分析</button>
        {canExport && <button type="button" className="primary" disabled={busy} onClick={onExport}>{primaryActionLabel}</button>}</div>
    </header>
    {state.error && <p className="receipt-overview__error" role="alert">{state.error}</p>}
    {state.reviewNotice && <p className="receipt-overview__notice" role="status">{state.reviewNotice}</p>}
    <div className="receipt-overview__tools">
      <button type="button" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>来源与类型</button>
      <div role="group" aria-label="总览方式">{(['receipts', 'pages'] as const).map((mode) => <button type="button" key={mode} aria-pressed={view === mode}
        disabled={busy} onClick={() => setView(mode)}>{mode === 'receipts' ? '片段总览' : '原页总览'}</button>)}</div>
      <div role="group" aria-label="片段状态筛选">{(['all', 'pending', 'excluded'] as const).map((filter) => <button type="button" key={filter}
        disabled={busy} aria-pressed={state.reviewFilter === filter}
        className={filter === 'pending' && pending > 0 ? 'receipt-overview__filter-attention' : undefined}
        onClick={() => { setSuspectedOnly(false); controller.setReviewFilter(filter); }}>
        {filter === 'all' ? '全部' : filter === 'pending' ? `待复核 ${pending}` : `已排除 ${excluded}`}</button>)}</div>
      {suspectedCount > 0 && <button type="button" className="receipt-overview__suspected-filter" disabled={busy}
        aria-pressed={suspectedOnly} onClick={() => {
          setSuspectedOnly(!suspectedOnly);
          if (!suspectedOnly) { setTypeFilter('all'); controller.setReviewFilter('pending'); }
        }}>疑似需排除 {suspectedCount}</button>}
      <ThumbnailSizeControl value={size} onChange={setSize} />
    </div>
    <div className={`receipt-overview__body${sidebarOpen ? '' : ' is-wide'}`}>
      {sidebarOpen && <aside className="receipt-overview__sources" aria-label="来源与凭证类型筛选">
        <label>凭证类型<select value={typeFilter} disabled={busy} onChange={(event) => setTypeFilter(event.currentTarget.value as DocumentType)}>
          <option value="all">全部类型</option><option value="ordinary">普通 / 未标记特殊</option><option value="special">全部特殊单证</option>
          {Object.entries(SPECIAL_DOCUMENT_LABELS).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select></label>
        {pendingSpecialCount > 0 && <button type="button" disabled={busy} onClick={() => {
          setSuspectedOnly(false); setTypeFilter('special'); controller.setReviewFilter('pending');
        }}>核对特殊单证 {pendingSpecialCount} 处</button>}
        {typeFilter === 'special' && pendingSpecialCount === 0 && <button type="button" disabled={busy} onClick={() => {
          setSuspectedOnly(false); setTypeFilter('ordinary'); controller.setReviewFilter('all');
        }}>处理普通回单</button>}
        {specialCount > 0 && <p>先核对特殊单证或排除无效片段，再处理普通回单，最后导出。类型已识别且边界完整时可直接确认；未识别的单证可选中后设置凭证类型。</p>}
        {onOpenTemplates && ordinaryCount > 0 && pendingSpecialCount === 0 && suspectedCount === 0 && <div className="receipt-overview__template-entry">
          <strong>普通回单版式</strong>
          <button type="button" disabled={busy} onClick={onOpenTemplates}>我的模板 · 预览应用</button>
          <p>预览将覆盖当前任务中所有兼容来源，不限于左侧筛选的 PDF；只替换已核对栏位边界，应用后仍须复核。</p>
        </div>}
        <strong>来源 PDF</strong><button type="button" disabled={busy} aria-pressed={sourceFilter === 'all'} onClick={() => { setSuspectedOnly(false); setSourceFilter('all'); }}>全部来源 <span>{session.items.length}</span></button>
        {session.prepared.binding.job.sources.map((source) => <button type="button" key={source.source_key} disabled={busy} aria-pressed={sourceFilter === source.source_key}
          title={source.name} onClick={() => { setSuspectedOnly(false); setSourceFilter(source.source_key); }}>{source.name}<small>{source.page_count} 页 · {session.items.filter((item) => item.original.source_key === source.source_key).length} 处</small></button>)}
      </aside>}
      <div className="receipt-overview__content">
        <div className="receipt-overview__selection-scope"><label><input ref={allRef} type="checkbox" checked={allChecked} disabled={busy || !filtered.length}
          onChange={(event) => { setTypeEditor(null); setSelection({ session, scope, ids: new Set(event.currentTarget.checked ? filtered.map((item) => item.original.id) : []) }); }} />
          全选当前筛选结果（{filtered.length} 处）</label><span>{suspectedOnly ? '仅为疑似无效建议；请查看缩略图或详情后再勾选排除' : view === 'pages' ? `${cards.length} 页 · 勾选页卡仅选择本页符合筛选的片段` : `${cards.length} 个片段 · 单选后可微调边界，多选后可批量处理`}</span>
          {state.reviewFilter === 'pending' && filtered.length === 0 && adjustableConfirmed > 0 && <button type="button"
            className="receipt-overview__empty-filter-action" disabled={busy} onClick={() => controller.setReviewFilter('all')}>切换到全部，继续调整已确认片段</button>}</div>
        <div className="receipt-overview__grid" ref={gridRef} hidden={Boolean(detail)}>
          <PdfThumbnailGrid cards={cards} size={size} shape={view === 'pages' ? 'page' : 'receipt'} selectedIds={selectedCards}
            focusedId={state.selectedId} onOpen={open} onToggle={toggle} disabled={busy} active={active && !detail} scrollKey={`${contextKey}:${scope}`}
            label={view === 'pages' ? '原页缩略图' : '片段查看与微调'} emptyMessage="当前筛选没有片段。" />
        </div>
        {detail && <div className="receipt-overview__detail" ref={dialogRef} role="dialog" aria-label="片段详情" onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); closeDetail(); }
        }}>
          <header><button type="button" disabled={busy} onClick={closeDetail}>返回总览</button><strong>{detail.sourceLabel} · {detail.label}</strong>
            <div>{[-1, 1].map((delta) => { const index = cards.findIndex((card) => card.id === detail.id) + delta; return <button type="button" key={delta}
              disabled={busy || index < 0 || index >= cards.length} onClick={() => open(cards[index])}>{delta < 0 ? '上一项' : '下一项'}</button>; })}</div></header>
          {renderPage(view === 'pages' && activeDetailItem ? { ...detail, rect: effectiveRect(activeDetailItem) } : detail)}
          <footer>
            {detailItems.length > 1 && <label>本页片段<select value={activeDetailItem?.original.id ?? ''} disabled={busy} onChange={(event) => {
              setTypeEditor(null); setDetailItemId(event.currentTarget.value); controller.select(event.currentTarget.value);
            }}>{detailItems.map((item) => <option key={item.original.id} value={item.original.id}>第 {item.original.position_index} 栏 · {receiptStatusLabel(item)}</option>)}</select></label>}
            {activeDetailItem ? <>
              <p>{activeDetailItem.page_notice ? `${SPECIAL_DOCUMENT_LABELS[activeDetailItem.page_notice.document_type]} · ` : '普通 / 未标记特殊 · '}{receiptStatusLabel(activeDetailItem)}
                {activeDetailItem.record?.review_status === 'blocked' ? '：需先处理边界或版式问题。' : needsReceiptReview(activeDetailItem) ? '：请检查抬头、正文、印章与底部是否完整。' : ''}</p>
              {activeDetailItem.page_notice && <p>确认只认可当前边界，不改变凭证类型。普通回单微调不会同步到此类型；调整本类单证时仍需核对实际版式范围。</p>}
              {!typePanel && <div>{needsReceiptReview(activeDetailItem) && activeDetailItem.record?.review_status !== 'blocked' && <button type="button" className="primary" disabled={busy} onClick={() => update([activeDetailItem], 'confirm')}>{activeDetailItem.page_notice ? '确认此特殊单证' : '确认此片段'}</button>}
                {isReceiptExcluded(activeDetailItem) ? <button type="button" disabled={busy} onClick={() => update([activeDetailItem], 'restore')}>恢复待复核</button>
                  : <><button type="button" disabled={busy} onClick={() => adjust(activeDetailItem)}>调整所选边界</button><button type="button" disabled={busy} onClick={() => showTypeEditor([activeDetailItem])}>设置凭证类型</button><button type="button" disabled={busy} onClick={() => update([activeDetailItem], 'exclude')}>排除此片段</button></>}</div>}
              {typePanel}
            </> : <p>此页没有符合当前筛选的候选片段。原页仅供查看。</p>}
          </footer>
        </div>}
        {!detail && typePanel}
        {selected.length > 0 && !detail && !typePanel && <footer className="receipt-overview__batch" aria-label="所选片段操作">
          <div><strong>已选 {selected.length} 处</strong><small>{new Set(selected.map((item) => item.original.source_key)).size} 份 PDF · {sourceFilter === 'all' ? '当前筛选范围' : sourceNames.get(sourceFilter)}</small></div>
          {confirmable.length > 0 && <button type="button" className="primary" disabled={busy} onClick={() => update(confirmable, 'confirm')}>{confirmingOnlySpecial ? '确认所选特殊单证' : '确认所选'} {confirmable.length} 处</button>}
          {excludable.length > 0 && <button type="button" disabled={busy} onClick={() => update(excludable, 'exclude')}>{suspectedOnly ? '排除所选疑似无效' : '排除所选'} {excludable.length} 处</button>}
          {restorable.length > 0 && <button type="button" disabled={busy} onClick={() => update(restorable, 'restore')}>恢复所选 {restorable.length} 处为待复核</button>}
          {selected.length === 1 && !isReceiptExcluded(selected[0]) && <button type="button" disabled={busy} onClick={() => adjust(selected[0])}>调整所选边界</button>}
          <button type="button" disabled={busy || selected.some(isReceiptExcluded)}
            onClick={() => showTypeEditor(selected)}>设置凭证类型</button>
          <button type="button" disabled={busy} onClick={() => setSelection(null)}>取消选择</button>
          {busy && <span role="status">正在保存并核实所选片段…</span>}
        </footer>}
      </div>
    </div>
  </section>;
}
