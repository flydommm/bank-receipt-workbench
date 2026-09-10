import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import type { SearchKeywordHistoryRole } from '../domain/searchKeywordHistory';

import './SearchKeywordInput.css';

export type SearchKeywordInputProps = {
  value: string;
  label: string;
  role: SearchKeywordHistoryRole;
  history: readonly string[];
  disabled?: boolean;
  onChange: (value: string) => void;
  onSelectHistory: (keyword: string) => void;
  onRemoveHistory?: (role: SearchKeywordHistoryRole, keyword: string) => void;
  onClearHistory?: (role: SearchKeywordHistoryRole) => void;
};

export function SearchKeywordInput({
  value,
  label,
  role,
  history,
  disabled = false,
  onChange,
  onSelectHistory,
  onRemoveHistory,
  onClearHistory,
}: SearchKeywordInputProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeChoiceRef = useRef<HTMLButtonElement | null>(null);
  const regionId = `search-keyword-history-${useId()}`;

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setActiveIndex(null);
    }
  }, [disabled]);

  // A changed draft invalidates the previously highlighted suggestion.
  useEffect(() => {
    setActiveIndex(null);
  }, [value]);

  useEffect(() => {
    if (activeIndex === null) return;
    activeChoiceRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const closeHistory = () => {
    setOpen(false);
    setActiveIndex(null);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (!nextTarget || !event.currentTarget.contains(nextTarget as Node)) closeHistory();
  };

  const handleFocus = () => {
    if (disabled) return;
    setOpen(true);
  };

  const handleInputChange = (nextValue: string) => {
    if (disabled) return;
    setActiveIndex(null);
    onChange(nextValue);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    const isComposing = (event.nativeEvent as globalThis.KeyboardEvent).isComposing;
    if (event.key === 'Enter' && isComposing) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (isComposing) return;

    if (event.key === 'ArrowDown' && history.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
      setActiveIndex((previous) => {
        if (previous === null || previous >= history.length - 1) return 0;
        return previous + 1;
      });
      return;
    }

    if (event.key === 'ArrowUp' && history.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
      setActiveIndex((previous) => {
        if (previous === null || previous <= 0) return history.length - 1;
        return previous - 1;
      });
      return;
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeHistory();
      return;
    }

    if (event.key === 'Enter' && open && activeIndex !== null) {
      const keyword = history[activeIndex];
      if (keyword === undefined) {
        setActiveIndex(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onSelectHistory(keyword);
      inputRef.current?.focus();
      closeHistory();
    }
  };

  const handleSelect = (event: MouseEvent<HTMLButtonElement>, keyword: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    onSelectHistory(keyword);
    inputRef.current?.focus();
    closeHistory();
  };

  const handleSelectMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleRemove = (event: MouseEvent<HTMLButtonElement>, keyword: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    onRemoveHistory?.(role, keyword);
    inputRef.current?.focus();
  };

  const handleClear = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    onClearHistory?.(role);
  };

  return (
    <div className="search-keyword-input" onBlur={handleBlur}>
      <div className="search-keyword-input-control">
        <input
          ref={inputRef}
          type="text"
          value={value}
          aria-label={label}
          onFocus={handleFocus}
          onChange={(event) => handleInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
        />
        <button
          className="search-keyword-input-history-button"
          type="button"
          aria-label={`${label}的历史记录`}
          aria-expanded={open && !disabled}
          aria-controls={regionId}
          onFocus={handleFocus}
          onClick={() => {
            if (!disabled) setOpen(true);
          }}
          disabled={disabled}
        >
          历史
        </button>
      </div>

      {open && !disabled && (
        <div
          id={regionId}
          className="search-keyword-input-history"
          role="region"
          aria-label={`${label}的历史记录列表`}
        >
          <div className="search-keyword-input-history-header">
            <span>最近使用</span>
            <button
              className="search-keyword-input-clear-button"
              type="button"
              onClick={handleClear}
              disabled={history.length === 0}
            >
              清空历史
            </button>
          </div>
          {history.length === 0 ? (
            <p className="search-keyword-input-empty">暂无历史关键词</p>
          ) : (
            <ul className="search-keyword-input-history-list">
              {history.map((keyword, index) => (
                <li
                  className="search-keyword-input-history-item"
                  key={`${keyword}-${index}`}
                >
                  <button
                    className="search-keyword-input-history-choice"
                    type="button"
                    aria-label={`使用历史关键词 ${keyword}`}
                    aria-current={activeIndex === index ? 'true' : undefined}
                    data-active={activeIndex === index ? 'true' : undefined}
                    ref={activeIndex === index ? activeChoiceRef : undefined}
                    onMouseDown={handleSelectMouseDown}
                    onClick={(event) => handleSelect(event, keyword)}
                  >
                    {keyword}
                  </button>
                  <button
                    className="search-keyword-input-history-remove"
                    type="button"
                    aria-label={`删除历史关键词 ${keyword}`}
                    onClick={(event) => handleRemove(event, keyword)}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default SearchKeywordInput;
