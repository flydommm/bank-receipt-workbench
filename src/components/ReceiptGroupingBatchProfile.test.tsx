// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syntheticReview, syntheticSnapshot } from '../domain/receiptGrouping.testFixtures';
import type { GroupingEdit, ReceiptGroupingSnapshot } from '../domain/receiptGrouping';
import type { ReceiptGroupingClient } from '../services/receiptGroupingClient';
import { ReceiptGroupingPanel } from './ReceiptGroupingPanel';

function batchSnapshot(count = 1): ReceiptGroupingSnapshot {
  const result = structuredClone(syntheticSnapshot(count));
  result.header.counts.assigned = 0; result.header.counts.counterparty_pending = count;
  for (const item of result.items) {
    item.own_decision = { status: 'confirmed', method: 'batch_profile', side: null, source_bank_status: 'unknown', reasons: ['own_account_missing'] };
    item.route = 'counterparty_pending'; item.group = { ...item.group!, kind: 'counterparty_pending', display_name: '交易对手待确认' };
    item.counterparty = null;
  }
  return result;
}

function setup(snapshot: ReceiptGroupingSnapshot, next = snapshot) {
  const calls = { prepare: vi.fn().mockResolvedValue(snapshot.header), loadAll: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValue(next),
    refreshAll: vi.fn().mockResolvedValue(next), save: vi.fn().mockResolvedValue(next) };
  const onExport = vi.fn();
  render(<ReceiptGroupingPanel jobId={snapshot.header.job_id} resultRevision={snapshot.header.result_revision!}
    reviewItems={snapshot.items.map(syntheticReview)} client={calls as unknown as ReceiptGroupingClient}
    onSnapshotChange={vi.fn()} onExport={onExport} canExport autoExtract={false} renderPreview={(_id, { controls }) => <div>{controls}<span>合成原件</span></div>} />);
  return { calls, onExport };
}

afterEach(cleanup);
describe('本方采用批次资料后的交易对手核对', () => {
  it('零本方待确认不占目录，未知收付款侧可直接修正对手名称且不提交身份确认', async () => {
    const user = userEvent.setup(); const snapshot = batchSnapshot(); const next = structuredClone(syntheticSnapshot());
    next.items[0].own_decision = snapshot.items[0].own_decision;
    const { calls } = setup(snapshot, next);
    await screen.findByRole('navigation', { name: '分组筛选' });
    expect(screen.getByText('本方按本批资料')).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: '分组筛选' })).queryByRole('button', { name: /本方待确认/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '本方确认' })).toBeNull();
    expect(screen.queryByLabelText('本方所在一侧')).toBeNull();
    await user.click(screen.getByRole('button', { name: '修改交易对手' }));
    expect(screen.getByRole('form', { name: '修改交易对手' })).toBeTruthy();
    const input = screen.getByLabelText('交易对手名称');
    expect((input as HTMLInputElement).value).toBe('');
    await user.type(input, '合成对手公司'); await user.click(screen.getByRole('button', { name: '保存当前 1 张' }));
    await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
    const edits = calls.save.mock.calls[0][1] as GroupingEdit[];
    expect(edits).toHaveLength(1);
    expect(edits[0].field_overrides).toEqual([{ side: 'counterparty', field: 'name', state: 'present', value: '合成对手公司', reason: '用户对照原件修改交易对手名称。' }]);
    expect(edits[0]).not.toHaveProperty('own_confirmation');
  });

  it('通用修改入口在侧别未知时默认对手名称，不要求用户再选择本方', async () => {
    const user = userEvent.setup(); setup(batchSnapshot());
    await user.click(await screen.findByRole('button', { name: '修改交易对手' }));
    expect(screen.getByRole('form', { name: '修改交易对手' })).toBeTruthy();
    expect(screen.queryByLabelText('本方所在一侧')).toBeNull();
  });

  it('明确资料矛盾集中计数且可定位，不阻挡导出入口或要求逐张身份确认', async () => {
    const user = userEvent.setup(); const snapshot = batchSnapshot(3);
    snapshot.items[0].own_decision.reasons = ['source_bank_mismatch']; snapshot.items[0].own_decision.source_bank_status = 'mismatch';
    snapshot.items[0].warnings = ['batch_identity_conflict'];
    snapshot.items[1].own_decision.reasons = ['own_company_mismatch'];
    const { onExport } = setup(snapshot);
    await screen.findByLabelText('本批资料差异提示');
    expect(screen.getByText(/有 2 张回单的公司、账号或银行与本批资料不一致/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '查看这 2 张' }));
    expect(screen.getByText('当前 2 张')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '本方确认' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '检查并导出' }));
    expect(onExport).toHaveBeenCalledOnce();
  });

  it('确认的特殊凭证侧别未知仍按中文类型整理，不追索本方或对方账号', async () => {
    const snapshot = batchSnapshot(); const item = snapshot.items[0];
    item.route = 'special'; item.group = { ...item.group!, kind: 'special', display_name: 'electronic_tax_payment' };
    snapshot.header.counts.counterparty_pending = 0; snapshot.header.counts.assigned = 1;
    setup(snapshot);
    await screen.findByRole('navigation', { name: '分组筛选' });
    expect(screen.getAllByText('电子缴税付款凭证').length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole('region', { name: '需要您处理' })).toBeNull();
    expect(screen.queryByRole('button', { name: '本方确认' })).toBeNull();
    expect(screen.getByText('按此类型归组，无需补填对方账号。')).toBeTruthy();
  });

  it('内部唯一组不能拆出或移入普通组，普通组也不能手工创建或移入内部组', async () => {
    const user = userEvent.setup(); const snapshot = structuredClone(syntheticSnapshot(2));
    snapshot.items[0].route = 'internal'; snapshot.items[0].group = { ...snapshot.items[0].group!, group_id: 'internal-one', kind: 'internal', display_name: '合成本公司' };
    snapshot.items[1].group!.group_id = 'named-other';
    const { calls } = setup(snapshot);
    await screen.findByRole('navigation', { name: '分组筛选' });
    expect(screen.queryByRole('button', { name: '移组／拆组' })).toBeNull();
    expect(screen.getByText(/本公司内部往来按公司名称统一成组，账号和开户行不拆组/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '下一张' }));
    await user.click(screen.getByRole('button', { name: '更多工具' }));
    await user.click(screen.getByRole('button', { name: '移组／拆组' }));
    expect(screen.queryByLabelText('新组类型')).toBeNull();
    const target = screen.getByLabelText('移入已有组');
    expect(within(target).queryByRole('option', { name: '合成本公司' })).toBeNull();
    await user.click(screen.getByLabelText('勾选前 2 张（批量上限）'));
    await user.type(screen.getByLabelText('分组名称'), '内部改名绕过');
    expect((screen.getByRole('button', { name: '将所选片段拆为新组' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.save).not.toHaveBeenCalled();
  });

  it('批次资料明确冲突引导修正实际本方字段，保存后消除提示且不要求身份确认', async () => {
    const user = userEvent.setup(); const snapshot = batchSnapshot(); const next = structuredClone(syntheticSnapshot());
    snapshot.items[0].own_decision.side = 'payer'; snapshot.items[0].own_decision.reasons = ['own_company_mismatch'];
    snapshot.items[0].warnings = ['batch_identity_conflict'];
    next.items[0].own_decision = { ...snapshot.items[0].own_decision, reasons: [], source_bank_status: 'matched' };
    const { calls } = setup(snapshot, next);
    await user.click(await screen.findByRole('button', { name: '修正付款方名称' }));
    expect(screen.getByRole('group', { name: '只修正当前这一张 · 付款方名称' })).toBeTruthy();
    const input = screen.getByLabelText('字段修正值');
    // Keep the extracted value; the UI must never fill the batch company into the original field.
    expect((input as HTMLInputElement).value).toBe(snapshot.items[0].extracted!.payer.name.value);
    await user.clear(input); await user.type(input, '合成测试公司');
    await user.click(screen.getByRole('button', { name: '保存字段修正' }));
    await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
    expect(calls.save.mock.calls[0][1][0].field_overrides[0].side).toBe('payer');
    expect(calls.save.mock.calls[0][1][0]).not.toHaveProperty('own_confirmation');
    await waitFor(() => expect(screen.queryByLabelText('本批资料差异提示')).toBeNull());
    expect(screen.queryByRole('region', { name: '需要您处理' })).toBeNull();
    expect(screen.queryByRole('button', { name: '本方确认' })).toBeNull();
  });

  it('明确本方账号矛盾却未知侧别时，不把修正目标自动转成交易对手账号', async () => {
    const user = userEvent.setup(); const snapshot = batchSnapshot();
    snapshot.items[0].own_decision.reasons = ['own_account_mismatch'];
    const { calls } = setup(snapshot);
    await user.click(await screen.findByRole('button', { name: '修正本方账号' }));
    expect((screen.getByLabelText('修正字段所属方') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('修正字段') as HTMLSelectElement).value).toBe('account');
    expect((screen.getByRole('button', { name: '保存字段修正' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText('本方所在一侧')).toBeNull();
    expect(calls.save).not.toHaveBeenCalled();
  });
});
