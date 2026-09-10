export type NavigableReviewRow = {
  sourceKey: string;
  sourcePage: number;
  segmentNo: number;
};

export type ReviewNavigationKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End';

export function nextReviewRowIndex(
  rows: readonly NavigableReviewRow[],
  currentIndex: number,
  key: ReviewNavigationKey,
): number | null {
  if (rows.length === 0) return null;

  const current = clampIndex(currentIndex, rows.length - 1);

  switch (key) {
    case 'ArrowUp':
      return Math.max(0, current - 1);
    case 'ArrowDown':
      return Math.min(rows.length - 1, current + 1);
    case 'Home':
      return 0;
    case 'End':
      return rows.length - 1;
    case 'ArrowLeft':
      return horizontalNeighbor(rows, current, -1);
    case 'ArrowRight':
      return horizontalNeighbor(rows, current, 1);
  }
}

function clampIndex(index: number, lastIndex: number): number {
  if (Number.isNaN(index) || index <= 0) return 0;
  if (index >= lastIndex) return lastIndex;
  if (!Number.isFinite(index)) return 0;
  return Math.trunc(index);
}

function horizontalNeighbor(
  rows: readonly NavigableReviewRow[],
  currentIndex: number,
  direction: -1 | 1,
): number {
  const currentRow = rows[currentIndex];
  const samePage = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => isSamePage(row, currentRow))
    .sort((left, right) => left.row.segmentNo - right.row.segmentNo || left.index - right.index);

  const currentPagePosition = samePage.findIndex(({ index }) => index === currentIndex);
  const adjacent = samePage[currentPagePosition + direction];
  if (adjacent !== undefined) return adjacent.index;

  for (
    let index = currentIndex + direction;
    index >= 0 && index < rows.length;
    index += direction
  ) {
    if (!isSamePage(rows[index], currentRow)) return index;
  }

  return currentIndex;
}

function isSamePage(left: NavigableReviewRow, right: NavigableReviewRow): boolean {
  return left.sourceKey === right.sourceKey && left.sourcePage === right.sourcePage;
}
