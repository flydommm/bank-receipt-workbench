// @vitest-environment jsdom
// @ts-expect-error The test runtime exposes Node crypto without @types/node.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeReceiptProcessingFingerprint,
  makeReceiptInstanceId,
  buildReceiptRecord,
  validateReceiptContext,
  type ReceiptReviewEdit,
  type ReceiptReviewOriginal,
} from './receiptReview';
import {
  parseReceiptBatchJobSnapshot,
  parseReceiptBatchList,
  parseReceiptBatchPreparedReview,
  parseReceiptBatchResultsPage,
  parseReceiptBatchReviewPage,
  parseReceiptBatchSaveResult,
  serializedReceiptBatchBytes,
  validateReceiptBatchRequest,
  type ReceiptBatchJobSnapshot,
  type ReceiptBatchReviewBinding,
} from './receiptBatch';

const SOURCE_SHA = 'a'.repeat(64);
const LAYOUT_SHA = 'b'.repeat(64);
const ANALYSIS_SHA = 'c'.repeat(64);
const SOURCE_KEY = 'c:/documents/report.pdf';
const SOURCE_PATH = 'C:/Documents/report.pdf';
const JOB_ID = 'job-receipt-1';
const SOURCE_ID = 'source-1';
const GEOMETRY = {
  pdf_box: { x0: 0, y0: 0, x1: 600, y1: 900 }, rotation: 0, user_unit: 1, width_pt: 600, height_pt: 900,
} as const;
const OPTIONS = { processing_mode: 'search' as const, criteria: { include: ['手续费'], includeMode: 'all' as const, exclude: [] } };

function shaValue(): { processed_pages: number; text_characters: number; fuzzy_work: number; matches: number; matched_text_characters: number } {
  return { processed_pages: 1, text_characters: 10, fuzzy_work: 0, matches: 1, matched_text_characters: 3 };
}

function pages() { return { pending: 0, processing: 0, succeeded: 1, failed: 0 }; }

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function jobValue(overrides: Partial<ReceiptBatchJobSnapshot> = {}): Promise<ReceiptBatchJobSnapshot> {
  return {
    id: JOB_ID, name: '回单任务', generation: 1, state: 'ready_for_review', resume_target: null,
    criteria: OPTIONS.criteria, page_result_schema: 2, processing_options: OPTIONS,
    criteria_fingerprint: await computeReceiptProcessingFingerprint(OPTIONS, 'exact'), match_mode: 'exact',
    computation_version: 'receipt-engine-v3', result_revision: 'revision-1', owner: null, error: null,
    created_at: '2026-09-14T00:00:00Z', updated_at: '2026-09-14T00:00:01Z', deletion_pending: false,
    page_summary: pages(), total_pages: 1,
    sources: [{ source_id: SOURCE_ID, position: 0, source_key: SOURCE_KEY, initial_path: SOURCE_PATH,
      access_path: SOURCE_PATH, name: 'report.pdf', sha256: SOURCE_SHA, size_bytes: 1234, page_count: 1,
      state: 'verified', error: null, budget: shaValue(), verified_generation: 1, page_summary: pages() }],
    ...overrides,
  };
}

async function contextValue(job: ReceiptBatchJobSnapshot) {
  return {
    version: 3 as const,
    sources: [{ source_key: SOURCE_KEY, source_path: SOURCE_PATH, source_sha256: SOURCE_SHA }],
    processing_options: OPTIONS, match_mode: job.match_mode,
    criteria_fingerprint: job.criteria_fingerprint, computation_version: job.computation_version,
  };
}

async function originalValue(job: ReceiptBatchJobSnapshot): Promise<ReceiptReviewOriginal> {
  const instanceId = makeReceiptInstanceId(SOURCE_SHA, 1, 'layout-report', 1, 'slot-1');
  return {
    id: await digest([JOB_ID, SOURCE_ID, instanceId]), source_key: SOURCE_KEY, source_page: 1,
    instance_id: instanceId, slot_id: 'slot-1', position_index: 1, layout_id: 'layout-report', layout_revision: 1,
    layout_signature: LAYOUT_SHA, page_geometry: structuredClone(GEOMETRY), candidate_rect: { x0: 0, y0: 600, x1: 600, y1: 900 },
    occupancy: 'occupied', selection_basis: job.processing_options?.processing_mode === 'split_all' ? 'occupied_slot' : 'keyword',
    needs_review: false, analysis_signature: ANALYSIS_SHA,
  };
}

function snapshotItem(original: ReceiptReviewOriginal) {
  return {
    original: structuredClone(original),
    segment: { ...structuredClone(original), source_path: SOURCE_PATH, source_sha256: SOURCE_SHA,
      final_rect: structuredClone(original.candidate_rect), crop_mode: 'candidate' as const,
      review_status: 'confirmed' as const, manual_adjusted: false as const },
    evidence: [{ query_id: 'include-0', rect: { x0: 20, y0: 620, x1: 100, y1: 650 } }],
  };
}

async function bindingValue(): Promise<{ job: ReceiptBatchJobSnapshot; binding: ReceiptBatchReviewBinding; original: ReceiptReviewOriginal }> {
  const job = await jobValue();
  const context = await contextValue(job);
  const prepared = await parseReceiptBatchPreparedReview({
    context,
    prepared: { status: 'ok', schema_version: 1,
      context_key: (await validateReceiptContext(context, { trustedAliases: true })).contextKey,
      result_revision: 'revision-1', total: 1 },
  }, job);
  return { job, binding: prepared.binding, original: await originalValue(job) };
}

describe('receipt batch DTO contracts', () => {
  it('preserves bounded ambiguous template choices while rejecting duplicate or malformed ids', async () => {
    const job = await jobValue(), context = await contextValue(job);
    const response = { context, template_choice_ids: ['first', 'second'],
      prepared: { status: 'ok', schema_version: 1,
        context_key: (await validateReceiptContext(context, { trustedAliases: true })).contextKey,
        result_revision: 'revision-1', total: 1 } };
    expect((await parseReceiptBatchPreparedReview(response, job)).templateChoiceIds).toEqual(['first', 'second']);
    for (const ids of [['first', 'first'], [], ['first'], [1, 'second'], ['first', ''], Array(257).fill('x')]) {
      await expect(parseReceiptBatchPreparedReview({ ...response, template_choice_ids: ids }, job)).rejects.toThrow();
    }
  });
  it('preserves an explicit template choice without changing processing options', () => {
    const request = { op: 'batch_create_receipts', name: 'template analysis',
      sources: [{ source_path: SOURCE_PATH, name: 'sample.pdf' }], processing_options: OPTIONS, match_mode: 'exact' };
    expect(validateReceiptBatchRequest(request)).toEqual(request);
    expect(validateReceiptBatchRequest({ ...request, layout_template_id: 'checked-template' }))
      .toEqual({ ...request, layout_template_id: 'checked-template' });
    expect(validateReceiptBatchRequest({ ...request, layout_template_id: null }))
      .toEqual({ ...request, layout_template_id: null });
    for (const value of ['', ' ', 'x'.repeat(257), 'bad\0id', 3, {}, undefined]) {
      expect(() => validateReceiptBatchRequest({ ...request, layout_template_id: value })).toThrow();
    }
    expect(() => validateReceiptBatchRequest({ ...request, template_database_path: '/untrusted.sqlite' })).toThrow();
  });
  beforeEach(() => vi.stubGlobal('crypto', webcrypto));
  afterEach(() => vi.unstubAllGlobals());

  it('normalizes legacy jobs in a mixed list without manufacturing receipt criteria', async () => {
    const legacy = {
      id: 'legacy-1', name: '旧任务', generation: 1, state: 'archived', resume_target: null,
      criteria: { include: ['手续费'], includeMode: 'all', exclude: [] }, criteria_fingerprint: 'd'.repeat(64),
      match_mode: 'exact', computation_version: 'legacy-v1', result_revision: 'r1', owner: null, error: null,
      created_at: '2026-09-14T00:00:00Z', updated_at: '2026-09-14T00:00:00Z', deletion_pending: false,
      page_summary: { pending: 0, processing: 0, succeeded: 1, failed: 0 }, total_pages: 1,
      sources: [{ source_id: 's1', position: 0, source_key: SOURCE_KEY, initial_path: SOURCE_PATH,
        access_path: SOURCE_PATH, name: 'old.pdf', sha256: SOURCE_SHA, size_bytes: 1, page_count: 1, state: 'verified',
        error: null, budget: shaValue(), verified_generation: 1, page_summary: pages() }],
    };
    const parsed = await parseReceiptBatchJobSnapshot(legacy);
    expect(parsed.page_result_schema).toBe(1);
    expect(parsed.processing_options).toBeNull();
    expect(parsed.criteria).toEqual(legacy.criteria);

    const receipt = await jobValue({ id: 'receipt-2' });
    const { sources: _legacySources, ...legacySummaryBase } = legacy;
    const legacySummary = { ...legacySummaryBase, source_summary: {
      total: 1, pending: 0, registered: 0, verified: 1, failed: 0, blocked: 0, declared_pages: 1,
    } };
    const { sources: _receiptSources, ...receiptSummaryBase } = receipt;
    const receiptSummary = { ...receiptSummaryBase, source_summary: {
      total: 1, pending: 0, registered: 0, verified: 1, failed: 0, blocked: 0, declared_pages: 1,
    } };
    const mixed = await parseReceiptBatchList({
      items: [legacySummary, receiptSummary], offset: 0, limit: 50, total: 2, next_offset: null,
    });
    expect(mixed.items.map((item) => item.page_result_schema)).toEqual([1, 2]);
    expect(mixed.items[0]?.processing_options).toBeNull();
    expect(mixed.items[1]?.criteria).toEqual(OPTIONS.criteria);
  });

  it('accepts split_all with a null criteria and validates the processing fingerprint', async () => {
    const job = await jobValue({
      criteria: null,
      processing_options: { processing_mode: 'split_all', criteria: null },
      criteria_fingerprint: await computeReceiptProcessingFingerprint({ processing_mode: 'split_all', criteria: null }, 'exact'),
    });
    await expect(parseReceiptBatchJobSnapshot(job)).resolves.toMatchObject({ criteria: null, page_result_schema: 2 });
    await expect(parseReceiptBatchJobSnapshot({ ...job, criteria_fingerprint: '0'.repeat(64) })).rejects.toThrow(/criteria_fingerprint/);
    await expect(parseReceiptBatchJobSnapshot({ ...job, page_result_schema: 1 })).rejects.toThrow();
  });

  it('rejects the legacy result codec and binds schema-2 items to the receipt job', async () => {
    const { job, binding, original } = await bindingValue();
    const item = snapshotItem(original);
    const page = await parseReceiptBatchResultsPage({ schema: 2, result_revision: 'revision-1', offset: 0, limit: 200,
      total: 1, next_offset: null, items: [item] }, binding);
    expect(page.items[0]?.original.id).toBe(original.id);
    await expect(parseReceiptBatchResultsPage({ result_revision: 'revision-1', offset: 0, limit: 200,
      total: 1, next_offset: null, items: [item] }, binding)).rejects.toThrow();
    await expect(parseReceiptBatchResultsPage({ schema: 2, result_revision: 'revision-1', offset: 0, limit: 200,
      total: 1, next_offset: null, items: [{ ...item, segment: { ...item.segment, source_path: 'D:/other.pdf' } }] }, binding)).rejects.toThrow();
  });

  it('checks review page records, cursors, and source access bindings', async () => {
    const { binding, original } = await bindingValue();
    const page = await parseReceiptBatchReviewPage({ schema_version: 1, context_key: binding.contextKey,
      result_revision: 'revision-1', offset: 0, limit: 20, total: 1, next_offset: null,
      items: [{ original, record_revision: 0, record: null }] }, binding);
    expect(page.items[0]?.record).toBeNull();
    await expect(parseReceiptBatchReviewPage({ schema_version: 1, context_key: binding.contextKey,
      result_revision: 'revision-1', offset: 0, limit: 20, total: 2, next_offset: null,
      items: [{ original, record_revision: 0, record: null }] }, binding)).rejects.toThrow();
  });

  it('validates save responses as records and keeps the request codec edit-only', async () => {
    const { binding, original } = await bindingValue();
    const edit: ReceiptReviewEdit = {
      schema_version: 1, context_key: binding.contextKey, result_revision: 'revision-1', id: original.id,
      source_key: original.source_key, instance_id: original.instance_id, analysis_signature: original.analysis_signature,
      record_revision: 0, final_rect: structuredClone(original.candidate_rect), crop_mode: 'candidate',
      review_status: 'confirmed', manual_adjusted: false, reviewed_at: '2026-09-14T10:20:30.000Z',
    };
    const record = buildReceiptRecord(original, edit, SOURCE_PATH, SOURCE_SHA, 1);
    const result = await parseReceiptBatchSaveResult({ schema_version: 1, context_key: binding.contextKey,
      result_revision: 'revision-1', saved_count: 1, segments: [record] }, binding);
    expect(result.segments[0]?.record_revision).toBe(1);
    expect(() => validateReceiptBatchRequest({ op: 'batch_save_receipt_review', job_id: JOB_ID,
      result_revision: 'revision-1', edits: [edit], originals: [] })).toThrow();
  });

  it('preserves controlled page notices outside immutable originals and rejects unknown notice content', async () => {
    const { binding, original } = await bindingValue();
    const pageValue = (notice: unknown) => ({ schema_version: 1, context_key: binding.contextKey,
      result_revision: 'revision-1', offset: 0, limit: 20, total: 1, next_offset: null,
      items: [{ original, record_revision: 0, record: null, page_notice: notice }] });
    for (const document_type of ['loan_settlement_notice', 'loan_interest_notice', 'electronic_tax_payment', 'other_special']) {
      const page = await parseReceiptBatchReviewPage(pageValue({ code: 'special_document', document_type }), binding);
      expect(page.items[0].page_notice).toEqual({ code: 'special_document', document_type });
      expect(page.items[0].original).toEqual(original);
      expect('page_notice' in page.items[0].original).toBe(false);
    }
    for (const notice of [null, {}, { code: 'special_document', document_type: 'unknown' },
      { code: 'special_document', document_type: 'loan_interest_notice', text: 'untrusted source text' },
      { code: 'other', document_type: 'loan_interest_notice' }]) {
      await expect(parseReceiptBatchReviewPage(pageValue(notice), binding)).rejects.toThrow(/page_notice/);
    }
  });

  it('accepts only a text-free, non-special exclusion suggestion outside immutable originals', async () => {
    const { binding, original } = await bindingValue();
    const pageValue = (notice: unknown, extra: Record<string, unknown> = {}) => ({
      schema_version: 1, context_key: binding.contextKey, result_revision: 'revision-1',
      offset: 0, limit: 20, total: 1, next_offset: null,
      items: [{ original, record_revision: 0, record: null, exclusion_notice: notice, ...extra }],
    });
    const accepted = await parseReceiptBatchReviewPage(pageValue({ code: 'suspected_invalid_slot' }), binding);
    expect(accepted.items[0].exclusion_notice).toEqual({ code: 'suspected_invalid_slot' });
    expect(accepted.items[0].record).toBeNull();
    expect(accepted.items[0].original).toEqual(original);
    for (const notice of [null, {}, { code: 'other' },
      { code: 'suspected_invalid_slot', text: 'private source text' }]) {
      await expect(parseReceiptBatchReviewPage(pageValue(notice), binding)).rejects.toThrow(/exclusion_notice/);
    }
    await expect(parseReceiptBatchReviewPage(pageValue({ code: 'suspected_invalid_slot' },
      { page_notice: { code: 'special_document', document_type: 'loan_interest_notice' } }), binding))
      .rejects.toThrow(/exclusion_notice/);
  });

  it('requires the effective notice to agree with a saved manual classification', async () => {
    const { binding, original } = await bindingValue();
    const edit: ReceiptReviewEdit = {
      schema_version: 1, context_key: binding.contextKey, result_revision: 'revision-1', id: original.id,
      source_key: original.source_key, instance_id: original.instance_id, analysis_signature: original.analysis_signature,
      record_revision: 0, final_rect: original.candidate_rect, crop_mode: 'candidate', review_status: 'needs_review',
      manual_adjusted: false, reviewed_at: '2026-09-23T10:20:30.000Z', document_type: 'other_special',
    };
    const record = buildReceiptRecord(original, edit, SOURCE_PATH, SOURCE_SHA, 1);
    const page = { schema_version: 1, context_key: binding.contextKey, result_revision: 'revision-1',
      offset: 0, limit: 20, total: 1, next_offset: null,
      items: [{ original, record_revision: 1, record, page_notice: { code: 'special_document', document_type: 'other_special' } }] };
    expect((await parseReceiptBatchReviewPage(page, binding)).items[0].record?.document_type).toBe('other_special');
    await expect(parseReceiptBatchReviewPage({ ...page, items: [{ original, record_revision: 1, record }] }, binding)).rejects.toThrow('人工分类');
    const ordinary = buildReceiptRecord(original, { ...edit, document_type: 'ordinary' }, SOURCE_PATH, SOURCE_SHA, 1);
    await expect(parseReceiptBatchReviewPage({ ...page, items: [{ ...page.items[0], record: ordinary }] }, binding)).rejects.toThrow('人工分类');
    expect((await parseReceiptBatchReviewPage({ ...page, items: [{ original, record_revision: 1, record: ordinary }] }, binding)).items[0].page_notice).toBeUndefined();
  });

  it('enforces the bounded request payload', () => {
    expect(serializedReceiptBatchBytes({ op: 'batch_start', job_id: JOB_ID, generation: 1 })).toBeGreaterThan(0);
    expect(() => serializedReceiptBatchBytes({ huge: 'x'.repeat(4 * 1024 * 1024) })).toThrow(/4 MiB/);
  });
});
