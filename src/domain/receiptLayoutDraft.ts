import { MIN_CROP_SIZE } from './cropReview';
import { near, parseLayoutDefinition, ReceiptLayoutError, type LayoutDefinition } from './receiptLayout';

export type LayoutDraftValidation = { layout: LayoutDefinition; error: null } | { layout: null; error: string };
const millimetres = (points: number) => String(Number((points * 25.4 / 72).toFixed(2)));

/** Editing may temporarily overlap or leave the page; preview requires the complete valid layout. */
export function validateLayoutDraft(candidate: LayoutDefinition): LayoutDraftValidation {
  const { width_pt: pageWidth, height_pt: pageHeight } = candidate.page_geometry;
  const left = candidate.left_pt, right = candidate.right_pt;
  if (![pageWidth, pageHeight].every(Number.isFinite) || pageWidth <= 0 || pageHeight <= 0) {
    return { layout: null, error: '页面尺寸无效，请检查页面宽度和页面高度。' };
  }
  if (!Number.isFinite(left) || left < 0) return { layout: null, error: '左边距不能小于 0。' };
  if (!Number.isFinite(right) || right < 0) return { layout: null, error: '右边距不能小于 0。' };
  const contentWidth = pageWidth - left - right;
  const minimumWidth = Math.min(MIN_CROP_SIZE, pageWidth);
  if (!Number.isFinite(contentWidth) || contentWidth <= 0 || (contentWidth < minimumWidth && !near(contentWidth, minimumWidth))) {
    return { layout: null, error: '左右边距过大，栏位必须位于页面宽度内。' };
  }
  const minimumHeight = Math.min(MIN_CROP_SIZE, pageHeight);
  let previousEnd: number | null = null;
  let firstHeight: number | null = null;
  for (const [index, slot] of candidate.slots.entries()) {
    const label = `第 ${index + 1} 栏`;
    if (!Number.isFinite(slot.top_pt)) return { layout: null, error: `${label}的距页顶必须是有效数字。` };
    if (!Number.isFinite(slot.height_pt)) return { layout: null, error: `${label}的回单高度必须是有效数字。` };
    if (slot.top_pt < 0) return { layout: null, error: `${label}的距页顶为 ${millimetres(slot.top_pt)} mm，超出页面上边约 ${millimetres(-slot.top_pt)} mm。请调整距页顶。` };
    if (slot.height_pt <= 0) return { layout: null, error: `${label}的回单高度必须大于 0。` };
    if (slot.height_pt < minimumHeight && !near(slot.height_pt, minimumHeight)) {
      return { layout: null, error: `${label}的回单高度不能小于 ${millimetres(minimumHeight)} mm。` };
    }
    const end = slot.top_pt + slot.height_pt;
    if (!Number.isFinite(end) || end <= slot.top_pt) return { layout: null, error: `${label}的回单高度超出可处理范围。` };
    if (end > pageHeight && !near(end, pageHeight)) {
      return { layout: null, error: `${label}距页顶 ${millimetres(slot.top_pt)} + 高度 ${millimetres(slot.height_pt)} = 底边 ${millimetres(end)} mm，超出页面高度 ${millimetres(pageHeight)} mm 约 ${millimetres(end - pageHeight)} mm。请调整距页顶或回单高度。` };
    }
    if (previousEnd !== null && previousEnd > slot.top_pt && !near(previousEnd, slot.top_pt)) {
      return { layout: null, error: `${label}距页顶 ${millimetres(slot.top_pt)} mm，上一栏底边 ${millimetres(previousEnd)} mm，两栏重叠约 ${millimetres(previousEnd - slot.top_pt)} mm。请调整距页顶或回单高度。` };
    }
    if (candidate.uniform_height) {
      if (firstHeight === null) firstHeight = slot.height_pt;
      else if (!near(firstHeight, slot.height_pt)) return { layout: null, error: '统一高度已开启，所有栏位的回单高度必须一致。' };
    }
    previousEnd = end;
  }
  try { return { layout: parseLayoutDefinition(candidate), error: null }; }
  catch (error) {
    return { layout: null, error: error instanceof ReceiptLayoutError && error.code === 'invalid_geometry'
      ? '页面尺寸无效，请检查页面宽度和页面高度。' : '版式数据无效，请检查栏位设置。' };
  }
}
