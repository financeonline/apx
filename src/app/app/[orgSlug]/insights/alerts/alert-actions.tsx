'use client';

import { useActionState, useEffect, useState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import type { EffectiveRole } from '@/core/permissions';
import {
  STATUS_ACTION_LABELS, UNDO_WINDOW_MS, allowedStatuses, type AlertStatus,
} from '@/components/dashboard/alert-status';
import { setAlertStatusAction } from './actions';
import { Button } from '@/components/ui/shadcn';

/**
 * The status controls on an alert card (UX_ARCHITECTURE.md §7.4).
 *
 * Two decisions worth stating.
 *
 * **The buttons a role may not use are absent, not disabled.** A client sees "Mark as seen" and
 * nothing else. A greyed-out "Dismiss" tells them exactly which capability they lack and invites a
 * support request about a button that was never theirs.
 *
 * **A status change is undoable for eight seconds.** Resolving an alert is the kind of action people
 * take quickly and regret immediately, and the undo is what makes acting on the list feel safe
 * rather than final.
 */

/**
 * What each button does, in a sentence (client-friendliness pass, 2026-10-28).
 *
 * "Resolve" and "Dismiss" read as the same thing to an owner, and they are not: a resolved alert
 * comes back if the problem does, and a dismissed one stays quiet for ninety days unless it gets
 * worse (`modules/alerts/domain/lifecycle.ts`, FINANCIAL_ENGINE.md §8.1). The sentences follow
 * that file; if the lifecycle changes, these change with it.
 */
const STATUS_ACTION_HINTS: Readonly<Record<AlertStatus, string>> = {
  open: 'Put it back on the list as not yet seen.',
  acknowledged: 'Keeps it on the list, marked as seen. It comes back to the top only if it gets worse.',
  resolved: 'You have dealt with it. It comes back if the problem returns.',
  dismissed: 'It does not apply to you. It stays hidden for 90 days unless it gets worse.',
};

/** The key to the buttons, said once above the list rather than on every card. */
export function AlertButtonsGuide({ role }: { role: EffectiveRole }) {
  const statuses = allowedStatuses(role);
  if (statuses.length === 0) return null;
  return (
    <details className="mt-2 text-sm text-ink-muted">
      <summary className="cursor-pointer text-accent">What do the buttons on an alert do?</summary>
      <dl className="mt-2 grid gap-1.5">
        {statuses.map((status) => (
          <div key={status}>
            <dt className="inline font-medium text-ink">{STATUS_ACTION_LABELS[status]}</dt>
            <dd className="inline"> — {STATUS_ACTION_HINTS[status]}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function AlertActions({
  orgSlug,
  alertId,
  status,
  role,
}: {
  orgSlug: string;
  alertId: string;
  status: AlertStatus;
  role: EffectiveRole;
}) {
  const [state, action, pending] = useActionState(setAlertStatusAction, null);

  /*
   * The undo window, tracked by which RESULT has expired rather than by a deadline.
   *
   * Storing the expired result's identity means the only `setState` runs inside the timer callback,
   * not synchronously in the effect body — a synchronous one would re-render the moment the action
   * returned, and every alert card on the page would re-render with it.
   */
  const [expiredFor, setExpiredFor] = useState<unknown>(null);

  useEffect(() => {
    if (state?.ok !== true) return;
    const timer = setTimeout(() => setExpiredFor(state), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const available = allowedStatuses(role).filter((next) => next !== status);
  const undoAvailable = state?.ok === true && expiredFor !== state;

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="org_slug" value={orgSlug} />
      <input type="hidden" name="alert_id" value={alertId} />

      {undoAvailable ? (
        <>
          <input type="hidden" name="status" value="open" />
          <SubmitButton pendingLabel="Undoing…">Undo</SubmitButton>
        </>
      ) : (
        available.map((next) => (
          <Button
            key={next}
            type="submit"
            name="status"
            value={next}
            disabled={pending}
            variant="secondary"
            className="px-2 py-1 text-sm"
            title={STATUS_ACTION_HINTS[next]}
          >
            {STATUS_ACTION_LABELS[next]}
          </Button>
        ))
      )}

      <ActionMessage state={state} />
    </form>
  );
}
