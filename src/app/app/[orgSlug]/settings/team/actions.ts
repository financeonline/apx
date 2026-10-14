'use server';

import { revalidatePath } from 'next/cache';
import {
  getAccessContext,
  resetMemberPermissions,
  setMemberPermission,
  decideAccessRequest,
  type SwitchablePermission,
} from '@/modules/tenancy';
import { ValidationError } from '@/core/errors';
import { fail, done, text, optionalText } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';
import { asSwitchable, grantFrom, resetAllMessage } from './access-view';

/**
 * Per-person access and "Request more information" (ADR-172), in the shape of every settings
 * action (SERVICE_ARCHITECTURE.md §8.9): the context from the slug, never from the form, then the
 * service, which asserts the permission and calls the api.* function that re-checks it in SQL —
 * including "never beyond the viewer's own rights" and "never an owner". Errors are mapped, never
 * swallowed.
 */

function permissionFrom(form: FormData): SwitchablePermission {
  const permission = asSwitchable(text(form, 'permission'));
  if (!permission) throw new ValidationError('Choose a permission to change.');
  return permission;
}

export async function setMemberPermissionAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    const permission = permissionFrom(form);
    const granted = grantFrom(text(form, 'granted'));
    if (granted === undefined) throw new ValidationError('Choose on, off or the role’s default.');
    await setMemberPermission(ctx, { userId: text(form, 'user_id'), permission, granted });
    revalidatePath(`/app/${orgSlug}/settings/team`);
    return done(granted === null ? 'Back to the role’s default.' : granted ? 'Switched on.' : 'Switched off.');
  } catch (error) {
    return fail(error, { requestId, action: 'settings.setMemberPermission' });
  }
}

/**
 * "Reset all" (rev 1.4): the service's `resetMemberPermissions`, which reads the member fresh, puts
 * back every switch the viewer may, and leaves — and names — those an owner set (for a viewer who is
 * not an owner) and those whose default would give something the viewer lacks; the database
 * re-checks each reset. The confirmation says what stayed and why, rather than stopping at the
 * first refusal. A refusal part-way still leaves those already reset reset.
 */
export async function resetMemberPermissionsAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    const outcome = await resetMemberPermissions(ctx, text(form, 'user_id'));
    revalidatePath(`/app/${orgSlug}/settings/team`);
    return done(resetAllMessage(outcome));
  } catch (error) {
    return fail(error, { requestId, action: 'settings.resetMemberPermissions' });
  }
}

/**
 * Approve or decline a request. Approval switches on the permissions ticked — a subset of those
 * asked, and only ones the viewer holds; the service refuses anything else.
 */
export async function decideAccessRequestAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    const decision = text(form, 'decision');
    if (decision !== 'approve' && decision !== 'decline') throw new ValidationError('Choose approve or decline.');
    const approve = decision === 'approve';
    const permissions = form
      .getAll('permissions')
      .map((value) => (typeof value === 'string' ? asSwitchable(value) : null))
      .filter((value): value is SwitchablePermission => value !== null);
    const note = optionalText(form, 'note');
    await decideAccessRequest(ctx, {
      id: text(form, 'request_id'),
      approve,
      permissions: approve ? permissions : undefined,
      note,
    });
    revalidatePath(`/app/${orgSlug}/settings/team`);
    if (approve) return done(permissions.length > 0 ? 'Approved. What you chose is switched on.' : 'Approved.');
    return done(note ? 'Declined. They will see your note.' : 'Declined.');
  } catch (error) {
    return fail(error, { requestId, action: 'settings.decideAccessRequest' });
  }
}
