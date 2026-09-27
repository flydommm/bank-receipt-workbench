import { describe, expect, it, vi } from 'vitest';
import { ExportBundleClient, ExportBundleError, parseExportBundlePreview, parseExportBundleReceipt, validateExportScopeRequest,
  type ExportBundlePreview, type ExportBundleReceipt, type ExportScopeRequest } from './exportBundleClient';

const intent = '12345678-1234-1234-1234-123456789012';
const fileToken = '22222222-1234-1234-1234-123456789012';
const sha = 'a'.repeat(64);
const customName = '自定义结果';
const sourceFileToken = '33333333-1234-1234-1234-123456789012';
const splitMergedName = '全部回单.pdf';
const splitSourceFileToken = '44444444-1234-1234-1234-123456789012';
const excludedDigest = '74b4be57118305c2ccca624a96d97beacc7f1019e70a8ced7c98591ef18cf685';
const emptyExcludedDigest = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const excludedAudit = { id: 'excluded-1', source_key: '/a.pdf', source_sha256: sha, source_page: 1, instance_id: 'instance-1',
  slot_id: 'slot-2', position_index: 2, record_revision: 1, decision: 'excluded' as const, reviewed_at: '2026-09-20T12:00:00.000Z' };
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

function splitPreview(output_mode: ExportScopeRequest['output_mode'], output_name?: string): ExportBundlePreview {
  const mergedFile = { ...preview().files[0]!, name: output_name === undefined ? splitMergedName : `${output_name}.pdf` };
  const sourceFile = { ...preview().files[0]!, file_id: 'source-001', name: output_name === undefined
    ? '001__source__回单分割结果.pdf' : `${output_name}_001__source__回单分割结果.pdf`, source_key: 'source',
  preview_token: splitSourceFileToken, preview_path: `C:/private/export-previews/${splitSourceFileToken}.pdf` };
  const files = output_mode === 'merged' ? [mergedFile] : output_mode === 'by_source' ? [sourceFile] : [mergedFile, sourceFile];
  const merged_pages = output_mode === 'by_source' ? 0 : 1;
  const source_pages = output_mode === 'merged' ? 0 : 1;
  return { ...preview(), output_mode, files, merged_pages, source_pages, total_pages: merged_pages + source_pages,
    ...(output_name === undefined ? {} : { output_name }) };
}

function receiptForPreview(value: ExportBundlePreview, includeMergedName = false): ExportBundleReceipt {
  const directory = 'D:/out/PDF查找_20260908_100000_12345678';
  return { intent_id: value.intent_id, state: 'published', directory,
    files: [...value.files.map((file) => ({ name: file.name, path: `${directory}/${file.name}`, kind: 'pdf' as const,
      sha256: file.sha256, size_bytes: file.size_bytes, page_count: file.page_count })),
      { name: '导出清单.json', path: `${directory}/导出清单.json`, kind: 'json' as const, sha256: 'b'.repeat(64), size_bytes: 700 }],
    summary: value.summary, merged_pages: value.merged_pages, source_pages: value.source_pages,
    total_pages: value.total_pages, row_count: 0,
    ...(includeMergedName && value.output_mode !== 'by_source'
      ? { merged_name: value.files.find((file) => file.file_id === 'merged')!.name } : {}) };
}

function excludedPreview(): ExportBundlePreview {
  const value = preview();
  value.summary = { total_segments: 2, selected_count: 1, selected_source_count: 1, omitted_count: 1,
    omitted_unresolved_count: 0, excluded_count: 1, expected_pages: 1 };
  value.receipt_schema = 2;
  value.excluded = [excludedAudit]; value.excluded_digest = excludedDigest;
  return value;
}

function excludedReceipt(value: ExportBundlePreview): ExportBundleReceipt {
  const result = receiptForPreview(value);
  result.receipt_schema = value.receipt_schema;
  result.summary = value.summary;
  result.excluded = value.excluded;
  result.excluded_digest = value.excluded_digest;
  return result;
}

describe('frozen export bundle boundary', () => {
  it('parses and attests schema2 exclusion audit while retaining legacy decoding', () => {
    const value = excludedPreview();
    const parsed = parseExportBundlePreview(value, request());
    expect(parsed.excluded).toEqual([excludedAudit]);
    expect(parsed.excluded_digest).toBe(excludedDigest);
    const empty = preview();
    empty.receipt_schema = 2; empty.excluded = []; empty.excluded_digest = emptyExcludedDigest;
    empty.summary = { total_segments: 1, selected_count: 1, selected_source_count: 1, omitted_count: 0,
      omitted_unresolved_count: 0, excluded_count: 0, expected_pages: 1 };
    expect(parseExportBundlePreview(empty, request()).excluded).toEqual([]);
    const receiptValue = excludedReceipt(value);
    expect(parseExportBundleReceipt(receiptValue, parsed).excluded).toEqual([excludedAudit]);

    const badDigest = excludedPreview(); badDigest.excluded_digest = '0'.repeat(64);
    expect(() => parseExportBundlePreview(badDigest, request())).toThrow(ExportBundleError);
    const missingDigest = excludedPreview(); delete missingDigest.excluded_digest;
    expect(() => parseExportBundlePreview(missingDigest, request())).toThrow(ExportBundleError);
    const badSummary = excludedPreview(); badSummary.summary.excluded_count = 0;
    expect(() => parseExportBundlePreview(badSummary, request())).toThrow(ExportBundleError);
    const badDecision = excludedPreview(); (badDecision.excluded![0] as any).decision = 'confirmed';
    expect(() => parseExportBundlePreview(badDecision, request())).toThrow(ExportBundleError);
    const genericLegacy = preview();
    expect(parseExportBundlePreview(genericLegacy, request()).receipt_schema).toBeUndefined();
    expect(() => parseExportBundlePreview(genericLegacy, request(), 2)).toThrow(ExportBundleError);
    const badReceipt = excludedReceipt(value); delete badReceipt.receipt_schema;
    expect(() => parseExportBundleReceipt(badReceipt, parsed)).toThrow(ExportBundleError);
  });

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
  it.each(['duplicate', 'forged-revision', 'negative-revision', 'extra-path', 'empty'] as const)('rejects %s requests before IPC', (change) => {
    const value = request();
    if (change === 'duplicate') value.selected_segment_ids.push('segment');
    if (change === 'forged-revision') value.expected_records[0]!.id = 'other';
    if (change === 'negative-revision') value.expected_records[0]!.record_revision = -1;
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
  it.each(['merged', 'both', 'by_source'] as const)('accepts split_all default filenames for %s previews', (output_mode) => {
    const value = splitPreview(output_mode);
    const input = { ...request(), output_mode };
    expect(parseExportBundlePreview(value, input).files.map((file) => file.name)).toEqual(value.files.map((file) => file.name));
  });
  it('rejects an unexpected default merged filename without a custom name', () => {
    const value = splitPreview('merged');
    value.files[0]!.name = '全部回单结果.pdf';
    expect(() => parseExportBundlePreview(value, request())).toThrow(ExportBundleError);
  });
  it('rejects an unexpected default merged filename in a recovery receipt', () => {
    const value = splitPreview('merged');
    const published = receiptForPreview(value);
    published.files[0]!.name = '全部回单结果.pdf';
    published.files[0]!.path = `${published.directory}/全部回单结果.pdf`;
    expect(() => parseExportBundleReceipt(published)).toThrow(ExportBundleError);
  });
  it('keeps custom merged names exact for split_all previews', () => {
    const value = splitPreview('both', customName);
    const parsed = parseExportBundlePreview(value, { ...request(), output_mode: 'both', output_name: customName });
    expect(parsed.output_name).toBe(customName);
    expect(parsed.files.map((file) => file.name)).toEqual([`${customName}.pdf`, `${customName}_001__source__回单分割结果.pdf`]);
    value.files[0]!.name = splitMergedName;
    expect(() => parseExportBundlePreview(value, { ...request(), output_mode: 'both', output_name: customName })).toThrow(ExportBundleError);
  });
  it.each(['merged', 'both', 'by_source'] as const)('publishes split_all %s output with legacy-compatible receipt names', async (output_mode) => {
    const value = splitPreview(output_mode);
    const published = receiptForPreview(value);
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data: published });
    const result = await new ExportBundleClient(invoke).publish(value, 'D:/out');
    expect(result.files.map((file) => file.name)).toEqual(published.files.map((file) => file.name));
    expect(result.merged_name).toBeUndefined();
  });
  it.each(['merged', 'both', 'by_source'] as const)('recovers split_all %s publication when merged_name is omitted', async (output_mode) => {
    const value = splitPreview(output_mode);
    const published = receiptForPreview(value);
    const invoke = vi.fn().mockResolvedValue({ status: 'ok', data: { job_id: 'job', publication: published, residuals: [] } });
    const status = await new ExportBundleClient(invoke).status('job');
    expect(status.publication?.files.map((file) => file.name)).toEqual(published.files.map((file) => file.name));
  });
  it('uses the preview merged filename when an old receipt omits merged_name', () => {
    const value = splitPreview('merged');
    const published = receiptForPreview(value);
    expect(parseExportBundleReceipt(published, value).files[0]?.name).toBe(splitMergedName);
  });
  it('uses a custom preview merged filename instead of guessing a legacy default', () => {
    const value = splitPreview('merged', customName);
    const published = receiptForPreview(value);
    expect(parseExportBundleReceipt(published, value).files[0]?.name).toBe(`${customName}.pdf`);
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

describe('optional external manifest contract', () => {
  it.each([false, true])('preserves explicit include_manifest=%s in requests and previews', (enabled) => {
    const scope = { ...request(), output_name: '结果', include_manifest: enabled };
    const rendered = { ...namedPreview('merged'), output_name: '结果', include_manifest: enabled };
    rendered.files[0]!.name = '结果.pdf';
    expect(validateExportScopeRequest(scope)).toEqual(scope);
    expect(parseExportBundlePreview(rendered, scope).include_manifest).toBe(enabled);
    expect(() => parseExportBundlePreview({ ...rendered, include_manifest: !enabled }, scope)).toThrow();
    const without: ExportBundlePreview = { ...rendered }; delete without.include_manifest;
    expect(() => parseExportBundlePreview(without, scope)).toThrow();
  });
  it.each(['false', 0, null, undefined])('rejects a present non-boolean manifest option %s', (value) => {
    expect(() => validateExportScopeRequest({ ...request(), include_manifest: value } as any)).toThrow();
    expect(() => parseExportBundlePreview({ ...preview(), include_manifest: value }, request())).toThrow();
    expect(() => parseExportBundleReceipt({ ...receipt(), include_manifest: value })).toThrow();
  });
  it.each([false, true])('validates the exact attachment set in receipt and status for include_manifest=%s', (enabled) => {
    const rendered = { ...preview(), include_manifest: enabled };
    const published = { ...receipt(), include_manifest: enabled };
    if (!enabled) published.files = published.files.filter((file) => file.kind !== 'json');
    expect(parseExportBundleReceipt(published, rendered).include_manifest).toBe(enabled);
    expect(parseExportBundleReceipt(published).include_manifest).toBe(enabled);
    expect(() => parseExportBundleReceipt({ ...published, include_manifest: !enabled }, rendered)).toThrow();
    const wrongFiles = { ...published, files: enabled ? published.files.filter((file) => file.kind !== 'json') : receipt().files };
    expect(() => parseExportBundleReceipt(wrongFiles, rendered)).toThrow();
    expect(() => parseExportBundleReceipt(published, preview())).toThrow();
  });
  it('retains the legacy required-manifest contract when the field is absent', () => {
    expect(validateExportScopeRequest(request())).not.toHaveProperty('include_manifest');
    expect(parseExportBundlePreview(preview(), request())).not.toHaveProperty('include_manifest');
    expect(parseExportBundleReceipt(receipt(), preview())).not.toHaveProperty('include_manifest');
    expect(() => parseExportBundleReceipt({ ...receipt(), files: receipt().files.filter((file) => file.kind !== 'json') })).toThrow();
  });
});
