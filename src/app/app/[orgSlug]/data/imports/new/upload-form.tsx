'use client';

import Link from 'next/link';
import { startTransition, useActionState, useRef, useState } from 'react';
import { Field, Input, Select } from '@/components/ui/field';
import { FileDrop } from '@/components/ui/file-drop';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { startImportAction } from '../actions';
import { InvoiceReader } from './invoice-reader';

/** ADR-175: the types whose single-invoice photo, scan or PDF is read on this page. */
const INVOICE_SIDE: Readonly<Record<string, 'sales' | 'purchase'>> = { sales_invoices: 'sales', purchase_invoices: 'purchase' };
const isDocument = (f: File) => /\.(pdf|jpe?g|png)$/i.test(f.name) || /^(application\/pdf|image\/(jpeg|png))$/.test(f.type);

/**
 * The upload step (IMPORT_ENGINE.md §2, §5).
 *
 * One screen, four questions, and no jargon: what is this file, which months does it cover, and —
 * for a statement — which account. The type is asked rather than guessed, because a trial balance
 * read as a general ledger produces figures that look plausible and are wrong; a filename heuristic
 * may PROPOSE, and the person always decides (§2.6).
 */

/** The choices offered, and how each is described. Whether one needs a bank account is the server's
 *  answer (`IMPORT_TYPE_SPECS`), passed in by the page, so the two cannot drift again. */
export const IMPORT_TYPES: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: 'bank_statement', label: 'Bank statement', hint: 'A list of transactions from your bank' },
  { value: 'general_ledger', label: 'General ledger', hint: 'Every transaction, account by account, exported from your bookkeeping software' },
  { value: 'trial_balance', label: 'Trial balance', hint: 'The balance of every account, exported from your bookkeeping software' },
  { value: 'pnl_report', label: 'Profit and loss report', hint: 'Income and costs for the period, line by line' },
  { value: 'balance_sheet', label: 'Balance sheet', hint: 'What the business owns and owes at a date' },
  { value: 'sales_invoices', label: 'Sales invoices', hint: 'Invoices you sent to customers — a list, or one invoice as a photo or PDF' },
  { value: 'purchase_invoices', label: 'Purchase invoices', hint: 'Bills from your suppliers — a list, or one bill as a photo or PDF' },
  { value: 'sales_report', label: 'Sales report', hint: 'A sales report with one line per invoice' },
  { value: 'purchase_report', label: 'Purchase report', hint: 'A purchase report with one line per invoice' },
  { value: 'receipts', label: 'Receipts', hint: 'Receipts for things the business paid for' },
  { value: 'budget', label: 'Budget', hint: 'What you plan to earn and spend, by month and account' },
];

export function UploadForm({
  orgSlug,
  bankAccounts,
  bankAccountTypes,
  pdfReadTypes,
  aiReadTypes = [],
  orgName = '',
}: {
  orgSlug: string;
  /** The company's own name, so the invoice reader never proposes it as the customer or supplier. */
  orgName?: string;
  bankAccounts: ReadonlyArray<{ id: string; label: string }>;
  /** The import types that belong to a bank account. */
  bankAccountTypes: readonly string[];
  /** The import types whose PDF figures MOTION reads. */
  pdfReadTypes: readonly string[];
  /** ADR-150: the import types whose PDFs and photos MOTION reads with AI when asked (receipts). */
  aiReadTypes?: readonly string[];
}) {
  const [state, action, pending] = useActionState(startImportAction, null);
  const [importType, setImportType] = useState('bank_statement');
  const [file, setFile] = useState<File | null>(null);
  const periodStart = useRef<HTMLInputElement>(null);
  const periodEnd = useRef<HTMLInputElement>(null);
  const invoiceSide = INVOICE_SIDE[importType];
  const readsInvoice = invoiceSide !== undefined && file !== null && isDocument(file);

  // ADR-175: one invoice covers its own date only (the server sets the same range), so it is never
  // taken for a whole month of invoices.
  const proposeDate = (iso: string) => {
    if (periodStart.current) periodStart.current.value = iso;
    if (periodEnd.current) periodEnd.current.value = iso;
  };

  const needsBankAccount = bankAccountTypes.includes(importType);
  const hint = IMPORT_TYPES.find((t) => t.value === importType)?.hint;

  return (
    // Wider while an invoice is being checked, so the invoice and its fields sit side by side.
    <form
      action={action}
      // Sent by hand: React resets a form after its action — after a refusal too — which emptied the
      // dates, the account and the file while the drop area still named the file. The browser's own
      // checks (required fields) still run first: `submit` only fires once they pass.
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className={`${readsInvoice ? 'max-w-5xl' : 'max-w-xl'} space-y-5`}
    >
      <input type="hidden" name="org_slug" value={orgSlug} />

      <div className="max-w-xl space-y-5">
        <Field label="What kind of file is this?" htmlFor="import_type" hint={hint}>
          <Select
            id="import_type"
            name="import_type"
            value={importType}
            onChange={(event) => setImportType(event.target.value)}
          >
            {IMPORT_TYPES.map((type) => (
              <option key={type.value} value={type.value}>{type.label}</option>
            ))}
          </Select>
        </Field>

        {needsBankAccount ? (
          <Field
            label="Which account is it for?"
            htmlFor="bank_account_id"
            hint={bankAccounts.length === 0
              ? <>No bank account yet. <Link href={`/app/${orgSlug}/money/banking#add-account`} className="font-medium text-accent underline underline-offset-2">Add a bank account</Link> first, then come back to upload the statement.</>
              : undefined}
          >
            <Select id="bank_account_id" name="bank_account_id" defaultValue={bankAccounts[0]?.id ?? ''}>
              {bankAccounts.map((account) => (
                <option key={account.id} value={account.id}>{account.label}</option>
              ))}
            </Select>
          </Field>
        ) : null}

        {/*
          The period is declared, not inferred. §2.2: coverage is a statement about what a file is
          MEANT to cover, and a file whose rows stop on the 20th still covers the month — inferring the
          range from the rows would silently mark a period incomplete.
        */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Covers from" htmlFor="period_start">
            <Input ref={periodStart} id="period_start" type="date" name="period_start" required />
          </Field>
          <Field label="Covers to" htmlFor="period_end">
            <Input ref={periodEnd} id="period_end" type="date" name="period_end" required />
          </Field>
        </div>
        {readsInvoice ? (
          <p className="-mt-3 text-xs text-ink-muted">One invoice covers only its own date, so APX never takes it for all of that month&apos;s invoices.</p>
        ) : (
          <p className="-mt-3 text-xs text-ink-muted">
            The first and last day the file is meant to cover — for example 1 January to 31 March. Use the whole
            period even if the last transaction is earlier.
          </p>
        )}

        {/*
          A PDF is always kept as a source document; only a bank statement's figures are read from one
          (IMPORT_ENGINE.md §5.3). The hint says which, for the type chosen, before anything is sent.
        */}
        <Field
          label="The file"
          htmlFor="file"
          hint={aiReadTypes.includes(importType)
            ? 'CSV or Excel, or a photo (JPEG or PNG, up to 5 MB) or PDF of receipts, which APX can read with AI when you ask.'
            : pdfReadTypes.includes(importType)
              ? 'CSV, Excel or a PDF statement, up to 25 MB.'
              : invoiceSide !== undefined
                ? 'A CSV or Excel list of invoices, or ONE invoice as a PDF or photo (JPEG or PNG, up to 5 MB): APX reads it on this page for you to check.'
                : 'CSV or Excel, up to 25 MB. A PDF is stored as a document, but its figures are not read.'}
        >
          <FileDrop
            id="file"
            name="file"
            accept=".csv,.xlsx,.xlsm,.txt,.pdf,.jpg,.jpeg,.png,text/csv,application/pdf,image/jpeg,image/png"
            required
            onFile={setFile}
          />
        </Field>
      </div>

      {readsInvoice ? (
        <InvoiceReader
          key={`${invoiceSide}:${file.name}:${file.size}:${file.lastModified}`}
          file={file}
          side={invoiceSide}
          ownName={orgName}
          onIssueDate={proposeDate}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Reading your file…" pending={pending}>Upload and check</SubmitButton>
        <span className="text-sm text-ink-muted">Nothing is imported until you review it.</span>
      </div>

      <ActionMessage state={state} />
    </form>
  );
}
