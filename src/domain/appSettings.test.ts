import { describe, expect, it } from 'vitest';

import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_APP_SETTINGS,
  clearAppSettings,
  normalizeAppSettings,
  readAppSettings,
  writeAppSettings,
  type AppSettingsV1,
  type SettingsStorage,
} from './appSettings';

function createMemoryStorage(initialValue?: string): SettingsStorage {
  const values = new Map<string, string>();
  if (initialValue !== undefined) values.set(APP_SETTINGS_STORAGE_KEY, initialValue);

  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe('app settings defaults and normalization', () => {
  it('returns the complete defaults for an empty storage', () => {
    expect(readAppSettings(createMemoryStorage())).toEqual({
      settings: DEFAULT_APP_SETTINGS,
      warning: null,
    });
  });

  it('keeps valid values, trims directories, and ignores unknown fields', () => {
    const storedValue = JSON.stringify({
      version: 1,
      defaultMatchMode: 'fuzzy',
      defaultIncludeMode: 'any',
      defaultIncludeXlsx: true,
      defaultPreviewZoom: 125,
      lastInputDirectory: '  C:\\Input  ',
      lastOutputDirectory: '  D:\\Output  ',
      showKeyboardHints: false,
      includeKeywords: ['do not persist'],
      pdfPaths: ['secret.pdf'],
    });

    expect(readAppSettings(createMemoryStorage(storedValue))).toEqual({
      settings: {
        version: 1,
        defaultMatchMode: 'fuzzy',
        defaultIncludeMode: 'any',
        defaultIncludeXlsx: true,
        defaultPreviewZoom: 125,
        lastInputDirectory: 'C:\\Input',
        lastOutputDirectory: 'D:\\Output',
        showKeyboardHints: false,
      },
      warning: null,
    });
  });

  it('falls back to the default independently for each invalid field', () => {
    const validInput = {
      version: 1,
      defaultMatchMode: 'fuzzy',
      defaultIncludeMode: 'any',
      defaultIncludeXlsx: true,
      defaultPreviewZoom: 125,
      lastInputDirectory: 'C:\\Input',
      lastOutputDirectory: 'D:\\Output',
      showKeyboardHints: false,
    };

    const invalidFields: Array<[string, unknown, unknown]> = [
      ['defaultMatchMode', 'near', 'exact'],
      ['defaultIncludeMode', 'sometimes', 'all'],
      ['defaultIncludeXlsx', 'true', false],
      ['defaultPreviewZoom', 110, 100],
      ['lastInputDirectory', 42, null],
      ['lastOutputDirectory', {}, null],
      ['showKeyboardHints', 1, true],
    ];

    for (const [field, value, expected] of invalidFields) {
      const normalized = normalizeAppSettings({ ...validInput, [field]: value });
      expect(normalized[field as keyof AppSettingsV1]).toBe(expected);
    }

    expect(normalizeAppSettings({
      ...validInput,
      lastInputDirectory: '   ',
      lastOutputDirectory: '\t\n',
    })).toMatchObject({
      lastInputDirectory: null,
      lastOutputDirectory: null,
    });
  });

  it('rejects unsupported versions and returns only the versioned whitelist', () => {
    expect(normalizeAppSettings({ version: 99, defaultIncludeXlsx: true })).toEqual(
      DEFAULT_APP_SETTINGS,
    );
    expect(normalizeAppSettings({ version: '1', defaultMatchMode: 'fuzzy' })).toEqual(
      DEFAULT_APP_SETTINGS,
    );
    expect(Object.keys(normalizeAppSettings({
      version: 1,
      keyword: 'secret',
      pdf: 'secret.pdf',
    }))).toEqual([
      'version',
      'defaultMatchMode',
      'defaultIncludeMode',
      'defaultIncludeXlsx',
      'defaultPreviewZoom',
      'lastInputDirectory',
      'lastOutputDirectory',
      'showKeyboardHints',
    ]);
  });
});

describe('app settings storage safety', () => {
  it('uses defaults and reports a warning for damaged JSON', () => {
    const result = readAppSettings(createMemoryStorage('{bad'));

    expect(result.settings).toEqual(DEFAULT_APP_SETTINGS);
    expect(result.warning).toMatch(/配置/);
  });

  it('uses defaults and reports a warning when storage read throws', () => {
    const storage: SettingsStorage = {
      getItem: () => {
        throw new Error('read failed');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    expect(() => readAppSettings(storage)).not.toThrow();
    expect(readAppSettings(storage)).toEqual({
      settings: DEFAULT_APP_SETTINGS,
      warning: expect.stringMatching(/读取|存储/),
    });
  });

  it('returns defaults with a warning when no browser storage is available', () => {
    expect(readAppSettings()).toEqual({
      settings: DEFAULT_APP_SETTINGS,
      warning: expect.stringMatching(/存储|设置/),
    });
  });

  it('writes a normalized whitelisted snapshot', () => {
    const storage = createMemoryStorage();
    const candidate = {
      ...DEFAULT_APP_SETTINGS,
      defaultMatchMode: 'fuzzy' as const,
      lastInputDirectory: '  C:\\Input  ',
      includeKeywords: ['secret'],
      sha256: 'secret',
    } as unknown as AppSettingsV1;

    expect(writeAppSettings(candidate, storage)).toEqual({ ok: true });
    expect(storage.getItem(APP_SETTINGS_STORAGE_KEY)).toBe(JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      defaultMatchMode: 'fuzzy',
      lastInputDirectory: 'C:\\Input',
    }));
  });

  it('returns an error result instead of throwing when writing fails', () => {
    const storage: SettingsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => undefined,
    };

    expect(() => writeAppSettings(DEFAULT_APP_SETTINGS, storage)).not.toThrow();
    const result = writeAppSettings(DEFAULT_APP_SETTINGS, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/写入|保存|设置/);
  });

  it('clears stored settings and returns a stable success result', () => {
    const storage = createMemoryStorage(JSON.stringify(DEFAULT_APP_SETTINGS));

    expect(clearAppSettings(storage)).toEqual({ ok: true });
    expect(storage.getItem(APP_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it('returns an error result instead of throwing when clearing fails', () => {
    const storage: SettingsStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        throw new Error('remove failed');
      },
    };

    expect(() => clearAppSettings(storage)).not.toThrow();
    const result = clearAppSettings(storage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/清除|删除|设置/);
  });
});
