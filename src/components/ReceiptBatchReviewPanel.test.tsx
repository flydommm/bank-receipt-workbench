// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReceiptBatchReviewPanel, { type ReceiptBatchReviewPanelItem } from './ReceiptBatchReviewPanel';

const geometry = {
  pdf_box: { x0: 0, y0: 0, x1: 600, y1: 900 },
  rotation: 0 as const,
  user_unit: 1,
  width_pt: 600,
  height_pt: 900,
};

function item(id: string, page: number, needsReview: boolean): ReceiptBatchReviewPanelItem {
  return {
    original: {
      id,
      source_key: 'source-a',
      source_page: page,
      instance_id: `instance-${id}`,
      slot_id: 'slot-1',
      position_index: 1,
      layout_id: 'layout-a',
      layout_revision: 1,
      layout_signature: 'layout-signature',
      page_geometry: geometry,
      candidate_rect: { x0: 0, y0: 0, x1: 600, y1: 440 },
      occupancy: 'occupied',
      selection_basis: 'keyword',
      needs_review: needsReview,
      analysis_signature: 'analysis-signature',
    },
    record_revision: 0,
    record: null,
  };
}

describe('ReceiptBatchReviewPanel', () => {
  beforeEach(() => cleanup());

  it('offers direct export when every candidate is automatic', () => {
    const onExport = vi.fn();
    render(<ReceiptBatchReviewPanel items={[item('a', 1, false)]} sources={[{ source_key: 'source-a', name: '上海银行回单.pdf' }]} onExport={onExport} />);
    expect(screen.getByText('无需微调，可直接导出')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '直接导出' }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('shows one progressive fine-tune action and reports selected candidates', () => {
    const onEnterFineTune = vi.fn();
    const onSelect = vi.fn();
    render(<ReceiptBatchReviewPanel
      items={[item('a', 1, true), item('b', 2, false)]}
      sources={[{ source_key: 'source-a', name: '华夏银行回单.pdf' }]}
      onEnterFineTune={onEnterFineTune}
      onSelect={onSelect}
    />);
    expect(screen.getByText('1 个候选需要微调后再导出')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '进入微调' }));
    expect(onEnterFineTune).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector<HTMLElement>('.receipt-batch-review-row')!);
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(screen.getByText('已选中一个候选，可进入微调查看边界。')).toBeTruthy();
  });
  it('keeps excluded rows auditable and withholds export when none remain', () => {
    const excluded = item('excluded', 1, false);
    excluded.record = { review_status: 'excluded', record_revision: 1 } as any;
    excluded.record_revision = 1;
    render(<ReceiptBatchReviewPanel items={[excluded]} sources={[{ source_key: 'source-a', name: '上海银行回单.pdf' }]} onExport={vi.fn()} />);
    expect(screen.getByText('已排除')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '直接导出' })).toBeNull();
  });
});
