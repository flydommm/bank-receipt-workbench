// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { buildExportPayloadForReviewSegments, buildReviewMatchPairs } from './App';
import type { EngineMatch } from './components/localEngineAdapter';
import type { PdfRect, ReviewSegment } from './domain/cropReview';
import type { SearchCriteria } from './domain/searchCriteria';

const SHARED_PATH = 'D:\\shared\\same-content.pdf';
const SHARED_SHA = 'a'.repeat(64);
const LOGICAL_A = 'd:/logical/a.pdf';
const LOGICAL_B = 'd:/logical/b.pdf';
const RECT_A: PdfRect = { x0: 20, y0: 30, x1: 120, y1: 60 };
const RECT_B: PdfRect = { x0: 220, y0: 130, x1: 360, y1: 170 };

function segment(
  id: string,
  sourceKey: string,
  sourceName: string,
  matchRect: PdfRect,
  finalRect: PdfRect,
): ReviewSegment {
  return {
    id,
    sourceKey,
    sourceName,
    sourcePath: SHARED_PATH,
    sourceSha256: SHARED_SHA,
    sourcePage: 1,
    segmentNo: 1,
    matchRect,
    candidateRect: { x0: 0, y0: 0, x1: 600, y1: 300 },
    finalRect,
    pageWidth: 600,
    pageHeight: 800,
    confidence: 0.96,
    slot: 'receipt',
    layoutFingerprint: 'shared-layout',
    mode: 'candidate',
    reviewStatus: 'confirmed',
    manualAdjusted: false,
  };
}

function match(sourceKey: string, text: string, rect: PdfRect): EngineMatch & { source_key: string } {
  return {
    source_key: sourceKey,
    source_path: SHARED_PATH,
    source_sha256: SHARED_SHA,
    page: 1,
    matched_text: text,
    matched_field: '摘要',
    confidence: 0.96,
    needs_review: false,
    x0: rect.x0,
    y0: rect.y0,
    x1: rect.x1,
    y1: rect.y1,
  };
}

describe('logical source identity with a shared physical access path', () => {
  it('pairs same-page segments by logical source without mixing their text', () => {
    const first = segment('logical-a-segment', LOGICAL_A, '逻辑来源 A.pdf', RECT_A, { x0: 0, y0: 0, x1: 200, y1: 180 });
    const second = segment('logical-b-segment', LOGICAL_B, '逻辑来源 B.pdf', RECT_B, { x0: 200, y0: 100, x1: 500, y1: 300 });
    const firstMatch = match(LOGICAL_A, '来源 A 文本', RECT_A);
    const secondMatch = match(LOGICAL_B, '来源 B 文本', RECT_B);

    const paired = buildReviewMatchPairs([firstMatch, secondMatch], [first, second]);

    expect(paired.error).toBeNull();
    expect(paired.pairs.map(({ hit, segment: item }) => [item.id, hit.matched_text])).toEqual([
      ['logical-a-segment', '来源 A 文本'],
      ['logical-b-segment', '来源 B 文本'],
    ]);
    expect(buildReviewMatchPairs([firstMatch], [
      { ...second, id: 'mismatched-logical-source' },
    ]).error).toContain('来源页片段身份不一致');
  });

  it('exports two same-path selections with independent rectangles and source names', () => {
    const first = segment('logical-a-segment', LOGICAL_A, '逻辑来源 A.pdf', RECT_A, { x0: 0, y0: 0, x1: 200, y1: 180 });
    const second = segment('logical-b-segment', LOGICAL_B, '逻辑来源 B.pdf', RECT_B, { x0: 200, y0: 100, x1: 500, y1: 300 });
    const firstMatch = match(LOGICAL_A, '来源 A 文本', RECT_A);
    const secondMatch = match(LOGICAL_B, '来源 B 文本', RECT_B);
    const criteria: SearchCriteria = { include: ['缴税'], includeMode: 'all', exclude: [] };

    const payload = buildExportPayloadForReviewSegments(
      [first, second],
      [firstMatch, secondMatch],
      '缴税',
      { 'logical-a-segment': [firstMatch], 'logical-b-segment': [secondMatch] },
      criteria,
    );

    expect(payload.selections).toHaveLength(2);
    expect(payload.selections.map((selection) => selection.source_path)).toEqual([SHARED_PATH, SHARED_PATH]);
    expect(payload.selections.map((selection) => selection.segments[0]?.rect)).toEqual([first.finalRect, second.finalRect]);
    expect(payload.selections.map((selection) => selection.segments[0]?.segment_no)).toEqual([1, 1]);
    expect(payload.rowSeed.map((row) => ({ source_file: row.source_file, matched_text: row.matched_text }))).toEqual([
      { source_file: '逻辑来源 A.pdf', matched_text: '来源 A 文本' },
      { source_file: '逻辑来源 B.pdf', matched_text: '来源 B 文本' },
    ]);
  });
});
