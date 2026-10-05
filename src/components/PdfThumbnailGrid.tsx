import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { PdfRect } from '../domain/cropReview';
import { PdfThumbnailCache } from '../services/pdfThumbnailCache';
import type { EnginePagePreview } from './localEngineAdapter';
import './PdfThumbnailGrid.css';

export type PdfThumbnailTone = 'automatic' | 'pending' | 'confirmed' | 'excluded';
export type PdfThumbnailAttention = 'suspected' | 'special';

export type PdfThumbnailOverlay = {
  rect: PdfRect;
  tone?: PdfThumbnailTone;
  attention?: PdfThumbnailAttention;
  badge?: string;
  label?: string;
};

export type PdfThumbnailCard = {
  id: string;
  path: string;
  sha: string;
  page: number;
  pageCount: number;
  label: string;
  sourceLabel?: string;
  width?: number;
  height?: number;
  rect?: PdfRect;
  overlays?: readonly PdfThumbnailOverlay[];
  description?: string;
  badge?: string;
  tone?: PdfThumbnailTone;
  attention?: PdfThumbnailAttention;
  selectable?: boolean;
};

export type PdfThumbnailGridProps = {
  cards: readonly PdfThumbnailCard[];
  size: number;
  shape: 'page' | 'receipt';
  selectedIds?: ReadonlySet<string>;
  focusedId?: string | null;
  followFocus?: boolean;
  onOpen: (card: PdfThumbnailCard) => void;
  onToggle?: (id: string, checked: boolean, extend: boolean) => void;
  active?: boolean;
  disabled?: boolean;
  scrollKey: string;
  label?: string;
  emptyMessage?: string;
};

type ScrollAnchor = { id?: string; index: number; fraction: number };
const scrollAnchors = new Map<string, ScrollAnchor>();
const GAP = 16;
const INSET = 16;
const OVERSCAN_ROWS = 2;

function saveAnchor(key: string, anchor: ScrollAnchor) {
  scrollAnchors.delete(key);
  scrollAnchors.set(key, anchor);
  if (scrollAnchors.size > 40) scrollAnchors.delete(scrollAnchors.keys().next().value!);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validRect(rect: PdfRect, width: number, height: number): boolean {
  return [rect.x0, rect.y0, rect.x1, rect.y1].every(Number.isFinite)
    && rect.x0 >= 0 && rect.y0 >= 0
    && rect.x1 > rect.x0 && rect.y1 > rect.y0
    && rect.x1 <= width && rect.y1 <= height;
}

function validCard(card: PdfThumbnailCard): boolean {
  return Boolean(card.path.trim()) && /^[a-f0-9]{64}$/i.test(card.sha)
    && Number.isSafeInteger(card.pageCount) && card.pageCount > 0
    && Number.isSafeInteger(card.page) && card.page > 0 && card.page <= card.pageCount
    && (card.width === undefined || positive(card.width))
    && (card.height === undefined || positive(card.height));
}

function validPreview(card: PdfThumbnailCard, preview: EnginePagePreview): boolean {
  return preview.status === 'ok' && preview.page === card.page && preview.page_count === card.pageCount
    && positive(preview.page_width) && positive(preview.page_height)
    && typeof preview.image_data === 'string' && preview.image_data.startsWith('data:image/')
    && preview.source_sha256?.toLowerCase() === card.sha.toLowerCase()
    && (card.width === undefined || Math.abs(card.width - preview.page_width) <= 0.5)
    && (card.height === undefined || Math.abs(card.height - preview.page_height) <= 0.5);
}

function cardIdentity(card: PdfThumbnailCard): string {
  return JSON.stringify([card.path, card.sha.toLowerCase(), card.page, card.pageCount, card.width, card.height]);
}

type ThumbnailCellProps = Pick<PdfThumbnailGridProps, 'onOpen' | 'onToggle' | 'disabled'> & {
  card: PdfThumbnailCard;
  cache: PdfThumbnailCache | null;
  selected: boolean;
  focused: boolean;
  imageHeight: number;
  imageWidth: number;
};

/** Both overview modes draw in PDF coordinates; badges stay readable at thumbnail scale. */
function FragmentOverlay({ overlay, scale }: { overlay: PdfThumbnailOverlay; scale: number }) {
  const { rect, tone = 'pending', attention, badge, label } = overlay;
  const width = rect.x1 - rect.x0, height = rect.y1 - rect.y0;
  // Keep the stroke inside the crop, without changing the image or its clip.
  const insetX = Math.min(1 / scale, width / 2), insetY = Math.min(1 / scale, height / 2);
  const badgeWidth = (badge?.length ?? 0) * 10 + 10;
  const badgeHeight = 18;
  const badgeScale = Math.min(1 / scale, width / (badgeWidth + 4), height / (badgeHeight + 4));
  return (
    <g className="pdf-thumbnail-fragment">
      {label && <title>{label}</title>}
      <rect
        className={`pdf-thumbnail-overlay tone-${tone}${attention ? ` attention-${attention}` : ''}`}
        x={rect.x0 + insetX} y={rect.y0 + insetY}
        width={Math.max(0, width - insetX * 2)} height={Math.max(0, height - insetY * 2)}
        vectorEffect="non-scaling-stroke"
      />
      {badge && <g
        className={`pdf-thumbnail-overlay-badge tone-${tone}`}
        transform={`translate(${rect.x1 - (badgeWidth + 2) * badgeScale} ${rect.y0 + 2 * badgeScale}) scale(${badgeScale})`}
      >
        <rect width={badgeWidth} height={badgeHeight} rx={3} />
        <text x={badgeWidth / 2} y={12.5} textAnchor="middle">{badge}</text>
      </g>}
    </g>
  );
}

function ThumbnailCell({ card, cache, selected, focused, onOpen, onToggle, disabled, imageHeight, imageWidth }: ThumbnailCellProps) {
  const clipId = useId();
  const identity = cardIdentity(card);
  const [result, setResult] = useState<{ identity: string; preview?: EnginePagePreview; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inputValid = validCard(card);

  useEffect(() => {
    if (!cache || !inputValid) return;
    const controller = new AbortController();
    setResult(null);
    void cache.load({
      path: card.path,
      sha: card.sha,
      page: card.page,
      pageCount: card.pageCount,
      width: card.width,
      height: card.height,
    }, controller.signal).then((preview) => {
      if (controller.signal.aborted) return;
      setResult(validPreview(card, preview)
        ? { identity, preview }
        : { identity, error: '页面或尺寸不匹配' });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ identity, error: '缩略图加载失败' });
    });
    return () => controller.abort();
    // Only source identity changes reload an image; crop/status edits reuse the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, identity, attempt, inputValid]);

  const currentResult = result?.identity === identity ? result : null;
  const pagePreview = currentResult?.preview && validPreview(card, currentResult.preview) ? currentResult.preview : null;
  const preview = pagePreview && (!card.rect || validRect(card.rect, pagePreview.page_width, pagePreview.page_height)) ? pagePreview : null;
  const error = !inputValid ? '页面信息无效'
    : currentResult?.error || (currentResult?.preview && !preview ? '裁剪区域无效' : '');
  const view = preview ? card.rect ?? { x0: 0, y0: 0, x1: preview.page_width, y1: preview.page_height } : null;
  // The image area has 10px padding; SVG meet fitting leaves any remaining space blank.
  const imageScale = view ? Math.min(Math.max(1, imageWidth - 20) / (view.x1 - view.x0),
    Math.max(1, imageHeight - 20) / (view.y1 - view.y0)) : 1;
  const cardDisabled = disabled || !inputValid;

  return (
    <article
      className={`pdf-thumbnail-card${selected ? ' is-selected' : ''}${focused ? ' is-focused' : ''}${card.tone ? ` tone-${card.tone}` : ''}${card.attention ? ` attention-${card.attention}` : ''}`}
      data-card-id={card.id}
    >
      <button
        type="button"
        className="pdf-thumbnail-open"
        aria-label={`打开 ${card.label}`}
        aria-current={focused ? 'page' : undefined}
        disabled={cardDisabled}
        onClick={() => onOpen(card)}
      >
        <span className="pdf-thumbnail-image" style={{ height: imageHeight }}>
          {preview && view ? (
            <svg
              viewBox={`${view.x0} ${view.y0} ${view.x1 - view.x0} ${view.y1 - view.y0}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label={`${card.label}缩略图`}
            >
              <rect x={view.x0} y={view.y0} width={view.x1 - view.x0} height={view.y1 - view.y0} fill="white" />
              <defs><clipPath id={clipId}><rect x={view.x0} y={view.y0} width={view.x1 - view.x0} height={view.y1 - view.y0} /></clipPath></defs>
              <g clipPath={`url(#${clipId})`}>
              <image href={preview.image_data} width={preview.page_width} height={preview.page_height} />
              {card.overlays?.filter(({ rect }) => validRect(rect, preview.page_width, preview.page_height)).map((overlay, index) => (
                <FragmentOverlay key={index} overlay={overlay} scale={imageScale} />
              ))}
              </g>
            </svg>
          ) : (
            <span className={`pdf-thumbnail-placeholder${error ? ' has-error' : ''}`}>
              {error || '正在加载…'}
            </span>
          )}
        </span>
        <span className="pdf-thumbnail-meta">
          <span className="pdf-thumbnail-title">
            <strong title={card.label}>{card.label}</strong>
            {!card.rect && card.badge && <span className="pdf-thumbnail-badge">{card.badge}</span>}
          </span>
          <span title={card.sourceLabel || card.description}>{card.sourceLabel || card.description || `第 ${card.page} / ${card.pageCount} 页`}</span>
          {card.sourceLabel && card.description && <span title={card.description}>{card.description}</span>}
        </span>
      </button>
      {card.attention && <span className={`pdf-thumbnail-attention attention-${card.attention}`}>
        {card.attention === 'suspected' ? '疑似无效·待核对' : '特殊单证'}
      </span>}
      {onToggle && card.selectable !== false && (
        <label className="pdf-thumbnail-select">
          <input
            type="checkbox"
            aria-label={`选择 ${card.label}`}
            checked={selected}
            disabled={cardDisabled}
            onChange={() => { /* Click handles the native Shift modifier as well as keyboard activation. */ }}
            onClick={(event) => onToggle(card.id, event.currentTarget.checked, event.shiftKey)}
            onKeyDown={(event) => {
              if (event.key === ' ' && event.shiftKey) {
                event.preventDefault();
                onToggle(card.id, !selected, true);
              }
            }}
          />
        </label>
      )}
      {card.rect && card.badge && (!preview || !card.overlays?.some((overlay) => overlay.badge))
        && <span className="pdf-thumbnail-badge">{card.badge}</span>}
      {error && inputValid && (
        <button type="button" className="pdf-thumbnail-retry" disabled={disabled} aria-label={`重试 ${card.label}缩略图`} onClick={() => setAttempt((value) => value + 1)}>重试</button>
      )}
    </article>
  );
}

export function PdfThumbnailGrid({
  cards, size, shape, selectedIds, focusedId, onOpen, onToggle,
  active = true, disabled = false, followFocus = false, scrollKey, label = 'PDF 缩略图总览', emptyMessage = '暂无可显示的页面',
}: PdfThumbnailGridProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pendingButtonFocus = useRef<string | null>(null);
  const scrollPositionRef = useRef(0);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const [scrollTop, setScrollTop] = useState(0);
  const [cacheState, setCacheState] = useState<{ key: string; cache: PdfThumbnailCache } | null>(null);
  const cache = cacheState?.key === scrollKey ? cacheState.cache : null;
  const safeSize = Number.isFinite(size) ? Math.min(420, Math.max(112, size)) : 200;
  const cardWidth = Math.min(safeSize, Math.max(1, viewport.width - INSET * 2));
  const columns = Math.max(1, Math.floor((viewport.width - INSET * 2 + GAP) / (cardWidth + GAP)));
  const imageHeight = Math.round(cardWidth * (shape === 'page' ? Math.SQRT2 : 0.72));
  const rowHeight = imageHeight + 80 + GAP;
  const rowCount = Math.ceil(cards.length / columns);
  const contentHeight = rowCount * rowHeight + INSET * 2;
  const previousLayout = useRef<{ key: string; columns: number; rowHeight: number; cards: readonly PdfThumbnailCard[] } | null>(null);

  useEffect(() => {
    const nextCache = new PdfThumbnailCache();
    setCacheState({ key: scrollKey, cache: nextCache });
    return () => nextCache.dispose();
  }, [scrollKey]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element || !active) return;
    const measure = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        setViewport((current) => current.width === element.clientWidth && current.height === element.clientHeight
          ? current : { width: element.clientWidth, height: element.clientHeight });
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element || !active) return;
    const previous = previousLayout.current;
    let anchor = scrollAnchors.get(scrollKey);
    if (previous?.key === scrollKey) {
      // Hidden containers and resized scroll ranges can report a clamped DOM
      // offset; retain the last known logical position until layout is restored.
      const offset = Math.max(0, scrollPositionRef.current - INSET);
      const index = Math.floor(offset / previous.rowHeight) * previous.columns;
      anchor = { id: previous.cards[index]?.id, index, fraction: (offset % previous.rowHeight) / previous.rowHeight };
    }
    const knownIndex = anchor?.id ? cards.findIndex((card) => card.id === anchor.id) : -1;
    const index = Math.min(Math.max(0, cards.length - 1), knownIndex >= 0 ? knownIndex : anchor?.index ?? 0);
    const nextScrollTop = anchor && (index > 0 || anchor.fraction > 0)
      ? Math.max(0, Math.min(contentHeight - viewport.height, Math.floor(index / columns) * rowHeight + anchor.fraction * rowHeight + INSET))
      : 0;
    element.scrollTop = nextScrollTop;
    scrollPositionRef.current = nextScrollTop;
    setScrollTop(nextScrollTop);
    previousLayout.current = { key: scrollKey, columns, rowHeight, cards };
    const offset = Math.max(0, nextScrollTop - INSET);
    const nextIndex = Math.floor(offset / rowHeight) * columns;
    saveAnchor(scrollKey, { id: cards[nextIndex]?.id, index: nextIndex, fraction: (offset % rowHeight) / rowHeight });
  }, [scrollKey, columns, rowHeight, contentHeight, viewport.height, cards, active]);

  const focusedIndex = cards.findIndex((card) => card.id === focusedId);
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element || !active || !followFocus || focusedIndex < 0 || disabled) {
      pendingButtonFocus.current = null;
      return;
    }
    const currentFocus = document.activeElement;
    if (currentFocus instanceof HTMLElement && element.contains(currentFocus)
      && currentFocus.matches('.pdf-thumbnail-open')) {
      pendingButtonFocus.current = focusedId ?? null;
    }
    const top = Math.floor(focusedIndex / columns) * rowHeight + INSET;
    const bottom = top + rowHeight - GAP;
    const current = scrollPositionRef.current;
    const target = top < current ? top : bottom > current + viewport.height ? bottom - viewport.height : current;
    const next = Math.max(0, Math.min(Math.max(0, contentHeight - viewport.height), target));
    if (next === current) return;
    element.scrollTop = next;
    scrollPositionRef.current = next;
    setScrollTop(next);
    const offset = Math.max(0, next - INSET);
    const index = Math.floor(offset / rowHeight) * columns;
    saveAnchor(scrollKey, { id: previousLayout.current?.cards[index]?.id, index, fraction: (offset % rowHeight) / rowHeight });
  }, [focusedId, focusedIndex, followFocus, active, disabled, scrollKey, columns, rowHeight, viewport.height, contentHeight]);

  const firstRow = Math.max(0, Math.floor(Math.max(0, scrollTop - INSET) / rowHeight) - OVERSCAN_ROWS);
  const lastRow = Math.min(rowCount, Math.ceil((scrollTop + viewport.height) / rowHeight) + OVERSCAN_ROWS);
  const visibleCards = useMemo(() => cards.slice(firstRow * columns, lastRow * columns), [cards, firstRow, lastRow, columns]);
  const gridStyle = { '--thumbnail-card-width': `${cardWidth}px`, '--thumbnail-row-height': `${rowHeight - GAP}px` } as CSSProperties;

  // A far-away keyboard target is mounted only after the virtual window moves.
  // Keep actual button focus with the highlighted card, without stealing focus
  // from the list, toolbar or grid region when they drive the same preview.
  useLayoutEffect(() => {
    if (!pendingButtonFocus.current || pendingButtonFocus.current !== focusedId) return;
    const card = Array.from(viewportRef.current?.querySelectorAll<HTMLElement>('[data-card-id]') ?? [])
      .find((node) => node.dataset.cardId === pendingButtonFocus.current);
    const button = card?.querySelector<HTMLButtonElement>('.pdf-thumbnail-open');
    if (button && !button.disabled) {
      button.focus({ preventScroll: true });
      pendingButtonFocus.current = null;
    }
  });

  return (
    <div
      ref={viewportRef}
      className={`pdf-thumbnail-grid shape-${shape}`}
      role="region"
      aria-label={label}
      hidden={!active}
      tabIndex={0}
      style={gridStyle}
      onScroll={(event) => {
        const nextTop = event.currentTarget.scrollTop;
        if (!active) return;
        scrollPositionRef.current = nextTop;
        setScrollTop(nextTop);
        const offset = Math.max(0, nextTop - INSET);
        const index = Math.floor(offset / rowHeight) * columns;
        saveAnchor(scrollKey, { id: cards[index]?.id, index, fraction: (offset % rowHeight) / rowHeight });
      }}
    >
      {cards.length === 0 ? <p className="pdf-thumbnail-empty">{emptyMessage}</p> : (
        <div className="pdf-thumbnail-spacer" style={{ height: contentHeight }}>
          {active && <div
            className="pdf-thumbnail-window"
            style={{ transform: `translateY(${firstRow * rowHeight + INSET}px)`, gridTemplateColumns: `repeat(${columns}, ${cardWidth}px)` }}
          >
            {visibleCards.map((card) => (
              <ThumbnailCell
                key={`${card.id}:${cardIdentity(card)}`}
                card={card}
                cache={cache}
                imageHeight={imageHeight}
                imageWidth={cardWidth - 2}
                selected={selectedIds?.has(card.id) ?? false}
                focused={focusedId === card.id}
                onOpen={onOpen}
                onToggle={onToggle}
                disabled={disabled}
              />
            ))}
          </div>}
        </div>
      )}
    </div>
  );
}

export default PdfThumbnailGrid;
