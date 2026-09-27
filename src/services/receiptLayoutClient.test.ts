// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ReceiptLayoutClient, type ReceiptLayoutPreparation, type ReceiptLayoutPreview } from './receiptLayoutClient';
import type { ReceiptBatchPreparedReview } from '../domain/receiptBatch';
import type { ReceiptBatchInvoke } from './receiptBatchClient';
import { parseLayoutDefinition } from '../domain/receiptLayout';
import fixture from '../../tests/fixtures/receipt_layout_v1.json';

const layout = parseLayoutDefinition(fixture.valid_cases[0].value.layout_definition);
const hash = 'a'.repeat(64);
const binding = { prepared: { result_revision: 'r', context_key: hash }, binding: { job: {
  id: 'j', sources: [{ source_key: '/a.pdf', page_count: 2 }],
} } } as ReceiptBatchPreparedReview;
const prepared: ReceiptLayoutPreparation = {
  schema_version: 1, job_id: 'j', result_revision: 'r', context_key: hash, sample_id: hash,
  selected_slot_id: layout.slots[0].slot_id, preparation_fingerprint: hash, layout_definition: layout,
  scope_kind: 'verified_layout', pages: [{ source_key: '/a.pdf', page: 1 }, { source_key: '/a.pdf', page: 2 }],
  page_count: 2, source_count: 1, excluded_page_counts: {},
};
function preview(): ReceiptLayoutPreview {
  return { schema_version: 1, job_id: 'j', result_revision: 'r', sample_id: hash, operation_id: 'op',
    preview_fingerprint: hash, layout_definition: layout, can_save: true, candidate_count: 2, page_count: 2, saved: false,
    affected: [1, 2].map((page) => ({ source_key: '/a.pdf', page, slot_id: layout.slots[0].slot_id,
      previous_id: hash, id: hash, before_rect: { x0: 0, y0: 10, x1: 500, y1: 200 },
      after_rect: { x0: 0, y0: 0, x1: 500, y1: 200 }, status: 'updated' })),
    risks: [], blockers: [], retained_record_ids: [], included_exception_ids: [],
  };
}
function templatePreview(): ReceiptLayoutPreview {
  return { ...preview(), mode: 'template_apply', template_id: 'template-A',
    applied_slot_ids: [layout.slots[0].slot_id], excluded_page_counts: { prior_review_scope: 1 },
    preserved_excluded_count: 1, template_allowed: false };
}
function stub(data: unknown) {
  const transport = vi.fn().mockResolvedValue({ status: 'ok', data });
  return { client: new ReceiptLayoutClient(transport as ReceiptBatchInvoke), transport };
}

describe('receipt calibration client', () => {
  it('previews a saved template in the current result without supplying a sample or draft', async () => {
    const expected = templatePreview();
    const { client, transport } = stub(expected);
    expect(await client.templateApplyPreview(binding, 'template-A')).toEqual(expected);
    expect(transport).toHaveBeenCalledWith('batch_command', { request: {
      op: 'batch_receipt_template_apply_preview', job_id: 'j', result_revision: 'r', template_id: 'template-A',
    } });
    await expect(client.save(expected, [], true, 'another template')).rejects.toThrow('可复用模板资格');
    transport.mockResolvedValue({ status: 'ok', data: { schema_version: 1, job_id: 'j', operation_id: 'op',
      result_revision: 'next', state: 'applied', saved_count: 2 } });
    await client.save(expected, [], false);
    expect(transport.mock.calls[1][1].request).toMatchObject({ remember_reference: false, template_id: null });
  });

  it.each(['wrong_revision', 'wrong_template', 'missing_mode', 'template_write_allowed', 'unknown_slot', 'wrong_source', 'negative_skip', 'negative_preserved', 'missing_preserved'])(
    'rejects an invalid template application preview: %s', async (caseName) => {
      const response = templatePreview();
      if (caseName === 'wrong_revision') response.result_revision = 'other';
      if (caseName === 'wrong_template') response.template_id = 'other';
      if (caseName === 'missing_mode') delete response.mode;
      if (caseName === 'template_write_allowed') delete response.template_allowed;
      if (caseName === 'unknown_slot') response.applied_slot_ids = ['foreign'];
      if (caseName === 'wrong_source') response.affected[0].source_key = '/foreign.pdf';
      if (caseName === 'negative_skip') response.excluded_page_counts = { prior_review_scope: -1 };
      if (caseName === 'negative_preserved') response.preserved_excluded_count = -1;
      if (caseName === 'missing_preserved') delete response.preserved_excluded_count;
      const { client } = stub(response);
      await expect(client.templateApplyPreview(binding, 'template-A')).rejects.toThrow('数据不完整');
    },
  );

  it('cancels a template preview whose result arrives after navigation', async () => {
    const controller = new AbortController();
    const transport = vi.fn().mockImplementationOnce(async () => {
      controller.abort(); return { status: 'ok', data: templatePreview() };
    }).mockResolvedValueOnce({ status: 'ok', data: { cancelled: true } });
    const client = new ReceiptLayoutClient(transport as ReceiptBatchInvoke);
    await expect(client.templateApplyPreview(binding, 'template-A', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.mock.calls[1][1].request).toEqual({ op: 'batch_receipt_calibration_cancel', job_id: 'j', operation_id: 'op' });
  });

  it('reports a long-running template preview timeout without claiming a saved draft', async () => {
    const { client, transport } = stub(templatePreview());
    transport.mockRejectedValueOnce('local engine operation timed out');
    await expect(client.templateApplyPreview(binding, 'template-A')).rejects.toMatchObject({
      code: 'calibration_timeout', message: '模板应用预览超时，当前分析结果未变，可以重试。',
    });
  });

  function protectedPreparation(): ReceiptLayoutPreparation {
    return { ...structuredClone(prepared), layout_definition: { ...structuredClone(layout), uniform_height: false },
      page_count: 1, pages: [prepared.pages[0]], editable_slot_ids: [prepared.selected_slot_id], template_allowed: false };
  }
  function protectedPreview(): ReceiptLayoutPreview {
    const result = preview();
    return { ...result, layout_definition: protectedPreparation().layout_definition, page_count: 1, candidate_count: 1,
      affected: [result.affected[0]], template_allowed: false };
  }
  it('preserves protected single-slot scope and refuses shared geometry changes before sending', async () => {
    const prep = protectedPreparation(); const { client, transport } = stub(prep);
    expect(await client.prepare(binding, hash)).toEqual(prep);
    transport.mockClear(); transport.mockResolvedValue({ status: 'ok', data: protectedPreview() });
    await expect(client.preview(binding, prep, { ...prep.layout_definition, left_pt: 1 })).rejects.toThrow();
    await expect(client.preview(binding, prep, { ...prep.layout_definition, uniform_height: true })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(await client.preview(binding, prep, prep.layout_definition)).toEqual(protectedPreview());
  });
  it.each(['missing_flag', 'missing_slots', 'wrong_slot', 'multiple_pages', 'uniform_height'])('rejects weakened protected preparation %s', async (invalid) => {
    const prep = protectedPreparation();
    if (invalid === 'missing_flag') delete prep.template_allowed;
    if (invalid === 'missing_slots') delete prep.editable_slot_ids;
    if (invalid === 'wrong_slot') prep.editable_slot_ids = ['unknown'];
    if (invalid === 'multiple_pages') { prep.pages = prepared.pages; prep.page_count = 2; }
    if (invalid === 'uniform_height') prep.layout_definition.uniform_height = true;
    const { client } = stub(prep);
    await expect(client.prepare(binding, hash)).rejects.toThrow('数据不完整');
  });
  it('rejects a protected preview without its prohibition and refuses saving it as a template', async () => {
    const result = protectedPreview(); delete result.template_allowed;
    const { client, transport } = stub(result);
    await expect(client.preview(binding, protectedPreparation(), protectedPreparation().layout_definition)).rejects.toThrow('数据不完整');
    transport.mockClear();
    await expect(client.save(protectedPreview(), [], true, '不得复用')).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('accepts an identity-ineligible full-page scope and keeps ordinary round saving available', async () => {
    const identitylessLayout = { ...structuredClone(layout), issuer_id: null, family_id: null };
    const prep: ReceiptLayoutPreparation = { ...structuredClone(prepared), layout_definition: identitylessLayout,
      scope_kind: 'current_pdf' };
    const result = { ...preview(), layout_definition: identitylessLayout };
    const operation = { schema_version: 1, job_id: 'j', operation_id: 'op', result_revision: 'new', state: 'applied', saved_count: 2 };
    const { client, transport } = stub(prep);
    expect(await client.prepare(binding, hash)).toEqual(prep);
    transport.mockResolvedValue({ status: 'ok', data: result });
    expect(await client.preview(binding, prep, identitylessLayout)).toEqual(result);
    await expect(client.save(result, [], true, '不得复用')).rejects.toThrow('可复用模板资格');
    transport.mockResolvedValue({ status: 'ok', data: operation });
    await expect(client.save(result, [], false)).resolves.toMatchObject(operation);
  });
  it('validates selected position, complete page scope and immutable preparation binding', async () => {
    const { client, transport } = stub(prepared);
    expect(await client.prepare(binding, hash)).toEqual(prepared);
    expect(transport).toHaveBeenCalledWith('batch_command', { request: {
      op: 'batch_receipt_calibration_prepare', job_id: 'j', result_revision: 'r', sample_id: hash,
    } });
    transport.mockResolvedValue({ status: 'ok', data: { ...prepared, result_revision: 'stale' } });
    await expect(client.prepare(binding, hash)).rejects.toThrow('版式操作返回的数据不完整');
  });

  it('keeps every preview target and sends draft changes without caller target lists', async () => {
    const result = preview(); const { client, transport } = stub(result);
    expect(await client.preview(binding, prepared, { ...layout, revision: 20 })).toEqual(result);
    const request = transport.mock.calls[0][1].request;
    expect(request.layout_definition.revision).toBe(layout.revision + 1);
    expect(request).not.toHaveProperty('affected');
    expect(request).not.toHaveProperty('review_database_path');
  });

  it('explains a native preview timeout without losing the retryable draft context', async () => {
    const { client, transport } = stub(preview());
    transport.mockRejectedValueOnce('local engine operation timed out');
    await expect(client.preview(binding, prepared, layout)).rejects.toMatchObject({
      code: 'calibration_timeout', message: '大批页面版式预览超时，调整草稿已保留，可以重试。',
    });
    expect(await client.preview(binding, prepared, layout)).toEqual(preview());
  });

  it.each(['local engine exited: C:\\private\\source.pdf', { path: 'C:\\private\\source.pdf' }])(
    'hides unrecognized native rejection details', async (rejection) => {
      const { client, transport } = stub(preview());
      transport.mockRejectedValueOnce(rejection);
      await expect(client.preview(binding, prepared, layout)).rejects.toMatchObject({
        code: 'calibration_host_failed', message: '版式操作未完成，请重试。',
      });
    },
  );

  it('does not describe a timed-out save as an unchanged preview draft', async () => {
    const { client, transport } = stub(preview());
    transport.mockRejectedValueOnce('local engine operation timed out');
    await expect(client.save(preview(), [])).rejects.toMatchObject({
      code: 'calibration_timeout', message: '本地版式操作超时，请重试。',
    });
  });

  it.each(['wrong_source', 'duplicate_target', 'blocked_but_saveable'])('rejects %s preview', async (caseName) => {
    const result = preview();
    if (caseName === 'wrong_source') result.affected[0].source_key = '/another-bank.pdf';
    if (caseName === 'duplicate_target') result.affected[1] = result.affected[0];
    if (caseName === 'blocked_but_saveable') result.blockers.push({ code: 'unassigned_block' });
    const { client } = stub(result);
    await expect(client.preview(binding, prepared, layout)).rejects.toThrow('版式操作返回的数据不完整');
  });

  it('cancels a preview that finishes after the user leaves', async () => {
    const controller = new AbortController();
    const transport = vi.fn().mockImplementationOnce(async () => {
      controller.abort();
      return { status: 'ok', data: preview() };
    }).mockResolvedValueOnce({ status: 'ok', data: { cancelled: true } });
    const client = new ReceiptLayoutClient(transport as ReceiptBatchInvoke);
    await expect(client.preview(binding, prepared, layout, [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.mock.calls[1][1].request).toEqual({ op: 'batch_receipt_calibration_cancel', job_id: 'j', operation_id: 'op' });
  });

  it('queries uncertain writes by operation and does not resubmit the whole preview', async () => {
    const operation = { schema_version: 1, job_id: 'j', operation_id: 'op', result_revision: 'new',
      state: 'applied', saved_count: 2 };
    const transport = vi.fn().mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ status: 'ok', data: { ...operation, preview_fingerprint: hash } });
    const client = new ReceiptLayoutClient(transport as ReceiptBatchInvoke);
    const result = preview();
    await expect(client.save(result, [])).rejects.toThrow('connection lost');
    expect(transport.mock.calls[0][1].request).toMatchObject({ remember_reference: false, template_name: null });
    expect(await client.status(result)).toMatchObject(operation);
    expect(transport.mock.calls[1][1].request).toEqual({ op: 'batch_receipt_calibration_status', job_id: 'j', operation_id: 'op' });
  });

  it('sends the explicit opt-out for historical layout memory', async () => {
    const operation = { schema_version: 1, job_id: 'j', operation_id: 'op', result_revision: 'new', state: 'applied', saved_count: 2 };
    const { client, transport } = stub(operation);
    await client.save(preview(), [], false);
    expect(transport.mock.calls[0][1].request.remember_reference).toBe(false);
  });

  it('validates and forwards a named template only when requested', async () => {
    const operation = { schema_version: 1, job_id: 'j', operation_id: 'op', result_revision: 'new', state: 'applied', saved_count: 2, reference_state: 'saved' };
    const { client, transport } = stub(operation);
    for (const name of [null, '', '   ', 'a'.repeat(257), 'a\0b']) await expect(client.save(preview(), [], true, name)).rejects.toThrow('模板名称');
    expect(transport).not.toHaveBeenCalled();
    expect(await client.save(preview(), [], true, ' 常用模板 ')).toMatchObject({ reference_state: 'saved' });
    expect(transport.mock.calls[0][1].request).toMatchObject({ remember_reference: true, template_name: '常用模板' });
  });

  it('requires an explicit update target and preserves the selected template outcome', async () => {
    const { client, transport } = stub({ schema_version: 1, job_id: 'j', operation_id: 'op', result_revision: 'new',
      state: 'applied', saved_count: 2, reference_state: 'saved', template_id: 'new-version', template_name: '目标模板', template_version: 2 });
    await expect(client.save(preview(), [], true, '目标模板', 'update', null, '银行')).rejects.toThrow('更新');
    await expect(client.save(preview(), [], true, '目标模板', 'create', 'old-version', '银行')).rejects.toThrow('新建');
    await expect(client.save(preview(), [], true, '目标模板', 'update', 'old-version', 'a'.repeat(81))).rejects.toThrow('银行名称');
    expect(transport).not.toHaveBeenCalled();
    expect(await client.save(preview(), [], true, '目标模板', 'update', 'old-version', ' 银行 ')).toMatchObject({ template_id: 'new-version', template_version: 2 });
    expect(transport.mock.calls[0][1].request).toMatchObject({ template_save_mode: 'update', template_id: 'old-version', template_bank_name: '银行' });
  });

  it.each(['shared_geometry_changed', 'template_geometry_conflict', 'operation_inactive', 'identity_unavailable', 'storage_unavailable', 'invalid_reference',
    'template_unavailable', 'template_conflict', 'template_incompatible', 'operation_conflict'])('accepts the safe template failure code %s', async (code) => {
    const { client } = stub({ schema_version: 1, job_id: 'j', operation_id: 'op', result_revision: 'new',
      state: 'applied', saved_count: 2, reference_state: 'failed', reference_error_code: code });
    expect(await client.save(preview(), [], true, '模板')).toMatchObject({ reference_error_code: code, state: 'applied' });
  });

  it.each([
    { reference_state: 'saved', reference_error_code: 'storage_unavailable' },
    { reference_state: 'failed', reference_error_code: 'private error details' },
    { reference_error_code: 'storage_unavailable' },
  ])('rejects inconsistent or unknown template failure metadata', async (extra) => {
    const { client } = stub({ schema_version: 1, job_id: 'j', operation_id: 'op', result_revision: 'new',
      state: 'applied', saved_count: 2, ...extra });
    await expect(client.save(preview(), [], true, '模板')).rejects.toThrow('数据不完整');
  });
});
