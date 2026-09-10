import type { EngineMatch, EngineOriginalReview, EngineReviewContext } from '../components/localEngineAdapter';
import type { PdfRect, ReviewSegment } from './cropReview';
import { normalizeSearchCriteria, searchCriteriaClauses, type SearchCriteria } from './searchCriteria';
import { normalizeSourcePath, type SourceDocument } from './sourcePreview';

type OriginalEvidence = EngineMatch & { query_id?: string; role?: 'include' | 'exclude' };

export type OriginalReviewContextInput = {
  documents: SourceDocument[];
  criteria: SearchCriteria;
  matchMode: 'exact' | 'fuzzy';
  computationVersion: string;
  segments: ReviewSegment[];
  evidenceById: Record<string, OriginalEvidence[]>;
};

export type OriginalReviewContext = {
  context: EngineReviewContext;
  originals: EngineOriginalReview[];
  resultRevision: string;
};

const digestPattern = /^[a-f0-9]{64}$/;

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('原始分析数据与审核上下文不一致，请重新分析。');
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !value.includes('\0');
}

function rawRect(rect: PdfRect | null): PdfRect | null {
  return rect === null ? null : { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 };
}

function finiteRect(rect: PdfRect | null): PdfRect | null {
  return rect && [rect.x0, rect.y0, rect.x1, rect.y1].every(Number.isFinite) ? rawRect(rect) : null;
}

function inside(rect: PdfRect | null, width: number, height: number): boolean {
  return rect !== null && rect.x0 >= 0 && rect.y0 >= 0 && rect.x1 > rect.x0 && rect.y1 > rect.y0
    && rect.x1 <= width && rect.y1 <= height;
}

async function fingerprint(value: object): Promise<string> {
  // Preserve invalid numeric evidence in the signature; JSON's default would
  // silently collapse NaN and both infinities to the same null value.
  const json = JSON.stringify(value, (_key, item: unknown) => typeof item === 'number' && !Number.isFinite(item)
    ? { invalidNumber: String(item) } : item);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

/** Call once on fresh analysis, before applying any persisted/manual decision. */
export async function buildOriginalReviewContext(input: OriginalReviewContextInput): Promise<OriginalReviewContext> {
  const snapshot = structuredClone(input);
  const criteria = normalizeSearchCriteria(snapshot.criteria);
  requireValid(criteria && ['exact', 'fuzzy'].includes(snapshot.matchMode));
  requireValid(text(snapshot.computationVersion, 256));
  requireValid(snapshot.documents.length > 0 && snapshot.documents.length <= 10_000 && snapshot.segments.length <= 50_000);
  const documentByKey = new Map<string, SourceDocument>();
  const sources = snapshot.documents.map((document) => {
    requireValid(text(document.sourcePath, 32768) && document.integrityStatus === 'valid');
    const key = normalizeSourcePath(document.sourcePath);
    const sha = document.sourceSha256.toLowerCase();
    requireValid(digestPattern.test(sha) && !documentByKey.has(key));
    requireValid(Number.isSafeInteger(document.pageCount) && document.pageCount > 0);
    documentByKey.set(key, document);
    return { source_key: key, source_path: document.sourcePath, source_sha256: sha };
  });
  const clauses = searchCriteriaClauses(criteria);
  const criteriaFingerprint = await fingerprint({ criteria, match_mode: snapshot.matchMode, clauses });
  const originals: EngineOriginalReview[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const segment of snapshot.segments) {
    requireValid(text(segment.id, 1024) && !ids.has(segment.id) && text(segment.sourcePath, 32768));
    const sourceKey = normalizeSourcePath(segment.sourcePath);
    const document = documentByKey.get(sourceKey);
    requireValid(document && document.sourceSha256.toLowerCase() === segment.sourceSha256.toLowerCase());
    requireValid(Number.isSafeInteger(segment.segmentNo) && segment.segmentNo > 0);
    requireValid(text(segment.layoutFingerprint, 1024) && Number.isFinite(segment.confidence) && segment.confidence >= 0 && segment.confidence <= 1);
    const page = Number.isSafeInteger(segment.sourcePage) ? segment.sourcePage : 0;
    const key = JSON.stringify([sourceKey, page, segment.segmentNo]);
    requireValid(!keys.has(key));
    ids.add(segment.id);
    keys.add(key);
    const evidence = snapshot.evidenceById[segment.id];
    requireValid(Array.isArray(evidence) && evidence.length > 0);
    for (const hit of evidence) {
      requireValid(hit.source_path === undefined || normalizeSourcePath(hit.source_path) === sourceKey);
      requireValid(hit.source_sha256 === undefined || hit.source_sha256.toLowerCase() === document.sourceSha256.toLowerCase());
    }
    const width = Number.isFinite(segment.pageWidth) && segment.pageWidth > 0 ? segment.pageWidth : 0;
    const height = Number.isFinite(segment.pageHeight) && segment.pageHeight > 0 ? segment.pageHeight : 0;
    const matchRect = finiteRect(segment.matchRect);
    const candidateRect = finiteRect(segment.candidateRect);
    const autoFullPage = segment.mode === 'full_page';
    const signature = await fingerprint({
      version: 2, page: segment.sourcePage, page_width: segment.pageWidth, page_height: segment.pageHeight,
      match_rect: rawRect(segment.matchRect), candidate_rect: rawRect(segment.candidateRect), auto_full_page: autoFullPage,
      confidence: segment.confidence, layout_fingerprint: segment.layoutFingerprint, slot: segment.slot,
      snap_points: segment.snapPoints ?? [],
      evidence: evidence.map((hit) => ({ page: hit.page, matched_text: hit.matched_text, matched_field: hit.matched_field,
        confidence: hit.confidence, needs_review: hit.needs_review ?? false,
        x0: hit.x0, y0: hit.y0, x1: hit.x1, y1: hit.y1, query_id: hit.query_id ?? null, role: hit.role ?? null })),
    });
    originals.push({
      id: segment.id, source_key: sourceKey, source_page: page, segment_no: segment.segmentNo, analysis_signature: signature,
      persistable: page > 0 && page <= document.pageCount && width > 0 && height > 0 && inside(matchRect, width, height)
        && (segment.candidateRect === null || inside(candidateRect, width, height)),
      page_width: width, page_height: height, match_rect: matchRect, candidate_rect: candidateRect,
      layout_fingerprint: segment.layoutFingerprint, confidence: segment.confidence, auto_full_page: autoFullPage,
    });
  }
  return freezeTree({
    context: { version: 2, sources, criteria_fingerprint: criteriaFingerprint, computation_version: snapshot.computationVersion },
    originals, resultRevision: crypto.randomUUID(),
  });
}
