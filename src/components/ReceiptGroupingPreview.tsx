import { useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';

import type { BatchSourceSnapshot } from '../domain/batchTask';
import type { PdfRect } from '../domain/cropReview';
import type { ReceiptBatchReviewPageItem } from '../domain/receiptBatch';
import { ReceiptPagePreviewCache, SupersededReceiptPreview, receiptPageKey } from '../services/receiptPagePreviewCache';
import { localEngineAdapter, type EnginePagePreview } from './localEngineAdapter';
import './ReceiptGroupingPreview.css';
import { clientPointInSvg, fieldRegionLabel, normalizeFieldSelection, type FieldSelectionContext, type NormalizedFieldRect } from '../domain/receiptFieldRules';

export type ReceiptGroupingPreviewProps = {
  reviewItem: ReceiptBatchReviewPageItem | null;
  source: BatchSourceSnapshot | null;
  active?: boolean;
  contextKey: string;
  controls?: ReactNode;
  fieldSelection?: FieldSelectionContext;
};

type PreviewRequest = {
  path: string;
  sha: string;
  page: number;
  pageCount: number;
  width: number;
  height: number;
  retry: number;
};

type PreviewBinding = {
  request: PreviewRequest;
  pageRect: PdfRect;
  displayRect: PdfRect;
  item: ReceiptBatchReviewPageItem;
  source: BatchSourceSnapshot;
};

const SHA256 = /^[a-f0-9]{64}$/i;
const MIN_ZOOM = 50;
const MAX_ZOOM = 300;
const ZOOM_STEP = 25;

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validRect(value: unknown, width: number, height: number): value is PdfRect {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Partial<PdfRect>;
  return [rect.x0, rect.y0, rect.x1, rect.y1].every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    && rect.x0! >= 0 && rect.y0! >= 0 && rect.x1! > rect.x0! && rect.y1! > rect.y0!
    && rect.x1! <= width && rect.y1! <= height;
}

function fullPageRect(width: number, height: number): PdfRect {
  return { x0: 0, y0: 0, x1: width, y1: height };
}

function effectiveRect(item: ReceiptBatchReviewPageItem, width: number, height: number): PdfRect {
  return item.record ? (item.record.final_rect ?? fullPageRect(width, height)) : item.original.candidate_rect;
}

function rectLabel(rect: PdfRect, page: PdfRect): string {
  if (rect.x0 === page.x0 && rect.y0 === page.y0 && rect.x1 === page.x1 && rect.y1 === page.y1) return '整页';
  return '已审核片段';
}

function sourceName(source: BatchSourceSnapshot): string {
  return source.name || source.access_path.replace(/\\/g, '/').split('/').pop() || '来源 PDF';
}

function bindingError(item: ReceiptBatchReviewPageItem | null, source: BatchSourceSnapshot | null): string | null {
  if (!item) return '请选择一个片段后查看原件。';
  if (!source) return '未找到当前片段对应的来源 PDF。';
  if (item.original.source_key !== source.source_key) return '来源 PDF 与审核片段不一致，请返回分割审核。';
  if (!source.access_path.trim() || !SHA256.test(source.sha256 ?? '')) return '来源 PDF 尚未完成 SHA-256 核验。';
  const pageCount = source.page_count;
  if (pageCount === null || !Number.isSafeInteger(pageCount) || pageCount < 1) return '来源 PDF 页数无效，请重新载入结果。';
  const page = item.original.source_page;
  if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) return '当前片段页码超出来源 PDF 范围。';
  const geometry = item.original.page_geometry;
  if (!isPositive(geometry.width_pt) || !isPositive(geometry.height_pt)) return '当前片段页面尺寸无效，不能预览。';
  const record = item.record;
  // access_path may be a verified relocation; the historical record path need
  // not be the current location of the same SHA-bound original.
  if (record && record.source_sha256.toLowerCase() !== source.sha256!.toLowerCase()) {
    return '审核记录与来源 PDF 的 SHA-256 不一致，请返回分割审核。';
  }
  const rect = effectiveRect(item, geometry.width_pt, geometry.height_pt);
  if (!validRect(rect, geometry.width_pt, geometry.height_pt)) return '当前片段边界无效，不能预览。';
  return null;
}

function buildBinding(item: ReceiptBatchReviewPageItem | null, source: BatchSourceSnapshot | null, retry: number): PreviewBinding | null {
  if (!item || !source || bindingError(item, source)) return null;
  const geometry = item.original.page_geometry;
  const pageRect = fullPageRect(geometry.width_pt, geometry.height_pt);
  const displayRect = effectiveRect(item, geometry.width_pt, geometry.height_pt);
  if (!displayRect || !validRect(displayRect, geometry.width_pt, geometry.height_pt)) return null;
  return {
    request: { path: source.access_path, sha: source.sha256!, page: item.original.source_page, pageCount: source.page_count!,
      width: geometry.width_pt, height: geometry.height_pt, retry },
    pageRect, displayRect, item, source,
  };
}

function PreviewSvg({ preview, rect, label, outline, className = '', zoom = 100, fieldSelection }: {
  preview: EnginePagePreview;
  rect: PdfRect;
  label: string;
  outline?: PdfRect;
  className?: string;
  zoom?: number;
  fieldSelection?: FieldSelectionContext;
}) {
  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const [drag, setDrag] = useState<NormalizedFieldRect | null>(null);
  const width = rect.x1 - rect.x0;
  const height = rect.y1 - rect.y0;
  const drawing = Boolean(fieldSelection?.current && !fieldSelection.disabled);
  useEffect(() => { startRef.current = null; setDrag(null); }, [fieldSelection?.current?.role, fieldSelection?.current?.field, drawing, rect.x0, rect.y0, rect.x1, rect.y1]);
  const point = (event: ReactPointerEvent<SVGSVGElement>) => { const matrix = event.currentTarget.getScreenCTM?.(); return matrix ? clientPointInSvg(event.clientX, event.clientY, matrix) : null; };
  const drawRect = (region: NormalizedFieldRect) => ({ x: rect.x0 + width * region.x0, y: rect.y0 + height * region.y0, width: width * (region.x1 - region.x0), height: height * (region.y1 - region.y0) });
  return (
    <svg
      className={`receipt-grouping-preview__svg ${className}`.trim()}
      role="img"
      aria-label={label}
      viewBox={`${rect.x0} ${rect.y0} ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: `${zoom}%`, touchAction: drawing ? 'none' : undefined, cursor: drawing ? 'crosshair' : undefined }}
      onPointerDown={(event) => {
        if (!drawing || event.button !== 0) return;
        const p = point(event); if (!p || p.x < rect.x0 || p.x > rect.x1 || p.y < rect.y0 || p.y > rect.y1) return;
        event.preventDefault(); event.stopPropagation(); startRef.current = { ...p, pointerId: event.pointerId }; setDrag(null); event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => { const start = startRef.current; if (!start || start.pointerId !== event.pointerId) return; const p = point(event); if (p) setDrag(normalizeFieldSelection(start, p, rect)); }}
      onPointerUp={(event) => {
        const start = startRef.current; if (!start || start.pointerId !== event.pointerId) return;
        const p = point(event); const selection = p && normalizeFieldSelection(start, p, rect);
        startRef.current = null; setDrag(null); event.currentTarget.releasePointerCapture?.(event.pointerId);
        if (selection && drawing) fieldSelection?.onSelect(selection);
      }}
      onPointerCancel={() => { startRef.current = null; setDrag(null); }}
    >
      <image href={preview.image_data} x="0" y="0" width={preview.page_width} height={preview.page_height} preserveAspectRatio="none" />
      {outline && <rect x={outline.x0} y={outline.y0} width={outline.x1 - outline.x0} height={outline.y1 - outline.y0}
        fill="none" stroke="#258575" strokeWidth="2" vectorEffect="non-scaling-stroke" aria-label="当前片段边界" />}
      {fieldSelection?.regions.map((region) => <g key={`${region.role}:${region.field}`} pointerEvents="none"><rect {...drawRect(region.rect)} fill="#25857522" stroke="#258575" strokeWidth="2" vectorEffect="non-scaling-stroke" aria-label={`${fieldRegionLabel(region, fieldSelection.mode)}读取区域`} /><text x={rect.x0 + width * region.rect.x0} y={Math.max(rect.y0 + 10, rect.y0 + height * region.rect.y0 - 3)} fill="#176759" fontSize={Math.max(8, width / 65)}>{fieldRegionLabel(region, fieldSelection.mode)}</text></g>)}
      {drag && <rect {...drawRect(drag)} fill="#da9a2822" stroke="#b67916" strokeWidth="2" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
    </svg>
  );
}

function PreviewMessage({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <p className={`receipt-grouping-preview__message${error ? ' is-error' : ''}`} role={error ? 'alert' : undefined}>{children}</p>;
}

export function ReceiptGroupingPreview({ reviewItem, source, active = true, contextKey, controls, fieldSelection }: ReceiptGroupingPreviewProps) {
  const [loaded, setLoaded] = useState<{ key: string; value: EnginePagePreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'segment' | 'page'>('segment');
  const [zoom, setZoom] = useState(100);
  const [inlineZoom, setInlineZoom] = useState(100);
  const cacheRef = useRef<ReceiptPagePreviewCache | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  const validation = useMemo(() => bindingError(reviewItem, source), [reviewItem, source]);
  const binding = useMemo(() => buildBinding(reviewItem, source, retry), [reviewItem, source, retry]);
  const requestKey = useMemo(() => binding ? receiptPageKey(binding.request) : '', [binding]);
  const renderKey = useMemo(() => JSON.stringify([contextKey, requestKey]), [contextKey, requestKey]);
  const image = loaded?.key === renderKey ? loaded.value : null;

  useEffect(() => {
    const cache = new ReceiptPagePreviewCache((request) => localEngineAdapter.renderPage(request.path, request.page, request.sha));
    cacheRef.current = cache;
    setLoaded(null);
    setError(null);
    setRetry(0);
    setDialogOpen(false);
    setDialogMode('segment');
    setZoom(100);
    setInlineZoom(100);
    return () => {
      cache.dispose();
      if (cacheRef.current === cache) cacheRef.current = null;
    };
  }, [contextKey]);

  useEffect(() => {
    let current = true;
    if (!active) {
      setDialogOpen(false);
      return () => { current = false; };
    }
    if (validation || !binding) {
      setLoaded(null);
      setError(null);
      setDialogOpen(false);
      return () => { current = false; };
    }
    setError(null);
    const cache = cacheRef.current;
    if (!cache) return () => { current = false; };
    const key = renderKey;
    void cache.load(binding.request).then((value) => {
      if (value.source_sha256?.toLowerCase() !== binding.request.sha.toLowerCase()) {
        throw new Error('页面预览来源 SHA-256 与当前 PDF 不一致，请重新载入结果。');
      }
      if (current) setLoaded({ key, value });
    }).catch((cause: unknown) => {
      if (current && !(cause instanceof SupersededReceiptPreview)) setError(cause instanceof Error ? cause.message : '页面预览失败，请重试。');
    });
    return () => { current = false; };
  }, [active, binding, renderKey, validation]);

  useEffect(() => {
    if (!dialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDialogOpen(false); }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    queueMicrotask(() => closeButtonRef.current?.focus());
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (triggerRef.current && document.contains(triggerRef.current)) triggerRef.current.focus();
    };
  }, [dialogOpen]);

  if (!active) return <section className="receipt-grouping-preview" aria-label="片段原件预览">{controls}<PreviewMessage>进入交易对手分组后可查看当前片段原件。</PreviewMessage></section>;
  if (validation || !binding) return <section className="receipt-grouping-preview" aria-label="片段原件预览">{controls}<PreviewMessage error={Boolean(validation)}>{validation ?? '当前片段暂不能预览。'}</PreviewMessage></section>;

  const { item, source: boundSource, displayRect, pageRect } = binding;
  const locationLabel = `第 ${item.original.source_page} 页 · 第 ${item.original.position_index} 栏`;
  const cropLabel = rectLabel(displayRect, pageRect);
  const imageLabel = `${sourceName(boundSource)} ${locationLabel} ${cropLabel}`;
  const openDialog = () => { setDialogMode('segment'); setZoom(100); setDialogOpen(true); };
  const closeDialog = () => { setDialogOpen(false); triggerRef.current?.focus(); };
  const dialogRect = dialogMode === 'page' ? pageRect : displayRect;

  return (
    <section className="receipt-grouping-preview" aria-label="片段原件预览">
      <header className="receipt-grouping-preview__header">
        <div className="receipt-grouping-preview__heading">
          <strong title={sourceName(boundSource)}>{sourceName(boundSource)}</strong>
          <span>{locationLabel}</span>
        </div>
        <div className="receipt-grouping-preview__tools">
          {controls}
          <div className="receipt-grouping-preview__zoom" role="group" aria-label="单张预览缩放">
            <button type="button" aria-label="缩小单张预览" onClick={() => setInlineZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))} disabled={!image || inlineZoom <= MIN_ZOOM}>−</button>
            <span aria-live="polite">{inlineZoom}%</span>
            <button type="button" aria-label="放大单张预览" onClick={() => setInlineZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))} disabled={!image || inlineZoom >= MAX_ZOOM}>＋</button>
          </div>
          <button ref={triggerRef} type="button" onClick={openDialog} disabled={!image}>放大查看</button>
        </div>
      </header>
      <div className="receipt-grouping-preview__stage" aria-live="polite">
        {image ? <PreviewSvg preview={image} rect={displayRect} label={imageLabel} zoom={inlineZoom} fieldSelection={fieldSelection} />
          : error ? <PreviewMessage error>{error}<button type="button" onClick={() => setRetry((value) => value + 1)}>重试页面预览</button></PreviewMessage>
            : <PreviewMessage>正在载入第 {item.original.source_page} 页原件…</PreviewMessage>}
      </div>
      {dialogOpen && image && (
        <div className="receipt-grouping-preview__dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
          <section ref={dialogRef} className="receipt-grouping-preview__dialog" role="dialog" aria-modal="true" aria-labelledby="receipt-grouping-preview-dialog-title">
            <header className="receipt-grouping-preview__dialog-header">
              <div>
                <h2 id="receipt-grouping-preview-dialog-title">原件放大查看</h2>
                <p>{sourceName(boundSource)} · {locationLabel} · {dialogMode === 'page' ? '整页' : cropLabel}</p>
              </div>
              <button ref={closeButtonRef} type="button" onClick={closeDialog}>关闭</button>
            </header>
            <div className="receipt-grouping-preview__dialog-tools" role="toolbar" aria-label="原件查看工具">
              <button type="button" aria-pressed={dialogMode === 'segment'} onClick={() => setDialogMode('segment')}>查看片段</button>
              <button type="button" aria-pressed={dialogMode === 'page'} onClick={() => setDialogMode('page')}>查看整页</button>
              <span className="receipt-grouping-preview__dialog-spacer" />
              <button type="button" aria-label="缩小" onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))} disabled={zoom <= MIN_ZOOM}>−</button>
              <span aria-live="polite">{zoom}%</span>
              <button type="button" aria-label="放大" onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))} disabled={zoom >= MAX_ZOOM}>＋</button>
            </div>
            <div className="receipt-grouping-preview__dialog-body">
              <PreviewSvg preview={image} rect={dialogRect} outline={dialogMode === 'page' ? displayRect : undefined}
                label={`${imageLabel} ${dialogMode === 'page' ? '整页' : '片段'}`} zoom={zoom} fieldSelection={dialogMode === 'segment' ? fieldSelection : undefined} />
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

export default ReceiptGroupingPreview;
