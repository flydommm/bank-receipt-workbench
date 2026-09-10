import { MIN_CROP_SIZE, type PdfRect, type ReviewSegment } from './cropReview';

/**
 * The read-only page descriptor returned by the local engine.  The field
 * names intentionally follow the snake_case response contract so this type
 * can be shared by the adapter and the pure planning code.
 */
export type CropTemplatePage = {
  status: 'ok';
  page: number;
  page_count: number;
  page_width: number;
  page_height: number;
  source_sha256: string;
  crop_template:
    | {
        status: 'ready';
        fingerprint: string;
        receipts: {
          anchor_y: number;
          bounds: PdfRect;
          title_key: string;
        }[];
      }
    | {
        status: 'unavailable';
        reason: string;
      };
};

export type BatchCropPlan = {
  sampleId: string;
  applicable: { before: ReviewSegment; after: ReviewSegment }[];
  skipped: { segment: ReviewSegment; reason: string }[];
};

const SIZE_TOLERANCE_PT = 1.5;
const GEOMETRY_TOLERANCE_PT = 0.5;

type ReceiptTemplate = {
  anchor_y: number;
  bounds: PdfRect;
  title_key: string;
};

type ReadyTemplatePage = {
  page: number;
  page_count: number;
  page_width: number;
  page_height: number;
  source_sha256: string;
  fingerprint: string;
  receipts: ReceiptTemplate[];
};

type PageInspection =
  | { kind: 'ready'; page: ReadyTemplatePage }
  | { kind: 'unavailable'; reason: string };

const UNAVAILABLE_REASONS: Readonly<Record<string, string>> = {
  no_text: '页面没有可识别文字。',
  no_titles: '页面没有可核实的凭证标题。',
  ambiguous_layout: '页面版式存在歧义。',
  budget_exceeded: '页面版式信息超出检查预算。',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isPageNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isCropMode(value: unknown): value is ReviewSegment['mode'] {
  return value === 'candidate' || value === 'manual' || value === 'full_page';
}

function isReviewStatus(value: unknown): value is ReviewSegment['reviewStatus'] {
  return value === 'pending'
    || value === 'needs_review'
    || value === 'confirmed'
    || value === 'blocked';
}

function sourceIdentity(value: Record<string, unknown>): string | null {
  if (value.sourceKey !== undefined && !isNonEmptyText(value.sourceKey)) return null;
  const source = value.sourceKey === undefined ? value.sourcePath : value.sourceKey;
  return isNonEmptyText(source) ? source.trim() : null;
}

function validRect(value: unknown, pageWidth: number, pageHeight: number, crop = false): value is PdfRect {
  if (!isRecord(value)
    || !isFiniteNumber(value.x0)
    || !isFiniteNumber(value.y0)
    || !isFiniteNumber(value.x1)
    || !isFiniteNumber(value.y1)
    || value.x0 < 0
    || value.y0 < 0
    || value.x1 < value.x0
    || value.y1 < value.y0
    || value.x1 > pageWidth
    || value.y1 > pageHeight) {
    return false;
  }

  const width = value.x1 - value.x0;
  const height = value.y1 - value.y0;
  if (!crop) return width > 0 && height > 0;

  const validWidth = pageWidth < MIN_CROP_SIZE
    ? value.x0 === 0 && value.x1 === pageWidth
    : width >= MIN_CROP_SIZE;
  const validHeight = pageHeight < MIN_CROP_SIZE
    ? value.y0 === 0 && value.y1 === pageHeight
    : height >= MIN_CROP_SIZE;
  return validWidth && validHeight;
}

function contains(outer: PdfRect, inner: PdfRect): boolean {
  return inner.x0 >= outer.x0
    && inner.y0 >= outer.y0
    && inner.x1 <= outer.x1
    && inner.y1 <= outer.y1;
}

function intersectsWithPositiveArea(left: PdfRect, right: PdfRect): boolean {
  return Math.min(left.x1, right.x1) > Math.max(left.x0, right.x0)
    && Math.min(left.y1, right.y1) > Math.max(left.y0, right.y0);
}

function sameRect(left: PdfRect, right: PdfRect): boolean {
  return left.x0 === right.x0
    && left.y0 === right.y0
    && left.x1 === right.x1
    && left.y1 === right.y1;
}

function cloneRect(value: PdfRect | null): PdfRect | null {
  return value === null ? null : { ...value };
}

function cloneSegment(value: ReviewSegment): ReviewSegment {
  return {
    ...value,
    matchRect: { ...value.matchRect },
    candidateRect: cloneRect(value.candidateRect),
    finalRect: cloneRect(value.finalRect),
    snapPoints: value.snapPoints ? [...value.snapPoints] : value.snapPoints,
  };
}

/**
 * Builds the page lookup key from immutable source identity, content hash and
 * one-based source page.  A NUL separator matches the other source/page keys
 * in the review domain and keeps the three components unambiguous.
 */
export function cropPageKey(segment: ReviewSegment): string {
  if (!isRecord(segment)) throw new RangeError('片段数据无效。');
  const source = sourceIdentity(segment);
  if (!isNonEmptyText(segment.sourcePath)
    || !source
    || !isNonEmptyText(segment.sourceSha256)
    || !isPageNumber(segment.sourcePage)) {
    throw new RangeError('片段来源、SHA 或页码无效。');
  }
  return `${source}\u0000${segment.sourceSha256.trim()}\u0000${segment.sourcePage}`;
}

function baseSegmentError(value: unknown, allowNullCrops: boolean): string | null {
  if (!isRecord(value)
    || !isNonEmptyText(value.id)
    || !isNonEmptyText(value.sourcePath)
    || !sourceIdentity(value)
    || !isNonEmptyText(value.sourceSha256)
    || !isPageNumber(value.sourcePage)
    || !isPageNumber(value.segmentNo)
    || !isPositiveFiniteNumber(value.pageWidth)
    || !isPositiveFiniteNumber(value.pageHeight)
    || !isFiniteNumber(value.confidence)
    || !isRecord(value.matchRect)
    || !validRect(value.matchRect, value.pageWidth, value.pageHeight)
    || !isNonEmptyText(value.layoutFingerprint)
    || !isCropMode(value.mode)
    || !isReviewStatus(value.reviewStatus)
    || typeof value.manualAdjusted !== 'boolean'
    || (value.slot !== null && typeof value.slot !== 'string')
    || (value.sourceName !== undefined && typeof value.sourceName !== 'string')
    || (value.snapPoints !== undefined
      && (!Array.isArray(value.snapPoints) || !value.snapPoints.every(isFiniteNumber)))) {
    return '片段数据无效。';
  }

  if (value.candidateRect !== null
    && !validRect(value.candidateRect, value.pageWidth, value.pageHeight, true)) {
    return '候选裁剪无效。';
  }
  if (value.finalRect !== null
    && !validRect(value.finalRect, value.pageWidth, value.pageHeight, true)) {
    return '最终裁剪无效。';
  }
  if (!allowNullCrops && (value.candidateRect === null || value.finalRect === null)) {
    return '缺少候选或最终裁剪。';
  }
  return null;
}

function sampleCropError(value: ReviewSegment): string | null {
  const baseError = baseSegmentError(value, true);
  if (baseError) return baseError;

  if (value.candidateRect === null) return '样本缺少候选裁剪。';
  if (value.finalRect === null) return '样本缺少最终裁剪。';
  if (!contains(value.candidateRect, value.matchRect) || !contains(value.finalRect, value.matchRect)) {
    return '样本裁剪未包含命中区域。';
  }
  if (value.manualAdjusted !== true) return '样本必须是人工调整片段。';
  if (value.mode !== 'manual') return '样本裁剪模式必须是手工模式。';
  if (sameRect(value.candidateRect, value.finalRect)) return '样本裁剪没有发生改动。';
  return null;
}

/**
 * Returns a user-facing reason when a segment cannot be used as the sample.
 * It is deliberately total over unknown runtime input because UI state may
 * have crossed a serialization boundary before reaching this pure function.
 */
export function batchSampleError(segment: ReviewSegment | null): string | null {
  if (segment === null || !isRecord(segment)) return '样本片段不存在或数据无效。';
  return sampleCropError(segment as ReviewSegment);
}

/**
 * Returns a protection reason for a target that must not be overwritten by a
 * batch operation.  Metadata compatibility is checked by the planner after
 * these state protections pass.
 */
export function batchTargetProtection(segment: ReviewSegment): string | null {
  if (!isRecord(segment) || !isNonEmptyText(segment.id)) return '片段数据无效。';
  if (!isReviewStatus(segment.reviewStatus)
    || (segment.reviewStatus !== 'pending' && segment.reviewStatus !== 'needs_review')) {
    return '当前审核状态不允许批量调整。';
  }
  if (segment.mode !== 'candidate') return '仅候选裁剪允许批量调整。';
  if (segment.manualAdjusted !== false) return '片段已人工调整，不能批量覆盖。';

  const baseError = baseSegmentError(segment, true);
  if (baseError) return baseError;
  if (segment.candidateRect === null) return '目标缺少候选裁剪。';
  if (segment.finalRect === null) return '目标缺少最终裁剪。';
  if (!sameRect(segment.finalRect, segment.candidateRect)) return '目标最终裁剪已被修改。';
  if (!contains(segment.candidateRect, segment.matchRect)) return '目标候选裁剪未包含命中区域。';
  return null;
}

function inspectPage(value: unknown): PageInspection | null {
  if (!isRecord(value) || value.status !== 'ok'
    || !isPageNumber(value.page)
    || !isPageNumber(value.page_count)
    || value.page_count < value.page
    || !isPositiveFiniteNumber(value.page_width)
    || !isPositiveFiniteNumber(value.page_height)
    || !isNonEmptyText(value.source_sha256)
    || !isRecord(value.crop_template)) {
    return null;
  }

  const template = value.crop_template;
  if (template.status === 'unavailable') {
    if (!isNonEmptyText(template.reason)) return null;
    return {
      kind: 'unavailable',
      reason: UNAVAILABLE_REASONS[template.reason.trim()] ?? '页面版式不可用，无法安全匹配。',
    };
  }
  if (template.status !== 'ready' || !isNonEmptyText(template.fingerprint)
    || !Array.isArray(template.receipts) || template.receipts.length === 0) {
    return null;
  }

  const receipts: ReceiptTemplate[] = [];
  for (const item of template.receipts) {
    if (!isRecord(item)
      || !isFiniteNumber(item.anchor_y)
      || !isNonEmptyText(item.title_key)
      || !validRect(item.bounds, value.page_width, value.page_height)) {
      return null;
    }
    if (item.anchor_y < item.bounds.y0 || item.anchor_y >= item.bounds.y1) return null;
    receipts.push({
      anchor_y: item.anchor_y,
      bounds: { x0: item.bounds.x0, y0: item.bounds.y0, x1: item.bounds.x1, y1: item.bounds.y1 },
      title_key: item.title_key.trim(),
    });
  }

  return {
    kind: 'ready',
    page: {
      page: value.page,
      page_count: value.page_count,
      page_width: value.page_width,
      page_height: value.page_height,
      source_sha256: value.source_sha256.trim(),
      fingerprint: template.fingerprint.trim(),
      receipts,
    },
  };
}

function pageIdentityError(page: ReadyTemplatePage, segment: ReviewSegment): string | null {
  if (page.page !== segment.sourcePage || page.page_count < segment.sourcePage) return '页面编号或页数元数据不匹配。';
  if (page.source_sha256.toLowerCase() !== segment.sourceSha256.trim().toLowerCase()) {
    return '页面来源 SHA-256 与片段不匹配。';
  }
  if (Math.abs(page.page_width - segment.pageWidth) > GEOMETRY_TOLERANCE_PT
    || Math.abs(page.page_height - segment.pageHeight) > GEOMETRY_TOLERANCE_PT) {
    return '页面几何与片段不匹配。';
  }
  return null;
}

function pageGeometryMismatch(left: ReadyTemplatePage, right: ReadyTemplatePage): boolean {
  return Math.abs(left.page_width - right.page_width) > GEOMETRY_TOLERANCE_PT
    || Math.abs(left.page_height - right.page_height) > GEOMETRY_TOLERANCE_PT;
}

function matchingReceipt(
  receipts: ReceiptTemplate[],
  matchRect: PdfRect,
): { receipt: ReceiptTemplate | null; reason: string | null } {
  const matches = receipts.filter((receipt) => contains(receipt.bounds, matchRect));
  if (matches.length === 0) return { receipt: null, reason: '页面版式中没有包含命中区域的凭证边界。' };
  if (matches.length > 1) return { receipt: null, reason: '命中区域对应多个凭证，版式不明确。' };
  return { receipt: matches[0]!, reason: null };
}

function getPage(pages: ReadonlyMap<string, CropTemplatePage>, segment: ReviewSegment): unknown {
  try {
    return pages.get(cropPageKey(segment));
  } catch {
    return undefined;
  }
}

function skipped(
  result: { segment: ReviewSegment; reason: string }[],
  segment: ReviewSegment,
  reason: string,
): void {
  result.push({ segment, reason });
}

function cloneAfter(segment: ReviewSegment, finalRect: PdfRect): ReviewSegment {
  return {
    ...cloneSegment(segment),
    finalRect: { ...finalRect },
    mode: 'manual',
    manualAdjusted: true,
    reviewStatus: 'confirmed',
  };
}

function planTarget(
  sample: ReviewSegment,
  target: ReviewSegment,
  samplePage: ReadyTemplatePage,
  sampleReceipt: ReceiptTemplate,
  targetPageValue: unknown,
): { after: ReviewSegment } | { reason: string } {
  const inspection = inspectPage(targetPageValue);
  if (inspection === null) return { reason: '目标页面版式元数据无效或缺失。' };
  if (inspection.kind === 'unavailable') return { reason: inspection.reason };

  const page = inspection.page;
  const identityError = pageIdentityError(page, target);
  if (identityError) return { reason: identityError };
  if (pageGeometryMismatch(samplePage, page)) return { reason: '目标页面几何与样本不匹配。' };
  if (page.fingerprint !== samplePage.fingerprint) return { reason: '目标版式指纹与样本不匹配。' };

  const targetReceiptResult = matchingReceipt(page.receipts, target.matchRect);
  if (targetReceiptResult.reason || targetReceiptResult.receipt === null) {
    return { reason: targetReceiptResult.reason ?? '目标凭证版式元数据无效。' };
  }
  const targetReceipt = targetReceiptResult.receipt;
  if (targetReceipt.title_key !== sampleReceipt.title_key) return { reason: '目标标题与样本不匹配。' };

  if (target.candidateRect === null || sample.candidateRect === null || sample.finalRect === null) {
    return { reason: '候选或最终裁剪缺失。' };
  }
  if (!validRect(target.candidateRect, page.page_width, page.page_height, true)
    || !validRect(target.matchRect, page.page_width, page.page_height)) {
    return { reason: '目标候选裁剪超出实际纸张边界。' };
  }
  const sampleWidth = sample.candidateRect.x1 - sample.candidateRect.x0;
  const sampleHeight = sample.candidateRect.y1 - sample.candidateRect.y0;
  const targetWidth = target.candidateRect.x1 - target.candidateRect.x0;
  const targetHeight = target.candidateRect.y1 - target.candidateRect.y0;
  if (Math.abs(targetWidth - sampleWidth) > SIZE_TOLERANCE_PT
    || Math.abs(targetHeight - sampleHeight) > SIZE_TOLERANCE_PT) {
    return { reason: '目标候选裁剪尺寸与样本不匹配。' };
  }

  const sampleHeaderOffset = sample.candidateRect.y0 - sampleReceipt.anchor_y;
  const targetHeaderOffset = target.candidateRect.y0 - targetReceipt.anchor_y;
  if (Math.abs(target.candidateRect.x0 - sample.candidateRect.x0) > SIZE_TOLERANCE_PT) {
    return { reason: '目标候选裁剪相对样本的横向位置不匹配。' };
  }
  if (Math.abs(targetHeaderOffset - sampleHeaderOffset) > SIZE_TOLERANCE_PT) {
    return { reason: '目标候选裁剪相对标题位置与样本不匹配。' };
  }

  const edgeDelta = {
    x0: sample.finalRect.x0 - sample.candidateRect.x0,
    y0: sample.finalRect.y0 - sample.candidateRect.y0,
    x1: sample.finalRect.x1 - sample.candidateRect.x1,
    y1: sample.finalRect.y1 - sample.candidateRect.y1,
  };
  const afterRect: PdfRect = {
    x0: target.candidateRect.x0 + edgeDelta.x0,
    y0: target.candidateRect.y0 + edgeDelta.y0,
    x1: target.candidateRect.x1 + edgeDelta.x1,
    y1: target.candidateRect.y1 + edgeDelta.y1,
  };

  if (!validRect(afterRect, target.pageWidth, target.pageHeight, true)) {
    return { reason: '批量调整后的裁剪超出纸张或小于最小尺寸。' };
  }
  if (!contains(afterRect, target.matchRect)) return { reason: '批量调整后的裁剪未包含命中区域。' };
  if (!contains(targetReceipt.bounds, afterRect)) return { reason: '批量调整后的裁剪超出凭证保护边界。' };

  for (const receipt of page.receipts) {
    if (receipt !== targetReceipt && intersectsWithPositiveArea(afterRect, receipt.bounds)) {
      return { reason: '批量调整后的裁剪伸入相邻凭证边界。' };
    }
  }

  return { after: cloneAfter(target, afterRect) };
}

/**
 * Creates an immutable-by-convention batch plan.  The original target object
 * is retained as `before`; the proposed decision is a detached segment.  No
 * source, target array, map, or nested rectangle is mutated.
 */
export function createBatchCropPlan(
  sample: ReviewSegment,
  targets: ReviewSegment[],
  pages: ReadonlyMap<string, CropTemplatePage>,
): BatchCropPlan {
  const sampleError = batchSampleError(sample);
  if (sampleError) throw new RangeError(sampleError);
  if (!Array.isArray(targets)) throw new TypeError('目标片段集合无效。');
  if (!isRecord(pages) || typeof pages.get !== 'function') throw new TypeError('页面版式映射无效。');

  const sampleValue = sample as ReviewSegment;
  const applicable: BatchCropPlan['applicable'] = [];
  const skippedTargets: BatchCropPlan['skipped'] = [];
  const ids = new Set<string>();

  for (const candidate of targets) {
    if (isRecord(candidate) && isNonEmptyText(candidate.id)) {
      if (ids.has(candidate.id)) throw new RangeError(`目标片段 ID 重复：${candidate.id}`);
      ids.add(candidate.id);
    }
  }

  const samplePageInspection = inspectPage(getPage(pages, sampleValue));
  let samplePage: ReadyTemplatePage | null = null;
  let samplePageReason = '样本页面版式元数据缺失。';
  if (samplePageInspection === null) {
    samplePageReason = '样本页面版式元数据无效或缺失。';
  } else if (samplePageInspection.kind === 'unavailable') {
    samplePageReason = samplePageInspection.reason;
  } else {
    const identityError = pageIdentityError(samplePageInspection.page, sampleValue);
    if (identityError) samplePageReason = `样本${identityError}`;
    else samplePage = samplePageInspection.page;
  }

  let sampleReceipt: ReceiptTemplate | null = null;
  if (samplePage) {
    const result = matchingReceipt(samplePage.receipts, sampleValue.matchRect);
    if (result.receipt === null) {
      samplePageReason = result.reason ?? '样本凭证版式元数据无效。';
      samplePage = null;
    } else {
      sampleReceipt = result.receipt;
      if (!validRect(sampleValue.candidateRect, samplePage.page_width, samplePage.page_height, true)
        || !validRect(sampleValue.finalRect, samplePage.page_width, samplePage.page_height, true)) {
        throw new RangeError('样本裁剪超出实际纸张边界。');
      }
      if (sampleValue.finalRect === null || !contains(sampleReceipt.bounds, sampleValue.finalRect)) {
        throw new RangeError('样本最终裁剪超出凭证保护边界。');
      }
      if (samplePage.receipts.some((receipt) => (
        receipt !== sampleReceipt && intersectsWithPositiveArea(sampleValue.finalRect!, receipt.bounds)
      ))) {
        throw new RangeError('样本最终裁剪伸入相邻凭证边界。');
      }
    }
  }

  for (const candidate of targets) {
    if (isRecord(candidate) && isNonEmptyText(candidate.id) && candidate.id === sampleValue.id) continue;

    if (!isRecord(candidate) || !isNonEmptyText(candidate.id)) {
      skipped(skippedTargets, candidate as ReviewSegment, '片段数据无效。');
      continue;
    }

    const protection = batchTargetProtection(candidate as ReviewSegment);
    if (protection) {
      skipped(skippedTargets, candidate as ReviewSegment, protection);
      continue;
    }
    if (samplePage === null || sampleReceipt === null) {
      skipped(skippedTargets, candidate as ReviewSegment, samplePageReason);
      continue;
    }

    const result = planTarget(
      sampleValue,
      candidate as ReviewSegment,
      samplePage,
      sampleReceipt,
      getPage(pages, candidate as ReviewSegment),
    );
    if ('reason' in result) skipped(skippedTargets, candidate as ReviewSegment, result.reason);
    else applicable.push({ before: candidate as ReviewSegment, after: result.after });
  }

  return { sampleId: sampleValue.id, applicable, skipped: skippedTargets };
}
