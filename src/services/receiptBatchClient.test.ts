// @vitest-environment jsdom
// @ts-expect-error The test runtime exposes Node crypto without @types/node.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildReceiptRecord,
  computeReceiptProcessingFingerprint,
  makeReceiptInstanceId,
  validateReceiptContext,
  type ReceiptReviewEdit,
  type ReceiptReviewOriginal,
} from '../domain/receiptReview';
import { parseReceiptBatchPreparedReview, type ReceiptBatchJobSnapshot } from '../domain/receiptBatch';
import { ReceiptBatchClient } from './receiptBatchClient';

const SOURCE_SHA = 'a'.repeat(64);
const LAYOUT_SHA = 'b'.repeat(64);
const ANALYSIS_SHA = 'c'.repeat(64);
const SOURCE_KEY = 'c:/documents/report.pdf';
const SOURCE_PATH = 'C:/Documents/report.pdf';
const JOB_ID = 'job-receipt-1';
const SOURCE_ID = 'source-1';
const OPTIONS = { processing_mode: 'search' as const, criteria: { include: ['手续费'], includeMode: 'all' as const, exclude: [] } };

function pages() { return { pending: 0, processing: 0, succeeded: 1, failed: 0 }; }
function budget() { return { processed_pages: 1, text_characters: 10, fuzzy_work: 0, matches: 1, matched_text_characters: 3 }; }

async function digest(value: unknown): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function jobValue(): Promise<ReceiptBatchJobSnapshot> {
  return {
    id: JOB_ID, name: '回单任务', generation: 1, state: 'ready_for_review', resume_target: null,
    criteria: OPTIONS.criteria, page_result_schema: 2, processing_options: OPTIONS,
    criteria_fingerprint: await computeReceiptProcessingFingerprint(OPTIONS, 'exact'), match_mode: 'exact',
    computation_version: 'receipt-engine-v3', result_revision: 'revision-1', owner: null, error: null,
    created_at: '2026-09-14T00:00:00Z', updated_at: '2026-09-14T00:00:01Z', deletion_pending: false,
    page_summary: pages(), total_pages: 1,
    sources: [{ source_id: SOURCE_ID, position: 0, source_key: SOURCE_KEY, initial_path: SOURCE_PATH,
      access_path: SOURCE_PATH, name: 'report.pdf', sha256: SOURCE_SHA, size_bytes: 1234, page_count: 1,
      state: 'verified', error: null, budget: budget(), verified_generation: 1, page_summary: pages() }],
  };
}

async function preparedValue(job: ReceiptBatchJobSnapshot) {
  const context = { version: 3 as const, sources: [{ source_key: SOURCE_KEY, source_path: SOURCE_PATH, source_sha256: SOURCE_SHA }],
    processing_options: OPTIONS, match_mode: 'exact' as const, criteria_fingerprint: job.criteria_fingerprint,
    computation_version: job.computation_version };
  const checked = await validateReceiptContext(context, { trustedAliases: true });
  return parseReceiptBatchPreparedReview({ context, prepared: { status: 'ok', schema_version: 1,
    context_key: checked.contextKey, result_revision: 'revision-1', total: 1 } }, job);
}

async function originalValue(): Promise<ReceiptReviewOriginal> {
  const instanceId = makeReceiptInstanceId(SOURCE_SHA, 1, 'layout-report', 1, 'slot-1');
  return { id: await digest([JOB_ID, SOURCE_ID, instanceId]), source_key: SOURCE_KEY, source_page: 1,
    instance_id: instanceId, slot_id: 'slot-1', position_index: 1, layout_id: 'layout-report', layout_revision: 1,
    layout_signature: LAYOUT_SHA, page_geometry: { pdf_box: { x0: 0, y0: 0, x1: 600, y1: 900 }, rotation: 0,
      user_unit: 1, width_pt: 600, height_pt: 900 }, candidate_rect: { x0: 0, y0: 600, x1: 600, y1: 900 },
    occupancy: 'occupied', selection_basis: 'keyword', needs_review: false, analysis_signature: ANALYSIS_SHA };
}

describe('receipt batch client protocol', () => {
  beforeEach(() => vi.stubGlobal('crypto', webcrypto));
  afterEach(() => vi.unstubAllGlobals());

  it('prepares only the job revision and asynchronously validates context binding', async () => {
    const job = await jobValue();
    const prepared = await preparedValue(job);
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data: {
      context: prepared.context,
      prepared: prepared.prepared,
    } });
    const result = await new ReceiptBatchClient(invoke).prepareReview(job);
    expect(result.binding.contextKey).toBe(prepared.binding.contextKey);
    expect(invoke).toHaveBeenCalledWith('batch_command', { request: {
      op: 'batch_prepare_review', job_id: JOB_ID, result_revision: 'revision-1',
    } });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('review_database_path');
  });

  it('reads a bounded review page without preparing again', async () => {
    const job = await jobValue();
    const prepared = await preparedValue(job);
    const original = await originalValue();
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data: {
      schema_version: 1, context_key: prepared.binding.contextKey, result_revision: 'revision-1',
      offset: 0, limit: 20, total: 1, next_offset: null,
      items: [{ original, record_revision: 0, record: null }],
    } });
    const result = await new ReceiptBatchClient(invoke).readReviewPage(prepared, 0, 20);
    expect(result).toMatchObject({ status: 'ok', data: { items: [{ record: null }] } });
    expect(invoke).toHaveBeenCalledWith('batch_command', { request: {
      op: 'batch_receipt_review_page', job_id: JOB_ID, result_revision: 'revision-1', offset: 0, limit: 20,
    } });
  });

  it('saves edit-only requests and returns the server records', async () => {
    const job = await jobValue();
    const prepared = await preparedValue(job);
    const original = await originalValue();
    const edit: ReceiptReviewEdit = { schema_version: 1, context_key: prepared.binding.contextKey,
      result_revision: 'revision-1', id: original.id, source_key: original.source_key, instance_id: original.instance_id,
      analysis_signature: original.analysis_signature, record_revision: 0, final_rect: original.candidate_rect,
      crop_mode: 'candidate', review_status: 'confirmed', manual_adjusted: false, reviewed_at: '2026-09-14T10:20:30.000Z' };
    const record = buildReceiptRecord(original, edit, SOURCE_PATH, SOURCE_SHA, 1);
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data: {
      schema_version: 1, context_key: prepared.binding.contextKey, result_revision: 'revision-1', saved_count: 1,
      segments: [record],
    } });
    const result = await new ReceiptBatchClient(invoke).saveReview(prepared, [edit]);
    expect(result).toMatchObject({ status: 'ok', data: { saved_count: 1, segments: [{ record_revision: 1 }] } });
    expect(invoke).toHaveBeenCalledWith('batch_command', { request: {
      op: 'batch_save_receipt_review', job_id: JOB_ID, result_revision: 'revision-1', edits: [edit],
    } });
    const requestText = JSON.stringify(invoke.mock.calls);
    expect(requestText).not.toContain('confirm_group');
    expect(requestText).not.toContain('originals');
    expect(requestText).not.toContain('review_database_path');
  });

  it('does not retry a CAS conflict and reports an abort after asynchronous validation', async () => {
    const job = await jobValue();
    const prepared = await preparedValue(job);
    const invoke = vi.fn().mockResolvedValue({ status: 'error', code: 'batch_conflict', message: '版本已变化' });
    const result = await new ReceiptBatchClient(invoke).saveReview(prepared, []);
    expect(result).toEqual({ status: 'error', code: 'batch_conflict', message: '版本已变化' });
    expect(invoke).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    await expect(new ReceiptBatchClient(vi.fn()).readReviewPage(prepared, 0, 20, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
