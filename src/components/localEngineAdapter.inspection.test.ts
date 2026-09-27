// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { localEngineAdapter } from './localEngineAdapter';

const sha = 'a'.repeat(64);
const path = 'D:\\input\\synthetic.pdf';

function page(number: number, overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok', page: number, page_count: 3, page_width: 600,
    page_height: 800, source_sha256: sha, ...overrides,
  };
}

function response(pages: unknown[] = [page(1), page(2)], overrides: Record<string, unknown> = {}) {
  return { status: 'ok', page_count: 3, source_sha256: sha, pages, ...overrides };
}

const unavailable = { status: 'unavailable', reason: 'no_text' };
const ready = {
  status: 'ready', fingerprint: 'b'.repeat(64), receipts: [{
    anchor_y: 20, bounds: { x0: 0, y0: 0, x1: 600, y1: 300 },
    title_key: 'c'.repeat(64), issuer_bank_key: 'd'.repeat(64),
    template_fingerprint: 'e'.repeat(64), issuer_bank_name: '示例银行',
  }],
};

describe('bounded page inspection IPC contract', () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  });

  afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); });

  it('checks the exact page set in one call and accepts reordered results without images', async () => {
    const result = response([page(2), page(1)]);
    invoke.mockResolvedValueOnce(result);
    await expect(localEngineAdapter.inspectPages(path, [1, 2], sha)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('engine_inspect_pages', {
      path, pages: [1, 2], sourceSha256: sha, includeCropTemplate: false,
    });
  });

  it('keeps individual page failures while returning usable sibling geometry', async () => {
    const result = response([
      page(1), { status: 'error', page: 2, code: 'render_failed', message: 'PDF page rendering failed' },
      { status: 'error', page: 4, code: 'page_out_of_range', message: 'page is out of range' },
    ]);
    invoke.mockResolvedValueOnce(result);
    await expect(localEngineAdapter.inspectPages(path, [1, 2, 4], sha)).resolves.toEqual(result);
  });

  it('requires valid optional descriptors, including bounded receipt geometry and identity', async () => {
    const result = response([page(1, { crop_template: ready }), page(2, { crop_template: unavailable })]);
    invoke.mockResolvedValueOnce(result);
    await expect(localEngineAdapter.inspectPages(path, [1, 2], sha, true)).resolves.toEqual(result);
    expect(invoke.mock.calls[0][1].includeCropTemplate).toBe(true);
  });

  it('accepts per-page descriptor failure only when descriptors were requested', async () => {
    const result = response([{ status: 'error', page: 1, code: 'analyze_failed', message: 'PDF page analysis failed' }]);
    invoke.mockResolvedValueOnce(result).mockResolvedValueOnce(result);
    await expect(localEngineAdapter.inspectPages(path, [1], sha, true)).resolves.toEqual(result);
    await expect(localEngineAdapter.inspectPages(path, [1], sha)).rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
  });

  it.each([
    [], [0], [-1], [1.5], [true], [Number.NaN], [2 ** 32], [1, 1], Array.from({ length: 33 }, (_, i) => i + 1),
  ].map((pages) => [pages]))('rejects invalid page requests %j before IPC', async (pages) => {
    await expect(localEngineAdapter.inspectPages(path, pages as number[], sha))
      .rejects.toMatchObject({ code: 'ENGINE_INVALID_REQUEST' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects invalid source identity, paths, descriptor flag and browser calls', async () => {
    await expect(localEngineAdapter.inspectPages(path, [1], 'bad')).rejects.toMatchObject({ code: 'ENGINE_INVALID_REQUEST' });
    await expect(localEngineAdapter.inspectPages('', [1], sha)).rejects.toMatchObject({ code: 'ENGINE_INVALID_REQUEST' });
    await expect(localEngineAdapter.inspectPages(path, [1], sha, 'yes' as unknown as boolean))
      .rejects.toMatchObject({ code: 'ENGINE_INVALID_REQUEST' });
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    await expect(localEngineAdapter.inspectPages(path, [1], sha)).rejects.toMatchObject({ code: 'TAURI_UNAVAILABLE' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    response([], {}),
    response([page(1), page(1)]),
    response([page(1), page(3)]),
    response([page(1), page(2), page(3)]),
    response(undefined, { source_sha256: 'b'.repeat(64) }),
    response(undefined, { page_count: 0 }),
    response([page(1), page(2, { page_count: 4 })]),
    response([page(1), page(2, { source_sha256: 'b'.repeat(64) })]),
    response([page(1), page(2, { page_width: Number.POSITIVE_INFINITY })]),
    response([page(1), page(2, { page_width: 0 })]),
    response([page(1), page(2, { page_height: 9000 })]),
    response([page(1), page(2, { page_width: 5000, page_height: 5000 })]),
    response([page(1), page(2, { crop_template: unavailable })]),
    response([page(1), { status: 'error', page: 2, code: 'source_changed', message: 'changed' }]),
    response([page(1), { status: 'error', page: 2, code: 'page_out_of_range', message: 'range' }]),
    response([page(1), { status: 'error', page: 2, code: 'render_failed', message: '' }]),
  ])('rejects incomplete, inconsistent or unsafe inspection results %#', async (result) => {
    invoke.mockResolvedValueOnce(result);
    await expect(localEngineAdapter.inspectPages(path, [1, 2], sha)).rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
  });

  it.each([
    undefined, null, { status: 'unavailable', reason: 'unknown' },
    { ...ready, receipts: [{ ...ready.receipts[0], bounds: { x0: 0, y0: 0, x1: 600, y1: 900 } }] },
    { ...ready, receipts: [{ ...ready.receipts[0], issuer_bank_key: null }] },
    { ...ready, receipts: [ready.receipts[0], ready.receipts[0]] },
  ])('rejects missing or invalid descriptors %#', async (crop_template) => {
    invoke.mockResolvedValueOnce(response([page(1, { crop_template })]));
    await expect(localEngineAdapter.inspectPages(path, [1], sha, true)).rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
  });

  it('retains source_changed as an authoritative top-level error', async () => {
    invoke.mockResolvedValueOnce({ status: 'error', code: 'source_changed', message: 'source PDF changed during processing' });
    await expect(localEngineAdapter.inspectPages(path, [1, 2], sha)).rejects.toMatchObject({
      code: 'ENGINE_REQUEST_REJECTED', engineCode: 'source_changed',
    });
  });

  it('keeps the submitted page set stable while the caller edits its array', async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pages = [1, 2];
    const pending = localEngineAdapter.inspectPages(path, pages, sha);
    pages[0] = 3;
    resolve(response());
    await expect(pending).resolves.toEqual(response());
    expect(invoke.mock.calls[0][1].pages).toEqual([1, 2]);
  });

  it('wraps IPC failures without presenting them as successful geometry', async () => {
    invoke.mockRejectedValueOnce(new Error('bridge unavailable'));
    await expect(localEngineAdapter.inspectPages(path, [1], sha)).rejects.toMatchObject({ code: 'ENGINE_ANALYZE_FAILED' });
  });
});
