// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReceiptLayoutPreview } from '../services/receiptLayoutClient';
import { ReceiptRiskReview, type ReceiptRiskReviewProps } from './ReceiptRiskReview';

afterEach(cleanup);

const layout = {
  schema_version: 1, layout_id: 'layout', revision: 1, workspace_id: 'workspace', issuer_id: 'bank', family_id: 'three', evidence_version: 'v1',
  page_geometry: { pdf_box: { x0: 0, y0: 0, x1: 600, y1: 900 }, rotation: 0, user_unit: 1, width_pt: 600, height_pt: 900 },
  uniform_height: false, left_pt: 0, right_pt: 0,
  slots: [0, 1, 2].map((index) => ({ slot_id: `slot-${index + 1}`, position_index: index + 1, top_pt: index * 300, height_pt: 290 })),
} as ReceiptLayoutPreview['layout_definition'];

function risk(riskId: string, sourceKey = '/a.pdf', page = 1, diagnostic: Record<string, unknown> = { code: 'content_outside_slots' }): ReceiptLayoutPreview['risks'][number] {
  return { risk_id: riskId, source_key: sourceKey, page, diagnostic };
}

function target(sourceKey: string, page: number, slotId: string, status: ReceiptLayoutPreview['affected'][number]['status'] = 'updated', hasAfterRect = true): ReceiptLayoutPreview['affected'][number] {
  return { source_key: sourceKey, page, slot_id: slotId, previous_id: null, id: hasAfterRect ? 'b'.repeat(64) : null,
    before_rect: null, after_rect: hasAfterRect ? { x0: 0, y0: 0, x1: 100, y1: 100 } : null, status };
}

function renderReview(overrides: Partial<ReceiptRiskReviewProps> = {}) {
  const props: ReceiptRiskReviewProps = {
    risks: [risk('risk-1')], acknowledgedRiskIds: [], onAcknowledgeMany: vi.fn(),
    sources: [{ source_key: '/a.pdf', label: '民生回单.pdf' }], layoutDefinition: layout,
    ...overrides,
  };
  return { props, view: render(<ReceiptRiskReview {...props} />) };
}

describe('ReceiptRiskReview', () => {
  it('names special document types without treating them as a standard receipt layout', () => {
    renderReview({ risks: [risk('notice', '/a.pdf', 18, { code: 'special_document', document_type: 'loan_interest_notice' }),
      risk('tax', '/a.pdf', 26, { code: 'special_document', document_type: 'electronic_tax_payment' }),
      risk('settlement', '/a.pdf', 10, { code: 'special_document', document_type: 'loan_settlement_notice' })] });
    expect(screen.getByText('贷款利息到期通知书，请核对整张凭证是否完整')).toBeTruthy();
    expect(screen.getByText('电子缴税付款凭证，请核对整张凭证是否完整')).toBeTruthy();
    expect(screen.getByText('贷款清算通知书，请核对整张凭证是否完整')).toBeTruthy();
    expect(screen.getByText('已核对 0 / 3 组')).toBeTruthy();
  });
  it('shows direct per-risk checkboxes and starts without acknowledging or saving anything', async () => {
    const user = userEvent.setup();
    const onAcknowledgeMany = vi.fn();
    const onSave = vi.fn();
    const { props } = renderReview({ risks: [risk('risk-1', '/a.pdf', 4, { code: 'content_crosses_slot', slot_id: 'slot-2' })], onAcknowledgeMany });

    expect((screen.getByRole('checkbox', { name: '全部标为已核对' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('已核对 0 / 1 组')).toBeTruthy();
    expect(screen.getByText('民生回单.pdf')).toBeTruthy();
    expect(screen.getByText('第 4 页')).toBeTruthy();
    expect(screen.getByText('第 2 栏')).toBeTruthy();
    expect(screen.getByText('文字超出回单边界')).toBeTruthy();
    expect(onAcknowledgeMany).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();

    const itemCheckbox = screen.getByRole('checkbox', { name: /民生回单\.pdf，第 4 页，第 2 栏/ });
    await user.click(itemCheckbox);
    expect(onAcknowledgeMany).toHaveBeenCalledExactlyOnceWith(['risk-1'], true);
    expect(props.acknowledgedRiskIds).toEqual([]);
  });

  it('groups two repeated same-slot visual risks into one checkbox while submitting both risk ids', async () => {
    const user = userEvent.setup();
    const onAcknowledgeMany = vi.fn();
    const risks = [
      risk('seal-1', '/a.pdf', 670, { code: 'visual_crosses_slot', slot_id: 'slot-3' }),
      risk('seal-2', '/a.pdf', 670, { code: 'visual_crosses_slot', slot_id: 'slot-3' }),
    ];
    renderReview({ risks, onAcknowledgeMany });

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getAllByRole('checkbox', { name: /第 670 页/ })).toHaveLength(1);
    const groupText = screen.getAllByRole('listitem')[0].textContent ?? '';
    expect(groupText).toContain('图形或印章超出回单边界 × 2 项');
    expect(groupText).toContain('共 2 项版式风险');
    expect(screen.getByText('已核对 0 / 1 组')).toBeTruthy();

    const group = screen.getByRole('checkbox', { name: /第 670 页.*第 3 栏/ });
    await user.click(group);
    expect(onAcknowledgeMany).toHaveBeenCalledExactlyOnceWith(['seal-1', 'seal-2'], true);
    await user.click(screen.getByRole('checkbox', { name: '全部标为已核对' }));
    expect(onAcknowledgeMany).toHaveBeenLastCalledWith(['seal-1', 'seal-2'], true);
  });

  it('shows affected evidence conservatively for changed, removed, and unchanged slot groups', () => {
    renderReview({
      risks: [
        risk('hit-risk', '/a.pdf', 670, { code: 'visual_crosses_slot', slot_id: 'slot-2' }),
        // A risk without an affected entry may be an unchanged hit; do not label it as a no-hit.
        risk('unchanged-risk', '/a.pdf', 670, { code: 'visual_crosses_slot', slot_id: 'slot-3' }),
        risk('page-risk', '/a.pdf', 670, { code: 'content_outside_slots' }),
        risk('removed-risk', '/a.pdf', 671, { code: 'visual_crosses_slot', slot_id: 'slot-2' }),
      ],
      affected: [target('/a.pdf', 670, 'slot-2'), target('/a.pdf', 671, 'slot-2', 'removed', false)],
    });

    expect(screen.getByText('本轮命中')).toBeTruthy();
    expect(screen.getByText('本轮未列入变化·版式核对')).toBeTruthy();
    expect(screen.getByText('本轮移除')).toBeTruthy();
    const pageRisk = screen.getByRole('checkbox', { name: /第 670 页.*页面整体检查/ });
    expect(pageRisk.closest('li')?.textContent).toContain('页面整体检查');
    expect(pageRisk.closest('li')?.textContent).not.toContain('本轮命中');
    expect(document.querySelector('.receipt-risk-review__explanation')?.textContent).toContain('勾选核对不会增加导出片段。');
  });

  it('states that an unchanged crop may still lose its earlier exclusion after saving', () => {
    renderReview({
      risks: [risk('exclusion-reset', '/a.pdf', 1, { code: 'excluded_decision_reset', slot_id: 'slot-3' })],
      affected: [target('/a.pdf', 1, 'slot-1')],
    });
    const row = screen.getByRole('checkbox', { name: /第 1 页.*第 3 栏/ }).closest('li');
    expect(row?.textContent).toContain('排除将转待复核');
    expect(row?.textContent).toContain('此片段原已排除；保存本轮后将转为待复核。如仍需排除，请保存后重新排除。');
    expect(row?.textContent).not.toContain('本轮未列入变化·版式核对');
  });

  it('keeps page-level and unknown slot checks separate and gives partially checked groups an indeterminate checkbox', async () => {
    const user = userEvent.setup();
    const risks = [
      risk('unknown-a', '/a.pdf', 4, { code: 'visual_crosses_slot', slot_id: 'missing-a' }),
      risk('unknown-b', '/a.pdf', 4, { code: 'visual_crosses_slot', slot_id: 'missing-b' }),
      risk('slot-risk-1', '/a.pdf', 4, { code: 'visual_crosses_slot', slot_id: 'slot-1' }),
      risk('slot-risk-2', '/a.pdf', 4, { code: 'content_crosses_slot', slot_id: 'slot-1' }),
      risk('page-risk-1', '/a.pdf', 4, { code: 'content_outside_slots' }),
      risk('page-risk-2', '/a.pdf', 4, { code: 'content_outside_slots' }),
    ];
    const onAcknowledgeMany = vi.fn();
    const { view } = renderReview({ risks, onAcknowledgeMany });
    const groups = screen.getAllByRole('listitem');
    expect(groups).toHaveLength(4);
    expect(groups.filter((row) => row.textContent?.includes('页面整体检查'))).toHaveLength(1);
    expect(groups.filter((row) => row.textContent?.includes('未知栏位'))).toHaveLength(2);

    view.rerender(<ReceiptRiskReview risks={risks} acknowledgedRiskIds={['slot-risk-1']} onAcknowledgeMany={onAcknowledgeMany} layoutDefinition={layout} />);
    expect((screen.getByRole('checkbox', { name: /第 4 页.*第 1 栏/ }) as HTMLInputElement).indeterminate).toBe(true);
    expect(screen.getByText('已核对 0 / 4 组')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: /第 4 页.*第 1 栏/ }));
    expect(onAcknowledgeMany).toHaveBeenLastCalledWith(['slot-risk-2', 'slot-risk-1'], true);
  });

  it('selects all, reports a mixed state, and clears every check with the same master checkbox', async () => {
    const user = userEvent.setup();
    const risks = [risk('risk-1'), risk('risk-2', '/a.pdf', 2)];
    const onAcknowledgeMany = vi.fn();
    const { view } = renderReview({ risks, onAcknowledgeMany });
    const master = screen.getByRole('checkbox', { name: '全部标为已核对' }) as HTMLInputElement;

    await user.click(master);
    expect(onAcknowledgeMany).toHaveBeenLastCalledWith(['risk-1', 'risk-2'], true);
    view.rerender(<ReceiptRiskReview risks={risks} acknowledgedRiskIds={['risk-1']} onAcknowledgeMany={onAcknowledgeMany} layoutDefinition={layout} />);
    expect(master.checked).toBe(false);
    expect(master.indeterminate).toBe(true);
    expect(screen.getByText('已核对 1 / 2 组')).toBeTruthy();

    await user.click(master);
    expect(onAcknowledgeMany).toHaveBeenLastCalledWith(['risk-1', 'risk-2'], true);
    view.rerender(<ReceiptRiskReview risks={risks} acknowledgedRiskIds={['risk-1', 'risk-2']} onAcknowledgeMany={onAcknowledgeMany} layoutDefinition={layout} />);
    expect(master.checked).toBe(true);
    expect(master.indeterminate).toBe(false);
    await user.click(master);
    expect(onAcknowledgeMany).toHaveBeenLastCalledWith(['risk-1', 'risk-2'], false);
  });

  it('applies Shift-click checking and clearing to the continuous sorted range', async () => {
    const user = userEvent.setup();
    const risks = [
      risk('risk-3', '/a.pdf', 3),
      risk('risk-1a', '/a.pdf', 1, { code: 'visual_crosses_slot', slot_id: 'slot-1' }),
      risk('risk-1b', '/a.pdf', 1, { code: 'visual_crosses_slot', slot_id: 'slot-1' }),
      risk('risk-4', '/a.pdf', 4),
      risk('risk-2', '/a.pdf', 2),
    ];
    const onAcknowledgeMany = vi.fn();
    const { view } = renderReview({ risks, onAcknowledgeMany, layoutDefinition: { ...layout, slots: [layout.slots[0]] } });

    const itemFor = (page: number) => screen.getByRole('checkbox', { name: new RegExp(`第 ${page} 页`) });
    await user.click(itemFor(1));
    await user.keyboard('[ShiftLeft>]');
    await user.click(itemFor(3));
    await user.keyboard('[/ShiftLeft]');
    expect(onAcknowledgeMany.mock.calls).toEqual([
      [['risk-1a', 'risk-1b'], true],
      [['risk-1a', 'risk-1b', 'risk-2', 'risk-3'], true],
    ]);
    view.rerender(<ReceiptRiskReview risks={risks} acknowledgedRiskIds={['risk-1a', 'risk-1b', 'risk-2', 'risk-3']}
      onAcknowledgeMany={onAcknowledgeMany} layoutDefinition={{ ...layout, slots: [layout.slots[0]] }} />);
    await user.keyboard('[ShiftLeft>]');
    await user.click(itemFor(3));
    await user.keyboard('[/ShiftLeft]');
    expect(onAcknowledgeMany).toHaveBeenLastCalledWith(['risk-1a', 'risk-1b', 'risk-2', 'risk-3'], false);
  });

  it('sorts by source, numeric page, and exact diagnostic slot while merging matching slot groups', () => {
    const risks = [
      risk('z', '/z.pdf', 1, { code: 'content_outside_slots' }),
      risk('page-10', '/a.pdf', 10, { code: 'content_outside_slots' }),
      risk('slot-3', '/a.pdf', 2, { code: 'visual_crosses_slot', slot_id: 'slot-3' }),
      risk('slot-1', '/a.pdf', 2, { code: 'uncertain_text', slot_id: 'slot-1' }),
      risk('unknown-slot', '/a.pdf', 3, { code: 'ambiguous_block', instance_ids: ['slot-2'] }),
      risk('page-2', '/a.pdf', 2, { code: 'content_outside_slots' }),
      risk('slot-1-other-risk', '/a.pdf', 2, { code: 'visual_crosses_slot', slot_id: 'slot-1' }),
    ];
    const { view } = renderReview({ risks });
    const rows = within(view.container).getAllByRole('listitem');
    expect(rows).toHaveLength(risks.length - 1);
    const labels = rows.map((row) => row.textContent ?? '');
    expect(labels[0]).toContain('第 2 页');
    expect(labels[0]).toContain('页面整体检查');
    expect(labels[1]).toContain('第 1 栏');
    expect(labels[1]).toContain('共 2 项版式风险');
    expect(labels[2]).toContain('第 3 栏');
    expect(labels[3]).toContain('第 3 页');
    expect(labels[3]).toContain('页面整体检查');
    expect(labels[4]).toContain('第 10 页');
    expect(labels[5]).toContain('z.pdf');
  });

  it('renders no review section when there are no risks', () => {
    renderReview({ risks: [] });
    expect(screen.queryByRole('region', { name: '本轮风险核对' })).toBeNull();
  });
});
