import { useId } from 'react';

import {
  type ExportOutputMode,
  type ExportScopeSelection,
  resolveExportScope,
} from '../domain/exportIntent';
import { MAX_EXPORT_NAME_LENGTH, validateExportName } from '../domain/exportNaming';

import './ExportScopeSettings.css';

export type ExportScopeSettingsSource = {
  key: string;
  name: string;
  segmentCount: number;
};

export type ExportScopeSettingsProps = {
  sources: Array<ExportScopeSettingsSource>;
  scope: ExportScopeSelection;
  summary: ReturnType<typeof resolveExportScope>;
  outputMode: ExportOutputMode;
  outputName?: string;
  outputNameError?: string | null;
  includeXlsx: boolean;
  busy: boolean;
  taskError: string | null;
  operationError?: string | null;
  currentListCount: number;
  onScopeChange: (scope: ExportScopeSelection) => void;
  onCaptureCurrentList: () => void;
  onOutputModeChange: (mode: ExportOutputMode) => void;
  onOutputNameChange?: (name: string) => void;
  onIncludeXlsxChange: (include: boolean) => void;
  onGenerate: () => void;
  onCancel: () => void;
};

const OUTPUT_MODE_OPTIONS: ReadonlyArray<{ value: ExportOutputMode; label: string }> = [
  { value: 'merged', label: '合并为一个 PDF' },
  { value: 'by_source', label: '按来源分别导出 PDF' },
  { value: 'both', label: '合并版 + 来源版' },
];

function displayCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function cleanError(value: string | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueSourceKeys(sources: readonly ExportScopeSettingsSource[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!seen.has(source.key)) {
      seen.add(source.key);
      keys.push(source.key);
    }
  }
  return keys;
}

function outputDescription(
  mode: ExportOutputMode,
  pageCount: number,
  sourceCount: number,
): string {
  const pages = displayCount(pageCount);
  const files = displayCount(sourceCount);
  switch (mode) {
    case 'by_source':
      return `来源版合计 ${pages} 页；PDF 文件数 ${files}`;
    case 'both':
      return `合并版 ${pages} 页；来源版合计 ${pages} 页；PDF 文件数 ${files + 1}；物理页 ${pages * 2}`;
    case 'merged':
    default:
      return `合并版 ${pages} 页；PDF 文件数 1`;
  }
}

export function ExportScopeSettings({
  sources,
  scope,
  summary,
  outputMode,
  includeXlsx,
  busy,
  taskError,
  operationError,
  currentListCount,
  onScopeChange,
  onCaptureCurrentList,
  onOutputModeChange,
  outputName,
  outputNameError,
  onOutputNameChange,
  onIncludeXlsxChange,
  onGenerate,
  onCancel,
}: ExportScopeSettingsProps) {
  const titleId = `export-scope-settings-title-${useId().replace(/:/g, '')}`;
  const taskErrorText = cleanError(taskError);
  const summaryErrorText = cleanError(summary.error);
  const outputNameValue = outputName ?? '';
  // Keep the pre-name component contract usable for embedded callers that do
  // not yet control the optional filename field. The production App supplies
  // the value and callback, so its empty/invalid values remain blocked.
  const outputNameControlled = outputName !== undefined || onOutputNameChange !== undefined || outputNameError !== undefined;
  const outputNameErrorText = cleanError(outputNameControlled ? outputNameError ?? validateExportName(outputNameValue) : null);
  const selectedUnresolvedCount = displayCount(summary.selectedUnresolvedCount);
  const omittedUnresolvedCount = displayCount(summary.omittedUnresolvedCount);
  const selectedSegmentCount = displayCount(summary.selectedCount);
  const expectedPageCount = displayCount(summary.expectedPages);
  const mergedOutputCount = Math.max(0, selectedSegmentCount - expectedPageCount);
  const currentListItems = displayCount(currentListCount);
  const capturedListCount = scope.kind === 'list' ? scope.segmentIds.length : 0;
  const sourceSelection = scope.kind === 'sources' ? scope.sourceKeys : [];
  const sourceSelectionSet = new Set(sourceSelection);
  const generateDisabled = busy
    || Boolean(taskErrorText)
    || Boolean(summaryErrorText)
    || Boolean(outputNameErrorText)
    || selectedUnresolvedCount > 0
    || displayCount(summary.selectedCount) === 0;

  const handleScopeModeChange = (kind: 'all' | 'sources') => {
    if (busy) return;
    if (kind === 'all') {
      onScopeChange({ kind: 'all' });
      return;
    }
    onScopeChange({ kind: 'sources', sourceKeys: uniqueSourceKeys(sources) });
  };

  const handleSourceToggle = (sourceKey: string, checked: boolean) => {
    if (busy) return;
    const nextKeys = sourceSelection.filter((key) => key !== sourceKey);
    if (checked && !nextKeys.includes(sourceKey)) nextKeys.push(sourceKey);
    onScopeChange({ kind: 'sources', sourceKeys: nextKeys });
  };

  return (
    <div className="export-scope-settings-backdrop">
      <section
        className="export-scope-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
      >
        <header className="export-scope-settings-header">
          <div>
            <p className="export-scope-settings-eyebrow">导出预览</p>
            <h2 id={titleId}>导出设置</h2>
          </div>
          {busy && <span className="export-scope-settings-busy" role="status">正在准备预览…</span>}
        </header>

        <div className="export-scope-settings-content">
          {operationError && <div className="export-scope-settings-error" role="alert">{operationError}</div>}
          {taskErrorText && (
            <div className="export-scope-settings-error" role="alert">
              {taskErrorText}
            </div>
          )}
          {summaryErrorText && (
            <div className="export-scope-settings-error" role="alert">
              {summaryErrorText}
            </div>
          )}

          <section className="export-scope-settings-section" aria-labelledby={`${titleId}-scope-heading`}>
            <h3 id={`${titleId}-scope-heading`}>导出范围</h3>
            <fieldset className="export-scope-settings-fieldset">
              <legend>选择范围类型</legend>
              <div className="export-scope-settings-options">
                <label>
                  <input
                    type="radio"
                    name={`${titleId}-scope`}
                    checked={scope.kind === 'all'}
                    disabled={busy}
                    onChange={() => handleScopeModeChange('all')}
                  />
                  全部结果
                </label>
                <label>
                  <input
                    type="radio"
                    name={`${titleId}-scope`}
                    checked={scope.kind === 'sources'}
                    disabled={busy}
                    onChange={() => handleScopeModeChange('sources')}
                  />
                  选定来源 PDF
                </label>
              </div>
            </fieldset>

            {scope.kind === 'sources' && (
              <fieldset className="export-scope-settings-fieldset export-scope-settings-source-fieldset">
                <legend>选择来源</legend>
                <div className="export-scope-settings-source-list">
                  {sources.map((source) => (
                    <label className="export-scope-settings-source-option" key={source.key}>
                      <input
                        type="checkbox"
                        checked={sourceSelectionSet.has(source.key)}
                        disabled={busy}
                        onChange={(event) => handleSourceToggle(source.key, event.currentTarget.checked)}
                      />
                      <span className="export-scope-settings-source-copy">
                        <strong>{source.name || source.key}</strong>
                        <span>{displayCount(source.segmentCount)} 个片段</span>
                      </span>
                    </label>
                  ))}
                </div>
                {sourceSelection.length === 0 && (
                  <p className="export-scope-settings-empty-note" role="status">
                    尚未选择来源，当前导出范围为空。
                  </p>
                )}
              </fieldset>
            )}

            <div className="export-scope-settings-list-capture">
              <div>
                <strong>按当前审核列表导出</strong>
                <span>当前审核列表：{currentListItems} 项</span>
              </div>
              <button type="button" disabled={busy} onClick={onCaptureCurrentList}>
                将当前列表设为导出范围
              </button>
            </div>

            {scope.kind === 'list' && (
              <div className="export-scope-settings-captured-list" role="status">
                <div>
                  <strong>{scope.description || '当前审核列表'}</strong>
                  <span>已捕获 {capturedListCount} 项</span>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onScopeChange({ kind: 'all' })}
                >
                  恢复全部结果
                </button>
              </div>
            )}
          </section>

          <section className="export-scope-settings-section" aria-labelledby={`${titleId}-summary-heading`}>
            <h3 id={`${titleId}-summary-heading`}>范围预览</h3>
            <dl className="export-scope-settings-summary">
              <div><dt>总片段</dt><dd>{displayCount(summary.totalSegments)}</dd></div>
              <div><dt>选中来源</dt><dd>{displayCount(summary.selectedSourceKeys.length)}</dd></div>
              <div><dt>选中片段</dt><dd>{displayCount(summary.selectedCount)}</dd></div>
              <div><dt>未包含片段</dt><dd>{displayCount(summary.omittedCount)}</dd></div>
              <div><dt>选中未解决</dt><dd>{selectedUnresolvedCount}</dd></div>
              <div><dt>范围外未解决</dt><dd>{omittedUnresolvedCount}</dd></div>
              <div><dt>预计输出页数</dt><dd>{expectedPageCount}</dd></div>
            </dl>
            {omittedUnresolvedCount > 0 && (
              <p className="export-scope-settings-omitted-note" role="status">
                范围外还有 {omittedUnresolvedCount} 项未解决，这些片段不会被导出。
              </p>
            )}
            {selectedUnresolvedCount > 0 && (
              <p className="export-scope-settings-warning" role="alert">
                当前选中范围有 {selectedUnresolvedCount} 项未解决，完成审核后才能生成预览。
              </p>
            )}
            <p className="export-scope-settings-output-summary">
              {outputDescription(outputMode, summary.expectedPages, summary.selectedSourceKeys.length)}
            </p>
            <p className="export-scope-settings-dedup-note">
              {mergedOutputCount > 0 && `已合并 ${mergedOutputCount} 个重复输出项；`}
              同一文件、同一页、范围完全相同的回单只输出一次；
              审核记录和索引逐条保留。
            </p>
          </section>

          <section className="export-scope-settings-section" aria-labelledby={`${titleId}-output-heading`}>
            <h3 id={`${titleId}-output-heading`}>输出方式</h3>
            <label className="export-scope-settings-select-label" htmlFor={`${titleId}-output-mode`}>
              PDF 输出模式
            </label>
            <select
              id={`${titleId}-output-mode`}
              aria-label="PDF 输出模式"
              value={outputMode}
              disabled={busy}
              onChange={(event) => onOutputModeChange(event.currentTarget.value as ExportOutputMode)}
            >
              {OUTPUT_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <label className="export-scope-settings-select-label" htmlFor={`${titleId}-output-name`}>
              导出文件名
            </label>
            <input
              id={`${titleId}-output-name`}
              className="export-scope-settings-name-input"
              type="text"
              value={outputNameValue}
              maxLength={MAX_EXPORT_NAME_LENGTH + 4}
              disabled={busy}
              aria-label="导出文件名"
              aria-invalid={outputNameErrorText ? 'true' : undefined}
              aria-describedby={outputNameErrorText ? `${titleId}-output-name-error` : `${titleId}-output-name-hint`}
              onChange={(event) => onOutputNameChange?.(event.currentTarget.value)}
            />
            <p id={`${titleId}-output-name-hint`} className="export-scope-settings-name-hint">
              合并版会生成“文件名.pdf”；按来源导出会在后面加上来源编号和名称。可输入 .pdf，系统只保留一个扩展名。
            </p>
            {outputNameErrorText && (
              <p id={`${titleId}-output-name-error`} className="export-scope-settings-name-error" role="alert">
                {outputNameErrorText}
              </p>
            )}
            <label className="export-scope-settings-checkbox">
              <input
                type="checkbox"
                checked={includeXlsx}
                disabled={busy}
                onChange={(event) => onIncludeXlsxChange(event.currentTarget.checked)}
              />
              同时导出审核索引 XLSX
            </label>
          </section>
        </div>

        <footer className="export-scope-settings-actions">
          <button type="button" disabled={busy} onClick={onCancel}>返回审核</button>
          <button
            type="button"
            className="export-scope-settings-primary"
            disabled={generateDisabled}
            onClick={onGenerate}
          >
            确认范围并生成预览
          </button>
        </footer>
      </section>
    </div>
  );
}

export default ExportScopeSettings;
