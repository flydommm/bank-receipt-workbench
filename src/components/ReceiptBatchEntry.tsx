import type { ReceiptBatchState } from '../services/receiptBatchController';
import type { ReactNode } from 'react';
import './ReceiptBatchEntry.css';

export type ReceiptBatchProcessingMode = 'search' | 'split_all';

export type ReceiptBatchEntryProps = {
  mode: ReceiptBatchProcessingMode;
  onModeChange: (mode: ReceiptBatchProcessingMode) => void;
  state: ReceiptBatchState;
  resultCount?: number;
  unresolvedCount?: number;
  canAnalyze?: boolean;
  /** Keyword mode uses the criteria form's submit button. */
  showAnalyzeAction?: boolean;
  reviewLoading?: boolean;
  onAnalyze: () => void;
  onEnterReview: () => void;
  onExport: () => void;
  templateControls?: ReactNode;
};

function stateLabel(state: ReceiptBatchState): string {
  switch (state.phase) {
    case 'creating': return '正在创建回单任务…';
    case 'running': {
      const job = state.job;
      if (job?.state === 'queued') return '等待开始分析…';
      if (job?.state === 'validating') return '正在读取 PDF…';
      if (job?.state === 'finalizing') return '正在整理分析结果…';
      if (job?.state === 'pause_requested') return '正在暂停…';
      if (job?.state === 'cancel_requested') return '正在取消…';
      if (!job || job.total_pages === 0) return '正在分析回单…';
      const done = job.page_summary.succeeded + job.page_summary.failed;
      return `分析中 · ${done}/${job.total_pages} 页${job.page_summary.failed ? `（${job.page_summary.failed} 页失败）` : ''}`;
    }
    case 'ready': return '分析完成';
    case 'failed': return '分析失败';
    case 'cancelled': return '任务已取消';
    default: return '准备分析';
  }
}

export function ReceiptBatchEntry(props: ReceiptBatchEntryProps) {
  const running = props.state.phase === 'creating' || props.state.phase === 'running' || props.state.busy;
  const ready = props.state.phase === 'ready';
  const hasReviewSummary = props.unresolvedCount !== undefined;
  const unresolved = props.unresolvedCount ?? 0;
  const resultCount = props.resultCount ?? 0;

  return (
    <section className="receipt-batch-entry" aria-labelledby="receipt-batch-entry-title">
      <div className="receipt-batch-entry__header">
        <div>
          <h2 id="receipt-batch-entry-title">分析与分割</h2>
        </div>
        <span role="status" aria-live="polite">{props.reviewLoading ? '载入结果中' : stateLabel(props.state)}</span>
      </div>

      <fieldset disabled={running || props.reviewLoading} className="receipt-batch-entry__mode">
        <legend className="sr-only">处理方式</legend>
        <label>
          <input
            type="radio"
            name="receipt-processing-mode"
            value="split_all"
            checked={props.mode === 'split_all'}
            onChange={() => props.onModeChange('split_all')}
          />
          分割全部回单
        </label>
        <label>
          <input
            type="radio"
            name="receipt-processing-mode"
            value="search"
            checked={props.mode === 'search'}
            onChange={() => props.onModeChange('search')}
          />
          查找提取回单
        </label>
      </fieldset>

      {props.templateControls && <div className="receipt-batch-entry__templates">{props.templateControls}</div>}

      {props.state.error && (
        <div className="receipt-batch-entry__error" role="alert">{props.state.error}</div>
      )}

      {ready && (
        <div className="receipt-batch-entry__summary" role="status">
          {hasReviewSummary
            ? `共整理 ${resultCount} 个回单片段，${unresolved > 0 ? `${unresolved} 个需要复核` : '无需微调'}。`
            : `已分析 ${props.state.job?.page_summary.succeeded ?? 0} 页`}
        </div>
      )}

      {!ready && props.showAnalyzeAction !== false && (
        <button type="button" className="primary-button receipt-batch-entry__analyze-action" disabled={running || props.canAnalyze === false} onClick={props.onAnalyze}>
          {props.state.error ? '重新分析回单' : '开始回单分析'}
        </button>
      )}

      {ready && !hasReviewSummary && (
        <button type="button" className="primary-button" disabled={props.reviewLoading} onClick={props.onEnterReview}>
          查看任务结果
        </button>
      )}
      {ready && hasReviewSummary && unresolved > 0 && (
        <button type="button" className="primary-button" onClick={props.onEnterReview}>
          进入微调
        </button>
      )}
      {ready && hasReviewSummary && unresolved === 0 && (
        <>
          <button type="button" className="primary-button" onClick={props.onExport}>
            直接导出
          </button>
          <button type="button" className="ghost-button" onClick={props.onEnterReview}>
            进入微调
          </button>
        </>
      )}

    </section>
  );
}
