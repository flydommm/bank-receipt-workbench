import { useMemo, useState } from 'react';
import type { ReceiptReviewSession } from '../services/receiptCalibrationController';
import { buildReceiptOverviewCards } from './ReceiptOverview';
import { PdfThumbnailGrid } from './PdfThumbnailGrid';
import { ThumbnailSizeControl, THUMBNAIL_SIZE_DEFAULT } from './ThumbnailSizeControl';
import './ReceiptGroupingOverview.css';

type Props = {
  session: ReceiptReviewSession;
  segmentIds: string[];
  focusedId: string | null;
  onOpen: (id: string) => void;
  active: boolean;
  disabled: boolean;
  contextKey: string;
};

/** Read-only projection of reviewed boundaries; grouping never edits review decisions. */
export function ReceiptGroupingOverview({ session, segmentIds, focusedId, onOpen, active, disabled, contextKey }: Props) {
  const [size, setSize] = useState(THUMBNAIL_SIZE_DEFAULT);
  const cards = useMemo(() => {
    const byId = new Map(session.items.map((item) => [item.original.id, item]));
    const items = segmentIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
    return buildReceiptOverviewCards(session, items, 'receipts', 'all', false);
  }, [session, segmentIds]);
  const unavailable = segmentIds.length - cards.length;
  return (
    <section className="receipt-grouping-overview" aria-label="当前组片段总览">
      <div className="receipt-grouping-overview-toolbar">
        <span>单击片段进入单张核对；↑ / ↓ 切换当前片段</span>
        <ThumbnailSizeControl value={size} onChange={setSize} disabled={disabled} />
      </div>
      {unavailable > 0 && <p role="status">有 {unavailable} 张缺少来源信息，暂不能预览；请从回单列表回查分割审核。</p>}
      <PdfThumbnailGrid cards={cards} size={size} shape="receipt" focusedId={focusedId} followFocus
        onOpen={(card) => onOpen(card.id)} active={active} disabled={disabled}
        scrollKey={`grouping-overview:${contextKey}`} label="分组回单片段总览"
        emptyMessage="当前结果没有可预览的回单" />
    </section>
  );
}
