// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COLUMN_LIMITS,
  COMPACT_DEFAULTS,
  ResizableWorkspace,
  WIDE_DEFAULTS,
  WORKSPACE_COLUMNS_STORAGE_KEY,
} from './ResizableWorkspace';

const ORIGINAL_INNER_WIDTH = window.innerWidth;

function installLocalStorageShim(): void {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function setWorkspaceWidth(width: number): void {
  const workspace = document.querySelector('.workspace');
  if (!workspace) throw new Error('workspace not rendered');
  Object.defineProperty(workspace, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      width,
      height: 500,
      right: width,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  fireEvent(window, new Event('resize'));
}

function variableValue(name: string): string {
  const workspace = document.querySelector('.workspace');
  if (!workspace) throw new Error('workspace not rendered');
  return workspace.getAttribute('style')?.match(new RegExp(`${name}: ([^;]+)`))?.[1] ?? '';
}

function workspaceElement(resetSignal?: number) {
  const resetProps = resetSignal === undefined ? {} : { resetSignal };
  return (
    <ResizableWorkspace
      {...resetProps}
      left={<aside>左栏</aside>}
      center={<main>中栏</main>}
      right={<aside>右栏</aside>}
    />
  );
}

function renderWorkspace(resetSignal?: number) {
  return render(workspaceElement(resetSignal));
}

beforeEach(() => {
  installLocalStorageShim();
  window.localStorage.clear();
  setViewportWidth(1600);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  setViewportWidth(ORIGINAL_INNER_WIDTH);
  vi.restoreAllMocks();
});

describe('ResizableWorkspace', () => {
  it('keeps a persisted preference when the initial reset signal is provided', () => {
    const persisted = JSON.stringify({ left: 320, right: 410 });
    window.localStorage.setItem(WORKSPACE_COLUMNS_STORAGE_KEY, persisted);

    renderWorkspace(0);

    expect(variableValue('--workspace-left')).toBe('320px');
    expect(variableValue('--workspace-right')).toBe('410px');
    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).toBe(persisted);
  });

  it('resets persisted columns when the reset signal changes', () => {
    window.localStorage.setItem(WORKSPACE_COLUMNS_STORAGE_KEY, JSON.stringify({ left: 320, right: 410 }));
    setViewportWidth(1100);
    const view = renderWorkspace(0);

    view.rerender(workspaceElement(1));

    expect(variableValue('--workspace-left')).toBe(`${COMPACT_DEFAULTS.left}px`);
    expect(variableValue('--workspace-right')).toBe(`${COMPACT_DEFAULTS.right}px`);
    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).toBeNull();
  });

  it('does not reset again for the same signal or for a viewport change', () => {
    const persisted = JSON.stringify({ left: 320, right: 410 });
    window.localStorage.setItem(WORKSPACE_COLUMNS_STORAGE_KEY, persisted);
    const view = renderWorkspace(0);

    view.rerender(workspaceElement(0));
    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).toBe(persisted);

    setViewportWidth(1100);
    fireEvent(window, new Event('resize'));

    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).toBe(persisted);
    expect(variableValue('--workspace-left')).toBe('320px');
    expect(variableValue('--workspace-right')).toBe('410px');
  });

  it('renders wide and compact defaults through CSS variables', () => {
    renderWorkspace();
    expect(variableValue('--workspace-left')).toBe(`${WIDE_DEFAULTS.left}px`);
    expect(variableValue('--workspace-right')).toBe(`${WIDE_DEFAULTS.right}px`);

    cleanup();
    setViewportWidth(1100);
    renderWorkspace();
    expect(variableValue('--workspace-left')).toBe(`${COMPACT_DEFAULTS.left}px`);
    expect(variableValue('--workspace-right')).toBe(`${COMPACT_DEFAULTS.right}px`);
  });

  it('falls back to defaults when persisted JSON is corrupt or non-finite', () => {
    window.localStorage.setItem(WORKSPACE_COLUMNS_STORAGE_KEY, '{"left":null,"right":1e309}');
    renderWorkspace();

    expect(variableValue('--workspace-left')).toBe(`${WIDE_DEFAULTS.left}px`);
    expect(variableValue('--workspace-right')).toBe(`${WIDE_DEFAULTS.right}px`);
  });

  it('clamps effective columns to side limits while preserving the center minimum', () => {
    window.localStorage.setItem(WORKSPACE_COLUMNS_STORAGE_KEY, JSON.stringify({ left: 420, right: 520 }));
    renderWorkspace();
    setWorkspaceWidth(COLUMN_LIMITS.centerMin + COLUMN_LIMITS.dividerWidth * 2 + 100);

    const left = Number.parseFloat(variableValue('--workspace-left'));
    const right = Number.parseFloat(variableValue('--workspace-right'));
    expect(left).toBeGreaterThanOrEqual(COLUMN_LIMITS.leftMin);
    expect(left).toBeLessThanOrEqual(COLUMN_LIMITS.leftMax);
    expect(right).toBeGreaterThanOrEqual(COLUMN_LIMITS.rightMin);
    expect(right).toBeLessThanOrEqual(COLUMN_LIMITS.rightMax);
    expect(left + right).toBeLessThanOrEqual(100 + COLUMN_LIMITS.leftMin + COLUMN_LIMITS.rightMin);
  });

  it('budgets side columns from the grid content box after responsive padding', () => {
    renderWorkspace();
    setWorkspaceWidth(1112);

    expect(variableValue('--workspace-left')).toBe('220px');
    expect(variableValue('--workspace-right')).toBe('312px');

    cleanup();
    setViewportWidth(1100);
    renderWorkspace();
    setWorkspaceWidth(1084);

    expect(variableValue('--workspace-left')).toBe('220px');
    expect(variableValue('--workspace-right')).toBe('300px');
  });

  it('changes the adjacent side on pointer drag and persists on pointer up', () => {
    renderWorkspace();
    setWorkspaceWidth(1400);
    const leftDivider = screen.getByRole('separator', { name: '调整左栏宽度' });

    fireEvent.pointerDown(leftDivider, { clientX: 100, pointerId: 1 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    fireEvent(window, new PointerEvent('pointermove', { clientX: 180, pointerId: 1 }));
    expect(variableValue('--workspace-left')).toBe('340px');
    fireEvent(window, new PointerEvent('pointerup', { clientX: 180, pointerId: 1 }));

    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).toBe(JSON.stringify({ left: 340, right: 350 }));
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('moves each separator by physical direction with sixteen-pixel keyboard steps', () => {
    renderWorkspace();
    setWorkspaceWidth(1400);
    const leftDivider = screen.getByRole('separator', { name: '调整左栏宽度' });
    const rightDivider = screen.getByRole('separator', { name: '调整右栏宽度' });

    fireEvent.keyDown(leftDivider, { key: 'ArrowRight' });
    expect(variableValue('--workspace-left')).toBe('276px');
    fireEvent.keyDown(rightDivider, { key: 'ArrowRight' });
    expect(variableValue('--workspace-right')).toBe('334px');
    fireEvent.keyDown(rightDivider, { key: 'ArrowLeft' });
    expect(variableValue('--workspace-right')).toBe('350px');
    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).toBe(JSON.stringify({ left: 276, right: 350 }));
  });

  it('resets both separators to the current breakpoint defaults with Home', () => {
    renderWorkspace();
    setWorkspaceWidth(1400);
    const leftDivider = screen.getByRole('separator', { name: '调整左栏宽度' });
    const rightDivider = screen.getByRole('separator', { name: '调整右栏宽度' });

    fireEvent.keyDown(leftDivider, { key: 'ArrowRight' });
    fireEvent.keyDown(rightDivider, { key: 'ArrowLeft' });
    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).not.toBeNull();

    expect(leftDivider.getAttribute('aria-keyshortcuts')).toContain('Home');
    expect(rightDivider.getAttribute('aria-keyshortcuts')).toContain('Home');
    fireEvent.keyDown(rightDivider, { key: 'Home' });

    expect(variableValue('--workspace-left')).toBe(`${WIDE_DEFAULTS.left}px`);
    expect(variableValue('--workspace-right')).toBe(`${WIDE_DEFAULTS.right}px`);
    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).toBeNull();
  });

  it('does not persist a preference for a pointer click without movement', () => {
    renderWorkspace();
    setWorkspaceWidth(1400);
    const divider = screen.getByRole('separator', { name: '调整左栏宽度' });

    fireEvent.pointerDown(divider, { clientX: 100, pointerId: 8 });
    fireEvent.pointerUp(window, { clientX: 100, pointerId: 8 });

    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).toBeNull();
    expect(variableValue('--workspace-left')).toBe(`${WIDE_DEFAULTS.left}px`);
  });

  it('keeps preferred widths while a narrow window clamps them and restores them when widened', () => {
    window.localStorage.setItem(WORKSPACE_COLUMNS_STORAGE_KEY, JSON.stringify({ left: 400, right: 500 }));
    renderWorkspace();
    setWorkspaceWidth(900);
    const narrowLeft = Number.parseFloat(variableValue('--workspace-left'));
    const narrowRight = Number.parseFloat(variableValue('--workspace-right'));
    expect(narrowLeft).toBeLessThan(400);
    expect(narrowRight).toBeLessThan(500);

    setWorkspaceWidth(1600);
    expect(variableValue('--workspace-left')).toBe('400px');
    expect(variableValue('--workspace-right')).toBe('500px');
    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).toBe(JSON.stringify({ left: 400, right: 500 }));
  });

  it('adjusts the retained preferred width from the preference while narrow', () => {
    window.localStorage.setItem(WORKSPACE_COLUMNS_STORAGE_KEY, JSON.stringify({ left: 400, right: 500 }));
    renderWorkspace();
    setWorkspaceWidth(900);

    fireEvent.keyDown(screen.getByRole('separator', { name: '调整左栏宽度' }), { key: 'ArrowRight' });

    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).toBe(JSON.stringify({ left: 416, right: 500 }));
    setWorkspaceWidth(1600);
    expect(variableValue('--workspace-left')).toBe('416px');
  });

  it('double-clicking either separator clears the preference and restores current defaults', () => {
    renderWorkspace();
    setWorkspaceWidth(1400);
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整左栏宽度' }), { key: 'ArrowRight' });
    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).not.toBeNull();

    fireEvent.doubleClick(screen.getByRole('separator', { name: '调整右栏宽度' }));
    expect(variableValue('--workspace-left')).toBe('260px');
    expect(variableValue('--workspace-right')).toBe('350px');
    expect(window.localStorage.getItem(WORKSPACE_COLUMNS_STORAGE_KEY)).toBeNull();
  });

  it('cleans global pointer listeners and body interaction styles on cancel, blur, and unmount', () => {
    const view = renderWorkspace();
    setWorkspaceWidth(1400);
    const divider = screen.getByRole('separator', { name: '调整左栏宽度' });

    fireEvent.pointerDown(divider, { clientX: 100, pointerId: 2 });
    fireEvent(window, new PointerEvent('pointercancel', { clientX: 120, pointerId: 2 }));
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    fireEvent.pointerDown(divider, { clientX: 100, pointerId: 3 });
    fireEvent(window, new Event('blur'));
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    fireEvent.pointerDown(divider, { clientX: 100, pointerId: 4 });
    view.unmount();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });
});
