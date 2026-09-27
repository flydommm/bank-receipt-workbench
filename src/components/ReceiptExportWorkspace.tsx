import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReceiptBatchPreparedReview, ReceiptBatchReviewPageItem } from '../domain/receiptBatch';
import { defaultReceiptExportName, normalizeExportName, validateExportName } from '../domain/exportNaming';
import { ExportBundleClient, type ExportBundlePreview, type ExportBundleReceipt } from '../services/exportBundleClient';
import { isReceiptExcluded, needsReceiptReview } from '../services/receiptCalibrationController';
import { localEngineAdapter } from './localEngineAdapter';
import type { ExportOutputMode } from '../domain/exportIntent';
import './ReceiptExportWorkspace.css';

export type ReceiptExportWorkspaceProps = {
  prepared: ReceiptBatchPreparedReview;
  items: ReceiptBatchReviewPageItem[];
  onClose: () => void;
  onRemoveSources?: () => void;
  initialOutputDirectory?: string | null;
  onExportSuccess?: (directory: string) => void;
};
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message
  : typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : fallback;

/** An export belongs to one task, analysis context and exact set of reviewed records. */
export function receiptExportContextKey(prepared: ReceiptBatchPreparedReview, items: ReceiptBatchReviewPageItem[]): string {
  return JSON.stringify([prepared.binding.job.id, prepared.binding.contextKey, prepared.prepared?.context_key,
    prepared.prepared?.result_revision, items.map((item) => [item.original.id, item.record_revision,
      item.record?.review_status, item.original.needs_review])]);
}

type ExportAttempt = { key: string; bundle: ExportBundlePreview; directory: string };

export function ReceiptExportWorkspace({ prepared, items, onClose, onRemoveSources, initialOutputDirectory, onExportSuccess }: ReceiptExportWorkspaceProps) {
  const job = prepared.binding.job;
  const suggestedName = defaultReceiptExportName(job.sources.map((source) => source.name),
    job.processing_options?.processing_mode ?? 'search', job.criteria?.include ?? []);
  const [mode, setMode] = useState<ExportOutputMode>('merged');
  const [outputName, setOutputName] = useState(suggestedName);
  const [includeXlsx, setIncludeXlsx] = useState(false);
  const [includeManifest, setIncludeManifest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ExportBundleReceipt | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const attempt = useRef<ExportAttempt | null>(null);
  const client = useMemo(() => new ExportBundleClient(undefined, { expectedReceiptSchema: 2 }), []);
  const hasPending = items.some(needsReceiptReview);
  const exportableItems = hasPending ? [] : items.filter((item) => !isReceiptExcluded(item));
  const contextKey = receiptExportContextKey(prepared, items);
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
    return () => { mounted.current = false; if (!inFlight.current) releaseAttempt(); };
  }, [client]);
  useEffect(() => {
    // In-flight work owns its bundle until its response arrives; never close a publishing intent underneath it.
    if (!inFlight.current) releaseAttempt();
    setOutputName(suggestedName); setMessage(null); setReceipt(null); setRetrying(false);
  }, [contextKey, suggestedName]);

  function changeOptions(change: () => void) {
    if (inFlight.current || retrying) return;
    releaseAttempt(); setReceipt(null); setMessage(null); change();
  }
  async function exportFiles(): Promise<void> {
    if (inFlight.current || hasPending || !exportableItems.length || !resultRevision || nameError) return;
    const requestContext = contextKey;
    const requestEpoch = contextEpoch.current;
    const stillCurrent = () => mounted.current && currentContext.current === requestContext && contextEpoch.current === requestEpoch;
    inFlight.current = true; setBusy(true); setMessage(null);
    let owned: ExportAttempt | null = attempt.current;
    try {
      if (!owned) {
        const directory = (await localEngineAdapter.pickOutputFolder(initialOutputDirectory))?.trim();
        if (!stillCurrent() || !directory) return;
        const bundle = await client.create({ job_id: job.id, result_revision: resultRevision, scope_kind: 'list',
          selected_segment_ids: exportableItems.map((item) => item.original.id),
          expected_records: exportableItems.map((item) => ({ id: item.original.id, record_revision: item.record_revision })),
          output_mode: mode, include_xlsx: includeXlsx, include_manifest: includeManifest, output_name: normalizeExportName(outputName) });
        owned = { key: requestContext, bundle, directory };
        if (!stillCurrent()) return;
        attempt.current = owned;
      }
      if (!stillCurrent() || owned.key !== requestContext) return;
      // Retrying reuses the same intent and directory, including an uncertain native response.
      // The backend recovers an already-published transaction instead of creating a second export.
      const published = await client.publish(owned.bundle, owned.directory);
      if (!stillCurrent()) return;
      setReceipt(published); setRetrying(false);
      onExportSuccess?.(owned.directory);
    } catch (error) {
      if (stillCurrent()) {
        setRetrying(owned !== null);
        setMessage(errorText(error, '导出未完成，请重试。'));
      }
    } finally {
      if (!stillCurrent() && owned) {
        if (attempt.current === owned) attempt.current = null;
        void client.close(owned.bundle.intent_id).catch(() => undefined);
      }
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const controlsDisabled = busy || retrying;
  return <section className="receipt-export-workspace panel" aria-label="导出设置" aria-busy={busy}>
    <header><h2>导出设置</h2><button type="button" disabled={busy} onClick={() => { if (!inFlight.current) onClose(); }}>返回检查</button></header>
    <div className="receipt-export-options">
      {!hasPending && <p>本次导出 {exportableItems.length} 处。</p>}
      <label className="receipt-export-field">导出名称<input type="text" value={outputName} disabled={controlsDisabled}
        aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'receipt-export-name-error' : undefined}
        onChange={(e) => changeOptions(() => setOutputName(e.target.value))} /></label>
      {nameError && <p id="receipt-export-name-error" role="alert">{nameError}</p>}
      <p className="receipt-export-hint">用于导出文件夹和合并 PDF 的名称；文件夹会附加导出时间。</p>
      <label className="receipt-export-field">导出方式<select value={mode} disabled={controlsDisabled} onChange={(e) => changeOptions(() => setMode(e.target.value as ExportOutputMode))}>
        <option value="merged">合并为一个 PDF</option><option value="by_source">按来源分别导出 PDF</option><option value="both">合并版和来源版</option>
      </select></label>
      <label><input type="checkbox" checked={includeXlsx} disabled={controlsDisabled} onChange={(e) => changeOptions(() => setIncludeXlsx(e.target.checked))} />同时导出 XLSX 索引</label>
      <label><input type="checkbox" checked={includeManifest} disabled={controlsDisabled} onChange={(e) => changeOptions(() => setIncludeManifest(e.target.checked))} />同时导出清单 JSON</label>
      {message && <p role="alert">{message}</p>}
      {receipt && <div className="receipt-export-success" role="status"><p>已生成 {receipt.files.length} 个文件，共 {receipt.total_pages} 页。</p><p>{receipt.directory}</p></div>}
    </div>
    <div className="receipt-export-actions" role="group" aria-label="导出操作">
      {receipt ? onRemoveSources && <button type="button" className="primary" disabled={busy} onClick={() => { if (!inFlight.current) onRemoveSources(); }}>移除本次来源</button>
        : exportableItems.length > 0 && <button type="button" className="primary" disabled={busy || Boolean(nameError) || !resultRevision}
          onClick={() => void exportFiles()}>{busy ? '正在导出…' : retrying ? '重试导出' : '选择目录并导出'}</button>}
    </div>
  </section>;
}
