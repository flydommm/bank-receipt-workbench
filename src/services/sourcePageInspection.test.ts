import { describe, expect, it, vi } from 'vitest';
import { SourcePageInspection } from './sourcePageInspection';
import { EngineProcessScheduler } from './engineProcessScheduler';
import type { EnginePagesInspection } from '../components/localEngineAdapter';

const sha = 'a'.repeat(64);
const result = (pages: number[]): EnginePagesInspection => ({ status: 'ok', page_count: 1000,
  source_sha256: sha, pages: pages.map((page) => ({ status: 'ok', page, page_count: 1000,
    page_width: 600, page_height: 800, source_sha256: sha })) });
const request = (page: number, scope = 'task1') => ({ path: 'C:/demo.pdf', page, pageCount: 1000, sha256: sha, scope,
  priority: 'background' as const, current: () => true });
const scheduler = () => new EngineProcessScheduler(3, () => new Error('stale'), 2);

describe('source page inspection', () => {
  it('coalesces 469 page requests into bounded blocks without rendering or rereading cached pages', async () => {
    const inspect = vi.fn(async (_path: string, pages: number[]) => result(pages));
    const service = new SourcePageInspection(inspect, scheduler(), () => new Error('stale'));
    const pages = await Promise.all(Array.from({ length: 469 }, (_, index) => service.get(request(index + 1))));
    expect(pages).toHaveLength(469);
    expect(inspect).toHaveBeenCalledTimes(15);
    expect(inspect.mock.calls.every((call) => call[1].length <= 32)).toBe(true);
    await service.get(request(20));
    expect(inspect).toHaveBeenCalledTimes(15);
  });

  it('deduplicates the same page while preserving source/task/template identity', async () => {
    const inspect = vi.fn(async (_path: string, pages: number[]) => result(pages));
    const service = new SourcePageInspection(inspect, scheduler(), () => new Error('stale'));
    const first = service.get(request(1));
    expect(service.get(request(1))).toBe(first);
    await first;
    await service.get(request(1, 'task2'));
    await service.get({ ...request(1), includeCropTemplate: true });
    expect(inspect).toHaveBeenCalledTimes(3);
    service.clear();
    await service.get(request(1));
    expect(inspect).toHaveBeenCalledTimes(4);
  });

  it('does not cache a failed page or lose successful siblings', async () => {
    const inspect = vi.fn(async (_path: string, pages: number[]): Promise<EnginePagesInspection> => ({ ...result(pages),
      pages: result(pages).pages.map((page) => page.page === 2
        ? { status: 'error', page: 2, code: 'render_failed', message: 'budget' } : page) }));
    const service = new SourcePageInspection(inspect, scheduler(), () => new Error('stale'));
    const results = await Promise.allSettled([service.get(request(1)), service.get(request(2))]);
    expect(results.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
    await service.get(request(1));
    await expect(service.get(request(2))).rejects.toThrow('budget');
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('does not reuse stale successes and still propagates late source-change errors', async () => {
    let resolve!: (value: EnginePagesInspection) => void;
    let reject!: (error: Error) => void;
    const inspect = vi.fn(() => new Promise<EnginePagesInspection>((yes, no) => { resolve = yes; reject = no; }));
    const service = new SourcePageInspection(inspect, scheduler(), () => new Error('stale'));
    const first = service.get(request(1));
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    service.clear(); resolve(result([1]));
    await expect(first).rejects.toThrow('stale');
    const second = service.get(request(1));
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    service.clear(); reject(new Error('source_changed'));
    await expect(second).rejects.toThrow('source_changed');
  });

  it('reports source changes even when a removed page is a page-level failure', async () => {
    const inspect = vi.fn(async (): Promise<EnginePagesInspection> => ({ status: 'ok', page_count: 1,
      source_sha256: sha, pages: [{ status: 'error', page: 2, code: 'page_out_of_range', message: 'missing' }] }));
    const service = new SourcePageInspection(inspect, scheduler(), () => new Error('stale'));
    await expect(service.get(request(2))).rejects.toMatchObject({ engineCode: 'source_changed' });
  });
});
