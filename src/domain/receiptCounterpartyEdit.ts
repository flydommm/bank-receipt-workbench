import type { FieldOverride, GroupDefinition, GroupingEdit, GroupingItem } from './receiptGrouping';
import { hasGroupingProfileConflict } from './receiptGroupingGuidance';

export type CounterpartyEditInput = { kind: 'name'; name: string }
  | { kind: 'group'; group: GroupDefinition }
  | { kind: 'blank' };

const editableRoutes = new Set<GroupingItem['route']>(['named', 'internal', 'blank', 'counterparty_pending']);
const sideConflicts = new Set(['both_sides_match_our_account', 'own_side_conflict']);

export function canCorrectCounterparty(item: GroupingItem): boolean {
  if (item.extraction_state !== 'ready' || item.own_decision.status !== 'confirmed'
    || item.own_decision.source_bank_status === 'mismatch' || hasGroupingProfileConflict(item)
    || [...item.own_decision.reasons, ...item.warnings].some((reason) => sideConflicts.has(reason))
    || (item.document_type !== null && item.document_type !== 'ordinary')) return false;
  return editableRoutes.has(item.route) || (item.route === 'special'
    && (item.extracted?.service_type === 'bank_fee' || item.extracted?.service_type === 'deposit_interest'));
}

export function isCounterpartyNameValid(name: string): boolean {
  return name.trim().length > 0 && name.trim().length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(name)
    && /[\p{L}\p{N}]/u.test(name);
}

/** Send a complete override list, preserving every field except the direct name. */
export function buildCounterpartyEdits(items: GroupingItem[], input: CounterpartyEditInput): GroupingEdit[] {
  if (items.length < 1 || items.length > 200) throw new Error('每次请选择 1 至 200 张回单。');
  if (new Set(items.map((item) => item.binding.segment_id)).size !== items.length) throw new Error('所选回单重复，请重新选择。');
  if (!items.every(canCorrectCounterparty)) throw new Error('所选回单中有不可修改交易对手的项目，请先处理本方资料或字段提取问题。');
  const name = input.kind === 'blank' ? '' : input.kind === 'name' ? input.name.trim() : input.group.display_name;
  if (input.kind !== 'blank' && !isCounterpartyNameValid(name)) throw new Error('请填写有效的交易对手名称，不能只有空格或标点。');
  if (input.kind === 'group' && (input.group.kind !== 'named' || !input.group.group_id.trim()
    || input.group.group_id.length > 256 || input.group.group_id.includes('\0'))) throw new Error('请选择有效的交易对手分组。');
  const override: FieldOverride = {
    side: 'counterparty', field: 'name', value: name, state: input.kind === 'blank' ? 'blank' : 'present',
    reason: input.kind === 'blank' ? '用户对照原件确认交易对手名称确实为空。' : '用户对照原件修改交易对手名称。',
  };
  return items.map((item) => ({
    segment_id: item.binding.segment_id,
    expected_basis_fingerprint: item.basis_fingerprint,
    field_overrides: [...item.field_overrides.filter((entry) => entry.side !== 'counterparty' || entry.field !== 'name').map((entry) => ({ ...entry })), { ...override }],
    assignment: input.kind === 'group' ? { group_id: input.group.group_id, reason: '用户对照原件选择已有交易对手分组。' } : null,
  }));
}
