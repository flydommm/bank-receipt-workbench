import { useId, useMemo, useState } from 'react';
import type { PdfRect } from '../domain/cropReview';
import type {
  ReceiptBatchReviewPageItem,
  ReceiptBatchJobSnapshot,
} from '../domain/receiptBatch';
import type {
  ReceiptReviewRecord,
  ReceiptSnapshotEvidence,
} from '../domain/receiptReview';
import './ReceiptBatchReviewPanel.css';

/**
 * Optional display metadata for a schema-3 source.  The review manifest keeps
 * the stable source key and path, while the human friendly name belongs to
 * the task/source list and can be supplied here by the caller.
 */
export type ReceiptBatchReviewPanelSource = {
  source_key: string;
  source_path?: string;
  name?: string;
};

/**
 * A schema-3 review item with UI-only metadata attached.  `record` is null
 * for a fresh automatic result; the panel intentionally treats that as an
 * unrecorded result and never labels it as saved.
 */
export type ReceiptBatchReviewPanelItem = Omit<ReceiptBatchReviewPageItem, 'record'> & {
  record?: ReceiptReviewRecord | null;
  sourceName?: string;
  sourcePath?: string;
  matchedField?: string | null;
  evidence?: readonly ReceiptSnapshotEvidence[];
};

/**
 * Small, already-normalized card input for callers that have an adapter of
 * their own.  Schema-3 `ReceiptBatchReviewPanelItem` remains the preferred
 * input because it preserves the immutable original and optional record.
 */
export type ReceiptBatchReviewCardItem = {
  id: string;
  sourceKey: string;
  sourceName?: string;
  sourcePath?: string;
  page: number;
  slotId?: string;
  positionIndex?: number;
  candidateRect?: PdfRect | null;
  pageWidth?: number;
  pageHeight?: number;
  status?: 'automatic' | 'pending' | 'needs_review' | 'confirmed' | 'page_confirmed' | 'blocked' | 'excluded';
  matchedField?: string | null;
};

export type ReceiptBatchReviewPanelProps = {
  /** The authoritative schema-3 page items, already validated by the client. */
  items?: readonly ReceiptBatchReviewPanelItem[];
  /** Alias useful to adapters that call the same collection “results”. */
  results?: readonly ReceiptBatchReviewPanelItem[];
  /** Human friendly names for source keys; item-level metadata takes priority. */
  sources?: readonly ReceiptBatchReviewPanelSource[];
  /** A controlled selected item. Omit it to use the panel's local selection. */
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Kept as an alias for small adapters; both callbacks receive the item id. */
  onSelectItem?: (id: string) => void;
  onEnterFineTune?: () => void;
  onExport?: () => void;
  onBack?: () => void;
  busy?: boolean;
  className?: string;
  /** Optional job metadata for a useful accessible label/title. */
  job?: Pick<ReceiptBatchJobSnapshot, 'name'>;
};

type PanelStatus = ReceiptBatchReviewCardItem['status'];

type PanelRow = {
  id: string;
  sourceKey: string;
  sourceName: string;
  sourcePath?: string;
  page: number;
  slotId: string;
  positionIndex: number;
  candidateRect: PdfRect | null;
  pageWidth: number;
  pageHeight: number;
  status: PanelStatus;
  record: ReceiptReviewRecord | null;
  finalRect: PdfRect | null;
  layoutId: string;
  layoutRevision: number;
  needsFineTune: boolean;
  occupancy: 'occupied' | 'uncertain' | undefined;
  selectionBasis: 'keyword' | 'occupied_slot' | 'manual_slot' | undefined;
  matchedField: string | null;
  evidenceCount: number;
};

type SourceGroup = {
  key: string;
  name: string;
  path?: string;
  pages: PageGroup[];
};

type PageGroup = {
  page: number;
  rows: PanelRow[];
};

const STATUS_LABELS: Record<NonNullable<PanelStatus>, string> = {
  automatic: '自动候选',
  pending: '待确认',
  needs_review: '需要微调',
  confirmed: '已确认',
  page_confirmed: '页面已确认',
  blocked: '已阻塞',
  excluded: '已排除',
};

const SELECTION_BASIS_LABELS: Record<NonNullable<PanelRow['selectionBasis']>, string> = {
  keyword: '关键词命中',
  occupied_slot: '整版栏位',
  manual_slot: '人工指定栏位',
};

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finitePage(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function finitePosition(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/0+$/, '').replace(/\.$/, '');
}

function formatRect(rect: PdfRect | null): string {
  if (!rect) return '无候选框';
  return `(${formatNumber(rect.x0)}, ${formatNumber(rect.y0)}) – (${formatNumber(rect.x1)}, ${formatNumber(rect.y1)}) pt`;
}

function isSchemaItem(item: ReceiptBatchReviewPanelItem): item is ReceiptBatchReviewPanelItem & {
  original: ReceiptBatchReviewPageItem['original'];
} {
  return Boolean(item && typeof item === 'object' && item.original && typeof item.original === 'object');
}

function statusForOriginal(item: ReceiptBatchReviewPanelItem): PanelStatus {
  if (item.record) return item.record.review_status;
  return item.original.needs_review ? 'needs_review' : 'automatic';
}

function rowNeedsFineTune(status: PanelStatus): boolean {
  return status === 'pending' || status === 'needs_review' || status === 'blocked';
}

function sourceFallback(sourceKey: string): string {
  return basename(sourceKey) || '未命名来源';
}

function normalizeRows(
  items: readonly ReceiptBatchReviewPanelItem[],
  sources: readonly ReceiptBatchReviewPanelSource[],
): PanelRow[] {
  const sourceMap = new Map(sources.map((source) => [source.source_key, source]));

  return items.flatMap((item) => {
    if (!isSchemaItem(item)) return [];
    const original = item.original;
    const source = sourceMap.get(original.source_key);
    const sourcePath = item.sourcePath ?? source?.source_path;
    const sourceName = item.sourceName?.trim()
      || source?.name?.trim()
      || (sourcePath ? basename(sourcePath) : sourceFallback(original.source_key));
    const status = statusForOriginal(item);
    const geometry = original.page_geometry;
    return [{
      id: original.id,
      sourceKey: original.source_key,
      sourceName,
      sourcePath,
      page: finitePage(original.source_page),
      slotId: original.slot_id,
      positionIndex: finitePosition(original.position_index),
      candidateRect: original.candidate_rect,
      pageWidth: finitePositive(geometry.width_pt, 1),
      pageHeight: finitePositive(geometry.height_pt, 1),
      status,
      record: item.record ?? null,
      // A confirmed full-page crop intentionally stores `final_rect: null`;
      // preserve that distinction instead of falling back to the candidate.
      finalRect: item.record ? item.record.final_rect : original.candidate_rect,
      layoutId: original.layout_id,
      layoutRevision: original.layout_revision,
      needsFineTune: rowNeedsFineTune(status),
      occupancy: original.occupancy,
      selectionBasis: original.selection_basis,
      matchedField: item.matchedField ?? null,
      evidenceCount: item.evidence?.length ?? 0,
    } satisfies PanelRow];
  });
}

function groupRows(rows: readonly PanelRow[]): SourceGroup[] {
  const sources = new Map<string, SourceGroup>();
  for (const row of rows) {
    let source = sources.get(row.sourceKey);
    if (!source) {
      source = { key: row.sourceKey, name: row.sourceName, path: row.sourcePath, pages: [] };
      sources.set(row.sourceKey, source);
    }
    let page = source.pages.find((candidate) => candidate.page === row.page);
    if (!page) {
      page = { page: row.page, rows: [] };
      source.pages.push(page);
    }
    page.rows.push(row);
  }

  for (const source of sources.values()) {
    source.pages.sort((left, right) => left.page - right.page);
    for (const page of source.pages) {
      page.rows.sort((left, right) => left.positionIndex - right.positionIndex || left.id.localeCompare(right.id));
    }
  }
  return [...sources.values()];
}

function statusLabel(status: PanelStatus): string {
  return status ? STATUS_LABELS[status] : '待确认';
}

function CandidatePreview({ row }: { row: PanelRow }) {
  const rect = row.finalRect;
  if (!rect) {
    return <div className="receipt-batch-review-row__candidate receipt-batch-review-row__candidate--empty" aria-label="无候选框">—</div>;
  }

  const left = Math.max(0, Math.min(100, (rect.x0 / row.pageWidth) * 100));
  const top = Math.max(0, Math.min(100, (rect.y0 / row.pageHeight) * 100));
  const right = Math.max(left, Math.min(100, (rect.x1 / row.pageWidth) * 100));
  const bottom = Math.max(top, Math.min(100, (rect.y1 / row.pageHeight) * 100));
  const label = `${row.record ? '已保存边界' : '候选框'} ${formatRect(rect)}`;

  return (
    <div className="receipt-batch-review-row__candidate" role="img" aria-label={label}>
      <span className="receipt-batch-review-row__paper" aria-hidden="true">
        <span
          className="receipt-batch-review-row__box"
          style={{ left: `${left}%`, top: `${top}%`, width: `${Math.max(0, right - left)}%`, height: `${Math.max(0, bottom - top)}%` }}
        />
      </span>
    </div>
  );
}

function ResultRow({ row, selected, onSelect }: { row: PanelRow; selected: boolean; onSelect: () => void }) {
  return (
    <li className="receipt-batch-review-row-item">
      <button
        type="button"
        className="receipt-batch-review-row"
        data-status={row.status}
        data-selected={selected ? 'true' : 'false'}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <div className="receipt-batch-review-row__lead">
          <span className="receipt-batch-review-row__index">{String(row.positionIndex).padStart(2, '0')}</span>
          <span className="receipt-batch-review-row__slot">栏位 {row.positionIndex}</span>
          <span className="receipt-batch-review-row__slot-id">{row.slotId}</span>
        </div>
        <CandidatePreview row={row} />
        <dl className="receipt-batch-review-row__meta">
          <div>
            <dt>来源</dt>
            <dd title={row.sourcePath ?? row.sourceKey}>{row.sourceName}</dd>
          </div>
          <div>
            <dt>页</dt>
            <dd>{`第 ${row.page} 页`}</dd>
          </div>
          <div>
            <dt>栏位</dt>
            <dd>{`第 ${row.positionIndex} 栏 · ${row.slotId}`}</dd>
          </div>
          <div>
            <dt>版式</dt>
            <dd>{`${row.layoutId} · 修订 ${row.layoutRevision}`}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>
              <span className="receipt-batch-review-status" data-status={row.status}>{statusLabel(row.status)}</span>
              {row.occupancy === 'uncertain' && <span className="receipt-batch-review-row__qualifier">版式待核实</span>}
            </dd>
          </div>
          <div className="receipt-batch-review-row__candidate-meta">
            <dt>候选框</dt>
            <dd>{formatRect(row.candidateRect)}</dd>
          </div>
          {(row.matchedField || row.selectionBasis || row.evidenceCount > 0) && (
            <div className="receipt-batch-review-row__basis">
              <dt>{row.matchedField ? '命中栏位' : '依据'}</dt>
              <dd>{row.matchedField ?? (row.selectionBasis ? SELECTION_BASIS_LABELS[row.selectionBasis] : `${row.evidenceCount} 条证据`)}</dd>
            </div>
          )}
        </dl>
      </button>
    </li>
  );
}

export function ReceiptBatchReviewPanel({
  items,
  results,
  sources = [],
  selectedId,
  onSelect,
  onSelectItem,
  onEnterFineTune = () => undefined,
  onExport = () => undefined,
  onBack = () => undefined,
  busy = false,
  className,
  job,
}: ReceiptBatchReviewPanelProps) {
  const titleId = useId();
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const rawItems = items ?? results ?? [];
  const rows = useMemo(() => normalizeRows(rawItems, sources), [rawItems, sources]);
  const groups = useMemo(() => groupRows(rows), [rows]);
  const activeSelectedId = selectedId === undefined ? localSelectedId : selectedId;
  const unresolvedCount = rows.filter((row) => row.needsFineTune).length;
  const canExport = rows.some((row) => row.status !== 'excluded') && unresolvedCount === 0;
  const primaryAction = canExport ? onExport : onEnterFineTune;
  const primaryLabel = canExport ? '直接导出' : '进入微调';
  const actionDisabled = busy || rows.length === 0;
  const panelClassName = ['receipt-batch-review-panel', className].filter(Boolean).join(' ');

  function selectRow(id: string): void {
    setLocalSelectedId(id);
    onSelect?.(id);
    onSelectItem?.(id);
  }

  return (
    <section className={panelClassName} aria-labelledby={titleId} data-unresolved-count={unresolvedCount}>
      <header className="receipt-batch-review-panel__header">
        <div className="receipt-batch-review-panel__heading">
          <p className="receipt-batch-review-panel__eyebrow">回单审核结果</p>
          <h2 id={titleId}>{job?.name ? `${job.name} · 分析完成` : '分析完成'}</h2>
          <p className="receipt-batch-review-panel__status" role="status" aria-live="polite">
            {unresolvedCount === 0 ? '无需微调，可直接导出' : `${unresolvedCount} 个候选需要微调后再导出`}
          </p>
        </div>
        <div className="receipt-batch-review-panel__stamp" aria-hidden="true">
          <span>{String(rows.length).padStart(2, '0')}</span>
          <small>候选</small>
        </div>
      </header>

      <div className="receipt-batch-review-panel__summary" aria-label="分析摘要">
        <span><strong>{rows.length}</strong> 个候选</span>
        <span><strong>{groups.length}</strong> 个来源</span>
        <span><strong>{unresolvedCount}</strong> 个需微调</span>
      </div>

      <div className="receipt-batch-review-panel__actions" aria-label="结果操作">
        <button
          type="button"
          className="receipt-batch-review-panel__primary"
          disabled={actionDisabled}
          onClick={primaryAction}
          aria-busy={busy || undefined}
        >
          {busy ? '正在处理…' : primaryLabel}
        </button>
        <button type="button" className="receipt-batch-review-panel__back" disabled={busy} onClick={onBack}>
          返回
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="receipt-batch-review-panel__empty" role="status">
          没有可显示的回单候选。
        </div>
      ) : (
        <div className="receipt-batch-review-panel__groups" aria-label="按来源和页码分组的候选结果">
          {groups.map((source, sourceIndex) => {
            const sourceHeadingId = `${titleId}-source-${sourceIndex}`;
            const count = source.pages.reduce((total, page) => total + page.rows.length, 0);
            return (
              <section className="receipt-batch-review-source" key={source.key} aria-labelledby={sourceHeadingId}>
                <header className="receipt-batch-review-source__header">
                  <div>
                    <p className="receipt-batch-review-source__kicker">来源 {String(sourceIndex + 1).padStart(2, '0')}</p>
                    <h3 id={sourceHeadingId} title={source.path ?? source.key}>{source.name}</h3>
                  </div>
                  <span>{`${source.pages.length} 页 · ${count} 个候选`}</span>
                </header>
                <div className="receipt-batch-review-source__pages">
                  {source.pages.map((page) => (
                    <section className="receipt-batch-review-page" key={`${source.key}-${page.page}`} aria-label={`第 ${page.page} 页`}>
                      <header className="receipt-batch-review-page__header">
                        <h4>{`第 ${page.page} 页`}</h4>
                        <span>{`${page.rows.length} 个栏位`}</span>
                      </header>
                      <ul className="receipt-batch-review-page__list">
                        {page.rows.map((row) => (
                          <ResultRow
                            key={row.id}
                            row={row}
                            selected={activeSelectedId === row.id}
                            onSelect={() => selectRow(row.id)}
                          />
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <footer className="receipt-batch-review-panel__footer">
        {activeSelectedId ? '已选中一个候选，可进入微调查看边界。' : '选择候选可查看来源、栏位状态和候选框。'}
      </footer>
    </section>
  );
}

export default ReceiptBatchReviewPanel;
