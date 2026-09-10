// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { EngineReviewSegment, EngineReviewSegmentV2, EnginePreparedReview } from '../components/localEngineAdapter';
import type { ReviewSegment } from './cropReview';
import { applyLegacyReviewSuggestion, legacyReviewSuggestions, mergeCompatibleReviews } from './reviewHistory';

const sha = 'a'.repeat(64);
const signature = 'b'.repeat(64);
const sourcePath = 'D:\\docs\\A.pdf';
const sourceKey = 'd:/docs/a.pdf';
const matchRect = { x0: 10, y0: 20, x1: 80, y1: 30 };
const candidateRect = { x0: 0, y0: 0, x1: 600, y1: 200 };

function segment(overrides: Partial<ReviewSegment> = {}): ReviewSegment {
  return {
    id: 'segment-1', sourcePath, sourceSha256: sha, sourcePage: 1, segmentNo: 1,
    matchRect: { ...matchRect }, candidateRect: { ...candidateRect }, finalRect: { x0: 0, y0: 0, x1: 600, y1: 200 },
    pageWidth: 600, pageHeight: 800, confidence: 0.96, slot: 'top', layoutFingerprint: 'geometry:600:800',
    mode: 'candidate', reviewStatus: 'needs_review', manualAdjusted: false, ...overrides,
  };
}

function preparedRecord(overrides: Partial<EngineReviewSegmentV2> = {}): EngineReviewSegmentV2 {
  return {
    id: 'segment-1', task_id: 'task-1', source_path: sourcePath, source_sha256: sha,
    source_page: 1, segment_no: 1, match_rect: { ...matchRect }, candidate_rect: { ...candidateRect },
    final_rect: { x0: 0, y0: 5, x1: 600, y1: 195 }, layout_fingerprint: 'new-layout', confidence: 0.2,
    crop_mode: 'manual', review_status: 'page_confirmed', manual_adjusted: true,
    reviewed_at: '2026-09-08T00:00:00.000Z', context_key: 'c'.repeat(64), source_key: sourceKey,
    analysis_signature: signature, result_revision: 'result-1', record_revision: 1, page_width: 600, page_height: 800,
    ...overrides,
  };
}

function prepared(records: EngineReviewSegmentV2[], groupConfirmed = false): EnginePreparedReview {
  return {
    status: 'ok', context_key: 'c'.repeat(64), result_revision: 'result-1', segments: records,
    record_revisions: [{ id: 'segment-1', source_key: sourceKey, source_page: 1, segment_no: 1, record_revision: 1 }],
    group_confirmed: groupConfirmed,
  };
}

function legacyRecord(overrides: Partial<EngineReviewSegment> = {}): EngineReviewSegment {
  return {
    id: 'old-id', task_id: 'old-task', source_path: sourcePath, source_sha256: sha,
    source_page: 1, segment_no: 1, match_rect: { ...matchRect }, candidate_rect: { ...candidateRect },
    final_rect: { x0: 0, y0: 5, x1: 600, y1: 195 }, layout_fingerprint: 'old-layout', confidence: 0.8,
    crop_mode: 'manual', review_status: 'confirmed', manual_adjusted: true,
    reviewed_at: '2026-09-08T00:00:00.000Z', ...overrides,
  };
}

describe('review history', () => {
  it('restores only decisions from verified v2 records and keeps original analysis fields', () => {
    const current = segment({ finalRect: { x0: 0, y0: 0, x1: 600, y1: 200 }, mode: 'candidate', reviewStatus: 'needs_review', manualAdjusted: false });
    const result = mergeCompatibleReviews([current], prepared([preparedRecord()]));
    expect(result.segments[0]).toMatchObject({
      finalRect: { x0: 0, y0: 5, x1: 600, y1: 195 }, mode: 'manual', reviewStatus: 'confirmed', manualAdjusted: true,
      candidateRect, matchRect, layoutFingerprint: 'geometry:600:800', confidence: 0.96,
    });
  });

  it('maps group confirmed to confirmed and does not claim a partial group', () => {
    const current = segment();
    const partial = mergeCompatibleReviews([current], prepared([], true));
    expect(partial.groupConfirmed).toBe(false);
    expect(mergeCompatibleReviews([], prepared([], true)).groupConfirmed).toBe(false);
    const full = mergeCompatibleReviews([current], prepared([preparedRecord({ review_status: 'group_confirmed' })], true));
    expect(full.groupConfirmed).toBe(true);
    expect(full.segments[0]?.reviewStatus).toBe('confirmed');
  });

  it.each(['needs_review', 'blocked'] as const)('restores the explicit %s status of a compatible v2 record', (status) => {
    const current = segment({ reviewStatus: 'confirmed' });
    const result = mergeCompatibleReviews([current], prepared([preparedRecord({ review_status: status })]));
    expect(result.segments[0]?.reviewStatus).toBe(status);
  });

  it('restores separate decisions for logical sources sharing path, SHA, page, and segment number', () => {
    const first = segment({ id: 'logical-a', sourceKey: 'd:/logical/a.pdf', sourceName: '逻辑来源 A' });
    const second = segment({ id: 'logical-b', sourceKey: 'd:/logical/b.pdf', sourceName: '逻辑来源 B' });
    const firstRecord = preparedRecord({
      id: first.id,
      source_key: first.sourceKey,
      review_status: 'confirmed',
      final_rect: { x0: 0, y0: 5, x1: 600, y1: 195 },
    });
    const secondRecord = preparedRecord({
      id: second.id,
      source_key: second.sourceKey,
      review_status: 'needs_review',
      final_rect: { x0: 0, y0: 10, x1: 600, y1: 190 },
    });
    const preparedBoth: EnginePreparedReview = {
      status: 'ok',
      context_key: 'c'.repeat(64),
      result_revision: 'result-1',
      segments: [firstRecord, secondRecord],
      record_revisions: [
        { id: first.id, source_key: first.sourceKey!, source_page: 1, segment_no: 1, record_revision: 1 },
        { id: second.id, source_key: second.sourceKey!, source_page: 1, segment_no: 1, record_revision: 1 },
      ],
      group_confirmed: false,
    };

    const result = mergeCompatibleReviews([first, second], preparedBoth);

    expect(result.segments).toMatchObject([
      { id: 'logical-a', sourceKey: 'd:/logical/a.pdf', finalRect: { x0: 0, y0: 5, x1: 600, y1: 195 }, reviewStatus: 'confirmed' },
      { id: 'logical-b', sourceKey: 'd:/logical/b.pdf', finalRect: { x0: 0, y0: 10, x1: 600, y1: 190 }, reviewStatus: 'needs_review' },
    ]);
    expect(result.segments[0]?.sourceName).toBe('逻辑来源 A');
    expect(result.segments[1]?.sourceName).toBe('逻辑来源 B');
  });

  it('exports normalized, geometry-matched legacy suggestions without copying missing records', () => {
    const current = segment({ id: 'new-id', sourcePath: 'd:/DOCS/a.pdf' });
    const suggestions = legacyReviewSuggestions([current, segment({ id: 'missing', sourcePath: 'D:\\docs\\missing.pdf' })], [legacyRecord()]);
    expect(Object.keys(suggestions)).toEqual(['new-id']);
    expect(suggestions['new-id']).toMatchObject({ final_rect: legacyRecord().final_rect, crop_mode: 'manual' });
  });

  it('accepts a full-page legacy suggestion with no rectangle and rejects duplicate logical keys', () => {
    const fullPage = legacyRecord({ crop_mode: 'full_page', final_rect: null });
    expect(legacyReviewSuggestions([segment({ id: 'new-id' })], [fullPage])).toMatchObject({ 'new-id': fullPage });
    const duplicate = legacyReviewSuggestions([segment({ id: 'new-id' })], [legacyRecord(), legacyRecord({ id: 'other-old-id' })]);
    expect(duplicate).toEqual({});
  });

  it('rejects legacy suggestions when source, match geometry, page or final rectangle is invalid', () => {
    const current = segment({ id: 'new-id' });
    expect(legacyReviewSuggestions([current], [legacyRecord({ source_sha256: 'f'.repeat(64) })])).toEqual({});
    expect(legacyReviewSuggestions([current], [legacyRecord({ match_rect: { ...matchRect, x0: 11 } })])).toEqual({});
    expect(legacyReviewSuggestions([current], [legacyRecord({ source_page: 2 })])).toEqual({});
    expect(legacyReviewSuggestions([current], [legacyRecord({ final_rect: { x0: 0, y0: 0, x1: 5, y1: 5 } })])).toEqual({});
  });

  it('applies only a validated legacy decision and leaves the current analysis untouched', () => {
    const current = segment({ id: 'new-id', reviewStatus: 'confirmed', manualAdjusted: false });
    const result = applyLegacyReviewSuggestion(current, legacyRecord());
    expect(result).toMatchObject({ id: 'new-id', finalRect: legacyRecord().final_rect, mode: 'manual', reviewStatus: 'needs_review', manualAdjusted: true });
    expect(result.candidateRect).toEqual(current.candidateRect);
    expect(result.matchRect).toEqual(current.matchRect);
    expect(result.layoutFingerprint).toBe(current.layoutFingerprint);
    expect(result.confidence).toBe(current.confidence);
  });

  it('throws when directly applying a legacy record with a mismatched source or illegal decision', () => {
    const current = segment();
    expect(() => applyLegacyReviewSuggestion(current, legacyRecord({ source_path: 'D:\\docs\\other.pdf' }))).toThrow();
    expect(() => applyLegacyReviewSuggestion(current, legacyRecord({ final_rect: { x0: 0, y0: 0, x1: 5, y1: 5 } }))).toThrow();
    expect(() => applyLegacyReviewSuggestion(current, legacyRecord({ match_rect: { ...matchRect, x1: 81 } }))).toThrow();
  });
});
