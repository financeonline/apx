'use server';

import { revalidatePath } from 'next/cache';
import { revokeUserSessions } from '@/core/db';
import { getPlatformContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { toMotionError } from '@/core/errors';
import { fail, done, text, optionalText } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * Platform actions. Each is authorised twice: assertCan here, and app.require_super_admin() inside
 * the api.* function — which additionally requires aal2 and, for these, re-authentication within
 * the last ten minutes (ADR-044.3).
 */

export async function grantPlatformRoleAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getPlatformContext();
    requestId = ctx.requestId;
    assertCan(ctx, 'platform.users.manage');
    const { error } = await ctx.db.schema('api').rpc('grant_platform_role', {
      p_user: text(form, 'user_id'),
      p_role: text(form, 'platform_role'),
    });
    if (error) throw toMotionError(error, requestId);
    revalidatePath('/platform/users');
    return done('Platform role granted.');
  } catch (error) {
    return fail(error, { requestId, action: 'platform.grantRole' });
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
