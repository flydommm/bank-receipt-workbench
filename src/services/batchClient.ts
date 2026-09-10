import { invoke as tauriInvoke } from '@tauri-apps/api/core';

import {
  parseBatchControlResult,
  parseBatchJobSnapshot,
  parseBatchList,
  parseBatchResponse,
  parseBatchResultsPage,
  validateBatchRequest,
  type BatchControlRequest,
  type BatchControlResult,
  type BatchCreateRequest,
  type BatchJobSnapshot,
  type BatchListRequest,
  type BatchListResult,
  type BatchRelocateRequest,
  type BatchRequest,
  type BatchResponse,
  type BatchResultItem,
  type BatchResultsPage,
  type BatchResultsPageRequest,
  type BatchSnapshotRequest,
  type BatchStartRequest,
} from '../domain/batchTask';
import { BatchTaskValidationError } from '../domain/batchTask';
import {
  parseBatchCleanup,
  parseBatchCleanupList,
  parseBatchStorageMaintenance,
  parseBatchStorageUsage,
  validateBatchCleanupRequest,
  type BatchCleanup,
  type BatchCleanupListResult,
  type BatchCleanupRequest,
  type BatchStorageMaintenance,
  type BatchStorageUsage,
} from '../domain/batchCleanup';
import { validatePreparedReviewResponse, type EnginePreparedReview, type EngineReviewContext } from '../components/localEngineAdapter';
import type { OriginalReviewContext } from '../domain/reviewContext';
import { normalizeSourcePath } from '../domain/sourcePreview';

export type BatchInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type BatchOperationData = BatchJobSnapshot | BatchListResult | BatchControlResult | BatchResultsPage;

export class BatchClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BatchClientError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function defaultInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(command, args);
}

function abortError(): Error {
  const error = new Error('批任务操作已取消。');
  error.name = 'AbortError';
  return error;
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The caller may have started an invoke just before aborting (for
    // example, an injected test/runtime callback aborts synchronously).  A
    // rejected native Promise still needs a consumer even though the caller
    // no longer waits for its result.
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

function parseOperationData(request: BatchRequest, data: unknown): BatchOperationData {
  switch (request.op) {
    case 'batch_create':
    case 'batch_start':
    case 'batch_snapshot':
    case 'batch_relocate':
      return parseBatchJobSnapshot(data);
    case 'batch_list':
      return parseBatchList(data);
    case 'batch_control':
      return parseBatchControlResult(data);
    case 'batch_results_page':
      return parseBatchResultsPage(data, request.result_revision);
    default:
      throw new BatchTaskValidationError('任务操作无效。');
  }
}

function ensureOk<T>(response: BatchResponse<T>): T {
  if (response.status === 'error') throw new BatchClientError(response.code, response.message);
  return response.data;
}

export class BatchClient {
  private readonly invoke: BatchInvoke;

  constructor(invoke: BatchInvoke = defaultInvoke) {
    this.invoke = invoke;
  }

  /** Send one strictly typed public management request through the host. */
  async send(request: BatchRequest, signal?: AbortSignal): Promise<BatchResponse<BatchOperationData>> {
    const normalized = validateBatchRequest(request);
    const raw = await this.invokeRequest(normalized, signal);
    return parseBatchResponse(raw, (data) => parseOperationData(normalized, data));
  }

  private async invokeRequest(request: object, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(this.invoke<unknown>('batch_command', { request }));
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw error;
    }
    return withAbort(pending, signal);
  }

  private async sendCleanup<T>(
    request: BatchCleanupRequest,
    parseData: (data: unknown) => T,
    signal?: AbortSignal,
  ): Promise<BatchResponse<T>> {
    const normalized = validateBatchCleanupRequest(request);
    const raw = await this.invokeRequest(normalized, signal);
    return parseBatchResponse(raw, parseData);
  }

  /** The host prepares its stored manifest; no UI originals are sent as proof. */
  async prepareReview(job: BatchJobSnapshot, items: BatchResultItem[], signal?: AbortSignal): Promise<{
    original: OriginalReviewContext; prepared: EnginePreparedReview;
  }> {
    const captured = parseBatchJobSnapshot(job);
    if (!['ready_for_review', 'archived'].includes(captured.state)
      || !captured.result_revision || captured.deletion_pending) {
      throw new BatchClientError('batch_not_ready', '任务尚未完成，不能载入审核结果。');
    }
    const raw = await this.invokeRequest({ op: 'batch_prepare_review', job_id: captured.id,
      result_revision: captured.result_revision }, signal);
    // parseBatchResponse is intentionally synchronous: it validates the wire
    // envelope before the trusted review response performs its asynchronous
    // context digest.  Passing an async callback here would put a Promise in
    // `data` and let malformed review payloads escape the typed boundary.
    const response = parseBatchResponse(raw, (data) => data);
    const data = ensureOk(response);
    if (!data || typeof data !== 'object' || Object.keys(data).sort().join(',') !== 'context,prepared') {
      throw new BatchTaskValidationError('任务审核准备结果无效。');
    }
    const value = data as { context: EngineReviewContext; prepared: unknown };
    const context = value.context;
    if (!context || Object.keys(context).sort().join(',') !== 'computation_version,criteria_fingerprint,sources,version'
      || context.version !== 2 || context.computation_version !== captured.computation_version
      || context.criteria_fingerprint !== captured.criteria_fingerprint || !Array.isArray(context.sources)
      || context.sources.length !== captured.sources.length) {
      throw new BatchTaskValidationError('任务审核上下文与已保存的分析不一致。');
    }
    context.sources.forEach((source, index) => {
      const expected = captured.sources[index]!;
      if (!source || Object.keys(source).sort().join(',') !== 'source_key,source_path,source_sha256'
        || source.source_key !== expected.source_key || typeof source.source_path !== 'string'
        || normalizeSourcePath(source.source_path) !== normalizeSourcePath(expected.access_path)
        || source.source_sha256?.toLowerCase() !== expected.sha256?.toLowerCase()) {
        throw new BatchTaskValidationError('任务来源已变化，请重新载入。');
      }
    });
    const originals = items.map((item) => item.original);
    let prepared: EnginePreparedReview;
    try {
      prepared = await validatePreparedReviewResponse(value.prepared, context, originals, captured.result_revision);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw error;
    }
    if (signal?.aborted) throw abortError();
    return { original: { context, originals, resultRevision: captured.result_revision }, prepared };
  }

  async create(
    input: Omit<BatchCreateRequest, 'op'>,
    signal?: AbortSignal,
  ): Promise<BatchResponse<BatchJobSnapshot>> {
    const normalized: BatchCreateRequest = { op: 'batch_create', ...input };
    const response = await this.send(normalized, signal);
    return response as BatchResponse<BatchJobSnapshot>;
  }

  async start(
    input: Omit<BatchStartRequest, 'op'>,
    signal?: AbortSignal,
  ): Promise<BatchResponse<BatchJobSnapshot>> {
    const response = await this.send({ op: 'batch_start', ...input }, signal);
    return response as BatchResponse<BatchJobSnapshot>;
  }

  async snapshot(
    input: Omit<BatchSnapshotRequest, 'op'>,
    signal?: AbortSignal,
  ): Promise<BatchResponse<BatchJobSnapshot>> {
    const response = await this.send({ op: 'batch_snapshot', ...input }, signal);
    return response as BatchResponse<BatchJobSnapshot>;
  }

  async list(
    input: Omit<BatchListRequest, 'op'> = { offset: 0, limit: 50 },
    signal?: AbortSignal,
  ): Promise<BatchResponse<BatchListResult>> {
    const response = await this.send({ op: 'batch_list', ...input }, signal);
    return response as BatchResponse<BatchListResult>;
  }

  async control(
    input: Omit<BatchControlRequest, 'op'>,
    signal?: AbortSignal,
  ): Promise<BatchResponse<BatchControlResult>> {
    const response = await this.send({ op: 'batch_control', ...input }, signal);
    return response as BatchResponse<BatchControlResult>;
  }

  async resultsPage(
    input: Omit<BatchResultsPageRequest, 'op'>,
    signal?: AbortSignal,
  ): Promise<BatchResponse<BatchResultsPage>> {
    const response = await this.send({ op: 'batch_results_page', ...input }, signal);
    return response as BatchResponse<BatchResultsPage>;
  }

  async relocate(
    input: Omit<BatchRelocateRequest, 'op'>,
    signal?: AbortSignal,
  ): Promise<BatchResponse<BatchJobSnapshot>> {
    const response = await this.send({ op: 'batch_relocate', ...input }, signal);
    return response as BatchResponse<BatchJobSnapshot>;
  }

  /** Ask the host to calculate the deletion scope for one persisted task. */
  async planCleanup(jobId: string, signal?: AbortSignal): Promise<BatchResponse<BatchCleanup>> {
    return this.sendCleanup({ op: 'batch_cleanup_plan', job_id: jobId }, parseBatchCleanup, signal);
  }

  /** Execute a previously issued server-owned cleanup plan. */
  async executeCleanup(
    cleanupId: string,
    deleteReview: boolean,
    signal?: AbortSignal,
  ): Promise<BatchResponse<BatchCleanup>> {
    return this.sendCleanup({ op: 'batch_cleanup_execute', cleanup_id: cleanupId, delete_review: deleteReview },
      parseBatchCleanup, signal);
  }

  async listCleanups(
    offset = 0,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<BatchResponse<BatchCleanupListResult>> {
    return this.sendCleanup({ op: 'batch_cleanup_list', offset, limit },
      (data) => parseBatchCleanupList(data, offset), signal);
  }

  async storageUsage(signal?: AbortSignal): Promise<BatchResponse<BatchStorageUsage>> {
    return this.sendCleanup({ op: 'batch_storage_usage' }, parseBatchStorageUsage, signal);
  }

  async maintainStorage(signal?: AbortSignal): Promise<BatchResponse<BatchStorageMaintenance>> {
    return this.sendCleanup({ op: 'batch_storage_maintain' }, parseBatchStorageMaintenance, signal);
  }

  /**
   * Read every immutable result page for one revision.  The revision, total,
   * cursor and item identities are checked again across page boundaries so a
   * late response cannot silently mix two published snapshots.
   */
  async loadAllResults(
    jobId: string,
    resultRevision: string,
    signal?: AbortSignal,
  ): Promise<BatchResultItem[]> {
    let offset = 0;
    let total: number | null = null;
    const items: BatchResultItem[] = [];
    const ids = new Set<string>();

    while (true) {
      const response = await this.resultsPage({
        job_id: jobId,
        result_revision: resultRevision,
        offset,
        limit: 200,
      }, signal);
      const page = ensureOk(response);
      if (page.result_revision !== resultRevision) {
        throw new BatchClientError('batch_revision_changed', '任务结果版本已变化。');
      }
      if (total === null) total = page.total;
      if (page.total !== total || page.offset !== offset) {
        throw new BatchClientError('batch_results_inconsistent', '任务结果分页不一致。');
      }
      for (const item of page.items) {
        if (ids.has(item.segment.id)) {
          throw new BatchClientError('batch_results_duplicate', '任务结果包含重复片段。');
        }
        ids.add(item.segment.id);
        items.push(item);
      }
      if (items.length > 50_000) {
        throw new BatchClientError('batch_results_too_many', '任务结果数量超过限制。');
      }
      if (page.next_offset === null) {
        if (items.length !== total) throw new BatchClientError('batch_results_incomplete', '任务结果分页不完整。');
        return items;
      }
      if (page.next_offset !== offset + page.items.length || page.next_offset <= offset) {
        throw new BatchClientError('batch_results_cursor', '任务结果游标无效。');
      }
      offset = page.next_offset;
    }
  }
}

export function createBatchClient(invoke: BatchInvoke = defaultInvoke): BatchClient {
  return new BatchClient(invoke);
}
