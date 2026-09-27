import './ThumbnailSizeControl.css';

export const THUMBNAIL_SIZE_MIN = 160;
export const THUMBNAIL_SIZE_MAX = 360;
export const THUMBNAIL_SIZE_STEP = 20;
export const THUMBNAIL_SIZE_DEFAULT = 240;

export type ThumbnailSizeControlProps = {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  label?: string;
};

function bounded(value: number): number {
  if (!Number.isFinite(value)) return THUMBNAIL_SIZE_DEFAULT;
  return Math.min(THUMBNAIL_SIZE_MAX, Math.max(THUMBNAIL_SIZE_MIN, value));
}

export function ThumbnailSizeControl({ value, onChange, disabled = false, label = '缩略图大小' }: ThumbnailSizeControlProps) {
  const size = bounded(value);
  return (
    <div className="thumbnail-size-control" role="group" aria-label={label}>
      <button type="button" aria-label="缩小缩略图" disabled={disabled || size <= THUMBNAIL_SIZE_MIN}
        onClick={() => onChange(Math.max(THUMBNAIL_SIZE_MIN, size - THUMBNAIL_SIZE_STEP))}>−</button>
      <span>{Math.round(size / THUMBNAIL_SIZE_DEFAULT * 100)}%</span>
      <button type="button" aria-label="放大缩略图" disabled={disabled || size >= THUMBNAIL_SIZE_MAX}
        onClick={() => onChange(Math.min(THUMBNAIL_SIZE_MAX, size + THUMBNAIL_SIZE_STEP))}>＋</button>
    </div>
  );
}

export default ThumbnailSizeControl;
