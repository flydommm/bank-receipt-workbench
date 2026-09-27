import { invoke as tauriInvoke } from '@tauri-apps/api/core';

import {
  parseReceiptBatchControlResult,
  parseReceiptBatchJobSnapshot,
  parseReceiptBatchList,
  parseReceiptBatchPreparedReview,
  parseReceiptBatchResponse,
  parseReceiptBatchResultsPage,
  parseReceiptBatchReviewPage,
  parseReceiptBatchSaveResult,
  serializedReceiptBatchBytes,
  validateReceiptBatchEdits,
  validateReceiptBatchRequest,
  type ReceiptBatchControlResult,
  type ReceiptBatchCreateRequest,
  type ReceiptBatchJobSnapshot,
  type ReceiptBatchListRequest,
  type ReceiptBatchListResult,
  type ReceiptBatchPreparedReview,
  type ReceiptBatchRelocateRequest,
  type ReceiptBatchRequest,
  type ReceiptBatchResponse,
  type ReceiptBatchResultsPage,
  type ReceiptBatchResultsPageRequest,
  type ReceiptBatchReviewPage,
  type ReceiptBatchReviewPageItem,
  type ReceiptBatchReviewPageRequest,
  type ReceiptBatchSaveReviewResult,
  type ReceiptBatchSnapshotRequest,
  type ReceiptBatchStartRequest,
  type ReceiptBatchControlRequest,
  type ReceiptBatchReviewBinding,
  type ReceiptBatchSaveReviewRequest,
  type ReceiptSnapshotItem,
} from '../domain/receiptBatch';

export type ReceiptBatchInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class ReceiptBatchClientError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ReceiptBatchClientError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function defaultInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(command, args);
}

function abortError(): Error {
  const error = new Error('回单批任务操作已取消。');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.then(() => undefined, () => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function ensureOk<T>(response: ReceiptBatchResponse<T>): T {
  if (response.status === 'error') throw new ReceiptBatchClientError(response.code, response.message);
  return response.data;
}

function errorOr<T>(response: ReceiptBatchResponse<unknown>, data: T): ReceiptBatchResponse<T> {
  return response.status === 'error' ? response : { status: 'ok', data };
}

export class ReceiptBatchClient {
  private readonly invoke: ReceiptBatchInvoke;

  constructor(invoke: ReceiptBatchInvoke = defaultInvoke) {
    this.invoke = invoke;
  }

  /** Send a public receipt-batch request. Private database paths are host-owned. */
  async send(request: ReceiptBatchRequest, signal?: AbortSignal): Promise<ReceiptBatchResponse<unknown>> {
    const normalized = validateReceiptBatchRequest(request);
    serializedReceiptBatchBytes({ request: normalized });
    throwIfAborted(signal);
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(this.invoke<unknown>('batch_command', { request: normalized }));
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw error;
    }
    const raw = await withAbort(pending, signal);
    throwIfAborted(signal);
    return parseReceiptBatchResponse(raw);
  }

  async create(
    input: Omit<ReceiptBatchCreateRequest, 'op'>,
    signal?: AbortSignal,
  ): Promise<ReceiptBatchResponse<ReceiptBatchJobSnapshot>> {
    const response = await this.send({ op: 'batch_create_receipts', ...input }, signal);
    if (response.status === 'error') return response;
    const job = await parseReceiptBatchJobSnapshot(response.data);
    throwIfAborted(signal);
    return errorOr(response, job);
  }

  async createReceiptJob(
    input: Omit<ReceiptBatchCreateRequest, 'op'>,
    signal?: AbortSignal,
  ): Promise<ReceiptBatchResponse<ReceiptBatchJobSnapshot>> {
    return this.create(input, signal);
  }

  async start(
    input: Omit<ReceiptBatchStartRequest, 'op'>,
    signal?: AbortSignal,
  ): Promise<ReceiptBatchResponse<ReceiptBatchJobSnapshot>> {
    const response = await this.send({ op: 'batch_start', ...input }, signal);
    if (response.status === 'error') return response;
    const job = await parseReceiptBatchJobSnapshot(response.data);
    throwIfAborted(signal);
    return errorOr(response, job);
  }

  async snapshot(
    input: Omit<ReceiptBatchSnapshotRequest, 'op'>,
    signal?: AbortSignal,
  ): Promise<ReceiptBatchResponse<ReceiptBatchJobSnapshot>> {
    const response = await this.send({ op: 'batch_snapshot', ...input }, signal);
    if (response.status === 'error') return response;
    const job = await parseReceiptBatchJobSnapshot(response.data);
    throwIfAborted(signal);
    return errorOr(response, job);
  }

  async list(
    input: Omit<ReceiptBatchListRequest, 'op'> = { offset: 0, limit: 50 },
    signal?: AbortSignal,
  ): Promise<ReceiptBatchResponse<ReceiptBatchListResult>> {
    const response = await this.send({ op: 'batch_list', ...input }, signal);
    if (response.status === 'error') return response;
    const list = await parseReceiptBatchList(response.data);
    throwIfAborted(signal);
    return errorOr(response, list);
  }

  async control(
    input: Omit<ReceiptBatchControlRequest, 'op'>,
    signal?: AbortSignal,
  ): Promise<ReceiptBatchResponse<ReceiptBatchControlResult>> {
    const response = await this.send({ op: 'batch_control', ...input }, signal);
    if (response.status === 'error') return response;
    const result = parseReceiptBatchControlResult(response.data);
    throwIfAborted(signal);
    return errorOr(response, result);
  }

  async relocate(
    input: Omit<ReceiptBatchRelocateRequest, 'op'>,
    signal?: AbortSignal,
  ): Promise<ReceiptBatchResponse<ReceiptBatchJobSnapshot>> {
    const response = await this.send({ op: 'batch_relocate', ...input }, signal);
    if (response.status === 'error') return response;
    const job = await parseReceiptBatchJobSnapshot(response.data);
    throwIfAborted(signal);
    return errorOr(response, job);
  }

  /** Parse schema-2 result pages against the immutable job source binding. */
  async resultsPage(
    input: Omit<ReceiptBatchResultsPageRequest, 'op'>,
    job: ReceiptBatchJobSnapshot,
    signal?: AbortSignal,
  ): Promise<ReceiptBatchResponse<ReceiptBatchResultsPage>> {
    const response = await this.send({ op: 'batch_results_page', ...input }, signal);
    if (response.status === 'error') return response;
    const page = await parseReceiptBatchResultsPage(response.data, job, input.result_revision);
    throwIfAborted(signal);
    return errorOr(response, page);
  }

  /** Read all immutable schema-2 pages while checking revision and identity continuity. */
  async loadAllResults(
    job: ReceiptBatchJobSnapshot,
    signal?: AbortSignal,
  ): Promise<ReceiptSnapshotItem[]> {
    let offset = 0;
    let total: number | null = null;
    const result: ReceiptSnapshotItem[] = [];
    const ids = new Set<string>();
    if (!job.result_revision) throw new ReceiptBatchClientError('batch_not_ready', '任务没有可读取的结果版本。');
    while (true) {
      const response = await this.resultsPage({ job_id: job.id, result_revision: job.result_revision, offset, limit: 200 }, job, signal);
      const page = ensureOk(response);
      if (total === null) total = page.total;
      if (page.total !== total || page.offset !== offset || page.result_revision !== job.result_revision) {
        throw new ReceiptBatchClientError('batch_changed', '回单结果分页在读取期间发生变化。');
      }
      for (const item of page.items) {
        if (ids.has(item.segment.id)) throw new ReceiptBatchClientError('batch_corrupt', '回单结果包含重复片段。');
        ids.add(item.segment.id);
        result.push(item);
      }
      if (page.next_offset === null) break;
      offset = page.next_offset;
      throwIfAborted(signal);
    }
    if (total !== result.length) throw new ReceiptBatchClientError('batch_corrupt', '回单结果总数与分页不一致。');
    return result;
  }

  /** Prepare only the server-owned context and review acknowledgement. */
  async prepareReview(
    job: ReceiptBatchJobSnapshot,
    signal?: AbortSignal,
  ): Promise<ReceiptBatchPreparedReview> {
    if (!['ready_for_review', 'archived'].includes(job.state) || !job.result_revision || job.deletion_pending) {
      throw new ReceiptBatchClientError('batch_not_ready', '任务尚未完成，不能载入回单审核结果。');
    }
    const response = await this.send({ op: 'batch_prepare_review', job_id: job.id, result_revision: job.result_revision }, signal);
    const data = ensureOk(response);
    const prepared = await parseReceiptBatchPreparedReview(data, job);
    // Context validation performs asynchronous SHA-256 work.  The abort check
    // here prevents a late digest from being adopted as the active session.
    throwIfAborted(signal);
    return prepared;
  }

  async readReviewPage(
    prepared: ReceiptBatchPreparedReview,
    offset = 0,
    limit = 200,
    signal?: AbortSignal,
  ): Promise<ReceiptBatchResponse<ReceiptBatchReviewPage>> {
    const binding = prepared.binding;
    const request: ReceiptBatchReviewPageRequest = {
      op: 'batch_receipt_review_page', job_id: binding.job.id,
      result_revision: prepared.prepared.result_revision, offset, limit,
    };
    const response = await this.send(request, signal);
    if (response.status === 'error') return response;
    const page = await parseReceiptBatchReviewPage(response.data, binding);
    throwIfAborted(signal);
    return errorOr(response, page);
  }

  /** Resume a prepared review from page zero without re-preparing its context. */
  async loadAllReviewPages(
    prepared: ReceiptBatchPreparedReview,
    signal?: AbortSignal,
  ): Promise<ReceiptBatchReviewPageItem[]> {
    let offset = 0;
    let total: number | null = null;
    const result: ReceiptBatchReviewPageItem[] = [];
    const ids = new Set<string>();
    while (true) {
      const response = await this.readReviewPage(prepared, offset, 200, signal);
      const page = ensureOk(response);
      if (total === null) total = page.total;
      if (page.total !== total || page.offset !== offset
        || page.result_revision !== prepared.prepared.result_revision
        || page.context_key !== prepared.prepared.context_key) {
        throw new ReceiptBatchClientError('batch_changed', '回单审核分页在读取期间发生变化。');
      }
      for (const item of page.items) {
        if (ids.has(item.original.id)) throw new ReceiptBatchClientError('batch_corrupt', '回单审核页包含重复片段。');
        ids.add(item.original.id);
        result.push(item);
      }
      if (page.next_offset === null) break;
      offset = page.next_offset;
      throwIfAborted(signal);
    }
    if (total !== result.length) throw new ReceiptBatchClientError('batch_corrupt', '回单审核总数与分页不一致。');
    return result;
  }

  async saveReview(
    prepared: ReceiptBatchPreparedReview,
    edits: ReceiptBatchSaveReviewRequest['edits'],
    signal?: AbortSignal,
  ): Promise<ReceiptBatchResponse<ReceiptBatchSaveReviewResult>> {
    const binding: ReceiptBatchReviewBinding = prepared.binding;
    const normalizedEdits = await validateReceiptBatchEdits(edits, binding);
    throwIfAborted(signal);
    const response = await this.send({
      op: 'batch_save_receipt_review', job_id: binding.job.id,
      result_revision: prepared.prepared.result_revision, edits: normalizedEdits,
    }, signal);
    if (response.status === 'error') return response;
    const result = await parseReceiptBatchSaveResult(response.data, binding);
    throwIfAborted(signal);
    return errorOr(response, result);
  }
}
