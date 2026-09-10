import { describe, expect, it } from 'vitest';
import type { ReviewSegment } from './cropReview';
import {
  MAX_REVIEW_OPERATION_HISTORY,
  ReviewOperationHistory,
  decisionFromSegment,
  sameReviewDecision,
  type ReviewDecision,
  type ReviewDecisionSnapshot,
  type ReviewOperationScope,
} from './reviewOperations';

const scope: ReviewOperationScope = {
  taskId: 'task-1',
  contextKey: 'context-1',
  resultRevision: 'result-1',
  sourceFingerprint: 'sha-1',
};

const rect = { x0: 10, y0: 20, x1: 110, y1: 220 };

function decision(id: string, overrides: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    id,
    finalRect: { ...rect },
    mode: 'manual',
    manualAdjusted: true,
    reviewStatus: 'needs_review',
    ...overrides,
  };
}

function snapshot(id: string, recordRevision: number, overrides: Partial<ReviewDecision> = {}): ReviewDecisionSnapshot {
  return { decision: decision(id, overrides), recordRevision };
}

function recordSingle(
  history: ReviewOperationHistory,
  id: string,
  beforeRevision: number,
  before: Partial<ReviewDecision>,
  after: Partial<ReviewDecision>,
  kind: 'crop' | 'keep_full_page' | 'restore_candidate' | 'confirm_fragment' | 'confirm_group' | 'restore_legacy' = 'crop',
): string {
  return history.record(
    kind,
    [snapshot(id, beforeRevision, before)],
    [snapshot(id, beforeRevision + 1, after)],
  );
}

function segment(overrides: Partial<ReviewSegment> = {}): ReviewSegment {
  return {
    id: 'segment-1',
    sourcePath: 'D:\\docs\\source.pdf',
    sourceSha256: 'a'.repeat(64),
    sourcePage: 1,
    segmentNo: 1,
    matchRect: { ...rect },
    candidateRect: { ...rect },
    finalRect: { ...rect },
    pageWidth: 600,
    pageHeight: 800,
    confidence: 0.9,
    slot: 'top',
    layoutFingerprint: 'layout-1',
    mode: 'candidate',
    reviewStatus: 'needs_review',
    manualAdjusted: false,
    ...overrides,
  };
}

describe('ReviewOperationHistory', () => {
  it('starts empty, reset increments epoch even for the same scope, and null scope rejects records', () => {
    const history = new ReviewOperationHistory();

    expect(history.epoch).toBe(0);
    expect(history.size).toBe(0);
    expect(history.peek()).toBeNull();

    history.reset(scope);
    expect(history.epoch).toBe(1);
    history.reset({ ...scope });
    expect(history.epoch).toBe(2);
    history.reset(null);
    expect(history.epoch).toBe(3);
    expect(() => recordSingle(history, 'segment-1', 0, {}, {})).toThrow();
  });

  it('deep copies the scope, decisions, and peek result', () => {
    const inputScope = { ...scope };
    const before = snapshot('segment-1', 0, { finalRect: { ...rect } });
    const after = snapshot('segment-1', 1, { finalRect: { ...rect, x1: 120 } });
    const history = new ReviewOperationHistory();
    history.reset(inputScope);

    const actionId = history.record('crop', [before], [after]);
    inputScope.taskId = 'mutated-task';
    before.decision.finalRect!.x1 = 999;
    after.decision.manualAdjusted = false;

    const firstPeek = history.peek();
    expect(firstPeek).toMatchObject({ id: actionId, kind: 'crop' });
    expect(firstPeek?.before[0]).toEqual(snapshot('segment-1', 0, { finalRect: rect }));
    expect(firstPeek?.after[0]).toEqual(snapshot('segment-1', 1, { finalRect: { ...rect, x1: 120 } }));

    if (firstPeek) {
      firstPeek.before[0]!.decision.finalRect!.x0 = 777;
      firstPeek.after[0]!.recordRevision = 777;
    }
    expect(history.peek()?.before[0]?.decision.finalRect?.x0).toBe(10);
    expect(history.peek()?.after[0]?.recordRevision).toBe(1);
    expect(history.scope).toEqual(scope);
  });

  it('normalizes page and group confirmed statuses for decision snapshots and comparison', () => {
    const fromSegment = decisionFromSegment(segment({ reviewStatus: 'confirmed' }));
    const pageConfirmed = { ...fromSegment, reviewStatus: 'page_confirmed' as ReviewDecision['reviewStatus'] };
    const groupConfirmed = { ...fromSegment, reviewStatus: 'group_confirmed' as ReviewDecision['reviewStatus'] };

    expect(fromSegment).toEqual({
      id: 'segment-1',
      finalRect: rect,
      mode: 'candidate',
      manualAdjusted: false,
      reviewStatus: 'confirmed',
    });
    expect(sameReviewDecision(fromSegment, pageConfirmed)).toBe(true);
    expect(sameReviewDecision(fromSegment, groupConfirmed)).toBe(true);
    expect(sameReviewDecision(fromSegment, { ...fromSegment, manualAdjusted: true })).toBe(false);
  });

  it('rejects empty, duplicate, mismatched, and non-consecutive snapshots without changing history', () => {
    const history = new ReviewOperationHistory();
    history.reset(scope);

    expect(() => history.record('crop', [], [])).toThrow();
    expect(() => history.record('crop', [snapshot('a', 0), snapshot('a', 0)], [snapshot('a', 1), snapshot('a', 1)])).toThrow();
    expect(() => history.record('crop', [snapshot('a', 0)], [snapshot('b', 1)])).toThrow();
    expect(() => history.record('crop', [snapshot('a', 0)], [snapshot('a', 2)])).toThrow();
    expect(history.size).toBe(0);
  });

  it('records a non-empty unchanged group confirmation as one operation', () => {
    const history = new ReviewOperationHistory();
    history.reset(scope);
    const before = [snapshot('a', 4), snapshot('b', 9)];
    const after = [snapshot('a', 5), snapshot('b', 10)];

    const actionId = history.record('confirm_group', before, after);

    expect(history.size).toBe(1);
    expect(history.peek()).toMatchObject({ id: actionId, kind: 'confirm_group', before, after });
  });

  it('keeps only the latest twenty successful operations', () => {
    const history = new ReviewOperationHistory();
    history.reset(scope);
    const ids: string[] = [];

    for (let index = 0; index < MAX_REVIEW_OPERATION_HISTORY + 1; index += 1) {
      ids.push(recordSingle(history, `segment-${index}`, 0, {}, { finalRect: { ...rect, x0: index + 1 } }));
    }

    expect(MAX_REVIEW_OPERATION_HISTORY).toBe(20);
    expect(history.size).toBe(MAX_REVIEW_OPERATION_HISTORY);
    expect(history.peek()?.id).toBe(ids.at(-1));
    expect(history.peek()?.id).not.toBe(ids[0]);
  });

  it('requires the current top operation, matching before semantics, and after revision plus one', () => {
    const history = new ReviewOperationHistory();
    history.reset(scope);
    const actionId = recordSingle(history, 'segment-1', 0, { reviewStatus: 'needs_review' }, { reviewStatus: 'confirmed' });
    const unchanged = history.peek();

    expect(() => history.completeUndo('other-action', [snapshot('segment-1', 2, { reviewStatus: 'needs_review' })])).toThrow();
    expect(() => history.completeUndo(actionId, [snapshot('segment-1', 2, { reviewStatus: 'blocked' })])).toThrow();
    expect(() => history.completeUndo(actionId, [snapshot('segment-1', 1, { reviewStatus: 'needs_review' })])).toThrow();
    expect(history.peek()).toEqual(unchanged);

    history.completeUndo(actionId, [snapshot('segment-1', 2, { reviewStatus: 'needs_review' })]);
    expect(history.size).toBe(0);
  });

  it('supports two consecutive undos for the same segment by continuing the prior after revision', () => {
    const history = new ReviewOperationHistory();
    history.reset(scope);
    const firstId = recordSingle(history, 'segment-1', 0, { reviewStatus: 'needs_review' }, { finalRect: { ...rect, x1: 120 } });
    const secondId = recordSingle(history, 'segment-1', 1, { finalRect: { ...rect, x1: 120 } }, { finalRect: { ...rect, x1: 140 } });

    history.completeUndo(secondId, [snapshot('segment-1', 3, { finalRect: { ...rect, x1: 120 } })]);
    expect(history.peek()).toMatchObject({ id: firstId, after: [snapshot('segment-1', 3, { finalRect: { ...rect, x1: 120 } })] });

    history.completeUndo(firstId, [snapshot('segment-1', 4, { reviewStatus: 'needs_review' })]);
    expect(history.size).toBe(0);
  });

  it('supports interleaved operations and an atomic batch undo for every affected segment', () => {
    const history = new ReviewOperationHistory();
    history.reset(scope);
    const firstId = recordSingle(history, 'a', 0, {}, { finalRect: { ...rect, x1: 120 } });
    const secondId = recordSingle(history, 'b', 0, {}, { finalRect: { ...rect, x1: 130 } });
    const batchId = history.record(
      'confirm_group',
      [
        snapshot('a', 1, { finalRect: { ...rect, x1: 120 } }),
        snapshot('b', 1, { finalRect: { ...rect, x1: 130 } }),
      ],
      [
        snapshot('a', 2, { reviewStatus: 'confirmed', finalRect: { ...rect, x1: 120 } }),
        snapshot('b', 2, { reviewStatus: 'confirmed', finalRect: { ...rect, x1: 130 } }),
      ],
    );

    history.completeUndo(batchId, [
      snapshot('a', 3, { finalRect: { ...rect, x1: 120 } }),
      snapshot('b', 3, { finalRect: { ...rect, x1: 130 } }),
    ]);
    expect(history.peek()).toMatchObject({ id: secondId, after: [snapshot('b', 3, { finalRect: { ...rect, x1: 130 } })] });

    history.completeUndo(secondId, [snapshot('b', 4, { reviewStatus: 'needs_review' })]);
    expect(history.peek()?.id).toBe(firstId);
    history.completeUndo(firstId, [snapshot('a', 4, {})]);
    expect(history.size).toBe(0);
  });

  it('does not continue a prior chain across an external same-semantic revision', () => {
    const history = new ReviewOperationHistory();
    history.reset(scope);
    const firstId = recordSingle(history, 'segment-1', 0, {}, { reviewStatus: 'confirmed' });
    const secondId = recordSingle(history, 'segment-1', 2, { reviewStatus: 'confirmed' }, { reviewStatus: 'blocked' });

    history.completeUndo(secondId, [snapshot('segment-1', 4, { reviewStatus: 'confirmed' })]);
    expect(history.peek()).toMatchObject({
      id: firstId,
      after: [snapshot('segment-1', 1, { reviewStatus: 'confirmed' })],
    });
  });
});
