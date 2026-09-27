import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import feedbackChannels from '../domain/feedbackChannels.json';
import type { FeedbackInvoke } from './localFeedback';

export type FeedbackChannel = 'github' | 'email';
export type FeedbackContact = 'email' | 'wechat';

export type FeedbackChannelErrorCode =
  | 'INVALID_CHANNEL'
  | 'INVALID_CONTACT'
  | 'TAURI_UNAVAILABLE'
  | 'OPEN_FAILED'
  | 'INVALID_RESPONSE'
  | 'CLIPBOARD_UNAVAILABLE'
  | 'CLIPBOARD_FAILED';

export class FeedbackChannelError extends Error {
  readonly code: FeedbackChannelErrorCode;

  constructor(code: FeedbackChannelErrorCode, message: string) {
    super(message);
    this.name = 'FeedbackChannelError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const INVALID_CHANNEL_MESSAGE = '反馈渠道无效，请选择邮箱或 GitHub。';
const INVALID_CONTACT_MESSAGE = '联系方式无效，请选择屏幕上显示的邮箱或微信号。';
const TAURI_UNAVAILABLE_MESSAGE = '打开反馈入口需要在桌面应用中运行，请通过屏幕上的邮箱、微信或 GitHub 手动联系。';
const OPEN_FAILED_MESSAGE = '无法打开反馈入口，请通过屏幕上的邮箱、微信或 GitHub 手动联系。';
const INVALID_RESPONSE_MESSAGE = '打开反馈入口返回了无效结果，请通过屏幕上的邮箱、微信或 GitHub 手动联系。';
const CLIPBOARD_MESSAGE = '无法自动复制联系方式，请手动选择并复制下方显示的邮箱或微信号。';

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

function isTauriRuntime(): boolean {
  try {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as TauriWindow);
  } catch {
    return false;
  }
}

function defaultInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  return tauriInvoke<unknown>(command, args);
}

function isFeedbackChannel(value: unknown): value is FeedbackChannel {
  return value === 'github' || value === 'email';
}

function isFeedbackContact(value: unknown): value is FeedbackContact {
  return value === 'email' || value === 'wechat';
}

function isOpenedResponse(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).status === 'opened';
}

function clipboard(): Clipboard | null {
  try {
    const value = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    return value && typeof value.writeText === 'function' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Ask the native side to open a user-selected feedback entry point.
 *
 * The web side deliberately sends only the channel name.  Native code owns
 * the configured destination and opening policy, so report text, URLs and
 * filesystem paths never cross this IPC boundary.
 */
export async function openFeedbackChannel(
  channel: FeedbackChannel,
  call: FeedbackInvoke = defaultInvoke,
): Promise<void> {
  if (!isFeedbackChannel(channel)) {
    throw new FeedbackChannelError('INVALID_CHANNEL', INVALID_CHANNEL_MESSAGE);
  }

  if (call === defaultInvoke && !isTauriRuntime()) {
    throw new FeedbackChannelError('TAURI_UNAVAILABLE', TAURI_UNAVAILABLE_MESSAGE);
  }

  let response: unknown;
  try {
    response = await call('open_feedback_channel', { channel });
  } catch {
    throw new FeedbackChannelError('OPEN_FAILED', OPEN_FAILED_MESSAGE);
  }

  try {
    if (!isOpenedResponse(response)) {
      throw new FeedbackChannelError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
    }
  } catch (error) {
    if (error instanceof FeedbackChannelError) throw error;
    throw new FeedbackChannelError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
  }
}

/** Copy one of the statically configured maintainer contacts. */
export async function copyFeedbackContact(contact: FeedbackContact): Promise<void> {
  if (!isFeedbackContact(contact)) {
    throw new FeedbackChannelError('INVALID_CONTACT', INVALID_CONTACT_MESSAGE);
  }

  const value = contact === 'email' ? feedbackChannels.email : feedbackChannels.wechat;
  const target = clipboard();
  if (!target) {
    throw new FeedbackChannelError('CLIPBOARD_UNAVAILABLE', CLIPBOARD_MESSAGE);
  }

  try {
    await target.writeText(value);
  } catch {
    throw new FeedbackChannelError('CLIPBOARD_FAILED', CLIPBOARD_MESSAGE);
  }
}
