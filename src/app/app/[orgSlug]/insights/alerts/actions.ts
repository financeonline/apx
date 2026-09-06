'use server';

import { revalidatePath } from 'next/cache';
import { getAccessContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { setAlertStatus } from '@/modules/alerts';
import { fail, done, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Change an alert's status (RBAC_MATRIX.md §2.1, UX_ARCHITECTURE.md §7.4).
 *
 * The permission check here is the SECOND one, not the only one: `api.set_alert_status` refuses a
 * client anything but `acknowledged` at the database, whatever this route believes. That is the
 * point of ADR-026 — the interface hides what a role may not do, and the database refuses it anyway,
 * so a forged request achieves nothing.
 */
export async function setAlertStatusAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    assertCan(ctx, 'alerts.manage');

    const status = text(form, 'status');
    await setAlertStatus(ctx.db, {
      alertId: text(form, 'alert_id'),
      status,
      reason: form.get('reason') === null ? null : String(form.get('reason')),
    }, requestId);

    revalidatePath(`/app/${orgSlug}/insights`);
    revalidatePath(`/app/${orgSlug}/home`);

    // §7.4: a status change is undoable for eight seconds, so the card tells the reader what it did
    // and offers the way back rather than only confirming.
    return done(MESSAGES[status] ?? 'Updated.');
  } catch (error) {
    return fail(error, { requestId, action: 'alerts.set_status' });
  }
}

const MESSAGES: Readonly<Record<string, string>> = {
  acknowledged: 'Marked as seen.',
  resolved: 'Resolved.',
  dismissed: 'Dismissed. It will come back only if it gets worse, or after 90 days.',
  open: 'Re-opened.',
};
