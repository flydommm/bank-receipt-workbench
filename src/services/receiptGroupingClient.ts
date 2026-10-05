import { invoke } from '@tauri-apps/api/core';
import { ReceiptBatchValidationError, parseReceiptBatchResponse, serializedReceiptBatchBytes } from '../domain/receiptBatch';
import { ReceiptBatchClientError, type ReceiptBatchInvoke } from './receiptBatchClient';
import {
  groupingExpected, parseCompanyAccount, parseCompanyAccountPage, parseGroupingHeader,
  parseGroupingPage, parseGroupingSnapshot, validateGroupingRequest,
  type AccountInput, type AccountSelection, type CompanyAccount, type GroupEdit,
  type GroupingEdit, type GroupingHeader, type GroupingPage, type GroupingRequest,
  ReceiptGroupingValidationError, type ReceiptGroupingSnapshot,
} from '../domain/receiptGrouping';

const messages: Record<string, string> = {
  account_invalid: '请填写完整公司、来源银行和本方账号。',
  account_conflict: '账户档案已经变化，请重新载入后选择。',
  grouping_not_enabled: '本任务尚未选择本方账户，请在分析前启用整理。',
  grouping_invalid: '分组数据无效，请检查填写内容并重新载入。',
  grouping_conflict: '分组已被更新，请重新载入后操作。',
  grouping_stale: '边界、资料或审核结果已变化，请重新载入分组。',
  grouping_identity_pending: '旧版分组结果需要更新，请重新载入并继续提取；本方使用本批账户资料。',
  source_changed: '来源文件已经变化，请重新核对来源文件。',
};
/** Do not display a backend exception or arbitrary transport text containing financial data. */
export function groupingErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return '已停止后续提取；已完成结果仍保留，重新载入后可继续。';
  if (error instanceof ReceiptGroupingValidationError) return '交易对手结果格式不兼容，请更新应用后重试。';
  if (error instanceof ReceiptBatchValidationError) return '回单任务结果格式不兼容，请更新应用后重试。';
  if (error instanceof ReceiptBatchClientError) return messages[error.code] ?? '账户或分组操作未完成，请重新载入后重试。';
  return '账户或分组操作未完成，请检查填写内容后重试。';
}
const invalid = (): never => { throw new ReceiptBatchClientError('grouping_invalid', messages.grouping_invalid); };
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('操作已取消。', 'AbortError'); }
async function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) { promise.catch(() => undefined); aborted(signal); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('操作已取消。', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
function assertHeader(header: GroupingHeader, jobId: string, resultRevision?: string, minimumRevision = 0): void {
  if (header.job_id !== jobId || (resultRevision !== undefined && header.result_revision !== resultRevision) || header.grouping_revision < minimumRevision) invalid();
}
function sameHeader(left: GroupingHeader, right: GroupingHeader): boolean {
  return left.job_id === right.job_id && left.result_revision === right.result_revision && left.grouping_revision === right.grouping_revision
    && left.review_fingerprint === right.review_fingerprint && left.own_account.fingerprint === right.own_account.fingerprint
    && JSON.stringify(left.counts) === JSON.stringify(right.counts);
}
export type GroupingProgress = { completed: number; total: number; header: GroupingHeader };

export class ReceiptGroupingClient {
  constructor(private readonly transport: ReceiptBatchInvoke = invoke) {}
  private async call(request: GroupingRequest, signal?: AbortSignal): Promise<unknown> {
    const invalidRequestCode = request.op === 'batch_counterparty_account_save' || request.op === 'batch_receipt_grouping_set_account'
      ? 'account_invalid' : 'grouping_invalid';
    let normalized: GroupingRequest;
    try {
      normalized = validateGroupingRequest(request);
      serializedReceiptBatchBytes({ request: normalized });
    } catch (error) {
      if (error instanceof ReceiptGroupingValidationError || error instanceof ReceiptBatchValidationError) {
        throw new ReceiptBatchClientError(invalidRequestCode, messages[invalidRequestCode]);
      }
      throw error;
    }
    aborted(signal);
    let raw: unknown;
    try { raw = await cancellable(Promise.resolve(this.transport<unknown>('batch_command', { request: normalized })), signal); }
    catch (error) { aborted(signal); throw new ReceiptBatchClientError('grouping_transport', groupingErrorMessage(error)); }
    aborted(signal); serializedReceiptBatchBytes(raw);
    const response = parseReceiptBatchResponse(raw);
    if (response.status === 'error') throw new ReceiptBatchClientError(response.code, messages[response.code] ?? '账户或分组操作未完成，请重新载入后重试。');
    return response.data;
  }
  async listAccounts(input: { active_only: boolean; offset: number; limit: number }, signal?: AbortSignal) {
    return parseCompanyAccountPage(await this.call({ op: 'batch_counterparty_account_list', ...input }, signal), input.offset, input.limit, input.active_only);
  }
  async loadAccounts(activeOnly = true, signal?: AbortSignal): Promise<CompanyAccount[]> {
    const items: CompanyAccount[] = []; const ids = new Set<string>(); let offset = 0; let total: number | null = null;
    while (true) {
      const page = await this.listAccounts({ active_only: activeOnly, offset, limit: 50 }, signal);
      if (total !== null && total !== page.total) invalid(); total = page.total;
      for (const item of page.items) { if (ids.has(item.account_id)) invalid(); ids.add(item.account_id); items.push(item); }
      if (page.next_offset === null) break; offset = page.next_offset; aborted(signal);
    }
    return items;
  }
  async saveAccount(account: AccountInput, previous: CompanyAccount | null = null, active = true, signal?: AbortSignal): Promise<CompanyAccount> {
    const value = parseCompanyAccount(await this.call({ op: 'batch_counterparty_account_save', account_id: previous?.account_id ?? null,
      expected_account_revision: previous?.account_revision ?? 0, account, active }, signal));
    if (value.active !== active || (previous && (value.account_id !== previous.account_id || value.account_revision <= previous.account_revision))) invalid();
    return value;
  }
  async setAccount(jobId: string, expectedRevision: number, accountSelection: AccountSelection, signal?: AbortSignal): Promise<GroupingHeader> {
    const header = parseGroupingHeader(await this.call({ op: 'batch_receipt_grouping_set_account', job_id: jobId, expected_grouping_revision: expectedRevision, account_selection: accountSelection }, signal));
    assertHeader(header, jobId, undefined, expectedRevision); return header;
  }
  async prepare(jobId: string, resultRevision: string, expectedRevision = -1, signal?: AbortSignal): Promise<GroupingHeader> {
    const header = parseGroupingHeader(await this.call({ op: 'batch_receipt_grouping_prepare', job_id: jobId, result_revision: resultRevision, expected_grouping_revision: expectedRevision }, signal));
    assertHeader(header, jobId, resultRevision, Math.max(expectedRevision, 0)); return header;
  }
  async page(header: GroupingHeader, offset: number, limit = 200, signal?: AbortSignal): Promise<GroupingPage> {
    const page = parseGroupingPage(await this.call({ op: 'batch_receipt_grouping_page', ...groupingExpected(header), offset, limit }, signal), offset, limit);
    if (!sameHeader(header, page.header)) throw new ReceiptBatchClientError('grouping_stale', messages.grouping_stale); return page;
  }
  async loadAll(header: GroupingHeader, signal?: AbortSignal): Promise<ReceiptGroupingSnapshot> {
    const items: ReceiptGroupingSnapshot['items'] = []; const ids = new Set<string>(); const fragments = new Set<string>();
    let offset = 0;
    while (true) {
      const page = await this.page(header, offset, 200, signal);
      for (const item of page.items) {
        if (ids.has(item.binding.segment_id) || fragments.has(item.binding.fragment_key)) invalid();
        ids.add(item.binding.segment_id); fragments.add(item.binding.fragment_key); items.push(item);
      }
      if (page.next_offset === null) break; offset = page.next_offset; aborted(signal);
    }
    if (items.length !== header.counts.total) invalid();
    return { header, items };
  }
  async refresh(header: GroupingHeader, segmentIds: string[], signal?: AbortSignal): Promise<ReceiptGroupingSnapshot> {
    const snapshot = parseGroupingSnapshot(await this.call({ op: 'batch_receipt_grouping_refresh', ...groupingExpected(header), segment_ids: segmentIds }, signal), 50);
    assertHeader(snapshot.header, header.job_id, header.result_revision ?? undefined, header.grouping_revision);
    if (snapshot.header.review_fingerprint !== header.review_fingerprint || snapshot.items.length !== segmentIds.length || snapshot.items.some((item) => !segmentIds.includes(item.binding.segment_id))) invalid();
    return snapshot;
  }
  /** Serial calls retain each returned CAS revision. Abort never starts a later chunk. */
  async refreshAll(snapshot: ReceiptGroupingSnapshot, onProgress?: (progress: GroupingProgress) => void, signal?: AbortSignal): Promise<ReceiptGroupingSnapshot> {
    const ids = snapshot.items.filter((item) => item.route !== 'excluded' && (item.extraction_state !== 'ready' || item.route === 'own_pending')).map((item) => item.binding.segment_id);
    let header = snapshot.header;
    onProgress?.({ completed: 0, total: ids.length, header });
    for (let offset = 0; offset < ids.length; offset += 50) {
      aborted(signal); const result = await this.refresh(header, ids.slice(offset, offset + 50), signal); header = result.header;
      onProgress?.({ completed: Math.min(offset + 50, ids.length), total: ids.length, header });
    }
    return this.loadAll(header, signal);
  }
  async save(header: GroupingHeader, edits: GroupingEdit[], groupEdits: GroupEdit[] = [], signal?: AbortSignal): Promise<ReceiptGroupingSnapshot> {
    const snapshot = parseGroupingSnapshot(await this.call({ op: 'batch_receipt_grouping_save', ...groupingExpected(header), edits, group_edits: groupEdits }, signal), 200);
    assertHeader(snapshot.header, header.job_id, header.result_revision ?? undefined, header.grouping_revision);
    if (snapshot.header.review_fingerprint !== header.review_fingerprint) invalid(); return snapshot;
  }
}
