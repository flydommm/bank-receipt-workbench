// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReceiptGroupingColumns } from './ReceiptGroupingColumns';

type ResizeEntry = { target: Element; contentRect: { width: number } };

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  private readonly callback: ResizeObserverCallback;
  private target: Element | null = null;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(target: Element): void {
    this.target = target;
  }

  disconnect(): void {}

  resize(width: number): void {
    if (!this.target) throw new Error('ResizeObserver target is missing');
    Object.defineProperty(this.target, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: 500,
        width,
        height: 500,
        toJSON: () => ({}),
      }),
    });
    const entry = { target: this.target, contentRect: { width } } as ResizeEntry;
    this.callback([entry as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

let pointerCaptureDescriptors: Map<string, PropertyDescriptor | undefined>;

function renderColumns() {
  return render(
    <ReceiptGroupingColumns
      left={<aside>左栏</aside>}
      center={<main>中栏</main>}
      right={<aside>右栏</aside>}
    />,
  );
}

function rootElement(): HTMLElement {
  const root = document.querySelector('.receipt-grouping-columns');
  if (!(root instanceof HTMLElement)) throw new Error('grouping columns root is missing');
  return root;
}

function resizeRoot(width: number): void {
  const observer = ResizeObserverStub.instances.at(-1);
  if (!observer) throw new Error('ResizeObserver was not created');
  act(() => observer.resize(width));
}

function width(side: 'left' | 'center' | 'right'): number {
  return Number(rootElement().getAttribute(`data-${side}-width`));
}

beforeEach(() => {
  ResizeObserverStub.instances = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  pointerCaptureDescriptors = new Map(
    ['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture'].map((name) => (
      [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]
    )),
  );
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
  document.body.style.cursor = 'crosshair';
  document.body.style.userSelect = 'text';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [name, descriptor] of pointerCaptureDescriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

describe('ReceiptGroupingColumns', () => {
  it('renders three clipped column wrappers with a compact center and a dominant default preview', () => {
    renderColumns();
    resizeRoot(1200);

    expect(width('left')).toBe(220);
    expect(width('center')).toBe(240);
    expect(width('right')).toBe(724);
    expect(width('right')).toBeGreaterThan(width('left'));
    expect(width('right')).toBeGreaterThan(width('center'));
    expect(screen.getByText('左栏').parentElement?.className).toContain('receipt-grouping-columns__pane');

    const leftDivider = screen.getByRole('separator', { name: '调整左栏宽度' });
    const rightDivider = screen.getByRole('separator', { name: '调整右栏宽度' });
    expect(leftDivider.getAttribute('aria-orientation')).toBe('vertical');
    expect(rightDivider.getAttribute('aria-valuemin')).toBe('300');
    expect(leftDivider.getAttribute('tabindex')).toBe('0');
  });

  it('lets a default left drag share responsive right space and captures/restores pointer body state', () => {
    renderColumns();
    resizeRoot(1200);
    const leftDivider = screen.getByRole('separator', { name: '调整左栏宽度' });
    const beforeRight = width('right');

    fireEvent.pointerDown(leftDivider, { button: 0, pointerId: 3, clientX: 300 });
    expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalledWith(3);
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.pointerMove(leftDivider, { pointerId: 3, clientX: 350 });
    expect(width('left')).toBe(270);
    expect(width('right')).toBe(beforeRight - 50);
    expect(width('center')).toBe(240);
    expect(width('left') + width('center') + width('right') + 16).toBe(1200);
    fireEvent.pointerUp(leftDivider, { pointerId: 3, clientX: 350 });

    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(3);
  });

  it('scales minima inside a narrow root without horizontal overflow', () => {
    renderColumns();
    resizeRoot(400);

    expect(width('left')).toBeLessThan(160);
    expect(width('right')).toBeLessThan(300);
    expect(width('center')).toBe(0);
    expect(width('left') + width('center') + width('right') + 16).toBeLessThanOrEqual(400);

    resizeRoot(1200);
    expect(width('left')).toBe(220);
    expect(width('right')).toBe(724);
  });

  it('keeps the responsive left drag preference across shrink and expansion', () => {
    renderColumns();
    resizeRoot(1200);
    const leftDivider = screen.getByRole('separator', { name: '调整左栏宽度' });
    fireEvent.pointerDown(leftDivider, { button: 0, pointerId: 4, clientX: 300 });
    fireEvent.pointerMove(leftDivider, { pointerId: 4, clientX: 340 });
    fireEvent.pointerUp(leftDivider, { pointerId: 4, clientX: 340 });
    expect(width('left')).toBe(260);
    expect(width('right')).toBe(684);

    resizeRoot(700);
    expect(width('left')).toBe(160);
    expect(width('right')).toBe(300);
    resizeRoot(1200);
    expect(width('left')).toBe(260);
    expect(width('right')).toBe(684);

    resizeRoot(700);
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整左栏宽度' }), { key: 'ArrowLeft' });
    expect(width('right')).toBe(300);
    resizeRoot(1200);
    expect(width('right')).toBe(784);
  });

  it('cancels pointer edits and restores body state on cancel, blur, and unmount', () => {
    const view = renderColumns();
    resizeRoot(1200);
    const divider = screen.getByRole('separator', { name: '调整左栏宽度' });

    fireEvent.pointerDown(divider, { button: 0, pointerId: 5, clientX: 300 });
    fireEvent.pointerMove(divider, { pointerId: 5, clientX: 360 });
    fireEvent.pointerCancel(divider, { pointerId: 5, clientX: 360 });
    expect(width('left')).toBe(220);
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');

    fireEvent.pointerDown(divider, { button: 0, pointerId: 6, clientX: 300 });
    fireEvent.pointerMove(divider, { pointerId: 6, clientX: 350 });
    fireEvent(window, new Event('blur'));
    expect(width('left')).toBe(220);
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');

    fireEvent.pointerDown(divider, { button: 0, pointerId: 7, clientX: 300 });
    view.unmount();
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');
  });

  it('supports keyboard steps, Shift steps, Home, and double-click reset per divider', () => {
    renderColumns();
    resizeRoot(1200);
    const leftDivider = screen.getByRole('separator', { name: '调整左栏宽度' });
    const rightDivider = screen.getByRole('separator', { name: '调整右栏宽度' });

    fireEvent.keyDown(leftDivider, { key: 'ArrowRight' });
    expect(width('left')).toBe(236);
    expect(width('right')).toBe(708);
    fireEvent.keyDown(leftDivider, { key: 'ArrowLeft', shiftKey: true });
    expect(width('left')).toBe(188);
    expect(width('right')).toBe(756);
    fireEvent.keyDown(leftDivider, { key: 'Home' });
    expect(width('left')).toBe(220);

    fireEvent.keyDown(rightDivider, { key: 'ArrowRight' });
    expect(width('right')).toBe(708);
    fireEvent.doubleClick(rightDivider);
    expect(width('right')).toBe(724);
  });

  it('keeps an explicitly resized right column across root resize while the default remains responsive', () => {
    renderColumns();
    resizeRoot(1200);
    const rightDivider = screen.getByRole('separator', { name: '调整右栏宽度' });

    fireEvent.pointerDown(rightDivider, { button: 0, pointerId: 8, clientX: 900 });
    fireEvent.pointerMove(rightDivider, { pointerId: 8, clientX: 960 });
    fireEvent.pointerUp(rightDivider, { pointerId: 8, clientX: 960 });
    expect(width('right')).toBe(664);

    resizeRoot(900);
    expect(width('right')).toBe(424);
    resizeRoot(1200);
    expect(width('right')).toBe(664);
  });
});
