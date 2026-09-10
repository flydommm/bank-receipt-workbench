import { useEffect, useMemo, useRef, useState } from 'react';
import type { CropMode, ReviewFilter, ReviewStatus } from '../domain/cropReview';
import {
  nextReviewRowIndex,
  type ReviewNavigationKey,
} from '../domain/reviewNavigatorNavigation';
import {
  deriveReviewResultView,
  type ReviewResultSource,
  type ReviewResultSort,
} from '../domain/reviewResultView';

export type ReviewNavigatorRow = {
  id: string;
  sourceKey: string;
  sourcePage: number;
  segmentNo: number;
  sourceName: string;
  sourceAccessibleLabel: string;
  matchedField: string;
  matchedText: string;
  matchedKeywords?: string;
  confidence: number;
  reviewStatus: ReviewStatus;
  manualAdjusted: boolean;
  mode: CropMode;
  previewStatus?: 'pending' | 'valid' | 'invalid';
  previewError?: string;
};

export type ReviewNavigatorProps = {
  rows: readonly ReviewNavigatorRow[];
  selectedId: string | null;
  activeFilter: ReviewFilter;
  onFilterChange: (filter: ReviewFilter) => void;
  onSelect: (id: string) => void;
  showSourceName: boolean;
  showKeyboardHints?: boolean;
  navigationDisabled?: boolean;
  stale?: boolean;
  pairingError?: string;
  emptyMessage?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  sourceFilter?: string | null;
  sortOrder?: ReviewResultSort;
  sources?: readonly ReviewResultSource[];
  onSourceFilterChange?: (source: string | null) => void;
  onSortOrderChange?: (sort: ReviewResultSort) => void;
  onResetFilters?: () => void;
  onRevealSelected?: () => void;
  viewControlsDisabled?: boolean;
};

const FILTERS: readonly { key: ReviewFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'needs_review', label: '需复核' },
  { key: 'manual', label: '人工调整' },
  { key: 'blocked', label: '已阻塞' },
];

const STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: '待复核',
  needs_review: '需复核',
  confirmed: '已确认',
  blocked: '已阻塞',
};

const REVIEW_NAVIGATION_KEYS = new Set<ReviewNavigationKey>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
]);

const SORT_OPTIONS: readonly { key: ReviewResultSort; label: string }[] = [
  { key: 'original', label: '原始顺序' },
  { key: 'confidence_asc', label: '置信度从低到高' },
  { key: 'confidence_desc', label: '置信度从高到低' },
];

const EMPTY_SOURCES: readonly ReviewResultSource[] = [];

function formatConfidence(confidence: number): string {
  return Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : '—';
}

function rowLabel(row: ReviewNavigatorRow): string {
  return `第 ${row.sourcePage} 页 / 片段 ${row.segmentNo}`;
}

function previewValidationLabel(row: ReviewNavigatorRow): string | null {
  if (row.previewStatus === 'pending' && row.previewError) return '预览待重试';
  if (row.previewStatus === 'pending') return '预览校验中';
  if (row.previewStatus === 'invalid') return '预览校验失败';
  return null;
}

export function ReviewNavigator({
  rows,
  selectedId,
  activeFilter,
  onFilterChange,
  onSelect,
  showSourceName,
  showKeyboardHints = true,
  navigationDisabled = false,
  stale = false,
  pairingError,
  emptyMessage,
  emptyActionLabel,
  onEmptyAction,
  sourceFilter = null,
  sortOrder = 'original',
  sources = EMPTY_SOURCES,
  onSourceFilterChange,
  onSortOrderChange,
  onResetFilters,
  onRevealSelected,
  viewControlsDisabled = false,
}: ReviewNavigatorProps) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const emptyStateRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeRowIdRef = useRef<string | null>(null);
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const focusAfterRenderRef = useRef<string | null>(null);
  const focusEmptyAfterRenderRef = useRef(false);
  const safeRows: readonly ReviewNavigatorRow[] = Array.isArray(rows) ? rows : [];
  const sourceKeys = useMemo(() => new Set([
    ...safeRows.map((row) => row.sourceKey),
    ...sources.map((source) => source.key),
  ]), [safeRows, sources]);
  const normalizedSourceFilter = sourceFilter !== null && sourceKeys.has(sourceFilter)
    ? sourceFilter
    : null;
  const normalizedSortOrder = SORT_OPTIONS.some(({ key }) => key === sortOrder)
    ? sortOrder
    : 'original';
  const resultView = useMemo(() => deriveReviewResultView(safeRows, {
    sourceKey: normalizedSourceFilter,
    filter: activeFilter,
    sort: normalizedSortOrder,
  }, sources), [activeFilter, normalizedSortOrder, normalizedSourceFilter, safeRows, sources]);
  const { visibleRows, counts, total } = resultView;
  const visibleRowIds = visibleRows.map((row) => row.id);
  const visibleRowKey = visibleRowIds.join('\u0000');
  const previousVisibleRowKeyRef = useRef(visibleRowKey);
  const rowFocusedBeforeVisibleChangeRef = useRef<HTMLButtonElement | null>(null);
  if (previousVisibleRowKeyRef.current !== visibleRowKey) {
    const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
    rowFocusedBeforeVisibleChangeRef.current = [...rowRefs.current.values()]
      .find((node) => node === activeElement) ?? null;
    previousVisibleRowKeyRef.current = visibleRowKey;
  }
  const selectedVisible = selectedId !== null && visibleRowIds.includes(selectedId);
  const selectedExists = selectedId !== null && safeRows.some((row) => row.id === selectedId);
  const selectedHidden = selectedExists && !selectedVisible;
  const tabStopId = selectedVisible ? selectedId : visibleRows[0]?.id ?? null;
  const normalizedPairingError = pairingError?.trim() ?? '';
  const filtersActive = normalizedSourceFilter !== null || activeFilter !== 'all';
  const controlsDisabled = navigationDisabled || viewControlsDisabled;
  const selectedSourceLabel = resultView.sources.find((source) => source.key === normalizedSourceFilter)?.label ?? '全部文件';
  const selectedSortLabel = SORT_OPTIONS.find(({ key }) => key === normalizedSortOrder)?.label ?? '原始顺序';

  function handleSourceFilterChange(event: React.ChangeEvent<HTMLSelectElement>): void {
    if (controlsDisabled) return;
    const value = event.currentTarget.value;
    if (value === '') {
      onSourceFilterChange?.(null);
      return;
    }
    if (sourceKeys.has(value)) onSourceFilterChange?.(value);
  }

  function handleSortOrderChange(event: React.ChangeEvent<HTMLSelectElement>): void {
    if (controlsDisabled) return;
    const value = event.currentTarget.value;
    if (SORT_OPTIONS.some(({ key }) => key === value)) {
      onSortOrderChange?.(value as ReviewResultSort);
    }
  }

  useEffect(() => {
    const visibleIds = new Set(visibleRowIds);
    const fallbackId = visibleRows[0]?.id ?? null;
    const pendingFocusId = focusAfterRenderRef.current;
    const focusedRowRemoved = Boolean(
      focusedRowId
      && !visibleIds.has(focusedRowId)
      && activeRowIdRef.current === focusedRowId
      && rowFocusedBeforeVisibleChangeRef.current !== null
      && !rowFocusedBeforeVisibleChangeRef.current.isConnected,
    );
    const pendingFocusRemoved = Boolean(
      pendingFocusId && !visibleIds.has(pendingFocusId),
    );

    setFocusedRowId((current) => (
      current === null ? null : visibleIds.has(current) ? current : fallbackId
    ));

    if (focusedRowRemoved || pendingFocusRemoved) {
      focusAfterRenderRef.current = fallbackId;
      focusEmptyAfterRenderRef.current = fallbackId === null;
    }
  }, [focusedRowId, visibleRowKey]);

  useEffect(() => {
    const clearActiveRowWhenFocusLeavesList = (event: FocusEvent): void => {
      const target = event.target;
      if (target instanceof Node && listRef.current?.contains(target)) return;

      activeRowIdRef.current = null;
      setFocusedRowId((current) => (
        current && rowRefs.current.has(current) ? null : current
      ));
    };
    const clearActiveRowWhenWindowBlurs = (): void => {
      const activeElement = document.activeElement;
      if (activeElement instanceof Node && listRef.current?.contains(activeElement)) return;

      activeRowIdRef.current = null;
      setFocusedRowId((current) => (
        current && rowRefs.current.has(current) ? null : current
      ));
    };

    document.addEventListener('focusin', clearActiveRowWhenFocusLeavesList);
    window.addEventListener('blur', clearActiveRowWhenWindowBlurs);
    return () => {
      document.removeEventListener('focusin', clearActiveRowWhenFocusLeavesList);
      window.removeEventListener('blur', clearActiveRowWhenWindowBlurs);
    };
  }, []);

  useEffect(() => {
    const targetId = focusAfterRenderRef.current;
    const focusEmptyState = focusEmptyAfterRenderRef.current;
    const focusOrigin = rowFocusedBeforeVisibleChangeRef.current;
    if (!targetId && !focusEmptyState) {
      rowFocusedBeforeVisibleChangeRef.current = null;
      return;
    }

    focusAfterRenderRef.current = null;
    focusEmptyAfterRenderRef.current = false;
    const targetRow = targetId ? rowRefs.current.get(targetId) : undefined;
    const activeElement = document.activeElement;
    const externalFocus = activeElement instanceof Node
      && !listRef.current?.contains(activeElement)
      && activeElement !== document.body;
    if (focusOrigin && externalFocus) {
      rowFocusedBeforeVisibleChangeRef.current = null;
      return;
    }
    if (targetRow && !targetRow.disabled) {
      targetRow.focus();
    } else if (focusEmptyState) {
      emptyStateRef.current?.focus();
    }
    rowFocusedBeforeVisibleChangeRef.current = null;
  }, [focusedRowId, visibleRowKey]);

  function handleRowFocus(rowId: string): void {
    activeRowIdRef.current = rowId;
    setFocusedRowId(rowId);
  }

  function handleRowBlur(
    event: React.FocusEvent<HTMLButtonElement>,
    rowId: string,
  ): void {
    // A null relatedTarget can mean that React is unmounting the focused row.
    // Defer the connectedness check so an ordinary blur to body clears the
    // active row, while an unmounted row remains eligible for fallback focus.
    if (event.relatedTarget === null) {
      const blurredNode = event.currentTarget;
      queueMicrotask(() => {
        if (!blurredNode.isConnected) return;
        const activeElement = document.activeElement;
        const activeRow = [...rowRefs.current.entries()]
          .find(([, node]) => node === activeElement)?.[0] ?? null;
        if (activeRow) {
          activeRowIdRef.current = activeRow;
          setFocusedRowId(activeRow);
        } else if (activeRowIdRef.current === rowId) {
          activeRowIdRef.current = null;
          setFocusedRowId((current) => (current === rowId ? null : current));
        }
      });
      return;
    }

    const nextRowId = [...rowRefs.current.entries()]
      .find(([, node]) => node === event.relatedTarget)?.[0] ?? null;
    if (activeRowIdRef.current === rowId) {
      activeRowIdRef.current = nextRowId;
    }
    setFocusedRowId((current) => (current === rowId ? nextRowId : current));
  }

  function handleRowKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    rowId: string,
  ): void {
    if (
      navigationDisabled
      || event.currentTarget !== document.activeElement
      || event.target !== event.currentTarget
      || !REVIEW_NAVIGATION_KEYS.has(event.key as ReviewNavigationKey)
    ) return;

    const currentIndex = visibleRows.findIndex((row) => row.id === rowId);
    if (currentIndex < 0) return;

    // Consume navigation keys even at a boundary so the page itself does not
    // scroll while the focused row remains selected.
    event.preventDefault();

    const targetIndex = nextReviewRowIndex(
      visibleRows,
      currentIndex,
      event.key as ReviewNavigationKey,
    );
    if (targetIndex === null || targetIndex === currentIndex) return;

    const targetRow = visibleRows[targetIndex];
    if (!targetRow) return;

    setFocusedRowId(targetRow.id);
    focusAfterRenderRef.current = targetRow.id;
    onSelect(targetRow.id);
  }

  useEffect(() => {
    if (!selectedId) return;

    const list = listRef.current;
    const selectedRow = rowRefs.current.get(selectedId);
    if (!list || !selectedRow) return;

    const listRect = list.getBoundingClientRect();
    const selectedRowRect = selectedRow.getBoundingClientRect();
    if (
      (selectedRowRect.top < listRect.top || selectedRowRect.bottom > listRect.bottom)
      && typeof selectedRow.scrollIntoView === 'function'
    ) {
      selectedRow.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedId, visibleRowKey]);

  return (
    <section
      className="review-navigator"
      aria-label="审核导航"
      data-stale={stale ? 'true' : undefined}
      data-filtered={filtersActive ? 'true' : undefined}
    >
      {showKeyboardHints && (
        <p className="review-navigator-keyboard-hint" role="note">
          焦点在命中片段上时，可用 ↑↓←→ 切换，Home/End 跳到首尾
        </p>
      )}
      <div className="review-navigator-filter-row" role="group" aria-label="审核筛选">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className="review-navigator-filter"
            aria-label={`${label} ${counts[key]}`}
            aria-pressed={activeFilter === key}
            disabled={controlsDisabled}
            onClick={() => {
              if (!controlsDisabled) onFilterChange(key);
            }}
          >
            <span>{label}</span>
            <span className="review-navigator-filter-count" aria-hidden="true">{counts[key]}</span>
          </button>
        ))}
      </div>

      <div className="review-navigator-view-controls" role="group" aria-label="结果视图控制">
        {resultView.sources.length > 1 && (
          <label className="review-navigator-view-control">
            <span className="review-navigator-view-control-label">来源 PDF</span>
            <select
              aria-label="来源 PDF"
              title={selectedSourceLabel}
              value={normalizedSourceFilter ?? ''}
              disabled={controlsDisabled}
              onChange={handleSourceFilterChange}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <option value="">全部文件</option>
              {resultView.sources.map((source) => (
                <option key={source.key} value={source.key}>
                  {`${source.label} (${source.count})`}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="review-navigator-view-control">
          <span className="review-navigator-view-control-label">结果排序</span>
          <select
            aria-label="结果排序"
            title={selectedSortLabel}
            value={normalizedSortOrder}
            disabled={controlsDisabled}
            onChange={handleSortOrderChange}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {SORT_OPTIONS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
      </div>

      <div className="review-navigator-summary" aria-live="polite">
        {stale && <strong>上次结果</strong>}
        <span>{`当前显示 ${visibleRows.length} / 总计 ${total} 个片段`}</span>
      </div>

      {filtersActive && (
        <div className="review-navigator-filter-notice">
          <span>筛选仅影响列表，整组确认和导出范围不变。</span>
          <button
            type="button"
            className="ghost-button review-navigator-reset"
            disabled={controlsDisabled}
            onClick={() => {
              if (!controlsDisabled) onResetFilters?.();
            }}
          >
            重置筛选
          </button>
        </div>
      )}

      {selectedHidden && (
        <div className="review-navigator-selected-hidden" role="status">
          <span>当前预览片段不在筛选结果中</span>
          <button
            type="button"
            className="ghost-button review-navigator-reveal"
            disabled={controlsDisabled}
            onClick={() => {
              if (!controlsDisabled) onRevealSelected?.();
            }}
          >
            定位当前片段
          </button>
        </div>
      )}

      {normalizedPairingError && (
        <div className="review-navigator-error" role="alert">{normalizedPairingError}</div>
      )}

      {visibleRows.length > 0 ? (
        <ul ref={listRef} className="review-navigator-list" role="list" aria-label="审核片段">
          {visibleRows.map((row) => {
            const statusLabel = STATUS_LABELS[row.reviewStatus] ?? '未知状态';
            const confidenceLabel = formatConfidence(row.confidence);
            const manual = row.manualAdjusted || row.mode === 'manual';
            const matchedField = row.matchedField || '命中文本';
            const matchedText = row.matchedText || '—';
            const matchedKeywords = row.matchedKeywords?.trim() ?? '';
            const previewLabel = previewValidationLabel(row);
            const previewDescription = previewLabel
              ? `，${previewLabel}${row.previewError ? `：${row.previewError}` : ''}`
              : '';
            const sourceLabel = row.sourceAccessibleLabel || row.sourceName || '未命名来源';
            return (
              <li key={row.id} className="review-navigator-list-item">
                <button
                  ref={(node) => {
                    if (node) {
                      rowRefs.current.set(row.id, node);
                    } else {
                      rowRefs.current.delete(row.id);
                    }
                  }}
                  type="button"
                  className="review-navigator-row"
                  disabled={navigationDisabled}
                  tabIndex={tabStopId === row.id ? 0 : -1}
                  data-status={row.reviewStatus}
                  data-selected={row.id === selectedId ? 'true' : undefined}
                  aria-label={`${sourceLabel}，${rowLabel(row)}，${matchedKeywords ? `关键词：${matchedKeywords}，` : ''}${matchedField}：${matchedText}，${statusLabel}，置信度${confidenceLabel}${manual ? '，人工调整' : ''}${previewDescription}`}
                  aria-current={row.id === selectedId ? 'true' : undefined}
                  onFocus={() => handleRowFocus(row.id)}
                  onBlur={(event) => handleRowBlur(event, row.id)}
                  onKeyDown={(event) => handleRowKeyDown(event, row.id)}
                  onClick={() => onSelect(row.id)}
                >
                  <span className="review-navigator-row-page">{row.sourcePage}</span>
                  <span className="review-navigator-row-copy">
                    {showSourceName && (
                      <span className="review-navigator-row-source" title={sourceLabel}>{row.sourceName || sourceLabel}</span>
                    )}
                    <span className="review-navigator-row-label">{rowLabel(row)}</span>
                    <span className="review-navigator-row-match">
                      {matchedKeywords && <span className="review-navigator-row-keywords">关键词：{matchedKeywords}</span>}
                      <strong>{matchedField}</strong>
                      <span>{matchedText}</span>
                    </span>
                    <span className="review-navigator-row-meta">
                      <span>置信度 {confidenceLabel}</span>
                      <span className="review-navigator-status" data-status={row.reviewStatus}>{statusLabel}</span>
                      {row.id === selectedId && (
                        <span className="review-navigator-row-selected" aria-hidden="true">当前选中</span>
                      )}
                      {manual && <span className="review-navigator-manual">人工调整</span>}
                      {previewLabel && <span className="review-navigator-preview" data-preview-status={row.previewStatus}>{previewLabel}</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div ref={emptyStateRef} className="review-navigator-empty" tabIndex={-1}>
          <span role="status">{safeRows.length === 0 ? (emptyMessage?.trim() || '暂无命中片段') : '当前筛选下没有命中片段'}</span>
          {safeRows.length === 0 && emptyActionLabel && onEmptyAction && (
            <button type="button" className="ghost-button" onClick={onEmptyAction}>{emptyActionLabel}</button>
          )}
        </div>
      )}
    </section>
  );
}

export default ReviewNavigator;
