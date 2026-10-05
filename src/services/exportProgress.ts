import { Channel } from '@tauri-apps/api/core';

export type ExportProgressStage = 'validating' | 'rendering' | 'writing_pdf' | 'saving' | 'indexing' | 'verifying' | 'finalizing';
export type ExportProgress = {
  stage: ExportProgressStage;
  completed: number | null;
  total: number | null;
  unit: 'pages' | 'files' | null;
};
const STAGES = new Set<ExportProgressStage>(['validating', 'rendering', 'writing_pdf', 'saving', 'indexing', 'verifying', 'finalizing']);

/** Progress is advisory. Malformed frames must never fail or complete an export. */
export function parseExportProgress(value: unknown): ExportProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.type !== 'export_progress' || !STAGES.has(row.stage as ExportProgressStage)) return null;
  const { completed, total, unit } = row;
  if (completed === null && total === null && unit === null) {
    return { stage: row.stage as ExportProgressStage, completed, total, unit };
  }
  if (typeof completed !== 'number' || !Number.isSafeInteger(completed) || completed < 0
      || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 1 || total > 100_000
      || completed > total || (unit !== 'pages' && unit !== 'files')) return null;
  return { stage: row.stage as ExportProgressStage, completed, total, unit };
}

export function exportProgressChannel(onProgress: (progress: ExportProgress) => void) {
  let active = true;
  const channel = new Channel<unknown>((payload) => {
    if (!active) return;
    const progress = parseExportProgress(payload);
    if (progress) onProgress(progress);
  });
  return { channel, close: () => { active = false; channel.onmessage = () => undefined; } };
}
