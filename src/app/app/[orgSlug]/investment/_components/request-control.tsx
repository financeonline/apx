'use client';

import { useActionState, useId } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import type { ButtonTone } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Label } from '@/components/ui/shadcn';
import { requestInvestmentReportAction } from '../actions';

/**
 * The one control that spends AI on Investment: create, refresh or retry the pack (ADR-171), as
 * Marketing's (ADR-170) — with the one thing the pack adds, the amount to allocate. Empty, APX
 * allocates the base year's net profit; when there is no profit to fall back on, the field is
 * required and says so. The words under it come from the module (`presentInvestmentStart`), never
 * from here.
 *
 * The permission, the amount's bounds and the allowance are the action's and the database's to
 * decide, not this form's (ADR-026); a refusal — an amount that does not read, a company with nothing
 * to allocate — comes back as a plain sentence beside the button.
 */
export function RequestPackControl({
  orgSlug,
  label,
  tone = 'primary',
  amount,
  compact = false,
}: {
  orgSlug: string;
  label: string;
  tone?: ButtonTone;
  /** The amount field: whether it must be filled, and the line under it. */
  amount: { readonly required: boolean; readonly hint: string };
  /** The toolbar's form: the field and the button on one line. */
  compact?: boolean;
}) {
  const [state, submit] = useActionState(requestInvestmentReportAction, null);
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  return (
    <form action={submit} className="flex min-w-0 flex-col gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <div className={compact ? 'flex flex-wrap items-end gap-3' : 'flex flex-col gap-3'}>
        <div className={compact ? 'w-44 space-y-1.5' : 'max-w-xs space-y-1.5'}>
          <Label htmlFor={fieldId}>
            Amount to allocate{amount.required ? '' : <span className="font-normal text-ink-muted"> (optional)</span>}
          </Label>
          <Input
            id={fieldId}
            name="surplus"
            inputMode="decimal"
            autoComplete="off"
            placeholder="e.g. 95,000"
            required={amount.required}
            aria-describedby={hintId}
            className="tabular"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton tone={tone} pendingLabel="Starting…">{label}</SubmitButton>
        </div>
      </div>
      <p id={hintId} className={compact ? 'max-w-md text-xs text-ink-muted' : 'max-w-prose text-xs text-ink-muted'}>{amount.hint}</p>
      <ActionMessage state={state} />
    </form>
  );
}
