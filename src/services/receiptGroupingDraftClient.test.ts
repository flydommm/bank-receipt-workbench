import { describe, expect, it, vi } from 'vitest';
import { exportReceiptGroupingDraft } from './receiptGroupingDraftClient';
import { syntheticHeader, syntheticHash } from '../domain/receiptGrouping.testFixtures';

describe('local analysis check sheet', () => {
  const header = syntheticHeader();
  const draftName = '银行回单_合成公司_测试银行_202607_交易对手核对草稿.xlsx';
  const draftDirectory = 'D:/out/银行回单_合成公司_测试银行_202607_交易对手核对草稿_20261003_120000_012345abcdef';
  const receipt = () => ({ state: 'draft_published', directory: draftDirectory, path: `${draftDirectory}/${draftName}`,
    name: draftName, sha256: syntheticHash(), size_bytes: 900, row_count: header.counts.total,
    generated_at: '2026-09-28T00:00:00Z', job_id: header.job_id, result_revision: header.result_revision,
    grouping_revision: header.grouping_revision, review_fingerprint: header.review_fingerprint, own_account_fingerprint: header.own_account.fingerprint });
  it('sends only version bindings, not account fields or browser receipt rows', async () => {
    const call = vi.fn().mockResolvedValue({ status: 'ok', data: receipt() });
    expect(await exportReceiptGroupingDraft(header, 'D:/out', call)).toEqual(receipt());
    const request = call.mock.calls[0][1].request;
    expect(request).not.toHaveProperty('items');
    expect(request).not.toHaveProperty('account_number');
    expect(request.op).toBe('grouping_draft');
  });
  it.each(['version', 'outside', 'count', 'hash'])('rejects a mismatched draft %s', async (change) => {
    const value = receipt();
    if (change === 'version') value.grouping_revision += 1;
    if (change === 'outside') value.path = 'D:/foreign/交易对手核对草稿.xlsx';
    if (change === 'count') value.row_count += 1;
    if (change === 'hash') value.sha256 = 'bad';
    await expect(exportReceiptGroupingDraft(header, 'D:/out', vi.fn().mockResolvedValue({ status: 'ok', data: value }))).rejects.toThrow();
  });

  it('accepts multiple source names and Windows separator normalization', async () => {
    const value = receipt();
    value.name = '合成公司_202607_等2份_交易对手核对草稿.xlsx';
    value.directory = 'd:\\out\\合成公司_202607_等2份_交易对手核对草稿_20261003_120000_012345abcdef';
    value.path = `${value.directory}\\${value.name}`;
    expect(await exportReceiptGroupingDraft(header, 'D:/out', vi.fn().mockResolvedValue({ status: 'ok', data: value }))).toEqual(value);
  });

  it.each([
    '../交易对手核对草稿.xlsx', '..\\交易对手核对草稿.xlsx', 'D:\\交易对手核对草稿.xlsx',
    '来源:交易对手核对草稿.xlsx', '来源|交易对手核对草稿.xlsx', '来源\0交易对手核对草稿.xlsx',
    '来源\u0085交易对手核对草稿.xlsx', '来源\u202e交易对手核对草稿.xlsx',
    'CON.交易对手核对草稿.xlsx', 'COM¹.交易对手核对草稿.xlsx',
    ' 交易对手核对草稿.xlsx', '交易对手核对草稿.xlsx.', '交易对手核对草稿.xlsx ',
    '交易对手核对草稿.exe', '😀'.repeat(120) + '_交易对手核对草稿.xlsx',
  ])('rejects unsafe or misleading draft basename %s', async (name) => {
    const value = receipt();
    value.name = name;
    value.path = `${value.directory}/${name}`;
    await expect(exportReceiptGroupingDraft(header, 'D:/out', vi.fn().mockResolvedValue({ status: 'ok', data: value }))).rejects.toThrow();
  });

  it.each(['D:/foreign/draft', 'D:/out/../draft', 'D:/out/..', 'D:/out/nested/draft', 'D:/out/NUL', 'D:/out/来源.', 'relative/draft'])('rejects unsafe or out of scope directory %s', async (directory) => {
    const value = receipt();
    value.directory = directory;
    value.path = `${directory}/${value.name}`;
    await expect(exportReceiptGroupingDraft(header, 'D:/out', vi.fn().mockResolvedValue({ status: 'ok', data: value }))).rejects.toThrow();
  });

  it('does not send a relative or traversing output directory to the engine', async () => {
    const call = vi.fn();
    for (const directory of ['relative/output', 'D:/out/../foreign']) {
      await expect(exportReceiptGroupingDraft(header, directory, call)).rejects.toThrow();
    }
    expect(call).not.toHaveBeenCalled();
  });
});
