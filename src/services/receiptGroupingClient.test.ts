import { describe, expect, it, vi } from 'vitest';
import { ReceiptBatchValidationError } from '../domain/receiptBatch';
import { ReceiptGroupingValidationError } from '../domain/receiptGrouping';
import { ReceiptBatchClientError } from './receiptBatchClient';
import { ReceiptGroupingClient, groupingErrorMessage } from './receiptGroupingClient';
import { syntheticAccount, syntheticHeader, syntheticItem, syntheticSnapshot } from '../domain/receiptGrouping.testFixtures';
const ok = (data: unknown) => ({ status: 'ok', data });

describe('ReceiptGroupingClient', () => {
  it('maps grouping and batch format errors without exposing arbitrary error text', () => {
    const sentinel = 'secret-account-999999';
    expect(groupingErrorMessage(new ReceiptGroupingValidationError())).toBe('交易对手结果格式不兼容，请更新应用后重试。');
    expect(groupingErrorMessage(new ReceiptBatchValidationError('response.data', sentinel))).toBe('回单任务结果格式不兼容，请更新应用后重试。');
    expect(groupingErrorMessage(new Error(sentinel))).toBe('账户或分组操作未完成，请检查填写内容后重试。');
    expect(groupingErrorMessage(new ReceiptBatchClientError('account_conflict', sentinel))).toBe('账户档案已经变化，请重新载入后选择。');
    expect(groupingErrorMessage(new ReceiptBatchClientError('grouping_transport', sentinel))).toBe('账户或分组操作未完成，请重新载入后重试。');
    for (const error of [new ReceiptGroupingValidationError(), new ReceiptBatchValidationError('response.data', sentinel),
      new Error(sentinel), new ReceiptBatchClientError('account_conflict', sentinel)]) {
      expect(groupingErrorMessage(error)).not.toContain(sentinel);
    }
  });

  it('reports invalid account requests as input errors without dispatching, while response format errors require an app update', async () => {
    const requestTransport = vi.fn();
    const requestClient = new ReceiptGroupingClient(requestTransport);
    const invalidAccount = { company_name: '', bank_name: '招商银行', branch_name: '', account_number: '123456' };
    await expect(requestClient.saveAccount(invalidAccount)).rejects.toMatchObject({
      code: 'account_invalid', message: '请填写完整公司、来源银行和本方账号。',
    });
    await expect(requestClient.setAccount('synthetic-job', 0, { kind: 'saved', account_id: '', account_revision: 1 })).rejects.toMatchObject({
      code: 'account_invalid', message: '请填写完整公司、来源银行和本方账号。',
    });
    expect(requestTransport).not.toHaveBeenCalled();

    const sentinel = 'secret-account-999999';
    const responseTransport = vi.fn().mockResolvedValue({ status: 'ok', data: { sentinel }, extra: sentinel });
    const responseClient = new ReceiptGroupingClient(responseTransport);
    let cause: unknown;
    try {
      await responseClient.setAccount('synthetic-job', 0, { kind: 'saved', account_id: 'saved-account', account_revision: 1 });
    } catch (error) {
      cause = error;
    }
    expect(cause).toBeInstanceOf(ReceiptBatchValidationError);
    expect(groupingErrorMessage(cause)).toBe('回单任务结果格式不兼容，请更新应用后重试。');
    expect(groupingErrorMessage(cause)).not.toContain(sentinel);
    expect(responseTransport).toHaveBeenCalledTimes(1);
  });

  it('sends host-owned public operations and checks private data without echoing backend errors', async () => {
    const transport = vi.fn().mockResolvedValueOnce(ok(syntheticHeader()))
      .mockResolvedValueOnce({ status: 'error', code: 'account_conflict', message: 'secret-account-999999' });
    const client = new ReceiptGroupingClient(transport);
    await client.setAccount('synthetic-job', 0, { kind: 'saved', account_id: syntheticAccount.account_id, account_revision: 1 });
    expect(transport.mock.calls[0]).toEqual(['batch_command', { request: { op: 'batch_receipt_grouping_set_account', job_id: 'synthetic-job', expected_grouping_revision: 0, account_selection: { kind: 'saved', account_id: syntheticAccount.account_id, account_revision: 1 } } }]);
    await expect(client.listAccounts({ active_only: true, offset: 0, limit: 10 })).rejects.toThrow('账户档案已经变化');
  });
  it('rejects changed or duplicate pages when loading the complete snapshot', async () => {
    const header = syntheticHeader(2);
    const transport = vi.fn().mockResolvedValueOnce(ok({ header, items: [syntheticItem(1)], offset: 0, total: 2, next_offset: 1 }))
      .mockResolvedValueOnce(ok({ header, items: [syntheticItem(1)], offset: 1, total: 2, next_offset: null }));
    await expect(new ReceiptGroupingClient(transport).loadAll(header)).rejects.toThrow();
    const changed = vi.fn().mockResolvedValue(ok({ header: { ...header, grouping_revision: 2 }, items: [syntheticItem(1), syntheticItem(2)], offset: 0, total: 2, next_offset: null }));
    await expect(new ReceiptGroupingClient(changed).loadAll(header)).rejects.toMatchObject({ code: 'grouping_stale' });
  });
  it('refreshes in chunks of 50, serially forwarding the latest revision', async () => {
    const snapshot = syntheticSnapshot(51); snapshot.items.forEach((item) => { item.extraction_state = 'pending'; item.extracted = null; });
    let revision = 1; let active = 0; let maximumActive = 0;
    const transport = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const request = args!.request as Record<string, unknown>;
      active++; maximumActive = Math.max(active, maximumActive); await Promise.resolve(); active--;
      if (request.op === 'batch_receipt_grouping_refresh') {
        expect(request.expected_grouping_revision).toBe(revision); revision++;
        const items = (request.segment_ids as string[]).map((id) => syntheticItem(Number.parseInt(id, 16)));
        return ok({ header: syntheticHeader(51, revision), items });
      }
      return ok({ header: syntheticHeader(51, revision), items: Array.from({ length: 51 }, (_, i) => syntheticItem(i + 1)), offset: 0, total: 51, next_offset: null });
    });
    const progress = vi.fn(); const result = await new ReceiptGroupingClient(transport as never).refreshAll(snapshot, progress);
    expect(result.header.grouping_revision).toBe(3); expect(maximumActive).toBe(1);
    expect((transport.mock.calls[0][1]!.request as { segment_ids: string[] }).segment_ids).toHaveLength(50);
    expect((transport.mock.calls[1][1]!.request as { segment_ids: string[] }).segment_ids).toHaveLength(1);
    expect(progress.mock.calls.map(([p]) => p.completed)).toEqual([0, 50, 51]);
  });
  it('cancellation stops future chunks even when the completed mutation is durable', async () => {
    const snapshot = syntheticSnapshot(51); snapshot.items.forEach((item) => { item.extraction_state = 'pending'; item.extracted = null; });
    const transport = vi.fn().mockResolvedValue(ok({ header: syntheticHeader(51, 2), items: snapshot.items.slice(0, 50) }));
    const abort = new AbortController();
    await expect(new ReceiptGroupingClient(transport).refreshAll(snapshot, (p) => { if (p.completed === 50) abort.abort(); }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch invalid requests or already cancelled reads', async () => {
    const transport = vi.fn(); const client = new ReceiptGroupingClient(transport); const abort = new AbortController(); abort.abort();
    await expect(client.listAccounts({ active_only: true, offset: 0, limit: 51 })).rejects.toThrow();
    await expect(client.prepare('synthetic-job', 'result-1', -1, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not extract excluded fragments that were never read', async () => {
    const snapshot = syntheticSnapshot(2);
    const excluded = snapshot.items[0];
    excluded.route = 'excluded'; excluded.group = null; excluded.extraction_state = 'pending'; excluded.extracted = null;
    const transport = vi.fn().mockResolvedValue(ok({ ...snapshot, offset: 0, total: 2, next_offset: null }));
    await new ReceiptGroupingClient(transport).refreshAll(snapshot);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1].request.op).toBe('batch_receipt_grouping_page');
  });
  it('refreshes legacy ready own-pending records so they can migrate to the batch profile rule', async () => {
    const snapshot = syntheticSnapshot();
    snapshot.items[0].route = 'own_pending'; snapshot.items[0].group = null;
    snapshot.items[0].own_decision = { status: 'pending', method: 'none', side: null, source_bank_status: 'unknown', reasons: [] };
    const next = syntheticSnapshot(); next.header.grouping_revision = 2;
    next.items[0].own_decision = { status: 'confirmed', method: 'batch_profile', side: null, source_bank_status: 'unknown', reasons: [] };
    const transport = vi.fn().mockResolvedValueOnce(ok(next)).mockResolvedValueOnce(ok({ ...next, offset: 0, total: 1, next_offset: null }));
    const result = await new ReceiptGroupingClient(transport).refreshAll(snapshot);
    expect(transport.mock.calls[0][1].request.op).toBe('batch_receipt_grouping_refresh');
    expect(result.items[0].own_decision.method).toBe('batch_profile');
    expect(result.header.counts.own_pending).toBe(0);
  });
});
