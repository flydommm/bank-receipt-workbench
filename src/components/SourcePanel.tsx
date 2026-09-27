import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  formatBatchSourceStatus,
  formatBatchSummary,
  type BatchFeedback,
} from '../domain/batchFeedback';
import './SourcePanel.css';

export type SourcePanelFile = {
  key: string;
  name: string;
  sourcePath: string;
  size: number;
  pageCount: number | null;
  integrityStatus: 'valid' | 'changed' | null;
};

export type SourcePanelNotice =
  | { kind: 'status' | 'error'; message: string }
  | null;

export type SourcePanelProps = {
  files: SourcePanelFile[];
  activeSourcePath: string | null;
  notice: SourcePanelNotice;
  disabled: boolean;
  onPickFiles: () => void;
  onPickFolder: () => void;
  onAddFiles: () => void;
  onAddFolder: () => void;
  onSelectSource: (sourcePath: string) => void;
  onRemoveAll: () => void;
  onRemoveSelected: (sourcePaths: string[]) => void;
  onRemoveSource: (sourcePath: string) => void;
  batchFeedback?: BatchFeedback | null;
  workflowStep?: 1 | 2 | 3;
  taskStateLabel?: string;
  onNewTask?: () => void;
  newTaskDisabled?: boolean;
};

function sourceStatus(file: SourcePanelFile): string {
  if (file.integrityStatus === 'changed') return '源文件已变化，请重新分析';
  if (file.pageCount === null) return '页数待分析';
  return `${file.pageCount} 页 · 文档已读取`;
}

function shouldShowNotice(notice: SourcePanelNotice): boolean {
  if (!notice) return false;
  if (notice.kind === 'error') return true;
  // Keep unexpected engine and picker feedback visible. Only the routine
  // source-count/reset confirmations are already conveyed by the file list.
  return !(
    /^当前共 \d+ 份 PDF(?:，已跳过 \d+ 个重复路径)?。$/.test(notice.message)
    || /^已选择 \d+ 个 PDF，任务状态为“待处理”。$/.test(notice.message)
    || /^已从当前任务移除 \d+ 个文件；原始文件未被删除或修改。$/.test(notice.message)
    || notice.message === '已创建空白审核任务，请选择 PDF 或文件夹。'
    || notice.message === '已移除本次来源；原始 PDF 和已保存模板保留。'
    || notice.message === '已取消选择，当前任务保持不变。'
  );
}

function taskStatus(files: SourcePanelFile[], batchFeedback: BatchFeedback | null, workflowStep: 1 | 2 | 3): string {
  if (files.length === 0) return '未添加';
  if (batchFeedback?.phase === 'running') return '分析中';
  if (batchFeedback?.phase === 'failed') return '分析未完成';
  if (workflowStep === 3) return '可导出';
  if (workflowStep === 2 || batchFeedback?.phase === 'succeeded') return '待检查';
  return '待分析';
}

function Notice({ notice }: { notice: SourcePanelNotice }) {
  if (!notice || !shouldShowNotice(notice)) return null;
  return (
    <div
      className={`source-panel-notice source-panel-notice-${notice.kind}`}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      {notice.message}
    </div>
  );
}

export function SourcePanel({
  files,
  activeSourcePath,
  notice,
  disabled,
  onPickFiles,
  onPickFolder,
  onAddFiles,
  onAddFolder,
  onSelectSource,
  onRemoveAll,
  onRemoveSelected,
  onRemoveSource,
  batchFeedback = null,
  workflowStep = 1,
  taskStateLabel,
  onNewTask,
  newTaskDisabled,
}: SourcePanelProps) {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const sourceButtonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedCount = selectedPaths.size;

  useEffect(() => {
    const available = new Set(files.map((file) => file.sourcePath));
    // Avoid scheduling a no-op state update while the parent refreshes the file list.
    if (![...selectedPaths].some((sourcePath) => !available.has(sourcePath))) return;
    const next = new Set([...selectedPaths].filter((sourcePath) => available.has(sourcePath)));
    setSelectedPaths(next);
  }, [files, selectedPaths]);

  function toggleSelected(sourcePath: string): void {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(sourcePath)) next.delete(sourcePath);
      else next.add(sourcePath);
      return next;
    });
  }

  function removeSelected(): void {
    if (selectedPaths.size === 0) return;
    onRemoveSelected([...selectedPaths]);
    setSelectedPaths(new Set());
  }

  function removeOne(sourcePath: string): void {
    onRemoveSource(sourcePath);
    setSelectedPaths((current) => {
      if (!current.has(sourcePath)) return current;
      const next = new Set(current);
      next.delete(sourcePath);
      return next;
    });
  }

  function handleSourceKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        nextIndex = Math.min(index + 1, files.length - 1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        nextIndex = Math.max(index - 1, 0);
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = files.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (nextIndex === index) return;
    sourceButtonsRef.current[nextIndex]?.focus();
    onSelectSource(files[nextIndex].sourcePath);
  }

  return (
    <aside className="source-panel panel" aria-label="当前文件">
      <header className="source-panel-header">
        <h2>文件操作</h2>
        <div className="source-panel-header-meta">
          <div className="source-panel-task-actions">
            {onNewTask && <button className="text-button" type="button" disabled={newTaskDisabled ?? disabled} onClick={onNewTask}>重置任务</button>}
          </div>
          <span role="status" className="source-panel-file-count">
            {files.length} 份 PDF · {files.length ? taskStateLabel ?? taskStatus(files, batchFeedback, workflowStep) : '未添加'}
          </span>
        </div>
      </header>

      <section className="source-panel-file-actions" aria-label="文件操作">
        <div className="source-panel-actions" aria-label="来源文件操作">
          <button className="ghost-button" type="button" onClick={onPickFiles} disabled={disabled}>
            选择 PDF
          </button>
          <button className="ghost-button" type="button" onClick={onPickFolder} disabled={disabled}>
            选择文件夹
          </button>
          <button className="ghost-button" type="button" onClick={onAddFiles} disabled={disabled}>
            添加 PDF
          </button>
          <button className="ghost-button" type="button" onClick={onAddFolder} disabled={disabled}>
            添加文件夹
          </button>
          <button className="text-button source-panel-remove" type="button" onClick={onRemoveAll} disabled={disabled}>
            移除全部文件
          </button>
          <button className="text-button source-panel-remove" type="button" onClick={removeSelected} disabled={disabled || selectedCount === 0}>
            移除选中{selectedCount > 0 ? `（${selectedCount}）` : ''}
          </button>
        </div>
      </section>

      <Notice notice={notice} />
      {batchFeedback && (
        <section className="batch-feedback" aria-label="本轮分析">
          <strong>本轮分析</strong>
          <p role="status">{formatBatchSummary(batchFeedback)}</p>
        </section>
      )}

      <div className="source-list-scroll">
        {files.length > 0 ? (
          <ul className="source-list" aria-label="当前来源文件">
            {files.map((file, index) => {
              const active = file.sourcePath === activeSourcePath;
              const batchSource = batchFeedback?.sources.find((source) => source.sourcePath === file.sourcePath);
              return (
                <li key={file.key}>
                  <div className={`source-row-wrap${active ? ' is-active' : ''}`}>
                    <input
                      type="checkbox"
                      className="source-row-checkbox"
                      aria-label={`选择 ${file.name}`}
                      checked={selectedPaths.has(file.sourcePath)}
                      disabled={disabled}
                      onChange={() => toggleSelected(file.sourcePath)}
                    />
                    <button
                      type="button"
                      className="source-row"
                      ref={(node) => { sourceButtonsRef.current[index] = node; }}
                      title={file.sourcePath}
                      aria-current={active ? 'true' : undefined}
                      disabled={disabled}
                      onClick={() => onSelectSource(file.sourcePath)}
                      onKeyDown={(event) => handleSourceKeyDown(event, index)}
                    >
                      <strong className="source-row-name">{file.name}</strong>
                      <span className="source-row-status">{sourceStatus(file)}</span>
                      {batchFeedback && batchSource && (
                        <span className="source-row-analysis">
                          {formatBatchSourceStatus(batchFeedback, batchSource)}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="source-row-remove"
                      aria-label={`移除 ${file.name}`}
                      disabled={disabled}
                      onClick={() => removeOne(file.sourcePath)}
                    >
                      移除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <span className="empty-source">尚未选择文件</span>
        )}
      </div>

      <footer className="source-panel-footer">
        <span className="status-dot" aria-hidden="true" />
        原始文件只读保护已开启
      </footer>
    </aside>
  );
}

export default SourcePanel;
