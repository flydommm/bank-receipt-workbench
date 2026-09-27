// @vitest-environment jsdom
// @ts-expect-error The test runtime exposes Node crypto without @types/node.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReceiptRecord,
  RECEIPT_DOCUMENT_TYPES,
  computeReceiptProcessingFingerprint,
  makeReceiptInstanceId,
  parseReceiptSnapshotItem,
  validateReceiptContext,
  validateReceiptEdit,
  validateReceiptOriginals,
  validateReceiptRecord,
  type ReceiptReviewEdit,
  type ReceiptReviewOriginal,
  type ReceiptSnapshotItem,
} from './receiptReview';

const SHA_A = 'a'.repeat(64);
const LAYOUT_SHA = 'b'.repeat(64);
const ANALYSIS_SHA = 'c'.repeat(64);
const ITEM_A = 'd'.repeat(64);
const GEOMETRY = {
  pdf_box: { x0: 0, y0: 0, x1: 600, y1: 900 },
  rotation: 0,
  user_unit: 1,
  width_pt: 600,
  height_pt: 900,
} as const;
const CANDIDATE = { x0: 0, y0: 600, x1: 600, y1: 900 } as const;

function options(processingMode: 'search' | 'split_all' = 'search') {
  return processingMode === 'search'
    ? { processing_mode: 'search' as const, criteria: { include: ['手续费'], includeMode: 'all' as const, exclude: [] } }
    : { processing_mode: 'split_all' as const, criteria: null };
}

async function contextValue(
  processingMode: 'search' | 'split_all' = 'search',
  sourcePath = 'C:/Documents/report.pdf',
  sourceKey = sourcePath,
) {
  const processingOptions = options(processingMode);
  return {
    version: 3 as const,
    sources: [{ source_key: sourceKey, source_path: sourcePath, source_sha256: SHA_A }],
    processing_options: processingOptions,
    match_mode: 'exact' as const,
    criteria_fingerprint: await computeReceiptProcessingFingerprint(processingOptions, 'exact'),
    computation_version: 'receipt-engine-v3',
  };
}

function originalValue(overrides: Partial<ReceiptReviewOriginal> = {}): ReceiptReviewOriginal {
  const sourceKey = overrides.source_key ?? 'c:/documents/report.pdf';
  const slotId = overrides.slot_id ?? 'slot-3';
  const layoutId = overrides.layout_id ?? 'layout-report';
  const layoutRevision = overrides.layout_revision ?? 2;
  return {
    id: ITEM_A,
    source_key: sourceKey,
    source_page: 1,
    instance_id: makeReceiptInstanceId(SHA_A, 1, layoutId, layoutRevision, slotId),
    slot_id: slotId,
    position_index: 3,
    layout_id: layoutId,
    layout_revision: layoutRevision,
    layout_signature: LAYOUT_SHA,
    page_geometry: structuredClone(GEOMETRY),
    candidate_rect: structuredClone(CANDIDATE),
    occupancy: 'occupied',
    selection_basis: 'keyword',
    needs_review: false,
    analysis_signature: ANALYSIS_SHA,
    ...overrides,
  };
}

function editValue(contextKey: string, original: ReceiptReviewOriginal, overrides: Partial<ReceiptReviewEdit> = {}): ReceiptReviewEdit {
  return {
    schema_version: 1,
    context_key: contextKey,
    result_revision: 'run-1',
    id: original.id,
    source_key: original.source_key,
    instance_id: original.instance_id,
    analysis_signature: original.analysis_signature,
    record_revision: 0,
    final_rect: structuredClone(original.candidate_rect),
    crop_mode: 'candidate',
    review_status: 'confirmed',
    manual_adjusted: false,
    reviewed_at: '2026-09-14T10:20:30.000Z',
    ...overrides,
  };
}

function snapshotValue(original: ReceiptReviewOriginal = originalValue()): ReceiptSnapshotItem {
  return {
    original: structuredClone(original),
    segment: {
      ...structuredClone(original),
      source_path: 'C:/Documents/report.pdf',
      source_sha256: SHA_A,
      final_rect: structuredClone(original.candidate_rect),
      crop_mode: 'candidate',
      review_status: original.needs_review ? 'needs_review' : 'confirmed',
      manual_adjusted: false,
    },
    evidence: [{ query_id: 'include-0', rect: { x0: 20, y0: 620, x1: 150, y1: 640 } }],
  };
}

describe('schema-3 receipt review contract', () => {
  it.each(RECEIPT_DOCUMENT_TYPES)('round-trips the explicit %s classification without changing the original or geometry', (document_type) => {
    const original = originalValue();
    const edit = validateReceiptEdit(editValue(SHA_A, original, { document_type, review_status: 'needs_review' }));
    const record = buildReceiptRecord(original, edit, 'D:/relocated/report.pdf', SHA_A, 1);
    expect(validateReceiptRecord(record)).toEqual(record);
    expect(record.document_type).toBe(document_type);
    expect(record.original).toEqual(originalValue());
    expect(record.final_rect).toEqual(original.candidate_rect);
  });
  it.each([null, undefined, '', 'special', 1, true])('rejects an invalid present classification %s', (document_type) => {
    expect(() => validateReceiptEdit({ ...editValue(SHA_A, originalValue()), document_type })).toThrow();
  });
  it('preserves legacy automatic records without inventing a manual ordinary override', () => {
    const original = originalValue();
    const record = buildReceiptRecord(original, editValue(SHA_A, original), 'D:/relocated/report.pdf', SHA_A, 1);
    expect(validateReceiptRecord(record)).not.toHaveProperty('document_type');
  });
  beforeEach(() => vi.stubGlobal('crypto', webcrypto));
  afterEach(() => vi.unstubAllGlobals());

  it('rejects a trailing unpaired high surrogate before encoding JSON', () => {
    const malformed = originalValue({ id: `${'a'.repeat(63)}\uD800` });

    expect(() => validateReceiptOriginals([malformed], { [malformed.source_key]: SHA_A }))
      .toThrow(/valid Unicode/);
  });

  it('validates context fingerprints and keeps relocated aliases out of context identity', async () => {
    const value = await contextValue('search', 'D:/relocated/report.pdf', 'C:/Documents/report.pdf');
    await expect(validateReceiptContext(value)).rejects.toThrow(/source_path/);

    const first = await validateReceiptContext(value, { trustedAliases: true });
    const second = await validateReceiptContext({
      ...value,
      sources: [{ ...value.sources[0], source_path: 'C:/Documents/report.pdf' }],
    });
    expect(first.context.sources[0]?.source_key).toBe('c:/documents/report.pdf');
    expect(first.context.sources[0]?.source_path).toBe('D:/relocated/report.pdf');
    expect(first.sourceShaByKey).toEqual({ 'c:/documents/report.pdf': SHA_A });
    expect(first.contextKey).toBe(second.contextKey);
    expect(first.contextKey).toMatch(/^[a-f0-9]{64}$/);

    await expect(validateReceiptContext({ ...value, criteria_fingerprint: '0'.repeat(64) }, { trustedAliases: true }))
      .rejects.toThrow(/criteria_fingerprint/);
  });

  it('uses the Python processing fingerprint payload for both processing modes', async () => {
    const search = await computeReceiptProcessingFingerprint(options('search'), 'exact');
    const split = await computeReceiptProcessingFingerprint(options('split_all'), 'exact');
    expect(search).toMatch(/^[a-f0-9]{64}$/);
    expect(split).toMatch(/^[a-f0-9]{64}$/);
    // Generated by engine.receipt_snapshot.processing_fingerprint with the
    // same JSON value; this guards the cross-language canonical/hash boundary.
    expect(search).toBe('97072b8d9b3a8e3bc04fdb64294bc5373d3a30c491476ae3060af013ce18a6e4');
    expect(search).not.toBe(split);
    await expect(computeReceiptProcessingFingerprint({
      processing_mode: 'search', criteria: { include: [' 手续费 ', '手续费'], includeMode: 'all', exclude: [] },
    }, 'exact')).resolves.toBe(search);
  });

  it('validates originals without rebuilding a manifest or accepting match data', async () => {
    const original = originalValue();
    const result = validateReceiptOriginals([original], { 'C:/Documents/report.pdf': SHA_A });
    expect(result).toEqual([original]);
    expect(result[0]).not.toHaveProperty('match_rect');
    expect(result[0]).not.toHaveProperty('confidence');

    const searchContext = await validateReceiptContext(await contextValue());
    expect(() => validateReceiptOriginals([original], searchContext.sourceShaByKey, searchContext.context)).not.toThrow();
    expect(() => validateReceiptOriginals([{
      ...original,
      selection_basis: 'occupied_slot',
    }], searchContext.sourceShaByKey, searchContext.context)).toThrow(/selection_basis/);
    const splitContext = await validateReceiptContext(await contextValue('split_all'));
    expect(() => validateReceiptOriginals([{
      ...original,
      selection_basis: 'occupied_slot',
    }], splitContext.sourceShaByKey, splitContext.context)).not.toThrow();
    expect(() => validateReceiptOriginals([original], splitContext.sourceShaByKey, splitContext.context)).toThrow(/selection_basis/);
  });

  it('rejects malformed, duplicate, out-of-page, and incorrectly bound originals', () => {
    const original = originalValue();
    const map = { 'c:/documents/report.pdf': SHA_A };
    expect(() => validateReceiptOriginals([{ ...original, id: 'bad' }], map)).toThrow(/id/);
    expect(() => validateReceiptOriginals([original, structuredClone(original)], map)).toThrow(/unique/);
    expect(() => validateReceiptOriginals([{
      ...original,
      slot_id: 'slot-4',
    }], map)).toThrow(/instance_id/);
    expect(() => validateReceiptOriginals([{
      ...original,
      candidate_rect: { x0: 0, y0: 600, x1: 601, y1: 900 },
    }], map)).toThrow(/candidate_rect/);
    expect(() => validateReceiptOriginals([{
      ...original,
      source_key: 'C:/Documents/report.pdf',
    }], map)).toThrow(/source_key/);
  });

  it('validates the maximum 50,000 originals incrementally', () => {
    const originals = Array.from({ length: 50_000 }, (_, index) => {
      const sourcePage = index + 1;
      return originalValue({
        id: index.toString(16).padStart(64, '0'),
        source_page: sourcePage,
        instance_id: makeReceiptInstanceId(SHA_A, sourcePage, 'layout-report', 2, 'slot-3'),
      });
    });

    expect(validateReceiptOriginals(originals, { 'c:/documents/report.pdf': SHA_A })).toHaveLength(50_000);
  }, 30_000);

  it('accepts finite decimal geometry without rebuilding an original manifest', () => {
    const original = originalValue({
      page_geometry: {
        pdf_box: { x0: 0.125, y0: 0.25, x1: 600.25, y1: 900.5 },
        rotation: 0,
        user_unit: 1,
        width_pt: 600.125,
        height_pt: 900.25,
      },
      candidate_rect: { x0: 0.125, y0: 600.25, x1: 600.125, y1: 900.25 },
    });

    expect(validateReceiptOriginals([original], { 'c:/documents/report.pdf': SHA_A })).toEqual([original]);
  });

  it('supports candidate, manual, and full-page edit modes and binds records to originals', async () => {
    const context = await validateReceiptContext(await contextValue());
    const original = originalValue();
    const candidate = validateReceiptEdit(editValue(context.contextKey, original));
    const manual = validateReceiptEdit(editValue(context.contextKey, original, {
      crop_mode: 'manual',
      final_rect: { x0: 12, y0: 612, x1: 588, y1: 888 },
      manual_adjusted: true,
    }));
    const fullPage = validateReceiptEdit(editValue(context.contextKey, original, {
      crop_mode: 'full_page', final_rect: null,
    }));
    for (const edit of [candidate, manual, fullPage]) {
      const record = buildReceiptRecord(original, edit, 'D:/relocated/report.pdf', SHA_A, 1);
      expect(validateReceiptRecord(record)).toEqual(record);
      expect(record.original).toEqual(original);
    }
    expect(() => validateReceiptEdit(editValue(context.contextKey, original, {
      crop_mode: 'manual', manual_adjusted: false,
    }))).toThrow(/manually/);
    expect(() => validateReceiptEdit(editValue(context.contextKey, original, {
      crop_mode: 'full_page', final_rect: structuredClone(CANDIDATE),
    }))).toThrow(/full_page/);
    expect(() => buildReceiptRecord(original, manual, 'D:/relocated/report.pdf', SHA_A, 0)).toThrow(/positive/);
    expect(() => buildReceiptRecord(original, validateReceiptEdit(editValue(context.contextKey, original, {
      crop_mode: 'manual', final_rect: { x0: 0, y0: 590, x1: 600, y1: 890 }, manual_adjusted: true,
    })), 'D:/relocated/report.pdf', SHA_A, 1)).toThrow(/candidate|page/);
  });

  it('accepts excluded review edits while keeping the legacy snapshot status codec strict', async () => {
    const context = await validateReceiptContext(await contextValue());
    const original = originalValue({ needs_review: true });
    const excluded = validateReceiptEdit(editValue(context.contextKey, original, { review_status: 'excluded' }));
    const record = buildReceiptRecord(original, excluded, 'D:/relocated/report.pdf', SHA_A, 1);
    expect(validateReceiptRecord(record).review_status).toBe('excluded');
    expect(() => parseReceiptSnapshotItem({ ...snapshotValue(original), segment: {
      ...snapshotValue(original).segment, review_status: 'excluded',
    } as any })).toThrow();
  });

  it('validates initial snapshot items and rejects legacy or fabricated fields', () => {
    const item = snapshotValue();
    expect(parseReceiptSnapshotItem(item)).toEqual(item);
    expect(() => parseReceiptSnapshotItem({
      ...item,
      segment: { ...item.segment, confidence: 0.99 },
    })).toThrow(/segment/);
    expect(() => parseReceiptSnapshotItem({
      ...item,
      original: { ...item.original, candidate_rect: { x0: 0, y0: 600, x1: 601, y1: 900 } },
    })).toThrow(/candidate|segment original/);
    expect(() => parseReceiptSnapshotItem({
      ...item,
      evidence: [{ query_id: 'include-0', rect: { x0: 0, y0: 0, x1: 10, y1: 10 } }],
    })).toThrow(/evidence/);
    expect(() => parseReceiptSnapshotItem({
      ...item,
      segment: { ...item.segment, final_rect: { x0: 0, y0: 612, x1: 600, y1: 900 } },
    })).toThrow(/final/);
  });
});
