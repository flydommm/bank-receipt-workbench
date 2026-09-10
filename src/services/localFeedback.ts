import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { MAX_FEEDBACK_REPORT_BYTES, validateFeedbackReportText } from '../domain/feedbackReport';

export type FeedbackSaveResult =
  | { status: 'saved'; fileName: string }
  | { status: 'cancelled' };

export type FeedbackInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type FeedbackServiceErrorCode =
  | 'INVALID_REPORT'
  | 'CLIPBOARD_UNAVAILABLE'
  | 'CLIPBOARD_FAILED'
  | 'TAURI_UNAVAILABLE'
  | 'SAVE_FAILED'
  | 'INVALID_RESPONSE';

export class FeedbackServiceError extends Error {
  readonly code: FeedbackServiceErrorCode;

  constructor(code: FeedbackServiceErrorCode, message: string) {
    super(message);
    this.name = 'FeedbackServiceError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as TauriWindow);
}

function defaultInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  return tauriInvoke<unknown>(command, args);
}

function assertReport(value: unknown): asserts value is string {
  const error = validateFeedbackReportText(value);
  if (error) throw new FeedbackServiceError('INVALID_REPORT', error);
}

function clipboard(): Clipboard | null {
  try {
    const value = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    return value && typeof value.writeText === 'function' ? value : null;
  } catch {
    return null;
  }
}

/** Copy only when the browser confirms that clipboard writing completed. */
export async function copyFeedbackReport(text: string): Promise<void> {
  assertReport(text);
  const target = clipboard();
  if (!target) {
    throw new FeedbackServiceError('CLIPBOARD_UNAVAILABLE', '无法自动复制反馈内容，请在预览文本框中手动复制。');
  }
  try {
    await target.writeText(text);
  } catch {
    throw new FeedbackServiceError('CLIPBOARD_FAILED', '无法自动复制反馈内容，请在预览文本框中手动复制。');
  }
}

function isSafeFileName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value !== value.trim() || /[ .]$/u.test(value)) return false;
  const name = value;
  if (name.length === 0 || name.length > 240 || !/\.txt$/i.test(name)) return false;
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (/[<>:"|?*]/u.test(name)) return false;
  const device = name.split('.')[0]!.toLowerCase();
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(device)) return false;
  return !Array.from(name).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

function parseSaveResult(value: unknown): FeedbackSaveResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FeedbackServiceError('INVALID_RESPONSE', '保存反馈返回了无效结果，请重试。');
  }
  const payload = value as Record<string, unknown>;
  if (payload.status === 'cancelled') return { status: 'cancelled' };
  if (payload.status === 'saved' && isSafeFileName(payload.fileName)) {
    return { status: 'saved', fileName: payload.fileName.trim() };
  }
  throw new FeedbackServiceError('INVALID_RESPONSE', '保存反馈返回了无效结果，请重试。');
}

const SAFE_NATIVE_SAVE_ERRORS = new Set([
  '反馈文件已存在，请更换文件名。',
  '反馈文件必须使用 .txt 后缀。',
  '反馈文件路径无效。',
  '反馈文件名无效。',
  '无法创建反馈文件，请检查保存目录后重试。',
  '反馈文件写入失败，文件可能不完整，请检查后重试。',
]);

function safeNativeSaveMessage(cause: unknown): string | null {
  const raw = typeof cause === 'string'
    ? cause
    : typeof cause === 'object' && cause !== null && 'message' in cause && typeof cause.message === 'string'
      ? cause.message
      : cause instanceof Error
        ? cause.message
        : null;
  return raw !== null && SAFE_NATIVE_SAVE_ERRORS.has(raw) ? raw : null;
}

/**
 * Ask the native side to show its save dialog.  The destination path and
 * filename never cross this boundary from the web UI; native code chooses the
 * path and returns only the saved basename.
 */
export async function saveFeedbackReport(text: string, call: FeedbackInvoke = defaultInvoke): Promise<FeedbackSaveResult> {
  assertReport(text);
  // Keep the browser guard for the production bridge, while allowing tests
  // and an embedding host to inject a deterministic invoke implementation.
  if (call === defaultInvoke && !isTauriRuntime()) {
    throw new FeedbackServiceError('TAURI_UNAVAILABLE', '保存反馈需要在桌面应用中运行。');
  }
  let response: unknown;
  try {
    response = await call('save_feedback_report', { report: text });
  } catch (cause) {
    throw new FeedbackServiceError('SAVE_FAILED', safeNativeSaveMessage(cause) ?? '保存反馈失败，请重试。');
  }
  return parseSaveResult(response);
}

export { MAX_FEEDBACK_REPORT_BYTES };
