// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syntheticHash, syntheticReview, syntheticSnapshot } from '../domain/receiptGrouping.testFixtures';
import type { ReceiptGroupingSnapshot } from '../domain/receiptGrouping';
import { ReceiptGroupingClient } from '../services/receiptGroupingClient';
import { ReceiptFieldRuleClient } from '../services/receiptFieldRuleClient';
import type { FieldRuleOperation } from '../domain/receiptFieldRules';
import { ReceiptCalibrationController, type ReceiptCalibrationState, type ReceiptReviewSession } from '../services/receiptCalibrationController';
import type { ReceiptLayoutClient } from '../services/receiptLayoutClient';
import { ReceiptCalibrationPane } from './ReceiptCalibrationWorkspace';
import { localEngineAdapter, type EnginePagePreview } from './localEngineAdapter';

// The overview is only a stage-transition seam here. The grouping panel itself stays real.
vi.mock('./ReceiptOverview', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ReceiptOverview')>(),
  ReceiptOverview: (props: { canExport: boolean; primaryActionLabel: string; onExport: () => void }) => (
    <section aria-label="分割审核">
      <h2>检查与处理</h2>
      {props.canExport && <button type="button" onClick={props.onExport}>{props.primaryActionLabel}</button>}
    </section>
  ),
}));

// Keep receiptExportContextKey and the parent export transition real, while avoiding
// native output-folder/export calls in this transition test.
vi.mock('./ReceiptExportWorkspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ReceiptExportWorkspace')>();
  return {
    ...actual,
    ReceiptExportWorkspace: ({ onClose }: { onClose: () => void }) => (
      <section aria-label="导出设置">
        <strong>按交易对手导出</strong>
        <button type="button" onClick={onClose}>返回核对</button>
      </section>
    ),
  };
});

const sourceSha = syntheticHash(101);

function makeGroupingSnapshot(overrides: Partial<ReceiptGroupingSnapshot['header']['counts']> = {}): ReceiptGroupingSnapshot {
  const snapshot = syntheticSnapshot();
  return {
    ...snapshot,
    header: {
      ...snapshot.header,
      counts: { ...snapshot.header.counts, ...overrides },
    },
  };
}

function setupState() {
  const grouping = makeGroupingSnapshot();
  const controller = new ReceiptCalibrationController({} as ReceiptLayoutClient, vi.fn());
  const state: ReceiptCalibrationState = {
    ...controller.getSnapshot(),
    phase: 'results',
    session: {
      prepared: {
        binding: {
          contextKey: 'synthetic-context',
          job: {
            id: grouping.header.job_id,
            result_revision: grouping.header.result_revision,
            sources: [{ source_key: grouping.items[0].binding.source_key, name: '合成回单.pdf',
              access_path: grouping.items[0].binding.source_key, sha256: grouping.items[0].binding.source_sha256, page_count: 1 }],
          },
        },
        prepared: { context_key: 'synthetic-context', result_revision: grouping.header.result_revision },
      },
      items: grouping.items.map(syntheticReview),
    } as ReceiptReviewSession,
  };
  return { state, controller, grouping };
}

function preview(page: number, sha = sourceSha): EnginePagePreview {
  return { status: 'ok', page, page_count: 1, page_width: 600, page_height: 900,
    source_sha256: sha, image_data: `data:image/png;base64,synthetic-page-${page}` };
}

function pendingSnapshot(count = 1): ReceiptGroupingSnapshot {
  const snapshot = syntheticSnapshot(count);
  snapshot.header.counts.counterparty_pending = count; snapshot.header.counts.assigned = 0;
  snapshot.items.forEach((item) => { item.route = 'counterparty_pending'; item.counterparty = null; item.group = { ...item.group!, kind: 'counterparty_pending', display_name: '交易对手待确认' }; });
  return snapshot;
}

function stubGroupingClient(base = makeGroupingSnapshot()) {
  let reviewRevision = 0;
  const currentSnapshot = () => {
    const snapshot = structuredClone(base);
    return { ...snapshot, items: snapshot.items.map((item) => ({ ...item,
      binding: { ...item.binding, review_record_revision: reviewRevision },
    })) };
  };
  const prepare = vi.spyOn(ReceiptGroupingClient.prototype, 'prepare').mockImplementation(async (jobId, resultRevision) => {
    const snapshot = currentSnapshot();
    return { ...snapshot.header, job_id: jobId, result_revision: resultRevision };
  });
  const loadAll = vi.spyOn(ReceiptGroupingClient.prototype, 'loadAll').mockImplementation(async (header) => {
    const snapshot = currentSnapshot();
    return { ...snapshot, header: { ...snapshot.header, job_id: header.job_id, result_revision: header.result_revision } };
  });
  const refreshAll = vi.spyOn(ReceiptGroupingClient.prototype, 'refreshAll').mockImplementation(async (snapshot) => snapshot);
  return { prepare, loadAll, refreshAll, setReviewRevision: (value: number) => { reviewRevision = value; } };
}

function exportButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^(检查并导出|导出结果)$/ }) as HTMLButtonElement;
}

async function enterAndWait(state: ReceiptCalibrationState, controller: ReceiptCalibrationController) {
  render(<ReceiptCalibrationPane state={state} controller={controller} groupingEnabled onBack={vi.fn()} onExport={vi.fn()} />);
  expect(screen.queryByRole('region', { name: '交易对手核对与分组' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
  await waitFor(() => expect(screen.getByRole('region', { name: '交易对手核对与分组' })).toBeTruthy());
}

beforeEach(() => {
  vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue(preview(1));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('真实交易对手分组面板与父阶段联动', () => {
  it('父阶段实际框选后分块试读超过200张，一次应用并恢复导出；不发送名称或原件路径', async () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    const { state, controller } = setupState();
    const loaded = pendingSnapshot(251); const ready = syntheticSnapshot(251);
    state.session!.items = loaded.items.map(syntheticReview);
    state.session!.prepared.binding.job.sources[0].page_count = 251;
    vi.spyOn(localEngineAdapter, 'renderPage').mockResolvedValue({ ...preview(1), page_count: 251 });
    vi.spyOn(ReceiptGroupingClient.prototype, 'prepare').mockResolvedValue(loaded.header);
    vi.spyOn(ReceiptGroupingClient.prototype, 'loadAll').mockImplementation(async (header) => ({ ...(header.grouping_revision === 2 ? ready : loaded), header }));
    const op = (completed: number, status: FieldRuleOperation['status'] = completed === 251 ? 'ready' : 'preparing'): FieldRuleOperation => ({ operation_id: 'trial-full', status, total: 251, completed, eligible: 251, skipped: 0, changed: completed, unresolved: 0, can_save_rule: true, rule_id: null });
    const prepareRule = vi.spyOn(ReceiptFieldRuleClient.prototype, 'prepare').mockResolvedValue(op(0));
    const step = vi.spyOn(ReceiptFieldRuleClient.prototype, 'step').mockImplementation(async (_job, operation) => op(Math.min(251, operation.completed + 50)));
    vi.spyOn(ReceiptFieldRuleClient.prototype, 'page').mockImplementation(async (_job, _operation, offset = 0, limit = 200) => ({ operation: op(251), items: loaded.items.slice(offset, offset + limit).map((item, index) => ({ segment_id: item.binding.segment_id, before_name: '未读到', after_name: (offset + index) % 2 ? '合成对手乙' : '合成对手甲', before_route: 'counterparty_pending', after_route: 'named', status: 'changed', reason: '可应用新读取结果' })), next_offset: offset + limit < 251 ? offset + limit : null }));
    const apply = vi.spyOn(ReceiptFieldRuleClient.prototype, 'apply').mockResolvedValue({ header: { ...ready.header, grouping_revision: 2 }, operation: op(251, 'applied') });
    const save = vi.spyOn(ReceiptGroupingClient.prototype, 'save');
    await enterAndWait(state, controller); await waitFor(() => expect(exportButton().disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '更多工具' }));
    fireEvent.click(screen.getByRole('button', { name: '同版式批量识别' }));
    await waitFor(() => expect(exportButton().disabled).toBe(true));
    expect((screen.getByRole('button', { name: '返回分割审核' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '返回分析' }) as HTMLButtonElement).disabled).toBe(true);
    const svg = await screen.findByRole('img', { name: /合成回单/ });
    Object.defineProperty(svg, 'getScreenCTM', { value: () => ({ a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 }) });
    fireEvent.pointerDown(svg, { clientX: 130, clientY: 140, button: 0 });
    fireEvent.pointerMove(svg, { clientX: 730, clientY: 260, button: 0 });
    fireEvent.pointerUp(svg, { clientX: 730, clientY: 260, button: 0 });
    expect((screen.getByRole('button', { name: '试读同版式回单' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '试读同版式回单' }));
    await screen.findByRole('option', { name: /合成对手乙 ·/ });
    expect(step).toHaveBeenCalledTimes(6);
    expect(prepareRule.mock.calls[0][1]).toEqual({ prototype_segment_id: loaded.items[0].binding.segment_id, mode: 'auto', fields: [{ role: 'counterparty', field: 'name', rect: { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.4 } }], include_resolved: false });
    fireEvent.click(screen.getByRole('button', { name: '确认应用 251 张' }));
    await waitFor(() => expect(exportButton().disabled).toBe(false), { timeout: 10000 });
    expect(apply).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '同版式批量识别' })).toBeNull();
    expect(screen.getByRole('button', { name: '撤销最近一次读取应用', hidden: true })).toBeTruthy();
  }, 30000);

  it('父阶段停止在途试读后不开始后续步骤、不应用，关闭后恢复核对', async () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    const { state, controller } = setupState(); stubGroupingClient(pendingSnapshot());
    const op: FieldRuleOperation = { operation_id: 'trial-stop', status: 'preparing', total: 1, completed: 0, eligible: 1, skipped: 0, changed: 0, unresolved: 0, can_save_rule: false, rule_id: null };
    vi.spyOn(ReceiptFieldRuleClient.prototype, 'prepare').mockResolvedValue(op);
    let resolveStep!: (value: FieldRuleOperation) => void;
    const step = vi.spyOn(ReceiptFieldRuleClient.prototype, 'step').mockReturnValue(new Promise((resolve) => { resolveStep = resolve; }));
    const cancel = vi.spyOn(ReceiptFieldRuleClient.prototype, 'cancel').mockResolvedValue({ ...op, status: 'cancelled' });
    const apply = vi.spyOn(ReceiptFieldRuleClient.prototype, 'apply');
    await enterAndWait(state, controller); await waitFor(() => expect(exportButton().disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '更多工具' }));
    fireEvent.click(screen.getByRole('button', { name: '同版式批量识别' }));
    const svg = await screen.findByRole('img', { name: /合成回单/ });
    Object.defineProperty(svg, 'getScreenCTM', { value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
    fireEvent.pointerDown(svg, { clientX: 20, clientY: 20, button: 0 }); fireEvent.pointerUp(svg, { clientX: 200, clientY: 50, button: 0 });
    fireEvent.click(screen.getByRole('button', { name: '试读同版式回单' })); await waitFor(() => expect(step).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '停止试读' })); resolveStep({ ...op, completed: 1, status: 'ready' });
    await screen.findByText('试读已停止，原分组未改变。'); expect(cancel).toHaveBeenCalledTimes(1); expect(apply).not.toHaveBeenCalled(); expect(step).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' })); await waitFor(() => expect(exportButton().disabled).toBe(false));
  });

  it('进入前不准备，点击入口后自动 prepare/load，稳定快照允许导出', async () => {
    const { state, controller } = setupState();
    const { prepare, loadAll, refreshAll } = stubGroupingClient();
    await enterAndWait(state, controller);

    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(refreshAll).not.toHaveBeenCalled();
    await waitFor(() => expect(exportButton().disabled).toBe(false));
    expect(screen.getByRole('button', { name: '单张核对' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('group', { name: '单张预览缩放' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '回查分割审核定位' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '分组回单片段总览' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '片段总览' }));
    expect(screen.getByRole('region', { name: '分组回单片段总览' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开 第 1 页 · 第 1 栏' }));
    expect(screen.queryByRole('region', { name: '分组回单片段总览' })).toBeNull();
    expect(screen.getByRole('button', { name: '单张核对' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('真实面板导出后等待状态稳定，返回分组保留快照且不重复 prepare', async () => {
    const { state, controller } = setupState();
    const onExport = vi.fn();
    const { prepare } = stubGroupingClient();
    render(<ReceiptCalibrationPane state={state} controller={controller} groupingEnabled onBack={vi.fn()} onExport={onExport} />);
    fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
    await waitFor(() => expect(exportButton().disabled).toBe(false));
    fireEvent.click(exportButton());
    await waitFor(() => expect(screen.getByRole('region', { name: '导出设置' })).toBeTruthy());
    expect(onExport).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('region', { name: '导出设置' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '返回核对' }));
    await waitFor(() => expect(screen.getByRole('region', { name: '交易对手核对与分组' })).toBeTruthy());
    await waitFor(() => expect(exportButton().disabled).toBe(false));
    expect(screen.getAllByText('合成对手').length).toBeGreaterThan(0);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('审核记录变化后回到审核页，必须再次主动进入；active=false 不会重新请求', async () => {
    const { state, controller } = setupState();
    const { prepare, setReviewRevision } = stubGroupingClient();
    const view = render(<ReceiptCalibrationPane state={state} controller={controller} groupingEnabled onBack={vi.fn()} onExport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
    await waitFor(() => expect(exportButton().disabled).toBe(false));

    const changed: ReceiptCalibrationState = {
      ...state,
      session: { ...state.session!, items: state.session!.items.map((item) => ({ ...item, record_revision: item.record_revision + 1 })) },
    };
    setReviewRevision(1);
    view.rerender(<ReceiptCalibrationPane state={changed} controller={controller} groupingEnabled onBack={vi.fn()} onExport={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: '检查与处理' })).toBeTruthy());
    expect(prepare).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prepare).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(exportButton().disabled).toBe(false));
  });

  it('审核阶段临时 disabled 后重新显示分组，不把 disabled 误记为 busy；任务版本变化卸载旧面板', async () => {
    const { state, controller } = setupState();
    const { prepare } = stubGroupingClient();
    const view = render(<ReceiptCalibrationPane state={state} controller={controller} groupingEnabled onBack={vi.fn()} onExport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '进入交易对手分组' }));
    await waitFor(() => expect(exportButton().disabled).toBe(false));

    const confirming: ReceiptCalibrationState = { ...state, reviewConfirming: true };
    view.rerender(<ReceiptCalibrationPane state={confirming} controller={controller} groupingEnabled onBack={vi.fn()} onExport={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: '检查与处理' })).toBeTruthy());
    expect(prepare).toHaveBeenCalledTimes(1);

    view.rerender(<ReceiptCalibrationPane state={state} controller={controller} groupingEnabled onBack={vi.fn()} onExport={vi.fn()} />);
    await waitFor(() => expect(exportButton().disabled).toBe(false));
    expect(screen.getAllByText('合成对手').length).toBeGreaterThan(0);
    expect(prepare).toHaveBeenCalledTimes(1);

    const nextState: ReceiptCalibrationState = {
      ...state,
      session: {
        ...state.session!,
        prepared: {
          ...state.session!.prepared,
          binding: { ...state.session!.prepared.binding, job: { ...state.session!.prepared.binding.job, id: 'synthetic-job-next', result_revision: 'result-next' } },
          prepared: { ...state.session!.prepared.prepared, result_revision: 'result-next' },
        },
      },
    };
    view.rerender(<ReceiptCalibrationPane state={nextState} controller={controller} groupingEnabled onBack={vi.fn()} onExport={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('region', { name: '交易对手核对与分组' })).toBeNull());
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
