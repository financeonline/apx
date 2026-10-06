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
      <div className="flex flex-wrap gap-2">
        {NEXT[status].map((next) => (
          <Button
            key={next.status}
            type="submit"
            name="status"
            value={next.status}
            disabled={pending}
            tone={next.status === 'dismissed' ? 'secondary' : 'primary'}
          >
            {next.label}
          </Button>
        ))}
      </div>

      <ActionMessage state={state} />
    </form>
  );
}
