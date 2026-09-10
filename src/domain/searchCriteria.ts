export type SearchMatchMode = 'all' | 'any';

export type SearchCriteria = {
  include: string[];
  includeMode: SearchMatchMode;
  exclude: string[];
};

export type SearchClause = {
  id: string;
  keyword: string;
  role: 'include' | 'exclude';
};

/** @deprecated Use SearchClause. */
export type SearchCriteriaClause = SearchClause;

export const MAX_SEARCH_CRITERIA_CLAUSES = 32;
export const MAX_SEARCH_KEYWORD_CODE_POINTS = 512;

export class SearchCriteriaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchCriteriaValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const keyword = item.trim().normalize('NFC');
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
  }
  return keywords;
}

function validateCriteriaLimits(criteria: SearchCriteria): void {
  for (const keyword of [...criteria.include, ...criteria.exclude]) {
    if (Array.from(keyword).length > MAX_SEARCH_KEYWORD_CODE_POINTS) {
      throw new SearchCriteriaValidationError(
        `单个搜索关键词不能超过 ${MAX_SEARCH_KEYWORD_CODE_POINTS} 个 Unicode 字符`,
      );
    }
  }

  if (criteria.include.length + criteria.exclude.length > MAX_SEARCH_CRITERIA_CLAUSES) {
    throw new SearchCriteriaValidationError(
      `搜索关键词总数不能超过 ${MAX_SEARCH_CRITERIA_CLAUSES} 个`,
    );
  }
}

export function normalizeSearchCriteria(value: unknown): SearchCriteria | null {
  const input = isRecord(value) ? value : {};
  const include = normalizeKeywords(input.include);
  if (include.length === 0) return null;

  const criteria: SearchCriteria = {
    include,
    includeMode: input.includeMode === 'any' ? 'any' : 'all',
    exclude: normalizeKeywords(input.exclude),
  };
  return criteria;
}

export function serializeSearchCriteria(criteria: SearchCriteria): string {
  const normalized = normalizeSearchCriteria(criteria);
  if (!normalized) {
    throw new SearchCriteriaValidationError('至少需要一个包含关键词。');
  }

  return JSON.stringify({
    include: normalized.include,
    includeMode: normalized.includeMode,
    exclude: normalized.exclude,
  });
}

export function searchCriteriaSummary(criteria: SearchCriteria): string {
  const normalized = normalizeSearchCriteria(criteria);
  if (!normalized) return '';

  const includeLabel = normalized.includeMode === 'any' ? '包含任一' : '包含全部';
  const summary = `${includeLabel}：${normalized.include.join('、')}`;
  if (normalized.exclude.length === 0) return summary;
  return `${summary}；排除任一：${normalized.exclude.join('、')}`;
}

export function legacyCriteria(keyword: string): SearchCriteria | null {
  if (typeof keyword !== 'string') return null;
  return normalizeSearchCriteria({
    include: [keyword],
    includeMode: 'all',
    exclude: [],
  });
}

export function searchCriteriaClauses(
  criteria: SearchCriteria,
): SearchClause[] {
  const normalized = normalizeSearchCriteria(criteria);
  if (!normalized) {
    throw new SearchCriteriaValidationError('至少需要一个包含关键词。');
  }

  validateCriteriaLimits(normalized);

  return [
    ...normalized.include.map((keyword, index) => ({
      id: `include-${index}`,
      keyword,
      role: 'include' as const,
    })),
    ...normalized.exclude.map((keyword, index) => ({
      id: `exclude-${index}`,
      keyword,
      role: 'exclude' as const,
    })),
  ];
}
