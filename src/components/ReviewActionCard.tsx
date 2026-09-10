import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ReviewStatus } from '../domain/cropReview';

export type ActionFeedback =
  | { kind: 'status' | 'error'; message: string }
  | null;

export type ActionSegment = {
  sourcePage: number;
  segmentNo: number;
  reviewStatus: ReviewStatus;
};

export type ExportResultSummary = {
  directory: string;
  indexPath: string | null;
  pdfPath: string;
  rowCount: number | null;
  pageCount: number;
  pdfCount?: number;
};

type BaseProps = {
  feedback: ActionFeedback;
  result: ExportResultSummary | null;
  onOpenResult: () => void;
};

type ReviewProps = BaseProps & {
  mode: 'review';
  currentSegment: ActionSegment | null;
  fragmentActionsEnabled: boolean;
  fragmentDisabledReason?: string;
  onKeepFullPage: () => void;
  hasLegacySuggestion?: boolean;
  onRestoreLegacySuggestion?: () => void;
  onConfirmCurrent: () => void;
  canConfirmGroup: boolean;
  groupSavePending: boolean;
  groupConfirmed: boolean;
  unresolvedCount: number;
  onConfirmGroup: () => void;
  canGeneratePreview: boolean;
  previewGenerating: boolean;
  onGeneratePreview: () => void;
  totalCount: number;
  reviewFrozenReason?: string;
  operationTools?: ReactNode;
  scopeSelectionEnabled?: boolean;
};

type ExportProps = BaseProps & {
  mode: 'export';
  includeXlsx: boolean;
  onIncludeXlsxChange: (checked: boolean) => void;
  optionsFrozen?: boolean;
  exportPending: boolean;
  canExport: boolean;
  onReturn: () => void;
  onExport: () => void;
};

export type ReviewActionCardProps = ReviewProps | ExportProps;

const DEFAULT_FRAGMENT_DISABLED_REASON = '当前预览页无命中，请选择右侧片段继续审核';

const STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: '待复核',
  needs_review: '需复核',
  confirmed: '已确认',
  blocked: '已阻塞',
};

function fileName(path: string): string {
  const normalizedPath = path.trim().replace(/[\\/]+$/, '');
  if (!normalizedPath) return '未命名文件';
  const parts = normalizedPath.split(/[\\/]/);
  return parts.at(-1) || '未命名文件';
}

function Feedback({ feedback }: { feedback: ActionFeedback }) {
  if (!feedback) return null;

  return (
    <div
      className="review-action-card-feedback"
      data-kind={feedback.kind}
      role={feedback.kind === 'error' ? 'alert' : 'status'}
    >
      {feedback.message}
    </div>
  );
}

function ResultSummary({ result, onOpenResult }: Pick<BaseProps, 'result' | 'onOpenResult'>) {
  if (!result) return null;

  return (
    <div className="review-action-card-result" role="region" aria-label="导出结果">
      <strong>导出成功</strong>
      {result.indexPath && (
        <span>
          <span className="review-action-card-result-label">XLSX：</span>
          <span className="review-action-card-result-file">{fileName(result.indexPath)}</span>
        </span>
      )}
      <span>
        <span className="review-action-card-result-label">PDF：</span>
        <span className="review-action-card-result-file">{result.pdfCount && result.pdfCount > 1 ? `${result.pdfCount} 份 PDF（详见结果目录）` : fileName(result.pdfPath)}</span>
      </span>
      <span>{`目录：${result.directory}`}</span>
      {result.rowCount === null
        ? <span>{result.pageCount} 页 PDF</span>
        : <span>{result.rowCount} 条索引 · {result.pageCount} 页 PDF</span>}
      <button className="review-action-card-link" type="button" onClick={onOpenResult}>
        打开结果目录
      </button>
    </div>
  );
}

function ReviewActionCardView(props: ReviewProps) {
  const phase = props.groupConfirmed ? 'confirmed' : 'review';
  const [detailsOpen, setDetailsOpen] = useState(false);
  const previousPhaseRef = useRef<'review' | 'confirmed' | null>(null);
  const mainActionRef = useRef<HTMLButtonElement | null>(null);
  const phaseHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const frozen = Boolean(props.reviewFrozenReason);
  const fragmentTargetAvailable = Boolean(props.currentSegment) && props.fragmentActionsEnabled;
  const fragmentActionsDisabled = frozen
    || !fragmentTargetAvailable
    || props.groupSavePending
    || props.previewGenerating;
  const groupDisabled = frozen
    || !props.canConfirmGroup
    || props.groupSavePending
    || props.previewGenerating;
  const previewDisabled = frozen
    || !props.canGeneratePreview
    || props.previewGenerating
    || props.groupSavePending;
  const currentAlreadyConfirmed = props.currentSegment?.reviewStatus === 'confirmed';
  const fragmentReason = props.fragmentDisabledReason?.trim() || DEFAULT_FRAGMENT_DISABLED_REASON;
  const unresolvedLabel = props.unresolvedCount > 0
    ? `未解决 ${props.unresolvedCount} 个片段；阻塞或需复核片段不能整组确认。`
    : props.currentSegment || props.canConfirmGroup
      ? props.scopeSelectionEnabled ? '全部片段已有合法候选，可选择导出范围。' : '全部片段已有合法候选，请确认整组后导出。'
      : '暂无可审核片段，请先完成分析。';
  const fragmentDisabledText = !fragmentTargetAvailable
    ? fragmentReason
    : props.groupSavePending
      ? '正在保存整组审核'
      : currentAlreadyConfirmed
        ? '当前片段已经确认'
        : props.previewGenerating
          ? '正在生成 PDF 导出预览'
          : null;
  const groupDisabledText = props.groupSavePending
    ? '正在保存整组审核'
    : !props.canConfirmGroup
      ? unresolvedLabel
      : props.previewGenerating
        ? '正在生成 PDF 导出预览'
        : null;
  const previewDisabledText = props.previewGenerating
    ? '正在生成 PDF 导出预览'
    : !props.canGeneratePreview
      ? props.scopeSelectionEnabled ? '任务和审核保存完成后，可进入导出设置' : '整组确认和页面校验完成后才能生成 PDF 导出预览'
      : null;

  useEffect(() => {
    if (props.feedback?.kind === 'error') setDetailsOpen(true);
    else setDetailsOpen(false);
  }, [props.feedback?.kind, props.feedback?.message]);

  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    if (previousPhase === phase || (previousPhase === null && phase === 'review')) return;
    if (mainActionRef.current && !mainActionRef.current.disabled) mainActionRef.current.focus();
    else phaseHeadingRef.current?.focus();
  }, [phase]);

  const keepDescription = frozen
    ? 'review-action-card-frozen-reason'
    : fragmentActionsDisabled && fragmentDisabledText
      ? 'review-action-card-fragment-disabled-reason'
      : undefined;
  const confirmDescription = frozen
    ? 'review-action-card-frozen-reason'
    : (fragmentActionsDisabled || currentAlreadyConfirmed) && fragmentDisabledText
      ? 'review-action-card-fragment-disabled-reason'
      : undefined;
  const groupDescription = frozen
    ? 'review-action-card-frozen-reason'
    : groupDisabled && groupDisabledText
      ? 'review-action-card-group-disabled-reason'
      : undefined;
  const previewDescription = frozen
    ? 'review-action-card-frozen-reason'
    : previewDisabled && previewDisabledText
      ? 'review-action-card-preview-disabled-reason'
      : undefined;

  return (
    <section
      className="review-action-card"
      data-mode="review"
      data-phase={phase}
      data-expanded={detailsOpen ? 'true' : 'false'}
      aria-labelledby="review-action-card-title"
    >
      <div className="review-action-card-main">
        <div className="review-action-card-context">
          <h3 ref={phaseHeadingRef} id="review-action-card-title" tabIndex={-1}>当前审核操作</h3>
          {phase === 'confirmed' ? (
            <span>{`已确认 ${props.totalCount} / ${props.totalCount}`}</span>
          ) : (
            <>
              <span>{props.currentSegment ? `已选中第 ${props.currentSegment.sourcePage} 页片段 ${props.currentSegment.segmentNo}` : '未选择片段'}</span>
              {props.currentSegment && <span role="status">当前状态：{STATUS_LABELS[props.currentSegment.reviewStatus]}</span>}
            </>
          )}
          {props.reviewFrozenReason && <small id="review-action-card-frozen-reason" role="status" aria-live="polite" title={props.reviewFrozenReason}>{props.reviewFrozenReason}</small>}
          {props.feedback && !detailsOpen && (
            <span
              className="review-action-card-feedback-compact"
              data-kind={props.feedback.kind}
              title={props.feedback.message}
              role={props.feedback.kind === 'error' ? 'alert' : 'status'}
            >
              {props.feedback.kind === 'error' ? '错误：' : '状态：'}{props.feedback.message}
            </span>
          )}
          {fragmentDisabledText && <small id="review-action-card-fragment-disabled-reason" className="sr-only">{fragmentDisabledText}</small>}
          {groupDisabledText && <small id="review-action-card-group-disabled-reason" className="sr-only">{groupDisabledText}</small>}
          {previewDisabledText && <small id="review-action-card-preview-disabled-reason" className="sr-only">{previewDisabledText}</small>}
        </div>

        <div className="review-action-card-actions">
          {phase === 'review' ? (
            <>
              <button className="ghost-button" type="button" disabled={fragmentActionsDisabled} aria-describedby={keepDescription} onClick={props.onKeepFullPage}>保留整页</button>
              <button className="ghost-button" type="button" disabled={fragmentActionsDisabled || currentAlreadyConfirmed} aria-describedby={confirmDescription} onClick={props.onConfirmCurrent}>确认当前片段</button>
              <button ref={mainActionRef} className="primary-button" type="button" disabled={groupDisabled} aria-describedby={groupDescription} aria-busy={props.groupSavePending || undefined} onClick={props.onConfirmGroup}>
                {props.groupSavePending ? '保存中…' : '确认整组'}
              </button>
            </>
          ) : null}
          {(phase === 'confirmed' || props.scopeSelectionEnabled) && (
            <button ref={phase === 'confirmed' ? mainActionRef : undefined} className="review-action-card-preview-button" type="button" disabled={previewDisabled} aria-describedby={previewDescription} aria-busy={props.previewGenerating || undefined} onClick={props.onGeneratePreview}>
              {props.previewGenerating ? '正在生成 PDF 导出预览…' : phase === 'review' ? '选择导出范围' : '生成 PDF 导出预览'}
              <span aria-hidden="true">→</span>
            </button>
          )}
          <button className="review-action-card-toggle" type="button" aria-expanded={detailsOpen} aria-controls="review-action-card-details" onClick={() => setDetailsOpen((open) => !open)}>
            {detailsOpen ? '收起详情' : '查看详情'}
          </button>
        </div>
      </div>

      {props.operationTools}
      {phase === 'review' && props.hasLegacySuggestion && props.onRestoreLegacySuggestion && (
        <div className="review-action-card-history">
          <span>旧版本裁剪记录可供参考，恢复后需重新确认。</span>
          <button className="review-action-card-link" type="button" disabled={fragmentActionsDisabled} aria-describedby={keepDescription} onClick={props.onRestoreLegacySuggestion}>恢复历史裁剪建议</button>
        </div>
      )}

      <div id="review-action-card-details" className="review-action-card-details" data-testid="review-action-card-details" hidden={!detailsOpen}>
        <p className="review-action-card-summary">{phase === 'confirmed' ? '整组审核已确认。' : unresolvedLabel}</p>
        {detailsOpen && phase === 'review' && fragmentDisabledText && <p>片段操作：{fragmentDisabledText}</p>}
        {detailsOpen && phase === 'review' && groupDisabledText && <p>整组操作：{groupDisabledText}</p>}
        {detailsOpen && phase === 'confirmed' && previewDisabledText && <p>预览操作：{previewDisabledText}</p>}
        {detailsOpen && <Feedback feedback={props.feedback} />}
        <ResultSummary result={props.result} onOpenResult={props.onOpenResult} />
      </div>
    </section>
  );
}

function ExportActionCardView(props: ExportProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const returnActionRef = useRef<HTMLButtonElement | null>(null);
  const exportActionRef = useRef<HTMLButtonElement | null>(null);
  const previousCanExportRef = useRef(props.canExport);
  const exportLabel = props.exportPending
    ? (props.includeXlsx ? '正在导出 XLSX 与 PDF…' : '正在导出 PDF…')
    : (props.includeXlsx ? '选择目录并导出 XLSX 与 PDF' : '选择目录并导出 PDF');

  useEffect(() => {
    if (props.canExport && !props.exportPending) exportActionRef.current?.focus();
    else returnActionRef.current?.focus();
  }, []);

  useEffect(() => {
    if (props.feedback?.kind === 'error') setDetailsOpen(true);
    else setDetailsOpen(false);
  }, [props.feedback?.kind, props.feedback?.message]);

  useEffect(() => {
    const previouslyAvailable = previousCanExportRef.current;
    previousCanExportRef.current = props.canExport;
    if (!previouslyAvailable && props.canExport && !props.exportPending && document.activeElement === returnActionRef.current) {
      exportActionRef.current?.focus();
    }
  }, [props.canExport, props.exportPending]);

  return (
    <section className="review-action-card" data-mode="export" data-phase="export" aria-labelledby="export-action-card-title">
      <div className="review-action-card-main">
        <div className="review-action-card-context">
          <h3 id="export-action-card-title">导出已确认内容</h3>
          {props.feedback && !detailsOpen && (
            <span
              className="review-action-card-feedback-compact"
              data-kind={props.feedback.kind}
              title={props.feedback.message}
              role={props.feedback.kind === 'error' ? 'alert' : 'status'}
            >
              {props.feedback.kind === 'error' ? '错误：' : '状态：'}{props.feedback.message}
            </span>
          )}
          <label htmlFor="review-action-card-include-xlsx">
            <input id="review-action-card-include-xlsx" type="checkbox" checked={props.includeXlsx} disabled={props.exportPending || props.optionsFrozen} onChange={(event) => props.onIncludeXlsxChange(event.target.checked)} />
            <span>同时导出审核索引 XLSX（可选）</span>
          </label>
        </div>
        <div className="review-action-card-actions">
          <button ref={returnActionRef} className="ghost-button" type="button" onClick={props.onReturn} disabled={props.exportPending}>返回调整</button>
          <button ref={exportActionRef} className="review-action-card-export-button" type="button" disabled={!props.canExport || props.exportPending} aria-busy={props.exportPending || undefined} onClick={props.onExport}>{exportLabel}</button>
          <button className="review-action-card-toggle" type="button" aria-expanded={detailsOpen} aria-controls="review-action-card-details" onClick={() => setDetailsOpen((open) => !open)}>
            {detailsOpen ? '收起详情' : '查看详情'}
          </button>
        </div>
      </div>
      <div id="review-action-card-details" className="review-action-card-details" data-testid="review-action-card-details" hidden={!detailsOpen}>
        <p>{props.optionsFrozen ? '导出范围、输出形式和 XLSX 选项已固定；更改选项请返回调整。' : '用于批量核查、留痕或交给 AI 复查；日常导出无需勾选。'}</p>
        {detailsOpen && <Feedback feedback={props.feedback} />}
        <ResultSummary result={props.result} onOpenResult={props.onOpenResult} />
      </div>
    </section>
  );
}

export function ReviewActionCard(props: ReviewActionCardProps) {
  if (props.mode === 'review') return <ReviewActionCardView {...props} />;
  return <ExportActionCardView {...props} />;
}

export default ReviewActionCard;
