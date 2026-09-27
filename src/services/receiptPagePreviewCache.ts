import type { EnginePagePreview } from '../components/localEngineAdapter';

export type ReceiptPageRequest = {
  path: string; sha: string; page: number; pageCount: number; width?: number; height?: number; retry: number;
};

export const receiptPageKey = (request: ReceiptPageRequest): string => JSON.stringify([
  request.path, request.sha, request.page, request.pageCount, request.width, request.height, request.retry,
]);

export class SupersededReceiptPreview extends Error {
  constructor() { super('页面预览请求已取消。'); }
}

type PendingPage = {
  key: string; request: ReceiptPageRequest; promise: Promise<EnginePagePreview>;
  resolve: (value: EnginePagePreview) => void; reject: (error: unknown) => void;
};

/** Component-local image cache: one running render and only the latest waiting page. */
export class ReceiptPagePreviewCache {
  private readonly images = new Map<string, EnginePagePreview>();
  private bytes = 0;
  private running: PendingPage | null = null;
  private waiting: PendingPage | null = null;
  private disposed = false;

  constructor(
    private readonly render: (request: ReceiptPageRequest) => Promise<EnginePagePreview>,
    private readonly limits = { entries: 4, bytes: 32 * 1024 * 1024 },
  ) {}

  load(request: ReceiptPageRequest): Promise<EnginePagePreview> {
    if (this.disposed) return Promise.reject(new SupersededReceiptPreview());
    const key = receiptPageKey(request);
    if (this.waiting?.key !== key) this.cancelWaiting();
    const cached = this.images.get(key);
    if (cached) {
      this.images.delete(key);
      this.images.set(key, cached);
      return Promise.resolve(cached);
    }
    if (this.running?.key === key) return this.running.promise;
    if (this.waiting?.key === key) return this.waiting.promise;
    let resolve!: PendingPage['resolve'], reject!: PendingPage['reject'];
    const promise = new Promise<EnginePagePreview>((yes, no) => { resolve = yes; reject = no; });
    const entry = { key, request: { ...request }, promise, resolve, reject };
    if (this.running) this.waiting = entry;
    else this.start(entry);
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelWaiting();
    this.running?.reject(new SupersededReceiptPreview());
    this.images.clear();
    this.bytes = 0;
  }

  private cancelWaiting(): void {
    this.waiting?.reject(new SupersededReceiptPreview());
    this.waiting = null;
  }

  private start(entry: PendingPage): void {
    this.running = entry;
    let result: Promise<EnginePagePreview>;
    try { result = this.render(entry.request); }
    catch (error) { result = Promise.reject(error); }
    void Promise.resolve(result).then((value) => {
      try {
        if (this.disposed) throw new SupersededReceiptPreview();
        const request = entry.request;
        if (value.source_sha256 !== request.sha || value.page !== request.page || value.page_count !== request.pageCount
          || !Number.isFinite(value.page_width) || value.page_width <= 0 || !Number.isFinite(value.page_height) || value.page_height <= 0
          || request.width !== undefined && Math.abs(value.page_width - request.width) > 0.5
          || request.height !== undefined && Math.abs(value.page_height - request.height) > 0.5) {
          throw new Error('页面尺寸或来源已变化，请重新载入结果。');
        }
        this.remember(entry.key, value);
        entry.resolve(value);
      } catch (error) { entry.reject(error); }
      this.finish(entry);
    }, (error: unknown) => { entry.reject(error); this.finish(entry); });
  }

  private finish(entry: PendingPage): void {
    if (this.running !== entry) return;
    this.running = null;
    const next = this.waiting;
    this.waiting = null;
    if (next && !this.disposed) this.start(next);
  }

  private remember(key: string, value: EnginePagePreview): void {
    const bytes = value.image_data.length * 2;
    if (bytes > this.limits.bytes || this.limits.entries < 1) return;
    this.images.set(key, value);
    this.bytes += bytes;
    while (this.images.size > this.limits.entries || this.bytes > this.limits.bytes) {
      const oldest = this.images.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.images.get(oldest)!.image_data.length * 2;
      this.images.delete(oldest);
    }
  }
}
