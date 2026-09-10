import { useCallback, useMemo, useRef, useState } from 'react';

import {
  choosePreferredSegment,
  normalizeSourcePath,
  parsePageDraft,
  type NavigableSegment,
  type SourceDocument,
  type SourcePreviewLocation,
} from '../domain/sourcePreview';

export type SourceSelection = {
  name: string;
  sourcePath: string;
};

export type PreviewViewSnapshot = {
  activeSourcePath: string | null;
  previewLocation: SourcePreviewLocation | null;
};

export type UseSourcePreviewNavigationOptions = {
  segments: readonly NavigableSegment[];
  onRevealSegment: (id: string) => void;
};

export type SourcePreviewNavigation = {
  documents: SourceDocument[];
  sourceIntegrityRevision: number;
  activeSourcePath: string | null;
  activeDocument: SourceDocument | null;
  previewLocation: SourcePreviewLocation | null;
  pageDraft: string;
  pageInputError: string;
  replaceSources: (sources: readonly SourceSelection[]) => void;
  commitDocuments: (
    documents: readonly SourceDocument[],
    initialSegment?: NavigableSegment | null,
  ) => void;
  clearSources: () => void;
  selectSource: (sourcePath: string) => void;
  showSegment: (segment: NavigableSegment) => void;
  goToPage: (page: number) => void;
  previousPage: () => void;
  nextPage: () => void;
  setPageDraft: (value: string) => void;
  submitPageDraft: () => void;
  cancelPageDraft: () => void;
  markSourceIntegrityChanged: (sourcePath: string, expectedDocumentKey?: string) => boolean;
  isSourceIntegrityValid: (sourcePath: string) => boolean;
  captureView: () => PreviewViewSnapshot;
  restoreView: (snapshot: PreviewViewSnapshot) => void;
};

type NavigationState = {
  documents: SourceDocument[];
  sourceIntegrityRevision: number;
  activeSourcePath: string | null;
  previewLocation: SourcePreviewLocation | null;
  pageDraft: string;
  pageInputError: string;
};

type RevealPageOptions = {
  documents?: SourceDocument[];
  segmentId?: string;
};

function createInitialNavigationState(): NavigationState {
  return {
    documents: [],
    sourceIntegrityRevision: 0,
    activeSourcePath: null,
    previewLocation: null,
    pageDraft: '',
    pageInputError: '',
  };
}

function documentForSource(
  documents: readonly SourceDocument[],
  sourcePath: unknown,
): SourceDocument | null {
  if (typeof sourcePath !== 'string') return null;
  const normalizedPath = normalizeSourcePath(sourcePath);
  return documents.find((document) => normalizeSourcePath(document.sourcePath) === normalizedPath) ?? null;
}

function documentForLocation(
  documents: readonly SourceDocument[],
  location: SourcePreviewLocation | null | undefined,
): SourceDocument | null {
  if (!location || typeof location.documentKey !== 'string') return null;
  return documents.find((document) => document.key === location.documentKey) ?? null;
}

function isValidPage(document: SourceDocument, page: unknown): page is number {
  return typeof page === 'number'
    && Number.isSafeInteger(page)
    && Number.isSafeInteger(document.pageCount)
    && document.pageCount >= 1
    && page >= 1
    && page <= document.pageCount;
}

function currentPageForDocument(
  state: NavigationState,
  document: SourceDocument,
): number {
  const locationDocument = documentForLocation(state.documents, state.previewLocation);
  return locationDocument?.key === document.key && isValidPage(document, state.previewLocation?.page)
    ? state.previewLocation!.page
    : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isSnapshotLocation(value: unknown): value is SourcePreviewLocation | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return hasOwn(value, 'documentKey')
    && typeof value.documentKey === 'string'
    && hasOwn(value, 'page')
    && typeof value.page === 'number'
    && Number.isSafeInteger(value.page);
}

export function useSourcePreviewNavigation({
  segments,
  onRevealSegment,
}: UseSourcePreviewNavigationOptions): SourcePreviewNavigation {
  const [navigationState, setNavigationState] = useState<NavigationState>(createInitialNavigationState);
  const latestStateRef = useRef<NavigationState>(navigationState);

  const transition = useCallback((update: (current: NavigationState) => NavigationState): NavigationState => {
    const current = latestStateRef.current;
    const next = update(current);
    latestStateRef.current = next;
    if (next !== current) setNavigationState(next);
    return next;
  }, []);

  const activeDocument = useMemo(
    () => documentForSource(navigationState.documents, navigationState.activeSourcePath),
    [navigationState.activeSourcePath, navigationState.documents],
  );

  const revealPage = useCallback((
    document: SourceDocument,
    page: number,
    options: RevealPageOptions = {},
  ): boolean => {
    if (!isValidPage(document, page)) return false;

    const current = latestStateRef.current;
    const nextDocuments = options.documents ?? current.documents;
    transition(() => ({
      ...current,
      documents: nextDocuments,
      activeSourcePath: document.sourcePath,
      previewLocation: { documentKey: document.key, page },
      pageDraft: String(page),
      pageInputError: '',
    }));

    const segmentId = options.segmentId
      ?? choosePreferredSegment(segments, document.sourcePath, page);
    if (segmentId !== null && segmentId !== undefined) onRevealSegment(segmentId);
    return true;
  }, [onRevealSegment, segments, transition]);

  const replaceSources = useCallback((sources: readonly SourceSelection[]) => {
    transition((state) => ({
      ...state,
      documents: [],
      activeSourcePath: sources[0]?.sourcePath ?? null,
      previewLocation: null,
      pageDraft: '',
      pageInputError: '',
    }));
  }, [transition]);

  const commitDocuments = useCallback((
    nextDocuments: readonly SourceDocument[],
    initialSegment?: NavigableSegment | null,
  ) => {
    const nextDocumentsArray = [...nextDocuments];
    let targetDocument = nextDocumentsArray[0] ?? null;
    let targetPage = 1;
    let segmentId: string | undefined;

    if (
      initialSegment
      && typeof initialSegment === 'object'
      && typeof initialSegment.id === 'string'
      && typeof initialSegment.sourcePath === 'string'
    ) {
      const candidate = documentForSource(nextDocumentsArray, initialSegment.sourcePath);
      if (candidate && isValidPage(candidate, initialSegment.sourcePage)) {
        targetDocument = candidate;
        targetPage = initialSegment.sourcePage;
        segmentId = initialSegment.id;
      }
    }

    if (!targetDocument) {
      transition(() => createInitialNavigationState());
      return;
    }

    revealPage(targetDocument, targetPage, {
      documents: nextDocumentsArray,
      segmentId,
    });
  }, [revealPage, transition]);

  const clearSources = useCallback(() => {
    transition(() => createInitialNavigationState());
  }, [transition]);

  const selectSource = useCallback((sourcePath: string) => {
    if (typeof sourcePath !== 'string') return;
    const current = latestStateRef.current;
    const document = documentForSource(current.documents, sourcePath);
    if (!document) {
      if (current.documents.length > 0) return;
      transition((state) => ({
        ...state,
        activeSourcePath: sourcePath,
        previewLocation: null,
        pageDraft: '',
        pageInputError: '',
      }));
      return;
    }
    revealPage(document, 1);
  }, [revealPage, transition]);

  const showSegment = useCallback((segment: NavigableSegment) => {
    if (
      !segment
      || typeof segment !== 'object'
      || typeof segment.id !== 'string'
      || typeof segment.sourcePath !== 'string'
    ) return;

    const current = latestStateRef.current;
    const document = documentForSource(current.documents, segment.sourcePath);
    if (!document || !isValidPage(document, segment.sourcePage)) return;
    revealPage(document, segment.sourcePage, { segmentId: segment.id });
  }, [revealPage]);

  const goToPage = useCallback((page: number) => {
    const current = latestStateRef.current;
    const document = documentForSource(current.documents, current.activeSourcePath);
    if (!document || !isValidPage(document, page)) return;
    revealPage(document, page);
  }, [revealPage]);

  const previousPage = useCallback(() => {
    const current = latestStateRef.current;
    const document = documentForSource(current.documents, current.activeSourcePath);
    if (!document) return;
    const page = Math.max(1, currentPageForDocument(current, document) - 1);
    revealPage(document, page);
  }, [revealPage]);

  const nextPage = useCallback(() => {
    const current = latestStateRef.current;
    const document = documentForSource(current.documents, current.activeSourcePath);
    if (!document) return;
    const page = Math.min(document.pageCount, currentPageForDocument(current, document) + 1);
    revealPage(document, page);
  }, [revealPage]);

  const setPageDraftValue = useCallback((value: string) => {
    if (typeof value !== 'string') return;
    transition((state) => ({ ...state, pageDraft: value }));
  }, [transition]);

  const submitPageDraft = useCallback(() => {
    const current = latestStateRef.current;
    const document = documentForSource(current.documents, current.activeSourcePath);
    if (!document) return;

    const result = parsePageDraft(current.pageDraft, document.pageCount);
    if (!result.ok) {
      const currentPage = documentForLocation(current.documents, current.previewLocation)?.key === document.key
        && isValidPage(document, current.previewLocation?.page)
        ? current.previewLocation!.page
        : null;
      transition((state) => ({
        ...state,
        pageDraft: currentPage === null ? '' : String(currentPage),
        pageInputError: result.message,
      }));
      return;
    }

    revealPage(document, result.page);
  }, [revealPage, transition]);

  const cancelPageDraft = useCallback(() => {
    const current = latestStateRef.current;
    const document = documentForSource(current.documents, current.activeSourcePath);
    const currentPage = document
      ? currentPageForDocument(current, document)
      : null;
    transition((state) => ({
      ...state,
      pageDraft: currentPage === null ? '' : String(currentPage),
      pageInputError: '',
    }));
  }, [transition]);

  const markSourceIntegrityChanged = useCallback((sourcePath: string, expectedDocumentKey?: string): boolean => {
    if (typeof sourcePath !== 'string') return false;
    const normalizedPath = normalizeSourcePath(sourcePath);
    let changed = false;
    transition((state) => {
      const nextDocuments = state.documents.map((document) => {
        if (
          normalizeSourcePath(document.sourcePath) === normalizedPath
          && (!expectedDocumentKey || document.key === expectedDocumentKey)
          && document.integrityStatus !== 'changed'
        ) {
          changed = true;
          return { ...document, integrityStatus: 'changed' as const };
        }
        return document;
      });
      return changed
        ? {
          ...state,
          documents: nextDocuments,
          sourceIntegrityRevision: state.sourceIntegrityRevision + 1,
        }
        : state;
    });
    return changed;
  }, [transition]);

  const isSourceIntegrityValid = useCallback((sourcePath: string) => (
    documentForSource(latestStateRef.current.documents, sourcePath)?.integrityStatus === 'valid'
  ), []);

  const captureView = useCallback((): PreviewViewSnapshot => {
    const current = latestStateRef.current;
    return {
      activeSourcePath: current.activeSourcePath,
      previewLocation: current.previewLocation ? { ...current.previewLocation } : null,
    };
  }, []);

  const restoreView = useCallback((snapshot: PreviewViewSnapshot) => {
    if (!isRecord(snapshot)) return;
    if (!hasOwn(snapshot, 'activeSourcePath') || !hasOwn(snapshot, 'previewLocation')) return;

    const snapshotSourcePath = snapshot.activeSourcePath;
    const snapshotLocation = snapshot.previewLocation;
    if (!(snapshotSourcePath === null || typeof snapshotSourcePath === 'string')) return;
    if (!isSnapshotLocation(snapshotLocation)) return;

    const current = latestStateRef.current;
    if (snapshotSourcePath === null && snapshotLocation === null) {
      if (current.documents.length > 0) return;
      transition(() => createInitialNavigationState());
      return;
    }

    if (snapshotLocation === null) {
      if (current.documents.length > 0) return;
      transition((state) => ({
        ...state,
        activeSourcePath: snapshotSourcePath,
        previewLocation: null,
        pageDraft: '',
        pageInputError: '',
      }));
      return;
    }

    if (snapshotSourcePath === null) return;
    const locationDocument = documentForLocation(current.documents, snapshotLocation);
    const sourceDocument = documentForSource(current.documents, snapshotSourcePath);
    if (
      !locationDocument
      || !sourceDocument
      || sourceDocument.key !== locationDocument.key
      || !isValidPage(locationDocument, snapshotLocation.page)
    ) return;

    revealPage(locationDocument, snapshotLocation.page);
  }, [revealPage, transition]);

  return {
    documents: navigationState.documents,
    sourceIntegrityRevision: navigationState.sourceIntegrityRevision,
    activeSourcePath: navigationState.activeSourcePath,
    activeDocument,
    previewLocation: navigationState.previewLocation,
    pageDraft: navigationState.pageDraft,
    pageInputError: navigationState.pageInputError,
    replaceSources,
    commitDocuments,
    clearSources,
    selectSource,
    showSegment,
    goToPage,
    previousPage,
    nextPage,
    setPageDraft: setPageDraftValue,
    submitPageDraft,
    cancelPageDraft,
    markSourceIntegrityChanged,
    isSourceIntegrityValid,
    captureView,
    restoreView,
  };
}
