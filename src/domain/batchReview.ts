import type {
  BatchJobSnapshot,
  BatchResultItem,
  BatchSnapshotEvidence,
  BatchSnapshotOriginal,
  BatchSnapshotSegment,
  BatchSourceSnapshot,
} from './batchTask';
import type {
  EngineMatch,
  EngineOriginalReview,
} from '../components/localEngineAdapter';
import {
  normalizeSourcePath,
  sourceDocumentKey,
  type SourceDocument,
} from './sourcePreview';
import type { PdfRect, ReviewSegment } from './cropReview';

const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_RESULTS = 50_000;
const MAX_PATH_LENGTH = 32_768;
const MAX_IDENTIFIER_LENGTH = 1_024;

/** The geometry gate is deliberately pending until the real PDF page is rendered. */
export type BatchReviewSourceGeometry = {
  matchValid: boolean;
  pageValid: boolean;
  pageCount: number;
  dimensionsMatch: boolean;
  pageCountMatch: boolean;
  previewStatus: 'pending' | 'valid' | 'invalid';
  previewError?: string;
};

/**
 * The existing App review pipeline calls these values SourceMatch.  Keep the
 * batch adapter independent from App.tsx while exposing the same structural
 * fields, including the source metadata that the old in-memory assembler
 * added before it reached the review navigator.
 */
export type BatchReviewMatch = EngineMatch & {
  source_path: string;
  source_sha256: string;
  source_identity: string;
  page_count: number;
  query_id?: string;
  role?: 'include' | 'exclude';
};

export type BatchReviewMapping = {
  documents: SourceDocument[];
  segments: ReviewSegment[];
  matches: BatchReviewMatch[];
  evidenceById: Record<string, BatchReviewMatch[]>;
  geometryById: Record<string, BatchReviewSourceGeometry>;
  originals: EngineOriginalReview[];
};

export class BatchReviewMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchReviewMappingError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(message: string): never {
  throw new BatchReviewMappingError(message);
}

function isNonEmptyText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength
    && !value.includes('\0');
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function rectEquals(left: PdfRect | null, right: PdfRect | null): boolean {
  if (left === null || right === null) return left === right;
  return left.x0 === right.x0
    && left.y0 === right.y0
    && left.x1 === right.x1
    && left.y1 === right.y1;
}

function cloneRect(rect: PdfRect | null): PdfRect | null {
  return rect === null ? null : { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 };
}

function validRect(value: unknown, width: number, height: number, nullable: boolean): value is PdfRect | null {
  if (value === null) return nullable;
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) return false;
  const rect = value as Partial<PdfRect>;
  return [rect.x0, rect.y0, rect.x1, rect.y1].every((coordinate) => (
    typeof coordinate === 'number' && Number.isFinite(coordinate)
  ))
    && rect.x0! >= 0
    && rect.y0! >= 0
    && rect.x0! < rect.x1!
    && rect.y0! < rect.y1!
    && rect.x1! <= width
    && rect.y1! <= height;
}

function validateSource(source: BatchSourceSnapshot, expectedPosition: number): void {
  if (!isNonEmptyText(source.source_id, MAX_IDENTIFIER_LENGTH)
    || source.position !== expectedPosition
    || !isNonEmptyText(source.source_key, MAX_PATH_LENGTH)
    || !isNonEmptyText(source.initial_path, MAX_PATH_LENGTH)
    || !isNonEmptyText(source.access_path, MAX_PATH_LENGTH)
    || !isNonEmptyText(source.name, 1_024)
    || source.source_key !== normalizeSourcePath(source.initial_path)
    || typeof source.sha256 !== 'string'
    || !SHA256.test(source.sha256)
    || !isPositiveSafeInteger(source.page_count)) {
    fail('批任务来源元数据不完整，无法载入审核结果。');
  }
}

function validateJob(job: BatchJobSnapshot): void {
  if (job.state !== 'ready_for_review' && job.state !== 'archived') {
    fail('批任务尚未生成可审核的完整结果。');
  }
  if (!isNonEmptyText(job.result_revision, MAX_IDENTIFIER_LENGTH)) {
    fail('批任务缺少结果修订，无法载入审核结果。');
  }
  if (!Array.isArray(job.sources) || job.sources.length === 0) {
    fail('批任务缺少来源元数据，无法载入审核结果。');
  }
}

function sourceIndex(job: BatchJobSnapshot): Map<string, BatchSourceSnapshot> {
  const byKey = new Map<string, BatchSourceSnapshot>();
  const ids = new Set<string>();
  for (const [index, source] of job.sources.entries()) {
    validateSource(source, index);
    if (ids.has(source.source_id) || byKey.has(source.source_key)) {
      fail('批任务来源存在重复身份，无法载入审核结果。');
    }
    ids.add(source.source_id);
    byKey.set(source.source_key, source);
  }
  return byKey;
}

function validateSourceDocuments(sources: readonly BatchSourceSnapshot[]): SourceDocument[] {
  const documents = new Map<string, SourceDocument>();
  for (const source of sources) {
    const sha = source.sha256!;
    const key = sourceDocumentKey(source.access_path, sha);
    const existing = documents.get(key);
    if (existing) {
      if (existing.pageCount !== source.page_count) fail('同一访问文件的页数不一致。');
      continue;
    }
    documents.set(key, {
      key,
      name: source.name,
      // The persisted segment path may be an old alias.  The current path is
      // the only path that the preview and source-integrity gate may use.
      sourcePath: source.access_path,
      sourceSha256: sha.toLowerCase(),
      pageCount: source.page_count!,
      integrityStatus: 'valid' as const,
    });
  }
  return [...documents.values()];
}

function validateSegmentGeometry(segment: BatchSnapshotSegment, original: BatchSnapshotOriginal): void {
  if (!isFinitePositive(segment.page_width)
    || !isFinitePositive(segment.page_height)
    || !validRect(segment.match_rect, segment.page_width, segment.page_height, false)
    || !validRect(segment.candidate_rect, segment.page_width, segment.page_height, true)
    || !validRect(segment.final_rect, segment.page_width, segment.page_height, true)
    || !Array.isArray(segment.snap_points)
    || !segment.snap_points.every((point) => Number.isFinite(point) && point >= 0 && point <= segment.page_height)
    || !isConfidence(segment.confidence)
    || segment.manual_adjusted !== false) {
    fail('批任务片段几何无效，无法载入审核结果。');
  }

  if (!isFinitePositive(original.page_width)
    || !isFinitePositive(original.page_height)
    || !validRect(original.match_rect, original.page_width, original.page_height, true)
    || !validRect(original.candidate_rect, original.page_width, original.page_height, true)
    || !rectEquals(segment.match_rect, original.match_rect)
    || !rectEquals(segment.candidate_rect, original.candidate_rect)
    || segment.page_width !== original.page_width
    || segment.page_height !== original.page_height
    || segment.confidence !== original.confidence
    || segment.layout_fingerprint !== original.layout_fingerprint
    || (segment.crop_mode === 'full_page') !== original.auto_full_page) {
    fail('批任务片段与原始审核几何不一致，已阻止载入。');
  }

  if (segment.crop_mode === 'full_page') {
    if (segment.final_rect !== null) fail('整页片段不应包含可编辑裁剪范围。');
  } else if (!rectEquals(segment.final_rect, segment.candidate_rect)) {
    fail('候选片段的最终裁剪范围不一致。');
  }
}

function validateEvidence(
  evidence: readonly BatchSnapshotEvidence[],
  segment: BatchSnapshotSegment,
): BatchSnapshotEvidence {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    fail('批任务片段缺少搜索证据。');
  }
  let representative: BatchSnapshotEvidence | undefined;
  for (const hit of evidence) {
    if (!isPositiveSafeInteger(hit.page)
      || hit.page !== segment.source_page
      || typeof hit.matched_text !== 'string'
      || hit.matched_text.length === 0
      || hit.matched_text.includes('\0')
      || (hit.matched_field !== null
        && (typeof hit.matched_field !== 'string' || hit.matched_field.length === 0))
      || !isConfidence(hit.confidence)
      || ![hit.x0, hit.y0, hit.x1, hit.y1].every((coordinate) => (
        typeof coordinate === 'number' && Number.isFinite(coordinate)
      ))
      || hit.x0 < 0
      || hit.y0 < 0
      || hit.x0 >= hit.x1
      || hit.y0 >= hit.y1
      || (hit.needs_review !== undefined && typeof hit.needs_review !== 'boolean')
      || ((hit.query_id === undefined) !== (hit.role === undefined))
      || (hit.query_id !== undefined && (!isNonEmptyText(hit.query_id, MAX_IDENTIFIER_LENGTH)
        || (hit.role !== 'include' && hit.role !== 'exclude')))) {
      fail('批任务搜索证据无效，无法载入审核结果。');
    }
    if (hit.x0 === segment.match_rect.x0
      && hit.y0 === segment.match_rect.y0
      && hit.x1 === segment.match_rect.x1
      && hit.y1 === segment.match_rect.y1
      && (hit.role === undefined || hit.role === 'include')
      && representative === undefined) {
      // Preserve backend evidence order: the first include/legacy hit that
      // points at the immutable match rectangle is the App representative.
      representative = hit;
    }
  }
  if (!representative) fail('批任务片段缺少与命中范围对应的包含关键词证据。');
  return representative;
}

function mapEvidence(
  hit: BatchSnapshotEvidence,
  source: BatchSourceSnapshot,
): BatchReviewMatch {
  const mapped: BatchReviewMatch = {
    page: hit.page,
    matched_text: hit.matched_text,
    matched_field: hit.matched_field,
    confidence: hit.confidence,
    x0: hit.x0,
    y0: hit.y0,
    x1: hit.x1,
    y1: hit.y1,
    source_path: source.access_path,
    source_key: source.source_key,
    source_sha256: source.sha256!.toLowerCase(),
    source_identity: source.source_id,
    page_count: source.page_count!,
  };
  if (hit.needs_review !== undefined) mapped.needs_review = hit.needs_review;
  if (hit.query_id !== undefined) {
    mapped.query_id = hit.query_id;
    mapped.role = hit.role;
  }
  return mapped;
}

function mapSegment(
  segment: BatchSnapshotSegment,
  source: BatchSourceSnapshot,
): ReviewSegment {
  return {
    id: segment.id,
    sourceKey: source.source_key,
    sourceName: source.name,
    sourcePath: source.access_path,
    sourceSha256: source.sha256!.toLowerCase(),
    sourcePage: segment.source_page,
    segmentNo: segment.segment_no,
    matchRect: cloneRect(segment.match_rect)!,
    candidateRect: cloneRect(segment.candidate_rect),
    finalRect: cloneRect(segment.final_rect),
    pageWidth: segment.page_width,
    pageHeight: segment.page_height,
    confidence: segment.confidence,
    slot: segment.slot,
    snapPoints: [...segment.snap_points],
    layoutFingerprint: segment.layout_fingerprint,
    mode: segment.crop_mode,
    reviewStatus: segment.review_status,
    manualAdjusted: false,
  };
}

function mapOriginal(original: BatchSnapshotOriginal): EngineOriginalReview {
  return {
    id: original.id,
    // Keep logical identity and the backend analysis signature byte-for-byte
    // as supplied.  Access-path relocation must not rewrite either value.
    source_key: original.source_key,
    source_page: original.source_page,
    segment_no: original.segment_no,
    analysis_signature: original.analysis_signature,
    persistable: original.persistable,
    page_width: original.page_width,
    page_height: original.page_height,
    match_rect: cloneRect(original.match_rect),
    candidate_rect: cloneRect(original.candidate_rect),
    layout_fingerprint: original.layout_fingerprint,
    confidence: original.confidence,
    auto_full_page: original.auto_full_page,
  };
}

/**
 * Convert an authoritative, fully paged batch result into the existing
 * review-workspace shapes.  This is deliberately a pure adapter: it neither
 * recalculates analysis signatures nor accepts UI supplied source metadata.
 */
export function mapBatchReview(
  job: BatchJobSnapshot,
  items: BatchResultItem[],
): BatchReviewMapping {
  validateJob(job);
  if (!Array.isArray(items) || items.length > MAX_RESULTS) {
    fail('批任务审核结果数量无效。');
  }

  const sourcesByKey = sourceIndex(job);
  const documents = validateSourceDocuments(job.sources);
  const segments: ReviewSegment[] = [];
  const matches: BatchReviewMatch[] = [];
  const originals: EngineOriginalReview[] = [];
  const evidenceById: Record<string, BatchReviewMatch[]> = {};
  const geometryById: Record<string, BatchReviewSourceGeometry> = {};
  const ids = new Set<string>();
  const logicalPositions = new Set<string>();

  let previousPosition = -1;
  let previousPage = 0;
  let previousSegmentNo = 0;
  for (const item of items) {
    const segment = item?.segment;
    const original = item?.original;
    if (!segment || !original) fail('批任务审核结果缺少片段或原始记录。');

    const source = sourcesByKey.get(segment.source_key);
    if (!source
      || original.source_key !== segment.source_key
      || original.id !== segment.id
      || original.source_page !== segment.source_page
      || original.segment_no !== segment.segment_no
      || segment.source_sha256.toLowerCase() !== source.sha256!.toLowerCase()
      || !isNonEmptyText(segment.source_path, MAX_PATH_LENGTH)
      || !isPositiveSafeInteger(segment.source_page)
      || segment.source_page > source.page_count!
      || !isPositiveSafeInteger(segment.segment_no)
      || !isNonEmptyText(segment.id, MAX_IDENTIFIER_LENGTH)) {
      fail('批任务审核结果与当前来源身份不一致。');
    }

    const position = source.position;
    if (position < previousPosition
      || (position === previousPosition
        && (segment.source_page < previousPage
          || (segment.source_page === previousPage && segment.segment_no !== previousSegmentNo + 1)
          || (segment.source_page > previousPage && segment.segment_no !== 1)))
      || (position > previousPosition && segment.segment_no !== 1)) {
      fail('批任务审核结果顺序不一致，已阻止载入。');
    }
    previousPosition = position;
    previousPage = segment.source_page;
    previousSegmentNo = segment.segment_no;

    const logicalPosition = `${segment.source_key}\0${segment.source_page}\0${segment.segment_no}`;
    if (ids.has(segment.id) || logicalPositions.has(logicalPosition)) {
      fail('批任务审核结果包含重复片段。');
    }
    ids.add(segment.id);
    logicalPositions.add(logicalPosition);

    validateSegmentGeometry(segment, original);
    const representative = validateEvidence(item.evidence, segment);
    const mappedEvidence = item.evidence.map((hit) => mapEvidence(hit, source));
    const mappedRepresentative = mapEvidence(representative, source);

    segments.push(mapSegment(segment, source));
    matches.push(mappedRepresentative);
    originals.push(mapOriginal(original));
    evidenceById[segment.id] = mappedEvidence;
    geometryById[segment.id] = {
      matchValid: true,
      pageValid: true,
      pageCount: source.page_count!,
      dimensionsMatch: true,
      pageCountMatch: true,
      previewStatus: 'pending',
    };
  }

  return { documents, segments, matches, evidenceById, geometryById, originals };
}
