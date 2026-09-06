'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import { createFromAlertAction } from '@/app/app/[orgSlug]/actions/actions';

/**
 * Turning an alert into an action (`TEST_STRATEGY.md §8` convert row; ADR-034).
 *
 * Offered once. When the alert already points at an action, the button is replaced by a link to it
 * — an alert is one problem, and a second task about the same problem is two people doing the same
 * work and each assuming the other is not.
 *
 * The action gets a COPY of this revision's evidence, not a pointer to it: the alert will be
 * re-evaluated the next time the figures move, and the action has to keep saying what it said when
 * somebody decided to act.
 */
export function ConvertControl({
  orgSlug,
  alertId,
  actionId,
}: {
  orgSlug: string;
  alertId: string;
  actionId: string | null;
}) {
  const [state, submit] = useActionState(createFromAlertAction, null);

  if (actionId !== null) {
    return (
      <p className="text-sm">
        <Link
          href={`/app/${orgSlug}/actions/${actionId}`}
          className="text-accent underline underline-offset-2"
        >
          Somebody is already on this — open the action
        </Link>
      </p>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-2">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="alert_id" value={alertId} />
      <div><SubmitButton tone="secondary">Add this to the Action Centre</SubmitButton></div>
      <ActionMessage state={state} />
    </form>
  );
}
