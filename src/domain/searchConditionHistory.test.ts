import { describe, expect, it } from 'vitest';
import {
  clearSearchConditionHistory,
  loadSearchConditionHistory,
  MAX_SEARCH_CONDITION_HISTORY,
  removeSearchConditionHistory,
  saveSearchConditionHistory,
  SEARCH_CONDITION_HISTORY_STORAGE_KEY,
  type SearchConditionHistoryStorage,
} from './searchConditionHistory';

function createMemoryStorage(initialValue?: string): SearchConditionHistoryStorage {
  let value = initialValue ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
    removeItem: () => { value = null; },
  };
}

const criteria = { include: ['手续费'], includeMode: 'all' as const, exclude: [] };

describe('search condition history storage', () => {
  it('saves and restores only the versioned search condition payload', () => {
    const storage = createMemoryStorage();
    const items = saveSearchConditionHistory(
      { name: '手续费精确', criteria, matchMode: 'exact' },
      storage,
      new Date('2026-09-07T00:00:00.000Z'),
    );

    expect(items).toHaveLength(1);
    expect(loadSearchConditionHistory(storage)).toEqual(items);
    expect(JSON.parse(storage.getItem(SEARCH_CONDITION_HISTORY_STORAGE_KEY) ?? '{}')).toEqual({
      version: 1,
      items,
    });
    expect(JSON.stringify(items)).not.toContain('pdf');
  });

  it('updates duplicate conditions and keeps the newest one first', () => {
    const storage = createMemoryStorage();
    saveSearchConditionHistory({ name: '旧名称', criteria, matchMode: 'exact' }, storage, new Date('2026-09-07T00:00:00.000Z'));
    const items = saveSearchConditionHistory({ name: '新名称', criteria, matchMode: 'exact' }, storage, new Date('2026-09-07T00:01:00.000Z'));

    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('新名称');
    expect(items[0].savedAt).toBe('2026-09-07T00:01:00.000Z');
  });

  it('preserves exclude keywords and any-match mode when round-tripping', () => {
    const storage = createMemoryStorage();
    const condition = {
      include: ['手续费', '华夏银行'],
      includeMode: 'any' as const,
      exclude: ['退款'],
    };

    const items = saveSearchConditionHistory({ name: '组合条件', criteria: condition, matchMode: 'fuzzy' }, storage);

    expect(loadSearchConditionHistory(storage)[0]).toMatchObject({
      name: '组合条件',
      criteria: condition,
      matchMode: 'fuzzy',
    });
    expect(items[0].criteria).toEqual(condition);
  });

  it('keeps only the newest ten distinct conditions', () => {
    const storage = createMemoryStorage();
    for (let index = 0; index < MAX_SEARCH_CONDITION_HISTORY + 2; index += 1) {
      saveSearchConditionHistory({
        name: `条件 ${index}`,
        criteria: { include: [`关键词${index}`], includeMode: 'all', exclude: [] },
        matchMode: 'exact',
      }, storage, new Date(2026, 8, 7, 0, index));
    }

    const items = loadSearchConditionHistory(storage);
    expect(items).toHaveLength(MAX_SEARCH_CONDITION_HISTORY);
    expect(items[0].name).toBe('条件 11');
    expect(items.at(-1)?.name).toBe('条件 2');
  });

  it('deletes one item and can clear all items', () => {
    const storage = createMemoryStorage();
    const first = saveSearchConditionHistory({ name: '第一条', criteria, matchMode: 'exact' }, storage);
    saveSearchConditionHistory({ name: '第二条', criteria: { ...criteria, include: ['退款'] }, matchMode: 'fuzzy' }, storage);

    expect(removeSearchConditionHistory(first[0].id, storage)).toHaveLength(1);
    expect(clearSearchConditionHistory(storage)).toEqual([]);
    expect(loadSearchConditionHistory(storage)).toEqual([]);
  });

  it('falls back safely for malformed, unsupported, or invalid stored data', () => {
    expect(loadSearchConditionHistory(createMemoryStorage('{bad'))).toEqual([]);
    expect(loadSearchConditionHistory(createMemoryStorage(JSON.stringify({ version: 9, items: [] })))).toEqual([]);
    expect(loadSearchConditionHistory(createMemoryStorage(JSON.stringify({
      version: 1,
      items: [{ id: 'x', name: '', savedAt: 'bad', criteria: {}, matchMode: 'exact' }],
    })))).toEqual([]);
  });

  it('does not throw when storage methods fail', () => {
    const storage: SearchConditionHistoryStorage = {
      getItem: () => { throw new Error('read failed'); },
      setItem: () => { throw new Error('write failed'); },
      removeItem: () => { throw new Error('clear failed'); },
    };

    expect(loadSearchConditionHistory(storage)).toEqual([]);
    expect(saveSearchConditionHistory({ name: '条件', criteria, matchMode: 'exact' }, storage)).toEqual([]);
    expect(clearSearchConditionHistory(storage)).toEqual([]);
  });
});
