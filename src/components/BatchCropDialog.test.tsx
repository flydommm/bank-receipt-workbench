// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BatchCropPlan } from '../domain/batchCrop';
import type { PdfRect, ReviewSegment } from '../domain/cropReview';
import { BatchCropDialog, type BatchCropDialogProps } from './BatchCropDialog';

const pageRect = (x0: number, y0: number, x1: number, y1: number): PdfRect => ({ x0, y0, x1, y1 });

function segment(id: string, page: number, overrides: Partial<ReviewSegment> = {}): ReviewSegment {
  return {
    id,
    sourceKey: 'source-a',
    sourceName: '甲.pdf',
    sourcePath: '/docs/a.pdf',
    sourceSha256: 'a'.repeat(64),
    sourcePage: page,
    segmentNo: page,
    matchRect: pageRect(180, 220, 240, 280),
    candidateRect: pageRect(120, 140, 360, 480),
    finalRect: pageRect(110, 130, 370, 490),
    pageWidth: 600,
    pageHeight: 800,
    confidence: 0.9,
    slot: 'top',
    layoutFingerprint: 'layout',
    mode: 'candidate',
    reviewStatus: 'needs_review',
    manualAdjusted: false,
    ...overrides,
  };
}

function makePlan(): BatchCropPlan {
  const first = segment('target-1', 4);
  const second = segment('target-2', 12, { sourceKey: 'source-b', sourceName: '乙.pdf', sourcePath: '/docs/b.pdf' });
  return {
    sampleId: 'sample',
    applicable: [
      { before: first, after: { ...first, finalRect: pageRect(100, 120, 380, 500), mode: 'manual', manualAdjusted: true } },
      { before: second, after: { ...second, finalRect: pageRect(100, 120, 380, 500), mode: 'manual', manualAdjusted: true } },
    ],
    skipped: [
      { segment: segment('skipped-1', 8), reason: '版式标题不一致，无法安全套用。' },
    ],
  };
}

function renderDialog(overrides: Partial<BatchCropDialogProps> = {}) {
  const onScopeChange = vi.fn<(scope: 'source' | 'filtered') => void>();
  const onApply = vi.fn<() => void>();
  const onClose = vi.fn<() => void>();
  const loadPreview = vi.fn(async (item: ReviewSegment) => `data:image/png;base64,${item.id}`);
  const props: BatchCropDialogProps = {
    sample: segment('sample', 1, { mode: 'manual', reviewStatus: 'confirmed', manualAdjusted: true }),
    scope: 'source',
    onScopeChange,
    plan: makePlan(),
    progress: '检查完成：可应用 2 项，跳过 1 项。',
    busy: false,
    applying: false,
    loadPreview,
    onApply,
    onClose,
    ...overrides,
  };
  const view = render(<BatchCropDialog {...props} />);
  return { ...view, props, onScopeChange, onApply, onClose, loadPreview };
}

afterEach(cleanup);

describe('BatchCropDialog', () => {
  it('zooms a loaded page without reloading and resets to fit when switching targets', async () => {
    const user = userEvent.setup();
    const { loadPreview } = renderDialog();
    const zoom = await screen.findByRole('button', { name: '放大预览' });
    await user.click(zoom);
    expect(screen.getByRole('button', { name: '适应整页' }).getAttribute('aria-pressed')).toBe('true');
    expect(loadPreview).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '下一项' }));
    expect(await screen.findByRole('button', { name: '放大预览' })).toBeTruthy();
    expect(loadPreview).toHaveBeenCalledTimes(2);
  });

  it('shows the scope, counts, target identity, skip reason, and auto-loads the first applicable preview', async () => {
    const { loadPreview } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: '应用到同类片段' });

    expect((within(dialog).getByRole('combobox', { name: '应用范围' }) as HTMLSelectElement).value).toBe('source');
    expect(within(dialog).getByRole('option', { name: '当前 PDF' })).toBeTruthy();
    expect(within(dialog).getByRole('option', { name: '当前筛选结果（可跨 PDF）' })).toBeTruthy();
    expect(dialog.querySelector('.batch-crop-dialog-counts')?.textContent).toContain('适用2');
    expect(dialog.querySelector('.batch-crop-dialog-counts')?.textContent).toContain('跳过1');
    expect(within(dialog).getByText('版式标题不一致，无法安全套用。')).toBeTruthy();
    expect(within(dialog).getByText('甲.pdf')).toBeTruthy();
    expect(dialog.textContent).toContain('第 4 页');
    expect(dialog.textContent).toContain('片段 4');
    await waitFor(() => expect(loadPreview).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByAltText(/甲\.pdf 第 4 页/)).toBeTruthy();
  });

  it('requires a loaded preview and the inspection checkbox before applying', async () => {
    const user = userEvent.setup();
    const preview = deferred<string>();
    const { onApply } = renderDialog({ loadPreview: vi.fn(() => preview.promise) });
    const dialog = screen.getByRole('dialog', { name: '应用到同类片段' });
    const checkbox = within(dialog).getByRole('checkbox', { name: /已检查预览/ }) as HTMLInputElement;
    const apply = within(dialog).getByRole('button', { name: '应用到 2 个片段' }) as HTMLButtonElement;

    expect(checkbox.disabled).toBe(true);
    expect(apply.disabled).toBe(true);
    preview.resolve('data:image/png;base64,loaded');
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(apply.disabled).toBe(true);
    await user.click(checkbox);
    expect(apply.disabled).toBe(false);
    await user.click(apply);
    expect(onApply).toHaveBeenCalledOnce();
  });

  it('drops a late preview after scope changes and resets inspection', async () => {
    const user = userEvent.setup();
    const preview = deferred<string>();
    const { onScopeChange } = renderDialog({ loadPreview: vi.fn(() => preview.promise) });
    const dialog = screen.getByRole('dialog', { name: '应用到同类片段' });
    const scope = within(dialog).getByRole('combobox', { name: '应用范围' });

    await user.selectOptions(scope, 'filtered');
    expect(onScopeChange).toHaveBeenCalledWith('filtered');
    expect((within(dialog).getByRole('checkbox', { name: /已检查预览/ }) as HTMLInputElement).checked).toBe(false);
    preview.resolve('data:image/png;base64,late');
    await Promise.resolve();
    expect(within(dialog).queryByAltText(/甲\.pdf 第 4 页/)).toBeNull();
  });

  it('retries a failed preview through a fresh load request', async () => {
    const user = userEvent.setup();
    const preview = deferred<string>();
    const loadPreview = vi.fn()
      .mockImplementationOnce(async () => { throw new Error('第一次加载失败'); })
      .mockReturnValueOnce(preview.promise);
    renderDialog({ loadPreview });
    const dialog = screen.getByRole('dialog', { name: '应用到同类片段' });

    await waitFor(() => expect(within(dialog).getByRole('button', { name: '重试预览' })).toBeTruthy());
    await user.click(within(dialog).getByRole('button', { name: '重试预览' }));
    expect(loadPreview).toHaveBeenCalledTimes(2);
    preview.resolve('data:image/png;base64,retried');
    await waitFor(() => expect(within(dialog).getByAltText(/甲\.pdf 第 4 页/)).toBeTruthy());
  });

  it('traps focus, cancels on Escape, restores the opener, and ignores Escape while applying', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = '打开批量调整';
    document.body.appendChild(opener);
    opener.focus();
    let open = true;
    let view: ReturnType<typeof renderDialog>;
    const onClose = vi.fn(() => {
      open = false;
      view.unmount();
    });
    view = renderDialog({ onClose });
    const dialog = screen.getByRole('dialog', { name: '应用到同类片段' });
    const focusable = () => within(dialog).getAllByRole('button').filter((node) => !(node as HTMLButtonElement).disabled);
    const buttons = focusable();
    buttons[buttons.length - 1]!.focus();
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('combobox', { name: '应用范围' }));

    const first = within(dialog).getByRole('combobox', { name: '应用范围' });
    first.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '取消' }));

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(open).toBe(false);
    expect(document.activeElement).toBe(opener);

    opener.remove();
  });

  it('disables cancellation and Escape while applying', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog({ applying: true });
    const dialog = screen.getByRole('dialog', { name: '应用到同类片段' });
    const cancel = within(dialog).getByRole('button', { name: '取消' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('explains when a plan has zero applicable targets', () => {
    const plan = makePlan();
    plan.applicable = [];
    renderDialog({ plan });
    const dialog = screen.getByRole('dialog', { name: '应用到同类片段' });

    expect(within(dialog).getByText('没有可应用的同类片段。')).toBeTruthy();
    expect(within(dialog).getByText('版式标题不一致，无法安全套用。')).toBeTruthy();
    expect((within(dialog).getByRole('checkbox', { name: /已检查预览/ }) as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: '应用到 0 个片段' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('supports selecting a target and previous/next navigation', async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: '应用到同类片段' });
    const selector = within(dialog).getByRole('combobox', { name: '选择预览片段' });

    await user.selectOptions(selector, '1');
    expect((selector as HTMLSelectElement).value).toBe('1');
    expect(within(dialog).getByText('乙.pdf')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: '上一项' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: '上一项' }));
    expect((selector as HTMLSelectElement).value).toBe('0');
    await user.click(within(dialog).getByRole('button', { name: '下一项' }));
    expect((selector as HTMLSelectElement).value).toBe('1');
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
