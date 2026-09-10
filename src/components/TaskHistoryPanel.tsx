import type {
  BatchJobSnapshot,
  BatchJobState,
  BatchJobSummary,
  BatchSourceSnapshot,
  JsonValue,
} from '../domain/batchTask';
import './TaskHistoryPanel.css';

export type TaskHistoryPanelProps = {
  open: boolean;
  onClose: () => void;
  jobs: BatchJobSummary[];
  selectedJob: BatchJobSnapshot | null;
  view?: TaskHistoryPanelView;
  onViewChange?: (view: TaskHistoryPanelView) => void;
  pendingSources?: readonly PendingTaskSource[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  hasMore: boolean;
  onRefresh: () => void;
  onLoadMore: () => void;
  onSelect: (id: string) => void;
  onResume: () => void;
  onPause: () => void;
  onCancel: () => void;
  onArchive: () => void;
  onLoadReview: () => void;
  onRelocate: (sourceId: string) => void;
  onDelete?: (jobId: string) => void;
  onOpenCleanup?: () => void;
  onNewTask?: () => void;
  newTaskDisabled?: boolean;
  /** Locks operations while another part of the app is saving or exporting. */
  locked?: boolean;
};

export type TaskHistoryPanelView = 'current' | 'history';

export type PendingTaskSource = {
  name: string;
  pageCount: number | null;
};

const ACTIVE_STATES = new Set<BatchJobState>([
  'validating',
  'running',
  'pause_requested',
  'finalizing',
  'cancel_requested',
]);

const RESUMABLE_STATES = new Set<BatchJobState>([
  'queued',
  'paused',
  'partial_failed',
  'blocked',
  'cancelled',
  'interrupted',
]);

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  pending: '待处理',
  registered: '已登记',
  verified: '已核验',
  failed: '失败',
  validating: '校验中',
  running: '运行中',
  pause_requested: '暂停中',
  paused: '已暂停',
  partial_failed: '部分失败',
  finalizing: '整理结果中',
  ready: '待审核',
  ready_for_review: '待审核',
  blocked: '已阻塞',
  cancel_requested: '停止中',
  cancelled: '已取消',
  interrupted: '已中断',
  archived: '已归档',
};

function statusLabel(state: string): string {
  return STATUS_LABELS[state] ?? state;
}

function isActive(state: BatchJobState): boolean {
  return ACTIVE_STATES.has(state);
}

function isReady(state: BatchJobState): boolean {
  return state === 'ready_for_review' || state === ('ready' as BatchJobState);
}

function isReviewable(state: BatchJobState): boolean {
  return isReady(state) || state === 'archived';
}

function criteriaSummary(criteria: BatchJobSnapshot['criteria']): string {
  const include = criteria.include.filter((keyword) => keyword.trim());
  const exclude = criteria.exclude.filter((keyword) => keyword.trim());
  const parts: string[] = [];

  if (include.length > 0) {
    parts.push(`${criteria.includeMode === 'all' ? '全部' : '任一'}包含：${include.join('、')}`);
  } else {
    parts.push('无包含条件');
  }
  if (exclude.length > 0) parts.push(`排除：${exclude.join('、')}`);

  return parts.join('；');
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value || '时间未知';

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

type FailureCopy = {
  reason: string;
  action: string;
};

export type TaskFailurePresentation = {
  reason: string;
  action: string;
  details: string | null;
};

const FAILURE_COPY: Record<string, FailureCopy> = {
  source_changed: {
    reason: '原始 PDF 内容或文件身份已变化。',
    action: '请选择内容相同的 PDF，或重新创建任务。',
  },
  file_not_found: {
    reason: '找不到原始 PDF 文件。',
    action: '请重新选择原始 PDF，或定位内容相同的文件。',
  },
  invalid_path: {
    reason: '原始 PDF 路径无效。',
    action: '请重新选择有效的 PDF 文件。',
  },
  invalid_page: {
    reason: 'PDF 页面信息无效。',
    action: '请检查 PDF 文件后重新分析。',
  },
  page_out_of_range: {
    reason: 'PDF 页面超出有效范围。',
    action: '请检查 PDF 文件后重新分析。',
  },
  page_limit_exceeded: {
    reason: 'PDF 页数超过当前任务限制。',
    action: '请拆分 PDF 后重新分析。',
  },
  search_failed: {
    reason: 'PDF 页面搜索失败。',
    action: '请重新分析；如果仍然失败，请检查 PDF 是否损坏或受密码保护。',
  },
  ocr_unavailable: {
    reason: 'OCR 运行时不可用。',
    action: '请点击“检测 OCR”重试，或改用包含文字层的可搜索 PDF。',
  },
  ocr_initialization_failed: {
    reason: 'OCR 初始化失败。',
    action: '请点击“检测 OCR”重试；如果仍然失败，请改用包含文字层的可搜索 PDF。',
  },
  ocr_inference_failed: {
    reason: 'OCR 识别验证失败。',
    action: '请点击“检测 OCR”重试；如果仍然失败，请改用包含文字层的可搜索 PDF。',
  },
  ocr_result_invalid: {
    reason: 'OCR 返回结果无效。',
    action: '请点击“检测 OCR”重试；如果仍然失败，请改用包含文字层的可搜索 PDF。',
  },
  search_budget_exceeded: {
    reason: '搜索资源超过当前任务限制。',
    action: '请减少文件或关键词数量，或拆分任务后重试。',
  },
  batch_capacity_exceeded: {
    reason: '任务存储空间不足。',
    action: '请清理已完成的历史任务后重试。',
  },
  batch_processing_failed: {
    reason: '批量处理失败。',
    action: '请刷新任务；如果仍然失败，请重新创建任务。',
  },
  batch_store_failed: {
    reason: '任务数据暂时无法读取或保存。',
    action: '请稍后刷新任务；如果仍然失败，请重新创建任务。',
  },
  batch_schema_incompatible: {
    reason: '任务数据来自不兼容的版本。',
    action: '请使用生成该任务的应用版本打开，或重新创建任务。',
  },
  batch_invalid_request: {
    reason: '任务请求或已保存数据无效。',
    action: '请刷新任务；如果仍然失败，请重新创建任务。',
  },
  computation_version_changed: {
    reason: '任务计算版本已变化。',
    action: '请重新创建任务后再分析。',
  },
};

const FAILURE_STAGE_LABELS: Record<string, string> = {
  validating: '校验来源',
  source_open: '打开来源',
  page: '分析页面',
  storage: '保存结果',
  final_source_verification: '最终核验',
  assembling: '整理结果',
};

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Convert host failure DTOs to stable user-facing Chinese copy. */
export function describeTaskFailure(value: JsonValue | null): TaskFailurePresentation | null {
  if (value === null) return null;
  if (typeof value === 'string') {
    return {
      reason: value.trim() || '任务处理失败。',
      action: '请刷新任务；如果仍然失败，请重新创建任务。',
      details: null,
    };
  }
  if (!isJsonRecord(value)) {
    return {
      reason: '任务处理失败，系统未提供可识别的原因。',
      action: '请刷新任务；如果仍然失败，请重新创建任务。',
      details: null,
    };
  }

  const code = typeof value.code === 'string' && value.code.trim() ? value.code.trim() : null;
  const stage = typeof value.stage === 'string' && value.stage.trim() ? value.stage.trim() : null;
  const copy = code ? FAILURE_COPY[code] : undefined;
  const stageLabel = stage ? FAILURE_STAGE_LABELS[stage] ?? stage : null;
  return {
    reason: copy?.reason ?? '任务处理失败，系统未提供可识别的原因。',
    action: copy?.action ?? '请刷新任务；如果仍然失败，请重新创建任务。',
    details: code || stageLabel
      ? `错误码：${code ?? '未知'}${stageLabel ? ` · 阶段：${stageLabel}` : ''}`
      : null,
  };
}

function sourceName(source: BatchSourceSnapshot): string {
  return source.name.trim() || source.access_path.trim() || source.initial_path.trim() || '未命名文件';
}

function sourcePath(source: BatchSourceSnapshot): string {
  return source.access_path.trim() || source.initial_path.trim() || '路径未知';
}

function pageCountText(summary: BatchJobSnapshot['page_summary'], totalPages: number): string {
  return `成功 ${summary.succeeded} 页 · 失败 ${summary.failed} 页 · 共 ${totalPages} 页`;
}

function sourcePageCountText(source: BatchSourceSnapshot): string {
  const total = source.page_count ?? source.page_summary.pending + source.page_summary.processing
    + source.page_summary.succeeded + source.page_summary.failed;
  return `成功 ${source.page_summary.succeeded} / ${total} 页 · 失败 ${source.page_summary.failed} 页`;
}

function pendingSourceName(source: PendingTaskSource): string {
  return source.name.trim() || '未命名文件';
}

function pendingSourcePageCountText(source: PendingTaskSource): string {
  return source.pageCount === null ? '页数待分析' : `${source.pageCount} 页 · 已读取`;
}

function JobSummaryItem({
  job,
  selected,
  disabled,
  onSelect,
}: {
  job: BatchJobSummary;
  selected: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <li className="task-history-job-item">
      <button
        className="task-history-job-button"
        type="button"
        aria-pressed={selected}
        aria-label={`选择任务 ${job.name}`}
        disabled={disabled}
        onClick={() => onSelect(job.id)}
      >
        <span className="task-history-job-button-topline">
          <strong className="task-history-job-name" title={job.name}>{job.name}</strong>
          <span className="task-history-status" data-state={job.state}>{statusLabel(job.state)}</span>
        </span>
        <span className="task-history-job-criteria" title={criteriaSummary(job.criteria)}>
          {criteriaSummary(job.criteria)}
        </span>
        <span className="task-history-job-meta">
          {job.source_summary.total} 个来源 · {pageCountText(job.page_summary, job.total_pages)}
        </span>
        <time className="task-history-job-updated" dateTime={job.updated_at}>
          更新于 {formatTimestamp(job.updated_at)}
        </time>
      </button>
    </li>
  );
}

function PendingSourceRow({
  source,
  position,
}: {
  source: PendingTaskSource;
  position: number;
}) {
  const name = pendingSourceName(source);

  return (
    <li className="task-history-source-item task-history-pending-source-item">
      <div className="task-history-source-heading">
        <span className="task-history-source-position">{position + 1}</span>
        <div className="task-history-source-name-wrap">
          <strong className="task-history-source-name" title={name}>{name}</strong>
          <span className="task-history-source-path">当前输入文件 · {pendingSourcePageCountText(source)}</span>
        </div>
        <span className="task-history-status" data-state="queued">待创建</span>
      </div>
    </li>
  );
}

function ActionBar({
  job,
  disabled,
  onResume,
  onPause,
  onCancel,
  onArchive,
  onLoadReview,
}: {
  job: BatchJobSnapshot;
  disabled: boolean;
  onResume: () => void;
  onPause: () => void;
  onCancel: () => void;
  onArchive: () => void;
  onLoadReview: () => void;
}) {
  const active = isActive(job.state);
  const pauseRequested = job.state === 'pause_requested';
  const cancelRequested = job.state === 'cancel_requested';
  const resumable = RESUMABLE_STATES.has(job.state);
  const ready = isReady(job.state);
  const reviewable = isReviewable(job.state);

  return (
    <div className="task-history-actions" aria-label="任务操作">
      {active && (
        <>
          <button
            className="task-history-button task-history-button-secondary"
            type="button"
            aria-label="暂停任务"
            disabled={disabled || pauseRequested || cancelRequested}
            onClick={onPause}
          >
            {pauseRequested ? '正在暂停' : '暂停任务'}
          </button>
          <button
            className="task-history-button task-history-button-danger"
            type="button"
            aria-label="取消任务"
            disabled={disabled || cancelRequested}
            onClick={onCancel}
          >
            取消任务
          </button>
        </>
      )}
      {resumable && (
        <button
          className="task-history-button task-history-button-primary"
          type="button"
          aria-label="继续任务"
          disabled={disabled}
          onClick={onResume}
        >
          继续任务
        </button>
      )}
      {reviewable && (
        <>
          <button
            className="task-history-button task-history-button-primary"
            type="button"
            aria-label="载入审核"
            disabled={disabled}
            onClick={onLoadReview}
          >
            载入审核
          </button>
          {ready && (
            <button
              className="task-history-button task-history-button-secondary"
              type="button"
              aria-label="归档任务"
              disabled={disabled}
              onClick={onArchive}
            >
              归档
            </button>
          )}
        </>
      )}
    </div>
  );
}

function SourceRow({
  source,
  active,
  disabled,
  onRelocate,
}: {
  source: BatchSourceSnapshot;
  active: boolean;
  disabled: boolean;
  onRelocate: (sourceId: string) => void;
}) {
  const sourceFailure = describeTaskFailure(source.error);
  const name = sourceName(source);
  const path = sourcePath(source);
  const canRelocate = Boolean(source.sha256) && !active;

  return (
    <li className="task-history-source-item">
      <div className="task-history-source-heading">
        <span className="task-history-source-position">{source.position + 1}</span>
        <div className="task-history-source-name-wrap">
          <strong className="task-history-source-name" title={name}>{name}</strong>
          <span className="task-history-source-path" title={path}>{path}</span>
        </div>
        <span className="task-history-status" data-state={source.state}>{statusLabel(source.state)}</span>
      </div>
      <div className="task-history-source-meta">
        <span>{sourcePageCountText(source)}</span>
        {source.sha256 && <span title={source.sha256}>已登记 SHA-256</span>}
        {canRelocate && (
          <button
            className="task-history-inline-button"
            type="button"
            aria-label={`定位同内容 PDF：${name}`}
            disabled={disabled}
            onClick={() => onRelocate(source.source_id)}
          >
            定位同内容 PDF
          </button>
        )}
      </div>
      {(sourceFailure || source.state === 'failed' || source.state === 'blocked') && (
        <p className="task-history-source-error" title={sourceFailure?.details ?? undefined}>
          <span>失败提示：{sourceFailure?.reason ?? '暂无详细提示'}</span>
          {sourceFailure && <><br /><span>处理建议：{sourceFailure.action}</span></>}
          {sourceFailure?.details && <><br /><span>{sourceFailure.details}</span></>}
        </p>
      )}
    </li>
  );
}

function TaskDetail({
  job,
  currentView,
  selectedActive,
  controlsDisabled,
  onDelete,
  onRelocate,
}: {
  job: BatchJobSnapshot;
  currentView: boolean;
  selectedActive: boolean;
  controlsDisabled: boolean;
  onDelete?: (jobId: string) => void;
  onRelocate: (sourceId: string) => void;
}) {
  const selectedFailure = describeTaskFailure(job.error);

  return (
    <section className="task-history-detail" aria-labelledby="task-history-detail-title">
      <div className="task-history-detail-heading">
        <div>
          <span className="task-history-kicker">{currentView ? 'CURRENT TASK' : 'SELECTED TASK'}</span>
          <h3 id="task-history-detail-title" title={job.name}>{job.name}</h3>
        </div>
        <span className="task-history-status task-history-status-large" data-state={job.state}>
          {statusLabel(job.state)}
        </span>
      </div>
      <p className="task-history-detail-criteria" title={criteriaSummary(job.criteria)}>
        {criteriaSummary(job.criteria)}
      </p>
      <div className="task-history-stat-grid">
        <div>
          <span>来源</span>
          <strong>{job.sources.length}</strong>
        </div>
        <div>
          <span>页面</span>
          <strong>{job.total_pages}</strong>
        </div>
        <div>
          <span>成功页</span>
          <strong>{job.page_summary.succeeded}</strong>
        </div>
        <div>
          <span>失败页</span>
          <strong>{job.page_summary.failed}</strong>
        </div>
      </div>
      <p className="task-history-updated">
        更新时间：<time dateTime={job.updated_at}>{formatTimestamp(job.updated_at)}</time>
      </p>
      {selectedFailure && (
        <p className="task-history-detail-error" title={selectedFailure.details ?? undefined}>
          <span>任务提示：{selectedFailure.reason}</span>
          <br /><span>处理建议：{selectedFailure.action}</span>
          {selectedFailure.details && <><br /><span>{selectedFailure.details}</span></>}
        </p>
      )}
      {onDelete && <button type="button" className="task-history-button task-history-button-danger"
        disabled={controlsDisabled || selectedActive || job.deletion_pending}
        onClick={() => onDelete(job.id)}>删除任务</button>}
      {job.deletion_pending && <p role="status" className="task-history-archive-note">
        此任务正在清理，已暂停载入和继续分析。请在“清理与空间”中重试未完成的清理。
      </p>}
      {isReady(job.state) && (
        <p className="task-history-archive-note">归档只整理历史记录，不改动原件或导出文件。</p>
      )}

      <div className="task-history-sources-heading">
        <h4>{currentView ? '本次来源' : '来源明细'}</h4>
        {!currentView && <span>{job.sources.length} 个来源</span>}
      </div>
      {job.sources.length === 0 ? (
        <p className="task-history-empty task-history-empty-sources">暂无来源</p>
      ) : (
        <ol className="task-history-source-list">
          {job.sources.map((source) => (
            <SourceRow
              key={source.source_id}
              source={source}
              active={selectedActive}
              disabled={controlsDisabled}
              onRelocate={onRelocate}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

export function TaskHistoryPanel({
  open,
  onClose,
  jobs,
  selectedJob,
  view = 'history',
  onViewChange,
  pendingSources = [],
  loading,
  busy,
  error,
  hasMore,
  onRefresh,
  onLoadMore,
  onSelect,
  onResume,
  onPause,
  onCancel,
  onArchive,
  onLoadReview,
  onRelocate,
  onDelete,
  onOpenCleanup,
  onNewTask,
  newTaskDisabled = false,
  locked = false,
}: TaskHistoryPanelProps) {
  if (!open) return null;

  const currentView = view === 'current';
  const hasCurrentContext = Boolean(selectedJob || pendingSources.length > 0);
  const selectedActive = Boolean(selectedJob && isActive(selectedJob.state));
  const controlsDisabled = loading || busy || locked;
  const selectionDisabled = selectedActive || loading || busy || locked;
  const topLevelFailure = error ? describeTaskFailure(error) : null;
  const liveMessage = selectedJob
    ? selectedJob.state === 'pause_requested'
      ? '正在暂停，等待当前页完成'
      : selectedJob.state === 'cancel_requested'
        ? '正在停止'
        : `当前任务：${statusLabel(selectedJob.state)}`
    : currentView
      ? busy ? '正在创建本次任务' : '尚未创建任务，可返回当前文件重试'
      : '尚未选择任务';
  const handleViewChange = (nextView: TaskHistoryPanelView): void => {
    onViewChange?.(nextView);
  };

  return (
    <aside
      className={`task-history-panel${currentView ? ' task-history-panel-current' : ' task-history-panel-history'}`}
      aria-label={currentView ? '当前任务' : '任务历史'}
      data-open="true"
      data-view={view}
    >
      <header className="task-history-header">
        <div>
          <span className="task-history-kicker">{currentView ? 'CURRENT TASK' : 'BATCH WORKSPACE'}</span>
          <h2>{currentView ? '当前任务' : '任务历史'}</h2>
          <p>{currentView ? '查看本次分析进度与来源文件' : '查看批量任务进度与已保存条件'}</p>
        </div>
        <div className="task-history-header-actions">
          {currentView && onViewChange && (
            <button
              className="task-history-view-button"
              type="button"
              aria-label="任务历史"
              onClick={() => handleViewChange('history')}
            >
              任务历史
            </button>
          )}
          {!currentView && onViewChange && hasCurrentContext && (
            <button
              className="task-history-view-button"
              type="button"
              aria-label="返回当前任务"
              onClick={() => handleViewChange('current')}
            >
              返回当前任务
            </button>
          )}
          <button
            className="task-history-close"
            type="button"
            aria-label={currentView ? '关闭当前任务' : '关闭任务历史'}
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>

      {currentView ? (
        <div className="task-history-toolbar task-history-current-toolbar">
          <span className="task-history-count">{selectedJob?.sources.length ?? pendingSources.length} 个来源</span>
        </div>
      ) : (
        <div className="task-history-toolbar">
          <span className="task-history-count">{jobs.length} 个任务</span>
          <div className="task-history-toolbar-actions">
            {onNewTask && <button className="task-history-toolbar-button" type="button"
              disabled={controlsDisabled || selectedActive || newTaskDisabled} onClick={onNewTask}>＋ 新建任务</button>}
            {onOpenCleanup && <button className="task-history-toolbar-button" type="button"
              disabled={busy || locked} onClick={onOpenCleanup}>清理与空间</button>}
            <button
              className="task-history-toolbar-button"
              type="button"
              disabled={controlsDisabled}
              onClick={onRefresh}
            >
              刷新
            </button>
            <button
              className="task-history-toolbar-button"
              type="button"
              disabled={controlsDisabled || !hasMore}
              onClick={onLoadMore}
            >
              {hasMore ? '更多' : '已到底'}
            </button>
          </div>
        </div>
      )}

      {topLevelFailure && (
        <div className="task-history-error" role="alert">
          <span>失败提示：{topLevelFailure.reason}</span>
          <br /><span>处理建议：{topLevelFailure.action}</span>
          {topLevelFailure.details && <><br /><span>{topLevelFailure.details}</span></>}
        </div>
      )}
      <div className="task-history-live" role="status" aria-live="polite">{liveMessage}</div>
      <div className="task-history-action-bar" aria-label="当前任务操作">
        <span
          className="task-history-selected-name"
          title={selectedJob?.name}
        >
          {selectedJob?.name ?? (currentView ? '等待本次任务创建' : '尚未选择任务')}
        </span>
        {selectedJob && (
          <ActionBar
            job={selectedJob}
            disabled={controlsDisabled || selectedJob.deletion_pending}
            onResume={onResume}
            onPause={onPause}
            onCancel={onCancel}
            onArchive={onArchive}
            onLoadReview={onLoadReview}
          />
        )}
      </div>

      <div className="task-history-body" key={view}>
        {currentView ? (
          selectedJob ? (
            <TaskDetail
              job={selectedJob}
              currentView
              selectedActive={selectedActive}
              controlsDisabled={controlsDisabled}
              onDelete={onDelete}
              onRelocate={onRelocate}
            />
          ) : (
            <section className="task-history-current-empty" aria-label="当前任务详情">
              {pendingSources.length > 0 && (
                <div className="task-history-current-sources">
                  <div className="task-history-sources-heading">
                    <h4>本次来源</h4>
                  </div>
                  <ol className="task-history-source-list">
                    {pendingSources.map((source, index) => (
                      <PendingSourceRow key={`${source.name}-${index}`} source={source} position={index} />
                    ))}
                  </ol>
                </div>
              )}
              {busy ? (
                <div className="task-history-detail-empty task-history-current-waiting">
                  <span className="task-history-empty-mark">…</span>
                  <h3>正在创建本次任务</h3>
                  <p>当前输入文件正在登记，请稍候。</p>
                </div>
              ) : (
                <div className="task-history-detail-empty task-history-current-waiting">
                  <span className="task-history-empty-mark">○</span>
                  <h3>尚未创建任务</h3>
                  <p>本次任务尚未创建，可返回当前文件重试。</p>
                  <button type="button" className="task-history-button task-history-button-secondary"
                    onClick={onClose}>返回当前文件重试</button>
                </div>
              )}
            </section>
          )
        ) : (
          <>
            <section className="task-history-list-section" aria-labelledby="task-history-list-title">
              <div className="task-history-section-heading">
                <h3 id="task-history-list-title">最近任务</h3>
                {loading && <span className="task-history-loading-label">正在加载</span>}
              </div>
              {jobs.length === 0 ? (
                <p className="task-history-empty">暂无历史任务</p>
              ) : (
                <ol className="task-history-job-list">
                  {jobs.map((job) => (
                    <JobSummaryItem
                      key={job.id}
                      job={job}
                      selected={job.id === selectedJob?.id}
                      disabled={selectionDisabled}
                      onSelect={onSelect}
                    />
                  ))}
                </ol>
              )}
            </section>

            {selectedJob ? (
              <TaskDetail
                job={selectedJob}
                currentView={false}
                selectedActive={selectedActive}
                controlsDisabled={controlsDisabled}
                onDelete={onDelete}
                onRelocate={onRelocate}
              />
            ) : (
              <section className="task-history-detail task-history-detail-empty" aria-label="当前任务详情">
                <span className="task-history-empty-mark">○</span>
                <h3>选择一个任务</h3>
                <p>选中历史任务后查看条件、来源和页级状态。</p>
              </section>
            )}
          </>
        )}
      </div>

      <footer className="task-history-footer">
        <p>{currentView && !selectedJob
          ? '此处为本次输入文件，任务成功创建后才会保存记录。'
          : '搜索条件、命中片段文字与坐标已随任务保存。'}</p>
        <p>原件保持只读，定位同内容 PDF 只切换访问路径。</p>
      </footer>
    </aside>
  );
}
