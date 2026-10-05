import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import type { AccountInput } from '../domain/receiptGrouping';
import type {
  CompanyAccountImportPreview,
  CompanyAccountImportRow,
} from '../services/companyAccountImportClient';
import './CompanyAccountImportDialog.css';

export type CompanyAccountImportDialogProps = {
  preview: CompanyAccountImportPreview;
  fileName: string;
  saving: boolean;
  disabled?: boolean;
  error: string | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
};

type ImportFilter = 'all' | CompanyAccountImportRow['status'];

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const FILTER_LABELS: Record<ImportFilter, string> = {
  all: '全部',
  ready: '可导入',
  duplicate: '重复',
  error: '错误',
};

const STATUS_LABELS: Record<CompanyAccountImportRow['status'], string> = {
  ready: '可导入',
  duplicate: '重复',
  error: '错误',
};

const FIELD_LABELS: Array<{ key: keyof AccountInput; label: string }> = [
  { key: 'company_name', label: '公司全名' },
  { key: 'bank_name', label: '来源银行' },
  { key: 'branch_name', label: '开户行' },
  { key: 'account_number', label: '完整本方账号' },
];

type InertSnapshot = {
  element: HTMLElement;
  hadAttribute: boolean;
  previousProperty: boolean;
};

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
}

function setElementInert(element: HTMLElement, inert: boolean): void {
  const withInert = element as HTMLElement & { inert?: boolean };
  withInert.inert = inert;
  if (inert) element.setAttribute('inert', '');
  else element.removeAttribute('inert');
}

function textValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return '未填写';
  return value;
}

function displayFields(row: CompanyAccountImportRow): Record<keyof AccountInput, string> {
  const account = row.account ?? row.source;
  return {
    company_name: textValue(account?.company_name),
    bank_name: textValue(account?.bank_name),
    branch_name: textValue(account?.branch_name),
    account_number: textValue(account?.account_number),
  };
}

function rowExplanation(row: CompanyAccountImportRow): string {
  const message = row.message.trim();
  if (row.status === 'ready') return message ? `将新增账户档案；${message}` : '将新增账户档案。';
  if (row.status === 'duplicate') return message ? `将跳过；${message}` : '将跳过，账户档案已存在。';
  return message ? `不导入；${message}` : '不导入，填写内容无效。';
}

function countsFor(preview: CompanyAccountImportPreview): Record<ImportFilter, number> {
  return {
    all: preview.rows.length,
    ready: preview.counts.ready,
    duplicate: preview.counts.duplicate,
    error: preview.counts.error,
  };
}

export function CompanyAccountImportDialog({
  preview,
  fileName,
  saving,
  disabled = false,
  error,
  returnFocusRef,
  onConfirm,
  onCancel,
}: CompanyAccountImportDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null && typeof document !== 'undefined') {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) openerRef.current = active;
  }

  const [filter, setFilter] = useState<ImportFilter>('all');
  const callbacksRef = useRef({ onConfirm, onCancel });
  const savingRef = useRef(saving);
  const disabledRef = useRef(disabled);
  callbacksRef.current = { onConfirm, onCancel };
  savingRef.current = saving;
  disabledRef.current = disabled;

  const counts = countsFor(preview);
  const visibleRows = filter === 'all'
    ? preview.rows
    : preview.rows.filter((row) => row.status === filter);
  const canConfirm = !saving && !disabled && preview.counts.ready > 0;

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
    if (activeIndex < 0) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && activeIndex === 0) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
      event.preventDefault();
      first.focus();
    }
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    const backdrop = dialog?.parentElement;
    if (!dialog || !backdrop) return undefined;

    const inertSnapshots: InertSnapshot[] = [];
    const inertTargets = new Set<HTMLElement>();
    const addSiblings = (element: Element | null): void => {
      const parent = element?.parentElement;
      if (!parent) return;
      for (const child of Array.from(parent.children)) {
        if (child === element || !(child instanceof HTMLElement)) continue;
        inertTargets.add(child);
      }
    };

    // The portal is a direct child of body, so lock every pre-existing body
    // child while preserving any inert state that was already present.
    addSiblings(backdrop);
    for (const element of inertTargets) {
      inertSnapshots.push({
        element,
        hadAttribute: element.hasAttribute('inert'),
        previousProperty: Boolean((element as HTMLElement & { inert?: boolean }).inert),
      });
      setElementInert(element, true);
    }

    (titleRef.current ?? cancelRef.current ?? dialog).focus();

    return () => {
      for (const snapshot of inertSnapshots) {
        const withInert = snapshot.element as HTMLElement & { inert?: boolean };
        withInert.inert = snapshot.previousProperty;
        if (snapshot.hadAttribute) snapshot.element.setAttribute('inert', '');
        else snapshot.element.removeAttribute('inert');
      }
      const opener = returnFocusRef?.current ?? openerRef.current;
      if (opener && opener.isConnected) opener.focus();
    };
  }, [returnFocusRef]);

  useEffect(() => {
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (savingRef.current || disabledRef.current) return;
      callbacksRef.current.onCancel();
    };
    document.addEventListener('keydown', handleDocumentKeyDown, true);
    return () => document.removeEventListener('keydown', handleDocumentKeyDown, true);
  }, []);

  if (typeof document === 'undefined') return null;

  const dialog = (
    <div className="company-account-import-dialog-backdrop">
      <div
        ref={dialogRef}
        className="company-account-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="company-account-import-dialog-title"
        aria-busy={saving || undefined}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="company-account-import-dialog__header">
          <div>
            <h2
              ref={titleRef}
              id="company-account-import-dialog-title"
              tabIndex={-1}
            >
              导入账户档案 · 核对预览
            </h2>
            <p className="company-account-import-dialog__file">文件：{textValue(fileName)}</p>
          </div>
          {saving && <p className="company-account-import-dialog__saving" role="status" aria-live="polite">正在保存账户档案…</p>}
        </header>

        <section className="company-account-import-dialog__summary" aria-label="导入数量">
          <div className="company-account-import-dialog__summary-heading">
            <strong>共 {counts.all} 条记录</strong>
            <span>有效档案将新增，重复跳过，错误行不导入。筛选不改变导入数量。</span>
          </div>
          <dl>
            {(['ready', 'duplicate', 'error'] as const).map((status) => (
              <div key={status} data-status={status}>
                <dt>{FILTER_LABELS[status]}</dt>
                <dd>{counts[status]}</dd>
              </div>
            ))}
          </dl>
        </section>

        <div className="company-account-import-dialog__filters" role="group" aria-label="导入状态筛选">
          {(Object.keys(FILTER_LABELS) as ImportFilter[]).map((status) => (
            <button
              key={status}
              type="button"
              className={filter === status ? 'is-active' : undefined}
              aria-pressed={filter === status}
              aria-label={`${FILTER_LABELS[status]}，${counts[status]}条`}
              onClick={() => setFilter(status)}
            >
              <span>{FILTER_LABELS[status]}</span>
              <strong>{counts[status]}</strong>
            </button>
          ))}
        </div>

        {error && <p className="company-account-import-dialog__error" role="alert">{error}</p>}

        <div className="company-account-import-dialog__table-scroll" role="region" aria-label="可滚动的账户明细" tabIndex={0}>
          <table className="company-account-import-dialog__table" aria-label="账户导入核对明细">
            <colgroup>
              <col className="company-account-import-dialog__col-row" />
              <col className="company-account-import-dialog__col-company" />
              <col className="company-account-import-dialog__col-bank" />
              <col className="company-account-import-dialog__col-branch" />
              <col className="company-account-import-dialog__col-account" />
              <col className="company-account-import-dialog__col-status" />
              <col className="company-account-import-dialog__col-message" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Excel 行号</th>
                <th scope="col">公司全名</th>
                <th scope="col">来源银行</th>
                <th scope="col">开户行</th>
                <th scope="col">完整本方账号</th>
                <th scope="col">状态</th>
                <th scope="col">说明</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const fields = displayFields(row);
                return (
                  <tr key={row.row_number} data-status={row.status}>
                    <th scope="row" aria-label={`Excel 第 ${row.row_number} 行`}>第 {row.row_number} 行</th>
                    {FIELD_LABELS.map(({ key, label }) => (
                      <td key={key} data-label={label} className={key === 'account_number' ? 'is-account-number' : undefined}>
                        {fields[key]}
                      </td>
                    ))}
                    <td>
                      <span className={`company-account-import-dialog__status company-account-import-dialog__status--${row.status}`}>
                        {STATUS_LABELS[row.status]}
                      </span>
                    </td>
                    <td>{rowExplanation(row)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visibleRows.length === 0 && <p className="company-account-import-dialog__empty" role="status">当前筛选没有记录。</p>}
        </div>

        <footer className="company-account-import-dialog__actions">
          {!saving && (
            <button
              ref={cancelRef}
              type="button"
              disabled={disabled}
              onClick={() => { if (!disabled) callbacksRef.current.onCancel(); }}
            >
              取消导入
            </button>
          )}
          <button
            type="button"
            className="company-account-import-dialog__confirm"
            disabled={!canConfirm}
            onClick={() => { if (canConfirm) callbacksRef.current.onConfirm(); }}
          >
            {saving ? '正在保存账户档案…' : `导入有效${preview.counts.ready}条档案`}
          </button>
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}

export default CompanyAccountImportDialog;
