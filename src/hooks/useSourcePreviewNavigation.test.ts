// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  sourceDocumentKey,
  type NavigableSegment,
  type SourceDocument,
} from '../domain/sourcePreview';
import { useSourcePreviewNavigation } from './useSourcePreviewNavigation';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SOURCE_A = 'D:\\input\\a.pdf';
const SOURCE_B = 'D:\\input\\b.pdf';

const documents: SourceDocument[] = [
  {
    key: sourceDocumentKey(SOURCE_A, SHA_A),
    name: 'a.pdf',
    sourcePath: SOURCE_A,
    sourceSha256: SHA_A,
    pageCount: 3,
    integrityStatus: 'valid',
  },
  {
    key: sourceDocumentKey(SOURCE_B, SHA_B),
    name: 'b.pdf',
    sourcePath: SOURCE_B,
    sourceSha256: SHA_B,
    pageCount: 6,
    integrityStatus: 'valid',
  },
];

function segment(overrides: Partial<NavigableSegment> = {}): NavigableSegment {
  return {
    id: 'segment-1',
    sourcePath: SOURCE_A,
    sourcePage: 2,
    reviewStatus: 'confirmed',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSourcePreviewNavigation', () => {
  it('replaceSources selects the first source before metadata exists', () => {
    const onRevealSegment = vi.fn();
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment,
    }));

    act(() => result.current.replaceSources([
      { name: 'a.pdf', sourcePath: SOURCE_A },
    ]));

    expect(result.current.documents).toEqual([]);
    expect(result.current.activeSourcePath).toBe(SOURCE_A);
    expect(result.current.activeDocument).toBeNull();
    expect(result.current.previewLocation).toBeNull();
    expect(result.current.pageDraft).toBe('');
    expect(result.current.pageInputError).toBe('');
    expect(onRevealSegment).not.toHaveBeenCalled();
  });

  it('commitDocuments opens the first source at page one when no initial segment is supplied', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.replaceSources([
      { name: 'a.pdf', sourcePath: SOURCE_A },
      { name: 'b.pdf', sourcePath: SOURCE_B },
    ]));
    act(() => result.current.commitDocuments(documents));

    expect(result.current.activeSourcePath).toBe(SOURCE_A);
    expect(result.current.activeDocument).toEqual(documents[0]);
    expect(result.current.previewLocation).toEqual({
      documentKey: documents[0].key,
      page: 1,
    });
    expect(result.current.pageDraft).toBe('1');
  });

  it('commitDocuments atomically opens an initial segment from the passed document batch', () => {
    const onRevealSegment = vi.fn();
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment,
    }));
    const initialSegment = segment({
      id: 'second-source-hit',
      sourcePath: SOURCE_B,
      sourcePage: 4,
      reviewStatus: 'needs_review',
    });

    act(() => result.current.replaceSources([
      { name: 'a.pdf', sourcePath: SOURCE_A },
      { name: 'b.pdf', sourcePath: SOURCE_B },
    ]));
    act(() => result.current.selectSource(SOURCE_B));
    act(() => result.current.commitDocuments(documents, initialSegment));

    expect(result.current.activeSourcePath).toBe(SOURCE_B);
    expect(result.current.activeDocument).toEqual(documents[1]);
    expect(result.current.previewLocation).toEqual({
      documentKey: sourceDocumentKey(SOURCE_B, SHA_B),
      page: 4,
    });
    expect(result.current.pageDraft).toBe('4');
    expect(onRevealSegment).toHaveBeenLastCalledWith('second-source-hit');
  });

  it('showSegment synchronizes source page and selected segment', () => {
    const onRevealSegment = vi.fn();
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment,
    }));
    const selectedSegment = segment({
      id: 'selected',
      sourcePath: SOURCE_B,
      sourcePage: 5,
      reviewStatus: 'pending',
    });

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.showSegment(selectedSegment));

    expect(result.current.activeSourcePath).toBe(SOURCE_B);
    expect(result.current.previewLocation).toEqual({
      documentKey: documents[1].key,
      page: 5,
    });
    expect(result.current.pageDraft).toBe('5');
    expect(onRevealSegment).toHaveBeenLastCalledWith('selected');
  });

  it('page navigation reveals the first unresolved segment', () => {
    const onRevealSegment = vi.fn();
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [
        segment({ id: 'confirmed' }),
        segment({ id: 'pending', reviewStatus: 'needs_review' }),
      ],
      onRevealSegment,
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.goToPage(2));

    expect(result.current.previewLocation?.page).toBe(2);
    expect(onRevealSegment).toHaveBeenLastCalledWith('pending');
  });

  it('page navigation keeps the previous selection on a no-hit page', () => {
    const onRevealSegment = vi.fn();
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [segment({ id: 'current', sourcePage: 2 })],
      onRevealSegment,
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.goToPage(2));
    expect(onRevealSegment).toHaveBeenCalledTimes(1);
    act(() => result.current.goToPage(3));

    expect(result.current.previewLocation?.page).toBe(3);
    expect(onRevealSegment).toHaveBeenCalledTimes(1);
    expect(onRevealSegment).toHaveBeenLastCalledWith('current');
  });

  it('selecting another source opens page one', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.goToPage(3));
    act(() => result.current.selectSource(SOURCE_B));

    expect(result.current.activeSourcePath).toBe(SOURCE_B);
    expect(result.current.previewLocation).toEqual({
      documentKey: documents[1].key,
      page: 1,
    });
    expect(result.current.pageDraft).toBe('1');
  });

  it('preselects an unknown source only while metadata is empty', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.selectSource(SOURCE_B));
    expect(result.current.documents).toEqual([]);
    expect(result.current.activeSourcePath).toBe(SOURCE_B);
    expect(result.current.activeDocument).toBeNull();
    expect(result.current.previewLocation).toBeNull();

    act(() => result.current.commitDocuments([documents[0]]));
    const beforeUnknownSelection = result.current.captureView();
    const beforeDocuments = result.current.documents;
    act(() => result.current.selectSource(SOURCE_B));
    expect(result.current.documents).toBe(beforeDocuments);
    expect(result.current.captureView()).toEqual(beforeUnknownSelection);

    act(() => {
      result.current.commitDocuments([documents[1]]);
      result.current.selectSource('D:\\input\\missing.pdf');
    });
    expect(result.current.documents).toEqual([documents[1]]);
    expect(result.current.activeSourcePath).toBe(SOURCE_B);
    expect(result.current.activeDocument).toEqual(documents[1]);
    expect(result.current.previewLocation).toEqual({
      documentKey: documents[1].key,
      page: 1,
    });
    expect(result.current.pageDraft).toBe('1');
  });

  it('previous and next stay inside the active document', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.previousPage());
    expect(result.current.previewLocation?.page).toBe(1);
    act(() => result.current.nextPage());
    expect(result.current.previewLocation?.page).toBe(2);
    act(() => result.current.nextPage());
    expect(result.current.previewLocation?.page).toBe(3);
    act(() => result.current.nextPage());
    expect(result.current.previewLocation?.page).toBe(3);
  });

  it('accepts only exact in-range pages and ignores invalid navigation requests', () => {
    const onRevealSegment = vi.fn();
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [segment({ id: 'page-two' })],
      onRevealSegment,
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.goToPage(2));
    onRevealSegment.mockClear();
    const beforeInvalidNavigation = result.current.captureView();

    for (const invalidPage of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 0, 4]) {
      act(() => result.current.goToPage(invalidPage));
    }

    expect(result.current.captureView()).toEqual(beforeInvalidNavigation);
    expect(result.current.pageDraft).toBe('2');
    expect(result.current.pageInputError).toBe('');
    expect(onRevealSegment).not.toHaveBeenCalled();
  });

  it('ignores unknown or invalid segments without clamping their page', () => {
    const onRevealSegment = vi.fn();
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment,
    }));

    act(() => result.current.commitDocuments(documents));
    const beforeInvalidSegment = result.current.captureView();
    act(() => result.current.showSegment(segment({ id: 'too-late', sourcePage: 99 })));
    act(() => result.current.showSegment(segment({
      id: 'not-a-source-page',
      sourcePath: 'D:\\input\\missing.pdf',
      sourcePage: 1,
    })));
    act(() => result.current.showSegment(segment({
      id: 'fractional-page',
      sourcePage: 1.5,
    })));

    expect(result.current.captureView()).toEqual(beforeInvalidSegment);
    expect(result.current.pageDraft).toBe('1');
    expect(onRevealSegment).not.toHaveBeenCalled();
  });

  it('falls back to the first document for an invalid initial segment', () => {
    const onRevealSegment = vi.fn();
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment,
    }));

    act(() => result.current.commitDocuments(documents, segment({
      id: 'unknown-source',
      sourcePath: 'D:\\input\\missing.pdf',
      sourcePage: 1,
    })));
    expect(result.current.activeSourcePath).toBe(SOURCE_A);
    expect(result.current.previewLocation).toEqual({
      documentKey: documents[0].key,
      page: 1,
    });
    expect(result.current.pageDraft).toBe('1');
    expect(onRevealSegment).not.toHaveBeenCalled();

    act(() => result.current.commitDocuments(documents, segment({
      id: 'out-of-range',
      sourcePath: SOURCE_A,
      sourcePage: 99,
    })));
    expect(result.current.activeSourcePath).toBe(SOURCE_A);
    expect(result.current.previewLocation?.page).toBe(1);
    expect(onRevealSegment).not.toHaveBeenCalled();
  });

  it('applies multiple page commands in one act from the latest state', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => {
      result.current.nextPage();
      result.current.nextPage();
    });

    expect(result.current.previewLocation).toEqual({
      documentKey: documents[0].key,
      page: 3,
    });
    expect(result.current.pageDraft).toBe('3');
  });

  it('keeps a same-act document commit and page navigation on the new document', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => {
      result.current.commitDocuments([documents[1]]);
      result.current.nextPage();
    });

    expect(result.current.documents).toEqual([documents[1]]);
    expect(result.current.activeSourcePath).toBe(SOURCE_B);
    expect(result.current.previewLocation).toEqual({
      documentKey: documents[1].key,
      page: 2,
    });
    expect(result.current.pageDraft).toBe('2');
    expect(result.current.pageInputError).toBe('');
  });

  it('does not create a cross-document location when replacing or clearing in one act', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => {
      result.current.replaceSources([{ name: 'b.pdf', sourcePath: SOURCE_B }]);
      result.current.nextPage();
    });
    expect(result.current.documents).toEqual([]);
    expect(result.current.activeSourcePath).toBe(SOURCE_B);
    expect(result.current.previewLocation).toBeNull();
    expect(result.current.pageDraft).toBe('');
    expect(result.current.pageInputError).toBe('');

    act(() => {
      result.current.commitDocuments(documents);
      result.current.clearSources();
    });
    expect(result.current.documents).toEqual([]);
    expect(result.current.activeSourcePath).toBeNull();
    expect(result.current.previewLocation).toBeNull();
    expect(result.current.pageDraft).toBe('');
    expect(result.current.pageInputError).toBe('');
  });

  it('Enter and blur commit a valid page draft', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.setPageDraft(' 2 '));
    act(() => result.current.submitPageDraft());
    expect(result.current.previewLocation?.page).toBe(2);
    expect(result.current.pageDraft).toBe('2');
    expect(result.current.pageInputError).toBe('');

    act(() => result.current.setPageDraft('3'));
    act(() => result.current.submitPageDraft());
    expect(result.current.previewLocation?.page).toBe(3);
    expect(result.current.pageDraft).toBe('3');
  });

  it('Escape restores the current page', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.goToPage(2));
    act(() => result.current.setPageDraft('99'));
    act(() => result.current.cancelPageDraft());

    expect(result.current.previewLocation?.page).toBe(2);
    expect(result.current.pageDraft).toBe('2');
    expect(result.current.pageInputError).toBe('');
  });

  it('invalid drafts restore the current page and expose an alert', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.goToPage(2));
    act(() => result.current.setPageDraft('4'));
    act(() => result.current.submitPageDraft());

    expect(result.current.previewLocation?.page).toBe(2);
    expect(result.current.pageDraft).toBe('2');
    expect(result.current.pageInputError).toBe('请输入 1–3 的页码');
  });

  it('rejects a non-integer page draft without changing the preview location', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.goToPage(2));
    act(() => result.current.setPageDraft('2.5'));
    act(() => result.current.submitPageDraft());

    expect(result.current.previewLocation?.page).toBe(2);
    expect(result.current.pageDraft).toBe('2');
    expect(result.current.pageInputError).toBe('请输入 1–3 的页码');
  });

  it('markSourceIntegrityChanged changes only the requested doc and is idempotent', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    let firstMark = false;
    act(() => {
      firstMark = result.current.markSourceIntegrityChanged(SOURCE_B);
    });
    expect(firstMark).toBe(true);

    expect(result.current.documents[0]).toEqual(documents[0]);
    expect(result.current.documents[1]).toEqual({
      ...documents[1],
      integrityStatus: 'changed',
    });
    expect(result.current.isSourceIntegrityValid(SOURCE_A)).toBe(true);
    expect(result.current.isSourceIntegrityValid(SOURCE_B)).toBe(false);

    const changedDocuments = result.current.documents;
    let duplicateMark = true;
    act(() => {
      duplicateMark = result.current.markSourceIntegrityChanged('d:/INPUT/B.PDF');
    });
    expect(duplicateMark).toBe(false);
    expect(result.current.documents).toBe(changedDocuments);
  });

  it('ignores an integrity event carrying a stale document key after same-path replacement', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));
    const replacement = {
      ...documents[0],
      key: sourceDocumentKey(SOURCE_A, SHA_B),
      sourceSha256: SHA_B,
    };

    act(() => result.current.commitDocuments([replacement]));
    act(() => result.current.markSourceIntegrityChanged(SOURCE_A, documents[0].key));

    expect(result.current.documents[0]?.integrityStatus).toBe('valid');

    act(() => result.current.markSourceIntegrityChanged(SOURCE_A, replacement.key));
    expect(result.current.documents[0]?.integrityStatus).toBe('changed');
  });

  it('increments the source integrity revision only when a document changes', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    const initialRevision = result.current.sourceIntegrityRevision;
    act(() => result.current.markSourceIntegrityChanged(SOURCE_B));
    expect(result.current.sourceIntegrityRevision).toBe(initialRevision + 1);

    act(() => result.current.markSourceIntegrityChanged(SOURCE_B));
    expect(result.current.sourceIntegrityRevision).toBe(initialRevision + 1);
  });

  it('restoreView restores source page and page draft', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.goToPage(2));
    const snapshot = result.current.captureView();
    act(() => result.current.selectSource(SOURCE_B));
    act(() => result.current.setPageDraft('6'));
    act(() => result.current.restoreView(snapshot));

    expect(result.current.activeSourcePath).toBe(SOURCE_A);
    expect(result.current.previewLocation).toEqual({
      documentKey: documents[0].key,
      page: 2,
    });
    expect(result.current.pageDraft).toBe('2');
    expect(result.current.pageInputError).toBe('');
  });

  it('restoreView reveals the first unresolved segment on the restored page', () => {
    const onRevealSegment = vi.fn();
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [
        segment({ id: 'confirmed' }),
        segment({ id: 'pending', reviewStatus: 'needs_review' }),
      ],
      onRevealSegment,
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.goToPage(2));
    const snapshot = result.current.captureView();
    act(() => result.current.selectSource(SOURCE_B));
    act(() => result.current.setPageDraft('6'));
    onRevealSegment.mockClear();

    act(() => result.current.restoreView(snapshot));

    expect(result.current.activeSourcePath).toBe(SOURCE_A);
    expect(result.current.previewLocation).toEqual({
      documentKey: documents[0].key,
      page: 2,
    });
    expect(result.current.pageDraft).toBe('2');
    expect(onRevealSegment).toHaveBeenCalledWith('pending');
  });

  it('ignores malformed restore snapshots and keeps the current view and selection', () => {
    const onRevealSegment = vi.fn();
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [segment({ id: 'pending', reviewStatus: 'needs_review' })],
      onRevealSegment,
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.goToPage(2));
    const beforeInvalidSnapshot = result.current.captureView();
    onRevealSegment.mockClear();

    const malformedSnapshots = [
      null,
      [] as unknown,
      { activeSourcePath: 42, previewLocation: null },
      { activeSourcePath: SOURCE_A },
      { activeSourcePath: SOURCE_A, previewLocation: 42 },
      { activeSourcePath: SOURCE_A, previewLocation: { documentKey: 42, page: 2 } },
      { activeSourcePath: SOURCE_A, previewLocation: { documentKey: documents[0].key, page: '2' } },
      { activeSourcePath: SOURCE_A, previewLocation: { documentKey: documents[0].key, page: 99 } },
      { activeSourcePath: SOURCE_A, previewLocation: { documentKey: documents[1].key, page: 2 } },
    ];

    for (const snapshot of malformedSnapshots) {
      act(() => result.current.restoreView(snapshot as never));
      expect(result.current.captureView()).toEqual(beforeInvalidSnapshot);
      expect(result.current.pageDraft).toBe('2');
      expect(result.current.pageInputError).toBe('');
    }
    expect(onRevealSegment).not.toHaveBeenCalled();
  });

  it('keeps committed documents when restoring a typed no-page snapshot', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.commitDocuments(documents));
    act(() => result.current.goToPage(2));
    const beforeView = result.current.captureView();
    const beforeDocuments = result.current.documents;

    act(() => result.current.restoreView({
      activeSourcePath: null,
      previewLocation: null,
    }));
    expect(result.current.documents).toBe(beforeDocuments);
    expect(result.current.captureView()).toEqual(beforeView);
    expect(result.current.pageDraft).toBe('2');

    act(() => result.current.restoreView({
      activeSourcePath: SOURCE_A,
      previewLocation: null,
    }));
    expect(result.current.documents).toBe(beforeDocuments);
    expect(result.current.captureView()).toEqual(beforeView);
    expect(result.current.pageDraft).toBe('2');
  });

  it('restores a no-page source snapshot only before metadata exists', () => {
    const { result } = renderHook(() => useSourcePreviewNavigation({
      segments: [],
      onRevealSegment: vi.fn(),
    }));

    act(() => result.current.restoreView({
      activeSourcePath: null,
      previewLocation: null,
    }));
    expect(result.current.documents).toEqual([]);
    expect(result.current.activeSourcePath).toBeNull();
    expect(result.current.previewLocation).toBeNull();
    expect(result.current.pageDraft).toBe('');

    act(() => result.current.restoreView({
      activeSourcePath: SOURCE_A,
      previewLocation: null,
    }));
    expect(result.current.documents).toEqual([]);
    expect(result.current.activeSourcePath).toBe(SOURCE_A);
    expect(result.current.activeDocument).toBeNull();
    expect(result.current.previewLocation).toBeNull();
    expect(result.current.pageDraft).toBe('');
  });
});
