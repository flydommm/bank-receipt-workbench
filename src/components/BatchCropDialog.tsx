import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type { BatchCropPlan } from '../domain/batchCrop';
import type { PdfRect, ReviewSegment } from '../domain/cropReview';
import './BatchCropDialog.css';

export type BatchCropDialogProps = {
  sample: ReviewSegment;
  scope: 'source' | 'filtered';
  onScopeChange: (scope: 'source' | 'filtered') => void;
  plan: BatchCropPlan | null;
  progress: string;
  busy: boolean;
  applying: boolean;
  error?: string;
  loadPreview: (segment: ReviewSegment) => Promise<string>;
  onApply: () => void;
  onClose: () => void;
};

type InertSnapshot = {
  element: HTMLElement;
  hadAttribute: boolean;
  previousProperty: boolean;
};

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
}

function safeSourceName(segment: ReviewSegment): string {
  const sourceName = segment.sourceName?.trim();
  if (sourceName) return sourceName;
  const parts = segment.sourcePath.split(/[\\/]/);
  return parts[parts.length - 1] || segment.sourcePath;
}

function targetLabel(segment: ReviewSegment): string {
  return `${safeSourceName(segment)} · 第 ${segment.sourcePage} 页 · 片段 ${segment.segmentNo}`;
}

function rectFor(segment: ReviewSegment): PdfRect | null {
  return segment.finalRect ?? segment.candidateRect ?? segment.matchRect ?? null;
}

function rectStyle(rect: PdfRect | null, pageWidth: number, pageHeight: number): CSSProperties {
  if (!rect || !Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) {
    return { display: 'none' };
  }
  return {
    left: `${(rect.x0 / pageWidth) * 100}%`,
    top: `${(rect.y0 / pageHeight) * 100}%`,
    width: `${((rect.x1 - rect.x0) / pageWidth) * 100}%`,
    height: `${((rect.y1 - rect.y0) / pageHeight) * 100}%`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '当前目标预览加载失败，请重试。';
}

function setElementInert(element: HTMLElement, inert: boolean): void {
  const withInert = element as HTMLElement & { inert?: boolean };
  withInert.inert = inert;
  if (inert) element.setAttribute('inert', '');
  else element.removeAttribute('inert');
}

export function BatchCropDialog({
  sample,
  scope,
  onScopeChange,
  plan,
  progress,
  busy,
  applying,
  error,
  loadPreview,
  onApply,
  onClose,
}: BatchCropDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
    openerRef.current = document.activeElement;
  }

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewData, setPreviewData] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | undefined>();
  const [checked, setChecked] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [expandedPreview, setExpandedPreview] = useState(false);
  const requestVersionRef = useRef(0);
  const previousScopeRef = useRef(scope);
  const previousPlanRef = useRef(plan);
  const loadPreviewRef = useRef(loadPreview);
  const callbacksRef = useRef({ onScopeChange, onApply, onClose });
  const applyingRef = useRef(applying);
  loadPreviewRef.current = loadPreview;
  callbacksRef.current = { onScopeChange, onApply, onClose };
  applyingRef.current = applying;

  const applicable = plan?.applicable ?? [];
  const activeIndex = applicable.length === 0 ? 0 : Math.min(selectedIndex, applicable.length - 1);
  const activeItem = applicable[activeIndex] ?? null;
  const canApply = Boolean(
    activeItem
      && previewData
      && checked
      && !busy
      && !applying,
  );

  function resetPreview(): void {
    requestVersionRef.current += 1;
    setPreviewData(null);
    setPreviewError(undefined);
    setPreviewLoading(false);
    setChecked(false);
    setExpandedPreview(false);
  }

  function selectItem(index: number): void {
    if (busy || applying || index < 0 || index >= applicable.length || index === activeIndex) return;
    resetPreview();
    setSelectedIndex(index);
  }

  function retryPreview(): void {
    if (busy || applying || !activeItem) return;
    resetPreview();
    setPreviewAttempt((attempt) => attempt + 1);
  }

  function handleScopeChange(event: ChangeEvent<HTMLSelectElement>): void {
    const nextScope = event.currentTarget.value as 'source' | 'filtered';
    if (nextScope === scope || busy || applying) return;
    previousScopeRef.current = nextScope;
    resetPreview();
    setSelectedIndex(0);
    callbacksRef.current.onScopeChange(nextScope);
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  useEffect(() => {
    if (previousScopeRef.current === scope) return;
    previousScopeRef.current = scope;
    resetPreview();
    setSelectedIndex(0);
  }, [scope]);

  useEffect(() => {
    if (previousPlanRef.current === plan) return;
    previousPlanRef.current = plan;
    resetPreview();
    setSelectedIndex(0);
  }, [plan]);

  useEffect(() => {
    const item = plan?.applicable[activeIndex] ?? null;
    const version = ++requestVersionRef.current;
    let disposed = false;
    setPreviewData(null);
    setPreviewError(undefined);
    setChecked(false);
    if (!item) {
      setPreviewLoading(false);
      return () => {
        disposed = true;
        requestVersionRef.current += 1;
      };
    }

    setPreviewLoading(true);
    void Promise.resolve()
      .then(() => loadPreviewRef.current(item.before))
      .then((data) => {
        if (disposed || version !== requestVersionRef.current) return;
        setPreviewData(data);
      })
      .catch((loadError: unknown) => {
        if (disposed || version !== requestVersionRef.current) return;
        setPreviewError(errorMessage(loadError));
      })
      .finally(() => {
        if (disposed || version !== requestVersionRef.current) return;
        setPreviewLoading(false);
      });

    return () => {
      disposed = true;
      requestVersionRef.current += 1;
    };
  }, [activeIndex, plan, previewAttempt]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const inertSnapshots: InertSnapshot[] = [];
    const inertTargets = new Set<HTMLElement>();
    const addSiblings = (element: Element | null): void => {
      const parent = element?.parentElement;
      if (!parent) return;
      for (const child of Array.from(parent.children)) {
        if (child === element || !(child instanceof HTMLElement)) continue;
        inertTargets.add(child);
      }
    };
    // The backdrop is the modal's direct child. Inert its siblings inside the
    // app shell so keyboard and pointer interaction cannot reach the locked
    // review workspace while the dialog is open.
    addSiblings(dialog.parentElement);
    const main = dialog.closest('main');
    if (main) addSiblings(main);
    for (const element of inertTargets) {
      inertSnapshots.push({
        element,
        hadAttribute: element.hasAttribute('inert'),
        previousProperty: Boolean((element as HTMLElement & { inert?: boolean }).inert),
      });
      setElementInert(element, true);
    }

    const initial = focusableElements(dialog)[0] ?? dialog;
    initial.focus();
    return () => {
      requestVersionRef.current += 1;
      for (const snapshot of inertSnapshots) {
        const withInert = snapshot.element as HTMLElement & { inert?: boolean };
        withInert.inert = snapshot.previousProperty;
        if (snapshot.hadAttribute) snapshot.element.setAttribute('inert', '');
        else snapshot.element.removeAttribute('inert');
      }
      const opener = openerRef.current;
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const handleDocumentKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || applyingRef.current) return;
      event.preventDefault();
      callbacksRef.current.onClose();
    };
    document.addEventListener('keydown', handleDocumentKeyDown, true);
    return () => document.removeEventListener('keydown', handleDocumentKeyDown, true);
  }, []);

  const oldRectStyle = activeItem
    ? rectStyle(rectFor(activeItem.before), activeItem.before.pageWidth, activeItem.before.pageHeight)
    : { display: 'none' };
  const newRectStyle = activeItem
    ? rectStyle(rectFor(activeItem.after), activeItem.after.pageWidth, activeItem.after.pageHeight)
    : { display: 'none' };

  return (
    <div className="batch-crop-backdrop">
      <div
        ref={dialogRef}
        className="batch-crop-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="应用到同类片段"
        aria-labelledby="batch-crop-dialog-title"
        aria-busy={busy || applying || previewLoading || undefined}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="batch-crop-dialog-header">
          <div>
            <span className="batch-crop-dialog-eyebrow">CROP TEMPLATE REVIEW</span>
            <h2 id="batch-crop-dialog-title">应用到同类片段</h2>
            <p className="batch-crop-dialog-sample">样本：{targetLabel(sample)}</p>
          </div>
          <span className="batch-crop-dialog-progress" role="status" aria-live="polite">
            {progress || (busy ? '正在准备批量调整…' : '请检查当前预览。')}
          </span>
        </header>

        <div className="batch-crop-dialog-content">
          <aside className="batch-crop-dialog-sidebar" aria-label="批量调整摘要">
            <section className="batch-crop-dialog-section batch-crop-dialog-scope">
              <label htmlFor="batch-crop-scope">应用范围</label>
              <select
                id="batch-crop-scope"
                aria-label="应用范围"
                value={scope}
                disabled={busy || applying}
                onChange={handleScopeChange}
              >
                <option value="source">当前 PDF</option>
                <option value="filtered">当前筛选结果（可跨 PDF）</option>
              </select>
              <p className="batch-crop-dialog-help">样本自身不计入应用数量。</p>
            </section>

            <section className="batch-crop-dialog-section" aria-labelledby="batch-crop-counts-title">
              <h3 id="batch-crop-counts-title">检查结果</h3>
              <dl className="batch-crop-dialog-counts">
                <div><dt>适用</dt><dd>{applicable.length}</dd></div>
                <div><dt>跳过</dt><dd>{plan?.skipped.length ?? 0}</dd></div>
              </dl>
              {error && <p className="batch-crop-dialog-error" role="alert">{error}</p>}
            </section>

            <section className="batch-crop-dialog-section batch-crop-dialog-skipped" aria-labelledby="batch-crop-skipped-title">
              <h3 id="batch-crop-skipped-title">跳过明细</h3>
              {plan?.skipped.length ? (
                <ul>
                  {plan.skipped.map(({ segment, reason }) => (
                    <li key={segment.id}>
                      <strong>{targetLabel(segment)}</strong>
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="batch-crop-dialog-help">暂无跳过项。</p>
              )}
            </section>
          </aside>

          <section className="batch-crop-dialog-preview-panel" aria-label="逐项预览">
            <div className="batch-crop-dialog-preview-toolbar">
              <div>
                <span className="batch-crop-dialog-section-kicker">当前目标</span>
                {activeItem ? (
                  <>
                    <strong>{safeSourceName(activeItem.before)}</strong>
                    <span>来源：{activeItem.before.sourcePath}</span>
                    <span>第 {activeItem.before.sourcePage} 页 · 片段 {activeItem.before.segmentNo}</span>
                  </>
                ) : (
                  <strong>没有可应用的同类片段。</strong>
                )}
              </div>
              <label className="batch-crop-dialog-item-select-label">
                选择预览片段
                <select
                  aria-label="选择预览片段"
                  value={String(activeIndex)}
                  disabled={busy || applying || applicable.length === 0}
                  onChange={(event) => selectItem(Number(event.currentTarget.value))}
                >
                  {applicable.map(({ before }, index) => (
                    <option key={before.id} value={String(index)}>{targetLabel(before)}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="batch-crop-dialog-preview-wrap">
              <div className="batch-crop-dialog-image-scroll">
                {previewData && activeItem ? (
                  <div
                    className={`batch-crop-dialog-preview-page${expandedPreview ? ' is-expanded' : ''}`}
                    style={{ aspectRatio: `${activeItem.before.pageWidth} / ${activeItem.before.pageHeight}` }}
                  >
                    <img src={previewData} alt={`${safeSourceName(activeItem.before)} 第 ${activeItem.before.sourcePage} 页预览`} />
                    <div
                      className="batch-crop-dialog-box batch-crop-dialog-box-old"
                      data-testid="batch-crop-old-box"
                      style={oldRectStyle}
                      aria-hidden="true"
                    />
                    <div
                      className="batch-crop-dialog-box batch-crop-dialog-box-new"
                      data-testid="batch-crop-new-box"
                      style={newRectStyle}
                      aria-hidden="true"
                    />
                  </div>
                ) : (
                  <div className="batch-crop-dialog-preview-placeholder" role="status" aria-live="polite">
                    {previewLoading ? '正在加载当前目标预览…' : previewError || '当前目标尚未加载预览。'}
                  </div>
                )}
              </div>
              {previewData && activeItem && (
                <div className="batch-crop-dialog-legend" aria-label="裁剪框图例">
                  <span><i className="batch-crop-dialog-legend-old" aria-hidden="true" />原裁剪框</span>
                  <span><i className="batch-crop-dialog-legend-new" aria-hidden="true" />新裁剪框</span>
                  <button
                    type="button"
                    aria-pressed={expandedPreview}
                    disabled={busy || applying}
                    onClick={() => setExpandedPreview((expanded) => !expanded)}
                  >
                    {expandedPreview ? '适应整页' : '放大预览'}
                  </button>
                </div>
              )}
            </div>

            {previewError && <p className="batch-crop-dialog-preview-error" role="alert">{previewError}</p>}
            {previewError && activeItem && !busy && !applying && (
              <button type="button" className="batch-crop-dialog-retry" onClick={retryPreview}>
                重试预览
              </button>
            )}
            <div className="batch-crop-dialog-navigation">
              <button
                type="button"
                disabled={busy || applying || activeIndex <= 0 || applicable.length === 0}
                onClick={() => selectItem(activeIndex - 1)}
              >
                上一项
              </button>
              <span className="batch-crop-dialog-item-position">
                {applicable.length > 0 ? `${activeIndex + 1} / ${applicable.length}` : '0 / 0'}
              </span>
              <button
                type="button"
                disabled={busy || applying || activeIndex >= applicable.length - 1 || applicable.length === 0}
                onClick={() => selectItem(activeIndex + 1)}
              >
                下一项
              </button>
            </div>
            <label className="batch-crop-dialog-check">
              <input
                type="checkbox"
                aria-label="已检查预览（确认原裁剪框与新裁剪框）"
                checked={checked}
                disabled={busy || applying || !previewData || !activeItem}
                onChange={(event) => setChecked(event.currentTarget.checked)}
              />
              已检查预览
            </label>
          </section>
        </div>

        <footer className="batch-crop-dialog-actions">
          <button
            type="button"
            disabled={applying}
            onClick={() => {
              if (!applying) callbacksRef.current.onClose();
            }}
          >
            取消
          </button>
          <button
            type="button"
            className="batch-crop-dialog-apply"
            disabled={!canApply}
            onClick={() => {
              if (canApply) callbacksRef.current.onApply();
            }}
          >
            应用到 {applicable.length} 个片段
          </button>
        </footer>
      </div>
    </div>
  );
}

export default BatchCropDialog;
