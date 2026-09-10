import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import {
  GUIDE_STEPS,
  HELP_TABS,
  OVERVIEW_FEATURES,
  PRIVACY_NOTE,
  PRODUCT_IDENTITY,
  RELEASE_NOTES,
  type HelpTabId,
} from '../domain/helpContent';
import {
  buildFeedbackReport,
  validateFeedbackDraft,
  MAX_FEEDBACK_FIELD_LENGTH,
  type FeedbackDraft,
  type FeedbackOcrState,
} from '../domain/feedbackReport';
import type {
  OcrCacheClearResult,
  OcrCacheInfo,
  OcrHealthCode,
} from './localEngineAdapter';
import { copyFeedbackReport, saveFeedbackReport } from '../services/localFeedback';
import './HelpCenterDialog.css';

export type HelpCenterOcrState = {
  readiness: FeedbackOcrState;
  message?: string;
  code?: OcrHealthCode;
};

export type HelpCenterOcrCacheInfo = OcrCacheInfo;
export type HelpCenterOcrCacheClearResult = OcrCacheClearResult;

export type HelpCenterDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Optional legacy props retained for other HelpCenterDialog callers. */
  engineStatus?: 'checking' | 'ready' | 'unavailable';
  ocrReady?: boolean | null;
  ocrState?: HelpCenterOcrState;
  onCheckOcr?: () => void | Promise<void>;
  ocrCacheInfo?: HelpCenterOcrCacheInfo | null;
  onReadOcrCache?: () => HelpCenterOcrCacheInfo | void | Promise<HelpCenterOcrCacheInfo | void>;
  onClearOcrCache?: () => HelpCenterOcrCacheClearResult | void | Promise<HelpCenterOcrCacheClearResult | void>;
  /** Disable cache clearing while the current analysis owns the OCR cache. */
  analysisInProgress?: boolean;
};

type FeedbackFormState = FeedbackDraft;

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

const INITIAL_FEEDBACK: FeedbackFormState = {
  category: 'problem',
  description: '',
  steps: '',
  expected: '',
  actual: '',
};

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => (
      element.getAttribute('aria-hidden') !== 'true'
      && element.closest('[hidden]') === null
    ));
}

function setElementInert(element: HTMLElement, inert: boolean): void {
  const withInert = element as HTMLElement & { inert?: boolean };
  withInert.inert = inert;
  if (inert) element.setAttribute('inert', '');
  else element.removeAttribute('inert');
}

function statusLabel(engineStatus: HelpCenterDialogProps['engineStatus']): string {
  if (engineStatus === 'ready') return '本地引擎已连接';
  if (engineStatus === 'unavailable') return '本地引擎不可用';
  return '正在检查本地引擎';
}

function ocrLabel(state: HelpCenterOcrState, legacy = false): string {
  if (legacy) {
    if (state.readiness === 'ready') return 'OCR 就绪';
    if (state.readiness === 'unavailable') return 'OCR 不可用';
    return 'OCR 检查中';
  }
  if (state.readiness === 'installed') return 'OCR 已安装，待验证';
  if (state.readiness === 'verifying') return '正在检测 OCR';
  if (state.readiness === 'ready') return 'OCR 已验证可用';
  if (state.readiness === 'unavailable') return 'OCR 不可用';
  if (state.readiness === 'failed') return 'OCR 验证失败';
  return 'OCR 状态未知';
}

function ocrStateFromLegacy(ocrReady: boolean | null): HelpCenterOcrState {
  return {
    readiness: ocrReady === true ? 'ready' : ocrReady === false ? 'unavailable' : 'unknown',
  };
}

function formatCacheBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isOcrCacheInfo(value: unknown): value is HelpCenterOcrCacheInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.status === 'ok'
    && typeof payload.available === 'boolean'
    && typeof payload.entries === 'number'
    && Number.isSafeInteger(payload.entries)
    && payload.entries >= 0
    && typeof payload.bytes === 'number'
    && Number.isSafeInteger(payload.bytes)
    && payload.bytes >= 0
    && payload.max_bytes === 268_435_456
    && payload.retention_days === 30;
}

function isOcrCacheClearResult(value: unknown): value is HelpCenterOcrCacheClearResult {
  if (!isOcrCacheInfo(value)) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.removed_entries === 'number'
    && Number.isSafeInteger(payload.removed_entries)
    && payload.removed_entries >= 0
    && typeof payload.failed_entries === 'number'
    && Number.isSafeInteger(payload.failed_entries)
    && payload.failed_entries >= 0;
}

export function HelpCenterDialog({
  open,
  onClose,
  engineStatus = 'checking',
  ocrReady = null,
  ocrState,
  onCheckOcr,
  ocrCacheInfo,
  onReadOcrCache,
  onClearOcrCache,
  analysisInProgress,
}: HelpCenterDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [activeTab, setActiveTab] = useState<HelpTabId>('overview');
  const [feedback, setFeedback] = useState<FeedbackFormState>(INITIAL_FEEDBACK);
  const [previewRequested, setPreviewRequested] = useState(false);
  const [feedbackAction, setFeedbackAction] = useState<'idle' | 'copying' | 'saving'>('idle');
  const [ocrCheckBusy, setOcrCheckBusy] = useState(false);
  const ocrCheckBusyRef = useRef(false);
  const ocrCheckMountedRef = useRef(true);
  const [ocrCacheView, setOcrCacheView] = useState<HelpCenterOcrCacheInfo | null>(ocrCacheInfo ?? null);
  const [ocrCacheAction, setOcrCacheAction] = useState<'idle' | 'reading' | 'clearing'>('idle');
  const ocrCacheActionRef = useRef(false);
  const ocrCacheRequestRef = useRef(0);
  const ocrCacheMountedRef = useRef(true);
  const openRef = useRef(open);
  openRef.current = open;
  const [ocrCacheMessage, setOcrCacheMessage] = useState<{
    kind: 'status' | 'error';
    text: string;
  } | null>(null);
  const [feedbackActionMessage, setFeedbackActionMessage] = useState<{
    kind: 'status' | 'error';
    text: string;
  } | null>(null);

  const effectiveOcrState = ocrState ?? ocrStateFromLegacy(ocrReady);
  const usingLegacyOcrState = ocrState === undefined;

  const feedbackReportState = useMemo(() => {
    const validationError = validateFeedbackDraft(feedback);
    if (validationError) return { text: '', error: validationError };
    try {
      return {
        text: buildFeedbackReport(feedback, {
          appVersion: PRODUCT_IDENTITY.version,
          engineStatus,
          ...(usingLegacyOcrState
            ? { ocrReady }
            : { ocrState: effectiveOcrState.readiness }),
        }),
        error: '',
      };
    } catch (reportError: unknown) {
      return {
        text: '',
        error: reportError instanceof Error ? reportError.message : '反馈预览生成失败，请重试。',
      };
    }
  }, [effectiveOcrState.readiness, engineStatus, feedback, ocrReady, usingLegacyOcrState]);

  const feedbackPreview = feedbackReportState.text;
  const feedbackError = feedbackReportState.error;

  useEffect(() => {
    ocrCheckMountedRef.current = true;
    return () => {
      ocrCheckMountedRef.current = false;
      ocrCheckBusyRef.current = false;
    };
  }, []);

  useEffect(() => {
    ocrCacheMountedRef.current = true;
    return () => {
      ocrCacheMountedRef.current = false;
      ocrCacheActionRef.current = false;
      ocrCacheRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (ocrCacheInfo !== undefined) setOcrCacheView(ocrCacheInfo);
  }, [ocrCacheInfo]);

  useEffect(() => {
    if (open) return;
    // A closed dialog should not commit a result from an operation started in
    // an earlier opening. The next opening can start a fresh request.
    ocrCacheRequestRef.current += 1;
    ocrCacheActionRef.current = false;
    setOcrCacheAction('idle');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const inertTargets = new Set<HTMLElement>();
    const addSiblings = (element: Element | null): void => {
      const parent = element?.parentElement;
      if (!parent) return;
      for (const child of Array.from(parent.children)) {
        if (child === element || !(child instanceof HTMLElement)) continue;
        inertTargets.add(child);
      }
    };
    // The backdrop is normally rendered inside the app shell. Lock the
    // workspace siblings while the modal is open, then restore their exact
    // previous inert state on close.
    addSiblings(dialog.parentElement);
    const snapshots: InertSnapshot[] = [];
    for (const element of inertTargets) {
      snapshots.push({
        element,
        hadAttribute: element.hasAttribute('inert'),
        previousProperty: Boolean((element as HTMLElement & { inert?: boolean }).inert),
      });
      setElementInert(element, true);
    }
    return () => {
      for (const snapshot of snapshots) {
        const withInert = snapshot.element as HTMLElement & { inert?: boolean };
        withInert.inert = snapshot.previousProperty;
        if (snapshot.hadAttribute) snapshot.element.setAttribute('inert', '');
        else snapshot.element.removeAttribute('inert');
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        const opener = openerRef.current;
        if (opener?.isConnected) opener.focus();
      }
      wasOpenRef.current = false;
      return;
    }

    if (wasOpenRef.current) return;
    openerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    wasOpenRef.current = true;
    const first = initialFocusRef.current ?? dialogRef.current;
    first?.focus();
  }, [open]);

  function closeDialog(): void {
    onClose();
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // The application also has global keyboard shortcuts for result navigation.
    // A modal owns every key pressed inside it, while tab-arrow handling remains
    // on the individual tab button.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDialog();
      return;
    }

    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = getFocusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
    if (activeIndex < 0) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && activeIndex === 0) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
      event.preventDefault();
      first.focus();
    }
  }

  function selectTab(tabId: HelpTabId): void {
    setActiveTab(tabId);
    const panel = dialogRef.current?.querySelector<HTMLElement>('[role="tabpanel"]');
    if (panel) panel.scrollTop = 0;
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: HelpTabId): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = HELP_TABS.findIndex((tab) => tab.id === current);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + HELP_TABS.length) % HELP_TABS.length;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % HELP_TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = HELP_TABS.length - 1;
    const nextTab = HELP_TABS[nextIndex];
    if (!nextTab) return;
    selectTab(nextTab.id);
    requestAnimationFrame(() => {
      document.getElementById(`help-tab-${nextTab.id}`)?.focus();
    });
  }

  function updateFeedback(field: keyof FeedbackFormState, value: string): void {
    setFeedback((current) => ({ ...current, [field]: value }));
    setFeedbackActionMessage(null);
  }

  async function checkOcr(): Promise<void> {
    if (!onCheckOcr || ocrCheckBusyRef.current || effectiveOcrState.readiness === 'verifying'
      || engineStatus !== 'ready') return;
    ocrCheckBusyRef.current = true;
    setOcrCheckBusy(true);
    try {
      await onCheckOcr();
    } finally {
      if (!ocrCheckMountedRef.current) return;
      ocrCheckBusyRef.current = false;
      setOcrCheckBusy(false);
    }
  }

  async function readOcrCache(): Promise<void> {
    if (!onReadOcrCache || ocrCacheActionRef.current || engineStatus !== 'ready') return;
    ocrCacheActionRef.current = true;
    const requestId = ++ocrCacheRequestRef.current;
    setOcrCacheAction('reading');
    setOcrCacheMessage(null);
    try {
      const result = await onReadOcrCache();
      if (!ocrCacheMountedRef.current || !openRef.current || requestId !== ocrCacheRequestRef.current) return;
      if (result !== undefined) {
        if (!isOcrCacheInfo(result)) throw new Error('invalid cache info');
        setOcrCacheView(result);
      }
      setOcrCacheMessage({ kind: 'status', text: '已更新识别缓存占用。' });
    } catch {
      if (ocrCacheMountedRef.current && openRef.current && requestId === ocrCacheRequestRef.current) {
        setOcrCacheMessage({ kind: 'error', text: '读取识别缓存占用失败，请重试。' });
      }
    } finally {
      if (ocrCacheMountedRef.current && openRef.current && requestId === ocrCacheRequestRef.current) {
        ocrCacheActionRef.current = false;
        setOcrCacheAction('idle');
      }
    }
  }

  async function clearOcrCache(): Promise<void> {
    if (!onClearOcrCache || ocrCacheActionRef.current || engineStatus !== 'ready' || analysisInProgress) return;
    ocrCacheActionRef.current = true;
    const requestId = ++ocrCacheRequestRef.current;
    setOcrCacheAction('clearing');
    setOcrCacheMessage(null);
    try {
      const result = await onClearOcrCache();
      if (!ocrCacheMountedRef.current || !openRef.current || requestId !== ocrCacheRequestRef.current) return;
      if (result !== undefined) {
        if (!isOcrCacheClearResult(result)) throw new Error('invalid cache clear result');
        setOcrCacheView(result);
        setOcrCacheMessage({
          kind: result.failed_entries > 0 ? 'error' : 'status',
          text: result.failed_entries > 0
            ? `已清除 ${result.removed_entries} 条识别缓存，${result.failed_entries} 条未能清除。`
            : `已清除 ${result.removed_entries} 条识别缓存。下次识别将重新生成缓存。`,
        });
      } else {
        setOcrCacheMessage({ kind: 'status', text: '已请求清除识别缓存，下次识别将重新生成缓存。' });
      }
    } catch {
      if (ocrCacheMountedRef.current && openRef.current && requestId === ocrCacheRequestRef.current) {
        setOcrCacheMessage({ kind: 'error', text: '清除识别缓存失败，请重试。' });
      }
    } finally {
      if (ocrCacheMountedRef.current && openRef.current && requestId === ocrCacheRequestRef.current) {
        ocrCacheActionRef.current = false;
        setOcrCacheAction('idle');
      }
    }
  }

  function handleFieldChange(field: keyof FeedbackFormState) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      updateFeedback(field, event.currentTarget.value);
    };
  }

  async function copyFeedback(): Promise<void> {
    if (!previewRequested || feedbackError || !feedbackPreview || feedbackAction !== 'idle') return;
    setFeedbackAction('copying');
    setFeedbackActionMessage(null);
    try {
      await copyFeedbackReport(feedbackPreview);
      setFeedbackActionMessage({ kind: 'status', text: '已复制到剪贴板。' });
    } catch (copyError: unknown) {
      setFeedbackActionMessage({
        kind: 'error',
        text: copyError instanceof Error ? copyError.message : '无法自动复制反馈内容，请在预览文本框中手动复制。',
      });
    } finally {
      setFeedbackAction('idle');
    }
  }

  async function saveFeedback(): Promise<void> {
    if (!previewRequested || feedbackError || !feedbackPreview || feedbackAction !== 'idle') return;
    setFeedbackAction('saving');
    setFeedbackActionMessage(null);
    try {
      const result = await saveFeedbackReport(feedbackPreview);
      if (result.status === 'saved') {
        setFeedbackActionMessage({ kind: 'status', text: `已保存反馈文件：${result.fileName}` });
      } else {
        setFeedbackActionMessage({ kind: 'status', text: '已取消保存。' });
      }
    } catch (saveError: unknown) {
      setFeedbackActionMessage({
        kind: 'error',
        text: saveError instanceof Error ? saveError.message : '保存反馈失败，请重试。',
      });
    } finally {
      setFeedbackAction('idle');
    }
  }

  function renderOverview() {
    return (
      <div className="help-center-content-section">
        <div className="help-center-intro">
          <span className="help-center-section-kicker">LOCAL DOCUMENT WORKBENCH</span>
          <h3>让银行回单查找、审核和分割连成一条线。</h3>
          <p>
            {PRODUCT_IDENTITY.name} 面向格式相对稳定的银行回单 PDF，帮助你从原始材料中定位关键词、核对凭证边界，
            再把确认后的结果导出为便于归档和复核的文件。
          </p>
        </div>

        <div className="help-center-feature-grid" aria-label="主要功能">
          {OVERVIEW_FEATURES.map((feature) => (
            <article className={`help-center-feature-card is-${feature.tone}`} key={feature.title}>
              <span className="help-center-feature-mark" aria-hidden="true" />
              <h4>{feature.title}</h4>
              <p>{feature.description}</p>
            </article>
          ))}
        </div>

        <div className="help-center-two-column">
          <section className="help-center-note-card">
            <h4>适合什么材料</h4>
            <p>适合银行下载的电子回单、同一 PDF 内连续排列的回单，以及通过 OCR 识别的扫描回单。</p>
            <p>不同银行、不同月份或不同凭证版式可能需要人工复核候选框。</p>
          </section>
          <section className="help-center-note-card is-warm">
            <h4>原始文件保护</h4>
            <p>应用只读取原始 PDF，并把分析、审核和导出状态保存在任务数据中。</p>
            <p>删除任务或导出结果不会删除原始文件；请自行保管原件和导出副本。</p>
          </section>
        </div>
      </div>
    );
  }

  function renderGuide() {
    return (
      <div className="help-center-content-section">
        <div className="help-center-intro compact">
          <span className="help-center-section-kicker">FROM SOURCE TO RESULT</span>
          <h3>六步完成一次回单查找。</h3>
          <p>建议先在少量脱敏样本上熟悉流程，再处理较大的批量任务。</p>
        </div>
        <ol className="help-center-guide-list">
          {GUIDE_STEPS.map((step) => (
            <li key={step.number}>
              <span className="help-center-guide-number" aria-hidden="true">{step.number}</span>
              <div>
                <h4>{step.title}</h4>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
          <aside className="help-center-callout" role="note">
            <strong>常见问题：OCR 和页数限制</strong>
            <p>基础版只处理文字型 PDF；扫描件请安装 OCR 版，无需配置全局 Python。首次识别可能联网下载公开模型。“OCR 已安装，待验证”只代表运行库可以导入；点击“检测 OCR”后才会确认实际识别能力。没有文字层的扫描 PDF 才会实际进入 OCR 流程；默认每份 PDF 最多 5,000 页。</p>
          </aside>
      </div>
    );
  }

  function renderFeedback() {
    const descriptionMissing = feedback.description.trim().length === 0;
    return (
      <div className="help-center-content-section help-center-feedback-section">
        <div className="help-center-intro compact">
          <span className="help-center-section-kicker">LOCAL FEEDBACK DRAFT</span>
          <h3>把遇到的问题整理成一段可复制的反馈。</h3>
          <p>反馈只在当前设备上整理，不会自动发送。草稿在本次运行中保留，退出前请复制或保存。</p>
        </div>

        <div className="help-center-feedback-layout">
          <form
            className="help-center-feedback-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (descriptionMissing || feedbackAction !== 'idle') return;
              setPreviewRequested(true);
              setFeedbackActionMessage(null);
            }}
          >
            <label>
              <span>问题类别</span>
              <select value={feedback.category} disabled={feedbackAction !== 'idle'} onChange={handleFieldChange('category')}>
                <option value="problem">问题反馈</option>
                <option value="suggestion">功能建议</option>
                <option value="question">使用咨询</option>
              </select>
            </label>
            <label>
              <span>问题描述 <b aria-hidden="true">*</b></span>
              <textarea
                value={feedback.description}
                maxLength={MAX_FEEDBACK_FIELD_LENGTH}
                disabled={feedbackAction !== 'idle'}
                onChange={handleFieldChange('description')}
                placeholder="请描述你看到的现象。"
                required
                aria-required="true"
                rows={4}
              />
            </label>
            <label>
              <span>复现步骤</span>
              <textarea
                value={feedback.steps}
                maxLength={MAX_FEEDBACK_FIELD_LENGTH}
                disabled={feedbackAction !== 'idle'}
                onChange={handleFieldChange('steps')}
                placeholder="例如：选择文件夹 → 输入关键词 → 点击开始分析。"
                rows={3}
              />
            </label>
            <label>
              <span>期望结果</span>
              <textarea
                value={feedback.expected}
                maxLength={MAX_FEEDBACK_FIELD_LENGTH}
                disabled={feedbackAction !== 'idle'}
                onChange={handleFieldChange('expected')}
                rows={2}
              />
            </label>
            <label>
              <span>实际结果</span>
              <textarea
                value={feedback.actual}
                maxLength={MAX_FEEDBACK_FIELD_LENGTH}
                disabled={feedbackAction !== 'idle'}
                onChange={handleFieldChange('actual')}
                rows={2}
              />
            </label>
            <div className="help-center-feedback-form-actions">
              <button type="submit" className="help-center-primary-button" disabled={descriptionMissing || feedbackAction !== 'idle'}>
                生成反馈预览
              </button>
              <span className="help-center-form-hint">带 * 为必填项</span>
            </div>
          </form>

          <section className="help-center-feedback-preview" aria-labelledby="help-feedback-preview-title">
            <div className="help-center-feedback-preview-heading">
              <div>
                <span className="help-center-section-kicker">PREVIEW</span>
                <h4 id="help-feedback-preview-title">反馈文本</h4>
              </div>
              <button
                type="button"
                className="help-center-ghost-button"
                onClick={() => void copyFeedback()}
                disabled={!previewRequested || Boolean(feedbackError) || !feedbackPreview || feedbackAction !== 'idle'}
              >
                {feedbackAction === 'copying' ? '复制中…' : '复制文本'}
              </button>
              <button
                type="button"
                className="help-center-ghost-button"
                onClick={() => void saveFeedback()}
                disabled={!previewRequested || Boolean(feedbackError) || !feedbackPreview || feedbackAction !== 'idle'}
              >
                {feedbackAction === 'saving' ? '保存中…' : '保存为 TXT'}
              </button>
            </div>
            <textarea
              className="help-center-feedback-text"
              aria-label="反馈预览"
              aria-live="polite"
              readOnly
              rows={12}
              value={previewRequested
                ? (feedbackError || feedbackPreview)
                : '填写问题描述后，点击“生成反馈预览”。'}
            />
            <p className="help-center-feedback-privacy">{PRIVACY_NOTE}</p>
            {previewRequested && feedbackError && <p className="help-center-feedback-status is-error" role="alert">{feedbackError}</p>}
            {feedbackActionMessage && (
              <p className={`help-center-feedback-status${feedbackActionMessage.kind === 'error' ? ' is-error' : ''}`} role={feedbackActionMessage.kind === 'error' ? 'alert' : 'status'}>
                {feedbackActionMessage.text}
              </p>
            )}
          </section>
        </div>
      </div>
    );
  }

  function renderUpdates() {
    return (
      <div className="help-center-content-section">
        <div className="help-center-intro compact">
          <span className="help-center-section-kicker">RELEASE NOTES</span>
          <h3>{PRODUCT_IDENTITY.name} · {PRODUCT_IDENTITY.version}</h3>
          <p>{PRODUCT_IDENTITY.subtitle}。版本说明随安装包提供，可以离线查看。</p>
        </div>
        <div className="help-center-release-list">
          {RELEASE_NOTES.map((release, index) => (
            <article className={`help-center-release${index === 0 ? ' is-current' : ''}`} key={release.version}>
              <div className="help-center-release-heading">
                <div>
                  <strong>{release.version}</strong>
                  <span>{release.status}</span>
                </div>
                {index === 0 && <em>当前</em>}
              </div>
              <p>{release.summary}</p>
              <ul>
                {release.details.map((detail) => <li key={detail}>{detail}</li>)}
              </ul>
            </article>
          ))}
        </div>
        <aside className="help-center-callout is-neutral" role="note">
          <strong>如何更新</strong>
          <p>当前没有在线更新服务器。获得新的 NSIS 安装包后，关闭应用并运行新安装包即可；历史任务和本地设置按安装兼容规则保留。请从可信的项目交付目录获取安装包。</p>
        </aside>
      </div>
    );
  }

  function renderPanel(): ReactNode {
    if (activeTab === 'guide') return renderGuide();
    if (activeTab === 'feedback') return renderFeedback();
    if (activeTab === 'updates') return renderUpdates();
    return renderOverview();
  }

  if (!open) return null;

  return (
    <div
      className="help-center-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div
        ref={dialogRef}
        className="help-center-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-center-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="help-center-header">
          <div className="help-center-title-block">
            <span className="help-center-section-kicker">OFFLINE HELP CENTER</span>
            <h2 id="help-center-title">帮助与反馈</h2>
            <p>{PRODUCT_IDENTITY.name} · {PRODUCT_IDENTITY.subtitle}</p>
          </div>
          <div className="help-center-header-actions">
            <span className="help-center-version">v{PRODUCT_IDENTITY.version}</span>
            <button ref={initialFocusRef} type="button" className="help-center-close" onClick={closeDialog}>
              关闭
            </button>
          </div>
        </header>

        <div className="help-center-shell">
          <nav className="help-center-tabs" aria-label="帮助中心栏目" role="tablist" aria-orientation="vertical">
            <p className="help-center-tabs-label">浏览内容</p>
            {HELP_TABS.map((tab) => {
              const selected = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  id={`help-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={tab.label}
                  aria-controls={`help-panel-${tab.id}`}
                  aria-describedby={`help-tab-description-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={`help-center-tab${selected ? ' is-active' : ''}`}
                  onClick={() => selectTab(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                >
                  <span className="help-center-tab-index" aria-hidden="true">{String(HELP_TABS.indexOf(tab) + 1).padStart(2, '0')}</span>
                  <span>
                    <strong>{tab.label}</strong>
                    <small id={`help-tab-description-${tab.id}`}>{tab.description}</small>
                  </span>
                </button>
              );
            })}
            <div className="help-center-status-card" role="status" aria-live="polite">
              <span className="help-center-status-dot" data-state={effectiveOcrState.readiness} aria-hidden="true" />
              <span><strong>{statusLabel(engineStatus)}</strong><small>{ocrLabel(effectiveOcrState, usingLegacyOcrState)}</small></span>
              {onCheckOcr && (
                <button
                  type="button"
                  className="help-center-ocr-check"
                  onClick={() => void checkOcr()}
                  disabled={engineStatus !== 'ready' || ocrCheckBusy || effectiveOcrState.readiness === 'verifying'}
                >
                  {ocrCheckBusy || effectiveOcrState.readiness === 'verifying' ? '检测中…' : '检测 OCR'}
                </button>
              )}
            </div>
            <div className="help-center-ocr-cache" role="group" aria-label="识别缓存">
              <div className="help-center-ocr-cache-heading">
                <span>
                  <strong>识别缓存</strong>
                  <small aria-live="polite">
                    {ocrCacheView === null
                      ? '尚未查看占用'
                      : !ocrCacheView.available
                        ? '缓存暂不可用'
                        : `${ocrCacheView.entries} 条 · ${formatCacheBytes(ocrCacheView.bytes)} / ${formatCacheBytes(ocrCacheView.max_bytes)}`}
                  </small>
                </span>
                <button
                  type="button"
                  className="help-center-ocr-cache-button"
                  onClick={() => void readOcrCache()}
                  disabled={engineStatus !== 'ready' || !onReadOcrCache || ocrCacheAction !== 'idle'}
                >
                  {ocrCacheAction === 'reading' ? '读取中…' : '查看占用'}
                </button>
              </div>
              <small className="help-center-ocr-cache-scope">
                本机保存识别文字；清理仅删除此缓存，原 PDF、任务和已导出文件保留。
              </small>
              {ocrCacheView !== null && (
                <small className="help-center-ocr-cache-retention">
                  上限 {formatCacheBytes(ocrCacheView.max_bytes)} · 最多复用 {ocrCacheView.retention_days} 天
                </small>
              )}
              <button
                type="button"
                className="help-center-ocr-cache-button is-clear"
                onClick={() => void clearOcrCache()}
                disabled={engineStatus !== 'ready' || !onClearOcrCache || ocrCacheAction !== 'idle' || analysisInProgress === true}
              >
                {ocrCacheAction === 'clearing' ? '清除中…' : '清除识别缓存'}
              </button>
              {analysisInProgress === true && (
                <small className="help-center-ocr-cache-hint">分析进行中，清理缓存将在完成后可用。</small>
              )}
              {analysisInProgress === undefined && (
                <small className="help-center-ocr-cache-hint">正在进行的分析可能重新生成缓存。</small>
              )}
              {ocrCacheMessage && (
                <small className={`help-center-ocr-cache-message${ocrCacheMessage.kind === 'error' ? ' is-error' : ''}`} role={ocrCacheMessage.kind === 'error' ? 'alert' : undefined}>
                  {ocrCacheMessage.text}
                </small>
              )}
            </div>
          </nav>

          <main
            id={`help-panel-${activeTab}`}
            className="help-center-panel"
            role="tabpanel"
            aria-labelledby={`help-tab-${activeTab}`}
            tabIndex={0}
          >
            {renderPanel()}
          </main>
        </div>

        <footer className="help-center-footer">
          <span>离线内容 · 当前版本 {PRODUCT_IDENTITY.version}</span>
          <button type="button" className="help-center-footer-close" onClick={closeDialog}>返回工作区</button>
        </footer>
      </div>
    </div>
  );
}

export default HelpCenterDialog;
