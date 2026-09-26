// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { countReceiptBatchUnresolved, groupReceiptBatchReviewItems, mapReceiptBatchReviewItems } from './receiptBatchReviewAdapter';
import type { ReceiptBatchJobSnapshot, ReceiptBatchReviewPageItem } from '../domain/receiptBatch';

const job = {
  sources: [{ source_key: '/a.pdf', name: 'a.pdf', access_path: '/a.pdf' }],
} as unknown as ReceiptBatchJobSnapshot;

const original = {
  id: 'id-1', source_key: '/a.pdf', source_page: 2, instance_id: 'instance-1', slot_id: 'slot-1', position_index: 1,
  layout_id: 'layout-1', layout_revision: 1, layout_signature: 'sig',
  page_geometry: { width_pt: 600, height_pt: 900, pdf_box: { x0: 0, y0: 0, x1: 600, y1: 900 }, rotation: 0, user_unit: 1 },
  candidate_rect: { x0: 0, y0: 0, x1: 600, y1: 440 }, occupancy: 'occupied', selection_basis: 'keyword', needs_review: true,
  analysis_signature: 'analysis',
} as const;

const automaticOriginal = { ...original, id: 'automatic', instance_id: 'instance-automatic', needs_review: false } as const;

function item(record: ReceiptBatchReviewPageItem['record'] = null): ReceiptBatchReviewPageItem {
  return { original, record_revision: record?.record_revision ?? 0, record } as unknown as ReceiptBatchReviewPageItem;
}

describe('receiptBatchReviewAdapter', () => {
  it('keeps identity and exposes unresolved item without a record', () => {
    const mapped = mapReceiptBatchReviewItems(job, [item()]);
    expect(mapped[0]).toMatchObject({ id: 'id-1', slotId: 'slot-1', sourceName: 'a.pdf', reviewStatus: 'needs_review', needsReview: true });
    expect(countReceiptBatchUnresolved(mapped)).toBe(1);
  });

  it('groups by source, layout and position slot', () => {
    const second = { ...original, id: 'id-2', instance_id: 'instance-2' };
    const mapped = mapReceiptBatchReviewItems(job, [item(), { ...item(), original: second } as never]);
    expect(groupReceiptBatchReviewItems(mapped).size).toBe(1);
  });

  it('does not treat an automatic item without a persisted record as unresolved', () => {
    const mapped = mapReceiptBatchReviewItems(job, [{ original: automaticOriginal, record_revision: 0, record: null } as never]);
    expect(mapped[0]?.needsReview).toBe(false);
    expect(countReceiptBatchUnresolved(mapped)).toBe(0);
  });

  it.each(['confirmed', 'page_confirmed'] as const)('uses saved %s instead of the initial warning', (reviewStatus) => {
    const record = { original, final_rect: null, crop_mode: 'full_page', review_status: reviewStatus,
      record_revision: 1, manual_adjusted: false } as ReceiptBatchReviewPageItem['record'];
    const mapped = mapReceiptBatchReviewItems(job, [item(record)]);
    expect(mapped[0]).toMatchObject({ needsReview: false, finalRect: null, cropMode: 'full_page' });
    expect(countReceiptBatchUnresolved(mapped)).toBe(0);
  });
  it('treats an excluded record as resolved while preserving its review status', () => {
    const record = { original, final_rect: original.candidate_rect, crop_mode: 'candidate', review_status: 'excluded',
      record_revision: 1, manual_adjusted: false } as ReceiptBatchReviewPageItem['record'];
    const mapped = mapReceiptBatchReviewItems(job, [item(record)]);
    expect(mapped[0]).toMatchObject({ reviewStatus: 'excluded', needsReview: false });
    expect(countReceiptBatchUnresolved(mapped)).toBe(0);
  });
});
