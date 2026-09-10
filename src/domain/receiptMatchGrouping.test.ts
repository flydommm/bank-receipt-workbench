import { describe, expect, it } from 'vitest';

import type { SearchCriteria } from './searchCriteria';
import {
  candidateSatisfiesCriteria,
  filterCandidateGroups,
  groupTaggedHitsByCandidate,
  type TaggedReceiptHit,
} from './receiptMatchGrouping';

function criteriaAll(include: string[], exclude: string[] = []): SearchCriteria {
  return { include, includeMode: 'all', exclude };
}

function criteriaAny(include: string[], exclude: string[] = []): SearchCriteria {
  return { include, includeMode: 'any', exclude };
}

function hits(queryIds: string[], candidateKey = 'candidate-0'): TaggedReceiptHit[] {
  return queryIds.map((queryId) => ({
    queryId,
    role: queryId.startsWith('exclude-') ? 'exclude' : 'include',
    candidateKey,
  }));
}

function hit(queryId: string, candidateIndex: number): TaggedReceiptHit {
  return {
    queryId,
    role: queryId.startsWith('exclude-') ? 'exclude' : 'include',
    candidateKey: `page-1-candidate-${candidateIndex}`,
  };
}

describe('candidateSatisfiesCriteria', () => {
  it('keeps a candidate when all include clauses hit it', () => {
    expect(
      candidateSatisfiesCriteria(
        { candidateKey: 'candidate-0', hits: hits(['include-0', 'include-1']) },
        criteriaAll(['include-0', 'include-1']),
      ),
    ).toBe(true);
  });

  it('does not combine adjacent candidates for AND', () => {
    const candidates = groupTaggedHitsByCandidate([
      hit('include-0', 0),
      hit('include-1', 1),
    ]);

    expect(filterCandidateGroups(candidates, criteriaAll(['include-0', 'include-1']))).toEqual([]);
  });

  it('keeps any include hit for OR', () => {
    expect(
      candidateSatisfiesCriteria(
        { candidateKey: 'candidate-0', hits: hits(['include-1']) },
        criteriaAny(['include-0', 'include-1']),
      ),
    ).toBe(true);
  });

  it('rejects a candidate when any exclude clause hits it', () => {
    expect(
      candidateSatisfiesCriteria(
        { candidateKey: 'candidate-0', hits: hits(['include-0', 'exclude-1']) },
        criteriaAll(['include-0'], ['exclude-0', 'exclude-1']),
      ),
    ).toBe(false);
  });

  it('rejects a candidate with an empty or unknown query id', () => {
    expect(
      candidateSatisfiesCriteria(
        {
          candidateKey: 'candidate-0',
          hits: hits(['', 'unknown-query']),
        },
        criteriaAll(['include-0']),
      ),
    ).toBe(false);
  });

  it('deduplicates repeated query ids within one candidate', () => {
    const candidates = groupTaggedHitsByCandidate([
      hit('include-0', 0),
      hit('include-0', 0),
      hit('include-1', 0),
    ]);

    expect(candidates).toEqual([
      {
        candidateKey: 'page-1-candidate-0',
        hits: [hit('include-0', 0), hit('include-1', 0)],
      },
    ]);
  });
});

describe('groupTaggedHitsByCandidate', () => {
  it('keeps candidate groups and hit order stable without mutating input', () => {
    const source = [
      hit('include-1', 1),
      hit('include-0', 0),
      hit('include-1', 1),
      hit('exclude-0', 0),
    ];
    const before = structuredClone(source);

    expect(groupTaggedHitsByCandidate(source)).toEqual([
      {
        candidateKey: 'page-1-candidate-1',
        hits: [hit('include-1', 1)],
      },
      {
        candidateKey: 'page-1-candidate-0',
        hits: [hit('include-0', 0), hit('exclude-0', 0)],
      },
    ]);
    expect(source).toEqual(before);
  });
});

describe('filterCandidateGroups', () => {
  it('filters groups without changing their stable order', () => {
    const candidates = groupTaggedHitsByCandidate([
      hit('include-0', 0),
      hit('include-1', 0),
      hit('include-0', 1),
      hit('include-1', 2),
    ]);
    const before = structuredClone(candidates);

    expect(filterCandidateGroups(candidates, criteriaAll(['include-0', 'include-1']))).toEqual([
      {
        candidateKey: 'page-1-candidate-0',
        hits: [hit('include-0', 0), hit('include-1', 0)],
      },
    ]);
    expect(candidates).toEqual(before);
  });
});
