import { describe, expect, it } from 'vitest';

import {
  clampPdfRect,
  clientPointToPdf,
  canConfirmGroup,
  filterSegments,
  hasValidSegmentIds,
  MIN_CROP_SIZE,
  movePdfRect,
  normalizePdfRect,
  resizePdfRect,
  type ReviewSegment,
} from './cropReview';

const RECT = { x0: 20, y0: 30, x1: 180, y1: 230 };

function segment(overrides: Partial<ReviewSegment> = {}): ReviewSegment {
  return {
    id: 'segment-1',
    sourcePath: 'source.pdf',
    sourceSha256: 'sha256',
    sourcePage: 1,
    segmentNo: 1,
    matchRect: RECT,
    candidateRect: RECT,
    finalRect: RECT,
    pageWidth: 600,
    pageHeight: 800,
    confidence: 0.95,
    slot: null,
    layoutFingerprint: 'layout-1',
    mode: 'candidate',
    reviewStatus: 'confirmed',
    manualAdjusted: false,
    ...overrides,
  };
}

describe('normalizePdfRect', () => {
  it('normalizes reversed, zero, and undersized crop edges', () => {
    expect(normalizePdfRect({ x0: 300, y0: 280, x1: 100, y1: 200 }, 600, 800)).toEqual({
      x0: 100,
      y0: 200,
      x1: 300,
      y1: 280,
    });
    expect(normalizePdfRect({ x0: 100, y0: 100, x1: 100, y1: 103 }, 600, 800)).toEqual({
      x0: 100,
      y0: 100,
      x1: 112,
      y1: 112,
    });
  });

  it('fills an axis when the page is smaller than the minimum crop size', () => {
    expect(normalizePdfRect({ x0: 2, y0: 3, x1: 4, y1: 5 }, 8, 10)).toEqual({
      x0: 0,
      y0: 0,
      x1: 8,
      y1: 10,
    });
  });

  it('normalizes a degenerate rectangle before moving it', () => {
    expect(movePdfRect({ x0: 100, y0: 100, x1: 100, y1: 100 }, { x: 20, y: 30 }, 600, 800)).toEqual({
      x0: 120,
      y0: 130,
      x1: 132,
      y1: 142,
    });
  });
});

describe('movePdfRect', () => {
  it('moves the whole rectangle to the top edge without an artificial margin', () => {
    expect(movePdfRect({ x0: 50, y0: 80, x1: 550, y1: 300 }, { x: 0, y: -80 }, 600, 800))
      .toEqual({ x0: 50, y0: 0, x1: 550, y1: 220 });
  });

  it('preserves the rectangle size while stopping at every page edge', () => {
    const rect = { x0: 50, y0: 80, x1: 550, y1: 300 };

    expect(movePdfRect(rect, { x: 100, y: 100 }, 600, 800)).toEqual({
      x0: 100,
      y0: 180,
      x1: 600,
      y1: 400,
    });
    expect(movePdfRect(rect, { x: -100, y: -100 }, 600, 800)).toEqual({
      x0: 0,
      y0: 0,
      x1: 500,
      y1: 220,
    });
    expect(movePdfRect(rect, { x: 1000, y: 1000 }, 600, 800)).toEqual({
      x0: 100,
      y0: 580,
      x1: 600,
      y1: 800,
    });
  });

  it('rejects non-finite deltas and invalid page dimensions', () => {
    const rect = { x0: 50, y0: 80, x1: 550, y1: 300 };

    expect(() => movePdfRect(rect, { x: Number.NaN, y: 0 }, 600, 800)).toThrow(RangeError);
    expect(() => movePdfRect(rect, { x: 0, y: Number.POSITIVE_INFINITY }, 600, 800)).toThrow(RangeError);
    expect(() => movePdfRect(rect, { x: 0, y: 0 }, 0, 800)).toThrow(RangeError);
  });
});

describe('clientPointToPdf', () => {
  it('converts a client point using the preview bounds scale', () => {
    expect(
      clientPointToPdf(
        400,
        450,
        { left: 100, top: 50, width: 600, height: 800 },
        300,
        400,
      ),
    ).toEqual({ x: 150, y: 200 });
  });

  it('clamps points outside the preview to the PDF page', () => {
    expect(
      clientPointToPdf(
        50,
        900,
        { left: 100, top: 50, width: 600, height: 800 },
        300,
        400,
      ),
    ).toEqual({ x: 0, y: 400 });
  });

  it('rejects zero or non-finite preview dimensions', () => {
    const bounds = { left: 100, top: 50, width: 600, height: 800 };

    expect(() => clientPointToPdf(100, 450, { ...bounds, width: 0 }, 300, 400)).toThrow(RangeError);
    expect(() => clientPointToPdf(400, 50, { ...bounds, height: 0 }, 300, 400)).toThrow(RangeError);
    expect(() => clientPointToPdf(400, 450, { ...bounds, width: Number.NaN }, 300, 400)).toThrow(RangeError);
    expect(() => clientPointToPdf(400, 450, { ...bounds, height: Number.POSITIVE_INFINITY }, 300, 400)).toThrow(RangeError);
  });

  it('rejects non-finite coordinates and page dimensions', () => {
    const bounds = { left: 100, top: 50, width: 600, height: 800 };

    expect(() => clientPointToPdf(Number.NaN, 450, bounds, 300, 400)).toThrow(RangeError);
    expect(() => clientPointToPdf(400, Number.NEGATIVE_INFINITY, bounds, 300, 400)).toThrow(RangeError);
    expect(() => clientPointToPdf(400, 450, { ...bounds, left: Number.NaN }, 300, 400)).toThrow(RangeError);
    expect(() => clientPointToPdf(400, 450, { ...bounds, top: Number.POSITIVE_INFINITY }, 300, 400)).toThrow(RangeError);
    expect(() => clientPointToPdf(400, 450, bounds, Number.NaN, 400)).toThrow(RangeError);
    expect(() => clientPointToPdf(400, 450, bounds, 300, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => clientPointToPdf(400, 450, bounds, 0, 400)).toThrow(RangeError);
    expect(() => clientPointToPdf(400, 450, bounds, 300, -1)).toThrow(RangeError);
  });
});

describe('clampPdfRect', () => {
  it('clamps an oversized rectangle to the whole page', () => {
    expect(
      clampPdfRect({ x0: -10, y0: -10, x1: 610, y1: 810 }, 600, 800),
    ).toEqual({ x0: 0, y0: 0, x1: 600, y1: 800 });
  });

  it('normalizes reversed edges after clamping', () => {
    expect(
      clampPdfRect({ x0: 500, y0: 700, x1: 100, y1: 200 }, 600, 800),
    ).toEqual({ x0: 100, y0: 200, x1: 500, y1: 700 });
  });

  it('rejects non-finite rectangle edges', () => {
    const rect = { x0: 100, y0: 100, x1: 500, y1: 700 };

    expect(() => clampPdfRect({ ...rect, x0: Number.NaN }, 600, 800)).toThrow(RangeError);
    expect(() => clampPdfRect({ ...rect, y0: Number.POSITIVE_INFINITY }, 600, 800)).toThrow(RangeError);
    expect(() => clampPdfRect({ ...rect, x1: Number.NEGATIVE_INFINITY }, 600, 800)).toThrow(RangeError);
    expect(() => clampPdfRect({ ...rect, y1: Number.NaN }, 600, 800)).toThrow(RangeError);
  });

  it.each([
    ['zero width', 0, 800],
    ['negative height', 600, -1],
    ['non-finite width', Number.NaN, 800],
    ['non-finite height', 600, Number.POSITIVE_INFINITY],
    ['negative infinity width', Number.NEGATIVE_INFINITY, 800],
  ])('rejects %s page dimensions', (_name, pageWidth, pageHeight) => {
    expect(() => clampPdfRect({ x0: 100, y0: 100, x1: 500, y1: 700 }, pageWidth, pageHeight)).toThrow(RangeError);
  });
});

describe('resizePdfRect', () => {
  it('exports the twelve-point minimum crop size', () => {
    expect(MIN_CROP_SIZE).toBe(12);
  });

  it('rejects a resize smaller than 12 PDF points', () => {
    expect(resizePdfRect({ x0: 50, y0: 50, x1: 300, y1: 300 }, 'e', { x: 55, y: 100 }, 600, 800))
      .toEqual({ x0: 50, y0: 50, x1: 62, y1: 300 });
  });

  it('keeps every handle from crossing or reversing the crop rectangle', () => {
    const base = { x0: 100, y0: 100, x1: 300, y1: 300 };
    const cases = [
      ['n', { x: 0, y: 900 }],
      ['ne', { x: 900, y: 900 }],
      ['e', { x: 0, y: 0 }],
      ['se', { x: 0, y: 0 }],
      ['s', { x: 0, y: 0 }],
      ['sw', { x: 900, y: 0 }],
      ['w', { x: 900, y: 0 }],
      ['nw', { x: 900, y: 900 }],
    ] as const;

    for (const [handle, point] of cases) {
      const result = resizePdfRect(base, handle, point, 600, 800);
      expect(result.x1 - result.x0).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
      expect(result.y1 - result.y0).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
      expect(Object.values(result).every(Number.isFinite)).toBe(true);
      expect(result.x0).toBeGreaterThanOrEqual(0);
      expect(result.y0).toBeGreaterThanOrEqual(0);
      expect(result.x1).toBeLessThanOrEqual(600);
      expect(result.y1).toBeLessThanOrEqual(800);
    }
  });

  it('resizes the northwest corner while preserving the other edges', () => {
    expect(
      resizePdfRect(
        { x0: 100, y0: 100, x1: 300, y1: 400 },
        'nw',
        { x: 40, y: 20 },
        600,
        800,
      ),
    ).toEqual({ x0: 40, y0: 20, x1: 300, y1: 400 });
  });

  it.each([
    ['n', { x: 40, y: 20 }, { x0: 100, y0: 20, x1: 300, y1: 400 }],
    ['ne', { x: 340, y: 20 }, { x0: 100, y0: 20, x1: 340, y1: 400 }],
    ['e', { x: 340, y: 200 }, { x0: 100, y0: 100, x1: 340, y1: 400 }],
    ['se', { x: 340, y: 440 }, { x0: 100, y0: 100, x1: 340, y1: 440 }],
    ['s', { x: 150, y: 440 }, { x0: 100, y0: 100, x1: 300, y1: 440 }],
    ['sw', { x: 40, y: 440 }, { x0: 40, y0: 100, x1: 300, y1: 440 }],
    ['w', { x: 40, y: 200 }, { x0: 40, y0: 100, x1: 300, y1: 400 }],
  ] as const)('resizes the %s handle', (handle, point, expected) => {
    expect(resizePdfRect({ x0: 100, y0: 100, x1: 300, y1: 400 }, handle, point, 600, 800)).toEqual(expected);
  });

  it('clamps a dragged corner to the page bounds', () => {
    expect(
      resizePdfRect(
        { x0: 100, y0: 100, x1: 300, y1: 400 },
        'se',
        { x: 700, y: 900 },
        600,
        800,
      ),
    ).toEqual({ x0: 100, y0: 100, x1: 600, y1: 800 });
  });

  it('rejects non-finite drag points and invalid page dimensions', () => {
    const rect = { x0: 100, y0: 100, x1: 300, y1: 400 };

    expect(() => resizePdfRect(rect, 'se', { x: Number.NaN, y: 400 }, 600, 800)).toThrow(RangeError);
    expect(() => resizePdfRect(rect, 'nw', { x: 100, y: Number.POSITIVE_INFINITY }, 600, 800)).toThrow(RangeError);
    expect(() => resizePdfRect(rect, 'e', { x: 300, y: 200 }, 0, 800)).toThrow(RangeError);
  });

  it.each([
    ['e', { x0: 100, y0: 100, x1: Number.NaN, y1: 400 }],
    ['w', { x0: Number.POSITIVE_INFINITY, y0: 100, x1: 300, y1: 400 }],
    ['n', { x0: 100, y0: Number.NEGATIVE_INFINITY, x1: 300, y1: 400 }],
    ['s', { x0: 100, y0: 100, x1: 300, y1: Number.NaN }],
  ] as const)('rejects a non-finite original edge overwritten by the %s handle', (handle, rect) => {
    expect(() => resizePdfRect(rect, handle, { x: 250, y: 300 }, 600, 800)).toThrow(RangeError);
  });
});

describe('canConfirmGroup', () => {
  it('blocks group confirmation while any segment needs review', () => {
    expect(canConfirmGroup([segment({ id: 'confirmed' }), segment({ id: 'warning', reviewStatus: 'needs_review' })])).toBe(false);
  });

  it('rejects an empty group and every unresolved status', () => {
    expect(canConfirmGroup([])).toBe(false);
    expect(canConfirmGroup([segment({ reviewStatus: 'pending' })])).toBe(false);
    expect(canConfirmGroup([segment({ reviewStatus: 'blocked' })])).toBe(false);
    expect(canConfirmGroup([segment({ reviewStatus: 'unknown' as ReviewSegment['reviewStatus'] })])).toBe(false);
    expect(canConfirmGroup([segment({ mode: 'unknown' as ReviewSegment['mode'] })])).toBe(false);
    expect(canConfirmGroup([segment({ id: '' })])).toBe(false);
    expect(canConfirmGroup([segment({ id: '   ' })])).toBe(false);
    expect(canConfirmGroup([segment({ id: 'duplicate' }), segment({ id: 'duplicate', segmentNo: 2 })])).toBe(false);
  });

  it('allows group confirmation when every segment has a valid final rectangle', () => {
    expect(canConfirmGroup([segment({ reviewStatus: 'confirmed', finalRect: RECT })])).toBe(true);
  });

  it('requires a legal final rectangle unless the segment is full page', () => {
    expect(canConfirmGroup([segment({ finalRect: null })])).toBe(false);
    expect(canConfirmGroup([segment({ finalRect: { x0: -1, y0: 30, x1: 180, y1: 230 } })])).toBe(false);
    expect(canConfirmGroup([segment({ finalRect: { x0: 20, y0: 30, x1: 10, y1: 230 } })])).toBe(false);
    expect(canConfirmGroup([segment({ finalRect: { x0: 20, y0: 30, x1: 25, y1: 230 } })])).toBe(false);
    expect(canConfirmGroup([segment({ finalRect: null, mode: 'full_page' })])).toBe(true);
    expect(canConfirmGroup([segment({
      finalRect: { x0: -1, y0: 0, x1: 600, y1: 800 },
      mode: 'full_page',
    })])).toBe(false);
  });

  it('requires a small page axis to be covered by the whole page', () => {
    expect(canConfirmGroup([segment({
      pageWidth: 8,
      finalRect: { x0: 1, y0: 30, x1: 7, y1: 230 },
    })])).toBe(false);
    expect(canConfirmGroup([segment({
      pageWidth: 8,
      finalRect: { x0: 0, y0: 30, x1: 8, y1: 230 },
    })])).toBe(true);
  });

  it('rejects invalid page dimensions even when keeping the full page', () => {
    expect(canConfirmGroup([segment({ mode: 'full_page', finalRect: null, pageWidth: 0 })])).toBe(false);
    expect(canConfirmGroup([segment({ mode: 'full_page', finalRect: null, pageHeight: -1 })])).toBe(false);
    expect(canConfirmGroup([segment({ mode: 'full_page', finalRect: null, pageWidth: Number.NaN })])).toBe(false);
    expect(canConfirmGroup([segment({ mode: 'full_page', finalRect: null, pageHeight: Number.POSITIVE_INFINITY })])).toBe(false);
  });
});

describe('hasValidSegmentIds', () => {
  it('accepts nonempty unique IDs and rejects empty or duplicate IDs', () => {
    expect(hasValidSegmentIds([segment({ id: 'a' }), segment({ id: 'b' })])).toBe(true);
    expect(hasValidSegmentIds([segment({ id: '' })])).toBe(false);
    expect(hasValidSegmentIds([segment({ id: '  ' })])).toBe(false);
    expect(hasValidSegmentIds([segment({ id: 'a' }), segment({ id: 'a', segmentNo: 2 })])).toBe(false);
  });
});

describe('filterSegments', () => {
  const segments = [
    segment({ id: 'confirmed', reviewStatus: 'confirmed' }),
    segment({ id: 'warning', reviewStatus: 'needs_review' }),
    segment({ id: 'manual', mode: 'manual', manualAdjusted: true }),
    segment({ id: 'blocked', reviewStatus: 'blocked', mode: 'candidate', manualAdjusted: false }),
  ];

  it('returns only unresolved segments for the review filter', () => {
    expect(filterSegments(segments, 'needs_review').map((item) => item.id)).toEqual(['warning', 'blocked']);
  });

  it('supports all, manual, and blocked filters without changing input order', () => {
    expect(filterSegments(segments, 'all').map((item) => item.id)).toEqual(['confirmed', 'warning', 'manual', 'blocked']);
    expect(filterSegments(segments, 'manual').map((item) => item.id)).toEqual(['manual']);
    expect(filterSegments(segments, 'blocked').map((item) => item.id)).toEqual(['blocked']);
    expect(filterSegments(segments, 'all')).not.toBe(segments);
    expect(segments.map((item) => item.id)).toEqual(['confirmed', 'warning', 'manual', 'blocked']);
  });
});
