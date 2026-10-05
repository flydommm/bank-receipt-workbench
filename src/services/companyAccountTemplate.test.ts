// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { COMPANY_ACCOUNT_TEMPLATE_NAME, COMPANY_ACCOUNT_TEMPLATE_URL, saveCompanyAccountTemplate, type CompanyAccountTemplateInvoke } from './companyAccountTemplate';

const testWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const originalTauri = testWindow.__TAURI_INTERNALS__;
afterEach(() => {
  if (originalTauri === undefined) delete testWindow.__TAURI_INTERNALS__;
  else Object.defineProperty(testWindow, '__TAURI_INTERNALS__', { configurable: true, value: originalTauri });
  vi.restoreAllMocks();
});

describe('company account template saving', () => {
  it('uses the native bridge instead of the anchor download in a desktop webview', async () => {
    Object.defineProperty(testWindow, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.mocked(invoke).mockResolvedValueOnce({ status: 'saved', fileName: COMPANY_ACCOUNT_TEMPLATE_NAME });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    await expect(saveCompanyAccountTemplate()).resolves.toEqual({ status: 'saved', fileName: COMPANY_ACCOUNT_TEMPLATE_NAME });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('save_company_account_template');
    expect(click).not.toHaveBeenCalled();
  });

  it('asks native code to save its fixed workbook without source bytes or paths', async () => {
    const call = vi.fn<CompanyAccountTemplateInvoke>().mockResolvedValue({ status: 'saved', fileName: COMPANY_ACCOUNT_TEMPLATE_NAME });
    await expect(saveCompanyAccountTemplate(call)).resolves.toEqual({ status: 'saved', fileName: COMPANY_ACCOUNT_TEMPLATE_NAME });
    expect(call).toHaveBeenCalledExactlyOnceWith('save_company_account_template');
  });

  it('returns native cancellation without reporting success or an error', async () => {
    const call = vi.fn<CompanyAccountTemplateInvoke>().mockResolvedValue({ status: 'cancelled' });
    await expect(saveCompanyAccountTemplate(call)).resolves.toEqual({ status: 'cancelled' });
  });

  it('preserves safe Chinese errors while hiding raw paths and transport details', async () => {
    const call = vi.fn<CompanyAccountTemplateInvoke>().mockRejectedValueOnce('模板文件已存在，请更换文件名。').mockRejectedValueOnce('D:\\private\\file.xlsx permission denied');
    await expect(saveCompanyAccountTemplate(call)).rejects.toThrow('模板文件已存在，请更换文件名。');
    await expect(saveCompanyAccountTemplate(call)).rejects.toThrow('保存导入模板失败，请重试。');
  });

  it.each([
    { status: 'saved', fileName: 'D:\\private\\file.xlsx' },
    { status: 'saved', fileName: 'file:stream.xlsx' },
    { status: 'saved', fileName: 'file.txt' },
    { status: 'saved', fileName: 'CON.xlsx' },
    { status: 'saved', fileName: 'file.xlsx ' },
    { status: 'saved' },
    { status: 'download_requested' },
    null,
  ])('does not accept invalid or unsafe desktop results %#', async (response) => {
    const call = vi.fn<CompanyAccountTemplateInvoke>().mockResolvedValue(response);
    await expect(saveCompanyAccountTemplate(call)).rejects.toThrow('保存导入模板失败，请重试。');
  });

  it('uses only the fixed HTTP asset in browser development without claiming disk success', async () => {
    delete testWindow.__TAURI_INTERNALS__;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.getAttribute('href')).toBe(COMPANY_ACCOUNT_TEMPLATE_URL);
      expect(this.download).toBe(COMPANY_ACCOUNT_TEMPLATE_NAME);
      expect(this.isConnected).toBe(true);
    });
    await expect(saveCompanyAccountTemplate()).resolves.toEqual({ status: 'download_requested' });
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('reports browser download initiation failure and removes its temporary link', async () => {
    delete testWindow.__TAURI_INTERNALS__;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('blocked'); });
    await expect(saveCompanyAccountTemplate()).rejects.toThrow('保存导入模板失败，请重试。');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
