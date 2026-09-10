// @ts-expect-error Test runtime provides Node fs without @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_NAME, APP_VERSION } from './appIdentity';

const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('display identity and upgrade compatibility', () => {
  it('uses the same visible name and version across the web and native application', () => {
    const native = JSON.parse(read('src-tauri/tauri.conf.json'));
    expect(native.productName).toBe(APP_NAME);
    expect(native.app.windows[0].title).toBe(APP_NAME);
    expect(native.version).toBe(APP_VERSION);
    expect(read('index.html')).toContain(`<title>${APP_NAME}</title>`);
    expect(read('src-tauri/Cargo.toml')).toContain(`version = "${APP_VERSION}"`);
    expect(read('src-tauri/Cargo.lock')).toContain(`name = "pdf-search"\nversion = "${APP_VERSION}"`);
  });

  it('preserves the pre-rebrand NSIS install identity and executable', () => {
    const native = JSON.parse(read('src-tauri/tauri.conf.json'));
    const template = read(`src-tauri/${native.bundle.windows.nsis.template}`);
    expect(native.identifier).toBe('com.local.pdfsearch');
    expect(JSON.parse(read('package.json')).name).toBe('pdf-search');
    expect(read('src-tauri/Cargo.toml')).toContain('name = "pdf-search"');
    expect(template).toContain('!define LEGACYPRODUCTNAME "PDF 精准查找"');
    expect(template).toContain('!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${LEGACYPRODUCTNAME}"');
    expect(template).toContain('!define MANUPRODUCTKEY "${MANUKEY}\\${LEGACYPRODUCTNAME}"');
    expect(template).toContain('ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""');
    expect(template).toContain('Call RestorePreviousInstallLocation');
    expect(JSON.parse(read('package.json')).devDependencies['@tauri-apps/cli']).toBe('2.11.4');
  });
});
