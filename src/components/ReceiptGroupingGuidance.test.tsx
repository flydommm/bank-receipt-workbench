// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syntheticReview, syntheticSnapshot } from '../domain/receiptGrouping.testFixtures';
import type { GroupingEdit, ReceiptGroupingSnapshot } from '../domain/receiptGrouping';
import type { ReceiptGroupingClient } from '../services/receiptGroupingClient';
import { ReceiptGroupingPanel } from './ReceiptGroupingPanel';

function pending(count = 1, reason = 'own_company_ambiguous') {
  const snapshot = structuredClone(syntheticSnapshot(count));
  snapshot.header.counts.own_pending = count; snapshot.header.counts.assigned = 0;
  for (const item of snapshot.items) {
    item.route = 'own_pending'; item.group = null; item.counterparty = null;
    item.own_decision = { status: 'pending', method: 'none', side: 'payer', source_bank_status: 'matched', reasons: [reason] };
    if (reason === 'own_company_ambiguous') item.extracted!.payer.name.state = 'ambiguous';
  }
  return snapshot;
}

function setup(snapshot: ReceiptGroupingSnapshot, next = snapshot) {
  const calls = {
    prepare: vi.fn().mockResolvedValue(snapshot.header),
    loadAll: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValue(next),
    save: vi.fn().mockResolvedValue(next), refreshAll: vi.fn().mockResolvedValue(next),
  };
  const onSelectSegment = vi.fn();
  render(<ReceiptGroupingPanel jobId={snapshot.header.job_id} resultRevision={snapshot.header.result_revision!}
    reviewItems={snapshot.items.map(syntheticReview)} client={calls as unknown as ReceiptGroupingClient}
    autoExtract={false} onSnapshotChange={vi.fn()} onSelectSegment={onSelectSegment}
    renderPreview={(_id, { controls }) => <div>{controls}合成原件预览</div>} />);
  return { calls, onSelectSegment };
}

const identityCheckbox = '我已核实，所选回单属于本批公司及所选账户';
const bankCheckbox = '已核对回单出具银行，确认是本批来源银行';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('分组需要处理卡与简单确认', () => {
  it('真实名称问题显示在列表和处理卡；已提取账号可查，技术内容默认折叠', async () => {
    const user = userEvent.setup(); setup(pending());
    const guidance = await screen.findByRole('region', { name: '需要您处理' });
    expect(within(guidance).getByText('付款方名称未识别清楚')).toBeTruthy();
    expect(screen.queryByText('账号未提供')).toBeNull();
    expect(within(screen.getByRole('region', { name: '连续回单列表' })).getByText('付款方名称未识别清楚')).toBeTruthy();
    const technical = screen.getByText('技术详情（排查时查看）').closest('details')!;
    expect(technical.open).toBe(false);
    await user.click(screen.getByText('查看收付款双方资料'));
    const details = screen.getByText('查看收付款双方资料').closest('details')!;
    expect(within(details).getAllByText('账号：00000999').length).toBe(2);
    expect(screen.queryByRole('button', { name: '本方确认' })).toBeNull();
    expect(screen.queryByRole('button', { name: '移组／拆组' })).toBeNull();
  });

  it('快捷修正仅当前这一张，在原件前直接编辑目标字段，不随复选框批量且备注可空', async () => {
    const user = userEvent.setup(); const snapshot = pending(2);
    const next = structuredClone(snapshot);
    next.items[0].own_decision = { status: 'confirmed', method: 'account_match', side: 'payer', source_bank_status: 'matched', reasons: [] };
    next.items[0].route = 'counterparty_pending'; next.items[0].warnings = ['counterparty_name_ambiguous'];
    next.items[0].extracted!.payer.name = { ...next.items[0].extracted!.payer.name, state: 'present', value: '合成测试公司' };
    next.header.counts.own_pending = 1; next.header.counts.counterparty_pending = 1;
    const { calls } = setup(snapshot, next);
    await user.click(await screen.findByLabelText('勾选前 2 张（批量上限）'));
    await user.click(screen.getByRole('button', { name: '修正付款方名称' }));
    const input = screen.getByLabelText('字段修正值');
    expect(document.activeElement).toBe(input);
    expect(screen.queryByLabelText('修正字段所属方')).toBeNull();
    expect(screen.getByRole('group', { name: '只修正当前这一张 · 付款方名称' })).toBeTruthy();
    expect(screen.getByText('补充说明（选填）').closest('details')!.open).toBe(false);
    expect(screen.getByRole('region', { name: '需要您处理' }).contains(input)).toBe(true);
    expect(screen.getByText('合成原件预览')).toBeTruthy();
    await user.clear(input); await user.type(input, '合成测试公司');
    await user.click(screen.getByRole('button', { name: '保存字段修正' }));
    await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
    const edits = calls.save.mock.calls[0][1] as GroupingEdit[];
    expect(edits).toHaveLength(1);
    expect(Object.keys(edits[0]).sort()).toEqual(['expected_basis_fingerprint', 'field_overrides', 'segment_id']);
    expect(edits[0]).toMatchObject({ segment_id: snapshot.items[0].binding.segment_id,
      field_overrides: [{ side: 'payer', field: 'name', value: '合成测试公司', state: 'present', reason: '用户对照原件修正付款方名称。' }] });
    await waitFor(() => expect(within(screen.getByRole('region', { name: '需要您处理' })).getByText('交易对手名称未识别清楚')).toBeTruthy());
    expect(screen.queryByLabelText('字段修正值')).toBeNull();
  });

  it('取消快捷修正不保存，切到下一张不沿用上一张的字段目标', async () => {
    const user = userEvent.setup(); const snapshot = pending(2); snapshot.items[1].own_decision.side = 'payee';
    const { calls } = setup(snapshot);
    await user.click(await screen.findByRole('button', { name: '修正付款方名称' }));
    await user.click(screen.getByRole('button', { name: '取消修正' }));
    expect(screen.queryByLabelText('字段修正值')).toBeNull(); expect(calls.save).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '修正付款方名称' }));
    await user.click(screen.getByRole('button', { name: '下一张' }));
    expect(screen.queryByLabelText('字段修正值')).toBeNull();
    expect(screen.getByRole('button', { name: '修正收款方名称' })).toBeTruthy();
  });

  it('未知本方位置必须主动选择且勾两项；备注为空也可确认当前这一张', async () => {
    const user = userEvent.setup(); const snapshot = pending(1, 'own_account_missing'); snapshot.items[0].own_decision.side = null;
    const { calls } = setup(snapshot);
    await user.click(await screen.findByRole('button', { name: '核对本方位置' }));
    expect(screen.getByRole('group', { name: '确认当前这一张' })).toBeTruthy();
    expect((screen.getByLabelText('本方所在一侧') as HTMLSelectElement).value).toBe('');
    const save = screen.getByRole('button', { name: '保存本方确认' }) as HTMLButtonElement;
    await user.click(screen.getByLabelText(identityCheckbox)); await user.click(screen.getByLabelText(bankCheckbox));
    expect(save.disabled).toBe(true); expect(calls.save).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('本方所在一侧'), 'payer');
    expect(save.disabled).toBe(false); await user.click(save);
    await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
    const edits = calls.save.mock.calls[0][1] as GroupingEdit[];
    expect(edits).toHaveLength(1);
    expect(edits[0].own_confirmation).toMatchObject({ side: 'payer', confirms_selected_account: true, confirms_source_bank: true,
      reason: expect.stringContaining('用户已对照原件确认本方为付款方') });
  });

  it.each(['payer', 'single'])('账号缺失时的 %s 确认记录只说明账户归属，不声称读到了完整账号', async (side) => {
    const user = userEvent.setup(); const snapshot = pending(1, 'own_account_missing');
    const item = snapshot.items[0]; item.own_decision.side = null;
    for (const party of [item.extracted!.payer, item.extracted!.payee]) party.account = { ...party.account, state: 'missing', raw: '', value: '' };
    const { calls } = setup(snapshot);
    await user.click(await screen.findByRole('button', { name: '核对本方位置' }));
    expect(screen.getByText('未读到完整账号时，也需核实这张凭证属于哪个账户；无法确定请保留待确认。')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('本方所在一侧'), side);
    await user.click(screen.getByLabelText(identityCheckbox)); await user.click(screen.getByLabelText(bankCheckbox));
    await user.click(screen.getByRole('button', { name: '保存本方确认' }));
    await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
    const confirmation = (calls.save.mock.calls[0][1] as GroupingEdit[])[0].own_confirmation!;
    expect(confirmation.side).toBe(side);
    expect(confirmation.reason).toContain('已核实凭证属于本批公司所选账户');
    expect(confirmation.reason).not.toContain('完整');
    expect(confirmation.reason).not.toContain('原件空白');
  });

  it('批量本方确认明确范围并只保存勾选项，同侧自动预选；混侧不能默认付款方', async () => {
    const user = userEvent.setup(); const snapshot = pending(3, 'source_bank_unknown'); snapshot.items[2].own_decision.side = 'payee';
    const { calls } = setup(snapshot);
    await screen.findByRole('navigation', { name: '分组筛选' });
    await user.click(screen.getByLabelText('选择 source.pdf · 第 1 页 · 第 1 栏'));
    await user.click(screen.getByLabelText('选择 source.pdf · 第 3 页 · 第 1 栏'));
    await user.click(screen.getByRole('button', { name: '本方确认' }));
    expect(screen.getByRole('group', { name: '确认已勾选 2 张' })).toBeTruthy();
    expect((screen.getByLabelText('本方所在一侧') as HTMLSelectElement).value).toBe('');
    await user.click(screen.getByLabelText('选择 source.pdf · 第 3 页 · 第 1 栏'));
    await user.click(screen.getByLabelText('选择 source.pdf · 第 2 页 · 第 1 栏'));
    expect((screen.getByLabelText('本方所在一侧') as HTMLSelectElement).value).toBe('payer');
    await user.click(screen.getByLabelText(identityCheckbox)); await user.click(screen.getByLabelText(bankCheckbox));
    await user.click(screen.getByRole('button', { name: '保存本方确认' }));
    await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
    expect((calls.save.mock.calls[0][1] as GroupingEdit[]).map((edit) => edit.segment_id)).toEqual(snapshot.items.slice(0, 2).map((item) => item.binding.segment_id));
  });

  it.each(['own_company_ambiguous', 'own_company_mismatch', 'own_account_mismatch', 'source_bank_mismatch'])(
    '%s 不提供普通确认捷径', async (reason) => {
      const { calls } = setup(pending(1, reason));
      await screen.findByRole('region', { name: '需要您处理' });
      expect(screen.queryByRole('button', { name: '本方确认' })).toBeNull();
      expect(screen.queryByRole('button', { name: '保存本方确认' })).toBeNull();
      expect(calls.save).not.toHaveBeenCalled();
    });

  it('已经打开确认表单后混入冲突回单，仍不能保存', async () => {
    const user = userEvent.setup(); const snapshot = pending(2, 'source_bank_unknown'); snapshot.items[1].own_decision.reasons = ['own_company_ambiguous'];
    const { calls } = setup(snapshot);
    await user.click(await screen.findByRole('button', { name: '本方确认' }));
    await user.click(screen.getByLabelText('勾选前 2 张（批量上限）'));
    await user.click(screen.getByLabelText(identityCheckbox)); await user.click(screen.getByLabelText(bankCheckbox));
    expect((screen.getByRole('button', { name: '保存本方确认' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('本方确认不能跳过');
    expect(calls.save).not.toHaveBeenCalled();
  });

  it('尚未提取的处理卡可继续提取，来源冲突只能回查且不提交人工覆盖', async () => {
    const user = userEvent.setup(); const snapshot = pending(); snapshot.items[0].extraction_state = 'pending';
    const ready = pending(1, 'source_bank_mismatch'); const { calls, onSelectSegment } = setup(snapshot, ready);
    await user.click(await screen.findByRole('button', { name: '继续提取当前批次字段' }));
    await waitFor(() => expect(calls.refreshAll).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole('button', { name: '回查回单来源' }));
    expect(onSelectSegment).toHaveBeenCalledWith(snapshot.items[0].binding.segment_id);
    expect(calls.save).not.toHaveBeenCalled();
  });

  it('已确认特殊凭证按类型整理，不因对方账号未读到继续提示欠补资料', async () => {
    const snapshot = structuredClone(syntheticSnapshot()); const item = snapshot.items[0];
    item.route = 'special'; item.group = { ...item.group!, kind: 'special', display_name: 'electronic_tax_payment' };
    item.counterparty!.account = { ...item.counterparty!.account, state: 'missing', value: '' };
    setup(snapshot);
    await screen.findByRole('navigation', { name: '分组筛选' });
    expect(screen.getByText('凭证分类')).toBeTruthy();
    expect(screen.queryByText('electronic_tax_payment')).toBeNull();
    expect(screen.getAllByText('电子缴税付款凭证').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('按此类型归组，无需补填对方账号。')).toBeTruthy();
    expect(screen.getAllByText(/已按凭证类型整理/)).toHaveLength(2);
    expect(screen.queryByText('对方账号尚未读到')).toBeNull();
    expect(screen.queryByRole('region', { name: '需要您处理' })).toBeNull();
    expect(screen.queryByText('当前交易对手')).toBeNull();
  });
});
