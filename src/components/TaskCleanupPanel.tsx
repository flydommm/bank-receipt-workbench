import { useEffect, useState, type ReactElement } from 'react';

import type { BatchCleanup, BatchStorageUsage } from '../domain/batchCleanup';
import './TaskCleanupPanel.css';

export type TaskCleanupPanelProps = {
  open: boolean;
  onClose: () => void;
  plan: BatchCleanup | null;
  history: BatchCleanup[];
  usage: BatchStorageUsage | null;
  busy: boolean;
  locked: boolean;
  error: string | null;
  hasMore: boolean;
  onExecute: (cleanupId: string, deleteReview: boolean) => void;
  onRetry: (cleanup: BatchCleanup) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onMaintain: () => void;
  onCancelPlan: () => void;
};

const TASK_DATA_LABELS: Record<string, string> = {
  pending: '待清理',
  deleted: '已删除',
};

const REVIEW_LABELS: Record<string, string> = {
  pending: '待处理',
  deleted: '已删除',
  retained: '已保留',
  absent: '不存在',
  residual: '有残留',
};

const PREVIEW_LABELS: Record<string, string> = {
  pending: '待处理',
  cleaned: '已清理',
  absent: '不存在',
  residual: '有残留',
};

const OUTCOME_LABELS: Record<string, string> = {
  pending: '处理中或待重试',
  completed: '已完成',
};

function stateLabel(labels: Record<string, string>, value: string): string {
  return labels[value] ?? '状态未知';
}

function outcomeLabel(cleanup: BatchCleanup): string {
  return cleanup.outcome === 'pending' && cleanup.delete_review === null
    ? '待确认'
    : stateLabel(OUTCOME_LABELS, cleanup.outcome);
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value || '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(timestamp);
}

function formatBytes(value: number | null): string {
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let index = -1;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(amount)} ${units[index]}`;
}

function noticeLabel(code: string): string {
  switch (code) {
    case 'review_retained': return '人工审核记录已保留。';
    case 'review_changed': return '计划生成后审核记录发生变化，已按当前状态处理。';
    case 'review_residual': return '审核记录清理存在残留，请使用原选择重试。';
    case 'preview_residual': return '预览清理存在残留，请重试。';
    default: return '清理返回了未细化的提示，请查看分项状态或重试。';
  }
}

function retryable(item: BatchCleanup): boolean {
  // The host persists delete_review before any destructive step.  A crash can
  // therefore leave every sub-state pending while the durable choice still
  // makes the record safe to retry.
  return item.outcome === 'pending' && item.delete_review !== null;
}

function SummaryRow({ label, value }: { label: string; value: string | number }): ReactElement {
  return <div className="task-cleanup-summary-row"><dt>{label}</dt><dd>{value}</dd></div>;
}

function CleanupState({ plan }: { plan: BatchCleanup }): ReactElement {
  return (
    <dl className="task-cleanup-states" aria-label="清理分项状态">
      <SummaryRow label="任务数据" value={stateLabel(TASK_DATA_LABELS, plan.task_data_state)} />
      <SummaryRow label="审核记录" value={stateLabel(REVIEW_LABELS, plan.review_state)} />
      <SummaryRow label="预览文件" value={stateLabel(PREVIEW_LABELS, plan.preview_state)} />
      <SummaryRow label="总体结果" value={outcomeLabel(plan)} />
    </dl>
  );
}

function StorageUsage({ usage }: { usage: BatchStorageUsage | null }): ReactElement {
  if (!usage || !usage.available) {
    return <p className="task-cleanup-unavailable" role="status">空间占用信息暂不可用。</p>;
  }
  const quotaState = usage.within_quota === null ? '配额状态未知' : usage.within_quota ? '在配额内' : '已超过配额';
  return (
    <dl className="task-cleanup-usage" aria-label="空间占用">
      <SummaryRow label="数据库" value={formatBytes(usage.database_bytes)} />
      <SummaryRow label="预写日志" value={formatBytes(usage.wal_bytes)} />
      <SummaryRow label="共享内存" value={formatBytes(usage.shm_bytes)} />
      <SummaryRow label="合计" value={formatBytes(usage.total_bytes)} />
      <SummaryRow label="配额" value={formatBytes(usage.quota_bytes)} />
      <SummaryRow label="配额状态" value={quotaState} />
    </dl>
  );
}

export function TaskCleanupPanel({
  open,
  onClose,
  plan,
  history,
  usage,
  busy,
  locked,
  error,
  hasMore,
  onExecute,
  onRetry,
  onRefresh,
  onLoadMore,
  onMaintain,
  onCancelPlan,
}: TaskCleanupPanelProps): ReactElement | null {
  const [deleteReview, setDeleteReview] = useState(false);

  useEffect(() => {
    setDeleteReview(false);
  }, [plan?.cleanup_id, plan?.job_id, plan?.review_exclusive, plan?.review_record_count, plan?.delete_review, plan?.outcome]);

  if (!open) return null;

  const canChooseReview = Boolean(plan && plan.outcome === 'pending' && plan.delete_review === null
    && plan.review_exclusive && plan.review_record_count > 0);
  const canExecute = Boolean(plan && plan.outcome === 'pending' && plan.delete_review === null
    && plan.task_data_state === 'pending');
  const canCancelPlan = Boolean(plan && plan.outcome === 'pending' && plan.delete_review === null);
  const mutationsDisabled = busy || locked;

  return (
    <aside className="task-cleanup-panel" role="complementary" aria-label="任务清理与空间" aria-busy={busy}>
      <div className="task-cleanup-header">
        <div>
          <p className="task-cleanup-eyebrow">历史任务维护</p>
          <h2>任务清理与空间</h2>
        </div>
        <button className="task-cleanup-close" type="button" aria-label="关闭任务清理" onClick={onClose}>
          关闭
        </button>
      </div>

      {error && <p className="task-cleanup-error" role="alert">{error}</p>}

      <section className="task-cleanup-section" aria-labelledby="task-cleanup-plan-title">
        <div className="task-cleanup-section-heading">
          <div>
            <p className="task-cleanup-eyebrow">本次清理范围</p>
            <h3 id="task-cleanup-plan-title">当前清理计划</h3>
          </div>
          {plan && <span className="task-cleanup-chip">{outcomeLabel(plan)}</span>}
        </div>

        {plan ? (
          <>
            <div className="task-cleanup-plan-title">
              <strong>{plan.job_name}</strong>
              <span>计划更新时间：{formatTimestamp(plan.updated_at)}</span>
            </div>
            <dl className="task-cleanup-summary" aria-label="清理范围统计">
              <SummaryRow label="来源文件" value={`${plan.source_count} 个`} />
              <SummaryRow label="页结果" value={`${plan.page_result_count} 条`} />
              <SummaryRow label="审核记录" value={`${plan.review_record_count} 条`} />
              <SummaryRow label="预览文件" value={`${plan.preview_count} 个`} />
            </dl>
            <p className="task-cleanup-retention">
              默认保留人工审核、关键词历史、原始 PDF 和已导出的文件。
            </p>
            {canChooseReview ? (
              <label className="task-cleanup-review-option">
                <input
                  id="task-cleanup-delete-review"
                  type="checkbox"
                  checked={deleteReview}
                  onChange={(event) => setDeleteReview(event.target.checked)}
                  disabled={mutationsDisabled}
                />
                <span>同时删除该任务独占的审核记录</span>
              </label>
            ) : plan.review_record_count > 0 && !plan.review_exclusive ? (
              <p className="task-cleanup-note">审核记录并非本任务独占，将保留。</p>
            ) : plan.review_record_count > 0 && plan.delete_review !== null ? (
              <p className="task-cleanup-note">
                本次计划已{plan.delete_review ? '选择删除' : '选择保留'}审核记录；重试时沿用已保存的选择。
              </p>
            ) : (
              <p className="task-cleanup-note">没有可删除的独占审核记录。</p>
            )}
            <CleanupState plan={plan} />
            {plan.notice_codes.length > 0 && (
              <ul className="task-cleanup-notices" aria-label="清理提示">
                {plan.notice_codes.map((code, index) => <li key={`${code}-${index}`}>{noticeLabel(code)}</li>)}
              </ul>
            )}
            <div className="task-cleanup-actions">
              <button
                className="task-cleanup-primary"
                type="button"
                disabled={!canExecute || mutationsDisabled}
                onClick={() => onExecute(plan.cleanup_id, deleteReview)}
              >
                确认删除任务
              </button>
              {canCancelPlan && (
                <button type="button" disabled={mutationsDisabled} onClick={onCancelPlan}>取消计划</button>
              )}
            </div>
          </>
        ) : (
          <p className="task-cleanup-empty" role="status">请从任务历史选择一个已停止的任务，生成清理计划。</p>
        )}
      </section>

      <section className="task-cleanup-section" aria-labelledby="task-cleanup-history-title">
        <div className="task-cleanup-section-heading">
          <div>
            <p className="task-cleanup-eyebrow">持久记录</p>
            <h3 id="task-cleanup-history-title">清理历史</h3>
          </div>
          <button type="button" disabled={mutationsDisabled} onClick={onRefresh}>刷新</button>
        </div>
        {history.length === 0 ? (
          <p className="task-cleanup-empty">还没有清理记录。</p>
        ) : (
          <ul className="task-cleanup-history" aria-label="清理历史列表">
            {history.map((item) => (
              <li key={item.cleanup_id} className="task-cleanup-history-item">
                <div>
                  <strong>{item.job_name}</strong>
                  <span>{outcomeLabel(item)} · 任务数据{stateLabel(TASK_DATA_LABELS, item.task_data_state)}</span>
                  <span>审核：{stateLabel(REVIEW_LABELS, item.review_state)} · 预览：{stateLabel(PREVIEW_LABELS, item.preview_state)}</span>
                </div>
                {retryable(item) && (
                  <button type="button" disabled={mutationsDisabled} onClick={() => onRetry(item)}>
                    重试清理 {item.job_name}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {hasMore && <button className="task-cleanup-load-more" type="button" disabled={mutationsDisabled} onClick={onLoadMore}>加载更多</button>}
      </section>

      <section className="task-cleanup-section" aria-labelledby="task-cleanup-storage-title">
        <div className="task-cleanup-section-heading">
          <div>
            <p className="task-cleanup-eyebrow">本地持久化</p>
            <h3 id="task-cleanup-storage-title">空间占用</h3>
          </div>
          <button type="button" disabled={mutationsDisabled} onClick={onMaintain}>维护存储</button>
        </div>
        <StorageUsage usage={usage} />
      </section>
    </aside>
  );
}
