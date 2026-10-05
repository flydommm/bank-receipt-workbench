import { describe, expect, it } from 'vitest';
import { groupingExpected, parseAccountInput, parseGroupingHeader, parseGroupingItem, parseGroupingPage, validateGroupingRequest } from './receiptGrouping';
import { syntheticAccount, syntheticHash, syntheticHeader, syntheticItem } from './receiptGrouping.testFixtures';

describe('receipt grouping contract', () => {
  it('accepts only known fragment business classifications without changing its review type', () => {
    for (const service_type of ['bank_fee', 'deposit_interest', null] as const) {
      const item = syntheticItem(); item.extracted!.service_type = service_type;
      expect(parseGroupingItem(item).extracted!.service_type).toBe(service_type);
      expect(parseGroupingItem(item).document_type).toBe(item.document_type);
    }
    const item = syntheticItem();
    expect(() => parseGroupingItem({ ...item, extracted: { ...item.extracted, service_type: 'unknown' } })).toThrow();
    expect(() => validateGroupingRequest({ op: 'batch_receipt_grouping_refresh', ...groupingExpected(syntheticHeader()),
      segment_ids: [syntheticHash()], service_type: 'bank_fee' })).toThrow();
  });
  it('preserves account strings, raw text and extraction evidence', () => {
    const account = { company_name: syntheticAccount.company_name, bank_name: syntheticAccount.bank_name, branch_name: '', account_number: '0000123456' };
    expect(parseAccountInput(account).account_number).toBe('0000123456');
    expect(parseAccountInput({ ...account, account_number: '００００ 123456' }).account_number).toBe('0000123456');
    for (const account_number of ['尾号1234', '***1234', '①234', 'ABC123']) expect(() => parseAccountInput({ ...account, account_number })).toThrow();
    const item = syntheticItem(); item.extracted!.payee.name.raw = ' 合成对手　';
    expect(parseGroupingItem(item).extracted!.payee.name.raw).toBe(' 合成对手　');
    expect(parseGroupingHeader(syntheticHeader())).toEqual(syntheticHeader());
  });
  it('rejects private paths, injected evidence, partial blank fields and malformed numbers without echoing data', () => {
    const header = syntheticHeader();
    const requests = [
      { op: 'batch_receipt_grouping_page', ...groupingExpected(header), offset: 0, limit: 200, grouping_database_path: 'private-path-123' },
      { op: 'batch_receipt_grouping_refresh', ...groupingExpected(header), segment_ids: Array(51).fill(syntheticHash()) },
      { op: 'batch_receipt_grouping_save', ...groupingExpected(header), edits: [{ segment_id: syntheticHash(), expected_basis_fingerprint: syntheticHash(), field_overrides: [{ side: 'payer', field: 'name', value: 'private-company-123', state: 'blank', reason: '人工核对', evidence: [] }] }], group_edits: [] },
    ];
    for (const request of requests) { expect(() => validateGroupingRequest(request)).toThrow(); try { validateGroupingRequest(request); } catch (error) { expect(String(error)).not.toMatch(/private-|path-123/); } }
    const item = syntheticItem(); item.extracted!.payer.name.evidence[0].rect!.x1 = Infinity;
    expect(() => parseGroupingItem(item)).toThrow();
    expect(() => parseGroupingHeader({ ...header, grouping_revision: true })).toThrow();
  });
  it('keeps own pending, counterpart pending and confirmed empty routes mutually exclusive', () => {
    const ownPending = { ...syntheticItem(), route: 'own_pending', group: null, own_decision: { status: 'pending', method: 'none', side: null, source_bank_status: 'unknown', reasons: ['source_bank_unknown'] } };
    expect(parseGroupingItem(ownPending).group).toBeNull();
    expect(() => parseGroupingItem({ ...ownPending, group: syntheticItem().group })).toThrow();
    expect(() => parseGroupingItem({ ...syntheticItem(), own_decision: { ...syntheticItem().own_decision, source_bank_status: 'unknown' } })).toThrow();
    expect(() => parseGroupingItem({ ...syntheticItem(), route: 'blank' })).toThrow();
  });
  it('permits first prepare sentinel only and requires explicit manual identity assertions', () => {
    expect(validateGroupingRequest({ op: 'batch_receipt_grouping_prepare', job_id: 'job', result_revision: 'revision', expected_grouping_revision: -1 }).op).toBe('batch_receipt_grouping_prepare');
    expect(() => validateGroupingRequest({ op: 'batch_receipt_grouping_page', ...groupingExpected(syntheticHeader()), expected_grouping_revision: -1, offset: 0, limit: 1 })).toThrow();
    expect(() => validateGroupingRequest({ op: 'batch_receipt_grouping_save', ...groupingExpected(syntheticHeader()), edits: [{ segment_id: syntheticHash(), expected_basis_fingerprint: syntheticHash(), own_confirmation: { side: 'payer', confirms_selected_account: true, confirms_source_bank: false, reason: '已核对' } }], group_edits: [] })).toThrow();
  });
  it('rejects inconsistent pagination and duplicate editable fields', () => {
    expect(() => parseGroupingPage({ header: syntheticHeader(2), items: [syntheticItem()], offset: 0, total: 2, next_offset: null }, 0, 200)).toThrow();
    const override = { side: 'payee', field: 'name', value: '人工名称', state: 'present', reason: '核对原件' };
    expect(() => validateGroupingRequest({ op: 'batch_receipt_grouping_save', ...groupingExpected(syntheticHeader()), edits: [{ segment_id: syntheticHash(), expected_basis_fingerprint: syntheticHash(), field_overrides: [override, override] }], group_edits: [] })).toThrow();
  });
  it.each(['unknown', 'mismatch'] as const)('only batch_profile permits confirmed nullable side and %s source', (source_bank_status) => {
    const item = syntheticItem();
    item.route = 'counterparty_pending'; item.group = { ...item.group!, kind: 'counterparty_pending' };
    item.counterparty = null;
    item.own_decision = { status: 'confirmed', method: 'batch_profile', side: null, source_bank_status, reasons: ['own_account_missing'] };
    expect(parseGroupingItem(item).own_decision).toEqual(item.own_decision);
    for (const method of ['account_match', 'manual', 'none'] as const) {
      expect(() => parseGroupingItem({ ...item, own_decision: { ...item.own_decision, method } })).toThrow();
      expect(() => parseGroupingItem({ ...item, own_decision: { ...item.own_decision, method, side: 'payer' } })).toThrow();
    }
    expect(() => parseGroupingItem({ ...item, own_decision: { ...item.own_decision, status: 'pending' } })).toThrow();
  });
  it('batch profile does not mix configured account into extracted raw data and permits direct counterparty edit', () => {
    const item = syntheticItem(); const extracted = structuredClone(item.extracted);
    item.own_decision = { status: 'confirmed', method: 'batch_profile', side: null, source_bank_status: 'unknown', reasons: ['own_account_missing'] };
    expect(parseGroupingItem(item).extracted).toEqual(extracted);
    const field = { side: 'counterparty', field: 'name', value: '合成收款公司', state: 'present', reason: '用户对照原件修正交易对手名称。' };
    const request = validateGroupingRequest({ op: 'batch_receipt_grouping_save', ...groupingExpected(syntheticHeader()),
      edits: [{ segment_id: item.binding.segment_id, expected_basis_fingerprint: item.basis_fingerprint, field_overrides: [field] }], group_edits: [] });
    expect(request.op).toBe('batch_receipt_grouping_save');
  });
});
