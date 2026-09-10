// @vitest-environment jsdom
// @ts-expect-error The test runtime exposes Node crypto without @types/node.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { localEngineAdapter, validatePreparedReviewResponse, type EngineReviewContext, type EngineOriginalReview, type EngineReviewSegmentV2 } from './localEngineAdapter';

const context: EngineReviewContext = {
  version: 2,
  sources: [{ source_key: '/docs/a.pdf', source_path: '/docs/a.pdf', source_sha256: 'a'.repeat(64) }],
  criteria_fingerprint: 'b'.repeat(64), computation_version: 'm2-test',
};
const original: EngineOriginalReview = {
  id: 's1', source_key: '/docs/a.pdf', source_page: 1, segment_no: 1,
  analysis_signature: 'c'.repeat(64), persistable: true,
  page_width: 600, page_height: 800, match_rect: { x0: 10, y0: 20, x1: 80, y1: 30 },
  candidate_rect: { x0: 0, y0: 0, x1: 600, y1: 200 },
  layout_fingerprint: 'geometry:600:800', confidence: 0.96, auto_full_page: false,
};

async function contextKey() {
  const canonical = JSON.stringify({ computation_version: context.computation_version,
    criteria_fingerprint: context.criteria_fingerprint,
    sources: context.sources.map(({ source_key, source_sha256 }) => ({ source_key, source_sha256 })), version: 2 });
  const hash = await (webcrypto as Crypto).subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

beforeEach(() => { invoke.mockReset(); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { vi.unstubAllGlobals(); });

it('checks the computation version without opening a PDF', async () => {
  invoke.mockResolvedValue({ status: 'ok', computation_version: 'm2-test' });
  await expect(localEngineAdapter.computationInfo()).resolves.toEqual({ status: 'ok', computation_version: 'm2-test' });
  expect(invoke).toHaveBeenCalledWith('engine_computation_info');
});

it('prepares a complete revision map and accepts a no-history result', async () => {
  const key = await contextKey();
  const response = { status: 'ok', context_key: key, result_revision: 'run-1', segments: [],
    record_revisions: [{ id: 's1', source_key: original.source_key, source_page: 1, segment_no: 1, record_revision: 0 }], group_confirmed: false };
  invoke.mockResolvedValue(response);
  await expect(localEngineAdapter.prepareReviewContext(context, [original], 'run-1')).resolves.toEqual(response);
  expect(invoke).toHaveBeenCalledWith('prepare_review_context_v2', { context, originals: [original], resultRevision: 'run-1' });
});

it('reads current decisions using only the bound context key and revision, without preparing or sending paths', async () => {
  const key = await contextKey();
  const response = { status: 'ok', context_key: key, result_revision: 'run-1', segments: [],
    record_revisions: [{ id: 's1', source_key: original.source_key, source_page: 1, segment_no: 1, record_revision: 0, task_id: null }], group_confirmed: false };
  invoke.mockResolvedValue(response);
  const alias = structuredClone(context);
  alias.sources[0]!.source_path = '/relocated/a.pdf';
  await expect(localEngineAdapter.readReviewSnapshot(alias, [original], 'run-1')).resolves.toEqual(response);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('read_review_snapshot_v2', { contextKey: key, resultRevision: 'run-1' });
  invoke.mockResolvedValue({ ...response, result_revision: 'old' });
  await expect(localEngineAdapter.readReviewSnapshot(alias, [original], 'run-1')).rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
});

it('accepts nullable or explicit task ownership in revision metadata', async () => {
  const key = await contextKey();
  const fresh = { status: 'ok', context_key: key, result_revision: 'run-1', segments: [],
    record_revisions: [{ id: 's1', source_key: original.source_key, source_page: 1, segment_no: 1, record_revision: 0, task_id: null }], group_confirmed: false };
  invoke.mockResolvedValueOnce(fresh);
  await expect(localEngineAdapter.prepareReviewContext(context, [original], 'run-1')).resolves.toEqual(fresh);

  const record = await savedRecord();
  record.task_id = 'task-a';
  const existing = { status: 'ok', context_key: key, result_revision: 'run-1', segments: [record],
    record_revisions: [{ id: original.id, source_key: original.source_key, source_page: 1, segment_no: 1,
      record_revision: 1, task_id: 'task-a' }], group_confirmed: false };
  invoke.mockResolvedValueOnce(existing);
  await expect(localEngineAdapter.prepareReviewContext(context, [original], 'run-1')).resolves.toEqual(existing);
});

it.each([
  ['revision zero owner', { record_revision: 0, task_id: 'task-a' }],
  ['nonzero null association', { record_revision: 1, task_id: null }],
  ['empty owner', { record_revision: 1, task_id: '' }],
  ['NUL owner', { record_revision: 1, task_id: 'task-\0a' }],
  ['oversized owner', { record_revision: 1, task_id: 'x'.repeat(1025) }],
  ['non-string owner', { record_revision: 1, task_id: 7 }],
] as const)('rejects %s in revision metadata', async (_scenario, metadata) => {
  const key = await contextKey();
  const base = metadata.record_revision > 0 ? { segments: [await savedRecord()] } : { segments: [] };
  const revision = { id: 's1', source_key: original.source_key, source_page: 1, segment_no: 1, ...metadata };
  invoke.mockResolvedValue({ status: 'ok', context_key: key, result_revision: 'run-1', ...base,
    record_revisions: [revision], group_confirmed: false });
  await expect(localEngineAdapter.prepareReviewContext(context, [original], 'run-1'))
    .rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
});

it('rejects a compatible segment whose task owner disagrees with revision metadata', async () => {
  const record = await savedRecord();
  record.task_id = 'task-b';
  invoke.mockResolvedValue({ status: 'ok', context_key: record.context_key, result_revision: 'run-1', segments: [record],
    record_revisions: [{ id: record.id, source_key: record.source_key, source_page: 1, segment_no: 1,
      record_revision: 1, task_id: 'task-a' }], group_confirmed: false });
  await expect(localEngineAdapter.prepareReviewContext(context, [original], 'run-1'))
    .rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
});

it.each(['wrong context', 'wrong result', 'missing revision', 'duplicate revision', 'missing revision identity', 'fake group'])(
  'rejects prepare response with %s', async (scenario) => {
    const revision = { id: 's1', source_key: original.source_key, source_page: 1, segment_no: 1, record_revision: 0 };
    invoke.mockResolvedValue({ status: 'ok', context_key: scenario === 'wrong context' ? 'f'.repeat(64) : await contextKey(),
      result_revision: scenario === 'wrong result' ? 'old' : 'run-1', segments: [],
      record_revisions: scenario === 'missing revision' ? [] : scenario === 'duplicate revision' ? [revision, revision]
        : scenario === 'missing revision identity' ? [{ record_revision: 7 }] : [revision],
      group_confirmed: scenario === 'fake group' });
    await expect(localEngineAdapter.prepareReviewContext(context, [original], 'run-1')).rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
  },
);

it('rejects duplicate sources before IPC and preserves conflict codes', async () => {
  await expect(localEngineAdapter.prepareReviewContext({ ...context, sources: [...context.sources, ...context.sources] }, [], 'run-1'))
    .rejects.toMatchObject({ code: 'ENGINE_INVALID_REQUEST' });
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValue({ status: 'error', code: 'review_revision_conflict', message: '审核记录已变化。' });
  await expect(localEngineAdapter.saveReviewSegmentsV2('d'.repeat(64), 'run-1', []))
    .rejects.toMatchObject({ code: 'ENGINE_REQUEST_REJECTED', engineCode: 'review_revision_conflict' });
});

async function savedRecord(): Promise<EngineReviewSegmentV2> {
  return {
    id: original.id, task_id: 'legacy-task', source_path: context.sources[0]!.source_path,
    source_key: original.source_key, source_sha256: context.sources[0]!.source_sha256,
    source_page: original.source_page, segment_no: original.segment_no,
    match_rect: { ...original.match_rect! }, candidate_rect: { ...original.candidate_rect! },
    final_rect: { x0: 0, y0: 2, x1: 600, y1: 198 }, layout_fingerprint: original.layout_fingerprint,
    confidence: original.confidence, crop_mode: 'manual', review_status: 'page_confirmed',
    manual_adjusted: true, reviewed_at: '2026-09-08T01:00:00.000Z', context_key: await contextKey(),
    analysis_signature: original.analysis_signature, result_revision: 'run-1', record_revision: 1,
    page_width: 600, page_height: 800,
  };
}

it('accepts a trusted relocated binding while keeping the public prepare path strict', async () => {
  const aliasContext = { ...context, sources: [{ ...context.sources[0]!, source_path: '/relocated/a.pdf' }] };
  const record = { ...await savedRecord(), source_path: '/relocated/a.pdf' };
  const response = { status: 'ok', context_key: record.context_key, result_revision: 'run-1', segments: [record],
    record_revisions: [{ id: original.id, source_key: original.source_key, source_page: 1, segment_no: 1, record_revision: 1 }],
    group_confirmed: false };
  await expect(validatePreparedReviewResponse(response, aliasContext, [original], 'run-1')).resolves.toEqual(response);
  await expect(localEngineAdapter.prepareReviewContext(aliasContext, [original], 'run-1'))
    .rejects.toMatchObject({ code: 'ENGINE_INVALID_REQUEST' });
  expect(invoke).not.toHaveBeenCalled();
  const stale = { ...response, segments: [{ ...record, source_path: '/docs/a.pdf' }] };
  await expect(validatePreparedReviewResponse(stale, aliasContext, [original], 'run-1'))
    .rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
});

it('saves a relocated logical source but rejects an acknowledgement with a different access path', async () => {
  const record = { ...await savedRecord(), source_path: '/relocated/a.pdf' };
  const response = { status: 'ok', context_key: record.context_key, result_revision: record.result_revision,
    saved_count: 1, segments: [{ ...record, record_revision: 2 }] };
  invoke.mockResolvedValueOnce(response).mockResolvedValueOnce({ ...response,
    segments: [{ ...response.segments[0], source_path: '/docs/a.pdf' }] });
  await expect(localEngineAdapter.saveReviewSegmentsV2(record.context_key, record.result_revision, [record]))
    .resolves.toMatchObject({ segments: [{ source_key: '/docs/a.pdf', source_path: '/relocated/a.pdf' }] });
  await expect(localEngineAdapter.saveReviewSegmentsV2(record.context_key, record.result_revision, [record]))
    .rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
});

const smallOriginal: EngineOriginalReview = {
  ...original,
  page_width: 8,
  page_height: 10,
  match_rect: { x0: 0, y0: 0, x1: 4, y1: 5 },
  candidate_rect: { x0: 0, y0: 0, x1: 8, y1: 10 },
};

async function smallRecord(
  cropMode: EngineReviewSegmentV2['crop_mode'] = 'manual',
  resultRevision = 'run-small',
  recordRevision = 0,
): Promise<EngineReviewSegmentV2> {
  return {
    id: smallOriginal.id, task_id: 'legacy-task', source_path: context.sources[0]!.source_path,
    source_key: smallOriginal.source_key, source_sha256: context.sources[0]!.source_sha256,
    source_page: smallOriginal.source_page, segment_no: smallOriginal.segment_no,
    match_rect: { ...smallOriginal.match_rect! }, candidate_rect: { ...smallOriginal.candidate_rect! },
    final_rect: { x0: 0, y0: 0, x1: 8, y1: 10 }, layout_fingerprint: smallOriginal.layout_fingerprint,
    confidence: smallOriginal.confidence, crop_mode: cropMode, review_status: 'page_confirmed',
    manual_adjusted: cropMode === 'manual', reviewed_at: '2026-09-08T01:00:00.000Z',
    context_key: await contextKey(), analysis_signature: smallOriginal.analysis_signature,
    result_revision: resultRevision, record_revision: recordRevision, page_width: 8, page_height: 10,
  };
}

it.each(['candidate', 'manual'] as const)('accepts a legal non-null final rectangle on an 8x10 page for %s mode', async (cropMode) => {
  const request = await smallRecord(cropMode, 'run-small', 0);
  const response = { status: 'ok' as const, context_key: request.context_key, result_revision: request.result_revision,
    saved_count: 1, segments: [{ ...request, record_revision: 1 }] };
  invoke.mockResolvedValue(response);
  await expect(localEngineAdapter.saveReviewSegmentsV2(request.context_key, request.result_revision, [request]))
    .resolves.toMatchObject({ saved_count: 1, segments: [{ record_revision: 1 }] });
  expect(invoke).toHaveBeenCalledWith('save_review_segments_v2', {
    contextKey: request.context_key, resultRevision: request.result_revision, segments: [request], confirmGroup: false,
  });
});

it('accepts a legal small-page record when preparing a v2 review', async () => {
  const record = await smallRecord('manual', 'run-small', 1);
  invoke.mockResolvedValue({ status: 'ok', context_key: record.context_key, result_revision: record.result_revision,
    segments: [record], record_revisions: [{ id: smallOriginal.id, source_key: smallOriginal.source_key,
      source_page: smallOriginal.source_page, segment_no: smallOriginal.segment_no, record_revision: 1 }], group_confirmed: false });
  await expect(localEngineAdapter.prepareReviewContext(context, [smallOriginal], record.result_revision))
    .resolves.toMatchObject({ segments: [record] });
});

it('rejects a non-full-size full_page rectangle on a normal page before save IPC', async () => {
  const request = { ...await savedRecord(), crop_mode: 'full_page' as const, final_rect: { x0: 0, y0: 0, x1: 8, y1: 10 } };
  await expect(localEngineAdapter.saveReviewSegmentsV2(request.context_key, request.result_revision, [request]))
    .rejects.toMatchObject({ code: 'ENGINE_INVALID_REQUEST' });
  expect(invoke).not.toHaveBeenCalled();
});

it('rejects an invalid full_page rectangle in a prepare response', async () => {
  const record = { ...await savedRecord(), crop_mode: 'full_page' as const, final_rect: { x0: 0, y0: 0, x1: 8, y1: 10 } };
  invoke.mockResolvedValue({ status: 'ok', context_key: record.context_key, result_revision: record.result_revision,
    segments: [record], record_revisions: [{ id: original.id, source_key: original.source_key,
      source_page: original.source_page, segment_no: original.segment_no, record_revision: 1 }], group_confirmed: false });
  await expect(localEngineAdapter.prepareReviewContext(context, [original], record.result_revision))
    .rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
});

it('accepts compatible restored geometry and its actual existing revision', async () => {
  const record = await savedRecord();
  const response = { status: 'ok', context_key: record.context_key, result_revision: 'run-1', segments: [record],
    record_revisions: [{ id: record.id, source_key: record.source_key, source_page: 1, segment_no: 1, record_revision: 1 }], group_confirmed: false };
  invoke.mockResolvedValue(response);
  await expect(localEngineAdapter.prepareReviewContext(context, [original], 'run-1')).resolves.toEqual(response);
});

it.each(['signature', 'candidate', 'source', 'geometry', 'revision'])(
  'rejects a restored record whose %s does not match the current original', async (scenario) => {
    const record = await savedRecord();
    if (scenario === 'signature') record.analysis_signature = 'f'.repeat(64);
    if (scenario === 'candidate') record.candidate_rect = { x0: 0, y0: 0, x1: 600, y1: 180 };
    if (scenario === 'source') record.source_sha256 = 'f'.repeat(64);
    if (scenario === 'geometry') record.final_rect = { x0: 0, y0: 0, x1: 601, y1: 200 };
    if (scenario === 'revision') record.record_revision = 2;
    invoke.mockResolvedValue({ status: 'ok', context_key: await contextKey(), result_revision: 'run-1', segments: [record],
      record_revisions: [{ id: 's1', source_key: original.source_key, source_page: 1, segment_no: 1, record_revision: 1 }], group_confirmed: false });
    await expect(localEngineAdapter.prepareReviewContext(context, [original], 'run-1')).rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
  },
);

it('accepts unavailable geometry only as a non-persistable original with explicit finite placeholders', async () => {
  const blocked = { ...original, source_page: 0, page_width: 0, page_height: 0, match_rect: null, candidate_rect: null, persistable: false };
  invoke.mockResolvedValue({ status: 'ok', context_key: await contextKey(), result_revision: 'run-1', segments: [],
    record_revisions: [{ id: 's1', source_key: original.source_key, source_page: 0, segment_no: 1, record_revision: 0 }], group_confirmed: false });
  await expect(localEngineAdapter.prepareReviewContext(context, [blocked], 'run-1')).resolves.toMatchObject({ group_confirmed: false });
  invoke.mockClear();
  await expect(localEngineAdapter.prepareReviewContext(context, [{ ...blocked, page_width: Number.NaN }], 'run-1'))
    .rejects.toMatchObject({ code: 'ENGINE_INVALID_REQUEST' });
  expect(invoke).not.toHaveBeenCalled();
});

it('freezes the prepare request before asynchronous hashing', async () => {
  const draftContext = structuredClone(context);
  const draftOriginal = structuredClone(original);
  invoke.mockResolvedValue({ status: 'ok', context_key: await contextKey(), result_revision: 'run-1', segments: [],
    record_revisions: [{ id: 's1', source_key: original.source_key, source_page: 1, segment_no: 1, record_revision: 0 }], group_confirmed: false });
  const pending = localEngineAdapter.prepareReviewContext(draftContext, [draftOriginal], 'run-1');
  draftContext.criteria_fingerprint = 'e'.repeat(64);
  draftOriginal.match_rect!.x0 = 99;
  await pending;
  expect(invoke).toHaveBeenCalledWith('prepare_review_context_v2', { context, originals: [original], resultRevision: 'run-1' });
});

it('requires the save response to increment the record revision without altering the decision', async () => {
  const previous = await savedRecord();
  const next = { ...previous, record_revision: 2 };
  invoke.mockResolvedValue({ status: 'ok', context_key: previous.context_key, result_revision: 'run-1', saved_count: 1, segments: [next] });
  await expect(localEngineAdapter.saveReviewSegmentsV2(previous.context_key, 'run-1', [previous]))
    .resolves.toMatchObject({ segments: [next] });
  expect(invoke).toHaveBeenCalledWith('save_review_segments_v2', { contextKey: previous.context_key, resultRevision: 'run-1', segments: [previous], confirmGroup: false });
});

it.each(['unchanged revision', 'changed decision', 'different result', 'duplicate record'])(
  'rejects save acknowledgment with %s', async (scenario) => {
    const previous = await savedRecord();
    const next = { ...previous, record_revision: 2 };
    if (scenario === 'unchanged revision') next.record_revision = 1;
    if (scenario === 'changed decision') next.final_rect = { x0: 0, y0: 10, x1: 600, y1: 190 };
    if (scenario === 'different result') next.result_revision = 'old';
    invoke.mockResolvedValue({ status: 'ok', context_key: previous.context_key, result_revision: 'run-1', saved_count: 1,
      segments: scenario === 'duplicate record' ? [next, next] : [next] });
    await expect(localEngineAdapter.saveReviewSegmentsV2(previous.context_key, 'run-1', [previous]))
      .rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
  },
);

it('requires an explicit whole-group request before sending group_confirmed records', async () => {
  const record = { ...await savedRecord(), review_status: 'group_confirmed' as const };
  await expect(localEngineAdapter.saveReviewSegmentsV2(record.context_key, 'run-1', [record]))
    .rejects.toMatchObject({ code: 'ENGINE_INVALID_REQUEST' });
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValue({ status: 'ok', context_key: record.context_key, result_revision: 'run-1', saved_count: 1, segments: [{ ...record, record_revision: 2 }] });
  await expect(localEngineAdapter.saveReviewSegmentsV2(record.context_key, 'run-1', [record], true)).resolves.toMatchObject({ saved_count: 1 });
});
