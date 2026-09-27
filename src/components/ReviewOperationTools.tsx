import { useEffect, useId, useState } from 'react';

import './ReviewOperationTools.css';

export type ReviewOperationToolsProps = {
  busy: boolean;
  draftPending?: boolean;
  frozenReason?: string;
  unsavedMessage?: string;
  historyCount: number;
  canUndo: boolean;
  undoDisabledReason?: string;
  onUndo: () => void;
  canRestoreCandidate: boolean;
  restoreDisabledReason?: string;
  onRestoreCandidate: () => void;
  onBatchCrop?: () => void;
  batchCropDisabledReason?: string;
  syncEnabled?: boolean;
  syncDisabledReason?: string;
  syncStatus?: string;
  onSyncEnabledChange?: (enabled: boolean) => void;
  onSplitCandidate?: () => void;
  visibleUnresolvedCount: number;
  hiddenUnresolvedCount: number;
  onNextUnresolved: () => void;
  onRevealUnresolved: () => void;
  onRetry: () => void;
  onDiscard: () => void;
};

const MAX_HISTORY_STEPS = 20;
const BUSY_MESSAGE = '正在保存审核…';

function normalizeText(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCount(value: number, maximum?: number): number {
  if (!Number.isFinite(value)) return 0;
  const count = Math.max(0, Math.floor(value));
  return maximum === undefined ? count : Math.min(maximum, count);
}

function joinReasons(reasons: readonly (string | undefined)[]): string | undefined {
  const uniqueReasons: string[] = [];
  for (const reason of reasons) {
    const normalizedReason = normalizeText(reason);
    if (normalizedReason && !uniqueReasons.includes(normalizedReason)) uniqueReasons.push(normalizedReason);
  }
  return uniqueReasons.length > 0 ? uniqueReasons.join('；') : undefined;
}

function describedBy(id: string, reason: string | undefined): string | undefined {
  return reason ? id : undefined;
}

function DisabledReason({ id, reason }: { id: string; reason: string | undefined }) {
  if (!reason) return null;
  return <span id={id} className="review-operation-tools-sr-only">{reason}</span>;
}

export function ReviewOperationTools(props: ReviewOperationToolsProps) {
  const idPrefix = `review-operation-tools-${useId().replace(/:/g, '')}`;
  const [moreOpen, setMoreOpen] = useState(false);
  const frozenReason = normalizeText(props.frozenReason);
  const unsavedMessage = normalizeText(props.unsavedMessage);
  const draftPending = Boolean(props.draftPending);
  const draftPendingMessage = '微调尚未保存，请先完成微调或取消微调。';
  const frozen = Boolean(frozenReason);
  const historyCount = normalizeCount(props.historyCount, MAX_HISTORY_STEPS);
  const visibleUnresolvedCount = normalizeCount(props.visibleUnresolvedCount);
  const hiddenUnresolvedCount = normalizeCount(props.hiddenUnresolvedCount);

  const nextDisabled = props.busy || frozen || draftPending || visibleUnresolvedCount === 0;
  const nextDisabledReason = nextDisabled
    ? joinReasons([
      props.busy ? BUSY_MESSAGE : undefined,
      frozenReason || undefined,
      draftPending ? draftPendingMessage : undefined,
      visibleUnresolvedCount === 0 ? '当前筛选范围内没有待复核项。' : undefined,
    ])
    : undefined;

  const revealDisabled = props.busy || frozen || draftPending;
  const revealDisabledReason = revealDisabled
    ? joinReasons([props.busy ? BUSY_MESSAGE : undefined, frozenReason || undefined, draftPending ? draftPendingMessage : undefined])
    : undefined;

  const restoreDisabled = props.busy || frozen || draftPending || Boolean(unsavedMessage) || !props.canRestoreCandidate;
  const restoreDisabledReason = restoreDisabled
    ? joinReasons([
      props.busy ? BUSY_MESSAGE : undefined,
      frozenReason || undefined,
      draftPending ? draftPendingMessage : undefined,
      unsavedMessage ? '有未保存修改，请先重试或放弃修改。' : undefined,
      normalizeText(props.restoreDisabledReason) || (!props.canRestoreCandidate ? '当前没有可恢复的自动候选。' : undefined),
    ])
    : undefined;

  const undoDisabled = props.busy || frozen || draftPending || Boolean(unsavedMessage) || !props.canUndo;
  const undoDisabledReason = undoDisabled
    ? joinReasons([
      props.busy ? BUSY_MESSAGE : undefined,
      frozenReason || undefined,
      draftPending ? draftPendingMessage : undefined,
      unsavedMessage ? '有未保存修改，请先重试或放弃修改。' : undefined,
      normalizeText(props.undoDisabledReason) || (!props.canUndo ? '当前没有可撤销的审核操作。' : undefined),
    ])
    : undefined;

  const recoveryDisabled = props.busy || frozen;
  const recoveryDisabledReason = recoveryDisabled
    ? joinReasons([props.busy ? BUSY_MESSAGE : undefined, frozenReason || undefined])
    : undefined;

  const splitDisabled = props.busy || frozen || draftPending || Boolean(unsavedMessage);
  const splitDisabledReason = splitDisabled
    ? joinReasons([
      props.busy ? BUSY_MESSAGE : undefined,
      frozenReason || undefined,
      draftPending ? draftPendingMessage : undefined,
      unsavedMessage ? '有未保存修改，请先重试或放弃修改。' : undefined,
    ])
    : undefined;
  const batchDisabled = props.busy || frozen || draftPending || Boolean(unsavedMessage) || Boolean(props.batchCropDisabledReason);
  const batchDisabledReason = batchDisabled
    ? joinReasons([
      props.busy ? BUSY_MESSAGE : undefined,
      frozenReason || undefined,
      draftPending ? draftPendingMessage : undefined,
      unsavedMessage ? '有未保存修改，请先重试或放弃修改。' : undefined,
      normalizeText(props.batchCropDisabledReason),
    ])
    : undefined;

  const nextReasonId = `${idPrefix}-next-reason`;
  const revealReasonId = `${idPrefix}-reveal-reason`;
  const restoreReasonId = `${idPrefix}-restore-reason`;
  const undoReasonId = `${idPrefix}-undo-reason`;
  const retryReasonId = `${idPrefix}-retry-reason`;
  const discardReasonId = `${idPrefix}-discard-reason`;
  const splitReasonId = `${idPrefix}-split-reason`;
  const batchReasonId = `${idPrefix}-batch-reason`;
  const moreId = `${idPrefix}-more`;

  useEffect(() => {
    if (draftPending) setMoreOpen(false);
  }, [draftPending]);

  return (
    <section
      className="review-operation-tools"
      aria-label="审核工具"
      aria-busy={props.busy || undefined}
    >
      {props.busy && (
        <div className="review-operation-tools-header">
          <span className="review-operation-tools-busy" role="status" aria-live="polite">
            {BUSY_MESSAGE}
          </span>
        </div>
      )}

      {frozen && (
        <p className="review-operation-tools-frozen" role="status" aria-live="polite" title={frozenReason}>
          {frozenReason}
        </p>
      )}

      {!draftPending && <>
        <div className="review-operation-tools-actions">
          <div className="review-operation-tools-action-group">
            <button
              className="review-operation-tools-button review-operation-tools-button-primary"
              type="button"
              disabled={nextDisabled}
              aria-describedby={describedBy(nextReasonId, nextDisabledReason)}
              title={nextDisabledReason}
              onClick={props.onNextUnresolved}
            >
              下一项待复核
            </button>
            {visibleUnresolvedCount === 0 && hiddenUnresolvedCount > 0 && (
              <div className="review-operation-tools-hidden-unresolved">
                <span>{`筛选范围外还有 ${hiddenUnresolvedCount} 项待复核`}</span>
                <button
                  className="review-operation-tools-inline-button"
                  type="button"
                  disabled={revealDisabled}
                  aria-describedby={describedBy(revealReasonId, revealDisabledReason)}
                  title={revealDisabledReason}
                  onClick={props.onRevealUnresolved}
                >
                  查看全部待复核
                </button>
              </div>
            )}
          </div>

          <button
            className="review-operation-tools-more-toggle"
            type="button"
            aria-expanded={moreOpen}
            aria-controls={moreId}
            onClick={() => setMoreOpen((open) => !open)}
          >
            {moreOpen ? '收起审核工具' : '更多审核工具'}
          </button>
        </div>

        {moreOpen && (
          <div id={moreId} className="review-operation-tools-more" aria-label="更多审核工具">
            <p className="review-operation-tools-more-hint">
              批量调整、候选恢复和撤销会改变审核结果，请确认用途后再使用。
            </p>
            <div className="review-operation-tools-action-group review-operation-tools-history-group">
              {props.onSplitCandidate && <button type="button" className="review-operation-tools-button"
                disabled={splitDisabled}
                aria-describedby={describedBy(splitReasonId, splitDisabledReason)}
                title={splitDisabledReason}
                onClick={props.onSplitCandidate}>按单张候选分割</button>}
              {props.onBatchCrop && <>
                <button type="button" className="review-operation-tools-button"
                  disabled={batchDisabled}
                  aria-describedby={describedBy(batchReasonId, batchDisabledReason)}
                  title={batchDisabledReason}
                  onClick={props.onBatchCrop}>应用到同类片段</button>
                <p className="review-operation-tools-batch-hint">
                  将当前裁剪框应用到同银行同版式、尚未确认且未独立调整的候选；已同步、已确认或独立调整的片段会自动跳过。
                </p>
              </>}
              <button
                className="review-operation-tools-button"
                type="button"
                disabled={restoreDisabled}
                aria-describedby={describedBy(restoreReasonId, restoreDisabledReason)}
                title={restoreDisabledReason}
                onClick={props.onRestoreCandidate}
              >
                恢复自动候选
              </button>
              <button
                className="review-operation-tools-button"
                type="button"
                disabled={undoDisabled}
                aria-describedby={describedBy(undoReasonId, undoDisabledReason)}
                title={undoDisabledReason}
                onClick={props.onUndo}
              >
                撤销上一步
              </button>
              <span className="review-operation-tools-history-count" aria-label={`最近 ${historyCount} / ${MAX_HISTORY_STEPS} 步`}>
                {`最近 ${historyCount} / ${MAX_HISTORY_STEPS} 步`}
              </span>
            </div>
          </div>
        )}
      </>}

      {props.onSyncEnabledChange && <div className="review-operation-tools-sync">
        <label title={props.syncDisabledReason}>
          <input type="checkbox" checked={Boolean(props.syncEnabled)}
            disabled={props.busy || frozen || Boolean(unsavedMessage) || Boolean(props.syncDisabledReason)}
            onChange={(event) => props.onSyncEnabledChange?.(event.target.checked)} />
          保存时同步同银行同版式候选
        </label>
        <p role="status">{props.syncStatus || '仅同步当前任务中出具银行、版式均可核实的候选；已由用户确认或单独调整过的片段会跳过。'}</p>
      </div>}

      <DisabledReason id={nextReasonId} reason={nextDisabledReason} />
      <DisabledReason id={revealReasonId} reason={revealDisabledReason} />
      <DisabledReason id={restoreReasonId} reason={restoreDisabledReason} />
      <DisabledReason id={undoReasonId} reason={undoDisabledReason} />
      <DisabledReason id={splitReasonId} reason={splitDisabledReason} />
      <DisabledReason id={batchReasonId} reason={batchDisabledReason} />

      {unsavedMessage && (
        <div className="review-operation-tools-unsaved" role="alert">
          <p className="review-operation-tools-unsaved-message">
            <strong>未保存修改：</strong>{unsavedMessage}
          </p>
          <div className="review-operation-tools-recovery-actions">
            <button
              className="review-operation-tools-button review-operation-tools-button-retry"
              type="button"
              disabled={recoveryDisabled}
              aria-describedby={describedBy(retryReasonId, recoveryDisabledReason)}
              title={recoveryDisabledReason}
              onClick={props.onRetry}
            >
              重试保存
            </button>
            <button
              className="review-operation-tools-button review-operation-tools-button-discard"
              type="button"
              disabled={recoveryDisabled}
              aria-describedby={describedBy(discardReasonId, recoveryDisabledReason)}
              title={recoveryDisabledReason}
              onClick={props.onDiscard}
            >
              放弃未保存修改
            </button>
          </div>
        </div>
      )}

      <DisabledReason id={retryReasonId} reason={recoveryDisabledReason} />
      <DisabledReason id={discardReasonId} reason={recoveryDisabledReason} />
    </section>
  );
}

export default ReviewOperationTools;
