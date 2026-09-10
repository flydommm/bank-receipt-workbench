import type { SourceDocument } from './sourcePreview';
import { normalizeSourcePath } from './sourcePreview';

export type SelectedSourceReference = {
  sourcePath: string;
};

export type ReviewSetHit = {
  sourceKey?: string;
  sourcePath: string;
  sourcePage: number;
  sourceSha256: string;
};

export type ReviewSetSegment = ReviewSetHit & {
  id: string;
  segmentNo: number;
};

export type IntegrityResult =
  | { ok: true; message: '' }
  | { ok: false; message: string };

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function validNormalizedPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const normalized = normalizeSourcePath(value);
  return normalized.length > 0 ? normalized : null;
}

function isStrictSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function normalizeSha256(value: string): string {
  return value.toLowerCase();
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function ok(): IntegrityResult {
  return { ok: true, message: '' };
}

function sourceError(): IntegrityResult {
  return { ok: false, message: '来源文件元数据不完整、已变化或不属于当前选择。' };
}

function malformedPathError(): IntegrityResult {
  return { ok: false, message: '来源或文档元数据存在空路径。' };
}

function duplicatePathError(): IntegrityResult {
  return { ok: false, message: '来源或文档元数据存在重复路径。' };
}

export function validateSourceDocumentIntegrity(
  sources: readonly SelectedSourceReference[],
  documents: readonly Pick<
    SourceDocument,
    'sourcePath' | 'sourceSha256' | 'integrityStatus'
  >[],
): IntegrityResult {
  if (
    !Array.isArray(sources)
    || !Array.isArray(documents)
    || sources.length === 0
    || sources.length !== documents.length
  ) {
    return { ok: false, message: '所选来源与文档元数据数量不一致。' };
  }

  const selectedPaths = new Set<string>();
  for (const source of sources) {
    const normalizedPath = validNormalizedPath(source?.sourcePath);
    if (!normalizedPath) return malformedPathError();
    if (selectedPaths.has(normalizedPath)) return duplicatePathError();
    selectedPaths.add(normalizedPath);
  }

  const documentsByPath = new Map<string, string>();
  for (const document of documents) {
    const normalizedPath = validNormalizedPath(document?.sourcePath);
    if (!normalizedPath) return malformedPathError();
    if (documentsByPath.has(normalizedPath)) return duplicatePathError();
    if (
      document.integrityStatus !== 'valid'
      || !isStrictSha256(document.sourceSha256)
    ) {
      return sourceError();
    }
    documentsByPath.set(normalizedPath, normalizeSha256(document.sourceSha256));
  }

  if (selectedPaths.size !== documentsByPath.size) return sourceError();
  for (const selectedPath of selectedPaths) {
    if (!documentsByPath.has(selectedPath)) return sourceError();
  }

  return ok();
}

export function validateReviewSetIntegrity(
  documents: readonly Pick<SourceDocument, 'sourcePath' | 'sourceSha256'>[],
  hits: readonly ReviewSetHit[],
  segments: readonly ReviewSetSegment[],
): IntegrityResult {
  if (!Array.isArray(documents) || !Array.isArray(hits) || !Array.isArray(segments)) {
    return { ok: false, message: '审核集合数据格式无效。' };
  }

  if (hits.length !== segments.length) {
    return {
      ok: false,
      message: `${hits.length} 个引擎命中，${segments.length} 个审核片段，数量无法配对。`,
    };
  }

  const documentShaByPath = new Map<string, string>();
  for (const document of documents) {
    const normalizedPath = validNormalizedPath(document?.sourcePath);
    if (!normalizedPath) return malformedPathError();
    if (documentShaByPath.has(normalizedPath)) return duplicatePathError();
    if (!isStrictSha256(document.sourceSha256)) return sourceError();
    documentShaByPath.set(normalizedPath, normalizeSha256(document.sourceSha256));
  }

  const ids = new Set<string>();
  const groupPositions = new Map<string, number>();

  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    const segment = segments[index];

    if (!isRecord(hit) || !isRecord(segment)) {
      return { ok: false, message: '审核集合包含无效的命中或片段元素。' };
    }

    if (
      !isPositiveSafeInteger(hit.sourcePage)
      || !isPositiveSafeInteger(segment.sourcePage)
      || !isPositiveSafeInteger(segment.segmentNo)
    ) {
      return { ok: false, message: '来源页码和片段序号必须是正安全整数。' };
    }

    const id = typeof segment.id === 'string' ? segment.id.trim() : '';
    if (!id || ids.has(id)) {
      return { ok: false, message: '审核片段存在空 ID 或重复 ID，无法安全配对。' };
    }
    ids.add(id);

    const hitPath = validNormalizedPath(hit.sourcePath);
    const segmentPath = validNormalizedPath(segment.sourcePath);
    if (!hitPath || !segmentPath) return malformedPathError();
    if (!isStrictSha256(hit.sourceSha256) || !isStrictSha256(segment.sourceSha256)) {
      return { ok: false, message: '命中结果或审核片段的 SHA-256 无效。' };
    }

    const documentSha = documentShaByPath.get(hitPath);
    if (
      hitPath !== segmentPath
      || hit.sourcePage !== segment.sourcePage
      || !documentSha
      || normalizeSha256(hit.sourceSha256) !== documentSha
      || normalizeSha256(segment.sourceSha256) !== documentSha
    ) {
      return { ok: false, message: '命中结果、审核片段与来源文档的路径、页码、SHA 或顺序不一致。' };
    }

    if (hit.sourceKey !== segment.sourceKey
      || (hit.sourceKey !== undefined && (typeof hit.sourceKey !== 'string' || !validNormalizedPath(hit.sourceKey)
        || hit.sourceKey !== normalizeSourcePath(hit.sourceKey)))) {
      return { ok: false, message: '命中与审核片段的逻辑来源不一致。' };
    }
    const groupKey = `${hit.sourceKey ?? hitPath}\u0000${hit.sourcePage}`;
    const expectedSegmentNo = (groupPositions.get(groupKey) ?? 0) + 1;
    groupPositions.set(groupKey, expectedSegmentNo);
    if (segment.segmentNo !== expectedSegmentNo) {
      return { ok: false, message: '审核片段序号与来源页内顺序不一致。' };
    }
  }

  return ok();
}
