import { invoke } from '@tauri-apps/api/core';
import type { ExportOutputMode } from '../domain/exportIntent';
import { normalizeExportName, validateExportName } from '../domain/exportNaming';
import { sameExportPath } from '../components/localEngineAdapter';
import { exportProgressChannel, type ExportProgress } from './exportProgress';

export type ReceiptExportOutputMode = ExportOutputMode | 'by_counterparty' | 'by_counterparty_merged';
export type GroupedExportBinding = {
  expected_grouping_revision: number;
  expected_review_fingerprint: string;
  own_account_fingerprint: string;
  include_counterparty_pending: boolean;
};

export type ExportScopeRequest = {
  job_id: string;
  result_revision: string;
  scope_kind: 'all' | 'sources' | 'list';
  selected_segment_ids: string[];
  expected_records: Array<{ id: string; record_revision: number }>;
  output_mode: ReceiptExportOutputMode;
  include_xlsx: boolean;
  include_manifest?: boolean;
  output_name?: string;
} & Partial<GroupedExportBinding>;
export type ExportScopeSummary = {
  total_segments: number; selected_count: number; selected_source_count: number;
  omitted_count: number; omitted_unresolved_count: number; expected_pages: number; excluded_count?: number;
};
export type ExportExcludedItem = {
  id: string; source_key: string; source_sha256: string; source_page: number; instance_id: string;
  slot_id: string; position_index: number; record_revision: number; decision: 'excluded'; reviewed_at: string;
};
export type ExportBundleFile = {
  file_id: string; name: string; source_key: string | null; page_count: number;
  preview_token: string; preview_path: string; sha256: string; size_bytes: number;
  group_id?: string; group_kind?: string; group_name?: string; grouped_pages?: number;
};
export type ExportBundlePreview = {
  intent_id: string; state: 'rendered'; job_id: string; result_revision: string;
  scope_kind: ExportScopeRequest['scope_kind']; selected_segment_ids: string[];
  source_fingerprint: string; review_revision: string; output_mode: ReceiptExportOutputMode;
  include_xlsx: boolean; summary: ExportScopeSummary; files: ExportBundleFile[];
  include_manifest?: boolean;
  merged_pages: number; source_pages: number; total_pages: number;
  receipt_schema?: 2;
  excluded?: ExportExcludedItem[]; excluded_digest?: string;
  output_name?: string;
  grouped_pages?: number;
} & Partial<GroupedExportBinding>;
export type ExportPublishedFile = {
  name: string; path: string; kind: 'pdf' | 'xlsx' | 'json'; sha256: string;
  size_bytes: number; page_count?: number;
  group_id?: string; group_kind?: string; group_name?: string; grouped_pages?: number;
};
export type ExportBundleReceipt = {
  intent_id: string; state: 'published'; directory: string; files: ExportPublishedFile[];
  summary: ExportScopeSummary; merged_pages: number; source_pages: number; total_pages: number; row_count: number;
  output_mode?: ReceiptExportOutputMode;
  receipt_schema?: 2;
  excluded?: ExportExcludedItem[]; excluded_digest?: string;
  merged_name?: string;
  include_manifest?: boolean;
  grouped_pages?: number;
} & Partial<GroupedExportBinding>;
export type ExportResidual = { path: string; reason: string };
export type ExportPublicationStatus = { job_id: string; publication: ExportBundleReceipt | null; residuals: ExportResidual[] };
type BundleInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class ExportBundleError extends Error {
  constructor(readonly code: string, message: string, readonly residuals: ExportResidual[] = []) {
    super(message);
    this.name = 'ExportBundleError';
  }
}

function invalid(): never { throw new ExportBundleError('ENGINE_INVALID_RESPONSE', '导出返回内容与已确认范围不一致，请重试导出。'); }
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
const DEFAULT_MERGED_FILENAMES = new Set(['全部匹配结果.pdf', '全部回单.pdf']);
const DEFAULT_GROUPED_MERGED_FILENAME = '全部分组回单.pdf';
const GROUP_KINDS = new Set(['named', 'internal', 'blank', 'special', 'counterparty_pending']);
function array(value: unknown, max: number, nonempty = false): unknown[] {
  if (!Array.isArray(value) || value.length > max || (nonempty && !value.length)) return invalid();
  return value;
}
function mode(value: unknown): ReceiptExportOutputMode {
  if (value !== 'merged' && value !== 'by_source' && value !== 'both' && value !== 'by_counterparty' && value !== 'by_counterparty_merged') return invalid();
  return value;
}
function groupedMode(value: unknown): value is 'by_counterparty' | 'by_counterparty_merged' {
  return value === 'by_counterparty' || value === 'by_counterparty_merged';
}
function groupKind(value: unknown): string {
  const result = text(value, 64);
  if (!GROUP_KINDS.has(result)) return invalid();
  return result;
}
function scopeKind(value: unknown): ExportScopeRequest['scope_kind'] {
  if (value !== 'all' && value !== 'sources' && value !== 'list') return invalid();
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') return invalid(); return value; }
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return invalid();
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value !== 'object') return invalid();
  const data = value as Record<string, unknown>;
  return `{${Object.keys(data).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(data[key])}`).join(',')}}`;
}
function sha256Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const blockCount = Math.ceil((bytes.length + 9) / 64);
  const words = new Uint32Array(blockCount * 16);
  for (let index = 0; index < bytes.length; index += 1) {
    words[index >>> 2] |= bytes[index]! << (24 - ((index & 3) * 8));
  }
  words[bytes.length >>> 2] |= 0x80 << (24 - ((bytes.length & 3) * 8));
  const bitLength = bytes.length * 8;
  words[words.length - 2] = Math.floor(bitLength / 0x100000000) >>> 0;
  words[words.length - 1] = bitLength >>> 0;
  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  const schedule = new Uint32Array(64);
  const rotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
  for (let block = 0; block < words.length; block += 16) {
    for (let index = 0; index < 16; index += 1) schedule[index] = words[block + index]!;
    for (let index = 16; index < 64; index += 1) {
      const s0 = (rotate(schedule[index - 15]!, 7) ^ rotate(schedule[index - 15]!, 18) ^ (schedule[index - 15]! >>> 3)) >>> 0;
      const s1 = (rotate(schedule[index - 2]!, 17) ^ rotate(schedule[index - 2]!, 19) ^ (schedule[index - 2]! >>> 10)) >>> 0;
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) >>> 0;
      const choose = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + choose + SHA256_K[index]! + schedule[index]!) >>> 0;
      const s0 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
}
function sourceKey(value: unknown): string {
  const result = text(value, 32_768);
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(result) || result !== result.trim()
      || result.includes('\\') || result !== result.toLowerCase()) return invalid();
  return result;
}
function reviewedAt(value: unknown): string {
  const result = text(value, 64);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/.exec(result);
  if (!parts || Number.isNaN(Date.parse(result))) return invalid();
  const parsed = new Date(result);
  if (parsed.getUTCFullYear() !== Number(parts[1]) || parsed.getUTCMonth() + 1 !== Number(parts[2])
      || parsed.getUTCDate() !== Number(parts[3]) || parsed.getUTCHours() !== Number(parts[4])
      || parsed.getUTCMinutes() !== Number(parts[5]) || parsed.getUTCSeconds() !== Number(parts[6])) return invalid();
  return result;
}
const EXCLUDED_FIELDS = ['id', 'source_key', 'source_sha256', 'source_page', 'instance_id', 'slot_id',
  'position_index', 'record_revision', 'decision', 'reviewed_at'] as const;
function excludedItem(value: unknown): ExportExcludedItem {
  const data = object(value);
  if (Object.keys(data).length !== EXCLUDED_FIELDS.length || EXCLUDED_FIELDS.some((key) => !(key in data))) return invalid();
  const result: ExportExcludedItem = {
    id: text(data.id), source_key: sourceKey(data.source_key), source_sha256: hash(data.source_sha256),
    source_page: count(data.source_page, Number.MAX_SAFE_INTEGER, true), instance_id: text(data.instance_id),
    slot_id: text(data.slot_id), position_index: count(data.position_index, 10_000, true),
    record_revision: count(data.record_revision, Number.MAX_SAFE_INTEGER, true), decision: 'excluded', reviewed_at: reviewedAt(data.reviewed_at),
  };
  if (data.decision !== 'excluded') return invalid();
  return result;
}
function excludedContract(data: Record<string, unknown>): { present: boolean; excluded: ExportExcludedItem[]; excluded_digest?: string } {
  const hasExcluded = Object.prototype.hasOwnProperty.call(data, 'excluded');
  const hasDigest = Object.prototype.hasOwnProperty.call(data, 'excluded_digest');
  if (hasExcluded !== hasDigest) return invalid();
  if (!hasExcluded) return { present: false, excluded: [] };
  const entries = array(data.excluded, 50_000).map(excludedItem);
  const ids = new Set<string>(); const logical = new Set<string>();
  for (const entry of entries) {
    const identity = `${entry.source_key}\u0000${entry.instance_id}`;
    if (ids.has(entry.id) || logical.has(identity)) return invalid();
    ids.add(entry.id); logical.add(identity);
  }
  const digest = hash(data.excluded_digest);
  if (digest !== sha256Utf8(canonicalJson(entries))) return invalid();
  return { present: true, excluded: entries, excluded_digest: digest };
}
function summary(value: unknown): ExportScopeSummary {
  const data = object(value);
  const result = {
    total_segments: count(data.total_segments, 50_000, true), selected_count: count(data.selected_count, 50_000, true),
    selected_source_count: count(data.selected_source_count, 10_000, true), omitted_count: count(data.omitted_count),
    omitted_unresolved_count: count(data.omitted_unresolved_count), expected_pages: count(data.expected_pages, 50_000, true),
  };
  const hasExcludedCount = Object.prototype.hasOwnProperty.call(data, 'excluded_count');
  const excluded_count = hasExcludedCount ? count(data.excluded_count, 50_000) : undefined;
  if (result.selected_count + result.omitted_count !== result.total_segments
      || result.omitted_unresolved_count > result.omitted_count || result.expected_pages > result.selected_count
      || result.selected_source_count > result.selected_count
      || (excluded_count !== undefined && (result.omitted_count !== excluded_count || result.omitted_unresolved_count !== 0
        || result.total_segments !== result.selected_count + excluded_count))) return invalid();
  return excluded_count === undefined ? result : { ...result, excluded_count };
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

export type ExportBundleClientOptions = { expectedReceiptSchema?: 2; onProgress?: (progress: ExportProgress) => void };

const GROUPING_FIELDS = ['expected_grouping_revision', 'expected_review_fingerprint', 'own_account_fingerprint', 'include_counterparty_pending'] as const;
function groupedBinding(data: Record<string, unknown>, required: boolean): GroupedExportBinding | undefined {
  const present = GROUPING_FIELDS.filter((field) => field in data).length;
  if (!required) { if (present) return invalid(); return undefined; }
  if (present !== GROUPING_FIELDS.length) return invalid();
  return { expected_grouping_revision: count(data.expected_grouping_revision, Number.MAX_SAFE_INTEGER),
    expected_review_fingerprint: hash(data.expected_review_fingerprint), own_account_fingerprint: hash(data.own_account_fingerprint),
    include_counterparty_pending: bool(data.include_counterparty_pending) };
}

export function validateExportScopeRequest(value: ExportScopeRequest): ExportScopeRequest {
  const data = object(value);
  const fields = ['job_id', 'result_revision', 'scope_kind', 'selected_segment_ids', 'expected_records', 'output_mode', 'include_xlsx'];
  const keys = Object.keys(data);
  if (fields.some((key) => !(key in data))
      || keys.some((key) => !fields.includes(key) && key !== 'output_name' && key !== 'include_manifest' && !GROUPING_FIELDS.includes(key as typeof GROUPING_FIELDS[number]))) return invalid();
  const ids = array(data.selected_segment_ids, 50_000, true).map((id) => text(id));
  const selected = new Set(ids);
  const seen = new Set<string>();
  const expected = array(data.expected_records, 50_000, true).map((entry) => {
    const row = object(entry); const id = text(row.id);
    if (Object.keys(row).length !== 2 || !selected.has(id) || seen.has(id)) return invalid();
    seen.add(id);
    // Revision 0 denotes an untouched automatic candidate. It is safe here
    // because the backend binds that candidate to the immutable task snapshot.
    return { id, record_revision: count(row.record_revision, Number.MAX_SAFE_INTEGER) };
  });
  if (selected.size !== ids.length || expected.length !== ids.length) return invalid();
  const output_name = 'output_name' in data ? outputName(data.output_name) : undefined;
  const requestedMode = mode(data.output_mode);
  const grouping = groupedBinding(data, groupedMode(requestedMode));
  if (grouping && !data.include_xlsx) return invalid();
  return { job_id: text(data.job_id), result_revision: text(data.result_revision), scope_kind: scopeKind(data.scope_kind),
    selected_segment_ids: ids, expected_records: expected, output_mode: requestedMode, include_xlsx: bool(data.include_xlsx),
    ...('include_manifest' in data ? { include_manifest: bool(data.include_manifest) } : {}),
    ...grouping,
    ...(output_name === undefined ? {} : { output_name }) };
}

export function parseExportBundlePreview(value: unknown, request: ExportScopeRequest, expectedReceiptSchema?: 2): ExportBundlePreview {
  const data = object(value);
  const receiptSchema = data.receipt_schema === undefined ? undefined : data.receipt_schema === 2 ? 2 : invalid();
  if (expectedReceiptSchema !== undefined && receiptSchema !== expectedReceiptSchema) return invalid();
  const grouped = groupedMode(request.output_mode);
  const groupedMerged = request.output_mode === 'by_counterparty_merged';
  const grouping = groupedBinding(data, grouped);
  if (grouped && (receiptSchema !== 2 || GROUPING_FIELDS.some((field) => data[field] !== request[field]))) return invalid();
  if (data.state !== 'rendered' || data.job_id !== request.job_id || data.result_revision !== request.result_revision
      || data.scope_kind !== request.scope_kind || data.output_mode !== request.output_mode || data.include_xlsx !== request.include_xlsx) return invalid();
  const requestedOutputName = request.output_name;
  const returnedOutputName = data.output_name === undefined ? undefined : outputName(data.output_name);
  if (returnedOutputName !== requestedOutputName) return invalid();
  const includeManifest = 'include_manifest' in data ? bool(data.include_manifest) : undefined;
  if (includeManifest !== request.include_manifest) return invalid();
  const ids = array(data.selected_segment_ids, 50_000, true).map((id) => text(id));
  const selected = new Set(ids);
  if (ids.length !== request.selected_segment_ids.length || selected.size !== ids.length
      || request.selected_segment_ids.some((id) => !selected.has(id))) return invalid();
  const scope = summary(data.summary);
  const exclusions = excludedContract(data);
  if (scope.selected_count !== ids.length || (request.scope_kind === 'all' && scope.omitted_count !== 0)) return invalid();
  if (exclusions.present) {
    if (scope.excluded_count !== exclusions.excluded.length
        || exclusions.excluded.some((entry) => selected.has(entry.id))) return invalid();
  } else if (scope.excluded_count !== undefined) {
    return invalid();
  }
  if ((receiptSchema === 2) !== exclusions.present) return invalid();
  const tokens = new Set<string>(); const names = new Set<string>(); const fileIds = new Set<string>(); const sources = new Set<string>(); const groups = new Set<string>();
  const allowedMergedNames = requestedOutputName === undefined
    ? DEFAULT_MERGED_FILENAMES : new Set([`${requestedOutputName}.pdf`]);
  const allowedGroupedMergedName = requestedOutputName === undefined
    ? DEFAULT_GROUPED_MERGED_FILENAME : `${requestedOutputName}.pdf`;
  const files = array(data.files, 501, true).map((entry): ExportBundleFile => {
    const file = object(entry);
    const hasGroupIdentityFields = ['group_id', 'group_kind', 'group_name'].some((field) => field in file);
    const parsed = { file_id: text(file.file_id), name: filename(file.name), source_key: file.source_key === null ? null : text(file.source_key),
      page_count: count(file.page_count, 50_000, true), preview_token: token(file.preview_token), preview_path: path(file.preview_path),
      sha256: hash(file.sha256), size_bytes: count(file.size_bytes, Number.MAX_SAFE_INTEGER, true),
      ...(grouped && !groupedMerged ? { group_id: text(file.group_id),
        group_kind: groupKind(file.group_kind), group_name: text(file.group_name),
        grouped_pages: count(file.grouped_pages, 50_000, true),
      } : {}),
      ...(groupedMerged ? { grouped_pages: count(file.grouped_pages, 50_000, true) } : {}) };
    const basename = parsed.preview_path.split(/[\\/]/).pop();
    if (!parsed.name.endsWith('.pdf') || basename !== `${parsed.preview_token}.pdf`
        || tokens.has(parsed.preview_token) || names.has(parsed.name.toLocaleLowerCase()) || fileIds.has(parsed.file_id)) return invalid();
    tokens.add(parsed.preview_token); names.add(parsed.name.toLocaleLowerCase()); fileIds.add(parsed.file_id);
    if (parsed.source_key !== null) { if (sources.has(parsed.source_key)) return invalid(); sources.add(parsed.source_key); }
    if (groupedMerged) {
      if (hasGroupIdentityFields || parsed.source_key !== null || parsed.file_id !== 'grouped-merged'
          || parsed.grouped_pages !== parsed.page_count || parsed.name !== allowedGroupedMergedName) return invalid();
    } else if (grouped) {
      if (parsed.source_key !== null || !parsed.group_id || groups.has(parsed.group_id) || parsed.file_id !== `group:${parsed.group_id}`) return invalid();
      if (parsed.grouped_pages !== parsed.page_count) return invalid();
      groups.add(parsed.group_id);
    } else if (hasGroupIdentityFields || file.grouped_pages !== undefined || (parsed.file_id === 'merged') !== (parsed.source_key === null)
        || (parsed.file_id === 'merged'
          && !allowedMergedNames.has(parsed.name))) return invalid();
    return parsed;
  });
  const merged = files.filter((file) => file.file_id === 'merged').reduce((total, file) => total + file.page_count, 0);
  const separate = groupedMerged ? 0 : files.filter((file) => file.file_id !== 'merged').reduce((total, file) => total + file.page_count, 0);
  const sourcePages = grouped ? 0 : separate;
  const groupedPages = grouped ? count(data.grouped_pages) : 0;
  const totalPages = count(data.total_pages, 100_000);
  const expectedTotalPages = groupedMerged ? merged + groupedPages : merged + separate;
  if ((grouped ? groupedPages !== (groupedMerged ? files.reduce((total, file) => total + file.page_count, 0) : separate)
      || (groupedMerged ? (files.length !== 1 || merged !== 0 || separate !== 0 || !files[0] || files[0].file_id !== 'grouped-merged')
        : separate !== scope.expected_pages)
      || (groupedMerged ? groupedPages !== scope.expected_pages : false)
      || !grouping || !request.include_xlsx : data.grouped_pages !== undefined)
      || count(data.merged_pages) !== merged || count(data.source_pages) !== sourcePages || totalPages !== expectedTotalPages
      || (request.output_mode === 'merged' && (files.length !== 1 || merged !== scope.expected_pages || separate !== 0))
      || (request.output_mode === 'by_source' && (merged !== 0 || separate !== scope.expected_pages || sources.size !== scope.selected_source_count))
      || (request.output_mode === 'both' && (merged !== scope.expected_pages || separate !== scope.expected_pages || sources.size !== scope.selected_source_count))) return invalid();
  return { intent_id: token(data.intent_id), state: 'rendered', job_id: request.job_id, result_revision: request.result_revision,
    scope_kind: request.scope_kind, selected_segment_ids: ids, source_fingerprint: hash(data.source_fingerprint), review_revision: hash(data.review_revision),
    output_mode: request.output_mode, include_xlsx: request.include_xlsx, summary: scope, files, merged_pages: merged, source_pages: sourcePages,
    total_pages: totalPages,
    ...grouping, ...(grouped ? { grouped_pages: groupedPages } : {}),
    ...(receiptSchema === 2 ? { receipt_schema: 2 as const } : {}),
    ...(includeManifest === undefined ? {} : { include_manifest: includeManifest }),
    ...(exclusions.present ? { excluded: exclusions.excluded, excluded_digest: exclusions.excluded_digest } : {}),
    ...(requestedOutputName === undefined ? {} : { output_name: requestedOutputName }) };
}

export function parseExportBundleReceipt(value: unknown, preview?: ExportBundlePreview, expectedReceiptSchema?: 2): ExportBundleReceipt {
  const data = object(value);
  const receiptSchema = data.receipt_schema === undefined ? undefined : data.receipt_schema === 2 ? 2 : invalid();
  if (expectedReceiptSchema !== undefined && receiptSchema !== expectedReceiptSchema) return invalid();
  const declaredOutputMode = data.output_mode === undefined ? undefined : mode(data.output_mode);
  const grouped = data.grouped_pages !== undefined || (declaredOutputMode !== undefined && groupedMode(declaredOutputMode))
    || Boolean(preview && groupedMode(preview.output_mode));
  const groupedMerged = declaredOutputMode === 'by_counterparty_merged' || preview?.output_mode === 'by_counterparty_merged';
  if (declaredOutputMode !== undefined && grouped && !groupedMode(declaredOutputMode)) return invalid();
  const grouping = groupedBinding(data, grouped);
  const groupedPages = grouped ? count(data.grouped_pages, 50_000, true) : 0;
  if (grouped && receiptSchema !== 2) return invalid();
  if (data.state !== 'published') return invalid();
  const includeManifest = 'include_manifest' in data ? bool(data.include_manifest) : undefined;
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
    if (kind === 'pdf') {
      parsed.page_count = count(file.page_count, 50_000, true);
      if (grouped && file.group_id !== undefined) parsed.group_id = text(file.group_id);
      if (grouped && file.group_kind !== undefined) parsed.group_kind = groupKind(file.group_kind);
      if (grouped && file.group_name !== undefined) parsed.group_name = text(file.group_name);
      if (grouped && file.grouped_pages !== undefined) parsed.grouped_pages = count(file.grouped_pages, 50_000, true);
      const hasGroupFields = ['group_id', 'group_kind', 'group_name'].some((field) => field in file);
      if (groupedMerged && (hasGroupFields || file.grouped_pages === undefined || parsed.grouped_pages !== parsed.page_count)) return invalid();
      if (grouped && !groupedMerged && (file.group_id === undefined || file.group_kind === undefined
          || file.group_name === undefined || file.grouped_pages === undefined || parsed.grouped_pages !== parsed.page_count)) return invalid();
      if (!grouped && ['group_id', 'group_kind', 'group_name', 'grouped_pages'].some((field) => field in file)) return invalid();
    }
    else if (file.page_count !== undefined) return invalid();
    return parsed;
  });
  const scope = summary(data.summary);
  const exclusions = excludedContract(data);
  if (exclusions.present) {
    if (scope.excluded_count !== exclusions.excluded.length) return invalid();
  } else if (scope.excluded_count !== undefined) {
    return invalid();
  }
  if ((receiptSchema === 2) !== exclusions.present) return invalid();
  const mergedPages = count(data.merged_pages); const sourcePages = count(data.source_pages);
  const totalPages = count(data.total_pages, 100_000); const rowCount = count(data.row_count);
  const pdfFiles = files.filter((file) => file.kind === 'pdf');
  const previewMergedName = preview?.files.find((file) => file.file_id === 'merged')?.name;
  const previewGroupedMergedName = preview?.files.find((file) => file.file_id === 'grouped-merged')?.name;
  const legacyMergedCandidates = preview === undefined && !grouped
    ? pdfFiles.filter((file) => DEFAULT_MERGED_FILENAMES.has(file.name)) : [];
  if (declaredMergedName === undefined && preview === undefined && !grouped
      && pdfFiles.some((file) => DEFAULT_MERGED_FILENAMES.has(file.name))
      && legacyMergedCandidates.length !== 1) return invalid();
  const inferredMergedName = declaredMergedName ?? previewMergedName
    ?? (legacyMergedCandidates.length === 1 ? legacyMergedCandidates[0]!.name : undefined);
  const mergedFiles = inferredMergedName === undefined ? [] : pdfFiles.filter((file) => file.name === inferredMergedName);
  const sourceFiles = grouped ? [] : inferredMergedName === undefined
    ? pdfFiles
    : pdfFiles.filter((file) => file.name !== inferredMergedName);
  if (declaredMergedName !== undefined && mergedFiles.length !== 1) return invalid();
  if (groupedMerged) {
    const groupedMergedName = previewGroupedMergedName
      ?? (preview === undefined ? undefined : (preview.output_name === undefined ? DEFAULT_GROUPED_MERGED_FILENAME : `${preview.output_name}.pdf`));
    if (pdfFiles.length !== 1 || (groupedMergedName !== undefined && pdfFiles[0]!.name !== groupedMergedName) || declaredMergedName !== undefined
        || mergedPages !== 0 || sourcePages !== 0 || groupedPages !== scope.expected_pages
        || totalPages !== groupedPages || !files.some((file) => file.kind === 'xlsx')) return invalid();
  } else if (grouped && (declaredMergedName !== undefined || mergedPages !== 0 || sourcePages !== 0 || groupedPages !== scope.expected_pages
      || !files.some((file) => file.kind === 'xlsx'))) return invalid();
  if (!pdfFiles.length || (!groupedMerged && mergedFiles.length > 1)
      || (!groupedMerged && mergedFiles.reduce((total, file) => total + file.page_count!, 0) !== mergedPages)
      || (!groupedMerged && sourceFiles.reduce((total, file) => total + file.page_count!, 0) !== sourcePages)
      || (!groupedMerged && mergedFiles.length > 0 && mergedPages !== scope.expected_pages)
      || (!groupedMerged && sourceFiles.length > 0 && (sourcePages !== scope.expected_pages || sourceFiles.length !== scope.selected_source_count))) return invalid();
  if (mergedPages + sourcePages + groupedPages !== totalPages || files.filter((file) => file.kind === 'json').length !== Number(includeManifest ?? true)
      || files.filter((file) => file.kind === 'pdf').reduce((total, file) => total + file.page_count!, 0) !== totalPages
      || (files.some((file) => file.kind === 'xlsx') ? rowCount !== scope.selected_count : rowCount !== 0)) return invalid();
  const result: ExportBundleReceipt = { intent_id: token(data.intent_id), state: 'published', directory, files, summary: scope,
    merged_pages: mergedPages, source_pages: sourcePages, total_pages: totalPages, row_count: rowCount,
    ...(declaredOutputMode === undefined ? {} : { output_mode: declaredOutputMode }),
    ...grouping, ...(grouped ? { grouped_pages: groupedPages } : {}) };
  if (receiptSchema === 2) result.receipt_schema = 2;
  if (includeManifest !== undefined) result.include_manifest = includeManifest;
  if (exclusions.present) { result.excluded = exclusions.excluded; result.excluded_digest = exclusions.excluded_digest; }
  if (declaredMergedName !== undefined) result.merged_name = declaredMergedName;
  if (preview) {
    const pdfs = files.filter((file) => file.kind === 'pdf');
    if (previewMergedName !== undefined && inferredMergedName !== previewMergedName) return invalid();
    if (groupedMerged && previewGroupedMergedName !== undefined && pdfs.length !== 1) return invalid();
    // by_source previews intentionally have no merged PDF. A custom name is
    // required to identify the merged artifact only for modes that include
    // that artifact; source files are validated by their complete set below.
    if (preview.output_name !== undefined && preview.output_mode !== 'by_source' && preview.output_mode !== 'by_counterparty'
        && preview.output_mode !== 'by_counterparty_merged'
        && inferredMergedName !== `${preview.output_name}.pdf`) return invalid();
    if (result.intent_id !== preview.intent_id || mergedPages !== preview.merged_pages || sourcePages !== preview.source_pages
        || totalPages !== preview.total_pages || grouped !== groupedMode(preview.output_mode)
        || (declaredOutputMode !== undefined && declaredOutputMode !== preview.output_mode)
        || (grouped && (groupedPages !== preview.grouped_pages
          || GROUPING_FIELDS.some((field) => data[field] !== preview[field]))) || JSON.stringify(scope) !== JSON.stringify(preview.summary)
        || receiptSchema !== preview.receipt_schema
        || includeManifest !== preview.include_manifest
        || exclusions.present !== (preview.excluded !== undefined || preview.excluded_digest !== undefined)
        || (exclusions.present && (JSON.stringify(exclusions.excluded) !== JSON.stringify(preview.excluded)
          || exclusions.excluded_digest !== preview.excluded_digest))
        || files.some((file) => file.kind === 'xlsx') !== preview.include_xlsx || pdfs.length !== preview.files.length) return invalid();
    const byName = new Map(pdfs.map((file) => [file.name, file]));
    for (const file of preview.files) {
      const published = byName.get(file.name);
      if (!published || published.sha256 !== file.sha256 || published.size_bytes !== file.size_bytes || published.page_count !== file.page_count) return invalid();
      for (const field of ['group_id', 'group_kind', 'group_name', 'grouped_pages'] as const) {
        if (published[field] !== file[field]) return invalid();
      }
    }
  }
  return result;
}

export class ExportBundleClient {
  constructor(private readonly call: BundleInvoke = invoke, private readonly options: ExportBundleClientOptions = {}) {}
  private async callWithProgress(request: Record<string, unknown>): Promise<unknown> {
    const progress = this.options.onProgress ? exportProgressChannel(this.options.onProgress) : null;
    try {
      return await this.call('export_bundle_command', { request, ...(progress ? { onProgress: progress.channel } : {}) });
    } finally {
      progress?.close();
    }
  }
  async create(request: ExportScopeRequest): Promise<ExportBundlePreview> {
    const detached = validateExportScopeRequest(request);
    return parseExportBundlePreview(unpack(await this.callWithProgress({ op: 'create', scope: detached })), detached, this.options.expectedReceiptSchema);
  }
  async publish(preview: ExportBundlePreview, directory: string): Promise<ExportBundleReceipt> {
    const selectedDirectory = path(directory);
    const result = parseExportBundleReceipt(unpack(await this.callWithProgress({ op: 'publish', intent_id: token(preview.intent_id), directory: selectedDirectory })), preview, this.options.expectedReceiptSchema);
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
    return { job_id: job, publication: data.publication === null ? null : parseExportBundleReceipt(data.publication, undefined, this.options.expectedReceiptSchema), residuals: residuals(data.residuals) };
  }
}
