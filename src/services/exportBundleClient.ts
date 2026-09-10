import { invoke } from '@tauri-apps/api/core';
import type { ExportOutputMode } from '../domain/exportIntent';
import { normalizeExportName, validateExportName } from '../domain/exportNaming';
import { sameExportPath } from '../components/localEngineAdapter';

export type ExportScopeRequest = {
  job_id: string;
  result_revision: string;
  scope_kind: 'all' | 'sources' | 'list';
  selected_segment_ids: string[];
  expected_records: Array<{ id: string; record_revision: number }>;
  output_mode: ExportOutputMode;
  include_xlsx: boolean;
  output_name?: string;
};
export type ExportScopeSummary = {
  total_segments: number; selected_count: number; selected_source_count: number;
  omitted_count: number; omitted_unresolved_count: number; expected_pages: number;
};
export type ExportBundleFile = {
  file_id: string; name: string; source_key: string | null; page_count: number;
  preview_token: string; preview_path: string; sha256: string; size_bytes: number;
};
export type ExportBundlePreview = {
  intent_id: string; state: 'rendered'; job_id: string; result_revision: string;
  scope_kind: ExportScopeRequest['scope_kind']; selected_segment_ids: string[];
  source_fingerprint: string; review_revision: string; output_mode: ExportOutputMode;
  include_xlsx: boolean; summary: ExportScopeSummary; files: ExportBundleFile[];
  merged_pages: number; source_pages: number; total_pages: number;
  output_name?: string;
};
export type ExportPublishedFile = {
  name: string; path: string; kind: 'pdf' | 'xlsx' | 'json'; sha256: string;
  size_bytes: number; page_count?: number;
};
export type ExportBundleReceipt = {
  intent_id: string; state: 'published'; directory: string; files: ExportPublishedFile[];
  summary: ExportScopeSummary; merged_pages: number; source_pages: number; total_pages: number; row_count: number;
  merged_name?: string;
};
export type ExportResidual = { path: string; reason: string };
export type ExportPublicationStatus = { job_id: string; publication: ExportBundleReceipt | null; residuals: ExportResidual[] };
type BundleInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class ExportBundleError extends Error {
  constructor(readonly code: string, message: string, readonly residuals: ExportResidual[] = []) {
    super(message);
    this.name = 'ExportBundleError';
  }
}

function invalid(): never { throw new ExportBundleError('ENGINE_INVALID_RESPONSE', '导出返回内容与已确认范围不一致，请重新生成预览。'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 1024): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > limit) return invalid();
  return value;
}
function count(value: unknown, max = 50_000, positive = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > max) return invalid();
  return value;
}
function hash(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) return invalid();
  return result;
}
function token(value: unknown): string {
  const result = text(value, 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result)) return invalid();
  return result;
}
function path(value: unknown): string {
  const result = text(value, 32768);
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(result)) return invalid();
  return result;
}
function filename(value: unknown): string {
  const result = text(value, 240);
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(result) || /[ .]$/.test(result) || /^\.{1,2}$/.test(result)) return invalid();
  return result;
}
function outputName(value: unknown): string {
  const result = text(value, 512);
  if (validateExportName(result) !== null) return invalid();
  return normalizeExportName(result);
}
function array(value: unknown, max: number, nonempty = false): unknown[] {
  if (!Array.isArray(value) || value.length > max || (nonempty && !value.length)) return invalid();
  return value;
}
function mode(value: unknown): ExportOutputMode {
  if (value !== 'merged' && value !== 'by_source' && value !== 'both') return invalid();
  return value;
}
function scopeKind(value: unknown): ExportScopeRequest['scope_kind'] {
  if (value !== 'all' && value !== 'sources' && value !== 'list') return invalid();
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') return invalid(); return value; }
function summary(value: unknown): ExportScopeSummary {
  const data = object(value);
  const result = {
    total_segments: count(data.total_segments, 50_000, true), selected_count: count(data.selected_count, 50_000, true),
    selected_source_count: count(data.selected_source_count, 10_000, true), omitted_count: count(data.omitted_count),
    omitted_unresolved_count: count(data.omitted_unresolved_count), expected_pages: count(data.expected_pages, 50_000, true),
  };
  if (result.selected_count + result.omitted_count !== result.total_segments
      || result.omitted_unresolved_count > result.omitted_count || result.expected_pages > result.selected_count
      || result.selected_source_count > result.selected_count) return invalid();
  return result;
}
function residuals(value: unknown): ExportResidual[] {
  return array(value ?? [], 4096).map((entry) => { const item = object(entry); return { path: path(item.path), reason: text(item.reason, 4096) }; });
}
function unpack(value: unknown): unknown {
  const result = object(value);
  if (result.status === 'error') throw new ExportBundleError(text(result.code, 128), text(result.message, 4096), residuals(result.residuals));
  if (result.status !== 'ok') return invalid();
  return result.data;
}

export function validateExportScopeRequest(value: ExportScopeRequest): ExportScopeRequest {
  const data = object(value);
  const fields = ['job_id', 'result_revision', 'scope_kind', 'selected_segment_ids', 'expected_records', 'output_mode', 'include_xlsx'];
  const keys = Object.keys(data);
  if ((keys.length !== fields.length && keys.length !== fields.length + 1)
      || fields.some((key) => !(key in data))
      || keys.some((key) => !fields.includes(key) && key !== 'output_name')) return invalid();
  const ids = array(data.selected_segment_ids, 50_000, true).map((id) => text(id));
  const selected = new Set(ids);
  const seen = new Set<string>();
  const expected = array(data.expected_records, 50_000, true).map((entry) => {
    const row = object(entry); const id = text(row.id);
    if (Object.keys(row).length !== 2 || !selected.has(id) || seen.has(id)) return invalid();
    seen.add(id);
    return { id, record_revision: count(row.record_revision, Number.MAX_SAFE_INTEGER, true) };
  });
  if (selected.size !== ids.length || expected.length !== ids.length) return invalid();
  const output_name = 'output_name' in data ? outputName(data.output_name) : undefined;
  return { job_id: text(data.job_id), result_revision: text(data.result_revision), scope_kind: scopeKind(data.scope_kind),
    selected_segment_ids: ids, expected_records: expected, output_mode: mode(data.output_mode), include_xlsx: bool(data.include_xlsx),
    ...(output_name === undefined ? {} : { output_name }) };
}

export function parseExportBundlePreview(value: unknown, request: ExportScopeRequest): ExportBundlePreview {
  const data = object(value);
  if (data.state !== 'rendered' || data.job_id !== request.job_id || data.result_revision !== request.result_revision
      || data.scope_kind !== request.scope_kind || data.output_mode !== request.output_mode || data.include_xlsx !== request.include_xlsx) return invalid();
  const requestedOutputName = request.output_name;
  const returnedOutputName = data.output_name === undefined ? undefined : outputName(data.output_name);
  if (returnedOutputName !== requestedOutputName) return invalid();
  const ids = array(data.selected_segment_ids, 50_000, true).map((id) => text(id));
  const selected = new Set(ids);
  if (ids.length !== request.selected_segment_ids.length || selected.size !== ids.length
      || request.selected_segment_ids.some((id) => !selected.has(id))) return invalid();
  const scope = summary(data.summary);
  if (scope.selected_count !== ids.length || (request.scope_kind === 'all' && scope.omitted_count !== 0)) return invalid();
  const tokens = new Set<string>(); const names = new Set<string>(); const fileIds = new Set<string>(); const sources = new Set<string>();
  const files = array(data.files, 501, true).map((entry): ExportBundleFile => {
    const file = object(entry);
    const parsed = { file_id: text(file.file_id), name: filename(file.name), source_key: file.source_key === null ? null : text(file.source_key),
      page_count: count(file.page_count, 50_000, true), preview_token: token(file.preview_token), preview_path: path(file.preview_path),
      sha256: hash(file.sha256), size_bytes: count(file.size_bytes, Number.MAX_SAFE_INTEGER, true) };
    const basename = parsed.preview_path.split(/[\\/]/).pop();
    if (!parsed.name.endsWith('.pdf') || basename !== `${parsed.preview_token}.pdf`
        || tokens.has(parsed.preview_token) || names.has(parsed.name.toLocaleLowerCase()) || fileIds.has(parsed.file_id)) return invalid();
    tokens.add(parsed.preview_token); names.add(parsed.name.toLocaleLowerCase()); fileIds.add(parsed.file_id);
    if (parsed.source_key !== null) { if (sources.has(parsed.source_key)) return invalid(); sources.add(parsed.source_key); }
    if ((parsed.file_id === 'merged') !== (parsed.source_key === null)
        || (parsed.file_id === 'merged'
          && parsed.name !== `${requestedOutputName ?? '全部匹配结果'}.pdf`)) return invalid();
    return parsed;
  });
  const merged = files.filter((file) => file.file_id === 'merged').reduce((total, file) => total + file.page_count, 0);
  const separate = files.filter((file) => file.file_id !== 'merged').reduce((total, file) => total + file.page_count, 0);
  if (count(data.merged_pages) !== merged || count(data.source_pages) !== separate || count(data.total_pages, 100_000) !== merged + separate
      || (request.output_mode === 'merged' && (files.length !== 1 || merged !== scope.expected_pages || separate !== 0))
      || (request.output_mode === 'by_source' && (merged !== 0 || separate !== scope.expected_pages || sources.size !== scope.selected_source_count))
      || (request.output_mode === 'both' && (merged !== scope.expected_pages || separate !== scope.expected_pages || sources.size !== scope.selected_source_count))) return invalid();
  return { intent_id: token(data.intent_id), state: 'rendered', job_id: request.job_id, result_revision: request.result_revision,
    scope_kind: request.scope_kind, selected_segment_ids: ids, source_fingerprint: hash(data.source_fingerprint), review_revision: hash(data.review_revision),
    output_mode: request.output_mode, include_xlsx: request.include_xlsx, summary: scope, files, merged_pages: merged, source_pages: separate, total_pages: merged + separate,
    ...(requestedOutputName === undefined ? {} : { output_name: requestedOutputName }) };
}

export function parseExportBundleReceipt(value: unknown, preview?: ExportBundlePreview): ExportBundleReceipt {
  const data = object(value);
  if (data.state !== 'published') return invalid();
  const directory = path(data.directory);
  const declaredMergedName = data.merged_name === undefined ? undefined : filename(data.merged_name);
  if (declaredMergedName !== undefined && !declaredMergedName.endsWith('.pdf')) return invalid();
  const names = new Set<string>();
  const files = array(data.files, 503, true).map((entry): ExportPublishedFile => {
    const file = object(entry); const kind = file.kind;
    if (kind !== 'pdf' && kind !== 'xlsx' && kind !== 'json') return invalid();
    const parsed: ExportPublishedFile = { name: filename(file.name), path: path(file.path), kind, sha256: hash(file.sha256), size_bytes: count(file.size_bytes, Number.MAX_SAFE_INTEGER, true) };
    if (!sameExportPath(parsed.path, `${directory.replace(/[\\/]$/, '')}/${parsed.name}`) || names.has(parsed.name.toLocaleLowerCase())
        || (kind === 'xlsx' && parsed.name !== '匹配索引.xlsx') || (kind === 'json' && parsed.name !== '导出清单.json')
        || (kind === 'pdf' && !parsed.name.endsWith('.pdf'))) return invalid();
    names.add(parsed.name.toLocaleLowerCase());
    if (kind === 'pdf') parsed.page_count = count(file.page_count, 50_000, true);
    else if (file.page_count !== undefined) return invalid();
    return parsed;
  });
  const scope = summary(data.summary);
  const mergedPages = count(data.merged_pages); const sourcePages = count(data.source_pages);
  const totalPages = count(data.total_pages, 100_000); const rowCount = count(data.row_count);
  const pdfFiles = files.filter((file) => file.kind === 'pdf');
  const inferredMergedName = declaredMergedName ?? (pdfFiles.some((file) => file.name === '全部匹配结果.pdf')
    ? '全部匹配结果.pdf' : undefined);
  const mergedFiles = inferredMergedName === undefined ? [] : pdfFiles.filter((file) => file.name === inferredMergedName);
  const sourceFiles = inferredMergedName === undefined
    ? pdfFiles
    : pdfFiles.filter((file) => file.name !== inferredMergedName);
  if (declaredMergedName !== undefined && mergedFiles.length !== 1) return invalid();
  if (!pdfFiles.length || mergedFiles.length > 1
      || mergedFiles.reduce((total, file) => total + file.page_count!, 0) !== mergedPages
      || sourceFiles.reduce((total, file) => total + file.page_count!, 0) !== sourcePages
      || (mergedFiles.length > 0 && mergedPages !== scope.expected_pages)
      || (sourceFiles.length > 0 && (sourcePages !== scope.expected_pages || sourceFiles.length !== scope.selected_source_count))) return invalid();
  if (mergedPages + sourcePages !== totalPages || files.filter((file) => file.kind === 'json').length !== 1
      || files.filter((file) => file.kind === 'pdf').reduce((total, file) => total + file.page_count!, 0) !== totalPages
      || (files.some((file) => file.kind === 'xlsx') ? rowCount !== scope.selected_count : rowCount !== 0)) return invalid();
  const result: ExportBundleReceipt = { intent_id: token(data.intent_id), state: 'published', directory, files, summary: scope,
    merged_pages: mergedPages, source_pages: sourcePages, total_pages: totalPages, row_count: rowCount };
  if (declaredMergedName !== undefined) result.merged_name = declaredMergedName;
  if (preview) {
    const pdfs = files.filter((file) => file.kind === 'pdf');
    const previewMergedName = preview.files.find((file) => file.file_id === 'merged')?.name;
    if (previewMergedName !== undefined && inferredMergedName !== previewMergedName) return invalid();
    // by_source previews intentionally have no merged PDF. A custom name is
    // required to identify the merged artifact only for modes that include
    // that artifact; source files are validated by their complete set below.
    if (preview.output_name !== undefined && preview.output_mode !== 'by_source'
        && inferredMergedName !== `${preview.output_name}.pdf`) return invalid();
    if (result.intent_id !== preview.intent_id || mergedPages !== preview.merged_pages || sourcePages !== preview.source_pages
        || totalPages !== preview.total_pages || JSON.stringify(scope) !== JSON.stringify(preview.summary)
        || files.some((file) => file.kind === 'xlsx') !== preview.include_xlsx || pdfs.length !== preview.files.length) return invalid();
    const byName = new Map(pdfs.map((file) => [file.name, file]));
    for (const file of preview.files) {
      const published = byName.get(file.name);
      if (!published || published.sha256 !== file.sha256 || published.size_bytes !== file.size_bytes || published.page_count !== file.page_count) return invalid();
    }
  }
  return result;
}

export class ExportBundleClient {
  constructor(private readonly call: BundleInvoke = invoke) {}
  async create(request: ExportScopeRequest): Promise<ExportBundlePreview> {
    const detached = validateExportScopeRequest(request);
    return parseExportBundlePreview(unpack(await this.call('export_bundle_command', { request: { op: 'create', scope: detached } })), detached);
  }
  async publish(preview: ExportBundlePreview, directory: string): Promise<ExportBundleReceipt> {
    const selectedDirectory = path(directory);
    const result = parseExportBundleReceipt(unpack(await this.call('export_bundle_command', { request: { op: 'publish', intent_id: token(preview.intent_id), directory: selectedDirectory } })), preview);
    if (!sameExportPath(result.directory.split(/[\\/]/).slice(0, -1).join('/'), selectedDirectory)) return invalid();
    return result;
  }
  async close(intentId: string): Promise<void> {
    const id = token(intentId);
    const data = object(unpack(await this.call('export_bundle_command', { request: { op: 'close', intent_id: id } })));
    if (data.intent_id !== id || data.state !== 'closed') return invalid();
  }
  async status(jobId: string): Promise<ExportPublicationStatus> {
    const job = text(jobId);
    const data = object(unpack(await this.call('export_bundle_command', { request: { op: 'status', job_id: job } })));
    if (data.job_id !== job) return invalid();
    return { job_id: job, publication: data.publication === null ? null : parseExportBundleReceipt(data.publication), residuals: residuals(data.residuals) };
  }
}
