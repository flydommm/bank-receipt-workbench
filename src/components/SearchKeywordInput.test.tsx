// @vitest-environment jsdom

import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SearchKeywordInput, { type SearchKeywordInputProps } from './SearchKeywordInput';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderInput(overrides: Partial<SearchKeywordInputProps> = {}) {
  const props: SearchKeywordInputProps = {
    value: '当前关键词',
    label: '包含关键词 1',
    role: 'include',
    history: ['退款', '手续费'],
    onChange: vi.fn(),
    onSelectHistory: vi.fn(),
    onRemoveHistory: vi.fn(),
    onClearHistory: vi.fn(),
    ...overrides,
  };
  const onParentKeyDown = vi.fn();
  const view = render(
    <div onKeyDown={onParentKeyDown}>
      <SearchKeywordInput {...props} />
    </div>,
  );
  return { props, onParentKeyDown, view };
}

describe('SearchKeywordInput', () => {
  it('opens the named history region on focus and from the adjacent history button', () => {
    renderInput();
    const input = screen.getByRole('textbox', { name: '包含关键词 1' });
    const historyButton = screen.getByRole('button', { name: '包含关键词 1的历史记录' });

    expect(screen.queryByRole('region', { name: '包含关键词 1的历史记录列表' })).toBeNull();
    fireEvent.focus(input);
    expect(screen.getByRole('region', { name: '包含关键词 1的历史记录列表' })).toBeTruthy();

    fireEvent.blur(input, { relatedTarget: document.body });
    expect(screen.queryByRole('region', { name: '包含关键词 1的历史记录列表' })).toBeNull();
    fireEvent.click(historyButton);
    expect(screen.getByRole('region', { name: '包含关键词 1的历史记录列表' })).toBeTruthy();
  });

  it('shows an empty state and lets the mouse choose a history keyword', () => {
    renderInput({ history: [] });
    fireEvent.click(screen.getByRole('button', { name: '包含关键词 1的历史记录' }));
    expect(screen.getByText('暂无历史关键词')).toBeTruthy();

    cleanup();
    const latest = renderInput();
    fireEvent.click(screen.getByRole('button', { name: '包含关键词 1的历史记录' }));
    fireEvent.click(screen.getByRole('button', { name: '使用历史关键词 退款' }));

    expect(latest.props.onSelectHistory).toHaveBeenCalledWith('退款');
  });

  it('selects the active candidate with Enter and keeps a plain Enter for the parent', () => {
    const { props, onParentKeyDown } = renderInput();
    const input = screen.getByRole('textbox', { name: '包含关键词 1' });
    fireEvent.focus(input);
    expect(document.querySelector('[aria-current="true"]')).toBeNull();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: '使用历史关键词 退款' }).getAttribute('aria-current')).toBe('true');
    const selectEvent = createEvent.keyDown(input, { key: 'Enter' });
    fireEvent(input, selectEvent);

    expect(props.onSelectHistory).toHaveBeenCalledWith('退款');
    expect(selectEvent.defaultPrevented).toBe(true);
    expect(onParentKeyDown).not.toHaveBeenCalled();

    cleanup();
    const plain = renderInput();
    const plainInput = screen.getByRole('textbox', { name: '包含关键词 1' });
    fireEvent.focus(plainInput);
    const plainEnter = createEvent.keyDown(plainInput, { key: 'Enter' });
    fireEvent(plainInput, plainEnter);
    expect(plainEnter.defaultPrevented).toBe(false);
    expect(plain.onParentKeyDown).toHaveBeenCalledTimes(1);
    expect(plain.props.onSelectHistory).not.toHaveBeenCalled();
  });

  it('supports ArrowUp, Escape, and IME Enter boundaries', () => {
    const { props, onParentKeyDown } = renderInput();
    const input = screen.getByRole('textbox', { name: '包含关键词 1' });
    fireEvent.focus(input);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('button', { name: '使用历史关键词 手续费' }).getAttribute('aria-current')).toBe('true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: '包含关键词 1的历史记录列表' })).toBeNull();

    fireEvent.focus(input);
    const imeEnter = createEvent.keyDown(input, { key: 'Enter' });
    Object.defineProperty(imeEnter, 'isComposing', { value: true });
    fireEvent(input, imeEnter);
    expect(imeEnter.defaultPrevented).toBe(true);
    expect(props.onSelectHistory).not.toHaveBeenCalled();
    expect(onParentKeyDown).not.toHaveBeenCalled();
  });

  it('leaves navigation keys to an active IME composition', () => {
    const { onParentKeyDown } = renderInput();
    const input = screen.getByRole('textbox', { name: '包含关键词 1' });
    fireEvent.focus(input);
    const composingArrow = createEvent.keyDown(input, { key: 'ArrowDown' });
    Object.defineProperty(composingArrow, 'isComposing', { value: true });
    fireEvent(input, composingArrow);

    expect(composingArrow.defaultPrevented).toBe(false);
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
    expect(onParentKeyDown).toHaveBeenCalledTimes(1);
  });

  it('scrolls an active history candidate into view as the list is navigated', () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      renderInput({ history: Array.from({ length: 20 }, (_, index) => `关键词${index + 1}`) });
      const input = screen.getByRole('textbox', { name: '包含关键词 1' });
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: 'ArrowDown' });

      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
          configurable: true,
          value: originalScrollIntoView,
        });
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      }
    }
  });

  it('deletes one item and clears the class history without selecting a keyword', () => {
    const { props } = renderInput();
    fireEvent.click(screen.getByRole('button', { name: '包含关键词 1的历史记录' }));

    fireEvent.click(screen.getByRole('button', { name: '删除历史关键词 退款' }));
    expect(props.onRemoveHistory).toHaveBeenCalledWith('include', '退款');
    expect(props.onSelectHistory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '清空历史' }));
    expect(props.onClearHistory).toHaveBeenCalledWith('include');
  });

  it('restores focus to the input after selecting a candidate with Tab and Enter', async () => {
    const user = userEvent.setup();
    const { props } = renderInput();
    const input = screen.getByRole('textbox', { name: '包含关键词 1' }) as HTMLInputElement;

    await user.click(input);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '使用历史关键词 退款' }));

    await user.keyboard('{Enter}');

    expect(props.onSelectHistory).toHaveBeenCalledWith('退款');
    expect(document.activeElement).toBe(input);
  });

  it('restores focus after click deletion while keeping the updated history list open', async () => {
    const user = userEvent.setup();
    const { props, view } = renderInput();
    const input = screen.getByRole('textbox', { name: '包含关键词 1' }) as HTMLInputElement;

    await user.click(input);
    await user.click(screen.getByRole('button', { name: '删除历史关键词 退款' }));
    expect(props.onRemoveHistory).toHaveBeenCalledWith('include', '退款');

    const nextProps = { ...props, history: ['手续费'] };
    view.rerender(
      <div onKeyDown={() => undefined}>
        <SearchKeywordInput {...nextProps} />
      </div>,
    );

    expect(input.value).toBe('当前关键词');
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('region', { name: '包含关键词 1的历史记录列表' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '使用历史关键词 退款' })).toBeNull();
  });

  it('restores focus after keyboard deletion when the removed button unmounts', async () => {
    const user = userEvent.setup();
    const { props, view } = renderInput();
    const input = screen.getByRole('textbox', { name: '包含关键词 1' }) as HTMLInputElement;

    await user.click(input);
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '删除历史关键词 退款' }));
    await user.keyboard('{Enter}');
    expect(props.onRemoveHistory).toHaveBeenCalledWith('include', '退款');

    view.rerender(
      <div onKeyDown={() => undefined}>
        <SearchKeywordInput {...props} history={['手续费']} />
      </div>,
    );

    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('region', { name: '包含关键词 1的历史记录列表' })).toBeTruthy();
  });

  it('closes when focus leaves the component and disables every history operation', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const { props } = renderInput({ disabled: true });
    const input = screen.getByRole('textbox', { name: '包含关键词 1' }) as HTMLInputElement;
    const historyButton = screen.getByRole('button', { name: '包含关键词 1的历史记录' }) as HTMLButtonElement;

    expect(input.disabled).toBe(true);
    expect(historyButton.disabled).toBe(true);
    fireEvent.focus(input);
    fireEvent.click(historyButton);
    expect(screen.queryByRole('region', { name: '包含关键词 1的历史记录列表' })).toBeNull();
    expect(props.onSelectHistory).not.toHaveBeenCalled();
    expect(props.onRemoveHistory).not.toHaveBeenCalled();
    expect(props.onClearHistory).not.toHaveBeenCalled();

    cleanup();
    outside.remove();
  });
});
