'use client';

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

export const IMPORT_TYPES: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: 'bank_statement', label: 'Bank statement', hint: 'A list of transactions from your bank' },
  { value: 'general_ledger', label: 'General ledger', hint: 'Every journal entry, from your accounting system' },
  { value: 'trial_balance', label: 'Trial balance', hint: 'Account balances at a point in time' },
  { value: 'pnl_report', label: 'Profit and loss report', hint: 'A summary by category' },
  { value: 'sales_invoices', label: 'Sales invoices', hint: 'What your customers owe you' },
  { value: 'purchase_invoices', label: 'Purchase invoices', hint: 'What you owe your suppliers' },
];

export function UploadForm({
  orgSlug,
  bankAccounts,
}: {
  orgSlug: string;
  bankAccounts: ReadonlyArray<{ id: string; label: string }>;
}) {
  const [state, action] = useActionState(startImportAction, null);
  const [importType, setImportType] = useState('bank_statement');

  const needsBankAccount = importType === 'bank_statement' || importType === 'receipts';
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
            ? 'Add a bank account on the Cash page first.'
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

      <Field label="The file" htmlFor="file" hint="CSV or Excel, up to 25 MB.">
        <Input id="file" type="file" name="file" accept=".csv,.xlsx,.xlsm,.txt,text/csv" required />
      </Field>

      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Reading your file…">Upload and check</SubmitButton>
        <span className="text-sm text-ink-muted">Nothing is imported until you review it.</span>
      </div>

      <ActionMessage state={state} />
    </form>
  );
}
