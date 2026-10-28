'use client';

import { useActionState } from 'react';
import { ActionMessage } from '@/components/ui/action-form';
import { Button } from '@/components/ui/button';
import type { ActionStatus } from '@/modules/actions';
import { setStatusAction } from './actions';
import { Textarea } from '@/components/ui/shadcn';

/**
 * The status controls on an action (UX_ARCHITECTURE.md §7; SOW §17).
 *
 * The moves a reader may not make are ABSENT, not disabled — a greyed-out button tells somebody
 * exactly which capability they lack and invites a support request about something that was never
 * theirs. What is shown is the next honest step for where the action is now: an open action can be
 * started, dropped or finished; a finished one can only be re-opened, because §17's two final
 * states are competing accounts of the same work and one has to be withdrawn before the other is
 * asserted.
 */

/**
 * What each move means, in a sentence: shown as the button's tooltip, and spelled out under the
 * buttons on the action's own page. "Mark as done" and "Dismiss" both take the action off the
 * to-do list, and the difference — it was done, or it was decided against — is the record.
 */
const HINT: Readonly<Record<ActionStatus, string>> = {
  in_progress: 'Someone has picked it up and is working on it.',
  completed: 'It is finished. It moves to Finished.',
  dismissed: 'You have decided not to do it. It moves to Finished, so the decision is kept.',
  open: 'Put it back on the to-do list.',
};

const NEXT: Readonly<Record<ActionStatus, ReadonlyArray<{ status: ActionStatus; label: string }>>> = {
  open: [
    { status: 'in_progress', label: 'Start' },
    { status: 'completed', label: 'Mark as done' },
    { status: 'dismissed', label: 'Dismiss' },
  ],
  in_progress: [
    { status: 'completed', label: 'Mark as done' },
    { status: 'dismissed', label: 'Dismiss' },
  ],
  completed: [{ status: 'open', label: 'Re-open' }],
  dismissed: [{ status: 'open', label: 'Re-open' }],
};

export function StatusControls({
  orgSlug,
  actionId,
  status,
  withOutcome = false,
}: {
  orgSlug: string;
  actionId: string;
  status: ActionStatus;
  /** The detail page asks for the outcome; a list card just moves it along. */
  withOutcome?: boolean;
}) {
  const [state, submit, pending] = useActionState(setStatusAction, null);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="action_id" value={actionId} />

      {withOutcome ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">What came of it? (optional)</span>
          <Textarea
            name="outcome_notes"
            rows={2}
            placeholder="What happened, in a sentence"
          />
        </label>
      ) : null}

      {/*
        * Plain buttons carrying their own `name`/`value`, not the shared SubmitButton: one form
        * offers several moves, and which one was pressed is the whole message. A component that
        * only reports pending state cannot say that.
        */}
      {/*
        * Only the first move — the natural next step — is a solid button. Two solid buttons side
        * by side ("Start", "Mark as done") read as equally expected, and the owner had to stop and
        * choose between them.
        */}
      <div className="flex flex-wrap gap-2">
        {NEXT[status].map((next, index) => (
          <Button
            key={next.status}
            type="submit"
            name="status"
            value={next.status}
            disabled={pending}
            tone={index === 0 && next.status !== 'dismissed' ? 'primary' : 'secondary'}
            title={HINT[next.status]}
          >
            {next.label}
          </Button>
        ))}
      </div>

      {withOutcome ? (
        <dl className="grid gap-1 text-sm text-ink-muted">
          {NEXT[status].map((next) => (
            <div key={next.status}>
              <dt className="inline font-medium text-ink">{next.label}</dt>
              <dd className="inline"> — {HINT[next.status]}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <ActionMessage state={state} />
    </form>
  );
}
