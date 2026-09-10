import { batchTargetProtection, createBatchCropPlan, cropPageKey, type BatchCropPlan, type CropTemplatePage } from '../domain/batchCrop';
import type { ReviewSegment } from '../domain/cropReview';

export class StaleBatchCropError extends Error {
  constructor() { super('批量调整预览已过期，请重新打开。'); }
}

export type BatchCropPreparation = {
  isCurrent: () => boolean;
  describe: (segment: ReviewSegment) => Promise<CropTemplatePage>;
  validate: (segment: ReviewSegment) => Promise<void>;
  onProgress: (message: string) => void;
};

/** Two lazy workers keep queued work and retained page images bounded. */
export async function prepareBatchCrop(sample: ReviewSegment, targets: ReviewSegment[], options: BatchCropPreparation): Promise<BatchCropPlan> {
  const check = () => { if (!options.isCurrent()) throw new StaleBatchCropError(); };
  const pages = new Map<string, CropTemplatePage>();
  const failures = new Map<string, string>();
  const unique = new Map<string, ReviewSegment>();
  for (const segment of [sample, ...targets.filter((item) => !batchTargetProtection(item))]) unique.set(cropPageKey(segment), segment);
  async function pool(items: ReviewSegment[], label: string, job: (segment: ReviewSegment) => Promise<void>): Promise<void> {
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < items.length) {
        check();
        const item = items[next++];
        await job(item);
        check();
        options.onProgress(`${label} ${++done} / ${items.length} 页`);
      }
    };
    await Promise.all([worker(), worker()]);
    check();
  }
  await pool([...unique.values()], '检查版式', async (segment) => {
    try { pages.set(cropPageKey(segment), await options.describe(segment)); }
    catch { check(); failures.set(cropPageKey(segment), '无法读取或核实页面版式，请单独复核'); }
  });
  if (failures.has(cropPageKey(sample))) throw new Error('样本页面版式无法核实，请先检查原文件。');
  const plan = createBatchCropPlan(sample, targets, pages);
  const validation = new Map<string, ReviewSegment>();
  for (const item of plan.applicable) validation.set(cropPageKey(item.after), item.after);
  await pool([...validation.values()], '核验预览', async (segment) => {
    try { await options.validate(segment); }
    catch { check(); failures.set(cropPageKey(segment), '页面预览核验失败，请单独预览后重试'); }
  });
  check();
  return {
    sampleId: plan.sampleId,
    applicable: plan.applicable.filter((item) => !failures.has(cropPageKey(item.after))),
    skipped: [...plan.skipped.map((item) => ({...item,reason:failures.get(cropPageKey(item.segment)) ?? item.reason})),
      ...plan.applicable.filter((item) => failures.has(cropPageKey(item.after)))
        .map((item) => ({segment:item.before,reason:failures.get(cropPageKey(item.after))!}))],
  };
}
