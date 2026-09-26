import type {
  ReceiptBatchJobSnapshot,
  ReceiptBatchReviewPageItem,
} from '../domain/receiptBatch';
import type {
  ReceiptReviewOriginal,
  ReceiptReviewRecord,
} from '../domain/receiptReview';

/** A display-only projection of the schema-3 review binding. */
export type ReceiptBatchReviewViewItem = {
  id: string;
  sourceKey: string;
  sourceName: string;
  sourcePath: string;
  sourcePage: number;
  instanceId: string;
  slotId: string;
  positionIndex: number;
  layoutId: string;
  layoutRevision: number;
  layoutSignature: string;
  pageWidth: number;
  pageHeight: number;
  candidateRect: ReceiptReviewOriginal['candidate_rect'];
  finalRect: ReceiptReviewRecord['final_rect'];
  cropMode: ReceiptReviewRecord['crop_mode'];
  reviewStatus: ReceiptReviewRecord['review_status'];
  manualAdjusted: boolean;
  recordRevision: number;
  needsReview: boolean;
  occupancy: ReceiptReviewOriginal['occupancy'];
  selectionBasis: ReceiptReviewOriginal['selection_basis'];
  analysisSignature: string;
};

function sourceIndex(job: ReceiptBatchJobSnapshot): Map<string, { name: string; accessPath: string }> {
  return new Map(job.sources.map((source) => [source.source_key, { name: source.name, accessPath: source.access_path }]));
}

/**
 * Convert server-validated review page items without changing immutable
 * identity or silently promoting an unconfirmed record. Missing records keep
 * their original candidate geometry and automatic review assessment.
 */
export function mapReceiptBatchReviewItems(
  job: ReceiptBatchJobSnapshot,
  items: readonly ReceiptBatchReviewPageItem[],
): ReceiptBatchReviewViewItem[] {
  const sources = sourceIndex(job);
  const ids = new Set<string>();
  return items.map((item) => {
    const original = item.original;
    if (ids.has(original.id)) throw new Error('回单审核结果包含重复片段。');
    ids.add(original.id);
    const source = sources.get(original.source_key);
    if (!source) throw new Error('回单审核结果来源不在任务清单中。');
    const record = item.record;
    if (record && record.original.id !== original.id) throw new Error('回单审核记录与原始片段身份不一致。');
    const finalRect = record ? record.final_rect : original.candidate_rect;
    return {
      id: original.id,
      sourceKey: original.source_key,
      sourceName: source.name,
      sourcePath: source.accessPath,
      sourcePage: original.source_page,
      instanceId: original.instance_id,
      slotId: original.slot_id,
      positionIndex: original.position_index,
      layoutId: original.layout_id,
      layoutRevision: original.layout_revision,
      layoutSignature: original.layout_signature,
      pageWidth: original.page_geometry.width_pt,
      pageHeight: original.page_geometry.height_pt,
      candidateRect: original.candidate_rect,
      finalRect,
      cropMode: record?.crop_mode ?? 'candidate',
      reviewStatus: record?.review_status ?? (original.needs_review ? 'needs_review' : 'confirmed'),
      manualAdjusted: record?.manual_adjusted ?? false,
      recordRevision: item.record_revision,
      // An explicit saved decision supersedes the initial analysis warning.
      // In particular, a saved calibration must stop appearing as unresolved.
      needsReview: record ? !['confirmed', 'page_confirmed', 'excluded'].includes(record.review_status) : original.needs_review,
      occupancy: original.occupancy,
      selectionBasis: original.selection_basis,
      analysisSignature: original.analysis_signature,
    };
  });
}

export function countReceiptBatchUnresolved(items: readonly ReceiptBatchReviewViewItem[]): number {
  return items.reduce((count, item) => count + (item.needsReview || item.reviewStatus === 'needs_review' ? 1 : 0), 0);
}

export function groupReceiptBatchReviewItems(
  items: readonly ReceiptBatchReviewViewItem[],
): Map<string, ReceiptBatchReviewViewItem[]> {
  const groups = new Map<string, ReceiptBatchReviewViewItem[]>();
  for (const item of items) {
    const key = `${item.sourceKey}\u0000${item.layoutId}\u0000${item.slotId}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
