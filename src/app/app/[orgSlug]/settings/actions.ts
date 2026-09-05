'use server';

import { revalidatePath } from 'next/cache';
import {
  getAccessContext,
  updateOrganization,
  inviteMember,
  revokeInvitation,
  changeMemberRole,
  removeMember,
  revokeAssignment,
  requestDeletion,
  cancelDeletion,
  leaveOrganization,
} from '@/modules/tenancy';
import { fail, done, text, integer } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';
import type { MembershipRole } from '@/modules/tenancy';

/**
 * Every action follows the same shape (SERVICE_ARCHITECTURE.md §8.9): build the context from the
 * slug (never from the form), then ONE service call, which asserts the permission and calls the
 * api.* function that re-checks it in SQL. Errors are mapped, never swallowed.
 */

export async function updateOrganizationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await updateOrganization(ctx, {
      name: text(form, 'name'),
      timezone: text(form, 'timezone'),
      fiscal_year_start_month: integer(form, 'fiscal_year_start_month', 1),
    });
    revalidatePath(`/app/${orgSlug}/settings`);
    return done('Saved.');
  } catch (error) {
    return fail(error, { requestId, action: 'settings.updateOrganization' });
  }
}

export async function inviteMemberAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    const { token } = await inviteMember(ctx, {
      email: text(form, 'email'),
      role: text(form, 'role') as MembershipRole,
    });
    revalidatePath(`/app/${orgSlug}/settings/team`);
    // Phase 1 has no mailer, so the link is shown once to the person doing the inviting. The raw
    // token is never stored — only its SHA-256 (SECURITY_MODEL.md §3).
    return done(`Invitation created. Send this link: /invite/${token}`);
  } catch (error) {
    return fail(error, { requestId, action: 'settings.inviteMember' });
  }
}

export async function revokeInvitationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await revokeInvitation(ctx, text(form, 'invitation_id'));
    revalidatePath(`/app/${orgSlug}/settings/team`);
    return done('Invitation withdrawn.');
  } catch (error) {
    return fail(error, { requestId, action: 'settings.revokeInvitation' });
  }
}

export async function changeMemberRoleAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await changeMemberRole(ctx, {
      userId: text(form, 'user_id'),
      fromRole: text(form, 'from_role') as MembershipRole,
      toRole: text(form, 'to_role') as MembershipRole,
    });
    revalidatePath(`/app/${orgSlug}/settings/team`);
    return done('Role updated.');
  } catch (error) {
    return fail(error, { requestId, action: 'settings.changeMemberRole' });
  }
}

export async function removeMemberAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await removeMember(ctx, text(form, 'user_id'));
    revalidatePath(`/app/${orgSlug}/settings/team`);
    return done('Member removed.');
  } catch (error) {
    return fail(error, { requestId, action: 'settings.removeMember' });
  }
}

export async function revokeAdviserAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await revokeAssignment(ctx, {
      assignmentId: text(form, 'assignment_id'),
      reason: 'Revoked by the organisation',
    });
    revalidatePath(`/app/${orgSlug}/settings/team`);
    return done('Adviser access removed.');
  } catch (error) {
    return fail(error, { requestId, action: 'settings.revokeAdviser' });
  }
}

export async function requestDeletionAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await requestDeletion(ctx);
    revalidatePath(`/app/${orgSlug}/settings/danger`);
    return done('Deletion scheduled. You have 30 days to change your mind.');
  } catch (error) {
    return fail(error, { requestId, action: 'settings.requestDeletion' });
  }
}

export async function cancelDeletionAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await cancelDeletion(ctx);
    revalidatePath(`/app/${orgSlug}/settings/danger`);
    return done('Deletion cancelled.');
  } catch (error) {
    return fail(error, { requestId, action: 'settings.cancelDeletion' });
  }
}

export async function leaveOrganizationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const orgSlug = text(form, 'org_slug');
  let requestId: string | undefined;
  try {
    const ctx = await getAccessContext(orgSlug);
    requestId = ctx.requestId;
    await leaveOrganization(ctx);
    return done('You have left the organisation.');
  } catch (error) {
    return fail(error, { requestId, action: 'settings.leaveOrganization' });
  }
}
