import type { ReceiptExportOutputMode } from '../services/exportBundleClient';

/** The browser-local history of the last export method used in each workflow. */
export const RECEIPT_EXPORT_PREFERENCES_STORAGE_KEY = 'pdf-search.receipt-export-preferences.v1';
export const RECEIPT_EXPORT_PREFERENCES_VERSION = 1 as const;

export type ReceiptExportPreferenceContext = 'regular' | 'grouping';
export type ReceiptExportPreferencesStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export type ReceiptExportPreferences = {
  version: typeof RECEIPT_EXPORT_PREFERENCES_VERSION;
  regular: 'merged' | 'by_source' | 'both';
  grouping: 'by_counterparty' | 'by_counterparty_merged';
};

export const DEFAULT_RECEIPT_EXPORT_PREFERENCES: ReceiptExportPreferences = {
  version: RECEIPT_EXPORT_PREFERENCES_VERSION,
  regular: 'merged',
  grouping: 'by_counterparty',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveStorage(storage?: ReceiptExportPreferencesStorage): ReceiptExportPreferencesStorage | null {
  if (storage) return storage;
  try {
    if (typeof window === 'undefined') return null;
    const candidate = window.localStorage;
    if (candidate === null || typeof candidate.getItem !== 'function' || typeof candidate.setItem !== 'function') {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

function cloneDefaults(): ReceiptExportPreferences {
  return { ...DEFAULT_RECEIPT_EXPORT_PREFERENCES };
}

function isRegularMode(value: unknown): value is ReceiptExportPreferences['regular'] {
  return value === 'merged' || value === 'by_source' || value === 'both';
}

function isGroupingMode(value: unknown): value is ReceiptExportPreferences['grouping'] {
  return value === 'by_counterparty' || value === 'by_counterparty_merged';
}

export function normalizeReceiptExportPreferences(value: unknown): ReceiptExportPreferences {
  if (!isRecord(value) || value.version !== RECEIPT_EXPORT_PREFERENCES_VERSION) return cloneDefaults();
  return {
    version: RECEIPT_EXPORT_PREFERENCES_VERSION,
    regular: isRegularMode(value.regular) ? value.regular : DEFAULT_RECEIPT_EXPORT_PREFERENCES.regular,
    grouping: isGroupingMode(value.grouping) ? value.grouping : DEFAULT_RECEIPT_EXPORT_PREFERENCES.grouping,
  };
}

export function readReceiptExportPreferences(storage?: ReceiptExportPreferencesStorage): ReceiptExportPreferences {
  const target = resolveStorage(storage);
  if (!target) return cloneDefaults();
  let serialized: string | null;
  try {
    serialized = target.getItem(RECEIPT_EXPORT_PREFERENCES_STORAGE_KEY);
  } catch {
    return cloneDefaults();
  }
  if (serialized === null) return cloneDefaults();
  try {
    return normalizeReceiptExportPreferences(JSON.parse(serialized));
  } catch {
    return cloneDefaults();
  }
}

export function readReceiptExportMode(
  context: ReceiptExportPreferenceContext,
  storage?: ReceiptExportPreferencesStorage,
): ReceiptExportOutputMode {
  const preferences = readReceiptExportPreferences(storage);
  return context === 'grouping' ? preferences.grouping : preferences.regular;
}

export function writeReceiptExportMode(
  context: ReceiptExportPreferenceContext,
  mode: ReceiptExportOutputMode,
  storage?: ReceiptExportPreferencesStorage,
): void {
  const target = resolveStorage(storage);
  if (!target) return;
  const current = readReceiptExportPreferences(target);
  const next = context === 'grouping'
    ? { ...current, grouping: isGroupingMode(mode) ? mode : current.grouping }
    : { ...current, regular: isRegularMode(mode) ? mode : current.regular };
  try {
    target.setItem(RECEIPT_EXPORT_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Export remains usable when browser storage is unavailable or full.
  }
}
