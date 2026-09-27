import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import './ReceiptPaneSplit.css';

const DEFAULT_CONTROLS_HEIGHT = 240;
const DEFAULT_CONTROLS_RATIO = 0.35;
const MAX_CONTROLS_RATIO = 0.75;
const SEPARATOR_HEIGHT = 10;
const MIN_PREVIEW_HEIGHT = 180;
const MIN_CONTROLS_HEIGHT = 150;
const KEYBOARD_STEP = 16;

type SplitMetrics = {
  separatorHeight: number;
  minPreviewHeight: number;
  minControlsHeight: number;
  maxControlsHeight: number;
  defaultControlsHeight: number;
};

type ActiveDrag = {
  pointerId: number;
  startY: number;
  startHeight: number;
  startManualHeight: number | null;
  target: HTMLDivElement;
  bodyCursor: string;
  bodyUserSelect: string;
  onWindowBlur: () => void;
};

export type ReceiptPaneSplitProps = {
  preview: ReactNode;
  controls: ReactNode;
  resizable: boolean;
};

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function metricsForHeight(rawHeight: number): SplitMetrics {
  const height = finiteNonNegative(rawHeight);
  const separatorHeight = Math.min(SEPARATOR_HEIGHT, height);
  const paneSpace = Math.max(0, height - separatorHeight);
  // The published minima are kept when the container can fit both panes. For
  // shorter containers they scale down together instead of overflowing.
  const minPreviewHeight = Math.min(MIN_PREVIEW_HEIGHT, paneSpace / 2);
  const minControlsHeight = Math.min(MIN_CONTROLS_HEIGHT, paneSpace / 2);
  const maxControlsHeight = Math.max(
    minControlsHeight,
    Math.min(height * MAX_CONTROLS_RATIO, paneSpace - minPreviewHeight),
  );
  const defaultControlsHeight = clamp(
    Math.min(DEFAULT_CONTROLS_HEIGHT, height * DEFAULT_CONTROLS_RATIO),
    minControlsHeight,
    maxControlsHeight,
  );

  return {
    separatorHeight,
    minPreviewHeight,
    minControlsHeight,
    maxControlsHeight,
    defaultControlsHeight,
  };
}

function isFiniteHeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function pointerMatches(pointerId: number, eventPointerId: number): boolean {
  return pointerId === 0 || eventPointerId === 0 || pointerId === eventPointerId;
}

export function ReceiptPaneSplit({ preview, controls, resizable }: ReceiptPaneSplitProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ActiveDrag | null>(null);
  const [containerHeight, setContainerHeight] = useState<number | null>(null);
  const [manualControlsHeight, setManualControlsHeight] = useState<number | null>(null);
  const manualControlsHeightRef = useRef(manualControlsHeight);
  manualControlsHeightRef.current = manualControlsHeight;

  const metrics = useMemo(
    () => (containerHeight === null ? null : metricsForHeight(containerHeight)),
    [containerHeight],
  );
  const controlsHeight = metrics
    ? (manualControlsHeight === null
      ? metrics.defaultControlsHeight
      : clamp(manualControlsHeight, metrics.minControlsHeight, metrics.maxControlsHeight))
    : (manualControlsHeight ?? DEFAULT_CONTROLS_HEIGHT);
  const previewHeight = metrics
    ? Math.max(0, (containerHeight ?? 0) - metrics.separatorHeight - controlsHeight)
    : 0;
  const splitStyle = {
    '--receipt-pane-controls-height': `${finiteNonNegative(controlsHeight)}px`,
    '--receipt-pane-separator-height': `${finiteNonNegative(metrics?.separatorHeight ?? SEPARATOR_HEIGHT)}px`,
  } as CSSProperties;

  const latestValuesRef = useRef({ metrics, controlsHeight });
  latestValuesRef.current = { metrics, controlsHeight };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const measure = () => {
      const nextHeight = root.getBoundingClientRect().height;
      if (!isFiniteHeight(nextHeight)) return;
      setContainerHeight((previous) => (previous === nextHeight ? previous : nextHeight));
    };

    measure();
    window.addEventListener('resize', measure);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(root);
    }

    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  function restoreBodyStyles(active: ActiveDrag): void {
    document.body.style.cursor = active.bodyCursor;
    document.body.style.userSelect = active.bodyUserSelect;
  }

  function finishDrag(cancel: boolean): void {
    const active = dragRef.current;
    if (!active) return;
    dragRef.current = null;
    window.removeEventListener('blur', active.onWindowBlur);

    if (cancel) {
      manualControlsHeightRef.current = active.startManualHeight;
      setManualControlsHeight(active.startManualHeight);
    }
    restoreBodyStyles(active);
    try {
      if (active.target.hasPointerCapture?.(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId);
      }
    } catch {
      // Pointer capture can already be released by the browser on cancellation.
    }
  }

  useLayoutEffect(() => () => {
    const active = dragRef.current;
    if (!active) return;
    dragRef.current = null;
    window.removeEventListener('blur', active.onWindowBlur);
    restoreBodyStyles(active);
    try {
      if (active.target.hasPointerCapture?.(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId);
      }
    } catch {
      // The target may already be detached as part of unmounting.
    }
  }, []);

  useLayoutEffect(() => {
    if (!resizable) finishDrag(true);
  }, [resizable]);

  function setManualHeight(value: number): void {
    const currentMetrics = latestValuesRef.current.metrics;
    if (!currentMetrics) return;
    const nextHeight = clamp(value, currentMetrics.minControlsHeight, currentMetrics.maxControlsHeight);
    manualControlsHeightRef.current = nextHeight;
    setManualControlsHeight(nextHeight);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!resizable || event.button !== 0 || dragRef.current || !metrics) return;
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : 0;
    const currentHeight = latestValuesRef.current.controlsHeight;
    const onWindowBlur = () => finishDrag(true);
    dragRef.current = {
      pointerId,
      startY: event.clientY,
      startHeight: currentHeight,
      startManualHeight: manualControlsHeightRef.current,
      target,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
      onWindowBlur,
    };
    window.addEventListener('blur', onWindowBlur);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Some test/browser environments do not implement pointer capture.
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const active = dragRef.current;
    if (!active || !pointerMatches(active.pointerId, event.pointerId)) return;
    const deltaY = event.clientY - active.startY;
    setManualHeight(active.startHeight - deltaY);
    event.preventDefault();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!resizable) return;
    if (event.key === 'Home') {
      event.preventDefault();
      manualControlsHeightRef.current = null;
      setManualControlsHeight(null);
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? -1 : 1;
    setManualHeight(latestValuesRef.current.controlsHeight + direction * KEYBOARD_STEP);
  }

  const hidden = containerHeight !== null && containerHeight <= 0;
  const effectiveControlsHeight = finiteNonNegative(controlsHeight);

  return (
    <div
      ref={rootRef}
      className="receipt-pane-split"
      data-resizable={resizable ? 'true' : 'false'}
      data-hidden={hidden ? 'true' : 'false'}
      data-controls-height={effectiveControlsHeight}
      data-preview-height={finiteNonNegative(previewHeight)}
      style={splitStyle}
    >
      <div className="receipt-pane-split__preview">
        {preview}
      </div>
      {resizable && (
        <div
          className="receipt-pane-split__separator"
          role="separator"
          aria-label="调整操作区高度"
          aria-orientation="horizontal"
          aria-valuenow={Math.round(effectiveControlsHeight)}
          aria-valuemin={Math.round(metrics?.minControlsHeight ?? 0)}
          aria-valuemax={Math.round(metrics?.maxControlsHeight ?? DEFAULT_CONTROLS_HEIGHT)}
          aria-keyshortcuts="Home ArrowUp ArrowDown"
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => {
            if (pointerMatches(dragRef.current?.pointerId ?? -1, event.pointerId)) finishDrag(false);
          }}
          onPointerCancel={(event) => {
            if (pointerMatches(dragRef.current?.pointerId ?? -1, event.pointerId)) finishDrag(true);
          }}
          onLostPointerCapture={(event) => {
            if (pointerMatches(dragRef.current?.pointerId ?? -1, event.pointerId)) finishDrag(true);
          }}
          onKeyDown={handleKeyDown}
          onDoubleClick={() => {
            manualControlsHeightRef.current = null;
            setManualControlsHeight(null);
          }}
        />
      )}
      <div className="receipt-pane-split__controls">
        {controls}
      </div>
    </div>
  );
}

export default ReceiptPaneSplit;
