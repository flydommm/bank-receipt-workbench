// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReceiptExportWorkspace } from './ReceiptExportWorkspace';
import { ExportBundleClient } from '../services/exportBundleClient';
import { localEngineAdapter } from './localEngineAdapter';
import { syntheticSnapshot } from '../domain/receiptGrouping.testFixtures';
import { RECEIPT_EXPORT_PREFERENCES_STORAGE_KEY } from '../domain/receiptExportPreferences';

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const bundle = { intent_id: 'intent', files: [], total_pages: 1 } as any;
  const create = vi.spyOn(ExportBundleClient.prototype, 'create').mockResolvedValue(bundle);
  const close = vi.spyOn(ExportBundleClient.prototype, 'close').mockResolvedValue();
  const publish = vi.spyOn(ExportBundleClient.prototype, 'publish').mockResolvedValue({ directory: '/output/结果', files: [{}], total_pages: 1 } as any);
  const pick = vi.spyOn(localEngineAdapter, 'pickOutputFolder').mockResolvedValue('/output');
  const renderPage = vi.spyOn(localEngineAdapter, 'renderPage');
  const prepared = { binding: { contextKey: 'context', job: { id: 'job', sources: [{ name: '示例银行_202601.pdf' }],
    processing_options: { processing_mode: 'split_all' }, criteria: null } }, prepared: { result_revision: 'rev' } } as any;
  const items = [{ original: { id: 'auto', needs_review: false }, record: null, record_revision: 0 }] as any;
  const onClose = vi.fn(), onRemoveSources = vi.fn(), onExportSuccess = vi.fn();
  const props = { prepared, items, onClose, onRemoveSources, onExportSuccess, initialOutputDirectory: '/configured/output' };
  const view = render(<ReceiptExportWorkspace {...props} />);
  return { bundle, create, close, publish, pick, renderPage, prepared, items, props, view, onClose, onRemoveSources, onExportSuccess };
}
const start = () => fireEvent.click(screen.getByRole('button', { name: '选择目录并导出' }));

describe('ReceiptExportWorkspace direct export', () => {
  it('requires an explicit pending destination and always includes the grouped check sheet', async () => {
    const test = setup();
    const grouping = syntheticSnapshot();
    grouping.header.counts.counterparty_pending = 1;
    grouping.header.counts.assigned = 0;
    test.view.rerender(<ReceiptExportWorkspace {...test.props} grouping={grouping} />);
    expect(screen.getByRole('button', { name: '返回交易对手核对' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '返回检查' })).toBeNull();
    expect((screen.getByLabelText('导出方式') as HTMLSelectElement).value).toBe('by_counterparty');
    expect((screen.getByLabelText('导出方式') as HTMLSelectElement).options[0]?.textContent).toBe('合并为一个PDF');
    expect((screen.getByLabelText('导出方式') as HTMLSelectElement).options[1]?.textContent).toBe('每组一个 PDF');
    expect(screen.getByRole('button', { name: '选择目录并导出' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: /另存为 PDF/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /另存为 PDF/ }));
    start();
    await screen.findByText('已生成 1 个文件，共 1 页。');
    expect(test.create).toHaveBeenCalledWith(expect.objectContaining({ output_mode: 'by_counterparty', include_xlsx: true,
      include_counterparty_pending: true, expected_grouping_revision: grouping.header.grouping_revision,
      expected_review_fingerprint: grouping.header.review_fingerprint, own_account_fingerprint: grouping.header.own_account.fingerprint }));
  });
  it('remembers the last export method independently for regular and grouped workspaces', () => {
    const test = setup();
    fireEvent.change(screen.getByLabelText('导出方式'), { target: { value: 'both' } });
    test.view.unmount();

    const regularAgain = render(<ReceiptExportWorkspace {...test.props} />);
    expect((screen.getByLabelText('导出方式') as HTMLSelectElement).value).toBe('both');
    regularAgain.unmount();

    const grouping = syntheticSnapshot();
    const grouped = render(<ReceiptExportWorkspace {...test.props} grouping={grouping} />);
    expect((screen.getByLabelText('导出方式') as HTMLSelectElement).value).toBe('by_counterparty');
    fireEvent.change(screen.getByLabelText('导出方式'), { target: { value: 'by_counterparty_merged' } });
    grouped.unmount();

    render(<ReceiptExportWorkspace {...test.props} grouping={grouping} />);
    expect((screen.getByLabelText('导出方式') as HTMLSelectElement).value).toBe('by_counterparty_merged');
  });
  it('switches grouped modes, refreshes the intent, and changes the pending hint', async () => {
    const test = setup();
    const grouping = syntheticSnapshot();
    grouping.header.counts.counterparty_pending = 1;
    grouping.header.counts.assigned = 0;
    test.view.rerender(<ReceiptExportWorkspace {...test.props} grouping={grouping} />);
    expect(screen.getByRole('checkbox', { name: /另存为 PDF/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('导出方式'), { target: { value: 'by_counterparty_merged' } });
    expect(screen.getByRole('checkbox', { name: /纳入合并 PDF 末尾/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择目录并导出' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: /纳入合并 PDF 末尾/ }));
    start();
    await screen.findByText('已生成 1 个文件，共 1 页。');
    expect(test.create).toHaveBeenCalledWith(expect.objectContaining({ output_mode: 'by_counterparty_merged', include_xlsx: true,
      include_counterparty_pending: true, expected_grouping_revision: grouping.header.grouping_revision,
      expected_review_fingerprint: grouping.header.review_fingerprint, own_account_fingerprint: grouping.header.own_account.fingerprint }));
    fireEvent.change(screen.getByLabelText('导出方式'), { target: { value: 'by_counterparty' } });
    expect(test.close).toHaveBeenCalledWith('intent');
    expect(screen.queryByRole('button', { name: '移除本次来源' })).toBeNull();
    start();
    await waitFor(() => expect(test.create).toHaveBeenCalledTimes(2));
    expect(test.create).toHaveBeenLastCalledWith(expect.objectContaining({ output_mode: 'by_counterparty', include_xlsx: true,
      include_counterparty_pending: true }));
  });
  it('drops an in-flight old group plan when the group revision changes', async () => {
    const test = setup(), delayed = deferred<any>(); test.create.mockReturnValue(delayed.promise);
    const grouping = syntheticSnapshot();
    test.view.rerender(<ReceiptExportWorkspace {...test.props} grouping={grouping} />);
    start(); await waitFor(() => expect(test.create).toHaveBeenCalledOnce());
    test.view.rerender(<ReceiptExportWorkspace {...test.props} grouping={{ ...grouping, header: { ...grouping.header, grouping_revision: 2 } }} />);
    await act(async () => delayed.resolve(test.bundle));
    expect(test.publish).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledWith('intent');
  });
  it('exports the frozen automatic records directly, with a source-based name and no optional attachments or PNG preview', async () => {
    const test = setup();
    expect(screen.queryByRole('button', { name: /生成预览/ })).toBeNull();
    expect(screen.getByText('本次导出 1 处。')).toBeTruthy();
    expect((screen.getByLabelText('同时导出清单 JSON') as HTMLInputElement).checked).toBe(false);
    start();
    await screen.findByText('已生成 1 个文件，共 1 页。');
    expect(test.create).toHaveBeenCalledWith({ job_id: 'job', result_revision: 'rev', scope_kind: 'list',
      selected_segment_ids: ['auto'], expected_records: [{ id: 'auto', record_revision: 0 }],
      output_mode: 'merged', include_xlsx: false, include_manifest: false, output_name: '示例银行_202601_全部回单' });
    expect(test.pick).toHaveBeenCalledWith('/configured/output');
    expect(test.publish).toHaveBeenCalledWith(test.bundle, '/output');
    expect(test.renderPage).not.toHaveBeenCalled();
    expect(test.onExportSuccess).toHaveBeenCalledWith('/output');
    expect(test.onRemoveSources).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '移除本次来源' }));
    expect(test.onRemoveSources).toHaveBeenCalledTimes(1);
    test.view.unmount();
    expect(test.close).toHaveBeenCalledWith('intent');
  });
  it('freezes the selected output options and validates a custom name', async () => {
    const test = setup();
    fireEvent.change(screen.getByLabelText('导出名称'), { target: { value: '../bad' } });
    expect((screen.getByRole('button', { name: '选择目录并导出' }) as HTMLButtonElement).disabled).toBe(true);
    expect(test.pick).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('导出名称'), { target: { value: '月度对账.pdf' } });
    fireEvent.change(screen.getByLabelText('导出方式'), { target: { value: 'both' } });
    fireEvent.click(screen.getByLabelText('同时导出 XLSX 索引'));
    fireEvent.click(screen.getByLabelText('同时导出清单 JSON'));
    start();
    await screen.findByText('已生成 1 个文件，共 1 页。');
    expect(test.create).toHaveBeenCalledWith(expect.objectContaining({ output_mode: 'both', output_name: '月度对账', include_xlsx: true, include_manifest: true }));
  });
  it('does no generation or publication when folder selection is cancelled', async () => {
    const test = setup(); test.pick.mockResolvedValue(null);
    start();
    await waitFor(() => expect((screen.getByRole('button', { name: '选择目录并导出' }) as HTMLButtonElement).disabled).toBe(false));
    expect(test.create).not.toHaveBeenCalled(); expect(test.publish).not.toHaveBeenCalled();
    expect(test.onExportSuccess).not.toHaveBeenCalled(); expect(test.onRemoveSources).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '导出进度' })).toBeNull();
  });
  it.each(['pending', 'empty', 'excluded'])('has no export action for %s results', (kind) => {
    const test = setup();
    const items = kind === 'empty' ? [] : [{ ...test.items[0], original: { ...test.items[0].original, needs_review: kind === 'pending' },
      record: kind === 'excluded' ? { review_status: 'excluded' } : null }];
    test.view.rerender(<ReceiptExportWorkspace {...test.props} items={items as any} />);
    expect(screen.queryByRole('button', { name: '选择目录并导出' })).toBeNull();
    expect(test.create).not.toHaveBeenCalled();
  });
  it.each(['pending', 'job', 'context', 'unmount'])('discards a delayed generated bundle after %s changes', async (change) => {
    const test = setup(), delayed = deferred<any>(); test.create.mockReturnValue(delayed.promise);
    start(); await waitFor(() => expect(test.create).toHaveBeenCalledTimes(1));
    if (change === 'unmount') test.view.unmount();
    else {
      const prepared = structuredClone(test.prepared);
      if (change === 'job') prepared.binding.job.id = 'other';
      if (change === 'context') prepared.binding.contextKey = 'other';
      const items = change === 'pending' ? [{ ...test.items[0], original: { ...test.items[0].original, needs_review: true } }] : test.items;
      test.view.rerender(<ReceiptExportWorkspace {...test.props} prepared={prepared} items={items} />);
    }
    await act(async () => { delayed.resolve(test.bundle); });
    expect(test.close).toHaveBeenCalledWith('intent'); expect(test.publish).not.toHaveBeenCalled();
    expect(test.onExportSuccess).not.toHaveBeenCalled();
  });
  it('checks the task again after the folder picker and does not create an obsolete export', async () => {
    const test = setup(), delayed = deferred<string | null>(); test.pick.mockReturnValue(delayed.promise);
    start();
    test.view.rerender(<ReceiptExportWorkspace {...test.props} items={[]} />);
    await act(async () => { delayed.resolve('/output'); });
    expect(test.create).not.toHaveBeenCalled(); expect(test.publish).not.toHaveBeenCalled();
  });
  it('rejects a delayed export even when the task changes away and back to the original context', async () => {
    const test = setup(), delayed = deferred<any>(); test.create.mockReturnValue(delayed.promise);
    start(); await waitFor(() => expect(test.create).toHaveBeenCalledTimes(1));
    const other = structuredClone(test.prepared); other.binding.contextKey = 'other';
    test.view.rerender(<ReceiptExportWorkspace {...test.props} prepared={other} />);
    test.view.rerender(<ReceiptExportWorkspace {...test.props} />);
    await act(async () => { delayed.resolve(test.bundle); });
    expect(test.publish).not.toHaveBeenCalled(); expect(test.close).toHaveBeenCalledWith('intent');
  });
  it('locks options and rejects double clicks throughout preparation and publication', async () => {
    const test = setup(), delayed = deferred<any>(); test.publish.mockReturnValue(delayed.promise);
    const button = screen.getByRole('button', { name: '选择目录并导出' });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(test.publish).toHaveBeenCalledTimes(1));
    expect(test.pick).toHaveBeenCalledTimes(1); expect(test.create).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('导出名称') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('同时导出清单 JSON') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '返回检查' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '移除本次来源' })).toBeNull();
    await act(async () => { delayed.resolve({ directory: '/output/结果', files: [{}], total_pages: 1 }); });
  });
  it('retries an uncertain publication with the same intent and directory instead of making duplicate output', async () => {
    const test = setup(); test.publish.mockRejectedValueOnce(new Error('连接中断'));
    start(); await screen.findByText('连接中断');
    expect(test.close).not.toHaveBeenCalled();
    expect((screen.getByLabelText('导出方式') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重试导出' }));
    await screen.findByText('已生成 1 个文件，共 1 页。');
    expect(test.create).toHaveBeenCalledTimes(1); expect(test.pick).toHaveBeenCalledTimes(1);
    expect(test.publish).toHaveBeenNthCalledWith(2, test.bundle, '/output');
  });
  it('explains generation timeout without reporting completed output or publishing partial files', async () => {
    const test = setup(); test.create.mockRejectedValueOnce('local engine operation timed out');
    start();
    await screen.findByText('生成 PDF 超时，本次导出未完成。已核对的回单和分组仍保留，可以重试。');
    expect(test.publish).not.toHaveBeenCalled();
    expect(test.onExportSuccess).not.toHaveBeenCalled();
    expect(screen.queryByText(/已生成 .* 个文件/)).toBeNull();
    expect(screen.getByRole('button', { name: '选择目录并导出' })).toHaveProperty('disabled', false);
  });
  it('explains publication timeout and retries the same output transaction', async () => {
    const test = setup(); test.publish.mockRejectedValueOnce(new Error('local engine operation timed out'));
    start();
    await screen.findByText('保存导出结果超时，尚未确认是否全部完成。请点击“重试导出”，系统会核对本次结果，避免重复导出。');
    expect(test.onExportSuccess).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试导出' }));
    await screen.findByText('已生成 1 个文件，共 1 页。');
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.publish).toHaveBeenNthCalledWith(2, test.bundle, '/output');
  });
  it('distinguishes grouped PDF generation from saving files', async () => {
    const test = setup(), generated = deferred<any>(), saved = deferred<any>();
    test.create.mockReturnValue(generated.promise); test.publish.mockReturnValue(saved.promise);
    test.view.rerender(<ReceiptExportWorkspace {...test.props} grouping={syntheticSnapshot()} />);
    start();
    expect(await screen.findByRole('button', { name: '正在生成各组 PDF…' })).toHaveProperty('disabled', true);
    await act(async () => generated.resolve(test.bundle));
    expect(await screen.findByRole('button', { name: '正在保存导出文件…' })).toHaveProperty('disabled', true);
    await act(async () => saved.resolve({ directory: '/output/结果', files: [{}], total_pages: 1 }));
    await screen.findByText('已生成 1 个文件，共 1 页。');
  });
  it('shows real progress and elapsed time, then clears them on failure and rejects stale-context updates', async () => {
    const test = setup(), generated = deferred<any>();
    let report!: (value: unknown) => void;
    test.create.mockImplementation(function (this: ExportBundleClient) {
      report = (this as any).options.onProgress;
      return generated.promise;
    });
    test.publish.mockRejectedValueOnce(new Error('连接中断'));
    vi.useFakeTimers(); start();
    await act(async () => { await Promise.resolve(); });
    act(() => report({ stage: 'rendering', completed: 2075, total: 4150, unit: 'pages' }));
    expect(screen.getByText('当前阶段：已完成 2075 / 4150 页（50%）')).toBeTruthy();
    act(() => vi.advanceTimersByTime(65_000));
    expect(screen.getByText('已用时 1 分 5 秒')).toBeTruthy();
    await act(async () => generated.resolve(test.bundle));
    expect(screen.getByText('连接中断')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '导出进度' })).toBeNull();
    act(() => report({ stage: 'rendering', completed: 4000, total: 4150, unit: 'pages' }));
    expect(screen.queryByRole('region', { name: '导出进度' })).toBeNull();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: '重试导出' }));
    await screen.findByText('已生成 1 个文件，共 1 页。');
    expect(screen.queryByRole('region', { name: '导出进度' })).toBeNull();
  });
  it('does not show progress from a previous task while its export response is pending', async () => {
    const test = setup(), generated = deferred<any>();
    let report!: (value: unknown) => void;
    test.create.mockImplementation(function (this: ExportBundleClient) {
      report = (this as any).options.onProgress;
      return generated.promise;
    });
    start(); await waitFor(() => expect(test.create).toHaveBeenCalledOnce());
    const other = structuredClone(test.prepared); other.binding.contextKey = 'other';
    test.view.rerender(<ReceiptExportWorkspace {...test.props} prepared={other} />);
    act(() => report({ stage: 'rendering', completed: 2075, total: 4150, unit: 'pages' }));
    expect(screen.queryByText(/2075/)).toBeNull();
    test.view.unmount();
    act(() => report({ stage: 'rendering', completed: 4150, total: 4150, unit: 'pages' }));
    await act(async () => generated.resolve(test.bundle));
    expect(test.publish).not.toHaveBeenCalled();
  });
  it('waits for an in-flight publication before closing on unmount and never reports success to another task', async () => {
    const test = setup(), delayed = deferred<any>(); test.publish.mockReturnValue(delayed.promise);
    start(); await waitFor(() => expect(test.publish).toHaveBeenCalledTimes(1));
    test.view.unmount(); expect(test.close).not.toHaveBeenCalled();
    await act(async () => { delayed.resolve({ directory: '/output/结果', files: [{}], total_pages: 1 }); });
    expect(test.close).toHaveBeenCalledWith('intent'); expect(test.onExportSuccess).not.toHaveBeenCalled();
  });
  it('allows changing output options after success and creates a fresh export', async () => {
    const test = setup(); start(); await screen.findByText('已生成 1 个文件，共 1 页。');
    fireEvent.click(screen.getByLabelText('同时导出 XLSX 索引'));
    expect(test.close).toHaveBeenCalledWith('intent');
    expect(screen.queryByRole('button', { name: '移除本次来源' })).toBeNull();
    start(); await waitFor(() => expect(test.create).toHaveBeenCalledTimes(2));
  });
});
