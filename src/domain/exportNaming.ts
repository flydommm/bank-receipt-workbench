/** Shared rules for the user-facing base name of an export bundle. */

export const MAX_EXPORT_NAME_LENGTH = 120;
export const MAX_EXPORT_FILENAME_LENGTH = 240;

const WINDOWS_ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/u;
const WINDOWS_ILLEGAL_GLOBAL = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/gu;
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function utf16Length(value: string): number {
  return value.length;
}

function limitUtf16(value: string, limit: number): string {
  return Array.from(value).reduce((result, character) => {
    if (result.length + character.length > limit) return result;
    return result + character;
  }, '');
}

/**
 * Return the canonical base name. A single final .pdf is optional in the UI;
 * the output pipeline appends the extension exactly once.
 */
export function normalizeExportName(value: string): string {
  let normalized = value.trim().normalize('NFC');
  while (/\.pdf$/iu.test(normalized)) normalized = normalized.slice(0, -4);
  return normalized;
}

/** Return a Chinese validation message, or null when the base name is valid. */
export function validateExportName(value: unknown): string | null {
  if (typeof value !== 'string') return '导出文件名必须是文本。';
  if (/[ .]$/u.test(value)) return '导出文件名不能以点或空格结尾。';
  const normalized = normalizeExportName(value);
  if (!normalized) return '导出文件名不能为空。';
  if (utf16Length(normalized) > MAX_EXPORT_NAME_LENGTH) {
    return `导出文件名不能超过 ${MAX_EXPORT_NAME_LENGTH} 个字符。`;
  }
  if (WINDOWS_ILLEGAL.test(normalized)) return '导出文件名包含 Windows 不允许的字符。';
  if (normalized === '.' || normalized === '..') return '导出文件名不能是 . 或 ..。';
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/') || normalized.startsWith('\\')) {
    return '导出文件名不能是路径。';
  }
  if (/[ .]$/u.test(normalized)) return '导出文件名不能以点或空格结尾。';
  if (RESERVED_DEVICE_NAME.test(normalized)) return '导出文件名不能使用 Windows 保留设备名。';
  return null;
}

export function isValidExportName(value: unknown): value is string {
  return validateExportName(value) === null;
}

/**
 * Build the initial value shown by the export dialog from committed include
 * clauses. Exclude clauses and the editable search draft are intentionally not
 * consulted. Invalid characters in a search term are made harmless because
 * this value is an automatic suggestion rather than user-entered output.
 */
export function defaultExportName(includeKeywords: readonly string[]): string {
  const terms = includeKeywords
    .filter((keyword): keyword is string => typeof keyword === 'string')
    .map((keyword) => keyword.trim().normalize('NFC'))
    .filter(Boolean);
  const raw = terms.join('_');
  let safe = raw.replace(WINDOWS_ILLEGAL_GLOBAL, '_').replace(/[ .]+$/gu, '');
  if (RESERVED_DEVICE_NAME.test(safe)) safe = `_${safe}`;
  const suffix = '_匹配结果';
  const prefix = limitUtf16(safe, MAX_EXPORT_NAME_LENGTH - utf16Length(suffix));
  return `${prefix || '导出'}${suffix}`;
}
