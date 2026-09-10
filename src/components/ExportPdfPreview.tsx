export type ExportPdfPreviewProps = {
  imageData: string;
  page: number;
  pageCount: number;
  zoom: number;
  loading: boolean;
  error: string;
  onPrevious: () => void;
  onNext: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onRetry: () => void;
  files?: Array<{ id: string; name: string; pageCount: number }>;
  selectedFileId?: string;
  onFileChange?: (id: string) => void;
  fileSelectionDisabled?: boolean;
  summary?: string;
};

export function ExportPdfPreview({
  imageData,
  page,
  pageCount,
  zoom,
  loading,
  error,
  onPrevious,
  onNext,
  onZoomOut,
  onZoomIn,
  onRetry,
  files,
  selectedFileId,
  onFileChange,
  fileSelectionDisabled,
  summary,
}: ExportPdfPreviewProps) {
  return (
    <section className="export-pdf-preview" aria-label="最终 PDF 导出预览">
      {files && <div className="export-bundle-summary">
        <label>预览文件
          <select aria-label="预览文件" value={selectedFileId} disabled={fileSelectionDisabled} onChange={(event) => onFileChange?.(event.target.value)}>
            {files.map((file) => <option key={file.id} value={file.id}>{file.name}（{file.pageCount} 页）</option>)}
          </select>
        </label>
        <p>{summary}</p>
      </div>}
      <header className="export-pdf-toolbar">
        <div>
          <strong>最终 PDF 导出预览</strong>
          <span>第 {page} / {pageCount} 页</span>
        </div>
        <div className="export-pdf-toolbar-actions">
          <button type="button" onClick={onPrevious} disabled={page <= 1 || loading}>上一页</button>
          <button type="button" onClick={onNext} disabled={page >= pageCount || loading}>下一页</button>
          <button type="button" aria-label="缩小" onClick={onZoomOut} disabled={zoom <= 25}>−</button>
          <span>{zoom}%</span>
          <button type="button" aria-label="放大" onClick={onZoomIn} disabled={zoom >= 200}>＋</button>
        </div>
      </header>
      <div className="export-pdf-stage">
        {loading ? (
          <p>正在渲染最终 PDF 第 {page} 页…</p>
        ) : error ? (
          <div className="export-pdf-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={onRetry}>重试预览页</button>
          </div>
        ) : imageData ? (
          <img
            src={imageData}
            alt={`最终 PDF 第 ${page} 页预览`}
            style={{ width: `${zoom}%` }}
          />
        ) : (
          <p>正在准备最终 PDF 第 {page} 页…</p>
        )}
      </div>
    </section>
  );
}
