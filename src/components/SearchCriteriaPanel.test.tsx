// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Bun exposes Node-compatible fs without @types/node.
import { readFileSync } from 'node:fs';
import type { BatchFeedback } from '../domain/batchFeedback';
import type { SearchCriteria } from '../domain/searchCriteria';
import { SearchCriteriaPanel } from './SearchCriteriaPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const draft: SearchCriteria = {
  include: ['示例实业', '宁波银行'],
  includeMode: 'all',
  exclude: [],
};

const baseProps = {
  draft,
  draftMode: 'exact' as const,
  appliedSummary: null,
  appliedMode: null,
  hitCount: 0,
  canAnalyze: true,
  analyzeUnavailableReason: undefined,
  expanded: true,
  running: false,
  disabled: false,
  disabledReason: undefined,
  feedback: null,
  onBeginEdit: vi.fn(),
  onCancelEdit: vi.fn(),
  onDraftChange: vi.fn(),
  onDraftModeChange: vi.fn(),
  onAnalyze: vi.fn(),
};

function makeBatchFailureFeedback(): BatchFeedback {
  return {
    runId: 9,
    phase: 'failed',
    stage: 'finalizing',
    sources: [
      {
        sourcePath: 'D:/one/same.pdf',
        name: 'same.pdf',
        search: 'failed',
        pages: {},
        segmentCount: null,
      },
      {
        sourcePath: 'D:/two/same.pdf',
        name: 'same.pdf',
        search: 'succeeded',
        pages: { 3: 'failed' },
        segmentCount: null,
      },
    ],
    failures: [
      {
        sourcePath: 'D:/one/same.pdf',
        page: null,
        stage: 'search',
        code: 'SEARCH_FAILED',
        message: '文件搜索失败',
        detail: 'search technical detail',
      },
      {
        sourcePath: 'D:/two/same.pdf',
        page: 3,
        stage: 'analysis',
        code: 'PAGE_ANALYSIS_FAILED',
        message: '第 3 页边界分析失败',
        detail: '<img src="x" onerror="alert(1)"> analysis technical detail',
      },
      {
        sourcePath: null,
        page: null,
        stage: 'finalizing',
        code: null,
        message: '整理审核结果失败',
        detail: 'finalizing technical detail',
      },
    ],
  };
}

describe('SearchCriteriaPanel', () => {
  it('shows a first-run editor with one clear primary action', () => {
    render(<SearchCriteriaPanel {...baseProps} />);
    expect(screen.getByRole('heading', { name: '搜索条件' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始分析' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '取消修改' })).toBeNull();
  });

  it('offers keyword history next to the input without a named-save workflow', async () => {
    const user = userEvent.setup();
    const onRemoveKeywordHistory = vi.fn();
    const onClearKeywordHistory = vi.fn();
    render(<SearchCriteriaPanel
      {...baseProps}
      keywordHistory={{ include: ['手续费'], exclude: [] }}
      onRemoveKeywordHistory={onRemoveKeywordHistory}
      onClearKeywordHistory={onClearKeywordHistory}
    />);
    expect(screen.queryByRole('button', { name: '保存条件' })).toBeNull();
    await user.click(screen.getByRole('textbox', { name: '包含关键词 1' }));
    await user.click(screen.getByRole('button', { name: '使用历史关键词 手续费' }));
    expect(baseProps.onDraftChange).toHaveBeenCalledWith({ ...draft, include: ['手续费', '宁波银行'] });
    expect(baseProps.onAnalyze).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '包含关键词 1的历史记录' }));
    await user.click(screen.getByRole('button', { name: '删除历史关键词 手续费' }));
    expect(onRemoveKeywordHistory).toHaveBeenCalledWith('include', '手续费');
    await user.click(screen.getByRole('button', { name: '清空历史' }));
    expect(onClearKeywordHistory).toHaveBeenCalledWith('include');
  });

  it('disables all history actions when an open history becomes locked', async () => {
    const user = userEvent.setup();
    const onRemoveKeywordHistory = vi.fn();
    const onClearKeywordHistory = vi.fn();
    const historyProps = {
      keywordHistory: { include: ['手续费'], exclude: [] },
      onRemoveKeywordHistory,
      onClearKeywordHistory,
    };
    const { rerender } = render(<SearchCriteriaPanel {...baseProps} {...historyProps} />);
    await user.click(screen.getByRole('textbox', { name: '包含关键词 1' }));
    expect(screen.getByRole('button', { name: '使用历史关键词 手续费' })).toBeTruthy();
    rerender(<SearchCriteriaPanel
      {...baseProps}
      {...historyProps}
      running
    />);
    expect((screen.getByRole('button', { name: '包含关键词 1的历史记录' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '使用历史关键词 手续费' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '包含关键词 1的历史记录' }));
    expect(onRemoveKeywordHistory).not.toHaveBeenCalled();
    expect(onClearKeywordHistory).not.toHaveBeenCalled();
  });

  it('collapses a successful search into one summary and one modify action', () => {
    render(<SearchCriteriaPanel
      {...baseProps}
      expanded={false}
      appliedSummary="包含全部：示例实业、宁波银行"
      appliedMode="exact"
      hitCount={28}
    />);
    expect(screen.getByText('包含全部：示例实业、宁波银行')).toBeTruthy();
    expect(screen.getByText('精确匹配 · 28 个命中')).toBeTruthy();
    expect(screen.getByRole('button', { name: '修改搜索条件' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('offers apply and cancel while editing an applied search', () => {
    render(<SearchCriteriaPanel
      {...baseProps}
      appliedSummary="包含全部：手续费"
      appliedMode="exact"
    />);
    expect(screen.getByRole('button', { name: '应用并重新分析' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消修改' })).toBeTruthy();
  });

  it('opens a rerun error and changes cancel into recovery', async () => {
    const user = userEvent.setup();
    const onAnalyze = vi.fn();
    render(<SearchCriteriaPanel
      {...baseProps}
      appliedSummary="包含全部：手续费"
      appliedMode="exact"
      feedback={{ kind: 'error', message: '本地搜索失败：测试错误' }}
      onAnalyze={onAnalyze}
    />);

    expect(screen.getByRole('button', { name: '恢复上次条件' })).toBeTruthy();
    const summary = screen.getByText('错误：本地搜索失败：测试错误', { selector: '.search-criteria-feedback-summary' });
    expect(summary).toBeTruthy();
    expect(summary.getAttribute('role')).toBe('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    const details = screen.getByTestId('search-criteria-feedback-details');
    expect(details.getAttribute('role')).toBeNull();
    const retry = screen.getByRole('button', { name: '重新分析整批' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    await user.click(retry);
    expect(onAnalyze).toHaveBeenCalledOnce();
    const close = await screen.findByRole('button', { name: '收起详情' });
    expect(close.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('本地搜索失败：测试错误');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    await user.click(close);
    const open = screen.getByRole('button', { name: '查看详情' });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(summary.getAttribute('role')).toBe('alert');
    expect(details.getAttribute('role')).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    await user.click(open);
    expect(screen.getByRole('button', { name: '收起详情' })).toBeTruthy();
    expect(summary.getAttribute('role')).toBe('alert');
    expect(details.getAttribute('role')).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('keeps expanded error feedback in the scrollable body while actions stay fixed', async () => {
    render(<SearchCriteriaPanel
      {...baseProps}
      feedback={{ kind: 'error', message: '受限高度下仍可查看的错误详情' }}
    />);

    const details = await screen.findByTestId('search-criteria-feedback-details');
    const body = details.closest('.search-criteria-panel-body');
    expect(body).toBeTruthy();
    expect((body as HTMLDivElement).contains(details)).toBe(true);
    expect(screen.getByRole('button', { name: '重新分析整批' })).toBeTruthy();

    const styles = readFileSync('src/styles.css', 'utf8');
    expect(styles).toMatch(/\.search-criteria-panel-body\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;/s);
    expect(styles).toMatch(/\.search-criteria-panel-actions\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(styles).toMatch(/\.search-criteria-feedback\s*\{[^}]*min-height:\s*0;/s);
    expect(styles).toMatch(/\.search-criteria-feedback\s*>\s*\[id='search-criteria-feedback-details'\]\s*\{[^}]*max-height:\s*120px;[^}]*overflow-y:\s*auto;/s);
  });

  it('labels a failed first analysis as a retry even without prior applied results', () => {
    render(<SearchCriteriaPanel
      {...baseProps}
      appliedSummary={null}
      feedback={{ kind: 'error', message: '首次分析失败' }}
    />);

    expect(screen.getByRole('button', { name: '重新分析整批' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '恢复上次条件' })).toBeNull();
    expect(screen.queryByRole('button', { name: '取消修改' })).toBeNull();
  });

  it('collapses error details when running or success feedback replaces the error', async () => {
    const { rerender } = render(<SearchCriteriaPanel
      {...baseProps}
      feedback={{ kind: 'error', message: '本地搜索失败：测试错误' }}
    />);
    expect(await screen.findByRole('button', { name: '收起详情' })).toBeTruthy();

    rerender(<SearchCriteriaPanel
      {...baseProps}
      feedback={{ kind: 'status', message: '正在重新分析…' }}
    />);
    expect(screen.getByRole('button', { name: '查看详情' })).toBeTruthy();
    const details = screen.getByTestId('search-criteria-feedback-details') as HTMLDivElement;
    expect(details.hidden).toBe(true);
    expect(details.getAttribute('role')).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain('正在重新分析…');
  });

  it('collapses unchanged error details when running starts', async () => {
    const { rerender } = render(<SearchCriteriaPanel
      {...baseProps}
      feedback={{ kind: 'error', message: '本地搜索失败：测试错误' }}
    />);
    expect(await screen.findByRole('button', { name: '收起详情' })).toBeTruthy();

    rerender(<SearchCriteriaPanel
      {...baseProps}
      running
      feedback={{ kind: 'error', message: '本地搜索失败：测试错误' }}
    />);
    expect(screen.getByRole('button', { name: '查看详情' }).getAttribute('aria-expanded')).toBe('false');
    expect((screen.getByTestId('search-criteria-feedback-details') as HTMLDivElement).hidden).toBe(true);
  });

  it('focuses the first include keyword when expanding a collapsed applied search', () => {
    const { rerender } = render(<SearchCriteriaPanel
      {...baseProps}
      expanded={false}
      appliedSummary="包含全部：手续费"
      appliedMode="exact"
    />);
    const modify = screen.getByRole('button', { name: '修改搜索条件' });
    modify.focus();
    expect(document.activeElement).toBe(modify);

    rerender(<SearchCriteriaPanel {...baseProps} />);

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '包含关键词 1' }));
  });

  it('keeps focus on the edited keyword when an otherwise valid draft becomes invalid', () => {
    const { rerender } = render(<SearchCriteriaPanel {...baseProps} />);
    const secondInput = screen.getByRole('textbox', { name: '包含关键词 2' });
    secondInput.focus();

    rerender(<SearchCriteriaPanel
      {...baseProps}
      draft={{ include: ['  ', '  '], includeMode: 'all', exclude: [] }}
    />);

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '包含关键词 2' }));
  });

  it('restores focus to the modify action when an expanded search is collapsed', () => {
    const { rerender } = render(<SearchCriteriaPanel {...baseProps} />);
    const input = screen.getByRole('textbox', { name: '包含关键词 1' });
    input.focus();

    rerender(<SearchCriteriaPanel
      {...baseProps}
      expanded={false}
      appliedSummary="包含全部：手续费"
      appliedMode="exact"
    />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: '修改搜索条件' }));
  });

  it('submits once from a text input and ignores an IME keydown', () => {
    const onAnalyze = vi.fn();
    render(<SearchCriteriaPanel {...baseProps} onAnalyze={onAnalyze} />);
    const input = screen.getByRole('textbox', { name: '包含关键词 1' });

    const composingEnter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      isComposing: true,
    });
    input.dispatchEvent(composingEnter);
    expect(composingEnter.defaultPrevented).toBe(true);
    expect(onAnalyze).not.toHaveBeenCalled();
    fireEvent.submit(input.closest('form')!);
    expect(onAnalyze).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole('button', { name: '添加包含关键词' }), { key: 'Enter' });
    expect(onAnalyze).toHaveBeenCalledOnce();
  });

  it('disables an invalid or unavailable analysis without locking draft editing', () => {
    const { rerender } = render(<SearchCriteriaPanel
      {...baseProps}
      draft={{ include: ['  '], includeMode: 'all', exclude: [] }}
    />);
    expect((screen.getByRole('button', { name: '开始分析' }) as HTMLButtonElement).disabled).toBe(true);
    const invalidInput = screen.getByRole('textbox', { name: '包含关键词 1' });
    expect(document.activeElement).toBe(invalidInput);

    rerender(<SearchCriteriaPanel
      {...baseProps}
      canAnalyze={false}
      analyzeUnavailableReason="请先选择 PDF 或文件夹"
    />);
    expect((screen.getByRole('textbox', { name: '包含关键词 1' }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '开始分析' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('请先选择 PDF 或文件夹')).toBeTruthy();
  });

  it('locks every search control while running', () => {
    render(<SearchCriteriaPanel {...baseProps} running />);
    expect((screen.getByRole('textbox', { name: '包含关键词 1' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '正在分析…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '正在分析…' }).getAttribute('aria-busy')).toBe('true');
  });

  it('locks the collapsed modify action with an accessible reason', () => {
    render(<SearchCriteriaPanel
      {...baseProps}
      expanded={false}
      appliedSummary="包含全部：手续费"
      appliedMode="exact"
      disabled
      disabledReason="请先返回调整，再修改搜索条件"
    />);
    const modify = screen.getByRole('button', { name: '修改搜索条件' });
    expect((modify as HTMLButtonElement).disabled).toBe(true);
    expect(modify.getAttribute('aria-describedby')).toBe('search-modification-disabled-reason');
    expect(screen.getByText('请先返回调整，再修改搜索条件')).toBeTruthy();
  });

  it('bounds the expanded editor and gives its body the only search scrollbar', () => {
    const styles = readFileSync('src/styles.css', 'utf8');
    expect(styles).toMatch(/\.search-criteria-panel-host\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*0;[^}]*max-height:\s*min\(36%,\s*360px\);[^}]*flex:\s*0 0 auto;[^}]*overflow:\s*hidden;/s);
    expect(styles).not.toMatch(/\.search-criteria-panel\s*\{[^}]*max-height:\s*min\(36%,\s*360px\);/s);
    expect(styles).toMatch(/\.search-criteria-panel\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;[^}]*flex-direction:\s*column;/s);
    expect(styles).toMatch(/\.search-criteria-panel\s+h2\s*\{[^}]*flex:\s*0 0 auto;[^}]*margin:\s*0;[^}]*padding:[^;]+;[^}]*font-size:\s*16px;[^}]*line-height:\s*1\.3;/s);
    expect(styles).toMatch(/\.search-criteria-panel\s*>\s*form\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;/s);
    expect(styles).toMatch(/\.search-criteria-panel-body\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;/s);
    expect(styles).toMatch(/\.search-criteria-feedback\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/s);
    expect(styles).toMatch(/\.search-criteria-feedback-summary\s*\{[^}]*display:\s*block;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    expect(styles).toMatch(/\.search-match-mode\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/s);
    expect(styles).toMatch(/\.search-criteria-panel-actions\s*\{[^}]*display:\s*flex;[^}]*flex:\s*0 0 auto;[^}]*justify-content:\s*flex-end;/s);
  });

  it('uses the panel visual hierarchy for match mode and unavailable guidance', () => {
    const styles = readFileSync('src/styles.css', 'utf8');
    expect(styles).toMatch(/\.search-match-mode legend\s*\{[^}]*flex:\s*0 0 auto;[^}]*padding:\s*0;[^}]*color:\s*#375267;[^}]*font-size:\s*11px;[^}]*font-weight:\s*600;[^}]*line-height:\s*1\.35;/s);
    expect(styles).toMatch(/\.search-match-mode label\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*gap:\s*4px;[^}]*color:\s*#657d91;[^}]*font-size:\s*12px;[^}]*line-height:\s*1\.35;[^}]*white-space:\s*nowrap;/s);
    expect(styles).toMatch(/\.search-match-mode input\s*\{[^}]*margin:\s*0;[^}]*accent-color:\s*#3f8b7b;/s);
    expect(styles).toMatch(/#search-analysis-unavailable-reason\s*\{[^}]*display:\s*block;[^}]*margin:\s*0 14px 8px;[^}]*color:\s*#7890a1;[^}]*font-size:\s*10px;[^}]*line-height:\s*1\.5;/s);
  });

  it('renders ordered batch failure details with source paths, known pages, and escaped technical text', async () => {
    const user = userEvent.setup();
    const batchFeedback = makeBatchFailureFeedback();
    render(<SearchCriteriaPanel
      {...baseProps}
      appliedSummary="包含全部：手续费"
      appliedMode="exact"
      feedback={{ kind: 'error', message: '本地搜索失败：批次总体错误' }}
      batchFeedback={batchFeedback}
    />);

    const details = await screen.findByTestId('search-criteria-feedback-details');
    const failures = within(details).getByRole('list', { name: '上一轮分析失败明细' });
    const items = within(failures).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain('文件搜索');
    expect(items[0]?.textContent).toContain('same.pdf');
    expect(items[0]?.textContent).toContain('D:/one/same.pdf');
    expect(items[0]?.textContent).toContain('文件搜索失败');
    expect(items[0]?.textContent).not.toMatch(/第\s*\d+\s*页/);
    expect(items[1]?.textContent).toContain('回单边界分析');
    expect(items[1]?.textContent).toContain('D:/two/same.pdf');
    expect(items[1]?.textContent).toContain('第 3 页');
    expect(items[1]?.textContent).toContain('第 3 页边界分析失败');
    expect(items[2]?.textContent).toContain('整批任务');
    expect(items[2]?.textContent).toContain('整理审核结果');
    expect(within(details).getByText('本地搜索失败：批次总体错误')).toBeTruthy();
    expect(within(details).getByText('上一轮分析')).toBeTruthy();

    const technical = items[1]?.querySelector('details') as HTMLDetailsElement | null;
    expect(technical).toBeTruthy();
    expect(technical?.open).toBe(false);
    const technicalToggle = technical?.querySelector('summary');
    expect(technicalToggle?.textContent).toContain('技术详情');
    await user.click(technicalToggle as HTMLElement);
    expect(technical?.open).toBe(true);
    expect(within(items[1] as HTMLElement).getByText('<img src="x" onerror="alert(1)"> analysis technical detail')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('retries the whole batch from the current editor and disables the action while running', async () => {
    const user = userEvent.setup();
    const onAnalyze = vi.fn();
    const batchFeedback = makeBatchFailureFeedback();
    const { rerender } = render(<SearchCriteriaPanel
      {...baseProps}
      onAnalyze={onAnalyze}
      feedback={{ kind: 'error', message: '本地搜索失败：批次总体错误' }}
      batchFeedback={batchFeedback}
    />);

    expect(screen.getByText('按当前条件重新处理全部来源')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新分析整批' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '重新分析整批' }));
    expect(onAnalyze).toHaveBeenCalledOnce();

    rerender(<SearchCriteriaPanel
      {...baseProps}
      onAnalyze={onAnalyze}
      running
      feedback={{ kind: 'status', message: '正在重新分析…' }}
      batchFeedback={{ ...batchFeedback, phase: 'running', stage: 'search', failures: [] }}
    />);
    const runningButton = screen.getByRole('button', { name: '正在分析…' }) as HTMLButtonElement;
    expect(runningButton.disabled).toBe(true);
    expect(runningButton.getAttribute('aria-busy')).toBe('true');
  });

  it('offers a primary failed-source retry beside the secondary whole-batch submit', async () => {
    const user = userEvent.setup();
    const onAnalyze = vi.fn();
    const onRetryFailed = vi.fn();
    render(<SearchCriteriaPanel
      {...baseProps}
      onAnalyze={onAnalyze}
      onRetryFailed={onRetryFailed}
      retryFailedCount={2}
      retryNotice="失败来源仅暂存于本次会话，超过缓存上限时会改为整批分析。"
      feedback={{ kind: 'error', message: '本地搜索失败：批次总体错误' }}
    />);

    const retry = screen.getByRole('button', { name: '重试失败文件（2）' }) as HTMLButtonElement;
    const wholeBatch = screen.getByRole('button', { name: '重新分析整批' }) as HTMLButtonElement;
    expect(retry.type).toBe('button');
    expect(retry.className).toContain('primary-button');
    expect(wholeBatch.type).toBe('submit');
    expect(wholeBatch.className).toContain('ghost-button');
    expect(screen.getByText('失败来源仅暂存于本次会话，超过缓存上限时会改为整批分析。')).toBeTruthy();
    expect(screen.getByText(/重试失败文件（2）.*重新分析整批/)).toBeTruthy();

    await user.click(retry);
    expect(onRetryFailed).toHaveBeenCalledOnce();
    expect(onAnalyze).not.toHaveBeenCalled();
    await user.click(wholeBatch);
    expect(onAnalyze).toHaveBeenCalledOnce();
  });

  it('hides failed-source retry without valid eligibility and guards it while disabled', async () => {
    const user = userEvent.setup();
    const onRetryFailed = vi.fn();
    const { rerender } = render(<SearchCriteriaPanel
      {...baseProps}
      onRetryFailed={onRetryFailed}
      retryFailedCount={0}
      feedback={{ kind: 'error', message: '没有可重试来源' }}
    />);
    expect(screen.queryByRole('button', { name: '重试失败文件（0）' })).toBeNull();
    expect(screen.getByRole('button', { name: '重新分析整批' }).className).toContain('primary-button');

    rerender(<SearchCriteriaPanel
      {...baseProps}
      onRetryFailed={onRetryFailed}
      retryFailedCount={2}
      running
      feedback={{ kind: 'error', message: '运行中' }}
    />);
    const runningRetry = screen.getByRole('button', { name: '重试失败文件（2）' }) as HTMLButtonElement;
    expect(runningRetry.disabled).toBe(true);
    fireEvent.click(runningRetry);
    expect(onRetryFailed).not.toHaveBeenCalled();

    rerender(<SearchCriteriaPanel
      {...baseProps}
      onRetryFailed={onRetryFailed}
      retryFailedCount={2}
      disabled
      feedback={{ kind: 'error', message: '工作区锁定' }}
    />);
    const disabledRetry = screen.getByRole('button', { name: '重试失败文件（2）' }) as HTMLButtonElement;
    expect(disabledRetry.disabled).toBe(true);
    fireEvent.click(disabledRetry);
    expect(onRetryFailed).not.toHaveBeenCalled();

    rerender(<SearchCriteriaPanel
      {...baseProps}
      onRetryFailed={onRetryFailed}
      retryFailedCount={2}
      draft={{ include: ['  '], includeMode: 'all', exclude: [] }}
      feedback={{ kind: 'error', message: '条件无效' }}
    />);
    const invalidRetry = screen.getByRole('button', { name: '重试失败文件（2）' }) as HTMLButtonElement;
    expect(invalidRetry.disabled).toBe(true);
    fireEvent.click(invalidRetry);
    expect(onRetryFailed).not.toHaveBeenCalled();

    expect(screen.getByText(/重试失败文件（2）只处理上一轮失败文件；重新分析整批会从当前条件重新处理所有来源/)).toBeTruthy();
  });

  it('keeps retry actions readable in a narrow panel without increasing the action text size', () => {
    const styles = readFileSync('src/styles.css', 'utf8');
    expect(styles).toMatch(/\.search-criteria-panel-actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(styles).toMatch(/\.search-criteria-retry-note\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*font-size:\s*10px;/s);
  });
});
