import { describe, expect, it } from 'vitest';

import {
  GUIDE_FINE_TUNE_STEPS,
  GUIDE_REVIEW_ACTION_GROUPS,
  GUIDE_REVIEW_CHECKS,
  GUIDE_STEPS,
  OVERVIEW_FEATURES,
  RELEASE_NOTES,
} from './helpContent';
import { APP_VERSION } from './appIdentity';

const guideText = [
  ...OVERVIEW_FEATURES.map((feature) => `${feature.title} ${feature.description}`),
  ...GUIDE_STEPS.flatMap((step) => [step.title, step.body]),
  ...GUIDE_FINE_TUNE_STEPS.flatMap((step) => [step.title, step.body]),
  ...GUIDE_REVIEW_ACTION_GROUPS.flatMap((group) => [group.title, group.description, ...group.actions.flatMap((action) => [action.label, action.description])]),
  ...GUIDE_REVIEW_CHECKS,
].join('\n');

describe('help content for the receipt overview workflow', () => {
  it('keeps the current release note aligned with the application version', () => {
    expect(RELEASE_NOTES[0]?.version).toBe(APP_VERSION);
  });

  it('describes the three stages and both source/result overview modes', () => {
    expect(OVERVIEW_FEATURES.map((feature) => feature.title)).toEqual([
      '三阶段处理',
      '原页与片段总览',
      '明确选择后批量处理',
    ]);
    expect(GUIDE_STEPS).toHaveLength(6);
    expect(guideText).toContain('导入预览 → 分析处理 → 导出结果');
    expect(guideText).toContain('原页总览');
    expect(guideText).toContain('片段总览');
    expect(guideText).toContain('缩略图大小');
  });

  it('documents selection scope, per-item actions, and needs-adjustment semantics', () => {
    expect(guideText).toContain('全选当前筛选结果');
    expect(guideText).toContain('暂未渲染');
    expect(guideText).toContain('原页卡勾选只选择本页符合当前筛选的候选');
    expect(guideText).toContain('确认所选 N 处');
    expect(guideText).toContain('排除所选 N 处');
    expect(guideText).toContain('恢复所选 N 处为待复核');
    expect(guideText).toContain('标记为“需调整”的片段不能确认');
    expect(guideText).toContain('返回总览');
    expect(guideText).toContain('上一项 / 下一项');
    expect(guideText).toContain('确认此片段');
    expect(guideText).toContain('调整所选边界');
    expect(guideText).toContain('排除此片段');
  });

  it('keeps fine-tune, uncertain-write recovery, and export rules explicit', () => {
    expect(guideText).toContain('同出具银行、同凭证类型、同实际版式');
    expect(guideText).toContain('复制/粘贴只复制高度');
    expect(guideText).toContain('统一所有栏位高度');
    expect(guideText).toContain('不会改变各栏位的顶部位置');
    expect(guideText).toContain('确认并预览本轮');
    expect(guideText).toContain('风险');
    expect(guideText).toContain('保存本轮 N 处');
    expect(guideText).toContain('保存为版式模板');
    expect(guideText).toContain('完成微调，返回结果');
    expect(guideText).toContain('撤销本轮');
    expect(guideText).toContain('核实并完成保存');
    expect(guideText).toContain('核实并完成撤销');
    expect(guideText).toContain('导出回单');
    expect(guideText).toContain('导出名称');
    expect(guideText).toContain('导出方式');
    expect(guideText).toContain('同时导出 XLSX 索引');
    expect(guideText).toContain('同时导出清单 JSON');
    expect(guideText).toContain('选择目录并导出');
    expect(guideText).toContain('重试导出');
    expect(guideText).toContain('移除本次来源');
    expect(guideText).toContain('不需要单独生成预览或最终预览');
    expect(guideText).toContain('复用同次导出');
    expect(guideText).toContain('合并为一个 PDF、按来源分别导出 PDF，或同时导出两种 PDF');
    expect(guideText).toContain('全部未排除项');
    expect(guideText).toContain('总览筛选不会改变导出范围');
    expect(guideText).not.toContain('预览并导出');
    expect(guideText).not.toContain('生成预览 N 处');
    expect(guideText).not.toContain('返回导出设置');
  });

  it('names only the supported special-document tags and avoids obsolete controls', () => {
    expect(guideText).toContain('贷款清算通知书');
    expect(guideText).toContain('确认此特殊单证');
    expect(guideText).toContain('核对特殊单证 N 处');
    expect(guideText).toContain('新任务默认“分割全部回单”');
    expect(guideText).toContain('贷款利息到期通知书');
    expect(guideText).toContain('电子缴税付款凭证');
    expect(guideText).toContain('按页');
    expect(guideText).toContain('有效特殊凭证也不会默认排除');
    for (const obsoleteLabel of [
      'SourceDocumentPreview',
      'ReceiptOverview',
      'ReceiptLayoutEditor',
      'blocked',
      'height',
      'top',
      'merged',
      'by_source',
      'loan_interest_notice',
      'electronic_tax_payment',
      '选择导出范围',
      '进入微调',
      '按单张候选分割',
      '调整为整页范围',
      '检查本银行完成情况',
      '导出审核结果',
      '重试本轮保存',
    ]) {
      expect(guideText).not.toContain(obsoleteLabel);
    }
  });
});
