// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LayoutTemplateManager } from './LayoutTemplateManager';
import type { LayoutTemplate, LayoutTemplateClient, LayoutTemplatePage } from '../services/layoutTemplateClient';

const template = (overrides: Partial<LayoutTemplate> = {}): LayoutTemplate => ({
  id: 'template-a', version: 2, name: '常用回单', source_scope: 'private-issuer-hash',
  page_geometry: { pdf_box: { x0: 0, y0: 0, x1: 600, y1: 900 }, rotation: 0, user_unit: 1, width_pt: 600, height_pt: 900 },
  layout_fingerprint: 'a'.repeat(64), source_operation_id: 'op', active: true, evidence_summary: { confirmed_slot_ids: ['s0', 's1'] },
  slots: [0, 1, 2].map((index) => ({ slot_id: `s${index}`, position_index: index + 1,
    rect: { x0: 10, y0: index * 300 + 10, x1: 590, y1: index * 300 + 290 } })),
  created_at: '2026-09-21T00:00:00Z', updated_at: '2026-09-21T00:00:00Z', ...overrides,
});
const evidenceForIssuer = (issuer_id: string): Record<string, unknown> => ({ confirmed_slot_ids: ['s0', 's1'], layout_definition: { issuer_id } });
const page = (items: LayoutTemplate[]): LayoutTemplatePage => ({ items, total: items.length, next_offset: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
function setup(items = [template()]) {
  const client = { list: vi.fn().mockResolvedValue(page(items)), rename: vi.fn().mockResolvedValue(template()), deactivate: vi.fn().mockResolvedValue(true) };
  const props = { client: client as unknown as LayoutTemplateClient, selectedTemplateId: null as string | null, candidateTemplateIds: undefined as string[] | undefined, onSelect: vi.fn(), onClose: vi.fn(), onChanged: vi.fn() };
  return { client, props };
}
afterEach(cleanup);

describe('LayoutTemplateManager', () => {
  it('uses review-specific template preview actions without editing the library', async () => {
    const chosen = template();
    const { props } = setup([chosen]);
    render(<LayoutTemplateManager {...props} usage="current_review" />);
    await screen.findByRole('heading', { name: '常用回单' });
    expect(screen.getByText(/先预览当前任务所有兼容来源中可应用的栏位/)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '模板名称' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停用此模板' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '预览应用到当前结果' }));
    expect(props.onSelect).toHaveBeenCalledWith(chosen);
    fireEvent.click(screen.getByRole('button', { name: '返回审核' }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it('guides an empty library toward the reviewed calibration flow', async () => {
    const { props } = setup([]);
    render(<LayoutTemplateManager {...props} />);
    await screen.findByRole('heading', { name: '暂无可用版式模板' });
    expect(screen.getByText(/分析 PDF 后/).textContent).toContain('保存为版式模板');
    expect(screen.queryByRole('button', { name: '选用此模板' })).toBeNull();
  });

  it('groups templates by issuer evidence and keeps missing issuer templates independent', async () => {
    const knownOne = template({ id: 'known-one', name: '企业甲版', bank_name: '招商银行', series_id: 'series-a', source_scope: 'opaque-a', evidence_summary: evidenceForIssuer('issuer-a') });
    const knownTwo = template({ id: 'known-two', name: '企业乙版', bank_name: '浦发银行', series_id: 'series-b', source_scope: 'opaque-b', evidence_summary: evidenceForIssuer('issuer-a') });
    const missing = template({ id: 'missing', name: '上海银行', bank_name: null, series_id: 'series-c', source_scope: 'opaque-c' });
    const blank = template({ id: 'blank', name: '另一套版式', bank_name: '   ', series_id: 'series-d', source_scope: 'opaque-d' });
    const { props } = setup([knownOne, knownTwo, missing, blank]);
    render(<LayoutTemplateManager {...props} />);

    await screen.findByRole('heading', { name: '企业甲版' });
    const knownGroup = screen.getByRole('region', { name: '银行：招商银行' });
    expect(within(knownGroup).getAllByRole('button')).toHaveLength(2);
    expect(screen.getAllByRole('region', { name: '银行：未标注银行名称' })).toHaveLength(2);
    expect(screen.getAllByRole('heading', { name: '未标注银行名称' })).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: '上海银行' })).toBeNull();
    expect(screen.queryByText('opaque-a')).toBeNull();
    expect(screen.getByText(/银行名称仅用于列表展示/)).toBeTruthy();
    expect(screen.getByText(/微调时明确选择目标模板/)).toBeTruthy();
    expect(screen.getByText(/独立模板互不覆盖/)).toBeTruthy();
  });

  it('does not merge equal bank labels from different issuers', async () => {
    const issuerA = template({ id: 'issuer-a', name: '甲模板', bank_name: '招商银行', evidence_summary: evidenceForIssuer('issuer-a') });
    const issuerB = template({ id: 'issuer-b', name: '乙模板', bank_name: '招商银行', evidence_summary: evidenceForIssuer('issuer-b') });
    const { props } = setup([issuerA, issuerB]);
    render(<LayoutTemplateManager {...props} />);

    await screen.findByRole('heading', { name: '甲模板' });
    const sameLabelGroups = screen.getAllByRole('region', { name: '银行：招商银行' });
    expect(sameLabelGroups).toHaveLength(2);
    expect(within(sameLabelGroups[0]).getAllByRole('button')).toHaveLength(1);
    expect(within(sameLabelGroups[1]).getAllByRole('button')).toHaveLength(1);
  });

  it('keeps templates without issuer evidence independent even when their bank labels match', async () => {
    const first = template({ id: 'missing-issuer-a', name: '待标注甲版', bank_name: '招商银行', series_id: 'series-a' });
    const second = template({ id: 'missing-issuer-b', name: '待标注乙版', bank_name: '招商银行', series_id: 'series-b' });
    const { props } = setup([first, second]);
    render(<LayoutTemplateManager {...props} />);

    await screen.findByRole('heading', { name: '待标注甲版' });
    const groups = screen.getAllByRole('region', { name: '银行：招商银行' });
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => within(group).getAllByRole('button').length === 1)).toBe(true);
  });

  it('marks only the exact selected template when a bank has independent templates', async () => {
    const selected = template({ id: 'selected', name: '招商银行甲版', bank_name: '招商银行', series_id: 'series-a' });
    const sibling = template({ id: 'sibling', name: '招商银行乙版', bank_name: '招商银行', series_id: 'series-b' });
    const { props } = setup([selected, sibling]);
    props.selectedTemplateId = selected.id;
    render(<LayoutTemplateManager {...props} />);

    await screen.findByRole('heading', { name: '招商银行甲版' });
    expect(screen.getAllByText('已选用于新分析')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /招商银行甲版.*已选用于新分析/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /招商银行乙版.*已选用于新分析/ })).toBeNull();
  });

  it('finds candidate templates across every library page before filtering the list', async () => {
    const firstCandidate = template({ id: 'candidate-first', name: '第一页候选', bank_name: '招商银行', series_id: 'series-a' });
    const secondCandidate = template({ id: 'candidate-second', name: '第二页候选', bank_name: '招商银行', series_id: 'series-b' });
    const firstPage = [firstCandidate, ...Array.from({ length: 9 }, (_, index) => template({ id: `other-${index}`, name: `其他模板${index}` }))];
    const { props, client } = setup(firstPage);
    props.candidateTemplateIds = [firstCandidate.id, secondCandidate.id];
    client.list.mockImplementation(async (request: { offset: number }) => request.offset === 0
      ? { items: firstPage, total: 11, next_offset: 10 }
      : { items: [secondCandidate], total: 11, next_offset: null });
    render(<LayoutTemplateManager {...props} />);

    await screen.findByRole('heading', { name: '第一页候选' });
    expect(screen.getByRole('button', { name: /第二页候选/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /其他模板/ })).toBeNull();
    expect(client.list.mock.calls.map(([request]) => request.offset)).toEqual([0, 10]);
  });

  it('shows safe geometry and millimetre parameters and selects the exact template', async () => {
    const value = template({ name: null }), { props } = setup([value]);
    render(<LayoutTemplateManager {...props} />);
    await screen.findByRole('heading', { name: '3栏回单模板' });
    expect(screen.getByRole('img', { name: '3栏回单模板框位示意' }).querySelectorAll('g rect')).toHaveLength(3);
    expect(screen.getByRole('img').querySelectorAll('g.is-confirmed')).toHaveLength(2);
    expect(screen.getByRole('img').querySelectorAll('g.is-unconfirmed')).toHaveLength(1);
    expect(screen.getByText('已核对 2 / 3 栏')).toBeTruthy();
    const parameters = screen.getByRole('table', { name: '框位参数（mm）' });
    expect(within(parameters).getAllByText('3.53').length).toBeGreaterThan(0);
    expect(screen.queryByText('private-issuer-hash')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '选用此模板' }));
    expect(props.onSelect).toHaveBeenCalledWith(value);
    fireEvent.click(screen.getByRole('button', { name: '返回分析' }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('keeps the editable name aligned when selecting another template after an async load', async () => {
    const generic = template({ id: 'generic', name: '3栏回单模板' });
    const hx = template({ id: 'hx', name: 'HX-3栏回单模板' });
    const { props } = setup([generic, hx]);
    props.selectedTemplateId = 'generic';
    render(<StrictMode><LayoutTemplateManager {...props} /></StrictMode>);

    await screen.findByRole('heading', { name: '3栏回单模板' });
    expect((screen.getByLabelText('模板名称') as HTMLInputElement).value).toBe('3栏回单模板');
    fireEvent.click(screen.getByRole('button', { name: /HX-3栏回单模板/ }));
    expect((screen.getByLabelText('模板名称') as HTMLInputElement).value).toBe('HX-3栏回单模板');
    await screen.findByRole('heading', { name: 'HX-3栏回单模板' });
    expect((screen.getByLabelText('模板名称') as HTMLInputElement).value).toBe('HX-3栏回单模板');
  });

  it('restores the selected name after a refresh and after reopening the manager', async () => {
    const generic = template({ id: 'generic', name: '3栏回单模板' });
    const hx = template({ id: 'hx', name: 'HX-3栏回单模板' });
    const { props, client } = setup([generic, hx]);
    props.selectedTemplateId = 'hx';
    client.list.mockResolvedValue(page([generic, hx]));
    const view = render(<StrictMode><LayoutTemplateManager {...props} /></StrictMode>);

    await waitFor(() => expect((screen.getByLabelText('模板名称') as HTMLInputElement).value).toBe('HX-3栏回单模板'));
    fireEvent.click(screen.getByRole('button', { name: '刷新列表' }));
    await waitFor(() => expect((screen.getByLabelText('模板名称') as HTMLInputElement).value).toBe('HX-3栏回单模板'));

    view.unmount();
    render(<StrictMode><LayoutTemplateManager {...props} /></StrictMode>);
    await waitFor(() => expect((screen.getByLabelText('模板名称') as HTMLInputElement).value).toBe('HX-3栏回单模板'));
  });

  it('validates names and locks selection and writes until rename is settled', async () => {
    const { props, client } = setup();
    const pending = deferred<LayoutTemplate>(); client.rename.mockReturnValueOnce(pending.promise);
    render(<LayoutTemplateManager {...props} />);
    const input = await screen.findByLabelText('模板名称');
    fireEvent.change(input, { target: { value: '  ' } });
    expect((screen.getByRole('button', { name: '保存名称' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  月结回单  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
    for (const name of ['选用此模板', '保存名称', '停用此模板', '返回分析']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(client.rename).toHaveBeenCalledWith('template-a', '月结回单');
    client.list.mockResolvedValue(page([template({ name: '月结回单' })]));
    await act(async () => pending.resolve(template({ name: '月结回单' })));
    await screen.findByRole('heading', { name: '月结回单' });
    expect(props.onChanged).toHaveBeenCalledOnce();
    expect(props.onChanged).toHaveBeenCalledWith(expect.objectContaining({ name: '月结回单' }), 'rename');
  });

  it('keeps a pending rename bound to its template and does not rename another selection', async () => {
    const first = template({ id: 'first', name: '甲模板' });
    const second = template({ id: 'second', name: '乙模板' });
    const { props, client } = setup([first, second]);
    const pending = deferred<LayoutTemplate>();
    client.rename.mockReturnValueOnce(pending.promise);
    render(<StrictMode><LayoutTemplateManager {...props} /></StrictMode>);

    await waitFor(() => expect((screen.getByLabelText('模板名称') as HTMLInputElement).value).toBe('甲模板'));
    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '甲模板新名' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
    expect((screen.getByLabelText('模板名称') as HTMLInputElement).value).toBe('甲模板新名');
    expect((screen.getByRole('button', { name: /乙模板/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /乙模板/ }));
    expect((screen.getByLabelText('模板名称') as HTMLInputElement).value).toBe('甲模板新名');

    const renamed = template({ ...first, name: '甲模板新名' });
    client.list.mockResolvedValue(page([renamed, second]));
    await act(async () => pending.resolve(renamed));
    await waitFor(() => expect((screen.getByLabelText('模板名称') as HTMLInputElement).value).toBe('甲模板新名'));
    fireEvent.click(screen.getByRole('button', { name: /乙模板/ }));
    expect((screen.getByLabelText('模板名称') as HTMLInputElement).value).toBe('乙模板');
    expect(client.rename).toHaveBeenCalledWith('first', '甲模板新名');
  });

  it('deactivates the family, refreshes and never selects a disabled template', async () => {
    const { props, client } = setup();
    render(<LayoutTemplateManager {...props} />);
    await screen.findByRole('heading', { name: '常用回单' });
    client.list.mockResolvedValue(page([]));
    fireEvent.click(screen.getByRole('button', { name: '停用此模板' }));
    await screen.findByRole('heading', { name: '暂无可用版式模板' });
    expect(client.deactivate).toHaveBeenCalledWith('template-a');
    expect(props.onChanged).toHaveBeenCalledOnce();
    expect(props.onChanged).toHaveBeenCalledWith(expect.objectContaining({ active: false }), 'deactivate');
    client.list.mockResolvedValue(page([template({ active: false })]));
    fireEvent.click(screen.getByRole('checkbox', { name: '显示已停用模板' }));
    await screen.findByRole('heading', { name: '常用回单' });
    expect((screen.getByRole('button', { name: '选用此模板' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '停用此模板' }) as HTMLButtonElement).disabled).toBe(true);
    expect(client.list.mock.calls.at(-1)?.[0].active_only).toBe(false);
  });

  it('uses the returned pagination offset and supports returning to the prior page', async () => {
    const { props, client } = setup();
    const first = Array.from({ length: 10 }, (_, index) => template({ id: `t${index}` }));
    client.list.mockResolvedValueOnce({ items: first, total: 11, next_offset: 10 })
      .mockResolvedValueOnce({ items: [template({ id: 'last', name: '最后模板' })], total: 11, next_offset: null })
      .mockResolvedValueOnce({ items: first, total: 11, next_offset: 10 });
    render(<LayoutTemplateManager {...props} />);
    await screen.findByRole('heading', { name: '常用回单' });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByRole('heading', { name: '最后模板' });
    expect(client.list.mock.calls[1][0]).toMatchObject({ offset: 10, limit: 10 });
    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    await screen.findByRole('heading', { name: '常用回单' });
    expect(client.list.mock.calls[2][0].offset).toBe(0);
  });

  it('ignores an obsolete load when the filter changes or the panel unmounts', async () => {
    const { props, client } = setup();
    const old = deferred<LayoutTemplatePage>();
    client.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([template({ name: '当前模板' })]));
    const view = render(<LayoutTemplateManager {...props} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '显示已停用模板' }));
    await screen.findByRole('heading', { name: '当前模板' });
    expect((client.list.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    await act(async () => old.resolve(page([template({ name: '过期模板' })])));
    expect(screen.queryByText('过期模板')).toBeNull();
    view.unmount();
    expect((client.list.mock.calls[1][1] as AbortSignal).aborted).toBe(true);
  });

  it('reports failed writes without announcing a change and supports retry', async () => {
    const { props, client } = setup();
    client.deactivate.mockRejectedValueOnce(new Error('模板写入失败'));
    render(<LayoutTemplateManager {...props} />);
    await screen.findByRole('heading', { name: '常用回单' });
    fireEvent.click(screen.getByRole('button', { name: '停用此模板' }));
    expect((await screen.findByRole('alert')).textContent).toBe('模板写入失败');
    expect(props.onChanged).not.toHaveBeenCalled();
    client.list.mockResolvedValue(page([]));
    fireEvent.click(screen.getByRole('button', { name: '停用此模板' }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
  });

  it('does not apply an old write response to a replacement client or selection', async () => {
    const original = setup(), replacement = setup([template({ id: 'replacement', name: '新的模板' })]);
    const pending = deferred<LayoutTemplate>(); original.client.rename.mockReturnValueOnce(pending.promise);
    const view = render(<LayoutTemplateManager {...original.props} />);
    const input = await screen.findByLabelText('模板名称');
    fireEvent.change(input, { target: { value: '旧的改名' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
    view.rerender(<LayoutTemplateManager {...replacement.props} />);
    await screen.findByRole('heading', { name: '新的模板' });
    await act(async () => pending.resolve(template({ name: '旧的改名' })));
    expect(screen.queryByText('旧的改名')).toBeNull();
    expect(original.props.onChanged).not.toHaveBeenCalled();
    expect(replacement.props.onChanged).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '选用此模板' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
