import { describe, expect, it, vi } from 'vitest';
import type { EnginePagePreview } from '../components/localEngineAdapter';
import { ReceiptPagePreviewCache, SupersededReceiptPreview, type ReceiptPageRequest } from './receiptPagePreviewCache';

const request = (page: number): ReceiptPageRequest => ({ path: '/source.pdf', sha: 'a'.repeat(64), page,
  pageCount: 8, width: 600, height: 900, retry: 0 });
const image = (value: ReceiptPageRequest): EnginePagePreview => ({ status: 'ok', page: value.page, page_count: value.pageCount,
  source_sha256: value.sha, page_width: value.width ?? 600, page_height: value.height ?? 900, image_data: `data:image/png;base64,page${value.page}` });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('receipt page preview cache', () => {
  it('accepts verified geometry for a source page without candidates but still rejects invalid dimensions', async () => {
    const entry = { ...request(4), width: undefined, height: undefined };
    const render = vi.fn().mockResolvedValueOnce(image(entry)).mockResolvedValueOnce({ ...image(entry), page_width: NaN });
    const cache = new ReceiptPagePreviewCache(render);
    expect((await cache.load(entry)).page_width).toBe(600);
    await expect(cache.load({ ...entry, retry: 1 })).rejects.toThrow('页面尺寸或来源已变化');
  });
  it('bounds completed image count and keeps recently revisited pages', async () => {
    const render = vi.fn(async (value: ReceiptPageRequest) => image(value));
    const cache = new ReceiptPagePreviewCache(render, { entries: 2, bytes: 1024 });
    for (const page of [1, 2, 1, 3, 1, 2]) await cache.load(request(page));
    expect(render.mock.calls.map(([value]) => value.page)).toEqual([1, 2, 3, 2]);
  });

  it('bounds decoded string memory and does not retain individually oversized images', async () => {
    const render = vi.fn(async (value: ReceiptPageRequest) => image(value));
    const bytes = image(request(1)).image_data.length * 2;
    const cache = new ReceiptPagePreviewCache(render, { entries: 4, bytes: bytes * 1.5 });
    for (const page of [1, 2, 1]) await cache.load(request(page));
    expect(render).toHaveBeenCalledTimes(3);
    const smallCache = new ReceiptPagePreviewCache(render, { entries: 4, bytes: bytes - 1 });
    await smallCache.load(request(3));
    await smallCache.load(request(3));
    expect(render).toHaveBeenCalledTimes(5);
  });

  it.each([
    { path: '/another.pdf' }, { sha: 'b'.repeat(64) }, { width: 700 }, { height: 1000 }, { pageCount: 9 }, { retry: 1 },
  ])('does not reuse an image after source, geometry or retry changes: %j', async (change) => {
    const render = vi.fn(async (value: ReceiptPageRequest) => image(value));
    const cache = new ReceiptPagePreviewCache(render);
    await cache.load(request(1));
    await cache.load({ ...request(1), ...change });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('clears obsolete waiting work when the user selects an already cached page', async () => {
    const running = deferred<EnginePagePreview>();
    const render = vi.fn((value: ReceiptPageRequest) => value.page === 2 ? running.promise : Promise.resolve(image(value)));
    const cache = new ReceiptPagePreviewCache(render);
    await cache.load(request(1));
    const second = cache.load(request(2));
    const skipped = cache.load(request(3)).catch((error: unknown) => error);
    await cache.load(request(1));
    expect(await skipped).toBeInstanceOf(SupersededReceiptPreview);
    running.resolve(image(request(2)));
    await second;
    expect(render.mock.calls.map(([value]) => value.page)).toEqual([1, 2]);
  });

  it('continues the latest waiting page after a render failure and permits retry', async () => {
    const failed = deferred<EnginePagePreview>();
    const render = vi.fn((value: ReceiptPageRequest) => value.page === 1 ? failed.promise : Promise.resolve(image(value)));
    const cache = new ReceiptPagePreviewCache(render);
    const first = cache.load(request(1)).catch((error: unknown) => error);
    const skipped = cache.load(request(2)).catch((error: unknown) => error);
    const latest = cache.load(request(3));
    failed.reject(new Error('render failed'));
    expect(await first).toMatchObject({ message: 'render failed' });
    expect(await skipped).toBeInstanceOf(SupersededReceiptPreview);
    expect((await latest).page).toBe(3);
    render.mockImplementation(async (value) => image(value));
    expect((await cache.load(request(1))).page).toBe(1);
    expect(render.mock.calls.map(([value]) => value.page)).toEqual([1, 3, 1]);
  });

  it.each(['source_sha256', 'page', 'page_count', 'page_width', 'page_height'] as const)(
    'rejects an inconsistent %s response without caching it', async (field) => {
      const invalid = { ...image(request(1)), [field]: field === 'source_sha256' ? 'b'.repeat(64) : 2000 };
      const render = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce(image(request(1)));
      const cache = new ReceiptPagePreviewCache(render);
      await expect(cache.load(request(1))).rejects.toThrow('页面尺寸或来源已变化');
      expect((await cache.load(request(1))).page).toBe(1);
      expect(render).toHaveBeenCalledTimes(2);
    },
  );

  it('drops waiting work and late responses on disposal', async () => {
    const first = deferred<EnginePagePreview>();
    const render = vi.fn(() => first.promise);
    const cache = new ReceiptPagePreviewCache(render);
    const active = cache.load(request(1)).catch((error: unknown) => error);
    const waiting = cache.load(request(2)).catch((error: unknown) => error);
    cache.dispose();
    expect(await active).toBeInstanceOf(SupersededReceiptPreview);
    expect(await waiting).toBeInstanceOf(SupersededReceiptPreview);
    first.resolve(image(request(1)));
    await expect(cache.load(request(1))).rejects.toBeInstanceOf(SupersededReceiptPreview);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
