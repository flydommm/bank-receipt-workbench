import type { CropMode, PdfRect, ReviewSegment, ReviewStatus } from './cropReview';

/** The user-owned part of a review segment that can be restored by undo. */
export type ReviewDecision = Pick<
  ReviewSegment,
  'id' | 'finalRect' | 'mode' | 'manualAdjusted' | 'reviewStatus'
>;

export type ReviewDecisionSnapshot = {
  decision: ReviewDecision;
  recordRevision: number;
};

export type ReviewOperationKind =
  | 'batch_crop'
  | 'crop'
  | 'keep_full_page'
  | 'restore_candidate'
  | 'confirm_fragment'
  | 'confirm_group'
  | 'confirm_scope'
  | 'restore_legacy';

export type ReviewOperationScope = {
  taskId: string;
  contextKey: string;
  resultRevision: string;
  sourceFingerprint: string;
};

export type ReviewOperation = {
  id: string;
  kind: ReviewOperationKind;
  before: ReviewDecisionSnapshot[];
  after: ReviewDecisionSnapshot[];
};

export const MAX_REVIEW_OPERATION_HISTORY = 20;

const operationKinds = new Set<ReviewOperationKind>([
  'batch_crop',
  'crop',
  'keep_full_page',
  'restore_candidate',
  'confirm_fragment',
  'confirm_group',
  'confirm_scope',
  'restore_legacy',
]);

let nextActionSequence = 0;

function fail(message: string): never {
  throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedReviewStatus(value: unknown): ReviewStatus {
  if (value === 'page_confirmed' || value === 'group_confirmed') return 'confirmed';
  if (value === 'pending' || value === 'needs_review' || value === 'confirmed' || value === 'blocked') {
    return value;
  }
  return fail('审核决定状态无效。');
}

function normalizedCropMode(value: unknown): CropMode {
  if (value === 'candidate' || value === 'manual' || value === 'full_page') return value;
  return fail('审核裁剪模式无效。');
}

function cloneRect(value: unknown): PdfRect | null {
  if (value === null) return null;
  if (!isObject(value)) return fail('审核裁剪区域无效。');
  return {
    x0: value.x0 as number,
    y0: value.y0 as number,
    x1: value.x1 as number,
    y1: value.y1 as number,
  };
}

function cloneDecision(value: unknown): ReviewDecision {
  if (!isObject(value) || typeof value.id !== 'string' || value.id.trim().length === 0
    || typeof value.manualAdjusted !== 'boolean') {
    return fail('审核决定无效。');
  }
  return {
    id: value.id,
    finalRect: cloneRect(value.finalRect),
    mode: normalizedCropMode(value.mode),
    manualAdjusted: value.manualAdjusted,
    reviewStatus: normalizedReviewStatus(value.reviewStatus),
  };
}

function isRecordRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function cloneSnapshot(value: unknown): ReviewDecisionSnapshot {
  if (!isObject(value) || !isRecordRevision(value.recordRevision)) {
    return fail('审核记录修订无效。');
  }
  return {
    decision: cloneDecision(value.decision),
    recordRevision: value.recordRevision,
  };
}

function cloneScope(value: ReviewOperationScope): ReviewOperationScope {
  return {
    taskId: value.taskId,
    contextKey: value.contextKey,
    resultRevision: value.resultRevision,
    sourceFingerprint: value.sourceFingerprint,
  };
}

function cloneSnapshotList(value: readonly ReviewDecisionSnapshot[], message: string): ReviewDecisionSnapshot[] {
  if (!Array.isArray(value) || value.length === 0) return fail(message);
  return value.map((item) => cloneSnapshot(item));
}

function indexSnapshots(
  snapshots: readonly ReviewDecisionSnapshot[],
  message: string,
): Map<string, ReviewDecisionSnapshot> {
  const indexed = new Map<string, ReviewDecisionSnapshot>();
  for (const snapshot of snapshots) {
    if (indexed.has(snapshot.decision.id)) return fail(message);
    indexed.set(snapshot.decision.id, snapshot);
  }
  return indexed;
}

function sameRect(left: PdfRect | null, right: PdfRect | null): boolean {
  if (left === null || right === null) return left === right;
  return left.x0 === right.x0 && left.y0 === right.y0
    && left.x1 === right.x1 && left.y1 === right.y1;
}

/**
 * Copy only the mutable decision fields from a segment. Page/group-specific
 * statuses are represented by the single persisted semantic `confirmed` state.
 */
export function decisionFromSegment(segment: ReviewSegment): ReviewDecision {
  return cloneDecision({
    id: segment.id,
    finalRect: segment.finalRect,
    mode: segment.mode,
    manualAdjusted: segment.manualAdjusted,
    reviewStatus: segment.reviewStatus,
  });
}

/** Compare persisted review semantics; revision numbers and derived UI state are ignored. */
export function sameReviewDecision(left: ReviewDecision, right: ReviewDecision): boolean {
  return left.id === right.id
    && sameRect(left.finalRect, right.finalRect)
    && left.mode === right.mode
    && left.manualAdjusted === right.manualAdjusted
    && normalizedReviewStatus(left.reviewStatus) === normalizedReviewStatus(right.reviewStatus);
}

function cloneOperation(operation: ReviewOperation): ReviewOperation {
  return {
    id: operation.id,
    kind: operation.kind,
    before: operation.before.map((item) => ({
      decision: cloneDecision(item.decision),
      recordRevision: item.recordRevision,
    })),
    after: operation.after.map((item) => ({
      decision: cloneDecision(item.decision),
      recordRevision: item.recordRevision,
    })),
  };
}

function createActionId(): string {
  nextActionSequence += 1;
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `review-operation-${nextActionSequence}-${crypto.randomUUID()}`;
    }
  } catch {
    // A monotonic fallback still keeps IDs unique in this process.
  }
  return `review-operation-${nextActionSequence}`;
}

export class ReviewOperationHistory {
  private operations: ReviewOperation[] = [];

  private currentScope: ReviewOperationScope | null = null;

  private currentEpoch = 0;

  constructor(scope?: ReviewOperationScope | null) {
    if (scope !== undefined) this.reset(scope);
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  get size(): number {
    return this.operations.length;
  }

  get scope(): ReviewOperationScope | null {
    return this.currentScope ? cloneScope(this.currentScope) : null;
  }

  reset(scope: ReviewOperationScope | null): void {
    this.currentScope = scope === null ? null : cloneScope(scope);
    this.operations = [];
    this.currentEpoch += 1;
  }

  peek(): ReviewOperation | null {
    const operation = this.operations.at(-1);
    return operation ? cloneOperation(operation) : null;
  }

  record(
    kind: ReviewOperationKind,
    beforeInput: readonly ReviewDecisionSnapshot[],
    afterInput: readonly ReviewDecisionSnapshot[],
  ): string {
    if (this.currentScope === null) return fail('审核操作历史没有有效作用域。');
    if (!operationKinds.has(kind)) return fail('审核操作类型无效。');

    const before = cloneSnapshotList(beforeInput, '审核操作不能是空操作。');
    const after = cloneSnapshotList(afterInput, '审核操作不能是空操作。');
    const beforeById = indexSnapshots(before, '审核操作包含重复片段。');
    const afterById = indexSnapshots(after, '审核操作包含重复片段。');
    if (beforeById.size !== afterById.size || [...beforeById.keys()].some((id) => !afterById.has(id))) {
      return fail('审核操作的前后片段集合不一致。');
    }
    for (const [id, beforeSnapshot] of beforeById) {
      const afterSnapshot = afterById.get(id)!;
      if (beforeSnapshot.recordRevision === Number.MAX_SAFE_INTEGER
        || afterSnapshot.recordRevision !== beforeSnapshot.recordRevision + 1) {
        return fail('审核操作的记录修订必须连续递增。');
      }
    }

    const operation: ReviewOperation = { id: createActionId(), kind, before, after };
    this.operations.push(operation);
    if (this.operations.length > MAX_REVIEW_OPERATION_HISTORY) this.operations.shift();
    return operation.id;
  }

  completeUndo(operationId: string, restoredInput: readonly ReviewDecisionSnapshot[]): void {
    const operation = this.operations.at(-1);
    if (!operation) return fail('审核操作历史为空。');
    if (operation.id !== operationId) return fail('只能撤销最近一次审核操作。');

    const restored = cloneSnapshotList(restoredInput, '撤销恢复不能为空。');
    const beforeById = indexSnapshots(operation.before, '审核操作前状态包含重复片段。');
    const afterById = indexSnapshots(operation.after, '审核操作后状态包含重复片段。');
    const restoredById = indexSnapshots(restored, '撤销恢复包含重复片段。');
    if (restoredById.size !== beforeById.size || [...beforeById.keys()].some((id) => !restoredById.has(id))) {
      return fail('撤销恢复的片段集合不一致。');
    }

    for (const [id, beforeSnapshot] of beforeById) {
      const afterSnapshot = afterById.get(id)!;
      const restoredSnapshot = restoredById.get(id)!;
      if (!sameReviewDecision(restoredSnapshot.decision, beforeSnapshot.decision)) {
        return fail('撤销恢复的审核决定与前状态不一致。');
      }
      if (afterSnapshot.recordRevision === Number.MAX_SAFE_INTEGER
        || restoredSnapshot.recordRevision !== afterSnapshot.recordRevision + 1) {
        return fail('撤销恢复的记录修订不符合预期。');
      }
    }

    // All validation is complete before the stack or any prior operation is mutated.
    this.operations.pop();
    for (const restoredSnapshot of restored) {
      const id = restoredSnapshot.decision.id;
      const beforeSnapshot = beforeById.get(id)!;
      let predecessor: ReviewOperation | undefined;
      let predecessorAfter: ReviewDecisionSnapshot | undefined;
      for (let index = this.operations.length - 1; index >= 0; index -= 1) {
        const candidate = this.operations[index]!;
        const candidateAfter = candidate.after.find((item) => item.decision.id === id);
        if (candidateAfter) {
          predecessor = candidate;
          predecessorAfter = candidateAfter;
          break;
        }
      }
      if (predecessor && predecessorAfter
        && sameReviewDecision(predecessorAfter.decision, restoredSnapshot.decision)
        && predecessorAfter.recordRevision === beforeSnapshot.recordRevision) {
        predecessorAfter.recordRevision = restoredSnapshot.recordRevision;
      }
    }
  }
}
