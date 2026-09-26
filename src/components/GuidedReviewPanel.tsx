import { useId, type ReactNode } from 'react';

import './GuidedReviewPanel.css';

export type GuidedReviewPhase =
  | 'entry'
  | 'preparing'
  | 'editing'
  | 'review'
  | 'round-complete'
  | 'choosing-position'
  | 'bank-complete'
  | 'completed';

export type GuidedReviewPanelProps = {
  phase: GuidedReviewPhase;
  bankLabel?: string;
  bankIndex?: number;
  bankCount?: number;
  bankConfirmedCount?: number;
  bankTotalCount?: number;
  totalCount?: number;
  pendingCount?: number;
  roundNumber?: number;
  roundCount?: number;
  /** Number of fixed candidate IDs in the current round. */
  roundSegmentCount?: number;
  sampleLabel?: string;
  dirty: boolean;
  busy: boolean;
  actionsDisabled?: boolean;
  message?: string;
  error?: string;
  undoAvailable: boolean;
  canFinishBank: boolean;
  canExtendBank?: boolean;
  positionChoices?: { key: string; label: string; count: number }[];
  skippedItems?: { id: string; label: string; reason: string }[];
  selectedPositionKey?: string;
  onOpenPositions?: () => void;
  onSelectPosition?: (key: string) => void;
  onStartPosition?: () => void;
  onCancelPositions?: () => void;
  onEnter: () => void;
  /** Generate an in-memory preview of the current round. */
  onPreview: () => void;
  /** Persist the frozen preview after the user has inspected it. */
  onSave: () => void;
  onCancelDraft: () => void;
  /** Return from the preview to the editable sample and restore its draft. */
  onBackToEdit: () => void;
  onNextRound: () => void;
  onCompleteBank: () => void;
  onUndo: () => void;
  onExit: () => void;
  onHelp: () => void;
  onExport: () => void;
  children?: ReactNode;
};

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function countLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function BankProgress({ props }: { props: GuidedReviewPanelProps }) {
  const hasBankPosition = props.bankIndex !== undefined && props.bankCount !== undefined;
  const hasBankCounts = props.bankConfirmedCount !== undefined && props.bankTotalCount !== undefined;

  if (!hasBankPosition && !hasBankCounts) return null;

  return (
    <div className="guided-review-panel-bank-progress" aria-label="银行审核进度">
      {hasBankPosition && (
        <span>{`第 ${countLabel(positiveNumber(props.bankIndex, 0))} / ${countLabel(positiveNumber(props.bankCount, 0))} 个银行`}</span>
      )}
      {hasBankCounts && (
        <>
          <span>{`本银行已确认 ${countLabel(positiveNumber(props.bankConfirmedCount, 0))} / ${countLabel(positiveNumber(props.bankTotalCount, 0))} 处`}</span>
          <span>{`本次范围内还剩 ${countLabel(Math.max(0, positiveNumber(props.bankTotalCount, 0) - positiveNumber(props.bankConfirmedCount, 0)))} 处`}</span>
        </>
      )}
    </div>
  );
}

function RoundProgress({ props }: { props: GuidedReviewPanelProps }) {
  if (props.roundNumber === undefined) return null;

  return (
    <span className="guided-review-panel-round-progress">
      {`第 ${countLabel(positiveNumber(props.roundNumber, 0))} 轮`}
    </span>
  );
}

function Header({ props, titleId }: { props: GuidedReviewPanelProps; titleId: string }) {
  if (props.phase === 'entry') {
    return (
      <header className="guided-review-panel-header guided-review-panel-entry-header">
        <div className="guided-review-panel-heading">
          <h2 id={titleId}>结果检查</h2>
        </div>
      </header>
    );
  }

  return (
    <header className="guided-review-panel-header">
      <div className="guided-review-panel-heading">
        <span className="guided-review-panel-eyebrow">按银行分轮审核</span>
        <h2 id={titleId}>微调与确认</h2>
        {props.bankLabel && <p className="guided-review-panel-bank">当前银行：{props.bankLabel}</p>}
      </div>
      <BankProgress props={props} />
    </header>
  );
}

function PhaseContent({ props }: { props: GuidedReviewPanelProps }) {
  const round = countLabel(positiveNumber(props.roundNumber, 1));
  const roundPending = props.roundSegmentCount === undefined
    ? undefined
    : positiveNumber(props.roundSegmentCount, 0);
  const positionCountLabel = roundPending === undefined ? '' : ` ${countLabel(roundPending)} 处`;
  const sample = props.sampleLabel?.trim() || '等待选择样本';
  const lastBank = props.bankCount !== undefined && props.bankIndex !== undefined
    ? props.bankIndex >= props.bankCount
    : true;

  switch (props.phase) {
    case 'entry': {
      const total = props.totalCount === undefined ? undefined : positiveNumber(props.totalCount, 0);
      const pending = props.pendingCount === undefined ? undefined : positiveNumber(props.pendingCount, 0);
      return (
        <div className="guided-review-panel-phase guided-review-panel-entry-phase" data-phase-content="entry">
          <p className="guided-review-panel-entry-lede">自动结果正确可直接选择导出范围；发现边界不合适时，再进入微调。</p>
          {(total !== undefined || pending !== undefined) && (
            <div className="guided-review-panel-entry-counts" aria-label="结果概况">
              {total !== undefined && <span>候选总数 {countLabel(total)} 处</span>}
              {pending !== undefined && <span>待复核 {countLabel(pending)} 处</span>}
            </div>
          )}
          {pending !== undefined && pending > 0 && (
            <p className="guided-review-panel-entry-note">还有 {countLabel(pending)} 处待复核；选择导出范围时仍会再次检查。</p>
          )}
        </div>
      );
    }
    case 'preparing':
      return (
        <div className="guided-review-panel-phase" data-phase-content="preparing" aria-busy="true">
          <h3>正在准备本次微调</h3>
          <p>优先核对待复核片段；同银行、同版式、同位置的候选合为一轮。</p>
          <div className="guided-review-panel-progress-track" role="progressbar" aria-label="准备微调" aria-valuetext="正在准备">
            <span />
          </div>
        </div>
      );
    case 'editing':
      return (
        <div className="guided-review-panel-phase" data-phase-content="editing">
          <div className="guided-review-panel-phase-line">
            <h3>{`第${round}轮·调整中`}</h3>
            <RoundProgress props={props} />
          </div>
          <p className="guided-review-panel-sample">选择样本：{sample}</p>
          <p>{props.dirty
            ? `当前调整尚未确认；完成拖动或缩放后，点击“确认并预览本轮${positionCountLabel}”。`
            : `当前没有未保存的调整；点击“确认并预览本轮${positionCountLabel}”，先检查本轮结果再保存。`}</p>
          <p className={`guided-review-panel-draft-status${props.dirty ? ' is-dirty' : ''}`} role="status">
            {props.dirty ? '未保存草稿：仅保留在当前轮次，保存前不会写入审核记录。' : '当前轮次没有未保存草稿。'}
          </p>
        </div>
      );
    case 'review':
      return (
        <div className="guided-review-panel-phase" data-phase-content="review">
          <div className="guided-review-panel-phase-line">
            <h3>{`本轮预览${roundPending === undefined ? '' : ` ${countLabel(roundPending)} 处`}，尚未保存`}</h3>
            <RoundProgress props={props} />
          </div>
          <p>请在右侧逐项查看本轮候选，确认抬头、交易内容、印章和底部末行都完整后，再保存本轮。</p>
          <p className="guided-review-panel-hint">当前仅为预览；返回调整可以继续修改，保存后才会应用到本轮全部候选。</p>
          <p className="guided-review-panel-draft-status is-dirty" role="status">
            未保存草稿：本轮预览会保留到你点击“保存本轮”或“返回调整”。
          </p>
          {props.skippedItems && props.skippedItems.length > 0 && (
            <details className="guided-review-panel-skipped">
              <summary>有 {props.skippedItems.length} 处未纳入本轮保存</summary>
              <ul>
                {props.skippedItems.map((item) => <li key={item.id}>{item.label}：{item.reason}</li>)}
              </ul>
              <p>这些片段仍保留在本轮范围，可在右侧逐项查看，下一轮可单独核对。</p>
            </details>
          )}
        </div>
      );
    case 'round-complete':
      return (
        <div className="guided-review-panel-phase" data-phase-content="round-complete">
          <div className="guided-review-panel-phase-line">
            <h3>{`第${round}轮已保存并确认`}</h3>
            <RoundProgress props={props} />
          </div>
          <p>{props.canFinishBank ? '本次范围已确认。其他位置需要调整时，可继续微调；自动结果正确则可结束本次微调。' : '本轮位置已确认，本次范围仍有未完成的片段。点击下一位置继续核对。'}</p>
        </div>
      );
    case 'choosing-position':
      return (
        <div className="guided-review-panel-phase" data-phase-content="choosing-position">
          <h3>选择本银行的下一位置</h3>
          {props.busy ? <p>正在核对尚未读取的位置，已确认的轮次会保留。</p> : Boolean(props.positionChoices?.length) && (
            <label className="guided-review-panel-position-select">
              需要微调的位置
              <select value={props.selectedPositionKey ?? ''} disabled={Boolean(props.actionsDisabled)}
                onChange={(event) => props.onSelectPosition?.(event.target.value)}>
                {props.positionChoices?.map((choice) => (
                  <option key={choice.key} value={choice.key}>{choice.label} · {choice.count} 处</option>
                ))}
              </select>
            </label>
          )}
        </div>
      );
    case 'bank-complete':
      return (
        <div className="guided-review-panel-phase" data-phase-content="bank-complete">
          <h3>本银行本次范围已完成</h3>
          <p>{lastBank ? '本次微调范围已确认，可以完成审核。' : '本次范围内本银行的位置已确认，可以进入下一银行。'}</p>
        </div>
      );
    case 'completed':
      return (
        <div className="guided-review-panel-phase" data-phase-content="completed">
          <h3>本次微调已完成</h3>
          <p>本次加入的全部位置已确认，可以选择导出范围。需要补充检查时，可以重新进入微调。</p>
        </div>
      );
  }
}

function Actions({ props }: { props: GuidedReviewPanelProps }) {
  const roundPending = props.roundSegmentCount === undefined
    ? undefined
    : positiveNumber(props.roundSegmentCount, 0);
  const lastBank = props.bankCount !== undefined && props.bankIndex !== undefined
    ? props.bankIndex >= props.bankCount
    : true;
  const positionCountLabel = props.roundSegmentCount === undefined
    ? ''
    : ` ${countLabel(positiveNumber(props.roundSegmentCount, 0))} 处`;
  const previewBusyLabel = '正在生成预览，请稍候…';
  const saveBusyLabel = '正在保存，请稍候…';
  const actionDisabled = props.busy || Boolean(props.actionsDisabled);
  const exitDisabled = !['preparing', 'choosing-position'].includes(props.phase) && (actionDisabled || (props.phase === 'editing' && props.dirty));
  const helpButton = props.phase !== 'completed' && props.phase !== 'entry' ? (
    <button className="guided-review-panel-secondary" type="button" onClick={props.onHelp} disabled={false}>
      查看微调说明
    </button>
  ) : null;
  const exitButton = props.phase !== 'entry' && props.phase !== 'completed' ? (
    <button
      className="guided-review-panel-secondary guided-review-panel-exit"
      type="button"
      onClick={props.onExit}
      disabled={exitDisabled}
      title={props.phase === 'editing' && props.dirty ? '请先确认并预览本轮，或取消当前调整，再退出微调。' : undefined}
    >
      退出微调
    </button>
  ) : null;
  const undoButton = (label: string) => props.undoAvailable ? (
    <button className="guided-review-panel-secondary" type="button" onClick={props.onUndo} disabled={actionDisabled}>
      {label}
    </button>
  ) : null;
  const extendButton = props.canExtendBank ? (
    <button className="guided-review-panel-secondary" type="button" onClick={props.onOpenPositions} disabled={actionDisabled}>
      继续微调本银行其他位置
    </button>
  ) : null;

  switch (props.phase) {
    case 'entry':
      return (
        <div className="guided-review-panel-actions">
          <button className="guided-review-panel-primary" type="button" onClick={props.onExport} disabled={actionDisabled} aria-busy={props.busy || undefined}>
            {props.busy ? '正在处理，请稍候…' : '选择导出范围'}
          </button>
          <button className="guided-review-panel-secondary" type="button" onClick={props.onEnter} disabled={actionDisabled}>
            进入微调
          </button>
        </div>
      );
    case 'preparing':
      return (
        <div className="guided-review-panel-actions">
          {exitButton}
          {helpButton}
        </div>
      );
    case 'editing':
      return (
        <div className="guided-review-panel-actions">
          <button className="guided-review-panel-primary" type="button" onClick={props.onPreview} disabled={actionDisabled} aria-busy={props.busy || undefined}>
            {props.busy ? previewBusyLabel : `确认并预览本轮${positionCountLabel}`}
          </button>
          {props.dirty && (
              <button className="guided-review-panel-secondary" type="button" onClick={props.onCancelDraft} disabled={actionDisabled}>
                取消当前调整
              </button>
          )}
          {!props.dirty && undoButton('撤销上一轮')}
          {helpButton}
          {exitButton}
        </div>
      );
    case 'review':
      return (
        <div className="guided-review-panel-actions">
          <button className="guided-review-panel-primary" type="button" onClick={props.onSave} disabled={actionDisabled || roundPending === 0} aria-busy={props.busy || undefined}>
            {props.busy ? saveBusyLabel : `保存本轮${positionCountLabel}`}
          </button>
          <button className="guided-review-panel-secondary" type="button" onClick={props.onBackToEdit} disabled={actionDisabled}>
            返回调整
          </button>
          {helpButton}
          {exitButton}
        </div>
      );
    case 'round-complete':
      return (
        <div className="guided-review-panel-actions">
          <button className="guided-review-panel-primary" type="button" onClick={props.onNextRound} disabled={actionDisabled} aria-busy={props.busy || undefined}>
            {props.canFinishBank ? '检查本银行完成情况' : '开始下一位置微调'}
          </button>
          {extendButton}
          {undoButton('撤销本轮')}
          {helpButton}
          {exitButton}
        </div>
      );
    case 'choosing-position':
      return (
        <div className="guided-review-panel-actions">
          {Boolean(props.positionChoices?.length) && (
            <button className="guided-review-panel-primary" type="button" onClick={props.onStartPosition}
              disabled={actionDisabled || !props.selectedPositionKey}>开始所选位置微调</button>
          )}
          <button className="guided-review-panel-secondary" type="button" onClick={props.onCancelPositions}>返回本轮完成状态</button>
        </div>
      );
    case 'bank-complete':
      return (
        <div className="guided-review-panel-actions">
          <button className="guided-review-panel-primary" type="button" onClick={props.onCompleteBank} disabled={actionDisabled} aria-busy={props.busy || undefined}>
            {lastBank ? '完成本次微调' : '完成本银行，进入下一银行'}
          </button>
          {extendButton}
          {undoButton('撤销本轮')}
          {helpButton}
          {exitButton}
        </div>
      );
    case 'completed':
      return (
        <div className="guided-review-panel-actions">
          <button className="guided-review-panel-primary" type="button" onClick={props.onExport} disabled={actionDisabled} aria-busy={props.busy || undefined}>
            {props.busy ? '正在导出，请稍候…' : '导出审核结果'}
          </button>
          <button className="guided-review-panel-secondary" type="button" onClick={props.onEnter} disabled={actionDisabled}>
            重新进入微调
          </button>
        </div>
      );
  }
}

export function GuidedReviewPanel(props: GuidedReviewPanelProps) {
  const titleId = useId();
  const feedbackId = useId();
  const hasChildren = props.children !== undefined && props.children !== null;
  const hasFeedback = Boolean(props.error || props.message);

  return (
    <section
      className="guided-review-panel"
      data-phase={props.phase}
      data-busy={props.busy ? 'true' : 'false'}
      aria-labelledby={titleId}
      aria-describedby={hasFeedback ? feedbackId : undefined}
      aria-busy={props.busy || undefined}
    >
      <Header props={props} titleId={titleId} />
      <div className="guided-review-panel-body">
        <PhaseContent props={props} />
        {hasChildren && <div className="guided-review-panel-children">{props.children}</div>}
        {(props.error || props.message) && (
          <div className="guided-review-panel-feedback" id={feedbackId}>
            {props.error && <p className="guided-review-panel-error" role="alert">{props.error}</p>}
            {props.message && <p className="guided-review-panel-message" role="status" aria-live="polite">{props.message}</p>}
          </div>
        )}
      </div>
      <footer className="guided-review-panel-footer">
        <Actions props={props} />
      </footer>
    </section>
  );
}

export default GuidedReviewPanel;
