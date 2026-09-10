// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  localEngineAdapter,
  type EnginePdfExportSelection,
  type EngineSearchClause,
} from './localEngineAdapter';

const multiSearchClauses: EngineSearchClause[] = [
  { id: 'include-0', keyword: '示例实业', role: 'include' },
  { id: 'exclude-0', keyword: '退款', role: 'exclude' },
];

function validMultiSearchMatch(overrides: Record<string, unknown> = {}) {
  return {
    source_path: '/docs/a.pdf',
    source_sha256: 'a'.repeat(64),
    page: 1,
    matched_text: '示例实业',
    matched_field: null,
    confidence: 1,
    needs_review: false,
    x0: 1,
    y0: 2,
    x1: 100,
    y1: 20,
    query_id: 'include-0',
    role: 'include',
    ...overrides,
  };
}

function validMultiSearchResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    page_count: 2,
    source_sha256: 'a'.repeat(64),
    matches: [validMultiSearchMatch()],
    ...overrides,
  };
}

describe('localEngineAdapter export preview boundary', () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('creates a managed preview path for the export token', async () => {
    invoke.mockResolvedValueOnce('C:\\cache\\preview.pdf');

    await expect(localEngineAdapter.createExportPreviewPath('preview-token-1234567890'))
      .resolves.toBe('C:\\cache\\preview.pdf');
    expect(invoke).toHaveBeenCalledWith('create_export_preview_path', {
      exportToken: 'preview-token-1234567890',
    });
  });

  it('preserves cancellation from the native output-folder picker', async () => {
    invoke.mockResolvedValueOnce(null);

    await expect(localEngineAdapter.pickOutputFolder()).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith('pick_output_folder', { initialDirectory: null });
  });

  it('binds persistent task previews and rejects invalid task identifiers before IPC', async () => {
    invoke.mockResolvedValueOnce('C:\\cache\\preview.pdf');
    await localEngineAdapter.createExportPreviewPath('preview-token-1234567890', 'job-1');
    expect(invoke).toHaveBeenCalledWith('create_export_preview_path', {
      exportToken: 'preview-token-1234567890', batchJobId: 'job-1',
    });
    invoke.mockClear();
    await expect(localEngineAdapter.createExportPreviewPath('preview-token-1234567890', ''))
      .rejects.toThrow('任务标识无效');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes the remembered input directory and validates picker results', async () => {
    invoke.mockResolvedValueOnce({ files: ['D:\\input\\a.pdf'], directory: 'D:\\input' });

    await expect(localEngineAdapter.pickPdfFiles('D:\\input')).resolves.toEqual({
      files: ['D:\\input\\a.pdf'],
      directory: 'D:\\input',
    });
    expect(invoke).toHaveBeenCalledWith('pick_pdf_files', { initialDirectory: 'D:\\input' });
  });

  it('inspects a PDF and returns its page count and source hash', async () => {
    const response = {
      status: 'ok',
      page_count: 2,
      source_sha256: 'a'.repeat(64),
    };
    invoke.mockResolvedValueOnce(response);

    await expect(localEngineAdapter.inspectPdf('D:\\input\\inspect.pdf'))
      .resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledWith('engine_inspect_pdf', {
      path: 'D:\\input\\inspect.pdf',
    });
  });

  it.each([
    ['missing page count', { status: 'ok', source_sha256: 'a'.repeat(64) }],
    ['zero page count', { status: 'ok', page_count: 0, source_sha256: 'a'.repeat(64) }],
    ['fractional page count', { status: 'ok', page_count: 1.5, source_sha256: 'a'.repeat(64) }],
    ['malformed source hash', { status: 'ok', page_count: 2, source_sha256: 'not-a-sha256' }],
  ] as const)('rejects an invalid inspect response with %s', async (_label, response) => {
    invoke.mockResolvedValueOnce(response);

    await expect(localEngineAdapter.inspectPdf('D:\\input\\inspect.pdf'))
      .rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
  });

  it('maps an inspect PDF engine error to the existing adapter error', async () => {
    invoke.mockResolvedValueOnce({
      status: 'error',
      code: 'file_not_found',
      message: 'PDF file does not exist',
    });

    await expect(localEngineAdapter.inspectPdf('D:\\input\\missing.pdf'))
      .rejects.toMatchObject({
        code: 'ENGINE_REQUEST_REJECTED',
        engineCode: 'file_not_found',
        message: 'PDF file does not exist',
      });
  });

  it('preserves folder cancellation and rejects malformed picker responses', async () => {
    invoke.mockResolvedValueOnce({ files: [], directory: null });
    await expect(localEngineAdapter.pickPdfFolder(null)).resolves.toEqual({ files: [], directory: null });
    expect(invoke).toHaveBeenCalledWith('pick_pdf_folder', { initialDirectory: null });

    invoke.mockResolvedValueOnce({ files: 'bad', directory: null });
    await expect(localEngineAdapter.pickPdfFolder()).rejects.toMatchObject({
      code: 'ENGINE_INVALID_RESPONSE',
    });
  });

  it.each(['', '   '])('rejects a picker response with an invalid file path (%j)', async (file) => {
    invoke.mockResolvedValueOnce({ files: [file], directory: null });

    await expect(localEngineAdapter.pickPdfFiles()).rejects.toMatchObject({
      code: 'ENGINE_INVALID_RESPONSE',
    });
  });

  it('passes the remembered output directory and preserves cancellation', async () => {
    invoke.mockResolvedValueOnce(null);

    await expect(localEngineAdapter.pickOutputFolder('D:\\output')).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith('pick_output_folder', { initialDirectory: 'D:\\output' });
  });

  it('validates directory paths through Tauri', async () => {
    invoke
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    await expect(localEngineAdapter.validateDirectory('D:\\input')).resolves.toBe(true);
    expect(invoke).toHaveBeenNthCalledWith(1, 'validate_directory', { path: 'D:\\input' });

    await expect(localEngineAdapter.validateDirectory('')).resolves.toBe(false);
    expect(invoke).toHaveBeenNthCalledWith(2, 'validate_directory', { path: '' });

    await expect(localEngineAdapter.validateDirectory('D:\\missing')).resolves.toBe(false);
    expect(invoke).toHaveBeenNthCalledWith(3, 'validate_directory', { path: 'D:\\missing' });
  });

  it('rejects a non-boolean directory validation response', async () => {
    invoke.mockResolvedValueOnce('true');

    await expect(localEngineAdapter.validateDirectory('D:\\input')).rejects.toMatchObject({
      code: 'ENGINE_INVALID_RESPONSE',
    });
  });

  it('passes the remembered directory and returns the selected directory without scanning', async () => {
    invoke.mockResolvedValueOnce('D:\\input');

    await expect(localEngineAdapter.pickDirectory('D:\\remembered')).resolves.toBe('D:\\input');
    expect(invoke).toHaveBeenCalledWith('pick_directory', { initialDirectory: 'D:\\remembered' });
  });

  it('preserves directory-picker cancellation and rejects malformed results', async () => {
    invoke.mockResolvedValueOnce(null);
    await expect(localEngineAdapter.pickDirectory(null)).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith('pick_directory', { initialDirectory: null });

    for (const response of ['', 42, {}]) {
      invoke.mockResolvedValueOnce(response);
      await expect(localEngineAdapter.pickDirectory()).rejects.toMatchObject({
        code: 'ENGINE_INVALID_RESPONSE',
      });
    }
  });

  it('binds source preview and analysis requests to the reviewed PDF hash', async () => {
    const sourceSha256 = 'b'.repeat(64);
    invoke
      .mockResolvedValueOnce({
        status: 'ok',
        page: 2,
        page_count: 3,
        page_width: 600,
        page_height: 800,
        source_sha256: sourceSha256,
        image_data: 'data:image/png;base64,AA==',
      })
      .mockResolvedValueOnce({
        status: 'ok',
        page: 2,
        page_width: 600,
        page_height: 800,
        source_sha256: sourceSha256,
        selections: [],
      });

    await localEngineAdapter.renderPage('D:\\input\\receipt.pdf', 2, sourceSha256);
    await localEngineAdapter.analyzePage('D:\\input\\receipt.pdf', 2, [], sourceSha256);

    expect(invoke).toHaveBeenNthCalledWith(1, 'engine_render_page', {
      path: 'D:\\input\\receipt.pdf',
      page: 2,
      sourceSha256,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'engine_analyze_page', {
      path: 'D:\\input\\receipt.pdf',
      page: 2,
      matches: [],
      sourceSha256,
    });
  });

  it('preserves source_changed when rendering a reviewed source page', async () => {
    const sourceSha256 = 'b'.repeat(64);
    invoke.mockResolvedValueOnce({
      status: 'error',
      code: 'source_changed',
      message: '源 PDF 已变化。',
    });

    await expect(
      localEngineAdapter.renderPage('D:\\input\\receipt.pdf', 2, sourceSha256),
    ).rejects.toMatchObject({
      code: 'ENGINE_REQUEST_REJECTED',
      engineCode: 'source_changed',
      message: '源 PDF 已变化。',
    });
  });

  it.each([
    [{ page_count: 7282, max_pages: 5000 }, '此 PDF 共 7282 页，超过当前每个 PDF 5000 页的限制。请拆分文件后重试。'],
    [{ page_count: 7282, max_pages: 6000 }, '此 PDF 共 7282 页，超过当前每个 PDF 6000 页的限制。请拆分文件后重试。'],
    [{}, 'PDF 页数超过当前配置上限。请拆分文件后重试。'],
    [{ page_count: '7282', max_pages: -1 }, 'PDF 页数超过当前配置上限。请拆分文件后重试。'],
  ])('explains the configured page limit in Chinese with validated counts', async (counts, message) => {
    invoke.mockResolvedValueOnce({ status: 'error', code: 'page_limit_exceeded',
      message: 'PDF page count exceeds the configured limit', ...counts });
    await expect(localEngineAdapter.renderPage('D:\\input\\large.pdf', 1, 'a'.repeat(64)))
      .rejects.toMatchObject({ engineCode: 'page_limit_exceeded', message });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid search page_count %s',
    async (pageCount) => {
      invoke.mockResolvedValueOnce({
        status: 'ok',
        page_count: pageCount,
        source_sha256: 'a'.repeat(64),
        matches: [],
      });

      await expect(
        localEngineAdapter.search('D:\\input\\receipt.pdf', '手续费'),
      ).rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
    },
  );

  it('maps a structured search engine error to a safe adapter error', async () => {
    invoke.mockResolvedValueOnce({
      status: 'error',
      code: 'ocr_unavailable',
      message: '当前 PDF 需要 OCR，但 OCR 运行时不可用。',
    });

    await expect(localEngineAdapter.search('D:\\input\\receipt.pdf', '手续费', true))
      .rejects.toMatchObject({
        code: 'ENGINE_REQUEST_REJECTED',
        engineCode: 'ocr_unavailable',
        message: '当前 PDF 需要 OCR，但 OCR 运行时不可用。',
      });
  });

  it('treats a mismatched preview SHA-256 as a changed source', async () => {
    invoke.mockResolvedValueOnce({
      status: 'ok',
      page: 2,
      page_count: 3,
      page_width: 600,
      page_height: 800,
      source_sha256: 'c'.repeat(64),
      image_data: 'data:image/png;base64,AA==',
    });

    await expect(
      localEngineAdapter.renderPage(
        'D:\\input\\receipt.pdf',
        2,
        'b'.repeat(64),
      ),
    ).rejects.toMatchObject({
      code: 'ENGINE_REQUEST_REJECTED',
      engineCode: 'source_changed',
    });
  });

  it.each([
    ['missing', {}],
    ['non-string', { source_sha256: 123 }],
    ['malformed', { source_sha256: 'not-a-sha256' }],
  ] as const)(
    'rejects a preview with a %s source SHA-256 as an invalid response',
    async (_label, sourceHash) => {
      invoke.mockResolvedValueOnce({
        status: 'ok',
        page: 2,
        page_count: 3,
        page_width: 600,
        page_height: 800,
        image_data: 'data:image/png;base64,AA==',
        ...sourceHash,
      });

      await expect(
        localEngineAdapter.renderPage(
          'D:\\input\\receipt.pdf',
          2,
          'b'.repeat(64),
        ),
      ).rejects.toMatchObject({
        code: 'ENGINE_INVALID_RESPONSE',
        engineCode: undefined,
      });
    },
  );

  it('rejects source and export responses that are not bound to a SHA-256', async () => {
    invoke
      .mockResolvedValueOnce({ status: 'ok', page_count: 1, matches: [] })
      .mockResolvedValueOnce({ status: 'ok', output_path: 'D:\\out\\preview.pdf', page_count: 1 });

    await expect(localEngineAdapter.search('D:\\input\\receipt.pdf', '手续费'))
      .rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
    await expect(localEngineAdapter.exportPdf(
      'D:\\out\\preview.pdf',
      [{
        source_path: 'D:\\input\\receipt.pdf',
        source_sha256: 'd'.repeat(64),
        segments: [{
          page_number: 1,
          segment_no: 1,
          rect: null,
          keep_full_page: true,
          review_status: 'confirmed',
        }],
      }],
      'preview-token-sha-check-001',
    )).rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
  });

  it('publishes a preview with separate ownership tokens', async () => {
    invoke.mockResolvedValueOnce({
      status: 'ok',
      output_path: 'D:\\out\\result.pdf',
      sha256: 'a'.repeat(64),
    });

    await expect(localEngineAdapter.publishPreviewPdf(
      'C:\\cache\\preview.pdf',
      'D:\\out\\result.pdf',
      'preview-token-1234567890',
      'final-token-123456789012',
    )).resolves.toMatchObject({ output_path: 'D:\\out\\result.pdf' });
    expect(invoke).toHaveBeenCalledWith('engine_publish_preview_pdf', {
      previewPath: 'C:\\cache\\preview.pdf',
      outputPath: 'D:\\out\\result.pdf',
      previewToken: 'preview-token-1234567890',
      finalToken: 'final-token-123456789012',
    });
  });

  it('rejects an XLSX result that redirects to another output path', async () => {
    invoke.mockResolvedValueOnce({
      status: 'ok',
      output_path: 'D:\\out\\unexpected.xlsx',
      row_count: 1,
    });

    await expect(localEngineAdapter.exportIndex(
      'D:\\out\\requested.xlsx',
      [{ source_page: 1 }],
      'index-token-1234567890',
    )).rejects.toMatchObject({
      code: 'ENGINE_INVALID_RESPONSE',
      message: '本地引擎返回的 XLSX 路径与请求路径不一致。',
    });
  });

  it('rejects an XLSX result whose row count does not match the request', async () => {
    invoke.mockResolvedValueOnce({
      status: 'ok',
      output_path: 'D:\\out\\requested.xlsx',
      row_count: 1,
    });

    await expect(localEngineAdapter.exportIndex(
      'D:\\out\\requested.xlsx',
      [{ source_page: 1 }, { source_page: 2 }],
      'index-token-1234567890',
    )).rejects.toMatchObject({
      code: 'ENGINE_INVALID_RESPONSE',
      message: '本地引擎返回的 XLSX 行数与请求内容不一致。',
    });
  });

  it('rejects a PDF result that redirects to another output path', async () => {
    invoke.mockResolvedValueOnce({
      status: 'ok',
      output_path: 'D:\\out\\unexpected.pdf',
      page_count: 1,
      sha256: 'a'.repeat(64),
    });

    await expect(localEngineAdapter.exportPdf(
      'D:\\out\\requested.pdf',
      [{
        source_path: 'D:\\input\\receipt.pdf',
        source_sha256: 'd'.repeat(64),
        segments: [{
          page_number: 1,
          segment_no: 1,
          rect: null,
          keep_full_page: true,
          review_status: 'confirmed',
        }],
      }],
      'pdf-token-1234567890',
    )).rejects.toMatchObject({
      code: 'ENGINE_INVALID_RESPONSE',
      message: '本地引擎返回的 PDF 路径与请求路径不一致。',
    });
  });

  it('rejects a published PDF result that redirects to another output path', async () => {
    invoke.mockResolvedValueOnce({
      status: 'ok',
      output_path: 'D:\\out\\unexpected.pdf',
      sha256: 'a'.repeat(64),
    });

    await expect(localEngineAdapter.publishPreviewPdf(
      'C:\\cache\\preview.pdf',
      'D:\\out\\requested.pdf',
      'preview-token-1234567890',
      'final-token-1234567890',
    )).rejects.toMatchObject({
      code: 'ENGINE_INVALID_RESPONSE',
      message: '本地引擎返回的 PDF 发布路径与请求路径不一致。',
    });
  });

  it('releases final export ownership without requesting file cleanup', async () => {
    invoke.mockResolvedValueOnce({ status: 'ok', released_count: 2 });

    await expect(localEngineAdapter.releaseExports('final-token-123456789012'))
      .resolves.toEqual({ status: 'ok', released_count: 2 });
    expect(invoke).toHaveBeenCalledWith('engine_release_exports', {
      exportToken: 'final-token-123456789012',
    });
  });

  it('allows the same segment number on different source pages', async () => {
    invoke.mockResolvedValueOnce({
      status: 'ok',
      output_path: 'D:\\out\\preview.pdf',
      page_count: 2,
      sha256: 'c'.repeat(64),
    });
    const selections: EnginePdfExportSelection[] = [{
      source_path: 'D:\\input\\traffic-bank.pdf',
      source_sha256: 'a'.repeat(64),
      segments: [
        {
          page_number: 1,
          segment_no: 1,
          rect: { x0: 0, y0: 0, x1: 100, y1: 100 },
          keep_full_page: false,
          review_status: 'confirmed',
        },
        {
          page_number: 2,
          segment_no: 1,
          rect: { x0: 0, y0: 0, x1: 100, y1: 100 },
          keep_full_page: false,
          review_status: 'confirmed',
        },
      ],
    }];

    await expect(localEngineAdapter.exportPdf(
      'D:\\out\\preview.pdf',
      selections,
      'preview-token-cross-page-001',
    )).resolves.toMatchObject({ status: 'ok', page_count: 2, sha256: 'c'.repeat(64) });
    expect(invoke).toHaveBeenCalledWith('engine_export_pdf', {
      outputPath: 'D:\\out\\preview.pdf',
      selections,
      exportToken: 'preview-token-cross-page-001',
    });
  });
});

describe('localEngineAdapter multi-search boundary', () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('sends a multi-search request with tagged clauses', async () => {
    const response = validMultiSearchResult({ matches: [] });
    invoke.mockResolvedValueOnce(response);

    await expect(localEngineAdapter.searchMulti('/docs/a.pdf', multiSearchClauses, true))
      .resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledWith('engine_search_multi', {
      path: '/docs/a.pdf',
      queries: multiSearchClauses,
      exact: true,
    });
  });

  it('rejects a multi-search match without query tags', async () => {
    invoke.mockResolvedValueOnce(validMultiSearchResult({
      matches: [validMultiSearchMatch({ query_id: undefined, role: undefined })],
    }));

    await expect(localEngineAdapter.searchMulti('/docs/a.pdf', [multiSearchClauses[0]], true))
      .rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
  });

  it.each([
    ['unknown query id', { query_id: 'not-requested', role: 'include' }],
    ['mismatched role', { query_id: 'include-0', role: 'exclude' }],
  ] as const)('rejects a multi-search match with a %s', async (_label, tag) => {
    invoke.mockResolvedValueOnce(validMultiSearchResult({
      matches: [validMultiSearchMatch(tag)],
    }));

    await expect(localEngineAdapter.searchMulti('/docs/a.pdf', [multiSearchClauses[0]], true))
      .rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
  });

  it.each([
    ['invalid page count', { page_count: 0 }],
    ['invalid source SHA-256', { source_sha256: 'not-a-sha256' }],
    ['page outside page count', { matches: [validMultiSearchMatch({ page: 3 })] }],
    ['negative rectangle coordinate', { matches: [validMultiSearchMatch({ x0: -1 })] }],
    ['unordered rectangle', { matches: [validMultiSearchMatch({ x1: 1 })] }],
  ] as const)('rejects a multi-search result with %s', async (_label, overrides) => {
    invoke.mockResolvedValueOnce(validMultiSearchResult(overrides));

    await expect(localEngineAdapter.searchMulti('/docs/a.pdf', [multiSearchClauses[0]], true))
      .rejects.toMatchObject({ code: 'ENGINE_INVALID_RESPONSE' });
  });

  it('maps a structured multi-search engine error to a safe adapter error', async () => {
    invoke.mockResolvedValueOnce({
      status: 'error',
      code: 'too_many_clauses',
      message: '搜索关键词总数不能超过 32 个。',
    });

    await expect(localEngineAdapter.searchMulti('/docs/a.pdf', [multiSearchClauses[0]], true))
      .rejects.toMatchObject({
        code: 'ENGINE_REQUEST_REJECTED',
        engineCode: 'too_many_clauses',
        message: '搜索关键词总数不能超过 32 个。',
      });
  });
});

describe('localEngineAdapter OCR health boundary', () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('passes verify=false for the startup import check and preserves installed readiness', async () => {
    const response = {
      status: 'ok',
      available: true,
      engine: 'paddleocr',
      message: 'OCR 运行库已安装，尚未执行识别验证。',
      readiness: 'installed',
    };
    invoke.mockResolvedValueOnce(response);

    await expect(localEngineAdapter.ocrHealth()).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledWith('ocr_health', { verify: false });
  });

  it('passes verify=true for an explicit OCR detection', async () => {
    const response = {
      status: 'ok',
      available: true,
      engine: 'paddleocr',
      message: 'OCR 已通过脱敏样本验证。',
      readiness: 'ready',
    };
    invoke.mockResolvedValueOnce(response);

    await expect(localEngineAdapter.ocrHealth(true)).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledWith('ocr_health', { verify: true });
  });

  it('downgrades a legacy response without readiness to installed when the package is importable', async () => {
    const response = {
      status: 'ok',
      available: true,
      engine: 'paddleocr',
      message: 'OCR 运行库已安装。',
    };
    invoke.mockResolvedValueOnce(response);

    await expect(localEngineAdapter.ocrHealth()).resolves.toEqual({
      ...response,
      readiness: 'installed',
    });
  });

  it.each([
    ['unknown readiness', { readiness: 'maybe' }],
    ['unknown code', { readiness: 'failed', code: 'internal_error' }],
  ] as const)('rejects a response with %s', async (_label, fields) => {
    invoke.mockResolvedValueOnce({
      status: 'ok',
      available: false,
      engine: 'paddleocr',
      message: 'OCR 状态不可用。',
      ...fields,
    });

    await expect(localEngineAdapter.ocrHealth()).rejects.toMatchObject({
      code: 'ENGINE_INVALID_RESPONSE',
    });
  });
});

describe('localEngineAdapter OCR cache boundary', () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  const info = {
    status: 'ok' as const,
    available: true,
    entries: 4,
    bytes: 12_345,
    max_bytes: 268_435_456 as const,
    retention_days: 30 as const,
  };

  it('reads the independent cache occupancy DTO without user arguments', async () => {
    invoke.mockResolvedValueOnce({ ...info, path: 'must-not-cross-the-boundary' });

    await expect(localEngineAdapter.ocrCacheInfo()).resolves.toEqual(info);
    expect(invoke).toHaveBeenCalledWith('ocr_cache_info');
  });

  it('clears the cache through its fixed native operation and returns counts', async () => {
    const response = { ...info, removed_entries: 3, failed_entries: 1 };
    invoke.mockResolvedValueOnce(response);

    await expect(localEngineAdapter.ocrCacheClear()).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledWith('ocr_cache_clear');
  });

  it.each([
    ['missing max bytes', { ...info, max_bytes: 1 }],
    ['fractional entry count', { ...info, entries: 1.5 }],
    ['negative byte count', { ...info, bytes: -1 }],
    ['non-boolean availability', { ...info, available: 'yes' }],
  ] as const)('rejects an invalid occupancy response with %s', async (_label, response) => {
    invoke.mockResolvedValueOnce(response);

    await expect(localEngineAdapter.ocrCacheInfo()).rejects.toMatchObject({
      code: 'ENGINE_INVALID_RESPONSE',
    });
  });

  it.each([
    ['missing removed count', { ...info, failed_entries: 0 }],
    ['negative failed count', { ...info, removed_entries: 0, failed_entries: -1 }],
  ] as const)('rejects an invalid clear response with %s', async (_label, response) => {
    invoke.mockResolvedValueOnce(response);

    await expect(localEngineAdapter.ocrCacheClear()).rejects.toMatchObject({
      code: 'ENGINE_INVALID_RESPONSE',
    });
  });

  it('maps a native cache call failure to a safe adapter error', async () => {
    invoke.mockRejectedValueOnce(new Error('private cache path must not be shown'));

    await expect(localEngineAdapter.ocrCacheClear()).rejects.toMatchObject({
      code: 'ENGINE_HEALTH_FAILED',
      message: '清除 OCR 缓存失败。',
    });
  });
});
