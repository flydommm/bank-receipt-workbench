import type { GroupingItem, RecognitionIssueCode } from './receiptGrouping';

export const RECOGNITION_ISSUE_LABELS: Record<RecognitionIssueCode, string> = {
  no_text: '没有可用文字', invalid_text: '文字未能正常读取', missing_field: '未读到所需内容',
  conflicting_field: '同一字段读到多个结果', incomplete_account: '账号未读完整', role_unresolved: '交易双方位置不明确',
  unsupported_layout: '尚未识别这种版式', source_conflict: '本批资料不一致', rule_incompatible: '已有读取规则不适用', region_out_of_bounds: '读取位置超出片段',
};
export type GroupingIssueCollection = { key: string; label: string; segmentIds: string[]; hasLayout: boolean };

/** Structure is supplied by the text reader; the crop layout is never a substitute. */
export function groupingIssueCollections(items: GroupingItem[], sourceBank: string): GroupingIssueCollection[] {
  const groups = new Map<string, GroupingIssueCollection>();
  const layoutNames = new Map<string, number>();
  for (const item of items) {
    if (!['counterparty_pending', 'own_pending'].includes(item.route)) continue;
    const signature = item.extracted?.layout_signature;
    if (signature && !layoutNames.has(signature)) layoutNames.set(signature, layoutNames.size + 1);
    const issues = item.extracted?.issues?.length ? item.extracted.issues : [{ code: 'unsupported_layout' as const, field: null, role: 'unknown' as const }];
    const seen = new Set<string>();
    for (const issue of issues) {
      const key = JSON.stringify([issue.code, sourceBank.trim(), issue.field, issue.role, item.document_type, signature ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      const role = { payer: '付款方', payee: '收款方', own: '本方', counterparty: '对方', unknown: '' }[issue.role];
      const field = issue.field ? { name: '名称', account: '账号', bank: '开户行' }[issue.field] : '';
      const group = groups.get(key) ?? { key, label: `${role}${field ? `${field}：` : ''}${RECOGNITION_ISSUE_LABELS[issue.code]}${signature ? ` · 样式 ${layoutNames.get(signature)}` : ' · 仅按原因'}`, segmentIds: [], hasLayout: Boolean(signature) };
      group.segmentIds.push(item.binding.segment_id); groups.set(key, group);
    }
  }
  return [...groups.values()].sort((left, right) => right.segmentIds.length - left.segmentIds.length);
}

export function canConfigureFieldRule(item: GroupingItem): boolean {
  return ['counterparty_pending', 'own_pending'].includes(item.route) && item.extraction_state === 'ready'
    && !item.extracted?.issues?.some((issue) => ['no_text', 'invalid_text', 'source_conflict'].includes(issue.code));
}
