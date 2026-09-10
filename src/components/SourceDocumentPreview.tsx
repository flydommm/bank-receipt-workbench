import type { ReactNode } from 'react';

import CropEditor from './CropEditor';
import type { EnginePagePreview } from './localEngineAdapter';
import { MIN_CROP_SIZE, type PdfRect, type ReviewSegment } from '../domain/cropReview';
import type { SourceDocument, SourcePreviewLocation } from '../domain/sourcePreview';

export type SourceDocumentPreviewProps = {
  document: SourceDocument | null;
  location: SourcePreviewLocation | null;
  pageDraft: string;
  pageInputError: string;
  preview: EnginePagePreview | null;
  visibleSegment: ReviewSegment | null;
  currentSegmentLabel?: string;
  editorRect: PdfRect | null;
  zoom: number;
  loading: boolean;
  error: string;
  navigationDisabled: boolean;
  editorDisabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onPageDraftChange: (value: string) => void;
  onPageDraftSubmit: () => void;
  onPageDraftCancel: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onRetry: () => void;
  onCropChange: (rect: PdfRect) => void;
  onCropCommit: (rect: PdfRect) => void;
};

const INVALID_EDITOR_RECT_MESSAGE = '当前片段裁剪几何无效，不能编辑或导出。';

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidEditorGeometry(
  value: unknown,
  segment: ReviewSegment | null,
): value is PdfRect {
  if (!segment || !isFinitePositive(segment.pageWidth) || !isFinitePositive(segment.pageHeight)) {
    return false;
  }
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const { x0, y0, x1, y1 } = candidate;
  return typeof x0 === 'number'
    && Number.isFinite(x0)
    && typeof y0 === 'number'
    && Number.isFinite(y0)
    && typeof x1 === 'number'
    && Number.isFinite(x1)
    && typeof y1 === 'number'
    && Number.isFinite(y1)
    && x0 >= 0
    && y0 >= 0
    && x1 > x0
    && y1 > y0
    && x1 <= segment.pageWidth
    && y1 <= segment.pageHeight
    && (segment.pageWidth < MIN_CROP_SIZE
      ? x0 === 0 && x1 === segment.pageWidth
      : x1 - x0 >= MIN_CROP_SIZE)
    && (segment.pageHeight < MIN_CROP_SIZE
      ? y0 === 0 && y1 === segment.pageHeight
      : y1 - y0 >= MIN_CROP_SIZE);
}

function pageWidth(preview: EnginePagePreview, zoom: number): number {
  const scaledWidth = preview.page_width * zoom / 100;
  return Math.max(300, scaledWidth);
}

function pageDisplay(document: SourceDocument | null, location: SourcePreviewLocation | null, pageDraft: string): string {
  if (!document) return '—';
  const draft = pageDraft.trim();
  return draft || (location?.page ? String(location.page) : '—');
}

function previewIsUsable(preview: EnginePagePreview | null): preview is EnginePagePreview {
  return Boolean(
    preview
      && typeof preview.image_data === 'string'
      && isFinitePositive(preview.page_width)
      && isFinitePositive(preview.page_height),
  );
}

function renderPageImage(
  preview: EnginePagePreview,
  document: SourceDocument | null,
  zoom: number,
): ReactNode {
  return (
    <img
      className="source-page-image"
      src={preview.image_data}
      alt={`${document?.name ?? 'PDF'} 第 ${preview.page} 页`}
      style={{ width: `${pageWidth(preview, zoom)}px` }}
    />
  );
}

export function SourceDocumentPreview({
  document,
  location,
  pageDraft,
  pageInputError,
  preview,
  visibleSegment,
  currentSegmentLabel,
  editorRect,
  zoom,
  loading,
  error,
  navigationDisabled,
  editorDisabled,
  onPrevious,
  onNext,
  onPageDraftChange,
  onPageDraftSubmit,
  onPageDraftCancel,
  onZoomOut,
  onZoomIn,
  onRetry,
  onCropChange,
  onCropCommit,
}: SourceDocumentPreviewProps) {
  const previewAvailable = previewIsUsable(preview) ? preview : null;
  const currentPage = location?.page ?? previewAvailable?.page ?? null;
  const inputDisabled = navigationDisabled || !document;
  const previousDisabled = inputDisabled || !location || currentPage === null || currentPage <= 1;
  const nextDisabled = inputDisabled || !location || currentPage === null || currentPage >= document?.pageCount!;
  const pageNumber = pageDisplay(document, location, pageDraft);
  const pageCount = document?.pageCount ?? '—';
  const editorGeometryValid = isValidEditorGeometry(editorRect, visibleSegment);
  const geometryInvalid = Boolean(previewAvailable && visibleSegment && !editorGeometryValid);
  const geometryError = geometryInvalid
    ? (error.trim() || INVALID_EDITOR_RECT_MESSAGE)
    : '';
  const canRenderCropEditor = Boolean(
    previewAvailable
      && visibleSegment
      && editorGeometryValid,
  );

  function renderStage(): ReactNode {
    if (loading) {
      return <div className="preview-message">正在渲染第 {pageNumber} 页…</div>;
    }

    if (geometryError && previewAvailable) {
      return (
        <>
          {renderPageImage(previewAvailable, document, zoom)}
          <div className="preview-message preview-error" role="alert">{geometryError}</div>
        </>
      );
    }

    if (error) {
      return (
        <div className="preview-message preview-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={onRetry} disabled={loading}>重试页面预览</button>
        </div>
      );
    }

    if (canRenderCropEditor && previewAvailable && visibleSegment && editorRect) {
      return (
        <div
          className="real-preview-page"
          style={{ width: `${pageWidth(previewAvailable, zoom)}px` }}
        >
          <CropEditor
            imageData={previewAvailable.image_data}
            pageWidth={visibleSegment.pageWidth}
            pageHeight={visibleSegment.pageHeight}
            value={editorRect}
            matchRect={visibleSegment.matchRect}
            snapPoints={visibleSegment.snapPoints}
            disabled={editorDisabled}
            onChange={onCropChange}
            onCommit={onCropCommit}
          />
        </div>
      );
    }

    if (previewAvailable) return renderPageImage(previewAvailable, document, zoom);

    return (
      <div className="preview-message">
        {document ? '正在准备页面预览…' : '选择 PDF 后可在分析前预览原始文件'}
      </div>
    );
  }

  return (
    <section className="source-document-preview" aria-label="源 PDF 预览">
      <header className="source-document-toolbar">
        <div className="source-document-context">
          <strong>真实 PDF 预览</strong>
          <span className="toolbar-separator" aria-hidden="true" />
          <span
            className="source-document-name"
            title={document?.sourcePath}
          >
            {document?.name ?? '未选择 PDF'}
          </span>
          {currentSegmentLabel && (
            <span className="source-document-segment-context" title={currentSegmentLabel}>
              {currentSegmentLabel}
            </span>
          )}
        </div>
        <div className="source-document-controls">
          <button type="button" onClick={onPrevious} disabled={previousDisabled}>上一页</button>
          <span className="source-page-control">
            <span aria-hidden="true">第</span>
            <label className="page-input-control">
              <span className="sr-only">当前 PDF 页码</span>
              <input
                aria-label="当前 PDF 页码"
                aria-invalid={Boolean(pageInputError)}
                inputMode="numeric"
                value={pageDraft}
                placeholder={document ? undefined : '—'}
                disabled={inputDisabled}
                onChange={(event) => onPageDraftChange(event.target.value)}
                onBlur={onPageDraftSubmit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onPageDraftSubmit();
                  if (event.key === 'Escape') onPageDraftCancel();
                }}
              />
              <span>/ {pageCount}</span>
            </label>
            <span aria-hidden="true">页</span>
            <span className="sr-only">第 {pageNumber} / {pageCount} 页</span>
          </span>
          <button type="button" onClick={onNext} disabled={nextDisabled}>下一页</button>
          <button type="button" aria-label="缩小" onClick={onZoomOut}>−</button>
          <span className="source-zoom-value">{zoom}%</span>
          <button type="button" aria-label="放大" onClick={onZoomIn}>＋</button>
        </div>
      </header>

      {pageInputError && (
        <div className="preview-message preview-error source-page-input-error" role="alert">
          {pageInputError}
        </div>
      )}

      <div className="document-stage">{renderStage()}</div>
    </section>
  );
}

export default SourceDocumentPreview;
