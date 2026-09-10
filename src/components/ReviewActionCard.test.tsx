// @vitest-environment jsdom

// @ts-expect-error Bun exposes Node-compatible fs without @types/node.
import { readFileSync } from 'node:fs';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReviewActionCardProps } from './ReviewActionCard';
import { ReviewActionCard } from './ReviewActionCard';

const currentSegment = {
  sourcePage: 7,
  segmentNo: 2,
  reviewStatus: 'confirmed' as const,
};

const fragmentDisabledReason = '当前预览页无命中，请选择右侧片段继续审核';

function reviewProps(overrides: Partial<Extract<ReviewActionCardProps, { mode: 'review' }>> = {}) {
  return {
    mode: 'review' as const,
    currentSegment,
    fragmentActionsEnabled: true,
    fragmentDisabledReason,
    onKeepFullPage: vi.fn(),
    onConfirmCurrent: vi.fn(),
    canConfirmGroup: true,
    groupSavePending: false,
    groupConfirmed: false,
    unresolvedCount: 0,
    onConfirmGroup: vi.fn(),
    canGeneratePreview: false,
    previewGenerating: false,
    onGeneratePreview: vi.fn(),
    totalCount: 28,
    reviewFrozenReason: undefined,
    feedback: null,
    result: null,
    onOpenResult: vi.fn(),
    ...overrides,
  } satisfies Extract<ReviewActionCardProps, { mode: 'review' }>;
}

function exportProps(overrides: Partial<Extract<ReviewActionCardProps, { mode: 'export' }>> = {}) {
  return {
    mode: 'export' as const,
    includeXlsx: false,
    onIncludeXlsxChange: vi.fn(),
    exportPending: false,
    canExport: true,
    onReturn: vi.fn(),
    onExport: vi.fn(),
    feedback: null,
    result: null,
    onOpenResult: vi.fn(),
    ...overrides,
  } satisfies Extract<ReviewActionCardProps, { mode: 'export' }>;
}

afterEach(cleanup);

describe('ReviewActionCard', () => {
  it('offers legacy crop recovery explicitly and gates it on preview readiness', async () => {
    const user = userEvent.setup();
    const onRestoreLegacySuggestion = vi.fn();
    const props = reviewProps({ hasLegacySuggestion: true, onRestoreLegacySuggestion });
    const view = render(<ReviewActionCard {...props} fragmentActionsEnabled={false} />);
    const restore = screen.getByRole('button', { name: '恢复历史裁剪建议' });
    expect((restore as HTMLButtonElement).disabled).toBe(true);
    await user.click(restore);
    expect(onRestoreLegacySuggestion).not.toHaveBeenCalled();
    view.rerender(<ReviewActionCard {...props} />);
    await user.click(screen.getByRole('button', { name: '恢复历史裁剪建议' }));
    expect(onRestoreLegacySuggestion).toHaveBeenCalledTimes(1);
    expect(screen.getByText('旧版本裁剪记录可供参考，恢复后需重新确认。')).toBeTruthy();
    view.rerender(<ReviewActionCard {...props} reviewFrozenReason="正在重新分析" />);
    expect((screen.getByRole('button', { name: '恢复历史裁剪建议' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows only review actions before group confirmation', () => {
    render(<ReviewActionCard {...reviewProps({ groupConfirmed: false })} />);
    const card = screen.getByRole('region', { name: '当前审核操作' });
    expect(card.getAttribute('data-phase')).toBe('review');
    expect(screen.getByRole('button', { name: '保留整页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认当前片段' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认整组' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();
  });

  it('replaces review actions with preview generation after confirmation', () => {
    render(<ReviewActionCard {...reviewProps({ groupConfirmed: true, totalCount: 28 })} />);
    expect(screen.getByText('已确认 28 / 28')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认整组' })).toBeNull();
    expect(screen.getByRole('button', { name: /生成 PDF 导出预览/ })).toBeTruthy();
  });

  it('shows only final-preview export actions and keeps XLSX opt-in unchecked', () => {
    render(<ReviewActionCard {...exportProps({ includeXlsx: false })} />);
    expect(screen.getByRole('button', { name: '返回调整' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择目录并导出 PDF' })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: '同时导出审核索引 XLSX（可选）' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole('button', { name: '保留整页' })).toBeNull();
    expect(screen.queryByRole('button', { name: '确认整组' })).toBeNull();
    expect(screen.queryByRole('button', { name: /生成 PDF 导出预览/ })).toBeNull();
  });

  it('describes a frozen review and disables every mutation action', () => {
    render(<ReviewActionCard {...reviewProps({ reviewFrozenReason: '修改完成前暂停审核' })} />);
    expect(screen.getByText('修改完成前暂停审核')).toBeTruthy();
    for (const name of ['保留整页', '确认当前片段', '确认整组']) {
      const button = screen.getByRole('button', { name });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(button.getAttribute('aria-describedby')).toBe('review-action-card-frozen-reason');
    }
    expect(screen.getAllByRole('status').some((node) => node.textContent?.includes('修改完成前暂停审核'))).toBe(true);
  });

  it('shows the active disabled reason inside expanded details', async () => {
    const user = userEvent.setup();
    render(<ReviewActionCard {...reviewProps({ groupConfirmed: true, canGeneratePreview: false })} />);
    const preview = screen.getByRole('button', { name: '生成 PDF 导出预览' });
    expect((preview as HTMLButtonElement).disabled).toBe(true);
    expect(preview.getAttribute('aria-describedby')).toBe('review-action-card-preview-disabled-reason');

    await user.click(screen.getByRole('button', { name: '查看详情' }));
    expect(screen.getByText('预览操作：整组确认和页面校验完成后才能生成 PDF 导出预览')).toBeTruthy();
  });

  it('keeps ordinary status details closed and auto-opens a new review error', async () => {
    const { rerender } = render(<ReviewActionCard {...reviewProps({ feedback: { kind: 'status', message: '保存完成' } })} />);
    expect((screen.getByTestId('review-action-card-details') as HTMLDivElement).hidden).toBe(true);
    expect(screen.getByText('状态：保存完成', { selector: '.review-action-card-feedback-compact' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看详情' })).toBeTruthy();

    rerender(<ReviewActionCard {...reviewProps({ feedback: { kind: 'error', message: '保存失败' } })} />);
    expect(await screen.findByRole('button', { name: '收起详情' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('保存失败');
  });

  it('auto-opens an export error, keeps export retry enabled, and calls it', async () => {
    const user = userEvent.setup();
    const props = exportProps({ feedback: { kind: 'error', message: '导出失败' }, canExport: true });
    render(<ReviewActionCard {...props} />);
    expect(await screen.findByRole('button', { name: '收起详情' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('导出失败');
    const retry = screen.getByRole('button', { name: '选择目录并导出 PDF' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    await user.click(retry);
    expect(props.onExport).toHaveBeenCalledOnce();
  });

  it('keeps confirmation and calls the enabled preview retry after preview failure', async () => {
    const user = userEvent.setup();
    const props = reviewProps({
      groupConfirmed: true,
      canGeneratePreview: true,
      feedback: { kind: 'error', message: '预览生成失败' },
    });
    render(<ReviewActionCard {...props} />);
    expect(await screen.findByRole('button', { name: '收起详情' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('预览生成失败');
    expect(screen.getByText('已确认 28 / 28')).toBeTruthy();
    const retry = screen.getByRole('button', { name: '生成 PDF 导出预览' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    await user.click(retry);
    expect(props.onGeneratePreview).toHaveBeenCalledOnce();
  });

  it('collapses an old error into one compact visible success status', async () => {
    const { rerender } = render(<ReviewActionCard {...exportProps({ feedback: { kind: 'error', message: '导出失败' } })} />);
    expect(await screen.findByRole('button', { name: '收起详情' })).toBeTruthy();

    rerender(<ReviewActionCard {...exportProps({ feedback: { kind: 'status', message: '导出成功' } })} />);
    expect(screen.getByRole('button', { name: '查看详情' })).toBeTruthy();
    expect((screen.getByTestId('review-action-card-details') as HTMLDivElement).hidden).toBe(true);
    const compact = screen.getByText('状态：导出成功', { selector: '.review-action-card-feedback-compact' });
    expect(compact).toBeTruthy();
    expect(screen.getByRole('status')).toBe(compact);
    expect(screen.queryAllByText(/导出成功/)).toHaveLength(1);
  });

  it('returns focus to the details trigger when details close', async () => {
    const user = userEvent.setup();
    render(<ReviewActionCard {...reviewProps()} />);
    await user.click(screen.getByRole('button', { name: '查看详情' }));
    const close = screen.getByRole('button', { name: '收起详情' });
    expect(close.getAttribute('aria-expanded')).toBe('true');
    expect(close.getAttribute('aria-controls')).toBe('review-action-card-details');
    await user.click(close);
    const reopen = screen.getByRole('button', { name: '查看详情' });
    expect(reopen.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(reopen);
  });

  it('moves focus to preview generation when confirmation changes the phase', async () => {
    const { rerender } = render(<ReviewActionCard {...reviewProps({ groupConfirmed: false })} />);
    rerender(<ReviewActionCard {...reviewProps({ groupConfirmed: true, canGeneratePreview: true })} />);
    const previewAction = screen.getByRole('button', { name: /生成 PDF 导出预览/ });
    await waitFor(() => expect(document.activeElement).toBe(previewAction));
    expect(screen.getByRole('button', { name: '查看详情' })).toBeTruthy();
  });

  it('focuses the confirmed primary action when returning from export mode', async () => {
    const { rerender } = render(<ReviewActionCard {...exportProps({ canExport: true })} />);
    rerender(<ReviewActionCard {...reviewProps({ groupConfirmed: true, canGeneratePreview: true })} />);
    const previewAction = screen.getByRole('button', { name: '生成 PDF 导出预览' });
    await waitFor(() => expect(document.activeElement).toBe(previewAction));
  });

  it('focuses the confirmed status heading when the new primary action is disabled', async () => {
    const { rerender } = render(<ReviewActionCard {...reviewProps({ groupConfirmed: false })} />);
    rerender(<ReviewActionCard {...reviewProps({ groupConfirmed: true, canGeneratePreview: false })} />);
    const heading = screen.getByRole('heading', { name: '当前审核操作' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('uses a reachable fallback while export is unavailable, then focuses the enabled primary export', async () => {
    const { rerender } = render(<ReviewActionCard {...exportProps({ canExport: false })} />);
    const returnAction = screen.getByRole('button', { name: '返回调整' });
    await waitFor(() => expect(document.activeElement).toBe(returnAction));

    rerender(<ReviewActionCard {...exportProps({ canExport: true })} />);
    const exportAction = screen.getByRole('button', { name: '选择目录并导出 PDF' });
    await waitFor(() => expect(document.activeElement).toBe(exportAction));
  });

  it('moves from pending group save to an enabled confirmed preview action', () => {
    const { rerender } = render(<ReviewActionCard {...reviewProps({ groupSavePending: true })} />);
    const saving = screen.getByRole('button', { name: '保存中…' });
    expect((saving as HTMLButtonElement).disabled).toBe(true);
    expect(saving.getAttribute('aria-busy')).toBe('true');
    for (const name of ['保留整页', '确认当前片段']) {
      const fragmentAction = screen.getByRole('button', { name });
      expect((fragmentAction as HTMLButtonElement).disabled).toBe(true);
      expect(fragmentAction.getAttribute('aria-describedby')).toBe('review-action-card-fragment-disabled-reason');
    }
    expect(document.getElementById('review-action-card-fragment-disabled-reason')?.textContent).toBe('正在保存整组审核');

    rerender(<ReviewActionCard {...reviewProps({ groupSavePending: false, groupConfirmed: true, canGeneratePreview: true })} />);
    expect(screen.queryByRole('button', { name: /确认整组/ })).toBeNull();
    expect((screen.getByRole('button', { name: '生成 PDF 导出预览' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('turns an expanded export failure into compact success and keeps result details on demand', async () => {
    const user = userEvent.setup();
    const props = exportProps({ feedback: { kind: 'error', message: '导出失败：目录不可写' } });
    const view = render(<ReviewActionCard {...props} />);
    expect(screen.getByRole('alert').textContent).toContain('导出失败：目录不可写');

    view.rerender(<ReviewActionCard
      {...props}
      feedback={{ kind: 'status', message: '导出成功' }}
      result={{
        directory: 'C:\\example-output\\回单导出',
        indexPath: 'C:\\example-output\\回单导出\\审核索引.xlsx',
        pdfPath: 'C:\\example-output\\回单导出\\最终回单.pdf',
        rowCount: 0,
        pageCount: 18,
      }}
    />);
    expect((screen.getByTestId('review-action-card-details') as HTMLDivElement).hidden).toBe(true);
    expect(screen.getByText('状态：导出成功', { selector: '.review-action-card-feedback-compact' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '查看详情' }));
    expect(screen.getByText('审核索引.xlsx')).toBeTruthy();
    expect(screen.getByText('最终回单.pdf')).toBeTruthy();
    expect(screen.getByText(/18 页 PDF/)).toBeTruthy();
    expect(screen.getByText(/0 条索引/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '打开结果目录' }));
    expect(props.onOpenResult).toHaveBeenCalledOnce();
  });

  it('handles Unix result paths and omits the XLSX row for PDF-only results', () => {
    render(<ReviewActionCard {...exportProps({
      result: {
        directory: '/tmp/review-output',
        indexPath: null,
        pdfPath: '/tmp/review-output/final.pdf',
        rowCount: null,
        pageCount: 1,
      },
    })} />);

    expect(screen.getByText('final.pdf')).toBeTruthy();
    expect(screen.queryByText(/XLSX：/)).toBeNull();
    expect(screen.getByText('1 页 PDF')).toBeTruthy();
  });

  it('normalizes trailing separators and falls back when a file path is empty', () => {
    const view = render(<ReviewActionCard {...exportProps({
      result: {
        directory: '/tmp/review-output',
        indexPath: 'C:\\exports\\审核索引.xlsx\\\\',
        pdfPath: '/tmp/output///',
        rowCount: 2,
        pageCount: 3,
      },
    })} />);

    expect(screen.getByText('审核索引.xlsx')).toBeTruthy();
    expect(screen.getByText('output')).toBeTruthy();

    view.rerender(<ReviewActionCard {...exportProps({
      result: { directory: '/tmp/review-output', indexPath: null, pdfPath: '', rowCount: null, pageCount: 1 },
    })} />);
    expect(screen.getByText('未命名文件')).toBeTruthy();
  });

  it('locks return, export and options while export is pending', async () => {
    const user = userEvent.setup();
    const props = exportProps({ includeXlsx: true, exportPending: true });
    render(<ReviewActionCard {...props} />);

    const returnButton = screen.getByRole('button', { name: '返回调整' }) as HTMLButtonElement;
    const checkbox = screen.getByRole('checkbox', { name: '同时导出审核索引 XLSX（可选）' }) as HTMLInputElement;
    const exportButton = screen.getByRole('button', { name: '正在导出 XLSX 与 PDF…' }) as HTMLButtonElement;
    expect(returnButton.disabled).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(exportButton.disabled).toBe(true);
    expect(exportButton.getAttribute('aria-busy')).toBe('true');

    await user.click(returnButton);
    await user.click(checkbox);
    await user.click(exportButton);
    expect(props.onReturn).not.toHaveBeenCalled();
    expect(props.onIncludeXlsxChange).not.toHaveBeenCalled();
    expect(props.onExport).not.toHaveBeenCalled();
  });

  it('resets XLSX opt-in and preserves mode-specific controls', async () => {
    const user = userEvent.setup();
    const props = exportProps();
    const view = render(<ReviewActionCard {...props} />);
    const checkbox = screen.getByRole('checkbox', { name: '同时导出审核索引 XLSX（可选）' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await user.click(checkbox);
    expect(props.onIncludeXlsxChange).toHaveBeenCalledWith(true);
    view.rerender(<ReviewActionCard {...props} includeXlsx />);
    expect((screen.getByRole('checkbox', { name: '同时导出审核索引 XLSX（可选）' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: '选择目录并导出 XLSX 与 PDF' })).toBeTruthy();
  });

  it('reserves real dock height and keeps expanded details internally scrollable', () => {
    const styles = readFileSync('src/styles.css', 'utf8');
    expect(styles).toMatch(/\.preview-action-dock\s*\{[^}]*flex:\s*0 0 auto;[^}]*border-top:/s);
    expect(styles).toMatch(/\.review-action-card-main\s*\{[^}]*min-height:\s*64px;/s);
    expect(styles).toMatch(/\.review-action-card-main\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(styles).toMatch(/\.review-action-card-actions\s*\{[^}]*white-space:\s*nowrap;/s);
    expect(styles).toMatch(/\.preview-action-dock \.review-action-card-preview-button,[\s\S]*\.preview-action-dock \.review-action-card-export-button\s*\{[^}]*width:\s*auto;[^}]*flex:\s*0 1 auto;/s);
    expect(styles).toMatch(/\.review-action-card-feedback-compact\s*\{[^}]*display:\s*block;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    expect(styles).toMatch(/\.review-action-card-details\s*\{[^}]*max-height:\s*min\(32vh,\s*280px\);[^}]*overflow-y:\s*auto;/s);
    expect(styles).toMatch(/@container preview-column \(max-width:\s*759px\)[\s\S]*\.review-action-card-main\s*\{[^}]*display:\s*grid;[^}]*max-height:\s*96px;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\) auto;/);
    expect(styles).toMatch(/@container preview-column \(max-width:\s*759px\)[\s\S]*\.review-action-card-context\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;[^}]*white-space:\s*nowrap;/);
    expect(styles).toMatch(/@media \(max-height:\s*720px\)[\s\S]*\.search-summary\s*\{[^}]*min-height:\s*64px;[\s\S]*\.review-action-card-main\s*\{[^}]*min-height:\s*56px;/);
  });
});
