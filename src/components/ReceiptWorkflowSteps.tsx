import './ReceiptWorkflowSteps.css';

/** Progress is descriptive: switching steps never bypasses review or discards a draft. */
export function ReceiptWorkflowSteps({ step }: { step: 1 | 2 | 3 }) {
  const labels = ['选择文件与本方账户', '分析并检查分割', '检查并导出（分组时先核对对手）'] as const;
  return <nav className="receipt-workflow-steps" aria-label="回单处理步骤">
    <span className="receipt-workflow-steps__number" aria-hidden="true">{step}</span>
    <strong aria-current="step">{labels[step - 1]}</strong>
  </nav>;
}
