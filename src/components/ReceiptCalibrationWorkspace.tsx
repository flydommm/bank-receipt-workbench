import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { CropEditor } from './CropEditor';
import { localEngineAdapter, type EnginePagePreview } from './localEngineAdapter';
import { ReceiptLayoutEditor } from './ReceiptLayoutEditor';
import { ReceiptExportWorkspace, receiptExportContextKey } from './ReceiptExportWorkspace';
import { ReceiptPaneSplit } from './ReceiptPaneSplit';
import { ReceiptRiskReview } from './ReceiptRiskReview';
import { slotRect } from '../domain/receiptLayout';
import type { PdfRect } from '../domain/cropReview';
import { calibrationBusy, isReceiptExcluded, matchesReceiptFilter, needsReceiptReview, type ReceiptCalibrationController, type ReceiptCalibrationState } from '../services/receiptCalibrationController';
import { ReceiptOverview } from './ReceiptOverview';
import { ReceiptGroupingPanel } from './ReceiptGroupingPanel';
import { ReceiptGroupingPreview } from './ReceiptGroupingPreview';
import { ReceiptGroupingOverview } from './ReceiptGroupingOverview';
import type { ReceiptGroupingSnapshot } from '../domain/receiptGrouping';
import { exportReceiptGroupingDraft } from '../services/receiptGroupingDraftClient';
import { SPECIAL_DOCUMENT_LABELS, isSpecialDocumentType } from '../domain/receiptBatch';
import { ReceiptPagePreviewCache, receiptPageKey, SupersededReceiptPreview } from '../services/receiptPagePreviewCache';
import { canRetryTemplateSave, templateReferenceAllowed, templateSaveFailureMessage, type ReceiptLayoutTarget } from '../services/receiptLayoutClient';
import { layoutTemplateBankName, layoutTemplateName } from '../services/layoutTemplateClient';
import './ReceiptCalibrationWorkspace.css';

type Props = { state: ReceiptCalibrationState; controller: ReceiptCalibrationController };
type SlotGuide = { slotId: string; position: number; rect: PdfRect };
type PageProps = { path: string; sha: string; page: number; pageCount: number; width?: number; height?: number;
  rect: PdfRect | null; beforeRect?: PdfRect | null; editable?: boolean; guides?: SlotGuide[]; editableSlotIds?: readonly string[];
  selectedSlotId?: string | null; onSelectSlot?: (id: string) => void; onChange: (rect: PdfRect) => void };
const zero = { x0: 0, y0: 0, x1: 0, y1: 0 };
const mm = (pt: number) => (pt * 25.4 / 72).toFixed(1);
const excludedScopeReason = (reason: string) => ({
  different_workspace: '工作区不同', different_page_geometry: '页面尺寸或方向不同',
  unverified_layout: '尚未核实为同一版式', different_issuer: '出具银行不同',
  different_layout_family: '版式类型不同', different_slot_structure: '栏位结构不同',
  different_document_type: '单证类型不同，需分别调整',
  manual_classification_scope: '人工分类页面单独调整，与批量范围隔离',
  prior_review_scope: '该页已有人工审核或排除决定',
  special_document_scope: '该页含特殊单证，需单独处理',
  excluded_shared_geometry_scope: '此页已排除栏位与模板的公共页边距不兼容',
  excluded_geometry_conflict: '应用模板会影响此页已排除栏位的边界',
  no_confirmed_slot: '此页没有模板中已核对的栏位',
  template_incompatible: '此页与所选模板不兼容',
} as Record<string, string>)[reason] ?? '其他版式不兼容';
const rectStyle = (r: PdfRect, w: number, h: number): CSSProperties => ({ position: 'absolute',
  left: `${r.x0 / w * 100}%`, top: `${r.y0 / h * 100}%`, width: `${(r.x1 - r.x0) / w * 100}%`, height: `${(r.y1 - r.y0) / h * 100}%` });

/** Images are SHA-bound; never display a previous page while a new request is pending. */
export function ReceiptSourcePage({ path, sha, page, pageCount, width, height, rect, beforeRect, editable, guides, selectedSlotId, editableSlotIds, onSelectSlot, onChange }: PageProps) {
  const [loaded, setLoaded] = useState<{ key: string; value: EnginePagePreview } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0), [zoom, setZoom] = useState(100);
  const [fitPage, setFitPage] = useState(Boolean(editable));
  const [availableSize, setAvailableSize] = useState<{ width: number; height: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null), sheetRef = useRef<HTMLDivElement>(null);
  const key = receiptPageKey({ path, sha, page, pageCount, width, height, retry });
  const cache = useRef<ReceiptPagePreviewCache | null>(null);
  useEffect(() => {
    const previews = new ReceiptPagePreviewCache((request) => localEngineAdapter.renderPage(request.path, request.page, request.sha));
    cache.current = previews;
    return () => { previews.dispose(); if (cache.current === previews) cache.current = null; };
  }, []);
  useEffect(() => { if (editable) setFitPage(true); }, [editable]);
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const measure = () => {
      const styles = getComputedStyle(viewport);
      const padding = (value: string) => Number.parseFloat(value) || 0;
      const width = viewport.clientWidth - padding(styles.paddingLeft) - padding(styles.paddingRight);
      const height = viewport.clientHeight - padding(styles.paddingTop) - padding(styles.paddingBottom);
      // A hidden container or a layout-less test DOM has no useful measurements yet.
      const next = width > 0 && height > 0 ? { width, height } : null;
      setAvailableSize((previous) => previous?.width === next?.width && previous?.height === next?.height ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(viewport);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => {
    let current = true;
    setError(null);
    const request = cache.current!.load({ path, sha, page, pageCount, width, height, retry });
    void request.then((value) => {
      if (!current) return;
      setLoaded({ key, value });
    }).catch((cause: unknown) => { if (current && !(cause instanceof SupersededReceiptPreview)) setError({ key, message: cause instanceof Error ? cause.message : '页面预览失败，请重试。' }); });
    return () => { current = false; };
  }, [key, path, sha, page, pageCount, width, height, retry]);
  const image = loaded?.key === key ? loaded.value : null;
  const actualWidth = width ?? image?.page_width ?? 0, actualHeight = height ?? image?.page_height ?? 0;
  const fittedWidth = availableSize && actualWidth > 0 && actualHeight > 0
    ? Math.min(availableSize.width, availableSize.height * actualWidth / actualHeight) : null;
  const displayedZoom = fitPage && fittedWidth !== null && availableSize
    ? Math.max(1, Math.round(fittedWidth / availableSize.width * 100)) : zoom;
  const adjustZoom = (delta: number) => { setZoom(Math.max(25, Math.min(200, displayedZoom + delta))); setFitPage(false); };
  useEffect(() => {
    if (!editable || fitPage || !image) return;
    const viewport = scrollRef.current;
    const crop = sheetRef.current?.querySelector<HTMLElement>('[aria-label="裁剪区域"]');
    if (!viewport || !crop) return;
    const outer = viewport.getBoundingClientRect(), target = crop.getBoundingClientRect();
    if (outer.width <= 0 || outer.height <= 0 || target.width <= 0 || target.height <= 0) return;
    const inset = 16;
    if (target.top < outer.top + inset || target.height > outer.height - inset * 2) viewport.scrollTop += target.top - outer.top - inset;
    else if (target.bottom > outer.bottom - inset) viewport.scrollTop += target.bottom - outer.bottom + inset;
    if (target.left < outer.left + inset || target.width > outer.width - inset * 2) viewport.scrollLeft += target.left - outer.left - inset;
    else if (target.right > outer.right - inset) viewport.scrollLeft += target.right - outer.right + inset;
    // Deliberately exclude rect: dragging updates it each frame and must not move the viewport.
  }, [editable, selectedSlotId, image, fitPage, zoom]);
  return <section className="receipt-source-page" aria-label="真实 PDF 预览">
    <header><strong>真实 PDF 预览</strong><span>第 {page} / {pageCount} 页{actualWidth > 0 && actualHeight > 0 ? ` · ${mm(actualWidth)} × ${mm(actualHeight)} 毫米` : ''}</span>
      <div><button type="button" className="receipt-source-page__fit" aria-pressed={fitPage} onClick={() => { setFitPage(true); if (scrollRef.current) { scrollRef.current.scrollTop = 0; scrollRef.current.scrollLeft = 0; } }}>整页</button>
        <button type="button" aria-label="缩小回单预览" disabled={displayedZoom <= 25} onClick={() => adjustZoom(-25)}>−</button>
        <span>{displayedZoom}%</span><button type="button" aria-label="放大回单预览" disabled={displayedZoom >= 200} onClick={() => adjustZoom(25)}>+</button></div>
    </header>
    <div className="receipt-source-page__scroll" ref={scrollRef}>
      {error?.key === key ? <div role="alert">{error.message}<button type="button" onClick={() => setRetry((v) => v + 1)}>重试页面预览</button></div>
        : !image ? <p role="status">正在载入第 {page} 页…</p> :
          <div className={`receipt-source-page__sheet${fitPage ? ' is-fit' : ''}`} ref={sheetRef}
            style={{ width: fitPage && fittedWidth !== null ? `${fittedWidth}px` : `${zoom}%` }}>
            {editable && !editableSlotIds && rect ? <CropEditor key={selectedSlotId} imageData={image.image_data} pageWidth={image.page_width} pageHeight={image.page_height}
              value={rect} matchRect={zero} preserveDraftGeometry onChange={onChange} /> : <>
                <img src={image.image_data} alt={`原始 PDF 第 ${page} 页`} />
                {beforeRect && <span className="receipt-source-page__before" style={rectStyle(beforeRect, image.page_width, image.page_height)} aria-label="调整前边界" />}
                {rect && <span className="receipt-source-page__after" style={rectStyle(rect, image.page_width, image.page_height)} aria-label="本轮边界" />}
              </>}
            {guides?.map((guide) => <button type="button" key={guide.slotId} className="receipt-source-page__guide"
              disabled={editableSlotIds !== undefined && !editableSlotIds.includes(guide.slotId)}
              style={rectStyle(guide.rect, image.page_width, image.page_height)} aria-label={`选择第 ${guide.position} 栏边界`}
              onClick={() => onSelectSlot?.(guide.slotId)}><span>第 {guide.position} 栏</span></button>)}
          </div>}
    </div>
  </section>;
}

const diagnosticMessage = (value: Record<string, unknown>) => {
  if (value.code === 'special_document') {
    const type = value.document_type;
    const label = isSpecialDocumentType(type) ? SPECIAL_DOCUMENT_LABELS[type] : '特殊单证';
    return `${label}，请核对整张凭证是否完整`;
  }
  const codes: Record<string, string> = {
    manual_classification_membership: '调整后该人工分类片段不再命中，请保留完整内容；不需要导出时请排除片段。',
    historical_layout_applied: '已参考版式模板边界，请核对当前回单是否完整',
    historical_template_ambiguous: '有多套适用模板，请选择模板后重新分析',
    unassigned_block: '有内容未归入任何栏位', ambiguous_block: '有内容的栏位归属不明确',
    cross_boundary_block: '有内容跨越栏位边界', low_confidence_exclude: '有内容被低置信度排除',
    manual_exception_conflict: '本轮与此前单独调整或保留整页的决定冲突',
    excluded_template_protection: '应用模板可能改变已排除片段的边界或命中证据，本轮已阻止保存；请单独核对该页。',
    template_content_outside_crop: '模板边界会裁掉本页回单的标题、标志或表格正文，已阻止应用；请微调边界后另存模板。',
    reference_layout_conflict: '保存的模板与当前页面内容不完全匹配，已保留自动识别边界，请核对后再应用模板。',
    content_outside_slot: '有内容在裁剪框外', content_crosses_boundary: '有内容跨越裁剪边界',
  };
  return codes[String(value.code ?? value.kind)] ?? '此页存在需要检查的版式内容';
};

export function ReceiptCalibrationPane({ state, controller, onExport, onBack, onOpenTemplates, onRemoveSources, initialOutputDirectory, onExportSuccess, onWorkflowStepChange, groupingEnabled = false }: Props & {
  onExport: () => void; onBack: () => void; onRemoveSources?: () => void;
  onOpenTemplates?: () => void;
  initialOutputDirectory?: string | null; onExportSuccess?: (directory: string) => void;
  onWorkflowStepChange?: (step: 2 | 3) => void;
  groupingEnabled?: boolean;
}) {
  const [exportContext, setExportContext] = useState<string | null>(null);
  const [groupingState, setGroupingState] = useState<{ reviewKey: string; snapshot: ReceiptGroupingSnapshot } | null>(null);
  const [enteredBatch, setEnteredBatch] = useState<string | null>(null);
  const [groupingEntry, setGroupingEntry] = useState<string | null>(null);
  const [groupingBusy, setGroupingBusy] = useState(false);
  const [groupingFocus, setGroupingFocus] = useState<{ id: string; sequence: number } | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [confirmClearSources, setConfirmClearSources] = useState(false);
  const { session, phase, preparation, draft, preview, operation } = state;
  const reviewKey = session ? receiptExportContextKey(session.prepared, session.items) : '';
  const batchKey = session ? JSON.stringify([session.prepared.binding.job.id, session.prepared.binding.job.result_revision, session.prepared.binding.contextKey,
    session.prepared.prepared?.context_key, session.prepared.prepared?.result_revision]) : '';
  const grouping = groupingEnabled && enteredBatch === batchKey && groupingState?.reviewKey === reviewKey ? groupingState.snapshot : null;
  const receiveGrouping = useCallback((snapshot: ReceiptGroupingSnapshot | null) => {
    setGroupingState(snapshot ? { reviewKey, snapshot } : null);
  }, [reviewKey]);
  useEffect(() => { setGroupingEntry(null); setGroupingFocus(null); setDraftNotice(null); }, [reviewKey, groupingEnabled]);
  useEffect(() => { setEnteredBatch(null); setGroupingState(null); setGroupingBusy(false); }, [batchKey, groupingEnabled]);
  const unresolved = session?.items.filter(needsReceiptReview).length ?? 0;
  const retainedCount = session?.items.filter((item) => !isReceiptExcluded(item)).length ?? 0;
  const exportKey = session ? receiptExportContextKey(session.prepared, session.items, grouping) : null;
  const groupingReady = !groupingEnabled || Boolean(grouping && grouping.header.counts.own_pending === 0
    && grouping.header.counts.extraction_pending === 0 && grouping.header.counts.stale === 0);
  const canEnterGrouping = retainedCount > 0 && unresolved === 0 && phase === 'results' && !state.reviewConfirming;
  const canExport = canEnterGrouping && groupingReady && (!groupingEnabled || !groupingBusy);
  useEffect(() => {
    if (!canExport || exportContext !== exportKey) setExportContext(null);
  }, [canExport, exportContext, exportKey]);
  const exporting = Boolean(session && canExport && exportContext !== null && exportContext === exportKey);
  const showingGrouping = groupingEnabled && enteredBatch === batchKey && groupingEntry === reviewKey && canEnterGrouping && !exporting;
  useEffect(() => { if (!showingGrouping) setConfirmClearSources(false); }, [showingGrouping]);
  const startExport = () => { if (canExport) { setExportContext(exportKey); onExport(); } };
  useEffect(() => { onWorkflowStepChange?.(exporting ? 3 : 2); }, [exporting, onWorkflowStepChange]);
  if (!session) return <p role="status">正在载入审核工作区…</p>;
  const sample = session.items.find((item) => item.original.id === state.selectedId);
  const undoing = state.writeAction === 'undo';
  const inPreview = !undoing && ['preview', 'saving', 'uncertain'].includes(phase);
  const target = inPreview ? preview?.affected[state.previewIndex] : null;
  const sourceKey = target?.source_key ?? sample?.original.source_key;
  const source = session.prepared.binding.job.sources.find((item) => item.source_key === sourceKey);
  const original = target ? session.items.find((item) => item.original.source_key === target.source_key && item.original.source_page === target.page)?.original : sample?.original;
  const geometry = original?.page_geometry ?? draft?.page_geometry ?? preview?.layout_definition.page_geometry;
  const selectedSlotId = state.selectedSlotId ?? preparation?.selected_slot_id;
  const selectedSlot = draft?.slots.find((slot) => slot.slot_id === selectedSlotId);
  const editable = phase === 'editing';
  const fullPage = geometry ? { x0: 0, y0: 0, x1: geometry.width_pt, y1: geometry.height_pt } : null;
  const rect = target ? target.after_rect : editable && draft && selectedSlot ? slotRect(draft, selectedSlot)
    : sample?.record ? sample.record.final_rect ?? fullPage : sample?.original.candidate_rect ?? null;
  const busy = calibrationBusy(phase);
  const scopedPages = new Set(preparation?.pages.map((page) => JSON.stringify([page.source_key, page.page])));
  const scopedHits = session.items.filter((item) => scopedPages.has(JSON.stringify([item.original.source_key, item.original.source_page]))
    && (!preparation?.editable_slot_ids || preparation.editable_slot_ids.includes(item.original.slot_id))).length;
  const reviewedSlotIds = new Set(preview?.affected.filter((item) => (item.status === 'updated' || item.status === 'added')
    && item.after_rect !== null).map((item) => item.slot_id));
  const applyingTemplate = preview?.mode === 'template_apply';
  const reviewedSlotPositions = preview?.layout_definition.slots.filter((slot) => reviewedSlotIds.has(slot.slot_id))
    .map((slot) => slot.position_index) ?? [];
  const pendingSlotPositions = preview?.layout_definition.slots.filter((slot) => !reviewedSlotIds.has(slot.slot_id))
    .map((slot) => slot.position_index) ?? [];
  const pagePreview = source && geometry ? <ReceiptSourcePage path={source.access_path} sha={source.sha256!} page={target?.page ?? original!.source_page}
      pageCount={source.page_count!} width={geometry.width_pt} height={geometry.height_pt} rect={rect}
      beforeRect={target?.before_rect} editable={editable} selectedSlotId={selectedSlotId}
      editableSlotIds={preparation?.editable_slot_ids}
      guides={editable && draft ? draft.slots.filter((slot) => slot.slot_id !== selectedSlotId).map((slot) => ({ slotId: slot.slot_id, position: slot.position_index, rect: slotRect(draft, slot) })) : undefined}
      onSelectSlot={(id) => controller.selectSlot(id)}
      onChange={(next) => controller.changeRect(next)} /> : <p>选择一个候选以查看原始页面。</p>;
  const controls = <div className="receipt-calibration-pane__controls">
      {state.error && <p className="receipt-calibration-error" role="alert">{state.error}</p>}
      {phase === 'preparing' && <><h2>{!preparation && !draft ? '正在核对版式模板' : '正在准备当前版式'}</h2><p>核对来源、尺寸与栏位；完成后会显示可应用范围。</p><button type="button" onClick={() => void controller.leave()}>取消准备</button></>}
      {phase === 'previewing' && !draft && <><h2>正在生成模板应用预览</h2><p role="status">正在核对可应用的普通回单及已有人工决定…</p></>}
      {['editing', 'previewing'].includes(phase) && draft && preparation && <>
        {preparation.editable_slot_ids && <p>此页包含人工分类，仅调整当前片段。请通过距页顶和高度微调；其他栏位、统一高度与公共左右边距已锁定，本轮不保存为复用模板。</p>}
        <details className="receipt-calibration-scope-details"><summary>本轮版式范围：{preparation.source_count} 份 PDF · {preparation.page_count} 页 · 现有命中 {scopedHits} 处</summary>
          <p>{preparation.editable_slot_ids ? '仅当前页的所选片段，其他片段边界保持不变。' : `${preparation.scope_kind === 'verified_layout' ? '同出具银行、同实际版式的页面' : '当前 PDF 中与样本版式一致的页面'}，包括其中未命中关键词的页；预览会按当前关键词重新计算各栏结果。`}</p>
          {session.items.length > scopedHits && <p>另有 {session.items.length - scopedHits} 处命中不在本轮范围内，需从对应版式样本调整。</p>}
          {Object.entries(preparation.excluded_page_counts).map(([reason, count]) => <p key={reason}>{excludedScopeReason(reason)}：{count} 页未纳入</p>)}
        </details>
        <ReceiptLayoutEditor layout={draft} baselineLayout={preparation.layout_definition} scopePageCount={preparation.page_count}
          selectedSlotId={selectedSlotId} onSelectSlot={(id) => controller.selectSlot(id)}
          editableSlotIds={preparation.editable_slot_ids}
          dirty={JSON.stringify(draft) !== JSON.stringify(preparation.layout_definition)} busy={busy}
          onChange={(value: import('../domain/receiptLayout').LayoutDefinition) => controller.change(value)} onPreview={() => void controller.generatePreview()} onCancel={() => void controller.leave()} />
      </>}
      {phase === 'preview' && preview && <div className="receipt-calibration-round">
        <div className="receipt-calibration-round__body">
        <header className="receipt-calibration-round__heading"><h2>{applyingTemplate ? '预览模板应用范围' : '检查本轮片段变化'}：{preview.affected.length} 处</h2>
          <details><summary>变化说明</summary>
            <p>绿框为本轮结果，灰色虚线为调整前边界；右侧可逐项预览。</p>
            {applyingTemplate ? <><p>仅替换模板中已核对的第 {preview.applied_slot_ids?.map((id) => preview.layout_definition.slots.find((slot) => slot.slot_id === id)?.position_index).filter((v): v is number => v !== undefined).join('、') || '—'} 栏边界；未核对栏位保留原框，已有排除决定保持不变。保存后，本轮受影响的普通片段进入待复核，需要逐项确认。</p>
              {Object.entries(preview.excluded_page_counts ?? {}).map(([reason, count]) => <p key={reason}>{excludedScopeReason(reason)}：{count} 页未应用模板。</p>)}</>
              : <><p>{preview.affected.filter((item) => item.status === 'added').length} 处新增 · {preview.affected.filter((item) => item.status === 'removed').length} 处移出 · {preview.retained_record_ids.length} 处保留原有单独决定</p>
                {preview.retained_record_ids.length > 0 && <button type="button" onClick={() => void controller.revise(true)}>纳入原有单独决定 {preview.retained_record_ids.length} 处并返回调整</button>}</>}
          </details>
        </header>
        {applyingTemplate && <p className="receipt-calibration-round__scope" role="status">当前任务所有兼容来源中，可应用 {preview.page_count} 页{preview.preserved_excluded_count ? `，保留 ${preview.preserved_excluded_count} 处已排除片段` : ''}；另有 {Object.values(preview.excluded_page_counts ?? {}).reduce((sum, count) => sum + count, 0)} 页未应用，请查看变化说明并单独处理。</p>}
        {preview.blockers.length > 0 && <div role="alert"><p>以下问题仍需处理，本轮不能保存：</p><ul>{preview.blockers.map((blocker, index) => <li key={index}>{diagnosticMessage(blocker)}</li>)}</ul></div>}
        {preview.risks.length > 0 && <ReceiptRiskReview key={preview.preview_fingerprint} risks={preview.risks} affected={preview.affected}
          sources={session.prepared.binding.job.sources.map((item) => ({ source_key: item.source_key, label: item.name }))}
          layoutDefinition={preview.layout_definition} acknowledgedRiskIds={state.acknowledgedRiskIds}
          onAcknowledgeMany={(ids, checked) => controller.acknowledgeMany(ids, checked)} />}
        {!applyingTemplate && <section className="receipt-template-save" aria-label="模板保存">
        {templateReferenceAllowed(preview) && <p className="receipt-template-save__coverage">同银行、同凭证类型、同版式的多栏可共用一套模板。本轮可写入 {reviewedSlotPositions.length}/{preview.layout_definition.slots.length} 栏
          {reviewedSlotPositions.length > 0 ? `（第 ${reviewedSlotPositions.join('、')} 栏）` : ''}。
          {pendingSlotPositions.length > 0
            ? `第 ${pendingSlotPositions.join('、')} 栏尚未核对：可返回调整一并处理，或稍后逐栏核对并更新模板。仅浏览不算核对。`
            : '所有栏位均已纳入本轮。'}风险核对组数不等于模板栏数。</p>}
        <label className="receipt-calibration-reference"><input type="checkbox" checked={state.rememberReference}
          disabled={!templateReferenceAllowed(preview)}
          onChange={(e) => controller.setRememberReference(e.currentTarget.checked)} /> 保存为版式模板</label>
        {!templateReferenceAllowed(preview) && <p>{preparation?.editable_slot_ids
          ? '此页含人工分类，本轮边界仅用于当前页面，暂不保存为复用模板。'
          : '尚未识别此回单的复用版式，可先保存本次调整。'}</p>}
        {state.rememberReference && <>
          <fieldset><legend>模板保存方式</legend>
            <label><input type="radio" name="template-save-mode" checked={state.templateSaveMode === 'create'}
              aria-label="新建一套模板" aria-describedby="receipt-template-create-hint" onChange={() => void controller.setTemplateSaveMode('create')} /> 新建一套模板<span id="receipt-template-create-hint" className="receipt-template-save__hint">（保留同银行已有模板）</span></label>
            <label><input type="radio" name="template-save-mode" checked={state.templateSaveMode === 'update'}
              aria-label="更新已有模板" aria-describedby="receipt-template-update-hint" onChange={() => void controller.setTemplateSaveMode('update')} /> 更新已有模板<span id="receipt-template-update-hint" className="receipt-template-save__hint">（只改所选模板的本轮栏位，其他栏位和模板保留）</span></label>
          </fieldset>
          {state.templateSaveMode === 'update' && <>
            {state.templateCandidatesStatus === 'idle' && <button type="button" onClick={() => void controller.loadTemplateCandidates()}>载入兼容模板</button>}
            {state.templateCandidatesStatus === 'loading' && <p role="status">正在载入兼容模板…</p>}
            {state.templateCandidatesStatus === 'error' && <div><p role="alert">{state.templateCandidatesError}</p>
              <button type="button" onClick={() => void controller.loadTemplateCandidates()}>重试载入兼容模板</button></div>}
            {state.templateCandidatesStatus === 'ready' && (state.templateCandidates.length > 0
              ? <label className="receipt-calibration-reference">要更新的模板<select value={state.templateId ?? ''}
                onChange={(e) => controller.selectTemplate(e.currentTarget.value)}>
                <option value="">请选择要更新的模板</option>
                {state.templateCandidates.map((template) => <option key={template.id} value={template.id}>
                  {layoutTemplateBankName(template)} · {layoutTemplateName(template)} · v{template.version}
                </option>)}
              </select></label>
              : <p>暂无与本轮版式兼容的可用模板。可选择“新建一套模板”。</p>)}
          </>}
          <label className="receipt-calibration-reference receipt-template-save__bank">银行名称（选填）<span id="receipt-template-bank-hint" className="receipt-template-save__hint">（用于查找；是否适用仍以版式为准）</span>
            <input type="text" aria-label="银行名称（选填）" aria-describedby="receipt-template-bank-hint" value={state.templateBankName} maxLength={80} onChange={(e) => controller.setTemplateBankName(e.currentTarget.value)} />
          </label>
          <label className="receipt-calibration-reference">模板名称
            <input type="text" value={state.templateName} maxLength={256} onChange={(e) => controller.setTemplateName(e.currentTarget.value)} />
          </label>
        </>}
        </section>}
        </div>
        <footer className="receipt-calibration-round__footer">
        <div className="receipt-calibration-actions"><button type="button" className="primary" onClick={() => void controller.save()}
          disabled={!preview.can_save || preview.risks.some((risk) => !state.acknowledgedRiskIds.includes(risk.risk_id))
            || state.rememberReference && (!state.templateName.trim() || state.templateName.trim().length > 256 || state.templateName.includes('\0')
              || state.templateBankName.trim().length > 80 || state.templateBankName.includes('\0')
              || state.templateSaveMode === 'update' && (state.templateCandidatesStatus !== 'ready' || !state.templateId))}>{applyingTemplate ? `应用模板并复核 ${preview.affected.length} 处` : `保存本轮 ${preview.affected.length} 处`}</button>
          {!applyingTemplate && <button type="button" onClick={() => void controller.revise()}>返回调整</button>}<button type="button" onClick={() => void controller.leave()}>{applyingTemplate ? '取消应用' : '取消本轮'}</button></div>
        </footer>
      </div>}
      {phase === 'saving' && <><h2>{undoing ? '正在撤销本轮' : applyingTemplate ? '正在应用版式模板' : '正在保存本轮'}</h2><p role="status">{undoing ? '正在核实撤销与恢复结果，请稍候…' : '正在核实保存与审核结果，请稍候…'}</p></>}
      {phase === 'uncertain' && <><h2>{undoing ? '核实本轮撤销结果' : '核实本轮保存结果'}</h2>
        <p>{undoing ? '本轮撤销尚未核实。将继续核实同一笔撤销，并重新载入结果。' : '本轮可能已写入。核实后将读取同一笔保存结果，不会重复创建一轮。'}</p>
        <button type="button" className="primary" onClick={() => void controller.recover()}>{undoing ? '核实并完成撤销' : '核实并完成保存'}</button></>}
      {phase === 'saved' && <><h2>{undoing ? '本轮已撤销' : '本轮已保存'}</h2>
        <p role="status">{undoing ? '已恢复本轮调整前的边界和复核状态。' : applyingTemplate ? `${operation?.saved_count ?? 0} 处已应用模板并进入待复核，请逐项检查后确认。` : `${operation?.saved_count ?? 0} 处已保存。右侧已载入最新结果，可选择下一位置继续。`}</p>
        {!undoing && operation?.reference_state === 'saved' && <p role="status">版式模板“{operation.template_name ?? state.templateName.trim()}”已保存{operation.template_version ? `（版本 ${operation.template_version}）` : ''}，将供同版式新文件参考。</p>}
        {!undoing && !applyingTemplate && (!state.rememberReference || operation?.reference_state === 'disabled') && <p>本轮未保存为版式模板。</p>}
        {!undoing && operation?.reference_state === 'failed' && <div><p className="receipt-calibration-error" role="alert">{templateSaveFailureMessage(operation)}</p>
          {canRetryTemplateSave(operation) && <button type="button" onClick={() => void controller.retryTemplateSave()}>重试保存模板</button>}</div>}
        <div className="receipt-calibration-actions">{!applyingTemplate && <button type="button" onClick={() => void controller.begin()} disabled={!sample}>开始所选位置微调</button>}
          <button type="button" onClick={() => void controller.undo()} disabled={!operation || undoing}>撤销本轮</button>
          <button type="button" className="primary" onClick={() => void controller.leave()}>{applyingTemplate ? '查看待复核片段' : '完成微调，返回结果'}</button></div></>}
    </div>;
  return <section className="receipt-calibration-pane panel" data-phase={phase} data-grouping={showingGrouping || undefined} aria-label="回单版式与预览">
    <div className="receipt-calibration-overview" hidden={phase !== 'results' || exporting || showingGrouping}>
      <ReceiptOverview state={state} controller={controller} canExport={groupingEnabled ? canEnterGrouping : canExport}
        primaryActionLabel={groupingEnabled ? '进入交易对手分组' : '导出回单'}
        active={phase === 'results' && !exporting && !showingGrouping} requestedSegment={groupingFocus}
        onBack={onBack} onOpenTemplates={onOpenTemplates}
        onExport={groupingEnabled ? () => { if (canEnterGrouping) { setEnteredBatch(batchKey); setGroupingEntry(reviewKey); } } : startExport}
        renderPage={(card) => <ReceiptSourcePage path={card.path} sha={card.sha} page={card.page} pageCount={card.pageCount}
          width={card.width} height={card.height} rect={card.rect ?? null} onChange={() => undefined} />} />
    </div>
    {groupingEnabled && enteredBatch === batchKey && <div className="receipt-calibration-grouping" hidden={!showingGrouping}>
      {confirmClearSources && <div className="receipt-calibration-clear-sources" role="alert">
        <span>清除本次来源并返回导入页面？原始 PDF、已导出的文件和已保存模板都会保留。</span>
        <button type="button" disabled={groupingBusy} onClick={() => setConfirmClearSources(false)}>取消清除</button>
        <button type="button" disabled={groupingBusy} onClick={() => {
          if (!groupingBusy) { setConfirmClearSources(false); onRemoveSources?.(); }
        }}>确认清除来源</button>
      </div>}
      <ReceiptGroupingPanel key={batchKey} jobId={session.prepared.binding.job.id}
        resultRevision={session.prepared.prepared?.result_revision ?? session.prepared.binding.job.result_revision!}
        reviewItems={session.items} onSnapshotChange={receiveGrouping}
        active={showingGrouping} autoExtract onBusyChange={setGroupingBusy} initialOutputDirectory={initialOutputDirectory}
        onBack={() => { if (!groupingBusy) setGroupingEntry(null); }} onExport={startExport} canExport={canExport}
        onBackToAnalysis={() => { if (!groupingBusy) onBack(); }}
        onRemoveSources={onRemoveSources ? () => {
          if (!groupingBusy) setConfirmClearSources(true);
        } : undefined}
        disabled={phase !== 'results' || exporting || state.reviewConfirming}
        onSelectSegment={(id) => {
          if (groupingBusy) return;
          setGroupingEntry(null); controller.select(id);
          setGroupingFocus((previous) => ({ id, sequence: (previous?.sequence ?? 0) + 1 }));
        }}
        renderPreview={(id, { controls, fieldSelection }) => {
          const item = session.items.find((entry) => entry.original.id === id) ?? null;
          const itemSource = session.prepared.binding.job.sources.find((entry) => entry.source_key === item?.original.source_key) ?? null;
          return <ReceiptGroupingPreview reviewItem={item} source={itemSource} active={showingGrouping} contextKey={batchKey} controls={controls} fieldSelection={fieldSelection} />;
        }}
        renderOverview={(context) => <ReceiptGroupingOverview session={session} {...context} />}
        onExportDraft={async (snapshot) => {
          setDraftNotice(null);
          const directory = await localEngineAdapter.pickOutputFolder(initialOutputDirectory);
          if (!directory) return;
          const receipt = await exportReceiptGroupingDraft(snapshot.header, directory);
          setDraftNotice(`核对草稿已保存：${receipt.path}。修改请在工作台完成后重新导出。`);
          onExportSuccess?.(directory);
        }} />
      {draftNotice && <p role="status">{draftNotice}</p>}
    </div>}
    {exporting ? <ReceiptExportWorkspace key={exportContext} prepared={session.prepared} items={session.items} onClose={() => setExportContext(null)}
      grouping={grouping}
      onRemoveSources={onRemoveSources} initialOutputDirectory={initialOutputDirectory} onExportSuccess={onExportSuccess} />
      : phase !== 'results' && <ReceiptPaneSplit preview={pagePreview} controls={controls} resizable={['editing', 'previewing', 'preview', 'saving', 'uncertain'].includes(phase)} />}
  </section>;
}

const targetLabel: Record<ReceiptLayoutTarget['status'], string> = { updated: '本轮调整', added: '新命中', removed: '移出本次结果', retained_manual: '保留原有决定' };
export function ReceiptCalibrationNavigator({ state, controller }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [state.selectedId, state.previewIndex, state.reviewFilter]);
  const { session, preview, phase } = state;
  if (!session) return null;
  const previewMode = state.writeAction !== 'undo' && ['preview', 'saving', 'uncertain'].includes(phase) && preview;
  const locked = state.reviewConfirming || !['results', 'saved', 'preview'].includes(phase);
  const rows = previewMode ? preview.affected.map((item, index) => ({ key: `${item.source_key}:${item.page}:${item.slot_id}`, source: item.source_key,
    page: item.page, slot: preview.layout_definition.slots.find((slot) => slot.slot_id === item.slot_id)?.position_index,
    documentLabel: null,
    selected: state.previewIndex === index, status: targetLabel[item.status], select: () => controller.selectPreview(index) }))
    : session.items.filter((item) => matchesReceiptFilter(item, state.reviewFilter)).map((item) => ({ key: item.original.id, source: item.original.source_key, page: item.original.source_page,
      slot: item.original.position_index, selected: state.selectedId === item.original.id,
      documentLabel: item.page_notice ? SPECIAL_DOCUMENT_LABELS[item.page_notice.document_type] : null,
      status: item.record?.review_status === 'excluded' ? '已排除' : item.record ? ['confirmed', 'page_confirmed'].includes(item.record.review_status) ? '已确认' : '待复核' : item.original.needs_review ? '待复核' : '自动候选',
      select: () => controller.select(item.original.id) }));
  return <aside className="receipt-calibration-navigator panel" aria-label={previewMode ? '本轮全部片段' : '全部回单候选'}>
    <header><h2>{previewMode ? '本轮预览' : '回单候选'}</h2>
      {!previewMode && <div className="receipt-review-filters" role="group" aria-label="候选筛选">
        <button type="button" disabled={locked} aria-pressed={state.reviewFilter === 'all'} onClick={() => controller.setReviewFilter('all')}>全部 {session.items.length}</button>
        <button type="button" disabled={locked} aria-pressed={state.reviewFilter === 'pending'} onClick={() => controller.setReviewFilter('pending')}>待复核 {session.items.filter(needsReceiptReview).length}</button>
      </div>}{!previewMode && state.reviewFilter === 'special' && <p>特殊单证，可分别调整边界</p>}{previewMode && <p>{rows.length} 处</p>}</header>
    <div ref={listRef} className="receipt-calibration-navigator__list" aria-label="候选列表" tabIndex={rows.length ? -1 : 0} onKeyDown={(event) => {
      if (locked || event.altKey || event.ctrlKey || event.metaKey || !rows.length) return;
      const index = rows.findIndex((row) => row.selected);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
        : ['ArrowDown', 'ArrowRight'].includes(event.key) ? Math.min(rows.length - 1, Math.max(0, index + 1))
        : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? Math.max(0, index - 1) : null;
      if (next === null) return;
      event.preventDefault(); rows[next].select();
      listRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus({ preventScroll: true });
    }}>{rows.map((row, index) => <button type="button" key={row.key} onClick={row.select}
      tabIndex={row.selected || !rows.some((entry) => entry.selected) && index === 0 ? 0 : -1}
      disabled={locked} aria-pressed={row.selected} className={row.selected ? 'is-selected' : ''}>
      <small title={session.prepared.binding.job.sources.find((source) => source.source_key === row.source)?.name}>{session.prepared.binding.job.sources.find((source) => source.source_key === row.source)?.name ?? '来源 PDF'}</small>
      <strong>第 {row.page} 页 · 第 {row.slot ?? '—'} 栏</strong>{row.documentLabel && <span>{row.documentLabel}</span>}<span>{row.status}</span>
    </button>)}{!rows.length && <p>{state.reviewFilter === 'special' ? '没有特殊单证。' : '没有待复核的片段。'}</p>}</div>
  </aside>;
}
