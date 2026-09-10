import { describe, expect, it } from 'vitest';

import {
  legacyCriteria,
  normalizeSearchCriteria,
  searchCriteriaClauses,
  searchCriteriaSummary,
  SearchCriteriaValidationError,
  serializeSearchCriteria,
  type SearchClause,
  type SearchCriteria,
} from './searchCriteria';

describe('normalizeSearchCriteria', () => {
  it('trims, NFC-normalizes, removes blanks, and de-duplicates within each group', () => {
    expect(normalizeSearchCriteria({
      include: ['  示例实业  ', '', '华夏银行', '示例实业', 'e\u0301', 'é'],
      includeMode: 'any',
      exclude: [' 退款 ', '  ', '冲正', '退款'],
    })).toEqual({
      include: ['示例实业', '华夏银行', 'é'],
      includeMode: 'any',
      exclude: ['退款', '冲正'],
    });
  });

  it('normalizes an illegal include mode to all', () => {
    expect(normalizeSearchCriteria({
      include: ['  手续费  '],
      includeMode: 'invalid',
      exclude: [],
    })).toEqual({
      include: ['手续费'],
      includeMode: 'all',
      exclude: [],
    });
  });

  it('returns null when no non-blank include keyword remains', () => {
    expect(normalizeSearchCriteria({
      include: [' ', '\t', '\n'],
      includeMode: 'all',
      exclude: ['退款'],
    })).toBeNull();
  });
});

describe('serializeSearchCriteria', () => {
  it('serializes the normalized shape with deterministic property order', () => {
    const criteria = {
      include: ['  示例实业 ', '示例实业', '华夏银行'],
      includeMode: 'all' as const,
      exclude: ['冲正', ' 冲正 '],
    };

    expect(serializeSearchCriteria(criteria)).toBe(
      '{"include":["示例实业","华夏银行"],"includeMode":"all","exclude":["冲正"]}',
    );
    expect(serializeSearchCriteria({
      include: ['示例实业', '华夏银行'],
      includeMode: 'all',
      exclude: ['冲正'],
    })).toBe(serializeSearchCriteria(criteria));
  });
});

describe('searchCriteriaSummary', () => {
  it('summarizes include and exclude groups using the include mode', () => {
    expect(searchCriteriaSummary({
      include: ['示例实业', '华夏银行'],
      includeMode: 'all',
      exclude: ['退款', '冲正'],
    })).toBe('包含全部：示例实业、华夏银行；排除任一：退款、冲正');

    expect(searchCriteriaSummary({
      include: ['示例实业', '华夏银行'],
      includeMode: 'any',
      exclude: [],
    })).toBe('包含任一：示例实业、华夏银行');
  });
});

describe('legacyCriteria', () => {
  it('converts a legacy single keyword into an all-match criteria', () => {
    expect(legacyCriteria('  e\u0301  ')).toEqual({
      include: ['é'],
      includeMode: 'all',
      exclude: [],
    });
  });

  it('returns null for a blank legacy keyword', () => {
    expect(legacyCriteria(' \t\n ')).toBeNull();
  });
});

describe('searchCriteriaClauses', () => {
  it('creates stable include-then-exclude clause IDs and roles', () => {
    expect(searchCriteriaClauses({
      include: [' 示例实业 ', '华夏银行'],
      includeMode: 'all',
      exclude: ['退款', '冲正'],
    })).toEqual([
      { id: 'include-0', keyword: '示例实业', role: 'include' },
      { id: 'include-1', keyword: '华夏银行', role: 'include' },
      { id: 'exclude-0', keyword: '退款', role: 'exclude' },
      { id: 'exclude-1', keyword: '冲正', role: 'exclude' },
    ]);
  });

  it('throws a validation error when clauses have no include keyword', () => {
    expect(() => searchCriteriaClauses({
      include: [],
      includeMode: 'all',
      exclude: ['退款'],
    })).toThrow(SearchCriteriaValidationError);
  });

  it('exposes clauses through the SearchClause type', () => {
    const clause: SearchClause = { id: 'include-0', keyword: '示例实业', role: 'include' };
    expect(clause).toEqual({ id: 'include-0', keyword: '示例实业', role: 'include' });
  });
});

describe('search criteria limits', () => {
  it('defers clause limits until clauses are generated', () => {
    const oversized = '😀'.repeat(513);
    expect(normalizeSearchCriteria({
      include: [oversized],
      includeMode: 'all',
      exclude: [],
    })).toEqual({
      include: [oversized],
      includeMode: 'all',
      exclude: [],
    });
  });

  it('accepts at most 32 normalized clauses', () => {
    const criteria: SearchCriteria = {
      include: Array.from({ length: 31 }, (_, index) => `include-${index}`),
      includeMode: 'all',
      exclude: ['exclude-0'],
    };
    expect(searchCriteriaClauses(criteria)).toHaveLength(32);
    expect(() => searchCriteriaClauses({
      ...criteria,
      exclude: ['exclude-0', 'exclude-1'],
    })).toThrow(SearchCriteriaValidationError);
    expect(() => searchCriteriaClauses({
      ...criteria,
      exclude: ['exclude-0', 'exclude-1'],
    })).toThrow('搜索关键词总数不能超过 32 个');
  });

  it('counts Unicode code points and rejects a keyword longer than 512', () => {
    const withinLimit = '😀'.repeat(512);
    expect(searchCriteriaClauses({
      include: [withinLimit],
      includeMode: 'all',
      exclude: [],
    })).toEqual([{ id: 'include-0', keyword: withinLimit, role: 'include' }]);

    expect(() => searchCriteriaClauses({
      include: [`${withinLimit}😀`],
      includeMode: 'all',
      exclude: [],
    })).toThrow(SearchCriteriaValidationError);
    expect(() => searchCriteriaClauses({
      include: [`${withinLimit}😀`],
      includeMode: 'all',
      exclude: [],
    })).toThrow('单个搜索关键词不能超过 512 个 Unicode 字符');
  });
});
