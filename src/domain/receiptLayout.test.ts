import { describe, expect, it } from 'vitest';
import fixture from '../../tests/fixtures/receipt_layout_v1.json';
import optionsFixture from '../../tests/fixtures/receipt_layout_options_v1.json';
import {
  ReceiptLayoutError, parsePageResult, parseLayoutDefinition, parseProcessingOptions,
  requireLayoutCapability, legacyProcessingMode, changedSlotIds, canIncludeTarget,
  makeInstanceId, parseCapabilities,
} from './receiptLayout';

describe('shared receipt layout wire contract', () => {
  for (const item of fixture.valid_cases) {
    it(item.name, () => expect(parsePageResult(item.value)).toEqual(item.value));
  }
  for (const item of fixture.invalid_cases) {
    it(item.name, () => {
      try { parsePageResult(item.value); expect.fail('invalid payload accepted'); }
      catch (error) {
        expect(error).toBeInstanceOf(ReceiptLayoutError);
        expect((error as ReceiptLayoutError).code).toBe(item.code);
      }
    });
  }
});

describe('processing mode stays explicit', () => {
  for (const item of optionsFixture.options_valid)
    it(item.name, () => expect(parseProcessingOptions(item.input)).toEqual(item.output));
  for (const item of optionsFixture.capabilities_valid)
    it(item.name, () => expect(parseCapabilities(item.input)).toEqual(item.input));
  for (const [items, parser] of [
    [optionsFixture.options_invalid, parseProcessingOptions],
    [optionsFixture.capabilities_invalid, parseCapabilities],
  ] as const) for (const item of items) it(item.name, () => {
    try { parser(item.input); expect.fail('invalid payload accepted'); }
    catch (error) {
      expect(error).toBeInstanceOf(ReceiptLayoutError);
      expect((error as ReceiptLayoutError).code).toBe(item.code);
    }
  });
  it('accepts split_all without fabricated search criteria', () => {
    expect(parseProcessingOptions({ processing_mode: 'split_all', criteria: null }))
      .toEqual({ processing_mode: 'split_all', criteria: null });
  });
  it('keeps search nonempty and refuses stale criteria in split_all', () => {
    for (const input of [
      { processing_mode: 'search', criteria: { include: [], includeMode: 'all', exclude: [] } },
      { processing_mode: 'split_all', criteria: { include: ['fee'], includeMode: 'all', exclude: [] } },
      { criteria: null }, { processing_mode: 'anything', criteria: null },
    ]) expect(() => parseProcessingOptions(input)).toThrow(ReceiptLayoutError);
    expect(legacyProcessingMode(undefined)).toBe('search');
    expect(() => legacyProcessingMode(null)).toThrow(ReceiptLayoutError);
  });
  it('does not normalize malformed criteria into valid requests', () => {
    for (const criteria of [
      { include: ['fee', false], includeMode: 'all', exclude: [] },
      { include: ['fee'], includeMode: 'unknown', exclude: [] },
      { include: ['fee'], includeMode: 'all', exclude: [], extra: true },
      { include: ['x'.repeat(513)], includeMode: 'all', exclude: [] },
      { include: Array.from({ length: 33 }, (_, i) => `q${i}`), includeMode: 'all', exclude: [] },
    ]) expect(() => parseProcessingOptions({ processing_mode: 'search', criteria })).toThrow(ReceiptLayoutError);
  });
  it('requires both host and engine to declare the new contract', () => {
    const ready = { contract_version: 1, processing_modes: ['search', 'split_all'], layout_schema_versions: [1] };
    const searchOnly = { ...ready, processing_modes: ['search'] };
    expect(() => requireLayoutCapability(ready, ready, 'split_all')).not.toThrow();
    for (const sides of [[null, ready], [ready, null], [searchOnly, ready], [ready, searchOnly]])
      expect(() => requireLayoutCapability(sides[0], sides[1], 'split_all')).toThrow(ReceiptLayoutError);
    expect(() => requireLayoutCapability({ ...ready, contract_version: 2 }, ready, 'search')).toThrow();
  });
});

describe('stable positions and complete change scope', () => {
  const baseline = () => parseLayoutDefinition(fixture.valid_cases[0].value.layout_definition);
  it('moves one position without changing other identities', () => {
    const before = baseline(); const after = baseline();
    before.uniform_height = false; after.uniform_height = false;
    after.slots[1].top_pt += 5; after.slots[1].height_pt -= 5; after.revision += 1;
    expect(changedSlotIds(before, after)).toEqual(['slot-2']);
    expect(makeInstanceId('a'.repeat(64), 1, before, 'slot-2'))
      .not.toBe(makeInstanceId('a'.repeat(64), 1, after, 'slot-2'));
  });
  it('shared size affects all positions including previously saved positions', () => {
    const before = baseline(); const after = baseline();
    after.slots.forEach((slot) => { slot.height_pt -= 5; });
    expect(changedSlotIds(before, after)).toEqual(['slot-1', 'slot-2', 'slot-3']);
    after.left_pt = 2;
    expect(changedSlotIds(before, after)).toEqual(['slot-1', 'slot-2', 'slot-3']);
  });
  it('slot count changes invalidate the complete old and new set', () => {
    const before = baseline(); const after = baseline();
    after.slots = Array.from({ length: 4 }, (_, i) => ({ slot_id: `slot-${i + 1}`, position_index: i + 1, top_pt: i * 225, height_pt: 225 }));
    expect(changedSlotIds(before, after)).toEqual(['slot-1', 'slot-2', 'slot-3', 'slot-4']);
  });
  it('automatic confirmation never excludes a target; human exceptions need opt-in', () => {
    expect(canIncludeTarget(false, false, false)).toBe(true);
    expect(canIncludeTarget(true, false, false)).toBe(false);
    expect(canIncludeTarget(false, true, false)).toBe(false);
    expect(canIncludeTarget(true, true, true)).toBe(true);
    expect(() => canIncludeTarget(true, true, 'false' as unknown as boolean)).toThrow(ReceiptLayoutError);
  });
  it('rejects NaN, Infinity and unsafe integers before geometry is used', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const input = baseline(); input.slots[0].height_pt = value;
      expect(() => parseLayoutDefinition(input)).toThrow(ReceiptLayoutError);
    }
    const input = baseline(); input.revision = Number.MAX_SAFE_INTEGER + 1;
    expect(() => parseLayoutDefinition(input)).toThrow(ReceiptLayoutError);
  });
});
