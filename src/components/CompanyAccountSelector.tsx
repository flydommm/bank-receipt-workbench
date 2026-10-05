import { useEffect, useMemo, useRef, useState } from 'react';
import { parseAccountSelection, type AccountInput, type AccountSelection, type CompanyAccount } from '../domain/receiptGrouping';
import {
  COMPANY_ACCOUNT_IMPORT_MAX_BYTES,
  CompanyAccountImportClient,
  companyAccountImportErrorMessage,
  type CompanyAccountImportPreview,
} from '../services/companyAccountImportClient';
import { ReceiptGroupingClient, groupingErrorMessage } from '../services/receiptGroupingClient';
import { companyAccountTemplateErrorMessage, saveCompanyAccountTemplate } from '../services/companyAccountTemplate';
import { CompanyAccountImportDialog } from './CompanyAccountImportDialog';
import './CompanyAccountSelector.css';

export type CompanyAccountSelectorProps = {
  value: AccountSelection | null; onChange: (value: AccountSelection | null) => void;
  onValidityChange?: (valid: boolean) => void; disabled?: boolean; client?: ReceiptGroupingClient;
  importClient?: CompanyAccountImportClient;
  saveTemplate?: typeof saveCompanyAccountTemplate;
  defaultMode?: 'saved' | 'inline';
};
const defaultClient = new ReceiptGroupingClient();
const defaultImportClient = new CompanyAccountImportClient();
const emptyAccount = (): AccountInput => ({ company_name: '', bank_name: '', branch_name: '', account_number: '' });
const inputOf = (account: AccountInput): AccountInput => ({ company_name: account.company_name, bank_name: account.bank_name, branch_name: account.branch_name, account_number: account.account_number });

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function CompanyAccountSelector({ value, onChange, onValidityChange, disabled = false, client = defaultClient, importClient = defaultImportClient, saveTemplate = saveCompanyAccountTemplate, defaultMode }: CompanyAccountSelectorProps) {
  const [accounts, setAccounts] = useState<CompanyAccount[]>([]);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [importBusy, setImportBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0), [savedMode, setSavedMode] = useState(defaultMode === 'saved' || value?.kind === 'saved');
  const [company, setCompany] = useState(''), [bank, setBank] = useState('');
  const [editing, setEditing] = useState<CompanyAccount | null>(null);
  const operation = useRef<AbortController | null>(null);
  const importOperation = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const importFileButton = useRef<HTMLButtonElement | null>(null);
  const savedModeButton = useRef<HTMLButtonElement | null>(null);
  const focusSavedMode = useRef(false);
  const [importFileName, setImportFileName] = useState('');
  const [importPreview, setImportPreview] = useState<CompanyAccountImportPreview | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importStage, setImportStage] = useState<'preview' | 'commit' | null>(null);
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateStatus, setTemplateStatus] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const templateOperation = useRef(false);
  useEffect(() => {
    if (focusSavedMode.current && value !== null && savedMode) {
      focusSavedMode.current = false;
      savedModeButton.current?.focus();
    }
  }, [value, savedMode]);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(null);
    void client.loadAccounts(false, abort.signal).then((items) => { if (!abort.signal.aborted) setAccounts(items); })
      .catch((cause: unknown) => { if (!abort.signal.aborted) setError(groupingErrorMessage(cause)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [client, refresh]);
  useEffect(() => () => { operation.current?.abort(); importOperation.current?.abort(); }, []);
  const selected = value?.kind === 'saved' ? accounts.find((item) => item.account_id === value.account_id) : undefined;
  useEffect(() => { if (selected) { setCompany(selected.company_name); setBank(selected.bank_name); setSavedMode(true); } }, [selected]);
  const valid = useMemo(() => {
    if (value === null) return true;
    try {
      parseAccountSelection(value);
      return value.kind === 'inline' || Boolean(!loading && selected?.active && selected.account_revision === value.account_revision);
    } catch { return false; }
  }, [value, selected, loading]);
  useEffect(() => { onValidityChange?.(valid && !saving && !importBusy); }, [valid, saving, importBusy, onValidityChange]);
  const draft = value?.kind === 'inline' ? value.account : selected ? inputOf(selected) : emptyAccount();
  const active = accounts.filter((item) => item.active);
  const companies = [...new Set(active.map((item) => item.company_name))];
  const banks = [...new Set(active.filter((item) => item.company_name === company).map((item) => item.bank_name))];
  const choices = active.filter((item) => item.company_name === company && item.bank_name === bank);
  const busy = disabled || saving || importBusy;
  const downloadTemplate = async () => {
    if (busy || templateOperation.current) return;
    templateOperation.current = true;
    setTemplateSaving(true);
    setTemplateStatus(null);
    setTemplateError(null);
    try {
      const result = await saveTemplate();
      if (result.status === 'saved') setTemplateStatus(`模板已保存：${result.fileName}`);
      else if (result.status === 'download_requested') setTemplateStatus('已请求下载模板，请查看浏览器下载列表。');
    } catch (cause) {
      setTemplateError(companyAccountTemplateErrorMessage(cause));
    } finally {
      templateOperation.current = false;
      setTemplateSaving(false);
    }
  };
  const changeField = (key: keyof AccountInput, text: string) => onChange({ kind: 'inline', account: { ...draft, [key]: text } });
  const clearSelection = () => { setEditing(null); onChange({ kind: 'inline', account: emptyAccount() }); };
  const cancelImport = () => {
    if (importStage === 'commit') return;
    importOperation.current?.abort();
    importOperation.current = null;
    setImportBusy(false);
    setImportStage(null);
    setImportPreview(null);
    setImportFileName('');
    setImportError(null);
    setImportStatus(null);
    if (fileInput.current) fileInput.current.value = '';
  };
  const previewImport = async (file: File) => {
    if (busy) return;
    setImportError(null);
    setImportStatus(null);
    setImportPreview(null);
    setImportFileName(file.name);
    if (file.size > COMPANY_ACCOUNT_IMPORT_MAX_BYTES) {
      setImportError('导入文件超过 512 KiB，请使用模板重新整理后重试。');
      return;
    }
    importOperation.current?.abort();
    const abort = new AbortController();
    importOperation.current = abort;
    setImportBusy(true);
    setImportStage('preview');
    try {
      const encoded = await fileBase64(file);
      if (abort.signal.aborted || importOperation.current !== abort) return;
      const preview = await importClient.preview(encoded, abort.signal);
      if (abort.signal.aborted || importOperation.current !== abort) return;
      setImportPreview(preview);
    } catch (cause) {
      if (!abort.signal.aborted && importOperation.current === abort) setImportError(companyAccountImportErrorMessage(cause));
    } finally {
      if (importOperation.current === abort) {
        importOperation.current = null;
        setImportBusy(false);
        setImportStage(null);
      }
    }
  };
  const commitImport = async () => {
    if (busy || !importPreview) return;
    const accountsToImport = importPreview.rows.filter((row) => row.status === 'ready' && row.account !== null).map((row) => row.account!);
    if (accountsToImport.length === 0) return;
    importOperation.current?.abort();
    const abort = new AbortController();
    importOperation.current = abort;
    setImportBusy(true);
    setImportStage('commit');
    setImportError(null);
    setImportStatus(null);
    try {
      const result = await importClient.commit(accountsToImport, abort.signal);
      if (abort.signal.aborted || importOperation.current !== abort) return;
      setImportPreview(null);
      setImportFileName('');
      // Only ready rows are submitted, so commit-time duplicates do not overlap
      // with the rows already skipped by the preview.
      const skipped = importPreview.counts.duplicate + result.skipped;
      const errors = importPreview.counts.error;
      setImportStatus(`已新增 ${result.created} 条账户档案，跳过 ${skipped} 条重复档案。${errors > 0 ? `另有 ${errors} 条错误记录未导入，请修正后重新导入。` : ''}`);
      setRefresh((current) => current + 1);
      if (fileInput.current) fileInput.current.value = '';
    } catch (cause) {
      if (!abort.signal.aborted && importOperation.current === abort) setImportError(companyAccountImportErrorMessage(cause));
    } finally {
      if (importOperation.current === abort) {
        importOperation.current = null;
        setImportBusy(false);
        setImportStage(null);
      }
    }
  };
  const save = async (deactivate = false) => {
    if (busy || (deactivate && !selected)) return;
    const previous = deactivate ? selected! : editing;
    const account = deactivate ? inputOf(selected!) : draft;
    const abort = new AbortController(); operation.current = abort; setSaving(true); setError(null);
    try {
      const saved = await client.saveAccount(account, previous, !deactivate, abort.signal);
      if (abort.signal.aborted) return;
      setAccounts((items) => [...items.filter((item) => item.account_id !== saved.account_id), saved]);
      setEditing(null);
      if (deactivate) { setSavedMode(false); onChange({ kind: 'inline', account: inputOf(saved) }); }
      else { setSavedMode(true); setCompany(saved.company_name); setBank(saved.bank_name); onChange({ kind: 'saved', account_id: saved.account_id, account_revision: saved.account_revision }); }
    } catch (cause) { if (!abort.signal.aborted) setError(groupingErrorMessage(cause)); }
    finally { if (!abort.signal.aborted) { setSaving(false); operation.current = null; } }
  };
  return <section className="company-account-selector" aria-label="本方账户与交易对手整理">
    <label><input type="checkbox" checked={value !== null} disabled={busy} onChange={(event) => {
      setEditing(null); setError(null); if (!event.target.checked) cancelImport(); setSavedMode(event.target.checked); focusSavedMode.current = event.target.checked;
      onChange(event.target.checked ? { kind: 'inline', account: emptyAccount() } : null);
    }} />启用按交易对手整理</label>
    {value !== null && <>
      <p className="company-account-selector__hint">选择来源银行和完整账号，用于识别交易对手。更换文件后，请重新选择本批账户。</p>
      <div className="company-account-selector__mode" role="group" aria-label="本方账户填写方式">
        <button ref={savedModeButton} type="button" aria-pressed={savedMode} disabled={busy} onClick={() => { setSavedMode(true); clearSelection(); }}>选择本机档案</button>
        <button type="button" aria-pressed={!savedMode} disabled={busy} onClick={() => { cancelImport(); setSavedMode(false); setEditing(null); onChange({ kind: 'inline', account: inputOf(draft) }); }}>仅填写本批资料</button>
      </div>
      {savedMode ? <div className="company-account-selector__saved">
        {loading && <p role="status">正在载入本机账户…</p>}
        <label>公司<select aria-label="档案公司" title={company || undefined} value={company} disabled={busy || loading} onChange={(event) => { setCompany(event.target.value); setBank(''); clearSelection(); }}>
          <option value="">请选择公司</option>{companies.map((name) => <option key={name} value={name}>{name}</option>)}
        </select></label>
        <label>来源银行<select aria-label="档案来源银行" title={bank || undefined} value={bank} disabled={busy || loading || !company} onChange={(event) => { setBank(event.target.value); clearSelection(); }}>
          <option value="">请选择来源银行</option>{banks.map((name) => <option key={name} value={name}>{name}</option>)}
        </select></label>
        <label className="company-account-selector__wide">本方账号<select aria-label="档案本方账号" title={selected ? `${selected.account_number}${selected.branch_name ? ` · ${selected.branch_name}` : ''}` : undefined} value={value.kind === 'saved' ? value.account_id : ''} disabled={busy || loading || !bank} onChange={(event) => {
          const account = accounts.find((item) => item.account_id === event.target.value);
          if (account) onChange({ kind: 'saved', account_id: account.account_id, account_revision: account.account_revision }); else clearSelection();
        }}><option value="">请选择完整账号</option>{choices.map((item) => <option key={item.account_id} value={item.account_id}>{item.account_number}{item.branch_name ? ` · ${item.branch_name}` : ''}</option>)}</select></label>
        {!loading && active.length === 0 && <p>尚无启用中的账户档案，可以填写本批资料后保存。</p>}
        {selected && <div className="company-account-selector__management">
          {selected.branch_name && <p className="company-account-selector__branch">开户行：{selected.branch_name}</p>}
          <div className="company-account-selector__actions">
            <button type="button" disabled={busy} onClick={() => { setEditing(selected); setSavedMode(false); onChange({ kind: 'inline', account: inputOf(selected) }); }}>编辑选中档案</button>
            <button type="button" disabled={busy} onClick={() => void save(true)}>停用选中档案</button>
          </div>
          <p>停用仅影响后续选择，已开始的任务保留原资料。</p>
        </div>}
        <div className="company-account-selector__import" aria-label="批量导入本方账户档案">
          <div className="company-account-selector__import-heading">
            <h3>批量导入账户档案</h3>
            <button className="company-account-selector__template" type="button" disabled={busy || templateSaving} onClick={() => void downloadTemplate()}>{templateSaving ? '正在保存模板…' : '下载导入模板'}</button>
          </div>
          {templateStatus && <p role="status">{templateStatus}</p>}
          {templateError && <p role="alert">{templateError}</p>}
          <p>按模板填写后导入，仅新增档案，不覆盖已有资料。</p>
          <input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden disabled={busy}
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void previewImport(file); }} />
          <button ref={importFileButton} type="button" disabled={busy} onClick={() => fileInput.current?.click()}>{importFileName ? '重新选择 Excel 文件' : '选择 Excel 文件'}</button>
          {importStage === 'preview' && <><p role="status">正在校验导入文件…</p><button type="button" disabled={disabled || saving} onClick={cancelImport}>取消导入</button></>}
          {importPreview && <CompanyAccountImportDialog preview={importPreview} fileName={importFileName || '已选择文件'}
            saving={importStage === 'commit'} disabled={disabled || saving} error={importError} returnFocusRef={importFileButton}
            onConfirm={() => void commitImport()} onCancel={cancelImport} />}
          {importStatus && !importPreview && <p role="status" className="company-account-selector__import-success">{importStatus}</p>}
          {importError && !importPreview && <p role="alert">{importError}</p>}
        </div>
      </div> : <fieldset disabled={busy}>
        <legend>{editing ? '编辑本机账户档案' : '本批本方资料'}</legend>
        <label className="company-account-selector__wide">公司全名<input aria-label="公司全名" maxLength={256} value={draft.company_name} onChange={(e) => changeField('company_name', e.target.value)} /></label>
        <label>来源银行<input aria-label="来源银行" maxLength={256} value={draft.bank_name} placeholder="例如：中国工商银行" onChange={(e) => changeField('bank_name', e.target.value)} /></label>
        <label>开户行（可选）<input aria-label="本方开户行" maxLength={256} value={draft.branch_name} onChange={(e) => changeField('branch_name', e.target.value)} /></label>
        <label className="company-account-selector__wide">完整本方账号<input aria-label="完整本方账号" type="text" inputMode="numeric" autoComplete="off" maxLength={128} value={draft.account_number} onChange={(e) => changeField('account_number', e.target.value)} /></label>
        <p>保留账号前导零；不要只填尾号或遮挡后的账号。资料只在本机处理。</p>
        <button type="button" disabled={!valid || busy} onClick={() => void save(false)}>{saving ? '正在保存…' : editing ? '保存档案修改' : '保存为本机账户档案'}</button>
      </fieldset>}
      {!valid && !loading && <p role="status">请完整填写本方资料，或重新选择有效的账户档案。</p>}
      {error && <div role="alert">{error}<button type="button" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>重新载入账户</button></div>}
    </>}
  </section>;
}
