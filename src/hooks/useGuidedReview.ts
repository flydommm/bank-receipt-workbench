import { useEffect, useRef, useState } from 'react';
import { cropPageKey, type CropTemplatePage } from '../domain/batchCrop';
import { buildGuidedReviewBankGroups, buildGuidedReviewGroups, type GuidedReviewGroup } from '../domain/guidedReview';
import type { ReviewSegment } from '../domain/cropReview';
import type { ReviewDecisionSnapshot } from '../domain/reviewOperations';
import { prepareBatchCrop } from '../services/prepareBatchCrop';

export type GuidedPhase = 'entry' | 'preparing' | 'editing' | 'review' | 'round-complete' | 'choosing-position' | 'bank-complete' | 'completed';
type Bank = { key: string; label: string; segmentIds: string[]; sourceKeys: string[]; bankKey: string | null };
type Round = { number: number; sampleId: string; ids: string[]; before: ReviewDecisionSnapshot[]; savedIds?: string[] };
export type GuidedSkippedItem = { id: string; reason: string };
type PreviewPlan = {
  originalRoundIds: string[];
  sample: ReviewSegment;
  proposedSegments: ReviewSegment[];
  expected: ReviewDecisionSnapshot[];
  skipped: GuidedSkippedItem[];
};
type State = {
  phase: GuidedPhase; banks: Bank[]; bankIndex: number; round: Round | null;
  /** IDs selected for this guided-review session; durable result rows are not the scope. */
  scopeIds: string[];
  positionChoices: GuidedReviewGroup[]; selectedPositionKey: string;
  confirmedIds: ReadonlySet<string>; busy: boolean; message: string; error?: string;
};
const initial = (): State => ({ phase: 'entry', banks: [], bankIndex: 0, round: null,
  scopeIds: [], positionChoices: [], selectedPositionKey: '', confirmedIds: new Set(), busy: false, message: '' });
export type GuidedWrite = {
  segments: ReviewSegment[]; expected: ReviewDecisionSnapshot[];
  current: () => boolean; onSaved: () => void; message: string;
};
type Options = {
  segments: ReviewSegment[];
  /** The explicit work set for this run. Omitted values default to unresolved rows. */
  workIds?: Iterable<string>;
  blocked: () => boolean;
  describe: (segment: ReviewSegment, current: () => boolean) => Promise<CropTemplatePage>;
  /**
   * Optional bulk descriptor reader. A missing map entry deliberately remains
   * unverifiable; the hook never falls back to a whole-task scan.
   */
  prefetch?: (
    segments: ReviewSegment[],
    current: () => boolean,
    onProgress: (done: number, total: number) => void,
  ) => Promise<Map<string, CropTemplatePage>>;
  validate: (segment: ReviewSegment, current: () => boolean) => Promise<void>;
  snapshots: (ids: string[]) => ReviewDecisionSnapshot[];
  persist: (write: GuidedWrite) => Promise<boolean>;
  select: (segment: ReviewSegment) => void;
  clearDraft: () => void;
};

/** Saved rectangles are durable. Explicit workflow checkpoints and undo belong to this session only. */
export function useGuidedReview(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [state, setState] = useState<State>(initial);
  const stateRef = useRef(state);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const pages = useRef(new Map<string, CropTemplatePage>());
  const automaticIds = useRef(new Set<string>());
  const previewPlan = useRef<PreviewPlan | null>(null);
  const roundGeneration = useRef(0);
  const positionGeneration = useRef(0);
  const positionReturnPhase = useRef<'round-complete' | 'bank-complete'>('round-complete');
  const history = useRef<{ bankIndex: number; round: Round; confirmedIds: ReadonlySet<string> }[]>([]);
  function update(patch: Partial<State>) {
    stateRef.current = { ...stateRef.current, ...patch };
    setState(stateRef.current);
  }
  function reset() {
    generation.current += 1;
    roundGeneration.current += 1;
    positionGeneration.current += 1;
    pages.current.clear(); automaticIds.current.clear(); history.current = []; previewPlan.current = null;
    stateRef.current = initial(); setState(stateRef.current);
  }
  function currentRun() {
    const run = generation.current;
    return () => generation.current === run;
  }
  function selectedSegments(ids: readonly string[]) {
    const byId = new Map(optionsRef.current.segments.map((segment) => [segment.id, segment]));
    return ids.map((id) => {
      const segment = byId.get(id);
      if (!segment) throw new Error('本轮片段已变化，请退出后重新进入微调。');
      return segment;
    });
  }
  function workSegments(preferredSegmentId?: string): ReviewSegment[] {
    const all = optionsRef.current.segments;
    const ids = new Set<string>();
    const requested = optionsRef.current.workIds
      ?? all.filter((segment) => segment.reviewStatus !== 'confirmed').map((segment) => segment.id);
    for (const rawId of requested) if (typeof rawId === 'string' && rawId.trim()) ids.add(rawId.trim());
    // A row explicitly selected by the user is part of this run even when its
    // durable status is already confirmed (for example, the user wants to
    // refine that candidate before syncing its untouched peers).
    if (preferredSegmentId && all.some((segment) => segment.id === preferredSegmentId)) ids.add(preferredSegmentId);
    return all.filter((segment) => ids.has(segment.id));
  }
  async function pool(segments: ReviewSegment[], current: () => boolean,
    job: (segment: ReviewSegment) => Promise<void>) {
    let next = 0;
    const worker = async () => {
      while (next < segments.length && current()) await job(segments[next++]);
    };
    await Promise.all([worker(), worker()]);
    if (!current()) throw new Error('本次微调已取消。');
  }
  function startRound(bankIndex: number, number: number, preferredSegmentId?: string) {
    roundGeneration.current += 1;
    previewPlan.current = null;
    const active = stateRef.current;
    const bank = active.banks[bankIndex];
    if (!bank) {
      update({ phase: 'entry', bankIndex: 0, round: null, busy: false, error: '本次没有可复核的片段。' });
      return;
    }
    const remaining = selectedSegments(bank.segmentIds.filter((id) => !active.confirmedIds.has(id)));
    if (!remaining.length) {
      update({ phase: 'bank-complete', bankIndex, round: null, message: '本次微调范围中的本银行所有位置均已保存并确认。', error: undefined });
      return;
    }
    const groups = buildGuidedReviewGroups(remaining, pages.current);
    const group = groups.find((item) => preferredSegmentId && item.segmentIds.includes(preferredSegmentId)) ?? groups[0];
    const ids = group.segmentIds;
    const sampleId = preferredSegmentId && ids.includes(preferredSegmentId) ? preferredSegmentId : ids[0];
    const round: Round = { number, sampleId, ids, before: [] };
    update({ phase: 'editing', bankIndex, round,
      message: group.bankKey === null
        ? '出具银行或版式尚未核实。本轮仅处理当前 1 处，不会同步其他片段。可单独调整并保存；若银行标识是图片，请在“帮助与反馈”中检测 OCR，正常后重新分析原 PDF。'
        : '先调整当前样本；确认调整后预览本轮全部片段，检查完成再保存本轮。',
      error: undefined });
    optionsRef.current.select(remaining.find((segment) => segment.id === round.sampleId)!);
  }
  async function enter(preferredSegmentId?: string) {
    if (stateRef.current.busy || optionsRef.current.blocked() || !optionsRef.current.segments.length) return;
    const scoped = workSegments(preferredSegmentId);
    if (scoped.length === 0) {
      update({ phase: 'entry', error: '本次没有需要微调的片段。', message: '' });
      return;
    }
    reset(); optionsRef.current.clearDraft();
    const current = currentRun();
    const sourceSegments = structuredClone(optionsRef.current.segments);
    const baseIds = new Set(scoped.map((segment) => segment.id));
    update({ phase: 'preparing', busy: true, scopeIds: scoped.map((segment) => segment.id), message: '正在识别出具银行和回单位置…' });
    try {
      const preferred = preferredSegmentId
        ? sourceSegments.find((segment) => segment.id === preferredSegmentId)
        : undefined;
      const snapshots = preferred?.reviewStatus === 'confirmed'
        ? optionsRef.current.snapshots(sourceSegments.map((segment) => segment.id))
        : [];
      const snapshotById = new Map(snapshots.map((item) => [item.decision.id, item]));
      const preferredIsUntouchedAutomatic = Boolean(preferred
        && preferred.reviewStatus === 'confirmed'
        && preferred.manualAdjusted === false
        && preferred.mode !== 'manual'
        && snapshotById.get(preferred.id)?.recordRevision === 0);
      // A selected, still-automatic confirmed row may be refined by the user.
      // Discover all untouched automatic candidates so strict descriptor grouping
      // can add only its same-bank/form/position peers to this session scope.
      // Candidates outside that preferred group are discovery-only and never
      // enter a later review round.
      const descriptorInput = preferredIsUntouchedAutomatic
        ? sourceSegments.filter((segment) => {
          const snapshot = snapshotById.get(segment.id);
          return baseIds.has(segment.id)
            || (snapshot?.recordRevision === 0 && segment.manualAdjusted === false && segment.mode !== 'manual');
        })
        : sourceSegments.filter((segment) => baseIds.has(segment.id));
      const unique = [...new Map(descriptorInput.map((segment) => [cropPageKey(segment), segment])).values()];
      if (optionsRef.current.prefetch) {
        const prefetched = await optionsRef.current.prefetch(unique, current, (done, total) => {
          if (current()) update({ message: `识别银行与位置 ${done} / ${total} 页` });
        });
        if (!current()) return;
        for (const segment of unique) {
          const page = prefetched.get(cropPageKey(segment));
          if (page !== undefined && current()) pages.current.set(cropPageKey(segment), page);
        }
      } else {
        let done = 0;
        await pool(unique, current, async (segment) => {
          try { const page = await optionsRef.current.describe(segment, current); if (current()) pages.current.set(cropPageKey(segment), page); }
          catch { /* Unverifiable identities remain isolated; no guessed bank or automatic synchronization. */ }
          if (current()) update({ message: `识别银行与位置 ${++done} / ${unique.length} 页` });
        });
      }
      if (!current()) return;
      // A source-integrity or review-context transition can block the App
      // while a bulk descriptor request is in flight. Do not expose a stale
      // editing round even though the hook generation itself is still live.
      if (optionsRef.current.blocked()) {
        update({ phase: 'entry', busy: false, error: '来源或审核上下文已变化，本次微调已取消。' });
        return;
      }
      const discoveredGroups = buildGuidedReviewGroups(descriptorInput, pages.current);
      const preferredGroup = preferredIsUntouchedAutomatic && preferredSegmentId
        ? discoveredGroups.find((group) => group.segmentIds.includes(preferredSegmentId))
        : undefined;
      const scopeIds = new Set(baseIds);
      if (preferredGroup) for (const id of preferredGroup.segmentIds) scopeIds.add(id);
      const all = sourceSegments.filter((segment) => scopeIds.has(segment.id));
      // The explicit automatic provenance is limited to the final scope. This
      // keeps discovery-only candidates out of linked writes and CAS snapshots.
      const scopeSnapshots = snapshots.length > 0
        ? snapshots.filter((item) => scopeIds.has(item.decision.id))
        : optionsRef.current.snapshots(all.map((segment) => segment.id));
      automaticIds.current = new Set(scopeSnapshots
        .filter((item) => item.recordRevision === 0).map((item) => item.decision.id));
      update({ scopeIds: all.map((segment) => segment.id) });
      const banks = buildGuidedReviewBankGroups(buildGuidedReviewGroups(all, pages.current));
      // Start at the user's selected bank while retaining every other bank for subsequent rounds.
      const selectedBankIndex = banks.findIndex((bank) => preferredSegmentId && bank.segmentIds.includes(preferredSegmentId));
      if (selectedBankIndex > 0) banks.unshift(...banks.splice(selectedBankIndex, 1));
      update({ banks, busy: false });
      startRound(0, 1, preferredSegmentId);
    } catch (error) {
      if (current()) update({ phase: 'entry', busy: false, error: error instanceof Error ? error.message : '无法开始微调。' });
    }
  }
  function remember(round: Round) {
    if (!history.current.some((item) => item.bankIndex === stateRef.current.bankIndex && item.round.number === round.number)) {
      history.current.push({ bankIndex: stateRef.current.bankIndex, round: structuredClone(round), confirmedIds: new Set(stateRef.current.confirmedIds) });
      if (history.current.length > 20) history.current.shift();
    }
  }
  async function preview(sample?: ReviewSegment) {
    const active = stateRef.current;
    if (active.phase !== 'editing' || active.busy || optionsRef.current.blocked() || !active.round
      || (sample && !active.round.ids.includes(sample.id))) return;
    const sessionCurrent = currentRun();
    const request = ++roundGeneration.current;
    const current = () => sessionCurrent() && request === roundGeneration.current;
    update({ busy: true, error: undefined, message: '正在检查本轮版式…' });
    try {
      const targets = structuredClone(selectedSegments(active.round.ids));
      // Freeze the pre-preview baseline. Saving or retrying must not quietly
      // accept decisions changed by another writer while the user previews.
      const expected = structuredClone(optionsRef.current.snapshots(active.round.ids));
      const selectedSample = structuredClone(sample ?? targets.find((item) => item.id === active.round!.sampleId)!);
      // Individually saved edits remain protected. Only untouched automatic candidates can join a new linked write.
      let segments = sample ? [selectedSample] : targets;
      let skipped: GuidedSkippedItem[] = [];
      if (sample && targets.length > 1) {
        const plan = await prepareBatchCrop(segments[0], targets, {
          isCurrent: current, linkedSnapshots: new Map(),
          // A controlled undo restores the original automatic decision with a new revision.
          // Its original provenance remains valid within this session; manual/confirmed rounds
          // cannot join because target protection and the explicit round membership still apply.
          unreviewedIds: automaticIds.current,
          describe: async (segment) => pages.current.get(cropPageKey(segment)) ?? optionsRef.current.describe(segment, current),
          validate: (segment) => optionsRef.current.validate(segment, current),
          onProgress: (message) => { if (current()) update({ message }); },
        });
        segments = [...segments, ...plan.applicable.map((item) => item.after)];
        skipped = plan.skipped.filter((item) => item.segment.id !== sample.id)
          .map((item) => ({ id: item.segment.id, reason: item.reason }));
      }
      await pool(segments, current, (segment) => optionsRef.current.validate(segment, current));
      if (!current()) return;
      if (optionsRef.current.blocked()) throw new Error('来源或审核上下文已变化，本轮预览未生成。');
      const ids = segments.map((segment) => segment.id);
      const plan: PreviewPlan = { originalRoundIds: [...active.round.ids], sample: selectedSample,
        proposedSegments: structuredClone(segments), expected: expected.filter((item) => ids.includes(item.decision.id)), skipped };
      if (plan.expected.length !== ids.length) throw new Error('本轮审核记录已变化，请返回后重新核对。');
      previewPlan.current = plan;
      optionsRef.current.clearDraft();
      // Keep skipped IDs in the round so the navigator can still preview them;
      // only proposedSegments are eligible for this save.
      update({ phase: 'review', round: { ...active.round, sampleId: selectedSample.id, ids: [...active.round.ids], savedIds: ids, before: [] }, busy: false,
        error: undefined, message: `本轮 ${ids.length} 处预览已准备，尚未保存。${skipped.length
          ? `另有 ${skipped.length} 处未同步，将留在后续轮次单独核对。` : '请浏览全部片段，检查完成再保存本轮。'}` });
    } catch (error) {
      if (current()) update({ error: error instanceof Error ? error.message : '本轮预览未生成，请重试。' });
    } finally { if (current()) update({ busy: false }); }
  }
  function backToEdit(): ReviewSegment | null {
    const active = stateRef.current;
    const plan = previewPlan.current;
    if (active.phase !== 'review' || !active.round || !plan || active.busy || optionsRef.current.blocked()) return null;
    roundGeneration.current += 1;
    previewPlan.current = null;
    const sample = structuredClone(plan.sample);
    update({ phase: 'editing', round: { ...active.round, sampleId: sample.id, ids: [...plan.originalRoundIds], before: [] },
      error: undefined, message: '已返回调整，当前样本的调整已保留；确认后可重新预览整轮。' });
    optionsRef.current.select(sample);
    return sample;
  }
  async function save() {
    const active = stateRef.current;
    const plan = previewPlan.current;
    if (active.phase !== 'review' || !active.round || !plan || active.busy || optionsRef.current.blocked()) return;
    const sessionCurrent = currentRun();
    // App persistence may keep this GuidedWrite for a durable retry. Its plan
    // remains live until success, return-to-edit, exit, or a context reset.
    const current = () => sessionCurrent() && previewPlan.current === plan && stateRef.current.phase === 'review';
    update({ busy: true, error: undefined, message: '正在核验并保存本轮…' });
    try {
      selectedSegments(active.round.ids);
      const segments = structuredClone(plan.proposedSegments).map((segment) => ({ ...segment, reviewStatus: 'confirmed' as const }));
      await pool(segments, current, (segment) => optionsRef.current.validate(segment, current));
      if (!current()) return;
      if (optionsRef.current.blocked()) throw new Error('来源或审核上下文已变化，本轮尚未保存。');
      const savedIds = segments.map((segment) => segment.id);
      const round = { ...active.round, savedIds, before: structuredClone(plan.expected) };
      const saved = await optionsRef.current.persist({ segments, expected: structuredClone(plan.expected), current,
        message: `本轮 ${segments.length} 处已保存并确认。`,
        onSaved: () => {
          if (!current()) return;
          remember(round);
          previewPlan.current = null;
          const nextConfirmedIds = new Set([...stateRef.current.confirmedIds, ...(round.savedIds ?? round.ids)]);
          const currentBank = stateRef.current.banks[stateRef.current.bankIndex];
          const remainingCount = currentBank?.segmentIds.filter((id) => !nextConfirmedIds.has(id)).length ?? 0;
          update({ phase: 'round-complete', round, busy: false, error: undefined,
            confirmedIds: nextConfirmedIds,
            message: remainingCount > 0
              ? `本轮已保存并确认，本银行本次范围还剩 ${remainingCount} 处待确认。`
              : '本轮已保存并确认，本银行本次范围已完成。' });
        } });
      if (!saved && current()) update({ error: '本轮尚未保存，预览已保留。请重试保存。' });
    } catch (error) {
      if (current()) update({ error: error instanceof Error ? error.message : '本轮未保存，请重试。' });
    } finally { if (current()) update({ busy: false }); }
  }
  async function undo() {
    const active = stateRef.current;
    const previous = history.current.at(-1);
    if (active.phase === 'review' || active.busy || optionsRef.current.blocked() || !previous || previous.bankIndex !== active.bankIndex) return;
    const current = currentRun();
    update({ busy: true, error: undefined });
    try {
      const byId = new Map(previous.round.before.map((item) => [item.decision.id, item.decision]));
      const undoIds = previous.round.savedIds ?? previous.round.ids;
      const segments = selectedSegments(undoIds).map((segment) => ({ ...segment, ...structuredClone(byId.get(segment.id)!) }));
      await pool(segments, current, (segment) => optionsRef.current.validate(segment, current));
      await optionsRef.current.persist({ segments, expected: optionsRef.current.snapshots(undoIds), current,
        message: '本轮微调和确认已一起撤销。', onSaved: () => {
          if (!current()) return;
          history.current.pop(); optionsRef.current.clearDraft();
          update({ confirmedIds: previous.confirmedIds, busy: false });
          startRound(previous.bankIndex, previous.round.number, previous.round.sampleId);
          update({ message: '已撤销本轮全部保存和确认，可以重新调整。' });
        } });
    } catch (error) {
      if (current()) update({ error: error instanceof Error ? error.message : '撤销失败，请重试。' });
    } finally { if (current()) update({ busy: false }); }
  }
  function next() {
    if (stateRef.current.phase !== 'round-complete' || stateRef.current.busy || optionsRef.current.blocked()) return;
    startRound(stateRef.current.bankIndex, (stateRef.current.round?.number ?? 0) + 1);
  }
  function additionalAutomaticSegments() {
    const active = stateRef.current;
    const excluded = new Set([...active.scopeIds, ...active.confirmedIds]);
    const candidates = optionsRef.current.segments.filter((segment) => !excluded.has(segment.id)
      && segment.reviewStatus === 'confirmed' && segment.manualAdjusted === false && segment.mode !== 'manual');
    const revisions = new Map(optionsRef.current.snapshots(candidates.map((segment) => segment.id))
      .map((snapshot) => [snapshot.decision.id, snapshot.recordRevision]));
    return candidates.filter((segment) => revisions.get(segment.id) === 0);
  }
  function canExtendBank() {
    const active = stateRef.current;
    const bank = active.banks[active.bankIndex];
    return Boolean(bank?.bankKey && ['round-complete', 'bank-complete'].includes(active.phase)
      && bank.segmentIds.every((id) => active.confirmedIds.has(id)));
  }
  async function openPositions() {
    if (!canExtendBank() || stateRef.current.busy || optionsRef.current.blocked()) return;
    const bankKey = stateRef.current.banks[stateRef.current.bankIndex].bankKey;
    positionReturnPhase.current = stateRef.current.phase as 'round-complete' | 'bank-complete';
    const sessionCurrent = currentRun();
    const request = ++positionGeneration.current;
    const current = () => sessionCurrent() && request === positionGeneration.current;
    update({ phase: 'choosing-position', positionChoices: [], selectedPositionKey: '', busy: true,
      error: undefined, message: '正在查找本银行可继续微调的位置…' });
    try {
      const candidates = additionalAutomaticSegments();
      const missing = [...new Map(candidates.filter((segment) => !pages.current.has(cropPageKey(segment)))
        .map((segment) => [cropPageKey(segment), segment])).values()];
      if (missing.length && optionsRef.current.prefetch) {
        const found = await optionsRef.current.prefetch(missing, current, (done, total) => {
          if (current()) update({ message: `核对其他位置 ${done} / ${total} 页` });
        });
        if (!current()) return;
        for (const segment of missing) {
          const page = found.get(cropPageKey(segment));
          if (page !== undefined) pages.current.set(cropPageKey(segment), page);
        }
      } else if (missing.length) {
        await pool(missing, current, async (segment) => {
          try {
            const page = await optionsRef.current.describe(segment, current);
            if (current()) pages.current.set(cropPageKey(segment), page);
          } catch { /* Unknown sources cannot be added to a verified bank. */ }
        });
      }
      if (!current()) return;
      if (optionsRef.current.blocked()) throw new Error('来源或审核上下文已变化，请退出后重新核对。');
      // Refresh automatic provenance after asynchronous discovery. Previously
      // confirmed/manual rows and all other banks remain outside the scope.
      const choices = buildGuidedReviewGroups(additionalAutomaticSegments(), pages.current)
        .filter((group) => group.bankKey === bankKey);
      update({ positionChoices: choices, selectedPositionKey: choices[0]?.key ?? '', busy: false,
        message: choices.length ? '选择需要调整的位置；已确认的轮次会保留。自动结果正确的位置无需加入。'
          : '没有可加入的同银行位置；已人工确认、单独调整或银行身份无法核实的片段不会加入。' });
    } catch (error) {
      if (current()) update({ busy: false, error: error instanceof Error ? error.message : '无法查找其他位置。' });
    }
  }
  function selectPosition(key: string) {
    if (stateRef.current.phase !== 'choosing-position' || stateRef.current.busy || optionsRef.current.blocked()) return;
    if (stateRef.current.positionChoices.some((choice) => choice.key === key)) update({ selectedPositionKey: key });
  }
  function cancelPositions() {
    if (stateRef.current.phase !== 'choosing-position') return;
    positionGeneration.current += 1;
    update({ phase: positionReturnPhase.current, positionChoices: [], selectedPositionKey: '', busy: false,
      error: undefined, message: '已返回本轮完成状态，已保存和确认的结果保持不变。' });
  }
  function startPosition() {
    const active = stateRef.current;
    if (active.phase !== 'choosing-position' || active.busy || optionsRef.current.blocked()) return;
    const bank = active.banks[active.bankIndex];
    if (!bank?.bankKey) return;
    const choice = active.positionChoices.find((item) => item.key === active.selectedPositionKey);
    const refreshed = buildGuidedReviewGroups(additionalAutomaticSegments(), pages.current)
      .find((item) => item.key === choice?.key && item.bankKey === bank.bankKey);
    if (!choice || !refreshed?.segmentIds.length || refreshed.segmentIds.length !== choice.segmentIds.length
      || refreshed.segmentIds.some((id) => !choice.segmentIds.includes(id))) {
      update({ error: '所选位置的候选已变化，请返回后重新选择。' });
      return;
    }
    for (const id of refreshed.segmentIds) automaticIds.current.add(id);
    const banks = active.banks.map((item, index) => index === active.bankIndex ? { ...item,
      segmentIds: [...item.segmentIds, ...refreshed.segmentIds],
      sourceKeys: [...new Set([...item.sourceKeys, ...refreshed.sourceKeys])],
    } : item);
    update({ banks, scopeIds: [...active.scopeIds, ...refreshed.segmentIds], positionChoices: [], selectedPositionKey: '' });
    startRound(active.bankIndex, (active.round?.number ?? history.current.at(-1)?.round.number ?? 0) + 1, refreshed.segmentIds[0]);
  }
  function completeBank() {
    const active = stateRef.current;
    if (active.phase !== 'bank-complete' || active.busy || optionsRef.current.blocked()) return;
    const bank = active.banks[active.bankIndex];
    if (!selectedSegments(bank.segmentIds).every((segment) => active.confirmedIds.has(segment.id) && segment.reviewStatus === 'confirmed')) return;
    history.current = [];
    if (active.bankIndex + 1 < active.banks.length) startRound(active.bankIndex + 1, 1);
    else update({ phase: 'completed', message: '本次微调范围内的全部银行均已保存并确认，可以选择导出范围。' });
  }
  function exit() {
    if (!['preparing', 'choosing-position'].includes(stateRef.current.phase) && (stateRef.current.busy || optionsRef.current.blocked())) return;
    optionsRef.current.clearDraft(); reset();
  }
  const active = !['entry', 'completed'].includes(state.phase);
  // During a saved round (and while choosing the next position), expose the
  // complete current-bank scope to the navigator. This lets the user inspect
  // every peer that was synchronised by the round before moving on; editing
  // remains restricted to the active round below.
  const reviewScopeIds = ['round-complete', 'bank-complete', 'choosing-position'].includes(state.phase)
    ? state.banks[state.bankIndex]?.segmentIds ?? []
    : state.round?.ids ?? [];
  const allowedIds = active ? new Set(reviewScopeIds) : null;
  function canSelect(id: string) {
    const value = stateRef.current;
    if (['entry', 'completed'].includes(value.phase)) return true;
    if (['round-complete', 'bank-complete', 'choosing-position'].includes(value.phase)) {
      return Boolean(value.banks[value.bankIndex]?.segmentIds.includes(id));
    }
    return Boolean(value.round?.ids.includes(id));
  }
  function completed() {
    const value = stateRef.current;
    const byId = new Map(optionsRef.current.segments.map((segment) => [segment.id, segment]));
    return value.phase === 'completed' && value.scopeIds.length > 0
      && value.scopeIds.every((id) => {
        const segment = byId.get(id);
        return Boolean(segment && value.confirmedIds.has(id) && segment.reviewStatus === 'confirmed');
      });
  }
  const previewSegments: readonly ReviewSegment[] = state.phase === 'review' ? previewPlan.current?.proposedSegments ?? [] : [];
  const previewSkipped: readonly GuidedSkippedItem[] = state.phase === 'review' ? previewPlan.current?.skipped ?? [] : [];
  return { ...state, active, allowedIds, canSelect, completed, enter, preview, previewSegments, save, backToEdit, undo, next, completeBank, exit, reset,
    canExtendBank: canExtendBank(), openPositions, selectPosition, cancelPositions, startPosition,
    undoAvailable: state.phase !== 'review' && history.current.at(-1)?.bankIndex === state.bankIndex,
    bank: state.banks[state.bankIndex],
    bankConfirmedCount: state.banks[state.bankIndex]?.segmentIds.filter((id) => state.confirmedIds.has(id)).length ?? 0,
    previewSkipped };
}
