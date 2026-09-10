import { describe, expect, it } from 'vitest';

import type { PdfRect, ReviewSegment } from './cropReview';
import {
  resolveExportScope,
  type ExportScopeSelection,
} from './exportIntent';

const rect: PdfRect = { x0: 1, y0: 2, x1: 80, y1: 90 };

function segment(
  id: string,
  sourceKey: string | undefined,
  sourcePage: number,
  segmentNo: number,
  mode: ReviewSegment['mode'] = 'candidate',
  finalRect: PdfRect | null = { ...rect },
): ReviewSegment {
  return {
    id,
    sourceKey,
    sourceName: sourceKey,
    sourcePath: `${sourceKey ?? 'fallback'}.pdf`,
    sourceSha256: `${id}-sha`,
    sourcePage,
    segmentNo,
    matchRect: { ...rect },
    candidateRect: { ...rect },
    finalRect: mode === 'full_page' || finalRect === null ? null : { ...finalRect },
    pageWidth: 100,
    pageHeight: 120,
    confidence: 0.9,
    slot: null,
    layoutFingerprint: `${id}-layout`,
    mode,
    reviewStatus: 'confirmed',
    manualAdjusted: false,
  };
}

function expectValidResult(result: ReturnType<typeof resolveExportScope>) {
  expect(result.error).toBeNull();
  expect(result.selectedCount).toBe(result.selectedSegments.length);
}

describe('resolveExportScope', () => {
  it('selects all results in stable source/page/segment order and deduplicates full pages', () => {
    const segments = [
      segment('b-crop', 'source-b', 2, 2),
      segment('a-full-2', 'source-a', 2, 2, 'full_page'),
      segment('a-crop', 'source-a', 1, 3),
      segment('a-full-1', 'source-a', 2, 1, 'full_page'),
      segment('b-full', 'source-b', 2, 1, 'full_page'),
    ];

    const result = resolveExportScope(segments, ['source-a', 'source-b'], { kind: 'all' }, new Set());

    expectValidResult(result);
    expect(result.selectedIds).toEqual(['a-crop', 'a-full-1', 'a-full-2', 'b-full', 'b-crop']);
    expect(result.selectedSourceKeys).toEqual(['source-a', 'source-b']);
    expect(result.totalSegments).toBe(5);
    expect(result.omittedCount).toBe(0);
    expect(result.expectedPages).toBe(4);
  });

  it('selects only requested sources, permits zero-hit sources, and does not mutate input segments', () => {
    const sourceA = segment('a', 'source-a', 1, 1);
    const sourceB = segment('b', 'source-b', 1, 1);
    const original = [sourceB, sourceA];
    const before = structuredClone(original);

    const result = resolveExportScope(
      original,
      ['source-a', 'source-empty', 'source-b'],
      { kind: 'sources', sourceKeys: ['source-empty', 'source-a'] },
      new Set(),
    );

    expectValidResult(result);
    expect(result.selectedIds).toEqual(['a']);
    expect(result.selectedSourceKeys).toEqual(['source-a']);
    expect(original).toEqual(before);
  });

  it('freezes a captured list by id while remaining stable when external input order changes', () => {
    const first = segment('first', 'source-a', 1, 2);
    const second = segment('second', 'source-a', 1, 1);
    const captured: ExportScopeSelection = {
      kind: 'list',
      segmentIds: ['first', 'second'],
      description: '当前筛选结果（2 项）',
    };

    const resultBefore = resolveExportScope([first, second], ['source-a'], captured, new Set());
    const resultAfter = resolveExportScope([second, first], ['source-a'], captured, new Set());

    expectValidResult(resultBefore);
    expectValidResult(resultAfter);
    expect(resultBefore.selectedIds).toEqual(['second', 'first']);
    expect(resultAfter.selectedIds).toEqual(resultBefore.selectedIds);
  });

  it('rejects duplicate or fabricated ids and source keys instead of silently narrowing the export', () => {
    const segments = [segment('a', 'source-a', 1, 1), segment('b', 'source-b', 1, 1)];
    const invalidScopes: ExportScopeSelection[] = [
      { kind: 'list', segmentIds: ['a', 'a'], description: '重复' },
      { kind: 'list', segmentIds: ['a', 'missing'], description: '伪造' },
      { kind: 'sources', sourceKeys: ['source-a', 'source-a'] },
      { kind: 'sources', sourceKeys: ['missing-source'] },
    ];

    for (const scope of invalidScopes) {
      const result = resolveExportScope(segments, ['source-a', 'source-b'], scope, new Set());
      expect(result.error).toBeTypeOf('string');
      expect(result.selectedSegments).toEqual([]);
      expect(result.selectedIds).toEqual([]);
      expect(result.selectedSourceKeys).toEqual([]);
    }

    const duplicateInput = resolveExportScope(
      [segment('a', 'source-a', 1, 1), segment('a', 'source-a', 1, 2)],
      ['source-a'],
      { kind: 'all' },
      new Set(),
    );
    expect(duplicateInput.error).toContain('重复');
    expect(duplicateInput.selectedSegments).toEqual([]);
  });

  it('keeps same-page full-page deduplication scoped to one source while ordinary crops stay independent', () => {
    const segments = [
      segment('a-full-1', 'source-a', 4, 1, 'full_page'),
      segment('a-full-2', 'source-a', 4, 2, 'full_page'),
      segment('a-crop-1', 'source-a', 4, 3),
      segment('b-full', 'source-b', 4, 1, 'full_page'),
      segment('b-crop', 'source-b', 4, 2),
    ];

    const result = resolveExportScope(segments, ['source-a', 'source-b'], { kind: 'all' }, new Set());

    expectValidResult(result);
    expect(result.expectedPages).toBe(4);
  });

  it('deduplicates exact candidate and manual rectangles while retaining every selected id', () => {
    const segments = [
      segment('same-candidate', 'source-a', 3, 1, 'candidate'),
      segment('same-manual', 'source-a', 3, 2, 'manual'),
      segment('slightly-different', 'source-a', 3, 3, 'candidate', { ...rect, x1: 80.0001 }),
      segment('adjacent', 'source-a', 3, 4, 'candidate', { ...rect, x0: 80, x1: 159 }),
      segment('same-rect-other-page', 'source-a', 4, 1, 'candidate'),
      segment('same-rect-other-source', 'source-b', 3, 1, 'candidate'),
    ];

    const result = resolveExportScope(segments, ['source-a', 'source-b'], { kind: 'all' }, new Set());

    expectValidResult(result);
    expect(result.selectedCount).toBe(6);
    expect(result.selectedIds).toEqual([
      'same-candidate', 'same-manual', 'slightly-different', 'adjacent',
      'same-rect-other-page', 'same-rect-other-source',
    ]);
    expect(result.expectedPages).toBe(5);
  });

  it('keeps full-page deduplication separate from an equal-sized crop and preserves the review gate', () => {
    const unresolvedDuplicate = segment('unresolved-duplicate', 'source-a', 5, 2, 'manual');
    unresolvedDuplicate.reviewStatus = 'needs_review';
    const segments = [
      segment('full-page-first', 'source-a', 5, 1, 'full_page'),
      segment('full-page-second', 'source-a', 5, 3, 'full_page'),
      segment('crop-with-same-rect', 'source-a', 5, 4, 'candidate', {
        x0: 0,
        y0: 0,
        x1: 100,
        y1: 120,
      }),
      unresolvedDuplicate,
    ];

    const result = resolveExportScope(segments, ['source-a'], { kind: 'all' }, new Set(['unresolved-duplicate']));

    expectValidResult(result);
    expect(result.selectedCount).toBe(4);
    expect(result.selectedIds).toEqual([
      'full-page-first', 'unresolved-duplicate', 'full-page-second', 'crop-with-same-rect',
    ]);
    expect(result.expectedPages).toBe(3);
    expect(result.selectedUnresolvedCount).toBe(1);
  });

  it('counts caller-provided unresolved ids across selected and omitted ranges without narrowing them', () => {
    const segments = [
      segment('a', 'source-a', 1, 1),
      segment('b', 'source-a', 1, 2),
      segment('c', 'source-b', 1, 1),
      segment('d', 'source-b', 1, 2),
    ];

    const result = resolveExportScope(
      segments,
      ['source-a', 'source-b'],
      { kind: 'sources', sourceKeys: ['source-a'] },
      new Set(['a', 'c', 'd', 'outside']),
    );

    expectValidResult(result);
    expect(result.selectedUnresolvedCount).toBe(1);
    expect(result.omittedUnresolvedCount).toBe(2);
    expect(result.omittedCount).toBe(2);
  });

  it('returns an empty non-exportable selection when a valid scope matches nothing', () => {
    const result = resolveExportScope(
      [segment('a', 'source-a', 1, 1)],
      ['source-a', 'source-empty'],
      { kind: 'sources', sourceKeys: ['source-empty'] },
      new Set(),
    );

    expect(result.error).toContain('为空');
    expect(result.selectedCount).toBe(0);
    expect(result.selectedSegments).toEqual([]);
    expect(result.expectedPages).toBe(0);
  });
});
