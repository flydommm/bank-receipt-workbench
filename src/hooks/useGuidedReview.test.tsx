// @vitest-environment jsdom
import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cropPageKey, type CropTemplatePage } from '../domain/batchCrop';
import type { ReviewSegment } from '../domain/cropReview';
import { decisionFromSegment, sameReviewDecision, type ReviewDecisionSnapshot } from '../domain/reviewOperations';
import { useGuidedReview, type GuidedWrite } from './useGuidedReview';

function receipt(id: string, sourceKey: string, sourcePage: number, y = 0): ReviewSegment {
  const box = { x0: 20, y0: y + 20, x1: 580, y1: y + 260 };
  return { id, sourceKey, sourceName: `${sourceKey}.pdf`, sourcePath: `D:/synthetic/${sourceKey}.pdf`,
    sourceSha256: (sourceKey === 'a' ? 'a' : sourceKey === 'b' ? 'b' : 'c').repeat(64),
    sourcePage, segmentNo: 1, matchRect: { x0: 100, y0: y + 100, x1: 200, y1: y + 120 },
    candidateRect: box, finalRect: box, pageWidth: 600, pageHeight: 900, confidence: 0.99,
    slot: 'single', layoutFingerprint: 'page-layout', mode: 'candidate', manualAdjusted: false, reviewStatus: 'confirmed' };
}
const fixtures = () => [receipt('a1', 'a', 1), receipt('a2', 'b', 1), receipt('am', 'a', 2, 350), receipt('b1', 'c', 1)];
function descriptor(segment: ReviewSegment): CropTemplatePage {
  return { status: 'ok', page: segment.sourcePage, page_count: Math.max(2, segment.sourcePage), page_width: 600, page_height: 900,
    source_sha256: segment.sourceSha256, crop_template: { status: 'ready', fingerprint: 'f'.repeat(64), receipts: [{
      anchor_y: segment.candidateRect!.y0 + 20, bounds: { x0: 0, y0: 0, x1: 600, y1: 900 },
      issuer_bank_key: (segment.sourceKey === 'c' ? '2' : '1').repeat(64),
      issuer_bank_name: segment.sourceKey === 'c' ? '合成乙银行' : '合成甲银行',
      title_key: '3'.repeat(64), template_fingerprint: '4'.repeat(64),
    }] } };
}
function harness(initial = fixtures(), options: {
  workIds?: readonly string[];
  prefetch?: (
    segments: ReviewSegment[],
    current: () => boolean,
    onProgress: (done: number, total: number) => void,
  ) => Promise<Map<string, CropTemplatePage>>;
} = {}) {
  const stored = new Map<string, ReviewDecisionSnapshot>(initial.map((segment) => [segment.id,
    { decision: decisionFromSegment(segment), recordRevision: 0 }]));
  const writes: GuidedWrite[] = [];
  let failure = false;
  let blocked = false;
  const validate = vi.fn(async () => {});
  const describePage = vi.fn(async (segment: ReviewSegment) => descriptor(segment));
  const clearDraft = vi.fn();
  const select = vi.fn();
  const workIds = Object.prototype.hasOwnProperty.call(options, 'workIds')
    ? options.workIds : initial.map((segment) => segment.id);
  const hook = renderHook(() => {
    const [segments, setSegments] = useState(initial);
    const guided = useGuidedReview({ segments, workIds,
      prefetch: options.prefetch, blocked: () => blocked, validate, describe: describePage,
      clearDraft, select,
      snapshots: (ids) => ids.map((id) => structuredClone(stored.get(id)!)),
      persist: async (write) => {
        writes.push(write);
        if (failure) return false;
        for (const expected of write.expected) {
          const actual = stored.get(expected.decision.id);
          if (!actual || actual.recordRevision !== expected.recordRevision || !sameReviewDecision(actual.decision, expected.decision))
            throw new Error('审核记录已变化，请重新核对。');
        }
        for (const segment of write.segments) stored.set(segment.id,
          { decision: decisionFromSegment(segment), recordRevision: stored.get(segment.id)!.recordRevision + 1 });
        setSegments((current) => current.map((segment) => ({ ...segment, ...stored.get(segment.id)!.decision })));
        write.onSaved(); return true;
      },
    });
    return { guided, segments };
  });
  return { ...hook, stored, writes, validate, describePage, clearDraft, select,
    fail: (value: boolean) => { failure = value; }, block: (value: boolean) => { blocked = value; } };
}

async function saveRound(h: ReturnType<typeof harness>) {
  if (h.result.current.guided.phase === 'editing') await act(() => h.result.current.guided.preview());
  await act(() => h.result.current.guided.save());
}

describe('guided bank review rounds', () => {
  it('previews every unchanged candidate in the current position before its only save', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter());
    await act(() => h.result.current.guided.save());
    expect(h.writes).toHaveLength(0);
    await act(() => h.result.current.guided.preview());
    expect(h.result.current.guided.phase).toBe('review');
    expect(h.result.current.guided.previewSegments).toEqual(fixtures().slice(0, 2));
    expect(h.result.current.guided.allowedIds).toEqual(new Set(['a1', 'a2']));
    expect(h.result.current.guided.canSelect('a2')).toBe(true);
    expect(h.result.current.guided.canSelect('am')).toBe(false);
    expect(h.writes).toHaveLength(0);
    expect(h.result.current.guided.message).toContain('尚未保存');
    await act(() => h.result.current.guided.save());
    expect(h.writes).toHaveLength(1);
    expect(h.result.current.guided.bankConfirmedCount).toBe(2);
    // A saved round keeps the whole current-bank scope visible so peers can
    // be inspected before advancing to another position.
    expect(h.result.current.guided.allowedIds).toEqual(new Set(['a1', 'a2', 'am']));
    expect(h.result.current.guided.canSelect('am')).toBe(true);
  });

  it('restores the edited sample and original round membership when returning from a reduced preview', async () => {
    const values = fixtures();
    values[1] = { ...values[1], manualAdjusted: true, mode: 'manual' };
    const h = harness(values);
    h.stored.get('a2')!.recordRevision = 2;
    await act(() => h.result.current.guided.enter());
    const sample = { ...values[0], mode: 'manual' as const, manualAdjusted: true,
      finalRect: { ...values[0].finalRect!, y0: 24, y1: 264 } };
    await act(() => h.result.current.guided.preview(sample));
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
    expect(h.result.current.guided.previewSegments.map((segment) => segment.id)).toEqual(['a1']);
    expect(h.result.current.guided.scopeIds).toEqual(['a1', 'a2', 'am', 'b1']);
    let restored: ReviewSegment | null = null;
    act(() => { restored = h.result.current.guided.backToEdit(); });
    expect(restored).toEqual(sample);
    expect(h.select).toHaveBeenLastCalledWith(sample);
    expect(h.result.current.guided.round?.sampleId).toBe('a1');
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
    expect(h.result.current.guided.previewSegments).toEqual([]);
    expect(h.result.current.guided.phase).toBe('editing');
    expect(h.result.current.segments).toEqual(values);
    expect(h.writes).toHaveLength(0);
  });

  it('rejects a changed durable revision instead of refreshing the pre-preview CAS baseline', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter());
    await act(() => h.result.current.guided.preview());
    h.stored.get('a2')!.recordRevision = 1;
    await act(() => h.result.current.guided.save());
    expect(h.writes[0].expected.map((snapshot) => snapshot.recordRevision)).toEqual([0, 0]);
    expect(h.result.current.guided.phase).toBe('review');
    expect(h.result.current.guided.error).toContain('审核记录已变化');
    expect(h.result.current.guided.previewSegments).toHaveLength(2);
    expect(h.result.current.guided.confirmedIds.size).toBe(0);
    expect(h.stored.get('a1')!.recordRevision).toBe(0);
    await act(() => h.result.current.guided.save());
    expect(h.writes[1].expected).toEqual(h.writes[0].expected);
    expect(h.result.current.guided.undoAvailable).toBe(false);
  });

  it('revalidates sources before saving and retains the preview if source validation fails', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter());
    await act(() => h.result.current.guided.preview());
    h.validate.mockClear();
    h.validate.mockRejectedValueOnce(new Error('原件已变化'));
    await act(() => h.result.current.guided.save());
    expect(h.validate).toHaveBeenCalled();
    expect(h.writes).toHaveLength(0);
    expect(h.result.current.guided.phase).toBe('review');
    expect(h.result.current.guided.error).toContain('原件已变化');
  });

  it('does not persist when the context becomes blocked during final validation', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter());
    await act(() => h.result.current.guided.preview());
    h.validate.mockImplementation(async () => { h.block(true); });
    await act(() => h.result.current.guided.save());
    expect(h.writes).toHaveLength(0);
    expect(h.result.current.guided.phase).toBe('review');
    expect(h.result.current.guided.error).toContain('上下文已变化');
    expect(h.result.current.guided.backToEdit()).toBeNull();
  });

  it('accepts an original durable-save retry callback once and invalidates it after returning to edit', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter());
    await act(() => h.result.current.guided.preview());
    h.fail(true);
    await act(() => h.result.current.guided.save());
    const cancelled = h.writes[0];
    expect(cancelled.current()).toBe(true);
    act(() => { h.result.current.guided.backToEdit(); });
    expect(cancelled.current()).toBe(false);
    act(() => cancelled.onSaved());
    expect(h.result.current.guided.phase).toBe('editing');
    await act(() => h.result.current.guided.preview());
    await act(() => h.result.current.guided.save());
    const retry = h.writes[1];
    expect(retry.current()).toBe(true);
    // App owns the pending durable write and retries that original callback.
    // Its pending-operation block must not invalidate its own successful write.
    h.block(true);
    act(() => retry.onSaved());
    expect(h.result.current.guided.phase).toBe('round-complete');
    expect(h.result.current.guided.confirmedIds.size).toBe(2);
    expect(retry.current()).toBe(false);
    act(() => retry.onSaved());
    expect(h.result.current.guided.confirmedIds.size).toBe(2);
  });

  it('discards unsaved previews on exit and ignores a late preview after reset', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter());
    await act(() => h.result.current.guided.preview());
    act(() => h.result.current.guided.exit());
    expect(h.result.current.guided.previewSegments).toEqual([]);
    expect(h.writes).toHaveLength(0);
    await act(() => h.result.current.guided.enter());
    const resolvers: (() => void)[] = [];
    h.validate.mockImplementation(() => new Promise<void>((resolve) => { resolvers.push(resolve); }));
    let preparing!: Promise<void>;
    act(() => { preparing = h.result.current.guided.preview(); });
    act(() => h.result.current.guided.reset());
    await act(async () => { resolvers.forEach((resolve) => resolve()); await preparing; });
    expect(h.result.current.guided.phase).toBe('entry');
    expect(h.result.current.guided.previewSegments).toEqual([]);
    expect(h.result.current.guided.confirmedIds.size).toBe(0);
    expect(h.writes).toHaveLength(0);
  });

  it('keeps a frozen adjusted sample while the caller continues changing its draft object', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter());
    const sample = { ...h.result.current.segments[0], mode: 'manual' as const, manualAdjusted: true,
      finalRect: { x0: 20, y0: 24, x1: 580, y1: 264 } };
    await act(() => h.result.current.guided.preview(sample));
    sample.finalRect.y0 = 99;
    expect(h.result.current.guided.previewSegments[0].finalRect?.y0).toBe(24);
    await act(() => h.result.current.guided.save());
    expect(h.writes[0].segments.map((segment) => segment.finalRect?.y0)).toEqual([24, 24]);
  });

  it('starts with the selected position and restores its sample when undoing that round', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter('am'));
    expect(h.result.current.guided.round?.ids).toEqual(['am']);
    expect(h.result.current.guided.message).toBe('先调整当前样本；确认调整后预览本轮全部片段，检查完成再保存本轮。');
    expect(h.result.current.guided.round?.sampleId).toBe('am');
    expect(h.select).toHaveBeenLastCalledWith(h.result.current.segments[2]);
    await saveRound(h);
    act(() => h.result.current.guided.next());
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
    await act(() => h.result.current.guided.undo());
    expect(h.result.current.guided.round?.sampleId).toBe('am');
    expect(h.result.current.guided.round?.number).toBe(1);
    expect(h.result.current.guided.confirmedIds.size).toBe(0);
    expect(h.select).toHaveBeenLastCalledWith(h.result.current.segments[2]);
  });

  it('keeps a selected sample from another PDF within the same bank and position', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter('a2'));
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
    expect(h.result.current.guided.round?.sampleId).toBe('a2');
    expect(h.select).toHaveBeenLastCalledWith(h.result.current.segments[1]);
    await saveRound(h);
    await act(() => h.result.current.guided.undo());
    expect(h.result.current.guided.round?.sampleId).toBe('a2');
  });

  it('starts with the selected bank without skipping any other bank or remaining position', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter('b1'));
    expect(h.result.current.guided.bank?.label).toBe('合成乙银行');
    expect(h.result.current.guided.round?.ids).toEqual(['b1']);
    await saveRound(h);
    act(() => h.result.current.guided.next());
    act(() => h.result.current.guided.completeBank());
    expect(h.result.current.guided.bank?.label).toBe('合成甲银行');
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
    await saveRound(h);
    act(() => h.result.current.guided.next());
    expect(h.result.current.guided.round?.ids).toEqual(['am']);
    await saveRound(h);
    act(() => h.result.current.guided.next());
    act(() => h.result.current.guided.completeBank());
    expect(h.result.current.guided.completed()).toBe(true);
    expect([...h.result.current.guided.confirmedIds].sort()).toEqual(['a1', 'a2', 'am', 'b1']);
  });

  it('falls back to the first available round when the preferred segment no longer exists', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter('removed'));
    expect(h.result.current.guided.round?.sampleId).toBe('a1');
    expect(h.result.current.guided.banks).toHaveLength(2);
    expect(h.writes).toHaveLength(0);
  });

  it('ignores an old preparation result after exiting and entering from a new selection', async () => {
    const h = harness();
    const resolvers: (() => void)[] = [];
    h.describePage.mockImplementation((segment) => new Promise((done) => {
      resolvers.push(() => done(descriptor(segment)));
    }));
    let oldEntry!: Promise<void>;
    act(() => { oldEntry = h.result.current.guided.enter('a1'); });
    expect(h.result.current.guided.phase).toBe('preparing');
    expect(h.select).not.toHaveBeenCalled();
    act(() => h.result.current.guided.exit());
    h.describePage.mockImplementation(async (segment) => descriptor(segment));
    await act(() => h.result.current.guided.enter('am'));
    expect(h.result.current.guided.round?.sampleId).toBe('am');
    await act(async () => { resolvers.forEach((resolve) => resolve()); await oldEntry; });
    expect(h.result.current.guided.round?.sampleId).toBe('am');
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.writes).toHaveLength(0);
  });

  it('merges PDFs by bank and requires explicit round and bank completion despite automatic confirmed statuses', async () => {
    const h = harness();
    expect(h.result.current.guided.phase).toBe('entry');
    expect(h.result.current.guided.completed()).toBe(false);
    await act(() => h.result.current.guided.enter());
    expect(h.result.current.guided.banks).toHaveLength(2);
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
    expect(h.result.current.guided.canSelect('am')).toBe(false);
    expect(h.result.current.guided.canSelect('b1')).toBe(false);
    await saveRound(h);
    expect(h.result.current.guided.phase).toBe('round-complete');
    expect(h.result.current.guided.bankConfirmedCount).toBe(2);
    act(() => h.result.current.guided.completeBank());
    expect(h.result.current.guided.bankIndex).toBe(0);
    act(() => h.result.current.guided.next());
    expect(h.result.current.guided.round?.ids).toEqual(['am']);
    await saveRound(h);
    act(() => h.result.current.guided.next());
    expect(h.result.current.guided.phase).toBe('bank-complete');
    act(() => h.result.current.guided.completeBank());
    expect(h.result.current.guided.bankIndex).toBe(1);
    expect(h.result.current.guided.undoAvailable).toBe(false);
    await saveRound(h);
    act(() => h.result.current.guided.next());
    expect(h.result.current.guided.completed()).toBe(false);
    act(() => h.result.current.guided.completeBank());
    expect(h.result.current.guided.completed()).toBe(true);
  });

  it('previews the exact linked round without writing and saves or undoes all decisions atomically', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter());
    const sample = h.result.current.segments[0];
    await act(() => h.result.current.guided.preview({ ...sample, mode: 'manual', manualAdjusted: true,
      finalRect: { ...sample.finalRect!, y0: 22, y1: 262 } }));
    expect(h.result.current.guided.phase).toBe('review');
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
    expect(h.result.current.segments).toEqual(fixtures());
    expect(h.writes).toHaveLength(0);
    expect(h.result.current.guided.previewSegments.map((segment) => [segment.id, segment.finalRect?.y0])).toEqual([['a1', 22], ['a2', 22]]);
    expect(h.result.current.guided.undoAvailable).toBe(false);
    expect(h.result.current.guided.confirmedIds.size).toBe(0);
    act(() => h.result.current.guided.next());
    expect(h.result.current.guided.phase).toBe('review');
    await saveRound(h);
    expect(h.result.current.guided.phase).toBe('round-complete');
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].segments.map((segment) => segment.reviewStatus)).toEqual(['confirmed', 'confirmed']);
    expect(h.result.current.guided.previewSegments).toEqual([]);
    act(() => h.result.current.guided.next());
    await act(() => h.result.current.guided.undo());
    expect(h.writes.at(-1)?.segments.map((segment) => segment.id)).toEqual(['a1', 'a2']);
    expect(h.result.current.segments.slice(0, 2)).toEqual(fixtures().slice(0, 2));
    expect(h.result.current.guided.confirmedIds.size).toBe(0);
    expect(h.result.current.guided.round?.number).toBe(1);
    await act(() => h.result.current.guided.preview({ ...sample, mode: 'manual', manualAdjusted: true,
      finalRect: { ...sample.finalRect!, y0: 24, y1: 264 } }));
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
    expect(h.result.current.guided.previewSegments[1].finalRect?.y0).toBe(24);
    expect(h.result.current.segments[1].finalRect?.y0).toBe(20);
  });

  it('retains its preview after a failed save and commits the same frozen round on a successful retry', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter());
    h.fail(true);
    await saveRound(h);
    expect(h.result.current.guided.phase).toBe('review');
    expect(h.result.current.guided.confirmedIds.size).toBe(0);
    expect(h.result.current.guided.completed()).toBe(false);
    h.fail(false);
    await saveRound(h);
    expect(h.writes[0].segments.map((s) => s.id)).toEqual(h.writes[1].segments.map((s) => s.id));
    expect(h.writes[0].expected).toEqual(h.writes[1].expected);
    expect(h.result.current.guided.phase).toBe('round-complete');
  });

  it('protects independently edited peers, leaving them for a later round', async () => {
    const values = fixtures();
    values[1] = { ...values[1], manualAdjusted: true, mode: 'manual' };
    const h = harness(values);
    h.stored.get('a2')!.recordRevision = 2;
    await act(() => h.result.current.guided.enter());
    await act(() => h.result.current.guided.preview({ ...values[0], mode: 'manual', manualAdjusted: true,
      finalRect: { ...values[0].finalRect!, y0: 22, y1: 262 } }));
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
    expect(h.stored.get('a2')!.recordRevision).toBe(2);
    await saveRound(h);
    act(() => h.result.current.guided.next());
    expect(h.result.current.guided.round?.ids).toEqual(['a2']);
  });

  it('preserves saved rectangles but clears completion proof after exiting and reentering', async () => {
    const h = harness([fixtures()[0]]);
    await act(() => h.result.current.guided.enter());
    await saveRound(h);
    const stored = structuredClone(h.stored.get('a1'));
    act(() => h.result.current.guided.exit());
    await act(() => h.result.current.guided.enter());
    expect(h.stored.get('a1')).toEqual(stored);
    expect(h.result.current.guided.confirmedIds.size).toBe(0);
    expect(h.result.current.guided.phase).toBe('editing');
    expect(h.result.current.guided.undoAvailable).toBe(false);
  });

  it('does not write a round whose geometry fails validation or accept a late completion after reset', async () => {
    const h = harness();
    await act(() => h.result.current.guided.enter());
    h.validate.mockRejectedValueOnce(new Error('合成页面几何校验失败'));
    await saveRound(h);
    expect(h.writes).toHaveLength(0);
    expect(h.result.current.guided.error).toContain('几何校验失败');
    expect(h.result.current.guided.bankIndex).toBe(0);
    h.fail(true);
    await saveRound(h);
    const delayed = h.writes[0];
    act(() => h.result.current.guided.reset());
    act(() => delayed.onSaved());
    expect(h.result.current.guided.phase).toBe('entry');
    expect(h.result.current.guided.confirmedIds.size).toBe(0);
    expect(h.result.current.guided.completed()).toBe(false);
  });

  it('cancels pending identity reads without resurrecting the workflow', async () => {
    const h = harness();
    const resolvers: ((page: CropTemplatePage) => void)[] = [];
    h.describePage.mockImplementation(() => new Promise((done) => { resolvers.push(done); }));
    let entering!: Promise<void>;
    act(() => { entering = h.result.current.guided.enter(); });
    await waitFor(() => expect(h.result.current.guided.phase).toBe('preparing'));
    act(() => h.result.current.guided.exit());
    // Both lazy workers must be released for the parent Promise to settle.
    await act(async () => { for (const resolve of resolvers) resolve(descriptor(fixtures()[0])); await entering; });
    expect(h.result.current.guided.phase).toBe('entry');
    expect(h.result.current.guided.completed()).toBe(false);
    h.unmount();
  });

  it('defaults to unresolved rows and adds an explicitly selected confirmed row', async () => {
    const values = fixtures().map((segment, index) => ({ ...segment,
      reviewStatus: index === 2 ? 'needs_review' as const : 'confirmed' as const }));
    const h = harness(values, { workIds: undefined });

    await act(() => h.result.current.guided.enter('a1'));

    expect(h.result.current.guided.scopeIds).toEqual(['a1', 'a2', 'am']);
    expect(h.describePage).toHaveBeenCalledTimes(4);
    expect(h.result.current.guided.round?.sampleId).toBe('a1');
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
  });

  it('uses bulk prefetch only for the explicit work scope and completes that scope alone', async () => {
    const prefetch = vi.fn(async (
      segments: ReviewSegment[],
      current: () => boolean,
      onProgress: (done: number, total: number) => void,
    ) => {
      expect(current()).toBe(true);
      onProgress(segments.length, segments.length);
      return new Map(segments.map((segment) => [cropPageKey(segment), descriptor(segment)]));
    });
    const values = fixtures().map((segment, index) => ({ ...segment,
      reviewStatus: index === 2 ? 'needs_review' as const : 'confirmed' as const }));
    const h = harness(values, { workIds: ['a1', 'am'], prefetch });

    await act(() => h.result.current.guided.enter('am'));

    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch.mock.calls[0]?.[0].map((segment) => segment.id)).toEqual(['a1', 'am']);
    expect(h.describePage).not.toHaveBeenCalled();
    expect(h.result.current.guided.scopeIds).toEqual(['a1', 'am']);
    expect(h.result.current.guided.round?.sampleId).toBe('am');

    await saveRound(h);
    act(() => h.result.current.guided.next());
    await saveRound(h);
    act(() => h.result.current.guided.next());
    act(() => h.result.current.guided.completeBank());

    expect(h.result.current.guided.phase).toBe('completed');
    expect(h.result.current.guided.completed()).toBe(true);
    expect([...h.result.current.guided.confirmedIds].sort()).toEqual(['a1', 'am']);
  });

  it('keeps an explicitly refined automatic sample eligible to sync untouched automatic peers', async () => {
    const h = harness(fixtures(), { workIds: ['a2'] });
    await act(() => h.result.current.guided.enter('a1'));

    expect(h.result.current.guided.scopeIds).toEqual(['a1', 'a2']);
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
    await act(() => h.result.current.guided.preview({ ...h.result.current.segments[0]!, mode: 'manual', manualAdjusted: true,
      finalRect: { ...h.result.current.segments[0]!.finalRect!, y0: 24, y1: 264 } }));

    expect(h.writes).toHaveLength(0);
    expect(h.result.current.guided.previewSegments.map((segment) => segment.id)).toEqual(['a1', 'a2']);
    await act(() => h.result.current.guided.save());
    expect(h.writes[0].segments.map((segment) => segment.id)).toEqual(['a1', 'a2']);
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
  });

  it('returns to entry when the review context becomes blocked during bulk preparation', async () => {
    let resolvePrefetch!: (pages: Map<string, CropTemplatePage>) => void;
    const prefetch = vi.fn(() => new Promise<Map<string, CropTemplatePage>>((resolve) => {
      resolvePrefetch = resolve;
    }));
    const h = harness(fixtures(), { workIds: ['am'], prefetch });
    let entering!: Promise<void>;

    act(() => { entering = h.result.current.guided.enter('am'); });
    await waitFor(() => expect(h.result.current.guided.phase).toBe('preparing'));
    h.block(true);
    resolvePrefetch(new Map());
    await act(() => entering);

    expect(h.result.current.guided.phase).toBe('entry');
    expect(h.result.current.guided.busy).toBe(false);
    expect(h.result.current.guided.error).toContain('上下文已变化');
  });

  it('continues from 15 confirmed tail receipts to another position without rereading pages or losing undo history', async () => {
    const tails = Array.from({ length: 15 }, (_, index) => receipt(`tail-${index}`, 'a', index + 1, 600));
    const top = [receipt('top-a', 'a', 16), receipt('top-b', 'b', 1)];
    const middle = receipt('middle', 'a', 17, 350);
    const h = harness([...tails, ...top, middle, receipt('other-bank', 'c', 1)], { workIds: undefined });
    await act(() => h.result.current.guided.enter(tails[0].id));
    expect(h.result.current.guided.scopeIds).toEqual(tails.map((segment) => segment.id));
    await saveRound(h);
    const reads = h.describePage.mock.calls.length;
    expect(h.result.current.guided.bankConfirmedCount).toBe(15);
    expect(h.result.current.guided.canExtendBank).toBe(true);

    await act(() => h.result.current.guided.openPositions());
    expect(h.describePage).toHaveBeenCalledTimes(reads);
    expect(h.result.current.guided.positionChoices.map((choice) => choice.segmentIds)).toEqual([['top-a', 'top-b'], ['middle']]);
    expect(h.result.current.guided.scopeIds).toHaveLength(15);
    act(() => h.result.current.guided.startPosition());
    expect(h.result.current.guided.round?.number).toBe(2);
    expect(h.result.current.guided.round?.ids).toEqual(['top-a', 'top-b']);
    expect(h.result.current.guided.confirmedIds.size).toBe(15);

    const sample = h.result.current.segments.find((segment) => segment.id === 'top-a')!;
    const adjusted = { ...sample, mode: 'manual' as const, manualAdjusted: true,
      finalRect: { ...sample.finalRect!, y0: 24, y1: 264 } };
    h.fail(true);
    await act(() => h.result.current.guided.preview(adjusted));
    await act(() => h.result.current.guided.save());
    expect(h.result.current.guided.phase).toBe('review');
    expect(h.result.current.guided.confirmedIds.size).toBe(15);
    h.fail(false);
    expect(h.result.current.guided.round?.ids).toEqual(['top-a', 'top-b']);
    await saveRound(h);
    expect(h.result.current.guided.bankConfirmedCount).toBe(17);
    await act(() => h.result.current.guided.undo());
    expect(h.result.current.guided.round?.number).toBe(2);
    expect(h.result.current.guided.confirmedIds.size).toBe(15);
    expect(h.result.current.segments.filter((segment) => segment.id.startsWith('tail-')).every((segment) => segment.reviewStatus === 'confirmed')).toBe(true);
    await saveRound(h);
    await act(() => h.result.current.guided.openPositions());
    expect(h.result.current.guided.positionChoices.map((choice) => choice.segmentIds)).toEqual([['middle']]);
    act(() => h.result.current.guided.cancelPositions());
    expect(h.result.current.guided.phase).toBe('round-complete');
    expect(h.result.current.guided.confirmedIds.size).toBe(17);
    expect(h.result.current.guided.scopeIds).toHaveLength(17);
  });

  it('keeps an eight-pending entry narrow and discovers only missing pages after an explicit continuation request', async () => {
    const pending = Array.from({ length: 8 }, (_, index) => ({ ...receipt(`pending-${index}`, 'a', index + 1, 600), reviewStatus: 'needs_review' as const }));
    const automatic = [receipt('top', 'a', 9), receipt('middle', 'a', 10, 350)];
    const prefetch = vi.fn(async (segments: ReviewSegment[]) => new Map(segments.map((segment) => [cropPageKey(segment), descriptor(segment)])));
    const h = harness([...pending, ...automatic], { workIds: undefined, prefetch });
    await act(() => h.result.current.guided.enter('pending-0'));
    expect(prefetch.mock.calls[0][0]).toHaveLength(8);
    expect(h.result.current.guided.scopeIds).toHaveLength(8);
    await saveRound(h);
    expect(h.result.current.guided.round?.ids).toHaveLength(8);
    expect(h.result.current.guided.bankConfirmedCount).toBe(8);
    expect(h.writes[0]?.segments).toHaveLength(8);
    expect(h.writes[0]?.segments.every((segment) => segment.reviewStatus === 'confirmed')).toBe(true);
    expect(prefetch).toHaveBeenCalledTimes(1);
    await act(() => h.result.current.guided.openPositions());
    expect(prefetch.mock.calls[1][0].map((segment) => segment.id)).toEqual(['top', 'middle']);
    act(() => h.result.current.guided.cancelPositions());
    await act(() => h.result.current.guided.openPositions());
    expect(prefetch).toHaveBeenCalledTimes(2);
    expect(h.result.current.guided.scopeIds).toHaveLength(8);
  });

  it('keeps skipped same-position targets visible for follow-up review instead of dropping them from the round', async () => {
    const values = fixtures().slice(0, 2).map((segment) => ({ ...segment, reviewStatus: 'needs_review' as const }));
    const prefetch = vi.fn(async (segments: ReviewSegment[]) => new Map(segments.map((segment) => {
      const page = descriptor(segment);
      if (segment.id === 'a2' && page.crop_template.status === 'ready') {
        page.crop_template.receipts[0]!.bounds = { x0: 100, y0: 0, x1: 500, y1: 900 };
      }
      return [cropPageKey(segment), page];
    })));
    const h = harness(values, { workIds: values.map((segment) => segment.id), prefetch });
    await act(() => h.result.current.guided.enter('a1'));
    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
    const sample = { ...h.result.current.segments[0]!, mode: 'manual' as const, manualAdjusted: true,
      finalRect: { ...h.result.current.segments[0]!.finalRect!, y0: 24, y1: 264 } };
    await act(() => h.result.current.guided.preview(sample));

    expect(h.result.current.guided.round?.ids).toEqual(['a1', 'a2']);
    expect(h.result.current.guided.previewSegments.map((segment) => segment.id)).toEqual(['a1']);
    expect(h.result.current.guided.previewSkipped).toEqual([{ id: 'a2', reason: '批量调整后的裁剪超出凭证保护边界。' }]);
    await act(() => h.result.current.guided.save());
    expect(h.result.current.guided.confirmedIds).toEqual(new Set(['a1']));
    act(() => h.result.current.guided.next());
    expect(h.result.current.guided.round?.ids).toEqual(['a2']);
  });

  it('excludes other banks, unknown identities and manual or user-confirmed rows from extra positions', async () => {
    const values = [receipt('sample', 'a', 1, 600), receipt('top', 'a', 2), receipt('user-confirmed', 'a', 3),
      { ...receipt('manual', 'a', 4), manualAdjusted: true, mode: 'manual' as const },
      receipt('unknown', 'a', 5), receipt('other-bank', 'c', 1)];
    const h = harness(values, { workIds: undefined });
    h.stored.get('user-confirmed')!.recordRevision = 1;
    h.describePage.mockImplementation(async (segment) => segment.id === 'unknown'
      ? { ...descriptor(segment), crop_template: { status: 'unavailable', reason: 'ambiguous_layout' } }
      : descriptor(segment));
    await act(() => h.result.current.guided.enter('sample'));
    await saveRound(h);
    await act(() => h.result.current.guided.openPositions());
    expect(h.result.current.guided.positionChoices.map((choice) => choice.segmentIds)).toEqual([['top']]);
    // Another writer confirming a displayed option makes the frozen selection invalid.
    h.stored.get('top')!.recordRevision = 1;
    act(() => h.result.current.guided.startPosition());
    expect(h.result.current.guided.phase).toBe('choosing-position');
    expect(h.result.current.guided.error).toContain('候选已变化');
    expect(h.result.current.guided.scopeIds).toEqual(['sample']);
  });

  it('cancels late position discovery and rejects a changed source without discarding completed rounds', async () => {
    const sample = { ...receipt('sample', 'a', 1, 600), reviewStatus: 'needs_review' as const };
    const h = harness([sample, receipt('top', 'a', 2)], { workIds: undefined });
    await act(() => h.result.current.guided.enter('sample'));
    await saveRound(h);
    let resolve!: (page: CropTemplatePage) => void;
    h.describePage.mockImplementation(() => new Promise((done) => { resolve = done; }));
    let discovery!: Promise<void>;
    act(() => { discovery = h.result.current.guided.openPositions(); });
    expect(h.result.current.guided.busy).toBe(true);
    act(() => h.result.current.guided.cancelPositions());
    await act(async () => { resolve(descriptor(receipt('top', 'a', 2))); await discovery; });
    expect(h.result.current.guided.phase).toBe('round-complete');
    expect(h.result.current.guided.confirmedIds.size).toBe(1);
    expect(h.result.current.guided.positionChoices).toEqual([]);

    act(() => { discovery = h.result.current.guided.openPositions(); });
    h.block(true);
    await act(async () => { resolve(descriptor(receipt('top', 'a', 2))); await discovery; });
    expect(h.result.current.guided.error).toContain('上下文已变化');
    expect(h.result.current.guided.positionChoices).toEqual([]);
    act(() => h.result.current.guided.startPosition());
    expect(h.result.current.guided.scopeIds).toEqual(['sample']);
    expect(h.writes).toHaveLength(1);
  });

  it('does not make empty rounds or infer a bank from an unknown source when continuing', async () => {
    const h = harness([receipt('sample', 'a', 1)], { workIds: undefined });
    await act(() => h.result.current.guided.enter('sample'));
    await saveRound(h);
    await act(() => h.result.current.guided.openPositions());
    expect(h.result.current.guided.positionChoices).toEqual([]);
    act(() => h.result.current.guided.startPosition());
    expect(h.result.current.guided.phase).toBe('choosing-position');
    act(() => h.result.current.guided.cancelPositions());
    act(() => h.result.current.guided.next());
    act(() => h.result.current.guided.completeBank());
    expect(h.result.current.guided.completed()).toBe(true);

    act(() => h.result.current.guided.exit());
    h.describePage.mockImplementation(async (segment) => ({ ...descriptor(segment), crop_template: { status: 'unavailable', reason: 'ambiguous_layout' } }));
    await act(() => h.result.current.guided.enter('sample'));
    await saveRound(h);
    expect(h.result.current.guided.canExtendBank).toBe(false);
    await act(() => h.result.current.guided.openPositions());
    expect(h.result.current.guided.phase).toBe('round-complete');
  });

  it.each(['unavailable', 'missing-bank', 'request-failed'])('explains one-item rounds without assuming OCR is broken: %s', async (failure) => {
    const values = [receipt('one', 'a', 1), receipt('two', 'a', 2)]
      .map((segment) => ({ ...segment, reviewStatus: 'needs_review' as const }));
    const h = harness(values, { workIds: undefined });
    h.describePage.mockImplementation(async (segment) => {
      if (failure === 'request-failed') throw new Error('synthetic descriptor failure');
      const page = descriptor(segment);
      if (failure === 'unavailable') return { ...page, crop_template: { status: 'unavailable', reason: 'ambiguous_layout' } };
      if (page.crop_template.status !== 'ready') throw new Error('invalid fixture');
      return { ...page, crop_template: { ...page.crop_template, receipts: page.crop_template.receipts.map((item) => ({
        ...item, issuer_bank_key: null, issuer_bank_name: null, template_fingerprint: null,
      })) } };
    });
    await act(() => h.result.current.guided.enter('one'));
    expect(h.result.current.guided.round?.ids).toEqual(['one']);
    expect(h.result.current.guided.message).toContain('本轮仅处理当前 1 处，不会同步其他片段');
    expect(h.result.current.guided.message).toContain('若银行标识是图片');
    expect(h.result.current.guided.message).toContain('检测 OCR，正常后重新分析原 PDF');
    await saveRound(h);
    act(() => h.result.current.guided.next());
    expect(h.result.current.guided.round?.ids).toEqual(['two']);
    expect(h.result.current.guided.message).toContain('本轮仅处理当前 1 处，不会同步其他片段');
    expect(h.writes[0].segments.map((segment) => segment.id)).toEqual(['one']);
  });
});
