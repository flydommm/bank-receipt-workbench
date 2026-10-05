// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syntheticSnapshot } from '../domain/receiptGrouping.testFixtures';
import { fieldRegionLabel, type FieldRuleOperation, type FieldRulePage } from '../domain/receiptFieldRules';
import { ReceiptFieldRuleClient } from '../services/receiptFieldRuleClient';
import { ReceiptFieldRuleEditor } from './ReceiptFieldRuleEditor';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup(count = 212) {
  const snapshot = syntheticSnapshot(count), client = new ReceiptFieldRuleClient();
  const operation: FieldRuleOperation = { operation_id: 'synthetic-trial', status: 'ready', total: count, completed: count, eligible: count - 1, skipped: 1, changed: count - 2, unresolved: 1, can_save_rule: true, rule_id: null };
  const rows: FieldRulePage['items'] = snapshot.items.map((item, index) => ({ segment_id: item.binding.segment_id, before_name: '', after_name: index < count - 2 ? (index % 2 ? '合成对手乙' : '合成对手甲') : '', before_route: 'counterparty_pending', after_route: index >= count - 2 ? 'counterparty_pending' : 'named', status: index === count - 1 ? 'skipped' : index === count - 2 ? 'pending' : 'changed', reason: index === count - 1 ? '已有人工处理，保持原结果' : index === count - 2 ? '名称仍未读清' : '逐张读取' }));
  const prepare = vi.spyOn(client, 'prepare').mockResolvedValue(operation);
  const page = vi.spyOn(client, 'page').mockImplementation(async (_job, _op, offset = 0, limit = 200) => ({ operation, items: rows.slice(offset, offset + limit), next_offset: offset + limit < rows.length ? offset + limit : null }));
  const apply = vi.spyOn(client, 'apply').mockResolvedValue({ header: snapshot.header, operation: { ...operation, status: 'applied' } });
  const cancel = vi.spyOn(client, 'cancel').mockResolvedValue({ ...operation, status: 'cancelled' });
  const onApplied = vi.fn().mockResolvedValue(undefined), onClose = vi.fn();
  const mount = () => render(<ReceiptFieldRuleEditor snapshot={snapshot} prototype={snapshot.items[0]} client={client} onApplied={onApplied} onClose={onClose} onComputing={vi.fn()} renderPreview={(id, context) => <div data-testid="synthetic-preview">原件：{id}{context.fieldSelection?.current && <button type="button" onClick={() => context.fieldSelection!.onSelect({ x0: 0.1, y0: context.fieldSelection!.current!.role === 'own' ? 0.5 : 0.2, x1: 0.6, y1: context.fieldSelection!.current!.role === 'own' ? 0.6 : 0.3 })}>框出{fieldRegionLabel(context.fieldSelection.current, context.fieldSelection.mode)}</button>}</div>} />);
  return { snapshot, client, operation, rows, prepare, page, apply, cancel, onApplied, onClose, mount };
}
const drawAndTrial = () => { fireEvent.click(screen.getByRole('button', { name: '框出名称位置一' })); fireEvent.click(screen.getByRole('button', { name: '试读同版式回单' })); };

describe('无方向设置和整批试读核对', () => {
  it('一个名称框即可试读，补框不问交易方向；全批按名称汇总并可定位后页异常', async () => {
    const test = setup(); test.mount();
    expect(screen.queryByLabelText('读取位置的交易双方写法')).toBeNull();
    expect((screen.getByRole('button', { name: '试读同版式回单' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '框出名称位置一' }));
    fireEvent.click(screen.getByText('需要补充另一处名称或账号'));
    fireEvent.change(screen.getByLabelText('补充读取位置'), { target: { value: 'own:name' } });
    fireEvent.click(screen.getByRole('button', { name: '框出名称位置二' }));
    fireEvent.click(screen.getByRole('button', { name: '试读同版式回单' }));
    const table = await screen.findByRole('table', { name: '逐张试读差异' });
    expect(test.prepare.mock.calls[0][1]).toMatchObject({ mode: 'auto', include_resolved: false });
    expect(test.prepare.mock.calls[0][1].fields.map((field) => field.role)).toEqual(['counterparty', 'own']);
    expect(test.page).toHaveBeenCalledWith(test.snapshot.header.job_id, test.operation.operation_id, 200, 200);
    expect(screen.getByRole('option', { name: '合成对手甲 · 105 张' })).toBeTruthy();
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    expect(screen.getByTestId('synthetic-preview').compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(screen.getByLabelText('按交易对手名称核对'), { target: { value: screen.getByRole('option', { name: '合成对手乙 · 105 张' }).getAttribute('value') } });
    expect(within(table).queryByText('合成对手甲')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '待确认 1' }));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByTestId('synthetic-preview').textContent).toContain(test.snapshot.items[210].binding.segment_id);
    fireEvent.click(screen.getByRole('button', { name: '第 211 页 · 第 1 栏' }));
    expect(screen.getByTestId('synthetic-preview').textContent).toContain(test.snapshot.items[210].binding.segment_id);
    fireEvent.click(screen.getByLabelText('下次同版式自动使用'));
    expect((screen.getByLabelText('本机读取规则名称') as HTMLInputElement).value).toContain('合成测试银行');
    fireEvent.click(screen.getByRole('button', { name: '确认应用 210 张并保存规则' }));
    await waitFor(() => expect(test.onApplied).toHaveBeenCalledTimes(1));
    expect(test.apply).toHaveBeenCalledWith(test.snapshot.header, test.operation.operation_id, true, '合成测试银行 · 交易对手读取位置');
  });
  it('试读范围可包含自动结果，原件没有名称时提示直接修正，不自动确认空白', async () => {
    const test = setup(3); test.mount();
    fireEvent.change(screen.getByLabelText('试读范围'), { target: { value: 'all' } }); drawAndTrial();
    await screen.findByRole('table', { name: '逐张试读差异' });
    expect(test.prepare.mock.calls[0][1].include_resolved).toBe(true);
    expect(test.prepare.mock.calls[0][1].fields).toHaveLength(1);
    expect(test.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回调整位置' }));
    await screen.findByText(/原件确实没有名称的手续费或结息/);
    expect(test.cancel).toHaveBeenCalledOnce();
  });
  it('结果没有完整载入时不提供应用入口', async () => {
    const test = setup(3); test.page.mockResolvedValue({ operation: test.operation, items: test.rows.slice(0, 1), next_offset: null }); test.mount(); drawAndTrial();
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /确认应用/ })).toBeNull();
    expect(test.apply).not.toHaveBeenCalled();
  });
  it('停止汇总后不再读取下一页，也不发布结果', async () => {
    const test = setup(); let complete!: (value: FieldRulePage) => void;
    test.page.mockReturnValue(new Promise((resolve) => { complete = resolve; })); test.mount(); drawAndTrial();
    await waitFor(() => expect(test.page).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '停止试读' }));
    complete({ operation: test.operation, items: test.rows.slice(0, 200), next_offset: 200 });
    await screen.findByText('试读已停止，原分组未改变。');
    expect(test.page).toHaveBeenCalledOnce(); expect(test.cancel).toHaveBeenCalledOnce(); expect(test.apply).not.toHaveBeenCalled();
  });
  it('一次确认期间阻止重复应用', async () => {
    const test = setup(3); let finish!: (value: Awaited<ReturnType<ReceiptFieldRuleClient['apply']>>) => void;
    test.apply.mockReturnValue(new Promise((resolve) => { finish = resolve; })); test.mount(); drawAndTrial();
    const button = await screen.findByRole('button', { name: '确认应用 1 张' }); fireEvent.click(button); fireEvent.click(button);
    expect(test.apply).toHaveBeenCalledOnce();
    finish({ header: test.snapshot.header, operation: { ...test.operation, status: 'applied' } });
    await waitFor(() => expect(test.onApplied).toHaveBeenCalledOnce());
  });
  it('全批未解决时不把旧名称当作新结果，也不能保存复用', async () => {
    const test = setup(1);
    Object.assign(test.operation, { eligible: 1, skipped: 0, changed: 0, unresolved: 1 });
    Object.assign(test.rows[0], { status: 'pending', before_name: '旧识别名称', after_name: '旧识别名称', after_route: 'named' });
    test.mount(); drawAndTrial();
    const table = await screen.findByRole('table', { name: '逐张试读差异' });
    expect(within(table).getAllByText('旧识别名称')).toHaveLength(1);
    expect(within(table).getByText('尚未确认')).toBeTruthy();
    expect((screen.getByLabelText('下次同版式自动使用') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认应用 0 张' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
