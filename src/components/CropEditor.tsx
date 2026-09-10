import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import {
  clampPdfRect,
  clientPointToPdf,
  MIN_CROP_SIZE,
  movePdfRect,
  normalizePdfRect,
  resizePdfRect,
  type PdfPoint,
  type PdfRect,
  type ResizeHandle,
} from '../domain/cropReview';
import './cropReview.css';

export type CropEditorProps = {
  imageData: string;
  pageWidth: number;
  pageHeight: number;
  value: PdfRect;
  matchRect: PdfRect;
  disabled?: boolean;
  /** PDF y-coordinates to which north/south handles should snap. */
  snapPoints?: readonly number[];
  snapTolerance?: number;
  onChange: (rect: PdfRect) => void;
  onCommit?: (rect: PdfRect) => void;
};

type ActiveMode = ResizeHandle | 'move' | 'draw';
type CropPointerEvent = ReactPointerEvent<HTMLDivElement> | ReactPointerEvent<HTMLButtonElement>;
type CropPointEvent = Pick<CropPointerEvent, 'clientX' | 'clientY'>;

type GestureSnapshot = {
  value: PdfRect;
  pageWidth: number;
  pageHeight: number;
  imageData: string;
  disabled: boolean;
};

const HANDLES: readonly ResizeHandle[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

const HANDLE_LABELS: Record<ResizeHandle, string> = {
  n: '调整北边界',
  ne: '调整东北边界',
  e: '调整东边界',
  se: '调整东南边界',
  s: '调整南边界',
  sw: '调整西南边界',
  w: '调整西边界',
  nw: '调整西北边界',
};

const HANDLE_HELP_ID = 'crop-editor-handle-help';

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPdfRect(value: unknown): value is PdfRect {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['x0', 'y0', 'x1', 'y1'].every((key) => (
    typeof candidate[key] === 'number' && Number.isFinite(candidate[key])
  ));
}

function safeCropRect(value: unknown, pageWidth: number, pageHeight: number, fallback: PdfRect): PdfRect {
  if (!isPdfRect(value)) return fallback;
  return normalizePdfRect(value, pageWidth, pageHeight);
}

function safeMatchRect(value: unknown, pageWidth: number, pageHeight: number): PdfRect {
  if (!isPdfRect(value)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return clampPdfRect(value, pageWidth, pageHeight);
}

function sameRect(left: PdfRect, right: PdfRect): boolean {
  return left.x0 === right.x0 && left.y0 === right.y0
    && left.x1 === right.x1 && left.y1 === right.y1;
}

function keyPart(value: unknown): string {
  if (typeof value !== 'number') return `${typeof value}:${String(value)}`;
  if (Number.isNaN(value)) return 'number:NaN';
  if (value === Number.POSITIVE_INFINITY) return 'number:+Infinity';
  if (value === Number.NEGATIVE_INFINITY) return 'number:-Infinity';
  return `number:${String(value)}`;
}

function normalizationInputKey(value: unknown, pageWidth: number, pageHeight: number): string {
  const rawRect = isPdfRect(value)
    ? [value.x0, value.y0, value.x1, value.y1].map(keyPart).join(',')
    : 'invalid-rect';
  return [keyPart(pageWidth), keyPart(pageHeight), rawRect].join('|');
}

function rectStyle(rect: PdfRect, pageWidth: number, pageHeight: number): CSSProperties {
  return {
    left: `${(rect.x0 / pageWidth) * 100}%`,
    top: `${(rect.y0 / pageHeight) * 100}%`,
    width: `${((rect.x1 - rect.x0) / pageWidth) * 100}%`,
    height: `${((rect.y1 - rect.y0) / pageHeight) * 100}%`,
  };
}

function pointIsInsideRect(point: PdfPoint, rect: PdfRect): boolean {
  return point.x >= rect.x0 && point.x <= rect.x1 && point.y >= rect.y0 && point.y <= rect.y1;
}

function growAxis(start: number, end: number, pageSize: number): [number, number] {
  const minimum = Math.min(MIN_CROP_SIZE, pageSize);
  if (end - start >= minimum) return [start, end];
  if (start + minimum <= pageSize) return [start, start + minimum];
  return [Math.max(0, pageSize - minimum), pageSize];
}

function drawRect(start: PdfPoint, point: PdfPoint, pageWidth: number, pageHeight: number): PdfRect {
  const bounded = clampPdfRect(
    { x0: start.x, y0: start.y, x1: point.x, y1: point.y },
    pageWidth,
    pageHeight,
  );
  const [x0, x1] = growAxis(bounded.x0, bounded.x1, pageWidth);
  const [y0, y1] = growAxis(bounded.y0, bounded.y1, pageHeight);
  return { x0, y0, x1, y1 };
}

function snapCoordinate(value: number, points: readonly number[], tolerance: number): number {
  const nearest = points
    .filter((point) => Number.isFinite(point))
    .map((point) => ({ point, distance: Math.abs(point - value) }))
    .sort((left, right) => left.distance - right.distance)[0];
  return nearest && nearest.distance <= tolerance ? nearest.point : value;
}

function snapResizeRect(
  rect: PdfRect,
  handle: ResizeHandle,
  points: readonly number[],
  tolerance: number,
  pageWidth: number,
  pageHeight: number,
): PdfRect {
  if (!points.length || (!handle.includes('n') && !handle.includes('s'))) return rect;
  const next = { ...rect };
  if (handle.includes('n')) next.y0 = snapCoordinate(next.y0, points, tolerance);
  if (handle.includes('s')) next.y1 = snapCoordinate(next.y1, points, tolerance);
  return normalizePdfRect(next, pageWidth, pageHeight);
}

function preservePageWidth(rect: PdfRect, startRect: PdfRect, pageWidth: number): PdfRect {
  const epsilon = Math.max(0.5, pageWidth * 0.001);
  if (startRect.x0 <= epsilon && pageWidth - startRect.x1 <= epsilon) {
    return { ...rect, x0: 0, x1: pageWidth };
  }
  return rect;
}

function safeSetPointerCapture(element: Element, pointerId: number): void {
  const capture = (element as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture;
  if (typeof capture === 'function') capture.call(element, pointerId);
}

function safeReleasePointerCapture(element: Element, pointerId: number): void {
  const release = (element as Element & { releasePointerCapture?: (id: number) => void }).releasePointerCapture;
  if (typeof release === 'function') release.call(element, pointerId);
}

function pointerIdOf(event: CropPointerEvent): number {
  return Number.isFinite(event.pointerId) ? event.pointerId : 0;
}

function isAcceptablePrimaryPointer(event: CropPointerEvent): boolean {
  if (typeof event.button === 'number' && event.button !== 0) return false;
  // jsdom exposes `isPrimary: false` for an omitted pointer initializer; a
  // real pointer event always supplies its pointer type, so only reject the
  // explicit non-primary case when that signal is present.
  if (event.isPrimary === false && event.pointerType) return false;
  return true;
}

export function CropEditor({
  imageData,
  pageWidth,
  pageHeight,
  value,
  matchRect,
  disabled = false,
  snapPoints = [],
  snapTolerance = 6,
  onChange,
  onCommit,
}: CropEditorProps) {
  const safePageWidth = isFinitePositive(pageWidth) ? pageWidth : 1;
  const safePageHeight = isFinitePositive(pageHeight) ? pageHeight : 1;
  const fallbackRect: PdfRect = { x0: 0, y0: 0, x1: safePageWidth, y1: safePageHeight };
  const normalizedValue = safeCropRect(value, safePageWidth, safePageHeight, fallbackRect);
  const highlightRect = safeMatchRect(matchRect, safePageWidth, safePageHeight);

  const pageRef = useRef<HTMLDivElement>(null);
  const currentRectRef = useRef<PdfRect>(normalizedValue);
  const startPointRef = useRef<PdfPoint | null>(null);
  const startRectRef = useRef<PdfRect | null>(null);
  const activeModeRef = useRef<ActiveMode | null>(null);
  const activeTargetRef = useRef<Element | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const drawArmedRef = useRef(false);
  const previousPropsRef = useRef<GestureSnapshot | null>(null);
  const normalizationNoticeKeyRef = useRef<string | null>(null);
  const [drawArmed, setDrawArmed] = useState(false);

  function setDrawMode(armed: boolean): void {
    drawArmedRef.current = armed;
    setDrawArmed(armed);
  }

  function clearGestureRefs(): {
    startRect: PdfRect | null;
    target: Element | null;
    pointerId: number | null;
  } {
    const snapshot = {
      startRect: startRectRef.current,
      target: activeTargetRef.current,
      pointerId: activePointerIdRef.current,
    };
    activeModeRef.current = null;
    activeTargetRef.current = null;
    activePointerIdRef.current = null;
    startPointRef.current = null;
    startRectRef.current = null;
    return snapshot;
  }

  function cancelGesture(rollback: boolean, releaseCapture: boolean): void {
    if (activeModeRef.current === null) return;
    const { startRect, target, pointerId } = clearGestureRefs();
    if (releaseCapture && target && pointerId !== null) {
      safeReleasePointerCapture(target, pointerId);
    }
    if (rollback && startRect) {
      currentRectRef.current = startRect;
      onChange(startRect);
    }
  }

  useEffect(() => {
    const previous = previousPropsRef.current;
    const snapshot: GestureSnapshot = {
      value: normalizedValue,
      pageWidth: safePageWidth,
      pageHeight: safePageHeight,
      imageData,
      disabled,
    };

    if (previous) {
      const dimensionsChanged = previous.pageWidth !== safePageWidth || previous.pageHeight !== safePageHeight;
      const imageChanged = previous.imageData !== imageData;
      const valueChanged = !sameRect(previous.value, normalizedValue);
      const draftDiffersFromValue = !sameRect(currentRectRef.current, normalizedValue);

      if (disabled && !previous.disabled) {
        cancelGesture(true, true);
      } else if (activeModeRef.current !== null && (dimensionsChanged || imageChanged || draftDiffersFromValue)) {
        cancelGesture(false, true);
      }
      if (drawArmedRef.current && (dimensionsChanged || imageChanged || valueChanged || disabled)) {
        setDrawMode(false);
      }
    }

    currentRectRef.current = normalizedValue;
    previousPropsRef.current = snapshot;
  }, [normalizedValue.x0, normalizedValue.y0, normalizedValue.x1, normalizedValue.y1, safePageWidth, safePageHeight, imageData, disabled]);

  const rawNormalizationKey = normalizationInputKey(value, pageWidth, pageHeight);
  useEffect(() => {
    const needsNormalization = !isPdfRect(value) || !sameRect(value, normalizedValue);
    if (!needsNormalization) {
      normalizationNoticeKeyRef.current = null;
      return;
    }
    if (normalizationNoticeKeyRef.current === rawNormalizationKey) return;
    normalizationNoticeKeyRef.current = rawNormalizationKey;
    onChange(normalizedValue);
  }, [rawNormalizationKey, normalizedValue.x0, normalizedValue.y0, normalizedValue.x1, normalizedValue.y1]);

  function emitChange(rect: PdfRect): void {
    currentRectRef.current = rect;
    onChange(rect);
  }

  function getPdfPoint(event: CropPointEvent): PdfPoint | null {
    const page = pageRef.current;
    if (!page || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
    const measuredBounds = page.getBoundingClientRect();
    const bounds = Number.isFinite(measuredBounds.left) && Number.isFinite(measuredBounds.top)
      && Number.isFinite(measuredBounds.width) && Number.isFinite(measuredBounds.height)
      && measuredBounds.width > 0 && measuredBounds.height > 0
      ? measuredBounds
      : { left: 0, top: 0, width: safePageWidth, height: safePageHeight };
    return clientPointToPdf(
      event.clientX,
      event.clientY,
      bounds,
      safePageWidth,
      safePageHeight,
    );
  }

  function beginGesture(event: CropPointerEvent, requestedMode: ActiveMode): void {
    if (disabled || activeModeRef.current !== null || !isAcceptablePrimaryPointer(event)) return;
    const point = getPdfPoint(event);
    if (!point) return;

    startPointRef.current = point;
    startRectRef.current = currentRectRef.current;
    activeModeRef.current = requestedMode;
    activeTargetRef.current = event.currentTarget;
    activePointerIdRef.current = pointerIdOf(event);
    safeSetPointerCapture(event.currentTarget, pointerIdOf(event));
    if (requestedMode === 'draw') setDrawMode(false);
    event.preventDefault();
  }

  function pointerBelongsToGesture(event: CropPointerEvent): boolean {
    const activePointerId = activePointerIdRef.current;
    const pointerId = pointerIdOf(event);
    return activePointerId !== null && (pointerId === 0 || pointerId === activePointerId);
  }

  function finishGesture(event: CropPointerEvent): void {
    if (activeModeRef.current === null || !pointerBelongsToGesture(event)) return;
    const { target, pointerId } = clearGestureRefs();
    if (target && pointerId !== null) safeReleasePointerCapture(target, pointerId);
    onCommit?.(currentRectRef.current);
  }

  function handlePointerCancel(event: CropPointerEvent): void {
    if (activeModeRef.current === null || !pointerBelongsToGesture(event)) return;
    cancelGesture(true, true);
  }

  function handleLostPointerCapture(event: CropPointerEvent): void {
    if (activeModeRef.current === null || !pointerBelongsToGesture(event)) return;
    cancelGesture(true, false);
  }

  function handlePointerMove(event: CropPointerEvent): void {
    const mode = activeModeRef.current;
    const startPoint = startPointRef.current;
    const startRect = startRectRef.current;
    if (disabled || mode === null || !startPoint || !startRect || !pointerBelongsToGesture(event)) return;

    const point = getPdfPoint(event);
    if (!point) return;

    const resizedRect = mode === 'move'
      ? movePdfRect(startRect, { x: point.x - startPoint.x, y: point.y - startPoint.y }, safePageWidth, safePageHeight)
      : mode === 'draw'
        ? drawRect(startPoint, point, safePageWidth, safePageHeight)
        : resizePdfRect(startRect, mode, point, safePageWidth, safePageHeight);
    const nextRect = mode === 'draw'
      ? resizedRect
      : preservePageWidth(
        mode === 'move'
          ? resizedRect
          : snapResizeRect(resizedRect, mode, snapPoints, snapTolerance, safePageWidth, safePageHeight),
        startRect,
        safePageWidth,
      );
    emitChange(nextRect);
    event.preventDefault();
  }

  function handlePagePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (drawArmedRef.current) beginGesture(event, 'draw');
  }

  function handleCropPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.stopPropagation();
    beginGesture(event, 'move');
  }

  function handleHandlePointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    handle: ResizeHandle,
  ): void {
    event.stopPropagation();
    beginGesture(event, handle);
  }

  function handleDoubleClick(event: ReactMouseEvent<HTMLDivElement>): void {
    if (disabled) return;
    const point = getPdfPoint(event);
    if (point && !pointIsInsideRect(point, currentRectRef.current)) {
      setDrawMode(true);
      pageRef.current?.focus();
    } else {
      setDrawMode(false);
    }
  }

  function handleCropDoubleClick(event: ReactMouseEvent<HTMLDivElement>): void {
    event.stopPropagation();
    setDrawMode(false);
  }

  function handlePageKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape') return;
    if (activeModeRef.current !== null) cancelGesture(true, true);
    if (drawArmedRef.current) setDrawMode(false);
    event.preventDefault();
  }

  function handlePageBlur(): void {
    if (drawArmedRef.current) setDrawMode(false);
  }

  function handleCropKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;
    const movements: Record<string, PdfPoint> = {
      ArrowUp: { x: 0, y: -1 },
      ArrowRight: { x: 1, y: 0 },
      ArrowDown: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 },
    };
    const movement = movements[event.key];
    if (!movement) return;
    event.preventDefault();
    const amount = event.shiftKey ? 5 : 1;
    const nextRect = movePdfRect(
      currentRectRef.current,
      { x: movement.x * amount, y: movement.y * amount },
      safePageWidth,
      safePageHeight,
    );
    emitChange(nextRect);
    onCommit?.(nextRect);
  }

  function handleKeyboardResize(handle: ResizeHandle, event: ReactKeyboardEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    if (disabled) return;
    const amount = event.shiftKey ? 5 : 1;
    let deltaX = 0;
    let deltaY = 0;
    if (event.key === 'ArrowLeft' && (handle.includes('w') || handle.includes('e'))) deltaX = -amount;
    if (event.key === 'ArrowRight' && (handle.includes('w') || handle.includes('e'))) deltaX = amount;
    if (event.key === 'ArrowUp' && (handle.includes('n') || handle.includes('s'))) deltaY = -amount;
    if (event.key === 'ArrowDown' && (handle.includes('n') || handle.includes('s'))) deltaY = amount;
    if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(event.key)) return;
    event.preventDefault();
    if (deltaX === 0 && deltaY === 0) return;

    const current = currentRectRef.current;
    const point: PdfPoint = {
      x: handle.includes('w') ? current.x0 + deltaX : current.x1 + deltaX,
      y: handle.includes('n') ? current.y0 + deltaY : current.y1 + deltaY,
    };
    const nextRect = preservePageWidth(
      snapResizeRect(
        resizePdfRect(current, handle, point, safePageWidth, safePageHeight),
        handle,
        snapPoints,
        snapTolerance,
        safePageWidth,
        safePageHeight,
      ),
      current,
      safePageWidth,
    );
    emitChange(nextRect);
    onCommit?.(nextRect);
  }

  const cropBoxStyle = rectStyle(normalizedValue, safePageWidth, safePageHeight);
  const highlightStyle = rectStyle(highlightRect, safePageWidth, safePageHeight);

  return (
    <div className={`crop-editor${disabled ? ' is-disabled' : ''}`}>
      <div
        ref={pageRef}
        className={`crop-editor-page${drawArmed ? ' draw-armed' : ''}`}
        data-testid="crop-editor-page"
        tabIndex={0}
        aria-label="PDF 页面裁剪编辑器"
        onPointerDown={handlePagePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handlePageKeyDown}
        onBlur={handlePageBlur}
      >
        <img
          src={imageData}
          alt="PDF 页面预览"
          width={safePageWidth}
          height={safePageHeight}
          draggable={false}
        />
        <div className="match-highlight-box" style={highlightStyle} aria-hidden="true" />
        <div
          className="crop-box interactive"
          style={cropBoxStyle}
          role="region"
          tabIndex={disabled ? -1 : 0}
          aria-label="裁剪区域"
          aria-disabled={disabled || undefined}
          onPointerDown={handleCropPointerDown}
          onDoubleClick={handleCropDoubleClick}
          onKeyDown={handleCropKeyDown}
        >
          {HANDLES.map((handle) => (
            <button
              key={handle}
              type="button"
              className={`crop-handle crop-handle-${handle}`}
              aria-label={HANDLE_LABELS[handle]}
              aria-describedby={HANDLE_HELP_ID}
              disabled={disabled}
              onPointerDown={(event) => handleHandlePointerDown(event, handle)}
              onKeyDown={(event) => handleKeyboardResize(handle, event)}
            />
          ))}
        </div>
        {drawArmed && (
          <div className="crop-editor-draw-status" role="status" aria-live="polite">
            绘制模式：拖动页面空白以定义新的裁剪区域，按 Esc 取消
          </div>
        )}
      </div>
      <span id={HANDLE_HELP_ID} className="sr-only">
        使用方向键调整对应裁剪边界，按 Shift 以 5 个 PDF 点为步长调整
      </span>
    </div>
  );
}

export default CropEditor;
