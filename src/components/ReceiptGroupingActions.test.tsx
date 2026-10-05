// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';

import { syntheticReview, syntheticSnapshot } from '../domain/receiptGrouping.testFixtures';
import type { ReceiptGroupingSnapshot } from '../domain/receiptGrouping';
import type { ReceiptGroupingClient } from '../services/receiptGroupingClient';
import { ReceiptGroupingPanel } from './ReceiptGroupingPanel';

function copy<T>(value: T): T { return structuredClone(value); }

function mockClient({ prepared, loaded, refreshed = loaded }: {
  prepared?: ReceiptGroupingSnapshot;
  loaded: ReceiptGroupingSnapshot;
  refreshed?: ReceiptGroupingSnapshot;
}) {
  const calls = {
    prepare: vi.fn().mockResolvedValue((prepared ?? loaded).header),
    loadAll: vi.fn().mockResolvedValue(loaded),
    save: vi.fn().mockResolvedValue({
      header: { ...loaded.header, grouping_revision: loaded.header.grouping_revision + 1 },
      items: loaded.items,
    }),
    refreshAll: vi.fn().mockResolvedValue(refreshed),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('交易对手分组真实操作回归', () => {
  it('批量修改交易对手覆盖所选混合方向，保留原有其他修正，不改未选回单', async () => {
    const user = userEvent.setup(); const snapshot = copy(syntheticSnapshot(3));
    snapshot.items[1].own_decision.side = 'payee';
    snapshot.items[0].field_overrides = [{ side: 'payer', field: 'bank', value: '已核对银行', state: 'present', reason: '原有依据' }];
    const { client, calls } = mockClient({ loaded: snapshot });
    render(<ReceiptGroupingPanel {...props(snapshot, { client })} />);
    await screen.findByRole('navigation', { name: '分组筛选' });
    expect(screen.queryByRole('button', { name: '查看本机读取规则' })).toBeNull();
    expect(screen.queryByRole('button', { name: '核对收付款资料' })).toBeNull();
    for (const page of [1, 2]) await user.click(screen.getByRole('checkbox', { name: new RegExp(`选择 source\\.pdf · 第 ${page} 页`) }));
    await user.click(screen.getByRole('button', { name: '批量修改交易对手（2）' }));
    expect(screen.queryByLabelText('修正字段所属方')).toBeNull();
    await user.type(screen.getByLabelText('交易对手名称'), '合成银行支行');
    await user.click(screen.getByRole('button', { name: '保存到所选 2 张' }));
    await waitFor(() => expect(calls.save).toHaveBeenCalledOnce());
    const edits = calls.save.mock.calls[0][1];
    expect(edits).toHaveLength(2);
    expect(edits.map((edit: { segment_id: string }) => edit.segment_id)).toEqual(snapshot.items.slice(0, 2).map((item) => item.binding.segment_id));
    expect(edits[0].field_overrides[0]).toEqual(snapshot.items[0].field_overrides[0]);
    for (const edit of edits) {
      expect(edit.assignment).toBeNull();
      expect(edit.field_overrides.at(-1)).toMatchObject({ side: 'counterparty', field: 'name', value: '合成银行支行' });
      expect(edit).not.toHaveProperty('own_confirmation');
    }
  });

  it('批量表单选择变化后清空名称，已有名称也能修正', async () => {
    const user = userEvent.setup(); const snapshot = syntheticSnapshot(3); const { client, calls } = mockClient({ loaded: snapshot });
    render(<ReceiptGroupingPanel {...props(snapshot, { client })} />);
    await user.click(await screen.findByRole('button', { name: '修改交易对手' }));
    expect((screen.getByLabelText('交易对手名称') as HTMLInputElement).value).toBe('合成对手');
    await user.clear(screen.getByLabelText('交易对手名称')); await user.type(screen.getByLabelText('交易对手名称'), '未保存名称');
    await user.click(screen.getByLabelText('勾选前 3 张（批量上限）'));
    expect((screen.getByLabelText('交易对手名称') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: '保存到所选 3 张' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.save).not.toHaveBeenCalled();
  });

  it('只勾选另一张后修改时，对齐原件预览并明确所选一张', async () => {
    const user = userEvent.setup(); const snapshot = syntheticSnapshot(2); const { client, calls } = mockClient({ loaded: snapshot });
    render(<ReceiptGroupingPanel {...props(snapshot, { client, renderPreview: (id) => <div data-testid="focused-original">{id}</div> })} />);
    await screen.findByRole('navigation', { name: '分组筛选' });
    expect(screen.getByTestId('focused-original').textContent).toBe(snapshot.items[0].binding.segment_id);
    await user.click(screen.getByRole('checkbox', { name: /选择 source\.pdf · 第 2 页/ }));
    await user.click(screen.getByRole('button', { name: '修改交易对手' }));
    expect(screen.getByText('所选 1 张回单')).toBeTruthy();
    expect(screen.getByTestId('focused-original').textContent).toBe(snapshot.items[1].binding.segment_id);
    await user.clear(screen.getByLabelText('交易对手名称')); await user.type(screen.getByLabelText('交易对手名称'), '仅第二张');
    await user.click(screen.getByRole('button', { name: '保存到所选 1 张' }));
    await waitFor(() => expect(calls.save).toHaveBeenCalledOnce());
    expect(calls.save.mock.calls[0][1].map((edit: { segment_id: string }) => edit.segment_id)).toEqual([snapshot.items[1].binding.segment_id]);
  });

  it('名称编辑只保留底部唯一确认入口，校验无效时禁用，连续点击只保存一次', async () => {
    const user = userEvent.setup(); const snapshot = syntheticSnapshot();
    const { client, calls } = mockClient({ loaded: snapshot });
    const saved = deferred<{ header: ReceiptGroupingSnapshot['header']; items: ReceiptGroupingSnapshot['items'] }>();
    calls.save.mockReturnValueOnce(saved.promise);
    render(<ReceiptGroupingPanel {...props(snapshot, { client, onSelectSegment: vi.fn() })} />);
    await user.click(await screen.findByRole('button', { name: '修改交易对手' }));
    const actions = screen.getByRole('group', { name: '交易对手操作' });
    expect(within(actions).getAllByRole('button').map((button) => button.textContent)).toEqual(['取消修改', '保存当前 1 张']);
    expect(screen.queryByRole('button', { name: '修改交易对手' })).toBeNull();
    expect(screen.queryByRole('button', { name: '保存交易对手' })).toBeNull();
    expect(within(screen.getByRole('form', { name: '修改交易对手' })).queryByRole('button')).toBeNull();
    expect(screen.getAllByRole('button', { name: '取消修改' })).toHaveLength(1);
    const save = within(actions).getByRole('button', { name: '保存当前 1 张' }) as HTMLButtonElement;
    expect(save.form).toBe(screen.getByRole('form', { name: '修改交易对手' }));
    await user.clear(screen.getByLabelText('交易对手名称'));
    expect(save.disabled).toBe(true);
    await user.type(screen.getByLabelText('交易对手名称'), '）');
    expect(save.disabled).toBe(true);
    await user.clear(screen.getByLabelText('交易对手名称'));
    await user.type(screen.getByLabelText('交易对手名称'), '已核对名称');
    expect(save.disabled).toBe(false);
    await user.dblClick(save);
    expect(calls.save).toHaveBeenCalledOnce();
    expect(save.disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消修改' }) as HTMLButtonElement).disabled).toBe(true);
    saved.resolve({ header: { ...snapshot.header, grouping_revision: 2 }, items: snapshot.items });
    await screen.findByRole('button', { name: '修改交易对手' });
    expect(screen.queryByRole('form', { name: '修改交易对手' })).toBeNull();
  });

  it('取消底部修改后不提交并恢复普通入口，次级工具名称准确', async () => {
    const user = userEvent.setup(); const snapshot = syntheticSnapshot(); const { client, calls } = mockClient({ loaded: snapshot });
    snapshot.items[0].route = 'counterparty_pending'; snapshot.items[0].group = null;
    snapshot.header.counts.assigned = 0; snapshot.header.counts.counterparty_pending = 1;
    render(<ReceiptGroupingPanel {...props(snapshot, { client, renderPreview: () => <div>合成原件</div> })} />);
    await user.click(await screen.findByRole('button', { name: '修改交易对手' }));
    await user.click(screen.getByRole('button', { name: '取消修改' }));
    expect(screen.queryByRole('form', { name: '修改交易对手' })).toBeNull();
    expect(screen.getByRole('button', { name: '修改交易对手' })).toBeTruthy();
    expect(calls.save).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '更多工具' }));
    expect(screen.getByRole('button', { name: '核对收付款资料' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '同版式批量识别' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '修改当前字段' })).toBeNull();
  });

  it('拆所选片段为新组时只提交分组 assignment 和 CAS 依据，不修改裁剪或审核字段', async () => {
    const user = userEvent.setup();
    const snapshot = syntheticSnapshot(2);
    const { client, calls } = mockClient({ loaded: snapshot });
    render(<ReceiptGroupingPanel {...props(snapshot, { client })} />);
    await screen.findByRole('navigation', { name: '分组筛选' });

    await user.click(screen.getByRole('checkbox', { name: /选择 source\.pdf · 第 1 页/ }));
    await user.click(screen.getByRole('button', { name: '更多工具' }));
    await user.click(screen.getByRole('button', { name: '移组／拆组' }));
    await user.type(screen.getByLabelText('分组名称'), '新交易对手组');
    await user.click(screen.getByRole('button', { name: '将所选片段拆为新组' }));

    await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
    const [, edits, groupEdits] = calls.save.mock.calls[0] as [unknown, Array<Record<string, unknown>>, Array<Record<string, unknown>>];
    expect(edits).toHaveLength(1);
    expect(Object.keys(edits[0]).sort()).toEqual(['assignment', 'expected_basis_fingerprint', 'segment_id']);
    expect(edits[0]).toMatchObject({
      segment_id: snapshot.items[0].binding.segment_id,
      expected_basis_fingerprint: snapshot.items[0].basis_fingerprint,
      assignment: { group_id: expect.stringMatching(/^manual-/), reason: expect.any(String) },
    });
    expect(edits[0]).not.toHaveProperty('final_rect');
    expect(edits[0]).not.toHaveProperty('review_status');
    expect(groupEdits).toEqual([{ action: 'create', group_id: (edits[0].assignment as { group_id: string }).group_id,
      kind: 'named', display_name: '新交易对手组' }]);
  });

  it('导出核对草稿始终传整批 snapshot，并包含当前筛选之外的待确认片段', async () => {
    const user = userEvent.setup();
    const snapshot = syntheticSnapshot(2);
    snapshot.items[1].route = 'counterparty_pending';
    snapshot.items[1].group = null;
    snapshot.header.counts.counterparty_pending = 1;
    snapshot.header.counts.assigned = 1;
    const { client } = mockClient({ loaded: snapshot });
    const onExportDraft = vi.fn().mockResolvedValue(undefined);
    render(<ReceiptGroupingPanel {...props(snapshot, { client, onExportDraft })} />);
    await screen.findByRole('navigation', { name: '分组筛选' });

    await user.click(within(screen.getByRole('navigation', { name: '分组筛选' })).getByRole('button', { name: /合成对手/ }));
    expect(screen.getByText('当前 1 张')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '导出核对草稿 Excel' }));
    await waitFor(() => expect(onExportDraft).toHaveBeenCalledTimes(1));
    const [draft] = onExportDraft.mock.calls[0] as [ReceiptGroupingSnapshot];
    expect(draft.items).toHaveLength(2);
    expect(draft.items.map((item) => item.binding.segment_id)).toEqual(snapshot.items.map((item) => item.binding.segment_id));
    expect(draft.items[1].route).toBe('counterparty_pending');
    expect(draft.header.counts.counterparty_pending).toBe(1);
  });

  it('StrictMode 首次自动准备和继续提取各执行一次', async () => {
    const pending = syntheticSnapshot();
    pending.header.counts.extraction_pending = 1;
    pending.items[0].extraction_state = 'pending';
    const ready = copy(pending);
    ready.header.counts.extraction_pending = 0;
    ready.items[0].extraction_state = 'ready';
    const { client, calls } = mockClient({ prepared: pending, loaded: pending, refreshed: ready });
    const onSnapshotChange = vi.fn();
    render(<StrictMode><ReceiptGroupingPanel {...props(pending, { client, onSnapshotChange, autoExtract: true })} /></StrictMode>);
    await waitFor(() => expect(calls.refreshAll).toHaveBeenCalledTimes(1));
    expect(calls.prepare).toHaveBeenCalledTimes(1);
    expect(calls.loadAll).toHaveBeenCalledTimes(1);
    expect(onSnapshotChange).toHaveBeenCalledWith(null);
    expect(onSnapshotChange).toHaveBeenLastCalledWith(ready);
  });

  it('停止字段提取后丢弃晚到结果，并可重新载入已保存结果继续', async () => {
    const pending = syntheticSnapshot();
    pending.header.counts.extraction_pending = 1;
    pending.items[0].extraction_state = 'pending';
    const ready = copy(pending);
    ready.header.counts.extraction_pending = 0;
    ready.items[0].extraction_state = 'ready';
    const pendingRefresh = deferred<ReceiptGroupingSnapshot>();
    const { client, calls } = mockClient({ loaded: pending });
    calls.refreshAll.mockReturnValueOnce(pendingRefresh.promise);
    calls.loadAll.mockResolvedValueOnce(pending).mockResolvedValueOnce(ready);
    const onSnapshotChange = vi.fn();
    const user = userEvent.setup();
    render(<ReceiptGroupingPanel {...props(pending, { client, autoExtract: false, onSnapshotChange })} />);
    await screen.findByRole('navigation', { name: '分组筛选' });
    await user.click(screen.getByRole('button', { name: '继续提取字段' }));
    await waitFor(() => expect(calls.refreshAll).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '停止后续操作' }));
    expect(onSnapshotChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('button', { name: '重新载入已保存结果' })).toBeTruthy();

    pendingRefresh.resolve(ready);
    await Promise.resolve();
    await Promise.resolve();
    expect(onSnapshotChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText('已显示当前筛选的全部 1 张回单')).toBeNull();

    await user.click(screen.getByRole('button', { name: '重新载入已保存结果' }));
    await waitFor(() => expect(calls.prepare).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onSnapshotChange).toHaveBeenLastCalledWith(ready));
    expect(screen.getByText('已显示当前筛选的全部 1 张回单')).toBeTruthy();
  });
});
