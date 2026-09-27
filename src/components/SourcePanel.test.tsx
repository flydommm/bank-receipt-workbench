// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BatchFeedback } from '../domain/batchFeedback';
import { SourcePanel, type SourcePanelFile, type SourcePanelProps } from './SourcePanel';

afterEach(cleanup);

const sourcePath = (index: number) => `D:\\input\\source-${index}.pdf`;

function makeFile(index: number, overrides: Partial<SourcePanelFile> = {}): SourcePanelFile {
  return {
    key: `source-${index}`,
    name: `source-${index}.pdf`,
    sourcePath: sourcePath(index),
    size: 1024 * index,
    pageCount: null,
    integrityStatus: null,
    ...overrides,
  };
}

function renderPanel(overrides: Partial<SourcePanelProps> = {}) {
  const props: SourcePanelProps = {
    files: [makeFile(1)],
    activeSourcePath: sourcePath(1),
    notice: null,
    disabled: false,
    onPickFiles: vi.fn(),
    onPickFolder: vi.fn(),
    onAddFiles: vi.fn(),
    onAddFolder: vi.fn(),
    onSelectSource: vi.fn(),
    onRemoveAll: vi.fn(),
    onRemoveSelected: vi.fn(),
    onRemoveSource: vi.fn(),
    ...overrides,
  };
  const view = render(<SourcePanel {...props} />);
  return { ...props, ...view };
}

function makeBatchFeedback(overrides: Partial<BatchFeedback> = {}): BatchFeedback {
  return {
    runId: 1,
    phase: 'running',
    stage: 'search',
    sources: [
      {
        sourcePath: sourcePath(1),
        name: 'source-1.pdf',
        search: 'waiting',
        pages: {},
        segmentCount: null,
      },
      {
        sourcePath: sourcePath(2),
        name: 'source-2.pdf',
        search: 'waiting',
        pages: {},
        segmentCount: null,
      },
    ],
    failures: [],
    ...overrides,
  };
}

describe('SourcePanel', () => {
  it('keeps file operations prominent and reset separate from file selection', async () => {
    const onNewTask = vi.fn(), user = userEvent.setup();
    const props = renderPanel({ onNewTask });
    expect(screen.queryByRole('navigation', { name: '回单处理步骤' })).toBeNull();
    expect(screen.getByRole('heading', { name: '文件操作', level: 2 })).toBeTruthy();
    expect(screen.queryByText('SOURCE FILES')).toBeNull();
    expect(screen.queryByRole('heading', { name: '当前文件' })).toBeNull();
    expect(screen.queryByRole('button', { name: '我的模板' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '重置任务' }));
    expect(props.onNewTask).toHaveBeenCalledOnce();
    cleanup(); renderPanel({ onNewTask, disabled: true });
    expect((screen.getByRole('button', { name: '重置任务' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps file actions in the panel and invokes their handlers', async () => {
    const user = userEvent.setup();
    const props = renderPanel();

    await user.click(screen.getByRole('button', { name: '选择 PDF' }));
    await user.click(screen.getByRole('button', { name: '选择文件夹' }));
    await user.click(screen.getByRole('button', { name: '添加 PDF' }));
    await user.click(screen.getByRole('button', { name: '添加文件夹' }));
    await user.click(screen.getByRole('button', { name: '移除全部文件' }));

    expect(props.onPickFiles).toHaveBeenCalledOnce();
    expect(props.onPickFolder).toHaveBeenCalledOnce();
    expect(props.onAddFiles).toHaveBeenCalledOnce();
    expect(props.onAddFolder).toHaveBeenCalledOnce();
    expect(props.onRemoveAll).toHaveBeenCalledOnce();
    expect(screen.getByRole('complementary', { name: '当前文件' })).toBeTruthy();
  });

  it('renders every source file instead of truncating the list', () => {
    const files = Array.from({ length: 6 }, (_value, index) => makeFile(index + 1));
    renderPanel({ files, activeSourcePath: sourcePath(1) });

    for (const file of files) {
      expect(screen.getByTitle(file.sourcePath)).toBeTruthy();
    }
    expect(screen.queryByText(/另有\s*\d+\s*个 PDF/)).toBeNull();
  });

  it('derives the cumulative count from the current source list after append and removal', () => {
    const props = renderPanel();
    expect(screen.getByText('1 份 PDF · 待分析')).toBeTruthy();
    props.rerender(<SourcePanel {...props} files={[makeFile(1), makeFile(2), makeFile(3)]} />);
    expect(screen.getByText('3 份 PDF · 待分析')).toBeTruthy();
    props.rerender(<SourcePanel {...props} files={[makeFile(1), makeFile(3)]} />);
    expect(screen.getByText('2 份 PDF · 待分析')).toBeTruthy();
  });

  it('shows the receipt task phase when supplied by the analysis workflow', () => {
    const props = renderPanel({ taskStateLabel: '分析中' });
    expect(screen.getByText('1 份 PDF · 分析中')).toBeTruthy();
    props.rerender(<SourcePanel {...props} taskStateLabel="待检查" />);
    expect(screen.getByText('1 份 PDF · 待检查')).toBeTruthy();
  });

  it('uses arrow and boundary keys to focus and preview adjacent source files', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ files: [makeFile(1), makeFile(2), makeFile(3)] });
    const first = screen.getByTitle(sourcePath(1));
    const second = screen.getByTitle(sourcePath(2));
    const third = screen.getByTitle(sourcePath(3));
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(second);
    expect(props.onSelectSource).toHaveBeenLastCalledWith(sourcePath(2));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(third);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(first);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(third);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(second);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(first);
    const callCount = vi.mocked(props.onSelectSource).mock.calls.length;
    screen.getByRole('checkbox', { name: '选择 source-1.pdf' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(vi.mocked(props.onSelectSource).mock.calls).toHaveLength(callCount);
  });

  it('shows analysis, metadata, and source-integrity states in each row', () => {
    renderPanel({
      files: [
        makeFile(1),
        makeFile(2, { pageCount: 12, integrityStatus: 'valid' }),
        makeFile(3, { pageCount: 9, integrityStatus: 'changed' }),
      ],
      activeSourcePath: sourcePath(2),
    });

    expect(screen.getByText('页数待分析')).toBeTruthy();
    expect(screen.getByText('12 页 · 文档已读取')).toBeTruthy();
    expect(screen.getByText('源文件已变化，请重新分析')).toBeTruthy();
    expect(screen.getByTitle(sourcePath(2)).getAttribute('aria-current')).toBe('true');
    expect(screen.getByTitle(sourcePath(1)).getAttribute('aria-current')).toBeNull();
  });

  it('locks actions and source rows when disabled', () => {
    renderPanel({ files: [makeFile(1), makeFile(2)], disabled: true });

    for (const label of ['选择 PDF', '选择文件夹', '添加 PDF', '添加文件夹', '移除全部文件']) {
      expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(true);
    }
    for (const file of [makeFile(1), makeFile(2)]) {
      expect((screen.getByTitle(file.sourcePath) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('checkbox', { name: `选择 ${file.name}` }) as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: `移除 ${file.name}` }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('supports selecting and removing one or more files without selecting the preview row', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ files: [makeFile(1), makeFile(2)] });
    await user.click(screen.getByRole('checkbox', { name: '选择 source-1.pdf' }));
    await user.click(screen.getByRole('checkbox', { name: '选择 source-2.pdf' }));
    expect(screen.getByRole('button', { name: '移除选中（2）' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '移除选中（2）' }));
    expect(props.onRemoveSelected).toHaveBeenCalledWith([sourcePath(1), sourcePath(2)]);

    await user.click(screen.getByTitle(sourcePath(1)));
    expect(props.onSelectSource).toHaveBeenCalledWith(sourcePath(1));
    await user.click(screen.getByRole('button', { name: '移除 source-1.pdf' }));
    expect(props.onRemoveSource).toHaveBeenCalledWith(sourcePath(1));
  });

  it('does not retain selected paths after the parent removes all files', async () => {
    const user = userEvent.setup();
    const props: SourcePanelProps = {
      files: [makeFile(1)],
      activeSourcePath: sourcePath(1),
      notice: null,
      disabled: false,
      onPickFiles: vi.fn(),
      onPickFolder: vi.fn(),
      onAddFiles: vi.fn(),
      onAddFolder: vi.fn(),
      onSelectSource: vi.fn(),
      onRemoveAll: vi.fn(),
      onRemoveSelected: vi.fn(),
      onRemoveSource: vi.fn(),
    };
    const { rerender } = render(<SourcePanel {...props} />);
    await user.click(screen.getByRole('checkbox', { name: '选择 source-1.pdf' }));
    expect(screen.getByRole('button', { name: '移除选中（1）' })).toBeTruthy();
    rerender(<SourcePanel {...props} files={[]} />);
    expect((screen.getByRole('button', { name: '移除选中' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not loop when a parent re-renders with a fresh files array after a native click', async () => {
    const file = makeFile(1, { pageCount: 1, integrityStatus: 'valid' });
    const props: SourcePanelProps = {
      files: [file],
      activeSourcePath: null,
      notice: null,
      disabled: false,
      onPickFiles: vi.fn(),
      onPickFolder: vi.fn(),
      onAddFiles: vi.fn(),
      onAddFolder: vi.fn(),
      onSelectSource: vi.fn(),
      onRemoveAll: vi.fn(),
      onRemoveSelected: vi.fn(),
      onRemoveSource: vi.fn(),
    };
    let rerenderParent!: () => void;
    let parentRenderCount = 0;
    function Parent() {
      const [, dispatch] = useReducer((value: number) => value + 1, 0);
      rerenderParent = dispatch;
      parentRenderCount += 1;
      return <SourcePanel {...props} files={[{ ...file }]} />;
    }

    render(<Parent />);
    const checkbox = screen.getByRole('checkbox', { name: '选择 source-1.pdf' }) as HTMLInputElement;
    const originalWindowEvent = Object.getOwnPropertyDescriptor(window, 'event');
    Object.defineProperty(window, 'event', {
      configurable: true,
      get: () => ({ type: 'click' }),
    });
    try {
      // Keep the discrete native-click lane alive while the parent supplies a
      // newly allocated files array on every render. This is the production
      // shape that previously turned the no-op effect setter into #185.
      await act(async () => {
        checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });
      expect(checkbox.checked).toBe(true);

      await act(async () => {
        for (let index = 0; index < 150; index += 1) {
          rerenderParent();
          await Promise.resolve();
        }
      });
    } finally {
      if (originalWindowEvent) Object.defineProperty(window, 'event', originalWindowEvent);
      else Reflect.deleteProperty(window, 'event');
    }

    expect(parentRenderCount).toBeGreaterThan(1);
    expect(checkbox.checked).toBe(true);
    expect(screen.getByRole('button', { name: '移除选中（1）' })).toBeTruthy();
  });

  it('keeps read-only protection visible without a persistent removal notice', () => {
    renderPanel({ files: [] });

    expect(screen.queryByText('仅从当前任务移除，不删除原文件')).toBeNull();
    expect(screen.getByText('原始文件只读保护已开启')).toBeTruthy();
  });

  it('hides routine success notices while preserving errors and duplicate warnings', () => {
    const props = renderPanel({ notice: { kind: 'status', message: '已从当前任务移除 1 个文件；原始文件未被删除或修改。' } });
    expect(screen.queryByText(/已从当前任务移除/)).toBeNull();
    props.rerender(<SourcePanel {...props} notice={{ kind: 'status', message: '所选 PDF 均已在当前任务中，未添加重复文件。' }} />);
    expect(screen.getByText(/未添加重复文件/)).toBeTruthy();
    props.rerender(<SourcePanel {...props} notice={{ kind: 'error', message: 'PDF 文件读取失败。' }} />);
    expect(screen.getByRole('alert').textContent).toContain('PDF 文件读取失败');
    props.rerender(<SourcePanel {...props} notice={{ kind: 'status', message: '本地引擎返回了无法识别的 PDF 元数据。' }} />);
    expect(screen.getByText('本地引擎返回了无法识别的 PDF 元数据。')).toBeTruthy();
  });

  it('shows a compact batch summary and matches row status by exact source path', () => {
    const firstPath = 'D:\\one\\same.pdf';
    const secondPath = 'D:\\two\\same.pdf';
    const files = [
      makeFile(1, { key: 'one', name: 'same.pdf', sourcePath: firstPath, pageCount: 4, integrityStatus: 'valid' }),
      makeFile(2, { key: 'two', name: 'same.pdf', sourcePath: secondPath, pageCount: 5, integrityStatus: 'valid' }),
    ];
    const batchFeedback: BatchFeedback = {
      runId: 7,
      phase: 'running',
      stage: 'search',
      sources: [
        { sourcePath: firstPath, name: 'same.pdf', search: 'succeeded', pages: {}, segmentCount: null },
        { sourcePath: secondPath, name: 'same.pdf', search: 'waiting', pages: {}, segmentCount: null },
      ],
      failures: [],
    };
    renderPanel({ files, activeSourcePath: firstPath, batchFeedback });

    const summary = screen.getByRole('region', { name: '本轮分析' });
    expect(summary).toBeTruthy();
    expect(within(summary).getByText(/1\s*\/\s*2/)).toBeTruthy();
    expect(summary.textContent).not.toMatch(/\d+%/);

    const firstRow = screen.getByTitle(firstPath).closest('li');
    const secondRow = screen.getByTitle(secondPath).closest('li');
    expect(firstRow).toBeTruthy();
    expect(secondRow).toBeTruthy();
    expect(within(firstRow as HTMLElement).getByText('搜索完成')).toBeTruthy();
    expect(within(secondRow as HTMLElement).getByText('等待搜索')).toBeTruthy();
    expect(within(firstRow as HTMLElement).getByText('4 页 · 文档已读取')).toBeTruthy();
    expect(within(secondRow as HTMLElement).getByText('5 页 · 文档已读取')).toBeTruthy();
  });

  it('keeps source integrity messaging while showing an in-progress batch status', () => {
    const batchFeedback = makeBatchFeedback({
      stage: 'analysis',
      sources: [
        {
          sourcePath: sourcePath(1),
          name: 'source-1.pdf',
          search: 'succeeded',
          pages: { 2: 'running' },
          segmentCount: null,
        },
      ],
    });
    renderPanel({
      files: [makeFile(1, { pageCount: 8, integrityStatus: 'changed' })],
      batchFeedback,
    });

    const row = screen.getByTitle(sourcePath(1)).closest('li');
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).getByText('源文件已变化，请重新分析')).toBeTruthy();
    expect(within(row as HTMLElement).getByText(/正在分析|已处理/)).toBeTruthy();
    expect(screen.getByRole('region', { name: '本轮分析' })).toBeTruthy();
  });
});
