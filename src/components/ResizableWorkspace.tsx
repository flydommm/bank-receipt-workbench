import { Children, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

export const WORKSPACE_COLUMNS_STORAGE_KEY = 'pdf-search.workspace-columns.v1';
export const WIDE_DEFAULTS = { left: 260, right: 350 } as const;
export const COMPACT_DEFAULTS = { left: 230, right: 320 } as const;
export const COLUMN_LIMITS = {
  leftMin: 220,
  leftMax: 420,
  rightMin: 300,
  rightMax: 520,
  centerMin: 500,
  dividerWidth: 16,
} as const;

const WIDE_HORIZONTAL_PADDING = 48;
const COMPACT_HORIZONTAL_PADDING = 32;

export type WorkspaceColumns = { left: number; right: number };

export type ResizableWorkspaceProps = {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  resetSignal?: number;
};

type DividerIndex = 0 | 1;
type DragCleanupMode = 'commit' | 'cancel' | 'silent';
type ActiveDrag = {
  divider: DividerIndex;
  pointerId: number;
  startClientX: number;
  startPreferred: WorkspaceColumns;
  moved: boolean;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function clampPreferredColumns(columns: WorkspaceColumns): WorkspaceColumns {
  return {
    left: clamp(columns.left, COLUMN_LIMITS.leftMin, COLUMN_LIMITS.leftMax),
    right: clamp(columns.right, COLUMN_LIMITS.rightMin, COLUMN_LIMITS.rightMax),
  };
}

function readStoredColumns(): WorkspaceColumns | null {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (!isFiniteNumber(candidate.left) || !isFiniteNumber(candidate.right)) return null;
    if (
      candidate.left < COLUMN_LIMITS.leftMin
      || candidate.left > COLUMN_LIMITS.leftMax
      || candidate.right < COLUMN_LIMITS.rightMin
      || candidate.right > COLUMN_LIMITS.rightMax
    ) return null;
    return { left: candidate.left, right: candidate.right };
  } catch {
    return null;
  }
}

function writeStoredColumns(columns: WorkspaceColumns): void {
  try {
    window.localStorage.setItem(WORKSPACE_COLUMNS_STORAGE_KEY, JSON.stringify(clampPreferredColumns(columns)));
  } catch {
    // Storage is optional. The workspace remains usable when it is unavailable.
  }
}

function defaultColumnsForViewport(viewportWidth: number): WorkspaceColumns {
  return viewportWidth <= 1250 ? { ...COMPACT_DEFAULTS } : { ...WIDE_DEFAULTS };
}

function contentBoxWidth(
  outerWidth: number,
  viewportWidth: number,
  element?: HTMLElement | null,
): number {
  if (!isFiniteNumber(outerWidth) || outerWidth <= 0) return 0;
  let horizontalPadding = viewportWidth <= 1250
    ? COMPACT_HORIZONTAL_PADDING
    : WIDE_HORIZONTAL_PADDING;
  if (element && typeof window !== 'undefined') {
    try {
      const computed = window.getComputedStyle(element);
      const paddingLeft = Number.parseFloat(computed.paddingLeft);
      const paddingRight = Number.parseFloat(computed.paddingRight);
      if (
        isFiniteNumber(paddingLeft)
        && paddingLeft >= 0
        && isFiniteNumber(paddingRight)
        && paddingRight >= 0
        && paddingLeft + paddingRight > 0
      ) {
        horizontalPadding = paddingLeft + paddingRight;
      }
    } catch {
      // Fall back to the responsive workspace padding when computed styles are unavailable.
    }
  }
  return Math.max(0, outerWidth - horizontalPadding);
}

/**
 * Calculate the widths that can be shown in the current workspace. The
 * preferred widths are intentionally not mutated by this calculation, so a
 * temporary narrow viewport does not erase the user's saved layout.
 */
export function getEffectiveWorkspaceColumns(
  preferred: WorkspaceColumns,
  availableWidth: number,
): WorkspaceColumns {
  let left = clamp(preferred.left, COLUMN_LIMITS.leftMin, COLUMN_LIMITS.leftMax);
  let right = clamp(preferred.right, COLUMN_LIMITS.rightMin, COLUMN_LIMITS.rightMax);
  if (!isFiniteNumber(availableWidth) || availableWidth <= 0) return { left, right };

  const sideBudget = Math.max(
    COLUMN_LIMITS.leftMin + COLUMN_LIMITS.rightMin,
    availableWidth - COLUMN_LIMITS.centerMin - COLUMN_LIMITS.dividerWidth * 2,
  );
  let overflow = left + right - sideBudget;
  if (overflow <= 0) return { left, right };

  const leftRoom = left - COLUMN_LIMITS.leftMin;
  const reduceLeft = Math.min(leftRoom, overflow);
  left -= reduceLeft;
  overflow -= reduceLeft;
  const rightRoom = right - COLUMN_LIMITS.rightMin;
  const reduceRight = Math.min(rightRoom, overflow);
  right -= reduceRight;
  return { left, right };
}

export function ResizableWorkspace({ left, center, right, children, resetSignal }: ResizableWorkspaceProps) {
  const initialViewportWidth = typeof window !== 'undefined' && isFiniteNumber(window.innerWidth)
    ? window.innerWidth
    : 1600;
  const [viewportWidth, setViewportWidth] = useState(initialViewportWidth);
  const viewportWidthRef = useRef(viewportWidth);
  viewportWidthRef.current = viewportWidth;
  const [hasUserPreference, setHasUserPreference] = useState(() => readStoredColumns() !== null);
  const [preferredColumns, setPreferredColumns] = useState<WorkspaceColumns>(() => (
    readStoredColumns() ?? defaultColumnsForViewport(initialViewportWidth)
  ));
  const preferredColumnsRef = useRef(preferredColumns);
  preferredColumnsRef.current = preferredColumns;
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(Number.POSITIVE_INFINITY);
  const [draggingDivider, setDraggingDivider] = useState<DividerIndex | null>(null);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const previousBodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const previousResetSignalRef = useRef(resetSignal);

  const effectiveColumns = useMemo(
    () => getEffectiveWorkspaceColumns(preferredColumns, availableWidth),
    [availableWidth, preferredColumns],
  );

  function setPreferred(columns: WorkspaceColumns): void {
    const next = clampPreferredColumns(columns);
    preferredColumnsRef.current = next;
    setPreferredColumns(next);
  }

  function persistPreferred(): void {
    setHasUserPreference(true);
    writeStoredColumns(preferredColumnsRef.current);
  }

  function stopDrag(mode: DragCleanupMode): void {
    const active = activeDragRef.current;
    if (active && mode === 'cancel') setPreferred(active.startPreferred);
    if (active && mode === 'commit' && active.moved) persistPreferred();
    activeDragRef.current = null;
    if (mode !== 'silent') setDraggingDivider(null);
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>, divider: DividerIndex): void {
    if (event.button !== 0 || activeDragRef.current) return;
    event.preventDefault();
    const body = document.body;
    previousBodyStyleRef.current = {
      cursor: body.style.cursor,
      userSelect: body.style.userSelect,
    };
    body.style.cursor = 'col-resize';
    body.style.userSelect = 'none';
    const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : 0;
    activeDragRef.current = {
      divider,
      pointerId,
      startClientX: event.clientX,
      startPreferred: { ...preferredColumnsRef.current },
      moved: false,
    };
    setDraggingDivider(divider);

    const pointerMatches = (pointerEvent: PointerEvent) => (
      pointerId === 0 || pointerEvent.pointerId === 0 || pointerEvent.pointerId === pointerId
    );
    const onPointerMove = (pointerEvent: PointerEvent) => {
      const active = activeDragRef.current;
      if (!active || !pointerMatches(pointerEvent)) return;
      const physicalDelta = pointerEvent.clientX - active.startClientX;
      const sideDelta = active.divider === 0 ? physicalDelta : -physicalDelta;
      const base = active.startPreferred;
      const side = active.divider === 0 ? 'left' : 'right';
      if (physicalDelta !== 0) active.moved = true;
      setPreferred({ ...base, [side]: base[side] + sideDelta });
      pointerEvent.preventDefault();
    };
    const onPointerUp = (pointerEvent: PointerEvent) => {
      if (!pointerMatches(pointerEvent)) return;
      stopDrag('commit');
    };
    const onPointerCancel = (pointerEvent: PointerEvent) => {
      if (!pointerMatches(pointerEvent)) return;
      stopDrag('cancel');
    };
    const onWindowBlur = () => stopDrag('cancel');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('blur', onWindowBlur);
    dragCleanupRef.current = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('blur', onWindowBlur);
      const previous = previousBodyStyleRef.current;
      if (previous) {
        body.style.cursor = previous.cursor;
        body.style.userSelect = previous.userSelect;
      } else {
        body.style.cursor = '';
        body.style.userSelect = '';
      }
      previousBodyStyleRef.current = null;
    };
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>, divider: DividerIndex): void {
    if (event.key === 'Home') {
      event.preventDefault();
      resetColumns();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const side = divider === 0 ? 'left' : 'right';
    const physicalDirection = event.key === 'ArrowRight' ? 1 : -1;
    const sideDirection = divider === 0 ? physicalDirection : -physicalDirection;
    const base = preferredColumnsRef.current[side];
    setPreferred({ ...preferredColumnsRef.current, [side]: base + sideDirection * COLUMN_LIMITS.dividerWidth });
    persistPreferred();
  }

  function resetColumns(): void {
    const defaults = defaultColumnsForViewport(viewportWidthRef.current);
    setPreferred(defaults);
    setHasUserPreference(false);
    try {
      window.localStorage.removeItem(WORKSPACE_COLUMNS_STORAGE_KEY);
    } catch {
      // Storage is optional.
    }
  }

  useEffect(() => {
    const previousResetSignal = previousResetSignalRef.current;
    if (
      previousResetSignal !== undefined
      && resetSignal !== undefined
      && previousResetSignal !== resetSignal
    ) {
      resetColumns();
    }
    previousResetSignalRef.current = resetSignal;
  }, [resetSignal]);

  useEffect(() => {
    const measure = () => {
      const fallback = isFiniteNumber(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1600;
      const measured = workspaceRef.current?.getBoundingClientRect().width ?? 0;
      setAvailableWidth(measured > 0 ? contentBoxWidth(measured, fallback, workspaceRef.current) : Number.POSITIVE_INFINITY);
      setViewportWidth(fallback);
    };
    measure();
    window.addEventListener('resize', measure);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && workspaceRef.current) {
      observer = new ResizeObserver(measure);
      observer.observe(workspaceRef.current);
    }
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!hasUserPreference) setPreferred(defaultColumnsForViewport(viewportWidth));
  }, [hasUserPreference, viewportWidth]);

  useEffect(() => () => {
    stopDrag('silent');
  }, []);

  const workspaceStyle = {
    '--workspace-left': `${effectiveColumns.left}px`,
    '--workspace-right': `${effectiveColumns.right}px`,
  } as CSSProperties;
  const columns = children === undefined ? [left, center, right] : Children.toArray(children);

  return (
    <div ref={workspaceRef} className="workspace" style={workspaceStyle}>
      {columns[0]}
      <div
        className={`workspace-divider${draggingDivider === 0 ? ' is-active' : ''}`}
        data-testid="workspace-divider-left"
        role="separator"
        aria-label="调整左栏宽度"
        aria-orientation="vertical"
        aria-valuenow={Math.round(effectiveColumns.left)}
        aria-valuemin={COLUMN_LIMITS.leftMin}
        aria-valuemax={COLUMN_LIMITS.leftMax}
        aria-keyshortcuts="Home ArrowLeft ArrowRight"
        tabIndex={0}
        onPointerDown={(event) => handlePointerDown(event, 0)}
        onKeyDown={(event) => handleKeyDown(event, 0)}
        onDoubleClick={resetColumns}
      />
      {columns[1]}
      <div
        className={`workspace-divider${draggingDivider === 1 ? ' is-active' : ''}`}
        data-testid="workspace-divider-right"
        role="separator"
        aria-label="调整右栏宽度"
        aria-orientation="vertical"
        aria-valuenow={Math.round(effectiveColumns.right)}
        aria-valuemin={COLUMN_LIMITS.rightMin}
        aria-valuemax={COLUMN_LIMITS.rightMax}
        aria-keyshortcuts="Home ArrowLeft ArrowRight"
        tabIndex={0}
        onPointerDown={(event) => handlePointerDown(event, 1)}
        onKeyDown={(event) => handleKeyDown(event, 1)}
        onDoubleClick={resetColumns}
      />
      {columns[2]}
    </div>
  );
}

export default ResizableWorkspace;
