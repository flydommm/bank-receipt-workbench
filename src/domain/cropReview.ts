export type PdfPoint = { x: number; y: number };

export type PdfRect = { x0: number; y0: number; x1: number; y1: number };

export type ReviewStatus = 'pending' | 'needs_review' | 'confirmed' | 'blocked';

export type CropMode = 'candidate' | 'manual' | 'full_page';

export type ReviewSegment = {
  id: string;
  /** Immutable batch identity; sourcePath remains the current readable alias. */
  sourceKey?: string;
  sourceName?: string;
  sourcePath: string;
  sourceSha256: string;
  sourcePage: number;
  segmentNo: number;
  matchRect: PdfRect;
  candidateRect: PdfRect | null;
  finalRect: PdfRect | null;
  pageWidth: number;
  pageHeight: number;
  confidence: number;
  slot: string | null;
  snapPoints?: number[];
  layoutFingerprint: string;
  mode: CropMode;
  reviewStatus: ReviewStatus;
  manualAdjusted: boolean;
};

export type ReviewFilter = 'all' | 'needs_review' | 'manual' | 'blocked';

export type ResizeHandle =
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w'
  | 'nw';

export type ClientBounds = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

export const MIN_CROP_SIZE = 12;

const RESIZE_HANDLES = new Set<ResizeHandle>([
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
  'nw',
]);

const REVIEW_STATUSES = new Set<ReviewStatus>([
  'pending',
  'needs_review',
  'confirmed',
  'blocked',
]);

const CROP_MODES = new Set<CropMode>(['candidate', 'manual', 'full_page']);

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === 'string' && REVIEW_STATUSES.has(value as ReviewStatus);
}

function isCropMode(value: unknown): value is CropMode {
  return typeof value === 'string' && CROP_MODES.has(value as CropMode);
}

function isValidSegmentId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function hasValidSegmentIds(segments: ReviewSegment[]): boolean {
  if (!Array.isArray(segments)) return false;
  const ids = new Set<string>();
  return segments.every((segment) => {
    if (segment === null || typeof segment !== 'object' || !isValidSegmentId(segment.id)) {
      return false;
    }
    if (ids.has(segment.id)) return false;
    ids.add(segment.id);
    return true;
  });
}

function isValidFinalRect(rect: unknown, pageWidth: number, pageHeight: number): rect is PdfRect {
  if (rect === null || typeof rect !== 'object') return false;
  if (!isFinitePositive(pageWidth) || !isFinitePositive(pageHeight)) {
    return false;
  }

  const candidate = rect as Partial<PdfRect>;
  if (![candidate.x0, candidate.y0, candidate.x1, candidate.y1].every((value) => (
    typeof value === 'number' && Number.isFinite(value)
  ))) {
    return false;
  }

  const { x0, y0, x1, y1 } = candidate as PdfRect;
  if (x0 < 0 || y0 < 0 || x1 < x0 || y1 < y0 || x1 > pageWidth || y1 > pageHeight) {
    return false;
  }

  const width = x1 - x0;
  const height = y1 - y0;
  const validWidth = pageWidth < MIN_CROP_SIZE
    ? x0 === 0 && x1 === pageWidth
    : width >= MIN_CROP_SIZE;
  const validHeight = pageHeight < MIN_CROP_SIZE
    ? y0 === 0 && y1 === pageHeight
    : height >= MIN_CROP_SIZE;
  return validWidth && validHeight;
}

export function canConfirmGroup(segments: ReviewSegment[]): boolean {
  if (!Array.isArray(segments) || segments.length === 0 || !hasValidSegmentIds(segments)) return false;

  return segments.every((segment) => {
    if (
      segment === null
      || typeof segment !== 'object'
      || !isReviewStatus(segment.reviewStatus)
      || segment.reviewStatus !== 'confirmed'
      || !isCropMode(segment.mode)
      || !isFinitePositive(segment.pageWidth)
      || !isFinitePositive(segment.pageHeight)
    ) {
      return false;
    }
    if (segment.mode === 'full_page') {
      return segment.finalRect === null
        || segment.finalRect === undefined
        || isValidFinalRect(segment.finalRect, segment.pageWidth, segment.pageHeight);
    }
    return isValidFinalRect(segment.finalRect, segment.pageWidth, segment.pageHeight);
  });
}

export function filterSegments(segments: ReviewSegment[], filter: ReviewFilter): ReviewSegment[] {
  switch (filter) {
    case 'all':
      return segments.filter(() => true);
    case 'needs_review':
      return segments.filter((segment) => (
        segment.reviewStatus === 'needs_review' || segment.reviewStatus === 'blocked'
      ));
    case 'manual':
      return segments.filter((segment) => segment.manualAdjusted || segment.mode === 'manual');
    case 'blocked':
      return segments.filter((segment) => segment.reviewStatus === 'blocked');
    default:
      return [];
  }
}

function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number`);
  }
}

function assertFinitePositiveNumber(value: number, name: string): void {
  assertFiniteNumber(value, name);
  if (value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function assertPageDimensions(pageWidth: number, pageHeight: number): void {
  assertFinitePositiveNumber(pageWidth, 'pageWidth');
  assertFinitePositiveNumber(pageHeight, 'pageHeight');
}

function assertClientBounds(bounds: ClientBounds): void {
  if (bounds === null || typeof bounds !== 'object') {
    throw new RangeError('bounds must be an object');
  }

  assertFiniteNumber(bounds.left, 'bounds.left');
  assertFiniteNumber(bounds.top, 'bounds.top');
  assertFinitePositiveNumber(bounds.width, 'bounds.width');
  assertFinitePositiveNumber(bounds.height, 'bounds.height');
}

function assertPdfPoint(point: PdfPoint, name = 'point'): void {
  if (point === null || typeof point !== 'object') {
    throw new RangeError(`${name} must be an object`);
  }

  assertFiniteNumber(point.x, `${name}.x`);
  assertFiniteNumber(point.y, `${name}.y`);
}

function assertPdfRect(rect: PdfRect): void {
  if (rect === null || typeof rect !== 'object') {
    throw new RangeError('rect must be an object');
  }

  assertFiniteNumber(rect.x0, 'rect.x0');
  assertFiniteNumber(rect.y0, 'rect.y0');
  assertFiniteNumber(rect.x1, 'rect.x1');
  assertFiniteNumber(rect.y1, 'rect.y1');
}

function assertResizeHandle(handle: ResizeHandle): void {
  if (!RESIZE_HANDLES.has(handle)) {
    throw new RangeError(`handle must be one of ${[...RESIZE_HANDLES].join(', ')}`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

export function clientPointToPdf(
  clientX: number,
  clientY: number,
  bounds: ClientBounds,
  pageWidth: number,
  pageHeight: number,
): PdfPoint {
  assertFiniteNumber(clientX, 'clientX');
  assertFiniteNumber(clientY, 'clientY');
  assertClientBounds(bounds);
  assertPageDimensions(pageWidth, pageHeight);

  const x = ((clientX - bounds.left) / bounds.width) * pageWidth;
  const y = ((clientY - bounds.top) / bounds.height) * pageHeight;
  assertFiniteNumber(x, 'converted x');
  assertFiniteNumber(y, 'converted y');

  return { x: clamp(x, 0, pageWidth), y: clamp(y, 0, pageHeight) };
}

export function clampPdfRect(rect: PdfRect, pageWidth: number, pageHeight: number): PdfRect {
  assertPdfRect(rect);
  assertPageDimensions(pageWidth, pageHeight);

  const x0 = clamp(Math.min(rect.x0, rect.x1), 0, pageWidth);
  const y0 = clamp(Math.min(rect.y0, rect.y1), 0, pageHeight);
  const x1 = clamp(Math.max(rect.x0, rect.x1), x0, pageWidth);
  const y1 = clamp(Math.max(rect.y0, rect.y1), y0, pageHeight);

  return { x0, y0, x1, y1 };
}

function ensureMinimumAxis(start: number, end: number, pageSize: number): [number, number] {
  const minimum = Math.min(MIN_CROP_SIZE, pageSize);
  const low = clamp(Math.min(start, end), 0, pageSize);
  const high = clamp(Math.max(start, end), low, pageSize);

  if (high - low >= minimum) {
    return [low, high];
  }

  if (low <= pageSize - minimum) {
    return [low, low + minimum];
  }

  return [pageSize - minimum, pageSize];
}

export function normalizePdfRect(rect: PdfRect, pageWidth: number, pageHeight: number): PdfRect {
  const bounded = clampPdfRect(rect, pageWidth, pageHeight);
  const [x0, x1] = ensureMinimumAxis(bounded.x0, bounded.x1, pageWidth);
  const [y0, y1] = ensureMinimumAxis(bounded.y0, bounded.y1, pageHeight);
  return { x0, y0, x1, y1 };
}

export function movePdfRect(
  rect: PdfRect,
  delta: PdfPoint,
  pageWidth: number,
  pageHeight: number,
): PdfRect {
  assertPdfRect(rect);
  assertPdfPoint(delta, 'delta');
  assertPageDimensions(pageWidth, pageHeight);

  const bounded = normalizePdfRect(rect, pageWidth, pageHeight);
  const dx = clamp(delta.x, -bounded.x0, pageWidth - bounded.x1);
  const dy = clamp(delta.y, -bounded.y0, pageHeight - bounded.y1);

  return {
    x0: bounded.x0 + dx,
    y0: bounded.y0 + dy,
    x1: bounded.x1 + dx,
    y1: bounded.y1 + dy,
  };
}

export function resizePdfRect(
  rect: PdfRect,
  handle: ResizeHandle,
  point: PdfPoint,
  pageWidth: number,
  pageHeight: number,
): PdfRect {
  assertPdfRect(rect);
  assertPdfPoint(point);
  assertResizeHandle(handle);
  assertPageDimensions(pageWidth, pageHeight);

  const bounded = normalizePdfRect(rect, pageWidth, pageHeight);
  let [x0, x1] = [bounded.x0, bounded.x1];
  let [y0, y1] = [bounded.y0, bounded.y1];
  const minimumWidth = Math.min(MIN_CROP_SIZE, pageWidth);
  const minimumHeight = Math.min(MIN_CROP_SIZE, pageHeight);

  if (handle.includes('w')) {
    x0 = clamp(point.x, 0, x1 - minimumWidth);
  } else if (handle.includes('e')) {
    x1 = clamp(point.x, x0 + minimumWidth, pageWidth);
  }

  if (handle.includes('n')) {
    y0 = clamp(point.y, 0, y1 - minimumHeight);
  } else if (handle.includes('s')) {
    y1 = clamp(point.y, y0 + minimumHeight, pageHeight);
  }

  return { x0, y0, x1, y1 };
}
