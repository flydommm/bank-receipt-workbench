// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syntheticField, syntheticReview, syntheticSnapshot } from '../domain/receiptGrouping.testFixtures';
import { ReceiptGroupingValidationError, type ReceiptGroupingSnapshot } from '../domain/receiptGrouping';
import type { ReceiptGroupingClient } from '../services/receiptGroupingClient';
import { ReceiptGroupingPanel } from './ReceiptGroupingPanel';

afterEach(cleanup);

it('空白筛选包含已识别收费空白项，与有名待核对分开且允许人工移组', async () => {
  const user = userEvent.setup(); const snapshot = syntheticSnapshot(3);
  const fee = snapshot.items[0]; fee.route = 'special'; fee.extracted!.service_type = 'bank_fee';
  fee.counterparty!.name = syntheticField(''); fee.extracted!.payee.name = syntheticField('');
  fee.group = { group_id: 'fee', kind: 'special', key: 'bank_fee', display_name: '银行手续费', manual: false };
  const pending = snapshot.items[1]; pending.route = 'counterparty_pending';
  pending.counterparty!.name = { ...syntheticField('待核对名称'), state: 'ambiguous' };
  pending.group = { group_id: 'pending', kind: 'counterparty_pending', key: 'pending', display_name: '对手待确认', manual: false };
  const { client } = mockClient({ loaded: snapshot });
  render(<ReceiptGroupingPanel {...props(snapshot, { client })} />);
  const filter = await screen.findByRole('button', { name: /对方名称为空.*1/ });
  await user.click(filter);
  expect(screen.getByLabelText('勾选前 1 张（批量上限）')).toBeTruthy();
  expect(screen.queryByText(/source\.pdf · 第 2 页/)).toBeNull();
  await user.click(screen.getByRole('button', { name: '更多工具' }));
    await user.click(screen.getByRole('button', { name: '移组／拆组' }));
  await user.selectOptions(screen.getByLabelText('移入已有组'), 'named-synthetic');
  expect((screen.getByRole('button', { name: '将所选片段移入此组' }) as HTMLButtonElement).disabled).toBe(false);
});

function copy<T>(value: T): T { return structuredClone(value); }

function mockClient({ prepared, loaded, refreshed = loaded }: { prepared?: ReceiptGroupingSnapshot; loaded: ReceiptGroupingSnapshot; refreshed?: ReceiptGroupingSnapshot }) {
  const calls = {
    prepare: vi.fn().mockResolvedValue((prepared ?? loaded).header),
    loadAll: vi.fn().mockResolvedValue(loaded),
    save: vi.fn().mockResolvedValue({ header: { ...loaded.header, grouping_revision: loaded.header.grouping_revision + 1 }, items: loaded.items }),
    refreshAll: vi.fn().mockResolvedValue(refreshed),
  };
  return { client: calls as unknown as ReceiptGroupingClient, calls };
}

function props(snapshot: ReceiptGroupingSnapshot, overrides: Partial<React.ComponentProps<typeof ReceiptGroupingPanel>> = {}) {
  return { jobId: 'synthetic-job', resultRevision: 'result-1', reviewItems: snapshot.items.map(syntheticReview), onSnapshotChange: vi.fn(), ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe('ReceiptGroupingPanel', () => {
  it('结果格式异常提示更新应用并保留已存结果，不误导用户修改账户或反复重载', async () => {
    const snapshot = syntheticSnapshot(); const { client, calls } = mockClient({ loaded: snapshot });
    calls.loadAll.mockRejectedValue(new ReceiptGroupingValidationError());
    render(<ReceiptGroupingPanel {...props(snapshot, { client, autoExtract: true })} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '交易对手结果格式不兼容，请更新应用后重试。 本机已保存的结果仍保留。');
    expect(screen.getByText('请按上方提示处理后，重新载入已保存结果。')).toBeTruthy();
    expect(screen.queryByText(/检查填写内容|本机已保存的结果仍可重新载入继续/)).toBeNull();
    expect(calls.refreshAll).not.toHaveBeenCalled();
  });

  it('首次进入仅在 prepare 返回待提取时自动 load 后 refresh，并且同一回合只 refresh 一次', async () => {
    const pending = syntheticSnapshot(); pending.header.counts.extraction_pending = 1; pending.items[0].extraction_state = 'pending';
    const ready = copy(pending); ready.header.counts.extraction_pending = 0; ready.items[0].extraction_state = 'ready';
    const { client, calls } = mockClient({ prepared: pending, loaded: pending, refreshed: ready }); const onSnapshotChange = vi.fn();
    const view = render(<ReceiptGroupingPanel {...props(pending, { client, onSnapshotChange, autoExtract: true })} />);
    await waitFor(() => expect(calls.refreshAll).toHaveBeenCalledTimes(1));
    expect(calls.prepare).toHaveBeenCalledTimes(1); expect(calls.loadAll).toHaveBeenCalledTimes(1); expect(onSnapshotChange).toHaveBeenCalledWith(null); expect(onSnapshotChange).toHaveBeenLastCalledWith(ready);
    view.rerender(<ReceiptGroupingPanel {...props(pending, { client, onSnapshotChange, autoExtract: true })} />); await Promise.resolve();
    expect(calls.prepare).toHaveBeenCalledTimes(1); expect(calls.refreshAll).toHaveBeenCalledTimes(1);
  });

  it('active=false 时零调用，重新进入后才 prepare', async () => {
    const snapshot = syntheticSnapshot(); const { client, calls } = mockClient({ loaded: snapshot });
    const view = render(<ReceiptGroupingPanel {...props(snapshot, { client, active: false })} />); await Promise.resolve();
    expect(calls.prepare).not.toHaveBeenCalled(); expect(calls.loadAll).not.toHaveBeenCalled(); expect(calls.refreshAll).not.toHaveBeenCalled();
    view.rerender(<ReceiptGroupingPanel {...props(snapshot, { client, active: true })} />); await waitFor(() => expect(calls.prepare).toHaveBeenCalledTimes(1));
  });

  it('审核依据变化立即失效，inactive 不重提取，重新 active 后载入并保留提示', async () => {
    const original = syntheticSnapshot(); const changed = copy(original); changed.items[0].binding.review_record_revision = 1;
    const { client, calls } = mockClient({ loaded: original }); calls.prepare.mockResolvedValueOnce(original.header).mockResolvedValueOnce(changed.header); calls.loadAll.mockResolvedValueOnce(original).mockResolvedValueOnce(changed);
    const onSnapshotChange = vi.fn(); const view = render(<ReceiptGroupingPanel {...props(original, { client, onSnapshotChange })} />);
    await waitFor(() => expect(onSnapshotChange).toHaveBeenLastCalledWith(original));
    view.rerender(<ReceiptGroupingPanel {...props(changed, { client, onSnapshotChange, active: false })} />);
    expect(onSnapshotChange).toHaveBeenLastCalledWith(null); expect(calls.prepare).toHaveBeenCalledTimes(1); expect(screen.getByText('分割或审核依据已变化，需要重新核对；人工决定请检查。')).toBeTruthy();
    view.rerender(<ReceiptGroupingPanel {...props(changed, { client, onSnapshotChange, active: true })} />); await waitFor(() => expect(calls.prepare).toHaveBeenCalledTimes(2));
    expect(screen.getByText('分割或审核依据已变化，需要重新核对；人工决定请检查。')).toBeTruthy();
  });

  it('稳定快照返回审核或导出时不重复 prepare/refresh，active=false 且 disabled 不清除快照', async () => {
    const snapshot = syntheticSnapshot(); const { client, calls } = mockClient({ loaded: snapshot }); const onSnapshotChange = vi.fn();
    const view = render(<ReceiptGroupingPanel {...props(snapshot, { client, onSnapshotChange })} />); await waitFor(() => expect(onSnapshotChange).toHaveBeenLastCalledWith(snapshot));
    view.rerender(<ReceiptGroupingPanel {...props(snapshot, { client, onSnapshotChange, active: false, disabled: true })} />); await Promise.resolve();
    expect(calls.prepare).toHaveBeenCalledTimes(1); expect(calls.refreshAll).not.toHaveBeenCalled(); expect(onSnapshotChange).toHaveBeenLastCalledWith(snapshot); expect(screen.queryByText('尚未载入交易对手核对数据')).toBeNull();
  });

  it('使用无折叠、无分页的目录和连续列表，点击行仅聚焦不回查', async () => {
    const user = userEvent.setup(); const snapshot = syntheticSnapshot(2); const { client } = mockClient({ loaded: snapshot }); const locate = vi.fn();
    render(<ReceiptGroupingPanel {...props(snapshot, { client, onSelectSegment: locate })} />); await screen.findByRole('navigation', { name: '分组筛选' });
    expect(screen.queryByText(/展开分组核对|收起分组核对|上一页|下一页/)).toBeNull(); await user.click(screen.getByText(/source\.pdf · 第 1 页/)); expect(locate).not.toHaveBeenCalled(); expect(screen.getByText('当前去向')).toBeTruthy();
  });

  it('点击回单显示父级原件预览，回查按钮才调用 onSelectSegment', async () => {
    const user = userEvent.setup(); const snapshot = syntheticSnapshot(); const { client } = mockClient({ loaded: snapshot }); const locate = vi.fn(); const preview = vi.fn((id: string) => <div data-testid="receipt-preview">预览 {id}</div>);
    render(<ReceiptGroupingPanel {...props(snapshot, { client, onSelectSegment: locate, renderPreview: preview })} />); await screen.findByText('预览 ' + snapshot.items[0].binding.segment_id); expect(preview).toHaveBeenCalledWith(snapshot.items[0].binding.segment_id, expect.objectContaining({ controls: expect.anything() }));
    await user.click(screen.getByRole('button', { name: '回查分割审核定位' })); expect(locate).toHaveBeenCalledWith(snapshot.items[0].binding.segment_id);
  });

  it('打开右栏动作表单后定位到表单并聚焦首个输入', async () => {
    const user = userEvent.setup(); const snapshot = syntheticSnapshot(); const { client } = mockClient({ loaded: snapshot });
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView'); const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      render(<ReceiptGroupingPanel {...props(snapshot, { client })} />); await user.click(await screen.findByRole('button', { name: '更多工具' })); await user.click(screen.getByRole('button', { name: '核对收付款资料' }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('修正字段所属方'))); expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    } finally {
      if (previous) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previous); else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('保存字段修正携带 CAS basis fingerprint，保存期间核心操作受保护', async () => {
    const user = userEvent.setup(); const snapshot = syntheticSnapshot(); const { client, calls } = mockClient({ loaded: snapshot }); const pendingSave = deferred<ReceiptGroupingSnapshot>(); calls.save.mockReturnValueOnce(pendingSave.promise);
    render(<ReceiptGroupingPanel {...props(snapshot, { client, onSelectSegment: vi.fn() })} />); await user.click(await screen.findByRole('button', { name: '更多工具' })); await user.click(screen.getByRole('button', { name: '核对收付款资料' })); await user.selectOptions(screen.getByLabelText('修正字段所属方'), 'payer'); await user.clear(screen.getByLabelText('字段修正值'));  await user.type(screen.getByLabelText('字段修正值'), '人工名称'); await user.type(screen.getByLabelText('字段修正备注'), '查看原件抬头'); await user.click(screen.getByRole('button', { name: '保存字段修正' }));
    await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1)); expect(calls.save.mock.calls[0][1][0]).toMatchObject({ segment_id: snapshot.items[0].binding.segment_id, expected_basis_fingerprint: snapshot.items[0].basis_fingerprint }); expect((screen.getByRole('button', { name: '回查分割审核定位' }) as HTMLButtonElement).disabled).toBe(true);
    pendingSave.resolve({ header: { ...snapshot.header, grouping_revision: 2 }, items: snapshot.items }); calls.loadAll.mockResolvedValueOnce(snapshot); await waitFor(() => expect((screen.getByRole('button', { name: '回查分割审核定位' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('批量选择严格限制为 200 张，并保留每个片段的来源信息', async () => {
    const snapshot = syntheticSnapshot(201); const { client } = mockClient({ loaded: snapshot }); render(<ReceiptGroupingPanel {...props(snapshot, { client })} />); const selectVisible = await screen.findByLabelText('勾选前 200 张（批量上限）'); await userEvent.setup().click(selectVisible);
    expect(screen.getByText('已选 200 / 200（批量上限）')).toBeTruthy(); expect(screen.getByText(/source\.pdf · 第 1 页 · 第 1 栏/)).toBeTruthy();
  });

  it('切换未选中的待确认片段会清空上一张的本方确认上下文', async () => {
    const user = userEvent.setup(); const snapshot = syntheticSnapshot(2);
    for (const item of snapshot.items) { item.route = 'own_pending'; item.group = null; item.own_decision = { status: 'pending', method: 'none', side: null, source_bank_status: 'unknown', reasons: ['source_bank_unknown'] }; }
    snapshot.header.counts.own_pending = 2; snapshot.header.counts.assigned = 0;
    const { client } = mockClient({ loaded: snapshot }); render(<ReceiptGroupingPanel {...props(snapshot, { client })} />);
    await screen.findByRole('button', { name: '本方确认' }); await user.click(screen.getByRole('button', { name: '本方确认' })); await user.click(screen.getByLabelText('我已核实，所选回单属于本批公司及所选账户')); await user.click(screen.getByLabelText('已核对回单出具银行，确认是本批来源银行')); await user.type(screen.getByLabelText('本方确认备注'), '第一张依据');
    await user.click(screen.getByText(/source\.pdf · 第 2 页/));
    expect(screen.queryByLabelText('本方确认备注')).toBeNull();
    await user.click(screen.getByRole('button', { name: '本方确认' }));
    expect((screen.getByLabelText('我已核实，所选回单属于本批公司及所选账户') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('已核对回单出具银行，确认是本批来源银行') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('本方确认备注') as HTMLInputElement).value).toBe('');
  });

  it('本方未确认时不把任一付款方或收款方误称为交易对手', async () => {
    const snapshot = syntheticSnapshot(); snapshot.items[0].route = 'own_pending'; snapshot.items[0].group = null; snapshot.items[0].counterparty = null; snapshot.items[0].own_decision = { status: 'pending', method: 'none', side: null, source_bank_status: 'unknown', reasons: [] }; snapshot.header.counts.own_pending = 1; snapshot.header.counts.assigned = 0;
    const { client } = mockClient({ loaded: snapshot }); render(<ReceiptGroupingPanel {...props(snapshot, { client })} />);
    await screen.findByText('确认本方后，将在这里显示交易对手资料。'); expect(screen.queryByText('当前交易对手合成对手')).toBeNull();
  });

  it('本方已确认但缺少 side 和交易对手时也不兜底为付款方或收款方', async () => {
    const snapshot = syntheticSnapshot(); const item = snapshot.items[0]; item.route = 'blank'; item.group = null; item.counterparty = null; item.extracted = null; item.own_decision.side = null;
    const { client } = mockClient({ loaded: snapshot }); render(<ReceiptGroupingPanel {...props(snapshot, { client })} />);
    await screen.findByText('当前交易对手'); expect(screen.getAllByText('尚未提取。').length).toBeGreaterThan(0); expect(screen.queryByText('合成对手')).toBeNull();
  });

  it('在途响应过期时不发布旧 snapshot，也不显示旧结果为已完成', async () => {
    const snapshot = syntheticSnapshot(); const preparation = deferred<typeof snapshot.header>(); const { client, calls } = mockClient({ loaded: snapshot }); calls.prepare.mockReturnValueOnce(preparation.promise); const onSnapshotChange = vi.fn();
    const view = render(<ReceiptGroupingPanel {...props(snapshot, { client, onSnapshotChange })} />); await waitFor(() => expect(calls.prepare).toHaveBeenCalledTimes(1)); view.rerender(<ReceiptGroupingPanel {...props(snapshot, { client, onSnapshotChange, active: false })} />); preparation.resolve(snapshot.header); await Promise.resolve();
    expect(calls.loadAll).not.toHaveBeenCalled(); expect(onSnapshotChange).toHaveBeenLastCalledWith(null); expect(screen.queryByText('已显示当前筛选的全部 1 张回单')).toBeNull();
  });
});
