import { describe, expect, it, vi } from 'vitest';
import { ExportBundleClient, type ExportBundlePreview } from './exportBundleClient';
import { exportProgressChannel, parseExportProgress } from './exportProgress';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class { constructor(public onmessage: (value: unknown) => void) {} },
}));

const frame = { type: 'export_progress', stage: 'rendering', completed: 4, total: 10, unit: 'pages' };

describe('export progress channel', () => {
  it('accepts real stage counts and explicitly indeterminate stages', () => {
    expect(parseExportProgress(frame)).toEqual({ stage: 'rendering', completed: 4, total: 10, unit: 'pages' });
    expect(parseExportProgress({ ...frame, stage: 'writing_pdf', completed: null, total: null, unit: null }))
      .toEqual({ stage: 'writing_pdf', completed: null, total: null, unit: null });
    for (const invalid of [{ ...frame, completed: 11 }, { ...frame, total: 0 }, { ...frame, completed: 1.5 },
      { ...frame, total: 100_001 }, { ...frame, stage: 'unknown' }, { ...frame, unit: null }, { ...frame, total: null },
      { status: 'ok' }]) expect(parseExportProgress(invalid)).toBeNull();
  });

  it('isolates concurrent requests and drops malformed and late events after closing', () => {
    const first = vi.fn(), second = vi.fn();
    const a = exportProgressChannel(first), b = exportProgressChannel(second);
    a.channel.onmessage(frame);
    expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
    a.close(); a.channel.onmessage(frame); b.channel.onmessage({ ...frame, completed: 8 });
    b.channel.onmessage({ ...frame, completed: 80 });
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
  });

  it.each(['create', 'publish'] as const)('%s forwards live progress but keeps it separate from result validation and releases the channel on failure', async (operation) => {
    const onProgress = vi.fn();
    let channel!: { onmessage: (value: unknown) => void };
    const call = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      channel = args!.onProgress as typeof channel;
      channel.onmessage(frame);
      return { status: 'error', code: 'export_failed', message: 'test failure' };
    });
    const client = new ExportBundleClient(call as any, { onProgress });
    const pending = operation === 'create'
      ? client.create({ job_id: 'job', result_revision: 'revision', scope_kind: 'list', selected_segment_ids: ['one'],
        expected_records: [{ id: 'one', record_revision: 0 }], output_mode: 'merged', include_xlsx: false })
      : client.publish({ intent_id: '12345678-1234-1234-1234-123456789012' } as ExportBundlePreview, '/output');
    await expect(pending).rejects.toThrow('test failure');
    expect(onProgress).toHaveBeenCalledOnce();
    channel.onmessage(frame);
    expect(onProgress).toHaveBeenCalledOnce();
  });
});
