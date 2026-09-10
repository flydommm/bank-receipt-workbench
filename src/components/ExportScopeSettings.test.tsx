// @vitest-environment jsdom

import userEvent from '@testing-library/user-event';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveExportScope, type ExportScopeSelection } from '../domain/exportIntent';
import ExportScopeSettings from './ExportScopeSettings';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const sources = [
  { key: 'source-a', name: '甲.pdf', segmentCount: 2 },
  { key: 'source-b', name: '乙.pdf', segmentCount: 1 },
];

function summary(overrides: Partial<ReturnType<typeof resolveExportScope>> = {}) {
  return {
    selectedSegments: [],
    selectedIds: [],
    selectedSourceKeys: [],
    totalSegments: 3,
    selectedCount: 3,
    omittedCount: 0,
    omittedUnresolvedCount: 0,
    selectedUnresolvedCount: 0,
    expectedPages: 4,
    error: null,
    ...overrides,
  } satisfies ReturnType<typeof resolveExportScope>;
}

function renderSettings(overrides: Partial<React.ComponentProps<typeof ExportScopeSettings>> = {}) {
  const onScopeChange = vi.fn<(scope: ExportScopeSelection) => void>();
  const onCaptureCurrentList = vi.fn<() => void>();
  const onOutputModeChange = vi.fn<React.ComponentProps<typeof ExportScopeSettings>['onOutputModeChange']>();
  const onIncludeXlsxChange = vi.fn<(include: boolean) => void>();
  const onGenerate = vi.fn<() => void>();
  const onCancel = vi.fn<() => void>();
  const props: React.ComponentProps<typeof ExportScopeSettings> = {
    sources,
    scope: { kind: 'all' },
    summary: summary(),
    outputMode: 'merged',
    includeXlsx: false,
    busy: false,
    taskError: null,
    currentListCount: 2,
    onScopeChange,
    onCaptureCurrentList,
    onOutputModeChange,
    onIncludeXlsxChange,
    onGenerate,
    onCancel,
    ...overrides,
  };
  const view = render(<ExportScopeSettings {...props} />);
  return { ...props, onScopeChange, onCaptureCurrentList, onOutputModeChange, onIncludeXlsxChange, onGenerate, onCancel, view };
}

describe('ExportScopeSettings', () => {
  it('exposes a labelled dialog, switches to all sources, and allows an explicit empty source subset', async () => {
    const user = userEvent.setup();
    const { onScopeChange, view } = renderSettings();

    const dialog = screen.getByRole('dialog', { name: '导出设置' });
    const title = screen.getByRole('heading', { name: '导出设置' });
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(screen.getByText('总片段')).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: '选定来源 PDF' }));
    expect(onScopeChange).toHaveBeenLastCalledWith({ kind: 'sources', sourceKeys: ['source-a', 'source-b'] });

    const sourceProps = renderSettingsProps({ scope: { kind: 'sources', sourceKeys: ['source-a', 'source-b'] } });
    view.rerender(<ExportScopeSettings {...sourceProps} />);
    await user.click(screen.getByRole('checkbox', { name: /甲\.pdf/ }));
    expect(sourceProps.onScopeChange).toHaveBeenLastCalledWith({ kind: 'sources', sourceKeys: ['source-b'] });
  });

  it('captures the current list through a callback and presents a frozen list description and count', async () => {
    const user = userEvent.setup();
    const { onCaptureCurrentList } = renderSettings({
      scope: { kind: 'list', segmentIds: ['a', 'b'], description: '当前筛选（2 项）' },
      currentListCount: 5,
    });

    expect(screen.getByText('当前筛选（2 项）')).toBeTruthy();
    expect(screen.getByText(/已捕获 2 项/)).toBeTruthy();
    expect(screen.getByText(/当前审核列表：5 项/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '将当前列表设为导出范围' }));
    expect(onCaptureCurrentList).toHaveBeenCalledOnce();
  });

  it('shows omitted unresolved items without disabling generation, while selected unresolved items disable it', () => {
    const { onGenerate, view } = renderSettings({
      summary: summary({ omittedCount: 2, omittedUnresolvedCount: 2, selectedUnresolvedCount: 0 }),
    });

    expect(screen.getByText(/范围外还有 2 项未解决/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认范围并生成预览' }) as HTMLButtonElement).disabled).toBe(false);

    view.rerender(
      <ExportScopeSettings
        {...renderSettingsProps({ summary: summary({ selectedUnresolvedCount: 1 }) })}
      />,
    );
    expect((screen.getByRole('button', { name: '确认范围并生成预览' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it.each([
    ['merged', '合并版 4 页', 'PDF 文件数 1'],
    ['by_source', '来源版合计 4 页', 'PDF 文件数 2'],
    ['both', '合并版 4 页', '来源版合计 4 页'],
  ] as const)('describes %s output pages and file counts', (mode, firstText, secondText) => {
    renderSettings({
      outputMode: mode,
      summary: summary({ selectedSourceKeys: ['source-a', 'source-b'] }),
    });

    expect(screen.getByText(new RegExp(firstText))).toBeTruthy();
    expect(screen.getByText(new RegExp(secondText))).toBeTruthy();
    if (mode === 'both') {
      expect(screen.getByText(/PDF 文件数 3/)).toBeTruthy();
      expect(screen.getByText(/物理页 8/)).toBeTruthy();
    }
  });

  it('explains page-only deduplication while keeping the selected segment count', () => {
    renderSettings({ summary: summary({ selectedCount: 4, expectedPages: 2 }) });

    expect(screen.getByText(/已合并 2 个重复输出项/)).toBeTruthy();
    expect(screen.getByText(/同一文件、同一页、范围完全相同的回单只输出一次/)).toBeTruthy();
    expect(screen.getByText(/审核记录和索引逐条保留/)).toBeTruthy();
  });

  it('keeps XLSX and all actions controlled and disables generation for errors or busy state', async () => {
    const user = userEvent.setup();
    const { onIncludeXlsxChange, view } = renderSettings({
      summary: summary(),
      taskError: '任务失败',
    });

    expect((screen.getByRole('checkbox', { name: /XLSX/ }) as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole('checkbox', { name: /XLSX/ }));
    expect(onIncludeXlsxChange).toHaveBeenLastCalledWith(true);
    expect((screen.getByRole('button', { name: '确认范围并生成预览' }) as HTMLButtonElement).disabled).toBe(true);

    const busyProps = renderSettingsProps({ busy: true });
    view.rerender(<ExportScopeSettings {...busyProps} />);
    expect((screen.getByRole('button', { name: '确认范围并生成预览' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '返回审核' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function renderSettingsProps(overrides: Partial<React.ComponentProps<typeof ExportScopeSettings>> = {}) {
  const callbacks = {
    onScopeChange: vi.fn<(scope: ExportScopeSelection) => void>(),
    onCaptureCurrentList: vi.fn<() => void>(),
    onOutputModeChange: vi.fn<React.ComponentProps<typeof ExportScopeSettings>['onOutputModeChange']>(),
    onIncludeXlsxChange: vi.fn<(include: boolean) => void>(),
    onGenerate: vi.fn<() => void>(),
    onCancel: vi.fn<() => void>(),
  };
  return {
    sources,
    scope: { kind: 'all' as const },
    summary: summary(),
    outputMode: 'merged' as const,
    includeXlsx: false,
    busy: false,
    taskError: null,
    currentListCount: 2,
    ...callbacks,
    ...overrides,
  } satisfies React.ComponentProps<typeof ExportScopeSettings>;
}
