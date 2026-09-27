import {
  cropPageKey,
  getReceiptIdentity,
  type CropTemplatePage,
  type VerifiedReceiptIdentity,
} from './batchCrop';
import type { ReviewSegment } from './cropReview';

// Keep the safe identity helper discoverable from the guided-review module
// while preserving one implementation in batchCrop's strict validator.
export { getReceiptIdentity } from './batchCrop';

/**
 * One guided adjustment round.  A round contains one verified bank, receipt
 * form, and page position.  The bank key is kept separately so the UI can
 * complete a bank only after every one of its rounds is confirmed.
 */
export type GuidedReviewGroup = {
  key: string;
  label: string;
  segmentIds: string[];
  sourceKeys: string[];
  bankKey: string | null;
  templateFingerprint: string | null;
  positionKey: string | null;
  sourceLabel?: string;
};

/** A bank-level view over all its verified position/form rounds. */
export type GuidedReviewBankGroup = {
  key: string;
  label: string;
  segmentIds: string[];
  sourceKeys: string[];
  bankKey: string | null;
  positionGroupKeys: string[];
};

const POSITION_BUCKET = 0.05;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function sourceKeyOf(segment: ReviewSegment): string | null {
  if (!isRecord(segment)) return null;
  if (nonEmptyText(segment.sourceKey)) return segment.sourceKey.trim();
  return nonEmptyText(segment.sourcePath) ? segment.sourcePath.trim() : null;
}

function pageFor(
  pages: ReadonlyMap<string, CropTemplatePage>,
  segment: ReviewSegment,
): unknown {
  if (!pages || typeof pages.get !== 'function') return undefined;
  try {
    return pages.get(cropPageKey(segment));
  } catch {
    return undefined;
  }
}

function safePart(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Buckets a verified receipt's page-relative title anchor.  A five-percent
 * bucket tolerates small page geometry differences while keeping distinct
 * top/middle/bottom copies separate.  It is deliberately independent of the
 * search result's segment number, which changes when matches are merged.
 */
function positionKey(identity: VerifiedReceiptIdentity): string | null {
  if (!Number.isFinite(identity.anchorY)
    || !Number.isFinite(identity.pageHeight)
    || identity.pageHeight <= 0) return null;
  const ratio = identity.anchorY / identity.pageHeight;
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return null;
  const bucket = Math.max(0, Math.min(Math.round(1 / POSITION_BUCKET), Math.round(ratio / POSITION_BUCKET)));
  return `p${String(bucket).padStart(2, '0')}`;
}

function positionLabel(value: string): string {
  const bucket = Number(value.slice(1));
  if (!Number.isFinite(bucket)) return '位置待核实';
  return `第 ${Math.round(bucket * POSITION_BUCKET * 100)}% 位置`;
}

function bankLabel(identity: VerifiedReceiptIdentity): string {
  return identity.issuerBankName?.trim()
    || `已核实银行 ${identity.issuerBankKey.slice(0, 8)}`;
}

function unknownLabel(segment: ReviewSegment, sourceKey: string | null): string {
  const source = sourceKey ?? '当前来源';
  return `待核实来源 · ${source} · 第 ${segment.sourcePage} 页片段 ${segment.segmentNo}`;
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function newUnknownGroup(segment: ReviewSegment, sourceKey: string | null): GuidedReviewGroup {
  const id = nonEmptyText(segment.id) ? segment.id.trim() : `row-${segment.sourcePage}-${segment.segmentNo}`;
  const source = sourceKey ?? `source-${id}`;
  return {
    key: `unknown:${safePart(source)}:${safePart(id)}`,
    label: unknownLabel(segment, sourceKey),
    segmentIds: [id],
    sourceKeys: [source],
    bankKey: null,
    templateFingerprint: null,
    positionKey: null,
    sourceLabel: segment.sourceName || segment.sourcePath.split(/[\\/]/).pop() || '未识别的 PDF',
  };
}

/**
 * Builds stable guided adjustment rounds in first-seen segment order.
 *
 * Verified candidates from different PDFs join when their issuing-bank key,
 * receipt-local template fingerprint, and page-relative position agree.
 * Missing or unavailable descriptors intentionally produce one round per
 * segment.  Source names are used only as an unknown-round label and key;
 * they never establish a bank identity.  The bank-level projection below may
 * merge those unknown rounds by source for a concise workflow step.
 */
export function buildGuidedReviewGroups(
  segments: readonly ReviewSegment[],
  pages: ReadonlyMap<string, CropTemplatePage>,
): GuidedReviewGroup[] {
  if (!Array.isArray(segments) || !pages || typeof pages.get !== 'function') return [];

  const groups: GuidedReviewGroup[] = [];
  const byKey = new Map<string, GuidedReviewGroup>();
  for (const candidate of segments) {
    if (!isRecord(candidate) || !nonEmptyText(candidate.id)) continue;
    const segment = candidate as ReviewSegment;
    const id = segment.id.trim();
    const source = sourceKeyOf(segment);
    const identity = getReceiptIdentity(segment, pageFor(pages, segment));
    const position = identity ? positionKey(identity) : null;
    if (identity === null || position === null) {
      groups.push(newUnknownGroup(segment, source));
      continue;
    }

    const key = [
      'bank',
      safePart(identity.issuerBankKey),
      'template',
      safePart(identity.templateFingerprint),
      'position',
      position,
    ].join(':');
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        label: `${bankLabel(identity)} · ${positionLabel(position)}`,
        segmentIds: [],
        sourceKeys: [],
        bankKey: identity.issuerBankKey,
        templateFingerprint: identity.templateFingerprint,
        positionKey: position,
      };
      byKey.set(key, group);
      groups.push(group);
    }
    addUnique(group.segmentIds, id);
    if (source !== null) addUnique(group.sourceKeys, source);
  }
  return groups;
}

/**
 * Collapses position/form rounds into one bank-level group for completion
 * gating.  Verified rounds merge by issuing-bank key. Unknown rounds merge
 * only when they came from the same source, keeping an unavailable PDF from
 * being guessed as another bank while avoiding one workflow step per hit.
 */
export function buildGuidedReviewBankGroups(
  groups: readonly GuidedReviewGroup[],
): GuidedReviewBankGroup[] {
  if (!Array.isArray(groups)) return [];
  const result: GuidedReviewBankGroup[] = [];
  const byBank = new Map<string, GuidedReviewBankGroup>();
  const unknownBySource = new Map<string, GuidedReviewBankGroup>();
  for (const group of groups) {
    if (!group || !nonEmptyText(group.key) || !Array.isArray(group.segmentIds)) continue;
    if (!nonEmptyText(group.bankKey)) {
      const source = group.sourceKeys.find(nonEmptyText)?.trim() ?? group.key;
      let unknown = unknownBySource.get(source);
      if (!unknown) {
        unknown = {
          key: `unknown-source:${safePart(source)}`,
          label: `待核实来源 · ${group.sourceLabel ?? '未识别的 PDF'}`,
          segmentIds: [],
          sourceKeys: [],
          bankKey: null,
          positionGroupKeys: [],
        };
        unknownBySource.set(source, unknown);
        result.push(unknown);
      }
      addUnique(unknown.positionGroupKeys, group.key);
      for (const id of group.segmentIds) if (nonEmptyText(id)) addUnique(unknown.segmentIds, id.trim());
      for (const itemSource of group.sourceKeys) if (nonEmptyText(itemSource)) addUnique(unknown.sourceKeys, itemSource.trim());
      continue;
    }
    const bankKey = group.bankKey.trim();
    let bank = byBank.get(bankKey);
    if (!bank) {
      bank = {
        key: `bank:${safePart(bankKey)}`,
        label: group.label.split(' · ')[0] ?? group.label,
        segmentIds: [],
        sourceKeys: [],
        bankKey,
        positionGroupKeys: [],
      };
      byBank.set(bankKey, bank);
      result.push(bank);
    }
    addUnique(bank.positionGroupKeys, group.key);
    for (const id of group.segmentIds) if (nonEmptyText(id)) addUnique(bank.segmentIds, id.trim());
    for (const source of group.sourceKeys) if (nonEmptyText(source)) addUnique(bank.sourceKeys, source.trim());
  }
  return result;
}

/**
 * Checks a single round against the session's explicit confirmation set.
 * Persisted revision numbers and automatic-confirmation provenance are not
 * consulted: the current segment must still be `confirmed` and its id must
 * be present in `confirmedIds`.
 */
export function isGuidedGroupComplete(
  group: GuidedReviewGroup | GuidedReviewBankGroup,
  segmentsById: ReadonlyMap<string, ReviewSegment>,
  confirmedIds: ReadonlySet<string>,
): boolean {
  if (!group || !Array.isArray(group.segmentIds) || group.segmentIds.length === 0
    || !segmentsById || typeof segmentsById.get !== 'function'
    || !confirmedIds || typeof confirmedIds.has !== 'function') return false;
  const ids = new Set<string>();
  for (const rawId of group.segmentIds) {
    if (!nonEmptyText(rawId)) return false;
    const id = rawId.trim();
    if (ids.has(id) || !confirmedIds.has(id)) return false;
    ids.add(id);
    const segment = segmentsById.get(id);
    if (!segment || segment.reviewStatus !== 'confirmed') return false;
  }
  return true;
}

/**
 * Checks whether every segment belonging to one verified bank is explicitly
 * confirmed in this guided-review session.  It accepts either the bank-level
 * result of `buildGuidedReviewBankGroups` or the position-level groups from
 * `buildGuidedReviewGroups`.
 */
export function isGuidedBankComplete(
  bankKey: string,
  groups: readonly (GuidedReviewGroup | GuidedReviewBankGroup)[],
  segmentsById: ReadonlyMap<string, ReviewSegment>,
  confirmedIds: ReadonlySet<string>,
): boolean {
  if (!nonEmptyText(bankKey) || !Array.isArray(groups)) return false;
  const matching = groups.filter((group) => isRecord(group) && group.bankKey === bankKey.trim());
  if (matching.length === 0) return false;
  const ids: string[] = [];
  for (const group of matching) {
    for (const id of group.segmentIds) if (nonEmptyText(id)) addUnique(ids, id.trim());
  }
  if (ids.length === 0) return false;
  return isGuidedGroupComplete({
    key: `bank:${safePart(bankKey.trim())}`,
    label: bankKey.trim(),
    segmentIds: ids,
    sourceKeys: [],
    bankKey: bankKey.trim(),
    positionGroupKeys: [],
  }, segmentsById, confirmedIds);
}
