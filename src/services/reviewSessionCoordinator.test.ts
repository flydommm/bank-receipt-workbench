// @vitest-environment jsdom
// @ts-expect-error The test runtime exposes Node crypto without @types/node.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EngineOriginalReview,
  EnginePreparedReview,
  EngineReviewContext,
  EngineReviewSegmentV2,
  EngineSavedReviewV2,
  LocalEngineAdapter,
} from '../components/localEngineAdapter';
import type { ReviewSegment } from '../domain/cropReview';
import type { OriginalReviewContext } from '../domain/reviewContext';
import { ReviewSessionCoordinator, StaleReviewSessionError } from './reviewSessionCoordinator';
import type { ReviewDecisionSnapshot } from '../domain/reviewOperations';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const sourceSha = 'a'.repeat(64);
const signature = 'b'.repeat(64);
const contextKey = 'c'.repeat(64);
const sourceKey = 'd:/docs/a.pdf';

const context: EngineReviewContext = {
  version: 2,
  sources: [{ source_key: sourceKey, source_path: 'D:\\docs\\A.pdf', source_sha256: sourceSha }],
  criteria_fingerprint: 'e'.repeat(64),
  computation_version: 'm2-test',
};

const original: EngineOriginalReview = {
  id: 'segment-1', source_key: sourceKey, source_page: 1, segment_no: 1,
  analysis_signature: signature, persistable: true, page_width: 600, page_height: 800,
  match_rect: { x0: 10, y0: 20, x1: 80, y1: 30 },
  candidate_rect: { x0: 0, y0: 0, x1: 600, y1: 200 },
  layout_fingerprint: 'geometry:600:800', confidence: 0.96, auto_full_page: false,
};

const currentSegment: ReviewSegment = {
  id: original.id, sourcePath: 'D:\\docs\\A.pdf', sourceSha256: sourceSha,
  sourcePage: 1, segmentNo: 1, matchRect: { ...original.match_rect! },
  candidateRect: { ...original.candidate_rect! }, finalRect: { x0: 0, y0: 2, x1: 600, y1: 198 },
  pageWidth: 600, pageHeight: 800, confidence: 0.96, slot: 'top',
  layoutFingerprint: original.layout_fingerprint, mode: 'manual', reviewStatus: 'confirmed', manualAdjusted: true,
};

function originalContext(resultRevision = 'result-1', contextValue: EngineReviewContext = context): OriginalReviewContext {
  return { context: contextValue, originals: [original], resultRevision };
}

function prepared(resultRevision = 'result-1', recordRevision = 0, preparedContextKey = contextKey): EnginePreparedReview {
  const record = recordRevision > 0 ? {
    id: original.id, task_id: 'task-1', source_path: context.sources[0]!.source_path,
    source_sha256: sourceSha, source_page: original.source_page, segment_no: original.segment_no,
    match_rect: { ...original.match_rect! }, candidate_rect: { ...original.candidate_rect! },
    final_rect: { x0: 0, y0: 2, x1: 600, y1: 198 }, layout_fingerprint: original.layout_fingerprint,
    confidence: original.confidence, crop_mode: 'manual' as const, review_status: 'page_confirmed' as const,
    manual_adjusted: true, reviewed_at: '2026-09-08T00:00:00.000Z', context_key: preparedContextKey,
    source_key: sourceKey, analysis_signature: signature, result_revision: resultRevision,
    record_revision: recordRevision, page_width: 600, page_height: 800,
  } satisfies EngineReviewSegmentV2 : null;
  return {
    status: 'ok', context_key: preparedContextKey, result_revision: resultRevision,
    segments: record ? [record] : [],
    record_revisions: [{ id: original.id, source_key: sourceKey, source_page: 1, segment_no: 1, record_revision: recordRevision }],
    group_confirmed: false,
  };
}

function saved(resultRevision: string, record: EngineReviewSegmentV2, responseRevision: number): EngineSavedReviewV2 {
  return { status: 'ok', context_key: contextKey, result_revision: resultRevision, saved_count: 1,
    segments: [{ ...record, record_revision: responseRevision }] };
}

function adapterFixture() {
  return {
    prepareReviewContext: vi.fn<LocalEngineAdapter['prepareReviewContext']>(),
    saveReviewSegmentsV2: vi.fn<LocalEngineAdapter['saveReviewSegmentsV2']>(),
  } satisfies Pick<LocalEngineAdapter, 'prepareReviewContext' | 'saveReviewSegmentsV2'>;
}

describe('strict review decisions', () => {
  function snapshot(segment = currentSegment, revision = 0): ReviewDecisionSnapshot {
    return { decision: { id: segment.id, finalRect: structuredClone(segment.finalRect), mode: segment.mode,
      manualAdjusted: segment.manualAdjusted, reviewStatus: segment.reviewStatus }, recordRevision: revision };
  }

  async function setup() {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared());
    adapter.saveReviewSegmentsV2.mockImplementation(async (_key, revision, records) => ({
      status: 'ok', context_key: contextKey, result_revision: revision, saved_count: records.length,
      segments: records.map((record) => ({ ...record, record_revision: record.record_revision + 1 })),
    }));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);
    coordinator.initializeDecisions(session, [currentSegment]);
    return { adapter, coordinator, session };
  }

  it('keeps the persisted baseline separate from gesture changes and advances only after a verified reply', async () => {
    const { adapter, coordinator, session } = await setup();
    const changed = { ...currentSegment, finalRect: { x0: 0, y0: 10, x1: 600, y1: 210 } };
    const gate = deferred<EngineSavedReviewV2>();
    adapter.saveReviewSegmentsV2.mockReturnValue(gate.promise);
    const saving = coordinator.saveStrict(session, 'task-1', [changed], [snapshot()], () => true);
    await vi.waitFor(() => expect(adapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1));
    expect(coordinator.decisionSnapshots(session, [original.id])).toEqual([snapshot()]);
    const sent = adapter.saveReviewSegmentsV2.mock.calls[0]![2][0]!;
    gate.resolve(saved('result-1', sent, 1));
    await saving;
    expect(coordinator.decisionSnapshots(session, [original.id])).toEqual([snapshot(changed, 1)]);
  });

  it('rejects a stale semantic expectation or revision before IPC, without substituting a newer revision', async () => {
    const { adapter, coordinator, session } = await setup();
    await coordinator.saveStrict(session, 'task-1', [currentSegment], [snapshot()], () => true);
    await expect(coordinator.saveStrict(session, 'task-1', [currentSegment], [snapshot()], () => true)).rejects.toThrow();
    const wrong = snapshot({ ...currentSegment, mode: 'candidate' }, 1);
    await expect(coordinator.saveStrict(session, 'task-1', [currentSegment], [wrong], () => true)).rejects.toThrow();
    expect(adapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1);
  });

  it('preserves the original expected revision after an unknown commit response', async () => {
    const { adapter, coordinator, session } = await setup();
    adapter.saveReviewSegmentsV2.mockResolvedValueOnce({ status: 'ok', context_key: contextKey,
      result_revision: 'result-1', saved_count: 1, segments: [] });
    await expect(coordinator.saveStrict(session, 'task-1', [currentSegment], [snapshot()], () => true)).rejects.toThrow();
    expect(coordinator.decisionSnapshots(session, [original.id])).toEqual([snapshot()]);
    adapter.saveReviewSegmentsV2.mockRejectedValueOnce(new Error('CAS conflict after response loss'));
    await expect(coordinator.saveStrict(session, 'task-1', [currentSegment], [snapshot()], () => true)).rejects.toThrow('CAS');
    expect(adapter.saveReviewSegmentsV2.mock.calls.map((call) => call[2][0]!.record_revision)).toEqual([0, 0]);
  });

  it('allows undo to a pending null crop and normalizes confirmation states in the saved baseline', async () => {
    const { adapter, coordinator, session } = await setup();
    const pending = { ...currentSegment, mode: 'candidate' as const, finalRect: null, reviewStatus: 'pending' as const };
    await coordinator.saveStrict(session, 'task-1', [pending], [snapshot()], () => true);
    expect(adapter.saveReviewSegmentsV2.mock.calls[0]![2][0]).toMatchObject({ review_status: 'pending', final_rect: null });
    await coordinator.saveStrict(session, 'task-1', [currentSegment], [snapshot(pending, 1)], () => true, true);
    expect(adapter.saveReviewSegmentsV2.mock.calls[1]![3]).toBe(true);
    expect(coordinator.decisionSnapshots(session, [original.id])).toEqual([snapshot(currentSegment, 2)]);
  });

  it('rejects duplicate expectations and cannot reinitialize the baseline from unsaved UI', async () => {
    const { adapter, coordinator, session } = await setup();
    await expect(coordinator.saveStrict(session, 'task-1', [currentSegment], [snapshot(), snapshot()], () => true)).rejects.toThrow();
    expect(() => coordinator.initializeDecisions(session, [{ ...currentSegment, mode: 'candidate' }])).toThrow();
    expect(adapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });
});

describe('durable review session adoption', () => {
  beforeEach(() => { vi.stubGlobal('crypto', webcrypto); });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function durableInput() {
    const aliasContext = structuredClone(context);
    aliasContext.sources[0]!.source_path = 'D:/relocated/A.pdf';
    const canonical = JSON.stringify({ computation_version: context.computation_version,
      criteria_fingerprint: context.criteria_fingerprint,
      sources: context.sources.map(({ source_key, source_sha256 }) => ({ source_key, source_sha256 })), version: 2 });
    const digest = await (webcrypto as Crypto).subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const response = prepared('durable-result', 2, key);
    response.segments[0]!.source_path = aliasContext.sources[0]!.source_path;
    return { input: originalContext('durable-result', aliasContext), response, key };
  }

  it('adopts the backend binding without a second prepare and preserves logical identity during queued saves', async () => {
    const adapter = adapterFixture();
    adapter.saveReviewSegmentsV2.mockImplementation(async (key, revision, records) => ({
      ...saved(revision, records[0]!, records[0]!.record_revision + 1), context_key: key,
    }));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const { input, response } = await durableInput();
    const session = await coordinator.adoptPrepared(input, response, () => true);
    const decision = { ...currentSegment, sourcePath: input.context.sources[0]!.source_path };
    const first = coordinator.save(session, 'batch-job', [decision], 'page_confirmed', () => true);
    const second = coordinator.save(session, 'batch-job', [decision], 'page_confirmed', () => true);
    await expect(first).resolves.toMatchObject({ segments: [{ source_key: sourceKey, record_revision: 3 }] });
    await expect(second).resolves.toMatchObject({ segments: [{ source_key: sourceKey, record_revision: 4 }] });
    expect(adapter.prepareReviewContext).not.toHaveBeenCalled();
    expect(adapter.saveReviewSegmentsV2.mock.calls.map((call) => call[2][0]!.source_path))
      .toEqual(['D:/relocated/A.pdf', 'D:/relocated/A.pdf']);
    expect(Object.isFrozen(session.original.context.sources[0])).toBe(true);
    expect(Object.isFrozen(session.prepared.segments[0])).toBe(true);
  });

  it('refreshes saved decisions without preparing again and keeps old CAS expectations conflicting', async () => {
    const adapter = { ...adapterFixture(), readReviewSnapshot: vi.fn<LocalEngineAdapter['readReviewSnapshot']>() };
    const coordinator = new ReviewSessionCoordinator(adapter);
    const { input, response } = await durableInput();
    const session = await coordinator.adoptPrepared(input, response, () => true);
    const segment = { ...currentSegment, sourcePath: input.context.sources[0]!.source_path };
    coordinator.initializeDecisions(session, [segment]);
    const before = coordinator.decisionSnapshots(session, [segment.id]);
    const changed = structuredClone(response);
    changed.record_revisions[0]!.record_revision = 3;
    changed.segments[0]!.record_revision = 3;
    adapter.readReviewSnapshot.mockResolvedValue(changed);
    await coordinator.refreshDecisions(session, () => true);
    expect(coordinator.decisionSnapshots(session, [segment.id])[0]!.recordRevision).toBe(3);
    await expect(coordinator.saveStrict(session, 'job', [segment], before, () => true)).rejects.toThrow('已变化');
    expect(adapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
    expect(adapter.prepareReviewContext).not.toHaveBeenCalled();
    expect(adapter.readReviewSnapshot).toHaveBeenCalledWith(input.context, input.originals, input.resultRevision);
  });

  it('adopts actual revisions and fresh defaults when a stored signature is incompatible', async () => {
    const adapter = { ...adapterFixture(), readReviewSnapshot: vi.fn<LocalEngineAdapter['readReviewSnapshot']>() };
    const coordinator = new ReviewSessionCoordinator(adapter);
    const { input, response } = await durableInput();
    const segment = { ...currentSegment, sourcePath: input.context.sources[0]!.source_path };
    const automatic = { ...segment, finalRect: original.candidate_rect, mode: 'candidate' as const, manualAdjusted: false };
    const session = await coordinator.adoptPrepared(input, response, () => true);
    coordinator.initializeDecisions(session, [segment], [automatic]);
    const incompatible = structuredClone(response);
    incompatible.segments = [];
    incompatible.record_revisions[0] = { ...incompatible.record_revisions[0]!, record_revision: 8, task_id: 'previous-task' };
    adapter.readReviewSnapshot.mockResolvedValue(incompatible);
    await coordinator.refreshDecisions(session, () => true);
    expect(coordinator.decisionSnapshots(session, [segment.id])).toMatchObject([{ recordRevision: 8,
      decision: { finalRect: original.candidate_rect, mode: 'candidate', manualAdjusted: false } }]);
  });

  it('does not adopt an invalid or late read response into the current saved baseline', async () => {
    const adapter = { ...adapterFixture(), readReviewSnapshot: vi.fn<LocalEngineAdapter['readReviewSnapshot']>() };
    const coordinator = new ReviewSessionCoordinator(adapter);
    const { input, response } = await durableInput();
    const session = await coordinator.adoptPrepared(input, response, () => true);
    const segment = { ...currentSegment, sourcePath: input.context.sources[0]!.source_path };
    coordinator.initializeDecisions(session, [segment]);
    const before = coordinator.decisionSnapshots(session, [segment.id]);
    adapter.readReviewSnapshot.mockResolvedValueOnce({ ...response, result_revision: 'wrong' });
    await expect(coordinator.refreshDecisions(session, () => true)).rejects.toThrow();
    expect(coordinator.decisionSnapshots(session, [segment.id])).toEqual(before);
    const gate = deferred<EnginePreparedReview>();
    let current = true;
    adapter.readReviewSnapshot.mockReturnValueOnce(gate.promise);
    const read = coordinator.refreshDecisions(session, () => current);
    await vi.waitFor(() => expect(adapter.readReviewSnapshot).toHaveBeenCalledTimes(2));
    current = false;
    gate.resolve(response);
    await expect(read).rejects.toBeInstanceOf(StaleReviewSessionError);
    expect(coordinator.decisionSnapshots(session, [segment.id])).toEqual(before);
  });

  it.each(['old path', 'changed SHA', 'unknown id'])('rejects a save with %s after relocation', async (scenario) => {
    const adapter = adapterFixture();
    const coordinator = new ReviewSessionCoordinator(adapter);
    const { input, response } = await durableInput();
    const session = await coordinator.adoptPrepared(input, response, () => true);
    const decision = { ...currentSegment, sourcePath: input.context.sources[0]!.source_path };
    if (scenario === 'old path') decision.sourcePath = currentSegment.sourcePath;
    if (scenario === 'changed SHA') decision.sourceSha256 = 'f'.repeat(64);
    if (scenario === 'unknown id') decision.id = 'unknown';
    await expect(coordinator.save(session, 'batch-job', [decision], 'page_confirmed', () => true)).rejects.toThrow();
    expect(adapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('invalidates the previous binding even when a validated durable response is late', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared());
    const coordinator = new ReviewSessionCoordinator(adapter);
    const previous = await coordinator.prepare(originalContext(), () => true);
    const { input, response } = await durableInput();
    await expect(coordinator.adoptPrepared(input, response, () => false)).rejects.toBeInstanceOf(StaleReviewSessionError);
    await expect(coordinator.save(previous, 'task-1', [currentSegment], 'page_confirmed', () => true))
      .rejects.toBeInstanceOf(StaleReviewSessionError);
    expect(adapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('captures inputs before queuing and rejects records bound to the old access path', async () => {
    const adapter = adapterFixture();
    const coordinator = new ReviewSessionCoordinator(adapter);
    const { input, response } = await durableInput();
    const adopting = coordinator.adoptPrepared(input, response, () => true);
    input.context.sources[0]!.source_path = 'D:/tampered.pdf';
    response.segments[0]!.source_path = 'D:/tampered.pdf';
    const adopted = await adopting;
    expect(adopted.prepared.segments[0]!.source_path).toBe('D:/relocated/A.pdf');
    const next = await durableInput();
    next.response.segments[0]!.source_path = currentSegment.sourcePath;
    await expect(coordinator.adoptPrepared(next.input, next.response, () => true))
      .rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
  });

  it('waits for an in-flight save before obtaining a trusted reload revision', async () => {
    const adapter = adapterFixture();
    const coordinator = new ReviewSessionCoordinator(adapter);
    const { input, response, key } = await durableInput();
    const session = await coordinator.adoptPrepared(input, response, () => true);
    const gate = deferred<void>();
    let storedRevision = 2;
    let oldCurrent = true;
    adapter.saveReviewSegmentsV2.mockImplementation(async (_key, revision, records) => {
      await gate.promise;
      if (records[0]!.record_revision !== storedRevision) throw new Error('CAS conflict');
      storedRevision += 1;
      return { ...saved(revision, records[0]!, storedRevision), context_key: key };
    });
    const decision = { ...currentSegment, sourcePath: input.context.sources[0]!.source_path };
    const saving = coordinator.save(session, 'batch-job', [decision], 'page_confirmed', () => oldCurrent);
    await vi.waitFor(() => expect(adapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1));
    oldCurrent = false;
    const factory = vi.fn(async () => {
      const refreshed = structuredClone(response);
      refreshed.segments[0]!.record_revision = storedRevision;
      refreshed.record_revisions[0]!.record_revision = storedRevision;
      return { original: input, prepared: refreshed };
    });
    const reload = coordinator.prepareTrusted(factory, () => true);
    expect(factory).not.toHaveBeenCalled();
    gate.resolve();
    await expect(saving).rejects.toBeInstanceOf(StaleReviewSessionError);
    const reloaded = await reload;
    expect(reloaded.prepared.record_revisions[0]!.record_revision).toBe(3);
    await expect(coordinator.save(reloaded, 'batch-job', [decision], 'page_confirmed', () => true))
      .resolves.toMatchObject({ segments: [{ record_revision: 4 }] });
  });
});

describe('ReviewSessionCoordinator', () => {
  it('uses the same minimum crop rules as the page editor and store', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared());
    adapter.saveReviewSegmentsV2.mockImplementation(async (_key, revision, records) => saved(revision, records[0]!, 1));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const smallRect = { x0: 0, y0: 0, x1: 8, y1: 10 };
    const smallOriginal = { ...original, page_width: 8, page_height: 10, match_rect: smallRect, candidate_rect: smallRect };
    const small = await coordinator.prepare({ ...originalContext(), originals: [smallOriginal] }, () => true);
    await expect(coordinator.save(small, 'task-1', [{ ...currentSegment,
      pageWidth: 8, pageHeight: 10, matchRect: smallRect, candidateRect: smallRect, finalRect: smallRect,
    }], 'page_confirmed', () => true)).resolves.toMatchObject({ saved_count: 1 });
    const regular = await coordinator.prepare(originalContext(), () => true);
    await expect(coordinator.save(regular, 'task-1', [{ ...currentSegment, mode: 'full_page', finalRect: smallRect }], 'page_confirmed', () => true))
      .rejects.toThrow('审核裁剪决定无效');
    expect(adapter.saveReviewSegmentsV2).toHaveBeenCalledTimes(1);
  });

  it('serializes same-context prepare and records a late prepare as stale after binding', async () => {
    const adapter = adapterFixture();
    const first = deferred<EnginePreparedReview>();
    adapter.prepareReviewContext
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(prepared('result-2'));
    let firstCurrent = true;
    const coordinator = new ReviewSessionCoordinator(adapter);
    const firstPromise = coordinator.prepare(originalContext(), () => firstCurrent);
    const secondPromise = coordinator.prepare(originalContext('result-2'), () => true);

    await Promise.resolve();
    expect(adapter.prepareReviewContext).toHaveBeenCalledTimes(1);
    firstCurrent = false;
    first.resolve(prepared('result-1'));

    await expect(firstPromise).rejects.toBeInstanceOf(StaleReviewSessionError);
    await expect(secondPromise).resolves.toMatchObject({ prepared: { result_revision: 'result-2' } });
    expect(adapter.prepareReviewContext.mock.invocationCallOrder[1])
      .toBeGreaterThan(adapter.prepareReviewContext.mock.invocationCallOrder[0]!);
  });

  it('does not start IPC when a scheduler becomes stale while waiting', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared());
    const gate = deferred<void>();
    const scheduler: { run<T>(operation: () => Promise<T>, isCurrent: () => boolean): Promise<T> } = {
      run: async <T>(operation: () => Promise<T>, isCurrent: () => boolean): Promise<T> => {
        await gate.promise;
        if (!isCurrent()) throw new Error('scheduler stale');
        return operation();
      },
    };
    let current = true;
    const coordinator = new ReviewSessionCoordinator(adapter, scheduler);
    const result = coordinator.prepare(originalContext(), () => current);
    current = false;
    gate.resolve();

    await expect(result).rejects.toBeInstanceOf(StaleReviewSessionError);
    expect(adapter.prepareReviewContext).not.toHaveBeenCalled();
  });

  it('keeps the captured original and prepared response deeply immutable', async () => {
    const adapter = adapterFixture();
    const preparedResponse = prepared();
    adapter.prepareReviewContext.mockResolvedValue(preparedResponse);
    const originalInput = originalContext();
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalInput, () => true);

    expect(session.original).not.toBe(originalInput);
    expect(Object.isFrozen(session.original)).toBe(true);
    expect(Object.isFrozen(session.original.originals[0])).toBe(true);
    expect(Object.isFrozen(session.prepared)).toBe(true);
    expect(Object.isFrozen(session.prepared.record_revisions)).toBe(true);
    expect(() => { session.original.resultRevision = 'changed'; }).toThrow();
    expect(() => { session.prepared.record_revisions[0]!.record_revision = 99; }).toThrow();
    expect(preparedResponse.record_revisions[0]!.record_revision).toBe(0);
  });

  it('uses the latest successful local record revision for queued saves', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared());
    adapter.saveReviewSegmentsV2.mockImplementation(async (_contextKey, resultRevision, records) => {
      const record = records[0]!;
      return saved(resultRevision, record, record.record_revision + 1);
    });
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);
    const first = coordinator.save(session, 'task-1', [currentSegment], 'page_confirmed', () => true);
    const second = coordinator.save(session, 'task-1', [{ ...currentSegment, finalRect: { x0: 0, y0: 8, x1: 600, y1: 192 } }], 'page_confirmed', () => true);

    await expect(first).resolves.toMatchObject({ segments: [{ record_revision: 1 }] });
    await expect(second).resolves.toMatchObject({ segments: [{ record_revision: 2 }] });
    expect(adapter.saveReviewSegmentsV2.mock.calls.map((call) => call[2][0]?.record_revision)).toEqual([0, 1]);
  });

  it('keeps the existing task owner when another batch reopens a compatible record', async () => {
    const adapter = adapterFixture();
    const restored = prepared('result-1', 1);
    restored.segments[0]!.task_id = 'task-a';
    restored.record_revisions[0]!.task_id = 'task-a';
    adapter.prepareReviewContext.mockResolvedValue(restored);
    adapter.saveReviewSegmentsV2.mockImplementation(async (_key, revision, records) => (
      saved(revision, records[0]!, records[0]!.record_revision + 1)
    ));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);

    await expect(coordinator.save(session, 'task-b', [currentSegment], 'page_confirmed', () => true))
      .resolves.toMatchObject({ segments: [{ record_revision: 2 }] });
    expect(adapter.saveReviewSegmentsV2.mock.calls[0]![2][0]!.task_id).toBe('task-a');
  });

  it('keeps the existing task owner when an incompatible analysis has no restored segment', async () => {
    const adapter = adapterFixture();
    const restored = prepared('result-1', 1);
    restored.segments = [];
    restored.record_revisions[0]!.task_id = 'task-a';
    adapter.prepareReviewContext.mockResolvedValue(restored);
    adapter.saveReviewSegmentsV2.mockImplementation(async (_key, revision, records) => (
      saved(revision, records[0]!, records[0]!.record_revision + 1)
    ));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const changedOriginal = { ...original, analysis_signature: 'f'.repeat(64) };
    const session = await coordinator.prepare({
      context,
      originals: [changedOriginal],
      resultRevision: 'result-1',
    }, () => true);

    await expect(coordinator.save(session, 'task-b', [currentSegment], 'page_confirmed', () => true))
      .resolves.toMatchObject({ segments: [{ record_revision: 2 }] });
    expect(adapter.saveReviewSegmentsV2.mock.calls[0]![2][0]!.task_id).toBe('task-a');
  });

  it('keeps an older response compatible by reading the restored record association', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared('result-1', 1));
    adapter.saveReviewSegmentsV2.mockImplementation(async (_key, revision, records) => (
      saved(revision, records[0]!, records[0]!.record_revision + 1)
    ));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);
    await coordinator.save(session, 'new-task', [currentSegment], 'page_confirmed', () => true);
    expect(adapter.saveReviewSegmentsV2.mock.calls[0]![2][0]!.task_id).toBe('task-1');
  });

  it('uses the current task for a new record and remembers it after the first save', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared());
    adapter.saveReviewSegmentsV2.mockImplementation(async (_key, revision, records) => (
      saved(revision, records[0]!, records[0]!.record_revision + 1)
    ));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);

    await coordinator.save(session, 'task-b', [currentSegment], 'page_confirmed', () => true);
    await coordinator.save(session, 'task-c', [currentSegment], 'page_confirmed', () => true);

    const records = adapter.saveReviewSegmentsV2.mock.calls.map((call) => call[2][0]!);
    expect(records.map((record) => [record.task_id, record.record_revision])).toEqual([
      ['task-b', 0], ['task-b', 1],
    ]);
  });

  it('uses stored and current task owners independently in a mixed batch', async () => {
    const sourceKeyB = 'd:/docs/b.pdf';
    const contextTwoSources: EngineReviewContext = {
      ...structuredClone(context),
      sources: [...context.sources, { source_key: sourceKeyB, source_path: 'D:\\docs\\B.pdf', source_sha256: sourceSha }],
    };
    const originalB: EngineOriginalReview = {
      ...original,
      id: 'segment-2',
      source_key: sourceKeyB,
      match_rect: { x0: 30, y0: 40, x1: 120, y1: 60 },
      candidate_rect: { x0: 0, y0: 0, x1: 500, y1: 250 },
    };
    const currentB: ReviewSegment = {
      ...structuredClone(currentSegment),
      id: originalB.id,
      sourcePath: 'D:\\docs\\B.pdf',
      matchRect: { ...originalB.match_rect! },
      candidateRect: { ...originalB.candidate_rect! },
      finalRect: { x0: 2, y0: 3, x1: 450, y1: 240 },
    };
    const restored = prepared('result-1', 1);
    restored.segments[0]!.task_id = 'task-a';
    restored.record_revisions[0]!.task_id = 'task-a';
    restored.record_revisions.push({
      id: originalB.id,
      source_key: originalB.source_key,
      source_page: originalB.source_page,
      segment_no: originalB.segment_no,
      record_revision: 0,
      task_id: null,
    });
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(restored);
    adapter.saveReviewSegmentsV2.mockImplementation(async (_key, revision, records) => ({
      status: 'ok',
      context_key: contextKey,
      result_revision: revision,
      saved_count: records.length,
      segments: records.map((record) => ({ ...record, record_revision: record.record_revision + 1 })),
    }));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare({
      context: contextTwoSources,
      originals: [original, originalB],
      resultRevision: 'result-1',
    }, () => true);

    await coordinator.save(session, 'task-b', [currentSegment, currentB], 'page_confirmed', () => true);

    const records = adapter.saveReviewSegmentsV2.mock.calls[0]![2];
    expect(records.map((record) => [record.id, record.task_id, record.record_revision])).toEqual([
      ['segment-1', 'task-a', 1], ['segment-2', 'task-b', 0],
    ]);
  });

  it('rejects a nonzero revision with no owner metadata or compatible segment', async () => {
    const adapter = adapterFixture();
    const restored = prepared('result-1', 1);
    restored.segments = [];
    adapter.prepareReviewContext.mockResolvedValue(restored);
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);

    await expect(coordinator.save(session, 'task-b', [currentSegment], 'page_confirmed', () => true))
      .rejects.toThrow('已有审核记录所属任务未知');
    expect(adapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('rejects conflicting task owners between revision metadata and restored segment', async () => {
    const adapter = adapterFixture();
    const restored = prepared('result-1', 1);
    restored.segments[0]!.task_id = 'task-b';
    restored.record_revisions[0]!.task_id = 'task-a';
    adapter.prepareReviewContext.mockResolvedValue(restored);
    const coordinator = new ReviewSessionCoordinator(adapter);

    await expect(coordinator.prepare(originalContext(), () => true))
      .rejects.toThrow('审核准备结果中的任务标识不一致');
  });

  it('rejects explicit null task metadata for an existing row even with a compatible fallback', async () => {
    const adapter = adapterFixture();
    const restored = prepared('result-1', 1);
    restored.record_revisions[0]!.task_id = null;
    adapter.prepareReviewContext.mockResolvedValue(restored);
    await expect(new ReviewSessionCoordinator(adapter).prepare(originalContext(), () => true))
      .rejects.toThrow('审核准备结果中的任务标识不一致');
  });

  it('does not refresh or retry the local revision after an external CAS failure', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared());
    adapter.saveReviewSegmentsV2.mockRejectedValue(new Error('review_revision_conflict'));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);

    await expect(coordinator.save(session, 'task-1', [currentSegment], 'page_confirmed', () => true)).rejects.toThrow('review_revision_conflict');
    await expect(coordinator.save(session, 'task-1', [currentSegment], 'page_confirmed', () => true)).rejects.toThrow('review_revision_conflict');
    expect(adapter.prepareReviewContext).toHaveBeenCalledTimes(1);
    expect(adapter.saveReviewSegmentsV2.mock.calls.map((call) => call[2][0]?.record_revision)).toEqual([0, 0]);
  });

  it('updates the actual revision before reporting a save that became stale in flight', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared());
    const saveGate = deferred<EngineSavedReviewV2>();
    adapter.saveReviewSegmentsV2.mockImplementationOnce(async (_contextKey, resultRevision, records) => {
      return saveGate.promise.then(() => saved(resultRevision, records[0]!, 1));
    }).mockImplementationOnce(async (_contextKey, resultRevision, records) => saved(resultRevision, records[0]!, 2));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);
    let current = true;
    const lateSave = coordinator.save(session, 'task-1', [currentSegment], 'page_confirmed', () => current);
    await Promise.resolve();
    current = false;
    saveGate.resolve(saved('result-1', { ...await Promise.resolve({
      id: original.id, task_id: 'task-1', source_path: context.sources[0]!.source_path, source_sha256: sourceSha,
      source_page: 1, segment_no: 1, match_rect: { ...original.match_rect! }, candidate_rect: { ...original.candidate_rect! },
      final_rect: currentSegment.finalRect, layout_fingerprint: original.layout_fingerprint, confidence: original.confidence,
      crop_mode: 'manual', review_status: 'page_confirmed', manual_adjusted: true,
      reviewed_at: '2026-09-08T00:00:00.000Z', context_key: contextKey, source_key: sourceKey,
      analysis_signature: signature, result_revision: 'result-1', record_revision: 1, page_width: 600, page_height: 800,
    } satisfies EngineReviewSegmentV2) }, 1));
    await expect(lateSave).rejects.toBeInstanceOf(StaleReviewSessionError);

    current = true;
    await expect(coordinator.save(session, 'task-1', [currentSegment], 'page_confirmed', () => current))
      .resolves.toMatchObject({ segments: [{ record_revision: 2 }] });
    expect(adapter.saveReviewSegmentsV2.mock.calls.map((call) => call[2][0]?.record_revision)).toEqual([0, 1]);
  });

  it('rejects saving a session replaced by a newer prepare for the same context', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValueOnce(prepared('result-1')).mockResolvedValueOnce(prepared('result-2'));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const oldSession = await coordinator.prepare(originalContext('result-1'), () => true);
    await coordinator.prepare(originalContext('result-2'), () => true);

    await expect(coordinator.save(oldSession, 'task-1', [currentSegment], 'page_confirmed', () => true))
      .rejects.toBeInstanceOf(StaleReviewSessionError);
    expect(adapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('rejects an old session after a prepare for a different context', async () => {
    const adapter = adapterFixture();
    const differentContextKey = 'f'.repeat(64);
    const differentContext = structuredClone(context);
    differentContext.criteria_fingerprint = '1'.repeat(64);
    adapter.prepareReviewContext
      .mockResolvedValueOnce(prepared('result-1', 0, contextKey))
      .mockResolvedValueOnce(prepared('result-2', 0, differentContextKey));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const oldSession = await coordinator.prepare(originalContext(), () => true);
    await coordinator.prepare(originalContext('result-2', differentContext), () => true);

    await expect(coordinator.save(oldSession, 'task-1', [currentSegment], 'page_confirmed', () => true))
      .rejects.toBeInstanceOf(StaleReviewSessionError);
    expect(adapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('keeps nested manifests immutable while still using their original fields for later saves', async () => {
    const adapter = adapterFixture();
    const preparedResponse = prepared('result-1', 1);
    adapter.prepareReviewContext.mockResolvedValue(preparedResponse);
    adapter.saveReviewSegmentsV2.mockImplementation(async (_contextKey, resultRevision, records) => (
      saved(resultRevision, records[0]!, records[0]!.record_revision + 1)
    ));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);

    expect(Object.isFrozen(session.original.originals[0]!.candidate_rect)).toBe(true);
    expect(Object.isFrozen(session.prepared.segments[0]!.final_rect)).toBe(true);
    expect(() => { session.original.originals[0]!.candidate_rect!.x1 = 1; }).toThrow();
    expect(() => { session.prepared.segments[0]!.record_revision = 99; }).toThrow();

    await expect(coordinator.save(session, 'task-1', [currentSegment], 'page_confirmed', () => true))
      .resolves.toMatchObject({ segments: [{ record_revision: 2 }] });
    const sent = adapter.saveReviewSegmentsV2.mock.calls[0]![2][0]!;
    expect(sent.record_revision).toBe(1);
    expect(sent.candidate_rect).toEqual(original.candidate_rect);
  });

  it('keeps same-SHA sources independent across consecutive saves', async () => {
    const sourceKeyB = 'd:/docs/b.pdf';
    const contextTwoSources: EngineReviewContext = {
      ...structuredClone(context),
      sources: [...context.sources, { source_key: sourceKeyB, source_path: 'D:\\docs\\B.pdf', source_sha256: sourceSha }],
    };
    const originalB: EngineOriginalReview = {
      ...original, id: 'segment-2', source_key: sourceKeyB,
      match_rect: { x0: 30, y0: 40, x1: 120, y1: 60 },
      candidate_rect: { x0: 0, y0: 0, x1: 500, y1: 250 },
    };
    const originalTwoSources: OriginalReviewContext = {
      context: contextTwoSources, originals: [original, originalB], resultRevision: 'result-1',
    };
    const preparedTwoSources: EnginePreparedReview = {
      status: 'ok', context_key: contextKey, result_revision: 'result-1', segments: [],
      record_revisions: [
        { id: original.id, source_key: original.source_key, source_page: 1, segment_no: 1, record_revision: 0 },
        { id: originalB.id, source_key: originalB.source_key, source_page: 1, segment_no: 1, record_revision: 0 },
      ], group_confirmed: false,
    };
    const currentB: ReviewSegment = {
      ...structuredClone(currentSegment), id: originalB.id, sourcePath: 'D:\\docs\\B.pdf',
      matchRect: { ...originalB.match_rect! }, candidateRect: { ...originalB.candidate_rect! },
      finalRect: { x0: 2, y0: 3, x1: 450, y1: 240 },
    };
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(preparedTwoSources);
    adapter.saveReviewSegmentsV2.mockImplementation(async (_key, resultRevision, records) => ({
      status: 'ok', context_key: contextKey, result_revision: resultRevision,
      saved_count: records.length, segments: records.map((record) => ({ ...record, record_revision: record.record_revision + 1 })),
    }));
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalTwoSources, () => true);

    await coordinator.save(session, 'task-1', [currentSegment], 'page_confirmed', () => true);
    await coordinator.save(session, 'task-1', [currentB], 'page_confirmed', () => true);
    await coordinator.save(session, 'task-1', [currentSegment], 'page_confirmed', () => true);
    await coordinator.save(session, 'task-1', [currentB], 'page_confirmed', () => true);

    const calls = adapter.saveReviewSegmentsV2.mock.calls.map((call) => call[2][0]!);
    expect(calls.map((record) => [record.source_key, record.record_revision])).toEqual([
      [original.source_key, 0], [originalB.source_key, 0], [original.source_key, 1], [originalB.source_key, 1],
    ]);
    expect(calls[0]!.candidate_rect).toEqual(original.candidate_rect);
    expect(calls[1]!.candidate_rect).toEqual(originalB.candidate_rect);
    expect(calls[0]!.final_rect).toEqual(currentSegment.finalRect);
    expect(calls[1]!.final_rect).toEqual(currentB.finalRect);
  });

  it('drains pending writes before cleanup and remains drainable after a failed save', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared());
    const gate = deferred<void>();
    adapter.saveReviewSegmentsV2.mockImplementation(async (_key, revision, records) => {
      await gate.promise;
      return saved(revision, records[0]!, 1);
    });
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);
    const saving = coordinator.save(session, 'task-1', [currentSegment], 'page_confirmed', () => true);
    let drained = false;
    const draining = coordinator.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await saving;
    await draining;
    expect(drained).toBe(true);
    adapter.saveReviewSegmentsV2.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(coordinator.save(session, 'task-1', [currentSegment], 'page_confirmed', () => true)).rejects.toThrow('disk unavailable');
    await expect(coordinator.drain()).resolves.toBeUndefined();
  });

  it('runs a queued prepare after a save and observes that save\'s bound revision', async () => {
    const adapter = adapterFixture();
    let persistedRevision = 0;
    adapter.prepareReviewContext.mockImplementation(async (_context, _originals, resultRevision) => prepared(resultRevision, persistedRevision));
    adapter.saveReviewSegmentsV2.mockImplementation(async (_key, resultRevision, records) => {
      persistedRevision = records[0]!.record_revision + 1;
      return saved(resultRevision, records[0]!, persistedRevision);
    });
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);
    const savePromise = coordinator.save(session, 'task-1', [currentSegment], 'page_confirmed', () => true);
    const nextPrepare = coordinator.prepare(originalContext('result-2'), () => true);

    await expect(savePromise).resolves.toMatchObject({ segments: [{ record_revision: 1 }] });
    await expect(nextPrepare).resolves.toMatchObject({ prepared: { result_revision: 'result-2', record_revisions: [{ record_revision: 1 }] } });
    expect(adapter.saveReviewSegmentsV2.mock.invocationCallOrder[0])
      .toBeLessThan(adapter.prepareReviewContext.mock.invocationCallOrder[1]!);
  });

  it('does not issue a save IPC when a queued save becomes stale before scheduler release', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared());
    const gate = deferred<void>();
    let delay = false;
    const scheduler: { run<T>(operation: () => Promise<T>, isCurrent: () => boolean): Promise<T> } = {
      run: async <T>(operation: () => Promise<T>, isCurrent: () => boolean): Promise<T> => {
        if (delay) await gate.promise;
        if (!isCurrent()) throw new Error('scheduler stale');
        return operation();
      },
    };
    const coordinator = new ReviewSessionCoordinator(adapter, scheduler);
    const session = await coordinator.prepare(originalContext(), () => true);
    let current = true;
    delay = true;
    const request = coordinator.save(session, 'task-1', [currentSegment], 'page_confirmed', () => current);
    current = false;
    gate.resolve();

    await expect(request).rejects.toBeInstanceOf(StaleReviewSessionError);
    expect(adapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });

  it('captures decisions before enqueueing and reconstructs immutable fields from the original manifest', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared());
    const gate = deferred<void>();
    adapter.saveReviewSegmentsV2.mockImplementation(async (_contextKey, resultRevision, records) => {
      await gate.promise;
      return saved(resultRevision, records[0]!, 1);
    });
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);
    const decision = { ...structuredClone(currentSegment), sourcePath: 'd:/docs/A.pdf', sourceSha256: sourceSha.toUpperCase() };
    const request = coordinator.save(session, 'task-1', [decision], 'page_confirmed', () => true);
    decision.finalRect = { x0: 30, y0: 30, x1: 40, y1: 40 };
    decision.candidateRect = null;
    gate.resolve();
    await request;

    const sent = adapter.saveReviewSegmentsV2.mock.calls[0]![2][0]!;
    expect(sent).toMatchObject({
      id: original.id, task_id: 'task-1', source_key: sourceKey, source_path: decision.sourcePath,
      source_sha256: sourceSha, source_page: 1, segment_no: 1, match_rect: original.match_rect,
      candidate_rect: original.candidate_rect, layout_fingerprint: original.layout_fingerprint,
      confidence: original.confidence, analysis_signature: signature, page_width: 600, page_height: 800,
      final_rect: currentSegment.finalRect, crop_mode: currentSegment.mode, manual_adjusted: currentSegment.manualAdjusted,
      review_status: 'page_confirmed',
    });
    expect(sent.reviewed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('rejects missing, duplicate, mismatched and non-persistable decisions before IPC', async () => {
    const adapter = adapterFixture();
    adapter.prepareReviewContext.mockResolvedValue(prepared());
    const coordinator = new ReviewSessionCoordinator(adapter);
    const session = await coordinator.prepare(originalContext(), () => true);
    await expect(coordinator.save(session, 'task-1', [], 'page_confirmed', () => true)).rejects.toThrow();
    await expect(coordinator.save(session, 'task-1', [currentSegment, currentSegment], 'page_confirmed', () => true)).rejects.toThrow();
    await expect(coordinator.save(session, 'task-1', [{ ...currentSegment, sourceSha256: 'f'.repeat(64) }], 'page_confirmed', () => true)).rejects.toThrow();
    await expect(coordinator.save(session, 'task-1', [{ ...currentSegment, id: 'unknown' }], 'page_confirmed', () => true)).rejects.toThrow();
    expect(adapter.saveReviewSegmentsV2).not.toHaveBeenCalled();
  });
});
