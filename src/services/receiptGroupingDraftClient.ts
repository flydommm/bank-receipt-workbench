import { invoke } from '@tauri-apps/api/core';
import type { GroupingHeader } from '../domain/receiptGrouping';
import type { ReceiptBatchInvoke } from './receiptBatchClient';
import { ExportBundleError } from './exportBundleClient';
import { sameExportPath } from '../components/localEngineAdapter';

export type ReceiptGroupingDraftReceipt = {
  state: 'draft_published'; directory: string; path: string; name: string;
  sha256: string; size_bytes: number; row_count: number; generated_at: string;
  job_id: string; result_revision: string; grouping_revision: number; review_fingerprint: string; own_account_fingerprint: string;
};
const invalid = (): never => { throw new ExportBundleError('draft_invalid_response', '核对草稿返回的版本或文件信息不一致，请重新载入后重试。'); };
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const absolute = (value: unknown): value is string => typeof value === 'string' && value.length <= 32768
  && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)
  && !value.split(/[\\/]/).some((part) => part === '.' || part === '..');
const safeBasename = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240
  && !/[<>:"/\\|?*\p{Cc}\p{Cf}\p{Cs}]/u.test(value) && !/^[ .]|[ .]$/.test(value)
  && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value);

export async function exportReceiptGroupingDraft(header: GroupingHeader, directory: string, call: ReceiptBatchInvoke = invoke): Promise<ReceiptGroupingDraftReceipt> {
  if (!absolute(directory) || !header.result_revision || !hash(header.review_fingerprint) || !hash(header.own_account.fingerprint)) invalid();
  const raw = await call<unknown>('export_bundle_command', { request: {
    op: 'grouping_draft', job_id: header.job_id, result_revision: header.result_revision,
    expected_grouping_revision: header.grouping_revision, expected_review_fingerprint: header.review_fingerprint,
    own_account_fingerprint: header.own_account.fingerprint, directory,
  } });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const response = raw as Record<string, unknown>;
  if (response.status === 'error') {
    throw new ExportBundleError(typeof response.code === 'string' ? response.code : 'draft_failed',
      typeof response.message === 'string' ? response.message : '核对草稿未能保存，请检查后重试。');
  }
  if (response.status !== 'ok' || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) return invalid();
  const value = response.data as ReceiptGroupingDraftReceipt;
  if (value.state !== 'draft_published' || value.job_id !== header.job_id || value.result_revision !== header.result_revision
      || value.grouping_revision !== header.grouping_revision || value.review_fingerprint !== header.review_fingerprint
      || value.own_account_fingerprint !== header.own_account.fingerprint || value.row_count !== header.counts.total
      || !absolute(value.directory) || !absolute(value.path) || !safeBasename(value.name) || !value.name.endsWith('交易对手核对草稿.xlsx')
      || !safeBasename(value.directory.split(/[\\/]/).pop()) || !hash(value.sha256)
      || !Number.isSafeInteger(value.size_bytes) || value.size_bytes <= 0 || typeof value.generated_at !== 'string'
      || Number.isNaN(Date.parse(value.generated_at))
      || !sameExportPath(value.directory.split(/[\\/]/).slice(0, -1).join('/'), directory)
      || !sameExportPath(value.path, `${value.directory}/${value.name}`)) return invalid();
  return value;
}
