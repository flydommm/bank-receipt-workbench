import { useEffect, useState, type ReactNode } from 'react';
import {
  formatBatchSourceStatus,
  formatBatchSummary,
  type BatchFeedback,
} from '../domain/batchFeedback';

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
  onOpenHistory?: () => void;
  onOpenCurrentTask?: () => void;
  onNewTask?: () => void;
  newTaskDisabled?: boolean;
};

function sourceStatus(file: SourcePanelFile): string {
  if (file.integrityStatus === 'changed') return '源文件已变化，请重新分析';
  if (file.pageCount === null) return '页数待分析';
  return `${file.pageCount} 页 · 文档已读取`;
}

function Notice({ notice }: { notice: SourcePanelNotice }): ReactNode {
  if (!notice) return null;
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
  onOpenHistory,
  onOpenCurrentTask,
  onNewTask,
  newTaskDisabled,
}: SourcePanelProps) {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const selectedCount = selectedPaths.size;

  useEffect(() => {
    const available = new Set(files.map((file) => file.sourcePath));
    setSelectedPaths((current) => {
      const next = new Set([...current].filter((sourcePath) => available.has(sourcePath)));
      return next.size === current.size ? current : next;
    });
  }, [files]);

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

  return (
    <aside className="source-panel panel" aria-label="当前文件">
      <header className="source-panel-header">
        <div>
          <span className="section-kicker">SOURCE FILES</span>
          <h2>当前文件</h2>
        </div>
        <div className="source-panel-task-actions">
          {onNewTask && <button className="ghost-button" type="button" disabled={newTaskDisabled ?? disabled} onClick={onNewTask}>＋ 新建任务</button>}
          {onOpenCurrentTask && <button className="text-button" type="button" onClick={onOpenCurrentTask}>当前任务</button>}
          {onOpenHistory && <button className="text-button" type="button" onClick={onOpenHistory}>历史任务</button>}
        </div>
      </header>

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

      <p className="source-panel-scope">仅从当前任务移除，不删除原文件</p>
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
            {files.map((file) => {
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
                      title={file.sourcePath}
                      aria-current={active ? 'true' : undefined}
                      disabled={disabled}
                      onClick={() => onSelectSource(file.sourcePath)}
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
