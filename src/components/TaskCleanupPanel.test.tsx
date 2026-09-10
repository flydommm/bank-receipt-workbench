// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BatchCleanup, BatchStorageUsage } from '../domain/batchCleanup';
import { TaskCleanupPanel, type TaskCleanupPanelProps } from './TaskCleanupPanel';

function plan(overrides: Partial<BatchCleanup> = {}): BatchCleanup {
  return {
    cleanup_id: 'cleanup-1',
    job_id: 'job-1',
    job_name: '合同检索',
    source_count: 2,
    page_result_count: 12,
    review_record_count: 3,
    review_exclusive: true,
    preview_count: 2,
    delete_review: null,
    task_data_state: 'pending',
    review_state: 'pending',
    preview_state: 'pending',
    outcome: 'pending',
    created_at: '2026-09-08T00:00:00Z',
    updated_at: '2026-09-08T00:00:00Z',
    notice_codes: [],
    ...overrides,
  };
}

function usage(overrides: Partial<BatchStorageUsage> = {}): BatchStorageUsage {
  return {
    database_bytes: 1024,
    wal_bytes: 64,
    shm_bytes: 128,
    total_bytes: 1216,
    quota_bytes: 1024 * 1024,
    within_quota: true,
    available: true,
    ...overrides,
  };
}

function callbacks() {
  return {
    onClose: vi.fn(),
    onExecute: vi.fn(),
    onRetry: vi.fn(),
    onRefresh: vi.fn(),
    onLoadMore: vi.fn(),
    onMaintain: vi.fn(),
    onCancelPlan: vi.fn(),
  } satisfies Pick<TaskCleanupPanelProps,
    'onClose' | 'onExecute' | 'onRetry' | 'onRefresh' | 'onLoadMore' | 'onMaintain' | 'onCancelPlan'>;
}

function props(overrides: Partial<TaskCleanupPanelProps> = {}): TaskCleanupPanelProps {
  return {
    ...callbacks(),
    open: true,
    plan: plan(),
    history: [],
    usage: usage(),
    busy: false,
    locked: false,
    error: null,
    hasMore: false,
    ...overrides,
  };
}

afterEach(cleanup);

describe('TaskCleanupPanel', () => {
  it('defaults to retaining review and only executes after the explicit button', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(<TaskCleanupPanel {...props({ ...handlers })} />);

    expect(screen.getByRole('complementary', { name: '任务清理与空间' })).toBeTruthy();
    expect(screen.getByText('默认保留人工审核、关键词历史、原始 PDF 和已导出的文件。')).toBeTruthy();
    const checkbox = screen.getByRole('checkbox', { name: '同时删除该任务独占的审核记录' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(handlers.onExecute).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认删除任务' }));
    expect(handlers.onExecute).toHaveBeenCalledWith('cleanup-1', false);
  });

  it('allows deleting only an exclusive review set when explicitly selected', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(<TaskCleanupPanel {...props({ ...handlers })} />);

    await user.click(screen.getByRole('checkbox', { name: '同时删除该任务独占的审核记录' }));
    await user.click(screen.getByRole('button', { name: '确认删除任务' }));
    expect(handlers.onExecute).toHaveBeenCalledWith('cleanup-1', true);
  });

  it('does not show a delete-review control for shared review records', () => {
    render(<TaskCleanupPanel {...props({ plan: plan({ review_exclusive: false }) })} />);
    expect(screen.queryByRole('checkbox', { name: /审核记录/ })).toBeNull();
    expect(screen.getByText('审核记录并非本任务独占，将保留。')).toBeTruthy();
  });

  it('resets the delete-review choice when the server plan changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TaskCleanupPanel {...props()} />);
    await user.click(screen.getByRole('checkbox', { name: '同时删除该任务独占的审核记录' }));
    expect((screen.getByRole('checkbox', { name: '同时删除该任务独占的审核记录' }) as HTMLInputElement).checked).toBe(true);

    rerender(<TaskCleanupPanel {...props({ plan: plan({ cleanup_id: 'cleanup-2', job_id: 'job-2' }) })} />);
    expect((screen.getByRole('checkbox', { name: '同时删除该任务独占的审核记录' }) as HTMLInputElement).checked).toBe(false);
  });

  it('passes the persisted review choice when retrying a residual history item', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const residual = plan({ cleanup_id: 'cleanup-2', job_id: 'job-2', delete_review: true,
      review_state: 'residual', preview_state: 'cleaned', outcome: 'pending' });
    render(<TaskCleanupPanel {...props({ ...handlers, plan: null, history: [residual] })} />);

    await user.click(screen.getByRole('button', { name: '重试清理 合同检索' }));
    expect(handlers.onRetry).toHaveBeenCalledWith(residual);
    expect(handlers.onExecute).not.toHaveBeenCalled();
  });

  it('offers retry when execution crashed before any sub-state was advanced', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const interrupted = plan({ cleanup_id: 'cleanup-3', delete_review: false });
    render(<TaskCleanupPanel {...props({ ...handlers, plan: null, history: [interrupted] })} />);

    await user.click(screen.getByRole('button', { name: '重试清理 合同检索' }));
    expect(handlers.onRetry).toHaveBeenCalledWith(interrupted);
  });

  it('does not turn unavailable nullable usage into zero bytes', () => {
    render(<TaskCleanupPanel {...props({ usage: null })} />);
    expect(screen.getByText('空间占用信息暂不可用。')).toBeTruthy();
    expect(screen.queryByText(/0 B/)).toBeNull();
  });

  it('keeps close usable while busy or locked and disables mutations', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(<TaskCleanupPanel {...props({ ...handlers, busy: true, locked: true, history: [plan({
      cleanup_id: 'cleanup-2', delete_review: false, review_state: 'residual', outcome: 'pending',
    })] })} />);

    expect((screen.getByRole('button', { name: '确认删除任务' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '重试清理 合同检索' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '维护存储' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '关闭任务清理' }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});
