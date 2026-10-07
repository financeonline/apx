'use client';

import { useActionState } from 'react';
import { Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { setLoanSecurityAction } from './actions';

const SECURITY_LABELS: Readonly<Record<string, string>> = {
  unmarked: 'Not yet marked',
  secured: 'Secured',
  unsecured: 'Unsecured',
};

/**
 * Whether a loan is secured or unsecured (ADR-156). Nothing in the imported data says which, so the
 * business marks it; unmarked stays "Not yet marked" and is never guessed from the account name.
 * Without `financials.edit` the marking is shown as text — the control is absent, not disabled.
 */
export function LoanSecurityControl({
  orgSlug,
  accountId,
  accountName,
  security,
  canEdit,
}: {
  orgSlug: string;
  accountId: string;
  accountName: string;
  security: 'secured' | 'unsecured' | null;
  canEdit: boolean;
}) {
  const [state, action] = useActionState(setLoanSecurityAction, null);
  const current = security ?? 'unmarked';

  if (!canEdit) {
    return (
      <p className="mt-2 text-xs text-ink-muted">
        Security: {SECURITY_LABELS[current]}
      </p>
    );
  }

  return (
    <div className="mt-2 min-w-0">
      <form action={action} className="flex min-w-0 flex-wrap items-center gap-2">
        <input type="hidden" name="org_slug" value={orgSlug} />
        <input type="hidden" name="account_id" value={accountId} />
        <label htmlFor={`loan_security_${accountId}`} className="text-xs text-ink-muted">
          Security
        </label>
        <Select
          id={`loan_security_${accountId}`}
          name="loan_security"
          defaultValue={current}
          aria-label={`Security for ${accountName}`}
          className="w-auto"
        >
          <option value="unmarked">Not yet marked</option>
          <option value="secured">Secured</option>
          <option value="unsecured">Unsecured</option>
        </Select>
        <SubmitButton pendingLabel="Saving…" tone="secondary">
          Save
        </SubmitButton>
      </form>
      <ActionMessage state={state} />
    </div>
  );
}
