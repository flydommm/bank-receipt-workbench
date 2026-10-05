import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReceiptBatchPreparedReview, ReceiptBatchReviewPageItem } from '../domain/receiptBatch';
import { defaultReceiptExportName, normalizeExportName, validateExportName } from '../domain/exportNaming';
import { ExportBundleClient, type ExportBundlePreview, type ExportBundleReceipt, type ReceiptExportOutputMode } from '../services/exportBundleClient';
import { isReceiptExcluded, needsReceiptReview } from '../services/receiptCalibrationController';
import { localEngineAdapter } from './localEngineAdapter';
import type { ReceiptGroupingSnapshot } from '../domain/receiptGrouping';
import { readReceiptExportMode, writeReceiptExportMode } from '../domain/receiptExportPreferences';
import type { ExportProgress } from '../services/exportProgress';
import { formatExportElapsed, ReceiptExportProgress } from './ReceiptExportProgress';
import './ReceiptExportWorkspace.css';

export type ReceiptExportWorkspaceProps = {
  prepared: ReceiptBatchPreparedReview;
  items: ReceiptBatchReviewPageItem[];
  onClose: () => void;
  onRemoveSources?: () => void;
  initialOutputDirectory?: string | null;
  onExportSuccess?: (directory: string) => void;
  grouping?: ReceiptGroupingSnapshot | null;
};
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message
  : typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : fallback;

/** An export belongs to one task, analysis context and exact set of reviewed records. */
export function receiptExportContextKey(prepared: ReceiptBatchPreparedReview, items: ReceiptBatchReviewPageItem[], grouping?: ReceiptGroupingSnapshot | null): string {
  return JSON.stringify([prepared.binding.job.id, prepared.binding.contextKey, prepared.prepared?.context_key,
    prepared.prepared?.result_revision, items.map((item) => [item.original.id, item.record_revision,
      item.record?.review_status, item.original.needs_review]), grouping ? [grouping.header.grouping_revision,
      grouping.header.review_fingerprint, grouping.header.own_account.fingerprint] : null]);
}

type ExportAttempt = { key: string; bundle: ExportBundlePreview; directory: string };

export function ReceiptExportWorkspace({ prepared, items, onClose, onRemoveSources, initialOutputDirectory, onExportSuccess, grouping }: ReceiptExportWorkspaceProps) {
  const job = prepared.binding.job;
  const suggestedName = defaultReceiptExportName(job.sources.map((source) => source.name),
    job.processing_options?.processing_mode ?? 'search', job.criteria?.include ?? []);
  const [mode, setMode] = useState<ReceiptExportOutputMode>(() => readReceiptExportMode(grouping ? 'grouping' : 'regular'));
  const [includeCounterpartyPending, setIncludeCounterpartyPending] = useState(false);
  const [outputName, setOutputName] = useState(suggestedName);
  const [includeXlsx, setIncludeXlsx] = useState(false);
  const [includeManifest, setIncludeManifest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exportStage, setExportStage] = useState<'preparing' | 'generating' | 'saving'>('preparing');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);
  const progressReceiver = useRef<((value: ExportProgress) => void) | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ExportBundleReceipt | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const attempt = useRef<ExportAttempt | null>(null);
  const client = useMemo(() => new ExportBundleClient(undefined, { expectedReceiptSchema: 2,
    onProgress: (value) => progressReceiver.current?.(value) }), []);
  const hasPending = items.some(needsReceiptReview) || Boolean(grouping && (grouping.header.counts.own_pending
    || grouping.header.counts.extraction_pending || grouping.header.counts.stale));
  const exportableItems = hasPending ? [] : items.filter((item) => !isReceiptExcluded(item));
  // Grouped exports always stay on a grouped mode, even if this workspace is
  // mounted after a non-grouped export. This keeps the grouping snapshot
  // binding on both grouped output choices.
  const groupedOutputMode: ReceiptExportOutputMode = grouping
    ? (mode === 'by_counterparty_merged' ? mode : 'by_counterparty') : mode;
  const regularOutputMode: ReceiptExportOutputMode = mode === 'by_source' || mode === 'both' || mode === 'merged' ? mode : 'merged';
  const contextKey = receiptExportContextKey(prepared, items, grouping);
  const currentContext = useRef(contextKey);
  const contextEpoch = useRef(0);
  if (currentContext.current !== contextKey) { currentContext.current = contextKey; contextEpoch.current += 1; }
  const nameError = validateExportName(outputName);
  const resultRevision = prepared.prepared?.result_revision ?? '';

  function releaseAttempt() {
    const previous = attempt.current;
    attempt.current = null;
    if (previous) void client.close(previous.bundle.intent_id).catch(() => undefined);
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; progressReceiver.current = null; if (!inFlight.current) releaseAttempt(); };
  }, [client]);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      if (startedAt.current !== null) setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    // In-flight work owns its bundle until its response arrives; never close a publishing intent underneath it.
    if (!inFlight.current) releaseAttempt();
    setOutputName(suggestedName); setMessage(null); setReceipt(null); setRetrying(false); setProgress(null);
  }, [contextKey, suggestedName]);

  function changeOptions(change: () => void) {
    if (inFlight.current || retrying) return;
    releaseAttempt(); setReceipt(null); setMessage(null); setProgress(null); setElapsed(0); change();
  }
  async function exportFiles(): Promise<void> {
    if (inFlight.current || hasPending || !exportableItems.length || !resultRevision || nameError
        || (grouping && grouping.header.counts.counterparty_pending > 0 && !includeCounterpartyPending)) return;
    const requestContext = contextKey;
    const requestEpoch = contextEpoch.current;
    const stillCurrent = () => mounted.current && currentContext.current === requestContext && contextEpoch.current === requestEpoch;
    inFlight.current = true; setBusy(true); setExportStage('preparing'); setMessage(null); setProgress(null); setElapsed(0);
    startedAt.current = Date.now();
    progressReceiver.current = (value) => { if (stillCurrent()) setProgress(value); };
    let owned: ExportAttempt | null = attempt.current;
    try {
      if (!owned) {
        const directory = (await localEngineAdapter.pickOutputFolder(initialOutputDirectory))?.trim();
        if (!stillCurrent() || !directory) return;
        setExportStage('generating');
        setProgress({ stage: 'validating', completed: null, total: null, unit: null });
        const bundle = await client.create({ job_id: job.id, result_revision: resultRevision, scope_kind: 'list',
          selected_segment_ids: exportableItems.map((item) => item.original.id),
          expected_records: exportableItems.map((item) => ({ id: item.original.id, record_revision: item.record_revision })),
          output_mode: grouping ? groupedOutputMode : regularOutputMode, include_xlsx: grouping ? true : includeXlsx, include_manifest: includeManifest,
          output_name: normalizeExportName(outputName), ...(grouping ? {
            expected_grouping_revision: grouping.header.grouping_revision, expected_review_fingerprint: grouping.header.review_fingerprint!,
            own_account_fingerprint: grouping.header.own_account.fingerprint, include_counterparty_pending: includeCounterpartyPending,
          } : {}) });
        owned = { key: requestContext, bundle, directory };
        if (!stillCurrent()) return;
        attempt.current = owned;
      }
      if (!stillCurrent() || owned.key !== requestContext) return;
      // Retrying reuses the same intent and directory, including an uncertain native response.
      // The backend recovers an already-published transaction instead of creating a second export.
      setExportStage('saving');
      setProgress({ stage: 'saving', completed: null, total: null, unit: null });
      const published = await client.publish(owned.bundle, owned.directory);
      if (!stillCurrent()) return;
      setReceipt(published); setRetrying(false);
      onExportSuccess?.(owned.directory);
    } catch (error) {
      if (stillCurrent()) {
        setRetrying(owned !== null);
        const detail = errorText(error, '导出未完成，请重试。');
        setMessage(detail.includes('local engine operation timed out')
          ? owned
            ? '保存导出结果超时，尚未确认是否全部完成。请点击“重试导出”，系统会核对本次结果，避免重复导出。'
            : '生成 PDF 超时，本次导出未完成。已核对的回单和分组仍保留，可以重试。'
          : detail);
      }
    } finally {
      if (!stillCurrent() && owned) {
        if (attempt.current === owned) attempt.current = null;
        void client.close(owned.bundle.intent_id).catch(() => undefined);
      }
      inFlight.current = false;
      progressReceiver.current = null;
      if (mounted.current) {
        setBusy(false); setProgress(null);
        if (startedAt.current !== null) setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
      }
      startedAt.current = null;
    }
  }
  const controlsDisabled = busy || retrying;
  return <section className="receipt-export-workspace panel" aria-label="导出设置" aria-busy={busy}>
    <header><h2>导出设置</h2><button type="button" disabled={busy} onClick={() => { if (!inFlight.current) onClose(); }}>{grouping ? '返回交易对手核对' : '返回检查'}</button></header>
    <div className="receipt-export-options">
      {!hasPending && <p>本次导出 {exportableItems.length} 处。</p>}
      <label className="receipt-export-field">导出名称<input type="text" value={outputName} disabled={controlsDisabled}
        aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'receipt-export-name-error' : undefined}
        onChange={(e) => changeOptions(() => setOutputName(e.target.value))} /></label>
      {nameError && <p id="receipt-export-name-error" role="alert">{nameError}</p>}
      <p className="receipt-export-hint">{grouping ? (groupedOutputMode === 'by_counterparty_merged'
        ? '用于导出文件夹和合并 PDF 的名称；按分组连续排列，并附总核对表。'
        : '用于导出文件夹的名称；每个交易对手和特殊类别各存一个 PDF，并附总核对表。') : '用于导出文件夹和合并 PDF 的名称；文件夹会附加导出时间。'}</p>
      {grouping && <label className="receipt-export-field">导出方式<select value={groupedOutputMode} disabled={controlsDisabled} onChange={(e) => changeOptions(() => {
        const nextMode = e.target.value as ReceiptExportOutputMode;
        setMode(nextMode); writeReceiptExportMode('grouping', nextMode);
      })}>
        <option value="by_counterparty_merged">合并为一个PDF</option><option value="by_counterparty">每组一个 PDF</option>
      </select></label>}
      {!grouping && <><label className="receipt-export-field">导出方式<select value={regularOutputMode} disabled={controlsDisabled} onChange={(e) => changeOptions(() => {
        const nextMode = e.target.value as ReceiptExportOutputMode;
        setMode(nextMode); writeReceiptExportMode('regular', nextMode);
      })}>
        <option value="merged">合并为一个 PDF</option><option value="by_source">按来源分别导出 PDF</option><option value="both">合并版和来源版</option>
      </select></label>
      <label><input type="checkbox" checked={includeXlsx} disabled={controlsDisabled} onChange={(e) => changeOptions(() => setIncludeXlsx(e.target.checked))} />同时导出 XLSX 索引</label></>}
      {grouping && <p>总核对表会列明每个片段的原文件、页码、栏位及导出文件和页码。已排除片段单列。</p>}
      {grouping && grouping.header.counts.counterparty_pending > 0 && <label><input type="checkbox" checked={includeCounterpartyPending} disabled={controlsDisabled}
        onChange={(e) => changeOptions(() => setIncludeCounterpartyPending(e.target.checked))} />将 {grouping.header.counts.counterparty_pending} 个交易对手待确认片段{groupedOutputMode === 'by_counterparty_merged' ? '纳入合并 PDF 末尾' : '另存为 PDF'}。未勾选时请返回完成归组。</label>}
      <label><input type="checkbox" checked={includeManifest} disabled={controlsDisabled} onChange={(e) => changeOptions(() => setIncludeManifest(e.target.checked))} />同时导出清单 JSON</label>
      {message && <p role="alert">{message}</p>}
      {receipt && <div className="receipt-export-success" role="status"><p>已生成 {receipt.files.length} 个文件，共 {receipt.total_pages} 页。</p><p>导出用时 {formatExportElapsed(elapsed)}</p><p>{receipt.directory}</p></div>}
    </div>
    {busy && <ReceiptExportProgress progress={progress} elapsed={elapsed} waitingForDirectory={exportStage === 'preparing'} />}
    <div className="receipt-export-actions" role="group" aria-label="导出操作">
      {receipt ? onRemoveSources && <button type="button" className="primary" disabled={busy} onClick={() => { if (!inFlight.current) onRemoveSources(); }}>移除本次来源</button>
        : exportableItems.length > 0 && <button type="button" className="primary" disabled={busy || Boolean(nameError) || !resultRevision
          || Boolean(grouping && grouping.header.counts.counterparty_pending > 0 && !includeCounterpartyPending)}
          onClick={() => void exportFiles()}>{busy
            ? exportStage === 'saving' ? '正在保存导出文件…'
              : exportStage === 'generating' ? groupedOutputMode === 'by_counterparty' ? '正在生成各组 PDF…' : '正在生成 PDF…'
                : '正在准备导出…'
            : retrying ? '重试导出' : '选择目录并导出'}</button>}
    </div>
  </section>;
}
