'use client';

import { useActionState, useId, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { decideAccessRequestAction } from './actions';
import { Field, Textarea } from '@/components/ui/field';
import { ActionMessage } from '@/components/ui/action-form';
import { buttonClass, type ButtonTone } from '@/components/ui/button';
import type { RequestView } from './access-view';

/**
 * A waiting "Request more information" (ADR-172), for an owner or admin to decide. Approving
 * switches on the ticked permissions — a subset of those asked, and only ones the viewer holds;
 * the rest are drawn disabled with the reason. One form, two buttons: the button pressed says
 * which decision it is, and the note goes with either.
 */
export function PendingRequest({ orgSlug, request }: { orgSlug: string; request: RequestView }) {
  const [state, action] = useActionState(decideAccessRequestAction, null);
  const noteId = useId();

  return (
    <li className="rounded-xl border border-line bg-surface-sunken/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="font-medium">{request.who}</p>
          <p className="break-all text-sm text-ink-muted">
            {request.roleName}
            {request.who !== request.email ? ` · ${request.email}` : ''}
          </p>
        </div>
        <p className="text-sm text-ink-muted">Asked {request.askedOn}</p>
      </div>

      {request.message ? (
        <blockquote className="mt-3 border-l-2 border-line-strong pl-3 text-sm whitespace-pre-line">
          {request.message}
        </blockquote>
      ) : null}

      <form action={action} className="mt-4 flex flex-col gap-4">
        <input type="hidden" name="org_slug" value={orgSlug} />
        <input type="hidden" name="request_id" value={request.id} />

        {request.asked.length > 0 ? (
          <fieldset>
            <legend className="text-sm font-medium">They asked for</legend>
            <p className="text-xs text-ink-muted">Untick anything you would rather not switch on.</p>
            <ul className="mt-2 flex flex-col gap-2">
              {request.asked.map((asked) => (
                <li key={asked.permission}>
                  <label
                    className={`flex min-h-11 items-start gap-3 rounded-lg border border-line bg-surface p-3 ${
                      asked.approvable ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'
                    }`}
                  >
                    <input
                      type="checkbox"
                      name="permissions"
                      value={asked.permission}
                      defaultChecked={asked.approvable}
                      disabled={!asked.approvable}
                      className="mt-1 size-4 shrink-0 accent-accent"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{asked.title}</span>
                      <span className="block text-xs text-ink-muted">{asked.detail}</span>
                      {asked.approvable ? null : (
                        <span className="mt-1 block text-xs text-warn">
                          You do not have this permission yourself, so you cannot give it. An owner can.
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        ) : (
          <p className="text-sm text-ink-muted">
            They asked in words only. Switch on what they need under their Access, above, then approve.
          </p>
        )}

        <Field label="Note to them (optional)" htmlFor={noteId} hint="They see it with your decision.">
          <Textarea id={noteId} name="note" rows={2} maxLength={1000} />
        </Field>

        <ActionMessage state={state} />

        <div className="flex flex-wrap gap-2">
          <DecisionButton decision="approve" tone="primary" disabled={!request.canApprove} who={request.who}>
            Approve
          </DecisionButton>
          <DecisionButton decision="decline" tone="secondary" who={request.who}>
            Decline
          </DecisionButton>
        </div>
        {request.canApprove ? null : (
          <p className="text-xs text-ink-muted">
            You hold none of what they asked for, so only an owner can approve this. You can still decline.
          </p>
        )}
      </form>
    </li>
  );
}

/** A submit button that names its decision in the form data, so one form serves both buttons. */
function DecisionButton({
  decision,
  tone,
  disabled = false,
  who,
  children,
}: {
  decision: 'approve' | 'decline';
  tone: ButtonTone;
  disabled?: boolean;
  who: string;
  children: ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="decision"
      value={decision}
      disabled={disabled || pending}
      aria-label={`${decision === 'approve' ? 'Approve' : 'Decline'} the request from ${who}`}
      className={buttonClass(tone, 'min-h-11 sm:min-h-0')}
    >
      {pending ? 'Working…' : children}
    </button>
  );
}
