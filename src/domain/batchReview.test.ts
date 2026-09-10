import { describe, expect, it } from 'vitest';

import {
  BatchReviewMappingError,
  mapBatchReview,
  type BatchReviewMapping,
} from './batchReview';
import type {
  BatchJobSnapshot,
  BatchResultItem,
  BatchSnapshotEvidence,
  BatchSourceSnapshot,
} from './batchTask';
import { sourceDocumentKey } from './sourcePreview';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const MATCH_RECT = { x0: 20, y0: 30, x1: 120, y1: 50 };
const CANDIDATE_RECT = { x0: 0, y0: 0, x1: 600, y1: 200 };

function source(
  sourceId: string,
  position: number,
  initialPath: string,
  accessPath: string,
  sha256 = SHA_A,
  pageCount = 3,
): BatchSourceSnapshot {
  return {
    source_id: sourceId,
    position,
    source_key: initialPath.replaceAll('\\', '/').toLowerCase(),
    initial_path: initialPath,
    access_path: accessPath,
    name: `${sourceId}.pdf`,
    sha256,
    size_bytes: 1234,
    page_count: pageCount,
    state: 'verified',
    error: null,
    budget: {
      processed_pages: pageCount,
      text_characters: 100,
      fuzzy_work: 0,
      matches: 1,
      matched_text_characters: 3,
    },
    verified_generation: 1,
    page_summary: { pending: 0, processing: 0, succeeded: pageCount, failed: 0 },
  };
}

function job(sources: BatchSourceSnapshot[], overrides: Partial<BatchJobSnapshot> = {}): BatchJobSnapshot {
  return {
    id: 'job-1',
    name: '批量任务',
    generation: 1,
    state: 'ready_for_review',
    resume_target: null,
    criteria: { include: ['手续费'], includeMode: 'all', exclude: [] },
    criteria_fingerprint: 'c'.repeat(64),
    match_mode: 'exact',
    computation_version: 'batch-assembly-v1',
    result_revision: 'revision-1',
    owner: null,
    error: null,
    created_at: '2026-09-08T00:00:00Z',
    updated_at: '2026-09-08T00:01:00Z',
    deletion_pending: false,
    page_summary: { pending: 0, processing: 0, succeeded: 3, failed: 0 },
    total_pages: 3,
    sources,
    ...overrides,
  };
}

type ItemOptions = {
  sourceKey: string;
  sourcePath?: string;
  sha256?: string;
  page?: number;
  segmentNo?: number;
  id?: string;
  signature?: string;
  evidence?: BatchSnapshotEvidence[];
};

function item(options: ItemOptions): BatchResultItem {
  const page = options.page ?? 1;
  const segmentNo = options.segmentNo ?? 1;
  const id = options.id ?? `job:${options.sha256 ?? SHA_A}:${page}:${segmentNo}`;
  const sha256 = options.sha256 ?? SHA_A;
  const signature = options.signature ?? `${String.fromCharCode(97 + page)}${'d'.repeat(63)}`;
  const original = {
    id,
    source_key: options.sourceKey,
    source_page: page,
    segment_no: segmentNo,
    analysis_signature: signature,
    persistable: true,
    page_width: 600,
    page_height: 800,
    match_rect: MATCH_RECT,
    candidate_rect: CANDIDATE_RECT,
    layout_fingerprint: 'geometry:600x800:0,0,600,200',
    confidence: 0.95,
    auto_full_page: false,
  };
  return {
    segment: {
      id,
      source_key: options.sourceKey,
      source_path: options.sourcePath ?? options.sourceKey,
      source_sha256: sha256,
      source_page: page,
      segment_no: segmentNo,
      match_rect: MATCH_RECT,
      candidate_rect: CANDIDATE_RECT,
      final_rect: CANDIDATE_RECT,
      page_width: 600,
      page_height: 800,
      confidence: 0.95,
      slot: 'full',
      snap_points: [0, 200, 800],
      layout_fingerprint: original.layout_fingerprint,
      crop_mode: 'candidate',
      review_status: 'confirmed',
      manual_adjusted: false,
    },
    evidence: options.evidence ?? [{
      page,
      matched_text: '手续费',
      matched_field: '摘要',
      confidence: 0.95,
      x0: MATCH_RECT.x0,
      y0: MATCH_RECT.y0,
      x1: MATCH_RECT.x1,
      y1: MATCH_RECT.y1,
      query_id: 'include-0',
      role: 'include',
    }],
    original,
  };
}

function expectMappingFailure(callback: () => unknown): void {
  expect(callback).toThrow(BatchReviewMappingError);
}

describe('mapBatchReview', () => {
  it('maps all sources including zero-hit sources and uses the current access path', () => {
    const first = source('source-a', 0, 'C:\\Original\\A.pdf', 'C:\\Current\\A.pdf', SHA_A, 2);
    const second = source('source-b', 1, 'D:\\Original\\B.pdf', 'D:\\Current\\B.pdf', SHA_B, 1);
    const result = mapBatchReview(
      job([first, second], {
        total_pages: 3,
        page_summary: { pending: 0, processing: 0, succeeded: 3, failed: 0 },
      }),
      [item({
        sourceKey: first.source_key,
        sourcePath: 'C:\\Old\\A.pdf',
        sha256: SHA_A,
        page: 2,
        signature: 'e'.repeat(64),
      })],
    );

    expect(result.documents).toEqual([
      {
        key: sourceDocumentKey(first.access_path, SHA_A),
        name: first.name,
        sourcePath: first.access_path,
        sourceSha256: SHA_A,
        pageCount: 2,
        integrityStatus: 'valid',
      },
      {
        key: sourceDocumentKey(second.access_path, SHA_B),
        name: second.name,
        sourcePath: second.access_path,
        sourceSha256: SHA_B,
        pageCount: 1,
        integrityStatus: 'valid',
      },
    ]);
    expect(result.segments[0]).toMatchObject({
      sourcePath: first.access_path,
      sourceSha256: SHA_A,
      sourcePage: 2,
      segmentNo: 1,
    });
    expect(result.matches[0]).toMatchObject({
      source_path: first.access_path,
      source_sha256: SHA_A,
      source_identity: first.source_id,
      page_count: 2,
    });
    expect(result.originals[0]).toMatchObject({
      source_key: first.source_key,
      analysis_signature: 'e'.repeat(64),
    });
    expect(result.geometryById[result.segments[0]!.id]).toEqual({
      matchValid: true,
      pageValid: true,
      pageCount: 2,
      dimensionsMatch: true,
      pageCountMatch: true,
      previewStatus: 'pending',
    });
    expect(Object.keys(result.geometryById)).toEqual([result.segments[0]!.id]);
  });

  it('keeps same-SHA sources independent and preserves compound evidence order', () => {
    const first = source('source-a', 0, '/input/a.pdf', '/current/a.pdf', SHA_A, 1);
    const second = source('source-b', 1, '/input/b.pdf', '/current/b.pdf', SHA_A, 1);
    const evidence: BatchSnapshotEvidence[] = [
      {
        page: 1, matched_text: 'first', matched_field: null, confidence: 0.7,
        x0: 30, y0: 60, x1: 80, y1: 70, query_id: 'include-0', role: 'include',
      },
      {
        page: 1, matched_text: 'representative', matched_field: '摘要', confidence: 0.9,
        x0: MATCH_RECT.x0, y0: MATCH_RECT.y0, x1: MATCH_RECT.x1, y1: MATCH_RECT.y1,
        query_id: 'include-1', role: 'include',
      },
      {
        page: 1, matched_text: 'excluded evidence', matched_field: null, confidence: 0.6,
        x0: MATCH_RECT.x0, y0: MATCH_RECT.y0, x1: MATCH_RECT.x1, y1: MATCH_RECT.y1,
        query_id: 'exclude-0', role: 'exclude',
      },
    ];
    const result = mapBatchReview(job([first, second], {
      total_pages: 2,
      page_summary: { pending: 0, processing: 0, succeeded: 2, failed: 0 },
    }), [
      item({ sourceKey: first.source_key, sha256: SHA_A, evidence }),
      item({
        sourceKey: second.source_key,
        sha256: SHA_A,
        id: 'job:same-sha:1:1:source-b',
        signature: 'f'.repeat(64),
      }),
    ]);

    expect(result.documents.map((document) => document.key)).toEqual([
      sourceDocumentKey(first.access_path, SHA_A),
      sourceDocumentKey(second.access_path, SHA_A),
    ]);
    expect(result.segments.map((segment) => segment.sourcePath)).toEqual([
      first.access_path,
      second.access_path,
    ]);
    expect(result.evidenceById[result.segments[0]!.id]).toHaveLength(3);
    expect(result.evidenceById[result.segments[0]!.id]?.map((hit) => hit.matched_text)).toEqual([
      'first', 'representative', 'excluded evidence',
    ]);
    expect(result.matches[0]?.matched_text).toBe('representative');
    expect(result.matches[0]?.query_id).toBe('include-1');
    expect(result.matches[0]?.role).toBe('include');
    expect(result.matches[1]?.source_identity).toBe(second.source_id);
  });

  it('keeps distinct logical sources independent when they share one access path and SHA', () => {
    const sharedAccessPath = 'C:\\shared\\same-content.pdf';
    const first = source('source-a', 0, 'C:\\logical\\a.pdf', sharedAccessPath, SHA_A, 1);
    const second = source('source-b', 1, 'D:\\logical\\b.pdf', sharedAccessPath, SHA_A, 1);
    const firstItem = item({
      sourceKey: first.source_key,
      sourcePath: 'C:\\old\\a.pdf',
      sha256: SHA_A,
      id: 'same-access-a',
    });
    const secondItem = item({
      sourceKey: second.source_key,
      sourcePath: 'D:\\old\\b.pdf',
      sha256: SHA_A,
      id: 'same-access-b',
      signature: 'f'.repeat(64),
    });

    const result = mapBatchReview(job([first, second], {
      total_pages: 2,
      page_summary: { pending: 0, processing: 0, succeeded: 2, failed: 0 },
    }), [firstItem, secondItem]);

    // One physical preview document is shared, while each logical source
    // retains an independent segment, representative hit, and original.
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({ sourcePath: sharedAccessPath, sourceSha256: SHA_A });
    expect(result.segments).toMatchObject([
      { id: 'same-access-a', sourceKey: first.source_key, sourceName: first.name, sourcePath: sharedAccessPath, segmentNo: 1 },
      { id: 'same-access-b', sourceKey: second.source_key, sourceName: second.name, sourcePath: sharedAccessPath, segmentNo: 1 },
    ]);
    expect(result.matches.map((match) => ({ source_key: match.source_key, source_path: match.source_path }))).toEqual([
      { source_key: first.source_key, source_path: sharedAccessPath },
      { source_key: second.source_key, source_path: sharedAccessPath },
    ]);
    expect(result.originals.map((original) => original.source_key)).toEqual([first.source_key, second.source_key]);

    const mismatchedSegment = structuredClone(firstItem);
    mismatchedSegment.segment.source_key = second.source_key;
    expectMappingFailure(() => mapBatchReview(job([first, second], {
      total_pages: 2,
      page_summary: { pending: 0, processing: 0, succeeded: 2, failed: 0 },
    }), [mismatchedSegment, secondItem]));
  });

  it('accepts a legacy evidence item without query metadata', () => {
    const sourceValue = source('source-a', 0, '/input/a.pdf', '/current/a.pdf');
    const legacyEvidence: BatchSnapshotEvidence = {
      page: 1,
      matched_text: '手续费',
      matched_field: null,
      confidence: 0.95,
      x0: MATCH_RECT.x0,
      y0: MATCH_RECT.y0,
      x1: MATCH_RECT.x1,
      y1: MATCH_RECT.y1,
    };
    const result = mapBatchReview(job([sourceValue]), [item({
      sourceKey: sourceValue.source_key,
      evidence: [legacyEvidence],
    })]);

    expect(result.matches[0]).not.toHaveProperty('query_id');
    expect(result.matches[0]).not.toHaveProperty('role');
  });

  it('rejects a non-ready task or a missing result revision', () => {
    const sourceValue = source('source-a', 0, '/input/a.pdf', '/current/a.pdf');
    const sourceItem = item({ sourceKey: sourceValue.source_key });
    expectMappingFailure(() => mapBatchReview(job([sourceValue], { state: 'running' }), [sourceItem]));
    expectMappingFailure(() => mapBatchReview(job([sourceValue], { result_revision: null }), [sourceItem]));
  });

  it('rejects source/SHA mismatches, duplicate identities, and out-of-order items', () => {
    const first = source('source-a', 0, '/input/a.pdf', '/current/a.pdf', SHA_A, 2);
    const second = source('source-b', 1, '/input/b.pdf', '/current/b.pdf', SHA_B, 2);
    const firstItem = item({ sourceKey: first.source_key, page: 1 });

    expectMappingFailure(() => mapBatchReview(job([first, second]), [
      item({ sourceKey: first.source_key, sha256: SHA_B }),
    ]));
    expectMappingFailure(() => mapBatchReview(job([first, second]), [
      item({ sourceKey: '/unknown.pdf' }),
    ]));
    expectMappingFailure(() => mapBatchReview(job([first, second]), [
      firstItem,
      item({ sourceKey: first.source_key, page: 2, id: firstItem.segment.id, signature: 'e'.repeat(64) }),
    ]));
    expectMappingFailure(() => mapBatchReview(job([first, second]), [
      firstItem,
      item({ sourceKey: first.source_key, page: 2, segmentNo: 2, id: 'gap', signature: 'e'.repeat(64) }),
    ]));
    expectMappingFailure(() => mapBatchReview(job([first, second]), [
      item({ sourceKey: first.source_key, page: 2 }),
      item({ sourceKey: first.source_key, page: 1, signature: 'e'.repeat(64) }),
    ]));
  });

  it('rejects missing representative evidence and inconsistent immutable geometry', () => {
    const sourceValue = source('source-a', 0, '/input/a.pdf', '/current/a.pdf');
    const wrongEvidence: BatchSnapshotEvidence = {
      page: 1,
      matched_text: 'other',
      matched_field: null,
      confidence: 0.95,
      x0: 30,
      y0: 60,
      x1: 90,
      y1: 70,
      query_id: 'include-0',
      role: 'include',
    };
    expectMappingFailure(() => mapBatchReview(job([sourceValue]), [item({
      sourceKey: sourceValue.source_key,
      evidence: [wrongEvidence],
    })]));

    const inconsistent = item({ sourceKey: sourceValue.source_key });
    inconsistent.segment.match_rect = { x0: 22, y0: 30, x1: 120, y1: 50 };
    expectMappingFailure(() => mapBatchReview(job([sourceValue]), [inconsistent]));
  });

  it('returns a structurally reusable mapping without mutating the input items', () => {
    const sourceValue = source('source-a', 0, '/input/a.pdf', '/current/a.pdf');
    const input = item({ sourceKey: sourceValue.source_key });
    const result: BatchReviewMapping = mapBatchReview(job([sourceValue]), [input]);

    result.segments[0]!.matchRect.x0 = 99;
    result.evidenceById[result.segments[0]!.id]![0]!.matched_text = 'changed';
    expect(input.segment.match_rect.x0).toBe(MATCH_RECT.x0);
    expect(input.evidence[0]!.matched_text).toBe('手续费');
  });
});
