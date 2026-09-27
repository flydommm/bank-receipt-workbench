// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReceiptBatchEntry } from './ReceiptBatchEntry';
import type { ReceiptBatchState } from '../services/receiptBatchController';

const idle: ReceiptBatchState = { job: null, busy: false, error: null, phase: 'idle' };
const runningJob: NonNullable<ReceiptBatchState['job']> = {
  id: 'job-progress', name: 'synthetic', generation: 1, state: 'running', resume_target: null,
  criteria: null, page_result_schema: 2, processing_options: { processing_mode: 'split_all', criteria: null },
  criteria_fingerprint: 'a'.repeat(64), match_mode: 'exact', computation_version: 'test',
  result_revision: null, owner: 'test', error: null, created_at: '2026-09-16T00:00:00Z',
  updated_at: '2026-09-16T00:01:00Z', deletion_pending: false,
  page_summary: { pending: 420, processing: 1, succeeded: 250, failed: 0 }, total_pages: 671, sources: [],
};

describe('ReceiptBatchEntry', () => {
  it('shows advancing page counts in the status text during analysis and distinguishes finalizing', () => {
    const props = { mode: 'search' as const, onModeChange: vi.fn(), onAnalyze: vi.fn(), onEnterReview: vi.fn(), onExport: vi.fn() };
    const { rerender } = render(<ReceiptBatchEntry {...props} showAnalyzeAction={false}
      state={{ ...idle, busy: true, phase: 'running', job: runningJob }} />);
    expect(screen.getByRole('status').textContent).toBe('分析中 · 250/671 页');
    expect(screen.queryByRole('progressbar')).toBeNull();
    rerender(<ReceiptBatchEntry {...props} showAnalyzeAction={false} state={{ ...idle, busy: true, phase: 'running',
      job: { ...runningJob, page_summary: { pending: 0, processing: 0, succeeded: 670, failed: 1 } } }} />);
    expect(screen.getByRole('status').textContent).toBe('分析中 · 671/671 页（1 页失败）');
    expect(screen.queryByRole('progressbar')).toBeNull();
    rerender(<ReceiptBatchEntry {...props} showAnalyzeAction={false} state={{ ...idle, busy: true, phase: 'running',
      job: { ...runningJob, state: 'finalizing', page_summary: { pending: 0, processing: 0, succeeded: 671, failed: 0 } } }} />);
    expect(screen.getByRole('status').textContent).toBe('正在整理分析结果…');
    expect(screen.queryByText('分析完成')).toBeNull();
  });

  it('does not show a previous job count while creating the next task', () => {
    render(<ReceiptBatchEntry mode="search" onModeChange={vi.fn()} onAnalyze={vi.fn()} onEnterReview={vi.fn()} onExport={vi.fn()}
      state={{ ...idle, busy: true, phase: 'creating', job: runningJob }} />);
    expect(screen.getByRole('status').textContent).toBe('正在创建回单任务…');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/671/)).toBeNull();
  });

  it('shows one loading status and never claims completion before review has loaded', () => {
    render(<ReceiptBatchEntry mode="search" onModeChange={vi.fn()} state={{ ...idle, phase: 'ready' }} reviewLoading
      onAnalyze={vi.fn()} onEnterReview={vi.fn()} onExport={vi.fn()} />);
    expect(screen.getAllByText(/载入结果/)).toHaveLength(1);
    expect(screen.queryByText('分析完成')).toBeNull();
    expect((screen.getByRole('button', { name: '查看任务结果' }) as HTMLButtonElement).disabled).toBe(true);
  });
  afterEach(() => cleanup());
  it('reveals one analysis action before results and supports split-all mode', async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    render(<ReceiptBatchEntry mode="search" onModeChange={onModeChange} state={idle}
      onAnalyze={vi.fn()} onEnterReview={vi.fn()} onExport={vi.fn()} />);

    expect(screen.getByRole('button', { name: '开始回单分析' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '进入微调' })).toBeNull();
    expect(screen.queryByText('切换处理方式后请重新分析；当前关键词输入会保留。')).toBeNull();
    expect(screen.getByRole('group', { name: '处理方式' })).toBeTruthy();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((input) => input.value)).toEqual(['split_all', 'search']);
    expect(radios.map((input) => input.checked)).toEqual([false, true]);
    await user.click(screen.getByLabelText('分割全部回单'));
    expect(onModeChange).toHaveBeenCalledWith('split_all');
  });

  it('shows only review entry when unresolved segments remain', () => {
    const state: ReceiptBatchState = { ...idle, phase: 'ready', job: ({
      id: 'job-1', name: 'demo', generation: 1, state: 'ready_for_review', resume_target: null,
      criteria: null, criteria_fingerprint: null, match_mode: 'exact', computation_version: 'v1',
      result_revision: 1, owner: 'local', error: null, created_at: 1, updated_at: 1,
      deletion_pending: false, page_summary: { pending: 0, processing: 0, succeeded: 2, failed: 0 }, total_pages: 1,
    } as unknown) as ReceiptBatchState['job'] };
    render(<ReceiptBatchEntry mode="search" onModeChange={vi.fn()} state={state} resultCount={2} unresolvedCount={1}
      onAnalyze={vi.fn()} onEnterReview={vi.fn()} onExport={vi.fn()} />);
    expect(screen.getByRole('button', { name: '进入微调' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '直接导出' })).toBeNull();
  });

  it('offers direct export when all results are automatic', () => {
    const state: ReceiptBatchState = { ...idle, phase: 'ready' };
    render(<ReceiptBatchEntry mode="search" onModeChange={vi.fn()} state={state} resultCount={3} unresolvedCount={0}
      onAnalyze={vi.fn()} onEnterReview={vi.fn()} onExport={vi.fn()} />);
    expect(screen.getByRole('button', { name: '直接导出' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入微调' })).toBeTruthy();
  });

  it('does not claim direct export until review status is loaded', () => {
    const state: ReceiptBatchState = { ...idle, phase: 'ready' };
    render(<ReceiptBatchEntry mode="search" onModeChange={vi.fn()} state={state}
      onAnalyze={vi.fn()} onEnterReview={vi.fn()} onExport={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '直接导出' })).toBeNull();
    expect(screen.getByRole('button', { name: '查看任务结果' })).toBeTruthy();
  });
});
