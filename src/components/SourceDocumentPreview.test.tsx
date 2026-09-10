// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The project uses Bun/Vitest runtime APIs without installing @types/node.
// @ts-expect-error Node-compatible fs is available in the Bun test runtime.
import { readFileSync } from 'node:fs';

import type { PdfRect, ReviewSegment } from '../domain/cropReview';
import type { SourceDocument, SourcePreviewLocation } from '../domain/sourcePreview';
import type { EnginePagePreview } from './localEngineAdapter';
import { SourceDocumentPreview, type SourceDocumentPreviewProps } from './SourceDocumentPreview';

afterEach(cleanup);

const sourceStyles = readFileSync('src/styles.css', 'utf8');

const previewImage = 'data:image/png;base64,PREVIEW';
const sourceDocument: SourceDocument = {
  key: 'source-key',
  name: 'a-very-long-source-document-name-that-needs-truncation.pdf',
  sourcePath: 'D:\\input\\source.pdf',
  sourceSha256: 'a'.repeat(64),
  pageCount: 3,
  integrityStatus: 'valid',
};
const location: SourcePreviewLocation = { documentKey: sourceDocument.key, page: 2 };
const preview: EnginePagePreview = {
  status: 'ok',
  page: 2,
  page_count: 3,
  page_width: 600,
  page_height: 800,
  image_data: previewImage,
};
const matchRect: PdfRect = { x0: 80, y0: 120, x1: 240, y1: 180 };
const editorRect: PdfRect = { x0: 60, y0: 80, x1: 540, y1: 300 };
const visibleSegment: ReviewSegment = {
  id: 'segment-1',
  sourcePath: sourceDocument.sourcePath,
  sourceSha256: sourceDocument.sourceSha256,
  sourcePage: 2,
  segmentNo: 1,
  matchRect,
  candidateRect: editorRect,
  finalRect: null,
  pageWidth: 600,
  pageHeight: 800,
  confidence: 0.9,
  slot: null,
  snapPoints: [80, 180],
  layoutFingerprint: 'layout',
  mode: 'candidate',
  reviewStatus: 'needs_review',
  manualAdjusted: false,
};

function renderPreview(overrides: Partial<SourceDocumentPreviewProps> = {}) {
  const props: SourceDocumentPreviewProps = {
    document: sourceDocument,
    location,
    pageDraft: '2',
    pageInputError: '',
    preview,
    visibleSegment: null,
    editorRect: null,
    zoom: 100,
    loading: false,
    error: '',
    navigationDisabled: false,
    editorDisabled: false,
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onPageDraftChange: vi.fn(),
    onPageDraftSubmit: vi.fn(),
    onPageDraftCancel: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomIn: vi.fn(),
    onRetry: vi.fn(),
    onCropChange: vi.fn(),
    onCropCommit: vi.fn(),
    ...overrides,
  };
  render(<SourceDocumentPreview {...props} />);
  return props;
}

describe('SourceDocumentPreview', () => {
  it('shows the source filename, page controls, and zoom controls', () => {
    renderPreview();

    const filename = screen.getByText(sourceDocument.name);
    expect(filename.className).toContain('source-document-name');
    expect(screen.queryByText('当前片段：第 2 页 / 片段 1')).toBeNull();
    expect(screen.getByRole('button', { name: '上一页' })).toBeTruthy();
    expect(screen.getByLabelText('当前 PDF 页码')).toBeTruthy();
    expect(screen.getByText('/ 3')).toBeTruthy();
    expect(screen.getByRole('button', { name: '下一页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '缩小' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '放大' })).toBeTruthy();
  });

  it('shows the current segment context beside the source filename when supplied', () => {
    const label = '当前片段：第 2 页 / 片段 1';
    renderPreview({ currentSegmentLabel: label });

    const contextLabel = screen.getByText(label);
    expect(contextLabel.className).toContain('source-document-segment-context');
    expect(contextLabel.getAttribute('title')).toBe(label);
  });

  it('disables page navigation and shows placeholders without document metadata', () => {
    renderPreview({ document: null, location: null, pageDraft: '' });

    expect(screen.getByText('第 — / — 页')).toBeTruthy();
    expect((screen.getByLabelText('当前 PDF 页码') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders an original page image on a page with no visible hit', () => {
    renderPreview();

    expect(screen.getByRole('img', { name: `${sourceDocument.name} 第 2 页` })).toBeTruthy();
    expect(screen.queryByTestId('crop-editor-page')).toBeNull();
    expect(screen.queryByRole('button', { name: '保存当前裁剪' })).toBeNull();
    expect(screen.queryByRole('button', { name: '保留整页' })).toBeNull();
    expect(screen.queryByRole('button', { name: '确认当前片段' })).toBeNull();
  });

  it('renders CropEditor only when the preview, segment, and editor geometry are valid', () => {
    renderPreview({ visibleSegment, editorRect });

    expect(screen.getByTestId('crop-editor-page')).toBeTruthy();
    expect(screen.queryByRole('img', { name: `${sourceDocument.name} 第 2 页` })).toBeNull();
  });

  it('lets a source-preview crop editor fill the scaled page width', () => {
    renderPreview({ visibleSegment, editorRect, zoom: 150 });

    const editorPage = screen.getByTestId('crop-editor-page');
    expect(editorPage.closest('.source-document-preview')).toBeTruthy();
    expect(sourceStyles).toMatch(
      /\.source-document-preview\s+\.crop-editor-page\s*\{[^}]*width:\s*100%;/,
    );
  });

  it.each([
    ['x0 小于页面左边界', { x0: -1, y0: 80, x1: 540, y1: 300 }],
    ['y0 小于页面上边界', { x0: 60, y0: -1, x1: 540, y1: 300 }],
    ['x1 超出页面右边界', { x0: 60, y0: 80, x1: 601, y1: 300 }],
    ['y1 超出页面下边界', { x0: 60, y0: 80, x1: 540, y1: 801 }],
  ])('rejects a non-empty editor rectangle when %s', (_description, outOfBoundsRect) => {
    renderPreview({ visibleSegment, editorRect: outOfBoundsRect });

    expect(screen.getByRole('img', { name: `${sourceDocument.name} 第 2 页` })).toBeTruthy();
    expect(screen.queryByTestId('crop-editor-page')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('当前片段裁剪几何无效，不能编辑或导出。');
  });

  it.each([
    ['width 小于最小裁剪尺寸', { x0: 60, y0: 80, x1: 71, y1: 300 }],
    ['height 小于最小裁剪尺寸', { x0: 60, y0: 80, x1: 540, y1: 91 }],
  ])('rejects an in-page editor rectangle when its %s', (_description, undersizedRect) => {
    renderPreview({ visibleSegment, editorRect: undersizedRect });

    expect(screen.getByRole('img', { name: `${sourceDocument.name} 第 2 页` })).toBeTruthy();
    expect(screen.queryByTestId('crop-editor-page')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('当前片段裁剪几何无效，不能编辑或导出。');
  });

  it('allows a full-page rectangle when both page dimensions are smaller than the minimum crop size', () => {
    const smallPageSegment: ReviewSegment = {
      ...visibleSegment,
      pageWidth: 8,
      pageHeight: 10,
    };

    renderPreview({
      visibleSegment: smallPageSegment,
      editorRect: { x0: 0, y0: 0, x1: 8, y1: 10 },
    });

    expect(screen.getByTestId('crop-editor-page')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the original page and reports invalid geometry without creating CropEditor', () => {
    renderPreview({ visibleSegment, editorRect: null });

    expect(screen.getByRole('img', { name: `${sourceDocument.name} 第 2 页` })).toBeTruthy();
    expect(screen.queryByTestId('crop-editor-page')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('当前片段裁剪几何无效，不能编辑或导出。');
  });

  it('uses the supplied geometry error when the application provides one', () => {
    renderPreview({ visibleSegment, editorRect: null, error: '页面尺寸与分析结果不一致' });

    expect(screen.getByRole('img', { name: `${sourceDocument.name} 第 2 页` })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('页面尺寸与分析结果不一致');
  });

  it('submits on Enter or blur and cancels on Escape', () => {
    const props = renderPreview();
    const input = screen.getByLabelText('当前 PDF 页码');

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(props.onPageDraftSubmit).toHaveBeenCalledTimes(2);
    expect(props.onPageDraftCancel).toHaveBeenCalledOnce();
  });

  it('marks page input errors as invalid and exposes the message as an alert', () => {
    renderPreview({ pageInputError: '请输入 1–3 的页码' });

    expect(screen.getByLabelText('当前 PDF 页码').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('请输入 1–3 的页码');
  });

  it('retains the current page while offering a retry after render errors', () => {
    const props = renderPreview({ error: '预览页面渲染失败' });

    expect((screen.getByLabelText('当前 PDF 页码') as HTMLInputElement).value).toBe('2');
    expect(screen.getByRole('alert').textContent).toContain('预览页面渲染失败');
    fireEvent.click(screen.getByRole('button', { name: '重试页面预览' }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it('owns only the source toolbar and independently scrolling PDF stage', () => {
    renderPreview();
    const previewRegion = screen.getByRole('region', { name: '源 PDF 预览' });
    const toolbar = previewRegion.querySelector('.source-document-toolbar');
    const stage = previewRegion.querySelector('.document-stage');
    expect(toolbar?.parentElement).toBe(previewRegion);
    expect(stage?.parentElement).toBe(previewRegion);
    expect(screen.queryByRole('button', { name: '保留整页' })).toBeNull();
    expect(screen.queryByRole('button', { name: '确认当前片段' })).toBeNull();
    expect(screen.queryByRole('button', { name: '确认整组' })).toBeNull();
    expect(screen.queryByRole('button', { name: /选择目录并导出/ })).toBeNull();
  });
});
