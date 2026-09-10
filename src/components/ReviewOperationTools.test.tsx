// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReviewOperationTools, type ReviewOperationToolsProps } from './ReviewOperationTools';

afterEach(cleanup);

function renderTools(overrides: Partial<ReviewOperationToolsProps> = {}) {
  const props: ReviewOperationToolsProps = {
    busy: false,
    historyCount: 3,
    canUndo: true,
    onUndo: vi.fn(),
    canRestoreCandidate: true,
    onRestoreCandidate: vi.fn(),
    visibleUnresolvedCount: 2,
    hiddenUnresolvedCount: 0,
    onNextUnresolved: vi.fn(),
    onRevealUnresolved: vi.fn(),
    onRetry: vi.fn(),
    onDiscard: vi.fn(),
    ...overrides,
  };

  return { props, view: render(<ReviewOperationTools {...props} />) };
}

describe('ReviewOperationTools', () => {
  it('does not invoke any callback on mount and invokes each operation once after a click', async () => {
    const user = userEvent.setup();
    const { props } = renderTools();

    expect(screen.getByRole('region', { name: '审核工具' })).toBeTruthy();
    expect(props.onNextUnresolved).not.toHaveBeenCalled();
    expect(props.onRestoreCandidate).not.toHaveBeenCalled();
    expect(props.onUndo).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '下一项待复核' }));
    await user.click(screen.getByRole('button', { name: '恢复自动候选' }));
    await user.click(screen.getByRole('button', { name: '撤销上一步' }));

    expect(props.onNextUnresolved).toHaveBeenCalledTimes(1);
    expect(props.onRestoreCandidate).toHaveBeenCalledTimes(1);
    expect(props.onUndo).toHaveBeenCalledTimes(1);
  });

  it('disables review navigation while busy or frozen and exposes hidden unresolved items without changing filters', async () => {
    const user = userEvent.setup();
    const { props, view } = renderTools({
      busy: false,
      frozenReason: '正在重新分析，暂不能修改审核结果。',
      visibleUnresolvedCount: 0,
      hiddenUnresolvedCount: 4,
    });

    expect(screen.getByText('筛选范围外还有 4 项待复核')).toBeTruthy();
    const nextButton = screen.getByRole('button', { name: '下一项待复核' }) as HTMLButtonElement;
    const revealButton = screen.getByRole('button', { name: '查看全部待复核' }) as HTMLButtonElement;
    expect(nextButton.disabled).toBe(true);
    expect(revealButton.disabled).toBe(true);
    expect(screen.getByRole('status', { name: '正在重新分析，暂不能修改审核结果。' })).toBeTruthy();

    await user.click(revealButton);
    expect(props.onRevealUnresolved).not.toHaveBeenCalled();

    view.unmount();
    const busyView = renderTools({
      busy: true,
      visibleUnresolvedCount: 0,
      hiddenUnresolvedCount: 1,
    });
    expect(screen.getByRole('status').textContent).toBe('正在保存审核…');
    expect((screen.getByRole('button', { name: '下一项待复核' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '查看全部待复核' }) as HTMLButtonElement).disabled).toBe(true);
    busyView.view.unmount();
  });

  it('shows the capped recent history count and disables undo or restore for their guards', () => {
    renderTools({
      historyCount: 27,
      canUndo: false,
      undoDisabledReason: '最近没有可撤销的审核操作。',
      canRestoreCandidate: false,
      restoreDisabledReason: '当前片段没有自动候选。',
    });

    expect(screen.getByText('最近 20 / 20 步')).toBeTruthy();
    const undoButton = screen.getByRole('button', { name: '撤销上一步' }) as HTMLButtonElement;
    const restoreButton = screen.getByRole('button', { name: '恢复自动候选' }) as HTMLButtonElement;
    expect(undoButton.disabled).toBe(true);
    expect(restoreButton.disabled).toBe(true);
    expect(undoButton.title).toContain('最近没有可撤销的审核操作。');
    expect(restoreButton.title).toContain('当前片段没有自动候选。');

    const undoReason = document.getElementById(undoButton.getAttribute('aria-describedby') ?? '');
    const restoreReason = document.getElementById(restoreButton.getAttribute('aria-describedby') ?? '');
    expect(undoReason?.textContent).toContain('最近没有可撤销的审核操作。');
    expect(restoreReason?.textContent).toContain('当前片段没有自动候选。');
  });

  it('shows unsaved recovery actions and disables them while busy or frozen', async () => {
    const user = userEvent.setup();
    const handlers = {
      onRetry: vi.fn(),
      onDiscard: vi.fn(),
    };
    const { view } = renderTools({
      ...handlers,
      unsavedMessage: '审核记录保存失败，当前修改尚未写入。',
    });

    expect(screen.getByRole('alert').textContent).toContain('审核记录保存失败，当前修改尚未写入。');
    await user.click(screen.getByRole('button', { name: '重试保存' }));
    await user.click(screen.getByRole('button', { name: '放弃未保存修改' }));
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
    expect(handlers.onDiscard).toHaveBeenCalledTimes(1);

    view.rerender(
      <ReviewOperationTools
        busy
        frozenReason="当前审核结果已冻结。"
        unsavedMessage="审核记录保存失败，当前修改尚未写入。"
        historyCount={1}
        canUndo
        onUndo={vi.fn()}
        canRestoreCandidate
        onRestoreCandidate={vi.fn()}
        visibleUnresolvedCount={1}
        hiddenUnresolvedCount={0}
        onNextUnresolved={vi.fn()}
        onRevealUnresolved={vi.fn()}
        onRetry={handlers.onRetry}
        onDiscard={handlers.onDiscard}
      />,
    );

    expect((screen.getByRole('button', { name: '重试保存' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '放弃未保存修改' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
