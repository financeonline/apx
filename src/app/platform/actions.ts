'use server';

import { revalidatePath } from 'next/cache';
import { revokeUserSessions } from '@/core/db';
import { addPlatformUser } from '@/modules/platform';
import { confirmPassword, getPlatformContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { toMotionError } from '@/core/errors';
import { fail, done, text, optionalText } from '@/app/_lib/server-action';
import { requestOrigin } from '@/app/_lib/request-origin';
import type { ActionResult } from '@/components/action-result';

/**
 * Platform actions. Each is authorised twice: assertCan here, and app.require_super_admin() inside
 * the api.* function — which additionally requires aal2 and, for these, re-authentication within
 * the last ten minutes (ADR-044.3).
 */

export async function addPlatformUserAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getPlatformContext();
    requestId = ctx.requestId;
    assertCan(ctx, 'platform.users.manage');
    const origin = await requestOrigin();
    const { invited } = await addPlatformUser(
      ctx,
      { email: text(form, 'email'), role: text(form, 'platform_role') },
      { redirectTo: `${origin}/account` },
    );
    revalidatePath('/platform/users');
    return done(invited
      ? 'Invited. They will receive an email to set their password, then must set up two-step sign-in.'
      : 'Added.');
  } catch (error) {
    return fail(error, { requestId, action: 'platform.addUser' });
  }
}

export async function revokePlatformRoleAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getPlatformContext();
    requestId = ctx.requestId;
    assertCan(ctx, 'platform.users.manage');
    const userId = text(form, 'user_id');
    const { error } = await ctx.db.schema('api').rpc('revoke_platform_role', { p_user: userId });
    if (error) throw toMotionError(error, requestId);
    // SECURITY_MODEL.md §4: a revoked platform role invalidates every session of that user, at the
    // database (ADR-075). After the revocation committed, so a failure here cannot undo it.
    await revokeUserSessions(userId);
    revalidatePath('/platform/users');
    return done('Platform role removed.');
  } catch (error) {
    return fail(error, { requestId, action: 'platform.revokeRole' });
  }
}

export async function createAssignmentAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getPlatformContext();
    requestId = ctx.requestId;
    assertCan(ctx, 'assignments.manage');
    const { error } = await ctx.db.schema('api').rpc('create_assignment', {
      p_org: text(form, 'organization_id'),
      p_employee: text(form, 'employee_user_id'),
      p_ends_at: optionalText(form, 'ends_at') ?? null,
    });
    if (error) throw toMotionError(error, requestId);
    revalidatePath('/platform/assignments');
    return done('Adviser assigned.');
  } catch (error) {
    return fail(error, { requestId, action: 'platform.createAssignment' });
  }
}

export async function revokeAssignmentAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getPlatformContext();
    requestId = ctx.requestId;
    assertCan(ctx, 'assignments.manage');
    const { error } = await ctx.db.schema('api').rpc('revoke_assignment', {
      p_assignment: text(form, 'assignment_id'),
      p_reason: optionalText(form, 'reason') ?? null,
    });
    if (error) throw toMotionError(error, requestId);
    revalidatePath('/platform/assignments');
    return done('Assignment revoked.');
  } catch (error) {
    return fail(error, { requestId, action: 'platform.revokeAssignment' });
  }
}

/**
 * "Confirm it's you" (ADR-159): a fresh password sign-in, so the changes that need a recent sign-in
 * (creating a company, switching its systems, adding staff, settings) work for the next ten minutes.
 */
export async function confirmItsYouAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getPlatformContext();
    requestId = ctx.requestId;
    assertCan(ctx, 'system.manage');
    const value = form.get('current_password');
    await confirmPassword(ctx, typeof value === 'string' ? value : '');
    return done('Confirmed. You can make changes for the next ten minutes.');
  } catch (error) {
    return fail(error, { requestId, action: 'platform.confirmItsYou' });
  }
}
