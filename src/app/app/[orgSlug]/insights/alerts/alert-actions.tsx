'use client';

import { useActionState, useEffect, useState } from 'react';
import { ActionMessage, SubmitButton } from '@/components/ui/action-form';
import type { EffectiveRole } from '@/core/permissions';
import {
  STATUS_ACTION_LABELS, UNDO_WINDOW_MS, allowedStatuses, type AlertStatus,
} from '@/components/dashboard/alert-status';
import { setAlertStatusAction } from './actions';

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
          <button
            key={next}
            type="submit"
            name="status"
            value={next}
            disabled={pending}
            className="rounded-md border border-line px-2 py-1 text-sm text-ink hover:border-line-strong disabled:opacity-60"
          >
            {STATUS_ACTION_LABELS[next]}
          </button>
        ))
      )}

      <ActionMessage state={state} />
    </form>
  );
}
