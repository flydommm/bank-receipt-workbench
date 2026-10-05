import { groupingIssueLabel, type FieldOverride, type GroupingItem, type Party } from './receiptGrouping';

export type GroupingFieldTarget = { side: FieldOverride['side'] | null; field: FieldOverride['field'] };
export type GroupingGuidance = {
  reason: string;
  instruction: string;
  action: ({ kind: 'field'; label: string } & GroupingFieldTarget)
    | { kind: 'own' | 'refresh' | 'source'; label: string };
};

const sideNames = { payer: '付款方', payee: '收款方', counterparty: '交易对手' };
const conflictCodes = new Set(['own_company_ambiguous', 'own_company_mismatch', 'own_account_mismatch',
  'source_bank_mismatch', 'both_sides_match_our_account', 'own_side_conflict']);
const profileConflictCodes = new Set(['own_company_mismatch', 'own_account_mismatch', 'source_bank_mismatch']);

export function hasGroupingProfileConflict(item: GroupingItem): boolean {
  return item.route !== 'excluded' && [...item.own_decision.reasons, ...item.warnings].some((code) => profileConflictCodes.has(code));
}

export function canEditDirectCounterparty(item: GroupingItem): boolean {
  return item.own_decision.status === 'confirmed' && (item.own_decision.side === 'single'
    || (item.own_decision.method === 'batch_profile' && item.own_decision.side === null));
}

export function effectiveGroupingParty(item: GroupingItem, side: FieldOverride['side']): Party | null {
  const original = side === 'counterparty' ? item.counterparty : item.extracted?.[side];
  if (!original) return null;
  const result: Party = { name: { ...original.name }, account: { ...original.account }, bank: { ...original.bank } };
  for (const override of item.field_overrides) {
    if (override.side !== side) continue;
    const field = result[override.field];
    result[override.field] = { ...field, value: override.value, state: override.state, diagnostics: [...field.diagnostics, '人工修正'] };
  }
  return result;
}

export function groupingCounterparty(item: GroupingItem): Party | null {
  const direct = effectiveGroupingParty(item, 'counterparty');
  if (direct) return direct;
  if (item.own_decision.side === 'payer') return effectiveGroupingParty(item, 'payee');
  if (item.own_decision.side === 'payee') return effectiveGroupingParty(item, 'payer');
  return null;
}

export function ownConfirmationBlocked(item: GroupingItem): boolean {
  return item.extraction_state !== 'ready' || item.route === 'excluded'
    || [...item.own_decision.reasons, ...item.warnings].some((code) => conflictCodes.has(code));
}

function fieldGuidance(reason: string, side: GroupingFieldTarget['side'], field: GroupingFieldTarget['field']): GroupingGuidance {
  const label = `${side ? sideNames[side] : '本方'}${{ name: '名称', account: '账号', bank: '开户行' }[field]}`;
  return { reason, instruction: side ? '请对照下方原件修正这一项，保存后会重新判断去向。'
    : '请先在原件中找出本方，再选择付款方或收款方修正；不要凭空补填。',
  action: { kind: 'field', label: `修正${label}`, side, field } };
}

function counterpartyNameGuidance(reason: string): GroupingGuidance {
  return { ...fieldGuidance(reason, 'counterparty', 'name'),
    action: { kind: 'field', side: 'counterparty', field: 'name', label: '修改交易对手' } };
}

/** Describe the saved decision; never infer an own side from a name or a partial account. */
export function groupingGuidance(item: GroupingItem): GroupingGuidance | null {
  if (item.route === 'excluded') return null;
  if (item.extraction_state !== 'ready') return { reason: item.extraction_state === 'failed' ? '这张回单的字段提取未完成' : '这张回单的字段尚未提取完成',
    instruction: '先完成字段提取，再核对本方和交易对手。', action: { kind: 'refresh', label: '继续提取当前批次字段' } };
  const reasons = [...item.own_decision.reasons, ...item.warnings];
  const ownSide = item.own_decision.side === 'payer' || item.own_decision.side === 'payee' ? item.own_decision.side : null;
  if (item.own_decision.method === 'batch_profile') {
    if (item.route !== 'counterparty_pending') return null;
    const pendingExportHint = '暂不处理也可保留待确认，在导出时选择一并导出或单独存放。';
    if (reasons.includes('source_bank_mismatch')) return { reason: '回单出具银行与本批银行不一致',
      instruction: `请回查来源和本批账户资料。${pendingExportHint}`, action: { kind: 'source', label: '回查回单来源' } };
    if (reasons.includes('own_company_mismatch')) return { ...fieldGuidance(`${ownSide ? sideNames[ownSide] : '本方'}名称与本批公司不一致`, ownSide, 'name'),
      instruction: `请对照原件：若只是识别错误，可修正该名称；不要把其他公司强改为本批公司。${pendingExportHint}` };
    if (reasons.includes('own_account_mismatch') || reasons.includes('both_sides_match_our_account') || reasons.includes('own_side_conflict')) {
      const reason = reasons.includes('own_account_mismatch') ? '回单本方账号与本批账号不一致'
        : reasons.includes('both_sides_match_our_account') ? '收付款双方都读到了本方账号，需核对账号' : '本方位置与完整账号证据不一致';
      return { ...fieldGuidance(reason, ownSide, 'account'),
        instruction: `请对照原件核对账号，仅修正识别错误；不要凭空补填或改成批次账号。${pendingExportHint}` };
    }
    const reason = reasons.includes('counterparty_name_ambiguous') ? '交易对手名称未识别清楚' : '交易对手名称待核对';
    return { ...counterpartyNameGuidance(reason),
      instruction: '本方采用本批账户资料。请对照原件填写交易对手名称；暂不确定的可保留待确认，在导出时选择一并导出或单独存放。' };
  }
  if (item.own_decision.status !== 'confirmed') {
    if (reasons.includes('source_bank_mismatch')) return { reason: '回单出具银行与本批银行不一致',
      instruction: '请回查回单来源和本批账户。属于其他银行的回单应另批处理，不能用本方确认跳过。', action: { kind: 'source', label: '回查回单来源' } };
    if (reasons.includes('own_company_ambiguous')) return fieldGuidance(`${ownSide ? sideNames[ownSide] : '本方'}名称未识别清楚`, ownSide, 'name');
    if (reasons.includes('own_company_mismatch')) return { ...fieldGuidance(`${ownSide ? sideNames[ownSide] : '本方'}名称与本批公司不一致`, ownSide, 'name'),
      instruction: '先对照原件。若只是识别错误，可修正；原件确属其他公司的，请另批处理。' };
    if (reasons.includes('own_account_mismatch')) return { ...fieldGuidance('本方账号与本批账号不一致', ownSide, 'account'),
      instruction: '先对照原件。若只是识别错误，可修正；原件确属其他账号的，请另批处理。' };
    if (reasons.includes('both_sides_match_our_account')) return fieldGuidance('收付款双方都读到了本方账号，需核对账号', null, 'account');
    if (reasons.includes('own_side_conflict')) return fieldGuidance('本方位置与完整账号证据不一致', ownSide, 'account');
    if (reasons.includes('own_account_missing')) {
      if (ownSide) return fieldGuidance(`${sideNames[ownSide]}的完整本方账号未读到`, ownSide, 'account');
      return { reason: '完整本方账号未读到，本方位置尚未确定', instruction: '请对照原件，先确认本方在付款方还是收款方；有明确账号时也可使用“修改当前字段”补正识别结果。',
        action: { kind: 'own', label: '核对本方位置' } };
    }
    if (reasons.includes('source_bank_unknown')) return { reason: '来源银行待核对', instruction: '请核对回单出具银行是否为本批银行，再确认本方。', action: { kind: 'own', label: '核对来源银行与本方' } };
    return { reason: reasons.length ? groupingIssueLabel(reasons[0]) : '本方所在位置待核对', instruction: '请对照原件确认本方所在一侧、完整账号和回单出具银行。', action: { kind: 'own', label: '核对本方位置' } };
  }
  if (item.route !== 'counterparty_pending') return null;
  if (reasons.includes('internal_account_incomplete')) {
    const otherSide = item.own_decision.side === 'payer' ? 'payee' : item.own_decision.side === 'payee' ? 'payer' : 'counterparty';
    const party = groupingCounterparty(item);
    return fieldGuidance('本公司内部往来的对方开户行或完整账号未识别清楚', otherSide, party?.bank.state !== 'present' || !party.bank.value ? 'bank' : 'account');
  }
  return counterpartyNameGuidance(reasons.includes('counterparty_name_ambiguous') ? '交易对手名称未识别清楚'
    : '交易对手名称尚未读到');
}

export function groupingItemSummary(item: GroupingItem): string {
  const guidance = groupingGuidance(item);
  if (guidance) return guidance.reason;
  if (item.route === 'excluded') return '已在分割审核中排除';
  if (item.route === 'special') return '已按凭证类型整理';
  const account = groupingCounterparty(item)?.account;
  if (account?.state === 'blank') return '对方账号：原件空白';
  if (account?.state === 'ambiguous') return '对方账号未识别清楚';
  if (account?.state !== 'present' || !account.value) return '对方账号尚未读到';
  return `对方账号：${account.value}`;
}

export function consistentOwnSide(items: GroupingItem[]): 'payer' | 'payee' | 'single' | '' {
  const side = items[0]?.own_decision.side;
  return side && items.every((item) => item.own_decision.side === side) ? side : '';
}
