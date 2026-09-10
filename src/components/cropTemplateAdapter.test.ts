// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { localEngineAdapter } from './localEngineAdapter';
const sha = 'a'.repeat(64);
const valid = () => ({ status: 'ok', page: 2, page_count: 3, page_width: 600, page_height: 900, source_sha256: sha,
  crop_template: { status: 'ready', fingerprint: 'b'.repeat(64), receipts: [
    { anchor_y: 25, bounds: {x0:0,y0:0,x1:600,y1:300}, title_key:'c'.repeat(64) },
  ] } });
beforeEach(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} }); invoke.mockReset(); });
afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });
it('requests only readonly crop metadata through the existing guarded page boundary', async () => {
  invoke.mockResolvedValue(valid());
  expect(await localEngineAdapter.describeCropPage('C:/test.pdf', 2, sha)).toEqual(valid());
  expect(invoke).toHaveBeenCalledWith('engine_analyze_page', {path:'C:/test.pdf',page:2,matches:[],sourceSha256:sha,includeCropTemplate:true});
});
it.each(['page','hash','bounds','anchor','empty','overlap','oversized','fingerprint'])('rejects malformed descriptor: %s', async (fault) => {
  const data = valid();
  if (fault === 'page') data.page = 1;
  if (fault === 'hash') data.source_sha256 = 'd'.repeat(64);
  if (fault === 'bounds') data.crop_template.receipts[0].bounds.y1 = 901;
  if (fault === 'anchor') data.crop_template.receipts[0].anchor_y = NaN;
  if (fault === 'empty') data.crop_template.receipts = [];
  if (fault === 'overlap') data.crop_template.receipts.push(structuredClone(data.crop_template.receipts[0]));
  if (fault === 'oversized') data.crop_template.receipts = Array(129).fill(data.crop_template.receipts[0]);
  if (fault === 'fingerprint') data.crop_template.fingerprint = 'not a hash';
  invoke.mockResolvedValue(data);
  await expect(localEngineAdapter.describeCropPage('C:/test.pdf', 2, sha)).rejects.toMatchObject({code:'ENGINE_INVALID_RESPONSE'});
});
it('accepts explicitly unavailable layouts, rejects unknown reasons, and retains engine error codes', async () => {
  invoke.mockResolvedValue({...valid(),crop_template:{status:'unavailable',reason:'no_titles'}});
  expect((await localEngineAdapter.describeCropPage('C:/test.pdf',2,sha)).crop_template.status).toBe('unavailable');
  invoke.mockResolvedValue({...valid(),crop_template:{status:'unavailable',reason:'arbitrary text'}});
  await expect(localEngineAdapter.describeCropPage('C:/test.pdf',2,sha)).rejects.toMatchObject({code:'ENGINE_INVALID_RESPONSE'});
  invoke.mockResolvedValue({status:'error',code:'SOURCE_CHANGED',message:'原件变化'});
  await expect(localEngineAdapter.describeCropPage('C:/test.pdf',2,sha)).rejects.toMatchObject({engineCode:'SOURCE_CHANGED'});
});
