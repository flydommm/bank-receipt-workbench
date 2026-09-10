// @vitest-environment jsdom
// @ts-expect-error The test runtime exposes Node crypto without @types/node.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReviewSegment } from './cropReview';
import { buildOriginalReviewContext, type OriginalReviewContextInput } from './reviewContext';

const segment: ReviewSegment = {
  id: 'source-1-page-1-segment-1', sourcePath: 'D:\\资料\\A.PDF', sourceSha256: 'a'.repeat(64),
  sourcePage: 1, segmentNo: 1, matchRect: { x0: 10, y0: 20, x1: 80, y1: 30 },
  candidateRect: { x0: 0, y0: 0, x1: 600, y1: 200 }, finalRect: { x0: 0, y0: 0, x1: 600, y1: 200 },
  pageWidth: 600, pageHeight: 800, confidence: 0.96, slot: 'top', layoutFingerprint: 'geometry:600:800',
  mode: 'candidate', reviewStatus: 'confirmed', manualAdjusted: false,
};

function input(): OriginalReviewContextInput {
  return {
    documents: [{ key: 'doc-a', name: 'A.PDF', sourcePath: segment.sourcePath, sourceSha256: segment.sourceSha256, pageCount: 2, integrityStatus: 'valid' }],
    criteria: { include: ['手续费'], includeMode: 'all', exclude: ['作废'] }, matchMode: 'exact', computationVersion: 'm2-test',
    segments: [structuredClone(segment)],
    evidenceById: { [segment.id]: [{ page: 1, matched_text: '手续费', matched_field: null, confidence: 0.98,
      x0: 10, y0: 20, x1: 80, y1: 30, query_id: 'include-0', role: 'include' }] },
  };
}

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

it('creates stable original signatures, fresh result revisions and normalized source identity', async () => {
  const first = await buildOriginalReviewContext(input());
  const second = await buildOriginalReviewContext(input());
  expect(first.originals).toEqual(second.originals);
  expect(first.context).toEqual(second.context);
  expect(first.resultRevision).not.toBe(second.resultRevision);
  expect(first.originals[0]).toMatchObject({ persistable: true, source_key: 'd:/资料/a.pdf', auto_full_page: false });
  expect(first.context.sources[0]?.source_path).toBe(segment.sourcePath);
});

it.each(['includeMode', 'matchMode', 'exclude', 'tag order'])(
  'includes %s in the criteria fingerprint', async (change) => {
    const initial = input();
    initial.criteria.include = ['手续费', '缴税'];
    const changed = structuredClone(initial);
    if (change === 'includeMode') changed.criteria.includeMode = 'any';
    if (change === 'matchMode') changed.matchMode = 'fuzzy';
    if (change === 'exclude') changed.criteria.exclude = ['退回'];
    if (change === 'tag order') changed.criteria.include.reverse();
    const [before, after] = await Promise.all([buildOriginalReviewContext(initial), buildOriginalReviewContext(changed)]);
    expect(before.context.criteria_fingerprint).not.toBe(after.context.criteria_fingerprint);
  },
);

it('excludes ephemeral IDs and manual final rectangles from the original signature', async () => {
  const before = await buildOriginalReviewContext(input());
  const changed = input();
  changed.segments[0]!.id = 'new-result-id';
  changed.evidenceById['new-result-id'] = changed.evidenceById[segment.id]!;
  changed.segments[0]!.finalRect = { x0: 0, y0: 5, x1: 600, y1: 195 };
  changed.segments[0]!.manualAdjusted = true;
  const after = await buildOriginalReviewContext(changed);
  expect(after.originals[0]?.analysis_signature).toBe(before.originals[0]?.analysis_signature);
});

it.each(['candidate', 'full page', 'evidence', 'tag'])(
  'invalidates the original signature when %s changes', async (change) => {
    const changed = input();
    if (change === 'candidate') changed.segments[0]!.candidateRect!.y1 = 210;
    if (change === 'full page') changed.segments[0]!.mode = 'full_page';
    if (change === 'evidence') changed.evidenceById[segment.id]![0]!.matched_text = '缴税';
    if (change === 'tag') changed.evidenceById[segment.id]![0]!.role = 'exclude';
    const [before, after] = await Promise.all([buildOriginalReviewContext(input()), buildOriginalReviewContext(changed)]);
    expect(before.originals[0]?.analysis_signature).not.toBe(after.originals[0]?.analysis_signature);
  },
);

it('keeps same-SHA sources separate and retains a valid low-confidence blocked original', async () => {
  const value = input();
  value.documents.push({ ...value.documents[0]!, key: 'doc-b', sourcePath: 'D:/other/A.PDF' });
  value.segments.push({ ...structuredClone(segment), id: 'second', sourcePath: 'D:/other/A.PDF', reviewStatus: 'blocked', confidence: 0.6 });
  value.evidenceById.second = value.evidenceById[segment.id]!;
  const result = await buildOriginalReviewContext(value);
  expect(result.context.sources).toHaveLength(2);
  expect(result.originals[1]).toMatchObject({ source_key: 'd:/other/a.pdf', persistable: true, confidence: 0.6 });
});

it('retains unknown geometry as a non-persistable finite manifest entry', async () => {
  const value = input();
  Object.assign(value.segments[0]!, { pageWidth: NaN, pageHeight: NaN, sourcePage: 0, matchRect: { x0: NaN, y0: 1, x1: 2, y1: 3 } });
  const result = await buildOriginalReviewContext(value);
  expect(result.originals[0]).toMatchObject({ persistable: false, page_width: 0, page_height: 0, match_rect: null, source_page: 0 });
  expect(JSON.stringify(result)).not.toContain('NaN');
});

it('freezes the captured inputs before hashing and the original geometry after construction', async () => {
  const value = input();
  const pending = buildOriginalReviewContext(value);
  value.criteria.include[0] = 'changed';
  value.segments[0]!.candidateRect!.y1 = 777;
  const result = await pending;
  expect(result.originals[0]?.candidate_rect?.y1).toBe(200);
  expect(result.context.criteria_fingerprint).toBe((await buildOriginalReviewContext(input())).context.criteria_fingerprint);
  expect(Object.isFrozen(result.originals[0]?.candidate_rect)).toBe(true);
});

it('rejects missing evidence, duplicate normalized sources and changed source identities', async () => {
  const missing = input();
  missing.evidenceById = {};
  await expect(buildOriginalReviewContext(missing)).rejects.toThrow();
  const duplicate = input();
  duplicate.documents.push({ ...duplicate.documents[0]!, sourcePath: 'd:/资料/a.pdf' });
  await expect(buildOriginalReviewContext(duplicate)).rejects.toThrow();
  const changed = input();
  changed.segments[0]!.sourceSha256 = 'b'.repeat(64);
  await expect(buildOriginalReviewContext(changed)).rejects.toThrow();
});
