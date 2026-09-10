import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_APP_NAME,
  MAX_FEEDBACK_FIELD_LENGTH,
  MAX_FEEDBACK_REPORT_BYTES,
  buildFeedbackReport,
  validateFeedbackDraft,
  validateFeedbackReportText,
  type FeedbackDraft,
  type FeedbackEnvironment,
} from './feedbackReport';

const draft: FeedbackDraft = {
  category: 'problem',
  description: '点击保存后没有生成文件。',
  steps: '选择一个样本，打开帮助中心，点击保存反馈。',
  expected: '生成文本反馈文件。',
  actual: '没有生成文件。',
};

const environment: FeedbackEnvironment = {
  appVersion: '0.1.22',
  engineStatus: 'ready',
  ocrReady: true,
};

describe('feedback report domain', () => {
  it('builds a concise report from explicit draft and environment values', () => {
    const report = buildFeedbackReport(draft, environment);
    expect(report).toContain(`${FEEDBACK_APP_NAME} 使用反馈`);
    expect(report).toContain('反馈类型：问题反馈');
    expect(report).toContain('应用版本：0.1.22');
    expect(report).toContain('本地引擎：已连接');
    expect(report).toContain('OCR 状态：就绪');
    expect(report).toContain(draft.description);
    expect(report).toContain(draft.actual);
    expect(report).not.toContain('PDF');
    expect(report).not.toContain('日志');
    expect(validateFeedbackReportText(report)).toBeNull();
  });

  it('accepts a minimal question and labels unknown sections as not filled', () => {
    const report = buildFeedbackReport({ ...draft, category: 'question', description: '如何撤销上一步操作？', steps: '', expected: '', actual: '' },
      { ...environment, engineStatus: 'checking', ocrReady: null });
    expect(report).toContain('反馈类型：使用咨询');
    expect(report).toContain('本地引擎：检查中');
    expect(report).toContain('OCR 状态：检查中');
    expect(report).toContain('（未填写）');
  });

  it.each([
    ['installed', 'OCR 状态：已安装，待验证'],
    ['verifying', 'OCR 状态：验证中'],
    ['ready', 'OCR 状态：已验证可用'],
    ['unavailable', 'OCR 状态：不可用'],
    ['failed', 'OCR 状态：验证失败'],
    ['unknown', 'OCR 状态：状态未知'],
  ] as const)('reports the explicit OCR state %s without treating installation as readiness', (ocrState, expected) => {
    const report = buildFeedbackReport(draft, {
      appVersion: '0.1.24',
      engineStatus: 'ready',
      ocrState,
    });
    expect(report).toContain(expected);
  });

  it.each([
    ['missing description', { ...draft, description: '' }, '问题描述不能为空。'],
    ['invalid category', { ...draft, category: 'other' }, '反馈类型无效，请重新选择。'],
    ['field too long', { ...draft, description: 'x'.repeat(MAX_FEEDBACK_FIELD_LENGTH + 1) }, `问题描述不能超过 ${MAX_FEEDBACK_FIELD_LENGTH} 个字符。`],
    ['control character', { ...draft, description: 'bad\u0000text' }, '问题描述包含无法保存的控制字符。'],
  ] as const)('rejects %s', (_label, value, message) => {
    expect(validateFeedbackDraft(value)).toBe(message);
    expect(() => buildFeedbackReport(value as FeedbackDraft, environment)).toThrow(message);
  });

  it('rejects a report whose UTF-8 size exceeds the native limit', () => {
    const report = '界'.repeat(Math.floor(MAX_FEEDBACK_REPORT_BYTES / 3) + 1);
    expect(validateFeedbackReportText(report)).toBe('反馈内容过长，请删减后再保存。');
  });

  it('rejects malformed environment values before producing a report', () => {
    expect(() => buildFeedbackReport(draft, { ...environment, appVersion: '' })).toThrow('反馈环境信息无效');
    expect(() => buildFeedbackReport(draft, { ...environment, engineStatus: 'broken' } as unknown as FeedbackEnvironment)).toThrow('反馈环境信息无效');
  });
});
