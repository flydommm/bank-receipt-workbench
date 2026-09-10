import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { EngineProcessScheduler, type EngineTaskPriority } from './services/engineProcessScheduler';

import {
  localEngineAdapter,
  LocalEngineError,
  sameExportPath,
  type EngineMatch,
  type EngineMultiSearchResult,
  type EngineSearchClause,
  type EnginePageAnalysis,
  type EnginePagePreview,
  type EnginePdfExportSelection,
  type EngineRect,
  type EngineReviewSegment,
  type EngineSearchResult,
  type OcrCacheClearResult,
  type OcrCacheInfo,
  type OcrHealth,
  type OcrHealthCode,
  type OcrReadiness,
} from './components/localEngineAdapter';
import type { SourceFile, SearchMode } from './domain/sourceFiles';
import { ExportPdfPreview } from './components/ExportPdfPreview';
import { ExportScopeSettings } from './components/ExportScopeSettings';
import { resolveExportScope, type ExportScopeSelection, type ExportOutputMode } from './domain/exportIntent';
import { defaultExportName, normalizeExportName, validateExportName } from './domain/exportNaming';
import { ExportBundleClient, ExportBundleError, parseExportBundleReceipt, type ExportBundlePreview,
  type ExportBundleReceipt } from './services/exportBundleClient';
import ResizableWorkspace from './components/ResizableWorkspace';
import ReviewActionCard, { type ActionFeedback } from './components/ReviewActionCard';
import { ReviewOperationTools } from './components/ReviewOperationTools';
import { BatchCropDialog } from './components/BatchCropDialog';
import { batchSampleError, type BatchCropPlan } from './domain/batchCrop';
import { prepareBatchCrop, StaleBatchCropError } from './services/prepareBatchCrop';
import { ReviewOperationHistory, type ReviewDecisionSnapshot, type ReviewOperationKind } from './domain/reviewOperations';
import { deriveReviewResultView } from './domain/reviewResultView';
import ReviewNavigator, { type ReviewNavigatorRow } from './components/ReviewNavigator';
import type { ReviewResultSort, ReviewResultSource } from './domain/reviewResultView';
import SettingsDialog from './components/SettingsDialog';
import { HelpCenterDialog, type HelpCenterOcrState } from './components/HelpCenterDialog';
import { APP_NAME, APP_SUBTITLE } from './domain/appIdentity';
import SourceDocumentPreview from './components/SourceDocumentPreview';
import SourcePanel from './components/SourcePanel';
import { TaskHistoryPanel } from './components/TaskHistoryPanel';
import { TaskCleanupPanel } from './components/TaskCleanupPanel';
import type { BatchCleanup, BatchStorageUsage } from './domain/batchCleanup';
import { PersistentBatchController, batchIsActive } from './services/persistentBatchController';
import type { BatchJobSnapshot, BatchResponse } from './domain/batchTask';
import { mapBatchReview } from './domain/batchReview';
import {
  batchFeedbackReducer,
  createBatchFailure,
  type BatchFailure,
  type BatchObserver,
  type BatchStage,
} from './domain/batchFeedback';
import {
  canConfirmGroup,
  filterSegments,
  normalizePdfRect,
  type PdfRect,
  type ReviewSegment,
  type ReviewFilter,
  type ReviewStatus,
} from './domain/cropReview';
import {
  appendUniqueSources,
  analysisStateReducer,
  buildSourceDocuments,
  normalizeSourcePath,
  removeSourceIdentities,
  sourceDocumentKey,
  type SourceDocument,
  type SearchSource,
} from './domain/sourcePreview';
import {
  validateReviewSetIntegrity,
  validateSourceDocumentIntegrity,
} from './domain/reviewSetIntegrity';
import { buildOriginalReviewContext } from './domain/reviewContext';
import { applyLegacyReviewSuggestion, legacyReviewSuggestions, mergeCompatibleReviews } from './domain/reviewHistory';
import { ReviewSessionCoordinator, StaleReviewSessionError, type ReviewSession } from './services/reviewSessionCoordinator';
import { freezeBatchExecutionContext, type BatchExecutionContext } from './domain/batchExecution';
import { BatchAnalysisRunner, BatchRunSupersededError } from './services/batchAnalysisRunner';
import { useSourcePreviewNavigation, type PreviewViewSnapshot } from './hooks/useSourcePreviewNavigation';
import SearchCriteriaPanel from './components/SearchCriteriaPanel';
import {
  legacyCriteria,
  normalizeSearchCriteria,
  searchCriteriaClauses,
  searchCriteriaSummary,
  serializeSearchCriteria,
  type SearchCriteria,
} from './domain/searchCriteria';
import {
  candidateSatisfiesCriteria,
  groupTaggedHitsByCandidate,
  type TaggedReceiptHit,
} from './domain/receiptMatchGrouping';
import {
  DEFAULT_APP_SETTINGS,
  readAppSettings,
  writeAppSettings,
  clearAppSettings,
  type AppSettingsV1,
} from './domain/appSettings';
import {
  clearSearchKeywordHistory,
  loadSearchKeywordHistory,
  recordSearchKeywordHistory,
  removeSearchKeywordHistory,
  type SearchKeywordHistory,
  type SearchKeywordHistoryRole,
} from './domain/searchKeywordHistory';

type PickerMode = 'file' | 'folder';
type DirectorySetting = 'lastInputDirectory' | 'lastOutputDirectory';
type EngineStatus = 'checking' | 'ready' | 'unavailable';
type OcrState = HelpCenterOcrState;
type PreviewValidationStatus = 'pending' | 'valid' | 'invalid';
export type PreviewInvalidReason = 'page' | 'page_count' | 'dimensions' | 'geometry';

const OCR_INITIAL_STATE: OcrState = {
  readiness: 'unknown',
  message: 'OCR 尚未检测。',
};

function isOcrHealthCode(value: unknown): value is OcrHealthCode {
  return value === 'ocr_initialization_failed'
    || value === 'ocr_inference_failed'
    || value === 'ocr_result_invalid';
}

function ocrStateFromHealth(result: OcrHealth, verified: boolean): OcrState {
  if (result.readiness === 'failed') {
    return { readiness: 'failed', message: result.message, ...(result.code ? { code: result.code } : {}) };
  }
  if (!result.available || result.readiness === 'unavailable') {
    return { readiness: 'unavailable', message: result.message };
  }
  // Import-only startup checks never establish that inference works, even if
  // an older host accidentally reports `ready` for verify=false.
  if (!verified) return { readiness: 'installed', message: result.message };
  if (result.readiness === 'ready') return { readiness: 'ready', message: result.message };
  if (result.readiness === 'installed') return { readiness: 'installed', message: result.message };
  return { readiness: 'failed', message: 'OCR 检测返回了无法识别的状态。' };
}

function ocrStateFromHealthError(error: unknown): OcrState {
  const code = error instanceof LocalEngineError && isOcrHealthCode(error.engineCode)
    ? error.engineCode
    : undefined;
  return {
    readiness: 'failed',
    message: 'OCR 检测失败，请重试。',
    ...(code ? { code } : {}),
  };
}

function ocrStateFromTaskCode(code: unknown): OcrState | null {
  if (code === 'ocr_unavailable') {
    return { readiness: 'unavailable', message: '当前任务需要 OCR，但 OCR 运行时不可用。' };
  }
  if (isOcrHealthCode(code)) {
    return { readiness: 'failed', message: '当前任务的 OCR 识别验证失败。', code };
  }
  return null;
}

function ocrStateFromTaskError(error: unknown): OcrState | null {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>).code;
  return ocrStateFromTaskCode(code);
}

function ocrStateFromCurrentTask(job: BatchJobSnapshot | null): OcrState | null {
  if (!job) return null;
  const jobIssue = ocrStateFromTaskError(job.error);
  if (jobIssue) return jobIssue;
  for (const source of job.sources) {
    const sourceIssue = ocrStateFromTaskError(source.error);
    if (sourceIssue) return sourceIssue;
  }
  return null;
}

function ocrStateFromBatchFeedback(feedback: ReturnType<typeof batchFeedbackReducer>): OcrState | null {
  if (!feedback) return null;
  for (const failure of feedback.failures) {
    const issue = ocrStateFromTaskCode(failure.code);
    if (issue) return issue;
  }
  return null;
}

function ocrReadinessLabel(state: OcrState): string {
  if (state.readiness === 'installed') return '已安装，待验证';
  if (state.readiness === 'verifying') return '验证中';
  if (state.readiness === 'ready') return '已验证可用';
  if (state.readiness === 'unavailable') return '不可用';
  if (state.readiness === 'failed') return '验证失败';
  return '状态未知';
}

type SourceMatch = EngineMatch & {
  source_path: string;
  source_sha256: string;
  source_identity: string;
  page_count: number;
  query_id?: string;
  role?: 'include' | 'exclude';
};

type SearchSettings = {
  criteria: SearchCriteria;
  matchMode: SearchMode;
};

type AppliedSearch = SearchSettings & {
  taskId: string;
};

type RawSourceSearch = EngineSearchResult | EngineMultiSearchResult;
type RawSourcePages = Array<{ page: number; analysis: EnginePageAnalysis }>;
type AnalysisAccess = {
  read: (path: string, page: number, matches: EngineRect[], sha: string) => Promise<EnginePageAnalysis>;
  cached?: boolean;
};
type BatchRunBinding = {
  taskId: string;
  observe: BatchObserver;
  rememberDocument: (sourcePath: string, result: RawSourceSearch) => void;
};
type RetryState = { context: BatchExecutionContext; count: number; notice: string };

class BatchAssemblyError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : typeof error === 'string' ? error : '整理审核结果失败。');
    this.name = 'BatchAssemblyError';
  }
}

type SearchResultCommit = {
  appliedSearch: AppliedSearch;
  reviewSession: ReviewSession;
  legacySuggestions: Record<string, EngineReviewSegment>;
  documents: SourceDocument[];
  engineMatches: SourceMatch[];
  evidenceById: Record<string, SourceMatch[]>;
  reviewSegments: ReviewSegment[];
  automaticReviewSegments?: ReviewSegment[];
  sourceGeometryById: Record<string, SourceGeometry>;
  selectedId: string | null;
  groupConfirmed: boolean;
  failedGroups: number;
  invalidInputs: number;
};

export type SourceGeometry = {
  matchValid: boolean;
  pageValid: boolean;
  pageCount: number;
  dimensionsMatch: boolean;
  pageCountMatch: boolean;
  previewStatus: PreviewValidationStatus;
  previewError?: string;
};

function sourcePathForFile(file: SourceFile): string {
  return file.path ?? file.relativePath ?? file.name;
}

function sourceSelectionForFile(file: SourceFile): SearchSource {
  return {
    name: file.name,
    sourcePath: sourcePathForFile(file),
  };
}

function materializeSourceFiles(
  sources: readonly SearchSource[],
  candidates: readonly SourceFile[],
): SourceFile[] {
  const candidatesByIdentity = new Map<string, SourceFile>();
  for (const file of candidates) {
    const identity = normalizeSourcePath(sourcePathForFile(file));
    if (!candidatesByIdentity.has(identity)) candidatesByIdentity.set(identity, file);
  }
  return sources.map((source) => candidatesByIdentity.get(normalizeSourcePath(source.sourcePath)) ?? ({
    name: source.name,
    relativePath: source.sourcePath,
    path: source.sourcePath,
    size: 0,
  }));
}

type IndexedMatch = {
  match: SourceMatch;
  inputIndex: number;
  segmentNo: number;
  sourceGeometry: SourceGeometry;
};

type AnalysisGroup = {
  sourcePath: string;
  sourceSha256: string;
  page: number;
  sourceIdentity: string;
  matches: IndexedMatch[];
};

type AnalysisBuildResult = {
  segments: ReviewSegment[];
  representativeMatches: SourceMatch[];
  evidenceById: Record<string, SourceMatch[]>;
  failedGroups: number;
  invalidInputs: number;
  geometryById: Record<string, SourceGeometry>;
};

type ExportSourceSnapshot = {
  sourcePath: string;
  sourceSha256: string;
};

type ExportOutputPaths = {
  index: string;
  pdf: string;
};

type ExportPreviewSnapshot = {
  taskId: string;
  reviewRevision: number;
  sourceIntegrityRevision: number;
  previewToken: string;
  previewPath: string;
  previewSha256: string;
  pageCount: number;
  reviewFingerprint: string;
  sources: ExportSourceSnapshot[];
  bundle: ExportBundlePreview;
};

type ReviewViewSnapshot = {
  navigation: PreviewViewSnapshot;
  selectedId: string | null;
  reviewFilter: ReviewFilter;
  reviewSourceFilter: string | null;
  reviewSortOrder: ReviewResultSort;
};

type ExportResult = {
  directory: string;
  indexPath: string | null;
  pdfPath: string;
  rowCount: number | null;
  pageCount: number;
  pdfCount: number;
};

const UNKNOWN_PAGE_WIDTH = Number.NaN;
const UNKNOWN_PAGE_HEIGHT = Number.NaN;
const MAX_ANALYSIS_CONCURRENCY = 3;
const PREVIEW_PAGE_MISMATCH = '页面预览页码不匹配，已拒绝显示。';
const PREVIEW_PAGE_COUNT_MISMATCH = '页面预览页数与搜索结果不一致，已阻止确认。';
const PREVIEW_DIMENSIONS_MISMATCH = '页面尺寸与分析结果不一致，已阻止确认。';
const PREVIEW_GEOMETRY_MISSING = '当前片段校验信息缺失，已显示原页预览；请重新分析。';
const PREVIEW_PENDING = '真实页面预览尚未校验，不能确认或裁剪。';

function createInitialSearchSettings(settings: AppSettingsV1): SearchSettings {
  return {
    criteria: {
      include: ['手续费'],
      includeMode: settings.defaultIncludeMode,
      exclude: [],
    },
    matchMode: settings.defaultMatchMode,
  };
}

function cloneSearchSettings(value: SearchSettings): SearchSettings {
  return {
    criteria: {
      include: [...value.criteria.include],
      includeMode: value.criteria.includeMode,
      exclude: [...value.criteria.exclude],
    },
    matchMode: value.matchMode,
  };
}

export type DocumentPreviewValidation =
  | { ok: true }
  | { ok: false; kind: 'page_mismatch' | 'page_count_mismatch'; message: string };

export function validateDocumentPreview(
  preview: EnginePagePreview,
  document: SourceDocument,
  requestedPage: number,
): DocumentPreviewValidation {
  if (!Number.isInteger(preview.page) || preview.page !== requestedPage) {
    return { ok: false, kind: 'page_mismatch', message: PREVIEW_PAGE_MISMATCH };
  }
  if (!Number.isInteger(preview.page_count) || preview.page_count !== document.pageCount) {
    return { ok: false, kind: 'page_count_mismatch', message: PREVIEW_PAGE_COUNT_MISMATCH };
  }
  return { ok: true };
}

class StaleRunError extends Error {
  constructor() {
    super('stale run');
    this.name = 'StaleRunError';
  }
}

export class SourceChangedDuringOperation extends Error {
  readonly sourcePath: string;
  readonly sourceChanges: readonly { sourcePath: string; message: string }[];

  constructor(
    sourcePath: string,
    message: string,
    sourceChanges: readonly { sourcePath: string; message: string }[] = [{ sourcePath, message }],
  ) {
    super(message);
    this.name = 'SourceChangedDuringOperation';
    this.sourcePath = sourcePath;
    this.sourceChanges = [...sourceChanges];
  }
}

export function isSourceChangedError(error: unknown): error is LocalEngineError {
  return error instanceof LocalEngineError
    && error.code === 'ENGINE_REQUEST_REJECTED'
    && error.engineCode === 'source_changed';
}

const engineProcessSemaphore = new EngineProcessScheduler(
  MAX_ANALYSIS_CONCURRENCY,
  () => new StaleRunError(),
);

function withoutExtension(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

function asFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function matchRect(match: EngineMatch): PdfRect {
  const x0 = asFinite(match.x0, Number.NaN);
  const y0 = asFinite(match.y0, Number.NaN);
  const x1 = asFinite(match.x1, Number.NaN);
  const y1 = asFinite(match.y1, Number.NaN);
  return { x0, y0, x1, y1 };
}

function engineRect(rect: PdfRect | null): EngineRect | null {
  return rect ? { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 } : null;
}

function sameRect(left: PdfRect, right: PdfRect): boolean {
  return left.x0 === right.x0 && left.y0 === right.y0
    && left.x1 === right.x1 && left.y1 === right.y1;
}

function normalizeSourceIdentity(path: string): string {
  return normalizeSourcePath(path);
}

function exportSourcesFor(segments: ReviewSegment[]): ExportSourceSnapshot[] {
  const entries = new Map<string, ExportSourceSnapshot>();
  for (const segment of segments) {
    const key = `${segment.sourcePath}\u0000${segment.sourceSha256}`;
    entries.set(key, { sourcePath: segment.sourcePath, sourceSha256: segment.sourceSha256 });
  }
  return [...entries.values()].sort((left, right) => (
    left.sourcePath.localeCompare(right.sourcePath)
    || left.sourceSha256.localeCompare(right.sourceSha256)
  ));
}

function sameExportSources(left: ExportSourceSnapshot[], right: ExportSourceSnapshot[]): boolean {
  return left.length === right.length
    && left.every((source, index) => source.sourcePath === right[index]?.sourcePath
      && source.sourceSha256 === right[index]?.sourceSha256);
}

function exportPathsForDirectory(directory: string, sourcePath: string, nonce = ''): ExportOutputPaths {
  const suffix = nonce ? `-${nonce}` : '';
  const separator = directory.includes('\\') ? '\\' : '/';
  const baseName = withoutExtension(sourcePath.split(/[\\/]/).pop() ?? 'pdf-search-results');
  const cleanDirectory = directory.replace(/[\\/]+$/, '');
  return {
    index: `${cleanDirectory}${separator}${baseName}.pdf-search-index${suffix}.xlsx`,
    pdf: `${cleanDirectory}${separator}${baseName}.pdf-search-results${suffix}.pdf`,
  };
}

function reviewExportFingerprint(segments: ReviewSegment[]): string {
  const payload = segments.map((segment) => ({
    id: segment.id,
    sourceKey: segment.sourceKey,
    sourcePath: segment.sourcePath,
    sourceSha256: segment.sourceSha256,
    sourcePage: segment.sourcePage,
    segmentNo: segment.segmentNo,
    finalRect: segment.finalRect,
    mode: segment.mode,
    reviewStatus: segment.reviewStatus,
  }));
  return stableIdentityDigest(JSON.stringify(payload));
}

/** Preview/file management share physical access files; task history retains every logical source. */
function persistentSourceFiles(job: BatchJobSnapshot): SourceFile[] {
  const files = new Map<string, SourceFile>();
  for (const source of job.sources) {
    const key = normalizeSourcePath(source.access_path);
    if (!files.has(key)) files.set(key, { name: source.name, path: source.access_path,
      relativePath: source.access_path, size: source.size_bytes ?? 0 });
  }
  return [...files.values()];
}

function exportMatchKey(sourcePath: string, page: number, segmentNo: number): string {
  return `${sourcePath}\u0000${page}\u0000${segmentNo}`;
}

type ReviewMatchPair = {
  hit: EngineMatch;
  segment: ReviewSegment;
};

type ReviewPairingResult = {
  pairs: ReviewMatchPair[];
  error: string | null;
};

type ExportEvidenceMatch = EngineMatch & {
  query_id?: string;
  role?: 'include' | 'exclude';
};

function reviewPairingKey(sourcePath: string, page: number, segmentNo: number): string {
  return `${normalizeSourcePath(sourcePath)}\u0000${page}\u0000${segmentNo}`;
}

/**
 * Pair search hits with their review segments using the source/page/segment
 * identity assigned during analysis.  The array positions are deliberately
 * not used here: a response can be regrouped by page or source before it
 * reaches the navigator, and showing the text from a neighbouring hit would
 * be much worse than temporarily blocking the list.
 */
export function buildReviewMatchPairs(
  engineMatches: readonly EngineMatch[],
  reviewSegments: readonly ReviewSegment[],
): ReviewPairingResult {
  if (engineMatches.length !== reviewSegments.length) {
    return {
      pairs: [],
      error: `${engineMatches.length} 个引擎命中，${reviewSegments.length} 个审核片段，数量无法配对。`,
    };
  }

  const matchesByKey = new Map<string, EngineMatch>();
  const segmentNoByPage = new Map<string, number>();
  for (const hit of engineMatches) {
    const sourcePath = typeof hit.source_path === 'string' ? hit.source_path : '';
    const page = hit.page;
    if (!normalizeSourcePath(sourcePath) || !Number.isSafeInteger(page) || page <= 0) {
      return { pairs: [], error: '命中结果缺少有效的来源路径或页码，无法安全配对。' };
    }
    const logicalSource = hit.source_key ?? normalizeSourcePath(sourcePath);
    const pageKey = `${logicalSource}\u0000${page}`;
    const segmentNo = (segmentNoByPage.get(pageKey) ?? 0) + 1;
    segmentNoByPage.set(pageKey, segmentNo);
    const key = reviewPairingKey(logicalSource, page, segmentNo);
    if (matchesByKey.has(key)) {
      return { pairs: [], error: '引擎命中存在重复的来源页片段身份，无法安全配对。' };
    }
    matchesByKey.set(key, hit);
  }

  const segmentsByKey = new Map<string, ReviewSegment>();
  for (const segment of reviewSegments) {
    const sourcePath = segment.sourcePath;
    if (!normalizeSourcePath(sourcePath)
      || !Number.isSafeInteger(segment.sourcePage)
      || segment.sourcePage <= 0
      || !Number.isSafeInteger(segment.segmentNo)
      || segment.segmentNo <= 0) {
      return { pairs: [], error: '审核片段缺少有效的来源路径、页码或片段序号，无法安全配对。' };
    }
    const key = reviewPairingKey(segment.sourceKey ?? sourcePath, segment.sourcePage, segment.segmentNo);
    if (segmentsByKey.has(key)) {
      return { pairs: [], error: '审核片段存在重复的来源页片段身份，无法安全配对。' };
    }
    segmentsByKey.set(key, segment);
  }

  const pairs: ReviewMatchPair[] = [];
  for (const segment of reviewSegments) {
    const key = reviewPairingKey(segment.sourceKey ?? segment.sourcePath, segment.sourcePage, segment.segmentNo);
    const hit = matchesByKey.get(key);
    if (!hit || normalizeSourcePath(hit.source_path ?? '') !== normalizeSourcePath(segment.sourcePath)
      || hit.source_key !== segment.sourceKey) {
      return { pairs: [], error: '命中结果与审核片段的来源页片段身份不一致，已阻止显示。' };
    }
    if (
      typeof hit.source_sha256 === 'string'
      && hit.source_sha256.trim().length > 0
      && typeof segment.sourceSha256 === 'string'
      && hit.source_sha256.toLowerCase() !== segment.sourceSha256.toLowerCase()
    ) {
      return { pairs: [], error: '命中结果与审核片段的来源 SHA-256 不一致，已阻止显示。' };
    }
    // A page can contain multiple hits with the same source/page/SHA.  The
    // occurrence number alone cannot tell those hits apart, so also compare
    // the immutable OCR rectangle captured on the segment.  If the engine
    // reordered or substituted a hit, block the whole list instead of showing
    // text beside the wrong crop.
    const hitRect = matchRect(hit);
    const hitRectValid = isValidMatchRect(hitRect);
    const segmentRectValid = isValidMatchRect(segment.matchRect);
    if (hitRectValid !== segmentRectValid || (hitRectValid && !sameRect(hitRect, segment.matchRect))) {
      return { pairs: [], error: '命中结果与审核片段的定位区域不一致，已阻止显示。' };
    }
    pairs.push({ hit, segment });
  }

  if (segmentsByKey.size !== matchesByKey.size) {
    return { pairs: [], error: '命中结果与审核片段的来源页片段身份不一致，已阻止显示。' };
  }

  return { pairs, error: null };
}

export function buildExportPayloadForReviewSegments(
  reviewSegments: ReviewSegment[],
  engineMatches: ExportEvidenceMatch[],
  query: string,
  evidenceById: Record<string, ExportEvidenceMatch[]> = {},
  criteria?: SearchCriteria,
): {
  selections: EnginePdfExportSelection[];
  rowSeed: Record<string, unknown>[];
} {
  const matchesByKey = new Map<string, ExportEvidenceMatch>();
  const nextSegmentNoByPage = new Map<string, number>();
  for (const match of engineMatches) {
    const sourcePath = match.source_key ?? match.source_path ?? '';
    const pageKey = `${sourcePath}\u0000${match.page}`;
    const segmentNo = (nextSegmentNoByPage.get(pageKey) ?? 0) + 1;
    nextSegmentNoByPage.set(pageKey, segmentNo);
    matchesByKey.set(exportMatchKey(sourcePath, match.page, segmentNo), match);
  }

  const rowSeed = reviewSegments.map((segment) => {
    const match = matchesByKey.get(exportMatchKey(segment.sourceKey ?? segment.sourcePath, segment.sourcePage, segment.segmentNo));
    const evidence = evidenceById[segment.id] ?? (match ? [match] : []);
    const includedEvidence = evidence.filter((item) => item.role !== 'exclude');
    const matchedFields = [...new Set(includedEvidence
      .map((item) => item.matched_field ?? '')
      .map((value) => value.trim())
      .filter(Boolean))];
    const matchedTexts = [...new Set(includedEvidence
      .map((item) => item.matched_text)
      .map((value) => value.trim())
      .filter(Boolean))];
    const matchedQueryIds = new Set(includedEvidence
      .map((item) => item.query_id)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0));
    const matchedKeywords = criteria
      ? criteria.include.filter((_keyword, index) => matchedQueryIds.has(`include-${index}`))
      : [];
    const effectiveKeywords = matchedKeywords.length > 0
      ? matchedKeywords
      : criteria
        ? (criteria.include.length === 1 ? criteria.include : [])
        : (query.trim() ? [query.trim()] : []);
    const cropRect = segment.mode === 'full_page'
      ? { x0: 0, y0: 0, x1: segment.pageWidth, y1: segment.pageHeight }
      : segment.finalRect;
    return {
      source_file: segment.sourceName ?? segment.sourcePath.split(/[\\/]/).pop() ?? segment.sourcePath,
      source_sha256: segment.sourceSha256,
      source_page: segment.sourcePage,
      segment_no: segment.segmentNo,
      query,
      matched_field: matchedFields.join('、') || (match?.matched_field ?? ''),
      matched_keywords: effectiveKeywords.join('、'),
      matched_text: matchedTexts.join('、') || (match?.role === 'exclude' ? '' : match?.matched_text ?? ''),
      crop_x0: cropRect?.x0 ?? null,
      crop_y0: cropRect?.y0 ?? null,
      crop_x1: cropRect?.x1 ?? null,
      crop_y1: cropRect?.y1 ?? null,
      crop_mode: segment.mode,
      review_status: segment.reviewStatus,
      confidence: segment.confidence,
      processed_at: new Date().toISOString(),
    };
  });

  const bySource = new Map<string, ReviewSegment[]>();
  for (const segment of reviewSegments) {
    const sourceSegments = bySource.get(segment.sourceKey ?? segment.sourcePath) ?? [];
    sourceSegments.push(segment);
    bySource.set(segment.sourceKey ?? segment.sourcePath, sourceSegments);
  }
  const selections = [...bySource.entries()].map(([path, segments]) => {
    const fullPageKeys = new Set<string>();
    const exportSegments: EnginePdfExportSelection['segments'] = [];
    for (const segment of segments) {
      if (segment.mode === 'full_page') {
        const fullPageKey = `${path}\u0000${segment.sourcePage}`;
        if (fullPageKeys.has(fullPageKey)) continue;
        fullPageKeys.add(fullPageKey);
      }
      exportSegments.push({
        page_number: segment.sourcePage,
        segment_no: segment.segmentNo,
        rect: engineRect(segment.finalRect),
        keep_full_page: segment.mode === 'full_page',
        review_status: segment.reviewStatus,
      });
    }
    return {
      source_path: segments[0]!.sourcePath,
      source_sha256: segments[0]?.sourceSha256 ?? '',
      segments: exportSegments,
    };
  });
  return { selections, rowSeed };
}

function createExportToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const entropy = `${Date.now()}-${Math.random()}-${stableIdentityDigest(`${Date.now()}-${Math.random()}`)}`;
  return `export-${Date.now().toString(36)}-${stableIdentityDigest(entropy)}-${Math.random().toString(36).slice(2, 14)}`;
}

/**
 * A deterministic local identity digest. This is not a security primitive;
 * it only keeps task metadata out of the SQLite primary key and prevents the
 * same source/page/segment from colliding across keyword tasks.
 */
function stableIdentityDigest(input: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
}

export function reviewTaskIdFor(files: SourceFile[], criteria: SearchCriteria, mode: SearchMode): string | null;
export function reviewTaskIdFor(files: SourceFile[], keyword: string, mode: SearchMode): string | null;
export function reviewTaskIdFor(
  files: SourceFile[],
  criteriaOrKeyword: SearchCriteria | string,
  mode: SearchMode,
): string | null {
  const paths = [...new Set(files
    .map((file) => file.path)
    .filter((path): path is string => typeof path === 'string' && Boolean(path.trim()))
    .map(normalizeSourceIdentity))].sort();
  if (paths.length === 0) return null;

  const criteria = typeof criteriaOrKeyword === 'string'
    ? legacyCriteria(criteriaOrKeyword)
    : normalizeSearchCriteria(criteriaOrKeyword);
  if (!criteria) return null;

  const isLegacy = criteria.include.length === 1
    && criteria.includeMode === 'all'
    && criteria.exclude.length === 0;
  const payload = isLegacy
    ? JSON.stringify({ paths, mode, keyword: criteria.include[0] })
    : JSON.stringify({ version: 2, paths, mode, criteria: JSON.parse(serializeSearchCriteria(criteria)) });
  return `review:${stableIdentityDigest(payload)}`;
}


type BatchCropSession = {
  sample: ReviewSegment; all: ReviewSegment[]; filteredIds: Set<string>;
  expected: ReviewDecisionSnapshot[];
  session: ReviewSession; taskId: string; reviewRevision: number; sourceRevision: number; epoch: number;
};

type PendingReviewOperation = {
  kind: ReviewOperationKind;
  session: ReviewSession;
  taskId: string;
  epoch: number;
  sourceRevision: number;
  expected: ReviewDecisionSnapshot[];
  segments: ReviewSegment[];
  /** Read-only dependencies checked on every attempt, without writing or undoing them. */
  validationSegments?: ReviewSegment[];
  undoId?: string;
  message: string;
};

type PersistenceOutcome =
  | { ok: true; savedCount: number }
  | {
    ok: false;
    code: 'missing_task_id' | 'unavailable_source' | 'filtered_records' | 'unavailable' | 'failed';
    message: string;
  };

function persistenceFailure(error: unknown): PersistenceOutcome {
  if (error instanceof LocalEngineError && error.code === 'TAURI_UNAVAILABLE') {
    return {
      ok: false,
      code: 'unavailable',
      message: '本地引擎不可用，审核记录未保存。',
    };
  }
  if (error instanceof StaleRunError || error instanceof StaleReviewSessionError) {
    return {
      ok: false,
      code: 'failed',
      message: '审核记录保存未完成，当前裁剪仍保留在界面中。',
    };
  }
  return {
    ok: false,
    code: 'failed',
    message: `审核记录保存失败${error instanceof Error && error.message ? `：${reviewErrorMessage(error)}` : '，当前裁剪仍保留在界面中。'}`,
  };
}

function reviewErrorMessage(error: Error): string {
  if (error instanceof LocalEngineError) {
    switch (error.engineCode) {
      case 'review_revision_conflict': return '审核记录已被其他操作更新，请重新分析后再保存。';
      case 'review_store_failed': return '审核记录读取或写入失败，请重试；已有记录未被清空。';
      case 'invalid_review_segments': return '审核记录与当前分析结果不一致，请重新分析。';
      case 'computation_version_changed': return '本地分析引擎已更新，请重新分析后再保存审核。';
    }
  }
  return error.message;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function safeDimensions(width: unknown, height: unknown): { pageWidth: number; pageHeight: number } {
  return {
    pageWidth: finitePositive(width) ? width : UNKNOWN_PAGE_WIDTH,
    pageHeight: finitePositive(height) ? height : UNKNOWN_PAGE_HEIGHT,
  };
}

function geometryFingerprint(pageWidth: number, pageHeight: number, rect: PdfRect | null): string {
  const round = (value: number) => finitePositive(value) ? Math.round(value * 1000) / 1000 : 'unknown';
  const geometry = rect ? [rect.x0, rect.y0, rect.x1, rect.y1].map(round).join(',') : 'none';
  return `geometry:${round(pageWidth)}x${round(pageHeight)}:${geometry}`;
}

function reviewStatusFor(confidence: number, rect: PdfRect | null): ReviewStatus {
  if (!rect || !Number.isFinite(confidence) || confidence < 0.7) return 'blocked';
  if (confidence < 0.9) return 'needs_review';
  return 'confirmed';
}

function fullPageRect(pageWidth: number, pageHeight: number): PdfRect {
  return { x0: 0, y0: 0, x1: pageWidth, y1: pageHeight };
}

function safeEditorRect(segment: ReviewSegment): PdfRect {
  if (segment.mode === 'full_page') {
    return fullPageRect(segment.pageWidth, segment.pageHeight);
  }
  const raw = segment.finalRect && isLegalRect(segment.finalRect, segment.pageWidth, segment.pageHeight)
    ? segment.finalRect
    : segment.candidateRect && isLegalRect(segment.candidateRect, segment.pageWidth, segment.pageHeight)
      ? segment.candidateRect
      : fullPageRect(segment.pageWidth, segment.pageHeight);
  return normalizePdfRect(raw, segment.pageWidth, segment.pageHeight);
}

function isLegalRect(rect: PdfRect | null, pageWidth: number, pageHeight: number): boolean {
  if (!rect || !finitePositive(pageWidth) || !finitePositive(pageHeight)) return false;
  try {
    const normalized = normalizePdfRect(rect, pageWidth, pageHeight);
    return normalized.x0 === rect.x0
      && normalized.y0 === rect.y0
      && normalized.x1 === rect.x1
      && normalized.y1 === rect.y1;
  } catch {
    return false;
  }
}

function isValidMatchRect(rect: PdfRect): boolean {
  return [rect.x0, rect.y0, rect.x1, rect.y1].every((value) => Number.isFinite(value))
    && rect.x0 >= 0
    && rect.y0 >= 0
    && rect.x0 < rect.x1
    && rect.y0 < rect.y1;
}

function isValidPage(page: number, pageCount: number): boolean {
  return Number.isInteger(page) && page >= 1 && Number.isFinite(pageCount) && pageCount >= page;
}

function segmentHasValidSourceGeometry(segment: ReviewSegment, sourceGeometry?: SourceGeometry): boolean {
  const geometry = sourceGeometry ?? {
    matchValid: isValidMatchRect(segment.matchRect),
    pageValid: Number.isInteger(segment.sourcePage) && segment.sourcePage >= 1,
    pageCount: segment.sourcePage,
    dimensionsMatch: true,
    pageCountMatch: true,
    previewStatus: 'pending',
  };
  return geometry.matchValid
    && geometry.pageValid
    && geometry.dimensionsMatch
    && geometry.pageCountMatch
    && geometry.previewStatus === 'valid'
    && finitePositive(segment.pageWidth)
    && finitePositive(segment.pageHeight)
    && isValidMatchRect(segment.matchRect)
    && segment.matchRect.x1 <= segment.pageWidth
    && segment.matchRect.y1 <= segment.pageHeight;
}

export function previewValidationError(
  preview: EnginePagePreview,
  segment: ReviewSegment,
  geometry?: SourceGeometry,
): PreviewInvalidReason | null {
  if (!geometry) return 'geometry';
  if (!Number.isInteger(preview.page) || preview.page !== segment.sourcePage) return 'page';
  if (
    !Number.isInteger(preview.page_count)
    || preview.page_count < segment.sourcePage
    || preview.page_count !== geometry.pageCount
  ) return 'page_count';
  const dimensions = safeDimensions(preview.page_width, preview.page_height);
  if (!finitePositive(dimensions.pageWidth) || !finitePositive(dimensions.pageHeight)) return 'dimensions';
  if (
    finitePositive(segment.pageWidth)
    && finitePositive(segment.pageHeight)
    && (segment.pageWidth !== dimensions.pageWidth || segment.pageHeight !== dimensions.pageHeight)
  ) return 'dimensions';
  return null;
}

function sourceDocumentForSegment(
  documents: readonly SourceDocument[],
  segment: ReviewSegment,
): SourceDocument | null {
  const normalizedPath = normalizeSourcePath(segment.sourcePath);
  return documents.find((document) => normalizeSourcePath(document.sourcePath) === normalizedPath) ?? null;
}

function segmentMatchesSourceDocument(
  segment: ReviewSegment,
  document: SourceDocument | null,
): boolean {
  return Boolean(
    document
      && document.integrityStatus === 'valid'
      && normalizeSourcePath(document.sourcePath) === normalizeSourcePath(segment.sourcePath)
      && document.sourceSha256.toLowerCase() === segment.sourceSha256.toLowerCase(),
  );
}

function segmentsMatchCurrentSourceDocuments(
  segments: readonly ReviewSegment[],
  documents: readonly SourceDocument[],
): boolean {
  return segments.every((segment) => segmentMatchesSourceDocument(
    segment,
    sourceDocumentForSegment(documents, segment),
  ));
}

function assertCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new StaleRunError();
}

function batchOperationFailure(
  context: Pick<BatchFailure, 'stage' | 'sourcePath' | 'page'>,
  error: unknown,
): BatchFailure {
  return createBatchFailure(context, error instanceof SourceChangedDuringOperation
    ? new LocalEngineError('ENGINE_REQUEST_REJECTED', error.message, { engineCode: 'source_changed' })
    : error);
}

/** An aggregate of failures already reported with their source/page context. */
class ReportedBatchFailure extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : '未知错误');
    this.name = 'ReportedBatchFailure';
  }
}

async function searchSources(
  sourcePaths: string[],
  criteria: SearchCriteria,
  exact: boolean,
  isCurrent: () => boolean,
  observe?: BatchObserver,
) : Promise<Array<{ sourcePath: string; result: EngineSearchResult | EngineMultiSearchResult }>> {
  const responses: Array<{ sourcePath: string; result: EngineSearchResult | EngineMultiSearchResult }> = [];
  const normalized = normalizeSearchCriteria(criteria);
  if (!normalized) return responses;
  const clauses = searchCriteriaClauses(normalized) as EngineSearchClause[];
  const legacy = normalized.include.length === 1
    && normalized.includeMode === 'all'
    && normalized.exclude.length === 0;
  for (let index = 0; index < sourcePaths.length; index += 4) {
    assertCurrent(isCurrent);
    const chunk = sourcePaths.slice(index, index + 4);
    const settledChunkResponses = await Promise.allSettled(chunk.map(async (sourcePath) => {
      try {
        const result = await engineProcessSemaphore.run(
          () => {
            observe?.({ type: 'search_started', sourcePath });
            return legacy
              ? localEngineAdapter.search(sourcePath, normalized.include[0]!, exact)
              : localEngineAdapter.searchMulti(sourcePath, clauses, exact);
          },
          isCurrent,
        );
        observe?.({ type: 'search_finished', sourcePath });
        return {
          kind: 'response' as const,
          sourcePath,
          result,
        };
      } catch (error: unknown) {
        if (error instanceof StaleRunError) throw error;
        observe?.({
          type: 'search_finished', sourcePath,
          failure: batchOperationFailure({ stage: 'search', sourcePath, page: null }, error),
        });
        if (error instanceof SourceChangedDuringOperation) {
          return {
            kind: 'source_changed' as const,
            sourcePath: error.sourcePath || sourcePath,
            message: error.message || '源 PDF 已变化，请重新分析文件。',
          };
        }
        if (isSourceChangedError(error)) {
          return {
            kind: 'source_changed' as const,
            sourcePath,
            message: error.message || '源 PDF 已变化，请重新分析文件。',
          };
        }
        throw error;
      }
    }));
    assertCurrent(isCurrent);
    const staleResponse = settledChunkResponses.find(
      (item): item is PromiseRejectedResult => item.status === 'rejected' && item.reason instanceof StaleRunError,
    );
    if (staleResponse) throw staleResponse.reason;
    const sourceChanges = settledChunkResponses
      .filter((item): item is PromiseFulfilledResult<{
        kind: 'source_changed';
        sourcePath: string;
        message: string;
      }> => item.status === 'fulfilled' && item.value.kind === 'source_changed')
      .map((item) => ({
        sourcePath: item.value.sourcePath,
        message: item.value.message,
      }));
    if (sourceChanges.length > 0) {
      const first = sourceChanges[0]!;
      throw new SourceChangedDuringOperation(first.sourcePath, first.message, sourceChanges);
    }
    const ordinaryFailure = settledChunkResponses.find(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    if (ordinaryFailure) throw new ReportedBatchFailure(ordinaryFailure.reason);
    responses.push(...settledChunkResponses
      .filter((item): item is PromiseFulfilledResult<{
        kind: 'response';
        sourcePath: string;
        result: EngineSearchResult | EngineMultiSearchResult;
      }> => item.status === 'fulfilled' && item.value.kind === 'response')
      .map((item) => ({ sourcePath: item.value.sourcePath, result: item.value.result })));
  }
  return responses;
}

function groupMatches(matches: IndexedMatch[]): AnalysisGroup[] {
  const groups = new Map<string, AnalysisGroup>();
  for (const entry of matches) {
    const { match } = entry;
    const key = `${match.source_path}\u0000${match.page}`;
    const existing = groups.get(key);
    if (existing) {
      existing.matches.push(entry);
    } else {
      groups.set(key, {
        sourcePath: match.source_path,
        sourceSha256: match.source_sha256,
        page: match.page,
        sourceIdentity: match.source_identity,
        matches: [entry],
      });
    }
  }
  return [...groups.values()];
}

async function fallbackDimensions(
  path: string,
  page: number,
  pageCount: number,
  sourceSha256: string,
  isCurrent: () => boolean,
): Promise<{ pageWidth: number; pageHeight: number }> {
  try {
    const preview = await engineProcessSemaphore.run(
      () => localEngineAdapter.renderPage(path, page, sourceSha256),
      isCurrent,
    );
    assertCurrent(isCurrent);
    if (
      typeof preview.source_sha256 === 'string'
      && preview.source_sha256.toLowerCase() !== sourceSha256.toLowerCase()
    ) {
      throw new SourceChangedDuringOperation(path, '源 PDF 已变化，请重新分析文件。');
    }
    if (
      !Number.isInteger(preview.page_count)
      || preview.page_count < page
      || preview.page_count !== pageCount
    ) {
      throw new SourceChangedDuringOperation(path, PREVIEW_PAGE_COUNT_MISMATCH);
    }
    if (!Number.isInteger(preview.page) || preview.page !== page) {
      return { pageWidth: UNKNOWN_PAGE_WIDTH, pageHeight: UNKNOWN_PAGE_HEIGHT };
    }
    return safeDimensions(preview.page_width, preview.page_height);
  } catch (error: unknown) {
    if (error instanceof StaleRunError) throw error;
    if (error instanceof SourceChangedDuringOperation) throw error;
    if (isSourceChangedError(error)) {
      throw new SourceChangedDuringOperation(path, error.message || '源 PDF 已变化，请重新分析文件。');
    }
    return { pageWidth: UNKNOWN_PAGE_WIDTH, pageHeight: UNKNOWN_PAGE_HEIGHT };
  }
}

function buildSegmentId(
  taskId: string,
  match: SourceMatch,
  page: number,
  segmentNo: number,
  usedIds: Set<string>,
): string {
  const identity = match.source_sha256 !== 'unavailable' ? match.source_sha256 : match.source_identity;
  const baseId = `${taskId}:${identity}:${page}:${segmentNo}`;
  let id = baseId;
  if (usedIds.has(id)) {
    const collision = `${baseId}:${match.source_identity}`;
    id = collision;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${collision}:${suffix}`;
      suffix += 1;
    }
  }
  usedIds.add(id);
  return id;
}

async function analyzeMatches(
  matches: SourceMatch[],
  isCurrent: () => boolean,
  taskId: string,
  criteria: SearchCriteria,
  observe?: BatchObserver,
  access?: AnalysisAccess,
): Promise<AnalysisBuildResult> {
  assertCurrent(isCurrent);
  const normalizedCriteria = normalizeSearchCriteria(criteria);
  if (!normalizedCriteria) throw new Error('至少需要一个包含关键词。');
  const legacy = normalizedCriteria.include.length === 1
    && normalizedCriteria.includeMode === 'all'
    && normalizedCriteria.exclude.length === 0;
  const segmentCounters = new Map<string, number>();
  const indexed = matches.map((match, inputIndex) => {
    const groupKey = `${match.source_path}\u0000${match.page}`;
    const segmentNo = (segmentCounters.get(groupKey) ?? 0) + 1;
    segmentCounters.set(groupKey, segmentNo);
    const sourceGeometry: SourceGeometry = {
      matchValid: isValidMatchRect(matchRect(match)),
      pageValid: isValidPage(match.page, match.page_count),
      pageCount: match.page_count,
      dimensionsMatch: true,
      pageCountMatch: true,
      previewStatus: 'pending',
    };
    return { match, inputIndex, segmentNo, sourceGeometry };
  });
  const validEntries = indexed.filter((entry) => entry.sourceGeometry.matchValid && entry.sourceGeometry.pageValid);
  const invalidEntries = indexed.filter((entry) => !entry.sourceGeometry.matchValid || !entry.sourceGeometry.pageValid);
  if (!legacy && invalidEntries.length > 0) {
    throw new Error('多关键词搜索返回了无效命中数据，已阻止分析。');
  }
  const groups = groupMatches(validEntries);
  observe?.({ type: 'analysis_planned', pages: groups.map(({ sourcePath, page }) => ({ sourcePath, page })) });
  const usedIds = new Set<string>();
  const byGroup: Array<{
    group: AnalysisGroup;
    failed: boolean;
    pageFullyMatched: boolean;
    dimensions: { pageWidth: number; pageHeight: number };
    selections: EnginePageAnalysis['selections'];
  }> = [];
  for (let start = 0; start < groups.length; start += MAX_ANALYSIS_CONCURRENCY) {
    assertCurrent(isCurrent);
    const batch = groups.slice(start, start + MAX_ANALYSIS_CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map(async (group) => {
      assertCurrent(isCurrent);
      let pageFailure: BatchFailure | undefined;
      const sourceRects = group.matches
        .map(({ match }) => matchRect(match))
        .map(engineRect)
        .filter((rect): rect is EngineRect => rect !== null);
      try {
        const readAnalysis = () => {
          observe?.({ type: 'page_started', sourcePath: group.sourcePath, page: group.page });
          return (access?.read ?? localEngineAdapter.analyzePage)(
            group.sourcePath,
            group.page,
            sourceRects,
            group.sourceSha256,
          );
        };
        const analysis = access?.cached
          ? await readAnalysis()
          : await engineProcessSemaphore.run(readAnalysis, isCurrent);
        if (
          typeof analysis.source_sha256 === 'string'
          && analysis.source_sha256.toLowerCase() !== group.sourceSha256.toLowerCase()
        ) {
          throw new SourceChangedDuringOperation(
            group.sourcePath,
            '源 PDF 已变化，请重新分析文件。',
          );
        }
        assertCurrent(isCurrent);
        if (!Array.isArray(analysis.selections) || analysis.selections.length !== group.matches.length) {
          throw new Error('页面分析返回的片段数量与命中结果不一致。');
        }
        return {
          group,
          failed: false,
          pageFullyMatched: analysis.page_fully_matched === true,
          dimensions: safeDimensions(analysis.page_width, analysis.page_height),
          selections: analysis.selections,
        };
      } catch (error: unknown) {
        if (error instanceof StaleRunError) throw error;
        // Complete cached sources must contain every requested page. A broken
        // final assembly is a batch error, never a reason to silently recompute.
        if (access?.cached) throw new BatchAssemblyError(error);
        pageFailure = batchOperationFailure({ stage: 'analysis', sourcePath: group.sourcePath, page: group.page }, error);
        if (error instanceof SourceChangedDuringOperation) throw error;
        if (isSourceChangedError(error)) {
          throw new SourceChangedDuringOperation(
            group.sourcePath,
            error.message || '源 PDF 已变化，请重新分析文件。',
          );
        }
        let dimensions: { pageWidth: number; pageHeight: number };
        try {
          dimensions = await fallbackDimensions(
            group.sourcePath,
            group.page,
            group.matches[0]?.sourceGeometry.pageCount ?? Number.NaN,
            group.sourceSha256,
            isCurrent,
          );
        } catch (fallbackError: unknown) {
          if (!(fallbackError instanceof StaleRunError)) {
            const fallbackFailure = batchOperationFailure({ stage: 'analysis', sourcePath: group.sourcePath, page: group.page }, fallbackError);
            pageFailure = { ...fallbackFailure, detail: `${pageFailure.detail}\n后续页面校验：${fallbackFailure.detail}` };
          }
          throw fallbackError;
        }
        assertCurrent(isCurrent);
        return {
          group,
          failed: true,
          pageFullyMatched: false,
          dimensions,
          selections: [],
        };
      } finally {
        if (pageFailure || isCurrent()) observe?.({
          type: 'page_finished', sourcePath: group.sourcePath, page: group.page,
          ...(pageFailure ? { failure: pageFailure } : {}),
        });
      }
    }));
    assertCurrent(isCurrent);
    const failures = batchResults.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
    const stale = failures.find((item) => item.reason instanceof StaleRunError);
    if (stale) throw stale.reason;
    const sourceChanges = failures.flatMap((item) => item.reason instanceof SourceChangedDuringOperation
      ? item.reason.sourceChanges : []);
    if (sourceChanges.length > 0) {
      const first = sourceChanges[0]!;
      throw new SourceChangedDuringOperation(first.sourcePath, first.message, sourceChanges);
    }
    if (failures[0]) throw new ReportedBatchFailure(failures[0].reason);
    byGroup.push(...batchResults.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []));
  }

  observe?.({ type: 'finalizing' });
  const segmentsByInputIndex = new Map<number, ReviewSegment>();
  const representativeByInputIndex = new Map<number, SourceMatch>();
  const geometryById: Record<string, SourceGeometry> = {};
  const compoundSegments: ReviewSegment[] = [];
  const compoundRepresentatives: SourceMatch[] = [];
  const compoundEvidenceById: Record<string, SourceMatch[]> = {};
  let failedGroups = 0;
  let invalidInputs = invalidEntries.length;
  for (const entry of invalidEntries) {
    const { match, inputIndex, segmentNo } = entry;
    const id = buildSegmentId(taskId, match, match.page, segmentNo, usedIds);
    const rect = matchRect(match);
    segmentsByInputIndex.set(inputIndex, {
      id,
      sourcePath: match.source_path,
      sourceSha256: match.source_sha256,
      sourcePage: match.page,
      segmentNo,
      matchRect: rect,
      candidateRect: null,
      finalRect: null,
      pageWidth: UNKNOWN_PAGE_WIDTH,
      pageHeight: UNKNOWN_PAGE_HEIGHT,
      confidence: asFinite(match.confidence, 0),
      slot: null,
      snapPoints: [],
      layoutFingerprint: geometryFingerprint(UNKNOWN_PAGE_WIDTH, UNKNOWN_PAGE_HEIGHT, rect),
      mode: 'candidate',
      reviewStatus: 'blocked',
      manualAdjusted: false,
    });
    geometryById[id] = entry.sourceGeometry;
    representativeByInputIndex.set(inputIndex, match);
  }
  for (const result of byGroup) {
    if (result.failed) failedGroups += 1;
    const { pageWidth, pageHeight } = result.dimensions;

    if (!legacy) {
      if (result.failed) continue;
      const candidateEntries = new Map<string, IndexedMatch[]>();
      const candidateSelections = new Map<string, EnginePageAnalysis['selections'][number]>();
      const taggedHits: TaggedReceiptHit[] = [];
      result.group.matches.forEach((matchEntry, selectionIndex) => {
        const match = matchEntry.match;
        const selection = result.selections[selectionIndex];
        if (
          typeof match.query_id !== 'string'
          || match.query_id.trim().length === 0
          || (match.role !== 'include' && match.role !== 'exclude')
          || !selection
          || selection.candidate_index === undefined
          || selection.candidate_index === null
          || !Number.isInteger(selection.candidate_index)
          || selection.candidate_index < 0
          || selection.candidate_rect === undefined
          || selection.candidate_rect === null
        ) {
          throw new Error('多关键词页面分析缺少候选回单元数据，已阻止导出。');
        }
        const candidateKey = `${result.group.sourcePath}\u0000${result.group.sourceSha256}\u0000${result.group.page}\u0000${selection.candidate_index}`;
        const entries = candidateEntries.get(candidateKey) ?? [];
        entries.push(matchEntry);
        candidateEntries.set(candidateKey, entries);
        candidateSelections.set(candidateKey, selection);
        taggedHits.push({
          queryId: match.query_id,
          role: match.role,
          candidateKey,
        });
      });

      const candidates = groupTaggedHitsByCandidate(taggedHits);
      candidates.sort((left, right) => (
        (candidateSelections.get(left.candidateKey)?.candidate_index ?? Number.MAX_SAFE_INTEGER)
        - (candidateSelections.get(right.candidateKey)?.candidate_index ?? Number.MAX_SAFE_INTEGER)
      ));
      let nextSegmentNo = 0;
      for (const candidate of candidates) {
        if (!candidateSatisfiesCriteria(candidate, normalizedCriteria)) continue;
        const entries = candidateEntries.get(candidate.candidateKey) ?? [];
        const selection = candidateSelections.get(candidate.candidateKey);
        const representativeEntry = entries.find((entry) => entry.match.role === 'include');
        if (!representativeEntry || !selection || !selection.candidate_rect) {
          throw new Error('多关键词候选回单缺少包含关键词命中，已阻止导出。');
        }
        const candidateRect = {
          x0: selection.candidate_rect.x0,
          y0: selection.candidate_rect.y0,
          x1: selection.candidate_rect.x1,
          y1: selection.candidate_rect.y1,
        };
        for (const entry of entries) {
          const entrySelection = result.selections[result.group.matches.indexOf(entry)];
          if (!entrySelection?.candidate_rect || !sameRect(candidateRect, entrySelection.candidate_rect)) {
            throw new Error('多关键词候选回单边界不一致，已阻止导出。');
          }
        }
        const representative = representativeEntry.match;
        const sourceRect = matchRect(representative);
        const legalCandidate = isLegalRect(candidateRect, pageWidth, pageHeight) ? candidateRect : null;
        const confidenceValues = entries.filter((entry) => entry.match.role === 'include').flatMap((entry) => {
          const index = result.group.matches.indexOf(entry);
          const itemSelection = result.selections[index];
          return [asFinite(entry.match.confidence, 0), asFinite(itemSelection?.confidence, 0)];
        });
        const confidence = confidenceValues.length > 0
          ? Math.min(...confidenceValues)
          : 0;
        nextSegmentNo += 1;
        const id = buildSegmentId(taskId, representative, result.group.page, nextSegmentNo, usedIds);
        const sourceGeometry: SourceGeometry = {
          matchValid: isValidMatchRect(sourceRect)
            && (!finitePositive(pageWidth) || !finitePositive(pageHeight)
              || (sourceRect.x1 <= pageWidth && sourceRect.y1 <= pageHeight)),
          pageValid: isValidPage(result.group.page, representative.page_count),
          pageCount: representative.page_count,
          dimensionsMatch: true,
          pageCountMatch: true,
          previewStatus: 'pending',
        };
        if (!sourceGeometry.matchValid || !sourceGeometry.pageValid) invalidInputs += 1;
        const segment: ReviewSegment = {
          id,
          sourcePath: result.group.sourcePath,
          sourceSha256: representative.source_sha256,
          sourcePage: result.group.page,
          segmentNo: nextSegmentNo,
          matchRect: sourceRect,
          candidateRect,
          finalRect: candidateRect,
          pageWidth,
          pageHeight,
          confidence,
          slot: selection.slot ?? null,
          snapPoints: selection.snap_points ?? [],
          layoutFingerprint: geometryFingerprint(pageWidth, pageHeight, candidateRect),
          mode: 'candidate',
          reviewStatus: result.failed || !sourceGeometry.matchValid || !sourceGeometry.pageValid
            ? 'blocked'
            : reviewStatusFor(confidence, legalCandidate),
          manualAdjusted: false,
        };
        compoundSegments.push(segment);
        compoundRepresentatives.push(representative);
        compoundEvidenceById[id] = entries.map((entry) => entry.match);
        geometryById[id] = sourceGeometry;
      }
      continue;
    }

    result.group.matches.forEach((matchEntry, selectionIndex) => {
      const match = matchEntry.match;
      const inputIndex = matchEntry.inputIndex;
      const selection = result.selections[selectionIndex];
      const candidateRect = selection?.rect ?? null;
      const confidence = asFinite(selection?.confidence, result.failed ? asFinite(match.confidence, 0) : 0);
      const id = buildSegmentId(taskId, match, result.group.page, matchEntry.segmentNo, usedIds);
      const legalCandidate = candidateRect && isLegalRect(candidateRect, pageWidth, pageHeight) ? candidateRect : null;
      const sourceRect = matchRect(match);
      const sourceGeometry: SourceGeometry = {
        ...matchEntry.sourceGeometry,
        matchValid: matchEntry.sourceGeometry.matchValid
          && (!finitePositive(pageWidth) || !finitePositive(pageHeight)
            || (sourceRect.x1 <= pageWidth && sourceRect.y1 <= pageHeight)),
      };
      if (!sourceGeometry.matchValid || !sourceGeometry.pageValid) invalidInputs += 1;
      segmentsByInputIndex.set(inputIndex, {
        id,
        sourcePath: result.group.sourcePath,
        sourceSha256: match.source_sha256,
        sourcePage: result.group.page,
        segmentNo: matchEntry.segmentNo,
        matchRect: sourceRect,
        candidateRect,
        finalRect: result.pageFullyMatched ? null : candidateRect,
        pageWidth,
        pageHeight,
        confidence,
        slot: selection?.slot ?? null,
        snapPoints: selection?.snap_points ?? [],
        layoutFingerprint: geometryFingerprint(pageWidth, pageHeight, candidateRect ?? matchRect(match)),
        mode: result.pageFullyMatched ? 'full_page' : 'candidate',
        reviewStatus: result.failed || !sourceGeometry.matchValid || !sourceGeometry.pageValid
          ? 'blocked'
          : reviewStatusFor(confidence, legalCandidate),
        manualAdjusted: false,
      });
      geometryById[id] = sourceGeometry;
      representativeByInputIndex.set(inputIndex, match);
    });
  }

  if (!legacy) {
    return {
      segments: compoundSegments,
      representativeMatches: compoundRepresentatives,
      evidenceById: compoundEvidenceById,
      failedGroups,
      invalidInputs,
      geometryById,
    };
  }

  const legacySegments = matches
    .map((_match, index) => segmentsByInputIndex.get(index))
    .filter((segment): segment is ReviewSegment => Boolean(segment));
  const legacyRepresentatives = matches
    .map((_match, index) => representativeByInputIndex.get(index))
    .filter((match): match is SourceMatch => Boolean(match));
  const legacyEvidenceById: Record<string, SourceMatch[]> = {};
  legacySegments.forEach((segment, index) => {
    const representative = legacyRepresentatives[index];
    if (representative) legacyEvidenceById[segment.id] = [representative];
  });

  return {
    segments: legacySegments,
    representativeMatches: legacyRepresentatives,
    evidenceById: legacyEvidenceById,
    failedGroups,
    invalidInputs,
    geometryById,
  };
}

function matchesForSource(sourcePath: string, sourceIndex: number, result: RawSourceSearch): SourceMatch[] {
  const [document] = buildSourceDocuments(
    [{ name: sourcePath, sourcePath }], [{ sourcePath, result }],
  );
  if (!document) throw new BatchAssemblyError('搜索来源缺少文档元数据。');
  return result.matches.map((match) => ({
    ...match,
    source_path: sourcePath,
    source_sha256: document.sourceSha256,
    source_identity: `source-${sourceIndex + 1}`,
    page_count: document.pageCount,
  }));
}

function createSourceBatchRunner(
  binding: () => BatchRunBinding,
  phaseChanged: (phase: 'search' | 'analysis' | 'verifying') => void,
): BatchAnalysisRunner<RawSourceSearch, RawSourcePages> {
  return new BatchAnalysisRunner({
    search: async (source, _index, context, isCurrent) => {
      const { observe, rememberDocument } = binding();
      const [response] = await searchSources([source.sourcePath], context.criteria, context.matchMode === 'exact', isCurrent, observe);
      if (!response) throw new BatchAssemblyError('搜索来源未返回结果。');
      rememberDocument(source.sourcePath, response.result);
      return response.result;
    },
    analyze: async (source, index, search, context, isCurrent) => {
      const { observe, taskId } = binding();
      const pages: RawSourcePages = [];
      try {
        const result = await analyzeMatches(
          matchesForSource(source.sourcePath, index, search), isCurrent, taskId, context.criteria,
          (event) => { if (event.type !== 'finalizing') observe(event); },
          { read: async (path, page, matches, sha) => {
            const analysis = await localEngineAdapter.analyzePage(path, page, matches, sha);
            pages.push({ page, analysis });
            return analysis;
          } },
        );
        if (result.failedGroups > 0) throw new ReportedBatchFailure(new Error('此 PDF 的部分页面分析失败。'));
        // The temporary per-source review objects are deliberately discarded.
        // Only raw responses are retained; final IDs are assigned batch-wide.
        return pages;
      } catch (error) {
        if (error instanceof StaleRunError || error instanceof SourceChangedDuringOperation
          || error instanceof ReportedBatchFailure || isSourceChangedError(error)) throw error;
        throw new BatchAssemblyError(error);
      }
    },
    verify: async (source, _index, search, _context, isCurrent) => {
      const { observe } = binding();
      let failure: BatchFailure | undefined;
      let reportedSourceChange = false;
      try {
        const metadata = await engineProcessSemaphore.run(() => {
          observe({ type: 'verification_started', sourcePath: source.sourcePath });
          return localEngineAdapter.inspectPdf(source.sourcePath);
        }, isCurrent);
        if (metadata.source_sha256.toLowerCase() !== search.source_sha256.toLowerCase()
          || metadata.page_count !== search.page_count) {
          throw new SourceChangedDuringOperation(source.sourcePath, '源 PDF 在分析期间发生变化，请重新分析整批。');
        }
        assertCurrent(isCurrent);
      } catch (error) {
        if (!(error instanceof StaleRunError)) failure = batchOperationFailure(
          { stage: 'verifying', sourcePath: source.sourcePath, page: null }, error,
        );
        // A sibling may have stopped new work already. Preserve known changes
        // from requests that were in flight; observe has its own run-ID guard.
        if (failure?.code === 'source_changed') {
          observe({ type: 'verification_finished', sourcePath: source.sourcePath, failure });
          reportedSourceChange = true;
        }
        if (isSourceChangedError(error)) throw new SourceChangedDuringOperation(source.sourcePath, error.message);
        throw error;
      } finally {
        if (!reportedSourceChange && isCurrent()) observe({ type: 'verification_finished', sourcePath: source.sourcePath, ...(failure ? { failure } : {}) });
      }
    },
    isFatal: (error) => error instanceof StaleRunError || error instanceof SourceChangedDuringOperation
      || error instanceof BatchAssemblyError || isSourceChangedError(error),
    onPhase: phaseChanged,
    onReused: (source, _index, search, pages) => {
      const { observe, rememberDocument } = binding();
      rememberDocument(source.sourcePath, search);
      observe({ type: 'source_reused', sourcePath: source.sourcePath, pages: pages.map((item) => item.page) });
    },
  });
}

export default function App() {
  const [persistentTasksEnabled] = useState(() => typeof window !== 'undefined'
    && typeof (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke === 'function');
  const [persistentController] = useState(() => new PersistentBatchController());
  const persistent = useSyncExternalStore(persistentController.subscribe, persistentController.getSnapshot);
  const [taskHistoryOpen, setTaskHistoryOpen] = useState(false);
  const [taskPanelView, setTaskPanelView] = useState<'current' | 'history'>('current');
  const [taskPanelRequest, setTaskPanelRequest] = useState<{ previousId: string | null } | null>(null);
  // While creating a new task, an older selected snapshot must not be shown
  // as the task being created, including when the create request fails.
  const taskPanelJob = taskPanelRequest
    && (persistent.current?.id ?? null) === taskPanelRequest.previousId ? null : persistent.current;
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const cleanupBusyRef = useRef(false);
  const [cleanupPlan, setCleanupPlan] = useState<BatchCleanup | null>(null);
  const [cleanupHistory, setCleanupHistory] = useState<BatchCleanup[]>([]);
  const [cleanupUsage, setCleanupUsage] = useState<BatchStorageUsage | null>(null);
  const [cleanupNextOffset, setCleanupNextOffset] = useState<number | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const autoOpenJobRef = useRef<string | null>(null);
  const persistentLoadAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!persistentTasksEnabled) return;
    persistentController.start();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<unknown>('batch-task-event', (event) => persistentController.onEvent(event.payload))
      .then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => { /* Snapshot polling still recovers a lost event subscription. */ });
    return () => {
      disposed = true;
      unlisten?.();
      persistentLoadAbortRef.current?.abort();
      persistentController.dispose();
    };
  }, [persistentController, persistentTasksEnabled]);
  const [initialAppSettings] = useState(() => readAppSettings());
  const [appSettings, setAppSettings] = useState<AppSettingsV1>(initialAppSettings.settings);
  const [settingsWarning, setSettingsWarning] = useState<string | null>(initialAppSettings.warning);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [inputDirectoryDraftResetToken, setInputDirectoryDraftResetToken] = useState(0);
  const [outputDirectoryDraftResetToken, setOutputDirectoryDraftResetToken] = useState(0);
  const [directoryPickerBusy, setDirectoryPickerBusy] = useState(false);
  const [directoryPickerError, setDirectoryPickerError] = useState<string | null>(null);
  const [workspaceResetSignal, setWorkspaceResetSignal] = useState(0);
  const [sourceFiles, setSourceFiles] = useState<SourceFile[]>([]);
  const [searchDraft, setSearchDraft] = useState<SearchSettings>(() => createInitialSearchSettings(initialAppSettings.settings));
  const [keywordHistory, setKeywordHistory] = useState<SearchKeywordHistory>(() => loadSearchKeywordHistory());
  const keywordHistoryRef = useRef(keywordHistory);
  const [appliedSearch, setAppliedSearch] = useState<AppliedSearch | null>(null);
  const [searchEditorOpen, setSearchEditorOpen] = useState(true);
  const [analysisState, dispatchAnalysis] = useReducer(analysisStateReducer, { phase: 'idle' });
  const [batchFeedback, dispatchBatchFeedback] = useReducer(batchFeedbackReducer, null);
  const [sourceNotice, setSourceNotice] = useState<ActionFeedback>(null);
  const [analysisNotice, setAnalysisNotice] = useState<ActionFeedback>(null);
  const [reviewFeedback, setReviewFeedback] = useState<ActionFeedback>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>('checking');
  const [ocrState, setOcrState] = useState<OcrState>(OCR_INITIAL_STATE);
  const [ocrCacheState, setOcrCacheState] = useState<OcrCacheInfo | null>(null);
  const [checkedTaskOcrIssueKey, setCheckedTaskOcrIssueKey] = useState<string | null>(null);
  const [engineMatches, setEngineMatches] = useState<SourceMatch[]>([]);
  const [evidenceById, setEvidenceById] = useState<Record<string, SourceMatch[]>>({});
  const [reviewSegments, setReviewSegments] = useState<ReviewSegment[]>([]);
  const [reviewCoordinator] = useState(() => new ReviewSessionCoordinator(localEngineAdapter, engineProcessSemaphore));
  const reviewSessionRef = useRef<ReviewSession | null>(null);
  const [reviewHistory] = useState(() => new ReviewOperationHistory());
  const [reviewHistoryCount, setReviewHistoryCount] = useState(0);
  const [reviewSavePending, setReviewSavePending] = useState(false);
  const reviewSavePendingRef = useRef(false);
  const pendingReviewOperationRef = useRef<PendingReviewOperation | null>(null);
  const [unsavedReviewMessage, setUnsavedReviewMessage] = useState<string | undefined>();
  const [legacySuggestions, setLegacySuggestions] = useState<Record<string, EngineReviewSegment>>({});
  const [sourceGeometryById, setSourceGeometryById] = useState<Record<string, SourceGeometry>>({});
  const reviewGeometryStateRef = useRef(sourceGeometryById);
  reviewGeometryStateRef.current = sourceGeometryById;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisErrorCount, setAnalysisErrorCount] = useState(0);
  const [invalidInputCount, setInvalidInputCount] = useState(0);
  const [pagePreview, setPagePreview] = useState<EnginePagePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewRetry, setPreviewRetry] = useState(0);
  const [previewRequestEpoch, setPreviewRequestEpoch] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [groupConfirmed, setGroupConfirmed] = useState(false);
  const [groupSavePending, setGroupSavePending] = useState(false);
  const [exportInFlight, setExportInFlight] = useState(false);
  const [previewGenerating, setPreviewGenerating] = useState(false);
  const [exportPreview, setExportPreview] = useState<ExportPreviewSnapshot | null>(null);
  const [exportPreviewPage, setExportPreviewPage] = useState(1);
  const [exportPreviewImage, setExportPreviewImage] = useState('');
  const [exportPreviewLoading, setExportPreviewLoading] = useState(false);
  const [exportPreviewError, setExportPreviewError] = useState('');
  const [exportPreviewRetry, setExportPreviewRetry] = useState(0);
  const [exportPreviewZoom, setExportPreviewZoom] = useState(75);
  const [exportFeedback, setExportFeedback] = useState<ActionFeedback>(null);
  const [includeXlsx, setIncludeXlsx] = useState(false);
  const [exportBundleClient] = useState(() => new ExportBundleClient());
  const [exportScopeOpen, setExportScopeOpen] = useState(false);
  const [exportScope, setExportScope] = useState<ExportScopeSelection>({ kind: 'all' });
  const [exportOutputMode, setExportOutputMode] = useState<ExportOutputMode>('merged');
  const [exportOutputName, setExportOutputName] = useState('');
  const [exportScopeError, setExportScopeError] = useState<string | null>(null);
  const exportScopeHostRef = useRef<HTMLDivElement>(null);
  const [batchCropSession, setBatchCropSession] = useState<BatchCropSession | null>(null);
  const batchCropRef = useRef<BatchCropSession | null>(null);
  const batchCropRunRef = useRef(0);
  const [batchCropScope, setBatchCropScope] = useState<'source' | 'filtered'>('source');
  const [batchCropPlan, setBatchCropPlan] = useState<BatchCropPlan | null>(null);
  const batchCropPlanRef = useRef<BatchCropPlan | null>(null);
  const [batchCropProgress, setBatchCropProgress] = useState('');
  const [batchCropBusy, setBatchCropBusy] = useState(false);
  const [batchCropApplying, setBatchCropApplying] = useState(false);
  const batchCropApplyingRef = useRef(false);
  const [batchCropError, setBatchCropError] = useState<string | undefined>();
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [reviewSourceFilter, setReviewSourceFilter] = useState<string | null>(null);
  const [reviewSortOrder, setReviewSortOrder] = useState<ReviewResultSort>('original');
  const settingsEntryRef = useRef<HTMLButtonElement>(null);
  const appSettingsRef = useRef(appSettings);
  appSettingsRef.current = appSettings;
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const settingsWasOpenRef = useRef(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const pickerAppendRef = useRef(false);
  const sourcePickerRequestRef = useRef(0);
  const searchRequestIdRef = useRef(0);
  const searchInFlightRef = useRef(false);
  const ocrCheckRequestRef = useRef(0);
  const ocrCheckInFlightRef = useRef(false);
  const ocrCacheRequestRef = useRef(0);
  const ocrCacheInFlightRef = useRef(false);
  const batchRunBindingRef = useRef<BatchRunBinding | null>(null);
  const [retryState, setRetryState] = useState<RetryState | null>(null);
  const [batchRunner] = useState(() => createSourceBatchRunner(
    () => {
      if (!batchRunBindingRef.current) throw new Error('批量执行上下文未就绪。');
      return batchRunBindingRef.current;
    },
    (phase) => {
      if (phase === 'analysis') {
        dispatchAnalysis({ type: 'page_analysis_started' });
        setAnalysisLoading(true);
        setAnalysisNoticeMessage('搜索阶段结束，正在分析命中页面…');
      } else if (phase === 'verifying') {
        batchRunBindingRef.current?.observe({ type: 'verifying' });
        setAnalysisNoticeMessage('正在核验全部来源，确认文件在分析期间未被修改…');
      }
    },
  ));
  const reviewRevisionRef = useRef(0);
  const reviewFeedbackRevisionRef = useRef(0);
  const reviewGeometryRevisionRef = useRef(0);
  const reviewFrozenRef = useRef(false);
  const previewRunRef = useRef(0);
  const groupSaveRequestRef = useRef(0);
  const groupSavePendingRef = useRef(false);
  const exportInFlightRef = useRef(false);
  const exportPreviewRef = useRef<ExportPreviewSnapshot | null>(null);
  const reviewViewBeforeExportRef = useRef<ReviewViewSnapshot | null>(null);
  const workspaceLockedRef = useRef(false);
  const pagePreviewCacheRef = useRef(new Map<string, Promise<EnginePagePreview>>());
  const pagePreviewOwnerRef = useRef(new Map<string, () => boolean>());
  const pagePreviewIdentityRef = useRef<{ documentKey: string; page: number } | null>(null);
  const previewLoadingRef = useRef(false);
  const previewReadyForActionsRef = useRef(false);
  const previewRetryRequestRef = useRef(0);
  const previewGenerationRef = useRef(0);
  // A search revision cancels queued page work without advancing the review
  // generation. The latter is reserved for committed review/source changes;
  // this epoch only prevents stale preview jobs from occupying the engine
  // semaphore while a replacement search is preparing.
  const previewRequestEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const directoryOperationRevisionRef = useRef<Record<DirectorySetting, number>>({
    lastInputDirectory: 0,
    lastOutputDirectory: 0,
  });
  const reviewFilterRef = useRef(reviewFilter);
  reviewFilterRef.current = reviewFilter;
  const reviewSourceFilterRef = useRef(reviewSourceFilter);
  reviewSourceFilterRef.current = reviewSourceFilter;
  const revealSegment = useCallback((id: string) => {
    if (workspaceLockedRef.current) return;
    const segment = reviewSegments.find((item) => item.id === id);
    if (segment && !filterSegments(reviewSegments, reviewFilterRef.current).some((item) => item.id === id)) {
      setReviewFilter('all');
    }
    if (segment && reviewSourceFilterRef.current !== null
      && reviewSourceFilterRef.current !== normalizeSourcePath(segment.sourcePath)) {
      setReviewSourceFilter(null);
    }
    setSelectedId(id);
  }, [reviewSegments]);
  const navigation = useSourcePreviewNavigation({
    segments: reviewSegments,
    onRevealSegment: revealSegment,
  });

  const reviewTaskId = appliedSearch?.taskId ?? null;
  const reviewTaskIdRef = useRef<string | null>(reviewTaskId);
  reviewTaskIdRef.current = reviewTaskId;
  const appliedCriteria = appliedSearch?.criteria ?? null;
  const sourceFilesRef = useRef(sourceFiles);
  sourceFilesRef.current = sourceFiles;
  const reviewSegmentsRef = useRef(reviewSegments);
  reviewSegmentsRef.current = reviewSegments;
  const navigationDocumentsRef = useRef(navigation.documents);
  navigationDocumentsRef.current = navigation.documents;
  const sourceIntegrityRevisionRef = useRef(navigation.sourceIntegrityRevision);
  sourceIntegrityRevisionRef.current = navigation.sourceIntegrityRevision;
  const exportSourcesRef = useRef(exportSourcesFor(reviewSegments));
  exportSourcesRef.current = exportSourcesFor(reviewSegments);
  groupSavePendingRef.current = groupSavePending;
  const workspaceLocked = Boolean(batchCropSession) || exportScopeOpen || previewGenerating || Boolean(exportPreview) || exportInFlight || cleanupBusy;
  workspaceLockedRef.current = workspaceLocked;

  function feedbackFor(message: string): ActionFeedback {
    const normalized = message.trim();
    if (!normalized) return null;
    return {
      kind: /失败|错误|无效|不能|不一致|变化|拒绝|阻塞|不可用|找不到|没有可/.test(normalized)
        ? 'error'
        : 'status',
      message: normalized,
    };
  }

  // Notifications have one owner each.  Keeping these setters explicit avoids
  // a generic import notice clearing or duplicating unrelated panels.
  function setSourceNoticeMessage(message: string): void {
    setSourceNotice(feedbackFor(message));
  }

  function setAnalysisNoticeMessage(message: string): void {
    setAnalysisNotice(feedbackFor(message));
  }

  function setReviewNoticeMessage(message: string): void {
    setReviewFeedback(feedbackFor(message));
  }

  function setPreviewNoticeMessage(message: string): void {
    setPreviewError(message.trim());
  }

  function setExportNotice(message: string): void {
    setExportFeedback(feedbackFor(message));
  }

  function commitNavigationDocuments(
    documents: readonly SourceDocument[],
    initialSegment?: ReviewSegment | null,
  ): void {
    navigation.commitDocuments(documents, initialSegment);
    // The navigation hook updates its latest state synchronously, while the
    // component ref normally follows only after React renders. Keep this ref
    // in lockstep so a late integrity event cannot target a replaced SHA in
    // the same tick.
    navigationDocumentsRef.current = [...documents];
  }

  function cachedPagePreview(
    document: SourceDocument,
    page: number,
    generation = previewGenerationRef.current,
    requestEpoch = previewRequestEpochRef.current,
    priority: EngineTaskPriority = 'foreground',
    currentGuard: () => boolean = () => true,
  ): Promise<EnginePagePreview> {
    const key = `${normalizeSourcePath(document.sourcePath)}\u0000${document.sourceSha256.toLowerCase()}\u0000${page}\u0000${requestEpoch}`;
    const cached = pagePreviewCacheRef.current.get(key);
    if (cached && pagePreviewOwnerRef.current.get(key)?.()) {
      // A hit may already be waiting behind hundreds of background checks.
      // Reuse its request, but promote it when the user wants to see that page.
      if (priority === 'foreground') engineProcessSemaphore.promote(cached);
      return cached;
    }
    const request = engineProcessSemaphore.run(
      () => localEngineAdapter.renderPage(
        document.sourcePath,
        page,
        document.sourceSha256,
      ),
      () => mountedRef.current
        && currentGuard()
        && previewGenerationRef.current === generation
        && previewRequestEpochRef.current === requestEpoch
        // Effects from the last render can still hold a formerly valid
        // document after a sibling response synchronously invalidates it.
        // Check the live source identity before occupying an engine slot.
        && navigationDocumentsRef.current.some((current) => (
          current.key === document.key && current.integrityStatus === 'valid'
        )),
      priority,
    );
    pagePreviewCacheRef.current.set(key, request);
    pagePreviewOwnerRef.current.set(key, currentGuard);
    const clearCache = () => {
      if (pagePreviewCacheRef.current.get(key) === request) {
        pagePreviewCacheRef.current.delete(key);
        pagePreviewOwnerRef.current.delete(key);
      }
    };
    void request.then(clearCache, clearCache);
    return request;
  }

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      batchRunner.clear();
      previewGenerationRef.current += 1;
      previewRequestEpochRef.current += 1;
      previewRunRef.current += 1;
      searchRequestIdRef.current += 1;
      ocrCheckRequestRef.current += 1;
      ocrCheckInFlightRef.current = false;
      ocrCacheRequestRef.current += 1;
      ocrCacheInFlightRef.current = false;
      reviewRevisionRef.current += 1;
      pagePreviewCacheRef.current.clear();
      pagePreviewOwnerRef.current.clear();
      pagePreviewIdentityRef.current = null;
      const current = exportPreviewRef.current;
      exportPreviewRef.current = null;
      if (current) void closeExportBundle(current.bundle.intent_id);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const requestId = ++ocrCheckRequestRef.current;
    void (async () => {
      try {
        await localEngineAdapter.health();
        if (!active || !mountedRef.current) return;
        setEngineStatus('ready');
        try {
          const result = await localEngineAdapter.ocrHealth(false);
          if (!active || !mountedRef.current || requestId !== ocrCheckRequestRef.current) return;
          setOcrState(ocrStateFromHealth(result, false));
        } catch (error: unknown) {
          if (!active || !mountedRef.current || requestId !== ocrCheckRequestRef.current) return;
          setOcrState(ocrStateFromHealthError(error));
        }
      } catch {
        if (active && mountedRef.current) setEngineStatus('unavailable');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const currentTaskOcrIssue = persistentTasksEnabled
    ? ocrStateFromCurrentTask(taskPanelJob)
    : ocrStateFromBatchFeedback(batchFeedback);
  const taskOcrIssueKey = currentTaskOcrIssue ? JSON.stringify([
    persistentTasksEnabled ? taskPanelJob?.id : batchFeedback?.runId,
    persistentTasksEnabled ? taskPanelJob?.generation : null,
    currentTaskOcrIssue.readiness, currentTaskOcrIssue.code,
  ]) : null;

  const checkOcr = useCallback(async (): Promise<void> => {
    if (!mountedRef.current || engineStatus !== 'ready' || ocrCheckInFlightRef.current) return;
    ocrCheckInFlightRef.current = true;
    const requestId = ++ocrCheckRequestRef.current;
    // This explicit probe supersedes only the failure known when it began.
    // A later failure in another generation remains visible even if this
    // probe's success arrives late.
    setCheckedTaskOcrIssueKey(taskOcrIssueKey);
    setOcrState({ readiness: 'verifying', message: '正在使用应用生成的测试文字检测 OCR。' });
    try {
      const result = await localEngineAdapter.ocrHealth(true);
      if (mountedRef.current && requestId === ocrCheckRequestRef.current) {
        setOcrState(ocrStateFromHealth(result, true));
      }
    } catch (error: unknown) {
      if (mountedRef.current && requestId === ocrCheckRequestRef.current) {
        setOcrState(ocrStateFromHealthError(error));
      }
    } finally {
      if (requestId === ocrCheckRequestRef.current) ocrCheckInFlightRef.current = false;
    }
  }, [engineStatus, taskOcrIssueKey]);

  const readOcrCache = useCallback(async (): Promise<OcrCacheInfo | void> => {
    if (!mountedRef.current || engineStatus !== 'ready' || ocrCacheInFlightRef.current) return;
    ocrCacheInFlightRef.current = true;
    const requestId = ++ocrCacheRequestRef.current;
    try {
      const result = await localEngineAdapter.ocrCacheInfo();
      if (!mountedRef.current || requestId !== ocrCacheRequestRef.current) return;
      setOcrCacheState(result);
      return result;
    } finally {
      if (requestId === ocrCacheRequestRef.current) ocrCacheInFlightRef.current = false;
    }
  }, [engineStatus]);

  const clearOcrCache = useCallback(async (): Promise<OcrCacheClearResult | void> => {
    if (!mountedRef.current || engineStatus !== 'ready' || ocrCacheInFlightRef.current) return;
    ocrCacheInFlightRef.current = true;
    const requestId = ++ocrCacheRequestRef.current;
    try {
      const result = await localEngineAdapter.ocrCacheClear();
      if (!mountedRef.current || requestId !== ocrCacheRequestRef.current) return;
      setOcrCacheState(result);
      return result;
    } finally {
      if (requestId === ocrCacheRequestRef.current) ocrCacheInFlightRef.current = false;
    }
  }, [engineStatus]);

  useEffect(() => {
    if (settingsOpen) {
      settingsWasOpenRef.current = true;
      return;
    }
    if (!settingsWasOpenRef.current) return;
    settingsWasOpenRef.current = false;
    settingsEntryRef.current?.focus();
  }, [settingsOpen]);

  function updateAppSettings(next: AppSettingsV1): void {
    appSettingsRef.current = next;
    setAppSettings(next);
    const result = writeAppSettings(next);
    setSettingsWarning((current) => result.ok
      ? null
      : current ?? `${result.error} 本次运行仍有效。`);
  }

  function resetAppSettings(): void {
    invalidateDirectoryOperations();
    setDirectoryPickerBusy(false);
    const result = clearAppSettings();
    const defaults = { ...DEFAULT_APP_SETTINGS };
    appSettingsRef.current = defaults;
    setAppSettings(defaults);
    setSettingsWarning(result.ok ? null : `${result.error} 本次运行仍有效。`);
    resetDirectoryDraft('lastInputDirectory');
    resetDirectoryDraft('lastOutputDirectory');
  }

  function resetDirectoryDraft(setting: DirectorySetting): void {
    if (setting === 'lastInputDirectory') {
      setInputDirectoryDraftResetToken((value) => value + 1);
      return;
    }
    setOutputDirectoryDraftResetToken((value) => value + 1);
  }

  function beginDirectoryOperation(setting: DirectorySetting): number {
    const revision = directoryOperationRevisionRef.current[setting] + 1;
    directoryOperationRevisionRef.current[setting] = revision;
    return revision;
  }

  function invalidateDirectoryOperations(setting?: DirectorySetting): void {
    if (setting) {
      directoryOperationRevisionRef.current[setting] += 1;
      return;
    }
    directoryOperationRevisionRef.current.lastInputDirectory += 1;
    directoryOperationRevisionRef.current.lastOutputDirectory += 1;
  }

  function isCurrentDirectoryOperation(setting: DirectorySetting, revision: number): boolean {
    return mountedRef.current
      && settingsOpenRef.current
      && directoryOperationRevisionRef.current[setting] === revision;
  }

  function closeSettingsDialog(): void {
    invalidateDirectoryOperations();
    setDirectoryPickerBusy(false);
    setDirectoryPickerError(null);
    resetDirectoryDraft('lastInputDirectory');
    resetDirectoryDraft('lastOutputDirectory');
    setSettingsOpen(false);
  }

  function reportDirectoryValidationFailure(
    setting: DirectorySetting,
    revision: number,
    message: string,
  ): void {
    if (!isCurrentDirectoryOperation(setting, revision)) return;
    setDirectoryPickerError(message);
    resetDirectoryDraft(setting);
  }

  function persistValidatedDirectory(
    setting: DirectorySetting,
    directory: string,
    revision: number,
    draft: string,
  ): void {
    if (!isCurrentDirectoryOperation(setting, revision)) return;
    const currentDirectory = appSettingsRef.current[setting];
    updateAppSettings({ ...appSettingsRef.current, [setting]: directory });
    // A normalized value may equal the previous setting even when the
    // visible draft contained surrounding whitespace or an uncommitted path.
    if (currentDirectory === directory && draft !== directory) resetDirectoryDraft(setting);
  }

  async function commitDirectory(setting: DirectorySetting, draft: string): Promise<void> {
    const revision = beginDirectoryOperation(setting);
    setDirectoryPickerError(null);
    const directory = draft.trim();

    if (!directory) {
      if (!isCurrentDirectoryOperation(setting, revision)) return;
      const currentDirectory = appSettingsRef.current[setting];
      updateAppSettings({ ...appSettingsRef.current, [setting]: null });
      // When the setting was already empty, the value dependency in
      // SettingsDialog does not change, so explicitly reset whitespace drafts.
      if (draft !== '' && currentDirectory === null) resetDirectoryDraft(setting);
      return;
    }

    try {
      const valid = await localEngineAdapter.validateDirectory(directory);
      if (!isCurrentDirectoryOperation(setting, revision)) return;
      if (!valid) {
        reportDirectoryValidationFailure(setting, revision, '目录无效：请输入已存在的文件夹。');
        return;
      }

      persistValidatedDirectory(setting, directory, revision, draft);
    } catch (error: unknown) {
      const message = error instanceof Error && error.message
        ? error.message
        : '无法校验目录。';
      reportDirectoryValidationFailure(setting, revision, `目录校验失败：${message}`);
    }
  }

  async function pickerInitialDirectory(setting: DirectorySetting, draft: string): Promise<string | null> {
    const currentDirectory = appSettingsRef.current[setting];
    const candidate = draft.trim();
    if (!candidate || candidate === currentDirectory) return currentDirectory;

    try {
      return await localEngineAdapter.validateDirectory(candidate)
        ? candidate
        : currentDirectory;
    } catch {
      // A draft that cannot be validated must not prevent the native picker
      // from opening from the last committed directory.
      return currentDirectory;
    }
  }

  async function chooseDirectory(setting: DirectorySetting, draft: string): Promise<void> {
    if (directoryPickerBusy) return;
    const revision = beginDirectoryOperation(setting);
    setDirectoryPickerBusy(true);
    setDirectoryPickerError(null);
    try {
      const initialDirectory = await pickerInitialDirectory(setting, draft);
      if (!isCurrentDirectoryOperation(setting, revision)) return;
      const selectedDirectory = await localEngineAdapter.pickDirectory(initialDirectory);
      if (!isCurrentDirectoryOperation(setting, revision)) return;
      const directory = selectedDirectory?.trim() || null;
      if (!directory) return;

      let valid: boolean;
      try {
        valid = await localEngineAdapter.validateDirectory(directory);
      } catch (error: unknown) {
        const message = error instanceof Error && error.message
          ? error.message
          : '无法校验目录。';
        reportDirectoryValidationFailure(setting, revision, `目录校验失败：${message}`);
        return;
      }
      if (!isCurrentDirectoryOperation(setting, revision)) return;
      if (!valid) {
        reportDirectoryValidationFailure(setting, revision, '目录无效：请输入已存在的文件夹。');
        return;
      }
      persistValidatedDirectory(setting, directory, revision, draft);
    } catch (error: unknown) {
      const message = error instanceof Error && error.message
        ? error.message
        : '无法打开目录选择器。';
      if (isCurrentDirectoryOperation(setting, revision)) {
        setDirectoryPickerError(`选择目录失败：${message}`);
      }
    } finally {
      if (isCurrentDirectoryOperation(setting, revision)) setDirectoryPickerBusy(false);
    }
  }

  const selectedSegment = useMemo(
    () => reviewSegments.find((segment) => segment.id === selectedId) ?? null,
    [reviewSegments, selectedId],
  );
  const activeDocument = navigation.activeDocument;
  const previewLocation = navigation.previewLocation;
  const selectedSourceGeometry = selectedSegment ? sourceGeometryById[selectedSegment.id] : undefined;
  const visibleSegment = selectedSegment
    && activeDocument
    && previewLocation
    && normalizeSourcePath(selectedSegment.sourcePath) === normalizeSourcePath(activeDocument.sourcePath)
    && selectedSegment.sourcePage === previewLocation.page
    ? selectedSegment
    : null;
  const currentSegmentLabel = visibleSegment
    ? `当前片段：第 ${visibleSegment.sourcePage} 页 / 片段 ${visibleSegment.segmentNo}`
    : undefined;
  const visibleSourceGeometry = visibleSegment ? sourceGeometryById[visibleSegment.id] : undefined;
  const visibleSourceDocument = visibleSegment
    ? sourceDocumentForSegment(navigation.documents, visibleSegment)
    : null;
  const visibleHasSourceGeometry = Boolean(
    visibleSegment
      && segmentMatchesSourceDocument(visibleSegment, visibleSourceDocument)
      && segmentHasValidSourceGeometry(visibleSegment, visibleSourceGeometry),
  );
  const visibleEditorRect = visibleSegment && visibleHasSourceGeometry
    ? safeEditorRect(visibleSegment)
    : null;
  const previewIdentityMatches = Boolean(
    activeDocument
      && previewLocation
      && pagePreview
      && pagePreviewIdentityRef.current?.documentKey === activeDocument.key
      && pagePreviewIdentityRef.current.page === previewLocation.page
      && pagePreview.page === previewLocation.page
      && pagePreview.page_count === activeDocument.pageCount,
  );
  // Never hand a stale physical-page image to the editor. During a page or
  // source switch the previous page may remain in React state for one render;
  // exposing it here would also expose its old crop editor until revalidation
  // finishes. The page itself is still rendered once the current identity is
  // established (including page-level validation errors).
  const previewForDisplay = previewIdentityMatches
    && visibleSourceGeometry?.previewError !== PREVIEW_PAGE_MISMATCH
    ? pagePreview
    : null;
  const previewReadyForActions = !previewLoading && previewIdentityMatches;
  previewLoadingRef.current = previewLoading;
  previewReadyForActionsRef.current = previewReadyForActions;
  const selectedSegmentGateError = selectedSegment
    && visibleSegment
    && (!selectedSourceGeometry || !selectedSourceGeometry.matchValid || !selectedSourceGeometry.pageValid)
    ? '命中数据无效，不能确认或裁剪。'
    : '';
  const centralPreviewError = previewError || visibleSourceGeometry?.previewError || selectedSegmentGateError;
  const duplicateSourceNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of sourceFiles) counts.set(file.name, (counts.get(file.name) ?? 0) + 1);
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
  }, [sourceFiles]);
  const sourceFileForPath = (sourcePath: string): SourceFile | undefined => (
    sourceFiles.find((file) => normalizeSourcePath(file.path ?? file.relativePath ?? file.name) === normalizeSourcePath(sourcePath))
  );
  const reviewResultSources = useMemo<ReviewResultSource[]>(() => (
    persistent.current && persistent.current.id === appliedSearch?.taskId
      ? persistent.current.sources.map((source) => ({ key: source.source_key, label: source.name }))
      : navigation.documents.map((document) => ({
      key: normalizeSourcePath(document.sourcePath),
      label: duplicateSourceNames.has(document.name) ? document.sourcePath : document.name,
    }))
  ), [appliedSearch?.taskId, duplicateSourceNames, navigation.documents, persistent.current]);
  const reviewPairing = useMemo(
    () => buildReviewMatchPairs(engineMatches, reviewSegments),
    [engineMatches, reviewSegments],
  );
  const selectedSourceReferences = useMemo(
    () => sourceFiles
      .filter((file): file is SourceFile & { path: string } => Boolean(file.path?.trim()))
      .map((file) => ({ sourcePath: file.path })),
    [sourceFiles],
  );
  const sourceDocumentIntegrity = useMemo(
    () => validateSourceDocumentIntegrity(selectedSourceReferences, navigation.documents),
    [navigation.documents, selectedSourceReferences],
  );
  const allDocumentsValid = sourceDocumentIntegrity.ok;
  const reviewSetIntegrity = useMemo(
    () => validateReviewSetIntegrity(
      navigation.documents,
      engineMatches.map((match) => ({
        sourceKey: match.source_key,
        sourcePath: match.source_path ?? '',
        sourcePage: match.page,
        sourceSha256: match.source_sha256 ?? '',
      })),
      reviewSegments.map((segment) => ({
        id: segment.id,
        sourceKey: segment.sourceKey,
        sourcePath: segment.sourcePath,
        sourcePage: segment.sourcePage,
        sourceSha256: segment.sourceSha256,
        segmentNo: segment.segmentNo,
      })),
    ),
    [engineMatches, navigation.documents, reviewSegments],
  );
  const reviewPairingError = searchLoading || analysisLoading
    ? undefined
    : reviewPairing.error ?? (reviewSetIntegrity.ok ? undefined : reviewSetIntegrity.message);
  const criteriaKeywordsById = useMemo(() => {
    if (!appliedCriteria) return new Map<string, string>();
    return new Map([
      ...appliedCriteria.include.map((keyword, index) => [`include-${index}`, keyword] as const),
      ...appliedCriteria.exclude.map((keyword, index) => [`exclude-${index}`, keyword] as const),
    ]);
  }, [appliedCriteria]);
  const appliedCriteriaSummary = appliedCriteria ? searchCriteriaSummary(appliedCriteria) : '';
  const reviewRows = useMemo<ReviewNavigatorRow[]>(() => {
    // Do not render hit text while either pairing layer reports a mismatch.
    // Showing a partial list could associate a keyword with the wrong crop
    // even though the export gate is correctly blocking the operation.
    if (reviewPairing.error || reviewPairingError) return [];
    return reviewPairing.pairs.map(({ hit, segment }) => {
      const sourceGeometry = sourceGeometryById[segment.id];
      const sourceFile = sourceFileForPath(segment.sourcePath);
      const sourceName = segment.sourceName ?? sourceFile?.name ?? segment.sourcePath.split(/[\\/]/).pop() ?? segment.sourcePath;
      const sourceAccessibleLabel = segment.sourceKey
        ? `${sourceName} (${segment.sourceKey})`
        : duplicateSourceNames.has(sourceName)
        ? sourceFile?.relativePath || sourceFile?.path || sourceName
        : sourceName;
      const evidence = evidenceById[segment.id] ?? [hit as SourceMatch];
      const matchedKeywords = [...new Set(evidence
        .filter((item) => item.role === undefined || item.role === 'include')
        .map((item) => item.query_id ? criteriaKeywordsById.get(item.query_id) : '')
        .filter((keyword): keyword is string => Boolean(keyword)))];
      if (matchedKeywords.length === 0 && evidence.length > 0) {
        const fallbackKeyword = appliedCriteria?.include[0];
        if (fallbackKeyword) matchedKeywords.push(fallbackKeyword);
      }
      const matchedTexts = [...new Set(evidence
        .filter((item) => item.role === undefined || item.role === 'include')
        .map((item) => item.matched_text.trim())
        .filter(Boolean))];
      return {
        id: segment.id,
        sourceKey: segment.sourceKey ?? normalizeSourcePath(segment.sourcePath),
        sourcePage: segment.sourcePage,
        segmentNo: segment.segmentNo,
        sourceName,
        sourceAccessibleLabel,
        matchedField: hit.matched_field ?? '命中文本',
        matchedText: matchedTexts.join('、') || (hit.matched_text ?? ''),
        matchedKeywords: matchedKeywords.join('、'),
        confidence: segment.confidence,
        reviewStatus: segment.reviewStatus,
        manualAdjusted: segment.manualAdjusted,
        mode: segment.mode,
        previewStatus: sourceGeometry?.previewStatus ?? 'pending',
        previewError: sourceGeometry?.previewError,
      };
    });
  }, [appliedCriteria, criteriaKeywordsById, duplicateSourceNames, evidenceById, reviewPairing.error, reviewPairing.pairs, reviewPairingError, sourceFiles, sourceGeometryById]);
  const unresolvedIds = useMemo(() => new Set(reviewSegments.filter((segment) => segment.reviewStatus !== 'confirmed'
    || !segmentHasValidSourceGeometry(segment, sourceGeometryById[segment.id])
    || (segment.mode !== 'full_page' && !isLegalRect(segment.finalRect, segment.pageWidth, segment.pageHeight)))
    .map((segment) => segment.id)), [reviewSegments, sourceGeometryById]);
  const unresolvedCount = unresolvedIds.size;
  const visibleReviewIds = new Set(deriveReviewResultView(reviewRows, { sourceKey: reviewSourceFilter,
    filter: reviewFilter, sort: reviewSortOrder }).visibleRows.map((row) => row.id));
  const visibleUnresolvedCount = [...unresolvedIds].filter((id) => visibleReviewIds.has(id)).length;
  const exportScopeSources = useMemo(() => {
    const counts = new Map<string, number>();
    for (const segment of reviewSegments) {
      const key = segment.sourceKey ?? segment.sourcePath;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const names = new Map(persistent.current?.sources.map((source) => [source.source_key, source.name]));
    return (reviewSessionRef.current?.original.context.sources ?? []).map((source) => ({ key: source.source_key,
      name: names.get(source.source_key) ?? source.source_path.split(/[\\/]/).pop() ?? source.source_key,
      segmentCount: counts.get(source.source_key) ?? 0 }));
  }, [reviewSegments, persistent.current]);
  const exportScopeResolution = useMemo(() => resolveExportScope(reviewSegments,
    exportScopeSources.map((source) => source.key), exportScope, unresolvedIds),
  [reviewSegments, exportScopeSources, exportScope, unresolvedIds]);
  const automaticCandidate = reviewSessionRef.current?.original.originals.find((item) => item.id === visibleSegment?.id);
  const canRestoreAutomaticCandidate = Boolean(automaticCandidate && (automaticCandidate.auto_full_page
    || isLegalRect(automaticCandidate.candidate_rect, automaticCandidate.page_width, automaticCandidate.page_height)));
  const hasReadableSources = sourceFiles.some((file) => Boolean(file.path));
  const groupReady = canConfirmGroup(reviewSegments)
    && reviewSegments.length > 0
    && allDocumentsValid
    && reviewSegments.every((segment) => segmentHasValidSourceGeometry(segment, sourceGeometryById[segment.id]))
    && !reviewPairingError;
  const isGroupConfirmed = groupConfirmed && groupReady && !groupSavePending && !reviewSavePending && !unsavedReviewMessage;
  const isRunning = analysisState.phase === 'running' || (persistentTasksEnabled && (persistent.busy || batchIsActive(persistent.current)));
  const editingAppliedSearch = searchEditorOpen && appliedSearch !== null;
  const searchModificationDisabled = isRunning || groupSavePending || reviewSavePending || workspaceLocked;
  // The legacy in-memory runner supports explicitly replacing an in-flight
  // search. Persistent jobs must instead be paused/cancelled before replacing.
  const newTaskDisabled = workspaceLocked || (persistentTasksEnabled && isRunning);
  const reviewFrozen = editingAppliedSearch || isRunning || groupSavePending || reviewSavePending || Boolean(unsavedReviewMessage) || workspaceLocked;
  const navigationDisabled = workspaceLocked || (isRunning && appliedSearch === null);
  const reviewViewControlsDisabled = navigationDisabled || isRunning || groupSavePending;
  const searchModificationDisabledReason = groupSavePending
    ? '正在保存整组审核，暂不能修改搜索条件'
    : previewGenerating
      ? '正在生成 PDF 导出预览，暂不能修改搜索条件'
      : exportInFlight
        ? '正在导出，暂不能修改搜索条件'
        : exportPreview
          ? '请先返回调整，再修改搜索条件'
          : undefined;
  const reviewNavigatorEmptyMessage = !hasReadableSources
    ? '请先选择 PDF 或文件夹，再开始分析。'
    : analysisState.phase === 'completed'
      && reviewSegments.length === 0
      && !reviewPairingError
      ? '未找到符合条件的回单'
      : undefined;
  const showEmptySearchAction = Boolean(
    appliedSearch
    && reviewRows.length === 0
    && !searchEditorOpen
    && !isRunning
    && !searchModificationDisabled,
  );
  const reviewFrozenReason = editingAppliedSearch
    ? isRunning ? '正在重新分析，上次结果暂停审核' : '修改完成前暂停审核'
    : groupSavePending ? '正在保存整组审核'
      : reviewSavePending ? '正在保存审核修改'
        : unsavedReviewMessage ? '有未保存的审核修改，请重试保存或放弃修改'
      : previewGenerating ? '正在生成 PDF 导出预览' : undefined;
  reviewFrozenRef.current = reviewFrozen;
  const searchPanelFeedback = useMemo<ActionFeedback>(() => {
    if (analysisState.phase === 'running') {
      return {
        kind: 'status',
        message: analysisState.step === 'search' ? '正在搜索源 PDF…' : '搜索完成，正在分析页面…',
      };
    }
    if (analysisNotice?.kind === 'error') return analysisNotice;
    const analysisError = 'error' in analysisState ? analysisState.error : undefined;
    return analysisError ? feedbackFor(`本地搜索失败：${analysisError}`) : null;
  }, [analysisNotice, analysisState]);
  const searchEditorExpanded = searchEditorOpen || searchPanelFeedback?.kind === 'error';
  const sourcePanelFiles = sourceFiles.map((file) => {
    const sourcePath = file.path ?? file.relativePath;
    const document = navigation.documents.find((item) => normalizeSourcePath(item.sourcePath) === normalizeSourcePath(sourcePath));
    return {
      key: normalizeSourcePath(sourcePath),
      name: file.name,
      sourcePath,
      size: file.size,
      pageCount: document?.pageCount ?? null,
      integrityStatus: document?.integrityStatus ?? null,
    };
  });
  const sourcePanelNotice = sourceNotice;
  function isCurrentExportSnapshot(snapshot: ExportPreviewSnapshot): boolean {
    return mountedRef.current
      && reviewTaskIdRef.current === snapshot.taskId
      && reviewRevisionRef.current === snapshot.reviewRevision
      && sourceIntegrityRevisionRef.current === snapshot.sourceIntegrityRevision
      && sameExportSources(exportSourcesRef.current, snapshot.sources)
      && reviewExportFingerprint(reviewSegmentsRef.current) === snapshot.reviewFingerprint;
  }

  async function closeExportBundle(intentId: string): Promise<boolean> {
    try { await exportBundleClient.close(intentId); return true; }
    catch { return false; }
  }

  function clearExportPreview(cleanup = true): void {
    const current = exportPreviewRef.current;
    exportPreviewRef.current = null;
    setExportPreview(null);
    setExportPreviewPage(1);
    setExportPreviewImage('');
    setExportPreviewLoading(false);
    setExportPreviewError('');
    setExportPreviewRetry(0);
    setExportFeedback(null);
    setIncludeXlsx(false);
    if (cleanup && current) void closeExportBundle(current.bundle.intent_id);
  }

  useEffect(() => {
    if (!exportScopeOpen) return;
    const host = exportScopeHostRef.current;
    if (!host) return;
    const previousFocus = document.activeElement;
    const siblings = Array.from(host.parentElement?.children ?? []).filter((item): item is HTMLElement => item instanceof HTMLElement && item !== host);
    const previousInert = siblings.map((item) => item.inert);
    siblings.forEach((item) => { item.inert = true; });
    const controls = () => Array.from(host.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]'));
    controls()[0]?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!exportInFlightRef.current) setExportScopeOpen(false);
      } else if (event.key === 'Tab') {
        const items = controls();
        if (!items.length) { event.preventDefault(); return; }
        const current = items.indexOf(document.activeElement as HTMLElement);
        if ((event.shiftKey && current <= 0) || (!event.shiftKey && (current < 0 || current === items.length - 1))) {
          event.preventDefault();
          (event.shiftKey ? items.at(-1) : items[0])?.focus();
        }
      }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('keydown', keyboard, true);
      siblings.forEach((item, index) => { item.inert = previousInert[index]; });
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [exportScopeOpen]);

  useEffect(() => {
    if (!persistentTasksEnabled || !reviewTaskId) return;
    let active = true;
    void exportBundleClient.status(reviewTaskId).then((status) => {
      if (!active || reviewTaskIdRef.current !== reviewTaskId || exportInFlightRef.current) return;
      if (status.publication) adoptExportReceipt(status.publication, true);
      if (status.residuals.length) setExportNotice(`上次导出仍有未清理内容：${status.residuals.map((item) => `${item.path}（${item.reason}）`).join('；')}`);
    }).catch((error) => {
      if (active && reviewTaskIdRef.current === reviewTaskId) setExportNotice(`检查上次导出未完成：${error instanceof Error ? error.message : '未知错误'}`);
    });
    return () => { active = false; };
  }, [reviewTaskId, persistentTasksEnabled, exportBundleClient]);

  function resetReviewResults(notice?: string): void {
    setTaskPanelRequest(null);
    closeBatchCrop(true);
    setExportScopeOpen(false);
    setExportScopeError(null);
    resetReviewOperationHistory();
    persistentLoadAbortRef.current?.abort();
    autoOpenJobRef.current = null;
    persistentController.clearSelection();
    batchRunner.clear();
    setRetryState(null);
    searchRequestIdRef.current += 1;
    searchInFlightRef.current = false;
    dispatchBatchFeedback({ type: 'clear' });
    reviewRevisionRef.current += 1;
    previewGenerationRef.current += 1;
    previewRequestEpochRef.current += 1;
    pagePreviewCacheRef.current.clear();
    pagePreviewOwnerRef.current.clear();
    pagePreviewIdentityRef.current = null;
    previewRunRef.current += 1;
    clearExportPreview();
    groupSaveRequestRef.current += 1;
    reviewTaskIdRef.current = null;
    reviewSessionRef.current = null;
    setLegacySuggestions({});
    reviewViewBeforeExportRef.current = null;
    exportInFlightRef.current = false;
    setEngineMatches([]);
    setEvidenceById({});
    setReviewSegments([]);
    setSourceGeometryById({});
    setSelectedId(null);
    setReviewFilter('all');
    setReviewSourceFilter(null);
    setReviewSortOrder('original');
    setSourceNotice(null);
    setAnalysisNotice(null);
    setReviewFeedback(null);
    setAnalysisErrorCount(0);
    setInvalidInputCount(0);
    setSearchLoading(false);
    setAnalysisLoading(false);
    setGroupConfirmed(false);
    groupSavePendingRef.current = false;
    setGroupSavePending(false);
    setExportInFlight(false);
    setPreviewGenerating(false);
    setExportResult(null);
    setPagePreview(null);
    setPreviewLoading(false);
    setPreviewError('');
    setPreviewRetry(0);
    setSearchEditorOpen(true);
    const defaults = appSettingsRef.current;
    setSearchDraft(createInitialSearchSettings(defaults));
    setZoom(defaults.defaultPreviewZoom);
    setExportPreviewZoom(defaults.defaultPreviewZoom);
    setAppliedSearch(null);
    if (notice !== undefined) setSourceNoticeMessage(notice);
  }

  function resetForSourceChange(notice: string, sources: readonly SearchSource[] = []): void {
    resetReviewResults();
    if (sources.length > 0) navigation.replaceSources(sources);
    else navigation.clearSources();
    dispatchAnalysis({ type: 'sources_replaced' });
    setSourceNoticeMessage(notice);
  }

  function cleanupData<T>(response: BatchResponse<T>): T {
    if (response.status === 'error') throw new Error(response.message);
    return response.data;
  }

  async function readCleanupStatus(append = false): Promise<void> {
    const offset = append ? cleanupNextOffset : 0;
    if (offset === null) return;
    const results = await Promise.allSettled([
      persistentController.client.listCleanups(offset, 20),
      persistentController.client.storageUsage(),
    ]);
    if (!mountedRef.current) return;
    const [historyResult, usageResult] = results;
    const errors: string[] = [];
    if (historyResult.status === 'fulfilled') {
      try {
        const page = cleanupData(historyResult.value);
        setCleanupHistory((previous) => append
          ? [...new Map([...previous, ...page.items].map((item) => [item.cleanup_id, item])).values()]
          : page.items);
        setCleanupNextOffset(page.next_offset);
        for (const item of page.items) {
          if (item.task_data_state === 'deleted') persistentController.forgetDeleted(item.job_id);
        }
      } catch (error) { errors.push(error instanceof Error ? error.message : '无法读取清理记录。'); }
    } else errors.push('无法读取清理记录，请刷新后重试。');
    if (usageResult.status === 'fulfilled') {
      try { setCleanupUsage(cleanupData(usageResult.value)); }
      catch { setCleanupUsage(null); errors.push('无法读取空间占用。'); }
    } else { setCleanupUsage(null); errors.push('无法读取空间占用。'); }
    if (errors.length) setCleanupError(errors.join(' '));
  }

  async function runCleanupOperation(operation: () => Promise<void>): Promise<void> {
    if (cleanupBusyRef.current) return;
    cleanupBusyRef.current = true;
    workspaceLockedRef.current = true;
    setCleanupBusy(true);
    setCleanupError(null);
    try { await operation(); }
    catch (error) {
      if (mountedRef.current) setCleanupError(error instanceof Error ? error.message : '任务清理未完成，请刷新后重试。');
    } finally {
      cleanupBusyRef.current = false;
      if (mountedRef.current) setCleanupBusy(false);
    }
  }

  function openCleanupStatus(): void {
    if (cleanupBusyRef.current) return;
    setCleanupOpen(true);
    setCleanupPlan(null);
    void runCleanupOperation(() => readCleanupStatus());
  }

  async function planTaskCleanup(jobId: string): Promise<void> {
    if (workspaceLockedRef.current || groupSavePendingRef.current || searchInFlightRef.current
      || persistentController.getSnapshot().busy || batchIsActive(persistentController.getSnapshot().current)) return;
    setCleanupOpen(true);
    setCleanupPlan(null);
    await runCleanupOperation(async () => {
      await reviewCoordinator.drain();
      if (!mountedRef.current) return;
      const plan = cleanupData(await persistentController.client.planCleanup(jobId));
      if (!mountedRef.current) return;
      setCleanupPlan(plan);
      await readCleanupStatus();
    });
  }

  async function executeTaskCleanup(plan: BatchCleanup, deleteReview: boolean): Promise<void> {
    if (workspaceLockedRef.current || groupSavePendingRef.current || searchInFlightRef.current
      || persistentController.getSnapshot().busy || batchIsActive(persistentController.getSnapshot().current)) return;
    await runCleanupOperation(async () => {
      // Finish submitted saves before clearing their view identity. The native
      // service separately verifies the worker lease and final preview lifecycle.
      await reviewCoordinator.drain();
      if (!mountedRef.current) return;
      if (reviewTaskIdRef.current === plan.job_id || persistentController.getSnapshot().current?.id === plan.job_id) {
        sourcePickerRequestRef.current += 1;
        resetReviewResults('任务工作台已关闭；原始 PDF 和已导出文件保持不变。');
        navigation.clearSources();
        setSourceFiles([]);
        dispatchAnalysis({ type: 'sources_replaced' });
      }
      try {
        const result = cleanupData(await persistentController.client.executeCleanup(plan.cleanup_id, deleteReview));
        if (!mountedRef.current) return;
        setCleanupPlan(result);
        if (result.task_data_state === 'deleted') persistentController.forgetDeleted(result.job_id);
      } finally {
        if (mountedRef.current) {
          await readCleanupStatus();
          await persistentController.refreshList();
        }
      }
    });
  }

  async function maintainTaskStorage(): Promise<void> {
    if (workspaceLockedRef.current || groupSavePendingRef.current || searchInFlightRef.current
      || persistentController.getSnapshot().busy || batchIsActive(persistentController.getSnapshot().current)) return;
    await runCleanupOperation(async () => {
      const result = cleanupData(await persistentController.client.maintainStorage());
      if (!mountedRef.current) return;
      setCleanupUsage(result.usage);
      if (result.outcome === 'failed') setCleanupError('空间回收暂未完成；已完成的任务清理仍然有效，可空闲时重试。');
    });
  }

  async function prepareSourcePreviews(sources: readonly SearchSource[]): Promise<void> {
    const requestId = ++sourcePickerRequestRef.current;
    const readableSources = sources.filter((source) => source.sourcePath.trim());
    // Browser fallback paths are not readable by the local engine. The
    // desktop runtime marker also keeps mocked browser tests from starting an
    // extra render request before the explicit analysis flow.
    if (
      readableSources.length === 0
      || engineStatus !== 'ready'
      || typeof window === 'undefined'
      || !('__TAURI_INTERNALS__' in window)
    ) return;
    const documents: SourceDocument[] = [];
    for (const source of readableSources) {
      try {
        const metadata = await localEngineAdapter.inspectPdf(source.sourcePath);
        if (requestId !== sourcePickerRequestRef.current || workspaceLockedRef.current) return;
        documents.push({
          key: sourceDocumentKey(source.sourcePath, metadata.source_sha256),
          name: source.name,
          sourcePath: source.sourcePath,
          sourceSha256: metadata.source_sha256.toLowerCase(),
          pageCount: metadata.page_count,
          integrityStatus: 'valid',
        });
      } catch (error: unknown) {
        if (requestId !== sourcePickerRequestRef.current) return;
        setSourceNoticeMessage(error instanceof Error ? error.message : '读取 PDF 元数据失败，暂时无法预览。');
        return;
      }
    }
    if (requestId !== sourcePickerRequestRef.current || documents.length === 0) return;
    commitNavigationDocuments(documents);
  }

  const commitSearchResult = useCallback((commit: SearchResultCommit): void => {
    reviewCoordinator.initializeDecisions(commit.reviewSession, commit.reviewSegments, commit.automaticReviewSegments ?? commit.reviewSegments);
    reviewHistory.reset({ taskId: commit.appliedSearch.taskId, contextKey: commit.reviewSession.prepared.context_key,
      resultRevision: commit.reviewSession.original.resultRevision,
      sourceFingerprint: JSON.stringify(commit.reviewSession.original.context.sources.map((source) => [source.source_key, source.source_sha256])) });
    setReviewHistoryCount(0);
    pendingReviewOperationRef.current = null;
    reviewSavePendingRef.current = false;
    setReviewSavePending(false);
    setUnsavedReviewMessage(undefined);
    reviewRevisionRef.current += 1;
    previewGenerationRef.current += 1;
    previewRequestEpochRef.current += 1;
    previewRunRef.current += 1;
    groupSaveRequestRef.current += 1;
    reviewTaskIdRef.current = commit.appliedSearch.taskId;
    reviewSessionRef.current = commit.reviewSession;
    setLegacySuggestions(commit.legacySuggestions);
    pagePreviewCacheRef.current.clear();
    pagePreviewOwnerRef.current.clear();
    pagePreviewIdentityRef.current = null;
    clearExportPreview();
    reviewViewBeforeExportRef.current = null;
    setPagePreview(null);
    setPreviewError('');
    setPreviewRetry((value) => commit.engineMatches.length === 0 ? value + 1 : 0);
    setSearchLoading(false);
    setPreviewLoading(false);
    setAnalysisLoading(false);
    setEngineMatches(commit.engineMatches);
    setEvidenceById(commit.evidenceById);
    setReviewSegments(commit.reviewSegments);
    setSourceGeometryById(commit.sourceGeometryById);
    setSelectedId(commit.selectedId);
    setReviewFilter('all');
    setReviewSourceFilter(null);
    setReviewSortOrder('original');
    setGroupConfirmed(commit.groupConfirmed);
    groupSavePendingRef.current = false;
    setGroupSavePending(false);
    setAnalysisErrorCount(commit.failedGroups);
    setInvalidInputCount(commit.invalidInputs);
    setReviewFeedback(null);
    setExportResult(null);
    commitNavigationDocuments(commit.documents, commit.reviewSegments[0] ?? null);
    setAppliedSearch(commit.appliedSearch);
    setSearchDraft(cloneSearchSettings(commit.appliedSearch));
    setSearchEditorOpen(false);
  }, [clearExportPreview, commitNavigationDocuments, reviewCoordinator, reviewHistory]);

  const loadLegacySuggestions = useCallback(async (taskId: string, isCurrent: () => boolean): Promise<EngineReviewSegment[]> => {
    const response = await engineProcessSemaphore.run(
      () => localEngineAdapter.loadReviewSegments(taskId),
      isCurrent,
    );
    assertCurrent(isCurrent);
    return response.segments;
  }, []);

  const loadPersistentReview = useCallback(async (job: BatchJobSnapshot): Promise<void> => {
    if (workspaceLockedRef.current || groupSavePendingRef.current || searchInFlightRef.current
      || job.deletion_pending || !['ready_for_review', 'archived'].includes(job.state) || !job.result_revision) return;
    persistentLoadAbortRef.current?.abort();
    const abort = new AbortController();
    persistentLoadAbortRef.current = abort;
    const requestId = ++searchRequestIdRef.current;
    sourcePickerRequestRef.current += 1;
    searchInFlightRef.current = true;
    const integrityRevision = sourceIntegrityRevisionRef.current;
    const isCurrent = () => mountedRef.current && !abort.signal.aborted && requestId === searchRequestIdRef.current
      && integrityRevision === sourceIntegrityRevisionRef.current
      && persistentController.getSnapshot().current?.id === job.id
      && persistentController.getSnapshot().current?.generation === job.generation;
    dispatchAnalysis({ type: 'run_started' });
    setSearchLoading(true);
    setAnalysisNoticeMessage('正在载入完整任务结果并核验原始 PDF…');
    try {
      const items = await persistentController.client.loadAllResults(job.id, job.result_revision, abort.signal);
      assertCurrent(isCurrent);
      const mapped = mapBatchReview(job, items);
      const session = await reviewCoordinator.prepareTrusted(
        () => persistentController.client.prepareReview(job, items, abort.signal), isCurrent);
      assertCurrent(isCurrent);
      const latest = await persistentController.client.snapshot({ job_id: job.id }, abort.signal);
      if (latest.status !== 'ok' || latest.data.state !== job.state || latest.data.deletion_pending
        || latest.data.generation !== job.generation || latest.data.result_revision !== job.result_revision
        || JSON.stringify(latest.data.sources.map((source) => [source.source_key, source.access_path, source.sha256]))
          !== JSON.stringify(job.sources.map((source) => [source.source_key, source.access_path, source.sha256]))) {
        throw new Error('任务来源或结果已变化，请重新载入。');
      }
      assertCurrent(isCurrent);
      const merged = mergeCompatibleReviews(mapped.segments, session.prepared);
      setSourceFiles(persistentSourceFiles(job));
      commitSearchResult({ appliedSearch: { criteria: job.criteria, matchMode: job.match_mode, taskId: job.id },
        reviewSession: session, legacySuggestions: {}, documents: mapped.documents, engineMatches: mapped.matches,
        evidenceById: mapped.evidenceById, reviewSegments: merged.segments, automaticReviewSegments: mapped.segments, sourceGeometryById: mapped.geometryById,
        selectedId: merged.segments[0]?.id ?? null, groupConfirmed: merged.groupConfirmed, failedGroups: 0, invalidInputs: 0 });
      dispatchAnalysis({ type: 'run_succeeded' });
      setAnalysisNoticeMessage(`任务已载入：${merged.segments.length} 个审核片段。${session.prepared.segments.length > 0
        ? `已恢复 ${session.prepared.segments.length} 个审核决定。` : ''}`);
      setTaskHistoryOpen(false);
    } catch (error) {
      if (mountedRef.current && !abort.signal.aborted && requestId === searchRequestIdRef.current) {
        const message = integrityRevision !== sourceIntegrityRevisionRef.current
          ? '原始文件的校验状态已变化，请重新载入任务。'
          : error instanceof Error ? error.message : '审核结果载入失败。';
        setAnalysisNoticeMessage(`审核结果载入失败：${message} 已完成的任务仍保留，可在历史任务中重新载入。`);
        dispatchAnalysis({ type: 'run_failed', error: message });
        setTaskPanelView('current');
        setTaskHistoryOpen(true);
      }
    } finally {
      if (requestId === searchRequestIdRef.current) {
        searchInFlightRef.current = false;
        setSearchLoading(false);
        setAnalysisLoading(false);
      }
    }
  }, [commitSearchResult, persistentController, reviewCoordinator]);

  useEffect(() => {
    if (!persistentTasksEnabled || persistent.busy) return;
    const job = persistent.current;
    if (job?.state === 'ready_for_review' && autoOpenJobRef.current === job.id) {
      autoOpenJobRef.current = null;
      void loadPersistentReview(job);
    }
  }, [loadPersistentReview, persistent.busy, persistent.current, persistentTasksEnabled]);

  async function selectPersistentTask(id: string): Promise<void> {
    if (workspaceLockedRef.current || groupSavePendingRef.current || searchInFlightRef.current
      || persistentController.getSnapshot().busy || batchIsActive(persistentController.getSnapshot().current)) return;
    resetReviewResults();
    navigation.clearSources();
    dispatchAnalysis({ type: 'sources_replaced' });
    const job = await persistentController.select(id);
    if (!job || !mountedRef.current) return;
    setTaskPanelRequest(null);
    setTaskPanelView('current');
    const files = persistentSourceFiles(job);
    setSourceFiles(files);
    setSearchDraft({ criteria: job.criteria, matchMode: job.match_mode });
    navigation.replaceSources(files.map(sourceSelectionForFile));
    if (job.state === 'ready_for_review' || job.state === 'archived') await loadPersistentReview(job);
    else void prepareSourcePreviews(files.map(sourceSelectionForFile));
  }

  async function relocatePersistentSource(sourceId: string): Promise<void> {
    if (workspaceLockedRef.current || groupSavePendingRef.current || searchInFlightRef.current) return;
    const before = persistentController.getSnapshot().current;
    if (!before || batchIsActive(before)) return;
    try {
      const picked = await localEngineAdapter.pickPdfFiles(appSettingsRef.current.lastInputDirectory);
      if (picked.files.length === 0) return;
      if (picked.files.length !== 1) throw new Error('请一次选择一份内容相同的原始 PDF。');
      if (persistentController.getSnapshot().current !== before || workspaceLockedRef.current) return;
      await persistentController.relocate(sourceId, picked.files[0]!);
      // Reload selection through the same invalidation path as a task switch.
      const relocated = persistentController.getSnapshot().current;
      if (relocated && relocated !== before) {
        await selectPersistentTask(relocated.id);
      }
    } catch (error) { setAnalysisNoticeMessage(error instanceof Error ? error.message : '定位原始文件失败。'); }
  }

  const runPersistentSearch = useCallback(async (files: SourceFile[], draft: SearchSettings): Promise<void> => {
    if (workspaceLockedRef.current || groupSavePendingRef.current || searchInFlightRef.current
      || batchIsActive(persistentController.getSnapshot().current) || persistentController.getSnapshot().busy) return;
    const criteria = normalizeSearchCriteria(draft.criteria);
    if (!criteria || engineStatus !== 'ready') return;
    const sources = files.filter((file) => file.path?.trim()).map((file) => ({ source_path: file.path!.trim(), name: file.name }));
    if (sources.length === 0) return;
    sourcePickerRequestRef.current += 1;
    searchInFlightRef.current = true;
    setTaskPanelRequest({ previousId: persistentController.getSnapshot().current?.id ?? null });
    setTaskPanelView('current');
    setTaskHistoryOpen(true);
    setAnalysisNotice(null);
    dispatchBatchFeedback({ type: 'clear' });
    try {
      searchCriteriaClauses(criteria);
      const history = recordSearchKeywordHistory(keywordHistoryRef.current, criteria);
      keywordHistoryRef.current = history;
      setKeywordHistory(history);
      const running = await persistentController.create({ name: `${sources[0]!.name}${sources.length > 1 ? ` 等 ${sources.length} 份 PDF` : ''}`,
        sources, criteria, match_mode: draft.matchMode });
      if (running) autoOpenJobRef.current = running.id;
    } catch (error) {
      setAnalysisNoticeMessage(error instanceof Error ? error.message : '创建任务失败。');
    } finally { searchInFlightRef.current = false; }
  }, [engineStatus, persistentController]);

  const runSearch = useCallback(async (files: SourceFile[], rawDraft: SearchSettings, retryFailed = false) => {
    if (persistentTasksEnabled) return runPersistentSearch(files, rawDraft);
    const criteria = normalizeSearchCriteria(rawDraft.criteria);
    const mode = rawDraft.matchMode;
    if (workspaceLockedRef.current || groupSavePendingRef.current || searchInFlightRef.current) return;
    // An explicit analysis run supersedes any still-pending pre-analysis
    // metadata request. Otherwise a late preview commit could advance the
    // navigation integrity revision while the search transaction is running.
    sourcePickerRequestRef.current += 1;
    const sourceInputs = files.reduce<Array<{ name: string; sourcePath: string }>>((accumulator, file) => {
      if (!file.path || !file.path.trim()) return accumulator;
      const sourcePath = file.path.trim();
      if (accumulator.some((source) => normalizeSourcePath(source.sourcePath) === normalizeSourcePath(sourcePath))) {
        return accumulator;
      }
      accumulator.push({ name: file.name, sourcePath });
      return accumulator;
    }, []);
    const sourcePaths = sourceInputs.map((source) => source.sourcePath);
    if (sourcePaths.length === 0 || !criteria || engineStatus !== 'ready') return;
    const taskId = reviewTaskIdFor(files, criteria, mode);
    if (!taskId) return;

    const replacingAppliedSearch = appliedSearch !== null;
    searchInFlightRef.current = true;
    const requestId = ++searchRequestIdRef.current;
    const isCurrent = () => mountedRef.current && requestId === searchRequestIdRef.current;
    let feedbackClosed = false;
    let hasOperationFailures = false;
    let feedbackStage: BatchStage = 'search';
    const observedSourceChanges = new Map<string, { sourcePath: string; message: string }>();
    const observe: BatchObserver = (event) => {
      if (!isCurrent() || feedbackClosed) return;
      if (event.type === 'analysis_planned') feedbackStage = 'analysis';
      if (event.type === 'verifying') feedbackStage = 'verifying';
      if (event.type === 'finalizing') feedbackStage = 'finalizing';
      if ('failure' in event && event.failure) {
        hasOperationFailures = true;
        const failure = event.failure;
        if (failure.code === 'source_changed' && failure.sourcePath !== null) {
          const key = normalizeSourcePath(failure.sourcePath);
          if (sourceInputs.some((source) => normalizeSourcePath(source.sourcePath) === key)) {
            observedSourceChanges.set(key, {
              sourcePath: failure.sourcePath, message: failure.detail || failure.message,
            });
          }
        }
      }
      dispatchBatchFeedback({ ...event, runId: requestId });
      if (event.type === 'failed' || event.type === 'completed') feedbackClosed = true;
    };
    dispatchBatchFeedback({ type: 'begin', runId: requestId, sources: sourceInputs });
    const sourceIntegrityRevision = sourceIntegrityRevisionRef.current;
    const isCommitCurrent = () => isCurrent() && sourceIntegrityRevisionRef.current === sourceIntegrityRevision;
    previewRequestEpochRef.current += 1;
    setPreviewRequestEpoch((value) => value + 1);
    const assertCommitCurrent = (): void => {
      assertCurrent(isCurrent);
      if (sourceIntegrityRevisionRef.current !== sourceIntegrityRevision) throw new StaleRunError();
    };
    dispatchAnalysis({ type: 'run_started' });
    setSearchLoading(true);
    setAnalysisLoading(false);
    setAnalysisNoticeMessage(`正在搜索 ${sourcePaths.length} 个 PDF…`);
    let preparedDocuments: SourceDocument[] | null = null;
    const searchedDocuments = new Map<string, SourceDocument>();
    const rememberDocument = (sourcePath: string, result: RawSourceSearch): void => {
      assertCommitCurrent();
      const source = sourceInputs.find((item) => normalizeSourcePath(item.sourcePath) === normalizeSourcePath(sourcePath));
      if (!source) throw new BatchAssemblyError('搜索结果的来源不属于当前批次。');
      try {
        const [document] = buildSourceDocuments([source], [{ sourcePath, result }]);
        if (!document) throw new Error('搜索来源缺少文档元数据。');
        searchedDocuments.set(normalizeSourcePath(sourcePath), document);
        // Retain only metadata for integrity handling, never partial review
        // results. Publish it on failure only under the existing source gate.
        if (searchedDocuments.size === sourceInputs.length) {
          preparedDocuments = sourceInputs.map((item) => searchedDocuments.get(normalizeSourcePath(item.sourcePath))!);
        }
      } catch (error) {
        throw new BatchAssemblyError(error);
      }
    };
    try {
      // Validate before recording; rejected drafts are not submitted searches.
      searchCriteriaClauses(criteria);
      setReviewFilter('all');
      setReviewSourceFilter(null);
      setReviewSortOrder('original');
      const nextKeywordHistory = recordSearchKeywordHistory(keywordHistoryRef.current, criteria);
      keywordHistoryRef.current = nextKeywordHistory;
      setKeywordHistory(nextKeywordHistory);
      if (!retryFailed) batchRunner.clear();
      setRetryState(null);
      const computation = await engineProcessSemaphore.run(() => localEngineAdapter.computationInfo(), isCommitCurrent);
      assertCommitCurrent();
      const executionContext = freezeBatchExecutionContext({
        sources: sourceInputs, criteria, matchMode: mode, computationVersion: computation.computation_version,
      });
      if (retryFailed && !batchRunner.canRetry(executionContext)) {
        setAnalysisNoticeMessage('计算版本或搜索上下文已变化，正在重新分析整批 PDF…');
      }
      batchRunBindingRef.current = { taskId, observe, rememberDocument };
      const outcome = await batchRunner.run(executionContext, { retryFailed, isCurrent: isCommitCurrent });
      assertCommitCurrent();
      if (outcome.status === 'failed') {
        const notice = outcome.reason === 'cache_limit'
          ? '本批结果超过复用上限，下次将整批重新分析。'
          : '成功文件的计算结果仅在本次会话暂存；关闭应用后需重新分析整批。';
        setRetryState({ context: executionContext, count: outcome.retryable ? outcome.failures.length : 0, notice });
        const message = `${outcome.failures.length} 个 PDF 未完成分析。${notice}`;
        observe({ type: 'failed' });
        setAnalysisNoticeMessage(`本地搜索失败：${message}`);
        dispatchAnalysis({ type: 'run_failed', error: message });
        return;
      }
      const responses = outcome.results.map(({ source, search }) => ({ sourcePath: source.sourcePath, result: search }));
      assertCurrent(isCurrent);
      feedbackStage = 'finalizing';
      const documents = buildSourceDocuments(sourceInputs, responses);
      preparedDocuments = documents;
      const documentByPath = new Map(
        documents.map((document) => [normalizeSourcePath(document.sourcePath), document]),
      );
      const matches: SourceMatch[] = responses.flatMap(({ sourcePath, result }, resultIndex) => {
        const document = documentByPath.get(normalizeSourcePath(sourcePath));
        if (!document) throw new Error('搜索来源缺少已校验的文档元数据。');
        return result.matches.map((match) => ({
          ...match,
          source_path: sourcePath,
          source_sha256: document.sourceSha256,
          source_identity: `source-${resultIndex + 1}`,
          page_count: document.pageCount,
        }));
      });
      assertCurrent(isCurrent);

      if (matches.length === 0) {
        observe({ type: 'finalizing' });
        const original = await buildOriginalReviewContext({
          documents, criteria, matchMode: mode, computationVersion: computation.computation_version,
          segments: [], evidenceById: {},
        });
        const reviewSession = await reviewCoordinator.prepare(original, isCommitCurrent);
        assertCommitCurrent();
        commitSearchResult({
          appliedSearch: { criteria, matchMode: mode, taskId },
          reviewSession,
          legacySuggestions: {},
          documents,
          engineMatches: [],
          evidenceById: {},
          reviewSegments: [],
          sourceGeometryById: {},
          selectedId: null,
          groupConfirmed: false,
          failedGroups: 0,
          invalidInputs: 0,
        });
        observe({ type: 'completed', counts: {} });
        setAnalysisNoticeMessage(
          `搜索条件：${searchCriteriaSummary(criteria)}。未找到符合条件的回单。`,
        );
        dispatchAnalysis({ type: 'run_succeeded' });
        return;
      }

      dispatchAnalysis({ type: 'page_analysis_started' });
      setAnalysisLoading(true);
      observe({ type: 'finalizing' });
      setAnalysisNoticeMessage(`核验完成，正在整理 ${matches.length} 个命中结果…`);
      const rawPages = new Map(outcome.results.flatMap(({ source, analysis }) => analysis.map(({ page, analysis: value }) => (
        [`${normalizeSourcePath(source.sourcePath)}\u0000${page}`, value] as const
      ))));
      const result = await analyzeMatches(matches, isCommitCurrent, taskId, criteria, undefined, {
        cached: true,
        read: async (path, page) => {
          const analysis = rawPages.get(`${normalizeSourcePath(path)}\u0000${page}`);
          if (!analysis) throw new Error('完整来源的页面暂存不完整，请重新分析整批。');
          return analysis;
        },
      });
      assertCurrent(isCurrent);
      if (result.failedGroups > 0) {
        throw new ReportedBatchFailure(new Error(`页面分析失败：${result.failedGroups} 个页面未能完成分析。`));
      }
      observe({ type: 'finalizing' });
      // Capture signatures from fresh analysis before applying any saved crop.
      const original = await buildOriginalReviewContext({
        documents, criteria, matchMode: mode, computationVersion: computation.computation_version,
        segments: result.segments, evidenceById: result.evidenceById,
      });
      const persisted = result.segments.length > 0 ? await loadLegacySuggestions(taskId, isCommitCurrent) : [];
      const reviewSession = await reviewCoordinator.prepare(original, isCommitCurrent);
      assertCommitCurrent();
      const merged = mergeCompatibleReviews(result.segments, reviewSession.prepared);
      const suggestions = legacyReviewSuggestions(result.segments, persisted);
      for (const record of reviewSession.prepared.segments) delete suggestions[record.id];
      const restoredSegments = merged.segments;
      const restoredCount = restoredSegments.filter((segment, index) => segment !== result.segments[index]).length;
      const unresolved = restoredSegments.filter((segment) => segment.reviewStatus !== 'confirmed').length;
      const runSummary = searchCriteriaSummary(criteria);
      assertCommitCurrent();
      commitSearchResult({
        appliedSearch: { criteria, matchMode: mode, taskId },
        reviewSession,
        legacySuggestions: suggestions,
        documents,
        engineMatches: result.representativeMatches,
        evidenceById: result.evidenceById,
        reviewSegments: restoredSegments,
        automaticReviewSegments: result.segments,
        sourceGeometryById: result.geometryById,
        selectedId: restoredSegments[0]?.id ?? null,
        groupConfirmed: merged.groupConfirmed,
        failedGroups: result.failedGroups,
        invalidInputs: result.invalidInputs,
      });
      const counts: Record<string, number> = {};
      for (const segment of restoredSegments) counts[segment.sourcePath] = (counts[segment.sourcePath] ?? 0) + 1;
      observe({ type: 'completed', counts });
      setAnalysisNoticeMessage(result.segments.length === 0
        ? `搜索条件：${runSummary}。未找到符合条件的回单（已分析 ${matches.length} 个命中结果，但没有候选回单符合条件）。`
        : result.invalidInputs > 0 || unresolved > 0
          ? `搜索条件：${runSummary}。分析完成：${result.segments.length} 个审核片段，${unresolved} 个未解决。${restoredCount > 0 ? ` 已恢复 ${restoredCount} 个审核片段。` : ''}${result.invalidInputs > 0 ? ` ${result.invalidInputs} 个命中数据无效，已保留为阻塞片段。` : ''}`
          : `搜索条件：${runSummary}。分析完成：${result.segments.length} 个审核片段，全部已有自动裁剪候选。${restoredCount > 0 ? ` 已恢复 ${restoredCount} 个审核片段。` : ''}`);
      dispatchAnalysis({ type: 'run_succeeded' });
    } catch (error: unknown) {
      if (!isCurrent()) return;
      batchRunner.clear();
      setRetryState(null);
      // Stopping queued work must not erase source-change facts already
      // reported by sibling requests from this same run.
      if (observedSourceChanges.size > 0) {
        if (error instanceof SourceChangedDuringOperation) {
          for (const change of error.sourceChanges) observedSourceChanges.set(normalizeSourcePath(change.sourcePath), change);
        }
        const changes = sourceInputs.flatMap((source) => {
          const change = observedSourceChanges.get(normalizeSourcePath(source.sourcePath));
          return change ? [change] : [];
        });
        const first = changes[0]!;
        error = new SourceChangedDuringOperation(first.sourcePath, first.message, changes);
      }
      if (error instanceof StaleRunError || error instanceof BatchRunSupersededError) {
        if (sourceIntegrityRevisionRef.current !== sourceIntegrityRevision) {
          observe({ type: 'failed', failure: batchOperationFailure(
            { stage: feedbackStage, sourcePath: null, page: null },
            new LocalEngineError('ENGINE_REQUEST_REJECTED', '源文件已变化，请重新分析。', { engineCode: 'source_changed' }),
          ) });
          dispatchAnalysis({ type: 'run_failed', error: '源文件已变化，请重新分析。' });
        }
        return;
      }
      const alreadyReported = error instanceof ReportedBatchFailure
        || (hasOperationFailures && (error instanceof SourceChangedDuringOperation || isSourceChangedError(error)));
      observe({ type: 'failed', ...(!alreadyReported ? {
        failure: batchOperationFailure({ stage: error instanceof BatchAssemblyError ? 'finalizing' : feedbackStage, sourcePath: null, page: null }, error),
      } : {}) });
      const sourceChanges = error instanceof SourceChangedDuringOperation
        ? error.sourceChanges
        : isSourceChangedError(error) && sourceInputs.length === 1
          ? [{
            sourcePath: sourceInputs[0]?.sourcePath ?? '',
            message: error.message || '源 PDF 已变化，请重新分析文件。',
          }]
          : [];
      if (sourceChanges.length > 0) {
        if (!replacingAppliedSearch && preparedDocuments) commitNavigationDocuments(preparedDocuments);
        for (const sourceChange of sourceChanges) {
          markSourceChanged(sourceChange.sourcePath, sourceChange.message);
        }
        setSearchLoading(false);
        setAnalysisLoading(false);
        const primaryMessage = sourceChanges[0]!.message;
        setAnalysisNoticeMessage(primaryMessage);
        dispatchAnalysis({ type: 'run_failed', error: primaryMessage });
        return;
      }
      const message = error instanceof StaleReviewSessionError
        ? '审核上下文已变化，请重新分析。'
        : error instanceof Error ? reviewErrorMessage(error) : '未知错误';
      setSearchLoading(false);
      setAnalysisLoading(false);
      setAnalysisNoticeMessage(`本地搜索失败：${message}`);
      dispatchAnalysis({ type: 'run_failed', error: message });
    } finally {
      if (requestId === searchRequestIdRef.current) {
        searchInFlightRef.current = false;
        setSearchLoading(false);
        setAnalysisLoading(false);
      }
    }
  }, [appliedSearch, batchRunner, commitNavigationDocuments, commitSearchResult, engineStatus, loadLegacySuggestions, markSourceChanged, reviewCoordinator, persistentTasksEnabled, runPersistentSearch]);

  useEffect(() => {
    const document = navigation.activeDocument;
    const location = navigation.previewLocation;
    const requestedPage = location?.page ?? null;
    const segment = visibleSegment;
    const geometry = visibleSourceGeometry;
    const runId = ++previewRunRef.current;
    const previewGeneration = previewGenerationRef.current;
    let active = true;
    const clearVisiblePreview = () => {
      pagePreviewIdentityRef.current = null;
      setPagePreview(null);
    };

    if (
      engineStatus !== 'ready'
      || !document
      || !location
      || requestedPage === null
      || !isValidPage(requestedPage, document.pageCount)
    ) {
      clearVisiblePreview();
      setPreviewError('');
      setPreviewLoading(false);
      return () => {
        active = false;
      };
    }

    if (document.integrityStatus !== 'valid') {
      clearVisiblePreview();
      // Source integrity belongs to the right-hand analysis status (and the
      // source row's compact state), not to a duplicate central-page alert.
      setPreviewError('');
      setPreviewLoading(false);
      return () => {
        active = false;
      };
    }

    // A wrong-page response is a page-level validation failure, not a reason
    // to invalidate the historical crop. Hold that page in the error state
    // until the user explicitly retries; otherwise the geometry update below
    // would immediately re-run this effect and silently replace the error
    // with another render. The retry counter is the explicit escape hatch.
    if (
      segment
      && geometry?.previewStatus === 'invalid'
      && geometry.previewError === PREVIEW_PAGE_MISMATCH
    ) {
      if (previewRetryRequestRef.current === previewRetry) {
        setPreviewLoading(false);
        return () => {
          active = false;
        };
      }
      previewRetryRequestRef.current = previewRetry;
    }

    // Geometry validation updates pending -> valid after the visible request
    // settles. Re-running the effect for that state change must retain the
    // already displayed page rather than enqueueing a second request. The
    // cache intentionally remains in-flight-only; this identity only guards
    // the React image state for the current location.
    if (
      pagePreview
      && pagePreviewIdentityRef.current?.documentKey === document.key
      && pagePreviewIdentityRef.current.page === requestedPage
      && pagePreview.page === requestedPage
      && pagePreview.page_count === document.pageCount
    ) {
      // The geometry update can replace the effect before the prior request's
      // finally runs. This branch owns the already validated visible image.
      setPreviewLoading(false);
      return () => {
        active = false;
      };
    }

    setPreviewLoading(true);
    clearVisiblePreview();
    setPreviewError('');
    cachedPagePreview(document, requestedPage, previewGeneration)
      .then((preview) => {
        if (
          typeof preview.source_sha256 === 'string'
          && preview.source_sha256.toLowerCase() !== document.sourceSha256.toLowerCase()
        ) {
          const sourceChangeAccepted = markSourceChanged(
            document.sourcePath,
            '源 PDF 已变化，请重新分析文件。',
            document.key,
            previewGeneration,
          );
          if (!sourceChangeAccepted) return;
          if (!active || runId !== previewRunRef.current) return;
          throw new Error('源 PDF 已变化，请重新分析文件。');
        }
        if (
          !Number.isInteger(preview.page_count)
          || preview.page_count !== document.pageCount
        ) {
          const sourceChangeAccepted = markSourceChanged(
            document.sourcePath,
            PREVIEW_PAGE_COUNT_MISMATCH,
            document.key,
            previewGeneration,
          );
          if (!sourceChangeAccepted) return;
          if (!active || runId !== previewRunRef.current) return;
          throw new Error(PREVIEW_PAGE_COUNT_MISMATCH);
        }
        // Source-level integrity checks above must run even when this page
        // request is no longer the visible request. Only the image and
        // page-level UI state are guarded by the active/run identity.
        if (!active || runId !== previewRunRef.current) return;
        const documentValidation = validateDocumentPreview(preview, document, requestedPage);
        if (!documentValidation.ok) {
          if (documentValidation.kind === 'page_count_mismatch') {
            markSourceChanged(document.sourcePath, documentValidation.message, document.key, previewGeneration);
          } else if (segment) {
            markPagePreviewInvalid(segment.id, 'page');
          }
          if (active && runId === previewRunRef.current) {
            clearVisiblePreview();
            setPreviewError(documentValidation.message);
          }
          return;
        }
        if (segment) {
          const validationError = previewValidationError(preview, segment, geometry);
          if (validationError === 'geometry') {
            // A missing geometry record is a recoverable review-state
            // inconsistency. Keep the real page visible, but never construct
            // a crop editor or allow actions until reanalysis restores the
            // segment's source geometry.
            pagePreviewIdentityRef.current = { documentKey: document.key, page: requestedPage };
            setPagePreview(preview);
            setPreviewError(PREVIEW_GEOMETRY_MISSING);
            return;
          }
          if (validationError) {
            if (validationError === 'page') {
              markPagePreviewInvalid(segment.id, validationError);
            } else {
              invalidateSegmentForPreview(segment.id, validationError);
            }
            const message = validationError === 'page'
              ? PREVIEW_PAGE_MISMATCH
              : validationError === 'page_count' ? PREVIEW_PAGE_COUNT_MISMATCH : PREVIEW_DIMENSIONS_MISMATCH;
            if (validationError === 'page') {
              clearVisiblePreview();
            } else {
              pagePreviewIdentityRef.current = { documentKey: document.key, page: requestedPage };
              setPagePreview(preview);
            }
            setPreviewError(message);
            return;
          }
          if (!geometry || !geometry.matchValid || !geometry.pageValid) {
            pagePreviewIdentityRef.current = { documentKey: document.key, page: requestedPage };
            setPagePreview(preview);
            setPreviewError('命中数据无效，不能确认或裁剪。');
            return;
          }
          const samePageSegmentIds = reviewSegments
            .filter((item) => (
              normalizeSourcePath(item.sourcePath) === normalizeSourcePath(document.sourcePath)
              && item.sourcePage === requestedPage
            ))
            .map((item) => item.id);
          setSourceGeometryById((current) => {
            let changed = false;
            const next = { ...current };
            for (const segmentId of samePageSegmentIds) {
              const itemGeometry = current[segmentId];
              if (!itemGeometry) continue;
              next[segmentId] = {
                ...itemGeometry,
                previewStatus: 'valid',
                previewError: undefined,
              };
              changed = true;
            }
            return changed ? next : current;
          });
        }
        pagePreviewIdentityRef.current = { documentKey: document.key, page: requestedPage };
        setPagePreview(preview);
        if (segment) {
          const dimensions = safeDimensions(preview.page_width, preview.page_height);
          const dimensionsKnown = finitePositive(segment.pageWidth) && finitePositive(segment.pageHeight);
          if (!dimensionsKnown) {
            setReviewSegments((current) => current.map((item) => item.id === segment.id
              ? {
                ...item,
                pageWidth: dimensions.pageWidth,
                pageHeight: dimensions.pageHeight,
                reviewStatus: 'blocked',
              }
              : item));
            invalidateGroupConfirmation();
          }
        }
      })
      .catch((error: unknown) => {
        if (error instanceof StaleRunError) return;
        if (isSourceChangedError(error)) {
          // A source-integrity rejection is authoritative even if the user
          // has already navigated to another page or source. The stale
          // request must still block the affected source; only its visible
          // error/image state is conditional on the current request identity.
          const sourceChangeAccepted = markSourceChanged(
            document.sourcePath,
            error.message || '源 PDF 已变化，请重新分析文件。',
            document.key,
            previewGeneration,
          );
          if (!sourceChangeAccepted) return;
          if (active && runId === previewRunRef.current && previewGeneration === previewGenerationRef.current) {
            pagePreviewIdentityRef.current = null;
            setPagePreview(null);
          }
          return;
        }
        if (active && runId === previewRunRef.current && previewGeneration === previewGenerationRef.current) {
          pagePreviewIdentityRef.current = null;
          setPagePreview(null);
          const message = error instanceof Error ? error.message : '页面预览生成失败';
          setPreviewError(message);
        }
      })
      .finally(() => {
        if (active && runId === previewRunRef.current && previewGeneration === previewGenerationRef.current) setPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    engineStatus,
    navigation.activeDocument?.integrityStatus,
    navigation.activeDocument?.key,
    navigation.activeDocument?.pageCount,
    navigation.activeDocument?.sourceSha256,
    navigation.previewLocation?.documentKey,
    navigation.previewLocation?.page,
    navigation.sourceIntegrityRevision,
    previewRequestEpoch,
    previewRetry,
    selectedId,
    selectedSourceGeometry?.dimensionsMatch,
    selectedSourceGeometry?.matchValid,
    selectedSourceGeometry?.pageCountMatch,
    selectedSourceGeometry?.pageValid,
    selectedSourceGeometry?.previewStatus,
  ]);

  useEffect(() => {
    const snapshot = exportPreview;
    if (!snapshot) {
      setExportPreviewLoading(false);
      return;
    }
    let active = true;
    const requestedPage = exportPreviewPage;
    setExportPreviewLoading(true);
    setExportPreviewImage('');
    setExportPreviewError('');
    localEngineAdapter.renderPage(snapshot.previewPath, requestedPage, snapshot.previewSha256)
      .then((preview) => {
        if (!active || exportPreviewRef.current !== snapshot) return;
        if (preview.page !== requestedPage || preview.page_count !== snapshot.pageCount) {
          throw new Error('最终 PDF 预览页码或总页数校验失败。');
        }
        setExportPreviewImage(preview.image_data);
      })
      .catch((error: unknown) => {
        if (!active || exportPreviewRef.current !== snapshot) return;
        setExportPreviewImage('');
        setExportPreviewError(`最终 PDF 第 ${requestedPage} 页渲染失败：${error instanceof Error ? error.message : '未知错误'}`);
      })
      .finally(() => {
        if (active && exportPreviewRef.current === snapshot) setExportPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [exportPreview, exportPreviewPage, exportPreviewRetry]);

  // Validate every distinct hit page in the background. The selected-page
  // preview above still owns the visible image, while this pass prevents the
  // group confirmation/export controls from waiting for manual page-by-page
  // clicks.
  useEffect(() => {
    // A new analysis expires queued previews. Do not recreate them from the
    // still-visible prior result while its in-flight pages are settling.
    // Resume validation after the run, including when it preserves old results.
    if (engineStatus !== 'ready' || isRunning || reviewSegments.length === 0) return;
    const reviewRevision = reviewRevisionRef.current;
    const taskId = reviewTaskIdRef.current;
    const sourceRevision = sourceIntegrityRevisionRef.current;
    const previewGeneration = previewGenerationRef.current;
    let active = true;
    const pages = new Map<string, { segment: ReviewSegment; document: SourceDocument }>();
    for (const segment of reviewSegments) {
      const geometry = sourceGeometryById[segment.id];
      if (!geometry || geometry.previewStatus !== 'pending') continue;
      if (geometry.previewError) continue;
      // Invalid hit/page geometry is deliberately excluded from page
      // analysis and must not trigger a preview request that could turn a
      // malformed match into a source-level failure.
      if (!geometry.matchValid || !geometry.pageValid) continue;
      const document = sourceDocumentForSegment(navigation.documents, segment);
      if (!document || !segmentMatchesSourceDocument(segment, document)) continue;
      const key = `${document.key}\u0000${segment.sourcePage}`;
      if (!pages.has(key)) pages.set(key, { segment, document });
    }
    if (pages.size === 0) return;

    type BackgroundPreviewResult =
      | {
        segment: ReviewSegment;
        document: SourceDocument;
        status: 'source_changed';
        message: string;
        generation: number;
      }
      | { segment: ReviewSegment; document: SourceDocument; status: 'stale' }
      | { segment: ReviewSegment; document: SourceDocument; status: 'pending'; error: string }
      | { segment: ReviewSegment; document: SourceDocument; status: 'valid' }
      | { segment: ReviewSegment; document: SourceDocument; status: 'invalid'; reason: PreviewInvalidReason };

    const applyResult = (result: BackgroundPreviewResult): void => {
      // Source-level integrity failures are authoritative even after this
      // effect has been cleaned up by a navigation or sibling state update.
      // Handle them before the visible-run guard so a hanging sibling cannot
      // delay the source gate.
      if (result.status === 'source_changed') {
        // A background request from the current analysis remains authoritative
        // even if another source changed first. Only an event from an older
        // analysis run uses its generation as a stale-event guard.
        const staleReviewRevision = reviewRevision === reviewRevisionRef.current
          ? undefined
          : result.generation;
        markSourceChanged(
          result.document.sourcePath,
          result.message,
          result.document.key,
          staleReviewRevision,
        );
        return;
      }
      if (
        !active
        || reviewRevision !== reviewRevisionRef.current
        || taskId !== reviewTaskIdRef.current
        || sourceRevision !== sourceIntegrityRevisionRef.current
        || previewGeneration !== previewGenerationRef.current
      ) return;
      if (result.status === 'stale') return;
      if (result.status === 'invalid' && result.reason === 'page') {
        markPagePreviewInvalid(result.segment.id, result.reason);
        return;
      }
      const geometry = sourceGeometryById[result.segment.id];
      if (!geometry || geometry.previewStatus !== 'pending') return;
      const resultPageKey = `${result.segment.sourcePath}\u0000${result.segment.sourceSha256}\u0000${result.segment.sourcePage}`;
      const samePageSegmentIds = reviewSegments
        .filter((segment) => `${segment.sourcePath}\u0000${segment.sourceSha256}\u0000${segment.sourcePage}` === resultPageKey)
        .map((segment) => segment.id);
      if (result.status === 'pending') {
        setSourceGeometryById((current) => {
          let changed = false;
          const next = { ...current };
          for (const segmentId of samePageSegmentIds) {
            const currentGeometry = current[segmentId];
            if (!currentGeometry || currentGeometry.previewStatus !== 'pending' || currentGeometry.previewError === result.error) continue;
            next[segmentId] = { ...currentGeometry, previewError: result.error };
            changed = true;
          }
          return changed ? next : current;
        });
        return;
      }
      if (result.status === 'invalid') {
        invalidateSegmentForPreview(result.segment.id, result.reason);
        return;
      }
      setSourceGeometryById((current) => {
        let changed = false;
        const next = { ...current };
        for (const segmentId of samePageSegmentIds) {
          const currentGeometry = current[segmentId];
          if (!currentGeometry || currentGeometry.previewStatus !== 'pending') continue;
          next[segmentId] = {
            ...currentGeometry,
            previewStatus: 'valid',
            previewError: undefined,
          };
          changed = true;
        }
        return changed ? next : current;
      });
    };

    for (const { segment, document } of pages.values()) {
      void (async (): Promise<BackgroundPreviewResult> => {
        const geometry = sourceGeometryById[segment.id];
        if (!geometry) return { segment, document, status: 'invalid', reason: 'dimensions' };
        try {
          const preview = await cachedPagePreview(
            document, segment.sourcePage, previewGeneration,
            previewRequestEpochRef.current, 'background',
          );
          if (
            typeof preview.source_sha256 === 'string'
            && preview.source_sha256.toLowerCase() !== document.sourceSha256.toLowerCase()
          ) {
            return {
              segment,
              document,
              status: 'source_changed',
              message: '源 PDF 已变化，请重新分析文件。',
              generation: previewGeneration,
            };
          }
          const documentValidation = validateDocumentPreview(preview, document, segment.sourcePage);
          if (!documentValidation.ok) {
            return documentValidation.kind === 'page_count_mismatch'
              ? {
                segment,
                document,
                status: 'source_changed',
                message: documentValidation.message,
                generation: previewGeneration,
              }
              : { segment, document, status: 'invalid', reason: 'page' };
          }
          const reason = previewValidationError(preview, segment, geometry);
          return reason
            ? { segment, document, status: 'invalid', reason }
            : { segment, document, status: 'valid' };
        } catch (error: unknown) {
          if (error instanceof StaleRunError) return { segment, document, status: 'stale' };
          if (isSourceChangedError(error)) {
            return {
              segment,
              document,
                status: 'source_changed',
                message: error.message || '源 PDF 已变化，请重新分析文件。',
                generation: previewGeneration,
            };
          }
          return {
            segment,
            document,
            status: 'pending',
            error: error instanceof Error ? error.message : '页面预览生成失败',
          };
        }
      })().then(applyResult);
    }
    return () => {
      active = false;
    };
  }, [engineStatus, isRunning, navigation.documents, reviewSegments, sourceGeometryById]);

  function appendSourceFiles(files: SourceFile[]): void {
    if (workspaceLockedRef.current || files.length === 0) return;
    const currentSources = sourceFiles.map(sourceSelectionForFile);
    const incomingSources = files.map(sourceSelectionForFile);
    const mergedSources = appendUniqueSources(currentSources, incomingSources);
    const mergedFiles = materializeSourceFiles(mergedSources, [...sourceFiles, ...files]);
    const addedCount = mergedSources.length - currentSources.length;
    const duplicateCount = files.length - (mergedSources.length - currentSources.length);
    if (addedCount <= 0) {
      setSourceNoticeMessage(`所选 PDF 均已在当前任务中，未添加重复文件。`);
      return;
    }
    setSourceFiles(mergedFiles);
    const readableSources = mergedSources.filter((source) => source.sourcePath.trim());
    const firstFile = files[0];
    resetForSourceChange(
      `已添加 ${addedCount} 个 PDF${duplicateCount > 0 ? `，已去除 ${duplicateCount} 个重复路径` : ''}，任务状态为“待处理”。${firstFile.path ? '' : '当前运行环境未提供文件路径，请在桌面应用中选择文件。'}`,
      readableSources,
    );
    void prepareSourcePreviews(readableSources);
  }

  function replaceSourceFiles(files: SourceFile[]): void {
    if (workspaceLockedRef.current || files.length === 0) return;
    const uniqueFiles: SourceFile[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const identity = normalizeSourcePath(sourcePathForFile(file));
      if (seen.has(identity)) continue;
      seen.add(identity);
      uniqueFiles.push(file);
    }
    if (uniqueFiles.length === 0) return;
    const sources = uniqueFiles.map(sourceSelectionForFile);
    setSourceFiles(uniqueFiles);
    resetForSourceChange(
      `已选择 ${uniqueFiles.length} 个 PDF，任务状态为“待处理”。${uniqueFiles[0]?.path ? '' : '当前运行环境未提供文件路径，请在桌面应用中选择文件。'}`,
      sources.filter((source) => source.sourcePath.trim()),
    );
    void prepareSourcePreviews(sources);
  }

  async function openPicker(mode: PickerMode, append = false): Promise<void> {
    if (workspaceLockedRef.current) return;
    pickerAppendRef.current = append;
    setSourceNoticeMessage(mode === 'folder' ? '请选择一个文件夹；只会读取其中的 PDF 文件。' : '请选择一个或多个 PDF；原始文件仍保留在原位置。');
    if (engineStatus === 'ready') {
      try {
        const pickerResult = mode === 'folder'
          ? await localEngineAdapter.pickPdfFolder(appSettingsRef.current.lastInputDirectory)
          : await localEngineAdapter.pickPdfFiles(appSettingsRef.current.lastInputDirectory);
        // The native picker can resolve after the user has entered final PDF
        // preview. Re-check the synchronous lock before touching any state or
        // falling back to the browser input.
        if (workspaceLockedRef.current) return;
        const paths = pickerResult.files;
        if (paths.length === 0) {
          setSourceNoticeMessage('已取消选择，当前任务保持不变。');
          return;
        }
        const uniquePaths: string[] = [];
        const seen = new Set<string>();
        for (const path of paths) {
          const identity = normalizeSourcePath(path);
          if (seen.has(identity)) continue;
          seen.add(identity);
          uniquePaths.push(path);
        }
        const files = uniquePaths.map((path) => ({
          name: path.split(/[\\/]/).pop() || path,
          relativePath: path,
          path,
          size: 0,
        }));
        (append ? appendSourceFiles : replaceSourceFiles)(files);
        const selectedDirectory = pickerResult.directory?.trim() || null;
        if (paths.length > 0 && selectedDirectory) {
          updateAppSettings({ ...appSettingsRef.current, lastInputDirectory: selectedDirectory });
        }
        if (uniquePaths.length < paths.length) setSourceNoticeMessage(`已去除 ${paths.length - uniquePaths.length} 个重复路径，保留 ${files.length} 个 PDF。`);
        return;
      } catch {
        if (workspaceLockedRef.current) return;
        setSourceNoticeMessage('原生选择器不可用，已切换到浏览器文件选择。');
      }
    }
    (mode === 'folder' ? folderInputRef : pdfInputRef).current?.click();
  }

  function startNewTask(): void {
    if (workspaceLockedRef.current || newTaskDisabled) return;
    setTaskHistoryOpen(false);
    setSourceFiles([]);
    resetForSourceChange('已创建空白审核任务，请选择 PDF 或文件夹。');
    window.setTimeout(() => void openPicker('file'), 0);
  }

  function handleFilesSelected(event: ChangeEvent<HTMLInputElement>, mode: PickerMode): void {
    if (workspaceLockedRef.current) {
      // Always clear a late picker value so the same file can be selected
      // again after returning from final preview.
      event.target.value = '';
      return;
    }
    const selectedFiles = Array.from(event.target.files ?? []);
    const pdfFiles = selectedFiles.filter((file) => file.name.toLowerCase().endsWith('.pdf'));
    event.target.value = '';
    if (pdfFiles.length === 0) {
      setSourceNoticeMessage('已取消选择，当前任务保持不变。');
      return;
    }
    const files = pdfFiles.map<SourceFile>((file) => ({
      name: file.name,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      size: file.size,
      path: (file as File & { path?: string }).path,
    }));
    (pickerAppendRef.current ? appendSourceFiles : replaceSourceFiles)(files);
  }

  function clearActiveSources(): void {
    if (workspaceLockedRef.current) return;
    sourcePickerRequestRef.current += 1;
    setSourceFiles([]);
    resetForSourceChange('已清除当前任务的来源文件；原始文件未被删除或修改。');
  }

  function removeSourcePaths(sourcePaths: string[]): void {
    if (workspaceLockedRef.current || sourcePaths.length === 0) return;
    const result = removeSourceIdentities(
      sourceFiles.map(sourceSelectionForFile),
      new Set(sourcePaths),
    );
    if (result.files.length === sourceFiles.length) return;
    const remainingFiles = materializeSourceFiles(result.files, sourceFiles);
    setSourceFiles(remainingFiles);
    resetForSourceChange(
      `已从当前任务移除 ${sourceFiles.length - remainingFiles.length} 个文件；原始文件未被删除或修改。`,
      result.files.filter((source) => source.sourcePath.trim()),
    );
    void prepareSourcePreviews(result.files);
  }

  function removeSourcePath(sourcePath: string): void {
    removeSourcePaths([sourcePath]);
  }

  function beginSearchEdit(): void {
    if (searchModificationDisabled || !appliedSearch) return;
    setSearchDraft(cloneSearchSettings(appliedSearch));
    setSearchEditorOpen(true);
  }

  function handleDraftCriteriaChange(nextCriteria: SearchCriteria): void {
    if (searchModificationDisabled) return;
    batchRunner.clear();
    setRetryState(null);
    setSearchDraft((current) => ({ ...current, criteria: nextCriteria }));
    dispatchAnalysis({ type: 'criteria_changed' });
  }

  function handleDraftMatchModeChange(mode: SearchMode): void {
    if (searchModificationDisabled) return;
    batchRunner.clear();
    setRetryState(null);
    setSearchDraft((current) => ({ ...current, matchMode: mode }));
    dispatchAnalysis({ type: 'criteria_changed' });
  }

  function removeKeywordHistoryItem(role: SearchKeywordHistoryRole, keyword: string): void {
    if (searchModificationDisabled || isRunning) return;
    const nextHistory = removeSearchKeywordHistory(keywordHistoryRef.current, role, keyword);
    keywordHistoryRef.current = nextHistory;
    setKeywordHistory(nextHistory);
  }

  function clearKeywordHistoryItems(role: SearchKeywordHistoryRole): void {
    if (searchModificationDisabled || isRunning) return;
    const nextHistory = clearSearchKeywordHistory(keywordHistoryRef.current, role);
    keywordHistoryRef.current = nextHistory;
    setKeywordHistory(nextHistory);
  }

  function cancelSearchEdit(): void {
    if (searchModificationDisabled || !appliedSearch) return;
    batchRunner.clear();
    setRetryState(null);
    setSearchDraft(cloneSearchSettings(appliedSearch));
    setSearchEditorOpen(false);
    dispatchBatchFeedback({ type: 'clear' });
    dispatchAnalysis({ type: 'previous_results_restored' });
    if (navigationDocumentsRef.current.every((document) => document.integrityStatus === 'valid')) {
      setAnalysisNotice(null);
    }
  }

  function changeReviewFilter(filter: ReviewFilter): void {
    if (workspaceLockedRef.current || groupSavePendingRef.current || isRunning) return;
    setReviewFilter(filter);
  }

  function changeReviewSourceFilter(source: string | null): void {
    if (workspaceLockedRef.current || groupSavePendingRef.current || isRunning) return;
    if (source !== null && !reviewResultSources.some((item) => item.key === source)) return;
    setReviewSourceFilter(source);
  }

  function changeReviewSortOrder(sort: ReviewResultSort): void {
    if (workspaceLockedRef.current || groupSavePendingRef.current || isRunning) return;
    if (!['original', 'confidence_asc', 'confidence_desc'].includes(sort)) return;
    setReviewSortOrder(sort);
  }

  function resetReviewFilters(): void {
    if (workspaceLockedRef.current || groupSavePendingRef.current || isRunning) return;
    setReviewSourceFilter(null);
    setReviewFilter('all');
  }

  function revealSelectedReviewSegment(): void {
    if (workspaceLockedRef.current || groupSavePendingRef.current || isRunning || !selectedId) return;
    revealSegment(selectedId);
  }

  function selectSegment(id: string): void {
    if (workspaceLockedRef.current) return;
    const segment = reviewSegments.find((item) => item.id === id);
    if (!segment) return;
    const reselecting = selectedId === id;
    setSelectedId(id);
    navigation.showSegment(segment);
    // A pending preview failure is intentionally not retried by the
    // background validation effect. Selecting the same row again is the
    // explicit retry gesture for that page.
    if (reselecting) setPreviewRetry((value) => value + 1);
  }

  function invalidateGroupConfirmation(): void {
    // A segment edit invalidates both the visible group decision and any
    // in-flight group-save response that captured the previous geometry.
    groupSaveRequestRef.current += 1;
    setGroupConfirmed(false);
    // This may be called by a stale preview callback whose closure predates
    // the save. The ref is authoritative so source changes always release
    // the visible pending gate.
    groupSavePendingRef.current = false;
    setGroupSavePending(false);
    // A previous successful group confirmation is no longer true after any
    // geometry/source mutation. Clear its feedback as well, otherwise the
    // action card can continue to claim that export is available while the
    // group is already gated again.
    setReviewFeedback(null);
    clearExportPreview();
    setExportResult(null);
  }

  function markSourceChanged(
    sourcePath: string,
    message = '源 PDF 已变化，请重新分析文件。',
    expectedDocumentKey?: string,
    expectedPreviewGeneration?: number,
  ): boolean {
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) return false;
    // A source-change response belongs to the page request generation that
    // issued it. Any newer analysis, source transition, or first integrity
    // event has already advanced this generation; a late response from that
    // older generation must not run App-wide cleanup against the new view.
    if (
      expectedPreviewGeneration !== undefined
      && expectedPreviewGeneration !== previewGenerationRef.current
    ) return false;
    const normalizedPath = normalizeSourcePath(sourcePath);
    const currentDocument = navigationDocumentsRef.current.find(
      (document) => normalizeSourcePath(document.sourcePath) === normalizedPath,
    );
    if (!currentDocument) return false;
    // A late response from an old run must never poison a replacement that
    // reuses the same path. The document key binds the event to the exact
    // path+SHA pair that issued the request.
    if (expectedDocumentKey && currentDocument.key !== expectedDocumentKey) return false;
    // Multiple in-flight page requests can report the same source change. Once
    // the document is already gated, the first event is authoritative; later
    // events must be completely inert so they cannot invalidate a recovered
    // preview or an unrelated pending review/export operation.
    if (currentDocument.integrityStatus === 'changed') return false;
    const expectedSourceSha = currentDocument?.sourceSha256.toLowerCase();
    // The navigation hook owns the synchronous latest-state ref. Ask it to
    // perform the transition before any App-wide invalidation so duplicate
    // source_changed callbacks in the same React tick become no-ops even
    // when navigationDocumentsRef has not rendered the first update yet.
    if (!navigation.markSourceIntegrityChanged(sourcePath, expectedDocumentKey)) return false;
    batchRunner.clear();
    setRetryState(null);
    navigationDocumentsRef.current = navigationDocumentsRef.current.map((document) => (
      normalizeSourcePath(document.sourcePath) === normalizedPath
      && (!expectedDocumentKey || document.key === expectedDocumentKey)
        ? { ...document, integrityStatus: 'changed' as const }
        : document
    ));
    // Invalidate export snapshots synchronously as well as through the hook's
    // functional state update. A source-change response can race a pending
    // export-path promise before React has committed the changed document.
    sourceIntegrityRevisionRef.current += 1;
    resetReviewOperationHistory();
    previewGenerationRef.current += 1;
    previewRunRef.current += 1;
    pagePreviewCacheRef.current.clear();
    pagePreviewOwnerRef.current.clear();
    pagePreviewIdentityRef.current = null;
    setReviewSegments((current) => {
      let changed = false;
      const next = current.map((segment) => {
        if (
          normalizeSourcePath(segment.sourcePath) !== normalizedPath
          || segment.reviewStatus === 'blocked'
          || (expectedSourceSha && segment.sourceSha256.toLowerCase() !== expectedSourceSha)
        ) return segment;
        changed = true;
        return { ...segment, reviewStatus: 'blocked' as const };
      });
      return changed ? next : current;
    });
    invalidateGroupConfirmation();
    setAnalysisNoticeMessage(message);
    return true;
  }

  function updateSegment(id: string, updater: (segment: ReviewSegment) => ReviewSegment): void {
    reviewFeedbackRevisionRef.current += 1;
    setReviewSegments((current) => current.map((segment) => segment.id === id ? updater(segment) : segment));
    invalidateGroupConfirmation();
  }

  function markPagePreviewInvalid(id: string, reason: PreviewInvalidReason): void {
    reviewFeedbackRevisionRef.current += 1;
    reviewGeometryRevisionRef.current += 1;
    const target = reviewSegmentsRef.current.find((segment) => segment.id === id);
    const targetPageKey = target
      ? `${target.sourcePath}\u0000${target.sourceSha256}\u0000${target.sourcePage}`
      : null;
    const samePage = (segment: ReviewSegment) => targetPageKey !== null
      && `${segment.sourcePath}\u0000${segment.sourceSha256}\u0000${segment.sourcePage}` === targetPageKey;
    setSourceGeometryById((current) => {
      if (!targetPageKey) return current;
      const next = { ...current };
      let changed = false;
      for (const segment of reviewSegmentsRef.current) {
        if (!samePage(segment)) continue;
        const geometry = current[segment.id];
        if (!geometry) continue;
        next[segment.id] = {
          ...geometry,
          dimensionsMatch: reason === 'dimensions' ? false : geometry.dimensionsMatch,
          pageCountMatch: reason === 'page_count' ? false : geometry.pageCountMatch,
          pageValid: reason === 'page_count' ? false : geometry.pageValid,
          previewStatus: 'invalid',
          previewError: reason === 'page'
            ? PREVIEW_PAGE_MISMATCH
            : reason === 'page_count'
              ? PREVIEW_PAGE_COUNT_MISMATCH
              : PREVIEW_DIMENSIONS_MISMATCH,
        };
        changed = true;
      }
      return changed ? next : current;
    });
    invalidateGroupConfirmation();
  }

  function invalidateSegmentForPreview(id: string, reason: PreviewInvalidReason): void {
    const target = reviewSegmentsRef.current.find((segment) => segment.id === id);
    const targetPageKey = target
      ? `${target.sourcePath}\u0000${target.sourceSha256}\u0000${target.sourcePage}`
      : null;
    const samePage = (segment: ReviewSegment) => targetPageKey !== null
      && `${segment.sourcePath}\u0000${segment.sourceSha256}\u0000${segment.sourcePage}` === targetPageKey;
    // A wrong-page response is a display-level failure. Keep every historic
    // crop decision intact so a later explicit retry can reuse it.
    if (reason === 'page') {
      markPagePreviewInvalid(id, reason);
      return;
    }
    setReviewSegments((current) => current.map((segment) => samePage(segment)
      ? {
          ...segment,
          candidateRect: null,
          finalRect: null,
          mode: 'candidate',
          reviewStatus: 'blocked',
          manualAdjusted: false,
        }
      : segment));
    markPagePreviewInvalid(id, reason);
  }

  function sourceGeometryMessage(segment: ReviewSegment): string {
    const geometry = sourceGeometryById[segment.id];
    if (geometry?.previewStatus === 'invalid') return geometry.previewError ?? '页面预览校验失败，不能确认或裁剪。';
    if (geometry?.previewStatus === 'pending') return PREVIEW_PENDING;
    if (geometry?.pageCountMatch === false) return PREVIEW_PAGE_COUNT_MISMATCH;
    if (geometry?.dimensionsMatch === false) return PREVIEW_DIMENSIONS_MISMATCH;
    if (!geometry?.matchValid || !geometry.pageValid) return '命中数据无效，不能确认或裁剪。';
    if (!finitePositive(segment.pageWidth) || !finitePositive(segment.pageHeight)) return '无法获取真实页面尺寸，不能确认或裁剪。';
    return '命中区域超出真实页面尺寸，不能确认或裁剪。';
  }

  function batchCropCurrent(snapshot: BatchCropSession): boolean {
    return mountedRef.current && batchCropRef.current === snapshot
      && reviewSessionRef.current === snapshot.session && reviewTaskIdRef.current === snapshot.taskId
      && reviewRevisionRef.current === snapshot.reviewRevision
      && sourceIntegrityRevisionRef.current === snapshot.sourceRevision && reviewHistory.epoch === snapshot.epoch;
  }

  function closeBatchCrop(force = false): void {
    if (batchCropApplyingRef.current && !force) return;
    batchCropRunRef.current += 1;
    batchCropRef.current = null;
    batchCropPlanRef.current = null;
    setBatchCropSession(null);
    setBatchCropPlan(null);
    setBatchCropBusy(false);
  }

  useEffect(() => {
    if (batchCropSession && !batchCropApplyingRef.current && !batchCropCurrent(batchCropSession)) {
      closeBatchCrop(true);
      setReviewNoticeMessage('任务或来源已变化，批量调整预览已取消。');
    }
  });

  async function loadBatchCropPreview(segment: ReviewSegment, priority: EngineTaskPriority): Promise<string> {
    const snapshot = batchCropRef.current;
    const run = batchCropRunRef.current;
    const current = () => Boolean(snapshot && batchCropCurrent(snapshot) && run === batchCropRunRef.current);
    if (!current()) throw new StaleBatchCropError();
    const document = sourceDocumentForSegment(navigationDocumentsRef.current, segment);
    if (!document || !segmentMatchesSourceDocument(segment, document)) throw new StaleBatchCropError();
    let preview: EnginePagePreview;
    try {
      preview = await cachedPagePreview(document, segment.sourcePage, previewGenerationRef.current, previewRequestEpochRef.current, priority, current);
    } catch (error) {
      if (current() && isSourceChangedError(error)) markSourceChanged(document.sourcePath, '来源PDF已变化，批量调整已取消。', document.key);
      throw error;
    }
    if (!current()) throw new StaleBatchCropError();
    if (preview.source_sha256?.toLowerCase() !== document.sourceSha256.toLowerCase()
        || preview.page_count !== document.pageCount) {
      markSourceChanged(document.sourcePath, '来源PDF已变化，批量调整已取消。', document.key);
      throw new StaleBatchCropError();
    }
    const reason = previewValidationError(preview, segment, reviewGeometryStateRef.current[segment.id]);
    if (reason) throw new Error('页面预览校验失败，不能应用裁剪。');
    const next = { ...reviewGeometryStateRef.current };
    for (const item of snapshot!.all) {
      if (item.sourcePath !== segment.sourcePath || item.sourceSha256 !== segment.sourceSha256 || item.sourcePage !== segment.sourcePage) continue;
      const geometry = next[item.id];
      if (geometry && !previewValidationError(preview, item, geometry)) next[item.id] = {...geometry,previewStatus:'valid',previewError:undefined};
    }
    reviewGeometryStateRef.current = next;
    setSourceGeometryById(next);
    return preview.image_data;
  }

  function openBatchCrop(): void {
    if (reviewFrozenRef.current || workspaceLockedRef.current || reviewSavePendingRef.current || pendingReviewOperationRef.current) return;
    const sample = visibleSegment;
    const session = reviewSessionRef.current;
    if (!sample || batchSampleError(sample) || !session || !reviewTaskId || !previewReadyForActionsRef.current) return;
    if (!reviewHistory.scope) reviewHistory.reset({taskId:reviewTaskId,contextKey:session.prepared.context_key,
      resultRevision:session.original.resultRevision,
      sourceFingerprint:JSON.stringify(session.original.context.sources.map((source) => [source.source_key,source.source_sha256]))});
    const snapshot: BatchCropSession = {sample:structuredClone(sample),all:structuredClone(reviewSegmentsRef.current),
      expected:reviewCoordinator.decisionSnapshots(session,reviewSegmentsRef.current.map((item) => item.id)),
      filteredIds:new Set(visibleReviewIds),session,taskId:reviewTaskId,reviewRevision:reviewRevisionRef.current,
      sourceRevision:sourceIntegrityRevisionRef.current,epoch:reviewHistory.epoch};
    batchCropRef.current = snapshot;
    workspaceLockedRef.current = true;
    setBatchCropSession(snapshot);
    setBatchCropScope('source');
    void buildBatchCropPlan(snapshot, 'source');
  }

  async function buildBatchCropPlan(snapshot: BatchCropSession, scope: 'source' | 'filtered'): Promise<void> {
    const run = ++batchCropRunRef.current;
    const current = () => batchCropCurrent(snapshot) && run === batchCropRunRef.current;
    batchCropPlanRef.current = null;
    setBatchCropPlan(null); setBatchCropError(undefined); setBatchCropBusy(true); setBatchCropProgress('准备检查页面版式…');
    const targets = snapshot.all.filter((item) => scope === 'filtered' ? snapshot.filteredIds.has(item.id)
      : (item.sourceKey ?? item.sourcePath) === (snapshot.sample.sourceKey ?? snapshot.sample.sourcePath));
    try {
      const plan = await prepareBatchCrop(snapshot.sample, targets, {
        isCurrent:current,
        onProgress:setBatchCropProgress,
        describe:async (segment) => {
          let result;
          try {
            result = await engineProcessSemaphore.run(() => localEngineAdapter.describeCropPage(segment.sourcePath,segment.sourcePage,segment.sourceSha256),current,'background');
          } catch (error) {
            if (current() && isSourceChangedError(error)) {
              const document = sourceDocumentForSegment(navigationDocumentsRef.current, segment);
              if (document) markSourceChanged(document.sourcePath, '来源PDF已变化，批量调整已取消。', document.key);
            }
            throw error;
          }
          if (!current()) throw new StaleBatchCropError();
          const document = sourceDocumentForSegment(navigationDocumentsRef.current, segment);
          if (!document || result.page_count !== document.pageCount) {
            if (document) markSourceChanged(document.sourcePath, '来源页数已变化，批量调整已取消。', document.key);
            throw new StaleBatchCropError();
          }
          return result;
        },
        validate:async (segment) => {
          if (!segmentHasValidSourceGeometry(segment, reviewGeometryStateRef.current[segment.id])) await loadBatchCropPreview(segment,'background');
        },
      });
      if (!current()) return;
      batchCropPlanRef.current = plan; setBatchCropPlan(plan);
      setBatchCropProgress(`检查完成：可应用 ${plan.applicable.length} 项，跳过 ${plan.skipped.length} 项。`);
    } catch (error) {
      if (current()) setBatchCropError(error instanceof Error ? error.message : '批量调整预览失败。');
    } finally { if (current()) setBatchCropBusy(false); }
  }

  async function applyBatchCrop(): Promise<void> {
    const snapshot = batchCropRef.current;
    const plan = batchCropPlanRef.current;
    if (!snapshot || !batchCropCurrent(snapshot) || !plan?.applicable.length || batchCropBusy || batchCropApplyingRef.current
        || reviewSavePendingRef.current || pendingReviewOperationRef.current) return;
    batchCropApplyingRef.current = true; setBatchCropApplying(true); setBatchCropError(undefined);
    try {
      const segments = plan.applicable.map((item) => item.after);
      const operation: PendingReviewOperation = {kind:'batch_crop',session:snapshot.session,taskId:snapshot.taskId,
        epoch:snapshot.epoch,sourceRevision:snapshot.sourceRevision,segments:structuredClone(segments),
        validationSegments:structuredClone([snapshot.sample,...segments]),
        expected:segments.map((segment) => snapshot.expected.find((item) => item.decision.id === segment.id)!),
        message:`已批量调整 ${segments.length} 个同类片段，可用“撤销上一步”整批恢复。`};
      if (!batchCropCurrent(snapshot)) throw new StaleBatchCropError();
      await runReviewOperation(operation);
      closeBatchCrop(true);
    } catch (error) {
      if (batchCropCurrent(snapshot)) setBatchCropError(error instanceof Error ? error.message : '批量调整保存失败。');
      else closeBatchCrop(true);
    } finally { batchCropApplyingRef.current = false; if (mountedRef.current) setBatchCropApplying(false); }
  }

  function resetReviewOperationHistory(): void {
    reviewHistory.reset(null);
    setReviewHistoryCount(0);
    pendingReviewOperationRef.current = null;
    reviewSavePendingRef.current = false;
    setReviewSavePending(false);
    setUnsavedReviewMessage(undefined);
  }

  function applyReviewDecisions(segments: ReviewSegment[]): void {
    const decisions = new Map(segments.map((segment) => [segment.id, segment]));
    reviewRevisionRef.current += 1;
    reviewFeedbackRevisionRef.current += 1;
    setReviewSegments((current) => current.map((segment) => {
      const value = decisions.get(segment.id);
      return value ? { ...segment, finalRect: value.finalRect === null ? null : { ...value.finalRect },
        mode: value.mode, manualAdjusted: value.manualAdjusted, reviewStatus: value.reviewStatus } : segment;
    }));
    invalidateGroupConfirmation();
  }

  function operationCurrent(operation: PendingReviewOperation): boolean {
    return mountedRef.current && reviewSessionRef.current === operation.session
      && reviewHistory.epoch === operation.epoch && sourceIntegrityRevisionRef.current === operation.sourceRevision
      && segmentsMatchCurrentSourceDocuments(operation.validationSegments ?? operation.segments, navigationDocumentsRef.current);
  }

  function operationGeometryValid(operation: PendingReviewOperation): boolean {
    return operation.segments.every((segment) => segmentHasValidSourceGeometry(segment, reviewGeometryStateRef.current[segment.id]));
  }

  async function verifyOperationSources(operation: PendingReviewOperation): Promise<void> {
    const documents = new Map((operation.validationSegments ?? operation.segments).map((segment) => {
      const document = sourceDocumentForSegment(navigationDocumentsRef.current, segment);
      if (!document) throw new Error('审核来源已失效，请重新载入任务。');
      return [document.key, document];
    }));
    for (const document of documents.values()) {
      const metadata = await engineProcessSemaphore.run(() => localEngineAdapter.inspectPdf(document.sourcePath), () => operationCurrent(operation));
      if (!operationCurrent(operation)) throw new StaleReviewSessionError();
      if (metadata.source_sha256.toLowerCase() !== document.sourceSha256.toLowerCase() || metadata.page_count !== document.pageCount) {
        markSourceChanged(document.sourcePath, '原始 PDF 已变化，不能恢复旧审核决定。', document.key);
        throw new StaleReviewSessionError();
      }
    }
  }

  async function runReviewOperation(operation: PendingReviewOperation): Promise<boolean> {
    if (reviewSavePendingRef.current || !operationCurrent(operation)) return false;
    reviewSavePendingRef.current = true;
    setReviewSavePending(true);
    const confirmingGroup = operation.kind === 'confirm_group' && !operation.undoId;
    if (confirmingGroup) { groupSavePendingRef.current = true; setGroupSavePending(true); }
    const guard = () => operationCurrent(operation) && operationGeometryValid(operation);
    try {
      if (!guard()) throw new Error('相关页面尚未通过校验，请先预览这些片段。');
      if (operation.undoId || operation.kind === 'batch_crop') await verifyOperationSources(operation);
      if (!guard()) throw new StaleReviewSessionError();
      await reviewCoordinator.saveStrict(operation.session, operation.taskId, operation.segments, operation.expected, guard, confirmingGroup);
      if (!guard()) return false;
      const after = reviewCoordinator.decisionSnapshots(operation.session, operation.segments.map((segment) => segment.id));
      if (operation.undoId) {
        reviewHistory.completeUndo(operation.undoId, after);
        applyReviewDecisions(operation.segments);
      } else {
        reviewHistory.record(operation.kind, operation.expected, after);
        if (operation.kind === 'batch_crop') applyReviewDecisions(operation.segments);
      }
      setReviewHistoryCount(reviewHistory.size);
      pendingReviewOperationRef.current = null;
      setUnsavedReviewMessage(undefined);
      if (confirmingGroup) setGroupConfirmed(true);
      setReviewNoticeMessage(operation.message);
      return true;
    } catch (error) {
      if (!operationCurrent(operation)) return false;
      pendingReviewOperationRef.current = operation;
      const outcome = persistenceFailure(error);
      const message = outcome.ok ? '审核保存未完成。' : outcome.message;
      setUnsavedReviewMessage(message);
      setGroupConfirmed(false);
      clearExportPreview();
      setReviewFeedback(null);
      return false;
    } finally {
      if (operationCurrent(operation)) {
        reviewSavePendingRef.current = false;
        setReviewSavePending(false);
        groupSavePendingRef.current = false;
        setGroupSavePending(false);
      }
    }
  }

  function submitReviewDecision(kind: ReviewOperationKind, segments: ReviewSegment[], message: string): void {
    if (reviewFrozenRef.current || reviewSavePendingRef.current || pendingReviewOperationRef.current) return;
    const session = reviewSessionRef.current;
    if (!session || !reviewTaskId) return;
    try {
      // A source integrity event clears the old stack, but valid receipts from
      // other sources may still be edited while whole-task export stays gated.
      if (!reviewHistory.scope) reviewHistory.reset({ taskId: reviewTaskId, contextKey: session.prepared.context_key,
        resultRevision: session.original.resultRevision,
        sourceFingerprint: JSON.stringify(session.original.context.sources.map((source) => [source.source_key, source.source_sha256])) });
      const operation: PendingReviewOperation = { kind, session, taskId: reviewTaskId, epoch: reviewHistory.epoch,
        sourceRevision: sourceIntegrityRevisionRef.current,
        expected: reviewCoordinator.decisionSnapshots(session, segments.map((segment) => segment.id)),
        segments: structuredClone(segments), message };
      if (kind !== 'confirm_group') applyReviewDecisions(segments);
      else { setGroupConfirmed(false); clearExportPreview(); }
      void runReviewOperation(operation);
    } catch (error) { setReviewNoticeMessage(error instanceof Error ? error.message : '审核保存基线不可用。'); }
  }

  function undoLastReviewOperation(): void {
    if (reviewFrozenRef.current || reviewSavePendingRef.current || pendingReviewOperationRef.current) return;
    const previous = reviewHistory.peek();
    const session = reviewSessionRef.current;
    if (!previous || !session || !reviewTaskId) return;
    const current = new Map(reviewSegmentsRef.current.map((segment) => [segment.id, segment]));
    const segments: ReviewSegment[] = [];
    for (const before of previous.before) {
      const segment = current.get(before.decision.id);
      if (!segment) return;
      segments.push({ ...segment, ...structuredClone(before.decision) });
    }
    void runReviewOperation({ kind: previous.kind, session, taskId: reviewTaskId, epoch: reviewHistory.epoch,
      sourceRevision: sourceIntegrityRevisionRef.current, expected: previous.after, segments,
      undoId: previous.id, message: '已撤销上一步审核操作，请重新确认整组后导出。' });
  }

  async function discardUnsavedReview(): Promise<void> {
    const operation = pendingReviewOperationRef.current;
    if (!operation || reviewSavePendingRef.current || !operationCurrent(operation) || editingAppliedSearch || workspaceLocked) return;
    reviewSavePendingRef.current = true;
    setReviewSavePending(true);
    try {
      await verifyOperationSources(operation);
      await reviewCoordinator.refreshDecisions(operation.session, () => operationCurrent(operation));
      if (!operationCurrent(operation)) return;
      const saved = reviewCoordinator.decisionSnapshots(operation.session, reviewSegmentsRef.current.map((segment) => segment.id));
      const byId = new Map(saved.map((item) => [item.decision.id, item.decision]));
      applyReviewDecisions(reviewSegmentsRef.current.map((segment) => ({ ...segment, ...byId.get(segment.id)! })));
      // A read does not prove the failed operation succeeded and cannot rebase history.
      pendingReviewOperationRef.current = null;
      setUnsavedReviewMessage(undefined);
      setReviewNoticeMessage('已放弃未保存修改，并读取当前保存的审核决定。');
    } catch (error) {
      if (operationCurrent(operation)) setUnsavedReviewMessage(error instanceof Error ? error.message : '读取审核记录失败，当前修改仍保留。');
    } finally {
      if (operationCurrent(operation)) { reviewSavePendingRef.current = false; setReviewSavePending(false); }
    }
  }

  function restoreAutomaticCandidate(): void {
    if (!visibleSegment || !previewReadyForActionsRef.current || !visibleHasSourceGeometry) return;
    const original = reviewSessionRef.current?.original.originals.find((item) => item.id === visibleSegment.id);
    if (!original || (!original.auto_full_page && !isLegalRect(original.candidate_rect, original.page_width, original.page_height))) return;
    submitReviewDecision('restore_candidate', [{ ...visibleSegment,
      mode: original.auto_full_page ? 'full_page' : 'candidate',
      finalRect: original.auto_full_page ? null : structuredClone(original.candidate_rect),
      manualAdjusted: false, reviewStatus: 'needs_review' }], '已恢复自动候选，请重新确认当前片段。');
  }

  function nextUnresolvedReview(revealAll = false): void {
    if (editingAppliedSearch || isRunning || workspaceLocked || reviewSavePendingRef.current) return;
    const view = deriveReviewResultView(reviewRows, { sourceKey: revealAll ? null : reviewSourceFilter,
      filter: revealAll ? 'all' : reviewFilter, sort: reviewSortOrder });
    const currentIndex = view.visibleRows.findIndex((row) => row.id === selectedId);
    const ordered = revealAll ? view.visibleRows : [...view.visibleRows.slice(currentIndex + 1), ...view.visibleRows.slice(0, currentIndex + 1)];
    const next = ordered.find((row) => unresolvedIds.has(row.id));
    if (!next) return;
    if (revealAll) { setReviewFilter('all'); setReviewSourceFilter(null); }
    const segment = reviewSegments.find((item) => item.id === next.id);
    if (segment) { setSelectedId(segment.id); navigation.showSegment(segment); }
  }

  function handleCropChange(rect: PdfRect): void {
    if (reviewFrozenRef.current) return;
    if (!visibleSegment) return;
    if (groupSavePending) return;
    if (!previewReadyForActionsRef.current || !visibleHasSourceGeometry || !isLegalRect(rect, visibleSegment.pageWidth, visibleSegment.pageHeight)) {
      setPreviewNoticeMessage(sourceGeometryMessage(visibleSegment));
      return;
    }
    updateSegment(visibleSegment.id, (segment) => ({
      ...segment,
      finalRect: rect,
      mode: 'manual',
      manualAdjusted: true,
      reviewStatus: 'confirmed',
    }));
  }

  function handleCropCommit(rect: PdfRect): void {
    if (reviewFrozenRef.current || !visibleSegment || !previewReadyForActionsRef.current
      || !visibleHasSourceGeometry || !isLegalRect(rect, visibleSegment.pageWidth, visibleSegment.pageHeight)) return;
    submitReviewDecision('crop', [{ ...visibleSegment, finalRect: rect, mode: 'manual',
      manualAdjusted: true, reviewStatus: 'confirmed' }], '裁剪调整已保存。');
  }

  function keepFullPage(): void {
    if (!visibleSegment || !previewReadyForActionsRef.current || !visibleHasSourceGeometry) return;
    submitReviewDecision('keep_full_page', [{ ...visibleSegment, mode: 'full_page', finalRect: null,
      reviewStatus: 'needs_review', manualAdjusted: true }], '已选择保留整页；请再次点击“确认当前片段”完成确认。');
  }

  function restoreLegacySuggestion(): void {
    if (!visibleSegment || !previewReadyForActionsRef.current || !visibleHasSourceGeometry) return;
    const suggestion = legacySuggestions[visibleSegment.id];
    if (!suggestion) return;
    try {
      const committed = applyLegacyReviewSuggestion(visibleSegment, suggestion);
      submitReviewDecision('restore_legacy', [committed], '已恢复历史裁剪建议，请确认当前片段。');
    } catch { setReviewNoticeMessage('历史裁剪建议与当前片段不一致，未恢复；请手动调整。'); }
  }

  function confirmCurrentSegment(): void {
    if (!visibleSegment || !previewReadyForActionsRef.current || !visibleHasSourceGeometry
      || (visibleSegment.mode !== 'full_page' && !isLegalRect(visibleSegment.finalRect, visibleSegment.pageWidth, visibleSegment.pageHeight))) return;
    submitReviewDecision('confirm_fragment', [{ ...visibleSegment, reviewStatus: 'confirmed' }],
      '第 ' + visibleSegment.sourcePage + ' 页 / 片段 ' + visibleSegment.segmentNo + ' 已确认。');
  }

  function confirmResolvedGroup(): void {
    if (!previewReadyForActionsRef.current || !groupReady || !allDocumentsValid || !reviewSetIntegrity.ok || reviewPairingError) return;
    submitReviewDecision('confirm_group', reviewSegments, '已整组确认，可继续导出。');
  }

  function validateExportTask(): string | null {
    if (reviewSavePendingRef.current || pendingReviewOperationRef.current) return '审核修改尚未保存，请先重试保存或放弃修改。';
    const session = reviewSessionRef.current;
    const job = persistentController.getSnapshot().current;
    if (!persistentTasksEnabled || !session || !job || job.id !== reviewTaskId
        || job.state !== 'ready_for_review' || job.result_revision !== session.original.resultRevision) {
      return '当前结果缺少完整的持久任务记录，请重新分析后导出。';
    }
    if (!allDocumentsValid) return sourceDocumentIntegrity.message;
    if (!reviewSetIntegrity.ok) return reviewSetIntegrity.message;
    if (reviewPairingError) return reviewPairingError;
    if (job.sources.some((source) => source.state === 'failed' || source.state === 'blocked' || source.state === 'pending') || job.page_summary.failed
        || job.page_summary.pending || job.page_summary.processing) return '任务尚未全部分析完成，请先处理失败文件。';
    if (!reviewSegments.length) return '当前任务没有可导出的片段。';
    return null;
  }

  function openExportScope(): void {
    if (reviewFrozenRef.current || exportInFlightRef.current) return;
    setExportScope({ kind: 'all' });
    setExportOutputMode('merged');
    setExportOutputName(defaultExportName(appliedSearch?.criteria.include ?? []));
    setIncludeXlsx(appSettingsRef.current.defaultIncludeXlsx);
    setExportScopeError(null);
    setExportFeedback(null);
    setExportScopeOpen(true);
    workspaceLockedRef.current = true;
  }

  function captureCurrentExportList(): void {
    if (exportInFlightRef.current) return;
    const source = reviewResultSources.find((item) => item.key === reviewSourceFilter);
    const filterName = { all: '全部状态', needs_review: '需复核', manual: '人工调整', blocked: '已阻塞' }[reviewFilter];
    setExportScope({ kind: 'list', segmentIds: [...visibleReviewIds],
      description: `${source?.label ?? '全部来源'} · ${filterName} · ${visibleReviewIds.size} 个片段` });
  }

  async function generateExportPreview(): Promise<void> {
    if (!mountedRef.current || !exportScopeOpen || exportInFlightRef.current) return;
    const outputNameError = validateExportName(exportOutputName);
    const invalidReason = validateExportTask() || exportScopeResolution.error
      || outputNameError
      || (exportScopeResolution.selectedUnresolvedCount ? '选定范围内仍有未解决片段，请返回审核。' : null)
      || (!exportScopeResolution.selectedCount ? '请至少选择一个片段。' : null);
    if (invalidReason) { setExportScopeError(invalidReason); return; }
    const session = reviewSessionRef.current!;
    const taskId = reviewTaskId!;
    const selected = exportScopeResolution.selectedSegments;
    let created: ExportBundlePreview | null = null;
    exportInFlightRef.current = true;
    workspaceLockedRef.current = true;
    setExportInFlight(true);
    setPreviewGenerating(true);
    setExportScopeError(null);
    setExportResult(null);
    setExportNotice('正在保存选定范围并生成最终 PDF 预览…');
    try {
      if (!reviewHistory.scope) reviewHistory.reset({ taskId, contextKey: session.prepared.context_key,
        resultRevision: session.original.resultRevision,
        sourceFingerprint: JSON.stringify(session.original.context.sources.map((source) => [source.source_key, source.source_sha256])) });
      const operation: PendingReviewOperation = { kind: 'confirm_scope', session, taskId, epoch: reviewHistory.epoch,
        sourceRevision: sourceIntegrityRevisionRef.current,
        expected: reviewCoordinator.decisionSnapshots(session, selected.map((segment) => segment.id)),
        segments: structuredClone(selected), message: `已保存本次导出范围：${selected.length} 个片段。` };
      if (!await runReviewOperation(operation)) {
        setExportScopeOpen(false);
        setExportFeedback(null);
        return;
      }
      const current = () => operationCurrent(operation) && operationGeometryValid(operation);
      if (!current()) throw new StaleReviewSessionError();
      const base = { taskId, reviewRevision: reviewRevisionRef.current,
        sourceIntegrityRevision: sourceIntegrityRevisionRef.current,
        reviewFingerprint: reviewExportFingerprint(reviewSegmentsRef.current), sources: exportSourcesFor(reviewSegmentsRef.current) };
      reviewViewBeforeExportRef.current = { navigation: navigation.captureView(), selectedId,
        reviewFilter, reviewSourceFilter, reviewSortOrder };
      created = await exportBundleClient.create({ job_id: taskId, result_revision: session.original.resultRevision,
        scope_kind: exportScope.kind, selected_segment_ids: selected.map((segment) => segment.id),
        expected_records: reviewCoordinator.decisionSnapshots(session, selected.map((segment) => segment.id))
          .map((row) => ({ id: row.decision.id, record_revision: row.recordRevision })),
        output_mode: exportOutputMode, include_xlsx: includeXlsx,
        output_name: normalizeExportName(exportOutputName) });
      if (created.summary.total_segments !== exportScopeResolution.totalSegments
          || created.summary.expected_pages !== exportScopeResolution.expectedPages
          || created.summary.selected_source_count !== exportScopeResolution.selectedSourceKeys.length) {
        throw new Error('后端导出范围统计与已确认内容不一致，请重新分析。');
      }
      const first = created.files[0];
      const snapshot: ExportPreviewSnapshot = { ...base, bundle: created,
        previewToken: first.preview_token, previewPath: first.preview_path, previewSha256: first.sha256, pageCount: first.page_count };
      if (!current() || !isCurrentExportSnapshot(snapshot)) throw new StaleReviewSessionError();
      exportPreviewRef.current = snapshot;
      setExportPreview(snapshot);
      setExportScopeOpen(false);
      setExportPreviewPage(1);
      setExportPreviewImage('');
      setExportPreviewError('');
      setExportPreviewRetry((value) => value + 1);
      setExportNotice(`已生成 ${created.files.length} 份 PDF 预览，共 ${created.total_pages} 页。可切换文件检查；选择目录后发布相同内容。`);
    } catch (error) {
      const cleaned = created ? await closeExportBundle(created.intent_id) : true;
      reviewViewBeforeExportRef.current = null;
      if (mountedRef.current) setExportScopeError(`生成预览失败：${error instanceof Error ? error.message : '未知错误'}${cleaned ? '' : '；临时预览清理尚未完成，将在退出时重试。'}`);
    } finally {
      exportInFlightRef.current = false;
      if (mountedRef.current) { setExportInFlight(false); setPreviewGenerating(false); }
    }
  }

  function selectExportPreviewFile(fileId: string): void {
    const current = exportPreviewRef.current;
    if (!current || exportInFlightRef.current) return;
    const file = current.bundle.files.find((item) => item.file_id === fileId);
    if (!file || file.preview_token === current.previewToken) return;
    const snapshot = { ...current, previewToken: file.preview_token, previewPath: file.preview_path,
      previewSha256: file.sha256, pageCount: file.page_count };
    exportPreviewRef.current = snapshot;
    setExportPreview(snapshot);
    setExportPreviewPage(1);
    setExportPreviewImage('');
    setExportPreviewError('');
  }

  function adoptExportReceipt(receipt: ExportBundleReceipt, recovered = false): void {
    const pdfs = receipt.files.filter((file) => file.kind === 'pdf');
    const index = receipt.files.find((file) => file.kind === 'xlsx');
    setExportResult({ directory: receipt.directory, indexPath: index?.path ?? null, pdfPath: pdfs[0].path,
      rowCount: index ? receipt.row_count : null, pageCount: receipt.total_pages, pdfCount: pdfs.length });
    setReviewNoticeMessage(`${recovered ? '已找回上次导出结果' : '导出成功'}：${pdfs.length} 份 PDF，共 ${receipt.total_pages} 页${index ? `，${receipt.row_count} 条索引` : ''}。输出目录：${receipt.directory}`);
  }

  async function exportConfirmedPreview(): Promise<void> {
    const snapshot = exportPreviewRef.current;
    if (!snapshot || !isCurrentExportSnapshot(snapshot)) {
      if (mountedRef.current) { clearExportPreview(); setExportNotice('导出预览已失效，请重新生成。'); }
      return;
    }
    if (exportInFlightRef.current) return;
    exportInFlightRef.current = true;
    setExportInFlight(true);
    setExportNotice('请选择输出目录。取消选择不会生成文件。');
    let receipt: ExportBundleReceipt | null = null;
    let recovered = false;
    try {
      const selectedDirectory = await localEngineAdapter.pickOutputFolder(appSettingsRef.current.lastOutputDirectory);
      if (!mountedRef.current) return;
      const directory = selectedDirectory?.trim();
      if (!directory) { setExportNotice('已取消目录选择；导出预览仍保留，可继续检查或再次导出。'); return; }
      updateAppSettings({ ...appSettingsRef.current, lastOutputDirectory: directory });
      if (!isCurrentExportSnapshot(snapshot)) throw new Error('审核内容已变化，请重新生成导出预览。');
      setExportNotice('正在生成整套结果；完成后将放入新的结果文件夹…');
      try {
        receipt = await exportBundleClient.publish(snapshot.bundle, directory);
      } catch (error) {
        // A lost reply can follow a successful atomic directory rename. Read
        // the journal before presenting a retry; never delete delivered files.
        const status = await exportBundleClient.status(snapshot.taskId).catch(() => null);
        if (status?.publication?.intent_id === snapshot.bundle.intent_id) {
          receipt = parseExportBundleReceipt(status.publication, snapshot.bundle);
          recovered = true;
        } else {
          const residuals = error instanceof ExportBundleError ? error.residuals : [];
          const allResiduals = [...residuals, ...(status?.residuals ?? [])];
          const residualNotice = [...new Map(allResiduals.map((item) => [item.path, item])).values()]
            .map((item) => `${item.path}（${item.reason}）`).join('；');
          throw new Error(`${error instanceof Error ? error.message : '导出未完成'}${residualNotice ? `。仍需处理：${residualNotice}` : ''}`);
        }
      }
      const cleaned = await closeExportBundle(snapshot.bundle.intent_id);
      if (!mountedRef.current) return;
      clearExportPreview(false);
      setExportFeedback(null);
      adoptExportReceipt(receipt, recovered);
      if (!cleaned) setReviewNoticeMessage(`整套结果已成功生成：${receipt.directory}。临时预览清理尚未完成，退出时将重试。`);
    } catch (error) {
      if (mountedRef.current) setExportNotice(`导出失败：${error instanceof Error ? error.message : '未知错误'}。预览已保留，可重新选择目录后重试。`);
    } finally {
      exportInFlightRef.current = false;
      if (mountedRef.current) setExportInFlight(false);
    }
  }

  async function returnFromExportPreview(): Promise<void> {
    if (exportInFlightRef.current) return;
    const snapshot = reviewViewBeforeExportRef.current;
    reviewViewBeforeExportRef.current = null;
    const current = exportPreviewRef.current;
    // Keep the workspace locked while the temporary preview is being cleaned
    // up. This prevents a picker/search event from racing the restore.
    workspaceLockedRef.current = true;
    setExportInFlight(true);
    clearExportPreview(false);
    const cleanupSucceeded = current
      ? await closeExportBundle(current.bundle.intent_id)
      : true;
    if (mountedRef.current) {
      if (snapshot) {
        navigation.restoreView(snapshot.navigation);
        setSelectedId(snapshot.selectedId);
        setReviewFilter(snapshot.reviewFilter);
        setReviewSourceFilter(snapshot.reviewSourceFilter);
        setReviewSortOrder(snapshot.reviewSortOrder);
      }
      setReviewNoticeMessage(cleanupSucceeded
        ? '已返回裁剪审核；临时 PDF 预览已清理。'
        : '已返回裁剪审核；临时 PDF 预览清理失败，退出应用时将自动重试。');
      setExportInFlight(false);
      workspaceLockedRef.current = false;
    }
  }

  async function openExportDirectory(): Promise<void> {
    if (!exportResult) return;
    try {
      await localEngineAdapter.openOutputFolder(exportResult.pdfPath);
      setReviewNoticeMessage('已打开结果所在目录。');
    } catch (error: unknown) {
      setReviewNoticeMessage(`打开目录失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  const reviewActionSegment = selectedSegment
    ? {
        sourcePage: selectedSegment.sourcePage,
        segmentNo: selectedSegment.segmentNo,
        reviewStatus: selectedSegment.reviewStatus,
      }
    : null;
  const fragmentActionsEnabled = Boolean(
    visibleSegment
      && visibleHasSourceGeometry
      && previewReadyForActions
      && !reviewFrozen,
  );
  const fragmentDisabledReason = selectedSegment && !visibleSegment
    ? '当前预览页无命中，请选择右侧片段继续审核'
    : reviewFrozenReason
      ? reviewFrozenReason
    : selectedSegment && !fragmentActionsEnabled
      ? sourceGeometryMessage(selectedSegment)
      : undefined;
  const canGeneratePreview = Boolean(reviewSegments.length && !reviewFrozen);
  const canExportPreview = Boolean(
    exportPreview
      && isCurrentExportSnapshot(exportPreview)
      && !exportPreviewLoading
      && !exportPreviewError
      && Boolean(exportPreviewImage),
  );
  // Reading the history list does not participate. New current-task failure
  // evidence wins; explicitly rechecking a known failure can clear it.
  const displayOcrState = currentTaskOcrIssue && taskOcrIssueKey !== checkedTaskOcrIssueKey
    ? currentTaskOcrIssue : ocrState;

  return (
    <main className="app-shell">
      <input ref={pdfInputRef} type="file" accept=".pdf,application/pdf" multiple onChange={(event) => handleFilesSelected(event, 'file')} style={{ display: 'none' }} disabled={workspaceLocked || isRunning} />
      <input ref={folderInputRef} type="file" accept=".pdf,application/pdf" multiple onChange={(event) => handleFilesSelected(event, 'folder')} style={{ display: 'none' }} disabled={workspaceLocked || isRunning} />

      <header className="topbar">
        <div className="brand-mark">P</div>
        <div><div className="brand-subtitle">{APP_SUBTITLE}</div><h1>{APP_NAME}</h1></div>
        <div className="topbar-actions">
          <span className="privacy-badge"><span className="status-dot" />{engineStatus === 'ready' ? `本地引擎已连接 · OCR ${ocrReadinessLabel(displayOcrState)}` : engineStatus === 'checking' ? '本地引擎检查中' : '本地处理不可用'}</span>
          <button
            ref={settingsEntryRef}
            className="ghost-button"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(true)}
          >
            设置
          </button>
          <button className="primary-button" type="button" aria-haspopup="dialog" aria-expanded={helpOpen} onClick={() => setHelpOpen(true)}>帮助与反馈</button>
        </div>
      </header>

      <ResizableWorkspace resetSignal={workspaceResetSignal}>
        {persistentTasksEnabled && taskHistoryOpen ? <TaskHistoryPanel
          open={taskHistoryOpen}
          view={taskPanelView}
          onViewChange={(view) => {
            setTaskPanelView(view);
            if (view === 'history') void persistentController.refreshList();
          }}
          pendingSources={sourcePanelFiles.map(({ name, pageCount }) => ({ name, pageCount }))}
          onClose={() => setTaskHistoryOpen(false)}
          jobs={persistent.jobs}
          selectedJob={taskPanelJob}
          loading={persistent.loading}
          busy={persistent.busy || searchLoading || analysisLoading}
          locked={workspaceLocked || groupSavePending}
          error={persistent.error}
          hasMore={persistent.nextOffset !== null}
          onRefresh={() => { void persistentController.refreshList(); void persistentController.refreshCurrent(); }}
          onLoadMore={() => void persistentController.refreshList(true)}
          onSelect={(id) => void selectPersistentTask(id)}
          onResume={() => {
            autoOpenJobRef.current = persistent.current?.id ?? null;
            void persistentController.resume();
          }}
          onPause={() => void persistentController.control('pause')}
          onCancel={() => void persistentController.control('cancel')}
          onArchive={() => void persistentController.control('archive')}
          onLoadReview={() => { if (persistent.current) void loadPersistentReview(persistent.current); }}
          onRelocate={(id) => void relocatePersistentSource(id)}
          onDelete={(id) => void planTaskCleanup(id)}
          onOpenCleanup={openCleanupStatus}
          onNewTask={startNewTask}
          newTaskDisabled={newTaskDisabled}
        /> : <SourcePanel
          files={sourcePanelFiles}
          activeSourcePath={navigation.activeSourcePath}
          notice={sourcePanelNotice}
          batchFeedback={batchFeedback}
          onOpenCurrentTask={persistentTasksEnabled && (taskPanelJob || taskPanelRequest) ? () => {
            setTaskPanelView('current'); setTaskHistoryOpen(true);
          } : undefined}
          onOpenHistory={persistentTasksEnabled ? () => {
            setTaskPanelView('history'); setTaskHistoryOpen(true); void persistentController.refreshList();
          } : undefined}
          onNewTask={startNewTask}
          newTaskDisabled={newTaskDisabled}
          disabled={workspaceLocked || isRunning}
          onPickFiles={() => void openPicker('file')}
          onPickFolder={() => void openPicker('folder')}
          onAddFiles={() => void openPicker('file', true)}
          onAddFolder={() => void openPicker('folder', true)}
          onSelectSource={(sourcePath) => {
            if (workspaceLockedRef.current) return;
            navigation.selectSource(sourcePath);
          }}
          onRemoveAll={clearActiveSources}
          onRemoveSelected={removeSourcePaths}
          onRemoveSource={removeSourcePath}
        />}

        <section className="preview-column panel">
          <div className="editor-panel">
            {exportPreview ? <ExportPdfPreview
              files={exportPreview.bundle.files.map((file) => ({ id: file.file_id, name: file.name, pageCount: file.page_count }))}
              selectedFileId={exportPreview.bundle.files.find((file) => file.preview_token === exportPreview.previewToken)?.file_id}
              onFileChange={selectExportPreviewFile}
              fileSelectionDisabled={exportInFlight}
              summary={`本次导出 ${exportPreview.bundle.summary.selected_count} / ${exportPreview.bundle.summary.total_segments} 个片段，${exportPreview.bundle.summary.selected_source_count} 个来源；未选中 ${exportPreview.bundle.summary.omitted_count} 个（未解决 ${exportPreview.bundle.summary.omitted_unresolved_count} 个）。合并版 ${exportPreview.bundle.merged_pages} 页，来源版 ${exportPreview.bundle.source_pages} 页，共 ${exportPreview.bundle.files.length} 份 PDF、${exportPreview.bundle.total_pages} 页。${exportPreview.bundle.include_xlsx ? '包含 XLSX 索引。' : ''}`}
              imageData={exportPreviewImage}
              page={exportPreviewPage}
              pageCount={exportPreview.pageCount}
              zoom={exportPreviewZoom}
              loading={exportPreviewLoading}
              error={exportPreviewError}
              onPrevious={() => setExportPreviewPage((page) => Math.max(1, page - 1))}
              onNext={() => setExportPreviewPage((page) => Math.min(exportPreview.pageCount, page + 1))}
              onZoomOut={() => setExportPreviewZoom((value) => Math.max(25, value - 25))}
              onZoomIn={() => setExportPreviewZoom((value) => Math.min(200, value + 25))}
              onRetry={() => setExportPreviewRetry((value) => value + 1)}
            /> : <SourceDocumentPreview
               document={activeDocument}
               location={previewLocation}
               pageDraft={navigation.pageDraft}
               pageInputError={navigation.pageInputError}
               preview={previewForDisplay}
               visibleSegment={visibleSegment}
               currentSegmentLabel={currentSegmentLabel}
               editorRect={visibleEditorRect}
               zoom={zoom}
               loading={previewLoading}
               error={centralPreviewError}
               navigationDisabled={navigationDisabled}
               editorDisabled={reviewFrozen || !previewReadyForActions}
               onPrevious={navigation.previousPage}
               onNext={navigation.nextPage}
               onPageDraftChange={navigation.setPageDraft}
               onPageDraftSubmit={navigation.submitPageDraft}
               onPageDraftCancel={navigation.cancelPageDraft}
               onZoomOut={() => setZoom((current) => Math.max(50, current - 25))}
               onZoomIn={() => setZoom((current) => Math.min(200, current + 25))}
               onRetry={() => setPreviewRetry((value) => value + 1)}
               onCropChange={handleCropChange}
              onCropCommit={handleCropCommit}
           />}
          </div>
          {(appliedSearch || exportPreview) && (
            <div className="preview-action-dock">
              {exportPreview ? <ReviewActionCard
                mode="export"
                feedback={exportFeedback}
                result={exportResult}
                onOpenResult={() => void openExportDirectory()}
                includeXlsx={exportPreview.bundle.include_xlsx}
                optionsFrozen
                onIncludeXlsxChange={setIncludeXlsx}
                exportPending={exportInFlight}
                canExport={canExportPreview}
                onReturn={() => void returnFromExportPreview()}
                onExport={() => void exportConfirmedPreview()}
              /> : <ReviewActionCard
                mode="review"
                // Preview generation errors are owned by the export flow, but the
                // review card remains mounted until a preview snapshot exists.
                // Prefer that transient export feedback here so a failed preview
                // is visible in the same (single) action feedback region.
                feedback={exportFeedback ?? reviewFeedback}
                result={exportResult}
                onOpenResult={() => void openExportDirectory()}
                currentSegment={reviewActionSegment}
                fragmentActionsEnabled={fragmentActionsEnabled}
                fragmentDisabledReason={fragmentDisabledReason}
                onKeepFullPage={keepFullPage}
                hasLegacySuggestion={Boolean(visibleSegment && legacySuggestions[visibleSegment.id])}
                onRestoreLegacySuggestion={restoreLegacySuggestion}
                onConfirmCurrent={confirmCurrentSegment}
                canConfirmGroup={groupReady && previewReadyForActions && !reviewFrozen}
                groupSavePending={groupSavePending}
                groupConfirmed={isGroupConfirmed}
                unresolvedCount={unresolvedCount}
                totalCount={reviewSegments.length}
                reviewFrozenReason={reviewFrozenReason}
                onConfirmGroup={confirmResolvedGroup}
                canGeneratePreview={canGeneratePreview}
                previewGenerating={previewGenerating}
                scopeSelectionEnabled
                onGeneratePreview={openExportScope}
                operationTools={<ReviewOperationTools
                  onBatchCrop={openBatchCrop}
                  batchCropDisabledReason={batchSampleError(visibleSegment) ?? (!previewReadyForActions || !visibleHasSourceGeometry ? '请等待当前页面预览完成' : undefined)}
                  busy={reviewSavePending}
                  frozenReason={editingAppliedSearch ? '修改完成前暂停审核' : isRunning ? '正在分析' : workspaceLocked ? '请先返回调整' : undefined}
                  unsavedMessage={unsavedReviewMessage}
                  historyCount={reviewHistoryCount}
                  canUndo={reviewHistoryCount > 0}
                  undoDisabledReason={reviewHistoryCount === 0 ? '本次任务尚无可撤销的已保存操作' : undefined}
                  onUndo={undoLastReviewOperation}
                  canRestoreCandidate={Boolean(canRestoreAutomaticCandidate && visibleHasSourceGeometry && previewReadyForActions)}
                  restoreDisabledReason={canRestoreAutomaticCandidate ? fragmentDisabledReason : '当前片段没有可恢复的有效自动候选'}
                  onRestoreCandidate={restoreAutomaticCandidate}
                  visibleUnresolvedCount={visibleUnresolvedCount}
                  hiddenUnresolvedCount={unresolvedCount - visibleUnresolvedCount}
                  onNextUnresolved={() => nextUnresolvedReview()}
                  onRevealUnresolved={() => nextUnresolvedReview(true)}
                  onRetry={() => { const operation = pendingReviewOperationRef.current; if (operation) void runReviewOperation(operation); }}
                  onDiscard={() => void discardUnsavedReview()}
                />}
              />}
            </div>
          )}
        </section>

        <aside className="results-column panel" aria-label="查找与审核">
          <div
            className="search-criteria-panel-host"
            onKeyDown={(event) => {
              if (
                event.key !== 'Enter'
                || event.defaultPrevented
                || event.nativeEvent.isComposing
                || !(event.target instanceof HTMLInputElement)
                || event.target.type !== 'text'
                || !/^(包含|排除)关键词/.test(event.target.getAttribute('aria-label') ?? '')
              ) return;
              event.preventDefault();
              if (!searchModificationDisabled && hasReadableSources && engineStatus === 'ready' && normalizeSearchCriteria(searchDraft.criteria)) {
                void runSearch(sourceFiles, cloneSearchSettings(searchDraft));
              }
            }}
          >
            <SearchCriteriaPanel
              draft={searchDraft.criteria}
              draftMode={searchDraft.matchMode}
              appliedSummary={appliedSearch ? searchCriteriaSummary(appliedSearch.criteria) : null}
              appliedMode={appliedSearch?.matchMode ?? null}
              hitCount={reviewRows.length}
              canAnalyze={hasReadableSources && engineStatus === 'ready'}
              analyzeUnavailableReason={!hasReadableSources ? '选择来源后即可开始分析' : engineStatus !== 'ready' ? '本地处理引擎暂不可用' : undefined}
              expanded={searchEditorExpanded}
              running={isRunning}
              disabled={searchModificationDisabled}
              disabledReason={searchModificationDisabledReason}
              feedback={searchPanelFeedback}
              batchFeedback={batchFeedback}
              retryFailedCount={retryState?.count ?? 0}
              retryNotice={retryState?.notice}
              onRetryFailed={() => {
                if (retryState && batchRunner.canRetry(retryState.context)) {
                  void runSearch(sourceFiles, cloneSearchSettings(searchDraft), true);
                }
              }}
              onBeginEdit={beginSearchEdit}
              onCancelEdit={cancelSearchEdit}
              onDraftChange={handleDraftCriteriaChange}
              onDraftModeChange={handleDraftMatchModeChange}
              onAnalyze={() => void runSearch(sourceFiles, cloneSearchSettings(searchDraft))}
              keywordHistory={keywordHistory}
              onRemoveKeywordHistory={removeKeywordHistoryItem}
              onClearKeywordHistory={clearKeywordHistoryItems}
            />
          </div>
          {appliedSearch ? (
            <ReviewNavigator
              rows={reviewRows}
              selectedId={selectedId}
              activeFilter={reviewFilter}
              onFilterChange={changeReviewFilter}
              sourceFilter={reviewSourceFilter}
              sortOrder={reviewSortOrder}
              sources={reviewResultSources}
              onSourceFilterChange={changeReviewSourceFilter}
              onSortOrderChange={changeReviewSortOrder}
              onResetFilters={resetReviewFilters}
              onRevealSelected={revealSelectedReviewSegment}
              viewControlsDisabled={reviewViewControlsDisabled}
              onSelect={selectSegment}
              showSourceName={sourceFiles.length > 1}
              showKeyboardHints={appSettings.showKeyboardHints}
              navigationDisabled={navigationDisabled}
              stale={searchEditorExpanded || isRunning}
              pairingError={reviewPairingError}
              emptyMessage={reviewNavigatorEmptyMessage}
              emptyActionLabel={showEmptySearchAction ? '修改搜索条件' : undefined}
              onEmptyAction={showEmptySearchAction ? beginSearchEdit : undefined}
            />
          ) : (
            <div className="review-navigator-empty review-workspace-guidance" role="status">
              {hasReadableSources ? '设置搜索条件并开始分析。' : '请先选择 PDF 或文件夹，再开始分析。'}
            </div>
          )}
        </aside>
      </ResizableWorkspace>
      {batchCropSession && <BatchCropDialog sample={batchCropSession.sample} scope={batchCropScope}
        plan={batchCropPlan} progress={batchCropProgress} busy={batchCropBusy} applying={batchCropApplying}
        error={batchCropError} onScopeChange={(scope) => { setBatchCropScope(scope); void buildBatchCropPlan(batchCropSession, scope); }}
        loadPreview={(segment) => loadBatchCropPreview(segment, 'foreground')}
        onApply={() => void applyBatchCrop()} onClose={() => closeBatchCrop()} />}
      <div ref={exportScopeHostRef}>
        {exportScopeOpen && <ExportScopeSettings
          sources={exportScopeSources}
          scope={exportScope}
          summary={exportScopeResolution}
          outputMode={exportOutputMode}
          outputName={exportOutputName}
          outputNameError={validateExportName(exportOutputName)}
          includeXlsx={includeXlsx}
          busy={previewGenerating || exportInFlight}
          taskError={validateExportTask()}
          operationError={exportScopeError}
          currentListCount={visibleReviewIds.size}
          onScopeChange={(scope) => { setExportScope(scope); setExportScopeError(null); }}
          onCaptureCurrentList={captureCurrentExportList}
          onOutputModeChange={(mode) => { setExportOutputMode(mode); setExportScopeError(null); }}
          onOutputNameChange={(name) => { setExportOutputName(name); setExportScopeError(null); }}
          onIncludeXlsxChange={setIncludeXlsx}
          onGenerate={() => void generateExportPreview()}
          onCancel={() => { if (!exportInFlightRef.current) setExportScopeOpen(false); }}
        />}
      </div>
      {persistentTasksEnabled && <TaskCleanupPanel
        open={cleanupOpen}
        onClose={() => setCleanupOpen(false)}
        plan={cleanupPlan}
        history={cleanupHistory}
        usage={cleanupUsage}
        busy={cleanupBusy}
        locked={previewGenerating || Boolean(exportPreview) || exportInFlight || groupSavePending || isRunning}
        error={cleanupError}
        hasMore={cleanupNextOffset !== null}
        onExecute={(id, deleteReview) => {
          if (cleanupPlan?.cleanup_id === id) void executeTaskCleanup(cleanupPlan, deleteReview);
        }}
        onRetry={(item) => {
          if (item.delete_review !== null) void executeTaskCleanup(item, item.delete_review);
        }}
        onRefresh={() => void runCleanupOperation(() => readCleanupStatus())}
        onLoadMore={() => void runCleanupOperation(() => readCleanupStatus(true))}
        onMaintain={() => void maintainTaskStorage()}
        onCancelPlan={() => setCleanupPlan(null)}
      />}
      <SettingsDialog
        open={settingsOpen}
        settings={appSettings}
        storageWarning={settingsWarning}
        onChange={updateAppSettings}
        onReset={resetAppSettings}
        onResetColumns={() => setWorkspaceResetSignal((value) => value + 1)}
        onClose={closeSettingsDialog}
        onChooseInputDirectory={(draft) => void chooseDirectory('lastInputDirectory', draft)}
        onChooseOutputDirectory={(draft) => void chooseDirectory('lastOutputDirectory', draft)}
        onInputDirectoryCommit={(draft) => void commitDirectory('lastInputDirectory', draft)}
        onOutputDirectoryCommit={(draft) => void commitDirectory('lastOutputDirectory', draft)}
        inputDirectoryDraftResetToken={inputDirectoryDraftResetToken}
        outputDirectoryDraftResetToken={outputDirectoryDraftResetToken}
        directoryPickerBusy={directoryPickerBusy}
        directoryPickerError={directoryPickerError}
      />
      <HelpCenterDialog
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        engineStatus={engineStatus}
        ocrState={displayOcrState}
        onCheckOcr={checkOcr}
        ocrCacheInfo={ocrCacheState}
        onReadOcrCache={readOcrCache}
        onClearOcrCache={clearOcrCache}
        analysisInProgress={isRunning}
      />
    </main>
  );
}
