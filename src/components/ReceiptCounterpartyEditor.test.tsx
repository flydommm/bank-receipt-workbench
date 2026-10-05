// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupDefinition, GroupingItem } from '../domain/receiptGrouping';
import { syntheticItem } from '../domain/receiptGrouping.testFixtures';
import { ReceiptCounterpartyEditor } from './ReceiptCounterpartyEditor';

afterEach(cleanup);
const groups: GroupDefinition[] = [
  { group_id: 'automatic', kind: 'named', display_name: '同名公司', key: '同名公司', manual: false },
  { group_id: 'manual-specific', kind: 'named', display_name: '同名公司', key: null, manual: true },
  { group_id: 'other', kind: 'named', display_name: '其他公司', key: null, manual: true },
  { group_id: 'internal', kind: 'internal', display_name: '本公司', key: null, manual: false },
];
function mount(items: GroupingItem[] = [syntheticItem()], disabled = false) {
  const onSave = vi.fn(), onCancel = vi.fn();
  const props = { items, groups, disabled, onSave, onCancel };
  return { ...render(<ReceiptCounterpartyEditor {...props} />), onSave, onCancel, props };
}
const saveButton = (name = '保存交易对手') => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('统一交易对手编辑器', () => {
  it('单张默认名称可直接修改，不出现收付款方向选择', () => {
    const { onSave } = mount();
    expect(screen.getByText('当前 1 张回单')).toBeTruthy();
    expect(screen.queryByLabelText('字段所属方')).toBeNull();
    expect((screen.getByLabelText('交易对手名称') as HTMLInputElement).value).toBe('合成对手');
    fireEvent.change(screen.getByLabelText('交易对手名称'), { target: { value: '新交易对手' } });
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith([expect.objectContaining({ assignment: null,
      field_overrides: [expect.objectContaining({ side: 'counterparty', field: 'name', value: '新交易对手' })] })]);
  });
  it('混合收付方向批量应用包含全部所选项目', () => {
    const items = [syntheticItem(), syntheticItem(2)]; items[1].own_decision.side = 'payee';
    const { onSave } = mount(items);
    expect(screen.getByText('所选 2 张回单')).toBeTruthy();
    expect(saveButton('应用到所选 2 张').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('交易对手名称'), { target: { value: '统一名称' } });
    fireEvent.click(saveButton('应用到所选 2 张'));
    expect(onSave.mock.calls[0][0]).toHaveLength(2);
    expect(onSave.mock.calls[0][0].map((edit: { segment_id: string }) => edit.segment_id)).toEqual(items.map((item) => item.binding.segment_id));
  });
  it('明确勾选单张时范围显示所选1张，保存按钮和提交内容不变', () => {
    const view = mount();
    view.rerender(<ReceiptCounterpartyEditor {...view.props} selected />);
    expect(screen.getByText('所选 1 张回单')).toBeTruthy();
    expect(screen.queryByText('当前 1 张回单')).toBeNull();
    fireEvent.click(saveButton());
    expect(view.onSave.mock.calls[0][0]).toHaveLength(1);
    expect(view.onSave.mock.calls[0][0][0].segment_id).toBe(view.props.items[0].binding.segment_id);
  });
  it('搜索并显式选择已有同名人工组，保存对应 group_id；直接改字后不保留旧组绑定', async () => {
    const { onSave } = mount();
    fireEvent.click(screen.getByText('选择已有交易对手'));
    fireEvent.change(screen.getByLabelText('搜索已有交易对手'), { target: { value: '同名' } });
    expect(screen.queryByRole('option', { name: '其他公司' })).toBeNull();
    expect(screen.queryByRole('option', { name: '本公司' })).toBeNull();
    expect(screen.getByRole('option', { name: /同名公司 · 人工分组 · 同名组 2/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('已有交易对手分组'), { target: { value: 'manual-specific' } });
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0][0][0]).toMatchObject({ assignment: { group_id: 'manual-specific' }, field_overrides: [expect.objectContaining({ value: '同名公司' })] });
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('交易对手名称'), { target: { value: '新名称' } });
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[1][0][0].assignment).toBeNull();
  });
  it('名称为空或只有标点时不能保存，明确勾选原件空白后才能保存 blank', () => {
    const { onSave } = mount();
    for (const value of [' ', '）']) {
      fireEvent.change(screen.getByLabelText('交易对手名称'), { target: { value } });
      expect(saveButton().disabled).toBe(true);
    }
    fireEvent.click(screen.getByLabelText('原件确实没有交易对手名称'));
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0][0][0]).toMatchObject({ assignment: null, field_overrides: [expect.objectContaining({ value: '', state: 'blank' })] });
  });
  it('只输入与已有组同名的名称不会擅自选择某个同名组', () => {
    const { onSave } = mount();
    fireEvent.change(screen.getByLabelText('交易对手名称'), { target: { value: '同名公司' } });
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0][0][0].assignment).toBeNull();
  });
  it('任一受保护项目阻止整个批量修改，201 张也不能发送前200张', () => {
    const items = [syntheticItem(), { ...syntheticItem(2), extraction_state: 'pending' as const }];
    const view = mount(items);
    expect(screen.getByRole('alert').textContent).toContain('不可修改');
    expect(saveButton('应用到所选 2 张').disabled).toBe(true);
    view.rerender(<ReceiptCounterpartyEditor {...view.props} items={Array.from({ length: 201 }, (_, index) => syntheticItem(index + 1))} />);
    expect(screen.getByRole('alert').textContent).toContain('1 至 200');
    expect(saveButton('应用到所选 201 张').disabled).toBe(true);
    expect(view.onSave).not.toHaveBeenCalled();
  });
  it('更换所选项目或保存依据时重置草稿，防止沿用上一张名称', () => {
    const view = mount();
    fireEvent.change(screen.getByLabelText('交易对手名称'), { target: { value: '未保存草稿' } });
    const item = syntheticItem(2); item.counterparty!.name.value = '另一张原名';
    view.rerender(<ReceiptCounterpartyEditor {...view.props} items={[item]} />);
    expect((screen.getByLabelText('交易对手名称') as HTMLInputElement).value).toBe('另一张原名');
    fireEvent.click(screen.getByRole('button', { name: '取消修改' })); expect(view.onCancel).toHaveBeenCalledOnce();
  });
  it('保存期间禁用再次提交与取消', () => {
    const { onSave, onCancel } = mount([syntheticItem()], true);
    expect(saveButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: '修改交易对手' }));
    fireEvent.click(screen.getByRole('button', { name: '取消修改' }));
    expect(onSave).not.toHaveBeenCalled(); expect(onCancel).not.toHaveBeenCalled();
  });
  it('可隐藏内部动作，通过关联外部按钮提交，报告校验状态并锁定在途保存', async () => {
    const onSave = vi.fn(); const onCancel = vi.fn(); const onCanSubmitChange = vi.fn();
    let finish!: () => void;
    onSave.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    render(<><ReceiptCounterpartyEditor items={[syntheticItem()]} groups={groups} disabled={false}
      formId="external-counterparty-form" showActions={false} onCanSubmitChange={onCanSubmitChange} onSave={onSave} onCancel={onCancel} />
      <button type="submit" form="external-counterparty-form">外部保存</button></>);
    expect(screen.queryByRole('button', { name: '保存交易对手' })).toBeNull();
    expect(screen.queryByRole('button', { name: '取消修改' })).toBeNull();
    expect(onCanSubmitChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByLabelText('交易对手名称'), { target: { value: '）' } });
    expect(onCanSubmitChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: '外部保存' }));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('交易对手名称'), { target: { value: '正确名称' } });
    expect(onCanSubmitChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: '外部保存' }));
    fireEvent.submit(screen.getByRole('form', { name: '修改交易对手' }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onCanSubmitChange).toHaveBeenLastCalledWith(false);
    finish();
    await waitFor(() => expect(onCanSubmitChange).toHaveBeenLastCalledWith(true));
  });
});
