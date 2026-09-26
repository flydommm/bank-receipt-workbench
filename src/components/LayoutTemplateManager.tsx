import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutTemplateClient, layoutTemplateBankName, layoutTemplateName, type LayoutTemplate, type LayoutTemplatePage } from '../services/layoutTemplateClient';
import './LayoutTemplateManager.css';

export type LayoutTemplateManagerProps = {
  client?: LayoutTemplateClient;
  onClose: () => void;
  onSelect: (template: LayoutTemplate) => void;
  selectedTemplateId: string | null;
  candidateTemplateIds?: string[];
  disabled?: boolean;
  onChanged?: (template: LayoutTemplate, action: 'rename' | 'deactivate') => void;
  usage?: 'new_analysis' | 'current_review';
};

const PAGE_SIZE = 10;
const millimetres = (points: number) => (points * 25.4 / 72).toFixed(2);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '模板操作未完成，请重试。';
type NameDraft = { templateId: string | null; value: string };
function confirmedSlots(template: LayoutTemplate): Set<string> {
  const ids = template.evidence_summary.confirmed_slot_ids;
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
}
function confirmedSlotCount(template: LayoutTemplate): number {
  const confirmed = confirmedSlots(template);
  return template.slots.filter((slot) => confirmed.has(slot.slot_id)).length;
}

function templateIssuerId(template: LayoutTemplate): string | null {
  const definition = template.evidence_summary.layout_definition;
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return null;
  const issuerId = (definition as Record<string, unknown>).issuer_id;
  return typeof issuerId === 'string' && issuerId.trim() ? issuerId.trim() : null;
}

function templateBankLabel(template: LayoutTemplate): string | null {
  const bankName = template.bank_name;
  return typeof bankName === 'string' && bankName.trim() ? bankName.trim() : null;
}

type TemplateBankGroup = { key: string; bankName: string; templates: LayoutTemplate[] };
function groupTemplatesByIssuer(templates: LayoutTemplate[]): TemplateBankGroup[] {
  const groups = new Map<string, { bankName: string | null; templates: LayoutTemplate[] }>();
  for (const template of templates) {
    const issuerId = templateIssuerId(template);
    const seriesId = typeof template.series_id === 'string' && template.series_id.trim() ? template.series_id.trim() : template.id;
    const key = issuerId ? `issuer:${issuerId}` : `series:${seriesId}`;
    const group = groups.get(key);
    const bankName = templateBankLabel(template);
    if (group) {
      if (!group.bankName && bankName) group.bankName = bankName;
      group.templates.push(template);
    } else {
      groups.set(key, { bankName, templates: [template] });
    }
  }
  return Array.from(groups.entries()).map(([key, group]) => ({
    key,
    bankName: group.bankName ?? layoutTemplateBankName(group.templates[0]),
    templates: group.templates,
  }));
}

async function listAllTemplates(client: LayoutTemplateClient, activeOnly: boolean, signal: AbortSignal): Promise<LayoutTemplate[]> {
  const items: LayoutTemplate[] = [];
  let offset = 0;
  while (true) {
    const result = await client.list({ active_only: activeOnly, offset, limit: PAGE_SIZE }, signal);
    items.push(...result.items);
    if (result.next_offset === null) return items;
    offset = result.next_offset;
  }
}

export function LayoutTemplateManager({ client: providedClient, onClose, onSelect, selectedTemplateId,
  candidateTemplateIds, disabled = false, onChanged, usage = 'new_analysis' }: LayoutTemplateManagerProps) {
  const defaultClient = useMemo(() => new LayoutTemplateClient(), []);
  const client = providedClient ?? defaultClient;
  const [showInactive, setShowInactive] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<LayoutTemplatePage | null>(null);
  const [viewedId, setViewedId] = useState<string | null>(selectedTemplateId);
  const [nameDraft, setNameDraft] = useState<NameDraft>({ templateId: null, value: '' });
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lifecycle = useRef(0);
  const writeLock = useRef(false);
  const candidateTemplateIdsKey = candidateTemplateIds?.join('\u0000') ?? null;
  const candidateIdsForLookup = useMemo(
    () => candidateTemplateIds === undefined ? undefined : [...candidateTemplateIds],
    [candidateTemplateIdsKey],
  );

  useEffect(() => {
    lifecycle.current++;
    writeLock.current = false; setWriting(false);
    return () => { lifecycle.current++; };
  }, [client]);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError(null); setPage(null);
    setNameDraft({ templateId: null, value: '' });
    const loadPage = async (): Promise<LayoutTemplatePage> => {
      if (candidateIdsForLookup === undefined) {
        return client.list({ active_only: !showInactive, offset, limit: PAGE_SIZE }, abort.signal);
      }
      const allItems = candidateIdsForLookup.length > 0
        ? await listAllTemplates(client, !showInactive, abort.signal)
        : [];
      const candidateIds = new Set(candidateIdsForLookup);
      const candidates = allItems.filter((item) => candidateIds.has(item.id));
      const items = candidates.slice(offset, offset + PAGE_SIZE);
      return {
        items,
        total: candidates.length,
        next_offset: offset + items.length < candidates.length ? offset + items.length : null,
      };
    };
    void loadPage().then((result) => {
      if (abort.signal.aborted) return;
      if (offset > 0 && offset >= result.total) {
        setOffset(result.total > 0 ? Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE : 0);
        return;
      }
      const nextViewedId = result.items.some((item) => item.id === viewedId) ? viewedId : result.items[0]?.id ?? null;
      const nextViewed = result.items.find((item) => item.id === nextViewedId) ?? null;
      setPage(result);
      setViewedId(nextViewedId);
      setNameDraft({ templateId: nextViewed?.id ?? null, value: nextViewed ? layoutTemplateName(nextViewed) : '' });
      setLoading(false);
    }).catch((failure: unknown) => {
      if (!abort.signal.aborted) { setError(errorMessage(failure)); setLoading(false); }
    });
    return () => abort.abort();
  }, [candidateIdsForLookup, client, showInactive, offset, refresh]);

  const viewed = page?.items.find((item) => item.id === viewedId) ?? null;
  const confirmed = viewed ? confirmedSlots(viewed) : new Set<string>();
  const name = viewed && nameDraft.templateId === viewed.id ? nameDraft.value : viewed ? layoutTemplateName(viewed) : '';
  const locked = disabled || loading || writing;
  const nameValid = name.trim().length > 0 && name.trim().length <= 256 && !name.includes('\0');
  const bankGroups = page ? groupTemplatesByIssuer(page.items) : [];

  async function changeTemplate(action: 'rename' | 'deactivate') {
    if (!viewed || locked || writeLock.current || (action === 'rename' && !nameValid)) return;
    const token = lifecycle.current;
    const requestedName = name.trim();
    writeLock.current = true; setWriting(true); setError(null); setNotice(null);
    try {
      let changed: LayoutTemplate;
      if (action === 'rename') changed = await client.rename(viewed.id, requestedName);
      else { await client.deactivate(viewed.id); changed = { ...viewed, active: false }; }
      if (token !== lifecycle.current) return;
      setNameDraft({ templateId: changed.id, value: layoutTemplateName(changed) });
      setNotice(action === 'rename' ? '模板名称已更新。' : '此模板已停用，新任务不会再自动使用；正在进行的任务保持原模板。');
      onChanged?.(changed, action);
      setRefresh((value) => value + 1);
    } catch (failure) {
      if (token === lifecycle.current) setError(errorMessage(failure));
    } finally {
      if (token === lifecycle.current) { writeLock.current = false; setWriting(false); }
    }
  }

  return <section className="layout-template-manager panel" aria-label="版式模板管理" aria-busy={loading || writing}>
    <header className="layout-template-manager__header">
      <div><h2>版式模板</h2><p>{usage === 'current_review'
        ? '选择已有模板，先预览当前任务所有兼容来源中可应用的栏位；保存后仍需逐项复核。'
        : '保存已核对的框位置，供匹配模板的新文件分析时参考。'}</p></div>
      <button type="button" onClick={onClose} disabled={writing || disabled}>{usage === 'current_review' ? '返回审核' : '返回分析'}</button>
    </header>
    <div className="layout-template-manager__toolbar">
      <label><input type="checkbox" checked={showInactive} disabled={writing || disabled}
        onChange={(event) => { setOffset(0); setShowInactive(event.currentTarget.checked); setNotice(null); }} /> 显示已停用模板</label>
      <button type="button" disabled={locked} onClick={() => setRefresh((value) => value + 1)}>刷新列表</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">正在载入模板…</p>}
    {!loading && page?.items.length === 0 && <div className="layout-template-manager__empty">
      <h3>{showInactive ? '还没有版式模板' : '暂无可用版式模板'}</h3>
      <p>分析 PDF 后，打开“调整所选边界”，核对本轮结果，再勾选“保存为版式模板”。</p>
    </div>}
    {page && page.items.length > 0 && <div className="layout-template-manager__body">
      <nav className="layout-template-manager__list" aria-label="模板列表">
        {bankGroups.map(({ key, bankName, templates }) => <section className="layout-template-manager__bank-group" key={key}
          aria-label={`银行：${bankName}`}>
          <h3>{bankName}</h3>
          {templates.map((template) => <button type="button" key={template.id} disabled={writing || disabled}
            aria-pressed={template.id === viewedId} onClick={() => {
              setViewedId(template.id);
              setNameDraft({ templateId: template.id, value: layoutTemplateName(template) });
              setError(null);
            }}>
            <strong>{layoutTemplateName(template)}</strong>
            <span>{template.slots.length} 栏 · 版本 {template.version} · {template.active ? '可用' : '已停用'}</span>
            <small>已核对 {confirmedSlotCount(template)} / {template.slots.length} 栏</small>
            {template.id === selectedTemplateId && <small>{usage === 'current_review' ? '当前预览模板' : '已选用于新分析'}</small>}
          </button>)}
        </section>)}
        <div className="layout-template-manager__pagination" aria-label="模板分页">
          <button type="button" disabled={locked || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</button>
          <span>{offset + 1}–{offset + page.items.length} / {page.total}</span>
          <button type="button" disabled={locked || page.next_offset === null} onClick={() => { if (page.next_offset !== null) setOffset(page.next_offset); }}>下一页</button>
        </div>
      </nav>
      {viewed && <article className="layout-template-manager__detail" aria-label="模板详情">
        <div className="layout-template-manager__drawing">
          <svg role="img" aria-label={`${layoutTemplateName(viewed)}框位示意`} viewBox={`0 0 ${viewed.page_geometry.width_pt} ${viewed.page_geometry.height_pt}`}>
            <rect className="layout-template-manager__paper" width={viewed.page_geometry.width_pt} height={viewed.page_geometry.height_pt} />
            {viewed.slots.map((slot) => <g key={slot.slot_id} className={confirmed.has(slot.slot_id) ? 'is-confirmed' : 'is-unconfirmed'}>
              <rect x={slot.rect.x0} y={slot.rect.y0} width={slot.rect.x1 - slot.rect.x0} height={slot.rect.y1 - slot.rect.y0} />
              <text x={(slot.rect.x0 + slot.rect.x1) / 2} y={(slot.rect.y0 + slot.rect.y1) / 2} textAnchor="middle" dominantBaseline="middle">第 {slot.position_index} 栏 · {confirmed.has(slot.slot_id) ? '已核对' : '未核对'}</text>
            </g>)}
          </svg>
          <p>页面 {millimetres(viewed.page_geometry.width_pt)} × {millimetres(viewed.page_geometry.height_pt)} mm</p>
          <p>实线为已核对边界；虚线栏位仅示意，不作为已保存边界套用。</p>
        </div>
        <div className="layout-template-manager__properties">
          <h3>{layoutTemplateName(viewed)}</h3>
          <p>{viewed.active ? '可用于匹配的新文件' : '此模板已停用'} · 版本 {viewed.version}</p>
          {usage === 'new_analysis' && <><label>模板名称<input value={name} maxLength={256} disabled={locked}
            onChange={(event) => setNameDraft({ templateId: viewed.id, value: event.currentTarget.value })} /></label>
            {!nameValid && <p className="layout-template-manager__validation">请输入 1 至 256 个字符的名称。</p>}
            <button type="button" disabled={locked || !nameValid || name.trim() === layoutTemplateName(viewed)} onClick={() => void changeTemplate('rename')}>保存名称</button></>}
          <div className="layout-template-manager__table-scroll"><table><caption>框位参数（mm）</caption><thead><tr><th>栏位</th><th>状态</th><th>左边距</th><th>距页顶</th><th>宽度</th><th>高度</th></tr></thead>
            <tbody>{viewed.slots.map((slot) => <tr key={slot.slot_id}><th>第 {slot.position_index} 栏</th>
              <td>{confirmed.has(slot.slot_id) ? '已核对' : '未核对'}</td>
              <td>{millimetres(slot.rect.x0)}</td><td>{millimetres(slot.rect.y0)}</td>
              <td>{millimetres(slot.rect.x1 - slot.rect.x0)}</td><td>{millimetres(slot.rect.y1 - slot.rect.y0)}</td></tr>)}</tbody></table></div>
          <p>模板兼容性按版式身份、页面尺寸与方向、栏位对应关系匹配；银行名称仅用于列表展示。只沿用已核对位置。</p>
          {usage === 'current_review' ? <p>当前任务中的特殊单证和已有人工决定保持隔离。预览会列明可应用范围及跳过页面；确认保存只应用边界，普通片段仍需审核。</p>
            : <p>如需更新框位置，请在新文件微调时明确选择目标模板，核对后再保存；独立模板互不覆盖。</p>}
          <div className="layout-template-manager__actions">
            <button type="button" className="primary-button" disabled={locked || !viewed.active}
              onClick={() => { if (!writeLock.current && !locked && viewed.active) onSelect(viewed); }}>{usage === 'current_review' ? '预览应用到当前结果' : '选用此模板'}</button>
            {usage === 'new_analysis' && <button type="button" disabled={locked || !viewed.active} onClick={() => void changeTemplate('deactivate')}>停用此模板</button>}
          </div>
        </div>
      </article>}
    </div>}
  </section>;
}
