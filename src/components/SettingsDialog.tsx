import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';

import type { AppSettingsV1 } from '../domain/appSettings';

const PREVIEW_ZOOM_OPTIONS: readonly AppSettingsV1['defaultPreviewZoom'][] = [
  50,
  75,
  100,
  125,
  150,
];

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export type SettingsDialogProps = {
  open: boolean;
  settings: AppSettingsV1;
  storageWarning?: string | null;
  onChange: (settings: AppSettingsV1) => void;
  onReset: () => void;
  onResetColumns: () => void;
  onClose: () => void;
  onChooseInputDirectory: (directory: string) => void;
  onChooseOutputDirectory: (directory: string) => void;
  onInputDirectoryCommit?: (directory: string) => void;
  onOutputDirectoryCommit?: (directory: string) => void;
  inputDirectoryDraftResetToken?: number;
  outputDirectoryDraftResetToken?: number;
  directoryPickerBusy: boolean;
  directoryPickerError?: string | null;
};

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => (
      element.getAttribute('aria-hidden') !== 'true'
      && element.closest('[hidden]') === null
    ));
}

export function SettingsDialog({
  open,
  settings,
  storageWarning = null,
  onChange,
  onReset,
  onResetColumns,
  onClose,
  onChooseInputDirectory,
  onChooseOutputDirectory,
  onInputDirectoryCommit = () => undefined,
  onOutputDirectoryCommit = () => undefined,
  inputDirectoryDraftResetToken = 0,
  outputDirectoryDraftResetToken = 0,
  directoryPickerBusy,
  directoryPickerError = null,
}: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const previousOpenRef = useRef(false);
  const [inputDirectoryDraft, setInputDirectoryDraft] = useState(
    () => settings.lastInputDirectory ?? '',
  );
  const [outputDirectoryDraft, setOutputDirectoryDraft] = useState(
    () => settings.lastOutputDirectory ?? '',
  );
  const lastInputDirectoryCommitRef = useRef<string | null>(null);
  const lastOutputDirectoryCommitRef = useRef<string | null>(null);

  useEffect(() => {
    setInputDirectoryDraft(settings.lastInputDirectory ?? '');
  }, [settings.lastInputDirectory]);

  useEffect(() => {
    setOutputDirectoryDraft(settings.lastOutputDirectory ?? '');
  }, [settings.lastOutputDirectory]);

  useLayoutEffect(() => {
    setInputDirectoryDraft(settings.lastInputDirectory ?? '');
    lastInputDirectoryCommitRef.current = null;
  }, [inputDirectoryDraftResetToken]);

  useLayoutEffect(() => {
    setOutputDirectoryDraft(settings.lastOutputDirectory ?? '');
    lastOutputDirectoryCommitRef.current = null;
  }, [outputDirectoryDraftResetToken]);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      const dialog = dialogRef.current;
      if (dialog !== null) {
        const firstFocusable = initialFocusRef.current ?? getFocusableElements(dialog)[0];
        (firstFocusable ?? dialog).focus();
      }
    }
    previousOpenRef.current = open;
  }, [open]);

  if (!open) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (dialog === null) return;

    const focusableElements = getFocusableElements(dialog);
    if (focusableElements.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement;
    const activeIndex = activeElement instanceof HTMLElement
      ? focusableElements.indexOf(activeElement)
      : -1;

    if (activeIndex < 0) {
      event.preventDefault();
      (event.shiftKey ? lastFocusable : firstFocusable).focus();
      return;
    }

    if (event.shiftKey) {
      if (activeIndex === 0) {
        event.preventDefault();
        lastFocusable.focus();
      }
      return;
    }

    if (activeIndex === focusableElements.length - 1) {
      event.preventDefault();
      firstFocusable.focus();
    }
  }

  function changeMatchMode(event: ChangeEvent<HTMLInputElement>) {
    if (!event.currentTarget.checked) return;
    onChange({
      ...settings,
      defaultMatchMode: event.currentTarget.value as AppSettingsV1['defaultMatchMode'],
    });
  }

  function changeIncludeMode(event: ChangeEvent<HTMLInputElement>) {
    if (!event.currentTarget.checked) return;
    onChange({
      ...settings,
      defaultIncludeMode: event.currentTarget.value as AppSettingsV1['defaultIncludeMode'],
    });
  }

  function changeIncludeXlsx(event: ChangeEvent<HTMLInputElement>) {
    onChange({
      ...settings,
      defaultIncludeXlsx: event.currentTarget.checked,
    });
  }

  function changePreviewZoom(event: ChangeEvent<HTMLSelectElement>) {
    const nextZoom = Number(event.currentTarget.value) as AppSettingsV1['defaultPreviewZoom'];
    if (!PREVIEW_ZOOM_OPTIONS.includes(nextZoom)) return;
    onChange({
      ...settings,
      defaultPreviewZoom: nextZoom,
    });
  }

  function changeKeyboardHints(event: ChangeEvent<HTMLInputElement>) {
    onChange({
      ...settings,
      showKeyboardHints: event.currentTarget.checked,
    });
  }

  function commitInputDirectory(value: string) {
    if (lastInputDirectoryCommitRef.current === value) return;
    lastInputDirectoryCommitRef.current = value;
    onInputDirectoryCommit(value);
  }

  function commitOutputDirectory(value: string) {
    if (lastOutputDirectoryCommitRef.current === value) return;
    lastOutputDirectoryCommitRef.current = value;
    onOutputDirectoryCommit(value);
  }

  function handleInputDirectoryKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitInputDirectory(event.currentTarget.value);
  }

  function handleOutputDirectoryKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitOutputDirectory(event.currentTarget.value);
  }

  return (
    <div className="settings-dialog-backdrop">
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="settings-dialog-header">
          <div>
            <p className="section-kicker">应用配置</p>
            <h2 id="settings-dialog-title">设置</h2>
          </div>
          <button
            ref={initialFocusRef}
            type="button"
            className="settings-dialog-close"
            aria-label="关闭设置"
            onClick={onClose}
          >
            关闭设置
          </button>
        </header>

        <div className="settings-dialog-content">
          {storageWarning ? (
            <p className="settings-dialog-warning" role="status">
              {storageWarning}
            </p>
          ) : null}

          <section className="settings-dialog-section" aria-labelledby="settings-search-defaults">
            <h3 id="settings-search-defaults">搜索默认值</h3>
            <fieldset className="settings-dialog-fieldset">
              <legend className="settings-dialog-match-legend">匹配精度</legend>
              <div className="settings-dialog-options">
                <label>
                  <input
                    type="radio"
                    name="settings-default-match-mode"
                    value="exact"
                    checked={settings.defaultMatchMode === 'exact'}
                    onChange={changeMatchMode}
                  />
                  <span>精确匹配</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="settings-default-match-mode"
                    value="fuzzy"
                    checked={settings.defaultMatchMode === 'fuzzy'}
                    onChange={changeMatchMode}
                  />
                  <span>模糊匹配</span>
                </label>
              </div>
            </fieldset>

            <fieldset className="settings-dialog-fieldset">
              <legend>包含关键词关系</legend>
              <div className="settings-dialog-options">
                <label>
                  <input
                    type="radio"
                    name="settings-default-include-mode"
                    value="all"
                    checked={settings.defaultIncludeMode === 'all'}
                    onChange={changeIncludeMode}
                  />
                  <span>全部满足</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="settings-default-include-mode"
                    value="any"
                    checked={settings.defaultIncludeMode === 'any'}
                    onChange={changeIncludeMode}
                  />
                  <span>任一满足</span>
                </label>
              </div>
            </fieldset>
          </section>

          <section className="settings-dialog-section" aria-labelledby="settings-export-defaults">
            <h3 id="settings-export-defaults">导出默认值</h3>
            <label className="settings-dialog-checkbox">
              <input
                type="checkbox"
                checked={settings.defaultIncludeXlsx}
                onChange={changeIncludeXlsx}
              />
              <span>同时导出审核索引 XLSX</span>
            </label>
            <p className="settings-dialog-help">进入导出预览时使用此默认值，仍可按任务单独调整。</p>
          </section>

          <section className="settings-dialog-section" aria-labelledby="settings-preview-defaults">
            <h3 id="settings-preview-defaults">预览默认值</h3>
            <label className="settings-dialog-select-label" htmlFor="settings-preview-zoom">
              PDF 预览缩放
            </label>
            <select
              id="settings-preview-zoom"
              aria-label="PDF 预览缩放"
              value={String(settings.defaultPreviewZoom)}
              onChange={changePreviewZoom}
            >
              {PREVIEW_ZOOM_OPTIONS.map((zoom) => (
                <option key={zoom} value={zoom}>
                  {zoom}%
                </option>
              ))}
            </select>
          </section>

          <section className="settings-dialog-section" aria-labelledby="settings-directories">
            <h3 id="settings-directories">文件夹</h3>
            <p className="settings-dialog-help">可选择并作为下次选择器起始位置。</p>
            {directoryPickerError ? (
              <p className="settings-dialog-error" role="alert">
                {directoryPickerError}
              </p>
            ) : null}
            {directoryPickerBusy ? (
              <p className="settings-dialog-help" role="status" aria-label="目录选择状态" aria-live="polite">
                正在选择目录…
              </p>
            ) : null}
            <dl className="settings-dialog-directories">
              <div>
                <dt>输入目录</dt>
                <dd>
                  <div className="settings-dialog-directory-control">
                    <input
                      id="settings-input-directory"
                      type="text"
                      className="settings-dialog-directory-input"
                      aria-label="输入目录"
                      placeholder="请选择或输入输入目录"
                      value={inputDirectoryDraft}
                      disabled={directoryPickerBusy}
                      onChange={(event) => {
                        lastInputDirectoryCommitRef.current = null;
                        setInputDirectoryDraft(event.currentTarget.value);
                      }}
                      onBlur={(event) => commitInputDirectory(event.currentTarget.value)}
                      onKeyDown={handleInputDirectoryKeyDown}
                    />
                    <button
                      type="button"
                      className="ghost-button settings-dialog-directory-browse"
                      aria-label="浏览输入目录"
                      disabled={directoryPickerBusy}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onChooseInputDirectory(inputDirectoryDraft)}
                    >
                      浏览…
                    </button>
                  </div>
                </dd>
              </div>
              <div>
                <dt>输出目录</dt>
                <dd>
                  <div className="settings-dialog-directory-control">
                    <input
                      id="settings-output-directory"
                      type="text"
                      className="settings-dialog-directory-input"
                      aria-label="输出目录"
                      placeholder="请选择或输入输出目录"
                      value={outputDirectoryDraft}
                      disabled={directoryPickerBusy}
                      onChange={(event) => {
                        lastOutputDirectoryCommitRef.current = null;
                        setOutputDirectoryDraft(event.currentTarget.value);
                      }}
                      onBlur={(event) => commitOutputDirectory(event.currentTarget.value)}
                      onKeyDown={handleOutputDirectoryKeyDown}
                    />
                    <button
                      type="button"
                      className="ghost-button settings-dialog-directory-browse"
                      aria-label="浏览输出目录"
                      disabled={directoryPickerBusy}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onChooseOutputDirectory(outputDirectoryDraft)}
                    >
                      浏览…
                    </button>
                  </div>
                </dd>
              </div>
            </dl>
          </section>

          <section className="settings-dialog-section" aria-labelledby="settings-keyboard-layout">
            <h3 id="settings-keyboard-layout">快捷键与布局</h3>
            <label className="settings-dialog-checkbox">
              <input
                type="checkbox"
                checked={settings.showKeyboardHints}
                onChange={changeKeyboardHints}
              />
              <span>显示命中列表快捷键说明</span>
            </label>
            {settings.showKeyboardHints ? (
              <p className="settings-dialog-help settings-dialog-shortcut-help">
                焦点在命中片段上时，可用 <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 切换，
                <kbd>Home</kbd>/<kbd>End</kbd> 跳到首尾。
              </p>
            ) : null}
            <button type="button" className="ghost-button" onClick={onResetColumns}>
              恢复三栏默认宽度
            </button>
          </section>
        </div>

        <footer className="settings-dialog-actions">
          <button type="button" className="ghost-button" onClick={onReset}>
            恢复默认设置
          </button>
          <button type="button" className="primary-button" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}

export default SettingsDialog;
