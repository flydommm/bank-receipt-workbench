import { searchCriteriaClauses, type SearchCriteria } from './searchCriteria';

export type TaggedReceiptHit = {
  queryId: string;
  role: 'include' | 'exclude';
  candidateKey: string;
};

export type ReceiptHitGroup = {
  candidateKey: string;
  hits: TaggedReceiptHit[];
};

/**
 * Groups tagged search hits by their receipt candidate identity.
 *
 * Map insertion order gives callers a deterministic order based on the first
 * occurrence of each candidate. Within a candidate, the first occurrence of a
 * query ID wins; this both preserves hit order and avoids counting repeated
 * OCR/text matches for the same clause more than once.
 */
export function groupTaggedHitsByCandidate(
  taggedHits: TaggedReceiptHit[],
): ReceiptHitGroup[] {
  const groups = new Map<string, ReceiptHitGroup>();
  const queryIdsByCandidate = new Map<string, Set<string>>();

  for (const taggedHit of taggedHits) {
    const candidateKey = taggedHit.candidateKey;
    let group = groups.get(candidateKey);
    if (!group) {
      group = { candidateKey, hits: [] };
      groups.set(candidateKey, group);
      queryIdsByCandidate.set(candidateKey, new Set<string>());
    }

    const queryIds = queryIdsByCandidate.get(candidateKey)!;
    if (queryIds.has(taggedHit.queryId)) continue;

    queryIds.add(taggedHit.queryId);
    group.hits.push({ ...taggedHit });
  }

  return [...groups.values()];
}

/**
 * Checks one candidate against normalized include/exclude query clauses.
 * Exclusion is intentionally an ANY rule: one matching exclusion clause is
 * enough to reject the whole receipt candidate.
 */
export function candidateSatisfiesCriteria(
  group: ReceiptHitGroup,
  criteria: SearchCriteria,
): boolean {
  const clauses = searchCriteriaClauses(criteria);
  const includeIds = new Set(
    clauses.filter((clause) => clause.role === 'include').map((clause) => clause.id),
  );
  const excludeIds = new Set(
    clauses.filter((clause) => clause.role === 'exclude').map((clause) => clause.id),
  );

  const includeHits = new Set<string>();
  const excludeHits = new Set<string>();
  for (const taggedHit of group.hits) {
    if (typeof taggedHit.queryId !== 'string' || taggedHit.queryId.length === 0) continue;
    if (taggedHit.role === 'include' && includeIds.has(taggedHit.queryId)) {
      includeHits.add(taggedHit.queryId);
    } else if (taggedHit.role === 'exclude' && excludeIds.has(taggedHit.queryId)) {
      excludeHits.add(taggedHit.queryId);
    }
  }

  if (criteria.includeMode === 'any') {
    if (![...includeIds].some((queryId) => includeHits.has(queryId))) return false;
  } else if (![...includeIds].every((queryId) => includeHits.has(queryId))) {
    return false;
  }

  return ![...excludeIds].some((queryId) => excludeHits.has(queryId));
}

/** Returns only candidates satisfying the supplied include/exclude criteria. */
export function filterCandidateGroups(
  groups: ReceiptHitGroup[],
  criteria: SearchCriteria,
): ReceiptHitGroup[] {
  return groups.filter((group) => candidateSatisfiesCriteria(group, criteria));
}
