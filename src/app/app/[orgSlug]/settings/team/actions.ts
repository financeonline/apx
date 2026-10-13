'use server';

import { revalidatePath } from 'next/cache';
import {
  getAccessContext,
  listMemberPermissions,
  setMemberPermission,
  decideAccessRequest,
  type SwitchablePermission,
} from '@/modules/tenancy';
import { ValidationError } from '@/core/errors';
import { fail, done, text, optionalText } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';
import { accessPanel, asSwitchable, grantFrom } from './access-view';

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
 * "Reset all": every switch the viewer may put back, read fresh from the service rather than from
 * the form, so a switch another admin set a moment ago is not missed. One call per switch, in turn;
 * a refusal stops there and says so, leaving those already reset reset.
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
    const userId = text(form, 'user_id');
    const member = (await listMemberPermissions(ctx)).find((m) => m.userId === userId);
    if (!member) throw new ValidationError('That person is no longer a member.');
    const { resettable } = accessPanel(member);
    for (const permission of resettable) {
      await setMemberPermission(ctx, { userId, permission, granted: null });
    }
    revalidatePath(`/app/${orgSlug}/settings/team`);
    return done(resettable.length === 0 ? 'Nothing to reset.' : 'Back to the role’s defaults.');
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
