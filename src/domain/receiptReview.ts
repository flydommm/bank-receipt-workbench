import { MIN_CROP_SIZE, type PdfRect } from './cropReview';
import {
  makeInstanceId,
  near,
  parsePageGeometry,
  parseProcessingOptions,
  type LayoutDefinition,
  type PageGeometry,
  type ProcessingMode,
  type ProcessingOptions,
  type SelectionBasis,
} from './receiptLayout';

/**
 * Pure schema-3 receipt-review models.
 *
 * This module is deliberately independent from the UI, IPC, persistence, and
 * PDF readers.  It accepts JSON-shaped data, validates the immutable binding
 * and geometry, and returns cloned values.  Context and processing fingerprints
 * use the same compact, sorted-key UTF-8 JSON rule as the Python engine.  The
 * authoritative original manifest remains owned by the backend.
 */

export const RECEIPT_REVIEW_CONTEXT_VERSION = 3 as const;
export const RECEIPT_REVIEW_EDIT_SCHEMA_VERSION = 1 as const;
/** The persistent page/item codec remains schema 2 beside context schema 3. */
export const RECEIPT_SNAPSHOT_CODEC_VERSION = 2 as const;
export const MAX_RECEIPT_REVIEW_ORIGINALS = 50_000;
export const MAX_RECEIPT_REVIEW_SOURCES = 10_000;
export const MAX_RECEIPT_REVIEW_SNAPSHOT_ITEMS = 50_000;
export const MAX_RECEIPT_REVIEW_ITEM_BYTES = 4 * 1024 * 1024;
export const MAX_RECEIPT_REVIEW_EDIT_BYTES = MAX_RECEIPT_REVIEW_ITEM_BYTES;
export const MAX_RECEIPT_REVIEW_RECORD_BYTES = MAX_RECEIPT_REVIEW_ITEM_BYTES;

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_REVIEW_ORIGINALS_BYTES = 128 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ITEMS = 250_000;
const MAX_PATH_BYTES = 32_768;
const MAX_VERSION_BYTES = 256;
const MAX_IDENTIFIER_BYTES = 1_024;
const MAX_LAYOUT_SLOTS = 1_000;
const SHA_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const INCLUDE_QUERY_PATTERN = /^include-(?:[0-9]|[12][0-9]|3[01])$/;
const RECT_FIELDS = ['x0', 'y0', 'x1', 'y1'] as const;
const CONTEXT_FIELDS = [
  'version', 'sources', 'processing_options', 'match_mode', 'criteria_fingerprint', 'computation_version',
] as const;
const SOURCE_FIELDS = ['source_key', 'source_path', 'source_sha256'] as const;
const ORIGINAL_FIELDS = [
  'id', 'source_key', 'source_page', 'instance_id', 'slot_id', 'position_index',
  'layout_id', 'layout_revision', 'layout_signature', 'page_geometry',
  'candidate_rect', 'occupancy', 'selection_basis', 'needs_review', 'analysis_signature',
] as const;
const EDIT_FIELDS = [
  'schema_version', 'context_key', 'result_revision', 'id', 'source_key', 'instance_id',
  'analysis_signature', 'record_revision', 'final_rect', 'crop_mode', 'review_status',
  'manual_adjusted', 'reviewed_at',
] as const;
const RECORD_FIELDS = [
  'schema_version', 'context_key', 'result_revision', 'record_revision', 'source_path',
  'source_sha256', 'original', 'final_rect', 'crop_mode', 'review_status',
  'manual_adjusted', 'reviewed_at',
] as const;
const SEGMENT_FIELDS = [...ORIGINAL_FIELDS, 'source_path', 'source_sha256', 'final_rect', 'crop_mode',
  'review_status', 'manual_adjusted'] as const;
const CROP_MODES = ['candidate', 'manual', 'full_page'] as const;
const REVIEW_STATUSES = ['pending', 'needs_review', 'confirmed', 'page_confirmed', 'blocked', 'excluded'] as const;

export type ReceiptReviewCropMode = typeof CROP_MODES[number];
export type ReceiptReviewStatus = typeof REVIEW_STATUSES[number];
export type ReceiptReviewMatchMode = 'exact' | 'fuzzy';
export const RECEIPT_DOCUMENT_TYPES = ['ordinary', 'other_special', 'loan_settlement_notice', 'loan_interest_notice', 'electronic_tax_payment'] as const;
export type ReceiptDocumentType = typeof RECEIPT_DOCUMENT_TYPES[number];
export const isReceiptDocumentType = (value: unknown): value is ReceiptDocumentType =>
  typeof value === 'string' && RECEIPT_DOCUMENT_TYPES.some((type) => type === value);

export type ReceiptReviewContextSource = {
  source_key: string;
  source_path: string;
  source_sha256: string;
};

export type ReceiptReviewContext = {
  version: typeof RECEIPT_REVIEW_CONTEXT_VERSION;
  sources: ReceiptReviewContextSource[];
  processing_options: ProcessingOptions;
  match_mode: ReceiptReviewMatchMode;
  criteria_fingerprint: string;
  computation_version: string;
};

export type ReceiptReviewOriginal = {
  id: string;
  source_key: string;
  source_page: number;
  instance_id: string;
  slot_id: string;
  position_index: number;
  layout_id: string;
  layout_revision: number;
  layout_signature: string;
  page_geometry: PageGeometry;
  candidate_rect: PdfRect;
  occupancy: 'occupied' | 'uncertain';
  selection_basis: SelectionBasis;
  needs_review: boolean;
  analysis_signature: string;
};

export type ReceiptReviewEdit = {
  document_type?: ReceiptDocumentType;
  schema_version: typeof RECEIPT_REVIEW_EDIT_SCHEMA_VERSION;
  context_key: string;
  result_revision: string;
  id: string;
  source_key: string;
  instance_id: string;
  analysis_signature: string;
  record_revision: number;
  final_rect: PdfRect | null;
  crop_mode: ReceiptReviewCropMode;
  review_status: ReceiptReviewStatus;
  manual_adjusted: boolean;
  reviewed_at: string;
};

export type ReceiptReviewRecord = {
  document_type?: ReceiptDocumentType;
  schema_version: typeof RECEIPT_REVIEW_EDIT_SCHEMA_VERSION;
  context_key: string;
  result_revision: string;
  record_revision: number;
  source_path: string;
  source_sha256: string;
  original: ReceiptReviewOriginal;
  final_rect: PdfRect | null;
  crop_mode: ReceiptReviewCropMode;
  review_status: ReceiptReviewStatus;
  manual_adjusted: boolean;
  reviewed_at: string;
};

export type ReceiptSnapshotEvidence = { query_id: string; rect: PdfRect };

export type ReceiptSnapshotSegment = ReceiptReviewOriginal & {
  source_path: string;
  source_sha256: string;
  final_rect: PdfRect;
  crop_mode: 'candidate';
  review_status: 'needs_review' | 'confirmed';
  manual_adjusted: false;
};

export type ReceiptSnapshotItem = {
  segment: ReceiptSnapshotSegment;
  evidence: ReceiptSnapshotEvidence[];
  original: ReceiptReviewOriginal;
};

export type ReceiptReviewErrorCode =
  | 'invalid_shape'
  | 'invalid_context'
  | 'invalid_source'
  | 'invalid_geometry'
  | 'invalid_original'
  | 'invalid_edit'
  | 'invalid_record'
  | 'invalid_snapshot'
  | 'invalid_hash'
  | 'invalid_instance'
  | 'invalid_revision';

export class ReceiptReviewError extends Error {
  constructor(
    public readonly code: ReceiptReviewErrorCode,
    public readonly path: string,
    message = `${code}: ${path}`,
  ) {
    super(message);
    this.name = 'ReceiptReviewError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type ReceiptReviewContextValidationOptions = {
  /**
   * Permit a source_path alias only after the caller has verified it against
   * source_sha256.  Aliases are retained for access and excluded from context_key.
   */
  trustedAliases?: boolean;
};

export type ReceiptReviewContextValidation = {
  context: ReceiptReviewContext;
  sourceShaByKey: Record<string, string>;
  contextKey: string;
};

export type ReceiptReviewOriginalValidationOptions = {
  /** Optional verified context/processing mode for source-of-truth selection checks. */
  context?: ReceiptReviewContext;
  processingMode?: ProcessingMode;
};

type JsonRecord = Record<string, unknown>;

function fail(code: ReceiptReviewErrorCode, path: string, message?: string): never {
  throw new ReceiptReviewError(code, path, message ?? `${code}: ${path}`);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function utf8Bytes(value: string): number {
  if (hasUnpairedSurrogate(value)) fail('invalid_shape', 'json', 'text must contain valid Unicode');
  return new TextEncoder().encode(value).byteLength;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) fail('invalid_shape', 'json', 'numbers must be finite');
  // Preserve the sign for -0 values while normalizing the JSON text used by
  // context/fingerprint inputs.  Original geometry is validated structurally;
  // its authoritative manifest bytes remain backend-owned.
  if (Object.is(value, -0)) return '-0.0';
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('invalid_shape', 'json');
  const exponent = encoded.indexOf('e');
  if (exponent < 0) return encoded;
  const mantissa = encoded.slice(0, exponent);
  const rawExponent = encoded.slice(exponent + 1);
  const sign = rawExponent.startsWith('-') ? '-' : '+';
  const digits = rawExponent.replace(/^[+-]/, '').padStart(2, '0');
  return `${mantissa}e${sign}${digits}`;
}

function canonicalJsonInner(value: unknown, depth: number, count: { value: number }, stack: Set<object>): string {
  if (depth > MAX_JSON_DEPTH) fail('invalid_shape', 'json', 'JSON nesting exceeds the limit');
  count.value += 1;
  if (count.value > MAX_JSON_ITEMS) fail('invalid_shape', 'json', 'JSON item count exceeds the limit');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      utf8Bytes(value);
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return canonicalNumber(value);
    case 'object': {
      if (stack.has(value)) fail('invalid_shape', 'json', 'cyclic JSON is not supported');
      stack.add(value);
      let output: string;
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value)) fail('invalid_shape', `json[${index}]`, 'sparse arrays are not supported');
        }
        output = `[${value.map((item) => canonicalJsonInner(item, depth + 1, count, stack)).join(',')}]`;
      } else {
        const record = value as JsonRecord;
        const keys = Object.keys(record).sort(compareUnicodeCodePoints);
        output = `{${keys.map((key) => {
          const keyJson = JSON.stringify(key);
          return `${keyJson}:${canonicalJsonInner(record[key], depth + 1, count, stack)}`;
        }).join(',')}}`;
      }
      stack.delete(value);
      return output;
    }
    default:
      fail('invalid_shape', 'json', 'value must be JSON');
  }
}

/** Return bounded compact sorted-key JSON for context/fingerprint inputs. */
function canonicalReceiptJson(value: unknown, maximumBytes = MAX_JSON_BYTES): string {
  const encoded = canonicalJsonInner(value, 0, { value: 0 }, new Set<object>());
  if (utf8Bytes(encoded) > maximumBytes) fail('invalid_shape', 'json', 'canonical JSON exceeds the limit');
  return encoded;
}

async function digestUtf8(value: string, path: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail('invalid_context', path, 'Web Crypto SHA-256 is unavailable');
  try {
    const bytes = await subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    fail('invalid_context', path, 'Web Crypto SHA-256 failed');
  }
}

async function digestJson(value: unknown, maximumBytes = MAX_JSON_BYTES): Promise<string> {
  return digestUtf8(canonicalReceiptJson(value, maximumBytes), 'json');
}

function cloneJson<T>(value: T, maximumBytes: number): T {
  const canonical = canonicalReceiptJson(value, maximumBytes);
  // The validators only accept JSON-shaped values, so this clone is exact and
  // avoids structuredClone implementation differences between browser/node.
  return JSON.parse(canonical) as T;
}

function exactObject(value: unknown, fields: readonly string[], path: string, code: ReceiptReviewErrorCode): JsonRecord {
  if (!isRecord(value)) fail(code, path);
  const actual = Object.keys(value);
  if (actual.length !== fields.length || actual.some((key) => !fields.includes(key))) fail(code, path);
  return value;
}

function text(value: unknown, path: string, maximumBytes: number, code: ReceiptReviewErrorCode): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail(code, path);
  if (utf8Bytes(value) > maximumBytes) fail(code, path);
  return value;
}

function sha(value: unknown, path: string, code: ReceiptReviewErrorCode = 'invalid_hash'): string {
  const result = text(value, path, 64, code);
  if (!SHA_PATTERN.test(result)) fail(code, path);
  return result;
}

function identifier(value: unknown, path: string, code: ReceiptReviewErrorCode): string {
  const result = text(value, path, 128, code);
  if (!IDENTIFIER_PATTERN.test(result)) fail(code, path);
  return result;
}

function numberValue(value: unknown, path: string, code: ReceiptReviewErrorCode): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code, path);
  return value;
}

function safeRevision(value: unknown, path: string, positive: boolean, code: ReceiptReviewErrorCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    fail('invalid_revision', path, `${path} must be a safe ${positive ? 'positive' : 'non-negative'} integer`);
  }
  return value;
}

function booleanValue(value: unknown, path: string, code: ReceiptReviewErrorCode): boolean {
  if (typeof value !== 'boolean') fail(code, path);
  return value;
}

function normalizePath(value: unknown, path: string, code: ReceiptReviewErrorCode): string {
  const raw = text(value, path, MAX_PATH_BYTES, code);
  const normalized = raw.trim().normalize('NFC').replaceAll('\\', '/').toLowerCase();
  if (!normalized || !(normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized))) fail(code, path);
  return normalized;
}

function absolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value.replaceAll('\\', '/'));
}

function parseMatchMode(value: unknown, path: string): ReceiptReviewMatchMode {
  if (value !== 'exact' && value !== 'fuzzy') fail('invalid_context', path);
  return value;
}

function parseCropMode(value: unknown, path: string, code: ReceiptReviewErrorCode): ReceiptReviewCropMode {
  if (!CROP_MODES.includes(value as ReceiptReviewCropMode)) fail(code, path);
  return value as ReceiptReviewCropMode;
}

function parseReviewStatus(value: unknown, path: string, code: ReceiptReviewErrorCode): ReceiptReviewStatus {
  if (!REVIEW_STATUSES.includes(value as ReceiptReviewStatus)) fail(code, path);
  return value as ReceiptReviewStatus;
}

function parseReviewedAt(value: unknown, path: string, code: ReceiptReviewErrorCode): string {
  const result = text(value, path, 64, code);
  if (!UTC_ISO_PATTERN.test(result)) fail(code, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(result);
  if (!match) fail(code, path);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) fail(code, path);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > days) fail(code, path);
  return result;
}

function parseRect(
  value: unknown,
  path: string,
  code: ReceiptReviewErrorCode,
  geometry?: PageGeometry,
  minimum = false,
  nullable = false,
): PdfRect | null {
  if (value === null) {
    if (nullable) return null;
    fail(code, path);
  }
  const object = exactObject(value, RECT_FIELDS, path, code);
  const rect = {
    x0: numberValue(object.x0, `${path}.x0`, code),
    y0: numberValue(object.y0, `${path}.y0`, code),
    x1: numberValue(object.x1, `${path}.x1`, code),
    y1: numberValue(object.y1, `${path}.y1`, code),
  };
  if (rect.x0 >= rect.x1 || rect.y0 >= rect.y1 || (!(rect.x0 >= 0 || near(rect.x0, 0)))
    || (!(rect.y0 >= 0 || near(rect.y0, 0)))) fail(code, path);
  if (!geometry) return rect;
  for (const [axis, size] of [['x', geometry.width_pt], ['y', geometry.height_pt]] as const) {
    const start = rect[`${axis}0` as 'x0' | 'y0'];
    const end = rect[`${axis}1` as 'x1' | 'y1'];
    if (!(end <= size || near(end, size)) || !(start >= 0 || near(start, 0))) fail(code, path);
    if (minimum) {
      if (size < MIN_CROP_SIZE) {
        if (!near(start, 0) || !near(end, size)) fail(code, path);
      } else if (end - start < MIN_CROP_SIZE && !near(end - start, MIN_CROP_SIZE)) {
        fail(code, path);
      }
    }
  }
  return rect;
}

function contains(outer: PdfRect, inner: PdfRect): boolean {
  return (outer.x0 <= inner.x0 || near(outer.x0, inner.x0))
    && (outer.y0 <= inner.y0 || near(outer.y0, inner.y0))
    && (inner.x1 <= outer.x1 || near(inner.x1, outer.x1))
    && (inner.y1 <= outer.y1 || near(inner.y1, outer.y1));
}

function intersects(left: PdfRect, right: PdfRect): boolean {
  return Math.min(left.x1, right.x1) > Math.max(left.x0, right.x0)
    && Math.min(left.y1, right.y1) > Math.max(left.y0, right.y0);
}

function sameRect(left: PdfRect, right: PdfRect): boolean {
  return near(left.x0, right.x0) && near(left.y0, right.y0)
    && near(left.x1, right.x1) && near(left.y1, right.y1);
}

function exactRect(left: PdfRect, right: PdfRect): boolean {
  return left.x0 === right.x0 && left.y0 === right.y0 && left.x1 === right.x1 && left.y1 === right.y1;
}

function layoutForInstance(layoutId: string, revision: number, slotId: string): LayoutDefinition {
  // makeInstanceId only consumes these three fields.  Keeping the helper
  // centralized guarantees the exact receipt-v1 identity formula is reused.
  return { layout_id: layoutId, revision, slots: [{ slot_id: slotId }] } as unknown as LayoutDefinition;
}

export function makeReceiptInstanceId(
  sourceSha256: string,
  sourcePage: number,
  layoutId: string,
  layoutRevision: number,
  slotId: string,
): string {
  try {
    return makeInstanceId(sourceSha256, sourcePage, layoutForInstance(layoutId, layoutRevision, slotId), slotId);
  } catch (error) {
    if (error instanceof ReceiptReviewError) throw error;
    fail('invalid_instance', 'instance_id');
  }
}

export async function computeReceiptProcessingFingerprint(
  processingOptions: unknown,
  matchMode: unknown,
): Promise<string> {
  let options: ProcessingOptions;
  try {
    options = parseProcessingOptions(processingOptions);
  } catch {
    fail('invalid_context', 'processing_options');
  }
  const mode = parseMatchMode(matchMode, 'match_mode');
  return digestJson({
    page_result_schema: 2,
    layout_schema_version: 1,
    processing_options: options,
    match_mode: mode,
  });
}

function sourceMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) fail('invalid_source', 'sourceShaByKey');
  if (Object.keys(value).length > MAX_RECEIPT_REVIEW_SOURCES) fail('invalid_source', 'sourceShaByKey');
  const result: Record<string, string> = {};
  for (const [index, [rawKey, rawSha]] of Object.entries(value).entries()) {
    const key = normalizePath(rawKey, `source_sha_by_key[${index}].source_key`, 'invalid_source');
    if (Object.prototype.hasOwnProperty.call(result, key)) fail('invalid_source', 'source_sha_by_key', 'duplicate normalized source key');
    result[key] = sha(rawSha, `source_sha_by_key[${index}].source_sha256`, 'invalid_source');
  }
  return result;
}

function parseContextOptions(
  options: ReceiptReviewContextValidationOptions | boolean | undefined,
): ReceiptReviewContextValidationOptions {
  if (typeof options === 'boolean') return { trustedAliases: options };
  if (options === undefined) return {};
  if (!isRecord(options) || (options.trustedAliases !== undefined && typeof options.trustedAliases !== 'boolean')) {
    fail('invalid_context', 'options');
  }
  return { trustedAliases: options.trustedAliases ?? false };
}

/** Validate and normalize a schema-3 context, including the Python fingerprint and context_key. */
export async function validateReceiptContext(
  value: unknown,
  options?: ReceiptReviewContextValidationOptions | boolean,
): Promise<ReceiptReviewContextValidation> {
  let context: JsonRecord;
  try {
    context = cloneJson(value, MAX_JSON_BYTES) as JsonRecord;
  } catch (error) {
    if (error instanceof ReceiptReviewError) fail('invalid_context', 'context');
    throw error;
  }
  exactObject(context, CONTEXT_FIELDS, 'context', 'invalid_context');
  if (context.version !== RECEIPT_REVIEW_CONTEXT_VERSION || typeof context.version === 'boolean') {
    fail('invalid_context', 'context.version');
  }
  const parsedOptions = parseContextOptions(options);
  const sourcesValue = context.sources;
  if (!Array.isArray(sourcesValue) || sourcesValue.length === 0 || sourcesValue.length > MAX_RECEIPT_REVIEW_SOURCES) {
    fail('invalid_source', 'context.sources');
  }
  const sources: ReceiptReviewContextSource[] = [];
  const sourceShaByKey: Record<string, string> = {};
  sourcesValue.forEach((rawSource, index) => {
    // Match Python's per-source bounded clone before normalizing any field.
    canonicalReceiptJson(rawSource, MAX_RECEIPT_REVIEW_ITEM_BYTES);
    const source = exactObject(rawSource, SOURCE_FIELDS, `context.sources[${index}]`, 'invalid_source');
    const key = normalizePath(source.source_key, `context.sources[${index}].source_key`, 'invalid_source');
    const path = normalizePath(source.source_path, `context.sources[${index}].source_path`, 'invalid_source');
    const sourceSha256 = sha(source.source_sha256, `context.sources[${index}].source_sha256`, 'invalid_source');
    if (!parsedOptions.trustedAliases && path !== key) fail('invalid_source', `context.sources[${index}].source_path`);
    if (Object.prototype.hasOwnProperty.call(sourceShaByKey, key)) fail('invalid_source', `context.sources[${index}].source_key`);
    sourceShaByKey[key] = sourceSha256;
    sources.push({ source_key: key, source_path: source.source_path as string, source_sha256: sourceSha256 });
  });
  const processingOptions = (() => {
    try {
      return parseProcessingOptions(context.processing_options);
    } catch {
      fail('invalid_context', 'context.processing_options');
    }
  })();
  const matchMode = parseMatchMode(context.match_mode, 'context.match_mode');
  const expectedFingerprint = await computeReceiptProcessingFingerprint(processingOptions, matchMode);
  const criteriaFingerprint = sha(context.criteria_fingerprint, 'context.criteria_fingerprint');
  if (criteriaFingerprint !== expectedFingerprint) fail('invalid_context', 'context.criteria_fingerprint');
  const computationVersion = text(context.computation_version, 'context.computation_version', MAX_VERSION_BYTES, 'invalid_context');
  const descriptor: ReceiptReviewContext = {
    version: RECEIPT_REVIEW_CONTEXT_VERSION,
    sources,
    processing_options: cloneJson(processingOptions, MAX_RECEIPT_REVIEW_ITEM_BYTES),
    match_mode: matchMode,
    criteria_fingerprint: criteriaFingerprint,
    computation_version: computationVersion,
  };
  const identity = {
    version: RECEIPT_REVIEW_CONTEXT_VERSION,
    sources: sources.map(({ source_key, source_sha256 }) => ({ source_key, source_sha256 })),
    processing_options: descriptor.processing_options,
    match_mode: descriptor.match_mode,
    criteria_fingerprint: descriptor.criteria_fingerprint,
    computation_version: descriptor.computation_version,
  };
  return { context: descriptor, sourceShaByKey, contextKey: await digestJson(identity) };
}

function originalMode(
  binding: ReceiptReviewContext | ProcessingOptions | ReceiptReviewOriginalValidationOptions | undefined,
): ProcessingMode | undefined {
  if (binding === undefined) return undefined;
  if (isRecord(binding) && 'processingMode' in binding) {
    const mode = binding.processingMode;
    if (mode !== 'search' && mode !== 'split_all') fail('invalid_original', 'processingMode');
    return mode;
  }
  if (isRecord(binding) && 'context' in binding) {
    const nested = binding.context;
    if (!isRecord(nested)) fail('invalid_original', 'context');
    return originalMode(nested as ReceiptReviewContext);
  }
  if (isRecord(binding) && 'processing_mode' in binding) {
    try {
      return parseProcessingOptions(binding).processing_mode;
    } catch {
      fail('invalid_original', 'processing_options');
    }
  }
  if (isRecord(binding) && 'processing_options' in binding) {
    try {
      return parseProcessingOptions(binding.processing_options).processing_mode;
    } catch {
      fail('invalid_original', 'context.processing_options');
    }
  }
  fail('invalid_original', 'context');
}

function validateOriginal(
  raw: unknown,
  sourceShaByKey: Record<string, string>,
  index: number,
  mode?: ProcessingMode,
): ReceiptReviewOriginal {
  const path = `originals[${index}]`;
  const original = cloneJson(raw, MAX_RECEIPT_REVIEW_ITEM_BYTES) as JsonRecord;
  exactObject(original, ORIGINAL_FIELDS, path, 'invalid_original');
  const itemId = sha(original.id, `${path}.id`);
  const sourceKey = normalizePath(original.source_key, `${path}.source_key`, 'invalid_original');
  if (original.source_key !== sourceKey) fail('invalid_original', `${path}.source_key`);
  const sourceSha256 = sourceShaByKey[sourceKey];
  if (sourceSha256 === undefined) fail('invalid_original', `${path}.source_key`);
  const sourcePage = safeRevision(original.source_page, `${path}.source_page`, true, 'invalid_revision');
  const positionIndex = safeRevision(original.position_index, `${path}.position_index`, true, 'invalid_revision');
  if (positionIndex > MAX_LAYOUT_SLOTS) fail('invalid_original', `${path}.position_index`);
  const layoutRevision = safeRevision(original.layout_revision, `${path}.layout_revision`, true, 'invalid_revision');
  const slotId = identifier(original.slot_id, `${path}.slot_id`, 'invalid_original');
  const layoutId = identifier(original.layout_id, `${path}.layout_id`, 'invalid_original');
  const layoutSignature = sha(original.layout_signature, `${path}.layout_signature`);
  const analysisSignature = sha(original.analysis_signature, `${path}.analysis_signature`);
  let geometry: PageGeometry;
  try {
    geometry = parsePageGeometry(original.page_geometry, `${path}.page_geometry`);
  } catch {
    fail('invalid_geometry', `${path}.page_geometry`);
  }
  const candidateRect = parseRect(original.candidate_rect, `${path}.candidate_rect`, 'invalid_original', geometry, true);
  if (!candidateRect) fail('invalid_original', `${path}.candidate_rect`);
  const expectedInstanceId = makeReceiptInstanceId(sourceSha256, sourcePage, layoutId, layoutRevision, slotId);
  if (original.instance_id !== expectedInstanceId) fail('invalid_instance', `${path}.instance_id`);
  if (original.occupancy !== 'occupied' && original.occupancy !== 'uncertain') fail('invalid_original', `${path}.occupancy`);
  if (original.selection_basis !== 'keyword' && original.selection_basis !== 'occupied_slot'
    && original.selection_basis !== 'manual_slot') fail('invalid_original', `${path}.selection_basis`);
  if (mode === 'search' && original.selection_basis !== 'keyword') fail('invalid_original', `${path}.selection_basis`);
  if (mode === 'split_all' && original.selection_basis === 'keyword') fail('invalid_original', `${path}.selection_basis`);
  const needsReview = booleanValue(original.needs_review, `${path}.needs_review`, 'invalid_original');
  if (original.occupancy === 'uncertain' && original.selection_basis !== 'manual_slot' && !needsReview) {
    fail('invalid_original', `${path}.needs_review`);
  }
  return {
    id: itemId,
    source_key: sourceKey,
    source_page: sourcePage,
    instance_id: expectedInstanceId,
    slot_id: slotId,
    position_index: positionIndex,
    layout_id: layoutId,
    layout_revision: layoutRevision,
    layout_signature: layoutSignature,
    page_geometry: original.page_geometry as PageGeometry,
    candidate_rect: original.candidate_rect as PdfRect,
    occupancy: original.occupancy as 'occupied' | 'uncertain',
    selection_basis: original.selection_basis as SelectionBasis,
    needs_review: needsReview,
    analysis_signature: analysisSignature,
  };
}

/** Validate immutable originals without rebuilding the backend-owned manifest. */
export function validateReceiptOriginals(
  value: unknown,
  sourceShaByKeyValue: unknown,
  binding?: ReceiptReviewContext | ProcessingOptions | ReceiptReviewOriginalValidationOptions,
): ReceiptReviewOriginal[] {
  if (!Array.isArray(value) || value.length > MAX_RECEIPT_REVIEW_ORIGINALS) {
    fail('invalid_original', 'originals');
  }
  const originalsValue = value as unknown[];
  const sourceShaByKey = sourceMap(sourceShaByKeyValue);
  const mode = originalMode(binding);
  if (binding && isRecord(binding) && 'context' in binding && binding.context) {
    const context = binding.context as ReceiptReviewContext;
    const expectedSources = context.sources;
    for (const source of expectedSources) {
      if (sourceShaByKey[source.source_key] !== source.source_sha256) fail('invalid_original', 'sourceShaByKey');
    }
  } else if (binding && isRecord(binding) && 'sources' in binding && Array.isArray(binding.sources)) {
    const context = binding as ReceiptReviewContext;
    for (const source of context.sources) {
      if (sourceShaByKey[source.source_key] !== source.source_sha256) fail('invalid_original', 'sourceShaByKey');
    }
  }
  const originals: ReceiptReviewOriginal[] = [];
  const ids = new Set<string>();
  const logicalKeys = new Set<string>();
  let totalBytes = 2;
  for (let index = 0; index < originalsValue.length; index += 1) {
    if (!(index in originalsValue)) fail('invalid_original', `originals[${index}]`, 'sparse arrays are not supported');
    const raw = originalsValue[index];
    const original = validateOriginal(raw, sourceShaByKey, index, mode);
    const logicalKey = `${original.source_key}\u0000${original.instance_id}`;
    if (ids.has(original.id)) fail('invalid_original', 'originals', 'original IDs must be unique');
    if (logicalKeys.has(logicalKey)) fail('invalid_original', 'originals', 'original source instances must be unique');
    ids.add(original.id);
    logicalKeys.add(logicalKey);
    const encoded = canonicalReceiptJson(original, MAX_RECEIPT_REVIEW_ITEM_BYTES);
    totalBytes += utf8Bytes(encoded) + (index > 0 ? 1 : 0);
    if (totalBytes > MAX_RECEIPT_REVIEW_ORIGINALS_BYTES) fail('invalid_original', 'originals');
    originals.push(original);
  }
  return originals;
}

function validatedEdit(value: unknown): ReceiptReviewEdit {
  const edit = cloneJson(value, MAX_RECEIPT_REVIEW_EDIT_BYTES) as JsonRecord;
  exactObject(edit, [...EDIT_FIELDS, ...(isRecord(edit) && 'document_type' in edit ? ['document_type'] : [])], 'edit', 'invalid_edit');
  if ('document_type' in edit && !isReceiptDocumentType(edit.document_type)) fail('invalid_edit', 'edit.document_type');
  if (edit.schema_version !== RECEIPT_REVIEW_EDIT_SCHEMA_VERSION || typeof edit.schema_version === 'boolean') {
    fail('invalid_edit', 'edit.schema_version');
  }
  const contextKey = sha(edit.context_key, 'edit.context_key');
  const resultRevision = text(edit.result_revision, 'edit.result_revision', 128, 'invalid_edit');
  const id = text(edit.id, 'edit.id', MAX_IDENTIFIER_BYTES, 'invalid_edit');
  const sourceKey = normalizePath(edit.source_key, 'edit.source_key', 'invalid_edit');
  const instanceId = text(edit.instance_id, 'edit.instance_id', MAX_IDENTIFIER_BYTES, 'invalid_edit');
  const analysisSignature = sha(edit.analysis_signature, 'edit.analysis_signature');
  const recordRevision = safeRevision(edit.record_revision, 'edit.record_revision', false, 'invalid_revision');
  const cropMode = parseCropMode(edit.crop_mode, 'edit.crop_mode', 'invalid_edit');
  const finalRect = parseRect(edit.final_rect, 'edit.final_rect', 'invalid_edit', undefined, false, cropMode === 'full_page');
  if (cropMode === 'full_page' && finalRect !== null) {
    fail('invalid_edit', 'edit.final_rect', 'full_page edit must have a null final_rect');
  }
  if (cropMode !== 'full_page' && finalRect === null) fail('invalid_edit', 'edit.final_rect');
  const reviewStatus = parseReviewStatus(edit.review_status, 'edit.review_status', 'invalid_edit');
  const manualAdjusted = booleanValue(edit.manual_adjusted, 'edit.manual_adjusted', 'invalid_edit');
  if ((cropMode === 'candidate' || cropMode === 'full_page') && manualAdjusted) {
    fail('invalid_edit', 'edit.manual_adjusted', `${cropMode} edit must not be marked manually adjusted`);
  }
  if (cropMode === 'manual' && !manualAdjusted) {
    fail('invalid_edit', 'edit.manual_adjusted', 'manual edit must be marked manually adjusted');
  }
  const reviewedAt = parseReviewedAt(edit.reviewed_at, 'edit.reviewed_at', 'invalid_edit');
  return {
    schema_version: RECEIPT_REVIEW_EDIT_SCHEMA_VERSION,
    context_key: contextKey,
    result_revision: resultRevision,
    id,
    source_key: sourceKey,
    instance_id: instanceId,
    analysis_signature: analysisSignature,
    record_revision: recordRevision,
    final_rect: finalRect,
    crop_mode: cropMode,
    review_status: reviewStatus,
    manual_adjusted: manualAdjusted,
    reviewed_at: reviewedAt,
    ...('document_type' in edit ? { document_type: edit.document_type as ReceiptDocumentType } : {}),
  };
}

export function validateReceiptEdit(value: unknown): ReceiptReviewEdit {
  return validatedEdit(value);
}

function bindImmutableFields(original: ReceiptReviewOriginal, edit: ReceiptReviewEdit): void {
  for (const field of ['id', 'source_key', 'instance_id', 'analysis_signature'] as const) {
    if (edit[field] !== original[field]) fail('invalid_edit', `edit.${field}`);
  }
}

/** Bind one edit to an immutable original and produce the durable record shape. */
export function buildReceiptRecord(
  originalValue: unknown,
  editValue: unknown,
  sourcePathValue: unknown,
  sourceSha256Value: unknown,
  newRevisionValue: unknown,
): ReceiptReviewRecord {
  const sourceSha256 = sha(sourceSha256Value, 'source_sha256');
  const sourcePath = text(sourcePathValue, 'source_path', MAX_PATH_BYTES, 'invalid_record');
  // The Python binder validates the normalized path while retaining the
  // caller's spelling in the durable access-path field.
  normalizePath(sourcePath, 'source_path', 'invalid_record');
  const newRevision = safeRevision(newRevisionValue, 'new_revision', true, 'invalid_revision');
  const rawOriginal = cloneJson(originalValue, MAX_RECEIPT_REVIEW_ITEM_BYTES) as JsonRecord;
  if (!isRecord(rawOriginal) || !('source_key' in rawOriginal)) fail('invalid_original', 'original');
  const canonicalKey = normalizePath(rawOriginal.source_key, 'original.source_key', 'invalid_original');
  const original = validateOriginal(rawOriginal, { [canonicalKey]: sourceSha256 }, 0);
  const edit = validatedEdit(editValue);
  bindImmutableFields(original, edit);
  const geometry = parsePageGeometry(original.page_geometry, 'original.page_geometry');
  const candidate = parseRect(original.candidate_rect, 'original.candidate_rect', 'invalid_record', geometry, true);
  if (!candidate) fail('invalid_record', 'original.candidate_rect');
  let finalRect: PdfRect | null = null;
  if (edit.crop_mode === 'candidate') {
    const final = parseRect(edit.final_rect, 'edit.final_rect', 'invalid_record', geometry, true);
    if (!final || !sameRect(final, candidate) || edit.manual_adjusted) {
      fail('invalid_record', 'edit.final_rect', 'candidate record must retain the candidate rectangle');
    }
    finalRect = final;
  } else if (edit.crop_mode === 'manual') {
    const final = parseRect(edit.final_rect, 'edit.final_rect', 'invalid_record', geometry, true);
    if (!final || !contains(candidate, final)) {
      fail('invalid_record', 'edit.final_rect', 'manual final rectangle must be inside the original candidate');
    }
    finalRect = final;
  } else if (edit.final_rect !== null || edit.manual_adjusted) {
    fail('invalid_record', 'edit.final_rect');
  }
  return {
    schema_version: RECEIPT_REVIEW_EDIT_SCHEMA_VERSION,
    context_key: edit.context_key,
    result_revision: edit.result_revision,
    record_revision: newRevision,
    source_path: sourcePath,
    source_sha256: sourceSha256,
    original,
    final_rect: finalRect,
    crop_mode: edit.crop_mode,
    review_status: edit.review_status,
    manual_adjusted: edit.manual_adjusted,
    reviewed_at: edit.reviewed_at,
    ...(edit.document_type !== undefined ? { document_type: edit.document_type } : {}),
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return left === right;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if ((left as unknown[]).length !== (right as unknown[]).length) return false;
    return (left as unknown[]).every((value, index) => sameJson(value, (right as unknown[])[index]));
  }
  const leftRecord = left as JsonRecord;
  const rightRecord = right as JsonRecord;
  const leftKeys = Object.keys(leftRecord).sort(compareUnicodeCodePoints);
  const rightKeys = Object.keys(rightRecord).sort(compareUnicodeCodePoints);
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]
    && sameJson(leftRecord[key], rightRecord[key]));
}

export function validateReceiptRecord(value: unknown): ReceiptReviewRecord {
  const record = cloneJson(value, MAX_RECEIPT_REVIEW_RECORD_BYTES) as JsonRecord;
  exactObject(record, [...RECORD_FIELDS, ...(isRecord(record) && 'document_type' in record ? ['document_type'] : [])], 'record', 'invalid_record');
  const sourceSha256 = sha(record.source_sha256, 'record.source_sha256');
  text(record.source_path, 'record.source_path', MAX_PATH_BYTES, 'invalid_record');
  const original = record.original;
  if (!isRecord(original) || !('source_key' in original)) fail('invalid_record', 'record.original');
  const canonicalKey = normalizePath(original.source_key, 'record.original.source_key', 'invalid_original');
  const edit = {
    schema_version: record.schema_version,
    context_key: record.context_key,
    result_revision: record.result_revision,
    id: original.id,
    source_key: canonicalKey,
    instance_id: original.instance_id,
    analysis_signature: original.analysis_signature,
    record_revision: record.record_revision,
    final_rect: record.final_rect,
    crop_mode: record.crop_mode,
    review_status: record.review_status,
    manual_adjusted: record.manual_adjusted,
    reviewed_at: record.reviewed_at,
    ...('document_type' in record ? { document_type: record.document_type } : {}),
  };
  const expected = buildReceiptRecord(original, edit, record.source_path, sourceSha256, record.record_revision);
  if (!sameJson(expected, record)) fail('invalid_record', 'record');
  return expected;
}

function segmentOriginal(segment: JsonRecord): JsonRecord {
  const original: JsonRecord = {};
  for (const field of ORIGINAL_FIELDS) original[field] = segment[field];
  return original;
}

/** Validate one initial schema-2 item carrying schema-3 originals/context bindings. */
export function parseReceiptSnapshotItem(value: unknown): ReceiptSnapshotItem {
  const item = cloneJson(value, MAX_RECEIPT_REVIEW_ITEM_BYTES) as JsonRecord;
  exactObject(item, ['segment', 'evidence', 'original'], 'snapshot', 'invalid_snapshot');
  const original = cloneJson(item.original, MAX_RECEIPT_REVIEW_ITEM_BYTES) as JsonRecord;
  const segment = cloneJson(item.segment, MAX_RECEIPT_REVIEW_ITEM_BYTES) as JsonRecord;
  exactObject(original, ORIGINAL_FIELDS, 'snapshot.original', 'invalid_snapshot');
  exactObject(segment, SEGMENT_FIELDS, 'snapshot.segment', 'invalid_snapshot');
  if (!sameJson(segmentOriginal(segment), original)) fail('invalid_snapshot', 'snapshot.segment', 'segment original binding differs');
  sha(original.id, 'snapshot.original.id');
  sha(original.layout_signature, 'snapshot.original.layout_signature');
  sha(original.analysis_signature, 'snapshot.original.analysis_signature');
  const sourceKey = normalizePath(original.source_key, 'snapshot.original.source_key', 'invalid_snapshot');
  if (original.source_key !== sourceKey) fail('invalid_snapshot', 'snapshot.original.source_key');
  const sourcePath = text(segment.source_path, 'snapshot.segment.source_path', MAX_PATH_BYTES, 'invalid_snapshot');
  if (!absolutePath(sourcePath)) fail('invalid_snapshot', 'snapshot.segment.source_path');
  const sourceSha256 = sha(segment.source_sha256, 'snapshot.segment.source_sha256');
  const sourcePage = safeRevision(original.source_page, 'snapshot.original.source_page', true, 'invalid_revision');
  const positionIndex = safeRevision(original.position_index, 'snapshot.original.position_index', true, 'invalid_revision');
  if (positionIndex > MAX_LAYOUT_SLOTS) fail('invalid_snapshot', 'snapshot.original.position_index');
  const layoutRevision = safeRevision(original.layout_revision, 'snapshot.original.layout_revision', true, 'invalid_revision');
  const slotId = identifier(original.slot_id, 'snapshot.original.slot_id', 'invalid_snapshot');
  const layoutId = identifier(original.layout_id, 'snapshot.original.layout_id', 'invalid_snapshot');
  let geometry: PageGeometry;
  try {
    geometry = parsePageGeometry(original.page_geometry, 'snapshot.original.page_geometry');
  } catch {
    fail('invalid_geometry', 'snapshot.original.page_geometry');
  }
  const candidate = parseRect(original.candidate_rect, 'snapshot.original.candidate_rect', 'invalid_snapshot', geometry, true);
  const final = parseRect(segment.final_rect, 'snapshot.segment.final_rect', 'invalid_snapshot', geometry, true);
  if (!candidate || !final || !exactRect(candidate, final)) fail('invalid_snapshot', 'snapshot.segment.final_rect');
  const expectedInstanceId = makeReceiptInstanceId(sourceSha256, sourcePage, layoutId, layoutRevision, slotId);
  if (original.instance_id !== expectedInstanceId) fail('invalid_instance', 'snapshot.original.instance_id');
  if (original.occupancy !== 'occupied' && original.occupancy !== 'uncertain') fail('invalid_snapshot', 'snapshot.original.occupancy');
  if (original.selection_basis !== 'keyword' && original.selection_basis !== 'occupied_slot'
    && original.selection_basis !== 'manual_slot') fail('invalid_snapshot', 'snapshot.original.selection_basis');
  const needsReview = booleanValue(original.needs_review, 'snapshot.original.needs_review', 'invalid_snapshot');
  if (original.occupancy === 'uncertain' && original.selection_basis !== 'manual_slot' && !needsReview) {
    fail('invalid_snapshot', 'snapshot.original.needs_review');
  }
  if (segment.crop_mode !== 'candidate' || segment.manual_adjusted !== false) fail('invalid_snapshot', 'snapshot.segment.crop_mode');
  if (segment.review_status !== (needsReview ? 'needs_review' : 'confirmed')) fail('invalid_snapshot', 'snapshot.segment.review_status');
  const evidenceValue = item.evidence;
  if (!Array.isArray(evidenceValue) || evidenceValue.length > 10_000) fail('invalid_snapshot', 'snapshot.evidence');
  if ((evidenceValue.length > 0) !== (original.selection_basis === 'keyword')) fail('invalid_snapshot', 'snapshot.evidence');
  const evidence: ReceiptSnapshotEvidence[] = evidenceValue.map((raw, index) => {
    const hit = exactObject(raw, ['query_id', 'rect'], `snapshot.evidence[${index}]`, 'invalid_snapshot');
    const queryId = text(hit.query_id, `snapshot.evidence[${index}].query_id`, 128, 'invalid_snapshot');
    if (!INCLUDE_QUERY_PATTERN.test(queryId)) fail('invalid_snapshot', `snapshot.evidence[${index}].query_id`);
    const hitRect = parseRect(hit.rect, `snapshot.evidence[${index}].rect`, 'invalid_snapshot', geometry);
    if (!hitRect || !intersects(candidate, hitRect) || (!contains(candidate, hitRect) && !needsReview)) {
      fail('invalid_snapshot', `snapshot.evidence[${index}].rect`);
    }
    return { query_id: queryId, rect: hit.rect as PdfRect };
  });
  return {
    original: original as unknown as ReceiptReviewOriginal,
    segment: segment as unknown as ReceiptSnapshotSegment,
    evidence,
  };
}
