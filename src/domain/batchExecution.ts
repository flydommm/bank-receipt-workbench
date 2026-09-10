import type { SearchMode } from './sourceFiles';
import { normalizeSearchCriteria, serializeSearchCriteria, type SearchCriteria } from './searchCriteria';
import { normalizeSourcePath } from './sourcePreview';

/** The match mode used by the local search engine. */
export type MatchMode = SearchMode;

export type BatchExecutionSource = {
  sourcePath: string;
  name: string;
};

export type BatchExecutionContext = {
  sources: readonly BatchExecutionSource[];
  criteria: SearchCriteria;
  matchMode: MatchMode;
  computationVersion: string;
};

/**
 * This is a soft limit for results kept after a failed run. It does not limit
 * a run which completed all of its sources, because that run does not need a
 * retry cache.
 */
export const FAILURE_RETENTION_LIMIT_BYTES = 128 * 1024 * 1024;

const MAX_SOURCE_PATH_LENGTH = 32_768;
const MAX_SOURCE_NAME_LENGTH = 1_024;
const MAX_COMPUTATION_VERSION_LENGTH = 256;

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizedText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  // A filesystem path and an engine version are opaque strings. Unicode
  // normalization can select a different real file or alter the version token.
  const normalized = value.trim();
  if (!normalized || normalized.length > limit || normalized.includes('\0')) return null;
  return normalized;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneContextInput(input: BatchExecutionContext): BatchExecutionContext {
  try {
    return structuredClone(input);
  } catch {
    throw new Error('批量分析上下文不可复制。');
  }
}

function buildNormalizedContext(input: BatchExecutionContext): BatchExecutionContext {
  const snapshot = cloneContextInput(input);
  requireValid(Array.isArray(snapshot.sources) && snapshot.sources.length > 0, '至少需要一个分析来源。');

  const criteria = normalizeSearchCriteria(snapshot.criteria);
  requireValid(criteria, '至少需要一个包含关键词。');
  const matchMode = snapshot.matchMode;
  requireValid(matchMode === 'exact' || matchMode === 'fuzzy', '搜索匹配模式无效。');
  const computationVersion = normalizedText(snapshot.computationVersion, MAX_COMPUTATION_VERSION_LENGTH);
  requireValid(computationVersion, '计算版本不能为空。');

  const identities = new Set<string>();
  const sources = snapshot.sources.map((source) => {
    requireValid(source && typeof source === 'object', '分析来源无效。');
    const sourcePath = normalizedText(source.sourcePath, MAX_SOURCE_PATH_LENGTH);
    requireValid(sourcePath, '分析来源路径不能为空。');
    const sourceIdentity = normalizeSourcePath(sourcePath);
    requireValid(sourceIdentity.length > 0, '分析来源路径不能为空。');
    requireValid(!identities.has(sourceIdentity), '分析来源不能包含重复路径。');
    identities.add(sourceIdentity);

    const name = normalizedText(source.name, MAX_SOURCE_NAME_LENGTH);
    requireValid(name, '分析来源名称不能为空。');
    return { sourcePath, name };
  });

  return { sources, criteria, matchMode, computationVersion };
}

/**
 * Captures the source order and all calculation inputs in an immutable
 * runtime snapshot. The caller's objects are never used by a later run.
 */
export function freezeBatchExecutionContext(input: BatchExecutionContext): BatchExecutionContext {
  const normalized = buildNormalizedContext(input);
  return deepFreeze(normalized);
}

/**
 * Produces a stable in-memory identity for a normalized execution context.
 * Display names intentionally do not participate: the normalized source path
 * is the source identity and a name can change without changing the file.
 */
export function executionContextKey(context: BatchExecutionContext): string {
  const normalized = freezeBatchExecutionContext(context);
  return JSON.stringify({
    sources: normalized.sources.map((source) => normalizeSourcePath(source.sourcePath)),
    criteria: JSON.parse(serializeSearchCriteria(normalized.criteria)),
    matchMode: normalized.matchMode,
    computationVersion: normalized.computationVersion,
  });
}
