// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ReceiptLayoutEditor } from './ReceiptLayoutEditor';
import type { LayoutDefinition } from '../domain/receiptLayout';

const layout: LayoutDefinition = {
  schema_version: 1, layout_id: 'layout-a', revision: 1, workspace_id: 'workspace-a', issuer_id: 'bank-a', family_id: 'family-a', evidence_version: 'v1',
  page_geometry: { pdf_box: { x0: 0, y0: 0, x1: 600, y1: 900 }, rotation: 0, user_unit: 1, width_pt: 600, height_pt: 900 },
  uniform_height: true, left_pt: 0, right_pt: 0,
  slots: [{ slot_id: 'slot-1', position_index: 1, top_pt: 0, height_pt: 440 }, { slot_id: 'slot-2', position_index: 2, top_pt: 460, height_pt: 440 }],
};

function makeLayout(overrides: Partial<LayoutDefinition> = {}): LayoutDefinition {
  return {
    ...layout,
    ...overrides,
    page_geometry: { ...layout.page_geometry, ...overrides.page_geometry },
    slots: overrides.slots ?? layout.slots.map((slot) => ({ ...slot })),
  };
}

function renderEditor(props: Partial<React.ComponentProps<typeof ReceiptLayoutEditor>> = {}) {
  return render(
    <ReceiptLayoutEditor
      layout={layout}
      dirty={false}
      onChange={vi.fn()}
      onPreview={vi.fn()}
      onCancel={vi.fn()}
      {...props}
    />,
  );
}

describe('ReceiptLayoutEditor', () => {
  afterEach(cleanup);

  it('edits only the protected selected slot with no shared geometry or copy controls', () => {
    const onChange = vi.fn(); const onSelectSlot = vi.fn();
    renderEditor({ layout: makeLayout({ uniform_height: false }), selectedSlotId: 'slot-2', editableSlotIds: ['slot-2'], onChange, onSelectSlot });
    expect(screen.getByRole('heading', { name: '所选片段微调' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /第 1 栏/ })).toHaveProperty('disabled', true);
    for (const name of ['左边距（mm）', '右边距（mm）', '统一所有栏位高度']) expect(screen.getByLabelText(name)).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: '复制当前框尺寸' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /第 1 栏/ }));
    expect(onSelectSlot).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('回单高度（mm）'), { target: { value: '100' } });
    expect(onChange.mock.calls[0][0].slots[0]).toEqual(layout.slots[0]);
    expect(onChange.mock.calls[0][0].slots[1].height_pt).toBeCloseTo(100 * 72 / 25.4);
    fireEvent.change(screen.getByLabelText('左边距（mm）'), { target: { value: '10' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows real page height, allows preview without a draft, and has no saved copy', () => {
    const onPreview = vi.fn();
    const onSelectSlot = vi.fn();
    renderEditor({ onPreview, onSelectSlot });

    expect(screen.getByRole('heading', { name: '整页栏位微调' })).toBeTruthy();
    expect(screen.getByText(/页面高度 317\.5 mm/)).toBeTruthy();
    expect(screen.queryByText(/已保存/)).toBeNull();
    expect(screen.queryByRole('button', { name: /保存/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /第 2 栏/ }));
    expect(onSelectSlot).toHaveBeenCalledWith('slot-2');
    fireEvent.click(screen.getByRole('button', { name: '确认并预览本轮' }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it('keeps layout points precise while converting edited millimetres once', () => {
    const onChange = vi.fn<(next: LayoutDefinition) => void>();
    const preciseLayout = makeLayout({
      slots: [
        { slot_id: 'slot-1', position_index: 1, top_pt: 0, height_pt: 300 },
        { slot_id: 'slot-2', position_index: 2, top_pt: 500, height_pt: 300 },
      ],
    });
    renderEditor({ layout: preciseLayout, onChange });

    fireEvent.change(screen.getByLabelText('距页顶（mm）'), { target: { value: '25.4' } });
    const topChange = onChange.mock.calls[0]?.[0];
    expect(topChange?.slots[0].top_pt).toBe(72);
    expect(topChange?.slots[1].top_pt).toBe(500);

    fireEvent.change(screen.getByLabelText('回单高度（mm）'), { target: { value: '25.4' } });
    const heightChange = onChange.mock.calls[1]?.[0];
    expect(heightChange?.slots.map((slot) => slot.height_pt)).toEqual([72, 72]);
  });

  it('shows an overlap error, blocks preview, and accepts a corrected height', () => {
    const onChange = vi.fn<(next: LayoutDefinition) => void>();
    const nonUniformLayout = makeLayout({
      uniform_height: false,
      slots: [
        { slot_id: 'slot-1', position_index: 1, top_pt: 0, height_pt: 440 },
        { slot_id: 'slot-2', position_index: 2, top_pt: 460, height_pt: 300 },
      ],
    });
    const view = renderEditor({ layout: nonUniformLayout, onChange });
    const topInput = screen.getByLabelText('距页顶（mm）');
    fireEvent.change(topInput, { target: { value: '100' } });
    const candidate = onChange.mock.calls[0][0];
    view.rerender(<ReceiptLayoutEditor layout={candidate} dirty onChange={onChange} onPreview={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toMatch(/重叠|页面高度/);
    expect((screen.getByRole('button', { name: '确认并预览本轮' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();

    fireEvent.change(topInput, { target: { value: '5' } });
    view.rerender(<ReceiptLayoutEditor layout={onChange.mock.calls[1][0]} dirty onChange={onChange} onPreview={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('synchronizes every slot when uniform height is enabled', () => {
    const onChange = vi.fn<(next: LayoutDefinition) => void>();
    const nonUniformLayout = makeLayout({
      uniform_height: false,
      slots: [
        { slot_id: 'slot-1', position_index: 1, top_pt: 0, height_pt: 440 },
        { slot_id: 'slot-2', position_index: 2, top_pt: 460, height_pt: 300 },
      ],
    });
    renderEditor({ layout: nonUniformLayout, onChange });
    fireEvent.click(screen.getByLabelText('统一所有栏位高度'));
    const changed = onChange.mock.calls[0]?.[0];
    expect(changed?.uniform_height).toBe(true);
    expect(changed?.slots.map((slot) => slot.height_pt)).toEqual([440, 440]);
  });

  it('shows conversion or callback failures for uniform height changes', () => {
    const onChange = vi.fn<(next: LayoutDefinition) => void>(() => { throw new Error('转换失败'); });
    renderEditor({ onChange });
    fireEvent.change(screen.getByLabelText('回单高度（mm）'), { target: { value: '100' } });
    expect(screen.getByRole('alert').textContent).toContain('回单高度更新失败');
    expect((screen.getByRole('button', { name: '确认并预览本轮' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders slot details without clickable navigation when no selector is supplied', () => {
    renderEditor();
    expect(screen.queryByRole('button', { name: /第 2 栏/ })).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText(/第 2 栏/)).toBeTruthy();
  });

  it('disables all editing and actions while busy', () => {
    renderEditor({ onSelectSlot: vi.fn(), busy: true });
    expect((screen.getByLabelText('距页顶（mm）') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('回单高度（mm）') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('统一所有栏位高度') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /第 2 栏/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '返回' }) as HTMLButtonElement).disabled).toBe(true);
    const pending = screen.getByRole('button', { name: '正在重算本轮页面…' }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute('aria-busy')).toBe('true');
  });

  function ThreeSlotEditor() {
    const pt = (mm: number) => mm * 72 / 25.4;
    const [draft, setDraft] = useState(makeLayout({ uniform_height: false,
      page_geometry: { ...layout.page_geometry, pdf_box: { x0: 0, y0: 0, x1: 600, y1: pt(297.04) }, height_pt: pt(297.04) },
      slots: [[0, 96.49], [100.01, 101.42], [201.44, 95.25]].map(([top, height], index) => ({
        slot_id: `slot-${index + 1}`, position_index: index + 1, top_pt: pt(top), height_pt: pt(height),
      })),
    }));
    const [slot, select] = useState('slot-1');
    return <ReceiptLayoutEditor layout={draft} selectedSlotId={slot} dirty onSelectSlot={select} onChange={setDraft} onPreview={vi.fn()} onCancel={vi.fn()} />;
  }

  it('keeps typed decimal height and lets another slot move after equal-height overflow', async () => {
    render(<ThreeSlotEditor />);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('回单高度（mm）'));
    await user.type(screen.getByLabelText('回单高度（mm）'), '96.25');
    fireEvent.click(screen.getByLabelText('统一所有栏位高度'));
    expect((screen.getByLabelText('统一所有栏位高度') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('0.65');
    expect(screen.getByRole('alert').textContent).toContain('297.69');
    expect((screen.getByRole('button', { name: '确认并预览本轮' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /第 3 栏.*距页顶/ }));
    expect((screen.getByLabelText('回单高度（mm）') as HTMLInputElement).value).toBe('96.25');
    fireEvent.change(screen.getByLabelText('距页顶（mm）'), { target: { value: '200.79' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: '确认并预览本轮' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('copies a frame size to another slot while preserving its position', () => {
    render(<ThreeSlotEditor />);
    fireEvent.change(screen.getByLabelText('回单高度（mm）'), { target: { value: '95' } });
    fireEvent.click(screen.getByRole('button', { name: '复制当前框尺寸' }));
    fireEvent.click(screen.getByRole('button', { name: /第 2 栏.*距页顶/ }));
    fireEvent.click(screen.getByRole('button', { name: '粘贴第 1 栏尺寸' }));
    expect((screen.getByLabelText('距页顶（mm）') as HTMLInputElement).value).toBe('100.01');
    expect((screen.getByLabelText('回单高度（mm）') as HTMLInputElement).value).toBe('95');
    fireEvent.click(screen.getByRole('button', { name: /第 3 栏.*距页顶/ }));
    expect((screen.getByLabelText('回单高度（mm）') as HTMLInputElement).value).toBe('95.25');
  });
});
