// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReceiptPaneSplit } from './ReceiptPaneSplit';

type ResizeEntry = { target: Element; contentRect: { height: number } };

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  private readonly callback: ResizeObserverCallback;
  private target: Element | null = null;
  disconnected = false;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(target: Element): void {
    this.target = target;
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  resize(height: number): void {
    if (!this.target) throw new Error('ResizeObserver target is missing');
    Object.defineProperty(this.target, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 800,
        bottom: height,
        width: 800,
        height,
        toJSON: () => ({}),
      }),
    });
    const entry = { target: this.target, contentRect: { height } } as ResizeEntry;
    this.callback([entry as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

let pointerCaptureDescriptors: Map<string, PropertyDescriptor | undefined>;

function renderSplit(resizable = true) {
  return render(
    <div style={{ height: 800 }}>
      <ReceiptPaneSplit
        resizable={resizable}
        preview={<div>PDF 预览区</div>}
        controls={<div>操作区</div>}
      />
    </div>,
  );
}

function rootElement(): HTMLElement {
  const root = document.querySelector('.receipt-pane-split');
  if (!(root instanceof HTMLElement)) throw new Error('split root is missing');
  return root;
}

function observeHeight(height: number): void {
  const observer = ResizeObserverStub.instances.at(-1);
  if (!observer) throw new Error('ResizeObserver was not created');
  act(() => observer.resize(height));
}

function controlsHeight(): number {
  const value = rootElement().getAttribute('data-controls-height');
  if (value === null) throw new Error('controls height is missing');
  return Number(value);
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
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
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

describe('ReceiptPaneSplit', () => {
  it('shows PDF above the controls and defaults to a compact, accessible resizable split', () => {
    renderSplit();
    observeHeight(800);

    const separator = screen.getByRole('separator', { name: '调整操作区高度' });
    expect(separator.getAttribute('aria-orientation')).toBe('horizontal');
    expect(controlsHeight()).toBe(240);
    expect(screen.getByText('PDF 预览区').compareDocumentPosition(screen.getByText('操作区'))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps both panes inside a short container without producing non-finite sizes', () => {
    renderSplit();
    observeHeight(300);

    const previewHeight = Number(rootElement().getAttribute('data-preview-height'));
    expect(previewHeight).toBeGreaterThanOrEqual(0);
    expect(controlsHeight()).toBeGreaterThanOrEqual(0);
    expect(previewHeight + controlsHeight() + 10).toBeLessThanOrEqual(300);
    expect(rootElement().getAttribute('data-hidden')).toBe('false');

    observeHeight(0);
    expect(rootElement().getAttribute('data-hidden')).toBe('true');
    expect(Number.isFinite(controlsHeight())).toBe(true);
    observeHeight(800);
    expect(rootElement().getAttribute('data-hidden')).toBe('false');
  });

  it('supports pointer drag in both directions, captures the pointer, and restores body styles', () => {
    renderSplit();
    observeHeight(800);
    const separator = screen.getByRole('separator', { name: '调整操作区高度' });

    fireEvent.pointerDown(separator, { button: 0, pointerId: 3, clientY: 400 });
    expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalledWith(3);
    expect(document.body.style.cursor).toBe('row-resize');
    expect(document.body.style.userSelect).toBe('none');

    fireEvent.pointerMove(separator, { pointerId: 3, clientY: 460 });
    expect(controlsHeight()).toBe(180);
    fireEvent.pointerMove(separator, { pointerId: 3, clientY: 440 });
    expect(controlsHeight()).toBe(200);
    fireEvent.pointerUp(separator, { pointerId: 3, clientY: 440 });

    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(3);
  });

  it('clamps pointer dragging at the minimum controls height and preserves at least 180px for preview', () => {
    renderSplit();
    observeHeight(800);
    const separator = screen.getByRole('separator', { name: '调整操作区高度' });

    fireEvent.pointerDown(separator, { button: 0, pointerId: 4, clientY: 400 });
    fireEvent.pointerMove(separator, { pointerId: 4, clientY: 4000 });
    expect(controlsHeight()).toBe(150);
    fireEvent.pointerMove(separator, { pointerId: 4, clientY: -1000 });
    expect(controlsHeight()).toBe(600);
    expect(Number(rootElement().getAttribute('data-preview-height'))).toBeGreaterThanOrEqual(180);
    fireEvent.pointerUp(separator, { pointerId: 4, clientY: -1000 });
  });

  it('moves by physical keyboard direction and resets with Home or double click', () => {
    renderSplit();
    observeHeight(800);
    const separator = screen.getByRole('separator', { name: '调整操作区高度' });

    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    expect(controlsHeight()).toBe(224);
    fireEvent.keyDown(separator, { key: 'ArrowUp' });
    expect(controlsHeight()).toBe(240);
    fireEvent.keyDown(separator, { key: 'ArrowUp' });
    expect(controlsHeight()).toBe(256);
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(controlsHeight()).toBe(240);
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    fireEvent.doubleClick(separator);
    expect(controlsHeight()).toBe(240);
  });

  it('reclamps on resize and restores a manually chosen height when the container grows again', () => {
    renderSplit();
    observeHeight(800);
    const separator = screen.getByRole('separator', { name: '调整操作区高度' });
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    for (let step = 0; step < 8; step += 1) fireEvent.keyDown(separator, { key: 'ArrowUp' });
    expect(controlsHeight()).toBe(352);

    observeHeight(400);
    expect(controlsHeight()).toBeLessThanOrEqual(210);
    expect(Number(rootElement().getAttribute('data-preview-height'))).toBeGreaterThanOrEqual(180);

    observeHeight(800);
    expect(controlsHeight()).toBe(352);
  });

  it('remembers the chosen height while resizable mode is temporarily disabled', () => {
    const view = renderSplit();
    observeHeight(800);
    const separator = screen.getByRole('separator', { name: '调整操作区高度' });
    fireEvent.keyDown(separator, { key: 'ArrowUp' });
    expect(controlsHeight()).toBe(256);

    view.rerender(
      <div style={{ height: 800 }}>
        <ReceiptPaneSplit resizable={false} preview={<div>PDF 预览区</div>} controls={<div>操作区</div>} />
      </div>,
    );
    expect(screen.queryByRole('separator', { name: '调整操作区高度' })).toBeNull();
    expect(rootElement().getAttribute('data-resizable')).toBe('false');

    view.rerender(
      <div style={{ height: 800 }}>
        <ReceiptPaneSplit resizable preview={<div>PDF 预览区</div>} controls={<div>操作区</div>} />
      </div>,
    );
    observeHeight(800);
    expect(controlsHeight()).toBe(256);
  });

  it('uses a scrollable 46% auto-height controls area when resizing is disabled', () => {
    renderSplit(false);
    const controls = screen.getByText('操作区').parentElement;
    expect(controls?.className).toContain('receipt-pane-split__controls');
    expect(rootElement().getAttribute('data-resizable')).toBe('false');
    expect(screen.queryByRole('separator', { name: '调整操作区高度' })).toBeNull();
  });

  it('cleans up an active pointer drag when cancelled or unmounted', () => {
    const view = renderSplit();
    observeHeight(800);
    const separator = screen.getByRole('separator', { name: '调整操作区高度' });

    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientY: 400 });
    fireEvent.pointerMove(separator, { pointerId: 7, clientY: 350 });
    fireEvent.pointerCancel(separator, { pointerId: 7, clientY: 450 });
    expect(controlsHeight()).toBe(240);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    fireEvent.pointerDown(separator, { button: 0, pointerId: 10, clientY: 400 });
    fireEvent.pointerMove(separator, { pointerId: 10, clientY: 350 });
    fireEvent(window, new Event('blur'));
    expect(controlsHeight()).toBe(240);
    expect(document.body.style.cursor).toBe('');

    fireEvent.pointerDown(separator, { button: 0, pointerId: 8, clientY: 400 });
    expect(document.body.style.cursor).toBe('row-resize');
    const observer = ResizeObserverStub.instances.at(-1);
    view.unmount();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    expect(observer?.disconnected).toBe(true);
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(8);
  });

  it('cancels and cleans up an active drag when resizable mode is disabled', () => {
    const view = renderSplit();
    observeHeight(800);
    const separator = screen.getByRole('separator', { name: '调整操作区高度' });
    fireEvent.pointerDown(separator, { button: 0, pointerId: 9, clientY: 400 });
    fireEvent.pointerMove(separator, { pointerId: 9, clientY: 350 });
    expect(controlsHeight()).toBe(290);
    expect(document.body.style.cursor).toBe('row-resize');

    view.rerender(
      <div style={{ height: 800 }}>
        <ReceiptPaneSplit resizable={false} preview={<div>PDF 预览区</div>} controls={<div>操作区</div>} />
      </div>,
    );

    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    expect(controlsHeight()).toBe(240);
  });
});
