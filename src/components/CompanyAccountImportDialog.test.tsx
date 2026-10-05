// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccountInput } from '../domain/receiptGrouping';
import type { CompanyAccountImportPreview } from '../services/companyAccountImportClient';
import { CompanyAccountImportDialog } from './CompanyAccountImportDialog';

afterEach(cleanup);

const account = (index: number): AccountInput => ({
  company_name: `合成公司 ${index}`,
  bank_name: `合成银行 ${index}`,
  branch_name: `合成支行 ${index}`,
  account_number: `000000000000${String(index).padStart(2, '0')}`,
});

function previewWithRows(): CompanyAccountImportPreview {
  const rows: CompanyAccountImportPreview['rows'] = Array.from({ length: 67 }, (_, index) => ({
    row_number: index + 2,
    account: account(index + 1),
    status: 'ready' as const,
    message: '',
  }));
  rows[2] = {
    row_number: 4,
    account: account(3),
    status: 'duplicate',
    message: '账户档案已存在',
  };
  rows[3] = {
    row_number: 5,
    account: null,
    status: 'error',
    message: '账号格式无效',
  };
  rows[10] = {
    row_number: 12,
    account: {
      ...account(11),
      company_name: '这是一个用于核对换行显示的非常长的合成公司全名'.repeat(3),
      account_number: '000000000000000000000000000000000000000000000000000001',
    },
    status: 'ready',
    message: '',
  };
  return {
    rows,
    counts: { ready: 65, duplicate: 1, error: 1 },
  };
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof CompanyAccountImportDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const props: React.ComponentProps<typeof CompanyAccountImportDialog> = {
    preview: previewWithRows(),
    fileName: '合成账户导入.xlsx',
    saving: false,
    disabled: false,
    error: null,
    onConfirm,
    onCancel,
    ...overrides,
  };
  const view = render(<CompanyAccountImportDialog {...props} />);
  return { ...view, onConfirm, onCancel, props };
}

describe('CompanyAccountImportDialog', () => {
  it('renders all 67 rows, keeps long account numbers intact, and exposes the last row', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: '导入账户档案 · 核对预览' });
    const table = within(dialog).getByRole('table', { name: '账户导入核对明细' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(68);
    expect(within(table).getByText('第 68 行')).toBeTruthy();
    expect(within(table).getByText('这是一个用于核对换行显示的非常长的合成公司全名'.repeat(3))).toBeTruthy();
    expect(within(table).getByText('000000000000000000000000000000000000000000000000000001')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '全部，67条' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '可导入，65条' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '重复，1条' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '错误，1条' })).toBeTruthy();
  });

  it('filters rows by status without changing the import count', async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '重复，1条' }));
    expect(within(dialog).getAllByRole('row')).toHaveLength(2);
    expect(within(dialog).getByText(/账户档案已存在/)).toBeTruthy();
    expect(within(dialog).getByText('共 67 条记录')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '错误，1条' }));
    expect(within(dialog).getAllByRole('row')).toHaveLength(2);
    expect(within(dialog).getByText('不导入；账号格式无效')).toBeTruthy();
  });

  it('uses display-only source fields when an invalid row has no validated account', () => {
    const preview = previewWithRows();
    preview.rows[4] = {
      row_number: 6,
      account: null,
      source: {
        company_name: '原表中的错误公司',
        bank_name: '原表中的错误银行',
        branch_name: '',
        account_number: '原表账号 0001',
      },
      status: 'error',
      message: '账号格式无效',
    };
    renderDialog({ preview });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('原表中的错误公司')).toBeTruthy();
    expect(within(dialog).getByText('原表中的错误银行')).toBeTruthy();
    expect(within(dialog).getByText('原表账号 0001')).toBeTruthy();
    expect(within(dialog).getAllByText('未填写').length).toBeGreaterThan(0);
  });

  it('calls confirm and cancel, while Escape closes through cancel', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog();
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '导入有效65条档案' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await user.click(within(dialog).getByRole('button', { name: '取消导入' }));
    expect(onCancel).toHaveBeenCalledOnce();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('blocks confirm, cancel, and Escape while saving', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog({ saving: true });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('status').textContent).toContain('正在保存账户档案…');
    expect(within(dialog).queryByRole('button', { name: '取消导入' })).toBeNull();
    expect((within(dialog).getByRole('button', { name: '正在保存账户档案…' }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{Escape}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('starts on the title, traps Tab focus, and restores the opener on unmount', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = '打开导入预览';
    document.body.appendChild(opener);
    opener.focus();
    const view = renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: '导入账户档案 · 核对预览' }));
    const buttons = within(dialog).getAllByRole('button');
    const last = buttons[buttons.length - 1]!;
    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(buttons[0]);
    buttons[0]!.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    expect(view.container.hasAttribute('inert')).toBe(true);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    expect(view.container.hasAttribute('inert')).toBe(false);
    opener.remove();
  });
});
