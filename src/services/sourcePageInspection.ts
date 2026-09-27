import { LocalEngineError, type EngineInspectedPage, type EnginePagesInspection } from '../components/localEngineAdapter';
import { normalizeSourcePath } from '../domain/sourcePreview';
import type { EngineProcessScheduler, EngineTaskPriority } from './engineProcessScheduler';

type Request = {
  path: string; sha256: string; page: number; pageCount: number; scope: string;
  includeCropTemplate?: boolean; priority: EngineTaskPriority; current: () => boolean;
};
type Entry = {
  request: Request; key: string; promise: Promise<EngineInspectedPage>;
  resolve: (page: EngineInspectedPage) => void; reject: (error: unknown) => void;
};
type Inspect = (path: string, pages: number[], sha256: string, includeCropTemplate: boolean) => Promise<EnginePagesInspection>;

/** Read-only, task-scoped metadata. Visible PDF images use their own foreground renderer. */
export class SourcePageInspection {
  private cache = new Map<string, EngineInspectedPage>();
  private pending = new Map<string, Entry>();
  private queue: Entry[] = [];
  private scheduled = false;
  private epoch = 0;

  constructor(private inspect: Inspect, private scheduler: EngineProcessScheduler,
    private stale: () => Error) {}

  clear(): void {
    this.epoch += 1;
    this.cache.clear();
    this.pending.clear();
  }

  get(request: Request): Promise<EngineInspectedPage> {
    if (!request.current()) return Promise.reject(this.stale());
    const base = JSON.stringify([request.scope, normalizeSourcePath(request.path), request.sha256.toLowerCase(), request.pageCount, request.page]);
    const key = `${base}:${Boolean(request.includeCropTemplate)}`;
    const cached = this.cache.get(key) ?? (!request.includeCropTemplate ? this.cache.get(`${base}:true`) : undefined);
    if (cached) return Promise.resolve(cached);
    const previous = this.pending.get(key);
    if (previous?.request.current()) return previous.promise;
    let resolve!: Entry['resolve'];
    let reject!: Entry['reject'];
    const promise = new Promise<EngineInspectedPage>((yes, no) => { resolve = yes; reject = no; });
    const entry = { request, key, promise, resolve, reject };
    this.pending.set(key, entry);
    this.queue.push(entry);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
    return promise;
  }

  private flush(): void {
    this.scheduled = false;
    const groups = new Map<string, Entry[]>();
    for (const entry of this.queue.splice(0)) {
      const request = entry.request;
      if (!request.current() || this.pending.get(entry.key) !== entry) {
        this.finish(entry, this.stale());
        continue;
      }
      const key = JSON.stringify([request.scope, normalizeSourcePath(request.path), request.sha256.toLowerCase(), request.pageCount,
        Boolean(request.includeCropTemplate), request.priority]);
      const group = groups.get(key) ?? [];
      group.push(entry); groups.set(key, group);
    }
    for (const entries of groups.values()) {
      for (let index = 0; index < entries.length; index += 32) void this.run(entries.slice(index, index + 32));
    }
  }

  private finish(entry: Entry, error: unknown, page?: EngineInspectedPage): void {
    if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key);
    if (page) entry.resolve(page); else entry.reject(error);
  }

  private async run(entries: Entry[]): Promise<void> {
    const epoch = this.epoch;
    const request = entries[0].request;
    const current = () => this.epoch === epoch && entries.some((entry) => entry.request.current());
    try {
      const result = await this.scheduler.run(() => this.inspect(request.path,
        entries.map((entry) => entry.request.page), request.sha256, Boolean(request.includeCropTemplate)), current, request.priority);
      if (result.page_count !== request.pageCount || result.source_sha256.toLowerCase() !== request.sha256.toLowerCase())
        throw new LocalEngineError('ENGINE_REQUEST_REJECTED', '来源 PDF 的页数或内容已变化，请重新分析。', { engineCode: 'source_changed' });
      // The adapter validates the exact requested set before any page reaches this cache.
      for (const entry of entries) {
        const page = result.pages.find((item) => item.page === entry.request.page);
        if (!current() || !entry.request.current()) this.finish(entry, this.stale());
        else if (!page || page.status !== 'ok') this.finish(entry, new Error(page?.message ?? '页面核验结果缺失。'));
        else {
          if (this.cache.size >= 2048) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(entry.key, page);
          this.finish(entry, undefined, page);
        }
      }
    } catch (error) {
      // In particular, never hide a late source_changed error behind a cancelled UI effect.
      for (const entry of entries) this.finish(entry, error);
    }
  }
}
