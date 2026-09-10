// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SearchCriteria } from '../domain/searchCriteria';
import type { SearchKeywordHistory } from '../domain/searchKeywordHistory';
import SearchCriteriaEditor from './SearchCriteriaEditor';

const criteriaWithOneInclude: SearchCriteria = {
  include: ['手续费'],
  includeMode: 'all',
  exclude: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderEditor(value: SearchCriteria, disabled = false) {
  const onChange = vi.fn<(next: SearchCriteria) => void>();
  const view = render(
    <SearchCriteriaEditor value={value} disabled={disabled} onChange={onChange} />,
  );
  return { onChange, view };
}

describe('SearchCriteriaEditor', () => {
  it('keeps at least one include textbox when the include group is empty', () => {
    renderEditor({ include: [], includeMode: 'all', exclude: [] });

    expect(screen.getAllByRole('textbox', { name: /包含关键词/ })).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: '包含关键词 1' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '排除关键词 1' })).toBeNull();
  });

  it('updates an include keyword immediately with a new criteria and array', () => {
    const { onChange } = renderEditor(criteriaWithOneInclude);
    const input = screen.getByRole('textbox', { name: '包含关键词 1' });

    fireEvent.change(input, { target: { value: '报销' } });

    const next = onChange.mock.lastCall?.[0];
    expect(next).toEqual({ include: ['报销'], includeMode: 'all', exclude: [] });
    expect(next).not.toBe(criteriaWithOneInclude);
    expect(next?.include).not.toBe(criteriaWithOneInclude.include);
  });

  it('adds an empty include row and allows deleting a non-final row', () => {
    const { onChange, view } = renderEditor(criteriaWithOneInclude);

    fireEvent.click(screen.getByRole('button', { name: '添加包含关键词' }));

    const added = onChange.mock.lastCall?.[0];
    expect(added).toEqual({ include: ['手续费', ''], includeMode: 'all', exclude: [] });
    expect(added?.include).not.toBe(criteriaWithOneInclude.include);

    view.rerender(
      <SearchCriteriaEditor value={added!} disabled={false} onChange={onChange} />,
    );
    expect(screen.getByRole('textbox', { name: '包含关键词 2' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '删除包含关键词 2' }));
    expect(onChange.mock.lastCall?.[0]).toEqual(criteriaWithOneInclude);
    expect(onChange.mock.lastCall?.[0].include).not.toBe(added?.include);
  });

  it('does not delete the final include row', () => {
    const { onChange } = renderEditor(criteriaWithOneInclude);
    const remove = screen.getByRole('button', { name: '删除包含关键词 1' });

    expect((remove as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(remove);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('adds and deletes exclude rows while hiding the empty exclude group', () => {
    const emptyExclude = { ...criteriaWithOneInclude, exclude: [] };
    const { onChange, view } = renderEditor(emptyExclude);

    expect(screen.queryByRole('textbox', { name: '排除关键词 1' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加排除关键词' }));

    const added = onChange.mock.lastCall?.[0];
    expect(added).toEqual({ include: ['手续费'], includeMode: 'all', exclude: [''] });
    expect(added?.exclude).not.toBe(emptyExclude.exclude);

    view.rerender(
      <SearchCriteriaEditor value={added!} disabled={false} onChange={onChange} />,
    );
    expect(screen.getByRole('textbox', { name: '排除关键词 1' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '添加排除关键词' }));
    const twoExcludes = onChange.mock.lastCall?.[0];
    expect(twoExcludes?.exclude).toEqual(['', '']);

    view.rerender(
      <SearchCriteriaEditor value={twoExcludes!} disabled={false} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除排除关键词 1' }));
    expect(onChange.mock.lastCall?.[0].exclude).toEqual(['']);
  });

  it('changes the include match mode through labelled all-or-any radios', () => {
    const { onChange, view } = renderEditor(criteriaWithOneInclude);
    const all = screen.getByRole('radio', { name: '全部满足' }) as HTMLInputElement;
    const any = screen.getByRole('radio', { name: '任一满足' }) as HTMLInputElement;

    expect(all.name).toBe('include-mode');
    expect(any.name).toBe('include-mode');
    expect(all.checked).toBe(true);
    expect(any.checked).toBe(false);

    fireEvent.click(any);
    const next = onChange.mock.lastCall?.[0];
    expect(next).toEqual({ include: ['手续费'], includeMode: 'any', exclude: [] });
    expect(next).not.toBe(criteriaWithOneInclude);
    expect(next?.include).not.toBe(criteriaWithOneInclude.include);
    expect(next?.exclude).not.toBe(criteriaWithOneInclude.exclude);
    view.rerender(
      <SearchCriteriaEditor value={next!} disabled={false} onChange={onChange} />,
    );
    expect((screen.getByRole('radio', { name: '任一满足' }) as HTMLInputElement).checked).toBe(true);
  });

  it('shows the exclude explanation and disables every control when disabled', () => {
    const value: SearchCriteria = {
      include: ['手续费'],
      includeMode: 'any',
      exclude: ['内部'],
    };
    const { onChange } = renderEditor(value, true);

    expect(screen.getByText('排除关键词（任意一个命中即排除）')).toBeTruthy();
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    expect(screen.getAllByRole('textbox').every((control) => (control as HTMLInputElement).disabled)).toBe(true);
    expect((screen.getByRole('radio', { name: '全部满足' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('radio', { name: '任一满足' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '添加包含关键词' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '添加排除关键词' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '删除包含关键词 1' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '删除排除关键词 1' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: '包含关键词 1' }), {
      target: { value: '不应更新' },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('passes per-row history into inputs and replaces only the selected row', () => {
    const value: SearchCriteria = {
      include: ['当前一', '当前二'],
      includeMode: 'any',
      exclude: ['当前排除'],
    };
    const keywordHistory: SearchKeywordHistory = {
      include: ['历史包含'],
      exclude: ['历史排除'],
    };
    const onChange = vi.fn<(next: SearchCriteria) => void>();
    render(
      <SearchCriteriaEditor
        value={value}
        disabled={false}
        onChange={onChange}
        keywordHistory={keywordHistory}
      />,
    );

    expect(screen.getAllByRole('button', { name: '包含关键词 1的历史记录' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '包含关键词 2的历史记录' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '排除关键词 1的历史记录' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '包含关键词 2的历史记录' }));
    fireEvent.click(screen.getByRole('button', { name: '使用历史关键词 历史包含' }));

    expect(onChange).toHaveBeenCalledWith({
      include: ['当前一', '历史包含'],
      includeMode: 'any',
      exclude: ['当前排除'],
    });
  });

  it('forwards history deletion and class clearing with their roles', () => {
    const onChange = vi.fn<(next: SearchCriteria) => void>();
    const onRemoveKeywordHistory = vi.fn<(role: 'include' | 'exclude', keyword: string) => void>();
    const onClearKeywordHistory = vi.fn<(role: 'include' | 'exclude') => void>();
    render(
      <SearchCriteriaEditor
        value={criteriaWithOneInclude}
        disabled={false}
        onChange={onChange}
        keywordHistory={{ include: ['历史包含'], exclude: [] }}
        onRemoveKeywordHistory={onRemoveKeywordHistory}
        onClearKeywordHistory={onClearKeywordHistory}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '包含关键词 1的历史记录' }));
    fireEvent.click(screen.getByRole('button', { name: '删除历史关键词 历史包含' }));
    fireEvent.click(screen.getByRole('button', { name: '清空历史' }));

    expect(onRemoveKeywordHistory).toHaveBeenCalledWith('include', '历史包含');
    expect(onClearKeywordHistory).toHaveBeenCalledWith('include');
    expect(onChange).not.toHaveBeenCalled();
  });
});
