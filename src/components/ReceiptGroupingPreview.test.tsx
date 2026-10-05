// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BatchSourceSnapshot } from '../domain/batchTask';
import type { ReceiptBatchReviewPageItem } from '../domain/receiptBatch';
import type { ReceiptReviewRecord } from '../domain/receiptReview';
import { ReceiptGroupingPreview } from './ReceiptGroupingPreview';
import { localEngineAdapter, type EnginePagePreview } from './localEngineAdapter';

const sha = 'a'.repeat(64);
const pageRect = { x0: 0, y0: 0, x1: 600, y1: 900 };
const candidateRect = { x0: 0, y0: 300, x1: 600, y1: 590 };

function source(overrides: Partial<BatchSourceSnapshot> = {}): BatchSourceSnapshot {
  return { source_id: 'source-1', position: 0, source_key: '/a.pdf', initial_path: '/a.pdf', access_path: '/a.pdf',
    name: '合成回单.pdf', sha256: sha, size_bytes: 1234, page_count: 2, state: 'verified', error: null,
    budget: { processed_pages: 2, text_characters: 100, fuzzy_work: 0, matches: 1, matched_text_characters: 20 },
    verified_generation: 1, page_summary: { pending: 0, processing: 0, succeeded: 2, failed: 0 }, ...overrides };
}

function item(overrides: Partial<ReceiptBatchReviewPageItem> = {}): ReceiptBatchReviewPageItem {
  return { original: { id: 'segment-1', source_key: '/a.pdf', source_page: 1, instance_id: 'instance-1', slot_id: 'slot-1',
    position_index: 2, layout_id: 'layout', layout_revision: 1, layout_signature: 'b'.repeat(64), page_geometry: {
      pdf_box: pageRect, rotation: 0, user_unit: 1, width_pt: 600, height_pt: 900,
    }, candidate_rect: candidateRect, occupancy: 'occupied', selection_basis: 'occupied_slot', needs_review: false,
    analysis_signature: 'c'.repeat(64) }, record_revision: 0, record: null, ...overrides } as ReceiptBatchReviewPageItem;
}

function record(overrides: Partial<ReceiptReviewRecord> = {}): ReceiptReviewRecord {
  return { schema_version: 1, context_key: 'd'.repeat(64), result_revision: 'revision-1', record_revision: 1,
    source_path: '/a.pdf', source_sha256: sha, original: item().original, final_rect: candidateRect, crop_mode: 'candidate',
    review_status: 'confirmed', manual_adjusted: false, reviewed_at: '2026-10-03T00:00:00Z', ...overrides };
}

function image(page: number, sourceSha = sha): EnginePagePreview {
  return { status: 'ok', page, page_count: 2, page_width: 600, page_height: 900, source_sha256: sourceSha,
    image_data: `data:image/png;base64,synthetic-page-${page}` };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ReceiptGroupingPreview', () => {
  it('单张可直接缩放，保持审核边界、不重复渲染原页，切换片段保留比例', async () => {
    const renderPage = vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(image(1));
    const audited = item({ record: record() });
    const view = render(<ReceiptGroupingPreview reviewItem={audited} source={source()} contextKey="batch-a" />);
    const svg = await screen.findByRole('img');
    const zoom = screen.getByRole('group', { name: '单张预览缩放' });
    expect(svg.style.width).toBe('100%');
    fireEvent.click(within(zoom).getByRole('button', { name: '放大单张预览' }));
    expect(svg.style.width).toBe('125%');
    expect(svg.getAttribute('viewBox')).toBe('0 300 600 290');
    expect(renderPage).toHaveBeenCalledTimes(1);
    const next = item({ original: { ...audited.original, id: 'segment-2', position_index: 3, candidate_rect: { x0: 0, y0: 600, x1: 600, y1: 890 } } });
    view.rerender(<ReceiptGroupingPreview reviewItem={next} source={source()} contextKey="batch-a" />);
    expect(screen.getByRole('img').style.width).toBe('125%');
    expect(screen.getByRole('img').getAttribute('viewBox')).toBe('0 600 600 290');
    expect(screen.getAllByText('第 1 页 · 第 3 栏')).toHaveLength(1);
    for (let count = 0; count < 15; count += 1) fireEvent.click(within(zoom).getByRole('button', { name: '缩小单张预览' }));
    expect(screen.getByRole('img').style.width).toBe('50%');
    expect((within(zoom).getByRole('button', { name: '缩小单张预览' }) as HTMLButtonElement).disabled).toBe(true);
    for (let count = 0; count < 15; count += 1) fireEvent.click(within(zoom).getByRole('button', { name: '放大单张预览' }));
    expect(screen.getByRole('img').style.width).toBe('300%');
    expect((within(zoom).getByRole('button', { name: '放大单张预览' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<ReceiptGroupingPreview reviewItem={next} source={source()} contextKey="batch-b" />);
    await waitFor(() => expect(screen.getByRole('img').style.width).toBe('100%'));
  });

  it('来源、唯一页码栏位和切换控制集中在同一个预览标题内', async () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(image(1));
    const next = vi.fn();
    const view = render(<ReceiptGroupingPreview reviewItem={item()} source={source()} contextKey="batch-a" controls={<button onClick={next}>下一张</button>} />);
    await screen.findByRole('img');
    const header = view.container.querySelector('.receipt-grouping-preview__header') as HTMLElement;
    expect(within(header).getByText('合成回单.pdf')).toBeTruthy();
    expect(within(header).getByText('第 1 页 · 第 2 栏')).toBeTruthy();
    expect(screen.getAllByText('第 1 页 · 第 2 栏')).toHaveLength(1);
    fireEvent.click(within(header).getByRole('button', { name: '下一张' }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(within(header).getByRole('button', { name: '放大单张预览' })).toBeTruthy();
  });

  it('uses the full page when an audited record has final_rect null', async () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(image(1));
    const audited = item({ record: record({ final_rect: null }) });
    render(<ReceiptGroupingPreview reviewItem={audited} source={source()} contextKey="batch-a" />);
    const svg = await screen.findByRole('img', { name: /合成回单\.pdf.*第 1 页.*整页/ });
    expect(svg.getAttribute('viewBox')).toBe('0 0 600 900');
    expect(localEngineAdapter.renderPage).toHaveBeenCalledWith('/a.pdf', 1, sha);
  });

  it('loads only after becoming active and does not show a stale source image after context changes', async () => {
    let resolveFirst!: (value: EnginePagePreview) => void;
    const firstPromise = new Promise<EnginePagePreview>((resolve) => { resolveFirst = resolve; });
    const renderPage = vi.spyOn(localEngineAdapter, 'renderPage')
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValue(image(1, 'b'.repeat(64)));
    const view = render(<ReceiptGroupingPreview reviewItem={item()} source={source()} active={false} contextKey="batch-a" />);
    expect(renderPage).not.toHaveBeenCalled();
    view.rerender(<ReceiptGroupingPreview reviewItem={item()} source={source()} active contextKey="batch-a" />);
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));
    const nextSource = source({ sha256: 'b'.repeat(64) });
    view.rerender(<ReceiptGroupingPreview reviewItem={item()} source={nextSource} active contextKey="batch-b" />);
    resolveFirst(image(1));
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));
    await screen.findByRole('img', { name: /合成回单\.pdf/ });
    expect(screen.getByRole('img').getAttribute('data-stale')).toBeNull();
  });

  it('opens a read-only dialog with segment/page views, zoom, and focus restoration', async () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(image(1));
    render(<ReceiptGroupingPreview reviewItem={item()} source={source()} contextKey="batch-a" />);
    const open = await screen.findByRole('button', { name: '放大查看' });
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: '原件放大查看' });
    fireEvent.click(within(dialog).getByRole('button', { name: '查看整页' }));
    expect(within(dialog).getByRole('img', { name: /整页/ }).getAttribute('viewBox')).toBe('0 0 600 900');
    fireEvent.click(within(dialog).getByRole('button', { name: '放大' }));
    expect(within(dialog).getByText('125%')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it('rejects a record whose source SHA does not match the selected source', () => {
    const mismatched = item({ record: record({ source_sha256: 'b'.repeat(64) }) });
    const renderPage = vi.spyOn(localEngineAdapter, 'renderPage');
    render(<ReceiptGroupingPreview reviewItem={mismatched} source={source()} contextKey="batch-a" />);
    expect(screen.getByRole('alert').textContent).toContain('SHA-256');
    expect(renderPage).not.toHaveBeenCalled();
  });

  it('opens a verified relocated original using its current path and unchanged SHA', async () => {
    const renderPage = vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(image(1));
    render(<ReceiptGroupingPreview reviewItem={item({ record: record() })}
      source={source({ access_path: '/relocated/a.pdf' })} contextKey="batch-a" />);
    await screen.findByRole('img');
    expect(renderPage).toHaveBeenCalledWith('/relocated/a.pdf', 1, sha);
  });

  it('rejects a renderer response whose SHA does not match the bound source', async () => {
    vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(image(1, 'b'.repeat(64)));
    render(<ReceiptGroupingPreview reviewItem={item()} source={source()} contextKey="batch-a" />);
    expect((await screen.findByRole('alert')).textContent).toContain('页面尺寸或来源');
  });
});
