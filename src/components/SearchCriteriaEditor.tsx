import type { SearchCriteria } from '../domain/searchCriteria';
import type { SearchMatchMode } from '../domain/searchCriteria';
import type {
  SearchKeywordHistory,
  SearchKeywordHistoryRole,
} from '../domain/searchKeywordHistory';
import SearchKeywordInput from './SearchKeywordInput';

export type SearchCriteriaEditorProps = {
  value: SearchCriteria;
  disabled: boolean;
  onChange: (next: SearchCriteria) => void;
  keywordHistory?: SearchKeywordHistory;
  onRemoveKeywordHistory?: (role: SearchKeywordHistoryRole, keyword: string) => void;
  onClearKeywordHistory?: (role: SearchKeywordHistoryRole) => void;
};

function nextWithInclude(criteria: SearchCriteria, index: number, keyword: string): SearchCriteria {
  const include = criteria.include.length > 0 ? [...criteria.include] : [''];
  include[index] = keyword;
  return { ...criteria, include };
}

function nextWithExclude(criteria: SearchCriteria, index: number, keyword: string): SearchCriteria {
  const exclude = [...criteria.exclude];
  exclude[index] = keyword;
  return { ...criteria, exclude };
}

export function SearchCriteriaEditor({
  value,
  disabled,
  onChange,
  keywordHistory,
  onRemoveKeywordHistory,
  onClearKeywordHistory,
}: SearchCriteriaEditorProps) {
  const includeRows = value.include.length > 0 ? value.include : [''];

  const handleIncludeChange = (index: number, keyword: string) => {
    if (disabled) return;
    onChange(nextWithInclude(value, index, keyword));
  };

  const handleExcludeChange = (index: number, keyword: string) => {
    if (disabled) return;
    onChange(nextWithExclude(value, index, keyword));
  };

  const handleModeChange = (includeMode: SearchMatchMode) => {
    if (disabled) return;
    onChange({
      ...value,
      include: [...value.include],
      exclude: [...value.exclude],
      includeMode,
    });
  };

  const addInclude = () => {
    if (disabled) return;
    const include = value.include.length > 0
      ? [...value.include, '']
      : ['', ''];
    onChange({ ...value, include });
  };

  const removeInclude = (index: number) => {
    if (disabled || value.include.length <= 1) return;
    onChange({
      ...value,
      include: value.include.filter((_, itemIndex) => itemIndex !== index),
    });
  };

  const addExclude = () => {
    if (disabled) return;
    onChange({ ...value, exclude: [...value.exclude, ''] });
  };

  const removeExclude = (index: number) => {
    if (disabled) return;
    onChange({
      ...value,
      exclude: value.exclude.filter((_, itemIndex) => itemIndex !== index),
    });
  };

  return (
    <section className="criteria-editor" aria-label="搜索条件编辑器">
      <div className="criteria-group criteria-include-group">
        <div className="criteria-group-header">
          <div>
            <h3>包含关键词</h3>
            <p>匹配方式</p>
          </div>
          <fieldset className="criteria-mode">
            <legend className="sr-only">包含关键词匹配方式</legend>
            <label>
              <input
                type="radio"
                name="include-mode"
                value="all"
                aria-label="全部满足"
                checked={value.includeMode === 'all'}
                onChange={() => handleModeChange('all')}
                disabled={disabled}
              />
              <span>全部满足</span>
            </label>
            <label>
              <input
                type="radio"
                name="include-mode"
                value="any"
                aria-label="任一满足"
                checked={value.includeMode === 'any'}
                onChange={() => handleModeChange('any')}
                disabled={disabled}
              />
              <span>任一满足</span>
            </label>
          </fieldset>
        </div>

        <div className="criteria-rows">
          {includeRows.map((keyword, index) => (
            <div className="criteria-row" key={`include-${index}`}>
              <SearchKeywordInput
                value={keyword}
                label={`包含关键词 ${index + 1}`}
                role="include"
                history={keywordHistory?.include ?? []}
                onChange={(nextKeyword) => handleIncludeChange(index, nextKeyword)}
                onSelectHistory={(nextKeyword) => handleIncludeChange(index, nextKeyword)}
                onRemoveHistory={onRemoveKeywordHistory}
                onClearHistory={onClearKeywordHistory}
                disabled={disabled}
              />
              <button
                className="criteria-remove-button"
                type="button"
                aria-label={`删除包含关键词 ${index + 1}`}
                onClick={() => removeInclude(index)}
                disabled={disabled || value.include.length <= 1}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          className="text-button criteria-add-button"
          type="button"
          onClick={addInclude}
          disabled={disabled}
        >
          添加包含关键词
        </button>
      </div>

      <div className="criteria-group criteria-exclude-group">
        <div className="criteria-group-heading">
          <h3>排除关键词（任意一个命中即排除）</h3>
        </div>
        {value.exclude.length > 0 && (
          <div className="criteria-rows">
            {value.exclude.map((keyword, index) => (
              <div className="criteria-row" key={`exclude-${index}`}>
                <SearchKeywordInput
                  value={keyword}
                  label={`排除关键词 ${index + 1}`}
                  role="exclude"
                  history={keywordHistory?.exclude ?? []}
                  onChange={(nextKeyword) => handleExcludeChange(index, nextKeyword)}
                  onSelectHistory={(nextKeyword) => handleExcludeChange(index, nextKeyword)}
                  onRemoveHistory={onRemoveKeywordHistory}
                  onClearHistory={onClearKeywordHistory}
                  disabled={disabled}
                />
                <button
                  className="criteria-remove-button"
                  type="button"
                  aria-label={`删除排除关键词 ${index + 1}`}
                  onClick={() => removeExclude(index)}
                  disabled={disabled}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          className="text-button criteria-add-button"
          type="button"
          onClick={addExclude}
          disabled={disabled}
        >
          添加排除关键词
        </button>
      </div>
    </section>
  );
}

export default SearchCriteriaEditor;
