import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { normalizeSearchCriteria, type SearchCriteria } from '../domain/searchCriteria';
import type { SearchKeywordHistory, SearchKeywordHistoryRole } from '../domain/searchKeywordHistory';
import type { BatchFailure, BatchFeedback } from '../domain/batchFeedback';
import type { SearchMode } from '../domain/sourceFiles';
import { SearchCriteriaEditor } from './SearchCriteriaEditor';

const BATCH_STAGE_LABELS: Record<BatchFailure['stage'], string> = {
  search: '文件搜索',
  analysis: '回单边界分析',
  verifying: '来源核验',
  finalizing: '整理审核结果',
};

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

function batchFailureSourceName(batchFeedback: BatchFeedback, failure: BatchFailure): string {
  if (failure.sourcePath === null) return '整批任务';
  return batchFeedback.sources.find((source) => source.sourcePath === failure.sourcePath)?.name ?? failure.sourcePath;
}

export type SearchCriteriaPanelProps = {
  draft: SearchCriteria;
  draftMode: SearchMode;
  appliedSummary: string | null;
  appliedMode: SearchMode | null;
  hitCount: number;
  canAnalyze: boolean;
  analyzeUnavailableReason?: string;
  expanded: boolean;
  running: boolean;
  disabled: boolean;
  disabledReason?: string;
  feedback: { kind: 'status' | 'error'; message: string } | null;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onDraftChange: (next: SearchCriteria) => void;
  onDraftModeChange: (next: SearchMode) => void;
  onAnalyze: () => void;
  retryFailedCount?: number;
  retryNotice?: string;
  onRetryFailed?: () => void;
  batchFeedback?: BatchFeedback | null;
  keywordHistory?: SearchKeywordHistory;
  onRemoveKeywordHistory?: (role: SearchKeywordHistoryRole, keyword: string) => void;
  onClearKeywordHistory?: (role: SearchKeywordHistoryRole) => void;
};

export function SearchCriteriaPanel(props: SearchCriteriaPanelProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const previousExpandedRef = useRef<boolean | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const validDraft = normalizeSearchCriteria(props.draft) !== null;
  const controlsDisabled = props.disabled || props.running;
  const submitDisabled = controlsDisabled || !props.canAnalyze || !validDraft;
  const retryEligible = props.feedback?.kind === 'error'
    && isPositiveInteger(props.retryFailedCount)
    && typeof props.onRetryFailed === 'function';
  const retryDisabled = submitDisabled;
  const submitLabel = props.running
    ? '正在分析…'
    : props.feedback?.kind === 'error'
      ? '重新分析整批'
      : props.appliedSummary === null
        ? '开始分析'
        : '应用并重新分析';
  const recovery = props.feedback?.kind === 'error';

  function retryFailed(): void {
    if (!retryEligible || retryDisabled) return;
    props.onRetryFailed?.();
  }

  useEffect(() => {
    if (props.running) setDetailsOpen(false);
    else if (props.feedback?.kind === 'error') setDetailsOpen(true);
    else setDetailsOpen(false);
  }, [props.feedback?.kind, props.feedback?.message, props.running]);

  useEffect(() => {
    const previousExpanded = previousExpandedRef.current;
    if (props.expanded) {
      const shouldFocusFirstInput = previousExpanded === false
        || (previousExpanded === null && !validDraft);
      if (shouldFocusFirstInput) {
        bodyRef.current?.querySelector<HTMLInputElement>('input[aria-label="包含关键词 1"]')?.focus();
      }
    } else if (previousExpanded === true) {
      document.querySelector<HTMLButtonElement>('.search-criteria-panel .search-summary button')?.focus();
    }
    previousExpandedRef.current = props.expanded;
  }, [props.expanded, validDraft]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!submitDisabled) props.onAnalyze();
  }

  function guardComposition(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
  }

  function renderFeedback() {
    if (!props.feedback) return null;
    const batchFailures = props.batchFeedback?.failures ?? [];
    const hasFailedBatch = props.batchFeedback?.phase === 'failed';
    return (
      <div className="search-criteria-feedback" data-kind={props.feedback.kind}>
        <span
          className="search-criteria-feedback-summary"
          title={props.feedback.message}
          role={props.feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {props.feedback.kind === 'error' ? '错误：' : '状态：'}{props.feedback.message}
        </span>
        <button type="button" aria-expanded={detailsOpen} aria-controls="search-criteria-feedback-details" onClick={() => setDetailsOpen((open) => !open)}>
          {detailsOpen ? '收起详情' : '查看详情'}
        </button>
        <div id="search-criteria-feedback-details" data-testid="search-criteria-feedback-details" hidden={!detailsOpen}>
          {detailsOpen ? (
            <>
              {hasFailedBatch && <p>上一轮分析</p>}
              {props.feedback.kind === 'error' && (
                <p id="search-retry-explanation">
                  {retryEligible
                    ? `重试失败文件（${props.retryFailedCount}）只处理上一轮失败文件；重新分析整批会从当前条件重新处理所有来源`
                    : '按当前条件重新处理全部来源'}
                </p>
              )}
              <p>{props.feedback.message}</p>
              {batchFailures.length > 0 && (
                <div className="batch-failures">
                  <ol aria-label="上一轮分析失败明细">
                    {batchFailures.map((failure, index) => (
                      <li key={`${failure.sourcePath ?? 'batch'}:${failure.page ?? 'unknown'}:${failure.stage}:${index}`}>
                        <strong>{batchFailureSourceName(props.batchFeedback!, failure)}</strong>
                        {failure.sourcePath !== null && <span> · 来源：{failure.sourcePath}</span>}
                        <span> · 阶段：{BATCH_STAGE_LABELS[failure.stage]}</span>
                        {failure.page !== null && <span> · 第 {failure.page} 页</span>}
                        <span> · {failure.message}</span>
                        <details>
                          <summary>技术详情</summary>
                          <pre>{failure.detail}</pre>
                        </details>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    );
  }

  const showSummary = !props.expanded && props.appliedSummary !== null;
  const summaryText = props.appliedSummary ?? '';

  return (
    <section className="search-criteria-panel" aria-labelledby="search-criteria-title">
      <h2 id="search-criteria-title" className={props.expanded ? undefined : 'sr-only'}>搜索条件</h2>
      {showSummary ? (
        <div className="search-summary">
          <div>
            <div className="search-summary-text" title={summaryText} aria-label={`已应用搜索条件：${summaryText}`}>
              {summaryText}
            </div>
            <small>{`${props.appliedMode === 'fuzzy' ? '模糊匹配' : '精确匹配'} · ${props.hitCount} 个命中`}</small>
          </div>
          <button
            type="button"
            className="ghost-button"
            disabled={props.disabled}
            aria-describedby={props.disabledReason ? 'search-modification-disabled-reason' : undefined}
            onClick={props.onBeginEdit}
          >
            修改搜索条件
          </button>
          {props.disabledReason && <small id="search-modification-disabled-reason">{props.disabledReason}</small>}
        </div>
      ) : (
        <form onSubmit={submit} onKeyDownCapture={guardComposition} aria-busy={props.running || undefined}>
          <div ref={bodyRef} className="search-criteria-panel-body">
            <SearchCriteriaEditor
              value={props.draft}
              disabled={controlsDisabled}
              onChange={props.onDraftChange}
              keywordHistory={props.keywordHistory}
              onRemoveKeywordHistory={props.onRemoveKeywordHistory}
              onClearKeywordHistory={props.onClearKeywordHistory}
            />
            <fieldset className="search-match-mode" disabled={controlsDisabled}>
              <legend>匹配精度</legend>
              <label><input type="radio" name="search-mode" checked={props.draftMode === 'exact'} onChange={() => props.onDraftModeChange('exact')} />精确匹配</label>
              <label><input type="radio" name="search-mode" checked={props.draftMode === 'fuzzy'} onChange={() => props.onDraftModeChange('fuzzy')} />模糊匹配</label>
            </fieldset>
            {!props.canAnalyze && props.analyzeUnavailableReason && (
              <small id="search-analysis-unavailable-reason">{props.analyzeUnavailableReason}</small>
            )}
            {renderFeedback()}
          </div>
          <div className="search-criteria-panel-actions">
            {props.appliedSummary !== null && (
              <button type="button" className="ghost-button" disabled={props.running} onClick={props.onCancelEdit}>
                {recovery ? '恢复上次条件' : '取消修改'}
              </button>
            )}
            {props.retryNotice && <small className="search-criteria-retry-note">{props.retryNotice}</small>}
            {retryEligible && (
              <button
                type="button"
                className="primary-button"
                disabled={retryDisabled}
                onClick={retryFailed}
              >
                重试失败文件（{props.retryFailedCount}）
              </button>
            )}
            <button
              type="submit"
              className={retryEligible ? 'ghost-button' : 'primary-button'}
              disabled={submitDisabled}
              aria-busy={props.running || undefined}
              aria-describedby={!props.canAnalyze && props.analyzeUnavailableReason ? 'search-analysis-unavailable-reason' : undefined}
            >
              {submitLabel}
            </button>
          </div>
        </form>
      )}
      {showSummary && renderFeedback()}
    </section>
  );
}

export default SearchCriteriaPanel;
