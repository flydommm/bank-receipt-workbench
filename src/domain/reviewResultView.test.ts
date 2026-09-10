import { describe, expect, it } from 'vitest';

import type { CropMode, ReviewFilter, ReviewStatus } from './cropReview';
import {
  deriveReviewResultView,
  type ReviewResultSort,
} from './reviewResultView';

type TestRow = {
  id: string;
  sourceKey: string;
  sourceName: string;
  sourceAccessibleLabel: string;
  confidence: number;
  reviewStatus: ReviewStatus;
  manualAdjusted: boolean;
  mode: CropMode;
};

function row(
  id: string,
  overrides: Partial<TestRow> = {},
): TestRow {
  return {
    id,
    sourceKey: 'source-a',
    sourceName: 'bank.pdf',
    sourceAccessibleLabel: 'bank.pdf',
    confidence: 0.5,
    reviewStatus: 'confirmed',
    manualAdjusted: false,
    mode: 'candidate',
    ...overrides,
  };
}

describe('deriveReviewResultView', () => {
  it('applies source before status and counts statuses within that source scope', () => {
    const rows = [
      row('b-low', {
        sourceKey: 'source-b',
        sourceAccessibleLabel: 'folder-b/bank.pdf',
        confidence: 0.2,
        reviewStatus: 'needs_review',
      }),
      row('a-needs', {
        sourceAccessibleLabel: 'folder-a/bank.pdf',
        confidence: 0.1,
        reviewStatus: 'needs_review',
      }),
      row('b-high', {
        sourceKey: 'source-b',
        sourceAccessibleLabel: 'folder-b/bank.pdf',
        confidence: 0.8,
        reviewStatus: 'blocked',
      }),
      row('b-confirmed', {
        sourceKey: 'source-b',
        sourceAccessibleLabel: 'folder-b/bank.pdf',
        confidence: 0.5,
      }),
    ];

    const result = deriveReviewResultView(rows, {
      sourceKey: 'source-b',
      filter: 'needs_review',
      sort: 'confidence_asc',
    });

    expect(result.visibleRows.map((item) => item.id)).toEqual(['b-low', 'b-high']);
    expect(result.counts).toEqual({
      all: 3,
      needs_review: 2,
      manual: 0,
      blocked: 1,
    });
    expect(result.total).toBe(4);
  });

  it('keeps zero-hit metadata sources and distinguishes duplicate file names by key', () => {
    const rows = [
      row('a', { sourceKey: 'source-a', sourceAccessibleLabel: 'folder-a/bank.pdf' }),
      row('b', { sourceKey: 'source-b', sourceAccessibleLabel: 'folder-b/bank.pdf' }),
      row('missing', {
        sourceKey: 'source-missing',
        sourceName: 'receipt.pdf',
        sourceAccessibleLabel: 'folder-c/receipt.pdf',
      }),
    ];

    const result = deriveReviewResultView(
      rows,
      { sourceKey: null, filter: 'all', sort: 'original' },
      [
        { key: 'source-a', label: 'bank.pdf' },
        { key: 'source-b', label: 'bank.pdf' },
        { key: 'source-empty', label: 'empty.pdf' },
      ],
    );

    expect(result.sources).toEqual([
      { key: 'source-a', label: 'folder-a/bank.pdf', count: 1 },
      { key: 'source-b', label: 'folder-b/bank.pdf', count: 1 },
      { key: 'source-empty', label: 'empty.pdf', count: 0 },
      { key: 'source-missing', label: 'folder-c/receipt.pdf', count: 1 },
    ]);

    const sourceB = deriveReviewResultView(
      rows,
      { sourceKey: 'source-b', filter: 'all', sort: 'original' },
      result.sources,
    );
    expect(sourceB.visibleRows.map((item) => item.id)).toEqual(['b']);
  });

  it.each([
    ['original', ['first', 'second', 'third', 'nan', 'infinity']],
    ['confidence_asc', ['third', 'first', 'second', 'nan', 'infinity']],
    ['confidence_desc', ['first', 'second', 'third', 'nan', 'infinity']],
  ] as const)('supports %s with stable ties and non-finite values last', (sort, expected) => {
    const rows = [
      row('first', { confidence: 0.5 }),
      row('second', { confidence: 0.5 }),
      row('third', { confidence: 0.1 }),
      row('nan', { confidence: Number.NaN }),
      row('infinity', { confidence: Number.POSITIVE_INFINITY }),
    ];
    const originalIds = rows.map((item) => item.id);

    const result = deriveReviewResultView(rows, {
      sourceKey: null,
      filter: 'all',
      sort: sort as ReviewResultSort,
    });

    expect(result.visibleRows.map((item) => item.id)).toEqual(expected);
    expect(rows.map((item) => item.id)).toEqual(originalIds);
  });

  it('counts manual state using the existing adjusted or manual mode semantics', () => {
    const rows = [
      row('adjusted', { manualAdjusted: true }),
      row('manual-mode', { mode: 'manual' }),
      row('blocked', { reviewStatus: 'blocked' }),
    ];

    const result = deriveReviewResultView(rows, {
      sourceKey: null,
      filter: 'manual',
      sort: 'original',
    });

    expect(result.visibleRows.map((item) => item.id)).toEqual(['adjusted', 'manual-mode']);
    expect(result.counts).toEqual({ all: 3, needs_review: 1, manual: 2, blocked: 1 });
  });
});
