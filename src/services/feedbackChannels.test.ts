// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyFeedbackContact,
  FeedbackChannelError,
  openFeedbackChannel,
  type FeedbackChannel,
} from './feedbackChannels';
import type { FeedbackInvoke } from './localFeedback';

type TestWindow = Window & { __TAURI_INTERNALS__?: unknown };
const testWindow = window as TestWindow;
const testNavigator = navigator;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(testNavigator, 'clipboard');
const originalTauri = testWindow.__TAURI_INTERNALS__;

function enableTauri(): void {
  Object.defineProperty(testWindow, '__TAURI_INTERNALS__', { configurable: true, value: {} });
}

function disableTauri(): void {
  if (originalTauri === undefined) delete testWindow.__TAURI_INTERNALS__;
  else Object.defineProperty(testWindow, '__TAURI_INTERNALS__', { configurable: true, value: originalTauri });
}

function setClipboard(value: unknown): void {
  Object.defineProperty(testNavigator, 'clipboard', { configurable: true, value });
}

afterEach(() => {
  disableTauri();
  if (originalClipboardDescriptor) Object.defineProperty(testNavigator, 'clipboard', originalClipboardDescriptor);
  else Reflect.deleteProperty(testNavigator, 'clipboard');
  vi.restoreAllMocks();
});

describe('feedback channel service', () => {
  it.each(['email', 'github'] as const)('opens the %s channel with only its name', async (channel) => {
    const call = vi.fn<FeedbackInvoke>().mockResolvedValue({ status: 'opened' });

    await expect(openFeedbackChannel(channel, call)).resolves.toBeUndefined();
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('open_feedback_channel', { channel });
    expect(call.mock.calls[0]?.[1]).toEqual({ channel });
    expect(Object.keys(call.mock.calls[0]?.[1] ?? {})).toEqual(['channel']);
  });

  it('rejects an invalid channel before invoking the native bridge', async () => {
    const call = vi.fn<FeedbackInvoke>().mockResolvedValue({ status: 'opened' });

    await expect(openFeedbackChannel('browser' as FeedbackChannel, call)).rejects.toMatchObject({
      name: 'FeedbackChannelError',
      code: 'INVALID_CHANNEL',
      message: '反馈渠道无效，请选择邮箱或 GitHub。',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('requires the desktop bridge when no invoke implementation is supplied', async () => {
    await expect(openFeedbackChannel('email')).rejects.toMatchObject({
      code: 'TAURI_UNAVAILABLE',
      message: '打开反馈入口需要在桌面应用中运行，请通过屏幕上的邮箱、微信或 GitHub 手动联系。',
    });
  });

  it('maps native failures to a fixed message without exposing raw details', async () => {
    enableTauri();
    const call = vi.fn<FeedbackInvoke>().mockRejectedValue(new Error('mailto:secret@example.com?path=C:\\private'));

    await expect(openFeedbackChannel('email', call)).rejects.toMatchObject({
      code: 'OPEN_FAILED',
      message: '无法打开反馈入口，请通过屏幕上的邮箱、微信或 GitHub 手动联系。',
    });
    await expect(openFeedbackChannel('email', call)).rejects.not.toThrow('secret@example.com');
  });

  it.each([
    undefined,
    null,
    [],
    { status: 'failed', url: 'mailto:secret@example.com' },
  ])('rejects a native response without a valid opened status: %#', async (response) => {
    enableTauri();
    const call = vi.fn<FeedbackInvoke>().mockResolvedValue(response);

    await expect(openFeedbackChannel('github', call)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: '打开反馈入口返回了无效结果，请通过屏幕上的邮箱、微信或 GitHub 手动联系。',
    });
  });

  it('copies the exact configured email and WeChat values', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await expect(copyFeedbackContact('email')).resolves.toBeUndefined();
    await expect(copyFeedbackContact('wechat')).resolves.toBeUndefined();
    expect(writeText.mock.calls.map(([value]) => value)).toEqual(['venz@163.com', 'vinz2009']);
  });

  it('rejects an invalid contact without touching the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await expect(copyFeedbackContact('phone' as 'email')).rejects.toMatchObject({
      code: 'INVALID_CONTACT',
      message: '联系方式无效，请选择屏幕上显示的邮箱或微信号。',
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('uses the same fixed manual-copy message when clipboard is unavailable or fails', async () => {
    setClipboard(undefined);
    await expect(copyFeedbackContact('email')).rejects.toMatchObject({
      code: 'CLIPBOARD_UNAVAILABLE',
      message: '无法自动复制联系方式，请手动选择并复制下方显示的邮箱或微信号。',
    });

    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    setClipboard({ writeText });
    await expect(copyFeedbackContact('wechat')).rejects.toMatchObject({
      code: 'CLIPBOARD_FAILED',
      message: '无法自动复制联系方式，请手动选择并复制下方显示的邮箱或微信号。',
    });
  });

  it('uses the dedicated error type for fixed service failures', async () => {
    setClipboard(undefined);
    await expect(copyFeedbackContact('email')).rejects.toBeInstanceOf(FeedbackChannelError);
  });
});
