import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export const COMPANY_ACCOUNT_TEMPLATE_NAME = '本方账户导入模板.xlsx';
export const COMPANY_ACCOUNT_TEMPLATE_URL = `/templates/${COMPANY_ACCOUNT_TEMPLATE_NAME}`;

export type CompanyAccountTemplateSaveResult =
  | { status: 'saved'; fileName: string }
  | { status: 'cancelled' }
  | { status: 'download_requested' };
export type CompanyAccountTemplateInvoke = (command: string) => Promise<unknown>;

const SAVE_FAILED = '保存导入模板失败，请重试。';
const SAFE_NATIVE_ERRORS = new Set([
  '模板文件已存在，请更换文件名。',
  '模板文件必须使用 .xlsx 后缀。',
  '模板文件路径无效。',
  '模板文件名无效。',
  '无法创建模板文件，请检查保存目录后重试。',
  '模板文件写入失败，文件可能不完整，请检查后重试。',
  SAVE_FAILED,
]);

export function companyAccountTemplateErrorMessage(cause: unknown): string {
  const message = typeof cause === 'string' ? cause
    : cause instanceof Error ? cause.message : null;
  return message !== null && SAFE_NATIVE_ERRORS.has(message) ? message : SAVE_FAILED;
}

function safeFileName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 5 && value.length <= 240
    && value === value.trim() && /\.xlsx$/iu.test(value)
    && !/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/u.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value);
}

function defaultInvoke(command: string): Promise<unknown> {
  return tauriInvoke<unknown>(command);
}

/** Desktop owns both the fixed workbook bytes and the native save destination. */
export async function saveCompanyAccountTemplate(call: CompanyAccountTemplateInvoke = defaultInvoke): Promise<CompanyAccountTemplateSaveResult> {
  if (call === defaultInvoke && (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window))) {
    if (typeof document === 'undefined') throw new Error(SAVE_FAILED);
    // Browser development has a real HTTP asset server. Do not claim that a
    // requested browser download has already been written to disk.
    const link = document.createElement('a');
    link.href = COMPANY_ACCOUNT_TEMPLATE_URL;
    link.download = COMPANY_ACCOUNT_TEMPLATE_NAME;
    link.hidden = true;
    try {
      document.body.appendChild(link);
      link.click();
    } catch {
      throw new Error(SAVE_FAILED);
    } finally {
      link.remove();
    }
    return { status: 'download_requested' };
  }
  let response: unknown;
  try {
    response = await call('save_company_account_template');
  } catch (cause) {
    throw new Error(companyAccountTemplateErrorMessage(cause));
  }
  if (typeof response === 'object' && response !== null && !Array.isArray(response)) {
    const payload = response as Record<string, unknown>;
    if (payload.status === 'cancelled') return { status: 'cancelled' };
    if (payload.status === 'saved' && safeFileName(payload.fileName)) {
      return { status: 'saved', fileName: payload.fileName };
    }
  }
  throw new Error(SAVE_FAILED);
}
