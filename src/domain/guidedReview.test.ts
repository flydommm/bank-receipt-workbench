import { describe, expect, it } from 'vitest';
import {
  cropPageKey,
  type CropTemplatePage,
} from './batchCrop';
import type { ReviewSegment } from './cropReview';
import {
  buildGuidedReviewBankGroups,
  buildGuidedReviewGroups,
  getReceiptIdentity,
  isGuidedBankComplete,
} from './guidedReview';

const BANK_A = 'a'.repeat(64);
const BANK_B = 'b'.repeat(64);
const TEMPLATE_1 = '1'.repeat(64);
const TEMPLATE_2 = '2'.repeat(64);

function segment(
  id: string,
  sourceKey: string,
  sourceSha256: string,
  overrides: Partial<ReviewSegment> = {},
): ReviewSegment {
  return {
    id,
    sourceKey,
    sourceName: `${sourceKey}.pdf`,
    sourcePath: `D:/documents/${sourceKey}.pdf`,
    sourceSha256,
    sourcePage: 1,
    segmentNo: 99,
    matchRect: { x0: 100, y0: 80, x1: 180, y1: 120 },
    candidateRect: { x0: 0, y0: 0, x1: 600, y1: 280 },
    finalRect: { x0: 0, y0: 0, x1: 600, y1: 280 },
    pageWidth: 600,
    pageHeight: 1000,
    confidence: 0.99,
    slot: null,
    layoutFingerprint: `layout-${sourceKey}`,
    mode: 'candidate',
    reviewStatus: 'needs_review',
    manualAdjusted: false,
    ...overrides,
  };
}

function pageFor(
  value: ReviewSegment,
  options: {
    bankKey?: string | null;
    bankName?: string | null;
    templateFingerprint?: string | null;
    anchorY?: number;
    pageHeight?: number;
    status?: 'ready' | 'unavailable';
  } = {},
): CropTemplatePage {
  const pageHeight = options.pageHeight ?? value.pageHeight;
  const status = options.status ?? 'ready';
  return {
    status: 'ok',
    page: value.sourcePage,
    page_count: Math.max(100, value.sourcePage),
    page_width: value.pageWidth,
    page_height: pageHeight,
    source_sha256: value.sourceSha256,
    crop_template: status === 'unavailable'
      ? { status: 'unavailable', reason: 'ambiguous_layout' }
      : {
        status: 'ready',
        fingerprint: 'page-fingerprint'.repeat(4).slice(0, 64),
        receipts: [{
          anchor_y: options.anchorY ?? 100,
          bounds: { x0: 0, y0: 0, x1: 600, y1: pageHeight },
          title_key: 'title'.repeat(13).slice(0, 64),
          issuer_bank_key: options.bankKey === undefined ? BANK_A : options.bankKey,
          issuer_bank_name: options.bankName,
          template_fingerprint: options.templateFingerprint === undefined
            ? TEMPLATE_1 : options.templateFingerprint,
        }],
      },
  };
}

function pagesFor(
  values: Array<[ReviewSegment, CropTemplatePage]>,
): ReadonlyMap<string, CropTemplatePage> {
  return new Map(values.map(([value, page]) => [cropPageKey(value), page]));
}

describe('getReceiptIdentity', () => {
  it('requires the strict page identity, unique hit ownership, issuer key, and receipt template', () => {
    const value = segment('safe', 'safe-source', 'c'.repeat(64));
    const page = pageFor(value, { bankName: '示例银行' });
    expect(getReceiptIdentity(value, page)).toMatchObject({
      issuerBankKey: BANK_A,
      issuerBankName: '示例银行',
      templateFingerprint: TEMPLATE_1,
      anchorY: 100,
      pageHeight: 1000,
    });

    expect(getReceiptIdentity({ ...value, sourceSha256: 'd'.repeat(64) }, page)).toBeNull();
    expect(getReceiptIdentity(value, pageFor(value, { status: 'unavailable' }))).toBeNull();
    expect(getReceiptIdentity(value, pageFor(value, { bankKey: null, templateFingerprint: null }))).toBeNull();
  });

  it('does not use a payer or payee bank field when the issuing identity is absent', () => {
    const value = segment('payer-only', 'payer-only-source', 'e'.repeat(64));
    const page = pageFor(value, { bankKey: null, templateFingerprint: null });
    expect(getReceiptIdentity(value, page)).toBeNull();
  });
});

describe('buildGuidedReviewGroups', () => {
  it('merges the same verified bank and form across PDFs', () => {
    const first = segment('first', 'first-pdf', '1'.repeat(64), { segmentNo: 7 });
    const second = segment('second', 'second-pdf', '2'.repeat(64), { segmentNo: 1, sourcePage: 23 });
    const pages = pagesFor([
      [first, pageFor(first, { bankName: '示例银行' })],
      [second, pageFor(second, { bankName: '示例银行', anchorY: 120 })],
    ]);

    const groups = buildGuidedReviewGroups([first, second], pages);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      bankKey: BANK_A,
      templateFingerprint: TEMPLATE_1,
      segmentIds: ['first', 'second'],
      sourceKeys: ['first-pdf', 'second-pdf'],
    });
    expect(groups[0]?.key).toContain(`bank:${BANK_A}`);
    expect(groups[0]?.label).toContain('示例银行');
  });

  it('keeps different banks and banks mixed into one PDF in separate rounds', () => {
    const first = segment('bank-a', 'mixed-pdf', '3'.repeat(64));
    const second = segment('bank-b', 'mixed-pdf', '3'.repeat(64), { sourcePage: 2, segmentNo: 2, matchRect: { x0: 100, y0: 400, x1: 180, y1: 440 } });
    const pages = pagesFor([
      [first, pageFor(first, { bankKey: BANK_A })],
      [second, pageFor(second, { bankKey: BANK_B, anchorY: 100 })],
    ]);

    const groups = buildGuidedReviewGroups([first, second], pages);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.bankKey)).toEqual([BANK_A, BANK_B]);
    expect(groups.every((group) => group.sourceKeys.length === 1 && group.sourceKeys[0] === 'mixed-pdf')).toBe(true);
  });

  it('keeps different forms separate while matching a single-receipt tail to the first position', () => {
    const top = segment('top', 'multi-page', '4'.repeat(64), { sourcePage: 1 });
    const middle = segment('middle', 'multi-page', '4'.repeat(64), { sourcePage: 2, segmentNo: 2, matchRect: { x0: 100, y0: 400, x1: 180, y1: 440 } });
    const tail = segment('tail', 'tail-page', '5'.repeat(64), { sourcePage: 9, pageHeight: 500 });
    const differentForm = segment('other-form', 'other-form', '6'.repeat(64), { sourcePage: 3 });
    const pages = pagesFor([
      [top, pageFor(top, { anchorY: 100 })],
      [middle, pageFor(middle, { anchorY: 500 })],
      [tail, pageFor(tail, { anchorY: 50, pageHeight: 500 })],
      [differentForm, pageFor(differentForm, { templateFingerprint: TEMPLATE_2 })],
    ]);

    const groups = buildGuidedReviewGroups([top, middle, tail, differentForm], pages);
    expect(groups).toHaveLength(3);
    expect(groups.find((group) => group.segmentIds.includes('top'))?.segmentIds).toEqual(['top', 'tail']);
    expect(groups.find((group) => group.segmentIds.includes('middle'))?.positionKey)
      .not.toBe(groups.find((group) => group.segmentIds.includes('top'))?.positionKey);
    expect(groups.find((group) => group.segmentIds.includes('other-form'))?.templateFingerprint).toBe(TEMPLATE_2);
  });

  it('uses one independent unknown round per segment and never guesses from a filename', () => {
    const first = segment('unknown-a', '工商银行_批量.pdf', '7'.repeat(64));
    const second = segment('unknown-b', '工商银行_批量.pdf', '7'.repeat(64), { segmentNo: 2 });
    const unavailable = pageFor(first, { status: 'unavailable' });
    const groups = buildGuidedReviewGroups([first, second], new Map([
      [cropPageKey(first), unavailable],
    ]));
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.bankKey === null && group.segmentIds.length === 1)).toBe(true);
    expect(groups.every((group) => group.key.startsWith('unknown:'))).toBe(true);
    expect(groups[0]?.label).toContain('待核实来源');

    const bankGroups = buildGuidedReviewBankGroups(groups);
    expect(bankGroups).toHaveLength(1);
    expect(bankGroups[0]).toMatchObject({
      bankKey: null,
      sourceKeys: ['工商银行_批量.pdf'],
      segmentIds: ['unknown-a', 'unknown-b'],
    });
    expect(bankGroups[0]?.positionGroupKeys).toEqual(groups.map((group) => group.key));
  });

  it('keeps exact 51/55/56 verified positions in separate rounds under one bank', () => {
    const positionSpecs = [
      { prefix: 'top', anchorY: 100, count: 51 },
      { prefix: 'middle', anchorY: 400, count: 55 },
      { prefix: 'bottom', anchorY: 700, count: 56 },
    ];
    const values: Array<[ReviewSegment, CropTemplatePage]> = [];
    for (const spec of positionSpecs) {
      for (let index = 0; index < spec.count; index += 1) {
        const value = segment(`${spec.prefix}-${index}`, 'large-source', 'a'.repeat(64), {
          sourcePage: values.length + 1,
          segmentNo: index + 1,
        });
        values.push([value, pageFor(value, { anchorY: spec.anchorY, bankKey: BANK_A, templateFingerprint: TEMPLATE_1 })]);
      }
    }

    const groups = buildGuidedReviewGroups(values.map(([value]) => value), pagesFor(values));
    expect(groups.map((group) => group.segmentIds.length)).toEqual([51, 55, 56]);
    expect(groups.every((group) => group.bankKey === BANK_A && group.templateFingerprint === TEMPLATE_1)).toBe(true);
    const bankGroups = buildGuidedReviewBankGroups(groups);
    expect(bankGroups).toHaveLength(1);
    expect(bankGroups[0]?.segmentIds).toHaveLength(162);
    expect(bankGroups[0]?.positionGroupKeys).toEqual(groups.map((group) => group.key));
  });
});

describe('guided bank completion', () => {
  it('requires every bank id to be explicitly confirmed in this session', () => {
    const first = segment('complete-a', 'pdf-a', '8'.repeat(64), { reviewStatus: 'confirmed' });
    const second = segment('complete-b', 'pdf-b', '9'.repeat(64), { reviewStatus: 'confirmed' });
    const pages = pagesFor([
      [first, pageFor(first)],
      [second, pageFor(second, { anchorY: 120 })],
    ]);
    const rounds = buildGuidedReviewGroups([first, second], pages);
    const bankGroups = buildGuidedReviewBankGroups(rounds);
    const segmentsById = new Map([[first.id, first], [second.id, second]]);

    expect(isGuidedBankComplete(BANK_A, bankGroups, segmentsById, new Set(['complete-a']))).toBe(false);
    expect(isGuidedBankComplete(BANK_A, bankGroups, segmentsById, new Set(['complete-a', 'complete-b']))).toBe(true);
    expect(isGuidedBankComplete(BANK_A, bankGroups, segmentsById, new Set(['complete-a', 'complete-b', 'extra']))).toBe(true);
    expect(isGuidedBankComplete(BANK_A, bankGroups, new Map([[first.id, { ...first, reviewStatus: 'needs_review' }], [second.id, second]]), new Set(['complete-a', 'complete-b']))).toBe(false);
  });

  it('also accepts position groups directly and never treats an unknown group as a bank', () => {
    const value = segment('unknown', 'unknown', 'a'.repeat(64), { reviewStatus: 'confirmed' });
    const group = buildGuidedReviewGroups([value], new Map());
    expect(isGuidedBankComplete(BANK_A, group, new Map([[value.id, value]]), new Set([value.id]))).toBe(false);
  });
});
