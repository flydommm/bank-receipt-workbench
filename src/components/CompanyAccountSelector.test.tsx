// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountSelection } from '../domain/receiptGrouping';
import { syntheticAccount } from '../domain/receiptGrouping.testFixtures';
import type { CompanyAccountImportClient, CompanyAccountImportPreview } from '../services/companyAccountImportClient';
import type { ReceiptGroupingClient } from '../services/receiptGroupingClient';
import type { CompanyAccountTemplateSaveResult, saveCompanyAccountTemplate } from '../services/companyAccountTemplate';
import { CompanyAccountSelector } from './CompanyAccountSelector';
afterEach(cleanup);

describe('CompanyAccountSelector', () => {
  function renderTemplate(saveTemplate: typeof saveCompanyAccountTemplate, disabled = false) {
    const client = { loadAccounts: vi.fn().mockResolvedValue([syntheticAccount]), saveAccount: vi.fn() } as unknown as ReceiptGroupingClient;
    return render(<CompanyAccountSelector value={{ kind: 'saved', account_id: syntheticAccount.account_id, account_revision: syntheticAccount.account_revision }} onChange={vi.fn()} client={client} saveTemplate={saveTemplate} disabled={disabled} />);
  }

  it('saves the template through one native request and shows the saved filename', async () => {
    const user = userEvent.setup();
    let finish!: (result: CompanyAccountTemplateSaveResult) => void;
    const saveTemplate = vi.fn(() => new Promise<CompanyAccountTemplateSaveResult>((resolve) => { finish = resolve; }));
    renderTemplate(saveTemplate);
    const button = screen.getByRole('button', { name: '下载导入模板' });
    await user.dblClick(button);
    expect(saveTemplate).toHaveBeenCalledExactlyOnceWith();
    expect((screen.getByRole('button', { name: '正在保存模板…' }) as HTMLButtonElement).disabled).toBe(true);
    finish({ status: 'saved', fileName: '本方账户导入模板.xlsx' });
    expect(await screen.findByText('模板已保存：本方账户导入模板.xlsx')).toBeTruthy();
    expect((screen.getByRole('button', { name: '下载导入模板' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('treats cancelling the native save dialog as a neutral result and allows retry', async () => {
    const user = userEvent.setup();
    const saveTemplate = vi.fn().mockResolvedValue({ status: 'cancelled' });
    renderTemplate(saveTemplate);
    await user.click(screen.getByRole('button', { name: '下载导入模板' }));
    expect(saveTemplate).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/^模板已保存/)).toBeNull();
    expect((screen.getByRole('button', { name: '下载导入模板' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a Chinese failure and permits retry without changing account selection', async () => {
    const user = userEvent.setup();
    const saveTemplate = vi.fn().mockRejectedValueOnce('模板文件已存在，请更换文件名。').mockResolvedValueOnce({ status: 'saved', fileName: '账户模板副本.xlsx' });
    renderTemplate(saveTemplate);
    await user.click(screen.getByRole('button', { name: '下载导入模板' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '模板文件已存在，请更换文件名。');
    await user.click(screen.getByRole('button', { name: '下载导入模板' }));
    expect(await screen.findByText('模板已保存：账户模板副本.xlsx')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveTemplate).toHaveBeenCalledTimes(2);
  });

  it('labels browser downloads as requested instead of already saved and respects disabled state', async () => {
    const user = userEvent.setup();
    const saveTemplate = vi.fn().mockResolvedValue({ status: 'download_requested' });
    const view = renderTemplate(saveTemplate, true);
    await user.click(screen.getByRole('button', { name: '下载导入模板' }));
    expect(saveTemplate).not.toHaveBeenCalled();
    view.unmount();
    renderTemplate(saveTemplate);
    await user.click(screen.getByRole('button', { name: '下载导入模板' }));
    expect(await screen.findByText('已请求下载模板，请查看浏览器下载列表。')).toBeTruthy();
    expect(screen.queryByText(/^模板已保存/)).toBeNull();
  });

  it('keeps incomplete inline selection invalid and preserves leading zeroes when saved', async () => {
    const user = userEvent.setup(); const valid = vi.fn(), changed = vi.fn();
    const save = vi.fn().mockResolvedValue(syntheticAccount);
    const client = { loadAccounts: vi.fn().mockResolvedValue([]), saveAccount: save } as unknown as ReceiptGroupingClient;
    function Wrapper() { const [value, setValue] = useState<AccountSelection | null>(null); return <CompanyAccountSelector value={value} onChange={(next) => { setValue(next); changed(next); }} onValidityChange={valid} client={client} />; }
    render(<Wrapper />); await user.click(screen.getByLabelText('启用按交易对手整理')); await user.click(screen.getByRole('button', { name: '仅填写本批资料' }));
    expect(valid).toHaveBeenLastCalledWith(false);
    await user.type(screen.getByLabelText('公司全名'), syntheticAccount.company_name);
    await user.type(screen.getByLabelText('来源银行'), syntheticAccount.bank_name);
    await user.type(screen.getByLabelText('完整本方账号'), syntheticAccount.account_number);
    await waitFor(() => expect(valid).toHaveBeenLastCalledWith(true));
    await user.click(screen.getByRole('button', { name: '保存为本机账户档案' }));
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ kind: 'saved', account_id: syntheticAccount.account_id, account_revision: 1 }));
    expect(save.mock.calls[0][0].account_number).toBe('0000123456');
    expect(save.mock.calls[0][1]).toBeNull();
  });
  it('selects by company, bank and account and deactivates without deleting existing snapshots', async () => {
    const user = userEvent.setup(); const save = vi.fn().mockResolvedValue({ ...syntheticAccount, active: false, account_revision: 2 }); const changed = vi.fn();
    const client = { loadAccounts: vi.fn().mockResolvedValue([syntheticAccount]), saveAccount: save } as unknown as ReceiptGroupingClient;
    function Wrapper() { const [value, setValue] = useState<AccountSelection | null>({ kind: 'inline', account: { company_name: '', bank_name: '', branch_name: '', account_number: '' } }); return <CompanyAccountSelector value={value} onChange={(next) => { setValue(next); changed(next); }} client={client} />; }
    render(<Wrapper />); await user.click(screen.getByRole('button', { name: '选择本机档案' }));
    await screen.findByRole('option', { name: syntheticAccount.company_name });
    await user.selectOptions(screen.getByLabelText('档案公司'), syntheticAccount.company_name);
    await user.selectOptions(screen.getByLabelText('档案来源银行'), syntheticAccount.bank_name);
    await user.selectOptions(screen.getByLabelText('档案本方账号'), syntheticAccount.account_id);
    expect(changed).toHaveBeenLastCalledWith({ kind: 'saved', account_id: syntheticAccount.account_id, account_revision: 1 });
    await user.click(screen.getByRole('button', { name: '停用选中档案' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1]).toEqual(syntheticAccount); expect(save.mock.calls[0][2]).toBe(false);
    await waitFor(() => expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'inline', account: { account_number: syntheticAccount.account_number } }));
  });
  it('edits saved accounts with their revision and can switch the feature off', async () => {
    const user = userEvent.setup(); const save = vi.fn().mockResolvedValue({ ...syntheticAccount, company_name: '修改后的合成公司', account_revision: 2 }); const changed = vi.fn();
    const client = { loadAccounts: vi.fn().mockResolvedValue([syntheticAccount]), saveAccount: save } as unknown as ReceiptGroupingClient;
    function Wrapper() { const [value, setValue] = useState<AccountSelection | null>({ kind: 'saved', account_id: syntheticAccount.account_id, account_revision: 1 }); return <CompanyAccountSelector value={value} onChange={(next) => { setValue(next); changed(next); }} client={client} />; }
    render(<Wrapper />); await user.click(await screen.findByRole('button', { name: '编辑选中档案' }));
    await user.clear(screen.getByLabelText('公司全名')); await user.type(screen.getByLabelText('公司全名'), '修改后的合成公司');
    await user.click(screen.getByRole('button', { name: '保存档案修改' }));
    await waitFor(() => expect(save).toHaveBeenCalled()); expect(save.mock.calls[0][1].account_revision).toBe(1);
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ kind: 'saved', account_id: syntheticAccount.account_id, account_revision: 2 }));
    await user.click(screen.getByLabelText('启用按交易对手整理')); expect(changed).toHaveBeenLastCalledWith(null);
  });
  it.each([
    { created: 2, skipped: 0, totalSkipped: 1 },
    { created: 1, skipped: 1, totalSkipped: 2 },
  ])('reports preview and commit duplicates once after importing $created accounts', async ({ created, skipped, totalSkipped }) => {
    const user = userEvent.setup(); const changed = vi.fn();
    const client = { loadAccounts: vi.fn().mockResolvedValue([]), saveAccount: vi.fn() } as unknown as ReceiptGroupingClient;
    const account = { company_name: '导入公司', bank_name: '导入银行', branch_name: '', account_number: '0000123' };
    const secondAccount = { ...account, account_number: '0000456' };
    const preview = vi.fn().mockResolvedValue({
      rows: [
        { row_number: 2, account, status: 'ready', message: '' },
        { row_number: 3, account, status: 'duplicate', message: '账户已存在' },
        { row_number: 4, account: null, source: { ...account, company_name: '需要修正的合成公司', account_number: '=00123' }, status: 'error', message: '账号不能为公式' },
        { row_number: 5, account: secondAccount, status: 'ready', message: '' },
        { row_number: 6, account: null, source: { ...account, company_name: '', account_number: '0000789' }, status: 'error', message: '请填写公司全名' },
      ], counts: { ready: 2, duplicate: 1, error: 2 },
    });
    const commit = vi.fn().mockResolvedValue({ created, skipped });
    const importClient = { preview, commit } as unknown as CompanyAccountImportClient;
    function Wrapper() { const [value, setValue] = useState<AccountSelection | null>(null); return <CompanyAccountSelector value={value} onChange={(next) => { setValue(next); changed(next); }} client={client} importClient={importClient} />; }
    const { container } = render(<Wrapper />);
    await user.click(screen.getByLabelText('启用按交易对手整理'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '选择本机档案' })));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['xlsx'], 'accounts.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith(expect.any(String), expect.any(AbortSignal)));
    const dialog = await screen.findByRole('dialog', { name: '导入账户档案 · 核对预览' });
    expect(within(dialog).getAllByRole('row')).toHaveLength(6);
    expect(within(dialog).getByText('将跳过；账户已存在')).toBeTruthy();
    expect(within(dialog).getByText('需要修正的合成公司')).toBeTruthy();
    expect(commit).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: '错误，2条' }));
    expect(within(dialog).getByText('=00123')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '导入有效2条档案' }));
    await waitFor(() => expect(commit).toHaveBeenCalledWith([account, secondAccount], expect.any(AbortSignal)));
    const summary = await screen.findByText(`已新增 ${created} 条账户档案，跳过 ${totalSkipped} 条重复档案。另有 2 条错误记录未导入，请修正后重新导入。`);
    expect(summary.getAttribute('role')).toBe('status');
    expect(summary.classList.contains('company-account-selector__import-success')).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.upload(input, new File(['next-xlsx'], 'next-accounts.xlsx'));
    expect(screen.queryByText(/^已新增/)).toBeNull();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
  it('keeps failed imports in the preview and restores the file-button focus when cancelled', async () => {
    const user = userEvent.setup();
    const client = { loadAccounts: vi.fn().mockResolvedValue([]), saveAccount: vi.fn() } as unknown as ReceiptGroupingClient;
    const account = { company_name: '合成公司', bank_name: '合成银行', branch_name: '', account_number: '0000123' };
    const preview = vi.fn().mockResolvedValue({ rows: [{ row_number: 2, account, status: 'ready', message: '' }], counts: { ready: 1, duplicate: 0, error: 0 } });
    const commit = vi.fn().mockRejectedValue(new Error('synthetic save failure'));
    const importClient = { preview, commit } as unknown as CompanyAccountImportClient;
    function Wrapper() { const [value, setValue] = useState<AccountSelection | null>(null); return <CompanyAccountSelector value={value} onChange={setValue} client={client} importClient={importClient} />; }
    const { container } = render(<Wrapper />);
    await user.click(screen.getByLabelText('启用按交易对手整理'));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['xlsx'], 'accounts.xlsx'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '导入有效1条档案' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeTruthy());
    expect((within(dialog).getByRole('button', { name: '导入有效1条档案' }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(dialog).getByText(account.account_number)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '取消导入' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '选择 Excel 文件' }));
  });
  it('allows cancelling a pending preview and ignores the late preview result', async () => {
    const user = userEvent.setup();
    const client = { loadAccounts: vi.fn().mockResolvedValue([]), saveAccount: vi.fn() } as unknown as ReceiptGroupingClient;
    let resolvePreview!: (value: CompanyAccountImportPreview) => void;
    const preview = vi.fn((_workbook: string, _signal?: AbortSignal) => new Promise<CompanyAccountImportPreview>((resolve) => { resolvePreview = resolve; }));
    const importClient = { preview, commit: vi.fn() } as unknown as CompanyAccountImportClient;
    function Wrapper() { const [value, setValue] = useState<AccountSelection | null>(null); return <CompanyAccountSelector value={value} onChange={setValue} client={client} importClient={importClient} />; }
    const { container } = render(<Wrapper />);
    await user.click(screen.getByLabelText('启用按交易对手整理'));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['xlsx'], 'accounts.xlsx'));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: '取消导入' }));
    expect(preview.mock.calls[0]?.[1]?.aborted).toBe(true);
    resolvePreview({ rows: [], counts: { ready: 0, duplicate: 0, error: 0 } });
    await waitFor(() => expect(screen.queryByText('正在校验导入文件…')).toBeNull());
  });
  it('does not expose cancellation or start a second commit while saving accounts', async () => {
    const user = userEvent.setup();
    const client = { loadAccounts: vi.fn().mockResolvedValue([]), saveAccount: vi.fn() } as unknown as ReceiptGroupingClient;
    const account = { company_name: '导入公司', bank_name: '导入银行', branch_name: '', account_number: '0000123' };
    const preview = vi.fn().mockResolvedValue({ rows: [{ row_number: 2, account, status: 'ready', message: '' }], counts: { ready: 1, duplicate: 0, error: 0 } });
    let resolveCommit!: (value: { created: number; skipped: number }) => void;
    const commit = vi.fn(() => new Promise<{ created: number; skipped: number }>((resolve) => { resolveCommit = resolve; }));
    const importClient = { preview, commit } as unknown as CompanyAccountImportClient;
    function Wrapper() { const [value, setValue] = useState<AccountSelection | null>(null); return <CompanyAccountSelector value={value} onChange={setValue} client={client} importClient={importClient} />; }
    const { container } = render(<Wrapper />);
    await user.click(screen.getByLabelText('启用按交易对手整理'));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['xlsx'], 'accounts.xlsx'));
    await waitFor(() => expect((screen.getByRole('button', { name: '导入有效1条档案' }) as HTMLButtonElement).disabled).toBe(false));
    const commitButton = screen.getByRole('button', { name: '导入有效1条档案' });
    await user.click(commitButton);
    await waitFor(() => expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true'));
    expect(screen.queryByRole('button', { name: '取消导入' })).toBeNull();
    await user.click(commitButton);
    expect(commit).toHaveBeenCalledTimes(1);
    resolveCommit({ created: 1, skipped: 0 });
  });
});
