'use server';

import { revalidatePath } from 'next/cache';
import { callApi, revokeUserSessions } from '@/core/db';
import { addPlatformUser, setAnalystCompanies } from '@/modules/platform';
import { confirmPassword, getPlatformContext } from '@/modules/tenancy';
import { assertCan } from '@/core/permissions';
import { fail, done, text, optionalText } from '@/app/_lib/server-action';
import { requestOrigin } from '@/app/_lib/request-origin';
import type { ActionResult } from '@/components/action-result';

/**
 * Platform actions. Each is authorised twice: assertCan here, and app.require_super_admin() inside
 * the api.* function — which, for these, additionally requires re-authentication within
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
    const { userId, invited, created } = await addPlatformUser(
      ctx,
      {
        email: text(form, 'email'), role: text(form, 'platform_role'),
        fullName: optionalText(form, 'full_name') ?? '', password: (form.get('password') as string | null) ?? '',
      },
      { redirectTo: `${origin}/account` },
    );
    // ADR-182: the companies ticked on the same form are given at once.
    const companies = organizationIds(form);
    if (companies.length > 0) await setAnalystCompanies(ctx, userId, companies);
    revalidatePath('/platform/users');
    revalidatePath('/platform/assignments');
    const access = companies.length === 0
      ? ' They cannot open any company until you tick one.'
      : ` They can open ${companies.length} ${companies.length === 1 ? 'company' : 'companies'}.`;
    return done((created
      ? 'Added. They can log in now with the email and password you set.'
      : invited
        ? 'Invited. They will receive an email to set their password.'
        : 'Added.') + access);
  } catch (error) {
    return fail(error, { requestId, action: 'platform.addUser' });
  }
}

/** The ticked `organization_id` checkboxes of a form. */
function organizationIds(form: FormData): string[] {
  return [...new Set(form.getAll('organization_id').filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

/** ADR-182: which companies one Financial Analyst can open, from the ticks on Platform accounts. */
export async function setAnalystCompaniesAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getPlatformContext();
    requestId = ctx.requestId;
    assertCan(ctx, 'assignments.manage');
    const { added, removed, total } = await setAnalystCompanies(ctx, text(form, 'user_id'), organizationIds(form));
    revalidatePath('/platform/users');
    revalidatePath('/platform/assignments');
    if (added === 0 && removed === 0) return done('No change.');
    return done(`Saved. They can open ${total} ${total === 1 ? 'company' : 'companies'}.`);
  } catch (error) {
    return fail(error, { requestId, action: 'platform.setAnalystCompanies' });
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
    await callApi(ctx.db, 'revoke_platform_role', { p_user: userId }, requestId);
    // SECURITY_MODEL.md §4: a revoked platform role invalidates every session of that user, at the
    // database (ADR-075). After the revocation committed, so a failure here cannot undo it.
    await revokeUserSessions(userId);
    revalidatePath('/platform/users');
    revalidatePath('/platform/assignments');
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
    await callApi(ctx.db, 'create_assignment', {
      p_org: text(form, 'organization_id'),
      p_employee: text(form, 'employee_user_id'),
      p_ends_at: optionalText(form, 'ends_at') ?? null,
    }, requestId);
    revalidatePath('/platform/assignments');
    return done('Financial Analyst assigned.');
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
    await callApi(ctx.db, 'revoke_assignment', {
      p_assignment: text(form, 'assignment_id'),
      p_reason: optionalText(form, 'reason') ?? null,
    }, requestId);
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
