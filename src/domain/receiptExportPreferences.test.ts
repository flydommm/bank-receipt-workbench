import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECEIPT_EXPORT_PREFERENCES,
  RECEIPT_EXPORT_PREFERENCES_STORAGE_KEY,
  normalizeReceiptExportPreferences,
  readReceiptExportMode,
  readReceiptExportPreferences,
  writeReceiptExportMode,
  type ReceiptExportPreferencesStorage,
} from './receiptExportPreferences';

function memoryStorage(initial?: string): ReceiptExportPreferencesStorage {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(RECEIPT_EXPORT_PREFERENCES_STORAGE_KEY, initial);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('receipt export preferences', () => {
  it('returns workflow defaults when no preference is stored', () => {
    const storage = memoryStorage();
    expect(readReceiptExportPreferences(storage)).toEqual(DEFAULT_RECEIPT_EXPORT_PREFERENCES);
    expect(readReceiptExportMode('regular', storage)).toBe('merged');
    expect(readReceiptExportMode('grouping', storage)).toBe('by_counterparty');
  });

  it('remembers regular and grouped methods independently', () => {
    const storage = memoryStorage();
    writeReceiptExportMode('regular', 'both', storage);
    writeReceiptExportMode('grouping', 'by_counterparty_merged', storage);
    expect(readReceiptExportPreferences(storage)).toEqual({
      version: 1,
      regular: 'both',
      grouping: 'by_counterparty_merged',
    });
  });

  it('falls back independently for invalid stored values', () => {
    expect(normalizeReceiptExportPreferences({ version: 1, regular: 'bad', grouping: 'by_counterparty_merged' })).toEqual({
      version: 1,
      regular: 'merged',
      grouping: 'by_counterparty_merged',
    });
    expect(normalizeReceiptExportPreferences({ version: 99, regular: 'both', grouping: 'by_counterparty_merged' })).toEqual(
      DEFAULT_RECEIPT_EXPORT_PREFERENCES,
    );
  });

  it('does not throw or block when storage reads and writes fail', () => {
    const storage: ReceiptExportPreferencesStorage = {
      getItem: () => { throw new Error('storage unavailable'); },
      setItem: () => { throw new Error('quota exceeded'); },
    };
    expect(() => readReceiptExportPreferences(storage)).not.toThrow();
    expect(readReceiptExportPreferences(storage)).toEqual(DEFAULT_RECEIPT_EXPORT_PREFERENCES);
    expect(() => writeReceiptExportMode('regular', 'both', storage)).not.toThrow();
  });
});
