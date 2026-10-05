import { invoke } from '@tauri-apps/api/core';
import {
  ReceiptBatchValidationError,
  parseReceiptBatchResponse,
  serializedReceiptBatchBytes,
} from '../domain/receiptBatch';
import { parseAccountInput, type AccountInput } from '../domain/receiptGrouping';
import { ReceiptBatchClientError, type ReceiptBatchInvoke } from './receiptBatchClient';

/** The import endpoint deliberately has a smaller limit than the generic batch codec. */
export const COMPANY_ACCOUNT_IMPORT_MAX_BYTES = 512 * 1024;
export const COMPANY_ACCOUNT_IMPORT_MAX_ROWS = 500;

export type CompanyAccountImportRowStatus = 'ready' | 'duplicate' | 'error';

/** Original cell text for review only; it may contain invalid account data. */
export type CompanyAccountImportSource = { company_name: string; bank_name: string; branch_name: string; account_number: string };

export type CompanyAccountImportRow = {
  row_number: number;
  account: AccountInput | null;
  source?: CompanyAccountImportSource;
  status: CompanyAccountImportRowStatus;
  message: string;
};

export type CompanyAccountImportPreview = {
  rows: CompanyAccountImportRow[];
  counts: { ready: number; duplicate: number; error: number };
};

export type CompanyAccountImportResult = {
  created: number;
  skipped: number;
};

const IMPORT_MESSAGES: Record<string, string> = {
  account_import_invalid: '导入文件无效，请检查模板、文件大小和行数后重试。',
  account_import_conflict: '账户档案已变化，请重新载入后重试。',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(path: string, message = `账户导入数据无效：${path}`): never {
  throw new ReceiptBatchValidationError(path, message);
}

function exactObject(value: unknown, fields: readonly string[], path: string, optionalFields: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value)) return invalid(path);
  const keys = Object.keys(value);
  if (fields.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !fields.includes(key) && !optionalFields.includes(key))) return invalid(path);
  return value;
}

function safeInteger(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) return invalid(path);
  return value;
}

function stringValue(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.includes('\0')) return invalid(path);
  return value;
}

function base64Bytes(value: string): number {
  if (value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return invalid('workbook_base64');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length * 3) / 4 - padding;
}

function importAccount(value: unknown, path: string): AccountInput {
  try {
    return parseAccountInput(value);
  } catch {
    return invalid(path);
  }
}

function importSource(value: unknown, path: string): CompanyAccountImportSource {
  const keys = ['company_name', 'bank_name', 'branch_name', 'account_number'] as const;
  const data = exactObject(value, keys, path);
  const fields = keys.map((key) => {
    const text = stringValue(data[key], `${path}.${key}`, true);
    // Python caps each cell at 256 Unicode code points plus a visible notice.
    // Leave room for surrogate pairs in JavaScript's UTF-16 string length.
    if (text.length > 600) return invalid(`${path}.${key}`);
    return text;
  });
  return { company_name: fields[0], bank_name: fields[1], branch_name: fields[2], account_number: fields[3] };
}

function validatePreviewRequest(value: unknown): { op: 'batch_counterparty_account_import_preview'; workbook_base64: string } {
  const data = exactObject(value, ['op', 'workbook_base64'], 'request');
  if (data.op !== 'batch_counterparty_account_import_preview') return invalid('request.op');
  const workbook = stringValue(data.workbook_base64, 'request.workbook_base64');
  if (base64Bytes(workbook) > COMPANY_ACCOUNT_IMPORT_MAX_BYTES) return invalid('request.workbook_base64');
  return { op: 'batch_counterparty_account_import_preview', workbook_base64: workbook };
}

function validateCommitRequest(value: unknown): { op: 'batch_counterparty_account_import'; accounts: AccountInput[] } {
  const data = exactObject(value, ['op', 'accounts'], 'request');
  if (data.op !== 'batch_counterparty_account_import') return invalid('request.op');
  if (!Array.isArray(data.accounts) || data.accounts.length === 0 || data.accounts.length > COMPANY_ACCOUNT_IMPORT_MAX_ROWS) {
    return invalid('request.accounts');
  }
  return {
    op: 'batch_counterparty_account_import',
    accounts: data.accounts.map((account, index) => importAccount(account, `request.accounts[${index}]`)),
  };
}

function parseImportPreview(value: unknown): CompanyAccountImportPreview {
  const data = exactObject(value, ['rows', 'counts'], 'data');
  if (!Array.isArray(data.rows) || data.rows.length > COMPANY_ACCOUNT_IMPORT_MAX_ROWS) return invalid('data.rows');
  const rows: CompanyAccountImportRow[] = [];
  const rowNumbers = new Set<number>();
  for (let index = 0; index < data.rows.length; index += 1) {
    const row = exactObject(data.rows[index], ['row_number', 'account', 'status', 'message'], `data.rows[${index}]`, ['source']);
    // Excel row numbers include the header row in the UI, so a 500-data-row
    // workbook may legitimately report row 501.
    const rowNumber = safeInteger(row.row_number, `data.rows[${index}].row_number`, COMPANY_ACCOUNT_IMPORT_MAX_ROWS + 1);
    if (rowNumber < 1 || rowNumbers.has(rowNumber)) return invalid(`data.rows[${index}].row_number`);
    rowNumbers.add(rowNumber);
    if (row.status !== 'ready' && row.status !== 'duplicate' && row.status !== 'error') return invalid(`data.rows[${index}].status`);
    const account = row.account === null ? null : importAccount(row.account, `data.rows[${index}].account`);
    if (row.status === 'ready' && account === null) return invalid(`data.rows[${index}].account`);
    const source = Object.hasOwn(row, 'source') ? importSource(row.source, `data.rows[${index}].source`) : undefined;
    const message = stringValue(row.message, `data.rows[${index}].message`, true);
    rows.push({ row_number: rowNumber, account, ...(source === undefined ? {} : { source }), status: row.status, message });
  }
  const countsData = exactObject(data.counts, ['ready', 'duplicate', 'error'], 'data.counts');
  const counts = {
    ready: safeInteger(countsData.ready, 'data.counts.ready', COMPANY_ACCOUNT_IMPORT_MAX_ROWS),
    duplicate: safeInteger(countsData.duplicate, 'data.counts.duplicate', COMPANY_ACCOUNT_IMPORT_MAX_ROWS),
    error: safeInteger(countsData.error, 'data.counts.error', COMPANY_ACCOUNT_IMPORT_MAX_ROWS),
  };
  const actual = rows.reduce((result, row) => ({ ...result, [row.status]: result[row.status] + 1 }), { ready: 0, duplicate: 0, error: 0 });
  if (actual.ready !== counts.ready || actual.duplicate !== counts.duplicate || actual.error !== counts.error) return invalid('data.counts');
  return { rows, counts };
}

function parseImportResult(value: unknown): CompanyAccountImportResult {
  const data = exactObject(value, ['created', 'skipped'], 'data');
  return {
    created: safeInteger(data.created, 'data.created', COMPANY_ACCOUNT_IMPORT_MAX_ROWS),
    skipped: safeInteger(data.skipped, 'data.skipped', COMPANY_ACCOUNT_IMPORT_MAX_ROWS),
  };
}

function abortError(): Error {
  const error = new Error('账户导入已取消。');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.then(() => undefined, () => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { if (!settled) { settled = true; cleanup(); resolve(value); } },
      (error: unknown) => { if (!settled) { settled = true; cleanup(); reject(error); } },
    );
  });
}

/** User-safe text for the two import-specific backend errors. */
export function companyAccountImportErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return '已取消账户导入。';
  if (error instanceof ReceiptBatchClientError) return IMPORT_MESSAGES[error.code] ?? '账户导入未完成，请检查填写内容后重试。';
  if (error instanceof ReceiptBatchValidationError) return '账户导入结果格式不兼容，请更新应用后重试。';
  return '账户导入未完成，请检查填写内容后重试。';
}

export class CompanyAccountImportClient {
  constructor(private readonly transport: ReceiptBatchInvoke = invoke) {}

  private async call(request: unknown, signal?: AbortSignal): Promise<unknown> {
    let normalized: { op: string; [key: string]: unknown };
    try {
      normalized = (isRecord(request) && request.op === 'batch_counterparty_account_import_preview')
        ? validatePreviewRequest(request)
        : validateCommitRequest(request);
      serializedReceiptBatchBytes({ request: normalized });
    } catch (error) {
      if (error instanceof ReceiptBatchValidationError) {
        throw new ReceiptBatchClientError('account_import_invalid', IMPORT_MESSAGES.account_import_invalid);
      }
      throw error;
    }
    throwIfAborted(signal);
    let raw: unknown;
    try {
      raw = await withAbort(Promise.resolve(this.transport<unknown>('batch_command', { request: normalized })), signal);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new ReceiptBatchClientError('account_import_transport', '账户导入未完成，请检查填写内容后重试。');
    }
    throwIfAborted(signal);
    serializedReceiptBatchBytes(raw);
    const response = parseReceiptBatchResponse(raw);
    if (response.status === 'error') {
      throw new ReceiptBatchClientError(response.code, IMPORT_MESSAGES[response.code] ?? '账户导入未完成，请检查填写内容后重试。');
    }
    return response.data;
  }

  async preview(workbookBase64: string, signal?: AbortSignal): Promise<CompanyAccountImportPreview> {
    return parseImportPreview(await this.call({ op: 'batch_counterparty_account_import_preview', workbook_base64: workbookBase64 }, signal));
  }

  async commit(accounts: AccountInput[], signal?: AbortSignal): Promise<CompanyAccountImportResult> {
    return parseImportResult(await this.call({ op: 'batch_counterparty_account_import', accounts }, signal));
  }
}
