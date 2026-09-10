import {
  loadSearchConditionHistory,
  type SearchConditionHistoryStorage,
} from './searchConditionHistory';
import {
  MAX_SEARCH_KEYWORD_CODE_POINTS,
  normalizeSearchCriteria,
  type SearchCriteria,
} from './searchCriteria';

export type SearchKeywordHistory = {
  include: string[];
  exclude: string[];
};

export type SearchKeywordHistoryRole = 'include' | 'exclude';

export const SEARCH_KEYWORD_HISTORY_STORAGE_KEY = 'pdf-search.keyword-history.v1';
export const SEARCH_KEYWORD_HISTORY_VERSION = 1 as const;
export const MAX_SEARCH_KEYWORD_HISTORY = 20;

type StoredSearchKeywordHistory = {
  version: typeof SEARCH_KEYWORD_HISTORY_VERSION;
  include: string[];
  exclude: string[];
};

type StorageReadResult = {
  available: boolean;
  serialized: string | null;
};

const EMPTY_HISTORY: SearchKeywordHistory = { include: [], exclude: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveBrowserStorage(): SearchConditionHistoryStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    const storage = window.localStorage;
    if (
      storage === null
      || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function'
      || typeof storage.removeItem !== 'function'
    ) return null;
    return storage;
  } catch {
    return null;
  }
}

function resolveStorage(storage?: SearchConditionHistoryStorage): SearchConditionHistoryStorage | null {
  const candidate = storage ?? resolveBrowserStorage();
  try {
    if (
      candidate === null
      || typeof candidate.getItem !== 'function'
      || typeof candidate.setItem !== 'function'
      || typeof candidate.removeItem !== 'function'
    ) return null;
    return candidate;
  } catch {
    return null;
  }
}

function normalizeKeyword(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const keyword = value.trim().normalize('NFC');
  if (!keyword || Array.from(keyword).length > MAX_SEARCH_KEYWORD_CODE_POINTS) return null;
  return keyword;
}

function normalizeKeywordList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const item of value) {
    const keyword = normalizeKeyword(item);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
    if (keywords.length >= MAX_SEARCH_KEYWORD_HISTORY) break;
  }
  return keywords;
}

function normalizeHistory(value: unknown): SearchKeywordHistory {
  if (!isRecord(value)) return { ...EMPTY_HISTORY };
  return {
    include: normalizeKeywordList(value.include),
    exclude: normalizeKeywordList(value.exclude),
  };
}

function prependKeywords(existing: string[], additions: unknown): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...(Array.isArray(additions) ? additions : []),
    ...existing,
  ];
  for (const candidate of candidates) {
    const keyword = normalizeKeyword(candidate);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    next.push(keyword);
    if (next.length >= MAX_SEARCH_KEYWORD_HISTORY) break;
  }
  return next;
}

function appendKeywords(existing: string[], additions: unknown): string[] {
  const next = [...existing];
  const seen = new Set(next);
  for (const candidate of Array.isArray(additions) ? additions : []) {
    const keyword = normalizeKeyword(candidate);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    next.push(keyword);
    if (next.length >= MAX_SEARCH_KEYWORD_HISTORY) break;
  }
  return next;
}

function cloneHistory(value: SearchKeywordHistory): SearchKeywordHistory {
  const normalized = normalizeHistory(value);
  return { include: normalized.include, exclude: normalized.exclude };
}

function readStorage(storage: SearchConditionHistoryStorage): StorageReadResult {
  try {
    const serialized = storage.getItem(SEARCH_KEYWORD_HISTORY_STORAGE_KEY);
    // Only an explicit null means that the key is absent and may be migrated.
    return {
      available: true,
      serialized: serialized === null ? null : String(serialized),
    };
  } catch {
    return { available: false, serialized: null };
  }
}

function writeHistory(
  history: SearchKeywordHistory,
  storage: SearchConditionHistoryStorage | null,
): SearchKeywordHistory {
  const next = cloneHistory(history);
  if (!storage) return next;

  const payload: StoredSearchKeywordHistory = {
    version: SEARCH_KEYWORD_HISTORY_VERSION,
    include: next.include,
    exclude: next.exclude,
  };
  try {
    storage.setItem(SEARCH_KEYWORD_HISTORY_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage is best effort; the caller keeps the computed session value.
  }
  return next;
}

function migrateLegacyHistory(storage: SearchConditionHistoryStorage): SearchKeywordHistory {
  const legacyItems = loadSearchConditionHistory(storage);
  const sortedItems = [...legacyItems].sort((left, right) => (
    Date.parse(right.savedAt) - Date.parse(left.savedAt)
  ));

  let include: string[] = [];
  let exclude: string[] = [];
  for (const item of sortedItems) {
    include = appendKeywords(include, item.criteria.include);
    exclude = appendKeywords(exclude, item.criteria.exclude);
  }
  return { include, exclude };
}

function readStoredHistory(storage: SearchConditionHistoryStorage): SearchKeywordHistory {
  const result = readStorage(storage);
  if (!result.available) return { ...EMPTY_HISTORY };

  if (result.serialized === null) {
    return migrateLegacyHistory(storage);
  }

  try {
    const parsed: unknown = JSON.parse(result.serialized);
    if (
      !isRecord(parsed)
      || parsed.version !== SEARCH_KEYWORD_HISTORY_VERSION
      || !Array.isArray(parsed.include)
      || !Array.isArray(parsed.exclude)
    ) return { ...EMPTY_HISTORY };
    return normalizeHistory(parsed);
  } catch {
    return { ...EMPTY_HISTORY };
  }
}

export function loadSearchKeywordHistory(storage?: SearchConditionHistoryStorage): SearchKeywordHistory {
  const target = resolveStorage(storage);
  if (!target) return { ...EMPTY_HISTORY };

  const result = readStorage(target);
  if (!result.available) return { ...EMPTY_HISTORY };
  if (result.serialized === null) {
    return writeHistory(migrateLegacyHistory(target), target);
  }

  return readStoredHistory(target);
}

export function recordSearchKeywordHistory(
  current: SearchKeywordHistory,
  criteria: SearchCriteria,
  storage?: SearchConditionHistoryStorage,
): SearchKeywordHistory {
  const target = resolveStorage(storage);
  const base = normalizeHistory(current);
  const normalizedCriteria = normalizeSearchCriteria(criteria);
  const next = normalizedCriteria
    ? {
      include: prependKeywords(base.include, normalizedCriteria.include),
      exclude: prependKeywords(base.exclude, normalizedCriteria.exclude),
    }
    : base;
  return writeHistory(next, target);
}

export function removeSearchKeywordHistory(
  current: SearchKeywordHistory,
  role: SearchKeywordHistoryRole,
  keyword: string,
  storage?: SearchConditionHistoryStorage,
): SearchKeywordHistory {
  const target = resolveStorage(storage);
  const next = normalizeHistory(current);
  const normalizedKeyword = normalizeKeyword(keyword);
  if (normalizedKeyword && (role === 'include' || role === 'exclude')) {
    next[role] = next[role].filter((item) => item !== normalizedKeyword);
  }
  return writeHistory(next, target);
}

export function clearSearchKeywordHistory(
  current: SearchKeywordHistory,
  role: SearchKeywordHistoryRole,
  storage?: SearchConditionHistoryStorage,
): SearchKeywordHistory {
  const target = resolveStorage(storage);
  const next = normalizeHistory(current);
  if (role === 'include' || role === 'exclude') next[role] = [];
  return writeHistory(next, target);
}
