import { invoke } from '@tauri-apps/api/core';
import { MIN_CROP_SIZE } from '../domain/cropReview';
import type { CropTemplatePage } from '../domain/batchCrop';
import { normalizeSourcePath } from '../domain/sourcePreview';

export type EngineHealth = {
  status: 'ok';
  engine: string;
  version: string;
};

export type OcrReadiness = 'installed' | 'ready' | 'unavailable' | 'failed';
export type OcrHealthCode = 'ocr_initialization_failed' | 'ocr_inference_failed' | 'ocr_result_invalid';

export type OcrHealth = {
  status: 'ok';
  available: boolean;
  engine: 'paddleocr';
  message: string;
  readiness: OcrReadiness;
  code?: OcrHealthCode;
};

export type OcrCacheInfo = {
  status: 'ok';
  available: boolean;
  entries: number;
  bytes: number;
  max_bytes: 268_435_456;
  retention_days: 30;
};

export type OcrCacheClearResult = OcrCacheInfo & {
  removed_entries: number;
  failed_entries: number;
};

export type EngineRect = { x0: number; y0: number; x1: number; y1: number };

export type EngineCropSelection = {
  match_rect: EngineRect;
  rect: EngineRect | null;
  candidate_index?: number | null;
  candidate_rect?: EngineRect | null;
  confidence: number;
  slot: string | null;
  evidence: string[];
  needs_review: boolean;
  snap_points?: number[];
};

export type EnginePageAnalysis = {
  status: 'ok';
  page: number;
  page_width: number;
  page_height: number;
  source_sha256?: string;
  page_fully_matched?: boolean;
  selections: EngineCropSelection[];
};

export type LocalEngineErrorCode =
  | 'TAURI_UNAVAILABLE'
  | 'ENGINE_HEALTH_FAILED'
  | 'ENGINE_INVALID_RESPONSE'
  | 'ENGINE_INVALID_REQUEST'
  | 'ENGINE_ANALYZE_FAILED'
  | 'ENGINE_REQUEST_REJECTED';

export type EngineMatch = {
  source_key?: string;
  source_path?: string;
  source_sha256?: string;
  page: number;
  matched_text: string;
  matched_field: string | null;
  confidence: number;
  needs_review?: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type EngineSearchResult = {
  status: 'ok';
  page_count: number;
  source_sha256: string;
  matches: EngineMatch[];
};

export type EnginePdfMetadata = {
  status: 'ok';
  page_count: number;
  source_sha256: string;
};

export type EngineSearchClause = {
  id: string;
  keyword: string;
  role: 'include' | 'exclude';
};

export type EngineMultiSearchMatch = EngineMatch & {
  query_id: string;
  role: 'include' | 'exclude';
};

export type EngineMultiSearchResult = Omit<EngineSearchResult, 'matches'> & {
  matches: EngineMultiSearchMatch[];
};

export type EnginePagePreview = {
  status: 'ok';
  page: number;
  page_count: number;
  page_width: number;
  page_height: number;
  source_sha256?: string;
  image_data: string;
};

export type EngineExportResult = {
  status: 'ok';
  output_path: string;
  row_count: number;
};

export type EnginePdfExportResult = {
  status: 'ok';
  output_path: string;
  page_count: number;
  sha256: string;
};

export type EnginePublishPreviewResult = {
  status: 'ok';
  output_path: string;
  sha256: string;
};

export type EngineCleanupResult = {
  status: 'ok';
  cleaned_count: number;
};

export type EngineReleaseResult = {
  status: 'ok';
  released_count: number;
};

export type PdfPickerResult = {
  files: string[];
  directory: string | null;
};

export type EnginePdfExportSegment = {
  page_number: number;
  segment_no: number;
  rect: EngineRect | null;
  keep_full_page: boolean;
  review_status: string;
};

export type EnginePdfExportSelection = {
  source_path: string;
  source_sha256: string;
  segments: EnginePdfExportSegment[];
};

export type EngineReviewSegment = {
  id: string;
  task_id: string;
  source_path: string;
  source_sha256: string;
  source_page: number;
  segment_no: number;
  match_rect: EngineRect;
  candidate_rect: EngineRect | null;
  final_rect: EngineRect | null;
  layout_fingerprint: string;
  confidence: number;
  crop_mode: 'candidate' | 'manual' | 'full_page';
  review_status: 'pending' | 'needs_review' | 'confirmed' | 'page_confirmed' | 'group_confirmed' | 'blocked';
  manual_adjusted: boolean;
  reviewed_at: string;
};

export type EngineReviewSegmentsSaveResult = {
  status: 'ok';
  task_id: string;
  saved_count: number;
};

export type EngineReviewSegmentsLoadResult = {
  status: 'ok';
  task_id: string;
  segments: EngineReviewSegment[];
};

type LocalEngineErrorOptions = ErrorOptions & { engineCode?: string };

export type EngineReviewContext = {
  version: 2;
  sources: { source_key: string; source_path: string; source_sha256: string }[];
  criteria_fingerprint: string;
  computation_version: string;
};

export type EngineOriginalReview = {
  id: string;
  source_key: string;
  source_page: number;
  segment_no: number;
  analysis_signature: string;
  persistable: boolean;
  page_width: number;
  page_height: number;
  match_rect: EngineRect | null;
  candidate_rect: EngineRect | null;
  layout_fingerprint: string;
  confidence: number;
  auto_full_page: boolean;
};

export type EngineReviewSegmentV2 = EngineReviewSegment & {
  context_key: string;
  source_key: string;
  analysis_signature: string;
  result_revision: string;
  record_revision: number;
  page_width: number;
  page_height: number;
};

export type EngineReviewRevision = Pick<EngineOriginalReview, 'id' | 'source_key' | 'source_page' | 'segment_no'> & {
  record_revision: number;
  /** Immutable legacy association; cleanup ownership is tracked separately. */
  task_id?: string | null;
};

export type EnginePreparedReview = {
  status: 'ok';
  context_key: string;
  result_revision: string;
  segments: EngineReviewSegmentV2[];
  record_revisions: EngineReviewRevision[];
  group_confirmed: boolean;
};

export type EngineSavedReviewV2 = Pick<EnginePreparedReview, 'status' | 'context_key' | 'result_revision' | 'segments'> & {
  saved_count: number;
};

export class LocalEngineError extends Error {
  readonly code: LocalEngineErrorCode;
  readonly engineCode?: string;

  constructor(code: LocalEngineErrorCode, message: string, options?: LocalEngineErrorOptions) {
    super(message, options);
    this.name = 'LocalEngineError';
    this.code = code;
    this.engineCode = options?.engineCode;
  }
}

export interface LocalEngineAdapter {
  describeCropPage(path: string, page: number, sourceSha256: string): Promise<CropTemplatePage>;
  health(): Promise<EngineHealth>;
  ocrHealth(verify?: boolean): Promise<OcrHealth>;
  ocrCacheInfo(): Promise<OcrCacheInfo>;
  ocrCacheClear(): Promise<OcrCacheClearResult>;
  search(path: string, keyword: string, exact?: boolean): Promise<EngineSearchResult>;
  searchMulti(path: string, clauses: EngineSearchClause[], exact?: boolean): Promise<EngineMultiSearchResult>;
  inspectPdf(path: string): Promise<EnginePdfMetadata>;
  renderPage(path: string, page: number, sourceSha256: string): Promise<EnginePagePreview>;
  analyzePage(path: string, page: number, matches: EngineRect[], sourceSha256: string): Promise<EnginePageAnalysis>;
  saveReviewSegments(taskId: string, segments: EngineReviewSegment[]): Promise<EngineReviewSegmentsSaveResult>;
  loadReviewSegments(taskId: string): Promise<EngineReviewSegmentsLoadResult>;
  computationInfo(): Promise<{ status: 'ok'; computation_version: string }>;
  prepareReviewContext(context: EngineReviewContext, originals: EngineOriginalReview[], resultRevision: string): Promise<EnginePreparedReview>;
  readReviewSnapshot(context: EngineReviewContext, originals: EngineOriginalReview[], resultRevision: string): Promise<EnginePreparedReview>;
  saveReviewSegmentsV2(contextKey: string, resultRevision: string, segments: EngineReviewSegmentV2[], confirmGroup?: boolean): Promise<EngineSavedReviewV2>;
  exportIndex(outputPath: string, rows: Record<string, unknown>[], exportToken: string): Promise<EngineExportResult>;
  exportPdf(outputPath: string, selections: EnginePdfExportSelection[], exportToken: string): Promise<EnginePdfExportResult>;
  createExportPreviewPath(exportToken: string, batchJobId?: string): Promise<string>;
  publishPreviewPdf(previewPath: string, outputPath: string, previewToken: string, finalToken: string): Promise<EnginePublishPreviewResult>;
  cleanupExports(exportToken: string): Promise<EngineCleanupResult>;
  releaseExports(exportToken: string): Promise<EngineReleaseResult>;
  pickPdfFiles(initialDirectory?: string | null): Promise<PdfPickerResult>;
  pickPdfFolder(initialDirectory?: string | null): Promise<PdfPickerResult>;
  pickDirectory(initialDirectory?: string | null): Promise<string | null>;
  validateDirectory(path: string): Promise<boolean>;
  pickOutputFolder(initialDirectory?: string | null): Promise<string | null>;
  openOutputFolder(path: string): Promise<void>;
}

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
};

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in (window as TauriWindow)
  );
}

function isEngineHealth(value: unknown): value is EngineHealth {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.status === 'ok' &&
    typeof payload.engine === 'string' &&
    typeof payload.version === 'string'
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isEngineRect(value: unknown): value is EngineRect {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return isFiniteNumber(payload.x0)
    && isFiniteNumber(payload.y0)
    && isFiniteNumber(payload.x1)
    && isFiniteNumber(payload.y1);
}

function isOrderedNonNegativeRect(value: unknown): value is EngineRect {
  return isEngineRect(value)
    && value.x0 >= 0
    && value.y0 >= 0
    && value.x0 < value.x1
    && value.y0 < value.y1;
}

function isRectInsidePage(value: unknown, pageWidth: number, pageHeight: number): value is EngineRect {
  return isOrderedNonNegativeRect(value)
    && value.x1 <= pageWidth
    && value.y1 <= pageHeight;
}

function isLegalV2FinalRect(
  value: unknown,
  cropMode: EngineReviewSegment['crop_mode'],
  reviewStatus: EngineReviewSegment['review_status'],
  pageWidth: number,
  pageHeight: number,
): value is EngineRect | null {
  if (value === null) {
    return cropMode === 'full_page'
      || !['confirmed', 'page_confirmed', 'group_confirmed'].includes(reviewStatus);
  }
  if (!isRectInsidePage(value, pageWidth, pageHeight)) return false;
  const width = value.x1 - value.x0;
  const height = value.y1 - value.y0;
  const validWidth = pageWidth < MIN_CROP_SIZE
    ? value.x0 === 0 && value.x1 === pageWidth
    : width >= MIN_CROP_SIZE;
  const validHeight = pageHeight < MIN_CROP_SIZE
    ? value.y0 === 0 && value.y1 === pageHeight
    : height >= MIN_CROP_SIZE;
  return validWidth && validHeight;
}

function rectsEqual(left: EngineRect, right: EngineRect): boolean {
  return left.x0 === right.x0
    && left.y0 === right.y0
    && left.x1 === right.x1
    && left.y1 === right.y1;
}

function containsRect(container: EngineRect, contained: EngineRect): boolean {
  return container.x0 <= contained.x0
    && container.y0 <= contained.y0
    && container.x1 >= contained.x1
    && container.y1 >= contained.y1;
}

function isCropSelection(
  value: unknown,
  pageWidth: number,
  pageHeight: number,
  expectedMatch: EngineRect,
): value is EngineCropSelection {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (!isRectInsidePage(payload.match_rect, pageWidth, pageHeight)) return false;
  if (!rectsEqual(payload.match_rect, expectedMatch)) return false;
  if (!isFiniteNumber(payload.confidence) || payload.confidence < 0 || payload.confidence > 1) return false;
  if (!Array.isArray(payload.evidence) || !payload.evidence.every((item) => typeof item === 'string')) return false;
  if (typeof payload.needs_review !== 'boolean') return false;
  if (payload.snap_points !== undefined && !Array.isArray(payload.snap_points)) return false;
  if (Array.isArray(payload.snap_points) && !payload.snap_points.every((point) => (
    isFiniteNumber(point) && point >= 0 && point <= pageHeight
  ))) return false;
  if (payload.candidate_index !== undefined && payload.candidate_index !== null && (
    !isFiniteNumber(payload.candidate_index)
    || !Number.isInteger(payload.candidate_index)
    || payload.candidate_index < 0
  )) return false;
  if (payload.candidate_rect !== undefined && payload.candidate_rect !== null && (
    !isRectInsidePage(payload.candidate_rect, pageWidth, pageHeight)
    || !containsRect(payload.candidate_rect, payload.match_rect)
  )) return false;
  if (payload.candidate_index !== undefined && payload.candidate_rect !== undefined && (
    (payload.candidate_index === null) !== (payload.candidate_rect === null)
  )) return false;
  if (payload.rect === null) {
    return payload.confidence === 0
      && payload.slot === null
      && payload.evidence.length === 0
      && payload.needs_review;
  }
  return isRectInsidePage(payload.rect, pageWidth, pageHeight)
    && containsRect(payload.rect, payload.match_rect)
    && typeof payload.slot === 'string'
    && payload.slot.trim().length > 0
    && payload.needs_review === (payload.confidence < 0.9);
}

function isPageAnalysis(
  value: unknown,
  expectedPage: number,
  expectedMatches: EngineRect[],
): value is EnginePageAnalysis {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (payload.status !== 'ok' || !isFiniteNumber(payload.page) || !Number.isInteger(payload.page) || payload.page !== expectedPage) return false;
  if (!isFiniteNumber(payload.page_width) || payload.page_width <= 0) return false;
  if (!isFiniteNumber(payload.page_height) || payload.page_height <= 0) return false;
  if (payload.page_fully_matched !== undefined && typeof payload.page_fully_matched !== 'boolean') return false;
  if (!Array.isArray(payload.selections) || payload.selections.length !== expectedMatches.length) return false;
  const pageWidth = payload.page_width;
  const pageHeight = payload.page_height;
  return payload.selections.every((selection, index) =>
    isCropSelection(selection, pageWidth, pageHeight, expectedMatches[index]),
  );
}

type EngineErrorResponse = {
  status: 'error';
  code: string;
  message: string;
  page_count?: unknown;
  max_pages?: unknown;
};

function engineErrorMessage(response: EngineErrorResponse): string {
  if (response.code !== 'page_limit_exceeded') return response.message;
  const pages = response.page_count;
  const limit = response.max_pages;
  if (typeof pages === 'number' && Number.isSafeInteger(pages)
      && typeof limit === 'number' && Number.isSafeInteger(limit)
      && limit > 0 && pages > limit) {
    return `此 PDF 共 ${pages} 页，超过当前每个 PDF ${limit} 页的限制。请拆分文件后重试。`;
  }
  return 'PDF 页数超过当前配置上限。请拆分文件后重试。';
}

function isEngineErrorResponse(value: unknown): value is EngineErrorResponse {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return payload.status === 'error'
    && typeof payload.code === 'string'
    && typeof payload.message === 'string';
}

function assertAnalyzeRequest(page: number, matches: EngineRect[]): void {
  if (!isFiniteNumber(page) || !Number.isInteger(page) || page < 1) {
    throw new LocalEngineError('ENGINE_INVALID_REQUEST', '页面编号必须是正整数。');
  }
  if (!Array.isArray(matches) || !matches.every((match) => isOrderedNonNegativeRect(match))) {
    throw new LocalEngineError('ENGINE_INVALID_REQUEST', '页面命中区域必须是有限、非负且有序的矩形。');
  }
}

function assertSourceSha256(sourceSha256: string): void {
  if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sourceSha256)) {
    throw new LocalEngineError('ENGINE_INVALID_REQUEST', '源 PDF 的 SHA-256 无效，请重新分析文件。');
  }
}

function normalizeOcrHealth(value: unknown): OcrHealth | null {
  if (typeof value !== 'object' || value === null) return null;
  const payload = value as Record<string, unknown>;
  if (payload.status !== 'ok'
    || typeof payload.available !== 'boolean'
    || payload.engine !== 'paddleocr'
    || typeof payload.message !== 'string') return null;

  const rawReadiness = payload.readiness;
  const readiness = rawReadiness === undefined
    ? (payload.available ? 'installed' : 'unavailable')
    : rawReadiness;
  if (readiness !== 'installed' && readiness !== 'ready'
    && readiness !== 'unavailable' && readiness !== 'failed') return null;

  const rawCode = payload.code;
  if (rawCode !== undefined
    && rawCode !== 'ocr_initialization_failed'
    && rawCode !== 'ocr_inference_failed'
    && rawCode !== 'ocr_result_invalid') return null;

  return {
    status: 'ok',
    available: payload.available,
    engine: 'paddleocr',
    message: payload.message,
    readiness,
    ...(rawCode === undefined ? {} : { code: rawCode }),
  };
}

const OCR_CACHE_MAX_BYTES = 268_435_456 as const;
const OCR_CACHE_RETENTION_DAYS = 30 as const;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizeOcrCacheInfo(value: unknown): OcrCacheInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.status !== 'ok'
    || typeof payload.available !== 'boolean'
    || !isNonNegativeSafeInteger(payload.entries)
    || !isNonNegativeSafeInteger(payload.bytes)
    || payload.max_bytes !== OCR_CACHE_MAX_BYTES
    || payload.retention_days !== OCR_CACHE_RETENTION_DAYS
  ) return null;
  return {
    status: 'ok',
    available: payload.available,
    entries: payload.entries,
    bytes: payload.bytes,
    max_bytes: OCR_CACHE_MAX_BYTES,
    retention_days: OCR_CACHE_RETENTION_DAYS,
  };
}

function normalizeOcrCacheClear(value: unknown): OcrCacheClearResult | null {
  const info = normalizeOcrCacheInfo(value);
  if (!info || typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (!isNonNegativeSafeInteger(payload.removed_entries)
    || !isNonNegativeSafeInteger(payload.failed_entries)) return null;
  return {
    ...info,
    removed_entries: payload.removed_entries,
    failed_entries: payload.failed_entries,
  };
}

function isSearchResult(value: unknown): value is EngineSearchResult {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return payload.status === 'ok'
    && typeof payload.page_count === 'number'
    && Number.isInteger(payload.page_count)
    && payload.page_count > 0
    && typeof payload.source_sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test(payload.source_sha256)
    && Array.isArray(payload.matches);
}

function isPdfMetadata(value: unknown): value is EnginePdfMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return payload.status === 'ok'
    && typeof payload.page_count === 'number'
    && Number.isInteger(payload.page_count)
    && payload.page_count > 0
    && typeof payload.source_sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test(payload.source_sha256);
}

function isEngineMultiSearchMatch(
  value: unknown,
  pageCount: number,
  sourceSha256: string,
): value is EngineMultiSearchMatch {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  const rect = {
    x0: payload.x0,
    y0: payload.y0,
    x1: payload.x1,
    y1: payload.y1,
  };
  if (
    !isFiniteNumber(payload.page)
    || !Number.isInteger(payload.page)
    || payload.page < 1
    || payload.page > pageCount
    || typeof payload.matched_text !== 'string'
    || payload.matched_text.length === 0
    || (typeof payload.matched_field !== 'string' && payload.matched_field !== null)
    || !isFiniteNumber(payload.confidence)
    || payload.confidence < 0
    || payload.confidence > 1
    || !isOrderedNonNegativeRect(rect)
    || typeof payload.query_id !== 'string'
    || payload.query_id.trim().length === 0
    || (payload.role !== 'include' && payload.role !== 'exclude')
  ) return false;
  if (payload.source_path !== undefined && (
    typeof payload.source_path !== 'string' || payload.source_path.trim().length === 0
  )) return false;
  if (payload.source_sha256 !== undefined && (
    typeof payload.source_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/i.test(payload.source_sha256)
    || payload.source_sha256.toLowerCase() !== sourceSha256.toLowerCase()
  )) return false;
  return payload.needs_review === undefined || typeof payload.needs_review === 'boolean';
}

function isEngineMultiSearchResult(
  value: unknown,
  clauses: EngineSearchClause[],
): value is EngineMultiSearchResult {
  if (!isSearchResult(value)) return false;
  const rolesById = new Map<string, EngineSearchClause['role']>();
  for (const clause of clauses as unknown[]) {
    if (
      typeof clause !== 'object'
      || clause === null
      || Array.isArray(clause)
    ) return false;
    const candidate = clause as Record<string, unknown>;
    if (
      typeof candidate.id !== 'string'
      || candidate.id.trim().length === 0
      || typeof candidate.keyword !== 'string'
      || candidate.keyword.trim().length === 0
      || (candidate.role !== 'include' && candidate.role !== 'exclude')
      || rolesById.has(candidate.id)
    ) return false;
    rolesById.set(candidate.id, candidate.role);
  }
  if (rolesById.size === 0) return false;
  return value.matches.every((match) => (
    isEngineMultiSearchMatch(match, value.page_count, value.source_sha256)
    && rolesById.get(match.query_id) === match.role
  ));
}

function isPagePreview(value: unknown): value is EnginePagePreview {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return payload.status === 'ok'
    && typeof payload.page === 'number'
    && typeof payload.page_count === 'number'
    && typeof payload.page_width === 'number'
    && typeof payload.page_height === 'number'
    && typeof payload.source_sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test(payload.source_sha256)
    && typeof payload.image_data === 'string'
    && payload.image_data.startsWith('data:image/png;base64,');
}

/**
 * Compare paths at the adapter boundary using the same lexical conventions
 * used by the local engine on Windows. The engine may canonicalize slash
 * direction or drive-letter casing, but it must never redirect an export to a
 * different file.
 */
export function sameExportPath(left: string, right: string): boolean {
  const normalize = (value: string): string => value
    .trim()
    .normalize('NFC')
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
  return normalize(left) === normalize(right);
}

function isExportResult(value: unknown): value is EngineExportResult {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return payload.status === 'ok'
    && typeof payload.output_path === 'string'
    && typeof payload.row_count === 'number'
    && Number.isInteger(payload.row_count)
    && payload.row_count >= 0;
}

function isPdfExportResult(value: unknown): value is EnginePdfExportResult {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return payload.status === 'ok'
    && typeof payload.output_path === 'string'
    && typeof payload.page_count === 'number'
    && typeof payload.sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test(payload.sha256);
}

function isPublishPreviewResult(value: unknown): value is EnginePublishPreviewResult {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return payload.status === 'ok'
    && typeof payload.output_path === 'string'
    && typeof payload.sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test(payload.sha256);
}

function isCleanupResult(value: unknown): value is EngineCleanupResult {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return payload.status === 'ok'
    && typeof payload.cleaned_count === 'number'
    && Number.isInteger(payload.cleaned_count)
    && payload.cleaned_count >= 0;
}

function isReleaseResult(value: unknown): value is EngineReleaseResult {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return payload.status === 'ok'
    && typeof payload.released_count === 'number'
    && Number.isInteger(payload.released_count)
    && payload.released_count >= 0;
}

function isPdfPickerResult(value: unknown): value is PdfPickerResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return Array.isArray(payload.files)
    && payload.files.every((file) => typeof file === 'string' && file.trim().length > 0)
    && (
      payload.directory === null
      || (
        typeof payload.directory === 'string'
        && payload.directory.trim().length > 0
      )
    );
}

function isReviewSegmentRect(value: unknown, nullable: boolean): value is EngineRect | null {
  if (value === null && nullable) return true;
  return isOrderedNonNegativeRect(value);
}

function isUtcIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isReviewSegment(value: unknown): value is EngineReviewSegment {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.id === 'string'
    && payload.id.trim().length > 0
    && typeof payload.task_id === 'string'
    && payload.task_id.trim().length > 0
    && typeof payload.source_path === 'string'
    && payload.source_path.trim().length > 0
    && typeof payload.source_sha256 === 'string'
    && payload.source_sha256.trim().length > 0
    && isFiniteNumber(payload.source_page)
    && Number.isInteger(payload.source_page)
    && payload.source_page >= 1
    && isFiniteNumber(payload.segment_no)
    && Number.isInteger(payload.segment_no)
    && payload.segment_no >= 1
    && isReviewSegmentRect(payload.match_rect, false)
    && isReviewSegmentRect(payload.candidate_rect, true)
    && isReviewSegmentRect(payload.final_rect, true)
    && typeof payload.layout_fingerprint === 'string'
    && payload.layout_fingerprint.trim().length > 0
    && isFiniteNumber(payload.confidence)
    && payload.confidence >= 0
    && payload.confidence <= 1
    && (payload.crop_mode === 'candidate' || payload.crop_mode === 'manual' || payload.crop_mode === 'full_page')
    && (payload.review_status === 'pending' || payload.review_status === 'needs_review' || payload.review_status === 'confirmed' || payload.review_status === 'page_confirmed' || payload.review_status === 'group_confirmed' || payload.review_status === 'blocked')
    && typeof payload.manual_adjusted === 'boolean'
    && isUtcIsoTimestamp(payload.reviewed_at);
}

function isReviewSegmentsSaveResult(value: unknown): value is EngineReviewSegmentsSaveResult {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return payload.status === 'ok'
    && typeof payload.task_id === 'string'
    && Number.isInteger(payload.saved_count)
    && typeof payload.saved_count === 'number'
    && payload.saved_count >= 0;
}

function isReviewSegmentsLoadResult(value: unknown): value is EngineReviewSegmentsLoadResult {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  const segments = payload.segments;
  const records = Array.isArray(segments) ? segments : [];
  const ids = records.map((segment) => (
    typeof segment === 'object' && segment !== null && typeof (segment as Record<string, unknown>).id === 'string'
      ? (segment as Record<string, unknown>).id
      : null
  ));
  return payload.status === 'ok'
    && typeof payload.task_id === 'string'
    && Array.isArray(segments)
    && records.every(isReviewSegment)
    && new Set(ids).size === records.length
    && records.every((segment) => segment.task_id === payload.task_id);
}

function assertTaskId(taskId: string): void {
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new LocalEngineError('ENGINE_INVALID_REQUEST', '审核任务标识不能为空。');
  }
}

const EXPORT_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/;

const REVIEW_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const boundedReviewText = (value: unknown, limit: number): value is string => (
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !value.includes('\0')
);
const reviewDigest = (value: unknown): value is string => typeof value === 'string' && REVIEW_DIGEST_PATTERN.test(value);
const reviewInteger = (value: unknown, minimum = 0): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
);
const reviewKey = (item: Pick<EngineOriginalReview, 'source_key' | 'source_page' | 'segment_no'>): string => (
  JSON.stringify([item.source_key, item.source_page, item.segment_no])
);

function validReviewContext(context: EngineReviewContext, allowSourceAliases = false): boolean {
  if (!context || context.version !== 2 || !reviewDigest(context.criteria_fingerprint)
    || !boundedReviewText(context.computation_version, 256) || !Array.isArray(context.sources)
    || context.sources.length === 0 || context.sources.length > 10_000) return false;
  const keys = new Set<string>();
  return context.sources.every((source) => {
    if (!source || !boundedReviewText(source.source_key, 32768) || !boundedReviewText(source.source_path, 32768)
      || normalizeSourcePath(source.source_key) !== source.source_key
      || (!allowSourceAliases && normalizeSourcePath(source.source_path) !== source.source_key)
      || !reviewDigest(source.source_sha256) || keys.has(source.source_key)) return false;
    keys.add(source.source_key);
    return true;
  });
}

function validOriginalReviews(context: EngineReviewContext, originals: EngineOriginalReview[]): boolean {
  if (!Array.isArray(originals) || originals.length > 50_000) return false;
  const sources = new Set(context.sources.map((source) => source.source_key));
  const ids = new Set<string>();
  const keys = new Set<string>();
  return originals.every((item) => {
    if (!item || !boundedReviewText(item.id, 1024) || !sources.has(item.source_key)
      || !Number.isSafeInteger(item.source_page) || !reviewInteger(item.segment_no, 1)
      || !reviewDigest(item.analysis_signature) || typeof item.persistable !== 'boolean'
      || typeof item.auto_full_page !== 'boolean' || !isFiniteNumber(item.page_width) || item.page_width < 0
      || !isFiniteNumber(item.page_height) || item.page_height < 0
      || !boundedReviewText(item.layout_fingerprint, 1024) || !isFiniteNumber(item.confidence)
      || item.confidence < 0 || item.confidence > 1 || ids.has(item.id) || keys.has(reviewKey(item))
      || (item.match_rect !== null && !isEngineRect(item.match_rect))
      || (item.candidate_rect !== null && !isEngineRect(item.candidate_rect))) return false;
    if (item.persistable && (!reviewInteger(item.source_page, 1) || item.page_width <= 0 || item.page_height <= 0
      || !isRectInsidePage(item.match_rect, item.page_width, item.page_height)
      || (item.candidate_rect !== null && !isRectInsidePage(item.candidate_rect, item.page_width, item.page_height)))) return false;
    ids.add(item.id);
    keys.add(reviewKey(item));
    return true;
  });
}

async function reviewContextDigest(context: EngineReviewContext): Promise<string> {
  // Matches Python's sorted-key, compact, UTF-8 context encoding. Only logical
  // source keys and content hashes affect identity; access-path spelling does not.
  const canonical = JSON.stringify({
    computation_version: context.computation_version,
    criteria_fingerprint: context.criteria_fingerprint,
    sources: context.sources.map(({ source_key, source_sha256 }) => ({ source_key, source_sha256 })),
    version: 2,
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isReviewSegmentV2(value: unknown, minimumRevision = 0): value is EngineReviewSegmentV2 {
  if (!isReviewSegment(value)) return false;
  const item = value as EngineReviewSegmentV2;
  return reviewDigest(item.context_key) && reviewDigest(item.analysis_signature) && reviewDigest(item.source_sha256)
    && boundedReviewText(item.result_revision, 128) && reviewInteger(item.record_revision, minimumRevision)
    && boundedReviewText(item.id, 1024) && boundedReviewText(item.task_id, 1024)
    && reviewInteger(item.source_page, 1) && reviewInteger(item.segment_no, 1)
    && boundedReviewText(item.source_key, 32768) && item.source_key === normalizeSourcePath(item.source_key)
    && boundedReviewText(item.source_path, 32768)
    && boundedReviewText(item.layout_fingerprint, 1024)
    && isFiniteNumber(item.page_width) && item.page_width > 0 && isFiniteNumber(item.page_height) && item.page_height > 0
    && isRectInsidePage(item.match_rect, item.page_width, item.page_height)
    && (item.candidate_rect === null || isRectInsidePage(item.candidate_rect, item.page_width, item.page_height))
    && isLegalV2FinalRect(item.final_rect, item.crop_mode, item.review_status, item.page_width, item.page_height);
}

function nullableRectsEqual(left: EngineRect | null, right: EngineRect | null): boolean {
  return left === null || right === null ? left === right : rectsEqual(left, right);
}

function matchesOriginal(
  record: EngineReviewSegmentV2,
  original: EngineOriginalReview,
  source: EngineReviewContext['sources'][number],
): boolean {
  return original.persistable && record.id === original.id && reviewKey(record) === reviewKey(original)
    && record.source_key === source.source_key
    && normalizeSourcePath(record.source_path) === normalizeSourcePath(source.source_path)
    && record.source_sha256.toLowerCase() === source.source_sha256.toLowerCase()
    && record.analysis_signature === original.analysis_signature && record.page_width === original.page_width
    && record.page_height === original.page_height && nullableRectsEqual(record.match_rect, original.match_rect)
    && nullableRectsEqual(record.candidate_rect, original.candidate_rect)
    && record.layout_fingerprint === original.layout_fingerprint && record.confidence === original.confidence;
}

function validPreparedReview(
  response: unknown, context: EngineReviewContext, originals: EngineOriginalReview[], contextKey: string, resultRevision: string,
): response is EnginePreparedReview {
  if (!response || typeof response !== 'object') return false;
  const value = response as EnginePreparedReview;
  if (value.status !== 'ok' || value.context_key !== contextKey || value.result_revision !== resultRevision
    || !Array.isArray(value.segments) || value.segments.length > originals.length || !Array.isArray(value.record_revisions)
    || value.record_revisions.length !== originals.length || typeof value.group_confirmed !== 'boolean') return false;
  const originalByKey = new Map(originals.map((item) => [reviewKey(item), item]));
  const revisionByKey = new Map<string, number>();
  const revisionTaskIdByKey = new Map<string, string>();
  for (const revision of value.record_revisions) {
    if (!revision || typeof revision !== 'object' || Array.isArray(revision)
      || !reviewInteger(revision.record_revision)) return false;
    const key = reviewKey(revision);
    const original = originalByKey.get(key);
    if (!original || original.id !== revision.id || revisionByKey.has(key)) return false;
    if (revision.record_revision === 0) {
      if (revision.task_id !== undefined && revision.task_id !== null) return false;
    } else if (revision.task_id !== undefined) {
      if (!boundedReviewText(revision.task_id, 1024)) return false;
      revisionTaskIdByKey.set(key, revision.task_id);
    }
    revisionByKey.set(key, revision.record_revision);
  }
  const sources = new Map(context.sources.map((source) => [source.source_key, source]));
  const seen = new Set<string>();
  for (const record of value.segments) {
    if (!isReviewSegmentV2(record, 1)) return false;
    const key = reviewKey(record);
    const original = originalByKey.get(key);
    const source = sources.get(record.source_key);
    if (!original || seen.has(key)
      || record.context_key !== contextKey || record.result_revision !== resultRevision
      || !source || !matchesOriginal(record, original, source)
      || revisionByKey.get(key) !== record.record_revision
      || (revisionTaskIdByKey.has(key) && revisionTaskIdByKey.get(key) !== record.task_id)) return false;
    seen.add(key);
  }
  return !value.group_confirmed || (originals.length > 0 && value.segments.length === originals.length
    && originals.every((item) => item.persistable) && value.segments.every((record) => record.review_status === 'group_confirmed'));
}

/**
 * Validate a prepared review returned by a trusted host-owned context.
 *
 * The context descriptor is the authority for logical source keys, current
 * access paths and immutable source hashes.  A relocated source may therefore
 * have a `source_key` that does not normalize to its `source_path`; arbitrary
 * aliases are still rejected because every record is checked against this
 * descriptor.  This helper performs no engine call and is also used by the
 * regular adapter prepare path after its strict public-context gate.
 */
export async function validatePreparedReviewResponse(
  value: unknown,
  context: EngineReviewContext,
  originals: EngineOriginalReview[],
  resultRevision: string,
): Promise<EnginePreparedReview> {
  if (!validReviewContext(context, true) || !boundedReviewText(resultRevision, 128)
    || !validOriginalReviews(context, originals)) {
    throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '审核上下文或原始分析清单无效。');
  }
  const contextKey = await reviewContextDigest(context);
  if (!validPreparedReview(value, context, originals, contextKey, resultRevision)) {
    throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '审核记录与当前分析上下文不一致。');
  }
  return value as EnginePreparedReview;
}

function sameSavedDecision(left: EngineReviewSegmentV2, right: EngineReviewSegmentV2): boolean {
  const fields = ['id', 'task_id', 'source_path', 'source_sha256', 'source_page', 'segment_no', 'context_key',
    'source_key', 'analysis_signature', 'result_revision', 'page_width', 'page_height', 'layout_fingerprint',
    'confidence', 'crop_mode', 'review_status', 'manual_adjusted', 'reviewed_at'] as const;
  return fields.every((field) => left[field] === right[field])
    && nullableRectsEqual(left.match_rect, right.match_rect) && nullableRectsEqual(left.candidate_rect, right.candidate_rect)
    && nullableRectsEqual(left.final_rect, right.final_rect);
}

async function invokeReviewV2(command: string, args?: Record<string, unknown>): Promise<unknown> {
  let response: unknown;
  try {
    response = args === undefined ? await invoke<unknown>(command) : await invoke<unknown>(command, args);
  } catch (cause) {
    throw new LocalEngineError('ENGINE_HEALTH_FAILED', '审核记录处理失败，请重试。', { cause });
  }
  if (isEngineErrorResponse(response)) {
    throw new LocalEngineError('ENGINE_REQUEST_REJECTED', engineErrorMessage(response), { engineCode: response.code });
  }
  return response;
}

function assertExportToken(exportToken: string): void {
  if (typeof exportToken !== 'string' || !EXPORT_TOKEN_PATTERN.test(exportToken.trim())) {
    throw new LocalEngineError('ENGINE_INVALID_REQUEST', '导出请求标识无效，请重新发起导出。');
  }
}

function isExportRect(value: unknown): value is EngineRect {
  return isOrderedNonNegativeRect(value)
    && value.x1 > value.x0
    && value.y1 > value.y0;
}

function isPdfExportSegment(value: unknown): value is EnginePdfExportSegment {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.page_number !== 'number'
    || !Number.isInteger(payload.page_number)
    || payload.page_number < 1
    || typeof payload.segment_no !== 'number'
    || !Number.isInteger(payload.segment_no)
    || payload.segment_no < 1
    || typeof payload.keep_full_page !== 'boolean'
    || payload.review_status !== 'confirmed'
  ) return false;
  if (payload.keep_full_page) return payload.rect === null || isExportRect(payload.rect);
  return isExportRect(payload.rect);
}

function isPdfExportSelection(value: unknown): value is EnginePdfExportSelection {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.source_path !== 'string'
    || payload.source_path.trim().length === 0
    || typeof payload.source_sha256 !== 'string'
    || payload.source_sha256.trim().length === 0
    || payload.source_sha256.trim() === 'unavailable'
    || !Array.isArray(payload.segments)
    || payload.segments.length === 0
    || !payload.segments.every(isPdfExportSegment)
  ) return false;
  const pageSegmentKeys = payload.segments.map((segment) => `${segment.page_number}:${segment.segment_no}`);
  return new Set(pageSegmentKeys).size === pageSegmentKeys.length;
}

function assertPdfExportRequest(outputPath: string, selections: unknown): asserts selections is EnginePdfExportSelection[] {
  if (typeof outputPath !== 'string' || outputPath.trim().length === 0 || !/\.pdf$/i.test(outputPath)) {
    throw new LocalEngineError('ENGINE_INVALID_REQUEST', 'PDF 输出路径必须是 .pdf 文件。');
  }
  if (!Array.isArray(selections) || selections.length === 0 || !selections.every(isPdfExportSelection)) {
    throw new LocalEngineError(
      'ENGINE_INVALID_REQUEST',
      'PDF 导出必须包含每个已确认片段的页码、片段号、裁剪区域、整页标记和源文件 SHA-256。',
    );
  }
}

/**
 * The production adapter always goes through the Tauri command boundary.
 * Browser/Vite preview builds fail explicitly instead of returning demo data.
 */
function isCropTemplatePage(value: unknown, page: number, sha: string): value is CropTemplatePage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (data.status !== 'ok' || data.page !== page || !Number.isSafeInteger(data.page_count)
      || (data.page_count as number) < page || data.source_sha256 !== sha
      || !isFiniteNumber(data.page_width) || data.page_width <= 0
      || !isFiniteNumber(data.page_height) || data.page_height <= 0) return false;
  const template = data.crop_template as Record<string, unknown> | undefined;
  if (!template || typeof template !== 'object' || Array.isArray(template)) return false;
  if (template.status === 'unavailable') return ['no_text','no_titles','ambiguous_layout','budget_exceeded'].includes(template.reason as string);
  const hash = (item: unknown) => typeof item === 'string' && /^[a-f0-9]{64}$/i.test(item);
  if (template.status !== 'ready' || !hash(template.fingerprint) || !Array.isArray(template.receipts)
      || template.receipts.length === 0 || template.receipts.length > 128) return false;
  let previousBottom = 0;
  return template.receipts.every((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const receipt = item as Record<string, unknown>;
    if (!isRectInsidePage(receipt.bounds, data.page_width as number, data.page_height as number)
        || !isFiniteNumber(receipt.anchor_y) || !hash(receipt.title_key)) return false;
    const bounds = receipt.bounds;
    if (bounds.y0 < previousBottom || receipt.anchor_y < bounds.y0 || receipt.anchor_y >= bounds.y1) return false;
    previousBottom = bounds.y1;
    return true;
  });
}

export const localEngineAdapter: LocalEngineAdapter = {
  async describeCropPage(path, page, sourceSha256) {
    assertAnalyzeRequest(page, []);
    assertSourceSha256(sourceSha256);
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', '版式检查需要在桌面应用中运行。');
    let response: unknown;
    try {
      response = await invoke<unknown>('engine_analyze_page', {path,page,matches:[],sourceSha256,includeCropTemplate:true});
    } catch (cause) {
      throw new LocalEngineError('ENGINE_ANALYZE_FAILED', '读取页面版式失败。', {cause});
    }
    if (isEngineErrorResponse(response)) throw new LocalEngineError('ENGINE_REQUEST_REJECTED', engineErrorMessage(response), {engineCode:response.code});
    if (!isCropTemplatePage(response,page,sourceSha256)) throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '页面版式数据无效。');
    return response;
  },
  async health(): Promise<EngineHealth> {
    if (!isTauriRuntime()) {
      throw new LocalEngineError(
        'TAURI_UNAVAILABLE',
        '本地引擎需要在 Tauri 桌面应用中运行。',
      );
    }

    let response: unknown;
    try {
      response = await invoke<unknown>('engine_health');
    } catch (cause) {
      throw new LocalEngineError(
        'ENGINE_HEALTH_FAILED',
        '本地引擎健康检查失败。',
        { cause },
      );
    }

    if (!isEngineHealth(response)) {
      throw new LocalEngineError(
        'ENGINE_INVALID_RESPONSE',
        '本地引擎返回了无法识别的健康信息。',
      );
    }

    return response;
  },

  async search(path: string, keyword: string, exact = true): Promise<EngineSearchResult> {
    if (!isTauriRuntime()) {
      throw new LocalEngineError('TAURI_UNAVAILABLE', '本地引擎需要在 Tauri 桌面应用中运行。');
    }
    let response: unknown;
    try {
      response = await invoke<unknown>('engine_search', { path, keyword, exact });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '本地 PDF 搜索失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError(
        'ENGINE_REQUEST_REJECTED',
        engineErrorMessage(response),
        { engineCode: response.code },
      );
    }
    if (!isSearchResult(response)) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的搜索结果。');
    }
    return response;
  },

  async searchMulti(
    path: string,
    clauses: EngineSearchClause[],
    exact = true,
  ): Promise<EngineMultiSearchResult> {
    if (!isTauriRuntime()) {
      throw new LocalEngineError('TAURI_UNAVAILABLE', '本地引擎需要在 Tauri 桌面应用中运行。');
    }
    if (!Array.isArray(clauses) || clauses.length === 0) {
      throw new LocalEngineError('ENGINE_INVALID_REQUEST', '至少需要一个搜索关键词。');
    }
    let response: unknown;
    try {
      response = await invoke<unknown>('engine_search_multi', { path, queries: clauses, exact });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '本地 PDF 多关键词搜索失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError(
        'ENGINE_REQUEST_REJECTED',
        engineErrorMessage(response),
        { engineCode: response.code },
      );
    }
    if (!isEngineMultiSearchResult(response, clauses)) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的多关键词搜索结果。');
    }
    return response;
  },

  async inspectPdf(path: string): Promise<EnginePdfMetadata> {
    if (!isTauriRuntime()) {
      throw new LocalEngineError('TAURI_UNAVAILABLE', 'PDF 元数据读取需要在 Tauri 桌面应用中运行。');
    }
    let response: unknown;
    try {
      response = await invoke<unknown>('engine_inspect_pdf', { path });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '本地 PDF 元数据读取失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError(
        'ENGINE_REQUEST_REJECTED',
        engineErrorMessage(response),
        { engineCode: response.code },
      );
    }
    if (!isPdfMetadata(response)) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的 PDF 元数据。');
    }
    return response;
  },

  async renderPage(path: string, page: number, sourceSha256: string): Promise<EnginePagePreview> {
    assertSourceSha256(sourceSha256);
    if (!isTauriRuntime()) {
      throw new LocalEngineError('TAURI_UNAVAILABLE', 'PDF 预览需要在 Tauri 桌面应用中运行。');
    }
    let response: unknown;
    try {
      response = await invoke<unknown>('engine_render_page', { path, page, sourceSha256 });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', 'PDF 页面预览生成失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError(
        'ENGINE_REQUEST_REJECTED',
        engineErrorMessage(response),
        { engineCode: response.code },
      );
    }
    if (!isPagePreview(response)) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的页面预览。');
    }
    if (response.source_sha256 !== sourceSha256) {
      throw new LocalEngineError(
        'ENGINE_REQUEST_REJECTED',
        '源 PDF 已变化，请重新分析文件。',
        { engineCode: 'source_changed' },
      );
    }
    return response;
  },

  async analyzePage(path: string, page: number, matches: EngineRect[], sourceSha256: string): Promise<EnginePageAnalysis> {
    assertAnalyzeRequest(page, matches);
    assertSourceSha256(sourceSha256);
    if (!isTauriRuntime()) {
      throw new LocalEngineError('TAURI_UNAVAILABLE', 'PDF 页面分析需要在 Tauri 桌面应用中运行。');
    }
    let response: unknown;
    try {
      response = await invoke<unknown>('engine_analyze_page', {
        path,
        page,
        matches,
        sourceSha256,
      });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_ANALYZE_FAILED', '本地 PDF 页面分析调用失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError(
        'ENGINE_REQUEST_REJECTED',
        engineErrorMessage(response),
        { engineCode: response.code },
      );
    }
    if (!isPageAnalysis(response, page, matches) || response.source_sha256 !== sourceSha256) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的页面分析结果。');
    }
    return response;
  },

  async saveReviewSegments(taskId: string, segments: EngineReviewSegment[]): Promise<EngineReviewSegmentsSaveResult> {
    assertTaskId(taskId);
    if (!Array.isArray(segments) || !segments.every(isReviewSegment) || segments.some((segment) => segment.task_id !== taskId)) {
      throw new LocalEngineError('ENGINE_INVALID_REQUEST', '审核片段数据无效。');
    }
    let response: unknown;
    try {
      response = await invoke<unknown>('save_review_segments', { taskId, segments });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '审核片段保存失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError('ENGINE_REQUEST_REJECTED', engineErrorMessage(response), { engineCode: response.code });
    }
    if (!isReviewSegmentsSaveResult(response) || response.task_id !== taskId || response.saved_count !== segments.length) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的审核片段保存结果。');
    }
    return response;
  },

  async loadReviewSegments(taskId: string): Promise<EngineReviewSegmentsLoadResult> {
    assertTaskId(taskId);
    let response: unknown;
    try {
      response = await invoke<unknown>('load_review_segments', { taskId });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '审核片段加载失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError('ENGINE_REQUEST_REJECTED', engineErrorMessage(response), { engineCode: response.code });
    }
    if (!isReviewSegmentsLoadResult(response) || response.task_id !== taskId) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的审核片段加载结果。');
    }
    return response;
  },

  async computationInfo() {
    const response = await invokeReviewV2('engine_computation_info');
    if (!response || typeof response !== 'object' || (response as Record<string, unknown>).status !== 'ok'
      || !boundedReviewText((response as Record<string, unknown>).computation_version, 256)) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '无法读取当前计算版本。');
    }
    return response as { status: 'ok'; computation_version: string };
  },

  async prepareReviewContext(context, originals, resultRevision) {
    if (!validReviewContext(context) || !boundedReviewText(resultRevision, 128) || !validOriginalReviews(context, originals)) {
      throw new LocalEngineError('ENGINE_INVALID_REQUEST', '审核上下文或原始分析清单无效。');
    }
    const snapshot = structuredClone({ context, originals });
    const response = await invokeReviewV2('prepare_review_context_v2', { ...snapshot, resultRevision });
    return validatePreparedReviewResponse(response, snapshot.context, snapshot.originals, resultRevision);
  },

  async readReviewSnapshot(context, originals, resultRevision) {
    if (!validReviewContext(context, true) || !boundedReviewText(resultRevision, 128) || !validOriginalReviews(context, originals)) {
      throw new LocalEngineError('ENGINE_INVALID_REQUEST', '审核上下文或原始分析清单无效。');
    }
    const snapshot = structuredClone({ context, originals });
    const contextKey = await reviewContextDigest(snapshot.context);
    const response = await invokeReviewV2('read_review_snapshot_v2', { contextKey, resultRevision });
    return validatePreparedReviewResponse(response, snapshot.context, snapshot.originals, resultRevision);
  },

  async saveReviewSegmentsV2(contextKey, resultRevision, segments, confirmGroup = false) {
    if (!reviewDigest(contextKey) || !boundedReviewText(resultRevision, 128) || !Array.isArray(segments)
      || segments.length > 50_000 || typeof confirmGroup !== 'boolean'
      || !segments.every((item) => isReviewSegmentV2(item) && item.context_key === contextKey && item.result_revision === resultRevision
        && (confirmGroup ? item.review_status === 'group_confirmed' : item.review_status !== 'group_confirmed'))
      || new Set(segments.map(reviewKey)).size !== segments.length || new Set(segments.map((item) => item.id)).size !== segments.length) {
      throw new LocalEngineError('ENGINE_INVALID_REQUEST', '审核片段或预期修订无效。');
    }
    const snapshot = structuredClone(segments);
    const response = await invokeReviewV2('save_review_segments_v2', { contextKey, resultRevision, segments: snapshot, confirmGroup });
    const value = response as EngineSavedReviewV2 | null;
    const byKey = new Map(snapshot.map((item) => [reviewKey(item), item]));
    const seen = new Set<string>();
    if (!value || value.status !== 'ok' || value.context_key !== contextKey || value.result_revision !== resultRevision
      || value.saved_count !== snapshot.length || !Array.isArray(value.segments) || value.segments.length !== snapshot.length
      || !value.segments.every((record) => {
        if (!isReviewSegmentV2(record, 1)) return false;
        const key = reviewKey(record);
        const sent = byKey.get(key);
        if (!sent || seen.has(key) || record.record_revision !== sent.record_revision + 1 || !sameSavedDecision(record, sent)) return false;
        seen.add(key);
        return true;
      })) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '审核保存结果或记录修订不一致。');
    }
    return value;
  },

  async ocrHealth(verify = false): Promise<OcrHealth> {
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', '本地 OCR 运行时需要在 Tauri 桌面应用中运行。');
    let response: unknown;
    try {
      response = await invoke<unknown>('ocr_health', { verify });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', 'PaddleOCR 运行时检查失败。', { cause });
    }
    const normalized = normalizeOcrHealth(response);
    if (!normalized) throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的 OCR 状态。');
    return normalized;
  },

  async ocrCacheInfo(): Promise<OcrCacheInfo> {
    if (!isTauriRuntime()) {
      throw new LocalEngineError('TAURI_UNAVAILABLE', '读取 OCR 缓存占用需要在 Tauri 桌面应用中运行。');
    }
    let response: unknown;
    try {
      response = await invoke<unknown>('ocr_cache_info');
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '读取 OCR 缓存占用失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError(
        'ENGINE_REQUEST_REJECTED',
        engineErrorMessage(response),
        { engineCode: response.code },
      );
    }
    const normalized = normalizeOcrCacheInfo(response);
    if (!normalized) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的 OCR 缓存占用。');
    }
    return normalized;
  },

  async ocrCacheClear(): Promise<OcrCacheClearResult> {
    if (!isTauriRuntime()) {
      throw new LocalEngineError('TAURI_UNAVAILABLE', '清除 OCR 缓存需要在 Tauri 桌面应用中运行。');
    }
    let response: unknown;
    try {
      response = await invoke<unknown>('ocr_cache_clear');
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '清除 OCR 缓存失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError(
        'ENGINE_REQUEST_REJECTED',
        engineErrorMessage(response),
        { engineCode: response.code },
      );
    }
    const normalized = normalizeOcrCacheClear(response);
    if (!normalized) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的 OCR 缓存清理结果。');
    }
    return normalized;
  },

  async exportIndex(outputPath: string, rows: Record<string, unknown>[], exportToken: string): Promise<EngineExportResult> {
    assertExportToken(exportToken);
    if (typeof outputPath !== 'string' || !/\.xlsx$/i.test(outputPath.trim())) {
      throw new LocalEngineError('ENGINE_INVALID_REQUEST', 'XLSX 输出路径必须是 .xlsx 文件。');
    }
    if (!Array.isArray(rows) || !rows.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))) {
      throw new LocalEngineError('ENGINE_INVALID_REQUEST', 'XLSX 导出内容无效。');
    }
    if (!isTauriRuntime()) {
      throw new LocalEngineError('TAURI_UNAVAILABLE', '索引导出需要在 Tauri 桌面应用中运行。');
    }
    let response: unknown;
    try {
      response = await invoke<unknown>('engine_export_index', { outputPath, rows, exportToken });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', 'XLSX 索引导出失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError('ENGINE_REQUEST_REJECTED', engineErrorMessage(response), { engineCode: response.code });
    }
    if (!isExportResult(response)) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的导出结果。');
    }
    if (!sameExportPath(response.output_path, outputPath)) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回的 XLSX 路径与请求路径不一致。');
    }
    if (response.row_count !== rows.length) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回的 XLSX 行数与请求内容不一致。');
    }
    return response;
  },

  async exportPdf(outputPath: string, selections: EnginePdfExportSelection[], exportToken: string): Promise<EnginePdfExportResult> {
    assertExportToken(exportToken);
    assertPdfExportRequest(outputPath, selections);
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', 'PDF 导出需要在 Tauri 桌面应用中运行。');
    let response: unknown;
    try {
      response = await invoke<unknown>('engine_export_pdf', { outputPath, selections, exportToken });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', 'PDF 结果导出失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError('ENGINE_REQUEST_REJECTED', engineErrorMessage(response), { engineCode: response.code });
    }
    if (!isPdfExportResult(response)) throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的 PDF 导出结果。');
    if (!sameExportPath(response.output_path, outputPath)) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回的 PDF 路径与请求路径不一致。');
    }
    return response;
  },

  async createExportPreviewPath(exportToken: string, batchJobId?: string): Promise<string> {
    assertExportToken(exportToken);
    if (batchJobId !== undefined && (!batchJobId.trim() || batchJobId.length > 128 || batchJobId.includes('\0'))) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '任务标识无效，无法创建预览。');
    }
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', 'PDF 导出预览需要在 Tauri 桌面应用中运行。');
    try {
      const path = await invoke<string>('create_export_preview_path', {
        exportToken, ...(batchJobId === undefined ? {} : { batchJobId }),
      });
      if (typeof path !== 'string' || !/\.pdf$/i.test(path.trim())) {
        throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地应用返回了无效的 PDF 预览路径。');
      }
      return path;
    } catch (cause) {
      if (cause instanceof LocalEngineError) throw cause;
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '无法创建 PDF 导出预览路径。', { cause });
    }
  },

  async publishPreviewPdf(
    previewPath: string,
    outputPath: string,
    previewToken: string,
    finalToken: string,
  ): Promise<EnginePublishPreviewResult> {
    assertExportToken(previewToken);
    assertExportToken(finalToken);
    if (previewToken === finalToken) {
      throw new LocalEngineError('ENGINE_INVALID_REQUEST', '预览与最终导出请求标识不能相同。');
    }
    if (typeof previewPath !== 'string' || !/\.pdf$/i.test(previewPath.trim())
      || typeof outputPath !== 'string' || !/\.pdf$/i.test(outputPath.trim())) {
      throw new LocalEngineError('ENGINE_INVALID_REQUEST', 'PDF 预览和输出路径必须是 .pdf 文件。');
    }
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', 'PDF 预览发布需要在 Tauri 桌面应用中运行。');
    let response: unknown;
    try {
      response = await invoke<unknown>('engine_publish_preview_pdf', {
        previewPath,
        outputPath,
        previewToken,
        finalToken,
      });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', 'PDF 预览发布失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError('ENGINE_REQUEST_REJECTED', engineErrorMessage(response), { engineCode: response.code });
    }
    if (!isPublishPreviewResult(response)) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的 PDF 发布结果。');
    }
    if (!sameExportPath(response.output_path, outputPath)) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回的 PDF 发布路径与请求路径不一致。');
    }
    return response;
  },

  async cleanupExports(exportToken: string): Promise<EngineCleanupResult> {
    assertExportToken(exportToken);
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', '清理导出文件需要在 Tauri 桌面应用中运行。');
    let response: unknown;
    try {
      response = await invoke<unknown>('engine_cleanup_exports', { exportToken });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '导出文件清理失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError('ENGINE_REQUEST_REJECTED', engineErrorMessage(response), { engineCode: response.code });
    }
    if (!isCleanupResult(response)) throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的清理结果。');
    return response;
  },

  async releaseExports(exportToken: string): Promise<EngineReleaseResult> {
    assertExportToken(exportToken);
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', '释放导出登记需要在 Tauri 桌面应用中运行。');
    let response: unknown;
    try {
      response = await invoke<unknown>('engine_release_exports', { exportToken });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '释放导出登记失败。', { cause });
    }
    if (isEngineErrorResponse(response)) {
      throw new LocalEngineError('ENGINE_REQUEST_REJECTED', engineErrorMessage(response), { engineCode: response.code });
    }
    if (!isReleaseResult(response)) throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地引擎返回了无法识别的释放结果。');
    return response;
  },

  async pickPdfFiles(initialDirectory?: string | null): Promise<PdfPickerResult> {
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', '文件选择需要在 Tauri 桌面应用中运行。');
    let response: unknown;
    try {
      response = await invoke<unknown>('pick_pdf_files', {
        initialDirectory: initialDirectory ?? null,
      });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '无法打开 PDF 文件选择器。', { cause });
    }
    if (!isPdfPickerResult(response)) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地应用返回了无效的 PDF 文件选择结果。');
    }
    return response;
  },

  async pickPdfFolder(initialDirectory?: string | null): Promise<PdfPickerResult> {
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', '文件夹选择需要在 Tauri 桌面应用中运行。');
    let response: unknown;
    try {
      response = await invoke<unknown>('pick_pdf_folder', {
        initialDirectory: initialDirectory ?? null,
      });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '无法打开文件夹选择器。', { cause });
    }
    if (!isPdfPickerResult(response)) {
      throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地应用返回了无效的 PDF 文件夹选择结果。');
    }
    return response;
  },

  async pickDirectory(initialDirectory?: string | null): Promise<string | null> {
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', '目录选择需要在 Tauri 桌面应用中运行。');
    try {
      const path = await invoke<unknown>('pick_directory', {
        initialDirectory: initialDirectory ?? null,
      });
      if (path !== null && (typeof path !== 'string' || !path.trim())) {
        throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地应用返回了无效的目录。');
      }
      return path;
    } catch (cause) {
      if (cause instanceof LocalEngineError) throw cause;
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '无法打开目录选择器。', { cause });
    }
  },

  async validateDirectory(path: string): Promise<boolean> {
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', '目录校验需要在 Tauri 桌面应用中运行。');
    try {
      const result = await invoke<unknown>('validate_directory', { path });
      if (typeof result !== 'boolean') {
        throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地应用返回了无效的目录校验结果。');
      }
      return result;
    } catch (cause) {
      if (cause instanceof LocalEngineError) throw cause;
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '目录校验失败。', { cause });
    }
  },

  async pickOutputFolder(initialDirectory?: string | null): Promise<string | null> {
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', '输出目录选择需要在 Tauri 桌面应用中运行。');
    try {
      const path = await invoke<unknown>('pick_output_folder', {
        initialDirectory: initialDirectory ?? null,
      });
      if (path !== null && (typeof path !== 'string' || !path.trim())) {
        throw new LocalEngineError('ENGINE_INVALID_RESPONSE', '本地应用返回了无效的输出目录。');
      }
      return path;
    } catch (cause) {
      if (cause instanceof LocalEngineError) throw cause;
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '无法打开输出目录选择器。', { cause });
    }
  },

  async openOutputFolder(path: string): Promise<void> {
    if (!isTauriRuntime()) throw new LocalEngineError('TAURI_UNAVAILABLE', '打开输出目录需要在 Tauri 桌面应用中运行。');
    try {
      await invoke('open_output_folder', { path });
    } catch (cause) {
      throw new LocalEngineError('ENGINE_HEALTH_FAILED', '无法打开输出目录。', { cause });
    }
  },
};
