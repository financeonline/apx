'use client';

import { useActionState } from 'react';
import { Field, Input, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import type { CashAccountView } from '@/modules/dashboard';
import { setOpeningBalanceAction } from './actions';

/**
 * "Enter the balance at the start of the statement" (UX_ARCHITECTURE.md §6, §4).
 *
 * Rendered only for a role with `financials.edit`; a role without it never sees the form at all,
 * because an action a role lacks is hidden, not disabled (§7.4, RBAC §5).
 */
export function OpeningBalanceForm({
  orgSlug,
  accounts,
  currency,
}: {
  orgSlug: string;
  accounts: readonly CashAccountView[];
  currency: string;
}) {
  const [state, action] = useActionState(setOpeningBalanceAction, null);
  const first = accounts[0];
  if (!first) return null;

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <Field label="Account" htmlFor="bank_account_id">
        <Select id="bank_account_id" name="bank_account_id" defaultValue={first.id}>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} — {account.reference}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={`Balance at the start (${currency})`}
        htmlFor="amount"
        hint="The balance shown at the top of your first statement, to the penny. A minus sign is fine if the account was overdrawn."
      >
        <Input id="amount" name="amount" inputMode="decimal" required placeholder="1234.56" />
      </Field>
      <Field label="On this date" htmlFor="balance_date" hint="The first day the statement covers.">
        <Input id="balance_date" name="balance_date" type="date" required />
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save opening balance</SubmitButton>
    </form>
  );
}
