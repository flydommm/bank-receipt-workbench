import { describe, expect, it } from 'vitest';
import { clientPointInSvg, fieldRegionLabel, normalizeFieldSelection, parseFieldRuleDefinition, parseGroupingDiagnostics, parseLocalFieldRule } from './receiptFieldRules';
import { parseGroupingItem } from './receiptGrouping';
import { syntheticSnapshot } from './receiptGrouping.testFixtures';
import { groupingIssueCollections, canConfigureFieldRule } from './receiptGroupingIssues';

describe('本机读取规则合同与坐标', () => {
  it('缩放、偏移和片段裁剪不会改变归一化读取区域', () => {
    const transform = { a: 2.5, b: 0, c: 0, d: 2.5, e: 80, f: -300 };
    const a = clientPointInSvg(330, 700, transform)!;
    const b = clientPointInSvg(830, 950, transform)!;
    expect(normalizeFieldSelection(a, b, { x0: 0, y0: 300, x1: 600, y1: 600 })).toEqual({ x0: 1 / 6, y0: 1 / 3, x1: 0.5, y1: 2 / 3 });
    expect(normalizeFieldSelection(b, a, { x0: 0, y0: 300, x1: 600, y1: 600 })).toEqual(normalizeFieldSelection(a, b, { x0: 0, y0: 300, x1: 600, y1: 600 }));
    expect(clientPointInSvg(0, 0, { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toBeNull();
    expect(normalizeFieldSelection(a, a, { x0: 0, y0: 300, x1: 600, y1: 600 })).toBeNull();
  });
  it('禁止传路径或识别值，收付模式必须分别提供两个名称框', () => {
    const definition = { prototype_segment_id: 'a'.repeat(64), mode: 'direct', fields: [{ role: 'counterparty', field: 'name', rect: { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.3 } }], include_resolved: false };
    expect(parseFieldRuleDefinition(definition).fields).toHaveLength(1);
    expect(() => parseFieldRuleDefinition({ ...definition, path: '/real.pdf' })).toThrow();
    expect(() => parseFieldRuleDefinition({ ...definition, fields: [{ ...definition.fields[0], value: '名称' }] })).toThrow();
    expect(() => parseFieldRuleDefinition({ ...definition, mode: 'sides' })).toThrow();
    expect(() => parseFieldRuleDefinition({ ...definition, fields: [{ ...definition.fields[0], rect: { x0: 0, y0: 0, x1: 1.1, y1: 1 } }] })).toThrow();
  });
  it('接受自动位置模式并保留旧模式；自动标签按位置一二显示', () => {
    const definition = { prototype_segment_id: 'a'.repeat(64), mode: 'auto', fields: [
      { role: 'counterparty', field: 'name', rect: { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.3 } },
      { role: 'own', field: 'account', rect: { x0: 0.1, y0: 0.4, x1: 0.5, y1: 0.5 } },
    ], include_resolved: false } as const;
    expect(parseFieldRuleDefinition(definition).mode).toBe('auto');
    expect(fieldRegionLabel(definition.fields[0], 'auto')).toBe('名称位置一');
    expect(fieldRegionLabel(definition.fields[1], 'auto')).toBe('位置二账号');
    expect(fieldRegionLabel(definition.fields[0])).toBe('交易对方名称');
    expect(() => parseFieldRuleDefinition({ ...definition, fields: [{ ...definition.fields[1], field: 'name' }] })).toThrow();
    expect(parseLocalFieldRule({ rule_id: 'rule-auto', revision: 1, name: '自动规则', bank_name: '示例银行', mode: 'auto', active: true }).mode).toBe('auto');
    expect(parseLocalFieldRule({ rule_id: 'rule-direct', revision: 1, name: '旧规则', bank_name: '示例银行', mode: 'direct', active: true }).mode).toBe('direct');
    expect(parseLocalFieldRule({ rule_id: 'rule-sides', revision: 1, name: '旧规则', bank_name: '示例银行', mode: 'sides', active: true }).mode).toBe('sides');
  });
  it('新结构化问题可解析，旧结果保持兼容，按读取版式而非裁剪版式集合', () => {
    const snapshot = syntheticSnapshot(3);
    for (const item of snapshot.items) { item.route = 'counterparty_pending'; item.group = { group_id: 'pending', kind: 'counterparty_pending', display_name: '待确认', key: null, manual: false }; }
    expect(parseGroupingItem(snapshot.items[0]).extracted?.issues).toBeUndefined();
    snapshot.items[0].extracted!.issues = [{ code: 'missing_field', role: 'counterparty', field: 'name', message: '没有读到名称' }];
    snapshot.items[0].extracted!.layout_signature = 'a'.repeat(64);
    snapshot.items[1].extracted = structuredClone(snapshot.items[0].extracted); snapshot.items[1].extracted!.layout_signature = 'b'.repeat(64);
    snapshot.items[2].extracted = structuredClone(snapshot.items[0].extracted); snapshot.items[2].extracted!.layout_signature = null;
    expect(parseGroupingItem(snapshot.items[0]).extracted?.issues?.[0].code).toBe('missing_field');
    const groups = groupingIssueCollections(snapshot.items, '示例银行');
    expect(groups).toHaveLength(3); expect(groups.filter((g) => g.hasLayout)).toHaveLength(2);
    expect(groups.find((g) => !g.hasLayout)?.label).toContain('仅按原因');
    expect(groupingIssueCollections(snapshot.items, '另一银行')[0].key).not.toBe(groups[0].key);
    snapshot.items[2].extracted!.issues = [{ code: 'no_text', role: 'unknown', field: null, message: '无文字' }];
    expect(canConfigureFieldRule(snapshot.items[2])).toBe(false);
  });
  it('诊断预览拒绝夹带原文和路径字段', () => {
    const report = { schema_version: 1, report_id: 'a'.repeat(32), app_version: '0.1.58', total: 3, issues: [{ code: 'missing_field', count: 3 }], field_states: [{ field: 'name', role: 'counterparty', state: 'missing', count: 1 }], layouts: [], reader_dependencies: [] };
    expect(parseGroupingDiagnostics(report).field_states[0]?.role).toBe('counterparty');
    expect(() => parseGroupingDiagnostics({ ...report, original_path: '/private.pdf' })).toThrow();
    expect(() => parseGroupingDiagnostics({ ...report, issues: [{ code: 'missing_field', count: 3, raw: '秘密' }] })).toThrow();
    expect(() => parseGroupingDiagnostics({ ...report, field_states: [{ ...report.field_states[0], role: 'auto' }] })).toThrow();
  });
});
