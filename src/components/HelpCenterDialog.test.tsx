// @vitest-environment jsdom

import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyFeedbackReport, saveFeedbackReport } from '../services/localFeedback';
import { copyFeedbackContact, openFeedbackChannel } from '../services/feedbackChannels';
import HelpCenterDialog, { type HelpCenterOcrCacheInfo } from './HelpCenterDialog';

vi.mock('../services/localFeedback', () => ({
  copyFeedbackReport: vi.fn(),
  saveFeedbackReport: vi.fn(),
}));

vi.mock('../services/feedbackChannels', () => ({
  copyFeedbackContact: vi.fn(),
  openFeedbackChannel: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(copyFeedbackReport).mockReset();
  vi.mocked(saveFeedbackReport).mockReset();
  vi.mocked(copyFeedbackContact).mockReset();
  vi.mocked(openFeedbackChannel).mockReset();
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

function channelStatus() {
  return within(screen.getByRole('region', { name: '发送反馈与查看回复' })).getByRole('status');
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

  it('opens the guide at the requested fine-tune section without changing modal focus management', async () => {
    const originalScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      renderDialog({ focusSection: 'fine-tune' });

      const close = screen.getByRole('button', { name: '关闭' });
      const title = await screen.findByRole('heading', { name: '微调与确认：预览本轮后再保存' });
      expect(screen.getByRole('tab', { name: /使用指南/ }).getAttribute('aria-selected')).toBe('true');
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' }));
      expect(scrollIntoView.mock.instances[0]).toBe(title);
      expect(document.activeElement).toBe(close);
    } finally {
      if (originalScrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
          ...originalScrollIntoViewDescriptor,
        });
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
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
    expect(screen.getByRole('heading', { name: '完成一次回单处理。' })).toBeTruthy();
    expect(screen.getAllByText(/默认每份 PDF 最多 5,000 页/).length).toBe(1);

    const guideTab = screen.getByRole('tab', { name: /使用指南/ });
    fireEvent.keyDown(guideTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /使用反馈/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: /把遇到的问题整理成一段/ })).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: /版本与更新/ }));
    expect(screen.getByText('公开发布准备版')).toBeTruthy();
    expect(screen.getByText(/没有在线更新服务器/)).toBeTruthy();
    expect(screen.getByText('0.1.40')).toBeTruthy();
    expect(screen.getByText('0.1.37')).toBeTruthy();
    expect(screen.getByText('保存版式后更换关键词，已保存的边界继续保留；同银行同版式支持跨文件匹配，并适配双张尾页已有栏位。')).toBeTruthy();
    expect(screen.getByText('贷款利息到期通知书按完整单张保留，电子缴税付款凭证独立识别；特殊凭证按类型和实际版式分组，并提供查看入口。')).toBeTruthy();
    expect(screen.getByText('记住的版式参考可用于其他月份文件的首次分析，并在重启后保留；旧记录缺少可靠身份信息时不自动套用，需核对后重新保存。')).toBeTruthy();
    expect(screen.getByText('导出目录沿用已设置的位置，成功导出后记住所选目录。')).toBeTruthy();
    expect(screen.getByText('首页分析区排版更紧凑，分析进度仅显示已分析页数和总页数。')).toBeTruthy();
    expect(screen.getByText('0.1.32')).toBeTruthy();
    expect(screen.getByText('微调区布局更紧凑，可拖动分隔线调整高度。')).toBeTruthy();
    expect(screen.getByText('检查本轮支持全选、逐项多选和 Shift 区间选择。')).toBeTruthy();
    expect(screen.getByText('操作底栏固定显示，面板内容较多时也能直接使用。')).toBeTruthy();
    expect(screen.getByText('0.1.31')).toBeTruthy();
  });

  it('explains the three-stage receipt overview workflow and current review actions', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('tab', { name: /使用指南/ }));

    expect(screen.getByRole('heading', { name: '微调与确认：预览本轮后再保存' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '阶段一：选择文件与本方账户' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '阶段二：分析并检查分割' })).toBeTruthy();
    expect(screen.getAllByText(/原页总览”和“单页/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: '勾选只选择，操作才改变状态' })).toBeTruthy();
    expect(screen.getByText(/全选当前筛选结果.*暂未渲染/)).toBeTruthy();
    expect(screen.getAllByText(/标记为“需调整”的片段不能确认/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/贷款利息到期通知书/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: '分析处理阶段的按钮' })).toBeTruthy();
    expect(screen.getAllByText(/片段总览 \/ 原页总览/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/全选当前筛选结果/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/确认所选 N 处/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/排除所选 N 处/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/恢复所选 N 处为待复核/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: '片段详情中的按钮' })).toBeTruthy();
    expect(screen.getAllByText(/返回总览/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/上一项 \/ 下一项/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/确认此片段/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/调整所选边界/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/排除此片段/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: '微调阶段的按钮' })).toBeTruthy();
    expect(screen.getByText(/勾选范围不等于版式同步范围/)).toBeTruthy();
    expect(screen.getAllByText(/确认并预览本轮/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/风险已勾选且没有阻断问题/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/统一所有栏位高度不会改变各栏位的顶部位置/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/核实并完成保存 \/ 核实并完成撤销/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: '导出结果阶段的按钮' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '阶段三：检查并导出' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '选择文件与本批账户的按钮' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '交易对手核对与分组的按钮' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '查找提取回单的导出步骤' })).toBeTruthy();
    expect(screen.getAllByText(/选择本机档案/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Excel 导入会完整预览/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/导出核对草稿 Excel/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/批量修改交易对手/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/同版式批量识别/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/导出回单/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/导出名称/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/导出方式/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/同时导出 XLSX 索引/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/当前阶段和已用时间/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/普通和分组流程分别记住上次选择/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/重试导出/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/移除本次来源/).length).toBeGreaterThan(0);
    expect(screen.queryByText('预览并导出')).toBeNull();
    expect(screen.queryByText('生成预览 N 处')).toBeNull();
    expect(screen.queryByText('返回导出设置')).toBeNull();
    const stageNote = screen.getByRole('note', { name: '审核区会显示的阶段状态' });
    expect(stageNote).toBeTruthy();
    expect(within(stageNote).getByText('确认并预览本轮')).toBeTruthy();
    expect(within(stageNote).getByText('本轮已保存')).toBeTruthy();
    expect(within(stageNote).getByText(/微调是分析处理阶段中的可选步骤/)).toBeTruthy();
    expect(screen.getAllByText(/选择导出范围/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/确认范围并生成预览/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/最终 PDF 导出预览/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/通用审核组件|可能进入/)).toBeNull();
    expect(screen.queryByText(/进入微调/)).toBeNull();
    expect(screen.queryByText(/开始下一位置微调/)).toBeNull();

    expect(screen.getByRole('heading', { name: '审核按钮怎么选' })).toBeTruthy();
    expect(screen.getByText(/勾选本身不会改变审核状态/)).toBeTruthy();
    expect(screen.getByText(/排除无效 → 核对特殊单证 → 必要时调整所选边界或模板/)).toBeTruthy();
    expect(screen.queryByText(/先选择导出范围，再检查生成的临时 PDF 预览/)).toBeNull();
    expect(screen.queryByText(/选择目录并导出 PDF/)).toBeNull();
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

  it('shows recipients and reply routes without opening or copying anything automatically', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('tab', { name: /使用反馈/ }));
    expect(screen.getByText('venz@163.com')).toBeTruthy();
    expect(screen.getByText('vinz2009')).toBeTruthy();
    expect(screen.getByText(/我们会回复你的来信/)).toBeTruthy();
    expect(screen.getByText(/我们会在微信会话中回复/)).toBeTruthy();
    expect(screen.queryByText(/GitHub/i)).toBeNull();
    expect(screen.queryByText(/Issue/i)).toBeNull();
    expect((screen.getByRole('button', { name: '复制反馈并写邮件' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /打开 GitHub/i })).toBeNull();
    expect(copyFeedbackReport).not.toHaveBeenCalled();
    expect(copyFeedbackContact).not.toHaveBeenCalled();
    expect(openFeedbackChannel).not.toHaveBeenCalled();
  });

  it('copies contact details independently of the feedback draft and explains the next step', async () => {
    const user = userEvent.setup();
    vi.mocked(copyFeedbackContact).mockResolvedValue(undefined);
    renderDialog();
    await user.click(screen.getByRole('tab', { name: /使用反馈/ }));
    await user.click(screen.getByRole('button', { name: '复制邮箱' }));
    expect(copyFeedbackContact).toHaveBeenLastCalledWith('email');
    expect(channelStatus().textContent).toContain('已复制邮箱地址');
    await user.click(screen.getByRole('button', { name: '复制微信号' }));
    expect(copyFeedbackContact).toHaveBeenLastCalledWith('wechat');
    expect(channelStatus().textContent).toContain('通过好友验证后发送反馈');
    expect(openFeedbackChannel).not.toHaveBeenCalled();
  });

  it('keeps contact details available for manual copying if the clipboard is unavailable', async () => {
    const user = userEvent.setup();
    vi.mocked(copyFeedbackContact).mockRejectedValue(new Error('private clipboard detail'));
    renderDialog();
    await user.click(screen.getByRole('tab', { name: /使用反馈/ }));
    await user.click(screen.getByRole('button', { name: '复制微信号' }));
    expect(screen.getByRole('alert').textContent).toContain('手动选择并复制');
    expect(screen.getByText('vinz2009')).toBeTruthy();
    expect(screen.queryByText(/private clipboard detail/)).toBeNull();
    expect((screen.getByRole('button', { name: '复制微信号' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('waits for feedback copying before opening email and prevents duplicate or conflicting actions', async () => {
    const user = userEvent.setup();
    let resolveCopy!: () => void;
    vi.mocked(copyFeedbackReport).mockReturnValue(new Promise<void>((resolve) => { resolveCopy = resolve; }));
    vi.mocked(openFeedbackChannel).mockResolvedValue(undefined);
    renderDialog();
    await user.click(screen.getByRole('tab', { name: /使用反馈/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /问题描述/ }), { target: { value: '合成反馈正文' } });
    await user.click(screen.getByRole('button', { name: '生成反馈预览' }));
    const email = screen.getByRole('button', { name: '复制反馈并写邮件' });
    await user.click(email);
    await user.click(email);
    expect(copyFeedbackReport).toHaveBeenCalledOnce();
    expect(copyFeedbackReport).toHaveBeenCalledWith(expect.stringContaining('合成反馈正文'));
    expect(openFeedbackChannel).not.toHaveBeenCalled();
    for (const name of ['复制文本', '保存为 TXT', '复制邮箱', '复制微信号']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByRole('textbox', { name: /问题描述/ }) as HTMLTextAreaElement).disabled).toBe(true);
    resolveCopy();
    await waitFor(() => expect(openFeedbackChannel).toHaveBeenCalledExactlyOnceWith('email'));
    await waitFor(() => expect(channelStatus().textContent).toContain('当前尚未发送'));
    expect((email as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses the latest preview for email and tells the user to send it manually', async () => {
    const user = userEvent.setup();
    vi.mocked(copyFeedbackReport).mockResolvedValue(undefined);
    vi.mocked(openFeedbackChannel).mockResolvedValue(undefined);
    renderDialog();
    await user.click(screen.getByRole('tab', { name: /使用反馈/ }));
    const description = screen.getByRole('textbox', { name: /问题描述/ });
    fireEvent.change(description, { target: { value: '旧的合成描述' } });
    await user.click(screen.getByRole('button', { name: '生成反馈预览' }));
    fireEvent.change(description, { target: { value: '修正后的合成描述' } });
    await user.click(screen.getByRole('button', { name: '复制反馈并写邮件' }));
    expect(copyFeedbackReport).toHaveBeenCalledWith(expect.stringContaining('修正后的合成描述'));
    expect(copyFeedbackReport).not.toHaveBeenCalledWith(expect.stringContaining('旧的合成描述'));
    expect(openFeedbackChannel).toHaveBeenCalledExactlyOnceWith('email');
    expect(channelStatus().textContent).toContain('venz@163.com');
    expect(channelStatus().textContent).toContain('当前尚未发送');
    fireEvent.change(description, { target: { value: '' } });
    expect((screen.getByRole('button', { name: '复制反馈并写邮件' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not open a channel after copy failure and offers a manual path without exposing raw errors', async () => {
    const user = userEvent.setup();
    vi.mocked(copyFeedbackReport).mockRejectedValue(new Error('private report or path'));
    renderDialog();
    await user.click(screen.getByRole('tab', { name: /使用反馈/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /问题描述/ }), { target: { value: '合成描述' } });
    await user.click(screen.getByRole('button', { name: '生成反馈预览' }));
    await user.click(screen.getByRole('button', { name: '复制反馈并写邮件' }));
    expect(openFeedbackChannel).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('尚未打开反馈入口');
    expect(screen.getByRole('alert').textContent).toContain('手动复制');
    expect(screen.queryByText(/private report or path/)).toBeNull();
  });

  it.each([
    ['复制反馈并写邮件', 'venz@163.com'],
  ])('retains copied feedback and a usable destination if %s fails', async (buttonName, destination) => {
    const user = userEvent.setup();
    vi.mocked(copyFeedbackReport).mockResolvedValue(undefined);
    vi.mocked(openFeedbackChannel).mockRejectedValue(new Error('private native error'));
    renderDialog();
    await user.click(screen.getByRole('tab', { name: /使用反馈/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /问题描述/ }), { target: { value: '合成描述' } });
    await user.click(screen.getByRole('button', { name: '生成反馈预览' }));
    await user.click(screen.getByRole('button', { name: buttonName }));
    expect(screen.getByRole('alert').textContent).toContain('反馈已复制，但未能打开');
    expect(screen.getByRole('alert').textContent).toContain(destination);
    expect(screen.queryByText(/private native error/)).toBeNull();
    expect((screen.getByRole('button', { name: buttonName }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('textbox', { name: '反馈预览' }) as HTMLTextAreaElement).value).toContain('合成描述');
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
