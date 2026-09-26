import { describe, expect, it, vi } from 'vitest';
import { LayoutTemplateClient, layoutDefinitionSlots, compatibleLayoutTemplate } from './layoutTemplateClient';
import type { LayoutDefinition } from '../domain/receiptLayout';

const response = (data: unknown) => ({ status: 'ok', data });
const geometry = { pdf_box: { x0: 0, y0: 0, x1: 600, y1: 900 }, rotation: 0, user_unit: 1, width_pt: 600, height_pt: 900 } as const;
const slot = { slot_id: 'slot-1', position_index: 1, rect: { x0: 0, y0: 0, x1: 600, y1: 300 } };
const template = { id: 't1', version: 1, name: '上海银行', source_scope: 'workspace-a', page_geometry: geometry,
  layout_fingerprint: 'a'.repeat(64), slots: [slot], evidence_summary: { sample_page: 2 }, source_operation_id: 'op-1', active: true,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };

describe('LayoutTemplateClient', () => {
  it('matches update candidates by verified layout identity and runtime scope, never by bank display name', () => {
    const layout: LayoutDefinition = { schema_version: 1, layout_id: 'layout', revision: 1, workspace_id: 'current',
      issuer_id: 'bank', family_id: 'family', evidence_version: 'v1', page_geometry: geometry, uniform_height: false,
      left_pt: 0, right_pt: 0, slots: [{ slot_id: 'slot-1', position_index: 1, top_pt: 0, height_pt: 300 }] };
    const candidate = { ...template, bank_name: '任意显示名称', evidence_summary: { layout_definition: { ...layout, left_pt: 5 } } };
    expect(compatibleLayoutTemplate(candidate, layout)).toBe(true);
    for (const changed of [{ workspace_id: 'other-runtime' }, { issuer_id: 'other' }, { family_id: 'other' }, { evidence_version: 'v2' },
      { page_geometry: { ...geometry, rotation: 180 } }, { slots: [{ ...layout.slots[0], slot_id: 'other' }] }]) {
      expect(compatibleLayoutTemplate({ ...candidate, evidence_summary: { layout_definition: { ...layout, ...changed } } }, layout)).toBe(false);
    }
    expect(compatibleLayoutTemplate({ ...candidate, active: false }, layout)).toBe(false);
    expect(compatibleLayoutTemplate({ ...candidate, evidence_summary: {} }, layout)).toBe(false);
  });
  it('preserves optional template series and bank display metadata while supporting old rows', async () => {
    const item = { ...template, series_id: 'series-a', bank_name: '上海银行' };
    const client = new LayoutTemplateClient(vi.fn().mockResolvedValue(response({ items: [item], total: 1, next_offset: null })));
    expect((await client.list({ active_only: true, offset: 0, limit: 10 })).items[0]).toMatchObject({ series_id: 'series-a', bank_name: '上海银行' });
  });
  it('lists bounded pages and renames without exposing private database paths', async () => {
    const transport = vi.fn().mockResolvedValueOnce(response({ items: [template], total: 2, next_offset: 1 }))
      .mockResolvedValueOnce(response({ ...template, name: '新名称' }));
    const client = new LayoutTemplateClient(transport);
    expect(await client.list({ active_only: true, offset: 0, limit: 1 })).toEqual({ items: [template], total: 2, next_offset: 1 });
    expect((await client.rename('t1', ' 新名称 ')).name).toBe('新名称');
    expect(transport.mock.calls[0][1].request).toEqual({ op: 'batch_layout_template_list', active_only: true, offset: 0, limit: 1 });
    expect(transport.mock.calls[1][1].request).toEqual({ op: 'batch_layout_template_rename', template_id: 't1', name: '新名称' });
  });

  it.each([
    { items: [template], total: 2, next_offset: null },
    { items: [template, template], total: 2, next_offset: null },
    { items: [{ ...template, active: false }], total: 1, next_offset: null },
    { items: [template], total: 2, next_offset: 0 },
  ])('rejects inconsistent pages', async (value) => {
    const client = new LayoutTemplateClient(vi.fn().mockResolvedValue(response(value)));
    await expect(client.list({ active_only: true, offset: 0, limit: 10 })).rejects.toThrow();
  });

  it('validates list bounds and names before invoking and rejects cancelled reads', async () => {
    const transport = vi.fn(), client = new LayoutTemplateClient(transport);
    await expect(client.list({ active_only: true, offset: 0, limit: 51 })).rejects.toThrow();
    for (const name of ['', '   ', 'a'.repeat(257), 'a\0b']) await expect(client.rename('t1', name)).rejects.toThrow('模板名称');
    const abort = new AbortController(); abort.abort();
    await expect(client.list({ active_only: true, offset: 0, limit: 10 }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('saves and matches a host-owned template without accepting a database path', async () => {
    const transport = vi.fn().mockResolvedValueOnce(response(template)).mockResolvedValueOnce(response(template));
    const client = new LayoutTemplateClient(transport);
    expect((await client.save({ source_scope: 'workspace-a', page_geometry: geometry, layout_fingerprint: 'a'.repeat(64), slots: [slot], evidence_summary: {}, source_operation_id: 'op-1' })).id).toBe('t1');
    expect((await client.match('workspace-a', geometry, 'a'.repeat(64), [slot]))?.version).toBe(1);
    expect(transport.mock.calls[0][1].request).not.toHaveProperty('template_database_path');
  });

  it('rejects malformed template responses and preserves slot rectangles', async () => {
    const malformed = { ...template, slots: [{ ...slot, rect: { ...slot.rect, y1: 901 } }] };
    await expect(new LayoutTemplateClient(vi.fn().mockResolvedValue(response(malformed))).save({ source_scope: 'workspace-a', page_geometry: geometry, layout_fingerprint: 'a'.repeat(64), slots: [slot], evidence_summary: {}, source_operation_id: 'op-1' })).rejects.toThrow('版式模板');
    const layout = { schema_version: 1, layout_id: 'l', revision: 1, workspace_id: 'w', issuer_id: null, family_id: null, evidence_version: 'e', page_geometry: geometry, uniform_height: true, left_pt: 0, right_pt: 0, slots: [{ slot_id: 'slot-1', position_index: 1, top_pt: 0, height_pt: 300 }] } as any;
    expect(layoutDefinitionSlots(layout)[0].rect.y1).toBe(300);
  });
});
