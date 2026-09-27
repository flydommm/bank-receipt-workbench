import { describe, expect, it } from 'vitest';
import type { ReviewSegment } from './cropReview';
import { LinkedCropSession } from './linkedCropSession';
import { MAX_REVIEW_OPERATION_HISTORY } from './reviewOperations';

function segment(id: string, offset = 0, slot: ReviewSegment['slot'] = 'top'): ReviewSegment {
  return {
    id,
    sourcePath: 'C:/synthetic/receipts.pdf',
    sourceSha256: 'a'.repeat(64),
    sourcePage: 1,
    segmentNo: 1,
    matchRect: { x0: 50, y0: 50, x1: 100, y1: 70 },
    candidateRect: { x0: 10, y0: 10, x1: 500, y1: 250 },
    finalRect: { x0: 10, y0: 10, x1: 500, y1: 250 + offset },
    pageWidth: 600,
    pageHeight: 800,
    confidence: 0.95,
    slot,
    snapPoints: [10, 250],
    layoutFingerprint: 'synthetic-layout',
    mode: 'manual',
    reviewStatus: 'needs_review',
    manualAdjusted: true,
  };
}

function link(session: LinkedCropSession, operationId: string, sampleId: string, ids: string[], slot: ReviewSegment['slot'] = 'top'): void {
  session.commit(operationId, session.transition([segment(sampleId, 0, slot), ...ids.map((id) => segment(id, 0, slot))], sampleId));
}

describe('LinkedCropSession', () => {
  it('prepares a transition without enrolling members before the save succeeds', () => {
    const session = new LinkedCropSession();
    const transition = session.transition([segment('sample'), segment('target')], 'sample');

    expect(session.membersFor('sample').size).toBe(0);
    expect(transition.before.size).toBe(0);
    expect(transition.after.get('sample')?.has('sample')).toBe(false);
    expect(transition.after.get('sample')?.get('target')).toEqual(segment('target'));

    session.commit('saved', transition);
    expect([...session.membersFor('sample').keys()]).toEqual(['target']);
  });

  it('updates affected members and preserves untouched members of the same sample', () => {
    const session = new LinkedCropSession();
    link(session, 'first', 'sample', ['target', 'other']);

    session.commit('second', session.transition([segment('sample', 3), segment('target', 3)], 'sample'));

    expect(session.membersFor('sample').get('target')?.finalRect?.y1).toBe(253);
    expect(session.membersFor('sample').get('other')?.finalRect?.y1).toBe(250);
    session.undo('second');
    expect(session.membersFor('sample').get('target')?.finalRect?.y1).toBe(250);
    expect(session.membersFor('sample').has('other')).toBe(true);
  });

  it('detaches independently edited members only on commit and undo restores their previous owner', () => {
    const session = new LinkedCropSession();
    link(session, 'linked', 'sample', ['target', 'other']);
    const transition = session.transition([segment('target', 4)]);

    expect(session.membersFor('sample').has('target')).toBe(true);
    session.commit('independent', transition);
    expect([...session.membersFor('sample').keys()]).toEqual(['other']);
    session.undo('independent');
    expect([...session.membersFor('sample').keys()]).toEqual(['target', 'other']);
  });

  it('reassigns targets and removes a new sample from its former owner group', () => {
    const session = new LinkedCropSession();
    link(session, 'first', 'sample-a', ['sample-b', 'target', 'other']);
    link(session, 'second', 'sample-b', ['target']);

    expect([...session.membersFor('sample-a').keys()]).toEqual(['other']);
    expect([...session.membersFor('sample-b').keys()]).toEqual(['target']);
    session.undo('second');
    expect([...session.membersFor('sample-a').keys()]).toEqual(['sample-b', 'target', 'other']);
    expect(session.membersFor('sample-b').size).toBe(0);
  });

  it('detaches all affected targets when confirming or restoring several segments', () => {
    const session = new LinkedCropSession();
    link(session, 'first', 'sample-a', ['target-a']);
    link(session, 'second', 'sample-b', ['target-b']);

    session.commit('confirmed', session.transition(['target-a', 'target-b'].map((id) => ({
      ...segment(id), reviewStatus: 'confirmed' as const,
    }))));
    expect(session.membersFor('sample-a').size).toBe(0);
    expect(session.membersFor('sample-b').size).toBe(0);
    session.undo('confirmed');
    expect(session.membersFor('sample-a').has('target-a')).toBe(true);
    expect(session.membersFor('sample-b').has('target-b')).toBe(true);
  });

  it('isolates input objects, transition snapshots and returned members from committed state', () => {
    const session = new LinkedCropSession();
    const target = segment('target');
    const transition = session.transition([segment('sample'), target], 'sample');
    target.finalRect!.y1 = 700;
    target.snapPoints!.push(700);
    session.commit('linked', transition);
    transition.after.get('sample')!.get('target')!.finalRect!.y1 = 600;

    const returned = session.membersFor('sample');
    returned.get('target')!.candidateRect!.y1 = 500;
    returned.get('target')!.snapPoints!.push(500);
    (returned as Map<string, ReviewSegment>).clear();

    const saved = session.membersFor('sample').get('target')!;
    expect(saved.finalRect!.y1).toBe(250);
    expect(saved.candidateRect!.y1).toBe(250);
    expect(saved.snapPoints).toEqual([10, 250]);
  });

  it('keeps the before state and undo history independent of the after snapshot', () => {
    const session = new LinkedCropSession();
    link(session, 'linked', 'sample', ['target']);
    const transition = session.transition([], 'sample');
    transition.after.get('sample')!.get('target')!.finalRect!.y1 = 300;
    expect(transition.before.get('sample')!.get('target')!.finalRect!.y1).toBe(250);
    expect(session.membersFor('sample').get('target')!.finalRect!.y1).toBe(250);

    session.commit('changed', transition);
    transition.before.get('sample')!.get('target')!.finalRect!.y1 = 700;
    session.undo('changed');
    expect(session.membersFor('sample').get('target')!.finalRect!.y1).toBe(250);
  });

  it('retains an abandoned plan unchanged for retry while committed membership stays unchanged', () => {
    const session = new LinkedCropSession();
    link(session, 'first', 'sample', ['target']);
    const pending = session.transition([segment('sample'), segment('target', 5)], 'sample');

    expect(session.membersFor('sample').get('target')!.finalRect!.y1).toBe(250);
    session.commit('retried', pending);
    expect(session.membersFor('sample').get('target')!.finalRect!.y1).toBe(255);
    session.undo('retried');
    expect(session.membersFor('sample').get('target')!.finalRect!.y1).toBe(250);
  });

  it('limits member history to the same twenty operations and ignores missing or non-latest undo IDs', () => {
    const session = new LinkedCropSession();
    for (let index = 0; index <= MAX_REVIEW_OPERATION_HISTORY; index += 1) {
      session.commit(`operation-${index}`, session.transition([segment('target', index)], 'sample'));
    }

    session.undo('operation-0');
    session.undo('operation-1');
    session.undo('missing');
    expect(session.membersFor('sample').get('target')!.finalRect!.y1).toBe(270);
    for (let index = MAX_REVIEW_OPERATION_HISTORY; index >= 1; index -= 1) session.undo(`operation-${index}`);
    expect(session.membersFor('sample').get('target')!.finalRect!.y1).toBe(250);
    session.undo('operation-0');
    expect(session.membersFor('sample').has('target')).toBe(true);
  });

  it('discard detaches affected members and sample groups and prevents old undo from reenrolling them', () => {
    const session = new LinkedCropSession();
    link(session, 'first', 'sample-a', ['target-a', 'other']);
    link(session, 'second', 'sample-b', ['target-b']);

    session.discard(['target-a', 'sample-b']);
    expect([...session.membersFor('sample-a').keys()]).toEqual(['other']);
    expect(session.membersFor('sample-b').size).toBe(0);
    session.undo('second');
    session.undo('first');
    expect([...session.membersFor('sample-a').keys()]).toEqual(['other']);
    expect(session.membersFor('sample-b').size).toBe(0);
  });

  it('reset clears members and every old operation before another task is opened', () => {
    const session = new LinkedCropSession();
    link(session, 'first', 'sample', ['target']);
    session.reset();
    session.undo('first');
    expect(session.membersFor('sample').size).toBe(0);
    link(session, 'second', 'new-sample', ['new-target']);
    expect(session.membersFor('sample').size).toBe(0);
    expect(session.membersFor('new-sample').has('new-target')).toBe(true);
  });

  it('keeps 51/55/56 same-layout positions isolated while applying one large batch atomically', () => {
    const session = new LinkedCropSession();
    const groups = [
      { sample: 'top-sample', slot: 'top' as const, count: 51 },
      { sample: 'middle-sample', slot: 'middle' as const, count: 55 },
      { sample: 'bottom-sample', slot: 'bottom' as const, count: 56 },
    ];

    for (const group of groups) {
      const targets = Array.from({ length: group.count }, (_, index) => `target-${group.slot}-${index}`);
      link(session, `seed-${group.slot}`, group.sample, targets.map((id) => id), group.slot);
      expect(session.membersFor(group.sample).size).toBe(group.count);
      expect([...session.membersFor(group.sample).values()].every((item) => item.slot === group.slot)).toBe(true);
    }

    const topTargets = Array.from({ length: 51 }, (_, index) => segment(`target-top-${index}`, 3, 'top'));
    session.commit('top-adjustment', session.transition([segment('top-sample', 3, 'top'), ...topTargets], 'top-sample'));
    expect(session.membersFor('top-sample').size).toBe(51);
    expect(session.membersFor('top-sample').get('target-top-50')?.finalRect?.y1).toBe(253);
    expect(session.membersFor('middle-sample').get('target-middle-54')?.finalRect?.y1).toBe(250);
    expect(session.membersFor('bottom-sample').get('target-bottom-55')?.finalRect?.y1).toBe(250);

    session.undo('top-adjustment');
    expect(session.membersFor('top-sample').get('target-top-50')?.finalRect?.y1).toBe(250);
    expect(session.membersFor('middle-sample').size).toBe(55);
    expect(session.membersFor('bottom-sample').size).toBe(56);
  });
});
