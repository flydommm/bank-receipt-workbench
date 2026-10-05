import { useEffect, useRef, useState } from 'react';
import { FIELD_STATE_LABELS, type GroupingHeader } from '../domain/receiptGrouping';
import { FIELD_LABELS, FIELD_ROLE_LABELS, type FieldRuleApplied, type GroupingDiagnostics, type LocalFieldRule } from '../domain/receiptFieldRules';
import { RECOGNITION_ISSUE_LABELS } from '../domain/receiptGroupingIssues';
import { ReceiptFieldRuleClient } from '../services/receiptFieldRuleClient';
import { localEngineAdapter } from './localEngineAdapter';
import './ReceiptFieldRuleEditor.css';

type Props = { header: GroupingHeader; client: ReceiptFieldRuleClient; lastOperationId: string | null; disabled: boolean; initialOutputDirectory?: string | null; onBusyChange: (busy: boolean) => void; onApplied: (result: FieldRuleApplied) => Promise<void> };
export function ReceiptGroupingRuleTools({ header, client, lastOperationId, disabled, initialOutputDirectory, onBusyChange, onApplied }: Props) {
  const [rules, setRules] = useState<LocalFieldRule[] | null>(null), [diagnostics, setDiagnostics] = useState<GroupingDiagnostics | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true), epoch = useRef(0); const callback = useRef(onBusyChange); callback.current = onBusyChange;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current += 1; callback.current(false); }; }, []);
  useEffect(() => { setDiagnostics(null); setNotice(null); epoch.current += 1; }, [header.job_id, header.grouping_revision, header.review_fingerprint]);
  const run = async (operation: (current: () => boolean) => Promise<void>) => {
    if (disabled || busy) return;
    const ownEpoch = ++epoch.current; setBusy(true); callback.current(true); setError(null); setNotice(null);
    try { await operation(() => mounted.current && ownEpoch === epoch.current); }
    catch (cause) { if (mounted.current && ownEpoch === epoch.current) setError(cause instanceof Error ? cause.message : '操作未完成，请重试。'); }
    finally { if (mounted.current) { setBusy(false); callback.current(false); } }
  };
  return <details className="receipt-grouping-rule-tools"><summary>读取规则与排查信息{lastOperationId ? ' · 可撤销最近应用' : ''}</summary>
    <p>读取规则由您设置字段位置、试读核对后，勾选“下次同版式自动使用”来保存。没有自定义规则也可使用系统自动识别；它与分割边界模板不同。</p>
    <p>诊断摘要用于排查识别问题，无需提供真实回单。普通名称修正请使用“修改交易对手”。</p>
    <div className="receipt-grouping-rule-tools__actions">
      {lastOperationId && <button type="button" disabled={disabled || busy} onClick={() => void run(async () => { const result = await client.undo(header, lastOperationId); await onApplied(result); })}>撤销最近一次读取应用</button>}
      <button type="button" disabled={disabled || busy} onClick={() => void run(async (current) => { const result = await client.list(true); if (current()) setRules(result); })}>查看本机读取规则</button>
      <button type="button" disabled={disabled || busy} onClick={() => void run(async (current) => { const result = await client.diagnostics(header); if (current()) setDiagnostics(result); })}>预览无需附回单的诊断摘要</button>
    </div>
    {lastOperationId && <p>撤销只恢复本批应用前的分组；若同时保存了读取规则，请在本机规则列表单独停用。</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {rules && <><p>停用只影响今后的自动匹配；不会改动已经整理的回单。</p>{rules.length ? <ul className="receipt-grouping-rule-tools__rules">{rules.map((rule) => <li key={rule.rule_id}>{rule.bank_name} · {rule.name} · 第 {rule.revision} 版 · {rule.mode === 'auto' ? '自动定位交易对手' : rule.mode === 'direct' ? '固定对方位置' : '双方位置'} · {rule.active ? '启用' : '已停用'}<button type="button" disabled={disabled || busy || !rule.active} onClick={() => void run(async (current) => { const result = await client.deactivate(rule); if (current()) setRules((prior) => prior?.map((item) => item.rule_id === result.rule_id ? result : item) ?? null); })}>停用此规则</button></li>)}</ul> : <p>尚未保存本机读取规则。</p>}{rules.length >= 1000 && <p>规则数量较多，请先停用不再使用的规则。</p>}</>}
    {diagnostics && <section className="receipt-grouping-diagnostics" aria-label="诊断摘要预览">
      <strong>诊断摘要预览</strong><p>只包含应用版本、问题数量、字段状态和匿名版式编号。不含公司、账号、文件名、原件内容或截图；仅保存在本机，是否发送由您决定。</p>
      <div className="receipt-grouping-diagnostics__details"><dl><dt>应用版本</dt><dd>{diagnostics.app_version}</dd><dt>回单数量</dt><dd>{diagnostics.total}</dd></dl>
      <strong>识别问题</strong><ul>{diagnostics.issues.map((issue) => <li key={issue.code}>{RECOGNITION_ISSUE_LABELS[issue.code]}：{issue.count}</li>)}</ul>
      <strong>字段状态</strong><ul>{diagnostics.field_states.map((item, index) => <li key={index}>{item.role === 'unknown' ? '未定角色' : FIELD_ROLE_LABELS[item.role]}{FIELD_LABELS[item.field]} · {FIELD_STATE_LABELS[item.state]}：{item.count}</li>)}</ul>
      <strong>匿名版式</strong><ul>{diagnostics.layouts.map((item) => <li key={item.layout_id}>{item.layout_id}：{item.count}</li>)}</ul>
      <strong>读取器版本</strong><ul>{diagnostics.reader_dependencies.map((item, index) => <li key={index}>{item.reader_id} · {item.version}</li>)}</ul></div>
      <button type="button" disabled={disabled || busy} onClick={() => void run(async (current) => { const directory = await localEngineAdapter.pickOutputFolder(initialOutputDirectory); if (!directory || !current()) return; const result = await client.exportDiagnostics(header, diagnostics.report_id, directory); if (current()) setNotice(`诊断摘要已保存：${result.output_directory}`); })}>选择目录并保存此摘要</button>
      <button type="button" disabled={busy} onClick={() => setDiagnostics(null)}>收起摘要</button>
    </section>}
  </details>;
}
