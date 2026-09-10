// @vitest-environment jsdom

import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyFeedbackReport, saveFeedbackReport } from '../services/localFeedback';
import HelpCenterDialog, { type HelpCenterOcrCacheInfo } from './HelpCenterDialog';

vi.mock('../services/localFeedback', () => ({
  copyFeedbackReport: vi.fn(),
  saveFeedbackReport: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(copyFeedbackReport).mockReset();
  vi.mocked(saveFeedbackReport).mockReset();
  vi.restoreAllMocks();
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof HelpCenterDialog>> = {}) {
  const onClose = vi.fn<() => void>();
  const props: React.ComponentProps<typeof HelpCenterDialog> = {
    open: true,
    onClose,
    engineStatus: 'ready',
    ocrReady: true,
    ...overrides,
  };
  const view = render(<HelpCenterDialog {...props} />);
  return { ...props, onClose, view };
}

describe('HelpCenterDialog', () => {
  it('does not render while closed and keeps the feedback draft across close and reopen', async () => {
    const user = userEvent.setup();
    const { view } = renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();

    view.rerender(<HelpCenterDialog open onClose={vi.fn()} engineStatus="ready" ocrReady />);
    await user.click(screen.getByRole('tab', { name: /使用反馈/ }));
    const description = screen.getByRole('textbox', { name: /问题描述/ });
    await user.type(description, '重新打开后仍应保留这段草稿。');

    view.rerender(<HelpCenterDialog open={false} onClose={vi.fn()} engineStatus="ready" ocrReady />);
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<HelpCenterDialog open onClose={vi.fn()} engineStatus="ready" ocrReady />);
    expect((screen.getByRole('textbox', { name: /问题描述/ }) as HTMLTextAreaElement).value)
      .toBe('重新打开后仍应保留这段草稿。');
  });

  it('exposes modal and tab semantics, status, and an initial focus target', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: '帮助与反馈' });
    const title = screen.getByRole('heading', { name: '帮助与反馈' });
    const close = screen.getByRole('button', { name: '关闭' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(document.activeElement).toBe(close);
    expect(screen.getByRole('status').textContent).toContain('本地引擎已连接');
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByRole('tab', { name: /功能介绍/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel')).toBeTruthy();
  });

  it('allows another OCR check after StrictMode replays mount effects', async () => {
    const user = userEvent.setup();
    const onCheckOcr = vi.fn(async () => {});
    render(<StrictMode><HelpCenterDialog open onClose={vi.fn()} engineStatus="ready"
      ocrState={{ readiness: 'installed' }} onCheckOcr={onCheckOcr}/></StrictMode>);
    await user.click(screen.getByRole('button', { name: '检测 OCR' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '检测 OCR' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '检测 OCR' }));
    expect(onCheckOcr).toHaveBeenCalledTimes(2);
  });

  it('distinguishes installed OCR from verified OCR and prevents a second detection while pending', async () => {
    const user = userEvent.setup();
    let resolveCheck!: () => void;
    const onCheckOcr = vi.fn(() => new Promise<void>((resolve) => {
      resolveCheck = resolve;
    }));
    const { view } = renderDialog({
      ocrReady: null,
      ocrState: { readiness: 'installed', message: 'OCR 运行库已安装，尚未执行识别验证。' },
      onCheckOcr,
    });

    expect(screen.getByRole('status').textContent).toContain('OCR 已安装，待验证');
    const check = screen.getByRole('button', { name: '检测 OCR' }) as HTMLButtonElement;
    expect(check.disabled).toBe(false);
    await user.click(check);
    expect(onCheckOcr).toHaveBeenCalledOnce();
    expect(check.disabled).toBe(true);
    expect(check.textContent).toContain('检测中');
    await user.click(check);
    expect(onCheckOcr).toHaveBeenCalledOnce();

    resolveCheck();
    await waitFor(() => expect(check.disabled).toBe(false));
    view.rerender(<HelpCenterDialog
      open
      onClose={vi.fn()}
      engineStatus="ready"
      ocrState={{ readiness: 'ready', message: 'OCR 已通过脱敏样本验证。' }}
      onCheckOcr={onCheckOcr}
    />);
    expect(screen.getByRole('status').textContent).toContain('OCR 已验证可用');
  });

  it('reads and clears the independent OCR cache report without a path control', async () => {
    const user = userEvent.setup();
    const readCache = vi.fn(async () => ({
      status: 'ok' as const,
      available: true,
      entries: 4,
      bytes: 12_345,
      max_bytes: 268_435_456 as const,
      retention_days: 30 as const,
    }));
    const clearCache = vi.fn(async () => ({
      status: 'ok' as const,
      available: true,
      entries: 0,
      bytes: 0,
      max_bytes: 268_435_456 as const,
      retention_days: 30 as const,
      removed_entries: 4,
      failed_entries: 0,
    }));
    renderDialog({ onReadOcrCache: readCache, onClearOcrCache: clearCache });

    expect(screen.getByRole('group', { name: '识别缓存' })).toBeTruthy();
    expect(screen.getByText('本机保存识别文字；清理仅删除此缓存，原 PDF、任务和已导出文件保留。')).toBeTruthy();
    expect(screen.queryByText(/缓存路径|OCR 文字/)).toBeNull();
    await user.click(screen.getByRole('button', { name: '查看占用' }));
    await waitFor(() => expect(screen.getByText(/4 条 · 12\.1 KB/)).toBeTruthy());
    expect(screen.getByText(/最多复用 30 天/)).toBeTruthy();
    expect(readCache).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: '清除识别缓存' }));
    await waitFor(() => expect(screen.getByText('已清除 4 条识别缓存。下次识别将重新生成缓存。')).toBeTruthy());
    expect(clearCache).toHaveBeenCalledOnce();
    expect(screen.getByText(/0 条 · 0 B/)).toBeTruthy();
  });

  it('deduplicates pending cache actions and permits retry after a failed read', async () => {
    const user = userEvent.setup();
    let resolveRead!: (value: HelpCenterOcrCacheInfo) => void;
    const readCache = vi.fn()
      .mockReturnValueOnce(new Promise<HelpCenterOcrCacheInfo>((resolve) => { resolveRead = resolve; }))
      .mockRejectedValueOnce(new Error('cache read failed'))
      .mockResolvedValue({
        status: 'ok' as const,
        available: false,
        entries: 0,
        bytes: 0,
        max_bytes: 268_435_456 as const,
        retention_days: 30 as const,
      });
    renderDialog({ onReadOcrCache: readCache });

    const readButton = screen.getByRole('button', { name: '查看占用' }) as HTMLButtonElement;
    await user.click(readButton);
    expect(readButton.disabled).toBe(true);
    await user.click(readButton);
    expect(readCache).toHaveBeenCalledOnce();
    resolveRead({
      status: 'ok', available: true, entries: 1, bytes: 10,
      max_bytes: 268_435_456, retention_days: 30,
    });
    await waitFor(() => expect(readButton.disabled).toBe(false));

    await user.click(readButton);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('读取识别缓存占用失败'));
    expect(readButton.disabled).toBe(false);
    await user.click(readButton);
    await waitFor(() => expect(screen.getByText('缓存暂不可用')).toBeTruthy());
    expect(readCache).toHaveBeenCalledTimes(3);
  });

  it('disables clearing during analysis and warns when no analysis state is provided', async () => {
    const user = userEvent.setup();
    const clearCache = vi.fn(async () => ({
      status: 'ok' as const,
      available: true,
      entries: 0,
      bytes: 0,
      max_bytes: 268_435_456 as const,
      retention_days: 30 as const,
      removed_entries: 1,
      failed_entries: 0,
    }));
    const { view } = renderDialog({ onClearOcrCache: clearCache, analysisInProgress: true });
    const clearButton = screen.getByRole('button', { name: '清除识别缓存' }) as HTMLButtonElement;
    expect(clearButton.disabled).toBe(true);
    await user.click(clearButton);
    expect(clearCache).not.toHaveBeenCalled();

    view.rerender(<HelpCenterDialog open onClose={vi.fn()} engineStatus="ready" ocrReady onClearOcrCache={clearCache} />);
    expect(screen.getByText('正在进行的分析可能重新生成缓存。')).toBeTruthy();
  });

  it('switches the four offline sections with mouse and tab-arrow navigation', async () => {
    const user = userEvent.setup();
    renderDialog({ engineStatus: 'unavailable', ocrReady: null });

    await user.click(screen.getByRole('tab', { name: /使用指南/ }));
    expect(screen.getByRole('heading', { name: '六步完成一次回单查找。' })).toBeTruthy();
    expect(screen.getAllByText(/默认每份 PDF 最多 5,000 页/).length).toBe(1);

    const guideTab = screen.getByRole('tab', { name: /使用指南/ });
    fireEvent.keyDown(guideTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /使用反馈/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: /把遇到的问题整理成一段/ })).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: /版本与更新/ }));
    expect(screen.getByText('公开发布准备版')).toBeTruthy();
    expect(screen.getByText(/没有在线更新服务器/)).toBeTruthy();
  });

  it('requires a description, generates a complete local preview, and copies it', async () => {
    const user = userEvent.setup();
    vi.mocked(copyFeedbackReport).mockResolvedValue(undefined);
    renderDialog();
    await user.click(screen.getByRole('tab', { name: /使用反馈/ }));

    const generate = screen.getByRole('button', { name: '生成反馈预览' });
    expect((generate as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole('textbox', { name: /问题描述/ }), '搜索结果需要复核。');
    await user.type(screen.getByRole('textbox', { name: /复现步骤/ }), '选择 PDF 后开始分析。');
    expect((generate as HTMLButtonElement).disabled).toBe(false);
    await user.click(generate);

    const preview = screen.getByRole('textbox', { name: '反馈预览' }) as HTMLTextAreaElement;
    expect(preview.value).toContain('银行回单工作台 使用反馈');
    expect(preview.value).toContain('搜索结果需要复核。');
    expect(preview.value).toContain('应用版本：');
    expect(preview.value).toContain('本地引擎：已连接');
    expect(preview.value).toContain('OCR 状态：就绪');
    await user.click(screen.getByRole('button', { name: '复制文本' }));
    expect(copyFeedbackReport).toHaveBeenCalledOnce();
    expect(screen.getByText('已复制到剪贴板。')).toBeTruthy();
  });

  it('saves feedback through the local service and distinguishes cancellation and failure', async () => {
    const user = userEvent.setup();
    vi.mocked(saveFeedbackReport).mockResolvedValue({ status: 'saved', fileName: '银行回单工作台_反馈.txt' });
    renderDialog();
    await user.click(screen.getByRole('tab', { name: /使用反馈/ }));
    await user.type(screen.getByRole('textbox', { name: /问题描述/ }), '需要保存的反馈。');
    await user.click(screen.getByRole('button', { name: '生成反馈预览' }));
    await user.click(screen.getByRole('button', { name: '保存为 TXT' }));
    expect(saveFeedbackReport).toHaveBeenCalledOnce();
    expect(screen.getByText('已保存反馈文件：银行回单工作台_反馈.txt')).toBeTruthy();

    vi.mocked(saveFeedbackReport).mockResolvedValue({ status: 'cancelled' });
    await user.click(screen.getByRole('button', { name: '保存为 TXT' }));
    expect(screen.getByText('已取消保存。')).toBeTruthy();

    vi.mocked(saveFeedbackReport).mockRejectedValue(new Error('保存反馈失败，请重试。'));
    await user.click(screen.getByRole('button', { name: '保存为 TXT' }));
    expect(screen.getByRole('alert').textContent).toContain('保存反馈失败，请重试。');
  });

  it('disables copy and save actions while the local save dialog is pending', async () => {
    const user = userEvent.setup();
    let resolveSave!: (value: { status: 'saved'; fileName: string }) => void;
    vi.mocked(saveFeedbackReport).mockReturnValue(new Promise((resolve) => {
      resolveSave = resolve;
    }));
    renderDialog();
    await user.click(screen.getByRole('tab', { name: /使用反馈/ }));
    await user.type(screen.getByRole('textbox', { name: /问题描述/ }), '保存期间不能重复操作。');
    await user.click(screen.getByRole('button', { name: '生成反馈预览' }));

    const saveButton = screen.getByRole('button', { name: '保存为 TXT' }) as HTMLButtonElement;
    await user.click(saveButton);
    expect(saveButton.disabled).toBe(true);
    expect(saveButton.textContent).toBe('保存中…');
    expect((screen.getByRole('textbox', { name: /问题描述/ }) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '生成反馈预览' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '复制文本' }) as HTMLButtonElement).disabled).toBe(true);

    resolveSave({ status: 'saved', fileName: '反馈.txt' });
    await waitFor(() => expect(screen.getByText('已保存反馈文件：反馈.txt')).toBeTruthy());
  });

  it('keeps focus inside the dialog, closes with Escape, and returns to the opener', () => {
    const opener = document.createElement('button');
    opener.textContent = '打开帮助';
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn<() => void>();
    const { view } = renderDialog({ onClose });
    const dialog = screen.getByRole('dialog', { name: '帮助与反馈' });
    const first = screen.getByRole('button', { name: '关闭' });
    const last = screen.getByRole('button', { name: '返回工作区' });

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();

    view.rerender(<HelpCenterDialog open={false} onClose={onClose} engineStatus="ready" ocrReady />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
