'use client';

import { useActionState } from 'react';
import { Field, Select } from '@/components/ui/field';
import { SubmitButton, ActionMessage } from '@/components/ui/action-form';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/components/labels';
import type { TransferCandidateView } from '@/modules/dashboard';
import { categoriseTransactionAction, pairTransferAction } from '../../actions';

/**
 * The two edits a reviewer may make to one statement line (RBAC `banking.reconcile`): which
 * category it belongs to, and whether it is one half of a transfer. Both are hidden, not disabled,
 * for a role without the permission (UX_ARCHITECTURE.md §7.4).
 */
export function CategoryForm({
  orgSlug, transactionId, current, options,
}: {
  orgSlug: string;
  transactionId: string;
  current: string | null;
  options: readonly { id: string; label: string }[];
}) {
  const [state, action] = useActionState(categoriseTransactionAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="transaction_id" value={transactionId} />
      <Field label="Which category does this belong to?" htmlFor="category_account_id" hint="Your choice stands: APX’s rules will not change it later.">
        <Select id="category_account_id" name="category_account_id" defaultValue={current ?? ''}>
          <option value="">Not categorised</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </Select>
      </Field>
      <ActionMessage state={state} />
      <SubmitButton pendingLabel="Saving…">Save category</SubmitButton>
    </form>
  );
}

export function TransferControls({
  orgSlug, transactionId, isTransfer, candidates,
}: {
  orgSlug: string;
  transactionId: string;
  isTransfer: boolean;
  candidates: readonly TransferCandidateView[];
}) {
  const [state, action] = useActionState(pairTransferAction, null);
  if (isTransfer) {
    return (
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="org_slug" value={orgSlug} />
        <input type="hidden" name="transaction_id" value={transactionId} />
        <input type="hidden" name="pair_id" value="" />
        <ActionMessage state={state} />
        <div><Button type="submit" tone="secondary">This is not a transfer</Button></div>
      </form>
    );
  }
  if (candidates.length === 0) {
    return <p className="text-sm text-ink-muted">No transaction on another account matches this one closely enough to be the other half of a transfer.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">If this moved money between your own accounts, pick the other half:</p>
      <ul className="flex flex-col gap-2">
        {candidates.map((candidate) => (
          <li key={candidate.id} className="rounded-md border border-line p-3 text-sm">
            <form action={action} className="flex flex-wrap items-center justify-between gap-3">
              <input type="hidden" name="org_slug" value={orgSlug} />
              <input type="hidden" name="transaction_id" value={transactionId} />
              <input type="hidden" name="pair_id" value={candidate.id} />
              <span>
                <span className="font-mono tabular-nums">{candidate.amount}</span>{' '}
                <span className="text-ink">{candidate.description}</span>{' '}
                <span className="text-ink-muted">· {candidate.accountName} · {formatDate(candidate.date)}</span>
                <span className="block text-xs text-ink-faint">Marking it makes this {candidate.meaning}.</span>
              </span>
              <Button type="submit" tone="secondary">This is the other half</Button>
            </form>
          </li>
        ))}
      </ul>
      <ActionMessage state={state} />
    </div>
  );
}
