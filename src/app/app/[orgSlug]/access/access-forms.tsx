'use client';

import { useActionState, useId, useState } from 'react';
import { Send } from 'lucide-react';
import { Field, Textarea } from '@/components/ui/field';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { requestAccessAction, withdrawAccessRequestAction } from './actions';
import type { PermissionLine } from './access-view';

/**
 * The two forms on "Your access" (ADR-172), each a plain `<form action>` so it works before the
 * page's script has loaded. The message box counts down to the 1,000-character limit the service
 * and the database enforce; ticking nothing and writing something is a valid request ("say what you
 * need in a message"), and the service says so in words when both are empty.
 */
export function RequestAccessForm({
  orgSlug,
  askable,
  maxLength,
}: {
  orgSlug: string;
  askable: readonly PermissionLine[];
  maxLength: number;
}) {
  const [state, action] = useActionState(requestAccessAction, null);
  const [length, setLength] = useState(0);
  const messageId = useId();
  const countId = useId();

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="org_slug" value={orgSlug} />

      {askable.length > 0 ? (
        <fieldset>
          <legend className="text-sm font-medium text-ink">What would you like to see?</legend>
          <p className="text-xs text-ink-muted">Tick anything you need. You can also just write what you need below.</p>
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {askable.map((p) => (
              <li key={p.permission} className="min-w-0">
                <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3 transition-colors hover:border-accent/60 has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40">
                  <input
                    type="checkbox"
                    name="permissions"
                    value={p.permission}
                    className="mt-1 size-4 shrink-0 accent-accent"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">{p.title}</span>
                    <span className="block text-xs text-ink-muted">{p.detail}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : (
        <p className="text-sm text-ink-muted">
          You already hold every permission that can be switched on for a person. Write what you need below.
        </p>
      )}

      <Field
        label="Message (optional)"
        htmlFor={messageId}
        hint={<span id={countId}>{`${length.toLocaleString('en-GB')} of ${maxLength.toLocaleString('en-GB')} characters`}</span>}
      >
        <Textarea
          id={messageId}
          name="message"
          rows={4}
          maxLength={maxLength}
          aria-describedby={countId}
          placeholder="For example: the monthly bank balances for the loan review."
          onChange={(event) => setLength(event.currentTarget.value.length)}
        />
      </Field>

      <ActionMessage state={state} />

      <div>
        <SubmitButton pendingLabel="Sending…">
          <Send aria-hidden="true" /> Send request
        </SubmitButton>
      </div>
    </form>
  );
}

/** Take back one's own waiting request. */
export function WithdrawRequestForm({ orgSlug, requestId }: { orgSlug: string; requestId: string }) {
  const [state, action] = useActionState(withdrawAccessRequestAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="request_id" value={requestId} />
      <div>
        <SubmitButton tone="secondary" pendingLabel="Withdrawing…" aria-label="Withdraw your waiting request">
          Withdraw request
        </SubmitButton>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}
