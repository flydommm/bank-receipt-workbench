// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { SearchCriteria } from './searchCriteria';
import {
  FAILURE_RETENTION_LIMIT_BYTES,
  freezeBatchExecutionContext,
  executionContextKey,
  type BatchExecutionContext,
} from './batchExecution';

const criteria: SearchCriteria = {
  include: ['  invoice ', '发票', 'invoice'],
  includeMode: 'all',
  exclude: [' draft ', 'draft'],
};

function context(overrides: Partial<BatchExecutionContext> = {}): BatchExecutionContext {
  return {
    sources: [
      { sourcePath: 'D:\\Docs\\A.pdf', name: 'A.pdf' },
      { sourcePath: 'D:\\Docs\\B.pdf', name: 'B.pdf' },
    ],
    criteria: { ...criteria, include: [...criteria.include], exclude: [...criteria.exclude] },
    matchMode: 'exact',
    computationVersion: 'm2-test-v1',
    ...overrides,
  };
}

describe('batch execution context', () => {
  it('preserves the actual Unicode spelling of file paths and version tokens', () => {
    const sourcePath = 'D:/Docs/cafe\u0301.pdf';
    const computationVersion = 'engine-e\u0301';
    const frozen = freezeBatchExecutionContext(context({
      sources: [{ sourcePath, name: 'sample.pdf' }], computationVersion,
    }));
    expect(frozen.sources[0]!.sourcePath).toBe(sourcePath);
    expect(frozen.computationVersion).toBe(computationVersion);
  });

  it('normalizes and deeply freezes an independent snapshot', () => {
    const input = context();
    const frozen = freezeBatchExecutionContext(input);

    expect(frozen).not.toBe(input);
    expect(frozen.sources.map((source) => source.sourcePath)).toEqual(['D:\\Docs\\A.pdf', 'D:\\Docs\\B.pdf']);
    expect(frozen.criteria).toEqual({ include: ['invoice', '发票'], includeMode: 'all', exclude: ['draft'] });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.sources)).toBe(true);
    expect(Object.isFrozen(frozen.sources[0])).toBe(true);
    expect(Object.isFrozen(frozen.criteria)).toBe(true);
    expect(Object.isFrozen(frozen.criteria.include)).toBe(true);
    expect(() => { frozen.sources[0]!.sourcePath = 'changed'; }).toThrow();
    expect(() => { frozen.criteria.include.push('changed'); }).toThrow();

    input.sources[0]!.sourcePath = 'mutated.pdf';
    input.criteria.include[0] = 'mutated';
    expect(frozen.sources[0]!.sourcePath).toBe('D:\\Docs\\A.pdf');
    expect(frozen.criteria.include).toEqual(['invoice', '发票']);
  });

  it('rejects empty, invalid, and duplicate normalized sources', () => {
    expect(() => freezeBatchExecutionContext(context({ sources: [] }))).toThrow();
    expect(() => freezeBatchExecutionContext(context({ sources: [{ sourcePath: '  ', name: 'x' }] }))).toThrow();
    expect(() => freezeBatchExecutionContext(context({ sources: [
      { sourcePath: 'D:\\Docs\\A.pdf', name: 'A' },
      { sourcePath: 'd:/docs/a.pdf', name: 'same file' },
    ] }))).toThrow();
    expect(() => freezeBatchExecutionContext(context({ criteria: { include: [], includeMode: 'all', exclude: [] } }))).toThrow();
    expect(() => freezeBatchExecutionContext(context({ computationVersion: '  ' }))).toThrow();
  });

  it('keeps source order and includes all identity-bearing fields in a stable key', () => {
    const first = freezeBatchExecutionContext(context());
    const equivalent = freezeBatchExecutionContext(context({
      sources: [
        { sourcePath: 'd:/DOCS/a.pdf', name: 'renamed display A' },
        { sourcePath: 'D:/docs/b.pdf', name: 'renamed display B' },
      ],
      criteria: { include: ['invoice', '发票'], includeMode: 'all', exclude: ['draft'] },
    }));
    expect(executionContextKey(first)).toBe(executionContextKey(equivalent));
    expect(first.sources.map((source) => source.sourcePath)).toEqual(['D:\\Docs\\A.pdf', 'D:\\Docs\\B.pdf']);

    expect(executionContextKey(first)).not.toBe(executionContextKey(freezeBatchExecutionContext(context({
      sources: [...first.sources].reverse(),
    }))));
    expect(executionContextKey(first)).not.toBe(executionContextKey(freezeBatchExecutionContext(context({
      computationVersion: 'm2-test-v2',
    }))));
    expect(executionContextKey(first)).not.toBe(executionContextKey(freezeBatchExecutionContext(context({
      matchMode: 'fuzzy',
    }))));
    expect(FAILURE_RETENTION_LIMIT_BYTES).toBe(128 * 1024 * 1024);
  });
});
