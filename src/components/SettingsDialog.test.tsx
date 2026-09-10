// @vitest-environment jsdom

import userEvent from '@testing-library/user-event';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_APP_SETTINGS,
  type AppSettingsV1,
} from '../domain/appSettings';
import SettingsDialog from './SettingsDialog';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof SettingsDialog>> = {},
) {
  const onChange = vi.fn<(next: AppSettingsV1) => void>();
  const onReset = vi.fn<() => void>();
  const onResetColumns = vi.fn<() => void>();
  const onClose = vi.fn<() => void>();
  const onChooseInputDirectory = vi.fn<(directory: string) => void>();
  const onChooseOutputDirectory = vi.fn<(directory: string) => void>();
  const onInputDirectoryCommit = vi.fn<(directory: string) => void>();
  const onOutputDirectoryCommit = vi.fn<(directory: string) => void>();
  const props: React.ComponentProps<typeof SettingsDialog> = {
    open: true,
    settings: DEFAULT_APP_SETTINGS,
    storageWarning: null,
    onChange,
    onReset,
    onResetColumns,
    onClose,
    onChooseInputDirectory,
    onChooseOutputDirectory,
    onInputDirectoryCommit,
    onOutputDirectoryCommit,
    directoryPickerBusy: false,
    directoryPickerError: null,
    ...overrides,
  };

  const view = render(<SettingsDialog {...props} />);
  return {
    ...props,
    onChange,
    onReset,
    onResetColumns,
    onClose,
    onChooseInputDirectory,
    onChooseOutputDirectory,
    onInputDirectoryCommit,
    onOutputDirectoryCommit,
    view,
  };
}

describe('SettingsDialog', () => {
  it('does not render a dialog while closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('exposes modal semantics, a labelled title, and an initial focus target', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: '设置' });
    const title = screen.getByRole('heading', { name: '设置' });
    const close = screen.getByRole('button', { name: '关闭设置' });

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(title.id).toBe('settings-dialog-title');
    expect(document.activeElement).toBe(close);
  });

  it('updates every controlled default immediately', async () => {
    const user = userEvent.setup();
    const { onChange } = renderDialog();

    await user.click(screen.getByRole('radio', { name: '模糊匹配' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_APP_SETTINGS,
      defaultMatchMode: 'fuzzy',
    });

    await user.click(screen.getByRole('radio', { name: '任一满足' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_APP_SETTINGS,
      defaultIncludeMode: 'any',
    });

    await user.click(screen.getByRole('checkbox', { name: '同时导出审核索引 XLSX' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_APP_SETTINGS,
      defaultIncludeXlsx: true,
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'PDF 预览缩放' }), '125');
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_APP_SETTINGS,
      defaultPreviewZoom: 125,
    });

    await user.click(screen.getByRole('checkbox', { name: '显示命中列表快捷键说明' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_APP_SETTINGS,
      showKeyboardHints: false,
    });
  });

  it('only renders keyboard shortcut help when hints are enabled', () => {
    const { view, ...props } = renderDialog();

    expect(document.querySelector('.settings-dialog-shortcut-help')).not.toBeNull();

    view.rerender(
      <SettingsDialog
        {...props}
        settings={{ ...DEFAULT_APP_SETTINGS, showKeyboardHints: false }}
      />,
    );

    expect(screen.getByRole('checkbox', { name: '显示命中列表快捷键说明' })).toBeTruthy();
    expect(document.querySelector('.settings-dialog-shortcut-help')).toBeNull();
  });

  it('shows non-blocking storage warnings and editable remembered directories', () => {
    renderDialog({
      storageWarning: '设置存储暂不可用。',
      settings: {
        ...DEFAULT_APP_SETTINGS,
        lastInputDirectory: 'D:\\资料\\输入',
        lastOutputDirectory: 'D:\\资料\\输出',
      },
    });

    expect(screen.getByRole('status').textContent).toBe('设置存储暂不可用。');
    expect((screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement).value).toBe('D:\\资料\\输入');
    expect((screen.getByRole('textbox', { name: '输出目录' }) as HTMLInputElement).value).toBe('D:\\资料\\输出');
    expect(screen.queryByText('未设置')).toBeNull();
    expect(screen.queryByRole('button', { name: '恢复默认设置' })).toBeTruthy();
  });

  it('shows directory labels and placeholders when no directory is remembered', () => {
    renderDialog();

    expect(screen.getByText('输入目录')).toBeTruthy();
    expect(screen.getByText('输出目录')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('textbox', { name: '输出目录' }) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('textbox', { name: '输入目录' }).getAttribute('placeholder')).toBe('请选择或输入输入目录');
    expect(screen.getByRole('textbox', { name: '输出目录' }).getAttribute('placeholder')).toBe('请选择或输入输出目录');
    expect(screen.queryByText('未设置')).toBeNull();
  });

  it('commits edited directories on Enter and blur', async () => {
    const user = userEvent.setup();
    const { onInputDirectoryCommit, onOutputDirectoryCommit } = renderDialog();
    const inputDirectory = screen.getByRole('textbox', { name: '输入目录' });
    const outputDirectory = screen.getByRole('textbox', { name: '输出目录' });

    await user.type(inputDirectory, 'D:\\资料\\输入');
    await user.keyboard('{Enter}');
    fireEvent.blur(inputDirectory);
    expect(onInputDirectoryCommit).toHaveBeenCalledOnce();
    expect(onInputDirectoryCommit).toHaveBeenLastCalledWith('D:\\资料\\输入');

    await user.type(outputDirectory, 'D:\\资料\\输出');
    fireEvent.blur(outputDirectory);
    expect(onOutputDirectoryCommit).toHaveBeenCalledOnce();
    expect(onOutputDirectoryCommit).toHaveBeenLastCalledWith('D:\\资料\\输出');
  });

  it('shows directory choices and invokes the matching callbacks', async () => {
    const user = userEvent.setup();
    const { onChooseInputDirectory, onChooseOutputDirectory } = renderDialog();

    expect(screen.getByText('可选择并作为下次选择器起始位置。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '浏览输入目录' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '浏览输出目录' })).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: '输入目录' }), 'D:\\资料\\输入草稿');
    await user.type(screen.getByRole('textbox', { name: '输出目录' }), 'D:\\资料\\输出草稿');
    await user.click(screen.getByRole('button', { name: '浏览输入目录' }));
    await user.click(screen.getByRole('button', { name: '浏览输出目录' }));

    expect(onChooseInputDirectory).toHaveBeenCalledOnce();
    expect(onChooseOutputDirectory).toHaveBeenCalledOnce();
    expect(onChooseInputDirectory).toHaveBeenLastCalledWith('D:\\资料\\输入草稿');
    expect(onChooseOutputDirectory).toHaveBeenLastCalledWith('D:\\资料\\输出草稿');
  });

  it('does not commit an edited directory when browsing from the input', async () => {
    const user = userEvent.setup();
    const { onInputDirectoryCommit, onChooseInputDirectory } = renderDialog();
    const inputDirectory = screen.getByRole('textbox', { name: '输入目录' });

    await user.type(inputDirectory, 'D:\\资料\\待选择');
    await user.click(screen.getByRole('button', { name: '浏览输入目录' }));

    expect(onInputDirectoryCommit).not.toHaveBeenCalled();
    expect(onChooseInputDirectory).toHaveBeenLastCalledWith('D:\\资料\\待选择');
  });

  it('disables both directory choices and reports selection progress while busy', () => {
    renderDialog({ directoryPickerBusy: true });

    expect((screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('textbox', { name: '输出目录' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '浏览输入目录' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '浏览输出目录' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status', { name: '目录选择状态' }).textContent).toBe('正在选择目录…');
  });

  it('exposes directory picker errors without replacing remembered directories', () => {
    renderDialog({
      settings: {
        ...DEFAULT_APP_SETTINGS,
        lastInputDirectory: 'D:\\资料\\输入',
        lastOutputDirectory: 'D:\\资料\\输出',
      },
      directoryPickerError: '选择目录失败，请重试。',
    });

    const error = screen.getByRole('alert');
    expect(error.textContent).toBe('选择目录失败，请重试。');
    expect(error.classList.contains('settings-dialog-error')).toBe(true);
    expect((screen.getByRole('textbox', { name: '输入目录' }) as HTMLInputElement).value).toBe('D:\\资料\\输入');
    expect((screen.getByRole('textbox', { name: '输出目录' }) as HTMLInputElement).value).toBe('D:\\资料\\输出');
  });

  it('calls reset, column reset, close, and Escape callbacks', async () => {
    const user = userEvent.setup();
    const { onReset, onResetColumns, onClose } = renderDialog();

    await user.click(screen.getByRole('button', { name: '恢复三栏默认宽度' }));
    expect(onResetColumns).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: '恢复默认设置' }));
    expect(onReset).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: '关闭设置' }));
    expect(onClose).toHaveBeenCalledOnce();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps Tab focus within the dialog and leaves direction keys to controls', () => {
    const { onClose } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: '设置' });
    const first = screen.getByRole('button', { name: '关闭设置' });
    const last = screen.getByRole('button', { name: '关闭' });

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    expect(onClose).not.toHaveBeenCalled();

    dialog.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
