import { describe, expect, it } from 'vitest';

import type { PdfRect, ReviewSegment } from './cropReview';
import {
  batchSampleError,
  batchTargetProtection,
  createBatchCropPlan,
  cropPageKey,
  type BatchCropPlan,
  type CropTemplatePage,
} from './batchCrop';

const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;
const SAMPLE_SHA = 'a'.repeat(64);

const rect = (x0: number, y0: number, x1: number, y1: number): PdfRect => ({ x0, y0, x1, y1 });

function segment(overrides: Partial<ReviewSegment> = {}): ReviewSegment {
  return {
    id: 'sample',
    sourceKey: 'source-a',
    sourcePath: 'D:/docs/source-a.pdf',
    sourceSha256: SAMPLE_SHA,
    sourcePage: 1,
    segmentNo: 1,
    matchRect: rect(160, 180, 200, 220),
    candidateRect: rect(100, 100, 300, 300),
    finalRect: rect(90, 90, 310, 310),
    pageWidth: PAGE_WIDTH,
    pageHeight: PAGE_HEIGHT,
    confidence: 0.95,
    slot: 'top',
    layoutFingerprint: 'layout-1',
    mode: 'manual',
    reviewStatus: 'confirmed',
    manualAdjusted: true,
    ...overrides,
  };
}

type ReadyPageOverrides = Partial<Omit<CropTemplatePage, 'crop_template'>> & {
  crop_template?: CropTemplatePage['crop_template'];
};

function readyPage(
  sourceSha256: string,
  overrides: ReadyPageOverrides = {},
): CropTemplatePage {
  return {
    status: 'ok',
    page: 1,
    page_count: 3,
    page_width: PAGE_WIDTH,
    page_height: PAGE_HEIGHT,
    source_sha256: sourceSha256,
    crop_template: {
      status: 'ready',
      fingerprint: 'layout-1',
      receipts: [{
        anchor_y: 80,
        bounds: rect(20, 20, 580, 380),
        title_key: 'invoice',
      }],
    },
    ...overrides,
  };
}

function pageFor(segmentValue: ReviewSegment, page: CropTemplatePage): ReadonlyMap<string, CropTemplatePage> {
  return new Map([[cropPageKey(segmentValue), page]]);
}

function target(
  id: string,
  sourceKey: string,
  sourceSha256: string,
  sourcePage: number,
  candidateRect: PdfRect,
  overrides: Partial<ReviewSegment> = {},
): ReviewSegment {
  const offset = candidateRect.y0 - 80;
  return segment({
    id,
    sourceKey,
    sourcePath: `D:/docs/${sourceKey}.pdf`,
    sourceSha256,
    sourcePage,
    segmentNo: sourcePage,
    matchRect: rect(candidateRect.x0 + 60, candidateRect.y0 + 80, candidateRect.x0 + 100, candidateRect.y0 + 120),
    candidateRect,
    finalRect: { ...candidateRect },
    slot: sourcePage === 1 ? 'top' : sourcePage === 2 ? 'middle' : 'bottom',
    mode: 'candidate',
    reviewStatus: sourcePage === 2 ? 'needs_review' : 'pending',
    manualAdjusted: false,
    ...overrides,
  });
}

function pageForTarget(
  targetValue: ReviewSegment,
  overrides: ReadyPageOverrides = {},
): ReadonlyMap<string, CropTemplatePage> {
  const page = readyPage(targetValue.sourceSha256, {
    page: targetValue.sourcePage,
    ...overrides,
  });
  return pageFor(targetValue, page);
}

function mergePages(...maps: ReadonlyMap<string, CropTemplatePage>[]): ReadonlyMap<string, CropTemplatePage> {
  return new Map(maps.flatMap((map) => [...map.entries()]));
}

function reasonsById(plan: BatchCropPlan): Map<string, string> {
  return new Map(plan.skipped.map(({ segment: item, reason }) => [item.id, reason]));
}

describe('batchSampleError', () => {
  it('accepts a manually changed crop that is legal and contains its match', () => {
    expect(batchSampleError(segment())).toBeNull();
  });

  it('rejects missing, unadjusted, non-manual, unchanged, and malformed samples', () => {
    expect(batchSampleError(null)).toMatch(/样本/);
    expect(batchSampleError(segment({ manualAdjusted: false }))).toMatch(/人工/);
    expect(batchSampleError(segment({ mode: 'candidate' }))).toMatch(/手工/);
    expect(batchSampleError(segment({ finalRect: segment().candidateRect }))).toMatch(/改动/);
    expect(batchSampleError(segment({ finalRect: null }))).toMatch(/最终/);
    expect(batchSampleError(segment({ candidateRect: null }))).toMatch(/候选/);
    expect(batchSampleError(segment({
      matchRect: rect(0, 0, 500, 500),
      candidateRect: rect(100, 100, 300, 300),
    }))).toMatch(/命中/);
    expect(batchSampleError(segment({ finalRect: rect(-1, 90, 310, 310) }))).toMatch(/最终裁剪无效/);
    expect(batchSampleError(segment({ pageWidth: Number.NaN }))).toMatch(/有效|无效/);
  });
});

describe('batchTargetProtection', () => {
  const eligible = target('eligible', 'source-a', SAMPLE_SHA, 1, rect(100, 100, 300, 300));

  it('leaves a pending or needs-review candidate untouched by protection checks', () => {
    expect(batchTargetProtection(eligible)).toBeNull();
    expect(batchTargetProtection({ ...eligible, reviewStatus: 'needs_review' })).toBeNull();
  });

  it('reports confirmation, manual, full-page, and changed-final protections', () => {
    expect(batchTargetProtection({ ...eligible, reviewStatus: 'confirmed' })).toMatch(/确认|状态/);
    expect(batchTargetProtection({ ...eligible, manualAdjusted: true })).toMatch(/人工/);
    expect(batchTargetProtection({ ...eligible, mode: 'full_page' })).toMatch(/候选|整页/);
    expect(batchTargetProtection({ ...eligible, finalRect: rect(90, 100, 300, 300) })).toMatch(/最终|修改/);
  });
});

describe('createBatchCropPlan', () => {
  it('maps the sample edge delta to top, middle, and bottom receipts across files', () => {
    const sample = segment();
    const top = target('top-target', 'source-b', 'b'.repeat(64), 1, rect(100, 100, 300, 300), { slot: 'different-slot' });
    const middle = target('middle-target', 'source-c', 'c'.repeat(64), 2, rect(100, 310, 300, 510));
    const bottom = target('bottom-target', 'source-d', 'd'.repeat(64), 3, rect(100, 520, 300, 720));
    const pages = mergePages(
      pageForTarget(top),
      pageForTarget(middle, {
        crop_template: {
          status: 'ready',
          fingerprint: 'layout-1',
          receipts: [{ anchor_y: 290, bounds: rect(20, 200, 580, 580), title_key: 'invoice' }],
        },
      }),
      pageForTarget(bottom, {
        crop_template: {
          status: 'ready',
          fingerprint: 'layout-1',
          receipts: [{ anchor_y: 500, bounds: rect(20, 400, 580, 780), title_key: 'invoice' }],
        },
      }),
      pageFor(sample, readyPage(sample.sourceSha256)),
    );
    const before = structuredClone([sample, top, middle, bottom]);

    const plan = createBatchCropPlan(sample, [sample, top, middle, bottom], pages);

    expect(plan.sampleId).toBe(sample.id);
    expect(plan.skipped).toEqual([]);
    expect(plan.applicable.map(({ before: item }) => item.id)).toEqual([
      top.id,
      middle.id,
      bottom.id,
    ]);
    expect(plan.applicable.map(({ after }) => after.finalRect)).toEqual([
      rect(90, 90, 310, 310),
      rect(90, 300, 310, 520),
      rect(90, 510, 310, 730),
    ]);
    for (const { before: original, after } of plan.applicable) {
      expect(after.id).toBe(original.id);
      expect(after.sourceKey).toBe(original.sourceKey);
      expect(after.sourceSha256).toBe(original.sourceSha256);
      expect(after.sourcePage).toBe(original.sourcePage);
      expect(after.mode).toBe('manual');
      expect(after.manualAdjusted).toBe(true);
      expect(after.reviewStatus).toBe('confirmed');
    }
    expect(plan.applicable[0]?.before).toBe(top);
    expect([sample, top, middle, bottom]).toEqual(before);
  });

  it('skips metadata, SHA, geometry, layout, title, size, and offset mismatches with Chinese reasons', () => {
    const sample = segment();
    const missing = target('missing', 'missing-file', 'b'.repeat(64), 1, rect(100, 100, 300, 300));
    const badSha = target('bad-sha', 'bad-sha-file', 'c'.repeat(64), 1, rect(100, 100, 300, 300));
    const badGeometry = target('bad-geometry', 'bad-geometry-file', 'd'.repeat(64), 1, rect(100, 100, 300, 300));
    const badLayout = target('bad-layout', 'bad-layout-file', 'e'.repeat(64), 1, rect(100, 100, 300, 300));
    const badTitle = target('bad-title', 'bad-title-file', 'f'.repeat(64), 1, rect(100, 100, 300, 300));
    const badSize = target('bad-size', 'bad-size-file', '1'.repeat(64), 1, rect(100, 100, 302, 300));
    const badXOffset = target('bad-x-offset', 'bad-x-offset-file', '3'.repeat(64), 1, rect(102, 100, 302, 300));
    const badOffset = target('bad-offset', 'bad-offset-file', '2'.repeat(64), 1, rect(100, 102, 300, 302));
    const unavailable = target('unavailable', 'unavailable-file', '4'.repeat(64), 1, rect(100, 100, 300, 300));
    const pages = mergePages(
      pageFor(sample, readyPage(sample.sourceSha256)),
      pageForTarget(badSha, { source_sha256: '0'.repeat(64) }),
      pageForTarget(badGeometry, { page_width: PAGE_WIDTH + 1 }),
      pageForTarget(badLayout, {
        crop_template: { status: 'ready', fingerprint: 'other-layout', receipts: [{ anchor_y: 80, bounds: rect(20, 20, 580, 380), title_key: 'invoice' }] },
      }),
      pageForTarget(badTitle, {
        crop_template: { status: 'ready', fingerprint: 'layout-1', receipts: [{ anchor_y: 80, bounds: rect(20, 20, 580, 380), title_key: 'other-title' }] },
      }),
      pageForTarget(badSize),
      pageForTarget(badXOffset),
      pageForTarget(badOffset),
      pageForTarget(unavailable, { crop_template: { status: 'unavailable', reason: 'no_text' } }),
    );

    const plan = createBatchCropPlan(sample, [missing, badSha, badGeometry, badLayout, badTitle, badSize, badXOffset, badOffset, unavailable], pages);
    const reasons = reasonsById(plan);

    expect(plan.applicable).toEqual([]);
    expect(plan.skipped).toHaveLength(9);
    expect(reasons.get('missing')).toMatch(/元数据|版式/);
    expect(reasons.get('bad-sha')).toMatch(/SHA|来源/);
    expect(reasons.get('bad-geometry')).toMatch(/几何|页面/);
    expect(reasons.get('bad-layout')).toMatch(/版式/);
    expect(reasons.get('bad-title')).toMatch(/标题/);
    expect(reasons.get('bad-size')).toMatch(/尺寸|大小/);
    expect(reasons.get('bad-x-offset')).toMatch(/横向|位置/);
    expect(reasons.get('bad-offset')).toMatch(/标题|位置/);
    expect(reasons.get('unavailable')).toMatch(/文字/);
    expect([...reasons.values()].every((reason) => /[^\x00-\x7F]/.test(reason))).toBe(true);
  });

  it('rejects a sample whose final crop crosses its receipt boundary or an adjacent receipt', () => {
    const targetValue = target('target', 'target-file', 'b'.repeat(64), 1, rect(100, 100, 300, 300));
    const targetPage = pageForTarget(targetValue);

    const outside = segment({ finalRect: rect(10, 90, 310, 310) });
    expect(() => createBatchCropPlan(
      outside,
      [targetValue],
      mergePages(pageFor(outside, readyPage(outside.sourceSha256)), targetPage),
    )).toThrow(/保护边界/);

    const adjacent = segment({ finalRect: rect(90, 90, 310, 310) });
    expect(() => createBatchCropPlan(
      adjacent,
      [targetValue],
      mergePages(
        pageFor(adjacent, readyPage(adjacent.sourceSha256, {
          crop_template: {
            status: 'ready',
            fingerprint: 'layout-1',
            receipts: [
              { anchor_y: 80, bounds: rect(20, 20, 580, 380), title_key: 'invoice' },
              { anchor_y: 80, bounds: rect(250, 20, 580, 380), title_key: 'adjacent' },
            ],
          },
        })),
        targetPage,
      ),
    )).toThrow(/相邻凭证/);
  });

  it('skips protected or unsafe targets, including paper, receipt, match, minimum-size, and NaN failures', () => {
    const sample = segment();
    const confirmed = target('confirmed', 'confirmed-file', 'b'.repeat(64), 1, rect(100, 100, 300, 300), { reviewStatus: 'confirmed' });
    const manual = target('manual', 'manual-file', 'c'.repeat(64), 1, rect(100, 100, 300, 300), { manualAdjusted: true });
    const fullPage = target('full-page', 'full-page-file', 'd'.repeat(64), 1, rect(100, 100, 300, 300), { mode: 'full_page' });
    const changedFinal = target('changed-final', 'changed-final-file', 'e'.repeat(64), 1, rect(100, 100, 300, 300), { finalRect: rect(101, 100, 300, 300) });
    const paper = target('paper', 'paper-file', 'f'.repeat(64), 1, rect(100, 600, 300, 800));
    const receipt = target('receipt', 'receipt-file', '1'.repeat(64), 1, rect(100, 100, 300, 300));
    const missingMatch = target('missing-match', 'missing-match-file', '2'.repeat(64), 1, rect(100, 100, 300, 300), { matchRect: rect(280, 280, 350, 350) });
    const minimum = target('minimum', 'minimum-file', '3'.repeat(64), 1, rect(100, 100, 300, 300));
    const nanTarget = target('nan', 'nan-file', '4'.repeat(64), 1, rect(100, 100, 300, 300), { matchRect: rect(Number.NaN, 180, 200, 220) });
    const common = (item: ReviewSegment): ReadonlyMap<string, CropTemplatePage> => pageForTarget(item);
    const pages = mergePages(
      pageForTarget(sample, readyPage(sample.sourceSha256)),
      common(confirmed),
      common(manual),
      common(fullPage),
      common(changedFinal),
      pageForTarget(paper, { crop_template: { status: 'ready', fingerprint: 'layout-1', receipts: [{ anchor_y: 580, bounds: rect(20, 500, 580, 800), title_key: 'invoice' }] } }),
      pageForTarget(receipt, { crop_template: { status: 'ready', fingerprint: 'layout-1', receipts: [{ anchor_y: 80, bounds: rect(110, 20, 580, 380), title_key: 'invoice' }] } }),
      common(missingMatch),
      pageForTarget(minimum, { crop_template: { status: 'ready', fingerprint: 'layout-1', receipts: [{ anchor_y: 80, bounds: rect(20, 20, 580, 380), title_key: 'invoice' }] } }),
      common(nanTarget),
    );
    // Make the sample expansion produce a sub-minimum rectangle for one target.
    const narrowSample = segment({
      matchRect: rect(104, 104, 110, 110),
      candidateRect: rect(100, 100, 114, 114),
      finalRect: rect(101, 101, 113, 113),
    });
    const narrowMinimum = target('minimum', 'minimum-file', '5'.repeat(64), 1, rect(100, 100, 113, 113), {
      matchRect: rect(104, 104, 110, 110),
    });
    const narrowPages = mergePages(
      pageFor(narrowSample, readyPage(narrowSample.sourceSha256)),
      pageForTarget(narrowMinimum, { source_sha256: narrowMinimum.sourceSha256 }),
    );

    const plan = createBatchCropPlan(sample, [confirmed, manual, fullPage, changedFinal, paper, receipt, missingMatch, nanTarget], pages);
    const unsafeReasons = reasonsById(plan);
    expect(plan.applicable).toEqual([]);
    expect(unsafeReasons.get('confirmed')).toMatch(/确认|状态/);
    expect(unsafeReasons.get('manual')).toMatch(/人工/);
    expect(unsafeReasons.get('full-page')).toMatch(/整页|候选/);
    expect(unsafeReasons.get('changed-final')).toMatch(/最终|修改/);
    expect(unsafeReasons.get('paper')).toMatch(/纸|保护/);
    expect(unsafeReasons.get('receipt')).toMatch(/凭证|保护/);
    expect(unsafeReasons.get('missing-match')).toMatch(/命中|匹配/);
    expect(unsafeReasons.get('nan')).toMatch(/有效|无效/);

    const minimumPlan = createBatchCropPlan(narrowSample, [narrowMinimum], narrowPages);
    expect(minimumPlan.applicable).toEqual([]);
    expect(minimumPlan.skipped[0]?.reason).toMatch(/最小|尺寸/);
  });

  it('throws for an invalid sample or duplicate target IDs', () => {
    const validTarget = target('target', 'source-b', 'b'.repeat(64), 1, rect(100, 100, 300, 300));
    const pages = pageForTarget(validTarget);

    expect(() => createBatchCropPlan(segment({ manualAdjusted: false }), [validTarget], pages)).toThrow(/人工/);
    expect(() => createBatchCropPlan(segment(), [validTarget, { ...validTarget }], pages)).toThrow(/重复/);
    expect(() => createBatchCropPlan(null as unknown as ReviewSegment, [validTarget], pages)).toThrow(/样本/);
  });

  it('rejects malformed collections without mutating the caller-owned arrays', () => {
    const sample = segment();
    const malformed = { ...target('malformed', 'source-b', 'b'.repeat(64), 1, rect(100, 100, 300, 300)), pageHeight: Number.NaN };
    const targets = [malformed];
    const before = structuredClone(targets);

    const plan = createBatchCropPlan(sample, targets, pageForTarget(malformed));

    expect(plan.applicable).toEqual([]);
    expect(plan.skipped[0]?.reason).toMatch(/有效|无效/);
    expect(targets).toEqual(before);
  });
});
