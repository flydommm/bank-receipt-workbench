import { describe, expect, it, vi } from 'vitest';
import { CompanyAccountImportClient } from './companyAccountImportClient';
import { ReceiptBatchValidationError } from '../domain/receiptBatch';

const account = { company_name: '导入公司', bank_name: '导入银行', branch_name: '营业部', account_number: '0000123' };

describe('CompanyAccountImportClient', () => {
  it('sends the preview contract and strictly parses counts and rows', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data: {
      rows: [{ row_number: 2, account, status: 'ready', message: '' }],
      counts: { ready: 1, duplicate: 0, error: 0 },
    } });
    const client = new CompanyAccountImportClient(invoke);
    await expect(client.preview('eA==')).resolves.toEqual({
      rows: [{ row_number: 2, account, status: 'ready', message: '' }],
      counts: { ready: 1, duplicate: 0, error: 0 },
    });
    expect(invoke).toHaveBeenCalledWith('batch_command', { request: { op: 'batch_counterparty_account_import_preview', workbook_base64: 'eA==' } });
  });

  it('commits only the explicit account list and rejects invalid input locally', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data: { created: 1, skipped: 0 } });
    const client = new CompanyAccountImportClient(invoke);
    await expect(client.commit([account])).resolves.toEqual({ created: 1, skipped: 0 });
    expect(invoke).toHaveBeenCalledWith('batch_command', { request: { op: 'batch_counterparty_account_import', accounts: [account] } });
    await expect(client.preview('not-base64')).rejects.toMatchObject({ code: 'account_import_invalid' });
    const displayAccount = { ...account, source: account };
    await expect(client.commit([displayAccount])).rejects.toMatchObject({ code: 'account_import_invalid' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps display-only source text for valid, duplicate, conflict and invalid rows', async () => {
    const invalidSource = { company_name: '', bank_name: '=1+1', branch_name: '', account_number: 'not a valid account' };
    const data = {
      rows: [
        { row_number: 2, account, source: account, status: 'ready', message: '可导入' },
        { row_number: 3, account, source: account, status: 'duplicate', message: '重复' },
        { row_number: 4, account, source: account, status: 'error', message: '冲突' },
        { row_number: 5, account: null, source: invalidSource, status: 'error', message: '输入无效' },
      ],
      counts: { ready: 1, duplicate: 1, error: 2 },
    };
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data });
    await expect(new CompanyAccountImportClient(invoke).preview('eA==')).resolves.toEqual(data);
  });

  it('accepts bounded Unicode source and its visible truncation notice', async () => {
    const source = { ...account, company_name: '🧾'.repeat(256) + '…（内容过长，请回原表核对）' };
    const data = { rows: [{ row_number: 2, account: null, source, status: 'error', message: '内容过长' }],
      counts: { ready: 0, duplicate: 0, error: 1 } };
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data });
    await expect(new CompanyAccountImportClient(invoke).preview('eA==')).resolves.toEqual(data);
  });

  it.each([
    null,
    { company_name: '', bank_name: '', account_number: '' },
    { ...account, account_number: 123 },
    { ...account, company_name: 'bad\0text' },
    { ...account, company_name: 'x'.repeat(601) },
    { ...account, unexpected: '' },
  ])('rejects malformed source fields without treating them as account input', async (source) => {
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data: {
      rows: [{ row_number: 2, account: null, source, status: 'error', message: '输入无效' }],
      counts: { ready: 0, duplicate: 0, error: 1 },
    } });
    await expect(new CompanyAccountImportClient(invoke).preview('eA==')).rejects.toBeInstanceOf(ReceiptBatchValidationError);
  });

  it.each([
    { rows: [{ row_number: 2, account, source: account, status: 'ready', message: '', unexpected: '' }], counts: { ready: 1, duplicate: 0, error: 0 } },
    { rows: [{ row_number: 2, account: null, source: account, status: 'ready', message: '' }], counts: { ready: 1, duplicate: 0, error: 0 } },
    { rows: [{ row_number: 2, account, source: account, status: 'ready', message: '' }], counts: { ready: 0, duplicate: 0, error: 1 } },
  ])('retains strict row and count validation when source is present', async (data) => {
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data });
    await expect(new CompanyAccountImportClient(invoke).preview('eA==')).rejects.toBeInstanceOf(ReceiptBatchValidationError);
  });

  it('maps backend import errors to a typed client error', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'error', code: 'account_import_conflict', message: 'opaque backend detail' });
    await expect(new CompanyAccountImportClient(invoke).commit([account])).rejects.toMatchObject({ code: 'account_import_conflict' });
  });
});
