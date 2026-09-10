import {
  normalizeSearchCriteria,
  serializeSearchCriteria,
  type SearchCriteria,
} from './searchCriteria';

export const SEARCH_CONDITION_HISTORY_STORAGE_KEY = 'pdf-search.search-history.v1';
export const SEARCH_CONDITION_HISTORY_VERSION = 1 as const;
export const MAX_SEARCH_CONDITION_HISTORY = 10;

export type SearchConditionHistoryItem = {
  id: string;
  name: string;
  savedAt: string;
  criteria: SearchCriteria;
  matchMode: 'exact' | 'fuzzy';
};

export type SearchConditionHistoryDraft = {
  name: string;
  criteria: SearchCriteria;
  matchMode: SearchConditionHistoryItem['matchMode'];
};

export type SearchConditionHistoryStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

type StoredHistory = {
  version: typeof SEARCH_CONDITION_HISTORY_VERSION;
  items: SearchConditionHistoryItem[];
};

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
  return storage ?? resolveBrowserStorage();
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 80 ? name : null;
}

function normalizeSavedAt(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id.length > 0 && id.length <= 120 ? id : null;
}

function normalizeItem(value: unknown): SearchConditionHistoryItem | null {
  if (!isRecord(value)) return null;
  const id = normalizeId(value.id);
  const name = normalizeName(value.name);
  const savedAt = normalizeSavedAt(value.savedAt);
  const criteria = normalizeSearchCriteria(value.criteria);
  const matchMode = value.matchMode === 'fuzzy' || value.matchMode === 'exact'
    ? value.matchMode
    : null;
  if (!id || !name || !savedAt || !criteria || !matchMode) return null;
  return { id, name, savedAt, criteria, matchMode };
}

function normalizeItems(value: unknown): SearchConditionHistoryItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: SearchConditionHistoryItem[] = [];
  for (const item of value) {
    const normalized = normalizeItem(item);
    if (!normalized) continue;
    const conditionKey = `${serializeSearchCriteria(normalized.criteria)}\u0000${normalized.matchMode}`;
    if (seen.has(conditionKey)) continue;
    seen.add(conditionKey);
    items.push(normalized);
    if (items.length >= MAX_SEARCH_CONDITION_HISTORY) break;
  }
  return items;
}

function readStoredHistory(storage?: SearchConditionHistoryStorage): SearchConditionHistoryItem[] {
  const target = resolveStorage(storage);
  if (!target) return [];
  let serialized: string | null;
  try {
    serialized = target.getItem(SEARCH_CONDITION_HISTORY_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== SEARCH_CONDITION_HISTORY_VERSION) return [];
    return normalizeItems(parsed.items);
  } catch {
    return [];
  }
}

function writeHistory(items: SearchConditionHistoryItem[], storage?: SearchConditionHistoryStorage): SearchConditionHistoryItem[] {
  const target = resolveStorage(storage);
  if (!target) return items;
  const payload: StoredHistory = {
    version: SEARCH_CONDITION_HISTORY_VERSION,
    items: normalizeItems(items),
  };
  try {
    target.setItem(SEARCH_CONDITION_HISTORY_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage failures must not interrupt the current search session.
    return readStoredHistory(storage);
  }
  return payload.items;
}

function createId(now: string): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to a timestamp-based identifier.
  }
  return `${now}-${Math.random().toString(36).slice(2, 10)}`;
}

export function loadSearchConditionHistory(storage?: SearchConditionHistoryStorage): SearchConditionHistoryItem[] {
  return readStoredHistory(storage);
}

export function saveSearchConditionHistory(
  draft: SearchConditionHistoryDraft,
  storage?: SearchConditionHistoryStorage,
  now = new Date(),
): SearchConditionHistoryItem[] {
  const criteria = normalizeSearchCriteria(draft.criteria);
  const name = normalizeName(draft.name);
  if (!criteria || !name || (draft.matchMode !== 'exact' && draft.matchMode !== 'fuzzy')) {
    return readStoredHistory(storage);
  }
  const savedAt = now.toISOString();
  const item: SearchConditionHistoryItem = {
    id: createId(savedAt),
    name,
    savedAt,
    criteria,
    matchMode: draft.matchMode,
  };
  const conditionKey = `${serializeSearchCriteria(criteria)}\u0000${draft.matchMode}`;
  const next = [item, ...readStoredHistory(storage).filter((entry) => (
    `${serializeSearchCriteria(entry.criteria)}\u0000${entry.matchMode}` !== conditionKey
  ))];
  return writeHistory(next, storage);
}

export function removeSearchConditionHistory(
  id: string,
  storage?: SearchConditionHistoryStorage,
): SearchConditionHistoryItem[] {
  return writeHistory(readStoredHistory(storage).filter((item) => item.id !== id), storage);
}

export function clearSearchConditionHistory(storage?: SearchConditionHistoryStorage): SearchConditionHistoryItem[] {
  const target = resolveStorage(storage);
  if (!target) return [];
  try {
    target.removeItem(SEARCH_CONDITION_HISTORY_STORAGE_KEY);
  } catch {
    // Clearing history is best effort and must not affect current search state.
  }
  return [];
}
