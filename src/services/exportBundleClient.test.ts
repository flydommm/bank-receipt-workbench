import { describe, expect, it, vi } from 'vitest';
import { ExportBundleClient, ExportBundleError, parseExportBundlePreview, parseExportBundleReceipt, validateExportScopeRequest,
  type ExportBundlePreview, type ExportBundleReceipt, type ExportScopeRequest } from './exportBundleClient';

const intent = '12345678-1234-1234-1234-123456789012';
const fileToken = '22222222-1234-1234-1234-123456789012';
const sha = 'a'.repeat(64);
const customName = '自定义结果';
const sourceFileToken = '33333333-1234-1234-1234-123456789012';
function request(): ExportScopeRequest { return { job_id: 'job', result_revision: 'result', scope_kind: 'list', selected_segment_ids: ['segment'],
  expected_records: [{ id: 'segment', record_revision: 1 }], output_mode: 'merged', include_xlsx: false }; }
function preview(): ExportBundlePreview { return { intent_id: intent, state: 'rendered', job_id: 'job', result_revision: 'result', scope_kind: 'list',
  selected_segment_ids: ['segment'], source_fingerprint: sha, review_revision: sha, output_mode: 'merged', include_xlsx: false,
  summary: { total_segments: 3, selected_count: 1, selected_source_count: 1, omitted_count: 2, omitted_unresolved_count: 1, expected_pages: 1 },
  files: [{ file_id: 'merged', name: '全部匹配结果.pdf', source_key: null, page_count: 1, preview_token: fileToken,
    preview_path: `C:/private/export-previews/${fileToken}.pdf`, sha256: sha, size_bytes: 300 }], merged_pages: 1, source_pages: 0, total_pages: 1 }; }
function receipt(): ExportBundleReceipt { return { intent_id: intent, state: 'published', directory: 'D:/out/PDF查找_20260908_100000_12345678',
  files: [{ name: '全部匹配结果.pdf', path: 'D:/out/PDF查找_20260908_100000_12345678/全部匹配结果.pdf', kind: 'pdf', sha256: sha, size_bytes: 300, page_count: 1 },
    { name: '导出清单.json', path: 'D:/out/PDF查找_20260908_100000_12345678/导出清单.json', kind: 'json', sha256: 'b'.repeat(64), size_bytes: 700 }],
  summary: preview().summary, merged_pages: 1, source_pages: 0, total_pages: 1, row_count: 0 }; }

function namedPreview(output_mode: ExportScopeRequest['output_mode']): ExportBundlePreview {
  const mergedFile = { ...preview().files[0]!, name: `${customName}.pdf` };
  const sourceFile = { ...preview().files[0]!, file_id: 'source-001', name: `${customName}_001__source__匹配结果.pdf`,
    source_key: 'source', preview_token: sourceFileToken, preview_path: `C:/private/export-previews/${sourceFileToken}.pdf` };
  const files = output_mode === 'merged' ? [mergedFile] : output_mode === 'by_source' ? [sourceFile] : [mergedFile, sourceFile];
  const merged_pages = output_mode === 'by_source' ? 0 : 1;
  const source_pages = output_mode === 'merged' ? 0 : 1;
  return { ...preview(), output_mode, output_name: customName, files, merged_pages, source_pages, total_pages: merged_pages + source_pages };
}

function namedReceipt(value: ExportBundlePreview): ExportBundleReceipt {
  const directory = 'D:/out/PDF查找_20260908_100000_12345678';
  return { intent_id: value.intent_id, state: 'published', directory,
    files: [...value.files.map((file) => ({ name: file.name, path: `${directory}/${file.name}`, kind: 'pdf' as const,
      sha256: file.sha256, size_bytes: file.size_bytes, page_count: file.page_count })),
      { name: '导出清单.json', path: `${directory}/导出清单.json`, kind: 'json' as const, sha256: 'b'.repeat(64), size_bytes: 700 }],
    summary: value.summary, merged_pages: value.merged_pages, source_pages: value.source_pages,
    total_pages: value.total_pages, row_count: 0,
    ...(value.output_mode === 'by_source' ? {} : { merged_name: `${customName}.pdf` }) };
}

describe('frozen export bundle boundary', () => {
  it('rejects incomplete recovery receipts without relying on a live preview', () => {
    const empty = receipt(); empty.files = empty.files.filter((file) => file.kind === 'json');
    empty.merged_pages = 0; empty.total_pages = 0;
    expect(() => parseExportBundleReceipt(empty)).toThrow(ExportBundleError);
    const swapped = receipt(); swapped.merged_pages = 0; swapped.source_pages = 1;
    expect(() => parseExportBundleReceipt(swapped)).toThrow(ExportBundleError);
  });
  it('sends only explicit scope and revision identity, detached from later edits', async () => {
    const input = request();
    let resolve!: (value: unknown) => void;
    const invoke = vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; }));
    const client = new ExportBundleClient(invoke);
    const running = client.create(input);
    input.selected_segment_ids.push('later'); input.expected_records[0]!.record_revision = 9;
    resolve({ status: 'ok', data: preview() });
    expect(await running).toEqual(preview());
    expect(invoke).toHaveBeenCalledWith('export_bundle_command', { request: { op: 'create', scope: request() } });
  });
  it.each(['duplicate', 'forged-revision', 'unsaved', 'extra-path', 'empty'] as const)('rejects %s requests before IPC', (change) => {
    const value = request();
    if (change === 'duplicate') value.selected_segment_ids.push('segment');
    if (change === 'forged-revision') value.expected_records[0]!.id = 'other';
    if (change === 'unsaved') value.expected_records[0]!.record_revision = 0;
    if (change === 'extra-path') Object.assign(value, { preview_root: 'D:/foreign' });
    if (change === 'empty') value.selected_segment_ids = [];
    expect(() => validateExportScopeRequest(value)).toThrow(ExportBundleError);
  });
  it.each(['task', 'revision', 'scope', 'xlsx', 'pages', 'file-token', 'duplicate-file', 'omitted'] as const)('rejects mismatched preview %s', (change) => {
    const value = preview();
    if (change === 'task') value.job_id = 'other';
    if (change === 'revision') value.result_revision = 'other';
    if (change === 'scope') value.selected_segment_ids = ['other'];
    if (change === 'xlsx') value.include_xlsx = true;
    if (change === 'pages') value.total_pages = 2;
    if (change === 'file-token') value.files[0]!.preview_path = 'D:/foreign.pdf';
    if (change === 'duplicate-file') value.files.push(value.files[0]!);
    if (change === 'omitted') value.summary.omitted_unresolved_count = 3;
    expect(() => parseExportBundlePreview(value, request())).toThrow(ExportBundleError);
  });
  it('accepts both-mode mapping counts and rejects a missing source PDF', () => {
    const value = preview(); const input = { ...request(), output_mode: 'both' as const };
    value.output_mode = 'both'; value.source_pages = 1; value.total_pages = 2;
    const secondToken = '33333333-1234-1234-1234-123456789012';
    value.files.push({ ...value.files[0]!, file_id: 'source-001', name: '001__source__匹配结果.pdf', source_key: 'source',
      preview_token: secondToken, preview_path: `C:/private/export-previews/${secondToken}.pdf` });
    expect(parseExportBundlePreview(value, input).files).toHaveLength(2);
    value.files.pop();
    expect(() => parseExportBundlePreview(value, input)).toThrow();
  });
  it.each(['merged', 'by_source', 'both'] as const)('publishes custom names for %s output', async (output_mode) => {
    const value = namedPreview(output_mode);
    const published = namedReceipt(value);
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data: published });
    const client = new ExportBundleClient(invoke);
    const result = await client.publish(value, 'D:/out');
    if (output_mode === 'by_source') {
      expect(result.merged_name).toBeUndefined();
      expect(parseExportBundleReceipt(published).merged_name).toBeUndefined();
    } else {
      expect(result.merged_name).toBe(`${customName}.pdf`);
      expect(parseExportBundleReceipt(published).merged_name).toBe(`${customName}.pdf`);
    }
  });
  it.each(['sha', 'size', 'pages', 'missing-manifest', 'outside', 'extra-xlsx', 'different-intent'] as const)('rejects published %s mismatch', (change) => {
    const value = receipt();
    if (change === 'sha') value.files[0]!.sha256 = 'c'.repeat(64);
    if (change === 'size') value.files[0]!.size_bytes = 301;
    if (change === 'pages') value.files[0]!.page_count = 2;
    if (change === 'missing-manifest') value.files.pop();
    if (change === 'outside') value.files[0]!.path = 'D:/other/全部匹配结果.pdf';
    if (change === 'extra-xlsx') value.files.push({ name: '匹配索引.xlsx', path: `${value.directory}/匹配索引.xlsx`, kind: 'xlsx', size_bytes: 900, sha256: sha });
    if (change === 'different-intent') value.intent_id = fileToken;
    expect(() => parseExportBundleReceipt(value, preview())).toThrow(ExportBundleError);
  });
  it('publishes with only token and chosen parent and checks returned exact PDFs', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data: receipt() });
    const client = new ExportBundleClient(invoke);
    expect(await client.publish(preview(), 'D:/out')).toEqual(receipt());
    expect(invoke).toHaveBeenCalledWith('export_bundle_command', { request: { op: 'publish', intent_id: intent, directory: 'D:/out' } });
  });
  it('keeps residual locations for a failed publication and does not call close', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'error', code: 'export_publish_failed', message: '发布失败，临时文件已保留。',
      residuals: [{ path: 'D:/out/.temporary', reason: '存在未登记文件' }] });
    const client = new ExportBundleClient(invoke);
    await expect(client.publish(preview(), 'D:/out')).rejects.toMatchObject({ code: 'export_publish_failed',
      residuals: [{ path: 'D:/out/.temporary', reason: '存在未登记文件' }] });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('validates close and recovery status independently of changed task sources', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ status: 'ok', data: { intent_id: intent, state: 'closed' } })
      .mockResolvedValueOnce({ status: 'ok', data: { job_id: 'job', publication: receipt(), residuals: [] } });
    const client = new ExportBundleClient(invoke);
    await client.close(intent);
    expect((await client.status('job')).publication).toEqual(receipt());
  });
});
