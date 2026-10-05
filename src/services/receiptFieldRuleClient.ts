import { invoke } from '@tauri-apps/api/core';
import { groupingExpected, type GroupingHeader } from '../domain/receiptGrouping';
import { parseReceiptBatchResponse, serializedReceiptBatchBytes } from '../domain/receiptBatch';
import { invalidFieldRule, parseFieldRuleApplied, parseFieldRuleDefinition, parseFieldRuleOperation, parseFieldRulePage, parseGroupingDiagnostics, parseLocalFieldRule, ruleInteger, ruleObject, ruleText,
  type DiagnosticExport, type FieldRuleDefinition, type FieldRuleOperation, type LocalFieldRule } from '../domain/receiptFieldRules';
import type { ReceiptBatchInvoke } from './receiptBatchClient';
import { sameExportPath } from '../components/localEngineAdapter';

const id = (value: string) => ruleText(value, 1024);
const absolute = (value: unknown): value is string => typeof value === 'string' && value.length <= 32768 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value) && !value.split(/[\\/]/).some((part) => part === '.' || part === '..');
const safeName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[<>:"/\\|?*\p{Cc}\p{Cf}\p{Cs}]/u.test(value) && !/^[ .]|[ .]$/.test(value);

export class ReceiptFieldRuleClient {
  constructor(private readonly transport: ReceiptBatchInvoke = invoke) {}
  private async call(request: Record<string, unknown>): Promise<unknown> {
    serializedReceiptBatchBytes({ request });
    const raw = await this.transport<unknown>('batch_command', { request }); serializedReceiptBatchBytes(raw);
    const response = parseReceiptBatchResponse(raw);
    if (response.status === 'error') throw new Error(response.message || '读取位置操作未完成，请重新载入后重试。');
    return response.data;
  }
  async prepare(header: GroupingHeader, definition: FieldRuleDefinition): Promise<FieldRuleOperation> {
    const result = parseFieldRuleOperation(await this.call({ op: 'batch_receipt_field_rule_prepare', ...groupingExpected(header), ...parseFieldRuleDefinition(definition) }));
    if (result.total > header.counts.total || !['preparing', 'ready'].includes(result.status)) return invalidFieldRule();
    return result;
  }
  async step(jobId: string, operation: FieldRuleOperation, limit = 50): Promise<FieldRuleOperation> {
    if (limit < 1 || limit > 50) return invalidFieldRule();
    const result = parseFieldRuleOperation(await this.call({ op: 'batch_receipt_field_rule_step', job_id: id(jobId), operation_id: id(operation.operation_id), offset: operation.completed, limit: ruleInteger(limit, 50) }));
    if (result.operation_id !== operation.operation_id || result.total !== operation.total || result.completed < operation.completed) return invalidFieldRule();
    return result;
  }
  async page(jobId: string, operationId: string, offset = 0, limit = 200) {
    if (limit < 1 || limit > 200) return invalidFieldRule();
    const result = parseFieldRulePage(await this.call({ op: 'batch_receipt_field_rule_page', job_id: id(jobId), operation_id: id(operationId), offset: ruleInteger(offset), limit: ruleInteger(limit, 200) }), offset, limit);
    if (result.operation.operation_id !== operationId) return invalidFieldRule();
    return result;
  }
  async apply(header: GroupingHeader, operationId: string, saveRule: boolean, ruleName: string) {
    const result = parseFieldRuleApplied(await this.call({ op: 'batch_receipt_field_rule_apply', ...groupingExpected(header), operation_id: id(operationId), save_rule: saveRule === true, rule_name: ruleText(ruleName, 80, !saveRule) }));
    this.checkApplied(header, operationId, result.header, result.operation);
    if (result.operation.status !== 'applied') return invalidFieldRule();
    return result;
  }
  async cancel(jobId: string, operationId: string) {
    const result = parseFieldRuleOperation(await this.call({ op: 'batch_receipt_field_rule_cancel', job_id: id(jobId), operation_id: id(operationId) }));
    if (result.operation_id !== operationId) return invalidFieldRule(); return result;
  }
  async undo(header: GroupingHeader, operationId: string) {
    const result = parseFieldRuleApplied(await this.call({ op: 'batch_receipt_field_rule_undo', ...groupingExpected(header), operation_id: id(operationId) }));
    this.checkApplied(header, operationId, result.header, result.operation);
    if (result.operation.status !== 'undone') return invalidFieldRule(); return result;
  }
  private checkApplied(before: GroupingHeader, operationId: string, after: GroupingHeader, operation: FieldRuleOperation) {
    if (after.job_id !== before.job_id || after.result_revision !== before.result_revision || after.review_fingerprint !== before.review_fingerprint
      || after.own_account.fingerprint !== before.own_account.fingerprint || after.grouping_revision < before.grouping_revision || operation.operation_id !== operationId) invalidFieldRule();
  }
  async list(activeOnly = true): Promise<LocalFieldRule[]> {
    const d = ruleObject(await this.call({ op: 'batch_receipt_field_rule_list', active_only: activeOnly }), ['items']);
    if (!Array.isArray(d.items) || d.items.length > 1000) return invalidFieldRule();
    const result = d.items.map(parseLocalFieldRule);
    if (new Set(result.map((rule) => rule.rule_id)).size !== result.length || activeOnly && result.some((rule) => !rule.active)) return invalidFieldRule(); return result;
  }
  async deactivate(rule: LocalFieldRule) {
    const result = parseLocalFieldRule(await this.call({ op: 'batch_receipt_field_rule_deactivate', rule_id: id(rule.rule_id), expected_revision: ruleInteger(rule.revision, Number.MAX_SAFE_INTEGER) }));
    // Deactivation changes availability, not the immutable field definition version.
    if (result.rule_id !== rule.rule_id || result.active || result.revision !== rule.revision) return invalidFieldRule(); return result;
  }
  async diagnostics(header: GroupingHeader) {
    const result = parseGroupingDiagnostics(await this.call({ op: 'batch_receipt_grouping_diagnostics', ...groupingExpected(header) }));
    if (result.total !== header.counts.total) return invalidFieldRule(); return result;
  }
  async exportDiagnostics(header: GroupingHeader, reportId: string, directory: string): Promise<DiagnosticExport> {
    if (!absolute(directory) || !/^[a-f0-9]{32}$/.test(reportId)) return invalidFieldRule();
    const d = ruleObject(await this.call({ op: 'batch_receipt_grouping_diagnostics_export', ...groupingExpected(header), report_id: reportId, directory }), ['output_directory', 'files']);
    if (!absolute(d.output_directory) || !sameExportPath(d.output_directory.split(/[\\/]/).slice(0, -1).join('/'), directory) || !Array.isArray(d.files) || !d.files.length || d.files.length > 4) return invalidFieldRule();
    const root = d.output_directory;
    const files = d.files.map((value) => { const f = ruleObject(value, ['name', 'path', 'bytes', 'sha256']);
      if (!safeName(f.name) || !absolute(f.path) || !sameExportPath(f.path, `${root}/${f.name}`) || !/^[a-f0-9]{64}$/i.test(ruleText(f.sha256, 64))) return invalidFieldRule();
      return { name: f.name, path: f.path, bytes: ruleInteger(f.bytes, 4 * 1024 * 1024), sha256: f.sha256 as string };
    });
    if (new Set(files.map((file) => file.name)).size !== files.length) return invalidFieldRule();
    return { output_directory: root, files };
  }
}
