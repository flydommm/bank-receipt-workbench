import { describe, expect, it } from 'vitest';

import {
  nextReviewRowIndex,
  type NavigableReviewRow,
} from './reviewNavigatorNavigation';

function row(
  sourceKey: string,
  sourcePage: number,
  segmentNo: number,
): NavigableReviewRow {
  return { sourceKey, sourcePage, segmentNo };
}

describe('nextReviewRowIndex', () => {
  it('returns null for an empty visible result', () => {
    expect(nextReviewRowIndex([], 0, 'ArrowRight')).toBeNull();
  });

  it('moves linearly with ArrowUp and ArrowDown without wrapping', () => {
    const rows = [row('source-a', 1, 1), row('source-a', 2, 1), row('source-a', 3, 1)];

    expect(nextReviewRowIndex(rows, 1, 'ArrowUp')).toBe(0);
    expect(nextReviewRowIndex(rows, 1, 'ArrowDown')).toBe(2);
    expect(nextReviewRowIndex(rows, 0, 'ArrowUp')).toBe(0);
    expect(nextReviewRowIndex(rows, 2, 'ArrowDown')).toBe(2);
    expect(nextReviewRowIndex(rows, -10, 'ArrowUp')).toBe(0);
    expect(nextReviewRowIndex(rows, 10, 'ArrowDown')).toBe(2);
  });

  it('clamps the current index before a no-target navigation', () => {
    const rows = [row('source-a', 1, 1)];

    expect(nextReviewRowIndex(rows, -1, 'ArrowLeft')).toBe(0);
    expect(nextReviewRowIndex(rows, 4, 'ArrowRight')).toBe(0);
  });

  it('returns the first and last visible result for Home and End', () => {
    const rows = [row('source-a', 1, 1), row('source-a', 2, 1), row('source-b', 1, 1)];

    expect(nextReviewRowIndex(rows, 1, 'Home')).toBe(0);
    expect(nextReviewRowIndex(rows, 1, 'End')).toBe(2);
  });

  it('moves between same-page segments by segment number then original index', () => {
    const rows = [
      row('source-a', 10, 1),
      row('source-b', 1, 1),
      row('source-a', 10, 2),
      row('source-a', 10, 2),
      row('source-a', 10, 3),
    ];

    expect(nextReviewRowIndex(rows, 0, 'ArrowRight')).toBe(2);
    expect(nextReviewRowIndex(rows, 2, 'ArrowRight')).toBe(3);
    expect(nextReviewRowIndex(rows, 3, 'ArrowRight')).toBe(4);
    expect(nextReviewRowIndex(rows, 3, 'ArrowLeft')).toBe(2);
    expect(nextReviewRowIndex(rows, 4, 'ArrowLeft')).toBe(3);
  });

  it('prefers a same-page adjacent segment over a nearer cross-page row', () => {
    const rows = [
      row('source-a', 10, 1),
      row('source-a', 11, 1),
      row('source-a', 10, 2),
      row('source-a', 12, 1),
    ];

    expect(nextReviewRowIndex(rows, 0, 'ArrowRight')).toBe(2);
    expect(nextReviewRowIndex(rows, 2, 'ArrowLeft')).toBe(0);
  });

  it('falls back to the previous or next visible page hit across sources', () => {
    const rows = [
      row('source-a', 9, 1),
      row('source-a', 10, 1),
      row('source-b', 3, 1),
      row('source-a', 11, 1),
    ];

    expect(nextReviewRowIndex(rows, 1, 'ArrowLeft')).toBe(0);
    expect(nextReviewRowIndex(rows, 1, 'ArrowRight')).toBe(2);
    expect(nextReviewRowIndex(rows, 2, 'ArrowRight')).toBe(3);
  });

  it('keeps the clamped index when no page or segment target exists', () => {
    const rows = [row('source-a', 1, 1)];

    expect(nextReviewRowIndex(rows, 0, 'ArrowLeft')).toBe(0);
    expect(nextReviewRowIndex(rows, 0, 'ArrowRight')).toBe(0);
  });

  it('does not mutate the visible rows array', () => {
    const rows = Object.freeze([
      row('source-a', 10, 3),
      row('source-a', 10, 1),
      row('source-a', 10, 2),
    ]);

    expect(nextReviewRowIndex(rows, 1, 'ArrowRight')).toBe(2);
    expect(rows).toEqual([
      row('source-a', 10, 3),
      row('source-a', 10, 1),
      row('source-a', 10, 2),
    ]);
  });
});
