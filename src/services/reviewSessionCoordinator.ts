import type {
  EngineOriginalReview,
  EnginePreparedReview,
  EngineReviewSegment,
  EngineReviewSegmentV2,
  EngineSavedReviewV2,
  LocalEngineAdapter,
} from '../components/localEngineAdapter';
import { validatePreparedReviewResponse } from '../components/localEngineAdapter';
import { normalizePdfRect, type ReviewSegment, type PdfRect } from '../domain/cropReview';
import type { OriginalReviewContext } from '../domain/reviewContext';
import { normalizeSourcePath } from '../domain/sourcePreview';
import type { ReviewDecision, ReviewDecisionSnapshot } from '../domain/reviewOperations';

export type ReviewSession = {
  original: OriginalReviewContext;
  prepared: EnginePreparedReview;
};

export type ReviewSessionScheduler = {
  run<T>(operation: () => Promise<T>, isCurrent: () => boolean): Promise<T>;
};

export class StaleReviewSessionError extends Error {
  constructor(message = '审核会话已过期。') {
    super(message);
    this.name = 'StaleReviewSessionError';
  }
}

type ReviewAdapter = Pick<LocalEngineAdapter, 'prepareReviewContext' | 'saveReviewSegmentsV2'>
  & Partial<Pick<LocalEngineAdapter, 'readReviewSnapshot'>>;

type SessionState = {
  contextKey: string;
  resultRevision: string;
  recordRevisions: Map<string, number>;
  recordTaskIds: Map<string, string>;
  decisions: Map<string, ReviewDecision> | null;
  defaults: Map<string, ReviewDecision> | null;
};

const sessionStates = new WeakMap<ReviewSession, SessionState>();

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

const directScheduler: ReviewSessionScheduler = {
  async run<T>(operation: () => Promise<T>, isCurrent: () => boolean): Promise<T> {
    if (!isCurrent()) throw new StaleReviewSessionError();
    return operation();
  },
};

const reviewStatusValues = new Set<EngineReviewSegment['review_status']>([
  'pending', 'needs_review', 'confirmed', 'page_confirmed', 'group_confirmed', 'blocked',
]);
const cropModeValues = new Set<EngineReviewSegment['crop_mode']>(['candidate', 'manual', 'full_page']);

function stale(): never {
  throw new StaleReviewSessionError();
}

function assertCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) stale();
}

function logicalKey(item: Pick<EngineOriginalReview, 'source_key' | 'source_page' | 'segment_no'>): string {
  return JSON.stringify([item.source_key, item.source_page, item.segment_no]);
}

function validTaskId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 && !value.includes('\0');
}

function decision(segment: ReviewSegment): ReviewDecision {
  return { id: segment.id, finalRect: cloneRect(segment.finalRect), mode: segment.mode,
    manualAdjusted: segment.manualAdjusted, reviewStatus: segment.reviewStatus };
}

function recordDecision(record: EngineReviewSegmentV2): ReviewDecision {
  return { id: record.id, finalRect: cloneRect(record.final_rect), mode: record.crop_mode,
    manualAdjusted: record.manual_adjusted,
    reviewStatus: record.review_status === 'page_confirmed' || record.review_status === 'group_confirmed'
      ? 'confirmed' : record.review_status };
}

function sameDecision(left: ReviewDecision, right: ReviewDecision): boolean {
  return left.id === right.id && sameRect(left.finalRect, right.finalRect) && left.mode === right.mode
    && left.manualAdjusted === right.manualAdjusted && left.reviewStatus === right.reviewStatus;
}

function cloneRect(rect: PdfRect | null): PdfRect | null {
  if (rect === null) return null;
  if (!rect || typeof rect !== 'object') throw new Error('审核裁剪区域无效，不能保存。');
  return { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 };
}

function sameRect(left: PdfRect | null, right: PdfRect | null): boolean {
  if (left === null || right === null) return left === right;
  return left.x0 === right.x0 && left.y0 === right.y0
    && left.x1 === right.x1 && left.y1 === right.y1;
}

function copyReviewSegments(segments: ReviewSegment[]): ReviewSegment[] {
  if (!Array.isArray(segments)) throw new Error('审核片段必须是数组。');
  try {
    return structuredClone(segments);
  } catch {
    throw new Error('审核片段无法复制，不能保存。');
  }
}

function buildRevisionMap(
  prepared: EnginePreparedReview,
  originals: EngineOriginalReview[],
): { recordRevisions: Map<string, number>; recordTaskIds: Map<string, string> } {
  const originalKeys = new Set(originals.map(logicalKey));
  const revisions = new Map<string, number>();
  const taskIds = new Map<string, string>();
  const segmentTaskIds = new Map<string, string>();
  for (const segment of prepared.segments) {
    const key = logicalKey(segment);
    if (!originalKeys.has(key) || !validTaskId(segment.task_id)) {
      throw new Error('审核准备结果中的任务标识不一致。');
    }
    const previous = segmentTaskIds.get(key);
    if (previous !== undefined && previous !== segment.task_id) {
      throw new Error('审核准备结果中的任务标识不一致。');
    }
    segmentTaskIds.set(key, segment.task_id);
  }
  for (const item of prepared.record_revisions) {
    const key = logicalKey(item);
    if (!originalKeys.has(key) || revisions.has(key) || !Number.isSafeInteger(item.record_revision) || item.record_revision < 0) {
      throw new Error('审核准备结果中的记录修订不一致。');
    }
    if (item.record_revision === 0) {
      if (item.task_id !== undefined && item.task_id !== null) {
        throw new Error('审核准备结果中的任务标识不一致。');
      }
    } else {
      let taskId: string | undefined;
      if (item.task_id !== undefined) {
        if (!validTaskId(item.task_id)) throw new Error('审核准备结果中的任务标识不一致。');
        taskId = item.task_id;
      }
      const segmentTaskId = segmentTaskIds.get(key);
      if (taskId !== undefined && segmentTaskId !== undefined && taskId !== segmentTaskId) {
        throw new Error('审核准备结果中的任务标识不一致。');
      }
      taskId ??= segmentTaskId;
      if (taskId !== undefined) taskIds.set(key, taskId);
    }
    revisions.set(key, item.record_revision);
  }
  if (revisions.size !== originals.length) throw new Error('审核准备结果缺少记录修订。');
  return { recordRevisions: revisions, recordTaskIds: taskIds };
}

function validDecisionRect(
  rect: PdfRect | null,
  mode: ReviewSegment['mode'],
  status: EngineReviewSegment['review_status'],
  width: number,
  height: number,
): boolean {
  if (rect === null) {
    return mode === 'full_page'
      || !['confirmed', 'page_confirmed', 'group_confirmed'].includes(status);
  }
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return false;
  try {
    return sameRect(normalizePdfRect(rect, width, height), rect);
  } catch {
    return false;
  }
}

export class ReviewSessionCoordinator {
  private readonly adapter: ReviewAdapter;
  private readonly scheduler: ReviewSessionScheduler;
  private readonly currentSessions = new Map<string, ReviewSession>();
  private readonly currentResultRevisions = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();

  /** A cleanup caller first disables editing, then awaits already queued writes. */
  async drain(): Promise<void> {
    await this.tail;
  }

  constructor(adapter: ReviewAdapter, scheduler: ReviewSessionScheduler = directScheduler) {
    this.adapter = adapter;
    this.scheduler = scheduler;
  }

  prepare(original: OriginalReviewContext, isCurrent: () => boolean): Promise<ReviewSession> {
    let captured: OriginalReviewContext;
    try {
      captured = freezeTree(structuredClone(original));
    } catch {
      return Promise.reject(new Error('审核上下文无法复制，不能准备审核会话。'));
    }
    return this.enqueue(() => this.executePrepare(captured, isCurrent));
  }

  adoptPrepared(original: OriginalReviewContext, response: EnginePreparedReview, isCurrent: () => boolean): Promise<ReviewSession> {
    let captured: OriginalReviewContext;
    let prepared: EnginePreparedReview;
    try {
      captured = freezeTree(structuredClone(original));
      prepared = freezeTree(structuredClone(response));
    } catch {
      return Promise.reject(new Error('审核上下文无法复制，不能准备审核会话。'));
    }
    return this.enqueue(async () => {
      await validatePreparedReviewResponse(prepared, captured.context, captured.originals, captured.resultRevision);
      // The server has already bound this response. Even a late UI response
      // must invalidate the previous session before the current-view guard.
      return this.bindPrepared(captured, prepared, isCurrent);
    });
  }

  /** The server-side prepare must share the save queue, not just its response. */
  prepareTrusted(
    factory: () => Promise<{ original: OriginalReviewContext; prepared: EnginePreparedReview }>,
    isCurrent: () => boolean,
  ): Promise<ReviewSession> {
    return this.enqueue(async () => {
      assertCurrent(isCurrent);
      const result = await factory();
      const original = freezeTree(structuredClone(result.original));
      const prepared = freezeTree(structuredClone(result.prepared));
      await validatePreparedReviewResponse(prepared, original.context, original.originals, original.resultRevision);
      return this.bindPrepared(original, prepared, isCurrent);
    });
  }

  save(
    session: ReviewSession,
    taskId: string,
    segments: ReviewSegment[],
    status: EngineReviewSegment['review_status'],
    isCurrent: () => boolean,
  ): Promise<EngineSavedReviewV2> {
    let decisions: ReviewSegment[];
    try {
      decisions = copyReviewSegments(segments);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    return this.enqueue(() => this.executeSave(session, taskId, decisions, status, isCurrent));
  }

  /** Seed once from the committed analysis/compatible merge, never from gesture state. */
  initializeDecisions(session: ReviewSession, segments: ReviewSegment[], defaults = segments): void {
    const state = this.currentState(session);
    if (state.decisions) throw new Error('审核保存基线已初始化，不能用临时修改覆盖。');
    const originalById = new Map(session.original.originals.map((item) => [item.id, item]));
    const collect = (items: ReviewSegment[]): Map<string, ReviewDecision> => {
      if (items.length !== originalById.size) throw new Error('审核保存基线与完整结果不一致。');
      const values = new Map<string, ReviewDecision>();
      for (const item of items) {
        const original = originalById.get(item.id);
        if (!original || values.has(item.id) || !reviewStatusValues.has(item.reviewStatus)
          || !cropModeValues.has(item.mode) || typeof item.manualAdjusted !== 'boolean'
          || !validDecisionRect(item.finalRect, item.mode, item.reviewStatus, original.page_width, original.page_height)) {
          throw new Error('审核保存基线无效。');
        }
        values.set(item.id, decision(item));
      }
      return values;
    };
    const capturedDefaults = collect(defaults);
    const captured = collect(segments);
    // Compatible persisted records, when present, are authoritative.
    for (const record of session.prepared.segments) captured.set(record.id, recordDecision(record));
    state.defaults = capturedDefaults;
    state.decisions = captured;
  }

  decisionSnapshots(session: ReviewSession, ids: string[]): ReviewDecisionSnapshot[] {
    const state = this.currentState(session);
    if (!state.decisions || new Set(ids).size !== ids.length) throw new Error('审核保存基线不可用。');
    const originals = new Map(session.original.originals.map((item) => [item.id, item]));
    return ids.map((id) => {
      const saved = state.decisions!.get(id);
      const original = originals.get(id);
      const revision = original ? state.recordRevisions.get(logicalKey(original)) : undefined;
      if (!saved || revision === undefined) throw new Error('审核保存基线缺少片段。');
      return { decision: structuredClone(saved), recordRevision: revision };
    });
  }

  saveStrict(
    session: ReviewSession,
    taskId: string,
    segments: ReviewSegment[],
    expected: ReviewDecisionSnapshot[],
    isCurrent: () => boolean,
    confirmGroup = false,
  ): Promise<EngineSavedReviewV2> {
    let captured: ReviewSegment[];
    let expectations: ReviewDecisionSnapshot[];
    try {
      captured = copyReviewSegments(segments);
      expectations = structuredClone(expected);
    } catch (error) { return Promise.reject(error); }
    return this.enqueue(() => this.executeSave(session, taskId, captured,
      confirmGroup ? 'group_confirmed' : null, isCurrent, expectations));
  }

  /** Read and adopt current decisions without rebinding the database manifest. */
  refreshDecisions(session: ReviewSession, isCurrent: () => boolean): Promise<EnginePreparedReview> {
    return this.enqueue(async () => {
      assertCurrent(isCurrent);
      const state = this.currentState(session);
      if (!state.defaults || !this.adapter.readReviewSnapshot) throw new Error('当前引擎不支持重新读取审核记录。');
      const guard = () => isCurrent() && this.isCurrentSession(session, state);
      const response = await this.scheduler.run(async () => {
        assertCurrent(guard);
        return this.adapter.readReviewSnapshot!(session.original.context, session.original.originals, state.resultRevision);
      }, guard);
      await validatePreparedReviewResponse(response, session.original.context, session.original.originals, state.resultRevision);
      assertCurrent(guard);
      const metadata = buildRevisionMap(response, session.original.originals);
      const next = new Map([...state.defaults].map(([id, value]) => [id, structuredClone(value)]));
      for (const record of response.segments) next.set(record.id, recordDecision(record));
      state.recordRevisions = metadata.recordRevisions;
      state.recordTaskIds = metadata.recordTaskIds;
      state.decisions = next;
      return structuredClone(response);
    });
  }

  private currentState(session: ReviewSession): SessionState {
    const state = sessionStates.get(session);
    if (!state || !this.isCurrentSession(session, state)) stale();
    return state;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async executePrepare(original: OriginalReviewContext, isCurrent: () => boolean): Promise<ReviewSession> {
    assertCurrent(isCurrent);
    let adapterStarted = false;
    let preparedResponse: EnginePreparedReview;
    try {
      preparedResponse = await this.scheduler.run(
        async () => {
          assertCurrent(isCurrent);
          adapterStarted = true;
          return this.adapter.prepareReviewContext(original.context, original.originals, original.resultRevision);
        },
        isCurrent,
      );
    } catch (error: unknown) {
      // EngineProcessSemaphore reports its own stale error while a task is
      // waiting. Keep the coordinator's public stale error stable.
      if (!adapterStarted && !isCurrent()) stale();
      throw error;
    }
    return this.bindPrepared(original, preparedResponse, isCurrent);
  }

  private bindPrepared(original: OriginalReviewContext, preparedResponse: EnginePreparedReview, isCurrent: () => boolean): ReviewSession {
    if (preparedResponse.result_revision !== original.resultRevision) throw new Error('审核结果修订与当前分析不一致。');
    // Keep adapter-owned objects out of the mutable public session while also
    // ensuring the original manifest and prepared response cannot be edited
    // into a different revision after they enter the session.
    const prepared: EnginePreparedReview = freezeTree(structuredClone(preparedResponse));

    const state: SessionState = {
      contextKey: prepared.context_key,
      resultRevision: prepared.result_revision,
      ...buildRevisionMap(prepared, original.originals),
      decisions: null,
      defaults: null,
    };
    const session: ReviewSession = Object.freeze({ original, prepared });
    // Binding is recorded before the final UI guard. A late response still
    // represents the revision the server has actually bound.
    sessionStates.set(session, state);
    // Only one review workbench session is active at a time. Clearing old
    // context entries bounds retained manifests and invalidates old sessions.
    this.currentSessions.clear();
    this.currentResultRevisions.clear();
    this.currentSessions.set(state.contextKey, session);
    this.currentResultRevisions.set(state.contextKey, state.resultRevision);
    if (!isCurrent()) stale();
    return session;
  }

  private async executeSave(
    session: ReviewSession,
    taskId: string,
    decisions: ReviewSegment[],
    status: EngineReviewSegment['review_status'] | null,
    isCurrent: () => boolean,
    expected?: ReviewDecisionSnapshot[],
  ): Promise<EngineSavedReviewV2> {
    assertCurrent(isCurrent);
    const state = sessionStates.get(session);
    if (!state || !this.isCurrentSession(session, state)) stale();
    if (!validTaskId(taskId)) {
      throw new Error('审核任务标识不能为空。');
    }
    if (status !== null && !reviewStatusValues.has(status)) throw new Error('审核状态无效，不能保存。');

    let sentRecords: EngineReviewSegmentV2[] | undefined;
    let adapterStarted = false;
    const guard = (): boolean => isCurrent() && this.isCurrentSession(session, state);
    let response: EngineSavedReviewV2;
    try {
      response = await this.scheduler.run(
        async () => {
          assertCurrent(guard);
          if (expected) this.assertExpected(session, decisions, expected);
          sentRecords = this.buildSaveRecords(session, state, taskId, decisions, status);
          adapterStarted = true;
          return this.adapter.saveReviewSegmentsV2(
            state.contextKey,
            state.resultRevision,
            sentRecords,
            status === 'group_confirmed',
          );
        },
        guard,
      );
    } catch (error: unknown) {
      if (!adapterStarted && !guard()) stale();
      throw error;
    }

    if (!sentRecords) throw new Error('审核保存未生成记录。');
    this.updateSuccessfulSave(state, sentRecords, response);
    // Store the actual response revision before notifying the caller that its
    // UI run is stale. The next queued save therefore uses the new CAS value.
    if (!isCurrent() || !this.isCurrentSession(session, state)) stale();
    return response;
  }

  private isCurrentSession(session: ReviewSession, state: SessionState): boolean {
    return this.currentSessions.get(state.contextKey) === session
      && this.currentResultRevisions.get(state.contextKey) === state.resultRevision;
  }

  private assertExpected(session: ReviewSession, segments: ReviewSegment[], expected: ReviewDecisionSnapshot[]): void {
    if (!Array.isArray(expected) || expected.length !== segments.length || expected.length === 0
      || expected.some((item) => !item?.decision || !Number.isSafeInteger(item.recordRevision) || item.recordRevision < 0)
      || new Set(expected.map((item) => item.decision.id)).size !== expected.length) {
      throw new Error('审核预期修订清单无效。');
    }
    const byId = new Map(expected.map((item) => [item.decision.id, item]));
    const current = this.decisionSnapshots(session, segments.map((item) => item.id));
    for (const saved of current) {
      const required = byId.get(saved.decision.id);
      if (!required || required.recordRevision !== saved.recordRevision || !sameDecision(required.decision, saved.decision)) {
        throw new Error('审核记录已变化，不能覆盖旧版本；请放弃修改并重新读取当前记录。');
      }
    }
  }

  private buildSaveRecords(
    session: ReviewSession,
    state: SessionState,
    taskId: string,
    decisions: ReviewSegment[],
    status: EngineReviewSegment['review_status'] | null,
  ): EngineReviewSegmentV2[] {
    const sourceByKey = new Map(session.original.context.sources.map((source) => [source.source_key, source]));
    const originalById = new Map(session.original.originals.map((item) => [item.id, item]));
    const seenKeys = new Set<string>();
    const seenIds = new Set<string>();
    const reviewedAt = new Date().toISOString();
    const records: EngineReviewSegmentV2[] = [];

    for (const segment of decisions) {
      if (!segment || typeof segment !== 'object' || typeof segment.id !== 'string' || seenIds.has(segment.id)) {
        throw new Error('审核片段缺失或重复，不能保存。');
      }
      const original = originalById.get(segment.id);
      const recordStatus = status ?? (segment.reviewStatus === 'confirmed' ? 'page_confirmed' : segment.reviewStatus);
      const source = original ? sourceByKey.get(original.source_key) : undefined;
      if (!original || !source || seenIds.has(original.id) || !original.persistable
        || typeof segment.sourcePath !== 'string' || typeof segment.sourceSha256 !== 'string'
        || normalizeSourcePath(segment.sourcePath) !== normalizeSourcePath(source.source_path)
        || segment.sourceSha256.toLowerCase() !== source.source_sha256.toLowerCase()) {
        throw new Error('审核片段与本轮原始分析不一致，不能保存。');
      }
      if (!Number.isSafeInteger(segment.sourcePage) || !Number.isSafeInteger(segment.segmentNo)
        || segment.sourcePage !== original.source_page || segment.segmentNo !== original.segment_no
        || typeof segment.manualAdjusted !== 'boolean' || !cropModeValues.has(segment.mode)
        || !reviewStatusValues.has(recordStatus)
        || !validDecisionRect(segment.finalRect, segment.mode, recordStatus, original.page_width, original.page_height)) {
        throw new Error('审核裁剪决定无效，不能保存。');
      }
      const key = logicalKey(original);
      if (seenKeys.has(key)) throw new Error('审核片段缺失或重复，不能保存。');
      const recordRevision = state.recordRevisions.get(key);
      if (recordRevision === undefined || !Number.isSafeInteger(recordRevision) || recordRevision < 0) {
        throw new Error('审核记录修订不可用，不能保存。');
      }
      const recordTaskId = recordRevision > 0 ? state.recordTaskIds.get(key) : taskId;
      if (!recordTaskId) {
        throw new Error('已有审核记录所属任务未知，不能保存。');
      }
      seenKeys.add(key);
      seenIds.add(segment.id);
      if (original.match_rect === null) throw new Error('原始命中区域无效，不能保存。');
      const sourceSha256 = source.source_sha256.toLowerCase();
      records.push({
        id: original.id,
        task_id: recordTaskId,
        source_path: segment.sourcePath,
        source_sha256: sourceSha256,
        source_page: original.source_page,
        segment_no: original.segment_no,
        match_rect: cloneRect(original.match_rect) as EngineReviewSegmentV2['match_rect'],
        candidate_rect: cloneRect(original.candidate_rect),
        final_rect: cloneRect(segment.finalRect),
        layout_fingerprint: original.layout_fingerprint,
        confidence: original.confidence,
        crop_mode: segment.mode,
        review_status: recordStatus,
        manual_adjusted: segment.manualAdjusted,
        reviewed_at: reviewedAt,
        context_key: state.contextKey,
        source_key: source.source_key,
        analysis_signature: original.analysis_signature,
        result_revision: state.resultRevision,
        record_revision: recordRevision,
        page_width: original.page_width,
        page_height: original.page_height,
      });
    }

    if (records.length === 0) throw new Error('没有可保存的审核片段。');
    if (status === 'group_confirmed') {
      if (records.length !== session.original.originals.length
        || session.original.originals.some((item) => !item.persistable)) {
        throw new Error('整组确认必须覆盖本轮全部可保存片段。');
      }
      const originalKeys = new Set(session.original.originals.map(logicalKey));
      if (seenKeys.size !== originalKeys.size || [...originalKeys].some((key) => !seenKeys.has(key))) {
        throw new Error('整组确认必须覆盖本轮全部可保存片段。');
      }
    }
    return records;
  }

  private updateSuccessfulSave(
    state: SessionState,
    sentRecords: EngineReviewSegmentV2[],
    response: EngineSavedReviewV2,
  ): void {
    if (!response || response.status !== 'ok' || response.context_key !== state.contextKey
      || response.result_revision !== state.resultRevision || response.saved_count !== sentRecords.length
      || !Array.isArray(response.segments) || response.segments.length !== sentRecords.length) {
      throw new Error('审核保存结果或记录修订不一致。');
    }
    const sentByKey = new Map(sentRecords.map((record) => [logicalKey(record), record]));
    const next = new Map<string, number>();
    const nextTaskIds = new Map<string, string>();
    for (const record of response.segments) {
      const key = logicalKey(record);
      const sent = sentByKey.get(key);
      if (!sent || next.has(key) || record.context_key !== state.contextKey
        || record.result_revision !== state.resultRevision || record.record_revision !== sent.record_revision + 1
        || record.id !== sent.id || record.source_key !== sent.source_key || record.source_page !== sent.source_page
        || record.segment_no !== sent.segment_no || !sameRect(record.match_rect, sent.match_rect)
        || !sameRect(record.candidate_rect, sent.candidate_rect) || !sameRect(record.final_rect, sent.final_rect)
        || record.crop_mode !== sent.crop_mode || record.review_status !== sent.review_status
        || record.manual_adjusted !== sent.manual_adjusted || record.task_id !== sent.task_id) {
        throw new Error('审核保存结果或记录修订不一致。');
      }
      next.set(key, record.record_revision);
      nextTaskIds.set(key, record.task_id);
    }
    if (next.size !== sentByKey.size) throw new Error('审核保存结果缺少记录。');
    for (const [key, revision] of next) {
      state.recordRevisions.set(key, revision);
      state.recordTaskIds.set(key, nextTaskIds.get(key)!);
    }
    if (state.decisions) {
      for (const record of response.segments) state.decisions.set(record.id, recordDecision(record));
    }
    this.currentResultRevisions.set(state.contextKey, response.result_revision);
  }
}
