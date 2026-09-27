import { useState } from 'react';
import { SPECIAL_DOCUMENT_LABELS, type ReceiptBatchReviewPageItem } from '../domain/receiptBatch';
import { isReceiptDocumentType, type ReceiptDocumentType } from '../domain/receiptReview';

type Props = {
  items: ReceiptBatchReviewPageItem[];
  busy: boolean;
  onSave: (type: ReceiptDocumentType, boundaryConfirmed: boolean) => void;
  onCancel: () => void;
};

export function ReceiptDocumentTypePanel({ items, busy, onSave, onCancel }: Props) {
  const types = new Set(items.map((item) => item.page_notice?.document_type ?? 'ordinary'));
  const [documentType, setDocumentType] = useState<ReceiptDocumentType | ''>(types.size === 1 ? [...types][0] : '');
  const [boundaryConfirmed, setBoundaryConfirmed] = useState(false);
  const blocked = items.some((item) => item.record?.review_status === 'excluded');
  const needsAdjustment = items.some((item) => item.record?.review_status === 'blocked');
  return <section className="receipt-overview__type-panel" aria-label="设置所选凭证类型">
    <div><strong>设置凭证类型 · 所选 {items.length} 处</strong><small>
      {new Set(items.map((item) => item.original.source_key)).size} 份 PDF · {new Set(items.map((item) => JSON.stringify([item.original.source_key, item.original.source_page]))).size} 页</small></div>
    <label>所选凭证类型<select value={documentType} disabled={busy || blocked} onChange={(event) => {
      const value = event.currentTarget.value;
      if (isReceiptDocumentType(value)) { setDocumentType(value); setBoundaryConfirmed(false); }
    }}>
      <option value="" disabled>请选择统一设置的类型</option>
      <option value="ordinary">普通回单</option>
      {Object.entries(SPECIAL_DOCUMENT_LABELS).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
    </select></label>
    <p>仅设置所选片段的类型，不合并片段、不扩为整页。人工改分类的页面会单独微调，不参与普通回单的批量模板同步。</p>
    <label><input type="checkbox" checked={boundaryConfirmed && !needsAdjustment} disabled={busy || blocked || needsAdjustment}
      onChange={(event) => setBoundaryConfirmed(event.currentTarget.checked)} />类型与边界均已核对</label>
    {blocked && <p>所选项含已排除片段，请先恢复后再设置类型。</p>}
    {needsAdjustment && <p>所选项仍有边界问题，保存类型后保持“需调整”，修正边界后才能审核通过。</p>}
    <div className="receipt-overview__type-actions"><button type="button" className="primary" disabled={busy || blocked || !documentType}
      onClick={() => { if (documentType && !busy && !blocked) onSave(documentType, boundaryConfirmed && !needsAdjustment); }}>
      {busy ? '正在保存并核实…' : boundaryConfirmed && !needsAdjustment ? '保存类型并确认边界' : needsAdjustment ? '保存类型，保持需调整' : '保存类型，保留待复核'}</button>
      <button type="button" disabled={busy} onClick={onCancel}>取消设置</button></div>
  </section>;
}
