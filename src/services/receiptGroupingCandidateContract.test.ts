import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/groupingFieldCandidates.json';
import { parsePartyField, ReceiptGroupingValidationError } from '../domain/receiptGrouping';
import { ReceiptGroupingClient } from './receiptGroupingClient';
import { syntheticItem, syntheticSnapshot } from '../domain/receiptGrouping.testFixtures';

const ok = (data: unknown) => ({ status: 'ok', data });

describe('receipt grouping field candidate contract', () => {
  it('parses the shared synthetic public projection and rejects leaked candidate keys', () => {
    const ordinary = parsePartyField(fixture.public_output.ordinary);
    const ambiguous = parsePartyField(fixture.public_output.ambiguous);

    expect(ordinary.value).toBe('规范收款名称');
    expect(ambiguous.state).toBe('ambiguous');
    expect(ambiguous.candidates?.map((candidate) => candidate.value)).toEqual(['候选甲规范值', '候选乙显式值']);
    expect(ambiguous.candidates?.every((candidate) => Object.keys(candidate).sort().join(',') === 'evidence,raw,state,value')).toBe(true);

    const leaked = structuredClone(fixture.public_output.ambiguous) as Record<string, unknown>;
    const candidates = leaked.candidates as Array<Record<string, unknown>>;
    candidates[0].diagnostics = ['candidate-reader-trace-secret'];
    expect(() => parsePartyField(leaked)).toThrow(ReceiptGroupingValidationError);
  });

  it('keeps ambiguous fields valid through refresh and complete reload', async () => {
    const ordinary = parsePartyField(fixture.public_output.ordinary);
    const ambiguous = parsePartyField(fixture.public_output.ambiguous);
    const snapshot = syntheticSnapshot(2);
    const refreshed = structuredClone(snapshot);
    refreshed.header.grouping_revision = 2;
    const first = syntheticItem(1);
    const second = syntheticItem(2);
    first.extracted = { ...first.extracted!, payer: { ...first.extracted!.payer, name: ordinary }, payee: { ...first.extracted!.payee, name: ambiguous } };
    first.counterparty = { ...first.counterparty!, name: ambiguous };
    second.extracted = { ...second.extracted!, payer: { ...second.extracted!.payer, name: ambiguous }, payee: { ...second.extracted!.payee, name: ordinary } };
    second.counterparty = { ...second.counterparty!, name: ordinary };
    refreshed.items = [first, second];

    const transport = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const request = args!.request as { op: string };
      if (request.op === 'batch_receipt_grouping_refresh') return ok(refreshed);
      return ok({ header: refreshed.header, items: refreshed.items, offset: 0, total: 2, next_offset: null });
    });
    const client = new ReceiptGroupingClient(transport as never);
    const result = await client.refresh(snapshot.header, snapshot.items.map((item) => item.binding.segment_id));
    const loaded = await client.loadAll(result.header);

    expect(result.items[0].extracted?.payee.name.candidates).toHaveLength(2);
    expect(result.items[0].counterparty?.name.value).toBe('字段备用值');
    expect(loaded.items[1].extracted?.payer.name.candidates?.[1].value).toBe('候选乙显式值');
    expect(transport.mock.calls.map(([_, args]) => (args!.request as { op: string }).op)).toEqual([
      'batch_receipt_grouping_refresh',
      'batch_receipt_grouping_page',
    ]);
  });
});
