import { describe, expect, it } from 'vitest';

import {
  clearSearchKeywordHistory,
  loadSearchKeywordHistory,
  MAX_SEARCH_KEYWORD_HISTORY,
  recordSearchKeywordHistory,
  removeSearchKeywordHistory,
  SEARCH_KEYWORD_HISTORY_STORAGE_KEY,
  type SearchKeywordHistory,
} from './searchKeywordHistory';
import {
  SEARCH_CONDITION_HISTORY_STORAGE_KEY,
  type SearchConditionHistoryStorage,
} from './searchConditionHistory';

function createMemoryStorage(initial: Record<string, string | null> = {}): SearchConditionHistoryStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

const emptyHistory: SearchKeywordHistory = { include: [], exclude: [] };

describe('search keyword history storage', () => {
  it('records keywords newest first and moves a repeated keyword to the front', () => {
    const storage = createMemoryStorage();
    const first = recordSearchKeywordHistory(emptyHistory, {
      include: [' 手续费 '],
      includeMode: 'all',
      exclude: [],
    }, storage);
    const second = recordSearchKeywordHistory(first, {
      include: ['退款'],
      includeMode: 'all',
      exclude: [],
    }, storage);

    expect(second.include).toEqual(['退款', '手续费']);
    expect(recordSearchKeywordHistory(second, {
      include: ['手续费'],
      includeMode: 'all',
      exclude: [],
    }, storage).include).toEqual(['手续费', '退款']);
  });

  it('normalizes, deduplicates, truncates keywords, and keeps include and exclude independent', () => {
    const storage = createMemoryStorage();
    const longKeyword = '字'.repeat(513);
    const next = recordSearchKeywordHistory(emptyHistory, {
      include: [' e\u0301 ', 'é', longKeyword, 42 as unknown as string],
      includeMode: 'all',
      exclude: [' 内部 ', '内部', '退款'],
    }, storage);

    expect(next.include).toEqual(['é']);
    expect(next.exclude).toEqual(['内部', '退款']);

    const twentyTwo = Array.from({ length: MAX_SEARCH_KEYWORD_HISTORY + 2 }, (_, index) => `词${index}`);
    const limited = recordSearchKeywordHistory(emptyHistory, {
      include: twentyTwo,
      includeMode: 'all',
      exclude: [],
    }, storage);
    expect(limited.include).toHaveLength(MAX_SEARCH_KEYWORD_HISTORY);
    expect(limited.include).toEqual(twentyTwo.slice(0, MAX_SEARCH_KEYWORD_HISTORY));

    const removed = removeSearchKeywordHistory(limited, 'include', ' 词0 ', storage);
    expect(removed.include).not.toContain('词0');
    expect(removed.exclude).toEqual([]);
    const cleared = clearSearchKeywordHistory(removed, 'include', storage);
    expect(cleared).toEqual({ include: [], exclude: [] });
  });

  it('migrates legacy conditions only when the new key is absent and keeps the legacy key', () => {
    const legacy = {
      version: 1,
      items: [
        {
          id: 'old',
          name: '旧条件',
          savedAt: '2026-09-07T00:00:00.000Z',
          criteria: { include: ['旧词', '重复词'], includeMode: 'all', exclude: ['旧排除'] },
          matchMode: 'exact',
        },
        {
          id: 'new',
          name: '新条件',
          savedAt: '2026-09-07T01:00:00.000Z',
          criteria: { include: ['新词', '重复词'], includeMode: 'all', exclude: ['新排除'] },
          matchMode: 'fuzzy',
        },
      ],
    };
    const storage = createMemoryStorage({
      [SEARCH_CONDITION_HISTORY_STORAGE_KEY]: JSON.stringify(legacy),
    });

    const migrated = loadSearchKeywordHistory(storage);

    expect(migrated).toEqual({
      include: ['新词', '重复词', '旧词'],
      exclude: ['新排除', '旧排除'],
    });
    expect(storage.getItem(SEARCH_CONDITION_HISTORY_STORAGE_KEY)).toBe(JSON.stringify(legacy));
    expect(JSON.parse(storage.getItem(SEARCH_KEYWORD_HISTORY_STORAGE_KEY) ?? '{}')).toEqual({
      version: 1,
      include: ['新词', '重复词', '旧词'],
      exclude: ['新排除', '旧排除'],
    });
  });

  it('does not migrate legacy conditions after an explicit empty new payload is written', () => {
    const storage = createMemoryStorage({
      [SEARCH_CONDITION_HISTORY_STORAGE_KEY]: JSON.stringify({
        version: 1,
        items: [{
          id: 'old',
          name: '旧条件',
          savedAt: '2026-09-07T00:00:00.000Z',
          criteria: { include: ['旧词'], includeMode: 'all', exclude: [] },
          matchMode: 'exact',
        }],
      }),
      [SEARCH_KEYWORD_HISTORY_STORAGE_KEY]: JSON.stringify({ version: 1, include: [], exclude: [] }),
    });

    expect(loadSearchKeywordHistory(storage)).toEqual(emptyHistory);
    expect(clearSearchKeywordHistory({ include: ['临时'], exclude: ['排除'] }, 'include', storage)).toEqual({
      include: [],
      exclude: ['排除'],
    });
    expect(loadSearchKeywordHistory(storage)).toEqual({ include: [], exclude: ['排除'] });
  });

  it('treats malformed and unknown new payloads as empty without falling back to legacy data', () => {
    const legacy = JSON.stringify({
      version: 1,
      items: [{
        id: 'old',
        name: '旧条件',
        savedAt: '2026-09-07T00:00:00.000Z',
        criteria: { include: ['旧词'], includeMode: 'all', exclude: [] },
        matchMode: 'exact',
      }],
    });

    for (const malformed of ['{bad', JSON.stringify({ version: 9, include: ['未知'], exclude: [] }), JSON.stringify({ version: 1, include: '错误', exclude: [] })]) {
      const storage = createMemoryStorage({
        [SEARCH_CONDITION_HISTORY_STORAGE_KEY]: legacy,
        [SEARCH_KEYWORD_HISTORY_STORAGE_KEY]: malformed,
      });
      expect(loadSearchKeywordHistory(storage)).toEqual(emptyHistory);
    }
  });

  it('returns the computed in-memory value when storage reads or writes fail', () => {
    const failingStorage: SearchConditionHistoryStorage = {
      getItem: () => { throw new Error('read failed'); },
      setItem: () => { throw new Error('write failed'); },
      removeItem: () => { throw new Error('remove failed'); },
    };
    const current = { include: ['已有'], exclude: ['排除'] };

    expect(loadSearchKeywordHistory(failingStorage)).toEqual(emptyHistory);
    expect(recordSearchKeywordHistory(current, {
      include: ['新增'],
      includeMode: 'all',
      exclude: ['新排除'],
    }, failingStorage)).toEqual({ include: ['新增', '已有'], exclude: ['新排除', '排除'] });
    expect(removeSearchKeywordHistory(current, 'include', '已有', failingStorage)).toEqual({
      include: [],
      exclude: ['排除'],
    });
    expect(clearSearchKeywordHistory(current, 'exclude', failingStorage)).toEqual({
      include: ['已有'],
      exclude: [],
    });
  });

  it('is safe when browser storage is unavailable', () => {
    expect(() => loadSearchKeywordHistory()).not.toThrow();
    expect(loadSearchKeywordHistory()).toEqual(emptyHistory);
  });
});
