import { useId } from 'react';

import './ReviewOperationTools.css';

export type ReviewOperationToolsProps = {
  busy: boolean;
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
  const frozenReason = normalizeText(props.frozenReason);
  const unsavedMessage = normalizeText(props.unsavedMessage);
  const frozen = Boolean(frozenReason);
  const historyCount = normalizeCount(props.historyCount, MAX_HISTORY_STEPS);
  const visibleUnresolvedCount = normalizeCount(props.visibleUnresolvedCount);
  const hiddenUnresolvedCount = normalizeCount(props.hiddenUnresolvedCount);

  const nextDisabled = props.busy || frozen || visibleUnresolvedCount === 0;
  const nextDisabledReason = nextDisabled
    ? joinReasons([
      props.busy ? BUSY_MESSAGE : undefined,
      frozenReason || undefined,
      visibleUnresolvedCount === 0 ? '当前筛选范围内没有待复核项。' : undefined,
    ])
    : undefined;

  const revealDisabled = props.busy || frozen;
  const revealDisabledReason = revealDisabled
    ? joinReasons([props.busy ? BUSY_MESSAGE : undefined, frozenReason || undefined])
    : undefined;

  const restoreDisabled = props.busy || frozen || Boolean(unsavedMessage) || !props.canRestoreCandidate;
  const restoreDisabledReason = restoreDisabled
    ? joinReasons([
      props.busy ? BUSY_MESSAGE : undefined,
      frozenReason || undefined,
      unsavedMessage ? '有未保存修改，请先重试或放弃修改。' : undefined,
      normalizeText(props.restoreDisabledReason) || (!props.canRestoreCandidate ? '当前没有可恢复的自动候选。' : undefined),
    ])
    : undefined;

  const undoDisabled = props.busy || frozen || Boolean(unsavedMessage) || !props.canUndo;
  const undoDisabledReason = undoDisabled
    ? joinReasons([
      props.busy ? BUSY_MESSAGE : undefined,
      frozenReason || undefined,
      unsavedMessage ? '有未保存修改，请先重试或放弃修改。' : undefined,
      normalizeText(props.undoDisabledReason) || (!props.canUndo ? '当前没有可撤销的审核操作。' : undefined),
    ])
    : undefined;

  const recoveryDisabled = props.busy || frozen;
  const recoveryDisabledReason = recoveryDisabled
    ? joinReasons([props.busy ? BUSY_MESSAGE : undefined, frozenReason || undefined])
    : undefined;

  const nextReasonId = `${idPrefix}-next-reason`;
  const revealReasonId = `${idPrefix}-reveal-reason`;
  const restoreReasonId = `${idPrefix}-restore-reason`;
  const undoReasonId = `${idPrefix}-undo-reason`;
  const retryReasonId = `${idPrefix}-retry-reason`;
  const discardReasonId = `${idPrefix}-discard-reason`;

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

        <div className="review-operation-tools-action-group review-operation-tools-history-group">
          {props.onBatchCrop && <button type="button" className="review-operation-tools-button"
            disabled={props.busy || frozen || Boolean(unsavedMessage) || Boolean(props.batchCropDisabledReason)}
            title={props.batchCropDisabledReason || undefined} onClick={props.onBatchCrop}>应用到同类片段</button>}
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

      <DisabledReason id={nextReasonId} reason={nextDisabledReason} />
      <DisabledReason id={revealReasonId} reason={revealDisabledReason} />
      <DisabledReason id={restoreReasonId} reason={restoreDisabledReason} />
      <DisabledReason id={undoReasonId} reason={undoDisabledReason} />

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
