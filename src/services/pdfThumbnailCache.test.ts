import { describe, expect, it, vi } from 'vitest';
import { localEngineAdapter, type EnginePagePreview } from '../components/localEngineAdapter';
import { PdfThumbnailCache, type PdfThumbnailRequest } from './pdfThumbnailCache';

const request = (page = 1): PdfThumbnailRequest => ({ path: '/source.pdf', sha: 'a'.repeat(64), page,
  pageCount: 8, width: 600, height: 900 });
const image = (value = request()): EnginePagePreview => ({ status: 'ok', page: value.page, page_count: value.pageCount,
  source_sha256: value.sha, page_width: value.width ?? 600, page_height: value.height ?? 900,
  image_data: `data:image/png;base64,page${value.page}` });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('PDF thumbnail cache', () => {
  it('uses thumbnail quality in the default renderer', async () => {
    const render = vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValueOnce(image());
    try {
      await new PdfThumbnailCache().load(request());
      expect(render).toHaveBeenCalledWith('/source.pdf', 1, 'a'.repeat(64), 'thumbnail');
    } finally { render.mockRestore(); }
  });

  it('shares one running page and renders distinct queued pages serially', async () => {
    const first = deferred<EnginePagePreview>();
    const second = deferred<EnginePagePreview>();
    const render = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      .mockImplementation(async (value: PdfThumbnailRequest) => image(value));
    const cache = new PdfThumbnailCache(render);
    const a = cache.load(request());
    const b = cache.load(request());
    const c = cache.load(request(2));
    const d = cache.load(request(3));
    expect(render).toHaveBeenCalledTimes(1);
    first.resolve(image());
    expect(await a).toEqual(await b);
    expect(render).toHaveBeenCalledTimes(2);
    second.resolve(image(request(2)));
    await c;
    expect((await d).page).toBe(3);
    await cache.load(request());
    expect(render.mock.calls.map(([value]) => value.page)).toEqual([1, 2, 3]);
  });

  it('cancels subscribers independently and skips queued pages without subscribers', async () => {
    const first = deferred<EnginePagePreview>();
    const render = vi.fn().mockReturnValueOnce(first.promise).mockImplementation(async (value) => image(value));
    const cache = new PdfThumbnailCache(render);
    const controller = new AbortController();
    const other = new AbortController();
    const cancelled = cache.load(request(), controller.signal).catch((error: unknown) => error);
    const kept = cache.load(request());
    const waiting = cache.load(request(2), other.signal).catch((error: unknown) => error);
    const last = cache.load(request(3));
    controller.abort();
    other.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    expect(await waiting).toMatchObject({ name: 'AbortError' });
    first.resolve(image());
    expect((await kept).page).toBe(1);
    expect((await last).page).toBe(3);
    expect(render.mock.calls.map(([value]) => value.page)).toEqual([1, 3]);
  });

  it('keeps queued work subscribed by another card and allows a cancelled page to be requested again', async () => {
    const first = deferred<EnginePagePreview>();
    const render = vi.fn().mockReturnValueOnce(first.promise).mockImplementation(async (value) => image(value));
    const cache = new PdfThumbnailCache(render);
    const active = cache.load(request());
    const abort = new AbortController();
    const cancelled = cache.load(request(2), abort.signal).catch((error: unknown) => error);
    const kept = cache.load(request(2));
    abort.abort();
    first.resolve(image());
    await active;
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    await kept;
    await cache.load(request(2));
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('does not cache a running response after every subscriber has cancelled', async () => {
    const first = deferred<EnginePagePreview>();
    const render = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(image());
    const cache = new PdfThumbnailCache(render);
    const abort = new AbortController();
    const cancelled = cache.load(request(), abort.signal).catch((error: unknown) => error);
    abort.abort();
    first.resolve(image());
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    await cache.load(request());
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('does not invoke an already aborted request', async () => {
    const render = vi.fn();
    const abort = new AbortController();
    abort.abort();
    await expect(new PdfThumbnailCache(render).load(request(), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(render).not.toHaveBeenCalled();
  });

  it.each([false, true])('continues after a renderer failure and retries without a cached failure (sync=%s)', async (sync) => {
    const render = vi.fn().mockImplementationOnce(() => {
      if (sync) throw new Error('render failed');
      return Promise.reject(new Error('render failed'));
    }).mockImplementation(async (value) => image(value));
    const cache = new PdfThumbnailCache(render);
    const failed = cache.load(request()).catch((error: unknown) => error);
    const waiting = cache.load(request(2));
    expect(await failed).toMatchObject({ message: 'render failed' });
    expect((await waiting).page).toBe(2);
    await cache.load(request());
    expect(render.mock.calls.map(([value]) => value.page)).toEqual([1, 2, 1]);
  });

  it('bounds entries by LRU and keeps recently visited pages', async () => {
    const render = vi.fn(async (value: PdfThumbnailRequest) => image(value));
    const cache = new PdfThumbnailCache(render, { maxEntries: 2 });
    for (const page of [1, 2, 1, 3, 1, 2]) await cache.load(request(page));
    expect(render.mock.calls.map(([value]) => value.page)).toEqual([1, 2, 3, 2]);
  });

  it('bounds image-string bytes and skips individually oversized entries', async () => {
    const render = vi.fn(async (value: PdfThumbnailRequest) => image(value));
    const bytes = image().image_data.length * 2;
    const cache = new PdfThumbnailCache(render, { maxBytes: bytes * 1.5 });
    for (const page of [1, 2, 1]) await cache.load(request(page));
    expect(render).toHaveBeenCalledTimes(3);
    const tiny = new PdfThumbnailCache(render, { maxBytes: bytes - 1 });
    await tiny.load(request());
    await tiny.load(request());
    expect(render).toHaveBeenCalledTimes(5);
  });

  it.each([1, 2])('keeps capacity accounting consistent when a rendered page overtakes a pending cache hit (maxEntries=%s)', async (maxEntries) => {
    const render = vi.fn(async (value: PdfThumbnailRequest) => ({ ...image(value),
      image_data: image(value).image_data.padEnd(122, 'A') }));
    const cache = new PdfThumbnailCache(render, { maxEntries, maxBytes: 244 });
    const storage = cache as unknown as { images: Map<string, EnginePagePreview>; bytes: number };
    const expectBounded = () => {
      const actualBytes = [...storage.images.values()].reduce((total, value) => total + value.image_data.length * 2, 0);
      expect(storage.images.size).toBe(1);
      expect(actualBytes).toBe(244);
      expect(storage.bytes).toBe(actualBytes);
    };
    await cache.load(request(1));
    // The resolved renderer queues its delivery before the cached hit queues its own delivery.
    const rendered = cache.load(request(2));
    const hit = cache.load(request(1));
    expect((await Promise.all([rendered, hit])).map((value) => value.page)).toEqual([2, 1]);
    expectBounded();
    await cache.load(request(2));
    expect(render.mock.calls.map(([value]) => value.page)).toEqual([1, 2]);
    await cache.load(request(1));
    expect(render.mock.calls.map(([value]) => value.page)).toEqual([1, 2, 1]);
    expectBounded();
    await cache.load(request(2));
    expect(render.mock.calls.map(([value]) => value.page)).toEqual([1, 2, 1, 2]);
    expectBounded();
  });

  it.each([{ path: '/another.pdf' }, { sha: 'b'.repeat(64) }, { page: 2 }])(
    'separates source path, hash and page identity %j', async (change) => {
      const render = vi.fn(async (value: PdfThumbnailRequest) => image(value));
      const cache = new PdfThumbnailCache(render);
      await cache.load(request());
      await cache.load({ ...request(), ...change });
      expect(render).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { source_sha256: 'b'.repeat(64) }, { source_sha256: undefined }, { page: 2 }, { page_count: 9 },
    { page_width: 601 }, { page_height: 901 }, { page_width: Number.NaN }, { page_height: 0 },
    { image_data: 'data:image/svg+xml;base64,AA==' },
  ])('rejects mismatched or malformed response %j without caching it', async (change) => {
    const render = vi.fn().mockResolvedValueOnce({ ...image(), ...change }).mockResolvedValueOnce(image());
    const cache = new PdfThumbnailCache(render);
    await expect(cache.load(request())).rejects.toThrow('页面尺寸或来源已变化');
    await cache.load(request());
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('checks optional geometry for each subscriber and for cache hits without rerendering', async () => {
    const first = deferred<EnginePagePreview>();
    const render = vi.fn(() => first.promise);
    const cache = new PdfThumbnailCache(render);
    const wrong = cache.load({ ...request(), width: 800 }).catch((error: unknown) => error);
    const exact = cache.load(request());
    const unconstrained = cache.load({ ...request(), width: undefined, height: undefined });
    first.resolve(image());
    expect(await wrong).toMatchObject({ message: expect.stringContaining('页面尺寸或来源已变化') });
    await exact;
    await unconstrained;
    await expect(cache.load({ ...request(), pageCount: 9 })).rejects.toThrow('页面尺寸或来源已变化');
    await expect(cache.load({ ...request(), height: 1000 })).rejects.toThrow('页面尺寸或来源已变化');
    await cache.load({ ...request(), width: 600.4, height: 899.6 });
    expect(render).toHaveBeenCalledTimes(1);
  });

  it.each([{ page: 0 }, { page: 1.5 }, { pageCount: 0 }, { pageCount: Number.NaN }, { sha: 'wrong' },
    { path: '' }, { width: Number.NaN }, { height: -1 }])('rejects invalid request %j before rendering', async (change) => {
    const render = vi.fn();
    await expect(new PdfThumbnailCache(render).load({ ...request(), ...change })).rejects.toThrow('请求无效');
    expect(render).not.toHaveBeenCalled();
  });

  it('snapshots requests and results so caller mutation cannot poison the cache', async () => {
    const source = request();
    const first = deferred<EnginePagePreview>();
    const rendered = image();
    const render = vi.fn(() => first.promise);
    const cache = new PdfThumbnailCache(render);
    const pending = cache.load(source);
    source.sha = 'b'.repeat(64);
    first.resolve(rendered);
    const delivered = await pending;
    delivered.page_width = 1;
    rendered.image_data = 'mutated';
    expect(await cache.load(request())).toEqual(image());
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('disposes pending subscriptions and ignores late results without starting old queued work', async () => {
    const first = deferred<EnginePagePreview>();
    const render = vi.fn(() => first.promise);
    const cache = new PdfThumbnailCache(render);
    const delivered = vi.fn();
    const active = cache.load(request()).then(delivered).catch((error: unknown) => error);
    const waiting = cache.load(request(2)).then(delivered).catch((error: unknown) => error);
    cache.dispose();
    cache.dispose();
    expect(await active).toMatchObject({ name: 'AbortError' });
    expect(await waiting).toMatchObject({ name: 'AbortError' });
    first.resolve(image());
    await expect(cache.load(request())).rejects.toMatchObject({ name: 'AbortError' });
    expect(delivered).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it.each(['abort', 'dispose'])('does not deliver a cached image cancelled before its microtask (%s)', async (action) => {
    const cache = new PdfThumbnailCache(async (value) => image(value));
    await cache.load(request());
    const abort = new AbortController();
    const hit = cache.load(request(), abort.signal);
    if (action === 'abort') abort.abort();
    else cache.dispose();
    await expect(hit).rejects.toMatchObject({ name: 'AbortError' });
  });
});
