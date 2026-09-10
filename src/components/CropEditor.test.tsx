// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MIN_CROP_SIZE, type PdfRect } from '../domain/cropReview';
import CropEditor from './CropEditor';

const requiredProps = {
  imageData: 'data:image/png;base64,AA==',
  pageWidth: 600,
  pageHeight: 800,
  value: { x0: 60, y0: 80, x1: 540, y1: 300 },
  matchRect: { x0: 80, y0: 120, x1: 180, y1: 140 },
  onChange: vi.fn(),
};

function preparePageBounds() {
  const page = screen.getByTestId('crop-editor-page');
  Object.defineProperty(page, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 100,
      top: 50,
      width: 600,
      height: 800,
      right: 700,
      bottom: 850,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    }),
  });
  return page;
}

function addPointerCaptureSpies(element: Element) {
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.defineProperty(element, 'setPointerCapture', {
    configurable: true,
    value: setPointerCapture,
  });
  Object.defineProperty(element, 'releasePointerCapture', {
    configurable: true,
    value: releasePointerCapture,
  });
  return { setPointerCapture, releasePointerCapture };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CropEditor', () => {
  it('moves a crop rectangle with pointer input', () => {
    const onChange = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} />);
    const box = screen.getByLabelText('裁剪区域');
    addPointerCaptureSpies(box);

    fireEvent.pointerDown(box, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(box, { clientX: 220, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(box, { pointerId: 1 });

    expect(onChange).toHaveBeenCalled();
    const movedRect = onChange.mock.lastCall?.[0] as PdfRect;
    expect(movedRect.x0).toBeCloseTo(80);
    expect(movedRect.y0).toBeCloseTo(60);
    expect(movedRect.x1).toBeCloseTo(560);
    expect(movedRect.y1).toBeCloseTo(280);
  });

  it('renders eight accessible resize handles', () => {
    render(<CropEditor {...requiredProps} />);

    expect(screen.getAllByRole('button', { name: /调整/ })).toHaveLength(8);
    for (const label of [
      '调整北边界',
      '调整东北边界',
      '调整东边界',
      '调整东南边界',
      '调整南边界',
      '调整西南边界',
      '调整西边界',
      '调整西北边界',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('moves one PDF point with arrows and five with Shift', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} onCommit={onCommit} />);
    const box = screen.getByLabelText('裁剪区域');

    fireEvent.keyDown(box, { key: 'ArrowRight' });
    fireEvent.keyDown(box, { key: 'ArrowDown', shiftKey: true });

    expect(onChange.mock.calls.map(([rect]) => rect)).toEqual([
      { x0: 61, y0: 80, x1: 541, y1: 300 },
      { x0: 61, y0: 85, x1: 541, y1: 305 },
    ]);
    expect(onCommit.mock.calls.map(([rect]) => rect)).toEqual(onChange.mock.calls.map(([rect]) => rect));
  });

  it('commits and releases a pointer gesture on pointer up, but not cancel', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} onCommit={onCommit} />);
    const box = screen.getByLabelText('裁剪区域');
    const spies = addPointerCaptureSpies(box);
    preparePageBounds();

    fireEvent.pointerDown(box, { clientX: 200, clientY: 200, pointerId: 2 });
    fireEvent.pointerUp(box, { pointerId: 2 });
    fireEvent.pointerDown(box, { clientX: 200, clientY: 200, pointerId: 3 });
    fireEvent.pointerCancel(box, { pointerId: 3 });

    expect(spies.setPointerCapture).toHaveBeenCalledWith(2);
    expect(spies.setPointerCapture).toHaveBeenCalledWith(3);
    expect(spies.releasePointerCapture).toHaveBeenCalledWith(2);
    expect(spies.releasePointerCapture).toHaveBeenCalledWith(3);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('rolls a cancelled gesture back to its start rectangle without committing', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} onCommit={onCommit} />);
    const box = screen.getByLabelText('裁剪区域');
    const spies = addPointerCaptureSpies(box);
    preparePageBounds();

    fireEvent.pointerDown(box, { clientX: 200, clientY: 200, pointerId: 10, button: 0 });
    fireEvent.pointerMove(box, { clientX: 220, clientY: 180, pointerId: 10 });
    fireEvent.pointerCancel(box, { pointerId: 10 });

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.lastCall?.[0]).toEqual(requiredProps.value);
    expect(onCommit).not.toHaveBeenCalled();
    expect(spies.releasePointerCapture).toHaveBeenCalledTimes(1);
  });

  it('handles lost pointer capture as a cancellation without releasing twice', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} onCommit={onCommit} />);
    const box = screen.getByLabelText('裁剪区域');
    const spies = addPointerCaptureSpies(box);
    preparePageBounds();

    fireEvent.pointerDown(box, { clientX: 200, clientY: 200, pointerId: 11, button: 0 });
    fireEvent.pointerMove(box, { clientX: 220, clientY: 180, pointerId: 11 });
    fireEvent.lostPointerCapture(box, { pointerId: 11 });
    fireEvent.pointerUp(box, { pointerId: 11 });

    expect(onChange.mock.lastCall?.[0]).toEqual(requiredProps.value);
    expect(onCommit).not.toHaveBeenCalled();
    expect(spies.releasePointerCapture).not.toHaveBeenCalled();
  });

  it('ignores secondary, non-primary, non-left, and competing pointers', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} onCommit={onCommit} />);
    const box = screen.getByLabelText('裁剪区域');
    const spies = addPointerCaptureSpies(box);
    preparePageBounds();

    fireEvent.pointerDown(box, { clientX: 200, clientY: 200, pointerId: 20, button: 0, isPrimary: true });
    fireEvent.pointerDown(box, { clientX: 300, clientY: 300, pointerId: 21, button: 0, isPrimary: true });
    fireEvent.pointerMove(box, { clientX: 220, clientY: 180, pointerId: 21 });
    fireEvent.pointerMove(box, { clientX: 220, clientY: 180, pointerId: 20 });
    fireEvent.pointerUp(box, { pointerId: 20 });

    expect(spies.setPointerCapture).toHaveBeenCalledTimes(1);
    expect(spies.setPointerCapture).toHaveBeenCalledWith(20);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(box, { clientX: 200, clientY: 200, pointerId: 22, button: 0, isPrimary: false, pointerType: 'touch' });
    fireEvent.pointerDown(box, { clientX: 200, clientY: 200, pointerId: 23, button: 2, isPrimary: true });
    expect(spies.setPointerCapture).toHaveBeenCalledTimes(1);
  });

  it('rolls back an active pointer when disabled during the gesture', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const view = render(<CropEditor {...requiredProps} onChange={onChange} onCommit={onCommit} />);
    const box = screen.getByLabelText('裁剪区域');
    const spies = addPointerCaptureSpies(box);
    preparePageBounds();

    fireEvent.pointerDown(box, { clientX: 200, clientY: 200, pointerId: 30, button: 0 });
    fireEvent.pointerMove(box, { clientX: 220, clientY: 180, pointerId: 30 });
    view.rerender(<CropEditor {...requiredProps} disabled onChange={onChange} onCommit={onCommit} />);

    expect(onChange.mock.lastCall?.[0]).toEqual(requiredProps.value);
    expect(onCommit).not.toHaveBeenCalled();
    expect(spies.releasePointerCapture).toHaveBeenCalledWith(30);
  });

  it('does not interact when disabled', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<CropEditor {...requiredProps} disabled onChange={onChange} onCommit={onCommit} />);
    const page = preparePageBounds();
    const box = screen.getByLabelText('裁剪区域');

    fireEvent.pointerDown(box, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(box, { clientX: 240, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(box, { pointerId: 1 });
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    fireEvent.doubleClick(page, { clientX: 20, clientY: 20 });

    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: /调整/ }).every((handle) => (handle as HTMLButtonElement).disabled)).toBe(true);
  });

  it('draws a normalized minimum-size rectangle after double-clicking outside', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} onCommit={onCommit} />);
    const page = preparePageBounds();
    addPointerCaptureSpies(page);

    fireEvent.doubleClick(page, { clientX: 600, clientY: 650 });
    fireEvent.pointerDown(page, { clientX: 600, clientY: 650, pointerId: 4 });
    fireEvent.pointerMove(page, { clientX: 596, clientY: 646, pointerId: 4 });
    fireEvent.pointerUp(page, { pointerId: 4 });

    const drawnRect = onChange.mock.lastCall?.[0] as PdfRect;
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(drawnRect).toEqual({ x0: 496, y0: 596, x1: 508, y1: 608 });
    expect(drawnRect.x1 - drawnRect.x0).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
    expect(drawnRect.y1 - drawnRect.y0).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
    expect(onCommit).toHaveBeenCalledWith(drawnRect);
  });

  it('shows an armed draw state, focuses the page, and clears it with Escape', () => {
    const onChange = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} />);
    const page = preparePageBounds();

    fireEvent.doubleClick(page, { clientX: 600, clientY: 650 });

    expect(page.className).toContain('draw-armed');
    expect(screen.getByRole('status').textContent).toContain('拖动');
    fireEvent.keyDown(page, { key: 'Escape' });
    expect(page.className).not.toContain('draw-armed');

    fireEvent.pointerDown(page, { clientX: 600, clientY: 650, pointerId: 40, button: 0 });
    fireEvent.pointerMove(page, { clientX: 500, clientY: 700, pointerId: 40 });
    fireEvent.pointerUp(page, { pointerId: 40 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not move the crop from an ordinary blank-page pointer down', () => {
    const onChange = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} />);
    const page = preparePageBounds();

    fireEvent.pointerDown(page, { clientX: 600, clientY: 650, pointerId: 41, button: 0 });
    fireEvent.pointerMove(page, { clientX: 500, clientY: 700, pointerId: 41 });
    fireEvent.pointerUp(page, { pointerId: 41 });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('resizes a handle while draw mode is armed instead of drawing', () => {
    const onChange = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} />);
    const page = preparePageBounds();
    const eastHandle = screen.getByRole('button', { name: '调整东边界' });
    addPointerCaptureSpies(eastHandle);

    fireEvent.doubleClick(page, { clientX: 600, clientY: 650 });
    fireEvent.pointerDown(eastHandle, { clientX: 640, clientY: 240, pointerId: 42, button: 0 });
    fireEvent.pointerMove(eastHandle, { clientX: 500, clientY: 240, pointerId: 42 });
    fireEvent.pointerUp(eastHandle, { pointerId: 42 });

    const resizedRect = onChange.mock.lastCall?.[0] as PdfRect;
    expect(resizedRect).toEqual({ x0: 60, y0: 80, x1: 400, y1: 300 });
  });

  it('keeps a page-width candidate locked horizontally while resizing', () => {
    const onChange = vi.fn();
    render(
      <CropEditor
        {...requiredProps}
        value={{ x0: 0, y0: 80, x1: 600, y1: 300 }}
        onChange={onChange}
      />,
    );
    const eastHandle = screen.getByRole('button', { name: '调整东边界' });
    addPointerCaptureSpies(eastHandle);

    fireEvent.pointerDown(eastHandle, { clientX: 700, clientY: 240, pointerId: 60, button: 0 });
    fireEvent.pointerMove(eastHandle, { clientX: 500, clientY: 240, pointerId: 60 });

    expect(onChange.mock.lastCall?.[0]).toMatchObject({ x0: 0, x1: 600 });
  });

  it('snaps vertical resize handles to detected boundaries', () => {
    const onChange = vi.fn();
    render(
      <CropEditor
        {...requiredProps}
        value={{ x0: 0, y0: 80, x1: 600, y1: 300 }}
        snapPoints={[200]}
        snapTolerance={8}
        onChange={onChange}
      />,
    );
    const southHandle = screen.getByRole('button', { name: '调整南边界' });
    addPointerCaptureSpies(southHandle);

    fireEvent.pointerDown(southHandle, { clientX: 400, clientY: 350, pointerId: 61, button: 0 });
    fireEvent.pointerMove(southHandle, { clientX: 400, clientY: 204, pointerId: 61 });

    expect(onChange.mock.lastCall?.[0]).toMatchObject({ x0: 0, x1: 600, y1: 200 });
  });

  it('cancels armed draw on page blur and when the image changes', () => {
    const onChange = vi.fn();
    const view = render(<CropEditor {...requiredProps} onChange={onChange} />);
    const page = preparePageBounds();

    fireEvent.doubleClick(page, { clientX: 600, clientY: 650 });
    fireEvent.blur(page);
    expect(page.className).not.toContain('draw-armed');
    fireEvent.pointerDown(page, { clientX: 600, clientY: 650, pointerId: 43, button: 0 });
    fireEvent.pointerMove(page, { clientX: 500, clientY: 700, pointerId: 43 });
    fireEvent.pointerUp(page, { pointerId: 43 });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.doubleClick(page, { clientX: 600, clientY: 650 });
    view.rerender(<CropEditor {...requiredProps} imageData="data:image/png;base64,BB==" onChange={onChange} />);
    fireEvent.pointerDown(page, { clientX: 600, clientY: 650, pointerId: 44, button: 0 });
    fireEvent.pointerMove(page, { clientX: 500, clientY: 700, pointerId: 44 });
    fireEvent.pointerUp(page, { pointerId: 44 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not arm draw mode when double-clicking inside the crop rectangle', () => {
    const onChange = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} />);
    const page = preparePageBounds();
    const box = screen.getByLabelText('裁剪区域');

    fireEvent.doubleClick(box, { clientX: 300, clientY: 200 });
    fireEvent.pointerDown(page, { clientX: 600, clientY: 650, pointerId: 5 });
    fireEvent.pointerMove(page, { clientX: 500, clientY: 700, pointerId: 5 });
    fireEvent.pointerUp(page, { pointerId: 5 });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders the page image and match highlight', () => {
    render(<CropEditor {...requiredProps} />);

    expect(screen.getByRole('img', { name: 'PDF 页面预览' }).getAttribute('src')).toBe(requiredProps.imageData);
    expect(document.querySelector('.match-highlight-box')).toBeTruthy();
    expect(document.querySelector('.crop-box.interactive')).toBeTruthy();
  });

  it('uses the prop value as the only displayed crop rectangle', () => {
    const onChange = vi.fn();
    const view = render(<CropEditor {...requiredProps} onChange={onChange} />);
    const page = preparePageBounds();
    const box = screen.getByLabelText('裁剪区域');

    expect(box.getAttribute('style')).toContain('left: 10%');
    fireEvent.pointerDown(box, { clientX: 200, clientY: 200, pointerId: 50, button: 0 });
    fireEvent.pointerMove(box, { clientX: 220, clientY: 180, pointerId: 50 });
    expect(onChange).toHaveBeenCalled();
    view.rerender(<CropEditor {...requiredProps} onChange={onChange} />);

    expect(page.querySelector('.crop-box')?.getAttribute('style')).toContain('left: 10%');
  });

  it('normalizes an external degenerate value while keeping a tiny match highlight', () => {
    render(
      <CropEditor
        {...requiredProps}
        value={{ x0: 200, y0: 200, x1: 200, y1: 200 }}
        matchRect={{ x0: 100, y0: 100, x1: 100, y1: 100 }}
      />,
    );
    const crop = screen.getByLabelText('裁剪区域');
    const highlight = document.querySelector('.match-highlight-box');
    expect(crop.getAttribute('style')).toContain('width: 2%');
    expect(crop.getAttribute('style')).toContain('height: 1.5%');
    expect(highlight?.getAttribute('style')).toContain('width: 0%');
    expect(highlight?.getAttribute('style')).toContain('height: 0%');
  });

  it('notifies the parent once when an external degenerate value is normalized', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <CropEditor
        {...requiredProps}
        value={{ x0: 100, y0: 100, x1: 100, y1: 100 }}
        onChange={onChange}
        onCommit={onCommit}
      />,
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ x0: 100, y0: 100, x1: 112, y1: 112 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('notifies the parent with the full rectangle when a page is smaller than the minimum', () => {
    const onChange = vi.fn();
    render(
      <CropEditor
        {...requiredProps}
        pageWidth={8}
        pageHeight={10}
        value={{ x0: 2, y0: 3, x1: 4, y1: 5 }}
        onChange={onChange}
      />,
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ x0: 0, y0: 0, x1: 8, y1: 10 });
  });

  it('does not repeat normalization for a rejected value when the callback identity changes', () => {
    const firstOnChange = vi.fn();
    const view = render(
      <CropEditor
        {...requiredProps}
        value={{ x0: 100, y0: 100, x1: 100, y1: 100 }}
        onChange={firstOnChange}
      />,
    );
    const secondOnChange = vi.fn();

    view.rerender(
      <CropEditor
        {...requiredProps}
        value={{ x0: 100, y0: 100, x1: 100, y1: 100 }}
        onChange={secondOnChange}
      />,
    );

    expect(firstOnChange).toHaveBeenCalledTimes(1);
    expect(secondOnChange).not.toHaveBeenCalled();
  });

  it('clears the normalization notice after the parent accepts the normalized value', () => {
    const onChange = vi.fn();
    const view = render(
      <CropEditor
        {...requiredProps}
        value={{ x0: 100, y0: 100, x1: 100, y1: 100 }}
        onChange={onChange}
      />,
    );
    const normalizedValue = onChange.mock.lastCall?.[0] as PdfRect;

    view.rerender(<CropEditor {...requiredProps} value={normalizedValue} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not notify for an already valid crop value', () => {
    const onChange = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} />);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('resizes handles with Arrow keys, Shift steps, corner axes, commit, and instructions', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<CropEditor {...requiredProps} onChange={onChange} onCommit={onCommit} />);
    const east = screen.getByRole('button', { name: '调整东边界' });
    const northeast = screen.getByRole('button', { name: '调整东北边界' });

    expect(east.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText(/方向键/)).toBeTruthy();
    fireEvent.keyDown(east, { key: 'ArrowLeft' });
    fireEvent.keyDown(east, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(northeast, { key: 'ArrowUp' });
    fireEvent.keyDown(northeast, { key: 'ArrowLeft' });

    expect(onChange.mock.calls.map(([rect]) => rect)).toEqual([
      { x0: 60, y0: 80, x1: 539, y1: 300 },
      { x0: 60, y0: 80, x1: 544, y1: 300 },
      { x0: 60, y0: 79, x1: 544, y1: 300 },
      { x0: 60, y0: 79, x1: 543, y1: 300 },
    ]);
    expect(onCommit).toHaveBeenCalledTimes(4);
  });
});
