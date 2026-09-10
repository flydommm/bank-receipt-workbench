// @vitest-environment jsdom

// @ts-expect-error Bun exposes Node-compatible fs without @types/node.
import { readFileSync } from 'node:fs';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReviewNavigatorRow } from './ReviewNavigator';
import { ReviewNavigator } from './ReviewNavigator';

function row(overrides: Partial<ReviewNavigatorRow> = {}): ReviewNavigatorRow {
  return {
    id: 'segment-1',
    sourceKey: 'source-a',
    sourcePage: 1,
    segmentNo: 1,
    sourceName: 'source.pdf',
    sourceAccessibleLabel: 'source.pdf',
    matchedField: '摘要',
    matchedText: '手续费',
    confidence: 0.95,
    reviewStatus: 'confirmed',
    manualAdjusted: false,
    mode: 'candidate',
    ...overrides,
  };
}

function renderNavigator(overrides: Partial<React.ComponentProps<typeof ReviewNavigator>> = {}) {
  return render(
    <ReviewNavigator
      rows={[row()]}
      selectedId={null}
      activeFilter="all"
      onFilterChange={vi.fn()}
      onSelect={vi.fn()}
      showSourceName={false}
      {...overrides}
    />,
  );
}

afterEach(cleanup);

describe('ReviewNavigator', () => {
  it('reports controlled filter changes and only summarizes a non-all filter', async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    const { rerender } = renderNavigator({
      activeFilter: 'all',
      onFilterChange,
      rows: [
        row({ id: 'confirmed' }),
        row({ id: 'needs', reviewStatus: 'needs_review' }),
      ],
    });

    expect(screen.getByRole('button', { name: '全部 2' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '需复核 1' }));
    expect(onFilterChange).toHaveBeenCalledWith('needs_review');

    rerender(
      <ReviewNavigator
        rows={[row({ id: 'confirmed' }), row({ id: 'needs', reviewStatus: 'needs_review' })]}
        selectedId={null}
        activeFilter="needs_review"
        onFilterChange={onFilterChange}
        onSelect={vi.fn()}
        showSourceName={false}
      />,
    );
    expect(screen.getByText('当前显示 1 / 总计 2 个片段')).toBeTruthy();
    expect(screen.queryByText(/^全部 2$/)).toBeNull();
    expect(screen.getByRole('region', { name: '审核导航' })).toBeTruthy();
  });

  it('shows normal total only for all and counts each filter', () => {
    renderNavigator({
      rows: [
        row({ id: 'confirmed' }),
        row({ id: 'needs', sourcePage: 2, reviewStatus: 'needs_review' }),
        row({ id: 'manual', sourcePage: 3, mode: 'manual', manualAdjusted: true }),
        row({ id: 'blocked', sourcePage: 4, reviewStatus: 'blocked' }),
      ],
    });

    expect(screen.getByRole('button', { name: '全部 4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '需复核 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '人工调整 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '已阻塞 1' })).toBeTruthy();
  });

  it('shows source names only when requested and always exposes an unambiguous source label', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderNavigator({
      showSourceName: true,
      rows: [row({ sourceName: 'bank.pdf', sourceAccessibleLabel: 'bank-a/bank.pdf' })],
      onSelect,
    });

    expect(screen.getByText('bank.pdf')).toBeTruthy();
    const item = screen.getByRole('button', { name: /^bank-a\/bank\.pdf，/ });
    await user.click(item);
    expect(onSelect).toHaveBeenCalledWith('segment-1');
  });

  it('clearly exposes the selected row and leaves other rows unselected', () => {
    renderNavigator({
      rows: [row(), row({ id: 'segment-2', sourcePage: 2, segmentNo: 2 })],
      selectedId: 'segment-2',
    });

    const selectedRow = screen.getByRole('button', { name: /第 2 页.*片段 2/ });
    const unselectedRow = screen.getByRole('button', { name: /第 1 页.*片段 1/ });

    expect(selectedRow.getAttribute('aria-current')).toBe('true');
    expect(selectedRow.getAttribute('data-selected')).toBe('true');
    expect(screen.getByText('当前选中').className).toContain('review-navigator-row-selected');
    expect(unselectedRow.getAttribute('aria-current')).toBeNull();
    expect(unselectedRow.getAttribute('data-selected')).toBeNull();
    expect(unselectedRow.querySelector('.review-navigator-row-selected')).toBeNull();
  });

  it('uses the selected row as the only tab stop and moves down with ArrowDown', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const rows = [
      row({ id: 'one', sourceKey: 'source-a', sourcePage: 2, segmentNo: 1 }),
      row({ id: 'two', sourceKey: 'source-a', sourcePage: 2, segmentNo: 2 }),
    ];
    const { rerender } = renderNavigator({ rows, selectedId: 'one', onSelect });
    const first = screen.getByRole('button', { name: /第 2 页.*片段 1/ });
    const second = screen.getByRole('button', { name: /第 2 页.*片段 2/ });

    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
    first.focus();
    await user.keyboard('{ArrowDown}');

    expect(onSelect).toHaveBeenCalledWith('two');
    expect(document.activeElement).toBe(second);

    rerender(
      <ReviewNavigator
        rows={rows}
        selectedId="two"
        activeFilter="all"
        onFilterChange={vi.fn()}
        onSelect={onSelect}
        showSourceName={false}
      />,
    );
    expect(first.tabIndex).toBe(-1);
    expect(second.tabIndex).toBe(0);
    expect(second.getAttribute('aria-current')).toBe('true');
  });

  it('uses same-page neighbors for ArrowLeft and ArrowRight', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const rows = [
      row({ id: 'one', sourceKey: 'source-a', sourcePage: 2, segmentNo: 1 }),
      row({ id: 'other-page', sourceKey: 'source-a', sourcePage: 3, segmentNo: 1 }),
      row({ id: 'two', sourceKey: 'source-a', sourcePage: 2, segmentNo: 2 }),
    ];
    renderNavigator({ rows, selectedId: 'one', onSelect });
    const first = screen.getByRole('button', { name: /第 2 页.*片段 1/ });
    const second = screen.getByRole('button', { name: /第 2 页.*片段 2/ });

    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenLastCalledWith('two');
    expect(document.activeElement).toBe(second);

    await user.keyboard('{ArrowLeft}');
    expect(onSelect).toHaveBeenLastCalledWith('one');
    expect(document.activeElement).toBe(first);
  });

  it('does not navigate when rows are disabled', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const rows = [
      row({ id: 'one' }),
      row({ id: 'two', sourcePage: 2, segmentNo: 1 }),
    ];
    renderNavigator({ rows, selectedId: 'one', onSelect, navigationDisabled: true });
    const first = screen.getByRole('button', { name: /第 1 页.*片段 1/ });
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('prevents the browser default at navigation boundaries', () => {
    renderNavigator({ selectedId: null });
    const rowButton = screen.getByRole('button', { name: /第 1 页.*片段 1/ });
    rowButton.focus();
    const event = createEvent.keyDown(rowButton, { key: 'ArrowUp', code: 'ArrowUp' });

    fireEvent(rowButton, event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('does not navigate when a text input owns the arrow key event', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderNavigator({ onSelect });
    const rowButton = screen.getByRole('button', { name: /第 1 页.*片段 1/ });
    const input = document.createElement('input');
    rowButton.appendChild(input);

    input.focus();
    await user.keyboard('{ArrowRight}');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('restores focus when the focused target is filtered out without selecting a fallback row', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const rows = [
      row({ id: 'current', reviewStatus: 'blocked' }),
      row({ id: 'target', sourcePage: 2, reviewStatus: 'needs_review' }),
    ];
    const { rerender } = renderNavigator({ rows, selectedId: 'current', onSelect });
    const current = screen.getByRole('button', { name: /第 1 页.*片段 1/ });
    const target = screen.getByRole('button', { name: /第 2 页.*片段 1/ });

    current.focus();
    await user.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenCalledWith('target');
    expect(document.activeElement).toBe(target);

    onSelect.mockClear();
    rerender(
      <ReviewNavigator
        rows={rows}
        selectedId="current"
        activeFilter="blocked"
        onFilterChange={vi.fn()}
        onSelect={onSelect}
        showSourceName={false}
      />,
    );

    const visibleCurrent = screen.getByRole('button', { name: /第 1 页.*片段 1/ });
    expect(screen.queryByRole('button', { name: /第 2 页.*片段 1/ })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(visibleCurrent);
  });

  it('does not steal focus from a filter control when its focused row disappears', () => {
    const rows = [
      row({ id: 'target', reviewStatus: 'needs_review' }),
      row({ id: 'fallback', sourcePage: 2, reviewStatus: 'blocked' }),
    ];
    const { rerender } = renderNavigator({ rows, selectedId: null, activeFilter: 'all' });
    const target = screen.getByRole('button', { name: /第 1 页.*片段 1/ });
    target.focus();
    const filterButton = screen.getByRole('button', { name: '全部 2' });
    filterButton.focus();

    rerender(
      <ReviewNavigator
        rows={rows}
        selectedId={null}
        activeFilter="blocked"
        onFilterChange={vi.fn()}
        onSelect={vi.fn()}
        showSourceName={false}
      />,
    );

    expect(document.activeElement).toBe(filterButton);
  });

  it('does not steal focus after a null-related-target blur leaves the list', () => {
    const rows = [
      row({ id: 'target', reviewStatus: 'needs_review' }),
      row({ id: 'fallback', sourcePage: 2, reviewStatus: 'blocked' }),
    ];
    const { rerender } = renderNavigator({ rows, selectedId: null, activeFilter: 'all' });
    const target = screen.getByRole('button', { name: /第 1 页.*片段 1/ });
    const filterButton = screen.getByRole('button', { name: '全部 2' });

    target.focus();
    target.blur();
    filterButton.focus();
    rerender(
      <ReviewNavigator
        rows={rows}
        selectedId={null}
        activeFilter="blocked"
        onFilterChange={vi.fn()}
        onSelect={vi.fn()}
        showSourceName={false}
      />,
    );

    expect(document.activeElement).toBe(filterButton);
  });

  it('does not restore a row after it was blurred to body before filtering', () => {
    const rows = [
      row({ id: 'target', reviewStatus: 'needs_review' }),
      row({ id: 'fallback', sourcePage: 2, reviewStatus: 'blocked' }),
    ];
    const { rerender } = renderNavigator({ rows, selectedId: null, activeFilter: 'all' });
    const target = screen.getByRole('button', { name: /第 1 页.*片段 1/ });
    target.focus();
    target.blur();

    rerender(
      <ReviewNavigator
        rows={rows}
        selectedId={null}
        activeFilter="blocked"
        onFilterChange={vi.fn()}
        onSelect={vi.fn()}
        showSourceName={false}
      />,
    );

    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus to a safe empty-result landing when the focused row disappears', () => {
    const rows = [row({ id: 'target', reviewStatus: 'needs_review' })];
    const { rerender } = renderNavigator({ rows, selectedId: 'target', activeFilter: 'all' });
    const target = screen.getByRole('button', { name: /第 1 页.*片段 1/ });
    target.focus();

    rerender(
      <ReviewNavigator
        rows={rows}
        selectedId="target"
        activeFilter="blocked"
        onFilterChange={vi.fn()}
        onSelect={vi.fn()}
        showSourceName={false}
      />,
    );

    const emptyState = screen.getByText('当前筛选下没有命中片段').parentElement;
    expect(emptyState).not.toBeNull();
    expect(emptyState?.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(emptyState);
  });

  it('scrolls an offscreen selected row into the nearest visible position', () => {
    const rows = [row(), row({ id: 'segment-2', sourcePage: 2, segmentNo: 2 })];
    const { rerender } = renderNavigator({ rows, selectedId: null });
    const list = screen.getByRole('list', { name: '审核片段' });
    const firstRow = screen.getByRole('button', { name: /第 1 页.*片段 1/ });
    const secondRow = screen.getByRole('button', { name: /第 2 页.*片段 2/ });
    const firstScrollIntoView = vi.fn();
    const secondScrollIntoView = vi.fn();
    const listRectSpy = vi.spyOn(list, 'getBoundingClientRect');
    const firstRowRectSpy = vi.spyOn(firstRow, 'getBoundingClientRect');
    const secondRowRectSpy = vi.spyOn(secondRow, 'getBoundingClientRect');

    firstRow.scrollIntoView = firstScrollIntoView;
    secondRow.scrollIntoView = secondScrollIntoView;
    listRectSpy.mockReturnValue({ top: 100, bottom: 140 } as DOMRect);
    firstRowRectSpy.mockReturnValue({ top: 100, bottom: 120 } as DOMRect);
    secondRowRectSpy.mockReturnValue({ top: 150, bottom: 180 } as DOMRect);

    rerender(
      <ReviewNavigator
        rows={rows}
        selectedId="segment-2"
        activeFilter="all"
        onFilterChange={vi.fn()}
        onSelect={vi.fn()}
        showSourceName={false}
      />,
    );
    expect(secondScrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(firstScrollIntoView).not.toHaveBeenCalled();

    secondScrollIntoView.mockClear();
    secondRowRectSpy.mockReturnValue({ top: 110, bottom: 130 } as DOMRect);
    rerender(
      <ReviewNavigator
        rows={rows}
        selectedId="segment-1"
        activeFilter="all"
        onFilterChange={vi.fn()}
        onSelect={vi.fn()}
        showSourceName={false}
      />,
    );
    expect(secondScrollIntoView).not.toHaveBeenCalled();

    rerender(
      <ReviewNavigator
        rows={rows}
        selectedId="segment-2"
        activeFilter="all"
        onFilterChange={vi.fn()}
        onSelect={vi.fn()}
        showSourceName={false}
      />,
    );
    expect(secondScrollIntoView).not.toHaveBeenCalled();

    rerender(
      <ReviewNavigator
        rows={rows}
        selectedId="missing"
        activeFilter="all"
        onFilterChange={vi.fn()}
        onSelect={vi.fn()}
        showSourceName={false}
      />,
    );
    expect(firstScrollIntoView).not.toHaveBeenCalled();
    expect(secondScrollIntoView).not.toHaveBeenCalled();
  });

  it('does not throw when an offscreen selected row lacks scrollIntoView', () => {
    const { rerender } = renderNavigator({ selectedId: null });
    const list = screen.getByRole('list', { name: '审核片段' });
    const selectedRow = screen.getByRole('button', { name: /第 1 页.*片段 1/ });

    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 140 } as DOMRect);
    vi.spyOn(selectedRow, 'getBoundingClientRect').mockReturnValue({ top: 150, bottom: 180 } as DOMRect);
    Object.defineProperty(selectedRow, 'scrollIntoView', { configurable: true, value: undefined });

    expect(() => {
      rerender(
        <ReviewNavigator
          rows={[row()]}
          selectedId="segment-1"
          activeFilter="all"
          onFilterChange={vi.fn()}
          onSelect={vi.fn()}
          showSourceName={false}
        />,
      );
    }).not.toThrow();
  });

  it('does not render group confirmation or export controls', () => {
    renderNavigator();

    expect(screen.queryByRole('button', { name: '确认整组' })).toBeNull();
    expect(screen.queryByRole('button', { name: /导出/ })).toBeNull();
    expect(screen.queryByText('当前审核摘要')).toBeNull();
  });

  it('shows or hides the keyboard navigation hint from the user setting', () => {
    const { rerender } = renderNavigator();

    expect(screen.getByRole('note').textContent).toContain('焦点在命中片段上时，可用 ↑↓←→ 切换，Home/End 跳到首尾');
    rerender(
      <ReviewNavigator
        rows={[row()]}
        selectedId={null}
        activeFilter="all"
        onFilterChange={vi.fn()}
        onSelect={vi.fn()}
        showSourceName={false}
        showKeyboardHints={false}
      />,
    );
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('locks filters and rows during final preview', async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    const onSelect = vi.fn();
    renderNavigator({ navigationDisabled: true, onFilterChange, onSelect });

    expect((screen.getByRole('button', { name: /全部/ }) as HTMLButtonElement).disabled).toBe(true);
    const rowButton = screen.getByRole('button', { name: /第 1 页.*片段 1/ }) as HTMLButtonElement;
    expect(rowButton.disabled).toBe(true);
    await user.click(rowButton);
    await user.click(screen.getByRole('button', { name: /全部/ }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onFilterChange).not.toHaveBeenCalled();
  });

  it('keeps empty-filter and large-list behavior', async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 180 }, (_value, index) => row({
      id: `segment-${index + 1}`,
      sourcePage: index + 1,
    }));
    const onFilterChange = vi.fn();
    const { rerender } = renderNavigator({ rows, onFilterChange });
    const list = screen.getByRole('list', { name: '审核片段' });
    expect(list.className).toContain('review-navigator-list');
    expect(list.querySelectorAll('li')).toHaveLength(180);

    await user.click(screen.getByRole('button', { name: /已阻塞/ }));
    expect(onFilterChange).toHaveBeenCalledWith('blocked');
    rerender(
      <ReviewNavigator
        rows={[row()]}
        selectedId={null}
        activeFilter="blocked"
        onFilterChange={onFilterChange}
        onSelect={vi.fn()}
        showSourceName={false}
      />,
    );
    expect(screen.getByText('当前筛选下没有命中片段')).toBeTruthy();
  });

  it('passes through the shared pairing error without inventing a second rule', () => {
    renderNavigator({ pairingError: '命中结果与审核片段无法配对。' });
    expect(screen.getByText('命中结果与审核片段无法配对。')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('命中结果与审核片段无法配对。');
  });

  it('labels previous results without disabling filters or rows', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onFilterChange = vi.fn();
    renderNavigator({ stale: true, navigationDisabled: false, onSelect, onFilterChange });

    expect(screen.getByText('上次结果')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '全部 1' }));
    await user.click(screen.getByRole('button', { name: /第 1 页 \/ 片段 1/ }));
    expect(onFilterChange).toHaveBeenCalledWith('all');
    expect(onSelect).toHaveBeenCalledWith('segment-1');
  });

  it('offers the configured action in a true empty-result list', async () => {
    const user = userEvent.setup();
    const onEmptyAction = vi.fn();
    renderNavigator({
      rows: [],
      emptyMessage: '未找到符合条件的回单',
      emptyActionLabel: '修改搜索条件',
      onEmptyAction,
    });
    expect(screen.getByText('未找到符合条件的回单')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '修改搜索条件' }));
    expect(onEmptyAction).toHaveBeenCalledOnce();
  });

  it('combines source and status filters while keeping source counts independent of status', () => {
    const onSourceFilterChange = vi.fn();
    const onSortOrderChange = vi.fn();
    renderNavigator({
      rows: [
        row({ id: 'a-needs', sourceKey: 'a', sourceName: 'bank.pdf', sourceAccessibleLabel: 'a/bank.pdf', reviewStatus: 'needs_review' }),
        row({ id: 'b-needs', sourceKey: 'b', sourceName: 'bank.pdf', sourceAccessibleLabel: 'b/bank.pdf', reviewStatus: 'needs_review' }),
        row({ id: 'b-confirmed', sourceKey: 'b', sourceName: 'bank.pdf', sourceAccessibleLabel: 'b/bank.pdf' }),
      ],
      activeFilter: 'needs_review',
      sourceFilter: 'b',
      sources: [
        { key: 'a', label: 'a/bank.pdf' },
        { key: 'b', label: 'b/bank.pdf' },
        { key: 'empty', label: 'empty.pdf' },
      ],
      onSourceFilterChange,
      onSortOrderChange,
    });

    expect(screen.getByText('当前显示 1 / 总计 3 个片段')).toBeTruthy();
    expect(screen.getByRole('button', { name: '全部 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '需复核 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '已阻塞 0' })).toBeTruthy();

    const sourceSelect = screen.getByRole('combobox', { name: '来源 PDF' }) as HTMLSelectElement;
    expect([...sourceSelect.options].map((option) => option.textContent)).toEqual([
      '全部文件',
      'a/bank.pdf (1)',
      'b/bank.pdf (2)',
      'empty.pdf (0)',
    ]);
    fireEvent.change(sourceSelect, { target: { value: 'a' } });
    fireEvent.change(screen.getByRole('combobox', { name: '结果排序' }), {
      target: { value: 'confidence_desc' },
    });
    expect(onSourceFilterChange).toHaveBeenCalledWith('a');
    expect(onSortOrderChange).toHaveBeenCalledWith('confidence_desc');
  });

  it('keeps a hidden selected preview and reveals it without selecting a fallback row', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onRevealSelected = vi.fn();
    const onResetFilters = vi.fn();
    renderNavigator({
      rows: [
        row({ id: 'selected', sourceKey: 'a' }),
        row({ id: 'visible', sourceKey: 'b', sourcePage: 2 }),
      ],
      selectedId: 'selected',
      sourceFilter: 'b',
      activeFilter: 'all',
      onSelect,
      onRevealSelected,
      onResetFilters,
      sortOrder: 'confidence_desc',
      sources: [
        { key: 'a', label: 'a.pdf' },
        { key: 'b', label: 'b.pdf' },
      ],
    });

    expect(screen.getByText('当前预览片段不在筛选结果中')).toBeTruthy();
    expect(screen.getByText('筛选仅影响列表，整组确认和导出范围不变。')).toBeTruthy();
    expect((screen.getByRole('combobox', { name: '来源 PDF' }) as HTMLSelectElement).title).toBe('b.pdf');
    expect((screen.getByRole('combobox', { name: '结果排序' }) as HTMLSelectElement).title).toBe('置信度从高到低');
    await user.click(screen.getByRole('button', { name: '定位当前片段' }));
    expect(onRevealSelected).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '重置筛选' }));
    expect(onResetFilters).toHaveBeenCalledOnce();
    expect((screen.getByRole('combobox', { name: '结果排序' }) as HTMLSelectElement).value).toBe('confidence_desc');
  });

  it('retains controls and reset action when a valid filter has no matches', async () => {
    const user = userEvent.setup();
    const onResetFilters = vi.fn();
    renderNavigator({
      rows: [row({ reviewStatus: 'confirmed' })],
      activeFilter: 'blocked',
      onResetFilters,
      sources: [{ key: 'source-a', label: 'source.pdf' }, { key: 'empty', label: 'empty.pdf' }],
    });

    expect(screen.getByText('当前筛选下没有命中片段')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '来源 PDF' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '结果排序' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '重置筛选' }));
    expect(onResetFilters).toHaveBeenCalledOnce();
  });

  it('disables every view control together while keeping rows controlled by navigationDisabled', () => {
    renderNavigator({
      rows: [row(), row({ id: 'visible', sourceKey: 'other', sourcePage: 2 })],
      selectedId: 'segment-1',
      sourceFilter: 'other',
      sources: [{ key: 'source-a', label: 'source.pdf' }, { key: 'other', label: 'other.pdf' }],
      onRevealSelected: vi.fn(),
      onResetFilters: vi.fn(),
      viewControlsDisabled: true,
    });

    expect([...screen.getAllByRole('button')].filter((button) => button.className.includes('review-navigator-filter')).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect((screen.getByRole('combobox', { name: '来源 PDF' }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole('combobox', { name: '结果排序' }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '重置筛选' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '定位当前片段' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /第 2 页/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('navigates in sorted display order and native selects do not trigger row navigation', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const rows = [
      row({ id: 'high', confidence: 0.9, sourcePage: 1 }),
      row({ id: 'low', confidence: 0.1, sourcePage: 2 }),
      row({ id: 'middle', confidence: 0.5, sourcePage: 3 }),
    ];
    renderNavigator({
      rows,
      selectedId: 'low',
      sortOrder: 'confidence_desc',
      onSelect,
      sources: [{ key: 'source-a', label: 'source.pdf' }, { key: 'source-b', label: 'other.pdf' }],
    });

    const sortSelect = screen.getByRole('combobox', { name: '结果排序' });
    sortSelect.focus();
    await user.keyboard('{ArrowDown}');
    expect(onSelect).not.toHaveBeenCalled();

    const high = screen.getByRole('button', { name: /第 1 页/ });
    const middle = screen.getByRole('button', { name: /第 3 页/ });
    const low = screen.getByRole('button', { name: /第 2 页/ });
    expect(high.tabIndex).toBe(-1);
    expect(low.tabIndex).toBe(0);
    high.focus();
    await user.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenLastCalledWith('middle');
    expect(document.activeElement).toBe(middle);
    await user.keyboard('{Home}');
    expect(onSelect).toHaveBeenLastCalledWith('high');
    expect(document.activeElement).toBe(high);
    await user.keyboard('{End}');
    expect(onSelect).toHaveBeenLastCalledWith('low');
    expect(document.activeElement).toBe(low);
  });

  it('keeps the results column and hit list on one bounded flex chain', () => {
    const styles = readFileSync('src/styles.css', 'utf8');
    expect(styles).toMatch(/\.results-column\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*0;[^}]*flex-direction:\s*column;/s);
    expect(styles).toMatch(/\.review-navigator\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(/\.review-navigator-list\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;/s);
    expect(styles).toMatch(/\.review-navigator-filter-row\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;/s);
    expect(styles).toMatch(/\.review-navigator-filter\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 0;/s);
  });
});
