// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReceiptExportWorkspace } from './ReceiptExportWorkspace';
import { ExportBundleClient } from '../services/exportBundleClient';
import { localEngineAdapter } from './localEngineAdapter';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
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
