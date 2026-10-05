import { describe, expect, it } from 'vitest';
import type { FieldOverride, GroupDefinition, GroupingItem } from './receiptGrouping';
import { syntheticItem } from './receiptGrouping.testFixtures';
import { buildCounterpartyEdits, canCorrectCounterparty, isCounterpartyNameValid } from './receiptCounterpartyEdit';

const namedGroup: GroupDefinition = { group_id: 'manual-specific-group', kind: 'named', display_name: '合成银行支行', key: null, manual: true };
const override = (side: FieldOverride['side'], field: FieldOverride['field'], value: string): FieldOverride => ({ side, field, value, state: 'present', reason: '合成已核对修正' });

describe('交易对手统一修改', () => {
  it('混合收付方向及未知方向只替换直接名称覆盖，保留本方和其余修正，不发送本方确认', () => {
    const items = (['payer', 'payee', 'single', null] as const).map((side, index) => {
      const item = syntheticItem(index + 1); item.own_decision.side = side;
      item.field_overrides = [override('payer', 'name', '原付款名称'), override('payer', 'account', '001'),
        override('payee', 'name', '原收款名称'), override('payee', 'bank', '原收款行'),
        override('counterparty', 'account', '009'), override('counterparty', 'bank', '原对手行'),
        override('counterparty', 'name', '旧直接名称')];
      return item;
    });
    const before = structuredClone(items);
    const edits = buildCounterpartyEdits(items, { kind: 'name', name: '  新交易对手  ' });
    expect(edits).toHaveLength(4);
    edits.forEach((edit, index) => {
      expect(edit.segment_id).toBe(items[index].binding.segment_id);
      expect(edit.expected_basis_fingerprint).toBe(items[index].basis_fingerprint);
      expect(edit.field_overrides!.slice(0, -1)).toEqual(items[index].field_overrides.slice(0, -1));
      expect(edit.field_overrides!.at(-1)).toMatchObject({ side: 'counterparty', field: 'name', value: '新交易对手', state: 'present' });
      expect(edit.assignment).toBeNull();
      expect(edit).not.toHaveProperty('own_confirmation');
    });
    expect(items).toEqual(before);
  });

  it('已有组选择同时记录组的明确标识和显示名称，区分同名人工组', () => {
    const one = buildCounterpartyEdits([syntheticItem()], { kind: 'group', group: namedGroup })[0];
    const another = buildCounterpartyEdits([syntheticItem()], { kind: 'group', group: { ...namedGroup, group_id: 'another-same-name' } })[0];
    expect(one.field_overrides!.at(-1)?.value).toBe(namedGroup.display_name);
    expect(one.assignment?.group_id).toBe(namedGroup.group_id);
    expect(another.assignment?.group_id).toBe('another-same-name');
  });

  it('只有显式 blank 操作写入原件空白，同时清除原有人工分组', () => {
    const item = syntheticItem(); item.field_overrides = [override('payer', 'account', '001')];
    const edit = buildCounterpartyEdits([item], { kind: 'blank' })[0];
    expect(edit.field_overrides).toEqual([item.field_overrides[0], expect.objectContaining({ side: 'counterparty', field: 'name', value: '', state: 'blank' })]);
    expect(edit.assignment).toBeNull();
    expect(() => buildCounterpartyEdits([item], { kind: 'name', name: '' })).toThrow();
  });

  it.each(['', '  ', '）', '（）', '…，。!?-', '💰', '名称\0', '名称\n后续', '名'.repeat(257)])('拒绝空白、标点或无效名称 %j', (name) => {
    expect(isCounterpartyNameValid(name)).toBe(false);
    expect(() => buildCounterpartyEdits([syntheticItem()], { kind: 'name', name })).toThrow();
  });
  it.each(['合成银行（测试支行）', 'Test Bank Ltd.', '张某', '账户123', '名'.repeat(256)])('允许有效名称 %s', (name) => {
    expect(isCounterpartyNameValid(name)).toBe(true);
  });

  it.each(['named', 'internal', 'blank', 'counterparty_pending'] as const)('允许 %s 且不把边界审核变成名称修改门槛', (route) => {
    const item = syntheticItem(); item.route = route; item.boundary_status = 'needs_review';
    expect(canCorrectCounterparty(item)).toBe(true);
    expect(buildCounterpartyEdits([item], { kind: 'name', name: '合成对手' })).toHaveLength(1);
  });
  it.each(['bank_fee', 'deposit_interest'] as const)('允许普通回单中的 %s 特殊去向', (service) => {
    const item = syntheticItem(); item.route = 'special'; item.extracted!.service_type = service;
    expect(canCorrectCounterparty(item)).toBe(true);
    item.document_type = 'ordinary'; expect(canCorrectCounterparty(item)).toBe(true);
    item.document_type = 'electronic_tax_payment'; expect(canCorrectCounterparty(item)).toBe(false);
  });
  it.each(['own_company_mismatch', 'own_account_mismatch', 'source_bank_mismatch', 'both_sides_match_our_account', 'own_side_conflict'])('不能用名称修改绕过硬冲突 %s', (reason) => {
    const item = syntheticItem(); item.warnings = [reason];
    expect(canCorrectCounterparty(item)).toBe(false);
    expect(() => buildCounterpartyEdits([syntheticItem(2), item], { kind: 'name', name: '合成对手' })).toThrow();
    item.warnings = []; item.own_decision.reasons = [reason]; expect(canCorrectCounterparty(item)).toBe(false);
  });
  it('拒绝特殊凭证、排除、未就绪和未确认本方，不静默跳过受保护项目', () => {
    const protectedItems: GroupingItem[] = [
      { ...syntheticItem(), route: 'excluded' }, { ...syntheticItem(), route: 'special' },
      { ...syntheticItem(), document_type: 'loan_interest_notice' },
      ...(['pending', 'stale', 'failed'] as const).map((extraction_state) => ({ ...syntheticItem(), extraction_state })),
      { ...syntheticItem(), own_decision: { ...syntheticItem().own_decision, status: 'pending' as const } },
      { ...syntheticItem(), own_decision: { ...syntheticItem().own_decision, source_bank_status: 'mismatch' as const } },
    ];
    protectedItems.forEach((item) => {
      expect(canCorrectCounterparty(item)).toBe(false);
      expect(() => buildCounterpartyEdits([syntheticItem(2), item], { kind: 'blank' })).toThrow();
    });
  });
  it('严格检查 1 至 200 张和重复项，201 张不能悄悄截断', () => {
    const items = Array.from({ length: 201 }, (_, index) => syntheticItem(index + 1));
    expect(buildCounterpartyEdits(items.slice(0, 200), { kind: 'blank' })).toHaveLength(200);
    expect(() => buildCounterpartyEdits([], { kind: 'blank' })).toThrow('1 至 200');
    expect(() => buildCounterpartyEdits(items, { kind: 'blank' })).toThrow('1 至 200');
    expect(() => buildCounterpartyEdits([items[0], items[0]], { kind: 'blank' })).toThrow('重复');
  });
  it('已有分组仅接受有效 named 组', () => {
    for (const group of [{ ...namedGroup, kind: 'internal' as const }, { ...namedGroup, group_id: '' }, { ...namedGroup, display_name: '）' }]) {
      expect(() => buildCounterpartyEdits([syntheticItem()], { kind: 'group', group })).toThrow();
    }
  });
});
