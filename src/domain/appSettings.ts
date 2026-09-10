export const APP_SETTINGS_STORAGE_KEY = 'pdf-search.settings.v1';

export type AppSettingsV1 = {
  version: 1;
  defaultMatchMode: 'exact' | 'fuzzy';
  defaultIncludeMode: 'all' | 'any';
  defaultIncludeXlsx: boolean;
  defaultPreviewZoom: 50 | 75 | 100 | 125 | 150;
  lastInputDirectory: string | null;
  lastOutputDirectory: string | null;
  showKeyboardHints: boolean;
};

export type SettingsStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export type SettingsStorageResult =
  | { ok: true }
  | { ok: false; error: string };

export const DEFAULT_APP_SETTINGS: AppSettingsV1 = {
  version: 1,
  defaultMatchMode: 'exact',
  defaultIncludeMode: 'all',
  defaultIncludeXlsx: false,
  defaultPreviewZoom: 100,
  lastInputDirectory: null,
  lastOutputDirectory: null,
  showKeyboardHints: true,
};

const PREVIEW_ZOOMS: readonly AppSettingsV1['defaultPreviewZoom'][] = [
  50,
  75,
  100,
  125,
  150,
];

const STORAGE_UNAVAILABLE_WARNING = '无法访问本地设置存储，已使用默认配置。';
const STORAGE_READ_WARNING = '读取本地设置失败，已使用默认配置。';
const SETTINGS_PARSE_WARNING = '配置内容损坏，已使用默认配置。';
const SETTINGS_VERSION_WARNING = '配置版本不受支持，已使用默认配置。';
const SETTINGS_WRITE_ERROR = '保存设置失败，设置未写入。';
const SETTINGS_CLEAR_ERROR = '清除设置失败，原有设置可能仍然保留。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultSettings(): AppSettingsV1 {
  return { ...DEFAULT_APP_SETTINGS };
}

function normalizeDirectory(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const directory = value.trim();
  return directory === '' ? null : directory;
}

function resolveBrowserStorage(): SettingsStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    const storage = window.localStorage;
    if (
      storage === null
      || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function'
      || typeof storage.removeItem !== 'function'
    ) {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

function resolveStorage(storage?: SettingsStorage): SettingsStorage | null {
  return storage ?? resolveBrowserStorage();
}

export function normalizeAppSettings(value: unknown): AppSettingsV1 {
  if (!isRecord(value) || value.version !== 1) return defaultSettings();

  return {
    version: 1,
    defaultMatchMode: value.defaultMatchMode === 'fuzzy' ? 'fuzzy' : 'exact',
    defaultIncludeMode: value.defaultIncludeMode === 'any' ? 'any' : 'all',
    defaultIncludeXlsx: typeof value.defaultIncludeXlsx === 'boolean'
      ? value.defaultIncludeXlsx
      : DEFAULT_APP_SETTINGS.defaultIncludeXlsx,
    defaultPreviewZoom: PREVIEW_ZOOMS.includes(value.defaultPreviewZoom as AppSettingsV1['defaultPreviewZoom'])
      ? value.defaultPreviewZoom as AppSettingsV1['defaultPreviewZoom']
      : DEFAULT_APP_SETTINGS.defaultPreviewZoom,
    lastInputDirectory: normalizeDirectory(value.lastInputDirectory),
    lastOutputDirectory: normalizeDirectory(value.lastOutputDirectory),
    showKeyboardHints: typeof value.showKeyboardHints === 'boolean'
      ? value.showKeyboardHints
      : DEFAULT_APP_SETTINGS.showKeyboardHints,
  };
}

export function readAppSettings(storage?: SettingsStorage): {
  settings: AppSettingsV1;
  warning: string | null;
} {
  const target = resolveStorage(storage);
  if (target === null) {
    return { settings: defaultSettings(), warning: STORAGE_UNAVAILABLE_WARNING };
  }

  let serialized: string | null;
  try {
    serialized = target.getItem(APP_SETTINGS_STORAGE_KEY);
  } catch {
    return { settings: defaultSettings(), warning: STORAGE_READ_WARNING };
  }

  if (serialized === null) {
    return { settings: defaultSettings(), warning: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { settings: defaultSettings(), warning: SETTINGS_PARSE_WARNING };
  }

  if (!isRecord(parsed) || parsed.version !== 1) {
    return { settings: defaultSettings(), warning: SETTINGS_VERSION_WARNING };
  }

  return { settings: normalizeAppSettings(parsed), warning: null };
}

export function writeAppSettings(
  settings: AppSettingsV1,
  storage?: SettingsStorage,
): SettingsStorageResult {
  const target = resolveStorage(storage);
  if (target === null) {
    return { ok: false, error: STORAGE_UNAVAILABLE_WARNING };
  }

  try {
    const serialized = JSON.stringify(normalizeAppSettings(settings));
    target.setItem(APP_SETTINGS_STORAGE_KEY, serialized);
    return { ok: true };
  } catch {
    return { ok: false, error: SETTINGS_WRITE_ERROR };
  }
}

export function clearAppSettings(storage?: SettingsStorage): SettingsStorageResult {
  const target = resolveStorage(storage);
  if (target === null) {
    return { ok: false, error: STORAGE_UNAVAILABLE_WARNING };
  }

  try {
    target.removeItem(APP_SETTINGS_STORAGE_KEY);
    return { ok: true };
  } catch {
    return { ok: false, error: SETTINGS_CLEAR_ERROR };
  }
}
