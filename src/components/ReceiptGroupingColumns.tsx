import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import './ReceiptGroupingColumns.css';

const DIVIDER_WIDTH = 8;
const LEFT_MIN = 160;
const CENTER_MIN = 240;
const RIGHT_MIN = 300;
const DEFAULT_LEFT = 220;
const DEFAULT_CENTER = 240;
// Used until the browser has measured the root. Once measured, the right
// column fills the remaining space after the default left and center widths.
const DEFAULT_RIGHT = 420;
const KEYBOARD_STEP = 16;
const KEYBOARD_LARGE_STEP = 48;

type Side = 'left' | 'right';

type PreferredColumns = {
  left: number;
  // null means the right column is still using the responsive default.
  right: number | null;
};

type LayoutMetrics = {
  available: number;
  leftMin: number;
  leftMax: number;
  centerMin: number;
  rightMin: number;
  rightMax: number;
};

type EffectiveColumns = {
  left: number;
  right: number;
  center: number | null;
  metrics: LayoutMetrics;
};

type BodyStyles = {
  cursor: string;
  userSelect: string;
};

type PointerLike = {
  pointerId: number;
  clientX: number;
  preventDefault: () => void;
};

type ActiveDrag = {
  side: Side;
  pointerId: number;
  startClientX: number;
  startPreferred: PreferredColumns;
  startEffective: EffectiveColumns;
  target: HTMLDivElement;
  bodyStyles: BodyStyles;
  moved: boolean;
  fixedOtherWidth: number | null;
  removeWindowListeners: () => void;
};

export type ReceiptGroupingColumnsProps = {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
};

export const RECEIPT_GROUPING_COLUMNS_DEFAULTS = {
  left: DEFAULT_LEFT,
  right: DEFAULT_RIGHT,
} as const;

export const RECEIPT_GROUPING_COLUMNS_MINIMUMS = {
  left: LEFT_MIN,
  center: CENTER_MIN,
  right: RIGHT_MIN,
} as const;

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  const low = Math.min(minimum, maximum);
  const high = Math.max(minimum, maximum);
  return Math.max(low, Math.min(value, high));
}

function normalizePreferred(columns: PreferredColumns): PreferredColumns {
  return {
    left: finiteNonNegative(columns.left, DEFAULT_LEFT),
    right: columns.right === null ? null : finiteNonNegative(columns.right, DEFAULT_RIGHT),
  };
}

function responsiveDefaultRight(metrics: LayoutMetrics, left: number): number {
  if (!Number.isFinite(metrics.available)) return DEFAULT_RIGHT;
  return Math.max(0, metrics.available - left - DEFAULT_CENTER);
}

function metricsForWidth(containerWidth: number | null): LayoutMetrics {
  const available = containerWidth === null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, finiteNonNegative(containerWidth) - DIVIDER_WIDTH * 2);

  let leftMin = LEFT_MIN;
  let centerMin = CENTER_MIN;
  let rightMin = RIGHT_MIN;

  // Keep the documented minima at ordinary desktop sizes. When the root is
  // too narrow, relax the center first; below the two side minima, scale those
  // side minima proportionally so every grid track still fits the root.
  if (available < LEFT_MIN + CENTER_MIN + RIGHT_MIN) {
    centerMin = Math.max(0, Math.min(CENTER_MIN, available - LEFT_MIN - RIGHT_MIN));
    if (available < LEFT_MIN + RIGHT_MIN) {
      const sideMinimumTotal = LEFT_MIN + RIGHT_MIN;
      const leftRatio = LEFT_MIN / sideMinimumTotal;
      leftMin = Math.floor(available * leftRatio);
      rightMin = Math.max(0, available - leftMin);
      centerMin = 0;
    }
  }

  const leftMax = Number.isFinite(available)
    ? Math.max(leftMin, available - centerMin - rightMin)
    : Number.POSITIVE_INFINITY;
  const rightMax = Number.isFinite(available)
    ? Math.max(rightMin, available - centerMin - leftMin)
    : Number.POSITIVE_INFINITY;

  return {
    available,
    leftMin,
    leftMax,
    centerMin,
    rightMin,
    rightMax,
  };
}

function effectiveColumnsFor(
  preferred: PreferredColumns,
  containerWidth: number | null,
): EffectiveColumns {
  const metrics = metricsForWidth(containerWidth);
  let left = clamp(preferred.left, metrics.leftMin, metrics.leftMax);
  const preferredRight = preferred.right === null
    ? responsiveDefaultRight(metrics, left)
    : preferred.right;
  let right = clamp(preferredRight, metrics.rightMin, metrics.rightMax);

  if (Number.isFinite(metrics.available)) {
    // The right side is clamped after the left side so a narrow workspace
    // keeps a valid center track without mutating the user's preference.
    const rightMaxForLeft = Math.max(
      metrics.rightMin,
      metrics.available - metrics.centerMin - left,
    );
    right = clamp(right, metrics.rightMin, Math.min(metrics.rightMax, rightMaxForLeft));

    if (left + right + metrics.centerMin > metrics.available) {
      const leftMaxForRight = Math.max(
        metrics.leftMin,
        metrics.available - metrics.centerMin - right,
      );
      left = clamp(left, metrics.leftMin, Math.min(metrics.leftMax, leftMaxForRight));
    }
  }

  const center = Number.isFinite(metrics.available)
    ? Math.max(0, metrics.available - left - right)
    : null;

  return { left, center, right, metrics };
}

function pointerMatches(pointerId: number, eventPointerId: number): boolean {
  return pointerId === 0 || eventPointerId === 0 || pointerId === eventPointerId;
}

function sideOfOther(side: Side): Side {
  return side === 'left' ? 'right' : 'left';
}

function sideDefault(side: Side): number {
  return side === 'left' ? DEFAULT_LEFT : DEFAULT_RIGHT;
}

function sideMinimum(metrics: LayoutMetrics, side: Side): number {
  return side === 'left' ? metrics.leftMin : metrics.rightMin;
}

function sideMaximum(metrics: LayoutMetrics, side: Side, otherWidth: number): number {
  if (!Number.isFinite(metrics.available)) {
    return side === 'left' ? metrics.leftMax : metrics.rightMax;
  }
  const maximum = metrics.available - metrics.centerMin - otherWidth;
  return Math.max(sideMinimum(metrics, side), maximum);
}

function ariaMaximum(effective: EffectiveColumns, side: Side): number {
  const other = effective[sideOfOther(side)];
  const maximum = sideMaximum(effective.metrics, side, other);
  if (Number.isFinite(maximum)) return Math.round(maximum);
  // A finite ARIA value remains useful before a browser has measured the root.
  return Math.max(Math.round(effective[side]), Math.round(sideDefault(side) + 1000));
}

export function ReceiptGroupingColumns({ left, center, right }: ReceiptGroupingColumnsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const [preferredColumns, setPreferredColumns] = useState<PreferredColumns>({
    left: DEFAULT_LEFT,
    right: null,
  });
  const preferredColumnsRef = useRef(preferredColumns);
  preferredColumnsRef.current = preferredColumns;
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const containerWidthRef = useRef(containerWidth);
  containerWidthRef.current = containerWidth;
  const [draggingSide, setDraggingSide] = useState<Side | null>(null);

  const effective = useMemo(
    () => effectiveColumnsFor(preferredColumns, containerWidth),
    [containerWidth, preferredColumns],
  );
  const latestRef = useRef({ effective, preferred: preferredColumns });
  latestRef.current = { effective, preferred: preferredColumns };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const measure = () => {
      const width = root.getBoundingClientRect().width;
      // A hidden root reports zero. Retain the last real measurement so
      // temporarily hiding/showing the same component does not erase a choice.
      if (!Number.isFinite(width) || width <= 0) return;
      setContainerWidth((previous) => (previous === width ? previous : width));
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

  function setPreferred(next: PreferredColumns): void {
    const normalized = normalizePreferred(next);
    preferredColumnsRef.current = normalized;
    setPreferredColumns(normalized);
  }

  function restoreBodyStyles(active: ActiveDrag): void {
    document.body.style.cursor = active.bodyStyles.cursor;
    document.body.style.userSelect = active.bodyStyles.userSelect;
  }

  function finishDrag(mode: 'commit' | 'cancel' | 'silent'): void {
    const active = activeDragRef.current;
    if (!active) return;
    activeDragRef.current = null;
    active.removeWindowListeners();
    if (mode === 'cancel') setPreferred(active.startPreferred);
    if (mode !== 'silent') setDraggingSide(null);
    restoreBodyStyles(active);

    try {
      if (active.target.hasPointerCapture?.(active.pointerId)) {
        active.target.releasePointerCapture?.(active.pointerId);
      }
    } catch {
      // Pointer capture may already have been released by the browser.
    }
  }

  useLayoutEffect(() => () => {
    finishDrag('silent');
  }, []);

  function handlePointerMove(event: PointerLike): void {
    const active = activeDragRef.current;
    if (!active || !pointerMatches(active.pointerId, event.pointerId)) return;

    const delta = finiteNumber(event.clientX) - active.startClientX;
    if (delta === 0) return;

    const currentMetrics = effectiveColumnsFor(
      preferredColumnsRef.current,
      containerWidthRef.current,
    ).metrics;
    const side = active.side;
    const other = sideOfOther(side);
    // While the right column is still responsive, moving the left divider
    // right must be able to consume the right column's space once the center
    // reaches its minimum. Keep the responsive right preference in that mode;
    // an explicitly resized right column continues to stay fixed.
    const rightIsResponsive = side === 'left' && active.startPreferred.right === null;
    if (!rightIsResponsive && active.fixedOtherWidth === null) {
      const current = effectiveColumnsFor(preferredColumnsRef.current, containerWidthRef.current);
      active.fixedOtherWidth = current[other];
    }

    const fixedOtherWidth = rightIsResponsive
      ? currentMetrics.rightMin
      : active.fixedOtherWidth ?? sideMinimum(currentMetrics, other);
    const direction = side === 'left' ? 1 : -1;
    const desired = active.startEffective[side] + direction * delta;
    const nextSide = clamp(
      desired,
      sideMinimum(currentMetrics, side),
      sideMaximum(currentMetrics, side, fixedOtherWidth),
    );

    if (rightIsResponsive) {
      setPreferred({ ...active.startPreferred, left: nextSide, right: null });
    } else {
      setPreferred({
        ...active.startPreferred,
        [side]: nextSide,
        [other]: fixedOtherWidth,
      });
    }
    active.moved = true;
    event.preventDefault();
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>, side: Side): void {
    if (event.button !== 0 || activeDragRef.current) return;
    event.preventDefault();

    const target = event.currentTarget;
    const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : 0;
    const startEffective = latestRef.current.effective;
    const bodyStyles = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    const onWindowMove = (pointerEvent: PointerEvent) => handlePointerMove(pointerEvent);
    const onWindowUp = (pointerEvent: PointerEvent) => {
      if (pointerMatches(pointerId, pointerEvent.pointerId)) finishDrag('commit');
    };
    const onWindowCancel = (pointerEvent: PointerEvent) => {
      if (pointerMatches(pointerId, pointerEvent.pointerId)) finishDrag('cancel');
    };
    const onWindowBlur = () => finishDrag('cancel');

    window.addEventListener('pointermove', onWindowMove);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowCancel);
    window.addEventListener('blur', onWindowBlur);

    activeDragRef.current = {
      side,
      pointerId,
      startClientX: finiteNumber(event.clientX),
      startPreferred: { ...preferredColumnsRef.current },
      startEffective,
      target,
      bodyStyles,
      moved: false,
      fixedOtherWidth: null,
      removeWindowListeners: () => {
        window.removeEventListener('pointermove', onWindowMove);
        window.removeEventListener('pointerup', onWindowUp);
        window.removeEventListener('pointercancel', onWindowCancel);
        window.removeEventListener('blur', onWindowBlur);
      },
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setDraggingSide(side);

    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Some test/browser environments do not implement pointer capture.
    }
  }

  function adjustByKeyboard(side: Side, physicalDirection: number, step: number): void {
    const current = latestRef.current.effective;
    const other = sideOfOther(side);
    const metrics = current.metrics;
    const rightIsResponsive = side === 'left' && preferredColumnsRef.current.right === null;
    const otherWidth = rightIsResponsive ? metrics.rightMin : current[other];
    const sideDirection = side === 'left' ? physicalDirection : -physicalDirection;
    const desired = current[side] + sideDirection * step;
    const nextSide = clamp(
      desired,
      sideMinimum(metrics, side),
      sideMaximum(metrics, side, otherWidth),
    );

    const nextPreferred = { ...preferredColumnsRef.current, [side]: nextSide };
    if (!rightIsResponsive) nextPreferred[other] = otherWidth;
    setPreferred(nextPreferred);
  }

  function resetColumn(side: Side): void {
    const nextPreferred = { ...preferredColumnsRef.current };
    if (side === 'right') nextPreferred.right = null;
    else nextPreferred.left = DEFAULT_LEFT;
    setPreferred(nextPreferred);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>, side: Side): void {
    if (event.key === 'Home') {
      event.preventDefault();
      resetColumn(side);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    adjustByKeyboard(side, event.key === 'ArrowRight' ? 1 : -1, event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP);
  }

  const rootStyle = {
    '--receipt-grouping-columns-left-width': `${effective.left}px`,
    // Let CSS provide the unmeasured responsive fallback. The measured
    // value is written inline once ResizeObserver has reported a real width.
    ...(effective.center === null
      ? {}
      : { '--receipt-grouping-columns-right-width': `${effective.right}px` }),
  } as CSSProperties;

  const centerWidth = effective.center === null ? undefined : Math.round(effective.center);
  const separatorProps = (side: Side) => ({
    role: 'separator' as const,
    'aria-label': side === 'left' ? '调整左栏宽度' : '调整右栏宽度',
    'aria-orientation': 'vertical' as const,
    'aria-valuenow': Math.round(effective[side]),
    'aria-valuemin': Math.round(sideMinimum(effective.metrics, side)),
    'aria-valuemax': ariaMaximum(effective, side),
    'aria-keyshortcuts': 'Home ArrowLeft ArrowRight',
    tabIndex: 0,
    className: `receipt-grouping-columns__separator receipt-grouping-columns__separator--${side}${draggingSide === side ? ' is-active' : ''}`,
    'data-testid': `receipt-grouping-columns-divider-${side}`,
  });

  return (
    <div
      ref={rootRef}
      className="receipt-grouping-columns"
      style={rootStyle}
      data-left-width={Math.round(effective.left)}
      data-center-width={centerWidth}
      data-right-width={Math.round(effective.right)}
    >
      <div className="receipt-grouping-columns__pane receipt-grouping-columns__pane--left receipt-grouping-columns__left">
        {left}
      </div>
      <div
        {...separatorProps('left')}
        onPointerDown={(event) => handlePointerDown(event, 'left')}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => {
          if (pointerMatches(activeDragRef.current?.pointerId ?? -1, event.pointerId)) finishDrag('commit');
        }}
        onPointerCancel={(event) => {
          if (pointerMatches(activeDragRef.current?.pointerId ?? -1, event.pointerId)) finishDrag('cancel');
        }}
        onLostPointerCapture={(event) => {
          if (pointerMatches(activeDragRef.current?.pointerId ?? -1, event.pointerId)) finishDrag('cancel');
        }}
        onKeyDown={(event) => handleKeyDown(event, 'left')}
        onDoubleClick={() => resetColumn('left')}
      />
      <div className="receipt-grouping-columns__pane receipt-grouping-columns__pane--center receipt-grouping-columns__center">
        {center}
      </div>
      <div
        {...separatorProps('right')}
        onPointerDown={(event) => handlePointerDown(event, 'right')}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => {
          if (pointerMatches(activeDragRef.current?.pointerId ?? -1, event.pointerId)) finishDrag('commit');
        }}
        onPointerCancel={(event) => {
          if (pointerMatches(activeDragRef.current?.pointerId ?? -1, event.pointerId)) finishDrag('cancel');
        }}
        onLostPointerCapture={(event) => {
          if (pointerMatches(activeDragRef.current?.pointerId ?? -1, event.pointerId)) finishDrag('cancel');
        }}
        onKeyDown={(event) => handleKeyDown(event, 'right')}
        onDoubleClick={() => resetColumn('right')}
      />
      <div className="receipt-grouping-columns__pane receipt-grouping-columns__pane--right receipt-grouping-columns__right">
        {right}
      </div>
    </div>
  );
}

export default ReceiptGroupingColumns;
