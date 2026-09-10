// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BatchJobSnapshot,
  BatchJobSummary,
  BatchSourceSnapshot,
} from '../domain/batchTask';
import { describeTaskFailure, TaskHistoryPanel, type TaskHistoryPanelProps } from './TaskHistoryPanel';

const budget = {
  processed_pages: 0,
  text_characters: 0,
  fuzzy_work: 0,
  matches: 0,
  matched_text_characters: 0,
};

const pageSummary = {
  pending: 1,
  processing: 0,
  succeeded: 3,
  failed: 1,
};

function source(overrides: Partial<BatchSourceSnapshot> = {}): BatchSourceSnapshot {
  return {
    source_id: 'source-1',
    position: 0,
    source_key: 'source-key-1',
    initial_path: 'C:\\docs\\report.pdf',
    access_path: 'C:\\docs\\report.pdf',
    name: 'report.pdf',
    sha256: 'a'.repeat(64),
    size_bytes: 2048,
    page_count: 5,
    state: 'verified',
    error: null,
    budget,
    verified_generation: 1,
    page_summary: pageSummary,
    ...overrides,
  };
}

function snapshot(overrides: Partial<BatchJobSnapshot> = {}): BatchJobSnapshot {
  return {
    id: 'job-1',
    name: '合同检索 · 2026-09-08',
    generation: 1,
    state: 'ready_for_review',
    resume_target: null,
    criteria: {
      include: ['付款', '违约责任'],
      includeMode: 'all',
      exclude: ['草稿'],
    },
    criteria_fingerprint: 'criteria-fingerprint',
    match_mode: 'exact',
    computation_version: 'batch-v2',
    result_revision: 'result-1',
    owner: null,
    error: null,
    created_at: '2026-09-08T09:00:00.000Z',
    updated_at: '2026-09-08T10:30:00.000Z',
    deletion_pending: false,
    page_summary: pageSummary,
    total_pages: 5,
    sources: [source()],
    ...overrides,
  };
}

function summary(job: BatchJobSnapshot = snapshot()): BatchJobSummary {
  return {
    ...job,
    source_summary: {
      total: job.sources.length,
      pending: 0,
      registered: 0,
      verified: job.sources.length,
      failed: 0,
      blocked: 0,
      declared_pages: job.total_pages,
    },
  };
}

function callbacks() {
  return {
    onClose: vi.fn(),
    onRefresh: vi.fn(),
    onLoadMore: vi.fn(),
    onSelect: vi.fn(),
    onResume: vi.fn(),
    onPause: vi.fn(),
    onCancel: vi.fn(),
    onArchive: vi.fn(),
    onLoadReview: vi.fn(),
    onRelocate: vi.fn(),
  } satisfies Pick<
    TaskHistoryPanelProps,
    | 'onClose'
    | 'onRefresh'
    | 'onLoadMore'
    | 'onSelect'
    | 'onResume'
    | 'onPause'
    | 'onCancel'
    | 'onArchive'
    | 'onLoadReview'
    | 'onRelocate'
  >;
}

function props(overrides: Partial<TaskHistoryPanelProps> = {}): TaskHistoryPanelProps {
  return {
    ...callbacks(),
    open: true,
    jobs: [summary()],
    selectedJob: snapshot(),
    loading: false,
    busy: false,
    error: null,
    hasMore: true,
    ...overrides,
  };
}

afterEach(cleanup);

describe('TaskHistoryPanel', () => {
  it('shows only pending current sources while creating and switches to history explicitly', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const onViewChange = vi.fn();
    const oldJob = snapshot({ name: '旧历史任务' });
    render(<TaskHistoryPanel {...props({
      ...handlers,
      view: 'current',
      onViewChange,
      selectedJob: null,
      jobs: [summary(oldJob)],
      pendingSources: [
        { name: '本次输入.pdf', pageCount: 4 },
        { name: '待读取.pdf', pageCount: null },
      ],
      busy: true,
    })} />);

    const panel = screen.getByRole('complementary', { name: '当前任务' });
    expect(within(panel).getByRole('heading', { name: '当前任务' })).toBeTruthy();
    expect(within(panel).getByRole('heading', { name: '本次来源' })).toBeTruthy();
    expect(within(panel).getByText('2 个来源')).toBeTruthy();
    expect(within(panel).getByText('本次输入.pdf')).toBeTruthy();
    expect(within(panel).getByText('待读取.pdf')).toBeTruthy();
    expect(within(panel).getAllByText('正在创建本次任务').length).toBeGreaterThanOrEqual(1);
    expect(within(panel).queryByRole('button', { name: /选择任务/ })).toBeNull();
    expect(within(panel).queryByText(oldJob.name)).toBeNull();
    expect(within(panel).queryByRole('button', { name: '更多' })).toBeNull();
    expect(within(panel).queryByText('1 个任务')).toBeNull();
    expect(within(panel).queryByText('尚未选择任务')).toBeNull();
    expect(within(panel).queryByText('搜索条件、命中片段文字与坐标已随任务保存。')).toBeNull();

    await user.click(within(panel).getByRole('button', { name: '任务历史' }));
    expect(onViewChange).toHaveBeenCalledTimes(1);
    expect(onViewChange).toHaveBeenCalledWith('history');
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  it('keeps history browsing explicit and locks task selection while busy', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const onViewChange = vi.fn();
    const selected = snapshot({ state: 'paused' });
    const other = snapshot({ id: 'job-2', name: '另一项历史任务', state: 'ready_for_review' });
    render(<TaskHistoryPanel {...props({
      ...handlers,
      view: 'history',
      onViewChange,
      selectedJob: selected,
      jobs: [summary(selected), summary(other)],
      pendingSources: [{ name: '当前输入.pdf', pageCount: 2 }],
      busy: true,
    })} />);

    const panel = screen.getByRole('complementary', { name: '任务历史' });
    const otherButton = within(panel).getByRole('button', { name: `选择任务 ${other.name}` }) as HTMLButtonElement;
    expect(otherButton.disabled).toBe(true);
    await user.click(otherButton);
    expect(handlers.onSelect).not.toHaveBeenCalled();

    await user.click(within(panel).getByRole('button', { name: '返回当前任务' }));
    expect(onViewChange).toHaveBeenCalledTimes(1);
    expect(onViewChange).toHaveBeenCalledWith('current');
    expect(handlers.onResume).not.toHaveBeenCalled();
    expect(handlers.onPause).not.toHaveBeenCalled();
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it('shows creation failure recovery without leaking the previously selected task', async () => {
    const user = userEvent.setup();
    const oldJob = snapshot({ name: '旧的已暂停任务', state: 'paused' });
    const onClose = vi.fn();
    const onViewChange = vi.fn();
    render(<TaskHistoryPanel {...props({
      onClose,
      view: 'current',
      onViewChange,
      selectedJob: null,
      jobs: [summary(oldJob)],
      pendingSources: [{ name: '创建失败.pdf', pageCount: 3 }],
      busy: false,
      error: '创建失败测试',
    })} />);

    const panel = screen.getByRole('complementary', { name: '当前任务' });
    expect(within(panel).getByRole('alert').textContent).toContain('创建失败测试');
    expect(within(panel).getByText('创建失败.pdf')).toBeTruthy();
    expect(within(panel).getByText('尚未创建任务')).toBeTruthy();
    expect(within(panel).getByText('本次任务尚未创建，可返回当前文件重试。')).toBeTruthy();
    expect(within(panel).queryByText(oldJob.name)).toBeNull();
    expect(within(panel).queryByRole('button', { name: '继续任务' })).toBeNull();

    await user.click(within(panel).getByRole('button', { name: '返回当前文件重试' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it('keeps the fixed pause and cancel bar visible for the current running task', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const running = snapshot({ state: 'running' });
    const view = render(<TaskHistoryPanel {...props({
      ...handlers,
      view: 'current',
      onViewChange: vi.fn(),
      selectedJob: running,
      jobs: [summary(running)],
    })} />);

    const body = view.container.querySelector('.task-history-body');
    const actionBar = view.container.querySelector('.task-history-action-bar');
    expect(body?.contains(actionBar)).toBe(false);
    expect(screen.getByRole('button', { name: '暂停任务' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消任务' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '暂停任务' }));
    expect(handlers.onPause).toHaveBeenCalledTimes(1);
  });

  it('keeps new-task access in the fixed toolbar and locks it during active work', async () => {
    const user = userEvent.setup();
    const onNewTask = vi.fn();
    const view = render(<TaskHistoryPanel {...props({ onNewTask })} />);
    const button = screen.getByRole('button', { name: '＋ 新建任务' }) as HTMLButtonElement;
    expect(button.closest('.task-history-toolbar')).toBeTruthy();
    await user.click(button);
    expect(onNewTask).toHaveBeenCalledTimes(1);
    view.rerender(<TaskHistoryPanel {...props({ onNewTask, selectedJob: snapshot({ state: 'running' }) })} />);
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(onNewTask).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '暂停任务' })).toBeTruthy();
  });

  it('shows saved criteria, page counts and source details, and routes ready actions', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const job = snapshot();
    render(<TaskHistoryPanel {...props({ ...handlers, selectedJob: job, jobs: [summary(job)] })} />);

    expect(screen.getByRole('complementary', { name: '任务历史' })).toBeTruthy();
    expect(screen.getAllByText('全部包含：付款、违约责任；排除：草稿').length).toBe(2);
    expect(screen.getByRole('button', { name: '选择任务 合同检索 · 2026-09-08' }).textContent)
      .toContain('成功 3 页 · 失败 1 页 · 共 5 页');
    expect(screen.getByText('report.pdf')).toBeTruthy();
    expect(screen.getByText('成功 3 / 5 页 · 失败 1 页')).toBeTruthy();
    expect(screen.getByText('已登记 SHA-256')).toBeTruthy();
    expect(screen.getByText('原件保持只读，定位同内容 PDF 只切换访问路径。')).toBeTruthy();
    expect(screen.getByText('归档只整理历史记录，不改动原件或导出文件。')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '刷新' }));
    await user.click(screen.getByRole('button', { name: '更多' }));
    await user.click(screen.getByRole('button', { name: '载入审核' }));
    await user.click(screen.getByRole('button', { name: '归档任务' }));
    await user.click(screen.getByRole('button', { name: '关闭任务历史' }));

    expect(handlers.onRefresh).toHaveBeenCalledTimes(1);
    expect(handlers.onLoadMore).toHaveBeenCalledTimes(1);
    expect(handlers.onLoadReview).toHaveBeenCalledTimes(1);
    expect(handlers.onArchive).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows pause and cancel for active work and prevents switching tasks', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const activeJob = snapshot({ state: 'running' });
    const otherJob = snapshot({ id: 'job-2', name: '另一项任务', state: 'paused' });
    render(<TaskHistoryPanel {...props({
      ...handlers,
      selectedJob: activeJob,
      jobs: [summary(activeJob), summary(otherJob)],
    })} />);

    expect(screen.getByRole('status').textContent).toContain('当前任务：运行中');
    expect((screen.getByRole('button', { name: '暂停任务' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '取消任务' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /定位同内容 PDF/ })).toBeNull();
    expect((screen.getByRole('button', { name: '选择任务 另一项任务' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: '暂停任务' }));
    await user.click(screen.getByRole('button', { name: '取消任务' }));

    expect(handlers.onPause).toHaveBeenCalledTimes(1);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  it('keeps selected task actions outside the scrollable body and preserves state-specific controls', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const longName = `${'长任务名称'.repeat(24)} · running`;
    const runningJob = snapshot({ name: longName, state: 'running' });
    const view = render(<TaskHistoryPanel {...props({
      ...handlers,
      selectedJob: runningJob,
      jobs: [summary(runningJob)],
    })} />);

    const body = view.container.querySelector('.task-history-body');
    const actionBar = view.container.querySelector('.task-history-action-bar');
    const selectedName = view.container.querySelector('.task-history-selected-name');
    expect(body).not.toBeNull();
    expect(actionBar).not.toBeNull();
    expect(body?.contains(actionBar)).toBe(false);
    expect(selectedName?.textContent).toBe(longName);
    expect(selectedName?.getAttribute('title')).toBe(longName);
    expect((screen.getByRole('button', { name: '暂停任务' }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole('button', { name: '暂停任务' }));
    expect(handlers.onPause).toHaveBeenCalledTimes(1);

    const pausedJob = snapshot({ name: longName, state: 'paused' });
    view.rerender(<TaskHistoryPanel {...props({
      ...handlers,
      selectedJob: pausedJob,
      jobs: [summary(pausedJob)],
    })} />);
    await user.click(screen.getByRole('button', { name: '继续任务' }));
    expect(handlers.onResume).toHaveBeenCalledTimes(1);

    const pauseRequestedJob = snapshot({ name: longName, state: 'pause_requested' });
    view.rerender(<TaskHistoryPanel {...props({
      ...handlers,
      selectedJob: pauseRequestedJob,
      jobs: [summary(pauseRequestedJob)],
    })} />);
    expect((screen.getByRole('button', { name: '暂停任务' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消任务' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: '取消任务' }));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);

    view.rerender(<TaskHistoryPanel {...props({
      ...handlers,
      selectedJob: runningJob,
      jobs: [summary(runningJob)],
      busy: true,
    })} />);
    expect((screen.getByRole('button', { name: '暂停任务' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消任务' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers continue for resumable jobs and relocates only a verified non-active source', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const pausedJob = snapshot({ state: 'paused' });
    const { rerender } = render(<TaskHistoryPanel {...props({
      ...handlers,
      selectedJob: pausedJob,
      jobs: [summary(pausedJob)],
    })} />);

    expect((screen.getByRole('button', { name: '继续任务' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: /定位同内容 PDF：report\.pdf/ }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: '继续任务' }));
    await user.click(screen.getByRole('button', { name: /定位同内容 PDF：report\.pdf/ }));
    expect(handlers.onResume).toHaveBeenCalledTimes(1);
    expect(handlers.onRelocate).toHaveBeenCalledWith('source-1');

    const activeJob = snapshot({ state: 'running' });
    rerender(<TaskHistoryPanel {...props({
      ...handlers,
      selectedJob: activeJob,
      jobs: [summary(activeJob)],
    })} />);
    expect(screen.queryByRole('button', { name: /定位同内容 PDF/ })).toBeNull();
  });

  it('keeps archived tasks available for review without offering a second archive action', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const archivedJob = snapshot({ state: 'archived' });
    render(<TaskHistoryPanel {...props({
      ...handlers,
      selectedJob: archivedJob,
      jobs: [summary(archivedJob)],
    })} />);

    expect(screen.getByRole('button', { name: '载入审核' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '归档任务' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '载入审核' }));
    expect(handlers.onLoadReview).toHaveBeenCalledTimes(1);
    expect(handlers.onArchive).not.toHaveBeenCalled();
  });

  it('disables mutations while busy or locked and handles an empty source list', () => {
    const activeJob = snapshot({ state: 'running', sources: [] });
    render(<TaskHistoryPanel {...props({
      selectedJob: activeJob,
      jobs: [summary(activeJob)],
      busy: true,
      locked: true,
    })} />);

    expect(screen.getByText('暂无来源')).toBeTruthy();
    expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '更多' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '暂停任务' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消任务' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('wraps long filenames and surfaces source failures without inventing a path action', () => {
    const longName = `${'审阅材料'.repeat(70)}.pdf`;
    const longSource = source({
      name: longName,
      access_path: 'C:\\incoming\\review.pdf',
      initial_path: 'C:\\incoming\\review.pdf',
      sha256: null,
      state: 'failed',
      error: 'PDF 页面读取失败',
    });
    const job = snapshot({
      sources: [longSource],
      state: 'blocked',
    });
    render(<TaskHistoryPanel {...props({ selectedJob: job, jobs: [summary(job)] })} />);

    const name = screen.getByText(longName);
    expect(name.className).toContain('task-history-source-name');
    expect(screen.getByText('失败提示：PDF 页面读取失败')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /定位同内容 PDF/ })).toBeNull();
  });

  it('maps structured failures to Chinese guidance and safely falls back for unknown codes', () => {
    const failedSource = source({
      state: 'failed',
      error: { code: 'page_limit_exceeded', stage: 'validating' },
    });
    const failedJob = snapshot({ state: 'blocked', sources: [failedSource] });
    const { rerender } = render(<TaskHistoryPanel {...props({ selectedJob: failedJob, jobs: [summary(failedJob)] })} />);

    expect(screen.getByText(/失败提示：PDF 页数超过当前任务限制/)).toBeTruthy();
    expect(screen.getByText(/处理建议：请拆分 PDF 后重新分析/)).toBeTruthy();
    expect(screen.getByText(/错误码：page_limit_exceeded · 阶段：校验来源/)).toBeTruthy();

    const unknownSource = source({ state: 'failed', error: { code: 'future_failure', stage: 'future_stage' } });
    const unknownJob = snapshot({ state: 'blocked', sources: [unknownSource] });
    rerender(<TaskHistoryPanel {...props({ selectedJob: unknownJob, jobs: [summary(unknownJob)] })} />);
    expect(screen.getByText(/任务处理失败，系统未提供可识别的原因/)).toBeTruthy();
    expect(screen.getByText(/处理建议：请刷新任务；如果仍然失败，请重新创建任务/)).toBeTruthy();
    expect(screen.getByText(/错误码：future_failure · 阶段：future_stage/)).toBeTruthy();
    expect(screen.queryByText(/\{"code"/)).toBeNull();
  });

  it.each([
    ['ocr_initialization_failed', 'OCR 初始化失败。', /检测 OCR.*重试/],
    ['ocr_inference_failed', 'OCR 识别验证失败。', /检测 OCR.*重试/],
    ['ocr_result_invalid', 'OCR 返回结果无效。', /检测 OCR.*重试/],
    ['ocr_unavailable', 'OCR 运行时不可用。', /检测 OCR.*重试/],
  ] as const)('maps %s to Chinese OCR guidance without exposing raw details', (code, reason, action) => {
    const failure = describeTaskFailure({
      code,
      stage: 'page',
      message: 'D:\\private\\bank.pdf: internal OCR traceback',
    });
    expect(failure).toEqual(expect.objectContaining({ reason }));
    expect(failure?.action).toMatch(action);
    expect(failure?.details).toContain(`错误码：${code}`);
    expect(failure?.details).not.toContain('bank.pdf');
    expect(failure?.details).not.toContain('internal OCR traceback');
  });

  it('routes deletion through planning and locks review while a durable cleanup is pending', async () => {
    const job = snapshot({ state: 'ready_for_review' });
    const onDelete = vi.fn();
    const onOpenCleanup = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<TaskHistoryPanel {...props({ selectedJob: job, onDelete, onOpenCleanup })} />);
    await user.click(screen.getByRole('button', { name: '删除任务' }));
    expect(onDelete).toHaveBeenCalledWith(job.id);
    rerender(<TaskHistoryPanel {...props({ selectedJob: { ...job, deletion_pending: true }, onDelete, onOpenCleanup })} />);
    expect((screen.getByRole('button', { name: '载入审核' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '删除任务' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/此任务正在清理/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '清理与空间' }));
    expect(onOpenCleanup).toHaveBeenCalled();
  });

  it('returns no panel when closed', () => {
    render(<TaskHistoryPanel {...props({ open: false })} />);
    expect(screen.queryByRole('complementary', { name: '任务历史' })).toBeNull();
  });
});
