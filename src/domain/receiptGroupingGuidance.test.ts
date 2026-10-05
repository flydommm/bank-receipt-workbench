import { describe, expect, it } from 'vitest';
import { syntheticItem } from './receiptGrouping.testFixtures';
import { canEditDirectCounterparty, consistentOwnSide, groupingGuidance, groupingItemSummary, hasGroupingProfileConflict, ownConfirmationBlocked } from './receiptGroupingGuidance';

function pending(reason: string, side: 'payer' | 'payee' | null = 'payer') {
  const item = syntheticItem();
  item.route = 'own_pending'; item.group = null; item.counterparty = null;
  item.own_decision = { status: 'pending', method: 'none', side, source_bank_status: 'matched', reasons: [reason] };
  return item;
}

describe('分组日常处理提示', () => {
  it('账号已读到但名称冲突时展示名称问题，不误称账号未提供', () => {
    const item = pending('own_company_ambiguous');
    expect(groupingItemSummary(item)).toBe('付款方名称未识别清楚');
    expect(groupingGuidance(item)?.action).toEqual({ kind: 'field', side: 'payer', field: 'name', label: '修正付款方名称' });
    expect(ownConfirmationBlocked(item)).toBe(true);
  });

  it.each(['own_company_mismatch', 'own_account_mismatch', 'source_bank_mismatch', 'both_sides_match_our_account', 'own_side_conflict'])(
    '%s 不能用普通本方确认跳过', (reason) => expect(ownConfirmationBlocked(pending(reason))).toBe(true));

  it('无本方侧别的缺账号不猜付款方，有侧别才能准确跳转账号', () => {
    expect(groupingGuidance(pending('own_account_missing', null))?.action.kind).toBe('own');
    expect(consistentOwnSide([pending('own_account_missing', null)])).toBe('');
    expect(groupingGuidance(pending('own_account_missing', 'payee'))?.action).toMatchObject({ kind: 'field', side: 'payee', field: 'account' });
  });

  it('来源银行不明引导核对，来源银行冲突不能伪装成开户行字段修正', () => {
    expect(groupingGuidance(pending('source_bank_unknown'))?.action.kind).toBe('own');
    expect(groupingGuidance(pending('source_bank_mismatch'))?.action.kind).toBe('source');
  });

  it('对手名称问题统一进入交易对手修改，不要求选择收付款方向', () => {
    const item = syntheticItem(); item.route = 'counterparty_pending'; item.warnings = ['counterparty_name_ambiguous'];
    expect(groupingGuidance(item)?.action).toEqual({ kind: 'field', side: 'counterparty', field: 'name', label: '修改交易对手' });
    expect(groupingItemSummary(item)).toBe('交易对手名称未识别清楚');
  });

  it.each(['payer', 'payee', 'single', null] as const)('本方侧别 %s 下的缺名仍使用同一个修改入口', (side) => {
    const item = syntheticItem(); item.route = 'counterparty_pending'; item.own_decision.side = side;
    item.warnings = ['counterparty_name_missing'];
    expect(groupingGuidance(item)?.action).toEqual({ kind: 'field', side: 'counterparty', field: 'name', label: '修改交易对手' });
  });

  it('未提取完成优先继续提取，不能直接确认；已排除不提示处理', () => {
    const item = pending('own_account_missing'); item.extraction_state = 'pending';
    expect(groupingGuidance(item)?.action.kind).toBe('refresh');
    expect(ownConfirmationBlocked(item)).toBe(true);
    item.route = 'excluded'; expect(groupingGuidance(item)).toBeNull();
  });

  it('已确认对方账号区分原件空白、尚未读到和识别冲突', () => {
    const item = syntheticItem();
    for (const [state, expected] of [['blank', '对方账号：原件空白'], ['missing', '对方账号尚未读到'], ['ambiguous', '对方账号未识别清楚']] as const) {
      item.counterparty!.account = { ...item.counterparty!.account, state, value: '' };
      expect(groupingItemSummary(item)).toBe(expected);
    }
  });

  it('批量同侧才预选；混合侧别或任意未知侧别须用户选择', () => {
    expect(consistentOwnSide([pending('source_bank_unknown'), pending('source_bank_unknown')])).toBe('payer');
    expect(consistentOwnSide([pending('source_bank_unknown'), pending('source_bank_unknown', 'payee')])).toBe('');
    expect(consistentOwnSide([pending('source_bank_unknown'), pending('source_bank_unknown', null)])).toBe('');
  });

  it('批次本方缺账号或来源不明只需核对交易对手，不再要求逐张确认本方', () => {
    const item = syntheticItem(); item.route = 'counterparty_pending'; item.counterparty = null;
    item.own_decision = { status: 'confirmed', method: 'batch_profile', side: null, source_bank_status: 'unknown', reasons: ['own_account_missing', 'source_bank_unknown'] };
    expect(groupingGuidance(item)?.action).toEqual({ kind: 'field', side: 'counterparty', field: 'name', label: '修改交易对手' });
    expect(canEditDirectCounterparty(item)).toBe(true);
    expect(hasGroupingProfileConflict(item)).toBe(false);
    item.own_decision.reasons.push('own_company_mismatch');
    expect(hasGroupingProfileConflict(item)).toBe(true);
    expect(groupingGuidance(item)?.action.kind).toBe('field');
  });

  it('批次本方在已知一侧时仍统一修改交易对手，内部和特殊分类不要求补账号', () => {
    const item = syntheticItem(); item.route = 'counterparty_pending';
    item.own_decision = { ...item.own_decision, method: 'batch_profile', side: 'payee', source_bank_status: 'unknown' };
    expect(groupingGuidance(item)?.action).toMatchObject({ side: 'counterparty', field: 'name', label: '修改交易对手' });
    expect(canEditDirectCounterparty(item)).toBe(false);
    item.route = 'internal'; expect(groupingGuidance(item)).toBeNull();
    item.route = 'special'; item.own_decision.side = null;
    expect(groupingGuidance(item)).toBeNull(); expect(groupingItemSummary(item)).toBe('已按凭证类型整理');
  });

  it.each([
    ['source_bank_mismatch', 'source', undefined],
    ['own_company_mismatch', 'field', 'name'],
    ['own_account_mismatch', 'field', 'account'],
    ['both_sides_match_our_account', 'field', 'account'],
    ['own_side_conflict', 'field', 'account'],
  ])('批次明确矛盾 %s 定位实际问题，不要求逐张本方确认', (reason, kind, field) => {
    const item = syntheticItem(); item.route = 'counterparty_pending';
    item.own_decision = { status: 'confirmed', method: 'batch_profile', side: 'payer', source_bank_status: 'matched', reasons: [reason] };
    const guidance = groupingGuidance(item)!;
    expect(guidance.action.kind).toBe(kind);
    if (guidance.action.kind === 'field') expect(guidance.action).toMatchObject({ side: 'payer', field });
    expect(guidance.instruction).toContain('暂不处理也可保留待确认');
    expect(guidance.action.kind).not.toBe('own');
  });

  it('批次本方名称读取不清但已有可靠侧别及对手时不增加人工处理门槛', () => {
    const item = syntheticItem();
    item.own_decision = { status: 'confirmed', method: 'batch_profile', side: 'payer', source_bank_status: 'matched', reasons: ['own_company_ambiguous'] };
    expect(groupingGuidance(item)).toBeNull();
    expect(hasGroupingProfileConflict(item)).toBe(false);
  });
});
