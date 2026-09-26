// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnginePagePreview } from './localEngineAdapter';
import { PdfThumbnailGrid, type PdfThumbnailCard } from './PdfThumbnailGrid';

const { load, dispose } = vi.hoisted(() => ({ load: vi.fn(), dispose: vi.fn() }));
vi.mock('../services/pdfThumbnailCache', () => ({
  PdfThumbnailCache: class {
    load = load;
    dispose = dispose;
  },
}));

function card(index: number, overrides: Partial<PdfThumbnailCard> = {}): PdfThumbnailCard {
  return {
    id: `page-${index}`, path: 'D:/synthetic/source.pdf', sha: 'a'.repeat(64),
    page: index + 1, pageCount: 5000, label: `第 ${index + 1} 页`, ...overrides,
  };
}

function preview(page = 1, sha = 'a'.repeat(64)): EnginePagePreview {
  return {
    status: 'ok', page, page_count: 5000, page_width: 600, page_height: 800,
    source_sha256: sha, image_data: `data:image/png;base64,${sha[0]}-${page}`,
  };
}

beforeEach(() => {
  load.mockReset();
  dispose.mockReset();
  load.mockImplementation(async (request: { page: number; sha: string }) => preview(request.page, request.sha));
});
afterEach(cleanup);

describe('PdfThumbnailGrid', () => {
  it('mounts a bounded window for thousands of cards and loads later pages while scrolling', async () => {
    const cards = Array.from({ length: 5000 }, (_, index) => card(index));
    const { container } = render(<PdfThumbnailGrid cards={cards} size={192} shape="page" scrollKey="bounded" onOpen={vi.fn()} />);
    const region = screen.getByRole('region');
    await waitFor(() => expect(load).toHaveBeenCalled());

    expect(container.querySelectorAll('[data-card-id]').length).toBeLessThan(40);
    expect(screen.queryByRole('button', { name: '打开 第 5000 页' })).toBeNull();
    fireEvent.scroll(region, { target: { scrollTop: 9000 } });
    expect(container.querySelectorAll('[data-card-id]').length).toBeLessThan(40);
    expect(screen.queryByRole('button', { name: '打开 第 1 页' })).toBeNull();
    await waitFor(() => expect(load.mock.calls.some(([request]) => request.page > 60)).toBe(true));
    expect(load.mock.calls.some(([, signal]) => signal.aborted)).toBe(true);
  });

  it('keeps the visible item anchor on zoom and restores it when details close or the grid remounts', async () => {
    const cards = Array.from({ length: 5000 }, (_, index) => card(index));
    const props = { cards, size: 192, shape: 'page' as const, scrollKey: 'remember-anchor', onOpen: vi.fn() };
    const { container, rerender, unmount } = render(<PdfThumbnailGrid {...props} />);
    const region = screen.getByRole('region');
    fireEvent.scroll(region, { target: { scrollTop: 9000 } });
    const visibleBefore = Array.from(container.querySelectorAll('[data-card-id]'), (item) => item.getAttribute('data-card-id'));

    rerender(<PdfThumbnailGrid {...props} size={256} />);
    const visibleAfter = Array.from(container.querySelectorAll('[data-card-id]'), (item) => item.getAttribute('data-card-id'));
    expect(visibleAfter.some((id) => visibleBefore.includes(id))).toBe(true);
    expect(region.scrollTop).toBeGreaterThan(9000);
    const scrollBeforeDetails = region.scrollTop;
    rerender(<PdfThumbnailGrid {...props} size={256} active={false} />);
    expect(container.querySelectorAll('[data-card-id]').length).toBe(0);
    region.scrollTop = 0;
    rerender(<PdfThumbnailGrid {...props} size={256} active />);
    expect(region.scrollTop).toBe(scrollBeforeDetails);

    unmount();
    render(<PdfThumbnailGrid {...props} size={256} />);
    expect(screen.getByRole('region').scrollTop).toBe(scrollBeforeDetails);
  });

  it('preserves the visible anchor after a container resize', () => {
    const cards = Array.from({ length: 5000 }, (_, index) => card(index));
    const { container } = render(<PdfThumbnailGrid cards={cards} size={192} shape="receipt" scrollKey="resize-anchor" onOpen={vi.fn()} />);
    const region = screen.getByRole('region');
    fireEvent.scroll(region, { target: { scrollTop: 4000 } });
    const before = Array.from(container.querySelectorAll('[data-card-id]'), (item) => item.getAttribute('data-card-id'));
    Object.defineProperties(region, { clientWidth: { configurable: true, value: 450 }, clientHeight: { configurable: true, value: 600 } });
    fireEvent(window, new Event('resize'));
    const after = Array.from(container.querySelectorAll('[data-card-id]'), (item) => item.getAttribute('data-card-id'));
    expect(after.some((id) => before.includes(id))).toBe(true);
    expect(region.scrollTop).toBeGreaterThan(4000);
  });

  it('keeps opening independent of selection and forwards Shift range selection', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    render(<PdfThumbnailGrid cards={[card(0)]} size={192} shape="page" scrollKey="selection" selectedIds={new Set()} onOpen={onOpen} onToggle={onToggle} />);
    const checkbox = screen.getByRole('checkbox', { name: '选择 第 1 页' });
    fireEvent.click(checkbox, { shiftKey: true });
    expect(onToggle).toHaveBeenLastCalledWith('page-0', true, true);
    expect(onOpen).not.toHaveBeenCalled();

    screen.getByRole('button', { name: '打开 第 1 页' }).focus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'page-0' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    checkbox.focus();
    await user.keyboard('[Space]');
    expect(onToggle).toHaveBeenLastCalledWith('page-0', true, false);
    await user.keyboard('{Shift>}[Space]{/Shift}');
    expect(onToggle).toHaveBeenLastCalledWith('page-0', true, true);
  });

  it('cancels old source subscriptions and never displays their late images', async () => {
    const pending: { request: { page: number; sha: string }; resolve: (value: EnginePagePreview) => void; signal: AbortSignal }[] = [];
    load.mockImplementation((request, signal) => new Promise<EnginePagePreview>((resolve) => pending.push({ request, signal, resolve })));
    const props = { size: 192, shape: 'page' as const, scrollKey: 'source-a', onOpen: vi.fn() };
    const { container, rerender } = render(<PdfThumbnailGrid {...props} cards={[card(0)]} />);
    await waitFor(() => expect(pending.length).toBe(1));
    rerender(<PdfThumbnailGrid {...props} scrollKey="source-b" cards={[card(0, { sha: 'b'.repeat(64) })]} />);
    await waitFor(() => expect(pending.length).toBe(2));
    expect(pending[0].signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    await act(async () => pending[0].resolve(preview()));
    expect(container.querySelector('image')).toBeNull();
    await act(async () => pending[1].resolve(preview(1, 'b'.repeat(64))));
    expect(container.querySelector('image')?.getAttribute('href')).toContain('b-1');
  });

  it('retries a failed card without opening it', async () => {
    load.mockRejectedValueOnce(new Error('temporary failure'));
    const onOpen = vi.fn();
    render(<PdfThumbnailGrid cards={[card(0)]} size={192} shape="page" scrollKey="retry" onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole('button', { name: '重试 第 1 页缩略图' }));
    await screen.findByRole('img', { name: '第 1 页缩略图' });
    expect(load).toHaveBeenCalledTimes(2);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong page', { page: 9 }],
    ['wrong SHA', { source_sha256: 'b'.repeat(64) }],
    ['missing SHA', { source_sha256: undefined }],
    ['zero width', { page_width: 0 }],
    ['wrong dimensions', { page_width: 500 }],
  ])('does not show a response with %s', async (_name, overrides) => {
    load.mockResolvedValue({ ...preview(), ...overrides });
    const { container } = render(<PdfThumbnailGrid cards={[card(0, { width: 600, height: 800 })]} size={192} shape="page" scrollKey={`invalid-${_name}`} onOpen={vi.fn()} />);
    await screen.findByText('页面或尺寸不匹配');
    expect(container.querySelector('image')).toBeNull();
  });

  it('uses the complete crop viewBox and reuses the same image for crop and status edits', async () => {
    const original = card(0, { width: 600, height: 800, rect: { x0: 0, y0: 100, x1: 600, y1: 300 } });
    const props = { size: 192, shape: 'receipt' as const, scrollKey: 'crop', onOpen: vi.fn() };
    const { rerender } = render(<PdfThumbnailGrid {...props} cards={[original]} />);
    const image = await screen.findByRole('img');
    expect(image.getAttribute('viewBox')).toBe('0 100 600 200');
    // viewBox fitting can leave letterbox space; clipping must prevent adjacent
    // receipts from appearing in that space around the requested fragment.
    const clip = image.querySelector('clipPath')!;
    expect(image.querySelector('g')?.getAttribute('clip-path')).toBe(`url(#${clip.id})`);
    expect(['x', 'y', 'width', 'height'].map((key) => clip.firstElementChild?.getAttribute(key))).toEqual(['0', '100', '600', '200']);
    expect(image.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    rerender(<PdfThumbnailGrid {...props} cards={[{ ...original, tone: 'confirmed', rect: { x0: 50, y0: 100, x1: 550, y1: 500 } }]} />);
    expect(screen.getByRole('img').getAttribute('viewBox')).toBe('50 100 500 400');
    expect(['x', 'y', 'width', 'height'].map((key) => screen.getByRole('img').querySelector('clipPath rect')?.getAttribute(key))).toEqual(['50', '100', '500', '400']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('prevents source loading and interaction for invalid input metadata', () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    render(<PdfThumbnailGrid cards={[card(0, { width: Number.NaN })]} size={192} shape="page" scrollKey="invalid-input" onOpen={onOpen} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 第 1 页' }));
    expect(load).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('keeps an invalid crop hidden and reuses the page when its geometry is repaired', async () => {
    const invalid = card(0, { rect: { x0: 0, y0: 100, x1: 700, y1: 300 } });
    const props = { size: 192, shape: 'receipt' as const, scrollKey: 'repair-crop', onOpen: vi.fn() };
    const { rerender, container } = render(<PdfThumbnailGrid {...props} cards={[invalid]} />);
    await screen.findByText('裁剪区域无效');
    expect(container.querySelector('image')).toBeNull();
    rerender(<PdfThumbnailGrid {...props} cards={[{ ...invalid, rect: { ...invalid.rect!, x1: 600 } }]} />);
    expect(screen.getByRole('img').getAttribute('viewBox')).toBe('0 100 600 200');
    expect(load).toHaveBeenCalledTimes(1);
  });
});
