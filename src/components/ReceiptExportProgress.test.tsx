// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { formatExportElapsed, ReceiptExportProgress } from './ReceiptExportProgress';

afterEach(cleanup);
describe('ReceiptExportProgress', () => {
  it('labels counted progress as a stage and does not carry its percentage into an uncounted write', () => {
    const view = render(<ReceiptExportProgress progress={{ stage: 'rendering', completed: 2075, total: 4150, unit: 'pages' }} elapsed={301} waitingForDirectory={false} />);
    expect(screen.getByText('当前阶段：已完成 2075 / 4150 页（50%）')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('50');
    expect(screen.getByText('已用时 5 分 1 秒')).toBeTruthy();
    view.rerender(<ReceiptExportProgress progress={{ stage: 'writing_pdf', completed: null, total: null, unit: null }} elapsed={302} waitingForDirectory={false} />);
    expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
    expect(screen.getByText('正在写入 PDF 文件')).toBeTruthy();
    expect(screen.queryByText(/50%/)).toBeNull();
  });
  it('shows directory selection without inventing generation progress and formats long durations', () => {
    render(<ReceiptExportProgress progress={null} elapsed={1} waitingForDirectory />);
    expect(screen.getByText('等待选择导出目录')).toBeTruthy();
    expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
    expect(formatExportElapsed(3723)).toBe('1 小时 2 分 3 秒');
  });
});
