import { describe, expect, it, vi } from 'vitest';
import { ReceiptBatchController, receiptBatchIsActive } from './receiptBatchController';
import type { ReceiptBatchClient } from './receiptBatchClient';
import type { ReceiptBatchJobSnapshot } from '../domain/receiptBatch';

const job = (state: ReceiptBatchJobSnapshot['state']): ReceiptBatchJobSnapshot => ({
  id: 'job-1', name: 'demo', generation: 1, state, resume_target: null,
  criteria: null, criteria_fingerprint: ''.padEnd(64, '0'), match_mode: 'exact', computation_version: 'v1',
  result_revision: '1', owner: 'local', error: null, created_at: '1', updated_at: '1',
  deletion_pending: false, page_summary: { pending: 0, processing: 0, succeeded: 1, failed: 0 }, total_pages: 1,
  page_result_schema: 2, processing_options: { processing_mode: 'split_all', criteria: null }, sources: [],
});

describe('ReceiptBatchController', () => {
  it('creates and starts a schema-2 job, exposing a ready snapshot', async () => {
    const client = {
      create: vi.fn().mockResolvedValue({ status: 'ok', data: job('queued') }),
      start: vi.fn().mockResolvedValue({ status: 'ok', data: job('ready_for_review') }),
    } as unknown as ReceiptBatchClient;
    const controller = new ReceiptBatchController(client);
    const result = await controller.createAndStart({
      name: 'demo', sources: [{ source_path: 'C:/demo.pdf', name: 'demo.pdf' }],
      processing_options: { processing_mode: 'split_all', criteria: null }, match_mode: 'exact',
    });
    expect(result?.state).toBe('ready_for_review');
    expect(controller.getSnapshot().phase).toBe('ready');
    expect(controller.getSnapshot().busy).toBe(false);
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.start).toHaveBeenCalledWith({ job_id: 'job-1', generation: 1 }, expect.anything());
  });

  it('recognises only non-terminal running states as active', () => {
    expect(receiptBatchIsActive(job('running'))).toBe(true);
    expect(receiptBatchIsActive(job('paused'))).toBe(false);
    expect(receiptBatchIsActive(job('ready_for_review'))).toBe(false);
  });

  it('clears the previous result before a new source set is analysed', async () => {
    const client = {
      create: vi.fn()
        .mockResolvedValueOnce({ status: 'ok', data: job('queued') })
        .mockResolvedValueOnce({ status: 'ok', data: { ...job('queued'), id: 'job-2' } }),
      start: vi.fn()
        .mockResolvedValueOnce({ status: 'ok', data: job('ready_for_review') })
        .mockResolvedValueOnce({ status: 'ok', data: { ...job('ready_for_review'), id: 'job-2' } }),
    } as unknown as ReceiptBatchClient;
    const controller = new ReceiptBatchController(client);
    const options = { processing_mode: 'search' as const, criteria: { include: ['手续费'], includeMode: 'all' as const, exclude: [] } };

    await controller.createAndStart({
      name: '华夏银行.pdf', sources: [{ source_path: 'C:/华夏银行.pdf', name: '华夏银行.pdf' }],
      processing_options: options, match_mode: 'exact',
    });
    expect(controller.getSnapshot().job?.id).toBe('job-1');

    controller.clear();
    expect(controller.getSnapshot()).toMatchObject({ job: null, phase: 'idle', busy: false, error: null });

    await controller.createAndStart({
      name: '宝生村镇银行.pdf', sources: [{ source_path: 'C:/宝生村镇银行.pdf', name: '宝生村镇银行.pdf' }],
      processing_options: options, match_mode: 'exact',
    });
    expect(controller.getSnapshot().job?.id).toBe('job-2');
    expect(client.create).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ sources: [{ source_path: 'C:/宝生村镇银行.pdf', name: '宝生村镇银行.pdf' }] }),
      expect.anything(),
    );
  });
});
