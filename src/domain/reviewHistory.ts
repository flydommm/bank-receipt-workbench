import type {
  EnginePreparedReview,
  EngineReviewSegment,
  EngineReviewSegmentV2,
} from '../components/localEngineAdapter';
import { normalizeSourcePath } from './sourcePreview';
import { normalizePdfRect, type PdfRect, type ReviewSegment } from './cropReview';

function logicalKey(sourcePath: string, sourceSha256: string, sourcePage: number, segmentNo: number): string {
  return JSON.stringify([normalizeSourcePath(sourcePath), sourceSha256.toLowerCase(), sourcePage, segmentNo]);
}

function sameRect(left: PdfRect | null, right: PdfRect | null): boolean {
  if (left === null || right === null) return left === right;
  return left.x0 === right.x0 && left.y0 === right.y0
    && left.x1 === right.x1 && left.y1 === right.y1;
}

function cloneRect(rect: PdfRect | null): PdfRect | null {
  return rect === null ? null : { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 };
}

function validSourceSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function validMatchRect(rect: unknown): rect is PdfRect {
  if (!rect || typeof rect !== 'object') return false;
  const value = rect as PdfRect;
  return [value.x0, value.y0, value.x1, value.y1].every(Number.isFinite)
    && value.x0 >= 0 && value.y0 >= 0 && value.x1 > value.x0 && value.y1 > value.y0;
}

function validFinalRect(rect: unknown, width: number, height: number): rect is PdfRect {
  if (!validMatchRect(rect) || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return false;
  try {
    const normalized = normalizePdfRect(rect, width, height);
    return sameRect(normalized, rect);
  } catch {
    return false;
  }
}

function validLegacyDecision(record: EngineReviewSegment, segment: ReviewSegment): boolean {
  if (!validSourceSha(record.source_sha256) || record.source_sha256.toLowerCase() !== segment.sourceSha256.toLowerCase()
    || normalizeSourcePath(record.source_path) !== normalizeSourcePath(segment.sourcePath)
    || !Number.isSafeInteger(segment.sourcePage) || segment.sourcePage < 1
    || !Number.isSafeInteger(segment.segmentNo) || segment.segmentNo < 1
    || record.source_page < 1 || record.segment_no < 1
    || record.source_page !== segment.sourcePage || record.segment_no !== segment.segmentNo
    || !validMatchRect(record.match_rect) || !sameRect(record.match_rect, segment.matchRect)) return false;
  if (record.crop_mode !== 'full_page' && record.crop_mode !== 'candidate' && record.crop_mode !== 'manual') return false;
  if (record.crop_mode === 'full_page' && record.final_rect === null) return true;
  return validFinalRect(record.final_rect, segment.pageWidth, segment.pageHeight);
}

function currentLogicalKey(segment: ReviewSegment): string {
  return logicalKey(segment.sourcePath, segment.sourceSha256, segment.sourcePage, segment.segmentNo);
}

function preparedLogicalKey(record: EngineReviewSegmentV2): string {
  return record.id;
}

/**
 * Merge decisions returned by a validated v2 prepare response. The response
 * carries immutable analysis fields, so only the editable decision fields are
 * copied into the freshly assembled current segments.
 */
export function mergeCompatibleReviews(
  current: ReviewSegment[],
  prepared: EnginePreparedReview,
): { segments: ReviewSegment[]; groupConfirmed: boolean } {
  const byKey = new Map<string, EngineReviewSegmentV2>();
  for (const record of prepared.segments) {
    const key = preparedLogicalKey(record);
    if (!byKey.has(key)) byKey.set(key, record);
  }
  let matched = 0;
  const segments = current.map((segment) => {
    const record = byKey.get(segment.id);
    if (!record || record.id !== segment.id || record.source_sha256.toLowerCase() !== segment.sourceSha256.toLowerCase()
      || (segment.sourceKey !== undefined && segment.sourceKey !== record.source_key)
      || record.source_page !== segment.sourcePage || record.segment_no !== segment.segmentNo
      || normalizeSourcePath(record.source_path) !== normalizeSourcePath(segment.sourcePath)
      || !sameRect(record.match_rect, segment.matchRect)) return segment;
    matched += 1;
    const restoredStatus: ReviewSegment['reviewStatus'] = record.review_status === 'confirmed'
      || record.review_status === 'page_confirmed'
      || record.review_status === 'group_confirmed'
      ? 'confirmed'
      : record.review_status === 'pending' || record.review_status === 'needs_review' || record.review_status === 'blocked'
        ? record.review_status
        : segment.reviewStatus;
    return {
      ...segment,
      finalRect: cloneRect(record.final_rect),
      mode: record.crop_mode,
      reviewStatus: restoredStatus,
      manualAdjusted: record.manual_adjusted,
    };
  });
  return {
    segments,
    groupConfirmed: Boolean(prepared.group_confirmed && current.length > 0
      && matched === current.length && current.length === prepared.segments.length),
  };
}

/** Return only unambiguous, source- and geometry-matched legacy decisions. */
export function legacyReviewSuggestions(
  current: ReviewSegment[],
  records: EngineReviewSegment[],
): Record<string, EngineReviewSegment> {
  const currentByKey = new Map<string, ReviewSegment>();
  const ambiguousCurrentKeys = new Set<string>();
  const ambiguousIds = new Set<string>();
  const currentIds = new Set<string>();
  for (const segment of current) {
    const key = currentLogicalKey(segment);
    if (currentByKey.has(key)) ambiguousCurrentKeys.add(key);
    currentByKey.set(key, segment);
    if (currentIds.has(segment.id)) ambiguousIds.add(segment.id);
    currentIds.add(segment.id);
  }

  const recordsByKey = new Map<string, EngineReviewSegment>();
  const ambiguousRecordKeys = new Set<string>();
  for (const record of records) {
    if (!record || typeof record.source_path !== 'string' || !validSourceSha(record.source_sha256)
      || !Number.isSafeInteger(record.source_page) || !Number.isSafeInteger(record.segment_no)) continue;
    const key = logicalKey(record.source_path, record.source_sha256, record.source_page, record.segment_no);
    if (recordsByKey.has(key)) ambiguousRecordKeys.add(key);
    recordsByKey.set(key, record);
  }

  const suggestions: Record<string, EngineReviewSegment> = {};
  for (const [key, segment] of currentByKey) {
    if (ambiguousCurrentKeys.has(key) || ambiguousRecordKeys.has(key) || ambiguousIds.has(segment.id)) continue;
    const record = recordsByKey.get(key);
    if (!record || !validLegacyDecision(record, segment)) continue;
    suggestions[segment.id] = structuredClone(record);
  }
  return suggestions;
}

/** Apply an explicitly selected legacy suggestion and require it to be valid. */
export function applyLegacyReviewSuggestion(segment: ReviewSegment, record: EngineReviewSegment): ReviewSegment {
  if (!validLegacyDecision(record, segment)) {
    throw new Error('历史审核建议与当前来源或裁剪区域不一致。');
  }
  return {
    ...segment,
    finalRect: cloneRect(record.final_rect),
    mode: record.crop_mode,
    reviewStatus: 'needs_review',
    manualAdjusted: true,
  };
}
