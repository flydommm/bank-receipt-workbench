import { MIN_CROP_SIZE, type PdfPoint, type PdfRect } from './cropReview';
import {
  MAX_LAYOUT_SLOTS, ReceiptLayoutError, parsePageGeometry, parseLayoutDefinition,
  type PageGeometry, type ReceiptSlot,
} from './receiptLayout';

function validPoint(point: PdfPoint): PdfPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new ReceiptLayoutError('invalid_geometry', 'point');
  return point;
}
function visible(point: PdfPoint, g: PageGeometry): PdfPoint {
  const { x, y } = validPoint(point);
  switch (g.rotation) {
    case 0: return { x, y };
    case 90: return validPoint({ x: g.width_pt - y, y: x });
    case 180: return validPoint({ x: g.width_pt - x, y: g.height_pt - y });
    case 270: return validPoint({ x: y, y: g.height_pt - x });
  }
}
function unrotated(point: PdfPoint, g: PageGeometry): PdfPoint {
  const { x, y } = validPoint(point);
  switch (g.rotation) {
    case 0: return { x, y };
    case 90: return validPoint({ x: y, y: g.width_pt - x });
    case 180: return validPoint({ x: g.width_pt - x, y: g.height_pt - y });
    case 270: return validPoint({ x: g.height_pt - y, y: x });
  }
}

/** Extracted text/image coordinates are already in physical points and crop-local. */
export function unrotatedPointToVisible(point: PdfPoint, geometry: PageGeometry): PdfPoint {
  return visible(point, parsePageGeometry(geometry));
}
export function visiblePointToUnrotated(point: PdfPoint, geometry: PageGeometry): PdfPoint {
  return unrotated(point, parsePageGeometry(geometry));
}
/** Raw PDF coordinates have a bottom-left origin and have not applied UserUnit. */
export function rawPdfPointToVisible(point: PdfPoint, geometry: PageGeometry): PdfPoint {
  const g = parsePageGeometry(geometry);
  validPoint(point);
  return visible({ x: (point.x - g.pdf_box.x0) * g.user_unit,
    y: (g.pdf_box.y1 - point.y) * g.user_unit }, g);
}
export function visiblePointToRawPdf(point: PdfPoint, geometry: PageGeometry): PdfPoint {
  const g = parsePageGeometry(geometry), p = unrotated(point, g);
  return validPoint({ x: p.x / g.user_unit + g.pdf_box.x0, y: g.pdf_box.y1 - p.y / g.user_unit });
}
function transformRect(rect: PdfRect, transform: (point: PdfPoint) => PdfPoint): PdfRect {
  if (![rect.x0, rect.y0, rect.x1, rect.y1].every(Number.isFinite) || rect.x1 <= rect.x0 || rect.y1 <= rect.y0)
    throw new ReceiptLayoutError('invalid_geometry', 'rect');
  const points = [transform({ x: rect.x0, y: rect.y0 }), transform({ x: rect.x1, y: rect.y0 }),
    transform({ x: rect.x0, y: rect.y1 }), transform({ x: rect.x1, y: rect.y1 })];
  const result = { x0: Math.min(...points.map((p) => p.x)), y0: Math.min(...points.map((p) => p.y)),
    x1: Math.max(...points.map((p) => p.x)), y1: Math.max(...points.map((p) => p.y)) };
  if (result.x1 <= result.x0 || result.y1 <= result.y0) throw new ReceiptLayoutError('invalid_geometry', 'rect');
  return result;
}
export function unrotatedRectToVisible(rect: PdfRect, geometry: PageGeometry): PdfRect {
  const g = parsePageGeometry(geometry);
  return transformRect(rect, (p) => visible(p, g));
}
export function visibleRectToUnrotated(rect: PdfRect, geometry: PageGeometry): PdfRect {
  const g = parsePageGeometry(geometry);
  return transformRect(rect, (p) => unrotated(p, g));
}

export function pointsToMillimeters(points: number): number {
  const result = points / 72 * 25.4;
  if (!Number.isFinite(result)) throw new ReceiptLayoutError('invalid_geometry', 'points');
  return result;
}
export function millimetersToPoints(mm: number): number {
  const result = mm / 25.4 * 72;
  if (!Number.isFinite(result)) throw new ReceiptLayoutError('invalid_geometry', 'millimeters');
  return result;
}

/** Initial manual suggestion only. It does not recognize bank identity or occupied slots. */
export function suggestSlots(geometry: PageGeometry, slotCount: number, options?: {
  top_pt: number; bottom_pt: number; gaps_pt: readonly number[];
}): { slots: ReceiptSlot[]; basis: 'equal_division'; needs_review: true } {
  const g = parsePageGeometry(geometry);
  const max = Math.min(MAX_LAYOUT_SLOTS, Math.floor(g.height_pt / Math.min(MIN_CROP_SIZE, g.height_pt)));
  if (!Number.isSafeInteger(slotCount) || slotCount < 1 || slotCount > max)
    throw new ReceiptLayoutError('invalid_layout', 'slot_count');
  const { top_pt: top, bottom_pt: bottom, gaps_pt: gaps } = options
    ?? { top_pt: 0, bottom_pt: 0, gaps_pt: Array<number>(slotCount - 1).fill(0) };
  if (gaps.length !== slotCount - 1 || [top, bottom, ...gaps].some((n) => !Number.isFinite(n) || n < 0))
    throw new ReceiptLayoutError('invalid_layout', 'whitespace');
  const height = (g.height_pt - top - bottom - gaps.reduce((sum, gap) => sum + gap, 0)) / slotCount;
  let nextTop = top;
  const slots = Array.from({ length: slotCount }, (_, i) => {
    const slot = { slot_id: `slot-${i + 1}`, position_index: i + 1, top_pt: nextTop, height_pt: height };
    nextTop += height + (gaps[i] ?? 0);
    return slot;
  });
  // Reuse the authoritative whole-layout constraints, including unselected neighbors.
  parseLayoutDefinition({ schema_version: 1, layout_id: 'initial-suggestion', revision: 1, workspace_id: 'default',
    issuer_id: null, family_id: null, evidence_version: 'equal-division-v1', page_geometry: g,
    uniform_height: true, left_pt: 0, right_pt: 0, slots });
  return { slots, basis: 'equal_division', needs_review: true };
}
