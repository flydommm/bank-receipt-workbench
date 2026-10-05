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
  GUIDE_FINE_TUNE_STEPS,
  GUIDE_REVIEW_ACTION_GROUPS,
  GUIDE_REVIEW_CHECKS,
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
import {
  copyFeedbackContact,
  openFeedbackChannel,
  type FeedbackChannel,
  type FeedbackContact,
} from '../services/feedbackChannels';
import feedbackChannels from '../domain/feedbackChannels.json';
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
  /** Open the guide at a specific section when the caller is explaining an action. */
  focusSection?: 'fine-tune';
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
  focusSection,
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
  const fineTuneTitleRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const appliedFocusSectionRef = useRef<HelpCenterDialogProps['focusSection']>(undefined);
  const [activeTab, setActiveTab] = useState<HelpTabId>('overview');
  const [feedback, setFeedback] = useState<FeedbackFormState>(INITIAL_FEEDBACK);
  const [previewRequested, setPreviewRequested] = useState(false);
  const [feedbackAction, setFeedbackAction] = useState<'idle' | 'copying' | 'saving' | 'opening' | 'contact'>('idle');
  const [feedbackActionArea, setFeedbackActionArea] = useState<'preview' | 'channels'>('preview');
  const feedbackBusyRef = useRef(false);
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

  useEffect(() => {
    if (!open) {
      appliedFocusSectionRef.current = undefined;
      return;
    }
    if (focusSection !== 'fine-tune') {
      appliedFocusSectionRef.current = undefined;
      return;
    }
    if (appliedFocusSectionRef.current === focusSection) return;
    appliedFocusSectionRef.current = focusSection;
    setActiveTab('guide');
  }, [focusSection, open]);

  useEffect(() => {
    if (!open || focusSection !== 'fine-tune' || activeTab !== 'guide') return;
    const title = fineTuneTitleRef.current;
    if (!title || typeof title.scrollIntoView !== 'function') return;

    const frame = requestAnimationFrame(() => {
      title.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab, focusSection, open]);

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
    if (!previewRequested || feedbackError || !feedbackPreview || feedbackBusyRef.current) return;
    feedbackBusyRef.current = true;
    setFeedbackAction('copying');
    setFeedbackActionArea('preview');
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
      feedbackBusyRef.current = false;
      setFeedbackAction('idle');
    }
  }

  async function saveFeedback(): Promise<void> {
    if (!previewRequested || feedbackError || !feedbackPreview || feedbackBusyRef.current) return;
    feedbackBusyRef.current = true;
    setFeedbackAction('saving');
    setFeedbackActionArea('preview');
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
      feedbackBusyRef.current = false;
      setFeedbackAction('idle');
    }
  }

  async function contactMaintainer(channel: FeedbackChannel): Promise<void> {
    if (!previewRequested || feedbackError || !feedbackPreview || feedbackBusyRef.current) return;
    feedbackBusyRef.current = true;
    setFeedbackAction('opening');
    setFeedbackActionArea('channels');
    setFeedbackActionMessage(null);
    let copied = false;
    try {
      await copyFeedbackReport(feedbackPreview);
      copied = true;
      await openFeedbackChannel(channel);
      setFeedbackActionMessage({
        kind: 'status',
        text: `反馈已复制，已请求打开邮件客户端。请粘贴正文并发送至 ${feedbackChannels.email}，我们会回复你的来信。当前尚未发送。`,
      });
    } catch {
      setFeedbackActionMessage({
        kind: 'error',
        text: copied
          ? `反馈已复制，但未能打开邮件客户端。请在常用邮箱中新建邮件，收件人填写 ${feedbackChannels.email}，粘贴正文后发送。`
          : '未能复制反馈，尚未打开反馈入口。请手动复制上方预览文本，或保存为 TXT，再通过下方邮箱或微信联系维护者。',
      });
    } finally {
      feedbackBusyRef.current = false;
      setFeedbackAction('idle');
    }
  }

  async function copyContact(contact: FeedbackContact): Promise<void> {
    if (feedbackBusyRef.current) return;
    feedbackBusyRef.current = true;
    setFeedbackAction('contact');
    setFeedbackActionArea('channels');
    setFeedbackActionMessage(null);
    try {
      await copyFeedbackContact(contact);
      setFeedbackActionMessage({
        kind: 'status',
        text: contact === 'email'
          ? '已复制邮箱地址。请在常用邮箱中新建邮件并粘贴收件人，再复制反馈正文发送。'
          : '已复制微信号。请在微信中搜索并添加，注明“银行回单工作台反馈”，通过好友验证后发送反馈；我们会在微信会话中回复。',
      });
    } catch {
      setFeedbackActionMessage({ kind: 'error', text: '无法自动复制联系方式，请手动选择并复制下方显示的邮箱或微信号。' });
    } finally {
      feedbackBusyRef.current = false;
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
          <h3>完成一次回单处理。</h3>
          <p>建议先在少量脱敏样本上熟悉流程，再处理较大的批量任务。当前顺序是“选择文件与本方账户 → 分析并检查分割 →（启用整理时）核对交易对手 → 检查并导出”：导入后可在分析前查看原页总览；分割审核内按“排除无效 → 核对特殊单证 → 必要时调整边界或模板 → 完成复核”操作，读取规则是可选工具；未启用分组时跳过交易对手核对。</p>
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
        <section className="help-center-guide-detail" aria-labelledby="help-guide-fine-tune-title">
          <div className="help-center-guide-detail-heading">
            <span className="help-center-section-kicker">FINE-TUNE WORKFLOW</span>
            <h4 ref={fineTuneTitleRef} id="help-guide-fine-tune-title">微调与确认：预览本轮后再保存</h4>
            <p>需要修正边界或统一打印尺寸时，单选片段或打开详情后点击“调整所选边界”；自动候选和已确认片段也可以微调。应用会按同出具银行、同凭证类型、同实际版式的页面确定本轮范围，保留当前样本；调整整页栏位后点击“确认并预览本轮”，逐项勾选风险，确认没有阻断问题后“保存本轮 N 处”。可选保存版式模板和名称，完成后点击“完成微调，返回结果”。</p>
          </div>
          <ol className="help-center-fine-tune-list">
            {GUIDE_FINE_TUNE_STEPS.map((step) => (
              <li key={step.number}>
                <span className="help-center-fine-tune-number" aria-hidden="true">{step.number}</span>
                <div>
                  <h5>{step.title}</h5>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <aside className="help-center-callout is-neutral" role="note" aria-labelledby="help-guide-stages-title">
            <strong id="help-guide-stages-title">审核区会显示的阶段状态</strong>
            <p>微调是分析处理阶段中的可选步骤。边界正确时继续查看和处理；所有未排除的待复核清零后才显示“导出回单”。打开版式调整时会保留进入前选中的样本，并按本轮实际范围处理，不跳到默认栏位。</p>
            <ul className="help-center-check-list">
              <li><strong>第 1 轮 · 调整中</strong>：编辑整页栏位，修改只在当前轮保留。</li>
              <li><strong>确认并预览本轮</strong>：查看本轮实际处数、变化和风险；风险逐项勾选，存在阻断问题时不能保存。</li>
              <li><strong>本轮已保存</strong>：结果已写入并核实，可以点击“完成微调，返回结果”或继续所选位置。</li>
              <li><strong>写入结果不明确</strong>：只点击“核实并完成保存”或“核实并完成撤销”读取权威结果，不用取消或重复操作猜测。</li>
            </ul>
            <p>预览尚未保存时需要修改，点击“返回调整”；放弃当前预览时取消本轮。已保存轮次需要回退时点击“撤销本轮”，系统会恢复本轮调整前的边界和复核状态。保存模板是可选的，模板只供同银行、同凭证类型、同实际版式的新文件参考。</p>
          </aside>
        </section>

        <section className="help-center-guide-detail" aria-labelledby="help-guide-actions-title">
          <div className="help-center-guide-detail-heading">
            <span className="help-center-section-kicker">REVIEW ACTIONS</span>
            <h4 id="help-guide-actions-title">审核按钮怎么选</h4>
            <p>按“片段/原页总览 → 排除无效 → 核对特殊单证 → 必要时调整所选边界或模板 → 逐栏复核并完成审核”的顺序操作；同版式批量识别和本机读取规则是可选工具。未启用分组时跳过交易对手核对，待复核清零后使用“导出回单”；启用分组时先“进入交易对手分组”，再“检查并导出”。在“导出设置”填写名称、选择导出方式和可选索引，先选择目录再直接导出；失败时可用“重试导出”复用同次导出。</p>
          </div>
          <div className="help-center-action-group-grid">
            {GUIDE_REVIEW_ACTION_GROUPS.map((group) => (
              <article className="help-center-action-group" key={group.title}>
                <h5>{group.title}</h5>
                <p>{group.description}</p>
                <ul>
                  {group.actions.map((action) => (
                    <li key={action.label}>
                      <strong>{action.label}</strong>
                      <span>{action.description}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <aside className="help-center-callout" role="note">
          <strong>复核时快速检查</strong>
          <ul className="help-center-check-list">
            {GUIDE_REVIEW_CHECKS.map((check) => <li key={check}>{check}</li>)}
          </ul>
        </aside>

        <aside className="help-center-callout" role="note">
          <strong>常见问题：OCR 和页数限制</strong>
          <p>基础版只处理文字型 PDF；扫描件请安装 OCR 版，无需配置全局 Python。首次识别可能联网下载公开模型。“OCR 已安装，待验证”只代表运行库可以导入；点击“检测 OCR”后才会确认实际识别能力。没有文字层的扫描 PDF 才会实际进入 OCR 流程；默认每份 PDF 最多 5,000 页。</p>
        </aside>
      </div>
    );
  }

  function renderFeedback() {
    const descriptionMissing = feedback.description.trim().length === 0;
    const actionMessage = (
      <div aria-live="polite" aria-atomic="true">
        {feedbackAction !== 'idle' && <p className="help-center-feedback-status">正在处理，请稍候…</p>}
        {feedbackActionMessage && (
          <p className={`help-center-feedback-status${feedbackActionMessage.kind === 'error' ? ' is-error' : ''}`} role={feedbackActionMessage.kind === 'error' ? 'alert' : 'status'}>
            {feedbackActionMessage.text}
          </p>
        )}
      </div>
    );
    return (
      <div className="help-center-content-section help-center-feedback-section">
        <div className="help-center-intro compact">
          <span className="help-center-section-kicker">FEEDBACK & CONTACT</span>
          <h3>把遇到的问题整理成一段可复制的反馈。</h3>
          <p>先生成并检查反馈预览，再由你选择邮箱或微信联系维护者。应用只生成、复制或保存反馈，不会自动上传或发送；请在选定渠道中完成发送，并在原渠道查看回复。</p>
          <p>草稿只在本次运行中保留，退出前请复制或保存。</p>
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
            {feedbackActionArea === 'preview' && actionMessage}
          </section>
        </div>

        <section className="help-center-feedback-channels" aria-labelledby="help-feedback-channels-title" aria-busy={feedbackAction !== 'idle'}>
          <div className="help-center-feedback-channels-heading">
            <h4 id="help-feedback-channels-title">发送反馈与查看回复</h4>
            <p>下面是可由你主动选择的联系渠道。应用不会自动上传或发送；分享前请删除真实账号、客户信息和业务内容。</p>
          </div>
          <div className="help-center-feedback-channel-grid">
            <article className="help-center-feedback-channel">
              <h5>邮箱反馈</h5>
              <p className="help-center-feedback-contact">{feedbackChannels.email}</p>
              <p>可使用桌面邮件客户端或常用网页邮箱手动发送；我们会回复你的来信，请留意收件箱和垃圾邮件。</p>
              <div className="help-center-feedback-channel-actions">
                <button type="button" className="help-center-primary-button" disabled={!previewRequested || Boolean(feedbackError) || !feedbackPreview || feedbackAction !== 'idle'} onClick={() => void contactMaintainer('email')}>
                  复制反馈并写邮件
                </button>
                <button type="button" className="help-center-ghost-button" disabled={feedbackAction !== 'idle'} onClick={() => void copyContact('email')}>
                  复制邮箱
                </button>
              </div>
              <p>需要系统配置默认邮件应用；也可用常用网页邮箱手动发送。</p>
            </article>
            <article className="help-center-feedback-channel">
              <h5>微信联系</h5>
              <p className="help-center-feedback-contact">{feedbackChannels.wechat}</p>
              <p>搜索并添加微信，注明“银行回单工作台反馈”。通过后发送反馈，我们会在微信会话中回复。</p>
              <div className="help-center-feedback-channel-actions">
                <button type="button" className="help-center-ghost-button" disabled={feedbackAction !== 'idle'} onClick={() => void copyContact('wechat')}>
                  复制微信号
                </button>
              </div>
              <p>添加完成后，可返回上方复制反馈文本或保存为 TXT。</p>
            </article>
          </div>
          {!previewRequested && <p className="help-center-feedback-privacy">填写问题描述并生成反馈预览后，即可使用“复制反馈并写邮件”；也可以先复制邮箱或微信号，再手动联系维护者。</p>}
          {feedbackActionArea === 'channels' && actionMessage}
        </section>
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
          <p>当前没有在线更新服务器。获得新的 NSIS 安装包后，关闭应用并运行新安装包即可；已保存版式模板和本地设置按安装兼容规则保留。请从可信的项目交付目录获取安装包。</p>
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
