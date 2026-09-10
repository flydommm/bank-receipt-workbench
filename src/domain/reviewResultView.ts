import type { CropMode, ReviewFilter, ReviewStatus } from './cropReview';

export type ReviewResultSort = 'original' | 'confidence_asc' | 'confidence_desc';

export type ReviewResultSource = {
  key: string;
  label: string;
};

export type ReviewResultViewRow = {
  id: string;
  sourceKey: string;
  sourceName: string;
  sourceAccessibleLabel: string;
  confidence: number;
  reviewStatus: ReviewStatus;
  manualAdjusted: boolean;
  mode: CropMode;
};

export type ReviewResultView<T> = {
  visibleRows: T[];
  counts: Record<ReviewFilter, number>;
  total: number;
  sources: Array<ReviewResultSource & { count: number }>;
};

type SourceAccumulator = ReviewResultSource & {
  count: number;
  rowLabels: string[];
};

const REVIEW_FILTERS: readonly ReviewFilter[] = [
  'all',
  'needs_review',
  'manual',
  'blocked',
];

const REVIEW_RESULT_SORTS: readonly ReviewResultSort[] = [
  'original',
  'confidence_asc',
  'confidence_desc',
];

function isReviewResultSort(value: string): value is ReviewResultSort {
  return REVIEW_RESULT_SORTS.includes(value as ReviewResultSort);
}

function matchesFilter<T extends ReviewResultViewRow>(row: T, filter: ReviewFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'needs_review':
      return row.reviewStatus === 'needs_review' || row.reviewStatus === 'blocked';
    case 'manual':
      return row.manualAdjusted || row.mode === 'manual';
    case 'blocked':
      return row.reviewStatus === 'blocked';
    default:
      return false;
  }
}

function rowSourceLabel<T extends ReviewResultViewRow>(row: T): string {
  return row.sourceAccessibleLabel?.trim()
    || row.sourceName?.trim()
    || row.sourceKey;
}

function sourceLabelCounts(sources: readonly SourceAccumulator[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const source of sources) {
    const label = source.label.trim() || source.key;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

function completeDuplicateSourceLabels(sources: SourceAccumulator[]): void {
  const initialLabelCounts = sourceLabelCounts(sources);
  const candidateLabelCounts = new Map<string, number>();
  for (const source of sources) {
    for (const label of source.rowLabels) {
      candidateLabelCounts.set(label, (candidateLabelCounts.get(label) ?? 0) + 1);
    }
  }

  for (const source of sources) {
    const baseLabel = source.label.trim() || source.key;
    if ((initialLabelCounts.get(baseLabel) ?? 0) < 2) continue;

    const completeLabel = source.rowLabels.find((label) => (
      label.length > 0
      && label !== baseLabel
      && (candidateLabelCounts.get(label) ?? 0) === 1
    ));
    if (completeLabel) {
      source.label = completeLabel;
      continue;
    }

    // Metadata without a row cannot provide a complete path. Keep the
    // source key in the label so two same-named entries remain selectable.
    source.label = `${baseLabel} (${source.key})`;
  }
}

function sortRows<T extends ReviewResultViewRow>(
  rows: readonly T[],
  sort: ReviewResultSort,
): T[] {
  const visibleRows = [...rows];
  if (sort === 'original') return visibleRows;

  return visibleRows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftFinite = Number.isFinite(left.row.confidence);
      const rightFinite = Number.isFinite(right.row.confidence);
      if (leftFinite !== rightFinite) return leftFinite ? -1 : 1;
      if (!leftFinite) return left.index - right.index;

      const delta = left.row.confidence - right.row.confidence;
      if (delta !== 0) return sort === 'confidence_asc' ? delta : -delta;
      return left.index - right.index;
    })
    .map(({ row }) => row);
}

export function deriveReviewResultView<T extends ReviewResultViewRow>(
  rows: readonly T[],
  view: {
    sourceKey: string | null;
    filter: ReviewFilter;
    sort: ReviewResultSort;
  },
  sourceMetadata: readonly ReviewResultSource[] = [],
): ReviewResultView<T> {
  const allRows = Array.isArray(rows) ? rows : [];
  const sourceMap = new Map<string, SourceAccumulator>();

  for (const source of sourceMetadata) {
    if (!sourceMap.has(source.key)) {
      sourceMap.set(source.key, {
        key: source.key,
        label: source.label,
        count: 0,
        rowLabels: [],
      });
    }
  }

  for (const row of allRows) {
    const source = sourceMap.get(row.sourceKey);
    if (source) {
      source.count += 1;
      const label = rowSourceLabel(row);
      if (label && !source.rowLabels.includes(label)) source.rowLabels.push(label);
      continue;
    }

    sourceMap.set(row.sourceKey, {
      key: row.sourceKey,
      label: rowSourceLabel(row),
      count: 1,
      rowLabels: rowSourceLabel(row) ? [rowSourceLabel(row)] : [],
    });
  }

  const sourceAccumulators = [...sourceMap.values()];
  for (const source of sourceAccumulators) {
    if (!source.label.trim() && source.rowLabels[0]) source.label = source.rowLabels[0];
  }
  completeDuplicateSourceLabels(sourceAccumulators);
  const sourceRows = view.sourceKey === null
    ? [...allRows]
    : allRows.filter((row) => row.sourceKey === view.sourceKey);
  const counts = Object.fromEntries(REVIEW_FILTERS.map((filter) => [
    filter,
    sourceRows.filter((row) => matchesFilter(row, filter)).length,
  ])) as Record<ReviewFilter, number>;
  const visibleRows = sortRows(
    sourceRows.filter((row) => matchesFilter(row, view.filter)),
    isReviewResultSort(view.sort) ? view.sort : 'original',
  );

  return {
    visibleRows,
    counts,
    total: allRows.length,
    sources: sourceAccumulators.map(({ key, label, count }) => ({
      key,
      label: label.trim() || key,
      count,
    })),
  };
}
