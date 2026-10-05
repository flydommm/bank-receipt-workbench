// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReceiptCalibrationPane } from './ReceiptCalibrationWorkspace';
import type { ReceiptGroupingPanel } from './ReceiptGroupingPanel';
import { ReceiptCalibrationController, type ReceiptCalibrationState, type ReceiptReviewSession } from '../services/receiptCalibrationController';
import type { ReceiptLayoutClient } from '../services/receiptLayoutClient';
import { syntheticReview, syntheticSnapshot } from '../domain/receiptGrouping.testFixtures';

// Exercise the real stage owner; panel internals, PDF rendering and export writes
// have their own tests and are deliberately kept out of this transition suite.
vi.mock('./ReceiptOverview', () => ({ ReceiptOverview: (props: { canExport: boolean; primaryActionLabel: string; onExport: () => void }) =>
  <section aria-label="分割审核"><h2>检查与处理</h2>{props.canExport && <button onClick={props.onExport}>{props.primaryActionLabel}</button>}</section> }));
vi.mock('./ReceiptGroupingPreview', () => ({ ReceiptGroupingPreview: () => <p>合成原件</p> }));
vi.mock('./ReceiptGroupingPanel', () => ({ ReceiptGroupingPanel: (props: ComponentProps<typeof ReceiptGroupingPanel>) => {
  const [position, setPosition] = useState(1);
  return <section aria-label="分组核对" data-active={props.active}>
    <h2>核对交易对手与分组</h2><p>当前位置 {position}</p>
    <button onClick={() => setPosition(2)}>选择第二组</button>
    <button onClick={() => props.onSnapshotChange?.(syntheticSnapshot())}>形成分组</button>
    <button onClick={() => {
      const snapshot = syntheticSnapshot();
      snapshot.header.counts.counterparty_pending = 1; snapshot.header.counts.assigned = 0;
      snapshot.items[0].route = 'counterparty_pending'; snapshot.items[0].group = { ...snapshot.items[0].group!, kind: 'counterparty_pending' };
      snapshot.items[0].own_decision = { status: 'confirmed', method: 'batch_profile', side: null, source_bank_status: 'unknown', reasons: ['own_account_missing'] };
      props.onSnapshotChange?.(snapshot);
    }}>批次本方与待确认对手</button>
    <button onClick={() => props.onBusyChange?.(true)}>开始保存</button>
    <button onClick={() => props.onBusyChange?.(false)}>保存结束</button>
    <button onClick={() => props.onSnapshotChange?.({ ...syntheticSnapshot(), header: { ...syntheticSnapshot().header,
      counts: { ...syntheticSnapshot().header.counts, own_pending: 1 } } })}>本方待确认</button>
    <button onClick={props.onBack}>返回分割审核</button>
    <button onClick={props.onBackToAnalysis}>返回分析</button>
    <button onClick={props.onRemoveSources}>清除来源</button>
    <button onClick={() => props.onSelectSegment?.(props.reviewItems[0].original.id)}>回查所选片段</button>
    <button disabled={!props.canExport} onClick={props.onExport}>检查并导出</button>
  </section>;
} }));
vi.mock('./ReceiptExportWorkspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ReceiptExportWorkspace')>();
  return { ...actual, ReceiptExportWorkspace: ({ onClose }: { onClose: () => void }) =>
    <section aria-label="导出设置"><button onClick={onClose}>返回核对</button></section> };
});

function setupState() {
  const grouping = syntheticSnapshot();
  const controller = new ReceiptCalibrationController({} as ReceiptLayoutClient, vi.fn());
  const state: ReceiptCalibrationState = { ...controller.getSnapshot(), session: {
    prepared: { binding: { contextKey: 'synthetic-context', job: {
      id: grouping.header.job_id, result_revision: grouping.header.result_revision,
      sources: [{ source_key: grouping.items[0].binding.source_key, name: '合成回单.pdf',
        access_path: 'c:/synthetic/source.pdf', sha256: grouping.items[0].binding.source_sha256, page_count: 1 }],
    } }, prepared: { context_key: 'synthetic-context', result_revision: grouping.header.result_revision } },
    items: grouping.items.map(syntheticReview),
  } as ReceiptReviewSession };
  return { state, controller };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('分割审核与交易对手分组的阶段衔接', () => {
  it('审核期间不挂载分组，自动候选完成必要审核即可主动进入', () => {
    const { state, controller } = setupState();
    const view = render(<ReceiptCalibrationPane state={state} controller={controller} groupingEnabled onBack={vi.fn()} onExport={vi.fn()} />);
    expect(screen.queryByText('核对交易对手与分组')).toBeNull();
    const pending = { ...state, session: { ...state.session!, items: state.session!.items.map(item => ({ ...item, original: { ...item.original, needs_review: true } })) } };
    view.rerender(<ReceiptCalibrationPane state={pending} controller={controller} groupingEnabled onBack={vi.fn()} onExport={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '进入交易对手分组' })).toBeNull();
    view.rerender(<ReceiptCalibrationPane state={state} controller={controller} groupingEnabled onBack={vi.fn()} onExport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
    expect(screen.getByRole('region', { name: '分组核对' }).dataset.active).toBe('true');
    expect(screen.queryByRole('heading', { name: '检查与处理' })).toBeNull();
    expect(screen.getByRole('button', { name: '检查并导出' })).toHaveProperty('disabled', true);
  });

  it('往返保持实例及位置，稳定快照允许进入导出并返回分组', () => {
    const { state, controller } = setupState(), onExport = vi.fn();
    render(<ReceiptCalibrationPane state={state} controller={controller} groupingEnabled onBack={vi.fn()} onExport={onExport} />);
    fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
    fireEvent.click(screen.getByRole('button', { name: '形成分组' }));
    fireEvent.click(screen.getByRole('button', { name: '选择第二组' }));
    fireEvent.click(screen.getByRole('button', { name: '返回分割审核' }));
    expect(screen.getByRole('region', { name: '分组核对', hidden: true }).dataset.active).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
    expect(screen.getByText('当前位置 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '检查并导出' }));
    expect(onExport).toHaveBeenCalledOnce();
    expect(screen.getByRole('region', { name: '导出设置' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回核对' }));
    expect(screen.getByRole('region', { name: '分组核对' }).dataset.active).toBe('true');
  });

  it('审核记录变化撤回旧导出，需从审核页重新进入', () => {
    const { state, controller } = setupState();
    const props = { controller, groupingEnabled: true, onBack: vi.fn(), onExport: vi.fn() };
    const view = render(<ReceiptCalibrationPane {...props} state={state} />);
    fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
    fireEvent.click(screen.getByRole('button', { name: '形成分组' }));
    fireEvent.click(screen.getByRole('button', { name: '检查并导出' }));
    const changed = { ...state, session: { ...state.session!, items: state.session!.items.map(item => ({ ...item, record_revision: 1 })) } };
    view.rerender(<ReceiptCalibrationPane {...props} state={changed} />);
    expect(screen.queryByRole('region', { name: '导出设置' })).toBeNull();
    expect(screen.getByRole('heading', { name: '检查与处理' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
    expect(screen.getByRole('button', { name: '检查并导出' })).toHaveProperty('disabled', true);
  });

  it('导出返回后可直接返回分析或确认清除来源，取消与保存期间均不清除', () => {
    const { state, controller } = setupState(), onBack = vi.fn(), onRemoveSources = vi.fn();
    render(<ReceiptCalibrationPane state={state} controller={controller} groupingEnabled onBack={onBack}
      onExport={vi.fn()} onRemoveSources={onRemoveSources} />);
    fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
    fireEvent.click(screen.getByRole('button', { name: '形成分组' }));
    fireEvent.click(screen.getByRole('button', { name: '检查并导出' }));
    fireEvent.click(screen.getByRole('button', { name: '返回核对' }));
    fireEvent.click(screen.getByRole('button', { name: '返回分析' }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(onRemoveSources).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '清除来源' }));
    expect(screen.getByRole('button', { name: '确认清除来源' })).toBeTruthy();
    expect(onRemoveSources).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消清除' }));
    expect(screen.queryByRole('button', { name: '确认清除来源' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '开始保存' }));
    fireEvent.click(screen.getByRole('button', { name: '返回分析' }));
    fireEvent.click(screen.getByRole('button', { name: '清除来源' }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '确认清除来源' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存结束' }));
    fireEvent.click(screen.getByRole('button', { name: '清除来源' }));
    fireEvent.click(screen.getByRole('button', { name: '开始保存' }));
    expect(screen.getByRole('button', { name: '确认清除来源' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '确认清除来源' }));
    expect(onRemoveSources).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存结束' }));
    fireEvent.click(screen.getByRole('button', { name: '确认清除来源' }));
    expect(onRemoveSources).toHaveBeenCalledOnce();
  });

  it('保存和本方待确认均阻止导出；回查定位到当前审核片段', () => {
    const { state, controller } = setupState();
    const select = vi.spyOn(controller, 'select');
    render(<ReceiptCalibrationPane state={state} controller={controller} groupingEnabled onBack={vi.fn()} onExport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
    fireEvent.click(screen.getByRole('button', { name: '形成分组' }));
    fireEvent.click(screen.getByRole('button', { name: '开始保存' }));
    expect(screen.getByRole('button', { name: '检查并导出' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '返回分割审核' }));
    expect(screen.getByRole('region', { name: '分组核对' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存结束' }));
    fireEvent.click(screen.getByRole('button', { name: '本方待确认' }));
    expect(screen.getByRole('button', { name: '检查并导出' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '回查所选片段' }));
    expect(select).toHaveBeenCalledWith(state.session!.items[0].original.id);
    expect(screen.getByRole('heading', { name: '检查与处理' })).toBeTruthy();
  });

  it('全排除无分组入口；未启用分组仍从审核直接导出', () => {
    const { state, controller } = setupState();
    const props = { controller, onBack: vi.fn(), onExport: vi.fn() };
    const excluded = { ...state, session: { ...state.session!, items: state.session!.items.map(item => ({ ...item,
      record: { review_status: 'excluded', final_rect: item.original.candidate_rect } as typeof item.record })) } };
    const view = render(<ReceiptCalibrationPane {...props} state={excluded} groupingEnabled />);
    expect(screen.queryByRole('button', { name: '进入交易对手分组' })).toBeNull();
    view.rerender(<ReceiptCalibrationPane {...props} state={state} />);
    fireEvent.click(screen.getByRole('button', { name: '导出回单' }));
    expect(screen.getByRole('region', { name: '导出设置' })).toBeTruthy();
    expect(screen.queryByText('核对交易对手与分组')).toBeNull();
  });

  it('批次本方即使未知收付款侧和来源银行，交易对手待确认仍可进入导出设置', () => {
    const { state, controller } = setupState(); const onExport = vi.fn();
    render(<ReceiptCalibrationPane state={state} controller={controller} groupingEnabled onBack={vi.fn()} onExport={onExport} />);
    fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
    fireEvent.click(screen.getByRole('button', { name: '批次本方与待确认对手' }));
    expect(screen.getByRole('button', { name: '检查并导出' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: '检查并导出' }));
    expect(onExport).toHaveBeenCalledOnce();
    expect(screen.getByRole('region', { name: '导出设置' })).toBeTruthy();
  });
});
