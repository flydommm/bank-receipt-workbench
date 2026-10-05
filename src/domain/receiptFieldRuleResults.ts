import type { FieldRuleDifference } from './receiptFieldRules';

export type FieldRuleResultGroup = {
  key: string;
  name: string;
  route: string;
  count: number;
  rows: FieldRuleDifference[];
};
export type FieldRuleResultSummary = {
  success: FieldRuleResultGroup[];
  pending: FieldRuleResultGroup[];
  skipped: FieldRuleResultGroup[];
};

type ResultBucket = keyof FieldRuleResultSummary;
const RESULT_BUCKETS: readonly ResultBucket[] = ['success', 'pending', 'skipped'];

function resultBucket(status: FieldRuleDifference['status']): ResultBucket {
  return status === 'pending' || status === 'skipped' ? status : 'success';
}

function groupKey(afterName: string, route: string): string {
  // JSON keeps an empty name and its route distinct from every other pair.
  return JSON.stringify([afterName, route]);
}

export function summarizeFieldRuleResults(rows: readonly FieldRuleDifference[]): FieldRuleResultSummary {
  const groups = new Map<string, FieldRuleResultGroup>();
  const buckets = Object.fromEntries(RESULT_BUCKETS.map((bucket) => [bucket, [] as FieldRuleResultGroup[]])) as Record<ResultBucket, FieldRuleResultGroup[]>;

  for (const row of rows) {
    const bucket = resultBucket(row.status);
    const route = row.after_route;
    const key = `${bucket}:${groupKey(row.after_name, route)}`;
    let group = groups.get(key);
    if (!group) {
      group = { key: groupKey(row.after_name, route), name: row.after_name, route, count: 0, rows: [] };
      groups.set(key, group);
      buckets[bucket].push(group);
    }
    group.count += 1;
    group.rows.push(row);
  }

  return buckets;
}
