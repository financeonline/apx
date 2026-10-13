'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { Field, Input, Select } from '@/components/ui/field';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { startImportAction } from '../actions';

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
  { value: 'general_ledger', label: 'General ledger', hint: 'Every journal entry, from your accounting system' },
  { value: 'trial_balance', label: 'Trial balance', hint: 'Account balances at a point in time' },
  { value: 'pnl_report', label: 'Profit and loss report', hint: 'A summary by category' },
  { value: 'balance_sheet', label: 'Balance sheet', hint: 'What the business owns and owes at a date' },
  { value: 'sales_invoices', label: 'Sales invoices', hint: 'What your customers owe you' },
  { value: 'purchase_invoices', label: 'Purchase invoices', hint: 'What you owe your suppliers' },
  { value: 'sales_report', label: 'Sales report', hint: 'A sales report with one line per invoice' },
  { value: 'purchase_report', label: 'Purchase report', hint: 'A purchase report with one line per invoice' },
  { value: 'receipts', label: 'Receipts', hint: 'A list of receipts, each against an expense account' },
  { value: 'budget', label: 'Budget', hint: 'What you plan to earn and spend, by month and account' },
];

export function UploadForm({
  orgSlug,
  bankAccounts,
  bankAccountTypes,
  pdfReadTypes,
  aiReadTypes = [],
}: {
  orgSlug: string;
  bankAccounts: ReadonlyArray<{ id: string; label: string }>;
  /** The import types that belong to a bank account. */
  bankAccountTypes: readonly string[];
  /** The import types whose PDF figures MOTION reads. */
  pdfReadTypes: readonly string[];
  /** ADR-150: the import types whose PDFs and photos MOTION reads with AI when asked (receipts). */
  aiReadTypes?: readonly string[];
}) {
  const [state, action] = useActionState(startImportAction, null);
  const [importType, setImportType] = useState('bank_statement');

  const needsBankAccount = bankAccountTypes.includes(importType);
  const hint = IMPORT_TYPES.find((t) => t.value === importType)?.hint;

  return (
    <form action={action} className="max-w-xl space-y-5">
      <input type="hidden" name="org_slug" value={orgSlug} />

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
          <Input id="period_start" type="date" name="period_start" required />
        </Field>
        <Field label="Covers to" htmlFor="period_end">
          <Input id="period_end" type="date" name="period_end" required />
        </Field>
      </div>

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
            : 'CSV or Excel, up to 25 MB. A PDF is stored as a document, but its figures are not read.'}
      >
        <Input
          id="file"
          type="file"
          name="file"
          accept=".csv,.xlsx,.xlsm,.txt,.pdf,.jpg,.jpeg,.png,text/csv,application/pdf,image/jpeg,image/png"
          required
        />
      </Field>

      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Reading your file…">Upload and check</SubmitButton>
        <span className="text-sm text-ink-muted">Nothing is imported until you review it.</span>
      </div>

      <ActionMessage state={state} />
    </form>
  );
}
