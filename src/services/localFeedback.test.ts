import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { copyFeedbackReport, saveFeedbackReport, type FeedbackInvoke } from './localFeedback';

const report = '银行回单工作台 使用反馈\n问题描述：示例';
type TestGlobals = typeof globalThis & {
  window?: Window & { __TAURI_INTERNALS__?: unknown };
  navigator?: Navigator;
};
const globals = globalThis as TestGlobals;
const originalWindow = globals.window;
const originalNavigator = globals.navigator;
if (!globals.window) Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
if (!globals.navigator) Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
const tauriWindow = globals.window ?? (globalThis as unknown as Window & { __TAURI_INTERNALS__?: unknown });
const originalTauri = tauriWindow.__TAURI_INTERNALS__;

function enableTauri(): void {
  Object.defineProperty(tauriWindow, '__TAURI_INTERNALS__', { configurable: true, value: {} });
}

afterEach(() => {
  if (originalTauri === undefined) delete tauriWindow.__TAURI_INTERNALS__;
  else Object.defineProperty(tauriWindow, '__TAURI_INTERNALS__', { configurable: true, value: originalTauri });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  vi.restoreAllMocks();
});

afterAll(() => {
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  if (originalNavigator === undefined) Reflect.deleteProperty(globalThis, 'navigator');
  else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
});

describe('local feedback service', () => {
  it('copies only after navigator.clipboard resolves', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await expect(copyFeedbackReport(report)).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith(report);
  });

  it('reports a manual-copy fallback when clipboard writing fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await expect(copyFeedbackReport(report)).rejects.toMatchObject({
      code: 'CLIPBOARD_FAILED',
      message: '无法自动复制反馈内容，请在预览文本框中手动复制。',
    });
  });

  it('does not report copy success when clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await expect(copyFeedbackReport(report)).rejects.toMatchObject({ code: 'CLIPBOARD_UNAVAILABLE' });
  });

  it('saves a valid native response and sends only the report', async () => {
    enableTauri();
    const call = vi.fn<FeedbackInvoke>().mockResolvedValue({ status: 'saved', fileName: '银行回单工作台_反馈_123.txt' });
    await expect(saveFeedbackReport(report, call)).resolves.toEqual({ status: 'saved', fileName: '银行回单工作台_反馈_123.txt' });
    expect(call).toHaveBeenCalledWith('save_feedback_report', { report });
  });

  it('returns cancellation without treating it as a save', async () => {
    enableTauri();
    const call = vi.fn<FeedbackInvoke>().mockResolvedValue({ status: 'cancelled' });
    await expect(saveFeedbackReport(report, call)).resolves.toEqual({ status: 'cancelled' });
  });

  it.each([
    { status: 'saved', fileName: 'C:\\secret\\feedback.txt' },
    { status: 'saved', fileName: 'feedback:stream.txt' },
    { status: 'saved', fileName: 'feedback.pdf' },
    { status: 'saved', fileName: 'CON.txt' },
    { status: 'saved', fileName: 'feedback.txt ' },
    { status: 'saved' },
    { status: 'unexpected' },
  ])('rejects an unsafe native response %#', async (response) => {
    enableTauri();
    const call = vi.fn<FeedbackInvoke>().mockResolvedValue(response);
    await expect(saveFeedbackReport(report, call)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('maps native failure without exposing its path or raw error', async () => {
    enableTauri();
    const call = vi.fn<FeedbackInvoke>().mockRejectedValue(new Error('D:\\secret\\feedback.txt already exists'));
    await expect(saveFeedbackReport(report, call)).rejects.toEqual(expect.objectContaining({
      code: 'SAVE_FAILED',
      message: '保存反馈失败，请重试。',
    }));
  });

  it('keeps safe native save messages without exposing arbitrary details', async () => {
    enableTauri();
    const existing = vi.fn<FeedbackInvoke>().mockRejectedValue('反馈文件已存在，请更换文件名。');
    await expect(saveFeedbackReport(report, existing)).rejects.toMatchObject({
      code: 'SAVE_FAILED',
      message: '反馈文件已存在，请更换文件名。',
    });
    const unsafe = vi.fn<FeedbackInvoke>().mockRejectedValue('D:\\secret\\feedback.txt 已存在');
    await expect(saveFeedbackReport(report, unsafe)).rejects.toMatchObject({
      code: 'SAVE_FAILED',
      message: '保存反馈失败，请重试。',
    });
  });

  it('rejects empty or oversized text before invoking native code', async () => {
    enableTauri();
    const call = vi.fn<FeedbackInvoke>().mockResolvedValue({ status: 'saved', fileName: 'feedback.txt' });
    await expect(saveFeedbackReport('   ', call)).rejects.toMatchObject({ code: 'INVALID_REPORT' });
    await expect(saveFeedbackReport('界'.repeat(11_000), call)).rejects.toMatchObject({ code: 'INVALID_REPORT' });
    expect(call).not.toHaveBeenCalled();
  });

  it('requires the desktop bridge before opening a native save dialog', async () => {
    await expect(saveFeedbackReport(report)).rejects.toMatchObject({ code: 'TAURI_UNAVAILABLE' });
  });
});
