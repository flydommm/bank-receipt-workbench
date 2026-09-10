// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExportPdfPreview } from './ExportPdfPreview';

afterEach(cleanup);

function renderPreview(overrides: Partial<React.ComponentProps<typeof ExportPdfPreview>> = {}) {
  const props: React.ComponentProps<typeof ExportPdfPreview> = {
    imageData: 'data:image/png;base64,PREVIEW',
    page: 2,
    pageCount: 3,
    zoom: 100,
    loading: false,
    error: '',
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomIn: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  render(<ExportPdfPreview {...props} />);
  return props;
}

describe('ExportPdfPreview', () => {
  it('shows the final PDF page and keeps navigation and zoom in the center preview', async () => {
    const user = userEvent.setup();
    const props = renderPreview();

    const image = screen.getByRole('img', { name: '最终 PDF 第 2 页预览' });
    expect(image.getAttribute('src')).toBe('data:image/png;base64,PREVIEW');
    expect(screen.getByText('第 2 / 3 页')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '上一页' }));
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await user.click(screen.getByRole('button', { name: '缩小' }));
    await user.click(screen.getByRole('button', { name: '放大' }));
    expect(props.onPrevious).toHaveBeenCalledOnce();
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(props.onZoomOut).toHaveBeenCalledOnce();
    expect(props.onZoomIn).toHaveBeenCalledOnce();
  });

  it('does not render adjustment, export, XLSX or feedback controls', () => {
    renderPreview();

    expect(screen.queryByRole('button', { name: '返回调整' })).toBeNull();
    expect(screen.queryByRole('button', { name: /选择目录并导出/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows page-render errors and lets the caller retry', async () => {
    const user = userEvent.setup();
    const props = renderPreview({ imageData: '', error: '预览页渲染失败' });

    expect(screen.getByRole('alert').textContent).toContain('预览页渲染失败');
    await user.click(screen.getByRole('button', { name: '重试预览页' }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it('owns only the final-preview toolbar and independently scrolling PDF stage', () => {
    renderPreview();
    const previewRegion = screen.getByRole('region', { name: '最终 PDF 导出预览' });
    const toolbar = previewRegion.querySelector('.export-pdf-toolbar');
    const stage = previewRegion.querySelector('.export-pdf-stage');
    expect(toolbar?.parentElement).toBe(previewRegion);
    expect(stage?.parentElement).toBe(previewRegion);
    expect(screen.queryByRole('button', { name: '返回调整' })).toBeNull();
    expect(screen.queryByRole('button', { name: /选择目录并导出/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /XLSX/ })).toBeNull();
  });
});
