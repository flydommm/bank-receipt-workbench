// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GuidedReviewPanel, type GuidedReviewPanelProps, type GuidedReviewPhase } from './GuidedReviewPanel';

afterEach(cleanup);

function panelProps(overrides: Partial<GuidedReviewPanelProps> = {}): GuidedReviewPanelProps {
  return {
    phase: 'entry',
    bankLabel: '上海银行',
    bankIndex: 1,
    bankCount: 2,
    bankConfirmedCount: 0,
    bankTotalCount: 14,
    roundNumber: 1,
    roundCount: 3,
    sampleLabel: '第 6 页 / 片段 1',
    dirty: false,
    busy: false,
    undoAvailable: false,
    canFinishBank: false,
    onEnter: vi.fn(),
    onPreview: vi.fn(),
    onSave: vi.fn(),
    onCancelDraft: vi.fn(),
    onBackToEdit: vi.fn(),
    onNextRound: vi.fn(),
    onCompleteBank: vi.fn(),
    onUndo: vi.fn(),
    onExit: vi.fn(),
    onHelp: vi.fn(),
    onExport: vi.fn(),
    ...overrides,
  };
}

describe('GuidedReviewPanel', () => {
  it('shows a concise result check with export first and micro-adjustment as the optional entry', async () => {
    const user = userEvent.setup();
    const onEnter = vi.fn();
    const onExport = vi.fn();
    render(<GuidedReviewPanel {...panelProps({ totalCount: 47, pendingCount: 13, onEnter, onExport })} />);

    expect(screen.getByRole('heading', { name: '结果检查' })).toBeTruthy();
    expect(screen.getByText('自动结果正确可直接选择导出范围；发现边界不合适时，再进入微调。')).toBeTruthy();
    expect(screen.getByText('候选总数 47 处')).toBeTruthy();
    expect(screen.getByText('待复核 13 处')).toBeTruthy();
    expect(screen.getByText('还有 13 处待复核；选择导出范围时仍会再次检查。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择导出范围' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入微调' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '查看微调说明' })).toBeNull();
    expect(screen.queryByRole('button', { name: '退出微调' })).toBeNull();
    expect(screen.queryByRole('button', { name: /保存本轮微调/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /确认本轮/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '导出审核结果' })).toBeNull();
    expect(screen.queryByLabelText('银行审核进度')).toBeNull();
    expect(screen.queryByText('按银行分轮审核')).toBeNull();
    expect(screen.queryByText('准备开始微调')).toBeNull();

    await user.click(screen.getByRole('button', { name: '选择导出范围' }));
    await user.click(screen.getByRole('button', { name: '进入微调' }));
    expect(onExport).toHaveBeenCalledOnce();
    expect(onEnter).toHaveBeenCalledOnce();
  });

  it('keeps both entry actions disabled while busy', () => {
    render(<GuidedReviewPanel {...panelProps({ phase: 'entry', busy: true, totalCount: 8, pendingCount: 2 })} />);

    expect((screen.getByRole('button', { name: '正在处理，请稍候…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '进入微调' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('progresses through editing and exposes only the action for the current step', async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    const onCancelDraft = vi.fn();
    const { rerender } = render(<GuidedReviewPanel {...panelProps({ phase: 'editing', dirty: true, roundSegmentCount: 14, onPreview, onCancelDraft })} />);

    expect(screen.getByText('第1轮·调整中')).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认并预览本轮 14 处' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消当前调整' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '退出微调' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /保存本轮/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: '取消当前调整' }));
    expect(onCancelDraft).toHaveBeenCalledOnce();

    rerender(<GuidedReviewPanel {...panelProps({ phase: 'editing', dirty: false, roundSegmentCount: 14, onPreview })} />);
    expect(screen.getByRole('button', { name: '确认并预览本轮 14 处' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '退出微调' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: '取消当前调整' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '确认并预览本轮 14 处' }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it('shows an unsaved whole-round preview and returns to the editable sample', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onBackToEdit = vi.fn();
    render(<GuidedReviewPanel {...panelProps({
      phase: 'review',
      bankConfirmedCount: 4,
      bankTotalCount: 14,
      roundSegmentCount: 3,
      onSave,
      onBackToEdit,
    })} />);

    expect(screen.getByRole('heading', { name: '本轮预览 3 处，尚未保存' })).toBeTruthy();
    expect(screen.getByText(/请在右侧逐项查看本轮候选/)).toBeTruthy();
    expect(screen.getByText('当前仅为预览；返回调整可以继续修改，保存后才会应用到本轮全部候选。')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存本轮 3 处' }));
    await user.click(screen.getByRole('button', { name: '返回调整' }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onBackToEdit).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /确认本轮/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '撤销本轮' })).toBeNull();
    expect(screen.queryByRole('button', { name: '开始下一位置微调' })).toBeNull();
  });

  it.each([
    ['round-complete', '开始下一位置微调'],
    ['round-complete', '检查本银行完成情况'],
    ['bank-complete', '完成本银行，进入下一银行'],
    ['bank-complete', '完成本次微调'],
  ] as Array<[GuidedReviewPhase, string]>)('renders the single next step for %s: %s', (_, label) => {
    const phase = label.startsWith('完成') ? 'bank-complete' : 'round-complete';
    const props = phase === 'bank-complete'
      ? panelProps({ phase, bankIndex: label === '完成本次微调' ? 2 : 1, bankCount: 2 })
      : panelProps({ phase, canFinishBank: label.includes('检查') });
    render(<GuidedReviewPanel {...props} />);

    expect(screen.getByRole('button', { name: label })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '导出审核结果' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重新进入微调' })).toBeNull();
  });

  it('keeps the latest round undoable after completion and exposes previous-round undo while idle', async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const { rerender } = render(<GuidedReviewPanel {...panelProps({
      phase: 'round-complete',
      undoAvailable: true,
      onUndo,
    })} />);

    await user.click(screen.getByRole('button', { name: '撤销本轮' }));
    expect(onUndo).toHaveBeenCalledOnce();

    rerender(<GuidedReviewPanel {...panelProps({
      phase: 'editing',
      dirty: false,
      undoAvailable: true,
      onUndo,
    })} />);
    await user.click(screen.getByRole('button', { name: '撤销上一轮' }));
    expect(onUndo).toHaveBeenCalledTimes(2);
  });

  it('offers further positions only after the current scope completes and keeps selection controls behind that entry', async () => {
    const user = userEvent.setup();
    const onOpenPositions = vi.fn();
    const onSelectPosition = vi.fn();
    const onStartPosition = vi.fn();
    const onCancelPositions = vi.fn();
    const props = panelProps({ phase: 'round-complete', canFinishBank: true, canExtendBank: true,
      onOpenPositions, onSelectPosition, onStartPosition, onCancelPositions });
    const { rerender } = render(<GuidedReviewPanel {...props} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: '检查本银行完成情况' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '继续微调本银行其他位置' }));
    expect(onOpenPositions).toHaveBeenCalledOnce();

    rerender(<GuidedReviewPanel {...props} phase="choosing-position" selectedPositionKey="top" positionChoices={[
      { key: 'top', label: '首栏（样本：第 3 页）', count: 14 },
      { key: 'middle', label: '中间栏（样本：第 5 页）', count: 18 },
    ]} />);
    await user.selectOptions(screen.getByRole('combobox', { name: '需要微调的位置' }), 'middle');
    expect(onSelectPosition).toHaveBeenCalledWith('middle');
    await user.click(screen.getByRole('button', { name: '开始所选位置微调' }));
    expect(onStartPosition).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '返回本轮完成状态' }));
    expect(onCancelPositions).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /确认并预览本轮/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /保存本轮/ })).toBeNull();
  });

  it('keeps position discovery cancellable while busy and offers no empty start action', async () => {
    const onCancelPositions = vi.fn();
    const { rerender } = render(<GuidedReviewPanel {...panelProps({ phase: 'choosing-position', busy: true,
      onCancelPositions })} />);
    expect(screen.queryByRole('button', { name: '开始所选位置微调' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '返回本轮完成状态' }));
    expect(onCancelPositions).toHaveBeenCalledOnce();
    rerender(<GuidedReviewPanel {...panelProps({ phase: 'choosing-position', positionChoices: [],
      message: '没有可加入的同银行位置。' })} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: '开始所选位置微调' })).toBeNull();
  });

  it('keeps completed mode limited to export and re-entry', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    const onEnter = vi.fn();
    render(<GuidedReviewPanel {...panelProps({ phase: 'completed', onExport, onEnter })} />);

    await user.click(screen.getByRole('button', { name: '导出审核结果' }));
    await user.click(screen.getByRole('button', { name: '重新进入微调' }));
    expect(onExport).toHaveBeenCalledOnce();
    expect(onEnter).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '查看微调说明' })).toBeNull();
    expect(screen.queryByRole('button', { name: '退出微调' })).toBeNull();
  });

  it('disables mutating actions while busy, allows preparing to be cancelled when idle, and reports errors', () => {
    const { rerender } = render(<GuidedReviewPanel {...panelProps({ phase: 'editing', dirty: true, busy: true, error: '本轮预览失败，请重试。' })} />);

    expect(screen.getByRole('alert').textContent).toContain('本轮预览失败');
    expect((screen.getByRole('button', { name: /正在生成预览/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消当前调整' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '退出微调' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<GuidedReviewPanel {...panelProps({ phase: 'preparing', busy: true })} />);
    expect((screen.getByRole('button', { name: '退出微调' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('progressbar', { name: '准备微调' })).toBeTruthy();
  });

  it('associates panel status and errors with the labelled review region', () => {
    const { rerender } = render(<GuidedReviewPanel {...panelProps({ phase: 'editing', error: '边界校验失败' })} />);
    const panel = screen.getByRole('region', { name: '微调与确认' });
    const feedback = screen.getByRole('alert');
    expect(panel.getAttribute('aria-describedby')).toBe(feedback.parentElement?.id);

    rerender(<GuidedReviewPanel {...panelProps({ phase: 'editing' })} />);
    expect(screen.getByRole('region', { name: '微调与确认' }).hasAttribute('aria-describedby')).toBe(false);
  });

  it('shows a failed write as stopped with a usable recovery action, not as still saving', async () => {
    const retry = vi.fn();
    render(<GuidedReviewPanel {...panelProps({ phase: 'editing', dirty: true, roundSegmentCount: 14, actionsDisabled: true,
      error: '本轮保存失败', children: <button onClick={retry}>重试本轮保存</button> })} />);
    expect(screen.queryByRole('button', { name: /正在保存/ })).toBeNull();
    expect((screen.getByRole('button', { name: '确认并预览本轮 14 处' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '重试本轮保存' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('does not move focus when the panel rerenders', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<GuidedReviewPanel {...panelProps({ phase: 'editing', children: <input aria-label="当前范围" /> })} />);
    const input = screen.getByRole('textbox', { name: '当前范围' });
    await user.click(input);
    expect(document.activeElement).toBe(input);

    rerender(<GuidedReviewPanel {...panelProps({ phase: 'editing', message: '已更新提示', children: <input aria-label="当前范围" /> })} />);
    expect(document.activeElement).toBe(input);
  });
});
