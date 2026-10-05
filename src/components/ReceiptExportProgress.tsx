import type { ExportProgress, ExportProgressStage } from '../services/exportProgress';

const STAGE_LABELS: Record<ExportProgressStage, string> = {
  validating: '正在核对导出范围与原始 PDF',
  rendering: '正在生成 PDF 页面',
  writing_pdf: '正在写入 PDF 文件',
  saving: '正在保存导出文件',
  indexing: '正在生成核对表与清单',
  verifying: '正在校验导出文件',
  finalizing: '正在核对本阶段结果',
};

export function formatExportElapsed(seconds: number): string {
  const elapsed = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(elapsed / 3600), minutes = Math.floor(elapsed % 3600 / 60), rest = elapsed % 60;
  return hours ? `${hours} 小时 ${minutes} 分 ${rest} 秒` : minutes ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
}

export function ReceiptExportProgress({ progress, elapsed, waitingForDirectory }: {
  progress: ExportProgress | null; elapsed: number; waitingForDirectory: boolean;
}) {
  const determinate = progress?.completed !== null && progress?.total != null;
  const percent = determinate ? Math.floor(progress!.completed! / progress!.total! * 100) : undefined;
  const label = waitingForDirectory ? '等待选择导出目录' : progress ? STAGE_LABELS[progress.stage] : '正在准备导出';
  return <div className="receipt-export-progress" role="region" aria-label="导出进度">
    <div className="receipt-export-progress__summary"><strong>{label}</strong><span>已用时 {formatExportElapsed(elapsed)}</span></div>
    <progress aria-label={label} max={100} value={percent} />
    <p role="status">{determinate
      ? `当前阶段：已完成 ${progress!.completed} / ${progress!.total} ${progress!.unit === 'pages' ? '页' : '个文件'}（${percent}%）`
      : waitingForDirectory ? '选定目录后开始生成。' : '此阶段暂无法计算百分比，请保持窗口打开。'}</p>
    {!waitingForDirectory && <p className="receipt-export-progress__hint">大批量回单可能需要数分钟；页面生成后还会写入和校验文件。</p>}
  </div>;
}
