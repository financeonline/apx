'use client';

import { useActionState } from 'react';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { createBankAccountAction } from './actions';

/**
 * "Add a bank account" (Phase 13). Rendered only for `financials.edit`. Asks for the account's name,
 * bank and type, and the last four digits — never a full account number, and never a password,
 * PIN or login: MOTION reads statements you upload, it does not connect to the bank.
 */
export function AddAccountForm({ orgSlug, currency }: { orgSlug: string; currency: string }) {
  const [state, action] = useActionState(createBankAccountAction, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <Field label="What do you call this account?" htmlFor="name" hint="For example “Main current account”.">
        <Input id="name" name="name" required maxLength={200} />
      </Field>
      <Field label="Which bank is it with?" htmlFor="bank_name">
        <Input id="bank_name" name="bank_name" required maxLength={200} />
      </Field>
      <Field label="What kind of account is it?" htmlFor="account_type" hint="Credit cards and loans are tracked, but only current and savings accounts count as cash.">
        <Select id="account_type" name="account_type" defaultValue="current">
          <option value="current">Current account</option>
          <option value="savings">Savings account</option>
          <option value="credit_card">Credit card</option>
          <option value="loan">Loan</option>
          <option value="other">Something else</option>
        </Select>
      </Field>
      <Field label="Last four digits of the account number" htmlFor="account_last4" hint="Only these four digits are kept. They tell two accounts at the same bank apart.">
        <Input id="account_last4" name="account_last4" inputMode="numeric" maxLength={4} pattern="[0-9]{4}" />
      </Field>
      <Field label="Sort code (optional)" htmlFor="sort_code_masked" hint="UK accounts only. Stored as shown on your statement.">
        <Input id="sort_code_masked" name="sort_code_masked" maxLength={10} placeholder="12-34-56" />
      </Field>
      <p className="text-xs text-ink-faint">Figures for this account will be in {currency}, the same as the rest of your organisation.</p>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Adding…">Add this account</SubmitButton>
    </form>
  );
}
