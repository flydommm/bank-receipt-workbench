// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  render(<SourcePanel {...props} />);
  return props;
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

  it('keeps removal scope and read-only protection visible', () => {
    renderPanel({ files: [] });

    expect(screen.getByText('仅从当前任务移除，不删除原文件')).toBeTruthy();
    expect(screen.getByText('原始文件只读保护已开启')).toBeTruthy();
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
