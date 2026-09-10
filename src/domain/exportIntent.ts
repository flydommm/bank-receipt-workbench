import type { PdfRect, ReviewSegment } from './cropReview';

export type ExportScopeSelection =
  | { kind: 'all' }
  | { kind: 'sources'; sourceKeys: string[] }
  | { kind: 'list'; segmentIds: string[]; description: string };

export type ExportOutputMode = 'merged' | 'by_source' | 'both';

export type ExportScopeResolution = {
  selectedSegments: ReviewSegment[];
  selectedIds: string[];
  selectedSourceKeys: string[];
  totalSegments: number;
  selectedCount: number;
  omittedCount: number;
  omittedUnresolvedCount: number;
  selectedUnresolvedCount: number;
  expectedPages: number;
  error: string | null;
};

type IndexedSegment = {
  segment: ReviewSegment;
  sourceKey: string;
  inputIndex: number;
};

function invalidResult(
  totalSegments: number,
  error: string,
  omittedUnresolvedCount = 0,
): ExportScopeResolution {
  return {
    selectedSegments: [],
    selectedIds: [],
    selectedSourceKeys: [],
    totalSegments,
    selectedCount: 0,
    omittedCount: totalSegments,
    omittedUnresolvedCount,
    selectedUnresolvedCount: 0,
    expectedPages: 0,
    error,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function segmentSourceKey(segment: ReviewSegment): unknown {
  return segment.sourceKey ?? segment.sourcePath;
}

function hasUnresolvedId(unresolvedIds: ReadonlySet<string>, id: string): boolean {
  return unresolvedIds !== null
    && typeof unresolvedIds === 'object'
    && typeof (unresolvedIds as { has?: unknown }).has === 'function'
    && unresolvedIds.has(id);
}

function cloneRect(rect: PdfRect | null): PdfRect | null {
  return rect === null ? null : { ...rect };
}

function cloneSegment(segment: ReviewSegment): ReviewSegment {
  return {
    ...segment,
    matchRect: { ...segment.matchRect },
    candidateRect: cloneRect(segment.candidateRect),
    finalRect: cloneRect(segment.finalRect),
    snapPoints: segment.snapPoints ? [...segment.snapPoints] : segment.snapPoints,
  };
}

function exactRectKey(rect: PdfRect | null | undefined): string | null {
  if (!isRecord(rect)) return null;
  const coordinates = [rect.x0, rect.y0, rect.x1, rect.y1];
  if (!coordinates.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }
  return JSON.stringify(coordinates);
}

function expectedPageCount(segments: readonly IndexedSegment[]): number {
  let pageCount = 0;
  const fullPagesBySource = new Map<string, Set<number>>();
  const cropRectsBySourcePage = new Map<string, Map<number, Set<string>>>();

  for (const { segment, sourceKey } of segments) {
    if (segment.mode !== 'full_page') {
      const rectKey = exactRectKey(segment.finalRect);
      // An unresolved/malformed crop cannot safely be coalesced with another
      // record. The normal export gate rejects it before rendering, while
      // this fallback keeps the estimate from under-counting invalid input.
      if (rectKey === null) {
        pageCount += 1;
        continue;
      }

      let pages = cropRectsBySourcePage.get(sourceKey);
      if (!pages) {
        pages = new Map<number, Set<string>>();
        cropRectsBySourcePage.set(sourceKey, pages);
      }
      let rects = pages.get(segment.sourcePage);
      if (!rects) {
        rects = new Set<string>();
        pages.set(segment.sourcePage, rects);
      }
      if (!rects.has(rectKey)) {
        rects.add(rectKey);
        pageCount += 1;
      }
      continue;
    }

    let pages = fullPagesBySource.get(sourceKey);
    if (!pages) {
      pages = new Set<number>();
      fullPagesBySource.set(sourceKey, pages);
    }
    if (!pages.has(segment.sourcePage)) {
      pages.add(segment.sourcePage);
      pageCount += 1;
    }
  }

  return pageCount;
}

function sortSegments(
  segments: readonly IndexedSegment[],
  sourceOrder: ReadonlyMap<string, number>,
): IndexedSegment[] {
  return [...segments].sort((left, right) => {
    const sourceOrderDelta = (sourceOrder.get(left.sourceKey) ?? 0)
      - (sourceOrder.get(right.sourceKey) ?? 0);
    if (sourceOrderDelta !== 0) return sourceOrderDelta;

    const pageDelta = left.segment.sourcePage - right.segment.sourcePage;
    if (pageDelta !== 0) return pageDelta;

    const segmentDelta = left.segment.segmentNo - right.segment.segmentNo;
    if (segmentDelta !== 0) return segmentDelta;

    return left.inputIndex - right.inputIndex;
  });
}

function validateSourceOrder(
  orderedSourceKeys: string[],
): { sourceOrder: Map<string, number>; error: string | null } {
  if (!Array.isArray(orderedSourceKeys)) {
    return { sourceOrder: new Map(), error: '来源顺序无效。' };
  }

  const sourceOrder = new Map<string, number>();
  for (const [index, sourceKey] of orderedSourceKeys.entries()) {
    if (typeof sourceKey !== 'string' || sourceKey.trim().length === 0) {
      return { sourceOrder: new Map(), error: '来源顺序包含无效来源。' };
    }
    if (sourceOrder.has(sourceKey)) {
      return { sourceOrder: new Map(), error: `来源顺序包含重复来源：${sourceKey}` };
    }
    sourceOrder.set(sourceKey, index);
  }

  return { sourceOrder, error: null };
}

function unresolvedCount(
  segments: readonly IndexedSegment[],
  unresolvedIds: ReadonlySet<string>,
): number {
  return segments.reduce(
    (count, { segment }) => count + (hasUnresolvedId(unresolvedIds, segment.id) ? 1 : 0),
    0,
  );
}

export function resolveExportScope(
  segments: ReviewSegment[],
  orderedSourceKeys: string[],
  scope: ExportScopeSelection,
  unresolvedIds: ReadonlySet<string>,
): ExportScopeResolution {
  const totalSegments = Array.isArray(segments) ? segments.length : 0;
  if (!Array.isArray(segments)) {
    return invalidResult(totalSegments, '输入片段集合无效。');
  }

  const { sourceOrder, error: sourceOrderError } = validateSourceOrder(orderedSourceKeys);
  if (sourceOrderError) return invalidResult(totalSegments, sourceOrderError);

  const ids = new Set<string>();
  const indexedSegments: IndexedSegment[] = [];
  for (const [inputIndex, segment] of segments.entries()) {
    if (!isRecord(segment) || typeof segment.id !== 'string' || segment.id.trim().length === 0) {
      return invalidResult(totalSegments, '输入片段包含无效 ID。');
    }
    if (ids.has(segment.id)) {
      return invalidResult(totalSegments, `输入片段 ID 重复：${segment.id}`);
    }
    ids.add(segment.id);

    const sourceKey = segmentSourceKey(segment as ReviewSegment);
    if (typeof sourceKey !== 'string' || sourceKey.trim().length === 0) {
      return invalidResult(totalSegments, `片段 ${segment.id} 的来源无效。`);
    }
    if (!sourceOrder.has(sourceKey)) {
      return invalidResult(totalSegments, `片段 ${segment.id} 的来源不存在：${sourceKey}`);
    }
    if (!Number.isFinite(segment.sourcePage) || !Number.isFinite(segment.segmentNo)) {
      return invalidResult(totalSegments, `片段 ${segment.id} 的页码或片段序号无效。`);
    }

    indexedSegments.push({
      segment: segment as ReviewSegment,
      sourceKey,
      inputIndex,
    });
  }

  const totalUnresolvedCount = unresolvedCount(indexedSegments, unresolvedIds);
  let selectedPredicate: (entry: IndexedSegment) => boolean;

  if (!isRecord(scope) || typeof scope.kind !== 'string') {
    return invalidResult(totalSegments, '导出范围无效。', totalUnresolvedCount);
  }

  switch (scope.kind) {
    case 'all':
      selectedPredicate = () => true;
      break;
    case 'sources': {
      if (!Array.isArray(scope.sourceKeys)) {
        return invalidResult(totalSegments, '导出来源范围无效。', totalUnresolvedCount);
      }
      const selectedSources = new Set<string>();
      for (const sourceKey of scope.sourceKeys) {
        if (typeof sourceKey !== 'string' || sourceKey.trim().length === 0) {
          return invalidResult(totalSegments, '导出来源范围包含无效来源。', totalUnresolvedCount);
        }
        if (selectedSources.has(sourceKey)) {
          return invalidResult(totalSegments, `导出来源范围包含重复来源：${sourceKey}`, totalUnresolvedCount);
        }
        if (!sourceOrder.has(sourceKey)) {
          return invalidResult(totalSegments, `导出来源不存在：${sourceKey}`, totalUnresolvedCount);
        }
        selectedSources.add(sourceKey);
      }
      selectedPredicate = (entry) => selectedSources.has(entry.sourceKey);
      break;
    }
    case 'list': {
      if (!Array.isArray(scope.segmentIds) || typeof scope.description !== 'string') {
        return invalidResult(totalSegments, '导出片段列表无效。', totalUnresolvedCount);
      }
      const selectedIds = new Set<string>();
      for (const id of scope.segmentIds) {
        if (typeof id !== 'string' || id.trim().length === 0) {
          return invalidResult(totalSegments, '导出片段列表包含无效 ID。', totalUnresolvedCount);
        }
        if (selectedIds.has(id)) {
          return invalidResult(totalSegments, `导出片段列表包含重复 ID：${id}`, totalUnresolvedCount);
        }
        if (!ids.has(id)) {
          return invalidResult(totalSegments, `导出片段不存在：${id}`, totalUnresolvedCount);
        }
        selectedIds.add(id);
      }
      selectedPredicate = (entry) => selectedIds.has(entry.segment.id);
      break;
    }
    default:
      return invalidResult(totalSegments, '导出范围类型无效。', totalUnresolvedCount);
  }

  const selected = sortSegments(indexedSegments.filter(selectedPredicate), sourceOrder);
  if (selected.length === 0) {
    return invalidResult(totalSegments, '导出范围为空，请至少选择一个片段。', totalUnresolvedCount);
  }

  const selectedIds = selected.map(({ segment }) => segment.id);
  const selectedSourceKeys: string[] = [];
  const selectedSourceSet = new Set<string>();
  for (const { sourceKey } of selected) {
    if (!selectedSourceSet.has(sourceKey)) {
      selectedSourceSet.add(sourceKey);
      selectedSourceKeys.push(sourceKey);
    }
  }

  const selectedUnresolvedCount = unresolvedCount(selected, unresolvedIds);
  return {
    selectedSegments: selected.map(({ segment }) => cloneSegment(segment)),
    selectedIds,
    selectedSourceKeys,
    totalSegments,
    selectedCount: selected.length,
    omittedCount: totalSegments - selected.length,
    omittedUnresolvedCount: totalUnresolvedCount - selectedUnresolvedCount,
    selectedUnresolvedCount,
    expectedPages: expectedPageCount(selected),
    error: null,
  };
}
