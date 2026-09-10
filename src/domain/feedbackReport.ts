/**
 * The small, explicit payload used by the Help and Feedback center.
 *
 * Feedback deliberately contains no source-file paths, PDF contents, logs, or
 * other machine data.  The environment block is supplied by the caller and
 * is limited to the values that are useful when a user reports a problem.
 */
import { APP_NAME } from './appIdentity';

export type FeedbackDraft = {
  category: 'problem' | 'suggestion' | 'question';
  description: string;
  steps: string;
  expected: string;
  actual: string;
};

export type FeedbackOcrState = 'unknown' | 'installed' | 'verifying' | 'ready' | 'unavailable' | 'failed';

export type FeedbackEnvironment = {
  appVersion: string;
  engineStatus: 'checking' | 'ready' | 'unavailable';
  /** The explicit OCR lifecycle state used by the current Help and Feedback UI. */
  ocrState?: FeedbackOcrState;
  /** Legacy compatibility for callers that only know the old boolean status. */
  ocrReady?: boolean | null;
};

export const FEEDBACK_APP_NAME = APP_NAME;
export const MAX_FEEDBACK_FIELD_LENGTH = 4_000;
export const MAX_FEEDBACK_REPORT_BYTES = 32 * 1024;

const MAX_FEEDBACK_DRAFT_BYTES = 28 * 1024;

const CATEGORY_LABELS: Record<FeedbackDraft['category'], string> = {
  problem: '问题反馈',
  suggestion: '功能建议',
  question: '使用咨询',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAllowedText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Newlines and tabs are useful in a report.  Other C0 controls can make a
  // copied or saved text report ambiguous, so reject them at the boundary.
  return !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0 || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d);
  });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizedField(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function validateField(value: unknown, label: string, required = false): string | null {
  if (!isAllowedText(value)) return `${label}包含无法保存的控制字符。`;
  if (required && value.trim().length === 0) return `${label}不能为空。`;
  if (value.length > MAX_FEEDBACK_FIELD_LENGTH) return `${label}不能超过 ${MAX_FEEDBACK_FIELD_LENGTH} 个字符。`;
  return null;
}

/** Validate user-entered feedback before it is rendered or sent to native code. */
export function validateFeedbackDraft(draft: unknown): string | null {
  if (!isRecord(draft)) return '反馈内容无效，请重新填写。';
  if (draft.category !== 'problem' && draft.category !== 'suggestion' && draft.category !== 'question') {
    return '反馈类型无效，请重新选择。';
  }

  const fields: Array<[string, string, boolean]> = [
    ['description', '问题描述', true],
    ['steps', '复现步骤', false],
    ['expected', '期望结果', false],
    ['actual', '实际结果', false],
  ];
  let totalBytes = 0;
  for (const [key, label, required] of fields) {
    const value = draft[key];
    const error = validateField(value, label, required);
    if (error) return error;
    totalBytes += utf8Bytes(normalizedField(value as string));
  }
  if (totalBytes > MAX_FEEDBACK_DRAFT_BYTES) {
    return '反馈内容过长，请删减后再保存。';
  }
  return null;
}

function validateEnvironment(environment: unknown): environment is FeedbackEnvironment {
  if (!isRecord(environment)) return false;
  const hasOcrState = environment.ocrState !== undefined;
  const hasLegacyOcrReady = Object.prototype.hasOwnProperty.call(environment, 'ocrReady');
  const validOcrState = !hasOcrState
    || environment.ocrState === 'unknown'
    || environment.ocrState === 'installed'
    || environment.ocrState === 'verifying'
    || environment.ocrState === 'ready'
    || environment.ocrState === 'unavailable'
    || environment.ocrState === 'failed';
  const validLegacyOcrReady = !hasLegacyOcrReady
    || environment.ocrReady === null
    || typeof environment.ocrReady === 'boolean';
  return isAllowedText(environment.appVersion)
    && environment.appVersion.trim().length > 0
    && environment.appVersion.length <= 128
    && (environment.engineStatus === 'checking'
      || environment.engineStatus === 'ready'
      || environment.engineStatus === 'unavailable')
    && (hasOcrState || hasLegacyOcrReady)
    && validOcrState
    && validLegacyOcrReady;
}

function engineLabel(status: FeedbackEnvironment['engineStatus']): string {
  if (status === 'ready') return '已连接';
  if (status === 'unavailable') return '不可用';
  return '检查中';
}

function legacyOcrLabel(status: boolean | null | undefined): string {
  if (status === true) return '就绪';
  if (status === false) return '不可用';
  return '检查中';
}

function ocrLabel(environment: FeedbackEnvironment): string {
  if (environment.ocrState === undefined) return legacyOcrLabel(environment.ocrReady);
  if (environment.ocrState === 'installed') return '已安装，待验证';
  if (environment.ocrState === 'verifying') return '验证中';
  if (environment.ocrState === 'ready') return '已验证可用';
  if (environment.ocrState === 'unavailable') return '不可用';
  if (environment.ocrState === 'failed') return '验证失败';
  return '状态未知';
}

function reportField(label: string, value: string): string {
  return `${label}：\n${normalizedField(value) || '（未填写）'}`;
}

/**
 * Build the plain text shown in the preview and copied/saved by the user.
 * This function throws a Chinese validation error so a UI can display it
 * directly beside the form.
 */
export function buildFeedbackReport(draft: FeedbackDraft, environment: FeedbackEnvironment): string {
  const draftError = validateFeedbackDraft(draft);
  if (draftError) throw new Error(draftError);
  if (!validateEnvironment(environment)) throw new Error('反馈环境信息无效，请稍后重试。');

  const report = [
    `${FEEDBACK_APP_NAME} 使用反馈`,
    '========================',
    `反馈类型：${CATEGORY_LABELS[draft.category]}`,
    `应用版本：${environment.appVersion.trim()}`,
    `本地引擎：${engineLabel(environment.engineStatus)}`,
    `OCR 状态：${ocrLabel(environment)}`,
    '',
    reportField('问题描述', draft.description),
    '',
    reportField('复现步骤', draft.steps),
    '',
    reportField('期望结果', draft.expected),
    '',
    reportField('实际结果', draft.actual),
    '',
    '本反馈仅包含用户填写内容及应用状态摘要。',
  ].join('\n');
  if (utf8Bytes(report) > MAX_FEEDBACK_REPORT_BYTES) {
    throw new Error('反馈内容过长，请删减后再保存。');
  }
  return report;
}

/** Validate text received by copy/save services, including pasted preview text. */
export function validateFeedbackReportText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return '反馈内容不能为空。';
  if (!isAllowedText(value)) return '反馈内容包含无法保存的控制字符。';
  if (utf8Bytes(value) > MAX_FEEDBACK_REPORT_BYTES) return '反馈内容过长，请删减后再保存。';
  return null;
}
