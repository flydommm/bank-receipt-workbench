import { describe, expect, it } from 'vitest';
import { summarizeFieldRuleResults, type FieldRuleResultGroup } from './receiptFieldRuleResults';
import type { FieldRuleDifference } from './receiptFieldRules';

function difference(segment_id: string, after_name: string, after_route: string, status: FieldRuleDifference['status']): FieldRuleDifference {
  return { segment_id, before_name: '', after_name, before_route: 'counterparty_pending', after_route, status, reason: '' };
}

function groupIds(groups: readonly FieldRuleResultGroup[]): string[][] {
  return groups.map((group) => group.rows.map((row) => row.segment_id));
}

describe('字段规则整批结果汇总', () => {
  it('把跨页同名结果按名称和去向合并，并保留同名不同去向', () => {
    const summary = summarizeFieldRuleResults([
      difference('page-1-a', '同名对手', 'named', 'changed'),
      difference('page-2-a', '同名对手', 'named', 'unchanged'),
      difference('page-3-a', '同名对手', 'internal', 'changed'),
      difference('page-4-a', '其他对手', 'named', 'unchanged'),
    ]);

    expect(summary.success).toHaveLength(3);
    expect(summary.success[0]).toMatchObject({ key: JSON.stringify(['同名对手', 'named']), name: '同名对手', route: 'named', count: 2 });
    expect(groupIds(summary.success.slice(0, 2))).toEqual([['page-1-a', 'page-2-a'], ['page-3-a']]);
  });

  it('保留空名称的 blank 与 missing 去向差异，不把它们混成一个组', () => {
    const summary = summarizeFieldRuleResults([
      difference('blank-1', '', 'blank', 'changed'),
      difference('missing-1', '', 'missing', 'changed'),
    ]);

    expect(summary.success).toHaveLength(2);
    expect(summary.success.map((group) => [group.name, group.route, group.count])).toEqual([
      ['', 'blank', 1], ['', 'missing', 1],
    ]);
  });

  it('把 pending 与 skipped 分到独立状态，不能进入可更新或保持组', () => {
    const summary = summarizeFieldRuleResults([
      difference('changed', '可更新', 'named', 'changed'),
      difference('unchanged', '保持', 'named', 'unchanged'),
      difference('pending', '待确认', 'counterparty_pending', 'pending'),
      difference('skipped', '已跳过', 'named', 'skipped'),
    ]);

    expect(summary.success.map((group) => group.rows.map((row) => row.segment_id))).toEqual([['changed'], ['unchanged']]);
    expect(summary.pending.map((group) => group.rows.map((row) => row.segment_id))).toEqual([['pending']]);
    expect(summary.skipped.map((group) => group.rows.map((row) => row.segment_id))).toEqual([['skipped']]);
    expect(summary.success.flatMap((group) => group.rows.map((row) => row.segment_id))).not.toContain('pending');
  });
});
