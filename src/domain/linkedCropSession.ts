import type { ReviewSegment } from './cropReview';
import { MAX_REVIEW_OPERATION_HISTORY } from './reviewOperations';

export type LinkedCropState = ReadonlyMap<string, ReadonlyMap<string, ReviewSegment>>;

/** Session-only membership change committed alongside a saved review operation. */
export type LinkedCropTransition = {
  before: LinkedCropState;
  after: LinkedCropState;
};

type MutableState = Map<string, Map<string, ReviewSegment>>;

function cloneState(state: LinkedCropState): MutableState {
  return new Map([...state].map(([sampleId, members]) => [
    sampleId,
    new Map([...members].map(([id, segment]) => [id, structuredClone(segment)])),
  ]));
}

function detach(state: MutableState, affectedIds: ReadonlySet<string>): void {
  for (const [sampleId, members] of state) {
    for (const id of affectedIds) members.delete(id);
    if (members.size === 0) state.delete(sampleId);
  }
}

/**
 * Remembers which saved decisions were produced by linkage in this session.
 * Review persistence and source validation remain the caller's responsibility.
 * An unsaved preview or failed save must never call commit or undo.
 */
export class LinkedCropSession {
  private members: MutableState = new Map();

  private history = new Map<string, MutableState>();

  membersFor(sampleId: string): ReadonlyMap<string, ReviewSegment> {
    return new Map([...this.members.get(sampleId) ?? []].map(([id, segment]) => [
      id,
      structuredClone(segment),
    ]));
  }

  transition(segments: ReviewSegment[], linkedSampleId?: string): LinkedCropTransition {
    const before = cloneState(this.members);
    const after = cloneState(this.members);
    detach(after, new Set(segments.map((segment) => segment.id)));

    if (linkedSampleId !== undefined) {
      const members = after.get(linkedSampleId) ?? new Map<string, ReviewSegment>();
      for (const segment of segments) {
        if (segment.id !== linkedSampleId) members.set(segment.id, structuredClone(segment));
      }
      if (members.size > 0) after.set(linkedSampleId, members);
    }

    return { before, after };
  }

  commit(operationId: string, transition: LinkedCropTransition): void {
    // Clone both snapshots before changing anything, including when callers
    // retain the pending transition for a retry or later mutate their copy.
    const before = cloneState(transition.before);
    const after = cloneState(transition.after);
    this.history.delete(operationId);
    this.history.set(operationId, before);
    this.members = after;
    if (this.history.size > MAX_REVIEW_OPERATION_HISTORY) {
      const oldest = this.history.keys().next().value;
      if (oldest !== undefined) this.history.delete(oldest);
    }
  }

  undo(operationId: string): void {
    // The review stack permits only its most recent operation. Missing IDs
    // are normal after discard/reset and must not resurrect old membership.
    if ([...this.history.keys()].at(-1) !== operationId) return;
    const before = this.history.get(operationId);
    if (!before) return;
    this.members = cloneState(before);
    this.history.delete(operationId);
  }

  reset(): void {
    this.members.clear();
    this.history.clear();
  }

  discard(ids: string[]): void {
    const affectedIds = new Set(ids);
    detach(this.members, affectedIds);
    // A refreshed decision cannot prove a failed linked save completed. If
    // its sample is affected, conservatively release that sample's group.
    for (const id of affectedIds) this.members.delete(id);
    this.history.clear();
  }
}
