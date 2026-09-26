import { describe, expect, it } from 'vitest';
import {
  rawPdfPointToVisible, visiblePointToRawPdf, unrotatedPointToVisible, visiblePointToUnrotated,
  unrotatedRectToVisible, visibleRectToUnrotated, suggestSlots, pointsToMillimeters, millimetersToPoints,
} from './receiptLayoutGeometry';
import { type PageGeometry, ReceiptLayoutError } from './receiptLayout';

function geometry(rotation: PageGeometry['rotation'], userUnit: number): PageGeometry {
  return { pdf_box: { x0: -50, y0: 100, x1: 550, y1: 900 }, rotation, user_unit: userUnit,
    width_pt: (rotation % 180 ? 800 : 600) * userUnit,
    height_pt: (rotation % 180 ? 600 : 800) * userUnit };
}

describe('physical PDF coordinate mapping', () => {
  for (const rotation of [0, 90, 180, 270] as const) for (const unit of [1, 2, 1.25]) {
    it(`round-trips rotation ${rotation}, UserUnit ${unit}, nonzero origin`, () => {
      const g = geometry(rotation, unit), raw = { x: 10, y: 860 };
      const visible = rawPdfPointToVisible(raw, g);
      expect(visiblePointToRawPdf(visible, g)).toEqual(raw);
      // Text extraction already applied unit and removed the PDF origin.
      const extracted = { x: 60 * unit, y: 40 * unit };
      expect(unrotatedPointToVisible(extracted, g)).toEqual(visible);
      expect(visiblePointToUnrotated(visible, g)).toEqual(extracted);
      const rect = { x0: 30 * unit, y0: 40 * unit, x1: 90 * unit, y1: 100 * unit };
      expect(visibleRectToUnrotated(unrotatedRectToVisible(rect, g), g)).toEqual(rect);
    });
  }
  it('uses physical translation when rotating a page with UserUnit=2', () => {
    const g = geometry(90, 2);
    expect(unrotatedPointToVisible({ x: 120, y: 80 }, g)).toEqual({ x: 1520, y: 120 });
  });
  it('preserves internal precision instead of reusing rounded UI millimeters', () => {
    const value = 269.753211;
    expect(millimetersToPoints(pointsToMillimeters(value))).toBeCloseTo(value, 12);
  });
  it('rejects malformed coordinates instead of returning NaN', () => {
    expect(() => rawPdfPointToVisible({ x: NaN, y: 0 }, geometry(0, 1))).toThrow(ReceiptLayoutError);
    expect(() => unrotatedRectToVisible({ x0: 10, y0: 0, x1: 5, y1: 20 }, geometry(0, 1))).toThrow(ReceiptLayoutError);
  });
});

describe('whole-page initial slot suggestions', () => {
  it('proposes three equal boxes from actual page dimensions', () => {
    const result = suggestSlots(geometry(0, 1), 3);
    expect(result.needs_review).toBe(true);
    expect(result.basis).toBe('equal_division');
    expect(result.slots.map((s) => s.position_index)).toEqual([1, 2, 3]);
    expect(result.slots[2].top_pt + result.slots[2].height_pt).toBeCloseTo(800, 12);
  });
  it('accounts for known whitespace and separate gaps without inventing occupancy', () => {
    const result = suggestSlots(geometry(0, 1), 4, { top_pt: 10, bottom_pt: 20, gaps_pt: [5, 10, 5] });
    expect(result.slots.map((s) => s.top_pt)).toEqual([10, 202.5, 400, 592.5]);
    expect(result.slots.map((s) => s.height_pt)).toEqual([187.5, 187.5, 187.5, 187.5]);
  });
  it('supports native single-page and rejects huge slot counts before allocation', () => {
    expect(suggestSlots(geometry(0, 1), 1).slots[0].height_pt).toBe(800);
    for (const count of [0, -1, 1.5, NaN, Infinity, 1e9, 67])
      expect(() => suggestSlots(geometry(0, 1), count)).toThrow(ReceiptLayoutError);
  });
  it('refuses negative whitespace and inadequate content height', () => {
    for (const options of [
      { top_pt: -1, bottom_pt: 0, gaps_pt: [0, 0] },
      { top_pt: 0, bottom_pt: 790, gaps_pt: [0, 0] },
      { top_pt: 0, bottom_pt: 0, gaps_pt: [5] },
    ]) expect(() => suggestSlots(geometry(0, 1), 3, options)).toThrow(ReceiptLayoutError);
  });
});
