// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syntheticSnapshot } from '../domain/receiptGrouping.testFixtures';
import type { GroupingDiagnostics, LocalFieldRule } from '../domain/receiptFieldRules';
import { ReceiptFieldRuleClient } from '../services/receiptFieldRuleClient';
import { localEngineAdapter } from './localEngineAdapter';
import { ReceiptGroupingRuleTools } from './ReceiptGroupingRuleTools';

const report: GroupingDiagnostics = { schema_version: 1, report_id: 'a'.repeat(32), app_version: '0.1.58', total: 1, issues: [{ code: 'missing_field', count: 1 }], field_states: [], layouts: [{ layout_id: 'layout-1', count: 1 }], reader_dependencies: [] };
const rule: LocalFieldRule = { rule_id: 'rule-test', revision: 2, name: '合成读取规则', bank_name: '示例银行', mode: 'direct', active: true };
const props = () => ({ header: syntheticSnapshot().header, client: new ReceiptFieldRuleClient(), lastOperationId: null, disabled: false, onBusyChange: vi.fn(), onApplied: vi.fn().mockResolvedValue(undefined) });
function openTools() { screen.getByText(/读取规则与排查信息/).closest('details')!.open = true; }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('本机规则和可选诊断摘要', () => {
  it('只有先预览才可导出；取消目录不导出，选定目录携带同一预览编号', async () => {
    vi.spyOn(ReceiptFieldRuleClient.prototype, 'diagnostics').mockResolvedValue(report);
    const pick = vi.spyOn(localEngineAdapter, 'pickOutputFolder').mockResolvedValueOnce(null).mockResolvedValueOnce('D:/synthetic-output');
    const exportReport = vi.spyOn(ReceiptFieldRuleClient.prototype, 'exportDiagnostics').mockResolvedValue({ output_directory: 'D:/synthetic-output/diagnostic', files: [] });
    const input = props(); render(<ReceiptGroupingRuleTools {...input} />); openTools();
    expect(screen.queryByRole('button', { name: '选择目录并保存此摘要' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '预览无需附回单的诊断摘要' }));
    await screen.findByRole('region', { name: '诊断摘要预览' });
    expect(screen.getByText('应用版本')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '选择目录并保存此摘要' }));
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(1)); await waitFor(() => expect(input.onBusyChange).toHaveBeenLastCalledWith(false));
    expect(exportReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '选择目录并保存此摘要' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledWith(input.header, report.report_id, 'D:/synthetic-output'));
    await screen.findByText('诊断摘要已保存：D:/synthetic-output/diagnostic');
  });

  it('核对版本改变会清掉旧预览，目录选择晚返回也不会导出旧摘要', async () => {
    vi.spyOn(ReceiptFieldRuleClient.prototype, 'diagnostics').mockResolvedValue(report);
    let completeFolder!: (folder: string) => void;
    vi.spyOn(localEngineAdapter, 'pickOutputFolder').mockReturnValue(new Promise((resolve) => { completeFolder = resolve; }));
    const exportReport = vi.spyOn(ReceiptFieldRuleClient.prototype, 'exportDiagnostics');
    const input = props(); const view = render(<ReceiptGroupingRuleTools {...input} />); openTools();
    fireEvent.click(screen.getByRole('button', { name: '预览无需附回单的诊断摘要' })); await screen.findByRole('region', { name: '诊断摘要预览' });
    fireEvent.click(screen.getByRole('button', { name: '选择目录并保存此摘要' }));
    view.rerender(<ReceiptGroupingRuleTools {...input} header={{ ...input.header, grouping_revision: input.header.grouping_revision + 1 }} />);
    expect(screen.queryByRole('region', { name: '诊断摘要预览' })).toBeNull();
    completeFolder('D:/synthetic-output'); await waitFor(() => expect(input.onBusyChange).toHaveBeenLastCalledWith(false));
    expect(exportReport).not.toHaveBeenCalled();
  });

  it('规则显示版本与收付关系，停用用当前版本且不隐式撤销本批', async () => {
    vi.spyOn(ReceiptFieldRuleClient.prototype, 'list').mockResolvedValue([rule]);
    const deactivate = vi.spyOn(ReceiptFieldRuleClient.prototype, 'deactivate').mockResolvedValue({ ...rule, active: false });
    const input = props(); render(<ReceiptGroupingRuleTools {...input} lastOperationId="latest-operation" />); openTools();
    expect(screen.getByText(/撤销只恢复本批应用前的分组/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看本机读取规则' }));
    await screen.findByText(/第 2 版 · 固定对方位置/);
    fireEvent.click(screen.getByRole('button', { name: '停用此规则' }));
    await screen.findByText(/第 2 版 · 固定对方位置 · 已停用/);
    expect(deactivate).toHaveBeenCalledWith(rule); expect(input.onApplied).not.toHaveBeenCalled();
  });
});
