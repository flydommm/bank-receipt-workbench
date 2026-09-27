import { localEngineAdapter, type EnginePagePreview } from '../components/localEngineAdapter';

export type PdfThumbnailRequest = {
  path: string;
  sha: string;
  page: number;
  pageCount: number;
  width?: number;
  height?: number;
};

export type PdfThumbnailRenderer = (request: PdfThumbnailRequest) => Promise<EnginePagePreview>;
export type PdfThumbnailCacheOptions = { maxEntries?: number; maxBytes?: number };

type Subscriber = {
  request: PdfThumbnailRequest;
  resolve: (value: EnginePagePreview) => void;
  reject: (error: unknown) => void;
  detach: () => void;
};

type PendingThumbnail = {
  key: string;
  request: PdfThumbnailRequest;
  subscribers: Set<Subscriber>;
};

const defaultRenderer: PdfThumbnailRenderer = ({ path, page, sha }) => (
  localEngineAdapter.renderPage(path, page, sha, 'thumbnail')
);
const pageKey = ({ path, sha, page }: PdfThumbnailRequest): string => JSON.stringify([path, sha, page]);
const abortError = (): DOMException => new DOMException('缩略图请求已取消。', 'AbortError');
const changedError = (): Error => new Error('页面尺寸或来源已变化，请重新载入结果。');
const positiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function validateRequest(request: PdfThumbnailRequest): void {
  if (typeof request.path !== 'string' || !request.path.trim() || request.path.includes('\0')
    || typeof request.sha !== 'string' || !/^[a-f0-9]{64}$/i.test(request.sha)
    || !Number.isSafeInteger(request.page) || request.page < 1
    || !Number.isSafeInteger(request.pageCount) || request.pageCount < request.page
    || (request.width !== undefined && !positiveNumber(request.width))
    || (request.height !== undefined && !positiveNumber(request.height))) {
    throw new Error('缩略图页面请求无效。');
  }
}

function validatePreview(value: EnginePagePreview, request: PdfThumbnailRequest): void {
  if (!value || value.status !== 'ok' || value.source_sha256 !== request.sha || value.page !== request.page
    || value.page_count !== request.pageCount || !Number.isSafeInteger(value.page_count)
    || !positiveNumber(value.page_width) || !positiveNumber(value.page_height)
    || (request.width !== undefined && Math.abs(value.page_width - request.width) > 0.5)
    || (request.height !== undefined && Math.abs(value.page_height - request.height) > 0.5)
    || typeof value.image_data !== 'string' || !value.image_data.startsWith('data:image/png;base64,')
    || value.image_data.length <= 'data:image/png;base64,'.length) {
    throw changedError();
  }
}

function cacheLimit(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

/** A grid owns this transient full-page image cache; crop overlays never enter its key. */
export class PdfThumbnailCache {
  private readonly images = new Map<string, EnginePagePreview>();
  private readonly pending = new Map<string, PendingThumbnail>();
  private readonly queue: PendingThumbnail[] = [];
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;
  private running: PendingThumbnail | null = null;
  private disposed = false;

  constructor(private readonly renderer: PdfThumbnailRenderer = defaultRenderer, options: PdfThumbnailCacheOptions = {}) {
    this.maxEntries = cacheLimit(options.maxEntries, 64);
    this.maxBytes = cacheLimit(options.maxBytes, 16 * 1024 * 1024);
  }

  load(request: PdfThumbnailRequest, signal?: AbortSignal): Promise<EnginePagePreview> {
    if (this.disposed || signal?.aborted) return Promise.reject(abortError());
    try { validateRequest(request); }
    catch (error) { return Promise.reject(error); }
    const snapshot = { ...request };
    const key = pageKey(snapshot);
    const cached = this.images.get(key);
    if (cached) {
      try { validatePreview(cached, snapshot); }
      catch (error) { return Promise.reject(error); }
      // Touch while this entry is still present; delivery must never resurrect an evicted image.
      this.images.delete(key);
      this.images.set(key, cached);
      // Check again in the delivery microtask so disposal/abort cannot deliver an old hit.
      return Promise.resolve().then(() => {
        if (this.disposed || signal?.aborted) throw abortError();
        return { ...cached };
      });
    }
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { key, request: snapshot, subscribers: new Set() };
      this.pending.set(key, entry);
      this.queue.push(entry);
    }
    const current = entry;
    const promise = new Promise<EnginePagePreview>((resolve, reject) => {
      const subscriber: Subscriber = { request: snapshot, resolve, reject, detach: () => {} };
      const onAbort = () => {
        subscriber.detach();
        current.subscribers.delete(subscriber);
        reject(abortError());
        if (current.subscribers.size === 0 && this.running !== current) {
          this.pending.delete(current.key);
          const index = this.queue.indexOf(current);
          if (index >= 0) this.queue.splice(index, 1);
        }
      };
      subscriber.detach = () => signal?.removeEventListener('abort', onAbort);
      current.subscribers.add(subscriber);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    this.startNext();
    return promise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.pending.values()) this.reject(entry, abortError());
    this.pending.clear();
    this.queue.length = 0;
    this.images.clear();
    this.bytes = 0;
  }

  private startNext(): void {
    if (this.disposed || this.running) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.running = entry;
    let result: Promise<EnginePagePreview>;
    try { result = this.renderer({ ...entry.request }); }
    catch (error) { result = Promise.reject(error); }
    void Promise.resolve(result).then((value) => {
      let accepted = false;
      for (const subscriber of entry.subscribers) {
        subscriber.detach();
        try {
          if (this.disposed) throw abortError();
          validatePreview(value, subscriber.request);
          subscriber.resolve({ ...value });
          accepted = true;
        } catch (error) { subscriber.reject(error); }
      }
      entry.subscribers.clear();
      if (accepted) this.remember(entry.key, value);
      this.finish(entry);
    }, (error: unknown) => {
      this.reject(entry, error);
      this.finish(entry);
    });
  }

  private reject(entry: PendingThumbnail, error: unknown): void {
    for (const subscriber of entry.subscribers) {
      subscriber.detach();
      subscriber.reject(error);
    }
    entry.subscribers.clear();
  }

  private finish(entry: PendingThumbnail): void {
    this.pending.delete(entry.key);
    this.running = null;
    this.startNext();
  }

  private remember(key: string, value: EnginePagePreview): void {
    const bytes = value.image_data.length * 2;
    if (this.disposed || bytes > this.maxBytes || this.maxEntries < 1) return;
    this.images.set(key, { ...value });
    this.bytes += bytes;
    while (this.images.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.images.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.images.get(oldest)!.image_data.length * 2;
      this.images.delete(oldest);
    }
  }
}
