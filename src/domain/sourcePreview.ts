export type SourceIntegrityStatus = 'valid' | 'changed';

export type SourceDocument = {
  key: string;
  name: string;
  sourcePath: string;
  sourceSha256: string;
  pageCount: number;
  integrityStatus: SourceIntegrityStatus;
};

export type SourcePreviewLocation = {
  documentKey: string;
  page: number;
};

export type SearchSource = {
  name: string;
  sourcePath: string;
};

export function appendUniqueSources(
  current: readonly SearchSource[],
  additions: readonly SearchSource[],
): SearchSource[] {
  const result: SearchSource[] = [];
  const seen = new Set<string>();
  for (const source of [...current, ...additions]) {
    const identity = normalizeSourcePath(source.sourcePath);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(source);
  }
  return result;
}

export function removeSourceIdentities(
  current: readonly SearchSource[],
  identities: ReadonlySet<string>,
): { files: SearchSource[]; nextActivePath: string | null } {
  const normalizedIdentities = new Set(
    Array.from(identities, (identity) => normalizeSourcePath(identity)),
  );
  const files = current.filter((source) => (
    !normalizedIdentities.has(normalizeSourcePath(source.sourcePath))
  ));
  return {
    files,
    nextActivePath: files[0]?.sourcePath ?? null,
  };
}

export type SourceSearchMetadata = {
  page_count: number;
  source_sha256: string;
  matches: readonly {
    source_path?: string;
    source_sha256?: string;
  }[];
};

export type SourceSearchResponse = {
  sourcePath: string;
  result: SourceSearchMetadata;
};

export function normalizeSourcePath(value: string): string {
  return value.trim().normalize('NFC').replaceAll('\\', '/').toLowerCase();
}

export function sourceDocumentKey(sourcePath: string, sourceSha256: string): string {
  return normalizeSourcePath(sourcePath) + '\u0000' + sourceSha256.toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertConsistentMatches(
  matches: unknown,
  sourceIdentity: string,
  sourceSha256: string,
): void {
  if (!Array.isArray(matches)) {
    throw new Error('命中结果与所属来源元数据不一致。');
  }

  for (const match of matches) {
    if (!isPlainObject(match)) {
      throw new Error('命中结果与所属来源元数据不一致。');
    }

    const hasSourcePath = hasOwnProperty(match, 'source_path');
    const hasSourceSha256 = hasOwnProperty(match, 'source_sha256');
    if (
      (hasSourcePath && typeof match.source_path !== 'string')
      || (hasSourceSha256 && typeof match.source_sha256 !== 'string')
    ) {
      throw new Error('命中结果与所属来源元数据不一致。');
    }

    if (
      (hasSourcePath && normalizeSourcePath(match.source_path as string) !== sourceIdentity)
      || (hasSourceSha256 && (match.source_sha256 as string).toLowerCase() !== sourceSha256)
    ) {
      throw new Error('命中结果与所属来源元数据不一致。');
    }
  }
}

export function buildSourceDocuments(
  sources: readonly SearchSource[],
  responses: readonly SourceSearchResponse[],
): SourceDocument[] {
  if (sources.length !== responses.length) {
    throw new Error('来源数量与搜索响应数量不一致。');
  }

  const seen = new Set<string>();
  return sources.map((source, index) => {
    const response = responses[index];
    const sourceIdentity = normalizeSourcePath(source.sourcePath);
    if (seen.has(sourceIdentity)) {
      throw new Error('来源路径重复，无法建立文档元数据。');
    }
    seen.add(sourceIdentity);

    if (normalizeSourcePath(response.sourcePath) !== sourceIdentity) {
      throw new Error('搜索响应与请求来源不一致。');
    }

    const { page_count: pageCount, source_sha256: sourceSha256, matches } = response.result;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
      throw new Error('搜索响应的 PDF 页数无效。');
    }
    if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sourceSha256)) {
      throw new Error('搜索响应的源 PDF SHA-256 无效。');
    }

    const normalizedSha = sourceSha256.toLowerCase();
    assertConsistentMatches(matches, sourceIdentity, normalizedSha);

    return {
      key: sourceDocumentKey(source.sourcePath, normalizedSha),
      name: source.name,
      sourcePath: source.sourcePath,
      sourceSha256: normalizedSha,
      pageCount,
      integrityStatus: 'valid' as const,
    };
  });
}

export type AnalysisState =
  | { phase: 'idle'; error?: string }
  | { phase: 'dirty'; error?: string }
  | { phase: 'completed' }
  | {
      phase: 'running';
      step: 'search' | 'pages';
      failurePhase: 'idle' | 'dirty';
    };

export type AnalysisEvent =
  | { type: 'sources_replaced' }
  | { type: 'criteria_changed' }
  | { type: 'run_started' }
  | { type: 'page_analysis_started' }
  | { type: 'run_succeeded' }
  | { type: 'run_failed'; error: string }
  | { type: 'previous_results_restored' };

export function analysisStateReducer(
  state: AnalysisState,
  event: AnalysisEvent,
): AnalysisState {
  switch (event.type) {
    case 'sources_replaced':
      return { phase: 'idle' };
    case 'criteria_changed':
      if (state.phase === 'completed' || state.phase === 'dirty') {
        return { phase: 'dirty' };
      }
      if (state.phase === 'running' && state.failurePhase === 'dirty') {
        return { phase: 'dirty' };
      }
      return { phase: 'idle' };
    case 'run_started':
      return {
        phase: 'running',
        step: 'search',
        failurePhase:
          state.phase === 'running'
            ? state.failurePhase
            : state.phase === 'completed' || state.phase === 'dirty' ? 'dirty' : 'idle',
      };
    case 'page_analysis_started':
      return state.phase === 'running' ? { ...state, step: 'pages' } : state;
    case 'run_succeeded':
      return state.phase === 'running' ? { phase: 'completed' } : state;
    case 'run_failed':
      return state.phase === 'running'
        ? { phase: state.failurePhase, error: event.error }
        : state;
    case 'previous_results_restored':
      return state.phase === 'dirty' ? { phase: 'completed' } : state;
  }
}

export function analysisButtonLabel(state: AnalysisState): string {
  if (state.phase === 'running') return '分析中…';
  return state.phase === 'idle' ? '开始分析' : '重新分析';
}

export type NavigableSegment = {
  id: string;
  sourcePath: string;
  sourcePage: number;
  reviewStatus: 'pending' | 'needs_review' | 'confirmed' | 'blocked';
};

export function choosePreferredSegment(
  segments: readonly NavigableSegment[],
  sourcePath: string,
  page: number,
): string | null {
  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  const pageSegments = segments.filter((segment) => (
    normalizeSourcePath(segment.sourcePath) === normalizedSourcePath
      && segment.sourcePage === page
  ));
  return pageSegments.find((segment) => segment.reviewStatus !== 'confirmed')?.id
    ?? pageSegments[0]?.id
    ?? null;
}

export type PageDraftResult =
  | { ok: true; page: number }
  | { ok: false; message: string };

export function parsePageDraft(draft: string, pageCount: number): PageDraftResult {
  const value = typeof draft === 'string' ? Number(draft) : Number.NaN;
  if (
    !Number.isSafeInteger(pageCount)
    || pageCount < 1
    || typeof draft !== 'string'
    || !/^\d+$/.test(draft.trim())
    || !Number.isSafeInteger(value)
    || value < 1
    || value > pageCount
  ) {
    return { ok: false, message: '请输入 1–' + pageCount + ' 的页码' };
  }
  return { ok: true, page: value };
}
