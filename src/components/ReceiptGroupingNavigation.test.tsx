// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syntheticReview, syntheticSnapshot } from '../domain/receiptGrouping.testFixtures';
import type { ReceiptGroupingSnapshot } from '../domain/receiptGrouping';
import type { ReceiptGroupingClient } from '../services/receiptGroupingClient';
import { ReceiptGroupingPanel } from './ReceiptGroupingPanel';

afterEach(cleanup);

function mockClient(loaded: ReceiptGroupingSnapshot) {
  const calls = {
    prepare: vi.fn().mockResolvedValue(loaded.header),
    loadAll: vi.fn().mockResolvedValue(loaded),
    save: vi.fn().mockResolvedValue({ header: loaded.header, items: loaded.items }),
    refreshAll: vi.fn().mockResolvedValue(loaded),
  };
  return { client: calls as unknown as ReceiptGroupingClient, calls };
}

function props(snapshot: ReceiptGroupingSnapshot, overrides: Partial<React.ComponentProps<typeof ReceiptGroupingPanel>> = {}) {
  return {
    jobId: 'synthetic-job',
    resultRevision: 'result-1',
    reviewItems: snapshot.items.map(syntheticReview),
    onSnapshotChange: vi.fn(),
    ...overrides,
  };
}

function markBatch(snapshot: ReceiptGroupingSnapshot, jobId: string, resultRevision: string, sourcePrefix: string) {
  snapshot.header.job_id = jobId;
  snapshot.header.result_revision = resultRevision;
  snapshot.items.forEach((item, index) => {
    item.binding.segment_id = `${sourcePrefix}-segment-${index + 1}`;
    item.binding.fragment_key = `${sourcePrefix}-fragment-${index + 1}`;
    item.binding.instance_id = `${sourcePrefix}-instance-${index + 1}`;
    item.binding.source_key = `${sourcePrefix}.pdf`;
    item.binding.source_page = index + 1;
    item.binding.position_index = 1;
  });
  return snapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('ReceiptGroupingPanel navigation', () => {
  it('小于批量上限时显示实际快捷勾选数量，搜索变化清空隐形勾选', async () => {
    const user = userEvent.setup();
    const snapshot = syntheticSnapshot(3);
    const { client } = mockClient(snapshot);
    render(<ReceiptGroupingPanel {...props(snapshot, { client })} />);

    const quickSelect = await screen.findByLabelText('勾选前 3 张（批量上限）');
    expect(screen.getByText('共 3 张（含已排除）')).toBeTruthy();
    await user.click(quickSelect);
    expect(screen.getByText('已选 3 / 200（批量上限）')).toBeTruthy();

    await user.type(screen.getByLabelText('分组名称搜索'), '不存在的名称');
    expect(screen.getByText('已选 0 / 200（批量上限）')).toBeTruthy();
    expect(screen.getByLabelText('勾选前 0 张（批量上限）')).toBeTruthy();
  });

  it('按来源首次出现、页码和栏位排序连续列表', async () => {
    const snapshot = syntheticSnapshot(4);
    const [first, second, third, fourth] = snapshot.items;
    Object.assign(first.binding, { source_key: 'z.pdf', source_page: 2, position_index: 1 });
    Object.assign(second.binding, { source_key: 'a.pdf', source_page: 2, position_index: 1 });
    Object.assign(third.binding, { source_key: 'z.pdf', source_page: 1, position_index: 2 });
    Object.assign(fourth.binding, { source_key: 'z.pdf', source_page: 1, position_index: 1 });
    const { client } = mockClient(snapshot);
    render(<ReceiptGroupingPanel {...props(snapshot, {
      client,
      reviewItems: [first, second, third, fourth].map(syntheticReview),
    })} />);

    await screen.findByRole('navigation', { name: '分组筛选' });
    const sourceLabels = [...document.querySelectorAll<HTMLElement>('.receipt-grouping-row__source')]
      .map((node) => node.textContent?.replace(/自动判断|人工决定|待判断/g, '').trim());
    expect(sourceLabels).toEqual([
      'z.pdf · 第 1 页 · 第 1 栏',
      'z.pdf · 第 1 页 · 第 2 栏',
      'z.pdf · 第 2 页 · 第 1 栏',
      'a.pdf · 第 2 页 · 第 1 栏',
    ]);
  });

  it('列表上下键可连续越过 200 张并同步实际焦点，不误触发勾选', async () => {
    const user = userEvent.setup();
    const snapshot = syntheticSnapshot(405);
    const { client } = mockClient(snapshot);
    render(<ReceiptGroupingPanel {...props(snapshot, { client })} />);
    await screen.findByRole('navigation', { name: '分组筛选' });

    const rows = () => [...document.querySelectorAll<HTMLElement>('.receipt-grouping-row')];
    const focusedRow = () => document.querySelector<HTMLElement>('.receipt-grouping-row.is-focused');
    const expectFocusedPage = (page: number) => {
      const row = focusedRow();
      expect(row).toBeTruthy();
      expect(row?.textContent).toContain(`第 ${page} 页`);
      expect(document.activeElement).toBe(row);
      expect(screen.getByText('已选 0 / 200（批量上限）')).toBeTruthy();
    };
    const firstRow = focusedRow();
    expect(firstRow).toBeTruthy();
    expect(rows()).toHaveLength(200);
    const checkbox = within(firstRow as HTMLElement).getByRole('checkbox');
    checkbox.focus();
    fireEvent.keyDown(checkbox, { key: 'ArrowDown' });
    expect(focusedRow()).toBe(firstRow);
    expect(document.activeElement).toBe(checkbox);
    expect(screen.getByText('已选 0 / 200（批量上限）')).toBeTruthy();

    await user.click(rows()[198]);
    expectFocusedPage(199);
    for (const [key, page] of [['ArrowDown', 200], ['ArrowDown', 201], ['ArrowDown', 202], ['ArrowUp', 201], ['ArrowUp', 200], ['ArrowUp', 199]] as const) {
      const row = focusedRow();
      expect(row).toBeTruthy();
      fireEvent.keyDown(row as HTMLElement, { key });
      expectFocusedPage(page);
    }

    const list = document.querySelector<HTMLElement>('.receipt-grouping-list');
    expect(list).toBeTruthy();
    fireEvent.scroll(list as HTMLElement);
    await waitFor(() => expect(rows()).toHaveLength(402));
    fireEvent.scroll(list as HTMLElement);
    await waitFor(() => expect(rows()).toHaveLength(405));

    await user.click(rows()[403]);
    expectFocusedPage(404);
    const row404 = focusedRow() as HTMLElement;
    fireEvent.keyDown(row404, { key: 'ArrowDown' });
    expectFocusedPage(405);
    const lastRow = focusedRow() as HTMLElement;
    fireEvent.keyDown(lastRow, { key: 'ArrowDown' });
    expectFocusedPage(405);
    fireEvent.keyDown(lastRow, { key: 'Enter' });
    expectFocusedPage(405);
  }, 30_000);

  it('总览契约提供当前筛选片段并支持上下键与 onOpen 切换', async () => {
    const user = userEvent.setup();
    const snapshot = syntheticSnapshot(3);
    const filteredItem = snapshot.items[1];
    filteredItem.route = 'counterparty_pending';
    filteredItem.group = null;
    filteredItem.own_decision = { status: 'pending', method: 'none', side: null, source_bank_status: 'unknown', reasons: [] };
    const { client } = mockClient(snapshot);
    const renderOverview = vi.fn((context: Parameters<NonNullable<React.ComponentProps<typeof ReceiptGroupingPanel>['renderOverview']>>[0]) => (
      <div data-testid="overview-grid">
        <button type="button" onClick={() => context.onOpen(filteredItem.binding.segment_id)}>打开第二张</button>
        <span data-testid="overview-focused">{context.focusedId ?? '无焦点'}</span>
      </div>
    ));
    const renderPreview = (id: string, context: { controls: React.ReactNode }) => <>{context.controls}<span data-testid="single-preview">预览 {id}</span></>;
    render(<ReceiptGroupingPanel {...props(snapshot, { client, renderOverview, renderPreview })} />);

    await screen.findByTestId('single-preview');
    expect(screen.queryByTestId('overview-grid')).toBeNull();
    expect(renderOverview).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '下一张' }));
    expect(screen.getByTestId('single-preview').textContent).toContain(snapshot.items[1].binding.segment_id);
    fireEvent.keyDown(screen.getByLabelText('原件预览，可用上下键切换'), { key: 'ArrowUp' });
    expect(screen.getByTestId('single-preview').textContent).toContain(snapshot.items[0].binding.segment_id);
    await user.click(screen.getByRole('button', { name: '片段总览' }));
    await screen.findByTestId('overview-grid');
    expect(renderOverview.mock.calls[0][0].segmentIds).toHaveLength(3);
    expect(renderOverview.mock.calls[0][0].active).toBe(true);
    expect(screen.getByRole('button', { name: '单张核对' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '下一张' }));
    await waitFor(() => expect(renderOverview.mock.calls.at(-1)?.[0].focusedId).toBe(snapshot.items[1].binding.segment_id));
    expect(screen.getByTestId('overview-grid')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('button', { name: '打开第二张' }), { key: 'ArrowDown' });
    await waitFor(() => expect(renderOverview.mock.calls.at(-1)?.[0].focusedId).toBe(snapshot.items[2].binding.segment_id));
    expect(screen.getByTestId('overview-grid')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '打开第二张' }));
    expect(screen.getByText(`预览 ${filteredItem.binding.segment_id}`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '片段总览' }));
    await user.click(within(screen.getByRole('navigation', { name: '分组筛选' })).getByRole('button', { name: /对手待确认/ }));
    await waitFor(() => expect(renderOverview.mock.calls.at(-1)?.[0].segmentIds).toEqual([filteredItem.binding.segment_id]));
  });

  it('完成一批 405 张回单后切换任务，界面只保留 B 批次', async () => {
    const batchA = markBatch(syntheticSnapshot(405), 'job-a', 'result-a', 'a-batch');
    const batchB = markBatch(syntheticSnapshot(3), 'job-b', 'result-b', 'b-batch');
    const calls = {
      prepare: vi.fn((jobId: string) => Promise.resolve(jobId === 'job-a' ? batchA.header : batchB.header)),
      loadAll: vi.fn((header: ReceiptGroupingSnapshot['header']) => Promise.resolve(header.job_id === 'job-a' ? batchA : batchB)),
      save: vi.fn(),
      refreshAll: vi.fn(),
    };
    const client = calls as unknown as ReceiptGroupingClient;
    const view = render(<ReceiptGroupingPanel {...props(batchA, { client, jobId: 'job-a', resultRevision: 'result-a' })} />);

    await screen.findByText('共 405 张（含已排除）');
    expect(screen.getByText(/a-batch\.pdf · 第 1 页/)).toBeTruthy();
    view.rerender(<ReceiptGroupingPanel {...props(batchB, { client, jobId: 'job-b', resultRevision: 'result-b' })} />);

    await screen.findByText('共 3 张（含已排除）');
    expect(screen.getByText(/当前 3 张/)).toBeTruthy();
    expect(screen.getByText('已显示当前筛选的全部 3 张回单')).toBeTruthy();
    expect(screen.getByLabelText('勾选前 3 张（批量上限）')).toBeTruthy();
    expect(screen.queryByLabelText('勾选前 200 张（批量上限）')).toBeNull();
    expect(screen.getByText(/b-batch\.pdf · 第 1 页/)).toBeTruthy();
    expect(screen.queryByText(/a-batch\.pdf/)).toBeNull();
  });

  it('任务 A 的晚到响应不能覆盖已经完成的任务 B', async () => {
    const batchA = markBatch(syntheticSnapshot(2), 'job-a-late', 'result-a-late', 'a-late');
    const batchB = markBatch(syntheticSnapshot(3), 'job-b-live', 'result-b-live', 'b-live');
    const lateA = deferred<ReceiptGroupingSnapshot>();
    const calls = {
      prepare: vi.fn((jobId: string) => Promise.resolve(jobId === 'job-a-late' ? batchA.header : batchB.header)),
      loadAll: vi.fn((header: ReceiptGroupingSnapshot['header']) => header.job_id === 'job-a-late' ? lateA.promise : Promise.resolve(batchB)),
      save: vi.fn(),
      refreshAll: vi.fn(),
    };
    const client = calls as unknown as ReceiptGroupingClient;
    const view = render(<ReceiptGroupingPanel {...props(batchA, { client, jobId: 'job-a-late', resultRevision: 'result-a-late' })} />);
    await waitFor(() => expect(calls.loadAll).toHaveBeenCalledTimes(1));

    view.rerender(<ReceiptGroupingPanel {...props(batchB, { client, jobId: 'job-b-live', resultRevision: 'result-b-live' })} />);
    await screen.findByText('共 3 张（含已排除）');
    expect(screen.getByText(/b-live\.pdf · 第 1 页/)).toBeTruthy();
    expect(calls.loadAll).toHaveBeenCalledTimes(2);

    lateA.resolve(batchA);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText('共 3 张（含已排除）')).toBeTruthy();
    expect(screen.getByText(/b-live\.pdf · 第 1 页/)).toBeTruthy();
    expect(screen.queryByText(/a-late\.pdf/)).toBeNull();
  });
});
