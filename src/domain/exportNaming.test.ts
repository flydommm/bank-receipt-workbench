import { describe, expect, it } from 'vitest';

import {
  MAX_EXPORT_NAME_LENGTH,
  defaultExportName,
  normalizeExportName,
  validateExportName,
} from './exportNaming';

describe('export naming', () => {
  it('derives a default only from committed include keywords', () => {
    expect(defaultExportName(['手续费', '华夏银行'])).toBe('手续费_华夏银行_匹配结果');
    expect(defaultExportName(['含/非法:c*', '正常'])).toBe('含_非法_c__正常_匹配结果');
    expect(validateExportName(defaultExportName(['CON.txt']))).toBeNull();
    expect(validateExportName(defaultExportName(['<>:*?/\\\u0001']))).toBeNull();
  });

  it('accepts one optional PDF extension and appends no second extension', () => {
    expect(normalizeExportName('  结果.pdf  ')).toBe('结果');
    expect(normalizeExportName('结果.pdf.pdf')).toBe('结果');
    expect(validateExportName('结果.pdf')).toBeNull();
  });

  it.each([
    '', '.', '..', '../结果', 'C:\\结果', '结果/明细', '结果|明细', '结果\u0001', '结果 .pdf', '结果..pdf',
    '结果 ', 'CON', 'con.pdf', `${'x'.repeat(MAX_EXPORT_NAME_LENGTH + 1)}`,
  ])('rejects unsafe name %j', (value) => {
    expect(validateExportName(value)).toBeTypeOf('string');
  });
});
